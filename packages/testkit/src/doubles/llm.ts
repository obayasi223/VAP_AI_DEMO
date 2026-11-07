import { absent, present } from '@llm-vap/contracts';
import type { LlmProvider, LlmRequest, LlmResult, LlmStream } from '@llm-vap/contracts';

export type LlmResponder = (request: LlmRequest) => string | Promise<string>;

export interface ScriptedLlmOptions {
  responder: LlmResponder;
  now?: () => number;
  /** 各 delta の待ち時間（実時間）。既定は 0。 */
  delta_delay_ms?: number;
  chars_per_delta?: number;
}

function abortError(): Error {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

/**
 * 決められた文字列を返す LLM。判断はしない。
 * これの結果を LLM の性能として報告しないこと（計画 §4.5a）。
 */
export class ScriptedLlmProvider implements LlmProvider {
  readonly provider = 'scripted_llm';
  readonly model_version = 'test_double';
  readonly provider_class = 'test_double' as const;
  readonly requests: LlmRequest[] = [];
  private readonly now: () => number;

  constructor(private readonly options: ScriptedLlmOptions) {
    this.now = options.now ?? (() => 0);
  }

  async generate(request: LlmRequest): Promise<LlmResult> {
    const stream = this.stream(request);
    for await (const _ of stream.deltas) {
      // 全部受け取る
    }
    return stream.result;
  }

  stream(request: LlmRequest): LlmStream {
    this.requests.push(request);
    const sent_at = this.now();
    const size = this.options.chars_per_delta ?? 4;
    const delay = this.options.delta_delay_ms ?? 0;
    const textPromise = Promise.resolve().then(() => this.options.responder(request));

    let resolveResult!: (result: LlmResult) => void;
    let rejectResult!: (error: unknown) => void;
    const result = new Promise<LlmResult>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    // 結果を待たない呼び出し側で未処理の拒否にしない。
    result.catch(() => undefined);

    const now = this.now;
    const model_version = this.model_version;
    async function* deltas(): AsyncGenerator<string> {
      try {
        const text = await textPromise;
        for (let i = 0; i < text.length; i += size) {
          if (request.signal?.aborted) throw abortError();
          if (delay > 0) await new Promise((r) => setTimeout(r, delay));
          if (request.signal?.aborted) throw abortError();
          yield text.slice(i, i + size);
        }
        resolveResult({
          request_id: request.request_id,
          purpose: request.purpose,
          text,
          model_version,
          sent_at,
          received_at: now(),
          finish_reason: present('STOP'),
          usage: {
            input_tokens: absent('test_double_does_not_count'),
            output_tokens: absent('test_double_does_not_count'),
          },
        });
      } catch (error) {
        rejectResult(error);
        throw error;
      }
    }
    return { deltas: deltas(), result };
  }
}
