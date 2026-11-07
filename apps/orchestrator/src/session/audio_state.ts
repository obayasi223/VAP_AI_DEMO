/**
 * 上りの音声枠から Node が求める値（レーン J）。
 *  - fallback_energy: mic の RMS（dBFS）。VAP の鮮度切れのときだけ TurnManager が使う。VAP ではない。
 *  - system チャネルの無音: 書き込み済みの AI 音声（sys）の RMS から。視線の「発話中のポーズ」の判定に使う。
 * 時間はどちらも audio_frame（16kHz サンプルの番号）で数え、到着の揺れに影響されない。
 */
import { SAMPLE_RATE_HZ } from '@llm-vap/contracts';
import type { PlaybackInput } from '@llm-vap/contracts';

/** sys がこれ以上なら AI の声が出ている。【暫定】書き込み済みのデジタル値なので、無音はほぼ 0（-inf dB）。 */
export const SYS_VOICED_DBFS = -50;

export function rmsDbfs(samples: Int16Array): number {
  if (samples.length === 0) return -Infinity;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const v = (samples[i] as number) / 32768;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / samples.length);
  return rms <= 0 ? -Infinity : 20 * Math.log10(rms);
}

/** 契約の数値は有限でなければならないので、無音は下限で止める。 */
export const FALLBACK_ENERGY_FLOOR_DBFS = -120;

interface Playing {
  audio_playback_id: number;
  generation: number;
  started_frame: number | null;
  samples_written: number;
  /** ブラウザの最新の報告（position、started）を受けた orchestrator 時刻。切断時の代行に使う。 */
  last_report_at: number | null;
}

/**
 * 再生の状況（TurnInputs.playback）。playback.started から playback.ended まで playing。
 * begin を送っただけ（最初の書き込み前）は idle のまま。E1 は start_speech 後 1000ms を「話し始め」として持つ。
 */
export class PlaybackTracker {
  private playing: Playing | null = null;
  private headFrame = 0;
  private lastSysVoicedEnd: number | null = null;

  /** 上りの枠ごと。frameEnd は枠の終わりの audio_frame。 */
  observeFrame(frameEnd: number, sysDbfs: number): void {
    this.headFrame = Math.max(this.headFrame, frameEnd);
    if (sysDbfs >= SYS_VOICED_DBFS) this.lastSysVoicedEnd = frameEnd;
  }

  started(id: number, generation: number, audio_frame: number, at: number): void {
    this.playing = {
      audio_playback_id: id,
      generation,
      started_frame: audio_frame,
      samples_written: 0,
      last_report_at: at,
    };
  }

  position(id: number, samples_written: number, at: number): void {
    if (this.playing?.audio_playback_id !== id) return;
    this.playing.samples_written = Math.max(this.playing.samples_written, samples_written);
    this.playing.last_report_at = at;
  }

  ended(id: number): void {
    if (this.playing?.audio_playback_id === id) this.playing = null;
  }

  current(): Readonly<Playing> | null {
    return this.playing;
  }

  input(): PlaybackInput {
    const p = this.playing;
    if (p === null) return { state: 'idle' };
    const since = Math.max(this.lastSysVoicedEnd ?? 0, p.started_frame ?? 0);
    const silentSamples = Math.max(0, this.headFrame - since);
    return {
      state: 'playing',
      audio_playback_id: p.audio_playback_id,
      samples_written: p.samples_written,
      system_silence_ms: (silentSamples / SAMPLE_RATE_HZ) * 1000,
    };
  }
}
