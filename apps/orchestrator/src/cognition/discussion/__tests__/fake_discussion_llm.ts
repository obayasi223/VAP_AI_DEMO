/**
 * 用途ごとに台本を返す偽の LLM（02 §5）。遅れと失敗（時間切れ、空、長すぎ、二人称、禁止の語、JSON の崩れ）を注入できる。
 * 文は合成の架空の内容だけ（sessions/ は使わない）。llm.request／llm.response は出さない（emitter の検査は生成器のイベントだけを見る）。
 */
import { absent, present, type LlmProvider, type LlmPurpose, type LlmRequest, type LlmResult, type LlmStream } from '@llm-vap/contracts';

export type FakeReply = { text: string } | { error: string } | { hang: true };
export type FakeHandler = (request: LlmRequest, call: number) => FakeReply;

export interface FakeOptions {
  /** 返すまでの実時間の遅れ（ms）。既定 0（マイクロタスクだけ）。 */
  delay_ms?: (request: LlmRequest) => number;
  /** 記録する見かけの遅れ（received_at − sent_at）。既定 0。 */
  reported_latency_ms?: (request: LlmRequest) => number;
}

/** 文字数がおよそ n になる中立の話し言葉（決定的）。 */
export function sentenceOfLength(head: string, n: number): string {
  const filler = ['二人で順番に考えてみたいと思います。', 'そこから見えることもありそうです。', 'もう少し具体的に整理してみます。'];
  let out = head;
  let i = 0;
  while ([...out].length < n) out += filler[i++ % filler.length];
  return out;
}

export function fakeTurnText(request: LlmRequest): string {
  const m = /# このターンでやること\n(\w+)：(.*)/u.exec(request.system);
  const band = /(\d+)〜(\d+) 字/u.exec(request.system);
  const beat = /拍(b\d+)/u.exec(m?.[2] ?? '')?.[1] ?? 'つなぎ';
  const self = /^あなたは(.+?)です。/u.exec(request.system)?.[1] ?? '';
  const mid = band ? Math.round((Number(band[1]) + Number(band[2])) / 2) : 30;
  return sentenceOfLength(`${self}の${beat}の話です。`, mid);
}

export class FakeDiscussionLlm implements LlmProvider {
  readonly provider = 'fake_discussion_llm';
  readonly model_version = 'fake-model';
  readonly provider_class = 'test_double' as const;
  readonly calls: LlmRequest[] = [];
  private readonly counts = new Map<LlmPurpose, number>();

  constructor(
    private readonly handlers: Partial<Record<LlmPurpose, FakeHandler>>,
    private readonly options: FakeOptions = {},
  ) {}

  callsOf(purpose: LlmPurpose): LlmRequest[] {
    return this.calls.filter((c) => c.purpose === purpose);
  }

  async generate(request: LlmRequest): Promise<LlmResult> {
    this.calls.push(request);
    const n = (this.counts.get(request.purpose) ?? 0) + 1;
    this.counts.set(request.purpose, n);
    const handler = this.handlers[request.purpose];
    const reply: FakeReply = handler ? handler(request, n) : { error: `no handler for ${request.purpose}` };
    const delay = this.options.delay_ms?.(request) ?? 0;
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        const e = new Error('aborted');
        e.name = 'AbortError';
        reject(e);
      };
      if (request.signal?.aborted) return abort();
      request.signal?.addEventListener('abort', abort, { once: true });
      if ('hang' in reply) return;
      if (delay > 0) setTimeout(resolve, delay);
      else queueMicrotask(resolve);
    });
    if ('error' in reply) throw new Error(reply.error);
    if ('hang' in reply) throw new Error('unreachable');
    const latency = this.options.reported_latency_ms?.(request) ?? 0;
    return {
      request_id: request.request_id,
      purpose: request.purpose,
      text: reply.text,
      model_version: this.model_version,
      sent_at: 0,
      received_at: latency,
      first_text_at: latency,
      finish_reason: present('STOP'),
      usage: { input_tokens: absent('fake'), output_tokens: absent('fake') },
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
