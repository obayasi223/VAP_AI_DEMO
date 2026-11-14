/**
 * probe の偽の LLM（--real がないとき、と試験）。返答は台本の LLM（app/scripted.ts の two_ai の用途）と同じ。
 * 実時間は待たず、用途ごとの見かけの遅れ（決定的）を received_at − sent_at に入れる。数値は仮のもので、測定値ではない。
 */
import { absent, present, type LlmProvider, type LlmPurpose, type LlmRequest, type LlmResult, type LlmStream } from '@llm-vap/contracts';
import { scriptedTwoAiReply } from '../../../apps/orchestrator/src/app/scripted';
import { seededUnit } from '../../../apps/orchestrator/src/cognition/discussion/text';

/** 用途ごとの見かけの遅れの幅（ms）。 */
export const MOCK_LATENCY_MS: Partial<Record<LlmPurpose, [number, number]>> = {
  discussion_plan: [9000, 16000],
  discussion_turn: [600, 1600],
  correction_assist: [500, 1300],
};

export class ProbeMockLlm implements LlmProvider {
  readonly provider = 'two_ai_probe_mock';
  readonly provider_class = 'test_double' as const;
  readonly calls: LlmRequest[] = [];

  constructor(readonly model_version = 'mock-model') {}

  async generate(request: LlmRequest): Promise<LlmResult> {
    this.calls.push(request);
    if (request.signal?.aborted) {
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    }
    const text = scriptedTwoAiReply(request);
    if (text === null) throw new Error(`mock: no reply for ${request.purpose}`);
    const [lo, hi] = MOCK_LATENCY_MS[request.purpose] ?? [100, 100];
    const latency = Math.round(lo + (hi - lo) * seededUnit(`${request.request_id}:${request.purpose}`));
    await Promise.resolve();
    return {
      request_id: request.request_id,
      purpose: request.purpose,
      text,
      model_version: this.model_version,
      sent_at: 0,
      received_at: latency,
      first_text_at: Math.round(latency * 0.6),
      finish_reason: present('STOP'),
      usage: { input_tokens: absent('mock'), output_tokens: absent('mock') },
    };
  }

  stream(request: LlmRequest): LlmStream {
    const result = this.generate(request);
    async function* deltas(): AsyncGenerator<string> {
      yield (await result).text;
    }
    return { deltas: deltas(), result };
  }
}
