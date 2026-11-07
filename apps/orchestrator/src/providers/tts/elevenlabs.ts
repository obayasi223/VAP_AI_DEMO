/**
 * ElevenLabs の TtsProvider。multi-stream-input を1接続だけ持ち、文脈で発話を分ける（provider_matrix §6.6）。
 *
 * 【実 API で確認（2026-11-08、短文で数回）】
 *  - ヘッダのキーで接続できる（最初のメッセージの xi_api_key もあってよい）。配信は asia-southeast1。
 *  - pcm_16000 と pcm_24000 は使える。pcm_44100 は接続後に output_format_not_allowed で拒否（Pro 以上）。
 *  - flush だけでは isFinal は来ない。close_context の後に来る（80〜100ms）。
 *  - close_context の後も flush 済みの音声は届く（3.7 秒ぶん、420ms 以内。isFinal は 607ms 後）。棄てるのはこの層。
 *  - alignment は入力の1文字ごとで末尾に空白が付く。normalizedAlignment はローマ字に展開されるので使わない。
 *  - flush をまたぐ chunk の alignment は文脈の累積の時刻で届く（資料は chunk 相対）。toChunkRelative でそろえる。
 *  - エラーの多くは接続が開いた後のメッセージ {message, error, code:1008} で来て、続いて閉じる。
 *    不正なキーも HTTP では拒否されない。HTTP 403 が権限とは限らない（invalid_output_format も 403）。
 * 【未確認】クォータ超過の実際のコード（ElevenLabsFailureKind の quota_exceeded は資料の名前）、取消分の課金、
 *  keep-alive の長時間の効果、日本語の読みの質（人が聞く）。
 *
 * 【取消】cancel は close_context を送り、以後その文脈の chunk を棄てて late_chunks_after_cancel に数える。
 * 【終了】endInput は flush と close_context を続けて送る。音声は続き、最後に isFinal が来る。
 *  isFinal が来なければ final_wait_ms の後に is_last の空の chunk を自分で出す。
 * 【切断】文脈はサーバー側に残らないので失う。onContextLost で知らせ、is_last の空の chunk で待ちを終わらせる。
 *  作り直しは呼び出し側（D）が決める。接続は指数バックオフで張り直す。
 * 【失敗の種類】ElevenLabsProviderError の kind で明示する。認証、プラン、クォータは張り直しても直らないので止める。
 */
import WebSocket from 'ws';
import { absent, present, ttsContextId } from '@llm-vap/contracts';
import type {
  ElevenLabsAlignment,
  ElevenLabsAudioMessage,
  ElevenLabsMultiMessage,
  EventEmitter,
  Maybe,
  ProviderClass,
  ProviderHealth,
  ProviderStatusUpdate,
  TimeSource,
  TtsCharAlignment,
  TtsChunk,
  TtsConnection,
  TtsConnectionConfig,
  TtsContext,
  TtsProvider,
  Unsubscribe,
} from '@llm-vap/contracts';
import { Listeners } from '../stt/listeners';
import type { LostContext, TtsCapabilities } from './capabilities';
import { ELEVENLABS_CAPABILITIES } from './capabilities';

const MAX_CONTEXTS = 5;
/** Flash／Turbo（provider_matrix §3）。取消分の課金は未確認で、全額と見なす。 */
const USD_PER_1K_CHARS = 0.04;
const SUPPORTED_RATES = new Set([8000, 16000, 22050, 24000, 32000, 44100, 48000]);
const CLOSE_POLICY = 1008;

export interface ElevenLabsOptions {
  /** 既定は wss://api.elevenlabs.io。試験は偽サーバーを指す。 */
  base_url: string;
  model_id: string;
  language_code: string;
  /** 最大 180（provider_matrix §3）。 */
  inactivity_timeout_sec: number;
  keep_alive_ms: number;
  /** endInput で close_context も送る。実 API の手順。false は音声が途絶えてから送る旧来の手順。 */
  close_on_end_input: boolean;
  /** close_on_end_input=false のとき、音声が途絶えてから close_context を送るまで。 */
  end_idle_ms: number;
  /** close_context の後、音声が途絶えてから isFinal を待つ上限。 */
  final_wait_ms: number;
  /**
   * 取消した文脈を、isFinal が来るまで枠に数える上限。実測で isFinal は close_context の 600ms 後で、
   * その間にサーバーの枠が空いているかは未確認。6本目は接続ごと閉じられる（実測）ので、手元で例外にして防ぐ。
   */
  release_wait_ms: number;
  retry_base_ms: number;
  retry_max_ms: number;
  down_after_attempts: number;
  /**
   * apply_language_text_normalization を URL に付ける（日本語の漢字の読みの対策。J が追加）。
   * 資料では日本語のみ対応で遅延が増える。multi-stream-input での効果は docs/provider_matrix.md を参照。
   */
  apply_language_text_normalization: boolean;
}

export const DEFAULT_ELEVENLABS_OPTIONS: ElevenLabsOptions = {
  base_url: 'wss://api.elevenlabs.io',
  model_id: 'eleven_flash_v2_5',
  language_code: 'ja',
  inactivity_timeout_sec: 180,
  keep_alive_ms: 60_000,
  close_on_end_input: true,
  end_idle_ms: 1500,
  final_wait_ms: 5000,
  release_wait_ms: 2000,
  retry_base_ms: 200,
  retry_max_ms: 5000,
  down_after_attempts: 3,
  apply_language_text_normalization: false,
};

/** 失敗の種類。LLM の GeminiProviderError と同じ考え方で、呼び出し側が文字列を解釈しなくてよいようにする。 */
export type ElevenLabsFailureKind =
  | 'auth'
  | 'permission'
  | 'plan_restricted'
  | 'quota_exceeded'
  | 'rate_limited'
  | 'invalid_request'
  | 'context_limit'
  | 'input_timeout'
  | 'network'
  | 'server'
  | 'unknown';

/** 張り直しても直らない。 */
const FATAL_KINDS = new Set<ElevenLabsFailureKind>(['auth', 'permission', 'plan_restricted', 'quota_exceeded', 'invalid_request']);

export class ElevenLabsProviderError extends Error {
  constructor(
    readonly kind: ElevenLabsFailureKind,
    message: string,
    readonly http_status: number | null = null,
    /** サーバーの error や detail.code の値。 */
    readonly provider_code: string | null = null,
  ) {
    super(`${kind}: ${message}`);
    this.name = 'ElevenLabsProviderError';
  }

  get fatal(): boolean {
    return FATAL_KINDS.has(this.kind);
  }
}

/** 実測した値: invalid_api_key、output_format_not_allowed、voice_id_does_not_exist、invalid_output_format、unsupported_model、max_active_conversations。 */
export function classifyElevenLabsError(code: string | null, http_status: number | null = null): ElevenLabsFailureKind {
  const c = (code ?? '').toLowerCase();
  if (c === 'max_active_conversations') return 'context_limit';
  if (c === 'invalid_api_key' || c === 'invalid_authorization_header' || c === 'unauthorized') return 'auth';
  if (c.includes('missing_permission') || c.includes('permission')) return 'permission';
  if (c.endsWith('_not_allowed') || c.includes('subscription') || c.includes('tier')) return 'plan_restricted';
  if (c.includes('quota')) return 'quota_exceeded';
  if (c.includes('too_many') || c.includes('rate_limit') || c.includes('concurrent')) return 'rate_limited';
  if (c.includes('timeout')) return 'input_timeout';
  if (c.startsWith('invalid_') || c.includes('does_not_exist') || c.startsWith('unsupported_') || c.includes('validation')) return 'invalid_request';
  if (http_status === 401) return 'auth';
  // 403 だけでは権限と決められない（invalid_output_format も 403）。
  if (http_status === 403) return code ? 'unknown' : 'permission';
  if (http_status === 429) return 'rate_limited';
  if (http_status !== null && http_status >= 500) return 'server';
  if (http_status !== null && http_status >= 400) return 'invalid_request';
  return 'unknown';
}

export interface ElevenLabsDiagnostics {
  connections_opened: number;
  /** 取消の後に届いた chunk。close_context 後の挙動の実測に使う（要実測の項目）。 */
  late_chunks_after_cancel: number;
  unknown_context_chunks: number;
  /** isFinal が来ず is_last を自分で出した回数。 */
  synthesized_last_chunks: number;
  lost_contexts: number;
  /** 文脈の累積の時刻で届き、chunk 相対へ直した chunk の数。 */
  alignment_rebased_chunks: number;
}

export interface ElevenLabsProviderConfig {
  api_key: string;
  voice_id: string;
  time: TimeSource;
  emitter?: EventEmitter;
  provider_class?: ProviderClass;
  options?: Partial<ElevenLabsOptions>;
}

/** 文字単位の時刻を契約の形へ。チャンク相対のまま（累積は D）。 */
export function mapAlignment(alignment: ElevenLabsAlignment | null | undefined): Maybe<TtsCharAlignment> {
  if (!alignment) return absent('server_sent_no_alignment');
  const { chars, charStartTimesMs, charDurationsMs } = alignment;
  if (
    !Array.isArray(chars) ||
    !Array.isArray(charStartTimesMs) ||
    !Array.isArray(charDurationsMs) ||
    chars.length !== charStartTimesMs.length ||
    chars.length !== charDurationsMs.length
  ) {
    return absent('malformed_alignment');
  }
  return present({ chars, char_start_ms: charStartTimesMs, char_duration_ms: charDurationsMs });
}

function parseRejection(body: string): { code: string | null; message: string | null } {
  try {
    const parsed = JSON.parse(body) as { detail?: { code?: string; status?: string; message?: string } | string };
    if (typeof parsed.detail === 'object' && parsed.detail) {
      return { code: parsed.detail.code ?? parsed.detail.status ?? null, message: parsed.detail.message ?? null };
    }
    if (typeof parsed.detail === 'string') return { code: null, message: parsed.detail };
  } catch {
    // 本文が JSON でない。
  }
  return { code: null, message: null };
}

/**
 * alignment を chunk 相対へそろえる（契約の TtsCharAlignment の定義）。
 * 資料は chunk 相対だが、実測では flush をまたぐ2番目の chunk の時刻が文脈の累積（1161ms、それまでの PCM は 1153ms）で届いた。
 * 先頭の時刻が 0 より累積に近ければ累積と見なして引く。どちらでも呼び出し側の足し算が正しくなる。
 */
export function toChunkRelative(
  alignment: Maybe<TtsCharAlignment>,
  pcmMsBefore: number,
): { value: Maybe<TtsCharAlignment>; rebased: boolean } {
  const value = alignment.value;
  const first = value?.char_start_ms[0];
  if (!value || first === undefined || pcmMsBefore <= 0 || first < pcmMsBefore / 2) {
    return { value: alignment, rebased: false };
  }
  return {
    value: present({
      chars: value.chars,
      char_start_ms: value.char_start_ms.map((ms) => Math.max(0, ms - pcmMsBefore)),
      char_duration_ms: value.char_duration_ms,
    }),
    rebased: true,
  };
}

type ContextState = 'open' | 'input_ended' | 'closing' | 'finished' | 'cancelled' | 'lost';

class ElevenLabsContext implements TtsContext {
  readonly context_id: string;
  state: ContextState = 'open';
  seq = 0;
  /** ここまでに渡した PCM の長さ。alignment の基準の判定に使う。 */
  pcmMsBefore = 0;
  /** 奇数バイトで切れた PCM の残り。 */
  carry: number | null = null;
  chars = 0;
  charsReported = false;
  endTimer: NodeJS.Timeout | null = null;

  constructor(
    readonly audio_playback_id: number,
    readonly generation: number,
    private readonly owner: ElevenLabsConnection,
  ) {
    this.context_id = ttsContextId(audio_playback_id, generation);
  }

  sendText(text: string): void {
    if (this.state === 'lost') return;
    if (this.state === 'cancelled') throw new Error('sendText after cancel');
    if (this.state !== 'open') throw new Error('sendText after endInput');
    if (text === '') return;
    this.chars += [...text].length;
    this.owner.send({ context_id: this.context_id, text });
  }

  flush(): void {
    if (this.state === 'open') this.owner.send({ context_id: this.context_id, flush: true });
  }

  endInput(): void {
    if (this.state !== 'open') return;
    this.owner.endInput(this);
  }

  cancel(reason: string): void {
    this.owner.cancelContext(this, reason);
  }
}

export class ElevenLabsConnection implements TtsConnection {
  readonly max_contexts = MAX_CONTEXTS;
  readonly capabilities: TtsCapabilities = ELEVENLABS_CAPABILITIES;
  private readonly chunks = new Listeners<TtsChunk>();
  private readonly statuses = new Listeners<ProviderStatusUpdate>();
  private readonly losses = new Listeners<LostContext>();
  private readonly failures = new Listeners<ElevenLabsProviderError>();
  private failure: ElevenLabsProviderError | null = null;
  private readonly contexts = new Map<string, ElevenLabsContext>();
  private readonly retired = new Set<string>();
  /** 取消して isFinal を待っている文脈。 */
  private readonly releasing = new Map<string, NodeJS.Timeout>();
  private readonly options: ElevenLabsOptions;
  private socket: WebSocket | null = null;
  private socketOpen = false;
  private authed = false;
  private outbox: ElevenLabsMultiMessage[] = [];
  private keepAlive: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private retryAttempt = 0;
  private closed = false;
  private fatal = false;
  private lastStatus: string | null = null;
  private readonly diag: ElevenLabsDiagnostics = {
    connections_opened: 0,
    late_chunks_after_cancel: 0,
    unknown_context_chunks: 0,
    synthesized_last_chunks: 0,
    lost_contexts: 0,
    alignment_rebased_chunks: 0,
  };

  constructor(
    private readonly provider: ElevenLabsTtsProvider,
    private readonly config: ElevenLabsProviderConfig,
    private readonly sampleRate: number,
  ) {
    this.options = { ...DEFAULT_ELEVENLABS_OPTIONS, ...config.options };
  }

  /** 最初の接続を試みる。失敗しても状態を出して張り直しを続ける（認証の誤りを除く）。 */
  async start(): Promise<void> {
    await this.connect();
    this.keepAlive = setInterval(() => this.sendKeepAlive(), this.options.keep_alive_ms);
    this.keepAlive.unref();
  }

  // ---- TtsConnection ---------------------------------------------------------

  openContext(target: { audio_playback_id: number; generation: number }): ElevenLabsContext {
    if (this.closed) throw new Error('connection is closed');
    if (this.fatal) throw new Error('connection is down and will not retry');
    const context = new ElevenLabsContext(target.audio_playback_id, target.generation, this);
    if (this.contexts.has(context.context_id) || this.retired.has(context.context_id)) {
      throw new Error(`context ${context.context_id} was already used`);
    }
    if (this.contexts.size + this.releasing.size >= MAX_CONTEXTS) {
      throw new Error(`too many active contexts (max ${MAX_CONTEXTS})`);
    }
    this.contexts.set(context.context_id, context);
    // 資料の手順: 空白1文字で文脈を始める。
    this.send({ context_id: context.context_id, text: ' ' });
    return context;
  }

  onChunk(listener: (chunk: TtsChunk) => void): Unsubscribe {
    return this.chunks.add(listener);
  }

  onStatus(listener: (status: ProviderStatusUpdate) => void): Unsubscribe {
    return this.statuses.add(listener);
  }

  /** 最後の失敗。種類で分岐できる。 */
  get lastFailure(): ElevenLabsProviderError | null {
    return this.failure;
  }

  /** 失敗ごとに呼ぶ。 */
  onFailure(listener: (failure: ElevenLabsProviderError) => void): Unsubscribe {
    return this.failures.add(listener);
  }

  /** 切断で失った文脈。契約の TtsConnection にはまだない（統括へ追加を依頼）。 */
  onContextLost(listener: (lost: LostContext) => void): Unsubscribe {
    return this.losses.add(listener);
  }

  diagnostics(): ElevenLabsDiagnostics {
    return { ...this.diag };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.keepAlive) clearInterval(this.keepAlive);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    for (const id of [...this.releasing.keys()]) this.clearReleasing(id);
    for (const context of this.contexts.values()) {
      if (context.endTimer) clearTimeout(context.endTimer);
      this.reportCost(context);
    }
    this.contexts.clear();
    const socket = this.socket;
    this.socket = null;
    this.socketOpen = false;
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => {
        socket.once('close', () => resolve());
        if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
        else socket.close(1000, 'done');
        setTimeout(() => {
          socket.terminate();
          resolve();
        }, 1000).unref();
      });
    }
  }

  // ---- 文脈から呼ばれる -------------------------------------------------------

  /** @internal */
  send(message: ElevenLabsMultiMessage): void {
    if (this.closed) return;
    if (this.socketOpen && this.socket) this.transmit(this.socket, message);
    else this.outbox.push(message);
  }

  /** @internal */
  cancelContext(context: ElevenLabsContext, _reason: string): void {
    if (context.state === 'cancelled' || context.state === 'finished' || context.state === 'lost') return;
    if (context.endTimer) clearTimeout(context.endTimer);
    context.state = 'cancelled';
    this.contexts.delete(context.context_id);
    this.retired.add(context.context_id);
    this.send({ context_id: context.context_id, close_context: true });
    this.releasing.set(
      context.context_id,
      setTimeout(() => this.releasing.delete(context.context_id), this.options.release_wait_ms),
    );
    this.reportCost(context);
  }

  /** @internal */
  endInput(context: ElevenLabsContext): void {
    this.send({ context_id: context.context_id, flush: true });
    context.state = 'input_ended';
    if (this.options.close_on_end_input) this.beginClosing(context);
    else this.armEndTimer(context);
  }

  private beginClosing(context: ElevenLabsContext): void {
    context.state = 'closing';
    this.send({ context_id: context.context_id, close_context: true });
    this.armFinalWait(context);
  }

  private armEndTimer(context: ElevenLabsContext): void {
    if (context.endTimer) clearTimeout(context.endTimer);
    context.endTimer = setTimeout(() => {
      if (context.state === 'input_ended') this.beginClosing(context);
    }, this.options.end_idle_ms);
  }

  private armFinalWait(context: ElevenLabsContext): void {
    if (context.endTimer) clearTimeout(context.endTimer);
    context.endTimer = setTimeout(() => {
      this.diag.synthesized_last_chunks += 1;
      this.finishContext(context, false);
    }, this.options.final_wait_ms);
  }

  // ---- 接続 ------------------------------------------------------------------

  private url(): string {
    const query = new URLSearchParams({
      model_id: this.options.model_id,
      output_format: `pcm_${this.sampleRate}`,
      auto_mode: 'true',
      sync_alignment: 'true',
      inactivity_timeout: String(this.options.inactivity_timeout_sec),
      language_code: this.options.language_code,
    });
    if (this.options.apply_language_text_normalization) query.set('apply_language_text_normalization', 'true');
    return `${this.options.base_url}/v1/text-to-speech/${encodeURIComponent(this.config.voice_id)}/multi-stream-input?${query}`;
  }

  private connect(): Promise<void> {
    return new Promise((resolve) => {
      // キーは URL に入れない。
      const socket = new WebSocket(this.url(), { headers: { 'xi-api-key': this.config.api_key } });
      this.socket = socket;
      this.authed = false;
      this.diag.connections_opened += 1;
      let settled = false;
      const settle = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      socket.on('open', () => {
        if (socket !== this.socket) return;
        this.socketOpen = true;
        this.retryAttempt = 0;
        this.setStatus('ok', 'connected', 0, absent('not_retrying'));
        const queued = this.outbox.splice(0);
        for (const message of queued) this.transmit(socket, message);
        settle();
      });
      socket.on('message', (data) => {
        if (socket === this.socket) this.onMessage(String(data));
      });
      socket.on('unexpected-response', (_request, response) => {
        const status = response.statusCode ?? 0;
        let body = '';
        response.on('data', (d) => {
          if (body.length < 2000) body += String(d);
        });
        const finish = () => {
          const { code, message } = parseRejection(body);
          const kind = classifyElevenLabsError(code, status);
          const failure = new ElevenLabsProviderError(kind, this.scrub(message ?? `HTTP ${status}`).slice(0, 180), status, code);
          if (failure.fatal) this.onFatal(failure);
          else {
            this.record(failure);
            this.onDisconnected(socket, failure.message);
          }
          socket.terminate();
          settle();
        };
        response.once('end', finish);
        response.once('error', finish);
      });
      socket.on('error', (error) => {
        this.onDisconnected(socket, `socket error: ${this.scrub(error.message)}`);
        settle();
      });
      socket.on('close', (code, reason) => {
        this.onDisconnected(socket, `closed: ${code} ${this.scrub(String(reason))}`.trim(), code, String(reason));
        settle();
      });
    });
  }

  private record(failure: ElevenLabsProviderError): void {
    this.failure = failure;
    this.failures.emit(failure);
  }

  /** 認証、プラン、クォータなど。張り直しをやめ、文脈を失ったと知らせる。 */
  private onFatal(failure: ElevenLabsProviderError): void {
    this.record(failure);
    this.fatal = true;
    this.failContexts(failure.message);
    this.setStatus('down', failure.message, this.retryAttempt, absent('non_retryable_error'));
  }

  private onDisconnected(socket: WebSocket, reason: string, code?: number, closeReason?: string): void {
    if (socket !== this.socket || this.closed || this.fatal) return;
    this.socket = null;
    this.socketOpen = false;
    this.failContexts(reason);
    // 文脈がないときの無通信の切断は正常。張り直すだけで状態は変えない。
    const idle = code === CLOSE_POLICY && /timeout/i.test(closeReason ?? '');
    this.retryAttempt += 1;
    const delay = Math.min(this.options.retry_max_ms, this.options.retry_base_ms * 2 ** (this.retryAttempt - 1));
    if (!idle) {
      const status: ProviderHealth = this.retryAttempt >= this.options.down_after_attempts ? 'down' : 'degraded';
      this.setStatus(status, reason, this.retryAttempt, present(delay));
    }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.closed) void this.connect();
    }, delay);
    this.retryTimer.unref();
  }

  private clearReleasing(id: string): void {
    const timer = this.releasing.get(id);
    if (timer) clearTimeout(timer);
    this.releasing.delete(id);
  }

  private failContexts(reason: string): void {
    this.outbox = [];
    // 接続が切れたらサーバーの枠も消える。
    for (const id of [...this.releasing.keys()]) this.clearReleasing(id);
    for (const context of [...this.contexts.values()]) {
      if (context.endTimer) clearTimeout(context.endTimer);
      context.state = 'lost';
      this.contexts.delete(context.context_id);
      this.retired.add(context.context_id);
      this.diag.lost_contexts += 1;
      this.reportCost(context);
      this.losses.emit({
        context_id: context.context_id,
        audio_playback_id: context.audio_playback_id,
        generation: context.generation,
        reason,
      });
      // 呼び出し側の待ちを終わらせる。音声が足りないことは onContextLost と provider.status で分かる。
      this.chunks.emit({
        context_id: context.context_id,
        audio_playback_id: context.audio_playback_id,
        generation: context.generation,
        seq: context.seq++,
        sample_rate_hz: this.sampleRate,
        pcm: new Int16Array(0),
        alignment: absent('context_lost'),
        is_last: true,
      });
    }
  }

  private transmit(socket: WebSocket, message: ElevenLabsMultiMessage): void {
    // 偽サーバーと資料の想定に合わせ、接続の最初のメッセージにもキーを入れる（ヘッダだけで足りるかは未検証）。
    const payload: ElevenLabsMultiMessage = this.authed ? message : { ...message, xi_api_key: this.config.api_key };
    this.authed = true;
    socket.send(JSON.stringify(payload));
  }

  private sendKeepAlive(): void {
    for (const context of this.contexts.values()) {
      if (context.state === 'open' || context.state === 'input_ended') {
        this.send({ context_id: context.context_id, text: '' });
      }
    }
  }

  // ---- 受信 ------------------------------------------------------------------

  private onMessage(raw: string): void {
    let message: ElevenLabsAudioMessage & { error?: unknown; message?: unknown };
    try {
      message = JSON.parse(raw) as typeof message;
    } catch {
      this.setStatus('degraded', 'invalid json from server', 0, absent('not_retrying'));
      return;
    }
    if (message.error !== undefined) {
      const code = typeof message.error === 'string' ? message.error : null;
      const failure = new ElevenLabsProviderError(
        classifyElevenLabsError(code),
        this.scrub(String(message.message ?? message.error)).slice(0, 180),
        null,
        code,
      );
      // 続いてサーバーが閉じる。直らないものはここで止め、それ以外は切断の経路で張り直す。
      if (failure.fatal) this.onFatal(failure);
      else {
        this.record(failure);
        this.setStatus('degraded', failure.message, this.retryAttempt, absent('awaiting_close'));
      }
      return;
    }
    const id = message.contextId;
    if (!id) {
      this.diag.unknown_context_chunks += 1;
      return;
    }
    const context = this.contexts.get(id);
    if (!context) {
      if (this.retired.has(id)) {
        if (message.audio) this.diag.late_chunks_after_cancel += 1;
        if (message.isFinal) this.clearReleasing(id);
      } else {
        this.diag.unknown_context_chunks += 1;
      }
      return;
    }
    if (message.audio || message.alignment) {
      const pcm = message.audio ? this.decode(context, message.audio) : new Int16Array(0);
      const alignment = toChunkRelative(mapAlignment(message.alignment), context.pcmMsBefore);
      if (alignment.rebased) this.diag.alignment_rebased_chunks += 1;
      context.pcmMsBefore += (pcm.length / this.sampleRate) * 1000;
      this.chunks.emit({
        context_id: context.context_id,
        audio_playback_id: context.audio_playback_id,
        generation: context.generation,
        seq: context.seq++,
        sample_rate_hz: this.sampleRate,
        pcm,
        alignment: alignment.value,
        is_last: false,
      });
      if (context.state === 'input_ended') this.armEndTimer(context);
      if (context.state === 'closing') this.armFinalWait(context);
    }
    if (message.isFinal) this.finishContext(context, true);
  }

  /** S16LE。メッセージの境界で奇数バイトに切れても1サンプルずらさない。 */
  private decode(context: ElevenLabsContext, base64: string): Int16Array {
    const bytes = Buffer.from(base64, 'base64');
    const lead = context.carry === null ? 0 : 1;
    const total = bytes.length + lead;
    const samples = new Int16Array(Math.floor(total / 2));
    const at = (i: number): number => (lead === 1 ? (i === 0 ? (context.carry as number) : (bytes[i - 1] as number)) : (bytes[i] as number));
    for (let i = 0; i < samples.length; i++) {
      samples[i] = ((at(i * 2) | (at(i * 2 + 1) << 8)) << 16) >> 16;
    }
    context.carry = total % 2 === 1 ? (bytes[bytes.length - 1] as number) : null;
    return samples;
  }

  private finishContext(context: ElevenLabsContext, sendClose: boolean): void {
    if (context.state === 'finished' || context.state === 'cancelled' || context.state === 'lost') return;
    if (context.endTimer) clearTimeout(context.endTimer);
    const alreadyClosing = context.state === 'closing';
    context.state = 'finished';
    this.contexts.delete(context.context_id);
    this.retired.add(context.context_id);
    // 枠を返す。flush で終わった場合はまだ閉じていない。
    if (sendClose && !alreadyClosing) this.send({ context_id: context.context_id, close_context: true });
    this.reportCost(context);
    this.chunks.emit({
      context_id: context.context_id,
      audio_playback_id: context.audio_playback_id,
      generation: context.generation,
      seq: context.seq++,
      sample_rate_hz: this.sampleRate,
      pcm: new Int16Array(0),
      alignment: absent('last_chunk_has_no_audio'),
      is_last: true,
    });
  }

  private reportCost(context: ElevenLabsContext): void {
    if (context.charsReported || context.chars === 0) return;
    context.charsReported = true;
    this.config.emitter?.emit({
      event: 'cost.usage',
      provider: this.provider.provider,
      purpose: 'tts_context',
      quantity: context.chars,
      unit: 'characters',
      estimated_cost_usd: present((context.chars / 1000) * USD_PER_1K_CHARS),
    });
  }

  private scrub(text: string): string {
    return text.split(this.config.api_key).join('<ELEVENLABS_API_KEY>');
  }

  private setStatus(
    status: ProviderHealth,
    reason: string,
    retry_attempt: number,
    next_retry_ms: Maybe<number>,
  ): void {
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

export class ElevenLabsTtsProvider implements TtsProvider {
  readonly provider = 'elevenlabs';
  readonly model_version: string;
  readonly provider_class: ProviderClass;

  constructor(private readonly config: ElevenLabsProviderConfig) {
    this.model_version = config.options?.model_id ?? DEFAULT_ELEVENLABS_OPTIONS.model_id;
    this.provider_class = config.provider_class ?? 'production';
  }

  async open(config: TtsConnectionConfig): Promise<ElevenLabsConnection> {
    const rate = config.preferred_sample_rate_hz;
    if (!SUPPORTED_RATES.has(rate)) throw new Error(`unsupported PCM rate ${rate}`);
    const connection = new ElevenLabsConnection(this, this.config, rate);
    await connection.start();
    return connection;
  }
}
