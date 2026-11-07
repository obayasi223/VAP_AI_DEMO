/**
 * Browser↔Node の偽物。実際の WS で契約どおりに話す。
 *  - FakeBrowserEchoServer: Node の代わり。A がブラウザ単体で確認するときに使う（mic を PCM で返す）。
 *  - FakeBrowserClient: ブラウザの代わり。J がブラウザなしで配線を確認するときに使う。
 * どちらも本番の検証には数えない。
 */
import {
  BROWSER_RPC_PROTOCOL_VERSION,
  BrowserToNode,
  DEFAULT_FRAME_SAMPLES,
  NodeToBrowser,
  SAMPLE_RATE_HZ,
  absent,
  decodeAudioFrame,
  decodePcmFrame,
  encodeAudioFrame,
  encodePcmFrame,
  isStaleGeneration,
  present,
} from '@llm-vap/contracts';
import type { PlaybackStopMode, TimeSource } from '@llm-vap/contracts';
import { SystemTimeSource } from '@llm-vap/contracts';
import { WebSocket, WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';

export interface FakeBrowserEchoOptions {
  port?: number;
  /** false なら mic を返さず、sendPcm だけで再生する。 */
  echo?: boolean;
  /** mic を何サンプル遅らせて返すか。 */
  echo_delay_samples?: number;
  time?: TimeSource;
}

export class FakeBrowserEchoServer {
  readonly received: BrowserToNode[] = [];
  readonly uplinkFrames: { audio_frame: number; sample_count: number }[] = [];
  private wss: WebSocketServer | null = null;
  private socket: WebSocket | null = null;
  private generation = 0;
  private playbackId = 0;
  private seq = 0;
  private begun = false;
  private delayLine: Int16Array[] = [];
  private delayed = 0;
  private readonly time: TimeSource;

  constructor(private readonly options: FakeBrowserEchoOptions = {}) {
    this.time = options.time ?? new SystemTimeSource();
  }

  async start(): Promise<number> {
    const wss = new WebSocketServer({ port: this.options.port ?? 0, host: '127.0.0.1' });
    this.wss = wss;
    await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
    wss.on('connection', (socket) => {
      this.socket = socket;
      this.nextPlayback();
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

  get currentGeneration(): number {
    return this.generation;
  }

  get currentPlaybackId(): number {
    return this.playbackId;
  }

  /** 再生中の音声を止める。世代を進めるので、以後の PCM は新しい再生になる。 */
  stopPlayback(stop: PlaybackStopMode, reason = 'test'): number {
    this.generation += 1;
    this.send({
      type: 'playback.stop',
      audio_playback_id: this.playbackId,
      generation: this.generation,
      stop,
      reason,
    });
    this.nextPlayback();
    return this.generation;
  }

  /** 明示的に PCM を送る。 */
  sendPcm(pcm: Int16Array, sample_rate_hz: number = SAMPLE_RATE_HZ, end_of_stream = false): void {
    if (!this.begun) {
      this.send({
        type: 'playback.begin',
        audio_playback_id: this.playbackId,
        generation: this.generation,
        sample_rate_hz,
      });
      this.begun = true;
    }
    this.socket?.send(
      encodePcmFrame({
        audio_playback_id: this.playbackId,
        generation: this.generation,
        seq: this.seq++,
        sample_rate_hz,
        pcm,
        end_of_stream,
      }),
    );
  }

  /** 試験から任意の JSON を送る。契約に合わなければ例外。 */
  send(message: NodeToBrowser): void {
    this.socket?.send(JSON.stringify(NodeToBrowser.parse(message)));
  }

  private nextPlayback(): void {
    this.playbackId += 1;
    this.seq = 0;
    this.begun = false;
  }

  private onBinary(data: Buffer): void {
    const frame = decodeAudioFrame(data);
    this.uplinkFrames.push({ audio_frame: frame.audio_frame, sample_count: frame.sample_count });
    if (this.options.echo === false) return;
    const delay = this.options.echo_delay_samples ?? 0;
    this.delayLine.push(frame.mic);
    this.delayed += frame.mic.length;
    while (this.delayLine.length > 0 && this.delayed - (this.delayLine[0] as Int16Array).length >= delay) {
      const head = this.delayLine.shift() as Int16Array;
      this.delayed -= head.length;
      this.sendPcm(head);
    }
  }

  private onText(text: string): void {
    const message = BrowserToNode.parse(JSON.parse(text));
    this.received.push(message);
    if (message.type === 'client.hello') {
      this.send({
        type: 'server.hello',
        protocol_version: BROWSER_RPC_PROTOCOL_VERSION,
        session_id: 'fake_session',
        condition: 'reactive',
        is_fake: true,
      });
    } else if (message.type === 'clock.ping') {
      this.send({
        type: 'clock.pong',
        seq: message.seq,
        client_t_ms: message.client_t_ms,
        server_t_ms: this.time.monotonicMs(),
      });
    }
  }
}

export interface FakeClientEvents {
  json: NodeToBrowser[];
  pcm: { audio_playback_id: number; generation: number; seq: number; samples: number[] }[];
  staleDropped: number;
}

/** ブラウザの代わり。世代の規則を契約どおりに実装する。再生は実時間でなく記録するだけ。 */
export class FakeBrowserClient {
  readonly events: FakeClientEvents = { json: [], pcm: [], staleDropped: 0 };
  private socket: WebSocket | null = null;
  private generation = 0;
  private audioFrame = 0;
  private waiters: { test: () => boolean; resolve: () => void }[] = [];

  constructor(private readonly url: string) {}

  async connect(): Promise<void> {
    const socket = new WebSocket(this.url);
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        const frame = decodePcmFrame(data as Buffer);
        if (isStaleGeneration(frame.generation, this.generation)) {
          this.events.staleDropped += 1;
        } else {
          this.events.pcm.push({
            audio_playback_id: frame.audio_playback_id,
            generation: frame.generation,
            seq: frame.seq,
            samples: Array.from(frame.pcm),
          });
        }
      } else {
        const message = NodeToBrowser.parse(JSON.parse(String(data)));
        this.events.json.push(message);
        if (message.type === 'playback.stop') this.generation = message.generation;
      }
      this.settle();
    });
    this.sendJson({
      type: 'client.hello',
      protocol_version: BROWSER_RPC_PROTOCOL_VERSION,
      session_id: absent('new_session'),
      audio_context_sample_rate_hz: 48000,
      frame_samples: DEFAULT_FRAME_SAMPLES,
      track_settings: {
        echoCancellation: present(false),
        noiseSuppression: present(false),
        autoGainControl: present(false),
        sampleRate: present(48000),
        channelCount: present(1),
        deviceId: absent('fake_client'),
      },
      latency: {
        base_latency_ms: absent('fake_client'),
        output_latency_ms: absent('fake_client'),
        output_timestamp_context_ms: absent('fake_client'),
        output_timestamp_performance_ms: absent('fake_client'),
      },
      user_agent: 'FakeBrowserClient',
    });
  }

  sendJson(message: BrowserToNode): void {
    this.socket?.send(JSON.stringify(BrowserToNode.parse(message)));
  }

  /** 次の audio_frame 番号で上り枠を送り、その番号を返す。 */
  sendAudio(mic: Int16Array, sys: Int16Array = new Int16Array(mic.length)): number {
    const audio_frame = this.audioFrame;
    this.socket?.send(encodeAudioFrame({ audio_frame, mic, sys }));
    this.audioFrame += mic.length;
    return audio_frame;
  }

  /** 欠損の再現用。次に送る番号を飛ばす。 */
  skipFrames(samples: number): void {
    this.audioFrame += samples;
  }

  waitFor(test: () => boolean, timeoutMs = 3000): Promise<void> {
    if (test()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('FakeBrowserClient.waitFor timed out')), timeoutMs);
      this.waiters.push({
        test,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
      });
    });
  }

  async close(): Promise<void> {
    this.socket?.close();
    this.socket = null;
  }

  private settle(): void {
    this.waiters = this.waiters.filter((w) => {
      if (!w.test()) return true;
      w.resolve();
      return false;
    });
  }
}
