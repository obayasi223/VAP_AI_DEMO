/**
 * 準備の判断（Appendix A の L45〜L54）。実行は D。
 * 閾値は prepareThresholds() の値を受け取るだけで、ここで別の値へ置き換えない。
 * similarity.threshold が null のときの扱いは docs/known_gaps.md §1 に理由を書いた。
 */
import type { Maybe, PrepareThresholds, PrepareTrigger } from '@llm-vap/contracts';

/** 文字 n-gram コサインの丸めの余裕。1 は「正規化後の文字列が同じ」で、尺度の校正に依存しない。 */
const SAME_TEXT_SIMILARITY = 1 - 1e-9;

export type SimilarityGate =
  | { outcome: 'pass'; basis: 'below_threshold'; similarity: number; threshold: number }
  | { outcome: 'pass'; basis: 'uncalibrated_text_differs'; similarity: number; threshold: null }
  | { outcome: 'block'; basis: 'at_or_above_threshold'; similarity: number; threshold: number }
  | { outcome: 'block'; basis: 'uncalibrated_same_text'; similarity: number; threshold: null };

/** L47。比較対象がないとき（Maybe が null）は 0（U-5）なので初回は必ず通る。 */
export function similarityGate(similarity: Maybe<number>, threshold: number | null): SimilarityGate {
  const value = similarity.value ?? 0;
  if (threshold === null) {
    return value >= SAME_TEXT_SIMILARITY
      ? { outcome: 'block', basis: 'uncalibrated_same_text', similarity: value, threshold: null }
      : { outcome: 'pass', basis: 'uncalibrated_text_differs', similarity: value, threshold: null };
  }
  return value < threshold
    ? { outcome: 'pass', basis: 'below_threshold', similarity: value, threshold }
    : { outcome: 'block', basis: 'at_or_above_threshold', similarity: value, threshold };
}

/** L46。completion の閾値が null（未校正、推定器なし）なら第1の条件は常に偽で、時間の条件だけが残る。 */
export function prepareTrigger(args: {
  completion_p: number;
  elapsed_since_asr_ms: number;
  thresholds: PrepareThresholds;
  asr_prepare_timeout_ms: number;
}): PrepareTrigger | null {
  const threshold = args.thresholds.completion_prepare_threshold;
  if (threshold !== null && args.completion_p > threshold) return 'completion_threshold';
  if (args.elapsed_since_asr_ms >= args.asr_prepare_timeout_ms) return 'asr_timeout';
  return null;
}
