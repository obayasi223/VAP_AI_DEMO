/**
 * /dev/avatar_measure の集計（純粋関数）。すべて dev 専用で、参加者の経路からは使わない。
 */

export interface DurationSummary {
  n: number;
  median: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
  mean: number | null;
}

/** 線形補間なしの順位の分位点（nearest-rank）。 */
export function quantile(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index] ?? null;
}

export function summarize(values: readonly number[]): DurationSummary {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    n,
    median: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    p99: quantile(sorted, 0.99),
    max: n > 0 ? (sorted[n - 1] ?? null) : null,
    mean: n > 0 ? sum / n : null,
  };
}

export interface FrameStats extends DurationSummary {
  /** 1 フレームの間隔の代表（中央値）× 1.5 より長いフレームの割合。 */
  droppedFraction: number;
  /** 上と同じ閾値の回数。 */
  droppedCount: number;
  /** 最も長いフレーム間隔の 1 秒窓あたりの落ち込み（1 秒窓の fps の最小）。 */
  minOneSecondFps: number | null;
}

/** 連続する rAF 時刻の間隔の統計。 */
export function frameStats(rafMs: readonly number[]): FrameStats {
  const gaps: number[] = [];
  for (let i = 1; i < rafMs.length; i += 1) {
    const prev = rafMs[i - 1];
    const cur = rafMs[i];
    if (prev !== undefined && cur !== undefined) gaps.push(cur - prev);
  }
  const base = summarize(gaps);
  const threshold = (base.median ?? 0) * 1.5;
  const droppedCount = gaps.filter((g) => g > threshold).length;
  let minFps: number | null = null;
  if (rafMs.length > 1) {
    const start = rafMs[0] as number;
    const end = rafMs[rafMs.length - 1] as number;
    for (let t = start; t + 1000 <= end; t += 250) {
      const count = rafMs.filter((r) => r >= t && r < t + 1000).length;
      if (minFps === null || count < minFps) minFps = count;
    }
  }
  return { ...base, droppedFraction: gaps.length === 0 ? 0 : droppedCount / gaps.length, droppedCount, minOneSecondFps: minFps };
}
