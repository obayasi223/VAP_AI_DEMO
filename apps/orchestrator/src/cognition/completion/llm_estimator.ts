/**
 * 代替 B: LLM によるターン完了の推定（計画 §4.4）。TurnGPT の再現ではない。
 * 遅延が大きいので tick には載せられない。現時点では A との比較用で、既定にしない。
 * 失敗は null と理由で返す（偽の値を入れない）。発行するイベントは LlmProvider が持つ。
 */
import { absent, present } from '@llm-vap/contracts';
import type {
  HistoryEntryRef,
  JsonValue,
  LlmMessage,
  LlmProvider,
  TurnCompletionEstimate,
  TurnCompletionEstimateContext,
  TurnCompletionEstimator,
} from '@llm-vap/contracts';

export const LLM_COMPLETION_ESTIMATOR = 'llm_completion_v1';

const SYSTEM = [
  'あなたは日本語の会話を聞いています。話者の発話の途中までの音声認識結果を読み、',
  '話者がここで話し終えて相手に発話権を渡す確率 p を 0 から 1 で返します。',
  '句読点は当てになりません。文が明らかに途中なら低く、質問や明確な締めくくりなら高く、',
  '文法的には終わるが続きがありそうなら中程度にします。',
].join('');

const RESPONSE_SCHEMA: JsonValue = {
  type: 'object',
  properties: { p: { type: 'number' } },
  required: ['p'],
};

const HISTORY_TURNS = 4;

export type LlmEstimateContext = TurnCompletionEstimateContext;

export class LlmTurnCompletionEstimator implements TurnCompletionEstimator {
  readonly name = LLM_COMPLETION_ESTIMATOR;
  private requests = 0;

  constructor(private readonly llm: LlmProvider) {}

  async estimate(
    history: readonly HistoryEntryRef[],
    partial: string,
    context: LlmEstimateContext = {},
  ): Promise<TurnCompletionEstimate> {
    if (partial.trim() === '') return { p: absent('empty_partial'), estimator: this.name };
    const lines = history
      .slice(-HISTORY_TURNS)
      .map((entry) => `${entry.role === 'user' ? '話者' : '相手'}: ${entry.text}`);
    const messages: LlmMessage[] = [
      {
        role: 'user',
        text: `${lines.length > 0 ? `これまでの会話:\n${lines.join('\n')}\n\n` : ''}話者の発話の途中: ${partial}`,
      },
    ];
    this.requests += 1;
    try {
      const result = await this.llm.generate({
        request_id: `completion-${this.requests}`,
        purpose: 'completion',
        system: SYSTEM,
        messages,
        response_json_schema: RESPONSE_SCHEMA,
        transcript_revision: context.transcript_revision ?? 0,
        ...(context.signal ? { signal: context.signal } : {}),
      });
      const p = (JSON.parse(result.text) as { p?: unknown }).p;
      if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) {
        return { p: absent('llm_output_out_of_range'), estimator: this.name };
      }
      return { p: present(p), estimator: this.name };
    } catch (error) {
      if (error instanceof SyntaxError) return { p: absent('llm_output_not_json'), estimator: this.name };
      const reason = error instanceof Error ? error.message : String(error);
      return { p: absent(`llm_failed: ${reason}`.slice(0, 200)), estimator: this.name };
    }
  }
}
