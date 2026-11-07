/**
 * 決定的なゲート（計画 §4.5）。入力と出力を照合するだけで、モデルの説明文は読まない。
 * reason／why_now／cost_of_waiting を引数に取らないこと自体が「ゲートに使わない」の保証になる。
 */
import { normalizeForMatch } from './text';
import type { AsrSegmentSnapshot } from './transcript_view';

/** 「の」のような短い一致で根拠を通さないための下限（正規化後の文字数）。値の根拠は実測でなく、自明な一致の排除。 */
export const MIN_EVIDENCE_CHARS = 3;

export interface GateFailure {
  ok: false;
  reasons: string[];
}
export type GateResult<T = object> = ({ ok: true } & T) | GateFailure;

function joined(segments: readonly AsrSegmentSnapshot[], ids?: readonly number[]): string {
  const picked = ids ? segments.filter((s) => ids.includes(s.asr_segment_id)) : segments;
  return picked.map((s) => normalizeForMatch(s.stable_text)).join('');
}

export interface EvidenceCheckInput {
  span: string;
  segment_ids: readonly number[];
  /** LLM に渡した安定テキスト。 */
  input: readonly AsrSegmentSnapshot[];
  /** 結果を受け取った時点の安定テキスト。 */
  latest: readonly AsrSegmentSnapshot[];
}

/**
 * evidence_span の実在、evidence_segment_ids の実在と包含、最新の安定テキストに残っていることを確かめる。
 * 安定テキストだけを見るので、未安定の部分にしかない語は根拠にならない。
 */
export function checkEvidence(check: EvidenceCheckInput): GateResult<{ segment_ids: number[] }> {
  const span = normalizeForMatch(check.span);
  const reasons: string[] = [];
  if (span.length < MIN_EVIDENCE_CHARS) reasons.push('evidence_too_short');
  else {
    if (!joined(check.input).includes(span)) reasons.push('evidence_not_in_input_stable_text');
    if (!joined(check.latest).includes(span)) reasons.push('evidence_not_in_latest_stable_text');
  }
  const ids = [...new Set(check.segment_ids)].sort((a, b) => a - b);
  if (ids.length === 0) reasons.push('evidence_segment_ids_empty');
  const known = new Set(check.input.map((s) => s.asr_segment_id));
  if (ids.some((id) => !known.has(id))) reasons.push('evidence_segment_id_unknown');
  else if (ids.length > 0 && span.length >= MIN_EVIDENCE_CHARS && !joined(check.input, ids).includes(span)) {
    reasons.push('evidence_span_not_in_listed_segments');
  }
  return reasons.length > 0 ? { ok: false, reasons } : { ok: true, segment_ids: ids };
}

export interface FreshnessCheckInput {
  new_stable_chars_since_input: number;
  age_ms: number;
  max_new_stable_chars_since_input: number;
  max_result_age_ms: number;
}

/** 鮮度は revision の完全一致で判定しない（計画 §4.5）。 */
export function checkFreshness(check: FreshnessCheckInput): GateResult {
  const reasons: string[] = [];
  if (check.new_stable_chars_since_input > check.max_new_stable_chars_since_input) {
    reasons.push('stale_too_many_new_stable_chars');
  }
  if (check.age_ms > check.max_result_age_ms) reasons.push('stale_result_too_old');
  return reasons.length > 0 ? { ok: false, reasons } : { ok: true };
}

export interface CandidateRef {
  candidate_id: string;
  candidate_version: number;
}

/** KEEP／REVISE／WITHDRAW の対象が、入力で示した候補として今も同じ版で未解決かを確かめる。 */
export function checkTarget(
  target_id: string,
  at_input: readonly CandidateRef[],
  current: CandidateRef | null,
): GateResult<{ version: number }> {
  const shown = at_input.find((c) => c.candidate_id === target_id);
  if (!shown) return { ok: false, reasons: ['target_candidate_not_in_input'] };
  if (!current) return { ok: false, reasons: ['target_candidate_resolved'] };
  if (current.candidate_version !== shown.candidate_version) {
    return { ok: false, reasons: ['target_candidate_version_changed'] };
  }
  return { ok: true, version: current.candidate_version };
}

export interface WithdrawCheckInput extends EvidenceCheckInput {
  candidate_evidence_span: string;
}

/** 撤回の根拠は、候補の根拠より後ろの発話であること（追補2の「後続発話区間」）。 */
export function checkWithdrawEvidence(check: WithdrawCheckInput): GateResult<{ segment_ids: number[] }> {
  const base = checkEvidence(check);
  if (!base.ok) return base;
  const all = joined(check.input);
  const candidate = normalizeForMatch(check.candidate_evidence_span);
  const start = all.indexOf(candidate);
  if (start >= 0) {
    const candidateEnd = start + candidate.length;
    const span = normalizeForMatch(check.span);
    const spanEnd = all.lastIndexOf(span) + span.length;
    if (spanEnd <= candidateEnd) return { ok: false, reasons: ['withdraw_evidence_not_after_candidate'] };
  }
  return base;
}
