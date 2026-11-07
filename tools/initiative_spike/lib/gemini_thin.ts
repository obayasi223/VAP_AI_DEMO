/**
 * スパイク用の薄い Gemini 実装（tools/provider_probe/gemini_probe.mjs の呼び方）。
 * LlmProvider の形なので、レーン D の実装ができたら run_replay.ts の1行で差し替えられる。
 * Interactions API を store:false で使う。キーは環境変数からのみ読み、表示も記録もしない。
 */
import { absent, present } from '@llm-vap/contracts';
import type { LlmProvider, LlmRequest, LlmResult, LlmStream, Maybe, TimeSource } from '@llm-vap/contracts';
import type { CallBudget } from './call_budget';

const BASE = process.env.GEMINI_TEST_BASE ?? 'https://generativelanguage.googleapis.com';
const API_REVISION = '2026-05-20';

export interface ThinGeminiOptions {
  model: string;
  thinking_level: string;
  time: TimeSource;
  budget: CallBudget;
  max_output_tokens?: number;
  timeout_ms?: number;
}

function requireKey(): string {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY is not set');
  return key;
}

/** エラー本文にキーが混ざっても残さない。 */
function scrub(text: string): string {
  const key = process.env.GEMINI_API_KEY;
  const cleaned = key ? text.split(key).join('<GEMINI_API_KEY>') : text;
  return cleaned.slice(0, 300);
}

export class ThinGeminiProvider implements LlmProvider {
  readonly provider = 'gemini_thin_spike';
  /** 実 API だが、本実装ではないので受け入れの証拠に数えない。 */
  readonly provider_class = 'development' as const;
  readonly model_version: string;

  constructor(private readonly options: ThinGeminiOptions) {
    this.model_version = options.model;
  }

  async generate(request: LlmRequest): Promise<LlmResult> {
    const { model, thinking_level, time, budget } = this.options;
    budget.consume(`${model}:${request.request_id}`);
    const sent_at = time.monotonicMs();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeout_ms ?? 30_000);
    request.signal?.addEventListener('abort', () => controller.abort());
    try {
      const response = await fetch(`${BASE}/v1beta/interactions?alt=sse`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': requireKey(),
          'Api-Revision': API_REVISION,
        },
        body: JSON.stringify({
          model,
          input: request.messages.map((m) => m.text).join('\n\n'),
          system_instruction: request.system,
          stream: true,
          store: false,
          response_format: { type: 'text', mime_type: 'application/json', schema: request.response_json_schema },
          generation_config: { thinking_level, max_output_tokens: this.options.max_output_tokens ?? 4096 },
        }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}: ${scrub(await response.text())}`);
      let text = '';
      let usage: InteractionUsage | undefined;
      let status: string | undefined;
      for await (const event of parseSse(response.body as unknown as AsyncIterable<Uint8Array>)) {
        text += textFromEvent(event);
        if (event.interaction?.usage) usage = event.interaction.usage;
        if (event.interaction?.status) status = event.interaction.status;
      }
      if (!text) throw new Error('no text in response');
      return {
        request_id: request.request_id,
        purpose: request.purpose,
        text,
        model_version: model,
        sent_at,
        received_at: time.monotonicMs(),
        finish_reason: status ? present(status) : absent('not_returned'),
        usage: {
          input_tokens: toMaybe(usage?.total_input_tokens),
          output_tokens: toMaybe(usage?.total_output_tokens),
        },
      };
    } finally {
      clearTimeout(timer);
    }
  }

  stream(_request: LlmRequest): LlmStream {
    throw new Error('ThinGeminiProvider does not stream: the initiative judge needs the whole JSON');
  }
}

interface InteractionUsage {
  total_input_tokens?: number;
  total_output_tokens?: number;
}

export interface InteractionEvent {
  event_type?: string;
  delta?: { type?: string; text?: string };
  interaction?: { status?: string; usage?: InteractionUsage };
}

function toMaybe(value: number | undefined): Maybe<number> {
  return typeof value === 'number' ? present(value) : absent('not_returned');
}

export function textFromEvent(event: InteractionEvent): string {
  return event.event_type === 'step.delta' && event.delta?.type === 'text' ? (event.delta.text ?? '') : '';
}

async function* parseSse(body: AsyncIterable<Uint8Array>): AsyncGenerator<InteractionEvent> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let cut = buffer.search(/\r?\n\r?\n/);
    while (cut >= 0) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut).replace(/^\r?\n\r?\n/, '');
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (data && data !== '[DONE]') yield JSON.parse(data) as InteractionEvent;
      cut = buffer.search(/\r?\n\r?\n/);
    }
  }
}
