/**
 * 技術評価の集計。run.ts の出力（runs.json と各セッションの events.jsonl、session_audio.wav、truth.json）を読む。
 *
 *   npx tsx tools/two_ai_eval/analyze.ts <out_dir> [<out_dir> ...] [--json <file>]
 *
 * 1. 停止の遅れ：録音の ch1（マイク）で刺激の声の始まりを見つけ、ch2（AI の再生音。ワークレットが出力へ書いたサンプル）で
 *    AI の声が実際に消えた時刻を見る。語の境界の待ちとフェードを含む。ログの値（first_voiced_at → stopped_at）も並べる。
 * 2. 誤った停止と止めそこね：刺激の種類ごとに、AI が話している最中に来た刺激のうち、2.5 秒以内に VAP／fallback の停止が
 *    起きた件数。中身のある発言で止まらなかったものは「止めそこね」。
 * 3. 点の時点：two_ai.point(started) の段、段の中の拍、中身の時計、壁時計を条件ごとに並べる。
 * 4. 負荷：audio.health(worker) の RTF と render.health の fps。
 */
import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Stim } from './stimuli';

type Raw = Record<string, any>;
const RATE = 16000;
const FR = 160; // 10 ms

export function quantile(values: number[], q: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}
const val = (v: unknown): number | null => (v !== null && typeof v === 'object' && 'value' in (v as object) && typeof (v as Raw).value === 'number' ? (v as Raw).value : typeof v === 'number' ? v : null);

/** 2ch の WAV を読み、10 ms ごとの RMS（dBFS）を ch ごとに返す。 */
export function readEnvelope(file: string): { mic: Float32Array; sys: Float32Array; frames: number } {
  const buf = readFileSync(file);
  let at = 12;
  let dataAt = -1;
  let size = 0;
  while (at + 8 <= buf.length) {
    const id = buf.toString('latin1', at, at + 4);
    const sz = buf.readUInt32LE(at + 4);
    if (id === 'data') {
      dataAt = at + 8;
      size = Math.min(sz, buf.length - dataAt);
      break;
    }
    at += 8 + sz + (sz & 1);
  }
  if (dataAt < 0) throw new Error(`${file}: no data`);
  const n = Math.floor(size / 4);
  const frames = Math.floor(n / FR);
  const mic = new Float32Array(frames);
  const sys = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let a = 0;
    let b = 0;
    for (let i = f * FR; i < (f + 1) * FR; i++) {
      const m = buf.readInt16LE(dataAt + i * 4);
      const s = buf.readInt16LE(dataAt + i * 4 + 2);
      a += m * m;
      b += s * s;
    }
    const ra = Math.sqrt(a / FR) / 32768;
    const rb = Math.sqrt(b / FR) / 32768;
    mic[f] = ra > 0 ? 20 * Math.log10(ra) : -150;
    sys[f] = rb > 0 ? 20 * Math.log10(rb) : -150;
  }
  return { mic, sys, frames };
}

interface Anchor { wav_sample: number; t: number; seg: number }
function readAnchors(file: string): Anchor[] {
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Raw).filter((r) => r.type === 'anchor').map((r) => ({ wav_sample: r.wav_sample, t: r.t_monotonic_ms, seg: r.seg }));
}
/** 録音の位置（秒）→ orchestrator の時刻（ms）。近い anchor から線形に。 */
function makeMap(anchors: Anchor[]) {
  const toT = (sec: number): number => {
    const s = sec * RATE;
    let best = anchors[0]!;
    for (const a of anchors) if (Math.abs(a.wav_sample - s) < Math.abs(best.wav_sample - s)) best = a;
    return best.t + (s - best.wav_sample) / 16;
  };
  const toSec = (t: number): number => {
    let best = anchors[0]!;
    for (const a of anchors) if (Math.abs(a.t - t) < Math.abs(best.t - t)) best = a;
    return (best.wav_sample + (t - best.t) * 16) / RATE;
  };
  return { toT, toSec };
}

/** ch1 の声の始まり（-45 dBFS を 2 枠続けて越えた最初の枠。前 300 ms は静か）。 */
export function micOnsets(mic: Float32Array, thr = -45): number[] {
  const out: number[] = [];
  let quiet = 30;
  for (let f = 0; f + 1 < mic.length; f++) {
    if (mic[f]! >= thr && mic[f + 1]! >= thr && quiet >= 30) out.push(f / 100);
    quiet = mic[f]! >= thr ? 0 : quiet + 1;
  }
  return out;
}

/** 刺激のファイルの時刻と録音の時刻のずれ（録音 = ファイル + lag）。intake と話し合いの大きな刺激の始まりで合わせる。 */
export function alignLag(stims: Stim[], onsets: number[]): { lag: number; matched: number } {
  const loud = stims.filter((s) => s.kind !== 'breath_soft');
  let best = { lag: 0, matched: -1 };
  const cands = new Set<number>();
  for (const o of onsets.slice(0, 40)) for (const s of loud.slice(0, 12)) cands.add(Math.round((o - s.onset_s) * 100) / 100);
  for (const lag of cands) {
    let m = 0;
    for (const s of loud) if (onsets.some((o) => Math.abs(o - (s.onset_s + lag)) <= 0.05)) m += 1;
    if (m > best.matched) best = { lag, matched: m };
  }
  return best;
}

export interface StimResult {
  run: string;
  condition: string;
  idx: number;
  kind: Stim['kind'];
  phase: string | null;
  rec_onset_s: number | null;
  /** 刺激の始まりに AI が話していた（ch2 に声があり、その再生が続いていた）。 */
  ai_speaking: boolean;
  playback_id: number | null;
  ch2_voiced_at_onset: boolean;
  /** 刺激の始まりから 1.5 秒の間の VAP の遅れの最大（ms）。 */
  vap_lag_ms: number | null;
  /** 鳴っていた発話の種類（ack は設計上止めない）。 */
  turn_kind: string | null;
  /** 刺激の始まりから、その再生の予定の終わりまで（ms）。止めなくても終わる近さ。 */
  remaining_ms: number | null;
  /** 再生の始まりからの位置（ms）。 */
  into_turn_ms: number | null;
  stopped: boolean;
  stop_source: string | null;
  /** 録音での、声の始まり → AI の声が消えた（ms）。 */
  stop_latency_audio_ms: number | null;
  /** ログの stop_latency_ms（first_voiced_at → stopped_at）。 */
  stop_latency_log_ms: number | null;
  /** 声の始まり（録音から写した時刻）→ 検出（onset）。 */
  detect_ms: number | null;
  /** 検出 → 停止の要求。 */
  request_ms: number | null;
  /** 停止の要求 → AI の声が消えた（録音）。語の境界の待ちとフェード。 */
  boundary_ms: number | null;
  onset_detected: boolean;
  /** 本人の声の終わり（録音）→ 受け止めの始まり（ack_started）。 */
  ack_delay_ms: number | null;
  episode_outcome: string | null;
  classification: string | null;
}

function loadEvents(dir: string): Raw[] {
  return readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Raw);
}

export function analyzeRun(run: Raw): { stims: StimResult[]; events: Raw[]; lag: { lag: number; matched: number }; dir: string; condition: string; vap_lag?: Raw } | null {
  const dir = run.session_dir as string;
  if (!dir || !existsSync(path.join(dir, 'events.jsonl'))) return null;
  const events = loadEvents(dir);
  const truth = JSON.parse(readFileSync(run.truth, 'utf8')) as { stims: Stim[] };
  const wav = path.join(dir, 'session_audio.wav');
  const sync = path.join(dir, 'session_audio_sync.jsonl');
  if (!existsSync(wav) || !existsSync(sync)) return { stims: [], events, lag: { lag: 0, matched: 0 }, dir, condition: run.condition };
  const env = readEnvelope(wav);
  const map = makeMap(readAnchors(sync));
  const onsets = micOnsets(env.mic);
  const lag = alignLag(truth.stims, onsets);

  const phases = events.filter((e) => e.event === 'two_ai.phase_changed').map((e) => ({ t: e.t_monotonic_ms as number, to: e.to as string }));
  const phaseAt = (t: number) => phases.filter((p) => p.t <= t).at(-1)?.to ?? null;
  // 再生の区間（orchestrator の時刻）。
  const plays = new Map<number, Raw>();
  for (const e of events) {
    if (e.event === 'speech.started') plays.set(e.audio_playback_id, { ...e, start: e.started_at });
    if ((e.event === 'speech.ended' || e.event === 'speech.interrupted') && plays.has(e.audio_playback_id)) {
      const p = plays.get(e.audio_playback_id)!;
      p.end = e.event === 'speech.ended' ? e.ended_at : e.interrupted_at;
      p.final = e;
    }
  }
  // 予定の長さ：two_ai.turn(prepared/arrived) に無いので、止まらなかった再生は実際の終わり、止まった再生は speech.* の samples と比べない。
  const turnEnded = new Map<number, Raw>();
  for (const e of events) if (e.event === 'two_ai.turn' && e.stage === 'ended') turnEnded.set(val(e.audio_playback_id) ?? -1, e);
  // VAP の遅れ：vap.state を出した時刻 − その推論の入力の末尾の音声の時刻（録音の対応で写す）。負荷で滞留すると伸びる。
  const vapLag: { t: number; lag: number }[] = events
    .filter((e) => e.event === 'vap.state' && typeof e.audio_frame === 'number')
    .map((e) => ({ t: e.t_monotonic_ms as number, lag: (e.t_monotonic_ms as number) - map.toT((e.audio_frame as number) / RATE) }));
  const vapLagAt = (t: number): number | null => {
    const xs = vapLag.filter((v) => v.t >= t && v.t <= t + 1500).map((v) => v.lag);
    return xs.length ? Math.max(...xs) : null;
  };
  const ijs = events.filter((e) => e.event === 'two_ai.interjection');
  const eps = events.filter((e) => e.event === 'two_ai.interjection_episode');
  const sysVoiced = (sec: number) => {
    const f = Math.round(sec * 100);
    return f >= 0 && f < env.frames && env.sys[f]! >= -50;
  };

  const out: StimResult[] = [];
  // 偽マイク（Chromium のファイルの入力）は負荷で数百 ms 飛ぶことがある（録音には欠落がないのに、ずれが途中で変わった）。
  // そこで刺激の順に、直前のずれの ±0.8 s で最も近い録音の始まりを探し、見つかればずれを更新する（区分ごとのずれ）。
  let curLag = lag.lag;
  for (const s of truth.stims) {
    const loudKind = s.kind !== 'breath_soft';
    if (loudKind) {
      let best: number | null = null;
      for (const o of onsets) if (Math.abs(o - (s.onset_s + curLag)) <= 0.8 && (best === null || Math.abs(o - (s.onset_s + curLag)) < Math.abs(best - (s.onset_s + curLag)))) best = o;
      if (best !== null) curLag = best - s.onset_s;
    }
    if (s.kind === 'intake') continue;
    const expect = s.onset_s + curLag;
    if (expect < 0 || expect * 100 >= env.frames) continue;
    // 録音の中の声の始まり：予想の ±80 ms の中で最初に越えた枠（弱い息は -62 dBFS で探す）。
    const thr = s.kind === 'breath_soft' ? -62 : -45;
    let rec: number | null = null;
    for (let f = Math.round((expect - 0.08) * 100); f <= Math.round((expect + 0.08) * 100); f++) {
      if (f >= 0 && f < env.frames && env.mic[f]! >= thr) {
        rec = f / 100;
        break;
      }
    }
    const onsetSec = rec ?? expect;
    const tOn = map.toT(onsetSec);
    const phase = phaseAt(tOn);
    // 刺激の始まりに鳴っていた再生。
    let play: Raw | null = null;
    for (const p of plays.values()) if (p.start <= tOn && (p.end ?? Infinity) > tOn) play = p;
    // AI の発話の区間の中（文の間の短い無音も含む）。ch2 に声があったかは別に残す。
    const ai_speaking = play !== null;
    const ch2_voiced = [0, -0.05, -0.1, -0.15, -0.2].some((d) => sysVoiced(onsetSec + d));
    const fin = play?.final ?? null;
    const stoppedHere = fin !== null && fin.event === 'speech.interrupted' && ['vap', 'fallback'].includes(fin.decision_source) && fin.interrupted_at >= tOn - 200 && fin.interrupted_at <= tOn + 3000;
    // 刺激に結びつく episode（onset が刺激の声の始まりの -300 ms〜終わり +1.5 s）。
    const tOff = map.toT(s.offset_s + curLag);
    const onsetEv = ijs.find((e) => e.stage === 'onset' && e.t_monotonic_ms >= tOn - 300 && e.t_monotonic_ms <= tOff + 1500);
    const ep = onsetEv ? eps.find((e) => e.interjection_id === onsetEv.interjection_id) : undefined;
    const classified = onsetEv ? ijs.find((e) => e.stage === 'classified' && e.interjection_id === onsetEv.interjection_id) : undefined;
    const reqEv = onsetEv ? ijs.find((e) => e.stage === 'stop_requested' && e.interjection_id === onsetEv.interjection_id) : undefined;
    const ackEv = onsetEv ? ijs.find((e) => e.stage === 'ack_started' && e.interjection_id === onsetEv.interjection_id) : undefined;
    let stopAudio: number | null = null;
    let boundary: number | null = null;
    if (stoppedHere) {
      // AI の声が消えた時刻：停止の記録の時刻 +300 ms までで、最後に ch2 に声があった枠の終わり。その後 300 ms 静か。
      const limit = map.toSec(fin.interrupted_at) + 0.3;
      let last: number | null = null;
      for (let f = Math.round(onsetSec * 100) - 20; f <= Math.round(limit * 100); f++) if (f >= 0 && f < env.frames && env.sys[f]! >= -50) last = f;
      if (last !== null) {
        let quiet = true;
        for (let f = last + 1; f <= last + 30 && f < env.frames; f++) if (env.sys[f]! >= -50) quiet = false;
        if (quiet) stopAudio = Math.max(0, (last + 1) / 100 - onsetSec) * 1000;
        if (quiet && reqEv) boundary = ((last + 1) / 100 - map.toSec(reqEv.t_monotonic_ms)) * 1000;
      }
    }
    const playEnd = play?.end ?? null;
    out.push({
      run: path.basename(path.dirname(path.dirname(dir))),
      condition: run.condition,
      idx: s.idx,
      kind: s.kind,
      phase,
      rec_onset_s: rec,
      ai_speaking,
      playback_id: play?.audio_playback_id ?? null,
      turn_kind: play?.turn_kind ?? null,
      ch2_voiced_at_onset: ch2_voiced,
      vap_lag_ms: (() => {
        const v = vapLagAt(tOn);
        return v === null ? null : Math.round(v);
      })(),
      remaining_ms: play !== null && playEnd !== null && !stoppedHere ? Math.round(playEnd - tOn) : null,
      into_turn_ms: play !== null ? Math.round(tOn - play.start) : null,
      stopped: stoppedHere,
      stop_source: stoppedHere ? fin.decision_source : null,
      stop_latency_audio_ms: stopAudio === null ? null : Math.round(stopAudio),
      stop_latency_log_ms: ep ? val(ep.stop_latency_ms) : null,
      detect_ms: onsetEv ? Math.round(onsetEv.t_monotonic_ms - tOn) : null,
      request_ms: onsetEv && reqEv ? Math.round(reqEv.t_monotonic_ms - onsetEv.t_monotonic_ms) : null,
      boundary_ms: boundary === null ? null : Math.round(boundary),
      onset_detected: onsetEv !== undefined,
      ack_delay_ms: ackEv ? Math.round(ackEv.t_monotonic_ms - tOff) : null,
      episode_outcome: ep?.outcome ?? null,
      classification: classified?.classification ?? null,
    });
  }
  const lags = vapLag.map((v) => v.lag);
  return { stims: out, events, lag, dir, condition: run.condition, vap_lag: { n: lags.length, p50: quantile(lags, 0.5), p95: quantile(lags, 0.95), p99: quantile(lags, 0.99), max: lags.length ? Math.max(...lags) : null, frac_over_300ms: lags.length ? lags.filter((x) => x > 300).length / lags.length : null } };
}

/** 点の時点（段、段の中の拍、中身の時計、壁時計）。 */
export function pointTimeline(events: Raw[]) {
  const discStart = events.find((e) => e.event === 'two_ai.phase_changed' && e.to === 'discussion')?.t_monotonic_ms ?? null;
  const stages = events.filter((e) => e.event === 'two_ai.stage');
  const turnsStarted = events.filter((e) => e.event === 'two_ai.turn' && e.stage === 'started');
  const gens = new Map<string, Raw>();
  for (const e of events) if (e.event === 'two_ai.generation' && e.turn_id) gens.set(e.turn_id, e);
  return events
    .filter((e) => e.event === 'two_ai.point' && ['started', 'missed', 'forced', 'unavailable'].includes(e.stage))
    .map((e) => {
      const st = stages.filter((x) => x.edge === 'started' && x.t_monotonic_ms <= e.t_monotonic_ms).at(-1);
      // 段の始まりから点の始まりまでに始まった中身のターン（受けのターン align_* を除く）。
      const inStage = turnsStarted.filter((t) => st && t.t_monotonic_ms >= st.t_monotonic_ms && t.t_monotonic_ms <= e.t_monotonic_ms && t.turn_id !== e.turn_id && ['discussion', 'point'].includes(t.turn_kind) && !(gens.get(t.turn_id)?.beat_id ?? '').startsWith('align_'));
      return {
        point_id: e.point_id,
        kind: e.point_kind,
        stage: e.stage,
        trigger: e.trigger,
        discussion_stage: e.discussion_stage,
        stage_turns_before: inStage.length,
        stage_beats_before: inStage.map((t) => `${t.turn_id}:${t.turn_kind}:${gens.get(t.turn_id)?.beat_id ?? '-'}`),
        content_s: val(e.content_elapsed_ms) === null ? null : Math.round(val(e.content_elapsed_ms)! / 100) / 10,
        wall_s: discStart === null ? null : Math.round((e.t_monotonic_ms - discStart) / 100) / 10,
        beat_id: gens.get(e.turn_id)?.beat_id ?? null,
      };
    });
}

/** 話し合いの閉じ方、板の枚数、段ごとの中身の時計と壁時計、割り込みの壁時計（manifest）。 */
export function discussionOf(events: Raw[], dir: string) {
  const start = events.find((e) => e.event === 'two_ai.phase_changed' && e.to === 'discussion')?.t_monotonic_ms ?? null;
  const closed = events.find((e) => e.event === 'two_ai.phase_changed' && e.from === 'discussion');
  const stages = events.filter((e) => e.event === 'two_ai.stage' && e.edge === 'ended').map((e) => ({ stage: e.discussion_stage, content_s: Math.round(e.content_elapsed_ms / 100) / 10, wall_s: Math.round(e.discussion_elapsed_ms / 100) / 10 }));
  let manifest: Raw = {};
  try {
    manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as Raw;
  } catch {
    /* なし */
  }
  const compressed = events.filter((e) => e.event === 'two_ai.generation' && e.stage === 'compressed').length;
  return {
    wall_s: start !== null && closed ? Math.round((closed.t_monotonic_ms - start) / 100) / 10 : null,
    close_reason: closed?.reason ?? null,
    closing_source: (events.filter((e) => e.event === 'two_ai.anomaly' || e.event === 'two_ai.phase_changed').find((e) => e.from === 'discussion') as Raw | undefined)?.source ?? null,
    cards_shown: events.filter((e) => e.event === 'two_ai.board' && e.reason === 'shown').length,
    compressed_beats: compressed,
    stages,
    interjection_wall: manifest.two_ai?.discussion_wall ?? null,
  };
}

export function perfOf(events: Raw[]) {
  const rtf = events.filter((e) => e.event === 'audio.health' && e.reporter === 'worker').map((e) => val(e.rtf)).filter((v): v is number => v !== null);
  const render = events.filter((e) => e.event === 'render.health');
  const fps = render.map((e) => e.fps_p5 as number).filter((v) => typeof v === 'number');
  const fpsMed = render.map((e) => e.fps_median as number).filter((v) => typeof v === 'number');
  const results = events.filter((e) => e.event === 'audio.health' && e.reporter === 'worker').map((e) => val(e.result_latency_ms) ?? val(e.latency_ms)).filter((v): v is number => v !== null);
  return {
    rtf: { n: rtf.length, p50: quantile(rtf, 0.5), p95: quantile(rtf, 0.95), max: rtf.length ? Math.max(...rtf) : null },
    fps_p5: { n: fps.length, median: quantile(fps, 0.5), min: fps.length ? Math.min(...fps) : null },
    fps_median: quantile(fpsMed, 0.5),
    renderer: render[0]?.renderer ?? null,
    long_tasks: render.reduce((s, e) => s + Number(e.long_tasks ?? 0), 0),
    result_latency_ms_p95: quantile(results, 0.95),
  };
}

const r0 = (v: number | null) => (v === null ? '—' : String(Math.round(v)));
export function summarize(all: StimResult[]) {
  const disc = all.filter((s) => s.phase === 'discussion');
  const byKind = (cond: string) => {
    const rows: Record<string, unknown>[] = [];
    for (const kind of ['speech', 'backchannel', 'cough', 'breath_loud', 'breath_soft'] as const) {
      const xs = disc.filter((s) => s.condition === cond && s.kind === kind);
      // 受け止め（ack）は設計上止めないので、AI が話していた区間から除いて別に数える。
      const during = xs.filter((s) => s.ai_speaking && s.turn_kind !== 'ack');
      rows.push({
        kind,
        n: xs.length,
        during_ai: during.length,
        during_ack: xs.filter((s) => s.ai_speaking && s.turn_kind === 'ack').length,
        stopped_during_ack: xs.filter((s) => s.ai_speaking && s.turn_kind === 'ack' && s.stopped).length,
        not_during_ai: xs.filter((s) => !s.ai_speaking).length,
        detected_any: xs.filter((s) => s.onset_detected).length,
        stopped: during.filter((s) => s.stopped).length,
        not_stopped: during.filter((s) => !s.stopped).length,
        not_stopped_near_end: during.filter((s) => !s.stopped && s.remaining_ms !== null && s.remaining_ms < 1500).length,
        outcomes: Object.fromEntries([...new Set(xs.map((s) => s.episode_outcome ?? 'none'))].map((o) => [o, xs.filter((s) => (s.episode_outcome ?? 'none') === o).length])),
      });
    }
    return rows;
  };
  const lat = disc.filter((s) => s.condition === 'respond_on_spot' && s.kind === 'speech' && s.stopped && s.stop_latency_audio_ms !== null);
  const L = lat.map((s) => s.stop_latency_audio_ms!) ;
  const comp = (k: keyof StimResult) => {
    const v = lat.map((s) => s[k] as number | null).filter((x): x is number => x !== null);
    return { n: v.length, median: quantile(v, 0.5), p90: quantile(v, 0.9) };
  };
  return {
    stop_latency_speech: { n: L.length, median: quantile(L, 0.5), p90: quantile(L, 0.9), min: L.length ? Math.min(...L) : null, max: L.length ? Math.max(...L) : null, mean: L.length ? L.reduce((a, b) => a + b, 0) / L.length : null },
    components: { detect_ms: comp('detect_ms'), request_ms: comp('request_ms'), boundary_ms: comp('boundary_ms'), log_ms: comp('stop_latency_log_ms') },
    ack_delay_ms: (() => {
      const v = disc.filter((s) => s.condition === 'respond_on_spot' && s.ack_delay_ms !== null).map((s) => s.ack_delay_ms!);
      return { n: v.length, median: quantile(v, 0.5), p90: quantile(v, 0.9), max: v.length ? Math.max(...v) : null };
    })(),
    stop_latency_all_kinds_on_spot: disc.filter((s) => s.condition === 'respond_on_spot' && s.stopped && s.stop_latency_audio_ms !== null).map((s) => ({ kind: s.kind, ms: s.stop_latency_audio_ms })),
    on_spot: byKind('respond_on_spot'),
    at_end: byKind('respond_at_end'),
    fmt: r0,
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const jsonAt = argv.indexOf('--json');
  const jsonOut = jsonAt >= 0 ? argv[jsonAt + 1] : null;
  const dirs = argv.filter((a, i) => !a.startsWith('--') && (jsonAt < 0 || i !== jsonAt + 1));
  const all: StimResult[] = [];
  const perRun: Raw[] = [];
  for (const d of dirs) {
    const runs = JSON.parse(readFileSync(path.join(d, 'runs.json'), 'utf8')) as Raw[];
    for (const run of runs) {
      const a = analyzeRun(run);
      if (a === null) {
        perRun.push({ run: run.session_dir, error: 'no events' });
        continue;
      }
      all.push(...a.stims);
      const sttFinals = a.events.filter((e) => e.event === 'stt.final').length;
      perRun.push({
        dir: a.dir,
        condition: a.condition,
        ended: run.ended,
        lag: a.lag,
        stims: a.stims.length,
        stt_finals: sttFinals,
        points: pointTimeline(a.events),
        perf: perfOf(a.events),
        vap_lag_ms: a.vap_lag ?? null,
        query: run.query ?? '',
        nice: run.nice ?? 0,
        discussion: discussionOf(a.events, a.dir),
      });
    }
  }
  const summary = summarize(all);
  const result = { summary: { ...summary, fmt: undefined }, runs: perRun, stims: all };
  if (jsonOut) await writeFile(jsonOut, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ summary: result.summary, runs: perRun.map((r) => ({ ...r, points: r.points })) }, null, 1));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  });
}
