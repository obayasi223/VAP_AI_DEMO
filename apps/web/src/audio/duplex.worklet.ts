/**
 * AudioWorklet 本体（計画 §3.2）。1つの Worklet でマイク入力と再生出力を同じレンダー量子で処理する。
 * 主スレッドを経由せず、MessagePort で Worker と直接話す。
 * ビルド: `npm run build:audio -w @llm-vap/web` → public/worklets/duplex.worklet.js
 */
import { DuplexCapture } from './dsp/capture';
import { PlaybackScheduler, type SchedulerEvent } from './dsp/playback_scheduler';
import { designResampler } from './dsp/resampler';
import type { FromWorklet, ToWorklet } from './protocol';

declare const sampleRate: number;
declare const currentFrame: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}

export interface DuplexProcessorOptions {
  frameSamples: number;
  prebufferMs: number;
}

const AUDIO_FRAME_RATE = 16000;

class DuplexProcessor extends AudioWorkletProcessor {
  private link: MessagePort | null = null;
  private readonly capture: DuplexCapture;
  private readonly scheduler: PlaybackScheduler;
  private captureStartFrame: number | null = null;
  private silence = new Float32Array(128);

  constructor(options: { processorOptions: DuplexProcessorOptions }) {
    super();
    const { frameSamples, prebufferMs } = options.processorOptions;
    this.capture = new DuplexCapture(designResampler(sampleRate, AUDIO_FRAME_RATE), frameSamples);
    this.scheduler = new PlaybackScheduler({
      contextRate: sampleRate,
      prebufferFrames: Math.round((prebufferMs * sampleRate) / 1000),
      onEvent: (event) => this.forward(event),
    });
    this.port.onmessage = (event: MessageEvent) => {
      const port = event.ports[0];
      if (!port) return;
      this.link = port;
      port.onmessage = (e: MessageEvent<ToWorklet>) => this.onCommand(e.data);
    };
  }

  private audioFrameAt(renderFrame: number): number {
    if (this.captureStartFrame === null) return 0;
    const value = ((renderFrame - this.captureStartFrame) * AUDIO_FRAME_RATE) / sampleRate;
    return Math.max(0, Math.round(value));
  }

  private onCommand(message: ToWorklet): void {
    switch (message.t) {
      case 'capture_start':
        if (this.captureStartFrame === null) this.captureStartFrame = currentFrame;
        break;
      case 'begin':
        this.scheduler.begin(message.id, message.gen);
        break;
      case 'pcm':
        this.scheduler.pcm(message.id, message.gen, message.frames, message.eos);
        break;
      case 'stop':
        this.scheduler.stop(message.id, message.gen, message.stop);
        break;
      case 'input_lost':
        this.scheduler.inputLost();
        break;
      case 'reset':
        this.scheduler.reset();
        break;
    }
  }

  private post(message: FromWorklet, transfer: Transferable[] = []): void {
    this.link?.postMessage(message, transfer);
  }

  private forward(event: SchedulerEvent): void {
    if (event.kind === 'started') {
      this.post({
        t: 'started',
        id: event.id,
        gen: event.gen,
        render_frame: event.renderFrame,
        audio_frame: this.audioFrameAt(event.renderFrame),
      });
    } else {
      this.post({
        t: 'ended',
        id: event.id,
        gen: event.gen,
        reason: event.reason,
        written: event.writtenFrames,
        discarded: event.discardedFrames,
        render_frame: event.renderFrame,
        audio_frame: this.audioFrameAt(event.renderFrame),
      });
    }
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0]?.[0];
    if (!out) return true;
    const n = out.length;
    const frameNow = currentFrame;
    this.scheduler.render(out, n, frameNow);
    if (this.captureStartFrame !== null) {
      let mic = inputs[0]?.[0];
      if (!mic) {
        if (this.silence.length < n) this.silence = new Float32Array(n);
        mic = this.silence;
      }
      this.capture.push(mic, out, n, (audioFrame, micFrame, sysFrame) => {
        const position = this.scheduler.position();
        const renderEnd = frameNow + n;
        this.post(
          {
            t: 'frame',
            audio_frame: audioFrame,
            mic: micFrame,
            sys: sysFrame,
            render_frame: renderEnd,
            head_audio_frame: this.audioFrameAt(renderEnd),
            pos_id: position === null ? 0 : position.id,
            pos_gen: position === null ? 0 : position.gen,
            pos_written: position === null ? 0 : position.writtenFrames,
            pos_buffered: position === null ? 0 : position.bufferedFrames,
            underrun_count: this.scheduler.underrunCount,
            underrun_frames: this.scheduler.underrunFrames,
            stale_chunks: this.scheduler.staleChunks,
            orphan_chunks: this.scheduler.orphanChunks,
          },
          [micFrame.buffer, sysFrame.buffer],
        );
      });
    }
    return true;
  }
}

registerProcessor('duplex-audio-processor', DuplexProcessor);
