import { absent, present, ttsContextId } from '@llm-vap/contracts';
import type {
  ProviderStatusUpdate,
  TtsChunk,
  TtsConnection,
  TtsConnectionConfig,
  TtsContext,
  TtsProvider,
  Unsubscribe,
} from '@llm-vap/contracts';
import { Listeners } from '../listeners';
import { toneSamples } from '../tone';

export interface ScriptedTtsOptions {
  /** 1文字あたりの音声の長さ。 */
  ms_per_char?: number;
  /** 1チャンクの文字数。 */
  chars_per_chunk?: number;
  /** 既定は 5（資料の multi-stream-input の上限）。 */
  max_contexts?: number;
}

class ScriptedTtsContext implements TtsContext {
  readonly context_id: string;
  readonly sent: string[] = [];
  cancelled: string | null = null;
  private pending = '';
  private inputEnded = false;
  private finished = false;
  private seq = 0;

  constructor(
    readonly audio_playback_id: number,
    readonly generation: number,
    private readonly owner: ScriptedTtsConnection,
  ) {
    this.context_id = ttsContextId(audio_playback_id, generation);
  }

  sendText(text: string): void {
    if (this.inputEnded) throw new Error('sendText after endInput');
    if (this.cancelled !== null) throw new Error('sendText after cancel');
    this.sent.push(text);
    this.pending += text;
  }

  flush(): void {
    // 台本の再生では pump の時点で生成するので何もしない。
  }

  endInput(): void {
    this.inputEnded = true;
  }

  cancel(reason: string): void {
    this.cancelled = reason;
    this.pending = '';
    this.owner.release(this);
  }

  /** 次の chunk を1つ出す。出したら true。取消後は何も出さない。 */
  pump(): boolean {
    if (this.cancelled !== null || this.finished || this.pending.length === 0) return false;
    const { ms_per_char, chars_per_chunk } = this.owner.options;
    const chars = [...this.pending].slice(0, chars_per_chunk);
    this.pending = [...this.pending].slice(chars.length).join('');
    const rate = this.owner.config.preferred_sample_rate_hz;
    const samples = Math.round(((chars.length * ms_per_char) / 1000) * rate);
    const is_last = this.inputEnded && this.pending.length === 0;
    this.owner.emitChunk({
      context_id: this.context_id,
      audio_playback_id: this.audio_playback_id,
      generation: this.generation,
      seq: this.seq++,
      sample_rate_hz: rate,
      pcm: toneSamples(samples, rate),
      // 実物と同じくチャンク内の相対時刻。累積は呼び出し側の仕事。
      alignment: present({
        chars,
        char_start_ms: chars.map((_, i) => i * ms_per_char),
        char_duration_ms: chars.map(() => ms_per_char),
      }),
      is_last,
    });
    if (is_last) {
      this.finished = true;
      this.owner.release(this);
    }
    return true;
  }

  pumpAll(): number {
    let n = 0;
    while (this.pump()) n += 1;
    return n;
  }
}

export class ScriptedTtsConnection implements TtsConnection {
  readonly contexts: ScriptedTtsContext[] = [];
  closed = false;
  private readonly active = new Set<ScriptedTtsContext>();
  private readonly chunks = new Listeners<TtsChunk>();
  private readonly statuses = new Listeners<ProviderStatusUpdate>();

  constructor(
    readonly config: TtsConnectionConfig,
    readonly options: Required<ScriptedTtsOptions>,
  ) {}

  get max_contexts(): number {
    return this.options.max_contexts;
  }

  get activeContextCount(): number {
    return this.active.size;
  }

  openContext(target: { audio_playback_id: number; generation: number }): ScriptedTtsContext {
    if (this.closed) throw new Error('connection is closed');
    if (this.active.size >= this.options.max_contexts) {
      throw new Error(`too many active contexts (max ${this.options.max_contexts})`);
    }
    const context = new ScriptedTtsContext(target.audio_playback_id, target.generation, this);
    this.contexts.push(context);
    this.active.add(context);
    return context;
  }

  onChunk(listener: (chunk: TtsChunk) => void): Unsubscribe {
    return this.chunks.add(listener);
  }

  onStatus(listener: (status: ProviderStatusUpdate) => void): Unsubscribe {
    return this.statuses.add(listener);
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  /** @internal */
  emitChunk(chunk: TtsChunk): void {
    this.chunks.emit(chunk);
  }

  /** @internal */
  release(context: ScriptedTtsContext): void {
    this.active.delete(context);
  }

  deliverStatus(status: ProviderStatusUpdate['status'], reason: string): void {
    this.statuses.emit({
      provider: 'scripted_tts',
      status,
      reason: present(reason),
      retry_attempt: 0,
      next_retry_ms: absent('test_double_does_not_retry'),
    });
  }
}

/**
 * テキストの長さに比例した長さのトーンを返す TTS。音声合成はしない。
 * pump() を呼ぶまで chunk を出さないので、取消と世代の試験を決定的に書ける。
 */
export class ScriptedTtsProvider implements TtsProvider {
  readonly provider = 'scripted_tts';
  readonly model_version = 'test_double';
  readonly provider_class = 'test_double' as const;
  readonly connections: ScriptedTtsConnection[] = [];
  private readonly options: Required<ScriptedTtsOptions>;

  constructor(options: ScriptedTtsOptions = {}) {
    this.options = { ms_per_char: 100, chars_per_chunk: 4, max_contexts: 5, ...options };
  }

  async open(config: TtsConnectionConfig): Promise<ScriptedTtsConnection> {
    const connection = new ScriptedTtsConnection(config, this.options);
    this.connections.push(connection);
    return connection;
  }
}
