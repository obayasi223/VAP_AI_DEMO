/**
 * 保存した音声（session_audio.wav と session_audio_sync.jsonl）の読み込みと、音声の時間軸の上に並べる印。
 * orchestrator が SAVE_SESSION_AUDIO=1 のときに書く（apps/orchestrator/src/logging/session_audio.ts）。読むだけで、書き換えない。
 *
 * 時計: イベントの時刻は記録の時点で orchestrator の時計（t_monotonic_ms）に写っている。ブラウザの時刻（描画、再生）は
 * clock.sync（browser_rtt）の推定で写したもので、その誤差を印ごとに出す。音声の位置への対応は同期ファイルの anchor で求める。
 */
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs';
import path from 'node:path';
import type { FrameMap } from './assemble';
import { num, parseJsonl, str, type RawEvent } from './readers';

export const SESSION_AUDIO_FILE = 'session_audio.wav';
export const SESSION_AUDIO_SYNC_FILE = 'session_audio_sync.jsonl';
const RATE = 16000;

export interface SyncAnchor {
  seg: number;
  audio_frame: number;
  wav_sample: number;
  t_ms: number;
  spread_ms: number;
}

export interface SyncGap {
  reason: string;
  audio_frame: number;
  frames: number;
  wav_sample: number;
  padded: boolean;
}

export interface AudioSync {
  anchors: SyncAnchor[];
  gaps: SyncGap[];
  /** 異常終了などで end の行がない。 */
  ended: boolean;
  stop_reason: string | null;
}

/** 同期ファイルを読む。無い、または anchor が 1 つもないときは null（vap.state の組に戻す）。 */
export function readAudioSync(dir: string): AudioSync | null {
  const file = path.join(dir, SESSION_AUDIO_SYNC_FILE);
  if (!existsSync(file) || !existsSync(path.join(dir, SESSION_AUDIO_FILE))) return null;
  const anchors: SyncAnchor[] = [];
  const gaps: SyncGap[] = [];
  let ended = false;
  let stop_reason: string | null = null;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // 異常終了で最後の行が欠ける
    }
    if (record.type === 'anchor') {
      const seg = num(record.seg);
      const audio_frame = num(record.audio_frame);
      const wav_sample = num(record.wav_sample);
      const t_ms = num(record.t_monotonic_ms);
      const spread_ms = num(record.spread_ms);
      if (audio_frame === null || wav_sample === null || t_ms === null) continue;
      anchors.push({ seg: seg ?? 0, audio_frame, wav_sample, t_ms, spread_ms: spread_ms ?? 0 });
    } else if (record.type === 'gap') {
      gaps.push({
        reason: str(record.reason) ?? '不明',
        audio_frame: num(record.audio_frame) ?? 0,
        frames: num(record.frames) ?? 0,
        wav_sample: num(record.wav_sample) ?? 0,
        padded: record.padded === true,
      });
    } else if (record.type === 'end') {
      ended = true;
      stop_reason = str(record.stop_reason);
    }
  }
  if (anchors.length === 0) return null;
  anchors.sort((a, b) => a.t_ms - b.t_ms);
  return { anchors, gaps, ended, stop_reason };
}

function interpolate(a: number, b: number, ratio: number): number {
  return a + (b - a) * ratio;
}

/** 同期ファイルの anchor の間を線形に補間する。別の区間（長い欠落を埋めていない）の間は補間しない。 */
export function syncFrameMap(sync: AudioSync): FrameMap {
  const byT = [...sync.anchors].sort((a, b) => a.t_ms - b.t_ms);
  const byFrame = [...sync.anchors].sort((a, b) => a.audio_frame - b.audio_frame);
  const bracket = (list: SyncAnchor[], value: number, get: (a: SyncAnchor) => number): [SyncAnchor, SyncAnchor | null] => {
    let lo = 0;
    let hi = list.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (get(list[mid] as SyncAnchor) <= value) lo = mid;
      else hi = mid - 1;
    }
    return [list[lo] as SyncAnchor, (list[lo + 1] ?? null) as SyncAnchor | null];
  };
  return {
    available: true,
    tAtFrame(frame) {
      const [a, b] = bracket(byFrame, frame, (x) => x.audio_frame);
      if (b !== null && a.seg === b.seg && frame >= a.audio_frame && b.audio_frame > a.audio_frame) {
        return interpolate(a.t_ms, b.t_ms, (frame - a.audio_frame) / (b.audio_frame - a.audio_frame));
      }
      return a.t_ms + (frame - a.audio_frame) / 16;
    },
    secondsAtT(t_ms) {
      const [a, b] = bracket(byT, t_ms, (x) => x.t_ms);
      if (t_ms < a.t_ms) return Math.max(0, (a.wav_sample - (a.t_ms - t_ms) * 16) / RATE);
      if (b === null) return (a.wav_sample + (t_ms - a.t_ms) * 16) / RATE;
      if (a.seg !== b.seg) {
        // 埋めていない長い欠落をまたぐ。欠落の中は欠落の位置に留め、その外は近い方の anchor から進める。
        const gap = sync.gaps.find((g) => !g.padded && g.wav_sample >= a.wav_sample && g.wav_sample <= b.wav_sample);
        const at = gap?.wav_sample ?? a.wav_sample;
        const fromA = a.wav_sample + (t_ms - a.t_ms) * 16;
        if (fromA <= at) return fromA / RATE;
        const fromB = b.wav_sample - (b.t_ms - t_ms) * 16;
        return Math.max(at, fromB) / RATE;
      }
      return interpolate(a.wav_sample, b.wav_sample, (t_ms - a.t_ms) / (b.t_ms - a.t_ms)) / RATE;
    },
  };
}

// ---- 印（音声の時間軸に並べる） ------------------------------------------------

export type MarkLane = 'desire' | 'timing' | 'cue' | 'render' | 'release' | 'speech';
export type MarkClock = 'orchestrator' | 'browser';

export interface TimelineMark {
  t_ms: number;
  lane: MarkLane;
  label: string;
  /** clock=browser は clock.sync の推定で写した時刻。 */
  clock: MarkClock;
  /** clock.sync の誤差（ms）。orchestrator の時刻は 0。推定が無いと null。 */
  clock_error_ms: number | null;
  candidate_id: string | null;
  event: string;
}

export interface ClockSummary {
  browser_samples: number;
  browser_error_ms_median: number | null;
  browser_error_ms_max: number | null;
}

interface ClockSample {
  t_ms: number;
  error_ms: number;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] as number;
}

function eventTime(e: RawEvent): number {
  return num(e.t_monotonic_ms) ?? 0;
}

/** 印を作る。signal.ended が無い記録や、visible=false の描画も壊れない。 */
export function buildMarks(events: RawEvent[]): { marks: TimelineMark[]; clock: ClockSummary } {
  const clocks: ClockSample[] = [];
  for (const e of events) {
    if (e.event !== 'clock.sync' || str(e.source) !== 'browser_rtt') continue;
    const error_ms = num(e.error_ms);
    if (error_ms !== null) clocks.push({ t_ms: eventTime(e), error_ms });
  }
  clocks.sort((a, b) => a.t_ms - b.t_ms);
  const clockErrorAt = (t: number): number | null => {
    if (clocks.length === 0) return null;
    let best = clocks[0] as ClockSample;
    for (const sample of clocks) {
      if (sample.t_ms > t) break;
      best = sample;
    }
    return best.error_ms;
  };
  const browserError = (e: RawEvent, t: number): number | null => {
    const basis = (e.time_basis ?? null) as { source?: unknown; uncertainty_ms?: unknown } | null;
    const fromBasis = basis !== null && basis.source === 'browser_rtt' ? num(basis.uncertainty_ms) : null;
    return fromBasis ?? clockErrorAt(t);
  };
  const desireRequests = new Set(events.filter((e) => e.event === 'initiative.desire').map((e) => str(e.request_id)));
  const marks: TimelineMark[] = [];
  const add = (mark: TimelineMark) => marks.push(mark);
  const common = (e: RawEvent) => ({ candidate_id: str(e.candidate_id), event: String(e.event) });
  const orchestrator = { clock: 'orchestrator' as const, clock_error_ms: 0 };
  for (const e of events) {
    switch (e.event) {
      case 'initiative.desire': {
        const t = num(e.received_at) ?? eventTime(e);
        add({ t_ms: t, lane: 'desire', label: `生成段: ${str(e.desire) ?? '不明'}（${str(e.outcome) ?? '不明'}）`, ...orchestrator, ...common(e) });
        break;
      }
      case 'initiative.decision': {
        if (desireRequests.has(str(e.request_id))) break; // 二段判定では生成段のイベントを出す
        const t = num(e.received_at) ?? eventTime(e);
        add({ t_ms: t, lane: 'desire', label: `判定: ${str(e.decision) ?? '不明'}`, ...orchestrator, ...common(e) });
        break;
      }
      case 'initiative.timing': {
        const t = num(e.received_at) ?? num(e.decided_at) ?? eventTime(e);
        add({ t_ms: t, lane: 'timing', label: `タイミング段: ${str(e.timing) ?? '不明'}（${str(e.outcome) ?? '不明'}）`, ...orchestrator, ...common(e) });
        break;
      }
      case 'signal.sent': {
        const t = num(e.sent_at) ?? eventTime(e);
        const phase = str(e.phase);
        const parameters = (e.parameters ?? {}) as Record<string, unknown>;
        if (phase === 'inhale') add({ t_ms: t, lane: 'cue', label: '吸気の合図の送信', ...orchestrator, ...common(e) });
        else add({ t_ms: t, lane: 'release', label: `breath.release: ${str(parameters.reason) ?? phase ?? '不明'}`, ...orchestrator, ...common(e) });
        break;
      }
      case 'signal.started': {
        const phase = str(e.phase) ?? '不明';
        const started = num(e.started_at);
        if (e.visible === true && started !== null) {
          add({ t_ms: started, lane: 'render', label: `描画の開始（${phase}）`, clock: 'browser', clock_error_ms: browserError(e, started), ...common(e) });
        } else {
          add({ t_ms: eventTime(e), lane: 'render', label: `描画されなかった（${phase}、${str(e.null_reason) ?? '理由なし'}）`, ...orchestrator, ...common(e) });
        }
        break;
      }
      case 'signal.ended': {
        const phase = str(e.phase) ?? '不明';
        const ended = num(e.ended_at);
        if (ended !== null) add({ t_ms: ended, lane: 'render', label: `描画の終了（${phase}）`, clock: 'browser', clock_error_ms: browserError(e, ended), ...common(e) });
        else add({ t_ms: eventTime(e), lane: 'render', label: `描画の終了（時刻なし、${phase}）`, ...orchestrator, ...common(e) });
        break;
      }
      case 'speech.started': {
        const t = num(e.started_at) ?? eventTime(e);
        add({ t_ms: t, lane: 'speech', label: `発話の開始（${str(e.origin) ?? '不明'}）`, clock: 'browser', clock_error_ms: browserError(e, t), ...common(e) });
        break;
      }
      case 'speech.ended':
      case 'speech.interrupted': {
        const t = num(e.ended_at) ?? num(e.interrupted_at) ?? eventTime(e);
        add({ t_ms: t, lane: 'speech', label: e.event === 'speech.ended' ? '発話の終了' : '発話の割り込み', clock: 'browser', clock_error_ms: browserError(e, t), ...common(e) });
        break;
      }
      default:
        break;
    }
  }
  marks.sort((a, b) => a.t_ms - b.t_ms);
  const errors = clocks.map((c) => c.error_ms);
  return {
    marks,
    clock: { browser_samples: clocks.length, browser_error_ms_median: median(errors), browser_error_ms_max: errors.length === 0 ? null : Math.max(...errors) },
  };
}

// ---- 波形 ----------------------------------------------------------------------

export interface Waveform {
  duration_sec: number;
  from_sec: number;
  to_sec: number;
  /** [min, max]（-1〜1）を bins 個。 */
  mic: [number, number][];
  sys: [number, number][];
}

interface WavLayout {
  dataOffset: number;
  dataBytes: number;
}

function wavLayout(fd: number, fileSize: number): WavLayout | null {
  const head = Buffer.alloc(Math.min(4096, fileSize));
  readSync(fd, head, 0, head.length, 0);
  if (head.length < 12 || head.toString('latin1', 0, 4) !== 'RIFF' || head.toString('latin1', 8, 12) !== 'WAVE') return null;
  let at = 12;
  let format = false;
  while (at + 8 <= head.length) {
    const id = head.toString('latin1', at, at + 4);
    const size = head.readUInt32LE(at + 4);
    if (id === 'fmt ') {
      if (head.readUInt16LE(at + 8) !== 1 || head.readUInt16LE(at + 10) !== 2 || head.readUInt32LE(at + 12) !== RATE || head.readUInt16LE(at + 22) !== 16) return null;
      format = true;
    } else if (id === 'data') {
      if (!format) return null;
      const dataOffset = at + 8;
      // 異常終了ではヘッダの長さが実際より短いことがある（定期更新の後の数秒）。実際にある分まで読む。
      const available = fileSize - dataOffset;
      return { dataOffset, dataBytes: available - (available % 4) };
    }
    at += 8 + size + (size % 2);
  }
  return null;
}

/** 2ch の WAV の一部を、区間ごとの最小と最大にする。読めない形式は null。 */
export function readWaveform(file: string, fromSec: number, toSec: number, bins: number): Waveform | null {
  const fd = openSync(file, 'r');
  try {
    const layout = wavLayout(fd, fstatSync(fd).size);
    if (layout === null) return null;
    const totalFrames = layout.dataBytes / 4;
    const duration_sec = totalFrames / RATE;
    const start = Math.max(0, Math.min(Math.floor(fromSec * RATE), totalFrames));
    const end = Math.max(start, Math.min(Math.ceil(toSec * RATE), totalFrames));
    const frames = end - start;
    const buffer = Buffer.alloc(frames * 4);
    if (frames > 0) readSync(fd, buffer, 0, buffer.length, layout.dataOffset + start * 4);
    const mic: [number, number][] = [];
    const sys: [number, number][] = [];
    for (let bin = 0; bin < bins; bin++) {
      const a = Math.floor((bin * frames) / bins);
      const b = Math.max(a + (frames > 0 ? 1 : 0), Math.floor(((bin + 1) * frames) / bins));
      let micMin = 0;
      let micMax = 0;
      let sysMin = 0;
      let sysMax = 0;
      for (let i = a; i < Math.min(b, frames); i++) {
        const m = buffer.readInt16LE(i * 4);
        const s = buffer.readInt16LE(i * 4 + 2);
        if (m < micMin) micMin = m;
        if (m > micMax) micMax = m;
        if (s < sysMin) sysMin = s;
        if (s > sysMax) sysMax = s;
      }
      mic.push([micMin / 32768, micMax / 32768]);
      sys.push([sysMin / 32768, sysMax / 32768]);
    }
    return { duration_sec, from_sec: start / RATE, to_sec: end / RATE, mic, sys };
  } finally {
    closeSync(fd);
  }
}

// ---- 画面へ返す形 --------------------------------------------------------------

export interface AudioTimeline {
  available: boolean;
  reason?: string;
  file?: string;
  waveform?: Waveform;
  marks?: (TimelineMark & { sec: number })[];
  clock?: ClockSummary;
  sync?: { anchors: number; spread_ms_median: number | null; spread_ms_max: number | null; gaps: SyncGap[]; ended: boolean; stop_reason: string | null };
}

export interface TimelineRequest {
  center_sec: number;
  span_sec: number;
  bins: number;
}

const MAX_SPAN_SEC = 120;
const MAX_BINS = 2000;

export function loadMarks(dir: string): { marks: TimelineMark[]; clock: ClockSummary } {
  return buildMarks(parseJsonl(readFileSync(path.join(dir, 'events.jsonl'), 'utf8')).events);
}

/** 詳細画面の音声の欄が使う: 波形と、窓の中の印、対応と時計の精度。 */
export function audioTimeline(dir: string, request: TimelineRequest, built: { marks: TimelineMark[]; clock: ClockSummary } = loadMarks(dir)): AudioTimeline {
  const sync = readAudioSync(dir);
  if (sync === null) return { available: false, reason: '保存した音声と時刻の対応（session_audio_sync.jsonl）がありません。SAVE_SESSION_AUDIO=1 のセッションだけ、波形と印を並べられます。' };
  const span = Math.min(Math.max(1, request.span_sec), MAX_SPAN_SEC);
  const from = Math.max(0, request.center_sec - span / 2);
  const bins = Math.min(Math.max(10, Math.floor(request.bins)), MAX_BINS);
  const waveform = readWaveform(path.join(dir, SESSION_AUDIO_FILE), from, from + span, bins);
  if (waveform === null) return { available: false, reason: `${SESSION_AUDIO_FILE} を読めません（2ch、16kHz、16bit の WAV が必要です）。` };
  const map = syncFrameMap(sync);
  const marks = built.marks.flatMap((mark) => {
    const sec = map.secondsAtT(mark.t_ms);
    if (sec === null || sec < waveform.from_sec || sec > waveform.to_sec) return [];
    return [{ ...mark, sec }];
  });
  const spreads = sync.anchors.map((a) => a.spread_ms);
  return {
    available: true,
    file: SESSION_AUDIO_FILE,
    waveform,
    marks,
    clock: built.clock,
    sync: {
      anchors: sync.anchors.length,
      spread_ms_median: median(spreads),
      spread_ms_max: Math.max(...spreads),
      gaps: sync.gaps,
      ended: sync.ended,
      stop_reason: sync.stop_reason,
    },
  };
}
