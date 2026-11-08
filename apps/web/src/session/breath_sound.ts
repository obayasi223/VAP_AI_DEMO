/**
 * 準備吸気に重ねるごく小さな息の音（暫定）。声ではなく、帯域を絞ったノイズを吸気の長さに合わせて鳴らす。
 *
 * 出力はスピーカーへ直接つなぐ。AI の再生音（outputNode）には混ぜないので、口の動き、VAP に渡す AI 側の音声、
 * 保存する session_audio.wav の AI のチャネルには入らない。
 * 音量は聞いて決めた値ではなく未校正（?breath_sound= で変えられる、0 で無音）。
 */

/** ノイズの振幅の頂点（0〜1）。AI の声より十分小さくなるよう置いた暫定値。 */
export const DEFAULT_BREATH_SOUND_GAIN = 0.025;
const MAX_BREATH_SOUND_GAIN = 0.1;

const BAND_START_HZ = 1800;
const BAND_END_HZ = 2800;
const BAND_Q = 0.7;
const STOP_TIME_CONSTANT_S = 0.02;
const STOP_TAIL_S = 0.1;

/** `?breath_sound=` の値。未指定と不正な値は既定、0 は無音、上限で切る。 */
export function parseBreathSoundGain(raw: string | null | undefined): number {
  if (raw === null || raw === undefined || raw.trim() === '') return DEFAULT_BREATH_SOUND_GAIN;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return DEFAULT_BREATH_SOUND_GAIN;
  return Math.min(value, MAX_BREATH_SOUND_GAIN);
}

interface Playing {
  source: AudioBufferSourceNode;
  gain: GainNode;
}

export class BreathSound {
  private playing: Playing | null = null;

  constructor(
    private readonly context: AudioContext,
    private readonly peakGain: number,
  ) {}

  /** 吸気の長さに合わせて1回鳴らす。鳴っている音があれば止めてから鳴らす。 */
  play(durationMs: number): void {
    this.stop();
    if (this.peakGain <= 0 || durationMs <= 0) return;
    const { context } = this;
    const seconds = durationMs / 1000;
    const buffer = context.createBuffer(1, Math.ceil(context.sampleRate * seconds), context.sampleRate);
    const samples = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i += 1) samples[i] = Math.random() * 2 - 1;

    const source = context.createBufferSource();
    source.buffer = buffer;
    const band = context.createBiquadFilter();
    band.type = 'bandpass';
    band.Q.value = BAND_Q;
    const gain = context.createGain();
    source.connect(band);
    band.connect(gain);
    gain.connect(context.destination);

    const start = context.currentTime;
    const end = start + seconds;
    band.frequency.setValueAtTime(BAND_START_HZ, start);
    band.frequency.linearRampToValueAtTime(BAND_END_HZ, end);
    // 吸い始めは静かに立ち上がり、後半で最も強く、終わりは息を止めるので短く消える。
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(this.peakGain * 0.7, start + seconds * 0.35);
    gain.gain.linearRampToValueAtTime(this.peakGain, start + seconds * 0.8);
    gain.gain.linearRampToValueAtTime(0, end);

    const playing: Playing = { source, gain };
    source.onended = () => {
      gain.disconnect();
      if (this.playing === playing) this.playing = null;
    };
    source.start(start);
    source.stop(end);
    this.playing = playing;
  }

  /** 途中で撤回されたときなど。音を切らず短く消す。 */
  stop(): void {
    const playing = this.playing;
    if (playing === null) return;
    this.playing = null;
    const now = this.context.currentTime;
    playing.gain.gain.cancelScheduledValues(now);
    playing.gain.gain.setValueAtTime(playing.gain.gain.value, now);
    playing.gain.gain.setTargetAtTime(0, now, STOP_TIME_CONSTANT_S);
    playing.source.stop(now + STOP_TAIL_S);
  }
}
