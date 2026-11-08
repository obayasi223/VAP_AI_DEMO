/**
 * 録音したセッション（sessions/<id>/events.jsonl）の入力を TurnManager の step に再生する（開発用の調整画面 /tune）。
 *
 * 記録から TurnInputs を tick ごとに組み立て直し、方策を変えた TurnManager（createTurnManager）で計算し直す。
 * 応答の LLM と TTS は呼ばない。準備の完了と再生の長さは記録の時刻を使い、記録と対応がつかないものは
 * 記録の中央値を仮定する（仮定は結果の assumptions に列挙し、画面に出す）。
 *
 * 入力の組み立て:
 *  - vap: 記録の vap.state。受信時刻は「t_monotonic_ms と、ファイルで直前の orchestrator 基準の時刻の大きい方」
 *    （vap.state の時刻はワーカーの時計の写像で、受信より少し早い。ファイルの並びは受信の順）。
 *  - received_audio_frame: 最新の vap.state の audio_frame から実時間で外挿（16 サンプル/ms）。
 *  - vap_worker_started_at: 記録の「rewarm:Xms<…」の理由から逆算。
 *  - transcript: 記録の stt.*。AI の開始（segment の境界）が記録と違う位置になったら、音声位置で旧 segment と
 *    新 segment に分け、境界の時点の文の長さまでを旧 segment とする（assembler の近似。記録と同じ位置の境界は記録のまま）。
 *  - completion_p: ja_rules_v1 を記録の文で計算し直す（同期の規則なので記録と同じ値になる）。他の推定器は再生しない。
 *  - similarity_to_prepared と prefetch: ResponsePrefetch の規則で再現（準備の完了は記録の時刻か仮定）。
 *  - playback: start_speech から記録の再生の報告までの時間と長さ（記録の audio_playback_id と対応がつけば記録の値）。
 *    system チャネルの無音は記録の vap.state の x2_peak（80ms 窓）から近似する。
 *  - fallback_energy: 記録にないので null（鮮度切れの間の開始と割り込みは再現しない）。
 *
 * 反実仮想の限界: 再計算で AI の発話の時刻が変わっても、その後の利用者の振る舞い（記録の音声、STT、VAP）は変わらない。
 */
import {
  SAMPLE_RATE_HZ,
  ResearchEvent,
  absent,
  present,
} from '@llm-vap/contracts';
import type {
  EventOf,
  Maybe,
  Policy,
  PlaybackInput,
  PrefetchInput,
  TranscriptSnapshot,
  TuneDivergence,
  TuneGazeChange,
  TuneDiagnosticSample,
  TuneReplayResult,
  TuneSpan,
  TuneStart,
  TuneTurnChange,
  TuneTurnOutcomes,
  TurnAllowedPayload,
  TurnOutcomeBody,
  TurnDecision,
  TurnInputs,
  Vap2chState,
} from '@llm-vap/contracts';
import { JA_RULES_ESTIMATOR, NO_ESTIMATOR, normalizePartial, scoreJaRules } from '../cognition/completion';
import { charNgramCosine } from '../cognition/similarity';
import { createTurnManager, userTextFor } from '../control';
import type { TurnState } from '../control';
import { SessionHistory, UserUtterances } from '../session/history';
import { computeMetrics, type MetricInputs } from './metrics';
import { buildTurnDiagnostic } from './turn_diagnostic';
import { noResponseOutcome, turnOutcomeSettings } from '../control/turn_outcome';
import { outcomeRows, recordedTurnOutcomes, replayedTurnOutcomes, type ReplayPlaybackDetail, type ReplayStartDetail } from './turn_outcome_replay';

type Ev<N extends ResearchEvent['event']> = EventOf<N>;
type SttEv = Ev<'stt.interim'> | Ev<'stt.final'>;

const FRAMES_PER_MS = SAMPLE_RATE_HZ / 1000;
/**
 * session の audio_state.ts は sys の 20ms 枠の RMS が -50 dBFS 以上を声とする。記録には 80ms 窓の x2_peak（int16 の最大）
 * しかないので、音声の波高率を約 10 dB と仮定して、最大値が -40 dBFS 以上を声とする（近似）。
 */
const SYS_VOICED_PEAK = Math.round(32768 * 10 ** (-40 / 20));
/** 記録の境界と同じ境界とみなす時刻の差。 */
const COINCIDE_MS = 60;
/** 記録の開始と同じ開始とみなす時刻の差（tick の位相の揺れ）。 */
const MATCH_MS = 45;
const DIAGNOSTIC_EVERY_TICKS = 5;
/** vap.state の x2_peak の窓（worker_input.from_audio_frame から audio_frame まで、80ms）。 */
const VAP_WINDOW_FRAMES = 1280;

export interface ParsedSessionLog {
  events: ResearchEvent[];
  invalid: number;
}

export function parseEventsJsonl(text: string): ParsedSessionLog {
  const events: ResearchEvent[] = [];
  let invalid = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed = ResearchEvent.safeParse(JSON.parse(line));
      if (parsed.success) events.push(parsed.data);
      else invalid += 1;
    } catch {
      invalid += 1;
    }
  }
  return { events, invalid };
}

export interface ReplayOptions {
  /** 記録と対応がつかない準備の完了までの時間。省略は記録の中央値。 */
  assumed_prepare_ms?: number;
  /** 記録と対応がつかない再生の長さ。省略は記録の中央値。 */
  assumed_speech_ms?: number;
  /** 割り込みの決定から再生の終わりの報告まで（記録で対応がつかないとき）。max_wait_ms に足す。 */
  stop_report_delay_ms?: number;
}

interface VapRow {
  recv: number;
  t: number;
  frame: number;
  state: Vap2chState;
  vadUser: number;
  sysVoiced: boolean;
}

interface RecordedPrefetch {
  id: number;
  segment_id: number;
  started: number;
  ready: number | null;
}

interface RecordedSpeech {
  id: number;
  started: number;
  ended: number | null;
  interrupted: boolean;
  spoken_text: string;
  spoken_text_precision: Ev<'speech.ended'>['spoken_text_precision'];
  origin: 'response' | 'candidate' | 'vocal_cue';
  candidate_id: string | null;
  /** speech.started／ended の started_at／ended_at（再生の報告の時刻）と音声位置。 */
  playback_started_at: number;
  playback_ended_at: number;
  start_frame: number | null;
  end_frame: number | null;
}

interface SimPrefetch {
  id: number;
  segment_id: number;
  transcript_revision: number;
  started_at: number;
  ready_at: number;
}

interface SimPlayback {
  id: number;
  requested_at: number;
  begin_at: number;
  end_at: number;
  rec: RecordedSpeech | null;
  /** 記録の sys の時刻へのずれ（記録と対応がつくとき）。 */
  shift: number | null;
  interrupted: boolean;
  committed: boolean;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function isOrchestratorBasis(e: ResearchEvent): boolean {
  return e.time_basis.source === 'orchestrator';
}

/** 記録から入力の材料を取り出す（方策に依らない部分）。同じ記録で何度も再生するので分けておく。 */
export interface PreparedLog {
  session_id: string;
  events: ResearchEvent[];
  vap: VapRow[];
  stt: SttEv[];
  prefetchByRevision: Map<number, RecordedPrefetch>;
  speechById: Map<number, RecordedSpeech>;
  recordedStarts: TuneStart[];
  recordedTurn: TuneTurnChange[];
  recordedGaze: TuneGazeChange[];
  recordedInterrupts: number;
  recordedAllowedPayloads: { t: number; payload: TurnAllowedPayload }[];
  workerStartedAt: number | null;
  detached: { start: number; end: number }[];
  tickAnchors: number[];
  tStart: number;
  tEnd: number;
  /** system チャネルの声の区間（音声位置）。vap.state の x2_peak の窓から作る（境は窓の中央）。 */
  sysVoiced: { start: number; end: number }[];
  /** vap.state の audio_frame からの外挿に足す、受信済み音声の先頭の進み（speech.* の audio_frame で校正）。 */
  headLeadFrames: number;
  medianPrepareMs: number | null;
  medianAckMs: number | null;
  medianSpeechMs: number | null;
  /** 記録のセッションが実際に使った completion の推定器（provider.status の completion:<名前>）。down は 'unavailable'。記録になければ null。 */
  recordedCompletion: string | null;
  warnings: string[];
}

export function prepareLog(events: ResearchEvent[]): PreparedLog {
  const warnings: string[] = [];
  const vap: VapRow[] = [];
  const stt: SttEv[] = [];
  const prefetchByRevision = new Map<number, RecordedPrefetch>();
  const prefetchById = new Map<number, RecordedPrefetch>();
  const speechById = new Map<number, RecordedSpeech>();
  const recordedTurn: TuneTurnChange[] = [];
  const recordedGaze: TuneGazeChange[] = [];
  const recordedAllowedPayloads: { t: number; payload: TurnAllowedPayload }[] = [];
  const anchors: number[] = [];
  const detached: { start: number; end: number }[] = [];
  let openDetach: number | null = null;
  let workerStartedAt: number | null = null;
  let recordedCompletion: string | null = null;
  let lastOrchestratorT = 0;
  let interrupts = 0;
  let sessionId = '';

  for (const e of events) {
    sessionId ||= e.session_id;
    if (isOrchestratorBasis(e)) lastOrchestratorT = Math.max(lastOrchestratorT, e.t_monotonic_ms);
    switch (e.event) {
      case 'vap.state': {
        if (e.channel_layout !== '2ch') break;
        const { schema_version: _s, t_monotonic_ms, wall_clock: _w, session_id: _id, condition: _c, time_basis: _b, event: _e, ...rest } = e;
        const state = rest as Vap2chState;
        const wi = (e.raw as { worker_input?: { x2_peak?: unknown; x2_digital_zero?: unknown } }).worker_input;
        const peak = typeof wi?.x2_peak === 'number' ? wi.x2_peak : null;
        const sysVoiced = peak !== null ? peak >= SYS_VOICED_PEAK && wi?.x2_digital_zero !== true : e.vad[1] >= 0.5;
        vap.push({
          recv: Math.max(t_monotonic_ms, lastOrchestratorT),
          t: t_monotonic_ms,
          frame: e.audio_frame,
          state,
          vadUser: e.vad[0],
          sysVoiced,
        });
        break;
      }
      case 'stt.interim':
      case 'stt.final':
        stt.push(e);
        break;
      case 'prefetch.started': {
        const row: RecordedPrefetch = { id: e.audio_playback_id, segment_id: e.segment_id, started: e.t_monotonic_ms, ready: null };
        prefetchByRevision.set(e.transcript_revision, row);
        prefetchById.set(e.audio_playback_id, row);
        anchors.push(e.t_monotonic_ms);
        break;
      }
      case 'prefetch.ready': {
        const row = prefetchById.get(e.audio_playback_id);
        if (row) row.ready = e.t_monotonic_ms;
        break;
      }
      case 'speech.started':
        speechById.set(e.audio_playback_id, {
          id: e.audio_playback_id,
          started: e.t_monotonic_ms,
          ended: null,
          interrupted: false,
          spoken_text: '',
          spoken_text_precision: 'time_proportional',
          origin: e.origin,
          candidate_id: 'candidate_id' in e ? e.candidate_id : null,
          playback_started_at: e.started_at,
          playback_ended_at: e.started_at,
          start_frame: e.audio_frame,
          end_frame: null,
        });
        break;
      case 'speech.ended':
      case 'speech.interrupted': {
        const row = speechById.get(e.audio_playback_id);
        if (row) {
          row.ended = e.t_monotonic_ms;
          row.interrupted = e.event === 'speech.interrupted';
          row.spoken_text = e.spoken_text;
          row.spoken_text_precision = e.spoken_text_precision;
          row.end_frame = e.audio_frame;
          row.playback_ended_at = e.event === 'speech.ended' ? e.ended_at : e.interrupted_at;
        }
        if (e.event === 'speech.interrupted') interrupts += 1;
        break;
      }
      case 'turn.allowed':
        anchors.push(e.t_monotonic_ms);
        recordedTurn.push({ t: e.t_monotonic_ms, allowed: e.turn_allowed, source: e.decision_source, reason: e.reason });
        {
          const { schema_version: _s, t_monotonic_ms: _t, wall_clock: _w, session_id: _id, condition: _c, time_basis: _b, event: _e, ...payload } = e;
          recordedAllowedPayloads.push({ t: e.t_monotonic_ms, payload: payload as TurnAllowedPayload });
        }
        if (workerStartedAt === null) {
          const m = /rewarm:([\d.]+)ms</.exec(e.reason);
          if (m) workerStartedAt = e.t_monotonic_ms - Number(m[1]);
        }
        break;
      case 'gaze.decision':
        anchors.push(e.t_monotonic_ms);
        recordedGaze.push({ t: e.t_monotonic_ms, target: e.target, reason: e.reason });
        break;
      case 'provider.status':
        if (e.provider === 'vap_freshness') {
          anchors.push(e.t_monotonic_ms);
          const m = e.reason.value === null ? null : /rewarm:([\d.]+)ms</.exec(e.reason.value);
          if (m && workerStartedAt === null) workerStartedAt = e.t_monotonic_ms - Number(m[1]);
        }
        if (e.provider.startsWith('completion:') && recordedCompletion === null) {
          recordedCompletion = e.status === 'ok' ? e.provider.slice('completion:'.length) : 'unavailable';
        }
        if (e.provider === 'browser_link') {
          if (e.status === 'down' && openDetach === null) openDetach = e.t_monotonic_ms;
          if (e.status === 'ok' && openDetach !== null) {
            detached.push({ start: openDetach, end: e.t_monotonic_ms });
            openDetach = null;
          }
        }
        break;
      default:
        break;
    }
  }
  const tEnd = events.reduce((m, e) => Math.max(m, e.t_monotonic_ms), 0);
  if (openDetach !== null) detached.push({ start: openDetach, end: tEnd + 1 });
  if (workerStartedAt === null && vap.length > 0) {
    workerStartedAt = (vap[0] as VapRow).recv;
    warnings.push('ワーカーの開始時刻が記録の理由から読めないので、最初の vap.state の時刻とした（助走の終わりがずれうる）');
  }

  // 記録の開始: speech.started（response）の直前の turn.allowed（許可）の tick。
  const recordedStarts: TuneStart[] = [];
  for (const speech of [...speechById.values()].sort((a, b) => a.started - b.started)) {
    if (speech.origin !== 'response') continue;
    let found: { t: number; payload: TurnAllowedPayload } | null = null;
    for (const row of recordedAllowedPayloads) {
      if (row.t > speech.started) break;
      if (row.payload.turn_allowed) found = row;
    }
    if (found === null) {
      warnings.push(`audio_playback_id=${speech.id} の開始の tick（turn.allowed）が見つからない`);
      continue;
    }
    recordedStarts.push(startOf(found.t, speech.id, found.payload));
  }

  const prepareLatencies = [...prefetchByRevision.values()].flatMap((p) => (p.ready === null ? [] : [p.ready - p.started]));
  const ackLatencies = recordedStarts.flatMap((s) => {
    const speech = speechById.get(s.audio_playback_id);
    return speech ? [speech.started - s.t] : [];
  });
  const speechLengths = [...speechById.values()].flatMap((s) => (s.ended !== null && !s.interrupted ? [s.ended - s.started] : []));

  // 受信済み音声の先頭は vap.state の audio_frame より VAP の処理の分だけ先にある。speech.* の audio_frame
  // （ブラウザの上りの番号）とその時刻で、外挿の進みを校正する。
  const raw = frameAtFactory(vap, 0);
  const leads: number[] = [];
  for (const e of events) {
    if (e.event === 'speech.started') leads.push(e.audio_frame - raw(e.started_at));
    if (e.event === 'speech.ended') leads.push(e.audio_frame - raw(e.ended_at));
  }
  const headLeadFrames = Math.max(0, Math.round(median(leads) ?? 0));

  // 連続する声の窓をまとめ、無音との境を窓の中央に置く。
  const sysVoiced: { start: number; end: number }[] = [];
  let run: { start: number; end: number; lastFrame: number } | null = null;
  for (const row of vap) {
    const contiguous = run !== null && row.frame - run.lastFrame === VAP_WINDOW_FRAMES;
    if (row.sysVoiced && contiguous && run !== null) {
      run.end = row.frame - VAP_WINDOW_FRAMES / 2;
      run.lastFrame = row.frame;
    } else {
      if (run !== null) sysVoiced.push({ start: run.start, end: run.end });
      run = row.sysVoiced ? { start: row.frame - VAP_WINDOW_FRAMES / 2, end: row.frame - VAP_WINDOW_FRAMES / 2, lastFrame: row.frame } : null;
    }
  }
  if (run !== null) sysVoiced.push({ start: run.start, end: run.end });

  const uniqueAnchors = [...new Set(anchors.map((a) => Math.round(a * 10) / 10))].sort((a, b) => a - b);
  const tStart = Math.min(...[uniqueAnchors[0] ?? Infinity, vap[0]?.recv ?? Infinity, stt[0]?.t_monotonic_ms ?? Infinity]);

  return {
    session_id: sessionId,
    events,
    vap,
    stt,
    prefetchByRevision,
    speechById,
    recordedStarts,
    recordedTurn,
    recordedGaze,
    recordedInterrupts: interrupts,
    recordedAllowedPayloads,
    workerStartedAt,
    recordedCompletion,
    detached,
    tickAnchors: uniqueAnchors,
    tStart: Number.isFinite(tStart) ? tStart : 0,
    tEnd,
    headLeadFrames,
    sysVoiced,
    medianPrepareMs: median(prepareLatencies),
    medianAckMs: median(ackLatencies),
    medianSpeechMs: median(speechLengths),
    warnings,
  };
}

function startOf(t: number, id: number, payload: TurnAllowedPayload): TuneStart {
  return {
    t: round1(t),
    audio_playback_id: id,
    decision_source: payload.decision_source,
    reason: payload.reason,
    gap_ms: payload.gap_ms.value === null ? null : round1(payload.gap_ms.value),
    p_now: payload.p_now.value,
    completion_p: payload.completion_p.value,
  };
}

/** tick の時刻。記録で tick の中に出たイベントの時刻（turn.allowed など）を通るように位相を合わせる。 */
export function tickTimes(log: Pick<PreparedLog, 'tickAnchors' | 'tStart' | 'tEnd'>, tickMs: number): number[] {
  const out: number[] = [];
  const anchors = log.tickAnchors.filter((a) => a >= log.tStart && a <= log.tEnd);
  let t = log.tStart;
  let i = 0;
  while (t <= log.tEnd) {
    out.push(t);
    let next = t + tickMs;
    while (i < anchors.length && (anchors[i] as number) <= t + tickMs / 2) i += 1;
    const anchor = anchors[i];
    if (anchor !== undefined && anchor < next + tickMs / 2) {
      next = anchor;
      i += 1;
    }
    t = next;
  }
  return out;
}

/** 記録の vap.state から、t の時点の受信済み音声の先頭を外挿する。 */
function frameAtFactory(vap: VapRow[], lead: number): (t: number) => number {
  return (t: number) => {
    if (vap.length === 0) return Math.max(0, Math.round(t * FRAMES_PER_MS));
    let lo = 0;
    let hi = vap.length - 1;
    if (t < (vap[0] as VapRow).recv) {
      const first = vap[0] as VapRow;
      return Math.max(0, Math.round(first.frame + lead - (first.recv - t) * FRAMES_PER_MS));
    }
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((vap[mid] as VapRow).recv <= t) lo = mid;
      else hi = mid - 1;
    }
    const row = vap[lo] as VapRow;
    return Math.round(row.frame + lead + (t - row.recv) * FRAMES_PER_MS);
  };
}

export function replay(log: PreparedLog, policy: Policy, options: ReplayOptions = {}): Omit<TuneReplayResult, 'initiative'> & { outcomes: TuneTurnOutcomes } {
  const fallbackEnergy = policy.policy_id === 'ja' ? (policy.turn.fallback_energy_silence_dbfs ?? null) : null;
  const tm = createTurnManager(policy, { fallback_energy_silence_threshold: fallbackEnergy });
  const settings = tm.settings;
  const assumptions: string[] = [];
  const warnings = [...log.warnings];
  const frameAt = frameAtFactory(log.vap, log.headLeadFrames);
  const assumedPrepare = options.assumed_prepare_ms ?? log.medianPrepareMs ?? 700;
  const assumedAck = log.medianAckMs ?? 15;
  const assumedSpeech = options.assumed_speech_ms ?? log.medianSpeechMs ?? 5000;
  const stopDelay = options.stop_report_delay_ms ?? 100;

  const policyEstimator = policy.policy_id === 'ja' ? policy.completion.estimator : null;
  // 記録のセッションで推定器が無かった（none、作れなかった）なら、方策が何であれ completion は無かったものとして再生する。
  // 記録の completion_p が null のままなのに再計算だけ値を持つと、準備（L46）と L74 の待ちが記録と食い違うため。
  const recordedNone = log.recordedCompletion === NO_ESTIMATOR || log.recordedCompletion === 'unavailable';
  const estimator = recordedNone ? null : policyEstimator;
  if (log.recordedCompletion !== null && policyEstimator !== null && log.recordedCompletion !== policyEstimator) {
    warnings.push(`記録のセッションの completion の推定器は ${log.recordedCompletion}、画面の方策は ${policyEstimator}。${recordedNone ? '記録に推定器がなかったので completion なしで再生する' : '方策の推定器で再生する'}`);
  }
  const replayCompletion = estimator === JA_RULES_ESTIMATOR;
  if (estimator !== null && !replayCompletion) {
    assumptions.push(`completion の推定器 ${estimator} は再生しない（completion_p は null。L46 の第1条件と L74 の表は p=0 で動く）`);
  }
  if (estimator === null) assumptions.push('completion の推定器なし（方策の設定どおり、completion_p は null）');

  // ---- 状態 ----
  let state: TurnState = tm.initialState();
  const history = new SessionHistory();
  const utterances = new UserUtterances();
  let vapIndex = -1;
  let sttIndex = 0;
  let transcript: TranscriptSnapshot | null = null;
  let completion: { p: Maybe<number>; revision: number | null } = { p: absent('no_estimate_yet'), revision: null };
  let prefetch: SimPrefetch | null = null;
  let lastSent: { text: string; segment_id: number } | null = null;
  let playback: SimPlayback | null = null;
  const usedRecordedIds = new Set<number>();
  let syntheticId = 100000;

  // segment の対応（記録の segment → 再計算の segment）。
  //  - 記録と同じ位置の境界（記録の j 番目の開始と COINCIDE_MS 以内）: 記録の segment j+1 を再計算の新しい segment へ。
  //    記録の割り当て（assembler が音声位置で決めた所属）をそのまま使う。
  //  - 再計算だけの境界: 今の記録の segment を音声位置 F で切り、F より後の結果を新しい segment へ。文は境界の時点の長さを除く。
  //  - 記録だけの境界: 記録の新しい segment を、再計算では前と同じ segment として扱う（文は記録で切られているので連結される）。
  const recordedBoundaryTimes = log.recordedStarts.map((s) => s.t);
  const usedRecordedBoundary = new Set<number>();
  const segmentMap = new Map<number, number>([[0, 0]]);
  const cuts = new Map<number, { frame: number; segment: number }>();
  let latestRecordedSegment = 0;
  const lastTextByKey = new Map<number, string>();
  const stripByKey = new Map<number, number>();
  let strippedBoundaries = 0;
  let recordedOnlyBoundaries = 0;
  let unmatchedPrepares = 0;
  let cancelledBeforeReady = 0;
  let unmatchedSpeech = 0;
  let unmatchedStops = 0;
  let sysUnknown = 0;

  // ---- 出力 ----
  const starts: TuneStart[] = [];
  const turnChanges: TuneTurnChange[] = [];
  const gaze: TuneGazeChange[] = [];
  const aiSpeech: TuneSpan[] = [];
  const prepares: { t: number; trigger: string; matched_recorded: boolean }[] = [];
  const diagnostics: TuneDiagnosticSample[] = [];
  const startDetails: ReplayStartDetail[] = [];
  const playbackDetails: ReplayPlaybackDetail[] = [];
  const noResponses: TurnOutcomeBody[] = [];
  let interrupts = 0;
  let lastReason: string | null = null;
  const outcomeSettings = turnOutcomeSettings(policy, settings);
  let lastAiEndAt: number | null = null;
  let lastUserVoiceAt: number | null = null;
  let voicePointer = 0;
  let latestAllowed: TurnAllowedPayload | null = null;
  let firedNoResponse: string | null = null;

  const keyOf = (e: SttEv) => e.segment_id * 1_000_000 + e.asr_segment_id;

  const onStt = (e: SttEv, now: number) => {
    const key = keyOf(e);
    const rec = e.segment_id;
    if (!segmentMap.has(rec)) {
      // 記録だけの境界。前の記録の segment の（切った後の）再計算の segment へ。
      let previous = 0;
      for (let s = rec - 1; s >= 0; s -= 1) {
        const cut = cuts.get(s);
        const mapped = cut?.segment ?? segmentMap.get(s);
        if (mapped !== undefined) {
          previous = mapped;
          break;
        }
      }
      segmentMap.set(rec, previous);
      recordedOnlyBoundaries += 1;
    }
    latestRecordedSegment = Math.max(latestRecordedSegment, rec);
    const cut = cuts.get(rec);
    const afterCut = cut !== undefined && e.audio_frame_end > cut.frame;
    const segment = afterCut ? cut.segment : (segmentMap.get(rec) as number);
    let text = e.text;
    const strip = afterCut ? stripByKey.get(key) : undefined;
    if (strip !== undefined) text = [...text].slice(strip).join('');
    lastTextByKey.set(key, e.text);
    const snapshot: TranscriptSnapshot = {
      segment_id: segment,
      asr_segment_id: key,
      asr_segment_frame_start: e.asr_segment_frame_start,
      transcript_revision: e.transcript_revision,
      text,
      stable_text: strip === undefined ? e.stable_text : '',
      unstable_text: strip === undefined ? e.unstable_text : text,
      is_final: e.event === 'stt.final',
      stability: e.stability,
      stability_source: e.stability_source,
      audio_frame_end: e.audio_frame_end,
      timing_precision: e.timing_precision,
      words: absent('not_used_in_replay'),
      received_at: now,
    };
    const whole = utterances.update(segment, key, text);
    history.upsertUserSegment({
      text: whole,
      segment_id: segment,
      transcript_revision: e.transcript_revision,
      is_final: snapshot.is_final,
      audio_frame_end: e.audio_frame_end,
    });
    transcript = snapshot;
    // session.ts の requestCompletion と同じ規則。
    if (segment < state.segment_id) return;
    if (!replayCompletion) {
      completion = { p: absent(estimator === null ? 'no_estimator_configured' : 'estimator_not_replayed'), revision: e.transcript_revision };
      return;
    }
    const partial = userTextFor(state, snapshot);
    const prior = history.snapshot().filter((h) => !(h.role === 'user' && h.segment_id === segment));
    const p = normalizePartial(partial) === '' ? absent('empty_partial') : present(scoreJaRules(prior, partial).p);
    if (e.transcript_revision >= (completion.revision ?? -1)) completion = { p, revision: e.transcript_revision };
  };

  const onBoundary = (now: number, frame: number, newSegment: number) => {
    const j = recordedBoundaryTimes.findIndex((t, i) => !usedRecordedBoundary.has(i) && Math.abs(t - now) <= COINCIDE_MS);
    if (j >= 0) {
      usedRecordedBoundary.add(j);
      segmentMap.set(j + 1, newSegment);
      return;
    }
    strippedBoundaries += 1;
    cuts.set(latestRecordedSegment, { frame, segment: newSegment });
    for (const [key, text] of lastTextByKey) stripByKey.set(key, [...text].length);
  };

  const sysSilenceMs = (p: SimPlayback, now: number): number => {
    if (p.shift === null) {
      sysUnknown += 1;
      return 0;
    }
    // 音声位置で数える（session の PlaybackTracker と同じ。VAP の処理の遅れを含めない）。
    // 声の区間（log.sysVoiced）は窓の境目の位置が分からないので、無音との境は窓の中央とした近似。
    const head = frameAt(now);
    const startedFrame = frameAt(p.begin_at);
    const shiftFrames = Math.round(p.shift * FRAMES_PER_MS);
    let lastVoiced = -Infinity;
    for (const run of log.sysVoiced) {
      if (run.start + shiftFrames >= head) break;
      lastVoiced = Math.max(lastVoiced, Math.min(run.end + shiftFrames, head));
    }
    return Math.max(0, (head - Math.max(lastVoiced, startedFrame)) / FRAMES_PER_MS);
  };

  const commitPlayback = (p: SimPlayback) => {
    if (p.committed) return;
    p.committed = true;
    playbackDetails.push({ id: p.id, begin_at: p.begin_at, end_at: p.end_at, interrupted: p.interrupted, spoken_text: p.rec?.spoken_text ?? null });
    lastAiEndAt = p.end_at;
    aiSpeech.push({ start: round1(p.begin_at), end: round1(p.end_at), label: `#${p.id}${p.interrupted ? ' 割り込み' : ''}` });
    history.commitAssistantSpoken(
      {
        text: p.rec?.spoken_text ?? '',
        audio_playback_id: p.id,
        spoken_text_precision: p.rec?.spoken_text_precision ?? ('time_proportional'),
        interrupted: p.interrupted,
        origin: { kind: 'response' },
      },
      state.segment_id,
    );
  };

  const inputsAt = (now: number): TurnInputs => {
    const row = vapIndex >= 0 ? (log.vap[vapIndex] as VapRow) : null;
    const t = transcript as TranscriptSnapshot | null;
    const prefetchInput: PrefetchInput =
      prefetch === null
        ? { state: 'idle' }
        : {
            state: now >= prefetch.ready_at ? 'ready' : 'preparing',
            audio_playback_id: prefetch.id,
            segment_id: prefetch.segment_id,
            transcript_revision: prefetch.transcript_revision,
            started_at: prefetch.started_at,
          };
    let playbackInput: PlaybackInput = { state: 'idle' };
    // 記録の時刻がちょうど tick の時刻と同じ報告は、その tick の後に届いたとみなす（台本の試験で起きる。実機の時刻は小数で重ならない）。
    if (playback !== null && now > playback.begin_at && now <= playback.end_at) {
      playbackInput = {
        state: 'playing',
        audio_playback_id: playback.id,
        samples_written: Math.round((now - playback.begin_at) * FRAMES_PER_MS),
        system_silence_ms: sysSilenceMs(playback, now),
      };
    }
    const detached = log.detached.some((d) => now >= d.start && now < d.end);
    const blocked =
      detached ? 'browser_detached' : playback !== null && now <= playback.end_at ? `another_playback_active:${playback.id}` : null;
    let similarity: Maybe<number>;
    if (t === null) similarity = absent('no_transcript_yet');
    else if (lastSent === null) similarity = absent('no_previous_prepare');
    else if (lastSent.segment_id !== state.segment_id) similarity = absent('previous_prepare_in_other_segment');
    else similarity = present(charNgramCosine(userTextFor(state, t), lastSent.text));
    return {
      vap: row === null ? absent('no_vap_state_since_ready') : present(row.state),
      vap_received_at: row === null ? absent('no_vap_state_since_ready') : present(row.recv),
      start_blocked_reason: blocked,
      received_audio_frame: Math.max(0, frameAt(now)),
      vap_worker_started_at:
        log.workerStartedAt === null || now < log.workerStartedAt ? absent('worker_not_ready') : present(log.workerStartedAt),
      fallback_energy: absent('not_recorded_in_log'),
      transcript: t === null ? absent('no_transcript_yet') : present(t),
      completion_p: completion.p,
      completion_revision: completion.revision === null ? absent('no_estimate_yet') : present(completion.revision),
      similarity_to_prepared: similarity,
      prefetch: prefetchInput,
      playback: playbackInput,
      woz: [],
    };
  };

  const dispatch = (d: TurnDecision, now: number) => {
    switch (d.kind) {
      case 'prepare': {
        const rec = log.prefetchByRevision.get(d.transcript_revision);
        const matched = rec !== undefined && rec.ready !== null && !usedRecordedIds.has(rec.id);
        const id = matched ? (rec as RecordedPrefetch).id : (syntheticId += 1);
        if (matched) usedRecordedIds.add(id);
        else if (rec !== undefined && rec.ready === null) cancelledBeforeReady += 1;
        else unmatchedPrepares += 1;
        const latency = matched ? ((rec as RecordedPrefetch).ready as number) - (rec as RecordedPrefetch).started : assumedPrepare;
        prefetch = { id, segment_id: d.segment_id, transcript_revision: d.transcript_revision, started_at: now, ready_at: now + latency };
        lastSent = { text: d.text, segment_id: d.segment_id };
        prepares.push({ t: round1(now), trigger: d.trigger, matched_recorded: matched });
        return;
      }
      case 'cancel_prepare':
        if (prefetch?.id === d.audio_playback_id) prefetch = null;
        return;
      case 'start_speech': {
        const rec = log.speechById.get(d.audio_playback_id) ?? null;
        const recStart = log.recordedStarts.find((s) => s.audio_playback_id === d.audio_playback_id);
        const usable = rec !== null && rec.ended !== null && recStart !== undefined;
        const ack = usable ? rec.started - (recStart as TuneStart).t : assumedAck;
        const begin = now + ack;
        const length = usable ? (rec.ended as number) - rec.started : assumedSpeech;
        if (!usable) unmatchedSpeech += 1;
        playback = {
          id: d.audio_playback_id,
          requested_at: now,
          begin_at: begin,
          end_at: begin + length,
          rec: usable ? rec : null,
          shift: usable ? begin - rec.started : null,
          interrupted: false,
          committed: false,
        };
        prefetch = null;
        return;
      }
      case 'interrupt_speech': {
        interrupts += 1;
        const p = playback;
        if (p === null || p.id !== d.audio_playback_id) return;
        p.interrupted = true;
        const recEnd = p.rec?.interrupted && p.rec.ended !== null && p.shift !== null ? p.rec.ended + p.shift : null;
        if (recEnd !== null && recEnd >= now && recEnd <= now + 1500) p.end_at = Math.min(p.end_at, recEnd);
        else {
          unmatchedStops += 1;
          p.end_at = Math.min(p.end_at, now + d.max_wait_ms + stopDelay);
        }
        return;
      }
      case 'advance_segment':
        onBoundary(now, d.at_audio_frame, d.new_segment_id);
        return;
      case 'turn_allowed':
        lastReason = d.payload.reason;
        turnChanges.push({ t: round1(now), allowed: d.payload.turn_allowed, source: d.payload.decision_source, reason: d.payload.reason });
        return;
      case 'gaze':
        gaze.push({ t: round1(now), target: d.payload.target, reason: d.payload.reason });
        return;
      case 'set_degraded':
        return;
    }
  };

  const ticks = tickTimes(log, settings.tick_ms);
  ticks.forEach((now, tickIndex) => {
    while (vapIndex + 1 < log.vap.length && (log.vap[vapIndex + 1] as VapRow).recv <= now) vapIndex += 1;
    while (sttIndex < log.stt.length && (log.stt[sttIndex] as SttEv).t_monotonic_ms < now) {
      onStt(log.stt[sttIndex] as SttEv, (log.stt[sttIndex] as SttEv).t_monotonic_ms);
      sttIndex += 1;
    }
    if (playback !== null && now > playback.end_at && !playback.committed) commitPlayback(playback);

    const inputs = inputsAt(now);
    const { state: next, decisions } = tm.step(state, inputs, now);
    state = next;
    if (outcomeSettings !== null) {
      for (const d of decisions) if (d.kind === 'turn_allowed') latestAllowed = d.payload;
      while (voicePointer <= vapIndex) {
        const v = log.vap[voicePointer] as VapRow;
        voicePointer += 1;
        if (v.vadUser >= outcomeSettings.speaking_threshold) lastUserVoiceAt = v.recv;
      }
      const missing = noResponseOutcome(
        { now, state, latest_allowed: latestAllowed, last_user_voice_at: lastUserVoiceAt, last_ai_end_at: lastAiEndAt, start_blocked_reason: inputs.start_blocked_reason ?? null, fired_key: firedNoResponse },
        outcomeSettings,
      );
      if (missing !== null) {
        firedNoResponse = missing.key;
        noResponses.push(missing.body);
      }
    }
    for (const d of decisions) {
      if (d.kind === 'start_speech') {
        const payload = decisions.find((x) => x.kind === 'turn_allowed') as Extract<TurnDecision, { kind: 'turn_allowed' }> | undefined;
        if (payload) {
          starts.push(startOf(now, d.audio_playback_id, payload.payload));
          const row = vapIndex >= 0 ? (log.vap[vapIndex] as VapRow) : null;
          startDetails.push({
            t: now,
            audio_playback_id: d.audio_playback_id,
            segment_id: state.segment_id,
            origin: 'response',
            frame: inputs.received_audio_frame,
            payload: payload.payload,
            vad: row === null ? null : { user: row.state.vad[0], ai: row.state.vad[1] },
            vap_age_ms: row === null ? null : now - row.recv,
          });
        }
      }
      dispatch(d, now);
    }
    if (tickIndex % DIAGNOSTIC_EVERY_TICKS === 0) {
      const row = vapIndex >= 0 ? (log.vap[vapIndex] as VapRow).state : null;
      diagnostics.push(buildTurnDiagnostic(settings, state, row, now, lastReason));
    }
  });
  if (playback !== null && !(playback as SimPlayback).committed) commitPlayback(playback as SimPlayback);

  // ---- 仮定 ----
  assumptions.push(
    '反実仮想の限界: AI の発話の時刻が変わっても、その後の利用者の振る舞い（記録の音声、STT、VAP の値）は記録のまま変わらない',
    '応答の LLM と TTS は呼ばない。準備の完了は、記録の同じ transcript_revision の準備の時間（prefetch.started→ready）を使う',
    'fallback_energy は記録にないので null（VAP の鮮度切れ・助走中の開始と割り込みは再現しない）',
    `system チャネルの無音（視線のポーズ）は記録の vap.state の x2_peak（80ms 窓、最大値が -40 dBFS 以上を声、声と無音の境は窓の中央とみなす）から音声位置で近似。記録の 20ms 枠の RMS より粗い`,
  );
  if (unmatchedPrepares > 0) {
    assumptions.push(`記録と対応のない準備 ${unmatchedPrepares} 件は、完了まで ${Math.round(assumedPrepare)}ms（${options.assumed_prepare_ms !== undefined ? '画面の指定' : '記録の中央値'}）と仮定`);
  }
  if (cancelledBeforeReady > 0) {
    assumptions.push(`記録では完了の前に取り消された準備 ${cancelledBeforeReady} 件は、完了まで ${Math.round(assumedPrepare)}ms と仮定（記録に完了の時刻がない）`);
  }
  if (unmatchedSpeech > 0) {
    assumptions.push(
      `記録と対応のない再生 ${unmatchedSpeech} 件は、開始の報告まで ${Math.round(assumedAck)}ms、長さ ${Math.round(assumedSpeech)}ms（${options.assumed_speech_ms !== undefined ? '画面の指定' : '記録の中央値'}）と仮定。その間の system チャネルは声が続くとみなす（視線のポーズなし）`,
    );
  }
  if (unmatchedStops > 0) assumptions.push(`記録と対応のない割り込み ${unmatchedStops} 件は、max_wait_ms＋${stopDelay}ms で止まると仮定`);
  if (strippedBoundaries > 0) {
    assumptions.push(
      `記録と違う位置の segment の境界 ${strippedBoundaries} 件: 境界の時点の文の長さまでを旧 segment とし、伸びた分だけを新しい発話として扱った（assembler の近似）`,
    );
  }
  if (recordedOnlyBoundaries > 0) {
    assumptions.push(`記録だけにある segment の境界 ${recordedOnlyBoundaries} 件: 記録で切られた文を、同じ発話の続きとして連結した`);
  }
  if (sysUnknown > 0 && unmatchedSpeech === 0) warnings.push('system チャネルの無音を近似できない再生があった');

  // ---- 比較 ----
  const match = matchStarts(log.recordedStarts, starts);
  const divergences = explainDivergences(log, starts, match, diagnostics, turnChanges);

  const recordedAi: TuneSpan[] = [...log.speechById.values()]
    .filter((s) => s.ended !== null)
    .map((s) => ({ start: round1(s.started), end: round1(s.ended as number), label: `#${s.id}${s.interrupted ? ' 割り込み' : ''}` }));
  const thr = settings.direction.speaking_threshold ?? 0.5;
  const outcomes = turnOutcomesFor(log, outcomeSettings, frameAt, startDetails, playbackDetails, noResponses);
  const metricBase: Omit<MetricInputs, 'starts' | 'ai_speech' | 'gaze' | 'interrupts'> = {
    vap: log.vap.map((v) => ({ t: v.t, vad_user: v.vadUser })),
    stt: log.stt.map((e) => ({
      t: e.t_monotonic_ms,
      key: keyOf(e),
      audio_frame_end: e.audio_frame_end,
      text: e.text,
    })),
    frameAt,
    speaking_threshold: thr,
    t_end: log.tEnd,
  };
  return {
    session_id: log.session_id,
    policy_id: policy.policy_id,
    tick_ms: settings.tick_ms,
    t_start: round1(log.tStart),
    t_end: round1(log.tEnd),
    recorded: {
      starts: log.recordedStarts,
      ai_speech: recordedAi,
      turn_changes: log.recordedTurn.map((r) => ({ ...r, t: round1(r.t) })),
      gaze: log.recordedGaze.map((g) => ({ ...g, t: round1(g.t) })),
      metrics: computeMetrics({ ...metricBase, starts: log.recordedStarts, ai_speech: recordedAi, gaze: log.recordedGaze, interrupts: log.recordedInterrupts }),
    },
    replayed: {
      starts,
      ai_speech: aiSpeech,
      turn_changes: turnChanges,
      gaze,
      prepares,
      metrics: computeMetrics({ ...metricBase, starts, ai_speech: aiSpeech, gaze, interrupts }),
      diagnostics,
    },
    start_match: match.summary,
    divergences,
    assumptions,
    warnings,
    outcomes,
  };
}

function turnOutcomesFor(
  log: PreparedLog,
  settings: ReturnType<typeof turnOutcomeSettings>,
  frameAt: (t: number) => number,
  starts: ReplayStartDetail[],
  playbacks: ReplayPlaybackDetail[],
  noResponses: TurnOutcomeBody[],
): TuneTurnOutcomes {
  if (settings === null) return { recorded: [], replayed: [], note: 'この方策に turn.outcome がないので、発話の結果を分類していない' };
  const rows = outcomeRows(log, (e) => e.segment_id * 1_000_000 + e.asr_segment_id);
  const hasRecorded = log.events.some((e) => e.event === 'turn.outcome');
  return {
    recorded: recordedTurnOutcomes(log, rows, settings, frameAt),
    replayed: [...replayedTurnOutcomes(starts, playbacks, rows, settings, frameAt), ...noResponses],
    note: hasRecorded ? null : '記録に turn.outcome がない古いログなので、記録の側は記録の入力から同じ規則で算出した（no_response は再計算の側だけ）',
  };
}

interface StartMatch {
  pairs: { recorded: TuneStart; replayed: TuneStart }[];
  recordedOnly: TuneStart[];
  replayedOnly: TuneStart[];
  summary: TuneReplayResult['start_match'];
}

export function matchStarts(recorded: TuneStart[], replayed: TuneStart[]): StartMatch {
  const used = new Set<number>();
  const pairs: StartMatch['pairs'] = [];
  const recordedOnly: TuneStart[] = [];
  for (const r of recorded) {
    let best = -1;
    let bestDiff = Infinity;
    replayed.forEach((p, i) => {
      const diff = Math.abs(p.t - r.t);
      if (!used.has(i) && diff <= MATCH_MS && diff < bestDiff) {
        best = i;
        bestDiff = diff;
      }
    });
    if (best >= 0) {
      used.add(best);
      pairs.push({ recorded: r, replayed: replayed[best] as TuneStart });
    } else recordedOnly.push(r);
  }
  const replayedOnly = replayed.filter((_, i) => !used.has(i));
  const shifts = pairs.map((p) => Math.abs(p.replayed.t - p.recorded.t));
  return {
    pairs,
    recordedOnly,
    replayedOnly,
    summary: {
      matched: pairs.length,
      recorded_only: recordedOnly.length,
      replayed_only: replayedOnly.length,
      max_abs_shift_ms: shifts.length === 0 ? null : round1(Math.max(...shifts)),
    },
  };
}

function nearestDiagnostic(diagnostics: TuneDiagnosticSample[], t: number): TuneDiagnosticSample | null {
  let best: TuneDiagnosticSample | null = null;
  for (const d of diagnostics) {
    if (d.t_monotonic_ms > t + 1) break;
    best = d;
  }
  return best;
}

function fmt(v: number | null | undefined, digits = 2): string {
  return v === null || v === undefined ? '-' : v.toFixed(digits);
}

function explainDivergences(
  log: PreparedLog,
  replayed: TuneStart[],
  match: StartMatch,
  diagnostics: TuneDiagnosticSample[],
  turnChanges: TuneTurnChange[],
): TuneDivergence[] {
  const out: TuneDivergence[] = [];
  for (const r of match.recordedOnly) {
    const d = nearestDiagnostic(diagnostics, r.t);
    const near = replayed.find((p) => Math.abs(p.t - r.t) < 3000);
    out.push({
      t: r.t,
      kind: 'recorded_start_missing',
      detail:
        `記録は ${r.decision_source}（${r.reason}）で開始、再計算は ${near ? `${round1(near.t - r.t)}ms ずれて開始` : '3 秒以内に開始なし'}。` +
        ` 記録の値: p_now=${fmt(r.p_now)} completion=${fmt(r.completion_p)} 間=${fmt(r.gap_ms, 0)}ms。` +
        (d
          ? ` 再計算の値（直前の標本）: p_now=${fmt(d.p_now_ai)} completion=${fmt(d.completion_p)} 間=${fmt(d.gap_ms, 0)}ms 待ち=${d.completion_wait_ms}ms 準備=${d.want_to_speak} AI=${d.ai_phase}`
          : ''),
    });
  }
  for (const p of match.replayedOnly) {
    out.push({
      t: p.t,
      kind: 'replayed_start_extra',
      detail: `再計算だけが ${p.decision_source}（${p.reason}）で開始。p_now=${fmt(p.p_now)} completion=${fmt(p.completion_p)} 間=${fmt(p.gap_ms, 0)}ms`,
    });
  }
  for (const { recorded, replayed: p } of match.pairs) {
    const differs: string[] = [];
    if (recorded.decision_source !== p.decision_source) differs.push(`判断の元 ${recorded.decision_source}→${p.decision_source}`);
    if (recorded.completion_p !== null && p.completion_p !== null && Math.abs(recorded.completion_p - p.completion_p) > 1e-6) {
      differs.push(`completion ${fmt(recorded.completion_p)}→${fmt(p.completion_p)}`);
    }
    if (differs.length > 0 || Math.abs(recorded.t - p.t) > 25) {
      out.push({
        t: recorded.t,
        kind: 'matched_with_difference',
        detail: `開始は対応（ずれ ${round1(p.t - recorded.t)}ms）。${differs.join('、') || '値は同じ'}`,
      });
    }
  }
  // turn.allowed の並びの最初の食い違い。
  const rec = log.recordedTurn;
  const n = Math.min(rec.length, turnChanges.length);
  for (let i = 0; i < n; i += 1) {
    const a = rec[i] as TuneTurnChange;
    const b = turnChanges[i] as TuneTurnChange;
    if (a.allowed !== b.allowed || a.source !== b.source || Math.abs(a.t - b.t) > MATCH_MS) {
      out.push({
        t: round1(Math.min(a.t, b.t)),
        kind: 'first_turn_allowed_difference',
        detail: `turn.allowed の ${i + 1} 件目で食い違い: 記録 ${round1(a.t)}ms ${a.allowed ? '許可' : '不許可'}/${a.source}（${a.reason}）、再計算 ${round1(b.t)}ms ${b.allowed ? '許可' : '不許可'}/${b.source}（${b.reason}）`,
      });
      break;
    }
  }
  return out.sort((a, b) => a.t - b.t);
}
