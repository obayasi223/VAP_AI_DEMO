/**
 * Gemini TTS の TtsProvider。ElevenLabs のキーがないときの代替。
 *
 * 【実 API で確認（2026-11-08、短文で各1〜2回）】
 *  gemini-3.8-flash-tts と gemini-3.8-flash-lite-tts は Interactions API の stream で動く。
 *  step.delta の delta.type=audio に base64 の audio/l16、24000Hz。最初の音声まで 0.9〜1.2 秒で、
 *  3 秒の音声は 0.7 秒ほどで届く。fetch の中断でストリームは止まる（課金が止まるかは未確認）。
 * 【未確認】無料枠の制限の実際のエラー（429 の扱いは偽サーバーのみ）、中断した分の課金、話し方の質。
 *
 * ElevenLabs との差（capabilities.ts で判別できる）:
 *  - 入力は逐次でなく、flush か endInput ごとに1要求。文脈の中では順に生成する。
 *  - 文字単位の alignment がない。TtsChunk.alignment は null と理由にし、estimated_alignment に推定を入れる。
 *    alignment へ入れないのは、呼び出し側が alignment_char の精度として記録しないようにするため。
 *  - 接続を持たない（要求ごとに HTTP）。keep-alive も再接続もない。
 */
import { absent, present, ttsContextId } from '@llm-vap/contracts';
import type {
  EventEmitter,
  Maybe,
  ProviderClass,
  ProviderHealth,
  ProviderStatusUpdate,
  TimeSource,
  TtsChunk,
  TtsConnection,
  TtsConnectionConfig,
  TtsContext,
  TtsProvider,
  Unsubscribe,
} from '@llm-vap/contracts';
import { Listeners } from '../stt/listeners';
import { GEMINI_TTS_CAPABILITIES } from './capabilities';
import type { EstimatedAlignment, LostContext, TtsCapabilities, TtsChunkWithEstimate } from './capabilities';

/** 音声 1 秒が 25 トークン。Standard の出力単価（2026-12-31 まで、1M トークン）。2027 年は2倍。無料枠なら 0。 */
const USD_PER_M_AUDIO_TOKENS: Record<string, number> = {
  'gemini-3.8-flash-tts': 9,
  'gemini-3.8-flash-lite-tts': 6,
};
const AUDIO_TOKENS_PER_SECOND = 25;
const DEFAULT_RATE = 24000;
/** 実測 3 秒／17 文字から。要求ごとに実際の長さで更新する。 */
const INITIAL_MS_PER_CHAR = 175;

export interface GeminiTtsOptions {
  base_url: string;
  model: string;
  voice: string;
  max_contexts: number;
  /** 音声が1つも届く前の失敗で開き直す回数。 */
  max_retries: number;
  /** サーバーの指定を含め、これより長くは待たない。古い応答の音声を出さないため。 */
  max_retry_wait_ms: number;
  retry_base_ms: number;
  down_after_failures: number;
}

export const DEFAULT_GEMINI_TTS_OPTIONS: GeminiTtsOptions = {
  base_url: 'https://generativelanguage.googleapis.com',
  model: 'gemini-3.8-flash-lite-tts',
  voice: 'Kore',
  max_contexts: 5,
  max_retries: 1,
  max_retry_wait_ms: 3000,
  retry_base_ms: 300,
  down_after_failures: 3,
};

export interface GeminiTtsProviderConfig {
  api_key: string;
  time: TimeSource;
  emitter?: EventEmitter;
  provider_class?: ProviderClass;
  options?: Partial<GeminiTtsOptions>;
}

export interface GeminiTtsDiagnostics {
  requests: number;
  retries: number;
  rate_limited: number;
  lost_contexts: number;
  /** 要求から最初の音声まで。 */
  first_audio_ms: number[];
  ms_per_char_estimate: number;
}

class RequestFailure extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly fatal: boolean,
    readonly retry_after_ms: number | null,
    readonly rate_limited: boolean,
  ) {
    super(message);
  }
}

type ContextState = 'open' | 'input_ended' | 'finished' | 'cancelled' | 'lost';

class GeminiTtsContext implements TtsContext {
  readonly context_id: string;
  state: ContextState = 'open';
  seq = 0;
  buffer = '';
  queue: string[] = [];
  running = false;
  abort: AbortController | null = null;

  constructor(
    readonly audio_playback_id: number,
    readonly generation: number,
    private readonly owner: GeminiTtsConnection,
  ) {
    this.context_id = ttsContextId(audio_playback_id, generation);
  }

  sendText(text: string): void {
    if (this.state === 'lost') return;
    if (this.state === 'cancelled') throw new Error('sendText after cancel');
    if (this.state !== 'open') throw new Error('sendText after endInput');
    this.buffer += text;
  }

  flush(): void {
    if (this.state !== 'open') return;
    this.enqueue();
  }

  endInput(): void {
    if (this.state !== 'open') return;
    this.enqueue();
    this.state = 'input_ended';
    this.owner.pump(this);
  }

  cancel(reason: string): void {
    this.owner.cancelContext(this, reason);
  }

  private enqueue(): void {
    if (this.buffer.trim() !== '') this.queue.push(this.buffer);
    this.buffer = '';
    this.owner.pump(this);
  }
}

export class GeminiTtsConnection implements TtsConnection {
  readonly capabilities: TtsCapabilities = GEMINI_TTS_CAPABILITIES;
  readonly max_contexts: number;
  private readonly chunks = new Listeners<TtsChunk>();
  private readonly statuses = new Listeners<ProviderStatusUpdate>();
  private readonly losses = new Listeners<LostContext>();
  private readonly contexts = new Map<string, GeminiTtsContext>();
  private readonly used = new Set<string>();
  private readonly options: GeminiTtsOptions;
  private msPerChar = INITIAL_MS_PER_CHAR;
  private consecutiveFailures = 0;
  private fatal = false;
  private closed = false;
  private lastStatus: string | null = null;
  private readonly diag: GeminiTtsDiagnostics = {
    requests: 0,
    retries: 0,
    rate_limited: 0,
    lost_contexts: 0,
    first_audio_ms: [],
    ms_per_char_estimate: INITIAL_MS_PER_CHAR,
  };

  constructor(
    private readonly provider: GeminiTtsProvider,
    private readonly config: GeminiTtsProviderConfig,
  ) {
    this.options = { ...DEFAULT_GEMINI_TTS_OPTIONS, ...config.options };
    this.max_contexts = this.options.max_contexts;
    // 要求は発話ごとなので、開いた時点では未確認。代替であることと推定であることを記録に残す。
    this.setStatus('ok', `ready model=${this.options.model} alignment=estimated_time_proportional`, 0, absent('not_retrying'));
  }

  openContext(target: { audio_playback_id: number; generation: number }): GeminiTtsContext {
    if (this.closed) throw new Error('connection is closed');
    if (this.fatal) throw new Error('connection is down and will not retry');
    const context = new GeminiTtsContext(target.audio_playback_id, target.generation, this);
    if (this.used.has(context.context_id)) throw new Error(`context ${context.context_id} was already used`);
    if (this.contexts.size >= this.max_contexts) {
      throw new Error(`too many active contexts (max ${this.max_contexts})`);
    }
    this.used.add(context.context_id);
    this.contexts.set(context.context_id, context);
    return context;
  }

  onChunk(listener: (chunk: TtsChunk) => void): Unsubscribe {
    return this.chunks.add(listener);
  }

  onStatus(listener: (status: ProviderStatusUpdate) => void): Unsubscribe {
    return this.statuses.add(listener);
  }

  onContextLost(listener: (lost: LostContext) => void): Unsubscribe {
    return this.losses.add(listener);
  }

  diagnostics(): GeminiTtsDiagnostics {
    return { ...this.diag, first_audio_ms: [...this.diag.first_audio_ms], ms_per_char_estimate: this.msPerChar };
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const context of [...this.contexts.values()]) this.cancelContext(context, 'connection_closed');
  }

  /** @internal */
  cancelContext(context: GeminiTtsContext, _reason: string): void {
    if (context.state === 'cancelled' || context.state === 'finished' || context.state === 'lost') return;
    context.state = 'cancelled';
    context.buffer = '';
    context.queue = [];
    context.abort?.abort();
    this.contexts.delete(context.context_id);
  }

  /** @internal 文脈の中では要求を順に実行する。 */
  pump(context: GeminiTtsContext): void {
    if (context.running) return;
    context.running = true;
    void this.run(context).finally(() => {
      context.running = false;
    });
  }

  private async run(context: GeminiTtsContext): Promise<void> {
    while (context.queue.length > 0 && context.state !== 'cancelled' && context.state !== 'lost') {
      const text = context.queue.shift() as string;
      try {
        await this.generateWithRetry(context, text);
      } catch (error) {
        if ((context.state as ContextState) === 'cancelled') return;
        this.onFailed(context, error instanceof RequestFailure ? error : new RequestFailure(String(error), false, false, null, false));
        return;
      }
    }
    if (context.state === 'input_ended' && context.queue.length === 0) this.finish(context);
  }

  private finish(context: GeminiTtsContext): void {
    context.state = 'finished';
    this.contexts.delete(context.context_id);
    this.emitChunk(context, new Int16Array(0), DEFAULT_RATE, absent('last_chunk_has_no_audio'), undefined, true);
  }

  private onFailed(context: GeminiTtsContext, failure: RequestFailure): void {
    this.consecutiveFailures += 1;
    if (failure.fatal) this.fatal = true;
    const status: ProviderHealth = failure.fatal || this.consecutiveFailures >= this.options.down_after_failures ? 'down' : 'degraded';
    this.setStatus(status, failure.message.slice(0, 200), this.consecutiveFailures, absent(failure.fatal ? 'non_retryable_error' : 'caller_decides_retry'));
    context.state = 'lost';
    context.queue = [];
    this.contexts.delete(context.context_id);
    this.diag.lost_contexts += 1;
    this.losses.emit({
      context_id: context.context_id,
      audio_playback_id: context.audio_playback_id,
      generation: context.generation,
      reason: failure.message.slice(0, 200),
    });
    this.emitChunk(context, new Int16Array(0), DEFAULT_RATE, absent('context_lost'), undefined, true);
  }

  private async generateWithRetry(context: GeminiTtsContext, text: string): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.generate(context, text);
        this.consecutiveFailures = 0;
        this.setStatus('ok', `generating model=${this.options.model} alignment=estimated_time_proportional`, 0, absent('not_retrying'));
        return;
      } catch (error) {
        if (!(error instanceof RequestFailure)) throw error;
        if (error.rate_limited) this.diag.rate_limited += 1;
        const wait = error.retry_after_ms ?? this.options.retry_base_ms * 2 ** attempt;
        if (!error.retryable || attempt >= this.options.max_retries || wait > this.options.max_retry_wait_ms) throw error;
        this.diag.retries += 1;
        this.setStatus('degraded', error.message.slice(0, 200), attempt + 1, present(wait));
        await new Promise((resolve) => setTimeout(resolve, wait));
        if (context.state === 'cancelled') return;
      }
    }
  }

  private async generate(context: GeminiTtsContext, text: string): Promise<void> {
    const abort = new AbortController();
    context.abort = abort;
    const startedAt = performance.now();
    this.diag.requests += 1;
    const body = {
      model: this.options.model,
      input: [{ type: 'user_input', content: [{ type: 'text', text }] }],
      response_format: { type: 'audio' },
      generation_config: { speech_config: [{ voice: this.options.voice }] },
      stream: true,
      // Interactions は既定で要求を保存する。人に聞かせる文を残さない。
      store: false,
    };
    let response: Response;
    try {
      response = await fetch(`${this.options.base_url}/v1beta/interactions?alt=sse`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // キーは URL に入れない。
          'x-goog-api-key': this.config.api_key,
          'Api-Revision': '2026-05-20',
        },
        body: JSON.stringify(body),
        signal: abort.signal,
      });
    } catch (error) {
      if (abort.signal.aborted) return;
      throw new RequestFailure(`network: ${this.scrub(String(error))}`, true, false, null, false);
    }
    if (!response.ok) throw await this.toFailure(response);
    if (!response.body) throw new RequestFailure('empty response body', true, false, null, false);

    const estimator = new CharEstimator(text, this.msPerChar);
    let held: { pcm: Int16Array; rate: number } | null = null;
    let carry: number | null = null;
    let delivered = false;
    let totalMs = 0;
    const flushHeld = (last: boolean) => {
      if (!held) return;
      const { pcm, rate } = held;
      held = null;
      const ms = (pcm.length / rate) * 1000;
      totalMs += ms;
      this.emitChunk(
        context,
        pcm,
        rate,
        absent('provider_has_no_alignment'),
        estimator.next(ms, last),
        false,
      );
      delivered = true;
    };

    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for await (const piece of response.body as unknown as AsyncIterable<Uint8Array>) {
        if (abort.signal.aborted) return;
        buffer += decoder.decode(piece, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '' || payload === '[DONE]') continue;
          const event = JSON.parse(payload) as GeminiSseEvent;
          if (event.error || event.event_type === 'error' || event.event_type === 'interaction.failed') {
            throw new RequestFailure(`stream error: ${this.scrub(JSON.stringify(event.error ?? event.event_type))}`, !delivered && !held, false, null, false);
          }
          if (event.event_type === 'step.delta' && event.delta?.type === 'audio' && event.delta.data) {
            if (this.diag.first_audio_ms.length < 1000 && !delivered && !held) {
              this.diag.first_audio_ms.push(Math.round(performance.now() - startedAt));
            }
            // 残り1個を持つ。最後の chunk に、割り当てていない文字を入れるため。
            flushHeld(false);
            const bytes = Buffer.from(event.delta.data, 'base64');
            const decoded = decodeS16le(bytes, carry);
            carry = decoded.carry;
            held = { pcm: decoded.samples, rate: event.delta.sample_rate ?? DEFAULT_RATE };
          }
        }
      }
    } catch (error) {
      if (abort.signal.aborted) return;
      // 受け取った音声は捨てない。
      if (delivered) flushHeld(true);
      if (error instanceof RequestFailure) throw error;
      throw new RequestFailure(`stream broken: ${this.scrub(String(error))}`, !delivered && !held, false, null, false);
    }
    if (abort.signal.aborted) return;
    flushHeld(true);
    if (totalMs > 0) {
      const chars = Math.max(1, [...text].length);
      // 次の要求の見積もりにだけ使う。
      this.msPerChar = this.msPerChar * 0.5 + (totalMs / chars) * 0.5;
      this.reportCost(totalMs / 1000);
    }
  }

  private async toFailure(response: Response): Promise<RequestFailure> {
    let detail = '';
    let retryAfter: number | null = null;
    try {
      const raw = await response.text();
      detail = this.scrub(raw).slice(0, 300);
      const parsed = JSON.parse(raw) as { error?: { message?: string; details?: { retryDelay?: string }[] } };
      detail = this.scrub(parsed.error?.message ?? detail).slice(0, 180);
      const delay = parsed.error?.details?.find((d) => d.retryDelay)?.retryDelay;
      if (delay) retryAfter = Number.parseFloat(delay) * 1000;
    } catch {
      // 本文が JSON でない。
    }
    const header = response.headers.get('retry-after');
    if (retryAfter === null && header) retryAfter = Number(header) * 1000;
    const code = response.status;
    const message = `HTTP ${code}: ${detail}`;
    if (code === 429) return new RequestFailure(message, true, false, retryAfter, true);
    if (code === 401 || code === 403) return new RequestFailure(message, false, true, null, false);
    if (code === 400 || code === 404) return new RequestFailure(message, false, false, null, false);
    return new RequestFailure(message, code >= 500, false, retryAfter, false);
  }

  private emitChunk(
    context: GeminiTtsContext,
    pcm: Int16Array,
    rate: number,
    alignment: Maybe<never>,
    estimated: EstimatedAlignment | undefined,
    is_last: boolean,
  ): void {
    const chunk: TtsChunkWithEstimate = {
      context_id: context.context_id,
      audio_playback_id: context.audio_playback_id,
      generation: context.generation,
      seq: context.seq++,
      sample_rate_hz: rate,
      pcm,
      alignment,
      is_last,
      ...(estimated ? { estimated_alignment: estimated } : {}),
    };
    this.chunks.emit(chunk);
  }

  private reportCost(seconds: number): void {
    const rate = USD_PER_M_AUDIO_TOKENS[this.options.model];
    this.config.emitter?.emit({
      event: 'cost.usage',
      provider: this.provider.provider,
      purpose: 'tts_request',
      quantity: seconds,
      unit: 'audio_seconds',
      estimated_cost_usd:
        rate === undefined
          ? absent('price_not_known_for_model')
          : present((seconds * AUDIO_TOKENS_PER_SECOND * rate) / 1_000_000),
    });
  }

  private scrub(text: string): string {
    return text.split(this.config.api_key).join('<GEMINI_API_KEY>');
  }

  private setStatus(status: ProviderHealth, reason: string, retry_attempt: number, next_retry_ms: Maybe<number>): void {
    const key = `${status}|${reason}|${retry_attempt}`;
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    const update: ProviderStatusUpdate = {
      provider: this.provider.provider,
      status,
      reason: present(reason),
      retry_attempt,
      next_retry_ms,
    };
    this.config.emitter?.emit({ event: 'provider.status', provider_class: this.provider.provider_class, ...update });
    this.statuses.emit(update);
  }
}

interface GeminiSseEvent {
  event_type?: string;
  delta?: { type?: string; data?: string; mime_type?: string; sample_rate?: number };
  error?: unknown;
}

/**
 * 文字を音声へ時間比例で割り当てる。音声の総量は最後まで分からないので、
 * 見積もりの速さで順に割り当て、最後の chunk に残りを全部入れる。実測の時刻ではない。
 */
export class CharEstimator {
  private readonly chars: string[];
  private used = 0;
  private audioMs = 0;

  constructor(text: string, private readonly msPerChar: number) {
    this.chars = [...text];
  }

  next(chunkMs: number, last: boolean): EstimatedAlignment {
    this.audioMs += chunkMs;
    const target = last ? this.chars.length : Math.min(this.chars.length, Math.floor(this.audioMs / this.msPerChar));
    const chars = this.chars.slice(this.used, Math.max(this.used, target));
    this.used += chars.length;
    const each = chars.length > 0 ? chunkMs / chars.length : 0;
    return {
      source: 'estimated_time_proportional',
      chars,
      char_start_ms: chars.map((_, i) => i * each),
      char_duration_ms: chars.map(() => each),
    };
  }
}

function decodeS16le(bytes: Buffer, carry: number | null): { samples: Int16Array; carry: number | null } {
  const data = carry === null ? bytes : Buffer.concat([Buffer.from([carry]), bytes]);
  const count = Math.floor(data.length / 2);
  const samples = new Int16Array(count);
  for (let i = 0; i < count; i++) samples[i] = data.readInt16LE(i * 2);
  return { samples, carry: data.length % 2 === 1 ? (data[data.length - 1] as number) : null };
}

export class GeminiTtsProvider implements TtsProvider {
  readonly provider = 'gemini_tts';
  readonly model_version: string;
  readonly provider_class: ProviderClass;

  constructor(private readonly config: GeminiTtsProviderConfig) {
    this.model_version = config.options?.model ?? DEFAULT_GEMINI_TTS_OPTIONS.model;
    this.provider_class = config.provider_class ?? 'production';
  }

  /** 出力は 24000Hz 固定（実測）。実際の値は TtsChunk.sample_rate_hz を見る。 */
  async open(_config: TtsConnectionConfig): Promise<GeminiTtsConnection> {
    return new GeminiTtsConnection(this, this.config);
  }
}
