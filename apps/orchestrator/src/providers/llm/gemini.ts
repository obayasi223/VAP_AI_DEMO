/**
 * Gemini の LlmProvider。REST の streamGenerateContent（SSE）を使う。
 *
 *  - Interactions は使わない。実測でこちらが少し速く、要求がサーバーに保存されない（docs/provider_matrix.md §4）。
 *  - temperature などのサンプリング項目は送らない（無視され、将来は 400。§1 の #12）。
 *  - 中断はクライアント側だけで、サーバー側の課金は止まらない（§1 の #12）。cost.usage に別単位で残す。
 *  - 失敗は GeminiProviderError で明示し、provider.status へ出す。再試行も代替の結果への切替もしない（計画 §4.8）。
 *  - llm.request と llm.response はここが発行する（リプレイの注入元）。呼び出し側は重ねて出さない。
 *    output は { text, finish_reason }。失敗と中断では null と理由。
 */
import { absent, modelOutput, modelOutputAbsent, present } from '@llm-vap/contracts';
import type {
  EventEmitter,
  JsonValue,
  LlmProvider,
  LlmRequest,
  LlmResult,
  LlmStream,
  LlmUsage,
  Maybe,
  ProviderClass,
  ProviderHealth,
  TimeSource,
} from '@llm-vap/contracts';

export const GEMINI_DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';
export const GEMINI_DEFAULT_MODEL = 'gemini-3.5-flash-lite';
const API_REVISION = '2026-05-20';

export type GeminiThinkingLevel = 'minimal' | 'low' | 'medium' | 'high';

/** モデルごとの低遅延の下限（provider_matrix §4）。3.8-flash の minimal はエラーになる。 */
const LOWEST_THINKING: Readonly<Record<string, GeminiThinkingLevel>> = {
  'gemini-3.5-flash-lite': 'minimal',
  'gemini-3.8-flash': 'low',
};

interface TokenPrice {
  input_per_mtok: number;
  output_per_mtok: number;
}

/** provider_matrix §4 の標準ティア。表にないモデルは推定費用を null と理由にする。 */
function priceFor(model: string, wallClockIso: string): TokenPrice | null {
  if (model === 'gemini-3.5-flash-lite') return { input_per_mtok: 0.3, output_per_mtok: 2.5 };
  if (model === 'gemini-3.8-flash') {
    return wallClockIso >= '2027-01-01'
      ? { input_per_mtok: 1.5, output_per_mtok: 7.5 }
      : { input_per_mtok: 0.75, output_per_mtok: 3.75 };
  }
  return null;
}

export type GeminiFailureKind =
  | 'model_unavailable'
  | 'auth'
  | 'bad_request'
  | 'rate_limited'
  | 'server'
  | 'network'
  | 'timeout'
  | 'blocked'
  | 'no_output'
  | 'malformed_response'
  | 'incomplete_stream';

const STATUS_BY_KIND: Readonly<Record<GeminiFailureKind, ProviderHealth>> = {
  model_unavailable: 'down',
  auth: 'down',
  bad_request: 'down',
  rate_limited: 'degraded',
  server: 'degraded',
  network: 'degraded',
  timeout: 'degraded',
  blocked: 'degraded',
  no_output: 'degraded',
  malformed_response: 'degraded',
  incomplete_stream: 'degraded',
};

export class GeminiProviderError extends Error {
  constructor(
    readonly kind: GeminiFailureKind,
    message: string,
    readonly http_status: number | null = null,
  ) {
    super(`${kind}: ${message}`);
    this.name = 'GeminiProviderError';
  }
}

export interface GeminiProviderOptions {
  api_key: string;
  time: TimeSource;
  emitter: EventEmitter;
  model?: string;
  /** 省略時はモデルごとの下限。表にないモデルでは必須。 */
  thinking_level?: GeminiThinkingLevel;
  /** 既定以外を渡すと provider_class は test_double になる（偽サーバーを本番として記録しない）。 */
  base_url?: string;
  max_output_tokens?: number;
  timeout_ms?: number;
}

interface WireChunk {
  candidates?: {
    content?: { parts?: { text?: string; thought?: boolean }[] };
    finishReason?: string;
  }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
  };
  modelVersion?: string;
  error?: { code?: number; message?: string; status?: string };
}

function abortError(): Error {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

/** Server-Sent Events の data 行を JSON へ。 */
export async function* parseSse(body: AsyncIterable<Uint8Array>): AsyncGenerator<unknown> {
  const decoder = new TextDecoder();
  let buffer = '';
  const parseBlock = (block: string): unknown[] => {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data || data === '[DONE]') return [];
    try {
      return [JSON.parse(data)];
    } catch {
      throw new GeminiProviderError('malformed_response', 'SSE data is not JSON');
    }
  };
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let match: RegExpExecArray | null;
    while ((match = /\r?\n\r?\n/.exec(buffer)) !== null) {
      const block = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      yield* parseBlock(block);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) yield* parseBlock(buffer);
}

/** 読み手がいなくても生成を進めるための受け渡し。 */
class DeltaQueue implements AsyncIterable<string> {
  private readonly items: string[] = [];
  private done = false;
  private failure: { error: unknown } | null = null;
  private wake: (() => void) | null = null;

  push(text: string): void {
    this.items.push(text);
    this.notify();
  }
  end(): void {
    this.done = true;
    this.notify();
  }
  fail(error: unknown): void {
    this.failure = { error };
    this.notify();
  }
  private notify(): void {
    this.wake?.();
    this.wake = null;
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<string> {
    for (;;) {
      if (this.items.length > 0) {
        yield this.items.shift() as string;
      } else if (this.failure) {
        throw this.failure.error;
      } else if (this.done) {
        return;
      } else {
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
      }
    }
  }
}

export class GeminiLlmProvider implements LlmProvider {
  readonly provider = 'gemini';
  readonly model_version: string;
  readonly provider_class: ProviderClass;
  readonly thinking_level: GeminiThinkingLevel;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly maxOutputTokens: number;
  private readonly timeoutMs: number;
  private readonly time: TimeSource;
  private readonly emitter: EventEmitter;
  private lastStatus: ProviderHealth | null = null;

  constructor(options: GeminiProviderOptions) {
    if (!options.api_key) {
      throw new Error('GEMINI_API_KEY が未設定です。擬似結果へは切り替えません。');
    }
    this.apiKey = options.api_key;
    this.time = options.time;
    this.emitter = options.emitter;
    this.model_version = options.model ?? GEMINI_DEFAULT_MODEL;
    const thinking = options.thinking_level ?? LOWEST_THINKING[this.model_version];
    if (!thinking) {
      throw new Error(`${this.model_version} の thinking の下限が不明です。thinking_level を指定してください。`);
    }
    this.thinking_level = thinking;
    this.baseUrl = (options.base_url ?? GEMINI_DEFAULT_BASE_URL).replace(/\/$/, '');
    this.provider_class = this.baseUrl === GEMINI_DEFAULT_BASE_URL ? 'production' : 'test_double';
    this.maxOutputTokens = options.max_output_tokens ?? 1024;
    this.timeoutMs = options.timeout_ms ?? 30_000;
  }

  /**
   * モデルが使えることを確かめる（生成はしない。セッション開始時に J が呼ぶ想定）。
   * 使えなければ provider.status=down を出して例外。
   */
  async checkModelAvailable(): Promise<{ model: string; version: string | null }> {
    const url = `${this.baseUrl}/v1beta/models/${encodeURIComponent(this.model_version)}`;
    try {
      const res = await fetch(url, { headers: this.headers(), signal: AbortSignal.timeout(this.timeoutMs) });
      if (!res.ok) throw await this.httpError(res);
      const info = (await res.json()) as { version?: string; supportedGenerationMethods?: string[] };
      if (info.supportedGenerationMethods && !info.supportedGenerationMethods.includes('generateContent')) {
        throw new GeminiProviderError('model_unavailable', `${this.model_version} は generateContent に未対応`);
      }
      this.reportStatus('ok', null);
      return { model: this.model_version, version: info.version ?? null };
    } catch (error) {
      const failure = this.toFailure(error);
      this.reportFailure(failure);
      throw failure;
    }
  }

  async generate(request: LlmRequest): Promise<LlmResult> {
    return this.stream(request).result;
  }

  stream(request: LlmRequest): LlmStream {
    const deltas = new DeltaQueue();
    const result = this.run(request, deltas);
    // 結果を待たない呼び出し側で未処理の拒否にしない。
    result.catch(() => undefined);
    return { deltas, result };
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-goog-api-key': this.apiKey,
      'Api-Revision': API_REVISION,
    };
  }

  private buildBody(request: LlmRequest): Record<string, unknown> {
    const generationConfig: Record<string, unknown> = {
      thinkingConfig: { thinkingLevel: this.thinking_level.toUpperCase() },
      maxOutputTokens: this.maxOutputTokens,
    };
    if (request.response_json_schema !== null) {
      generationConfig.responseMimeType = 'application/json';
      generationConfig.responseJsonSchema = request.response_json_schema;
    }
    return {
      contents: request.messages.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.text }],
      })),
      ...(request.system ? { systemInstruction: { parts: [{ text: request.system }] } } : {}),
      generationConfig,
    };
  }

  private async run(request: LlmRequest, deltas: DeltaQueue): Promise<LlmResult> {
    if (request.signal?.aborted) {
      const error = abortError();
      deltas.fail(error);
      throw error;
    }
    const sent_at = this.time.monotonicMs();
    let text = '';
    let finishReason: string | null = null;
    let blockReason: string | null = null;
    let usage: WireChunk['usageMetadata'] | null = null;
    let actualModel: string | null = null;
    let responded = false;
    let firstTextAt: number | null = null;

    const logResponse = (output: JsonValue | null, nullReason: string): void => {
      this.emitter.emit({
        event: 'llm.response',
        request_id: request.request_id,
        purpose: request.purpose,
        output: output === null ? modelOutputAbsent(nullReason) : modelOutput(output),
        transcript_revision: request.transcript_revision,
        sent_at,
        received_at: this.time.monotonicMs(),
        model_version: actualModel ?? this.model_version,
        ...(firstTextAt === null ? {} : { first_text_at: firstTextAt }),
      });
    };

    this.emitter.emit({
      event: 'llm.request',
      request_id: request.request_id,
      purpose: request.purpose,
      input: {
        system: request.system,
        messages: request.messages.map((m) => ({ role: m.role, text: m.text })),
        response_json_schema: request.response_json_schema,
        thinking_level: this.thinking_level,
        max_output_tokens: this.maxOutputTokens,
      },
      transcript_revision: request.transcript_revision,
      sent_at,
      model_version: this.model_version,
    });

    const controller = new AbortController();
    const onCallerAbort = (): void => controller.abort();
    request.signal?.addEventListener('abort', onCallerAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);

    try {
      const url = `${this.baseUrl}/v1beta/models/${encodeURIComponent(this.model_version)}:streamGenerateContent?alt=sse`;
      const res = await fetch(url, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(this.buildBody(request)),
        signal: controller.signal,
      });
      if (!res.ok) throw await this.httpError(res);
      if (!res.body) throw new GeminiProviderError('malformed_response', 'response has no body');
      responded = true;

      for await (const raw of parseSse(res.body as unknown as AsyncIterable<Uint8Array>)) {
        const chunk = raw as WireChunk;
        if (chunk.error) {
          throw classifyHttp(chunk.error.code ?? 0, chunk.error.message ?? 'error in stream', this.apiKey);
        }
        actualModel = chunk.modelVersion ?? actualModel;
        usage = chunk.usageMetadata ?? usage;
        blockReason = chunk.promptFeedback?.blockReason ?? blockReason;
        const candidate = chunk.candidates?.[0];
        finishReason = candidate?.finishReason ?? finishReason;
        const piece = (candidate?.content?.parts ?? [])
          .filter((part) => !part.thought)
          .map((part) => part.text ?? '')
          .join('');
        if (piece) {
          firstTextAt ??= this.time.monotonicMs();
          text += piece;
          deltas.push(piece);
        }
      }

      if (blockReason) throw new GeminiProviderError('blocked', `prompt blocked: ${blockReason}`);
      if (finishReason === null) {
        throw new GeminiProviderError('incomplete_stream', `stream ended without finishReason after ${text.length} chars`);
      }
      if (finishReason !== 'STOP' && text === '') {
        throw new GeminiProviderError('no_output', `finishReason=${finishReason} with no text`);
      }
    } catch (error) {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', onCallerAbort);
      const aborted = request.signal?.aborted === true && !timedOut;
      if (aborted) {
        const failure = abortError();
        deltas.fail(failure);
        logResponse(null, `aborted_by_caller; received_chars=${text.length}`);
        // 中断してもサーバー側の課金は続く。応答が始まる前の中断でも同じ扱いにして、数だけ残す。
        this.emitter.emit({
          event: 'cost.usage',
          provider: this.provider,
          purpose: request.purpose,
          quantity: 1,
          unit: 'aborted_request',
          estimated_cost_usd: absent('aborted_request_may_still_bill_usage_unknown'),
        });
        throw failure;
      }
      const failure = timedOut
        ? new GeminiProviderError('timeout', `no completion within ${this.timeoutMs}ms`)
        : this.toFailure(error);
      deltas.fail(failure);
      logResponse(null, failure.message);
      this.reportFailure(failure);
      if (responded && usage) this.emitCost(request, usage);
      throw failure;
    }
    clearTimeout(timer);
    request.signal?.removeEventListener('abort', onCallerAbort);

    deltas.end();
    logResponse({ text, finish_reason: finishReason }, '');
    this.emitCost(request, usage);
    this.reportStatus('ok', null);
    return {
      request_id: request.request_id,
      purpose: request.purpose,
      text,
      model_version: actualModel ?? this.model_version,
      sent_at,
      received_at: this.time.monotonicMs(),
      ...(firstTextAt === null ? {} : { first_text_at: firstTextAt }),
      finish_reason: present(finishReason),
      usage: toUsage(usage),
    };
  }

  private async httpError(res: Response): Promise<GeminiProviderError> {
    let message = '';
    try {
      const body = await res.text();
      try {
        message = (JSON.parse(body) as WireChunk).error?.message ?? body;
      } catch {
        message = body;
      }
    } catch {
      message = '(no body)';
    }
    return classifyHttp(res.status, message, this.apiKey);
  }

  private toFailure(error: unknown): GeminiProviderError {
    if (error instanceof GeminiProviderError) return error;
    const message = redact(error instanceof Error ? `${error.name}: ${error.message}` : String(error), this.apiKey);
    return new GeminiProviderError('network', message);
  }

  private reportFailure(failure: GeminiProviderError): void {
    this.reportStatus(STATUS_BY_KIND[failure.kind], failure.message);
  }

  /** 状態が変わったときだけ出す。失敗の理由が変われば出し直す意味は薄いので、状態の遷移で判定する。 */
  private reportStatus(status: ProviderHealth, reason: string | null): void {
    if (this.lastStatus === status) return;
    this.lastStatus = status;
    this.emitter.emit({
      event: 'provider.status',
      provider: this.provider,
      provider_class: this.provider_class,
      status,
      reason: reason === null ? absent('healthy') : present(reason),
      retry_attempt: 0,
      next_retry_ms: absent('gemini_provider_does_not_retry'),
    });
  }

  private emitCost(request: LlmRequest, usage: WireChunk['usageMetadata'] | null): void {
    const counts = toUsage(usage);
    const price = priceFor(this.model_version, this.time.wallClock());
    const entries: [string, Maybe<number>, number | null][] = [
      ['input_tokens', counts.input_tokens, price?.input_per_mtok ?? null],
      ['output_tokens', counts.output_tokens, price?.output_per_mtok ?? null],
    ];
    for (const [unit, quantity, perMtok] of entries) {
      if (quantity.value === null) continue;
      this.emitter.emit({
        event: 'cost.usage',
        provider: this.provider,
        purpose: request.purpose,
        quantity: quantity.value,
        unit,
        estimated_cost_usd:
          perMtok === null
            ? absent(`no_price_table_for_${this.model_version}`)
            : present((quantity.value / 1_000_000) * perMtok),
      });
    }
    if (counts.input_tokens.value === null && counts.output_tokens.value === null) {
      this.emitter.emit({
        event: 'cost.usage',
        provider: this.provider,
        purpose: request.purpose,
        quantity: 1,
        unit: 'request_without_usage_metadata',
        estimated_cost_usd: absent('response_had_no_usage_metadata'),
      });
    }
  }
}

/** output_tokens は課金の単位に合わせて思考トークンを含む。 */
function toUsage(usage: WireChunk['usageMetadata'] | null): LlmUsage {
  const input = usage?.promptTokenCount;
  const candidates = usage?.candidatesTokenCount;
  const thoughts = usage?.thoughtsTokenCount ?? 0;
  return {
    input_tokens: input === undefined ? absent('no_usage_metadata') : present(input),
    output_tokens: candidates === undefined ? absent('no_usage_metadata') : present(candidates + thoughts),
  };
}

function redact(text: string, apiKey: string): string {
  return (apiKey ? text.split(apiKey).join('[redacted]') : text).slice(0, 400);
}

function classifyHttp(status: number, message: string, apiKey: string): GeminiProviderError {
  const clean = redact(message, apiKey);
  const detail = `HTTP ${status}: ${clean}`;
  if (status === 404) return new GeminiProviderError('model_unavailable', detail, status);
  if (status === 401 || status === 403) return new GeminiProviderError('auth', detail, status);
  if (status === 429) return new GeminiProviderError('rate_limited', detail, status);
  if (status === 400) return new GeminiProviderError('bad_request', detail, status);
  if (status >= 500) return new GeminiProviderError('server', detail, status);
  return new GeminiProviderError('server', detail, status || null);
}

/** 環境変数から作る。キーがなければ例外（黙って擬似結果にしない）。 */
export function createGeminiProviderFromEnv(
  deps: Pick<GeminiProviderOptions, 'time' | 'emitter'> &
    Partial<Omit<GeminiProviderOptions, 'api_key' | 'time' | 'emitter'>>,
): GeminiLlmProvider {
  return new GeminiLlmProvider({ ...deps, api_key: process.env.GEMINI_API_KEY ?? '' });
}
