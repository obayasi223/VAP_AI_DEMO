/**
 * AI の発話の結果（turn.outcome）の集計。1件ごとの一覧を主にし、中央値を添える。文は扱わない（数値とラベルだけ）。
 * 入力は記録のイベントか再生の結果（封筒の有無で変わらない）。分類の条件は control/turn_outcome.ts と docs/known_gaps.md。
 */
import type { TurnOutcomeBody, TurnOutcomeAiUtterance } from '@llm-vap/contracts';

export interface TurnOutcomeRow {
  /** 開始の判断の時刻（no_response は記録の時刻）。 */
  t_ms: number;
  kind: TurnOutcomeBody['kind'];
  audio_playback_id: number | null;
  origin: string | null;
  decision_source: string | null;
  reason: string | null;
  /** ラベル（分類しなかったときは [] で null_reason に理由）。 */
  labels: string[];
  null_reason: string | null;
  p_now: number | null;
  p_future: number | null;
  completion_p: number | null;
  gap_ms: number | null;
  voice_gap_before_ms: number | null;
  continued: boolean;
  overlap_ms: number | null;
  first_overlap_ms: number | null;
  played_ms: number | null;
  interrupted: boolean;
  waited_ms: number | null;
  echo_suspected: boolean;
}

function labelsOf(labels: TurnOutcomeBody['labels']): { labels: string[]; null_reason: string | null } {
  return labels.value === null ? { labels: [], null_reason: labels.null_reason } : { labels: labels.value, null_reason: null };
}

export function turnOutcomeRows(outcomes: readonly (TurnOutcomeBody & { t_monotonic_ms?: number })[]): TurnOutcomeRow[] {
  return outcomes
    .map((o): TurnOutcomeRow => {
      if (o.kind === 'no_response') {
        return {
          t_ms: o.t_monotonic_ms ?? (o.last_user_voice_at.value ?? 0) + o.waited_ms,
          kind: o.kind,
          audio_playback_id: null,
          origin: null,
          decision_source: o.decision_source.value,
          reason: o.wait_state,
          ...labelsOf(o.labels),
          p_now: o.p_now.value,
          p_future: o.p_future.value,
          completion_p: o.completion_p.value,
          gap_ms: null,
          voice_gap_before_ms: null,
          continued: false,
          overlap_ms: null,
          first_overlap_ms: null,
          played_ms: null,
          interrupted: false,
          waited_ms: o.waited_ms,
          echo_suspected: false,
        };
      }
      const u: TurnOutcomeAiUtterance = o;
      return {
        t_ms: u.start.decided_at,
        kind: u.kind,
        audio_playback_id: u.audio_playback_id,
        origin: u.origin,
        decision_source: u.start.decision_source,
        reason: u.start.reason,
        ...labelsOf(u.labels),
        p_now: u.start.p_now.value,
        p_future: u.start.p_future.value,
        completion_p: u.start.completion_p.value,
        gap_ms: u.start.gap_ms.value,
        voice_gap_before_ms: u.observed.user_voice_gap_before_ms.value,
        continued: u.observed.continuation.continued,
        overlap_ms: u.observed.overlap.overlap_ms.value,
        first_overlap_ms: u.observed.overlap.first_after_start_ms.value,
        played_ms: u.played_ms.value,
        interrupted: u.interrupted,
        waited_ms: null,
        echo_suspected: u.observed.echo.suspected,
      };
    })
    .sort((a, b) => a.t_ms - b.t_ms);
}

export interface TurnOutcomeSummary {
  rows: number;
  ai_utterances: number;
  unsettled: number;
  /** ラベルごとの件数（分類しなかった発話は含めない）。 */
  by_label: Record<string, number>;
  /** 分類しなかった理由ごとの件数。 */
  by_null_reason: Record<string, number>;
  /** 中央値（ms）。対象の件数も返す。 */
  medians: Record<'gap_ms' | 'voice_gap_before_ms' | 'overlap_ms' | 'first_overlap_ms' | 'played_ms', { n: number; median: number | null }>;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

export function summarizeTurnOutcomes(rows: readonly TurnOutcomeRow[]): TurnOutcomeSummary {
  const by_label: Record<string, number> = {};
  const by_null_reason: Record<string, number> = {};
  for (const row of rows) {
    for (const label of row.labels) by_label[label] = (by_label[label] ?? 0) + 1;
    if (row.null_reason !== null) by_null_reason[row.null_reason] = (by_null_reason[row.null_reason] ?? 0) + 1;
  }
  const utterances = rows.filter((r) => r.kind === 'ai_utterance');
  const pick = (name: keyof TurnOutcomeSummary['medians']) => {
    const values = utterances.flatMap((r) => (r[name] === null ? [] : [r[name] as number]));
    return { n: values.length, median: median(values) };
  };
  return {
    rows: rows.length,
    ai_utterances: utterances.length,
    unsettled: utterances.filter((r) => r.null_reason !== null).length,
    by_label,
    by_null_reason,
    medians: {
      gap_ms: pick('gap_ms'),
      voice_gap_before_ms: pick('voice_gap_before_ms'),
      overlap_ms: pick('overlap_ms'),
      first_overlap_ms: pick('first_overlap_ms'),
      played_ms: pick('played_ms'),
    },
  };
}
