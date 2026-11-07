/**
 * 実ブラウザ試験用の Node の代わり。受けた枠のサンプルを番号の位置へ記録し、
 * 契約どおりの JSON を zod で検証する。本番の検証には数えない。
 */
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import {
  BROWSER_RPC_PROTOCOL_VERSION,
  BrowserToNode,
  NodeToBrowser,
  decodeAudioFrame,
  encodePcmFrame,
} from '@llm-vap/contracts';

const CAPACITY = 16000 * 300;

export interface MeasureOptions {
  echo?: boolean;
  /** clock.pong の前に置く遅延（非対称の再現）。 */
  pongDelayMs?: number;
}

export class MeasureServer {
  readonly mic = new Int16Array(CAPACITY);
  readonly sys = new Int16Array(CAPACITY);
  readonly messages: { at: number; message: BrowserToNode }[] = [];
  readonly frames: { audio_frame: number; at: number }[] = [];
  readonly violations: string[] = [];
  head = 0;
  connections = 0;
  private wss: WebSocketServer | null = null;
  private socket: WebSocket | null = null;
  private echoBegun = false;
  private echoSeq = 0;
  /** server_t_ms の原点（wall clock の ms）。 */
  readonly originMs = performance.timeOrigin + performance.now();

  constructor(private readonly options: MeasureOptions = {}) {}

  now(): number {
    return performance.timeOrigin + performance.now() - this.originMs;
  }

  async start(): Promise<number> {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    this.wss = wss;
    await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
    wss.on('connection', (socket) => {
      this.socket = socket;
      this.connections++;
      socket.on('message', (data, isBinary) => {
        if (isBinary) this.onBinary(data as Buffer);
        else this.onText(String(data));
      });
    });
    return (wss.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    const wss = this.wss;
    if (!wss) return;
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    this.wss = null;
  }

  dropConnection(): void {
    this.socket?.terminate();
  }

  send(message: NodeToBrowser): void {
    this.socket?.send(JSON.stringify(NodeToBrowser.parse(message)));
  }

  begin(id: number, generation: number, sample_rate_hz: number): void {
    this.send({ type: 'playback.begin', audio_playback_id: id, generation, sample_rate_hz });
  }

  /** 枠へ分けて一気に送る。 */
  pcm(
    id: number,
    generation: number,
    sample_rate_hz: number,
    pcm: Int16Array,
    options: { startSeq?: number; end?: boolean; chunk?: number } = {},
  ): number {
    const chunk = options.chunk ?? 480;
    let seq = options.startSeq ?? 0;
    for (let i = 0; i < pcm.length; i += chunk) {
      const part = pcm.subarray(i, Math.min(pcm.length, i + chunk));
      const last = i + chunk >= pcm.length;
      this.socket?.send(
        encodePcmFrame({
          audio_playback_id: id,
          generation,
          seq: seq++,
          sample_rate_hz,
          pcm: part,
          end_of_stream: last && options.end === true,
        }),
      );
    }
    return seq;
  }

  ofType<T extends BrowserToNode['type']>(type: T): Extract<BrowserToNode, { type: T }>[] {
    return this.messages
      .filter((m) => m.message.type === type)
      .map((m) => m.message as Extract<BrowserToNode, { type: T }>);
  }

  async waitFor(test: () => boolean, timeoutMs = 10_000, label = 'condition'): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!test()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  /** 番号の飛びを列挙する。 */
  gaps(): { from: number; to: number }[] {
    const out: { from: number; to: number }[] = [];
    let expected: number | null = null;
    for (const f of this.frames) {
      if (expected !== null && f.audio_frame !== expected) out.push({ from: expected, to: f.audio_frame });
      expected = f.audio_frame + 320;
    }
    return out;
  }

  private onBinary(data: Buffer): void {
    const frame = decodeAudioFrame(data);
    this.frames.push({ audio_frame: frame.audio_frame, at: this.now() });
    this.mic.set(frame.mic, frame.audio_frame);
    this.sys.set(frame.sys, frame.audio_frame);
    this.head = frame.audio_frame + frame.sample_count;
    if (this.options.echo) {
      if (!this.echoBegun) {
        this.begin(1, 0, 16000);
        this.echoBegun = true;
      }
      this.socket?.send(
        encodePcmFrame({
          audio_playback_id: 1,
          generation: 0,
          seq: this.echoSeq++,
          sample_rate_hz: 16000,
          pcm: frame.mic,
        }),
      );
    }
  }

  private onText(text: string): void {
    const parsed = BrowserToNode.safeParse(JSON.parse(text));
    if (!parsed.success) {
      this.violations.push(`${text.slice(0, 120)}: ${parsed.error.message}`);
      return;
    }
    const message = parsed.data;
    this.messages.push({ at: this.now(), message });
    if (message.type === 'client.hello') {
      this.send({
        type: 'server.hello',
        protocol_version: BROWSER_RPC_PROTOCOL_VERSION,
        session_id: 'measure_session',
        condition: 'reactive',
        is_fake: true,
      });
    } else if (message.type === 'clock.ping') {
      const serverT = this.now();
      const reply = () =>
        this.send({
          type: 'clock.pong',
          seq: message.seq,
          client_t_ms: message.client_t_ms,
          server_t_ms: serverT,
        });
      if (this.options.pongDelayMs) setTimeout(reply, this.options.pongDelayMs);
      else reply();
    }
  }
}
