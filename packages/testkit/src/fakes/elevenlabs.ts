/**
 * ElevenLabs の WS の偽物。stream-input と multi-stream-input の両方を実際の WS で話す。
 * 音声はトーンで、音声合成はしない。
 *
 * docs/provider_matrix.md §3 の資料どおりにしたもの: alignment は文字単位でチャンク相対、sync_alignment は既定 false、
 * 1接続 5 文脈、close_context、無通信は既定 20 秒で inactivity_timeout により最大 180 秒、
 * eleven_v3／v4 は不可、stream-input の空文字列は閉じる、multi の空文字列は keep-alive。
 *
 * 【要実測】close code、6本目の扱い（ここでは接続を閉じる）、close_context 後の音声（ここでは止める）、
 * 認証の方法、flush なしで生成が始まる条件。ここを本番の動作の根拠にしない。
 */
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import type {
  ElevenLabsAudioMessage,
  ElevenLabsMultiMessage,
  ElevenLabsTextMessage,
} from '@llm-vap/contracts';
import { toneSamples } from '../tone';

export interface FakeElevenLabsOptions {
  port?: number;
  ms_per_char?: number;
  chars_per_chunk?: number;
  /** クエリの inactivity_timeout より優先する。試験を短くするため。 */
  idle_timeout_ms?: number;
  chunk_delay_ms?: number;
  /** 音声チャンクをこの数だけ送ったら接続を切る（障害の注入）。 */
  disconnect_after_chunks?: number;
  max_contexts?: number;
}

const REJECTED_MODELS = new Set(['eleven_v3', 'eleven_v4']);
const CLOSE_POLICY = 1008;
const MAX_INACTIVITY_SEC = 180;
const DEFAULT_INACTIVITY_SEC = 20;

interface ConnectionInfo {
  voice_id: string;
  kind: 'stream-input' | 'multi-stream-input';
  model_id: string | null;
  output_format: string | null;
  sync_alignment: boolean;
  auto_mode: boolean;
  inactivity_timeout_sec: number;
}

export class FakeElevenLabsServer {
  readonly connections: ConnectionInfo[] = [];
  readonly textReceived: string[] = [];
  /** 取消された文脈。 */
  readonly closedContexts: string[] = [];
  private wss: WebSocketServer | null = null;

  constructor(private readonly options: FakeElevenLabsOptions = {}) {}

  async start(): Promise<number> {
    const wss = new WebSocketServer({ port: this.options.port ?? 0, host: '127.0.0.1' });
    this.wss = wss;
    await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
    wss.on('connection', (socket, request) => this.onConnection(socket, request.url ?? ''));
    return (wss.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    const wss = this.wss;
    if (!wss) return;
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    this.wss = null;
  }

  private onConnection(socket: WebSocket, rawUrl: string): void {
    const url = new URL(rawUrl, 'http://fake');
    const match = /^\/v1\/text-to-speech\/([^/]+)\/(stream-input|multi-stream-input)$/.exec(url.pathname);
    if (!match) {
      socket.close(CLOSE_POLICY, 'unknown path');
      return;
    }
    const kind = match[2] as ConnectionInfo['kind'];
    const model_id = url.searchParams.get('model_id');
    const output_format = url.searchParams.get('output_format');
    const inactivity = Number(url.searchParams.get('inactivity_timeout') ?? DEFAULT_INACTIVITY_SEC);
    const info: ConnectionInfo = {
      voice_id: match[1] as string,
      kind,
      model_id,
      output_format,
      sync_alignment: url.searchParams.get('sync_alignment') === 'true',
      auto_mode: url.searchParams.get('auto_mode') === 'true',
      inactivity_timeout_sec: inactivity,
    };
    this.connections.push(info);
    if (model_id && REJECTED_MODELS.has(model_id)) {
      socket.close(CLOSE_POLICY, `model ${model_id} is not supported on ${kind}`);
      return;
    }
    if (inactivity > MAX_INACTIVITY_SEC) {
      socket.close(CLOSE_POLICY, `inactivity_timeout above ${MAX_INACTIVITY_SEC}`);
      return;
    }
    const format = /^pcm_(\d+)$/.exec(output_format ?? 'pcm_16000');
    if (!format) {
      socket.close(CLOSE_POLICY, `unsupported output_format ${output_format}`);
      return;
    }
    const session = new FakeSession(this, socket, info, Number(format[1]), this.options);
    session.begin();
  }
}

class FakeSession {
  private readonly buffers = new Map<string, string>();
  private readonly closedContexts = new Set<string>();
  private queue: Promise<void> = Promise.resolve();
  private sentChunks = 0;
  private authed = false;
  private idle: NodeJS.Timeout | null = null;

  constructor(
    private readonly server: FakeElevenLabsServer,
    private readonly socket: WebSocket,
    private readonly info: ConnectionInfo,
    private readonly rate: number,
    private readonly options: FakeElevenLabsOptions,
  ) {}

  begin(): void {
    this.touch();
    this.socket.on('close', () => {
      if (this.idle) clearTimeout(this.idle);
    });
    this.socket.on('message', (data) => this.onMessage(String(data)));
  }

  private touch(): void {
    if (this.idle) clearTimeout(this.idle);
    const ms = this.options.idle_timeout_ms ?? this.info.inactivity_timeout_sec * 1000;
    this.idle = setTimeout(() => this.socket.close(CLOSE_POLICY, 'input timeout'), ms);
  }

  private onMessage(raw: string): void {
    this.touch();
    let message: ElevenLabsTextMessage & ElevenLabsMultiMessage;
    try {
      message = JSON.parse(raw) as ElevenLabsTextMessage & ElevenLabsMultiMessage;
    } catch {
      this.socket.close(CLOSE_POLICY, 'invalid json');
      return;
    }
    if (!this.authed) {
      if (!message.xi_api_key) {
        this.socket.close(CLOSE_POLICY, 'missing xi_api_key');
        return;
      }
      this.authed = true;
    }
    if (this.info.kind === 'multi-stream-input') this.onMulti(message);
    else this.onSingle(message);
  }

  private onSingle(message: ElevenLabsTextMessage): void {
    const context = '';
    const isEnd = message.text === '';
    this.append(context, message.text);
    if (message.flush || isEnd || this.info.auto_mode) this.generate(context, null);
    if (isEnd) this.finish(context, null, true);
  }

  private onMulti(message: ElevenLabsMultiMessage): void {
    const id = message.context_id;
    if (!id) {
      this.socket.close(CLOSE_POLICY, 'missing context_id');
      return;
    }
    if (message.close_context) {
      this.closedContexts.add(id);
      this.buffers.delete(id);
      this.server.closedContexts.push(id);
      return;
    }
    if (this.closedContexts.has(id)) return;
    if (!this.buffers.has(id)) {
      const limit = this.options.max_contexts ?? 5;
      if (this.buffers.size >= limit) {
        this.socket.close(CLOSE_POLICY, `too many contexts (max ${limit})`);
        return;
      }
      this.buffers.set(id, '');
    }
    // 空文字列は keep-alive。
    this.append(id, message.text ?? '');
    if (message.flush || this.info.auto_mode) {
      this.generate(id, id);
      if (message.flush) this.finish(id, id, false);
    }
  }

  private append(context: string, text: string): void {
    if (text.trim() === '') return;
    this.server.textReceived.push(text);
    this.buffers.set(context, (this.buffers.get(context) ?? '') + text);
  }

  private generate(context: string, contextId: string | null): void {
    const text = this.buffers.get(context) ?? '';
    this.buffers.set(context, '');
    if (text) this.queue = this.queue.then(() => this.pushAudio(text, context, contextId));
  }

  private finish(context: string, contextId: string | null, close: boolean): void {
    this.queue = this.queue.then(() => {
      if (this.socket.readyState !== this.socket.OPEN) return;
      if (this.closedContexts.has(context)) return;
      const last: ElevenLabsAudioMessage = {
        audio: null,
        isFinal: true,
        alignment: null,
        ...(contextId ? { contextId } : {}),
      };
      this.socket.send(JSON.stringify(last));
      if (close) this.socket.close(1000, 'done');
    });
  }

  private async pushAudio(text: string, context: string, contextId: string | null): Promise<void> {
    const msPerChar = this.options.ms_per_char ?? 100;
    const size = this.options.chars_per_chunk ?? 4;
    const all = [...text];
    for (let i = 0; i < all.length; i += size) {
      const delay = this.options.chunk_delay_ms ?? 0;
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      if (this.socket.readyState !== this.socket.OPEN) return;
      if (this.closedContexts.has(context)) return;
      const chars = all.slice(i, i + size);
      const pcm = toneSamples(Math.round(((chars.length * msPerChar) / 1000) * this.rate), this.rate);
      const message: ElevenLabsAudioMessage = {
        audio: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64'),
        isFinal: null,
        alignment: this.info.sync_alignment
          ? {
              chars,
              // チャンク内の相対時刻。
              charStartTimesMs: chars.map((_, n) => n * msPerChar),
              charDurationsMs: chars.map(() => msPerChar),
            }
          : null,
        ...(contextId ? { contextId } : {}),
      };
      this.socket.send(JSON.stringify(message));
      this.sentChunks += 1;
      const limit = this.options.disconnect_after_chunks;
      if (limit !== undefined && this.sentChunks >= limit) {
        this.socket.terminate();
        return;
      }
    }
  }
}
