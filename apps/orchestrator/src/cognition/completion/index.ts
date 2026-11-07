/**
 * TurnCompletionEstimator の入口（計画 §4.4）。代替は TurnGPT の再現とは呼ばない。
 * 推定器の p は尺度が違うので、閾値は推定器ごとの表から読む。TURNGPT_PREPARE_THRESHOLD を流用しない。
 */
import { absent } from '@llm-vap/contracts';
import type { LlmProvider, PolicyJa, TurnCompletionEstimate, TurnCompletionEstimator } from '@llm-vap/contracts';
import { JA_RULES_ESTIMATOR, JaRulesTurnCompletionEstimator } from './ja_rules';
import { LLM_COMPLETION_ESTIMATOR, LlmTurnCompletionEstimator } from './llm_estimator';

export * from './ja_rules';
export * from './llm_estimator';

export const NO_ESTIMATOR = 'none';

/** 推定器なし（仕様§7-4）。VAP が譲渡を示さなければ上限 3000ms 待つことになる（計画 §4.4）。 */
export class NullTurnCompletionEstimator implements TurnCompletionEstimator {
  readonly name = NO_ESTIMATOR;
  async estimate(): Promise<TurnCompletionEstimate> {
    return { p: absent('no_estimator_configured'), estimator: this.name };
  }
}

/** policy.completion.estimator から作る。知らない名前は例外（黙って別の推定器にしない）。 */
export function createCompletionEstimator(
  completion: PolicyJa['completion'],
  deps: { llm?: LlmProvider } = {},
): TurnCompletionEstimator {
  switch (completion.estimator) {
    case null:
      return new NullTurnCompletionEstimator();
    case JA_RULES_ESTIMATOR:
      return new JaRulesTurnCompletionEstimator();
    case LLM_COMPLETION_ESTIMATOR:
      if (!deps.llm) throw new Error(`${LLM_COMPLETION_ESTIMATOR} には LlmProvider が必要です`);
      return new LlmTurnCompletionEstimator(deps.llm);
    default:
      throw new Error(`unknown completion estimator: ${completion.estimator}`);
  }
}

/** E が読む閾値。null は未校正または推定器なしで、completion による準備の起動をしない。 */
export function completionPrepareThreshold(completion: PolicyJa['completion']): number | null {
  if (completion.estimator === null) return null;
  return completion.thresholds[completion.estimator]?.prepare_threshold ?? null;
}
