/**
 * 根拠の照合（追補1「入力の ASR 内容と照合できない根拠は採用しない」、計画 §4.5 の決定的な検証）。
 *
 * 照合の規則そのものは G のゲート（cognition/initiative/gate.ts）と同じ関数を使う。規則を2つ持つと
 * G で通った根拠が E2a で落ちる（またはその逆）ずれが起きるため。E2a はその上に
 * 「区間 ID が最新の ASR にも実在する」を足す（G から渡された入力の区間だけを信じない）。
 *
 * ここはモデルの説明文（reason など）を引数に取らない。
 */
import { checkEvidence, checkWithdrawEvidence } from '../../cognition/initiative/gate';
import { normalizeForMatch } from '../../cognition/initiative/text';
import type { AsrSegmentSnapshot } from './types';

export type EvidenceResult = { ok: true; segment_ids: number[] } | { ok: false; details: string[] };

function idsMissingFromLatest(ids: readonly number[], latest: readonly AsrSegmentSnapshot[]): boolean {
  const known = new Set(latest.map((s) => s.asr_segment_id));
  return ids.some((id) => !known.has(id));
}

export function verifyEvidence(input: {
  span: string;
  segment_ids: readonly number[];
  input_segments: readonly AsrSegmentSnapshot[];
  latest: readonly AsrSegmentSnapshot[];
}): EvidenceResult {
  const base = checkEvidence({
    span: input.span,
    segment_ids: input.segment_ids,
    input: input.input_segments,
    latest: input.latest,
  });
  const details = base.ok ? [] : [...base.reasons];
  if (idsMissingFromLatest(input.segment_ids, input.latest)) details.push('evidence_segment_id_not_in_latest');
  if (details.length > 0 || !base.ok) return { ok: false, details };
  return { ok: true, segment_ids: base.segment_ids };
}

export function verifyWithdrawEvidence(input: {
  span: string;
  segment_ids: readonly number[];
  input_segments: readonly AsrSegmentSnapshot[];
  latest: readonly AsrSegmentSnapshot[];
  candidate_evidence_span: string;
  candidate_carried?: boolean;
}): EvidenceResult {
  const base = checkWithdrawEvidence({
    span: input.span,
    segment_ids: input.segment_ids,
    input: input.input_segments,
    latest: input.latest,
    candidate_evidence_span: input.candidate_evidence_span,
    ...(input.candidate_carried ? { candidate_carried: true } : {}),
  });
  const details = base.ok ? [] : [...base.reasons];
  if (idsMissingFromLatest(input.segment_ids, input.latest)) details.push('evidence_segment_id_not_in_latest');
  if (details.length > 0 || !base.ok) return { ok: false, details };
  return { ok: true, segment_ids: base.segment_ids };
}

/** 候補の根拠が最新の安定テキストに残っているか。ASR の書き換えで消えた根拠を検出する。 */
export function evidenceStillStable(span: string, latest: readonly AsrSegmentSnapshot[]): boolean {
  const stable = latest.map((s) => normalizeForMatch(s.stable_text)).join('');
  const needle = normalizeForMatch(span);
  return needle.length > 0 && stable.includes(needle);
}
