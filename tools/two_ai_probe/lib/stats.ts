/** 遅れの集計（中央値と 95 パーセンタイル。最近順位法）。 */
export interface LatencyStats {
  n: number;
  median_ms: number | null;
  p95_ms: number | null;
  max_ms: number | null;
}

export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(sorted.length, rank) - 1]!;
}

export function latencyStats(values: readonly number[]): LatencyStats {
  return {
    n: values.length,
    median_ms: percentile(values, 50),
    p95_ms: percentile(values, 95),
    max_ms: values.length === 0 ? null : Math.max(...values),
  };
}

/** STT の確定文の p95 を測っていないときに仮に置く値（ms）。 */
export const ASSUMED_STT_P95_MS = 1500;

/**
 * 判定の保留の上限（06 §6.2 の予算）：STT の確定文の p95 ＋ (e) の p95 ＋ 1500 ms と 6000 ms の大きい方。
 * (e) を測れていなければ null。
 */
export function holdMaxMs(stt_p95_ms: number | null, correction_p95_ms: number | null): number | null {
  if (correction_p95_ms === null) return null;
  return Math.max((stt_p95_ms ?? ASSUMED_STT_P95_MS) + correction_p95_ms + 1500, 6000);
}

/**
 * 計画の待ちの提案（01 §3、05 §5.2）。max_wait_ms は (c) の p95 に 1.5 倍の余裕を見て 1 秒単位に切り上げる。
 * plan_start_sec は、intake の soft_sec に計画が届くよう soft_sec − ceil(p95 秒) とし、min_sec より前にはしない。
 */
export function planWaitProposal(
  plan_p95_ms: number | null,
  intake: { min_sec: number; soft_sec: number },
): { max_wait_ms: number; plan_start_sec: number } | null {
  if (plan_p95_ms === null) return null;
  return {
    max_wait_ms: Math.ceil((plan_p95_ms * 1.5) / 1000) * 1000,
    plan_start_sec: Math.max(intake.min_sec, intake.soft_sec - Math.ceil(plan_p95_ms / 1000)),
  };
}
