/**
 * 上りの音声の分解（session.ts の handleBinary から切り出し。docs/design/two_ai/06 §11、01 §1.3。WP1a）。
 * 1 対 1 と 2 体で同じ順に処理する：decode → 数え → 受信の位置 → mic の dBFS → sys の観測 → 音声の保存 → STT → MaAI。
 */
import { decodeAudioFrame } from '@llm-vap/contracts';
import type { SttSession, TimeSource } from '@llm-vap/contracts';
import type { SessionAudioRecorder } from '../../logging';
import { FALLBACK_ENERGY_FLOOR_DBFS, rmsDbfs } from '../audio_state';
import type { PlaybackTracker } from '../audio_state';

export interface UplinkCounters {
  uplink_frames: number;
  bad_uplink_frames: number;
}

/** MaAI へ送る口（準備ができていなければ呼び手が null を渡す）。 */
export interface MaaiSender {
  sendEncodedAudio(data: Uint8Array, sample_count: number): unknown;
}

export class UplinkAudio {
  private received = 0;
  private micDbfs: number | null = null;

  constructor(private readonly deps: { counters: UplinkCounters; tracker: PlaybackTracker; time: TimeSource }) {}

  /** 枠を処理する。壊れた枠は数えて捨てる。 */
  handle(data: Uint8Array, sinks: { recorder: SessionAudioRecorder | null; stt: SttSession | null; maai: MaaiSender | null }): void {
    let frame: ReturnType<typeof decodeAudioFrame>;
    try {
      frame = decodeAudioFrame(data);
    } catch {
      this.deps.counters.bad_uplink_frames += 1;
      return;
    }
    this.deps.counters.uplink_frames += 1;
    const end = frame.audio_frame + frame.sample_count;
    this.received = Math.max(this.received, end);
    this.micDbfs = Math.max(FALLBACK_ENERGY_FLOOR_DBFS, rmsDbfs(frame.mic));
    this.deps.tracker.observeFrame(end, rmsDbfs(frame.sys));
    sinks.recorder?.push(frame.audio_frame, frame.mic, frame.sys, this.deps.time.monotonicMs());
    sinks.stt?.pushAudio(frame.audio_frame, frame.mic);
    sinks.maai?.sendEncodedAudio(data, frame.sample_count);
  }

  get receivedAudioFrame(): number {
    return this.received;
  }

  get lastMicDbfs(): number | null {
    return this.micDbfs;
  }
}
