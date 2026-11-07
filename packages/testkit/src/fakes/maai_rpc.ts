/**
 * MaAI ワーカーの偽物。Node↔Python の契約どおりに WS で話す。
 *
 * 返す p の値は試験が決めた台本で、音声から計算しない（VAD を VAP と呼ぶダミーにしない）。
 * model_variant は FAKE_MODEL_VARIANT、READY の is_fake は true なので、ログで本物と区別できる。
 * チャネルずれ、遅延時の同時破棄など、本物のワーカーの性質の試験は B が実物で行う。
 */
import {
  FAKE_MODEL_VARIANT,
  MAAI_RPC_PROTOCOL_VERSION,
  MaaiNodeToWorker,
  MaaiWorkerToNode,
  absent,
  decodeAudioFrame,
  present,
} from '@llm-vap/contracts';
import type { MaaiConfigure } from '@llm-vap/contracts';
import { WebSocket, WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';

export interface FakeVapValues {
  p_now: [number, number];
  p_future: [number, number];
  vad: [number, number];
}

export type FakeVapScript = (audio_frame: number) => FakeVapValues;

const NEUTRAL: FakeVapValues = { p_now: [0.5, 0.5], p_future: [0.5, 0.5], vad: [0, 0] };

export interface FakeMaaiOptions {
  port?: number;
  script?: FakeVapScript;
  /** VAP_STATE を返すまでの遅延（実時間）。 */
  response_delay_ms?: number;
}

export class FakeMaaiRpcServer {
  readonly configures: MaaiConfigure[] = [];
  readonly frames: { audio_frame: number; sample_count: number }[] = [];
  private wss: WebSocketServer | null = null;
  private socket: WebSocket | null = null;
  private config: MaaiConfigure | null = null;
  private nextExpected: number | null = null;
  private samplesSinceResult = 0;
  private stalled = false;
  private droppedNetwork = 0;
  private script: FakeVapScript;

  constructor(private readonly options: FakeMaaiOptions = {}) {
    this.script = options.script ?? (() => NEUTRAL);
  }

  async start(): Promise<number> {
    const wss = new WebSocketServer({ port: this.options.port ?? 0, host: '127.0.0.1' });
    this.wss = wss;
    await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
    wss.on('connection', (socket) => {
      this.socket = socket;
      socket.on('message', (data, isBinary) => {
        if (isBinary) this.onAudio(data as Buffer);
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

  setScript(script: FakeVapScript): void {
    this.script = script;
  }

  /** 障害の注入: VAP_STATE を止める（鮮度切れの再現）。接続は保つ。 */
  stall(): void {
    this.stalled = true;
  }

  resume(): void {
    this.stalled = false;
  }

  /** 障害の注入: ワーカーの異常終了（接続を切る）。 */
  crash(): void {
    this.socket?.terminate();
    this.socket = null;
    this.nextExpected = null;
    this.samplesSinceResult = 0;
  }

  /** 状態の報告を送る。 */
  sendStatus(status: 'loading' | 'ok' | 'degraded' | 'down', reason: string | null = null): void {
    this.send({
      type: 'WORKER_STATUS',
      status,
      reason: reason === null ? absent('no_reason') : present(reason),
      audio_frame: this.nextExpected ?? 0,
      frames_dropped_network: this.droppedNetwork,
      frames_dropped_overload: 0,
      queue_depth: 0,
      rtf: absent('fake_worker_does_not_measure'),
    });
  }

  private send(message: MaaiWorkerToNode): void {
    this.socket?.send(JSON.stringify(MaaiWorkerToNode.parse(message)));
  }

  private onText(text: string): void {
    const message = MaaiNodeToWorker.parse(JSON.parse(text));
    if (message.type === 'CONFIGURE') {
      this.configures.push(message);
      this.config = message;
      this.send({
        type: 'READY',
        protocol_version: MAAI_RPC_PROTOCOL_VERSION,
        maai_version: 'fake',
        checkpoint: FAKE_MODEL_VARIANT,
        lang: message.lang,
        model_type: message.model_type,
        channel_layout: message.channel_layout,
        frame_rate_hz: message.frame_rate_hz,
        device: 'cpu',
        is_fake: true,
      });
    } else if (message.type === 'PING') {
      this.send({ type: 'PONG', seq: message.seq, t_ms: message.t_ms, worker_t_ms: performance.now() });
    } else {
      this.socket?.close(1000, message.reason);
    }
  }

  private onAudio(data: Buffer): void {
    const frame = decodeAudioFrame(data);
    this.frames.push({ audio_frame: frame.audio_frame, sample_count: frame.sample_count });
    if (!this.config) {
      this.send({ type: 'ERROR', code: 'not_configured', message: 'audio before CONFIGURE', fatal: false });
      return;
    }
    if (this.nextExpected !== null && frame.audio_frame > this.nextExpected) {
      const gap = frame.audio_frame - this.nextExpected;
      this.droppedNetwork += gap;
      this.samplesSinceResult += gap;
      this.send({
        type: 'FRAMES_DROPPED',
        from_audio_frame: this.nextExpected,
        sample_count: gap,
        cause: 'network_gap',
        zero_filled: true,
        channels: 'both',
      });
    }
    this.nextExpected = frame.audio_frame + frame.sample_count;
    this.samplesSinceResult += frame.sample_count;

    const period = Math.round(this.config.sample_rate_hz / this.config.frame_rate_hz);
    while (this.samplesSinceResult >= period) {
      this.samplesSinceResult -= period;
      if (!this.stalled) this.scheduleResult(this.nextExpected - this.samplesSinceResult);
    }
  }

  private scheduleResult(audio_frame: number): void {
    const emit = () => {
      const config = this.config;
      if (!config) return;
      const values = this.script(audio_frame);
      const threshold = config.speaking_threshold;
      this.send({
        type: 'VAP_STATE',
        t: performance.now(),
        audio_frame,
        model_variant: FAKE_MODEL_VARIANT,
        inference_ms: 0,
        raw: { fake: true },
        channel_layout: '2ch',
        p_now: values.p_now,
        p_future: values.p_future,
        vad: values.vad,
        user_speaking: values.vad[0] >= threshold,
        system_speaking: values.vad[1] >= threshold,
      });
    };
    const delay = this.options.response_delay_ms ?? 0;
    if (delay > 0) setTimeout(emit, delay);
    else emit();
  }
}
