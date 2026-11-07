/**
 * 遅延の区間（計画 §3.6、仕様§5）の分位点。純粋関数で、ブラウザからも読む。
 *
 * 規則:
 *  - データのない区間は 0 でなく unmeasured と理由を返す。行そのものは消さない。
 *  - 別プロセスの時刻は補正済みのものだけを比べる（追補2）。signal.started と speech.started は
 *    time_basis が browser_rtt でなければ、envelope からは補正の有無が分からないので標本に入れない。
 *  - 負の値は時計補正の誤差の証拠なので捨てずに含め、件数を残す。
 *  - decision_at／cue_at／speech_at は decided_at、signal.started の started_at、speech.started の
 *    started_at の別名で、candidateTimeline が候補ごとに別々の値として出す（時刻を二重に持たない）。
 */
import {
  LlmPurpose,
  SAMPLE_RATE_HZ,
  type EventOf,
  type ResearchEvent,
  type TimingPrecision,
} from '@llm-vap/contracts';
import { normalizeForMatch } from './text';

// ---- 分位点 ----------------------------------------------------------------

/** 線形補間（R-7、numpy の既定と同じ）。sorted は昇順。空なら null。 */
export function quantile(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const a = sorted[lower] as number;
  const b = sorted[upper] as number;
  return a + (b - a) * (position - lower);
}

export interface LatencySample {
  ms: number;
  /** 両端の推定誤差の和。片方でも不明なら null。 */
  uncertainty_ms: number | null;
}

export type LatencyStat =
  | {
      status: 'measured';
      n: number;
      p50: number;
      p90: number;
      p95: number;
      min: number;
      max: number;
      /** 標本の誤差の最大。誤差が不明な標本があれば null。 */
      uncertainty_ms_max: number | null;
      negative_count: number;
      /** 測れなかった件数（理由別）。 */
      excluded: Record<string, number>;
    }
  | {
      status: 'unmeasured';
      n: 0;
      reason: string;
      excluded: Record<string, number>;
    };

export function latencyStat(
  samples: readonly LatencySample[],
  excluded: Record<string, number> = {},
  emptyReason = 'no_samples_in_log',
): LatencyStat {
  const valid = samples.filter((s) => Number.isFinite(s.ms));
  if (valid.length === 0) {
    const reasons = Object.keys(excluded);
    return {
      status: 'unmeasured',
      n: 0,
      reason: reasons.length > 0 ? `all_excluded:${reasons.join(',')}` : emptyReason,
      excluded,
    };
  }
  const sorted = valid.map((s) => s.ms).sort((a, b) => a - b);
  let uncertainty: number | null = 0;
  for (const sample of valid) {
    if (sample.uncertainty_ms === null) {
      uncertainty = null;
      break;
    }
    uncertainty = Math.max(uncertainty, sample.uncertainty_ms);
  }
  return {
    status: 'measured',
    n: sorted.length,
    p50: quantile(sorted, 0.5) as number,
    p90: quantile(sorted, 0.9) as number,
    p95: quantile(sorted, 0.95) as number,
    min: sorted[0] as number,
    max: sorted[sorted.length - 1] as number,
    uncertainty_ms_max: uncertainty,
    negative_count: sorted.filter((v) => v < 0).length,
    excluded,
  };
}

// ---- 候補ごとの時刻 --------------------------------------------------------

export type TimePoint =
  | { status: 'measured'; t_ms: number; uncertainty_ms: number | null }
  | {
      status: 'unmeasured';
      reason: string;
      /** その時刻を持つイベント自体がない（候補が撤回されたなど）。除外の件数に数えない。 */
      absent: boolean;
    };

export interface CandidateTimelineRow {
  candidate_id: string;
  /**
   * オンラインの近似（計画 §3.6）: span を初めて含む revision の audio_frame_end を時刻へ写した値。
   * 正式な値は保存音声の事後整列で、content_evidence_posthoc に入る。区分は precision を見る。
   */
  content_evidence_online: TimePoint;
  content_evidence_precision: TimingPrecision | null;
  content_evidence_posthoc: TimePoint;
  /** t_transcript: 同じ span を初めて含む stt イベントの受信時刻。 */
  transcript: TimePoint;
  /** t_initiative_decision = decided_at。 */
  decision_at: TimePoint;
  /** t_breath_start = 吸気の signal.started の started_at。 */
  cue_at: TimePoint;
  /** t_speech_start = speech.started の started_at。 */
  speech_at: TimePoint;
}

function uncertaintyOf(event: ResearchEvent): number | null {
  return event.time_basis.uncertainty_ms.value;
}

const ABSENT = (reason: string): TimePoint => ({ status: 'unmeasured', reason, absent: true });
const EXCLUDED = (reason: string): TimePoint => ({ status: 'unmeasured', reason, absent: false });

type SttEvent = EventOf<'stt.interim'> | EventOf<'stt.final'>;
type NewDecision = Extract<EventOf<'initiative.decision'>, { decision: 'NEW' }>;

/** audio_frame → orchestrator 時刻。ブラウザの audio.health（補正済み）を基準点にする。 */
export interface FrameClock {
  toMs(frame: number): { t_ms: number; uncertainty_ms: number | null } | { reason: string };
}

const MAX_ANCHOR_DISTANCE_FRAMES = 60 * SAMPLE_RATE_HZ;
const FRAMES_PER_MS = SAMPLE_RATE_HZ / 1000;

export function buildFrameClock(events: readonly ResearchEvent[]): FrameClock {
  const anchors: { frame: number; t_ms: number; uncertainty_ms: number | null }[] = [];
  for (const event of events) {
    if (event.event !== 'audio.health' || event.reporter !== 'browser') continue;
    if (event.time_basis.source !== 'browser_rtt') continue;
    anchors.push({
      frame: event.audio_frame,
      t_ms: event.t_monotonic_ms,
      uncertainty_ms: uncertaintyOf(event),
    });
  }
  anchors.sort((a, b) => a.frame - b.frame);
  return {
    toMs(frame) {
      if (anchors.length === 0) return { reason: 'no_audio_frame_time_anchor' };
      let low = 0;
      let high = anchors.length - 1;
      while (low < high) {
        const mid = (low + high) >> 1;
        if ((anchors[mid] as { frame: number }).frame < frame) low = mid + 1;
        else high = mid;
      }
      const after = anchors[low] as (typeof anchors)[number];
      const before = low > 0 ? (anchors[low - 1] as (typeof anchors)[number]) : after;
      const nearest = Math.abs(before.frame - frame) <= Math.abs(after.frame - frame) ? before : after;
      if (Math.abs(nearest.frame - frame) > MAX_ANCHOR_DISTANCE_FRAMES) {
        return { reason: 'audio_frame_anchor_too_far' };
      }
      return {
        t_ms: nearest.t_ms + (frame - nearest.frame) / FRAMES_PER_MS,
        uncertainty_ms: nearest.uncertainty_ms,
      };
    },
  };
}

function isStt(event: ResearchEvent): event is SttEvent {
  return event.event === 'stt.interim' || event.event === 'stt.final';
}

/**
 * span を初めて含む STT イベント。根拠の ASR 区間の最新テキストを番号順に連結して探す
 * （span が区間をまたぐ場合があり、別の区間の同じ語に誤って当たらないようにする）。
 * LLM に渡したあとの revision は根拠になりえないので sent_at までに限る。
 */
function firstSttContaining(
  stt: readonly SttEvent[],
  decision: NewDecision,
): SttEvent | null {
  const span = normalizeForMatch(decision.evidence_span.value);
  if (span.length === 0) return null;
  const ids = [...decision.evidence_segment_ids.value].sort((a, b) => a - b);
  const latest = new Map<number, string>();
  for (const event of stt) {
    if (event.t_monotonic_ms > decision.sent_at) break;
    latest.set(event.asr_segment_id, normalizeForMatch(event.text));
    const joined = ids.map((id) => latest.get(id) ?? '').join('');
    if (joined.includes(span)) return event;
  }
  return null;
}

function browserTime(event: ResearchEvent, t_ms: number): TimePoint {
  if (event.time_basis.source !== 'browser_rtt') return EXCLUDED('endpoint_clock_uncorrected');
  return { status: 'measured', t_ms, uncertainty_ms: uncertaintyOf(event) };
}

export function candidateTimeline(events: readonly ResearchEvent[]): CandidateTimelineRow[] {
  const stt = events.filter(isStt).sort((a, b) => a.t_monotonic_ms - b.t_monotonic_ms);
  const frameClock = buildFrameClock(events);
  const firstCue = new Map<string, EventOf<'signal.started'>>();
  const firstSpeech = new Map<string, EventOf<'speech.started'>>();
  for (const event of events) {
    if (event.event === 'signal.started' && event.phase === 'inhale' && !firstCue.has(event.candidate_id)) {
      firstCue.set(event.candidate_id, event);
    }
    if (event.event === 'speech.started' && event.origin === 'candidate' && !firstSpeech.has(event.candidate_id)) {
      firstSpeech.set(event.candidate_id, event);
    }
  }

  const rows: CandidateTimelineRow[] = [];
  for (const event of events) {
    if (event.event !== 'initiative.decision' || event.decision !== 'NEW') continue;
    const found = event.evidence_valid.value ? firstSttContaining(stt, event) : null;
    let online: TimePoint;
    let transcript: TimePoint;
    if (!event.evidence_valid.value) {
      online = EXCLUDED('evidence_invalid');
      transcript = EXCLUDED('evidence_invalid');
    } else if (found === null) {
      online = EXCLUDED('evidence_span_not_found_in_stt');
      transcript = EXCLUDED('evidence_span_not_found_in_stt');
    } else {
      transcript = {
        status: 'measured',
        t_ms: found.t_monotonic_ms,
        uncertainty_ms: uncertaintyOf(found),
      };
      const mapped = frameClock.toMs(found.audio_frame_end);
      online =
        'reason' in mapped
          ? EXCLUDED(mapped.reason)
          : { status: 'measured', t_ms: mapped.t_ms, uncertainty_ms: mapped.uncertainty_ms };
    }
    const precision = found?.timing_precision ?? null;
    const isPosthoc = precision === 'posthoc_alignment';

    const cueEvent = firstCue.get(event.candidate_id);
    let cue: TimePoint;
    if (cueEvent === undefined) cue = ABSENT('no_signal_started');
    else if (!cueEvent.visible) cue = EXCLUDED('signal_not_visible');
    else cue = browserTime(cueEvent, cueEvent.started_at);

    const speechEvent = firstSpeech.get(event.candidate_id);
    let speech: TimePoint;
    if (speechEvent === undefined) speech = ABSENT('no_speech_started');
    else if (speechEvent.output_latency_ms.value === null) speech = EXCLUDED('output_latency_unknown');
    else speech = browserTime(speechEvent, speechEvent.started_at);

    rows.push({
      candidate_id: event.candidate_id,
      content_evidence_online: isPosthoc ? ABSENT('stt_is_posthoc') : online,
      content_evidence_precision: precision,
      content_evidence_posthoc: isPosthoc ? online : ABSENT('posthoc_alignment_not_in_log'),
      transcript,
      decision_at: { status: 'measured', t_ms: event.decided_at, uncertainty_ms: uncertaintyOf(event) },
      cue_at: cue,
      speech_at: speech,
    });
  }
  return rows;
}

// ---- 区間 ------------------------------------------------------------------

export interface LatencyRow {
  /** 区間の識別子。precision と合わせて一意。 */
  id: string;
  from: string;
  to: string;
  group: 'chain' | 'component';
  /** t_content_evidence の区分。purpose など他の内訳もここに入れる。 */
  breakdown: string | null;
  stat: LatencyStat;
}

export interface LatencyReport {
  rows: LatencyRow[];
  timeline: CandidateTimelineRow[];
}

class Bucket {
  readonly samples: LatencySample[] = [];
  readonly excluded: Record<string, number> = {};
  add(from: TimePoint, to: TimePoint): void {
    for (const point of [from, to]) {
      if (point.status === 'unmeasured') {
        if (!point.absent) this.excluded[point.reason] = (this.excluded[point.reason] ?? 0) + 1;
        return;
      }
    }
    const a = from as Extract<TimePoint, { status: 'measured' }>;
    const b = to as Extract<TimePoint, { status: 'measured' }>;
    this.samples.push({
      ms: b.t_ms - a.t_ms,
      uncertainty_ms:
        a.uncertainty_ms === null || b.uncertainty_ms === null ? null : a.uncertainty_ms + b.uncertainty_ms,
    });
  }
}

const POSTHOC: TimingPrecision = 'posthoc_alignment';
const ONLINE_PLACEHOLDER = 'online';

export function computeLatencyReport(events: readonly ResearchEvent[]): LatencyReport {
  const timeline = candidateTimeline(events);
  const rows: LatencyRow[] = [];

  // 発話希望の連鎖。正式（事後整列）とオンラインの近似は混ぜない。
  const precisions = new Set<string>();
  for (const row of timeline) {
    const p = row.content_evidence_precision;
    if (p !== null && p !== POSTHOC) precisions.add(p);
  }
  if (precisions.size === 0) precisions.add(ONLINE_PLACEHOLDER);
  const evidenceTargets = [
    { id: 'content_evidence_to_transcript', to: 't_transcript', pick: (r: CandidateTimelineRow) => r.transcript },
    { id: 'content_evidence_to_decision', to: 't_initiative_decision', pick: (r: CandidateTimelineRow) => r.decision_at },
    { id: 'content_evidence_to_speech', to: 't_speech_start', pick: (r: CandidateTimelineRow) => r.speech_at },
  ];
  for (const target of evidenceTargets) {
    for (const precision of [...precisions].sort()) {
      const bucket = new Bucket();
      for (const row of timeline) {
        const p = row.content_evidence_precision;
        const matches = p === precision || (precision === ONLINE_PLACEHOLDER && p === null);
        if (matches) bucket.add(row.content_evidence_online, target.pick(row));
      }
      rows.push({
        id: target.id,
        from: 't_content_evidence',
        to: target.to,
        group: 'chain',
        breakdown: `online:${precision}`,
        stat: latencyStat(bucket.samples, bucket.excluded),
      });
    }
    const posthoc = new Bucket();
    for (const row of timeline) posthoc.add(row.content_evidence_posthoc, target.pick(row));
    rows.push({
      id: target.id,
      from: 't_content_evidence',
      to: target.to,
      group: 'chain',
      breakdown: `official:${POSTHOC}`,
      stat: latencyStat(posthoc.samples, posthoc.excluded, 'posthoc_alignment_not_in_log'),
    });
  }

  const chain = [
    { id: 'transcript_to_decision', from: 't_transcript', to: 't_initiative_decision', a: (r: CandidateTimelineRow) => r.transcript, b: (r: CandidateTimelineRow) => r.decision_at },
    { id: 'decision_to_breath', from: 't_initiative_decision', to: 't_breath_start', a: (r: CandidateTimelineRow) => r.decision_at, b: (r: CandidateTimelineRow) => r.cue_at },
    { id: 'breath_to_speech', from: 't_breath_start', to: 't_speech_start', a: (r: CandidateTimelineRow) => r.cue_at, b: (r: CandidateTimelineRow) => r.speech_at },
    { id: 'decision_to_speech', from: 't_initiative_decision', to: 't_speech_start', a: (r: CandidateTimelineRow) => r.decision_at, b: (r: CandidateTimelineRow) => r.speech_at },
  ];
  for (const link of chain) {
    const bucket = new Bucket();
    for (const row of timeline) bucket.add(link.a(row), link.b(row));
    rows.push({
      id: link.id,
      from: link.from,
      to: link.to,
      group: 'chain',
      breakdown: null,
      stat: latencyStat(bucket.samples, bucket.excluded),
    });
  }

  rows.push(...componentRows(events));
  return { rows, timeline };
}

/** 候補がなくても測れる部品の遅延（仕様§10 の「音声認識・LLM・アニメの遅延分布」）。 */
function componentRows(events: readonly ResearchEvent[]): LatencyRow[] {
  const rows: LatencyRow[] = [];

  // LLM の往復。sent_at と received_at はどちらも orchestrator の時計。
  for (const purpose of LlmPurpose.options) {
    const samples: LatencySample[] = [];
    for (const event of events) {
      if (event.event === 'llm.response' && event.purpose === purpose && event.output.value !== null) {
        samples.push({ ms: event.received_at - event.sent_at, uncertainty_ms: 0 });
      }
    }
    rows.push({
      id: 'llm_roundtrip',
      from: 'llm.sent_at',
      to: 'llm.received_at',
      group: 'component',
      breakdown: purpose,
      stat: latencyStat(samples),
    });
  }

  // 音声位置から STT の受信まで。精度の区分ごとに分ける。
  const frameClock = buildFrameClock(events);
  const stt = new Map<string, Bucket>();
  for (const event of events) {
    if (!isStt(event)) continue;
    let bucket = stt.get(event.timing_precision);
    if (bucket === undefined) {
      bucket = new Bucket();
      stt.set(event.timing_precision, bucket);
    }
    const mapped = frameClock.toMs(event.audio_frame_end);
    bucket.add(
      'reason' in mapped
        ? EXCLUDED(mapped.reason)
        : { status: 'measured', t_ms: mapped.t_ms, uncertainty_ms: mapped.uncertainty_ms },
      { status: 'measured', t_ms: event.t_monotonic_ms, uncertainty_ms: uncertaintyOf(event) },
    );
  }
  if (stt.size === 0) stt.set(ONLINE_PLACEHOLDER, new Bucket());
  for (const [precision, bucket] of [...stt.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    rows.push({
      id: 'audio_to_stt_arrival',
      from: 'stt.audio_frame_end',
      to: 'stt.received',
      group: 'component',
      breakdown: precision,
      stat: latencyStat(bucket.samples, bucket.excluded),
    });
  }

  // 合図の指示から最初の描画まで。
  const sent = new Map<string, EventOf<'signal.sent'>>();
  const animation = new Bucket();
  for (const event of events) {
    if (event.event === 'signal.sent') {
      const key = `${event.candidate_id}/${event.phase}`;
      if (!sent.has(key)) sent.set(key, event);
    }
  }
  for (const event of events) {
    if (event.event !== 'signal.started') continue;
    const origin = sent.get(`${event.candidate_id}/${event.phase}`);
    if (origin === undefined) {
      animation.add(EXCLUDED('signal_sent_missing'), EXCLUDED('signal_sent_missing'));
      continue;
    }
    sent.delete(`${event.candidate_id}/${event.phase}`);
    animation.add(
      { status: 'measured', t_ms: origin.sent_at, uncertainty_ms: uncertaintyOf(origin) },
      event.visible ? browserTime(event, event.started_at) : EXCLUDED('signal_not_visible'),
    );
  }
  rows.push({
    id: 'signal_sent_to_first_render',
    from: 'signal.sent_at',
    to: 'signal.started_at',
    group: 'component',
    breakdown: null,
    stat: latencyStat(animation.samples, animation.excluded),
  });

  return rows;
}

/** 遅延の計算に必要なイベントだけを残すための判定。画面の保持量を抑える。 */
export function isLatencyRelevant(event: ResearchEvent): boolean {
  switch (event.event) {
    case 'stt.interim':
    case 'stt.final':
    case 'llm.response':
    case 'initiative.decision':
    case 'signal.sent':
    case 'signal.started':
    case 'speech.started':
      return true;
    case 'audio.health':
      return event.reporter === 'browser';
    default:
      return false;
  }
}
