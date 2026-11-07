/**
 * mic と sys を同じ FIR で 16kHz へ変換し、audio_frame つきの枠に切る（計画 §3.2）。依存なし。
 * 両チャネルは同じ ResamplerDesign を共有し、常に同じ数の入力を受ける。
 */
import { PolyphaseResampler, type ResamplerDesign } from './resampler';

export type CaptureFrameHandler = (audioFrame: number, mic: Int16Array, sys: Int16Array) => void;

/** Float32 を Int16 へ。契約の int16ToFloat32（/32768）の逆。 */
export function floatToInt16(x: number): number {
  const v = Math.round(x * 32768);
  if (v > 32767) return 32767;
  if (v < -32768) return -32768;
  return v;
}

export class DuplexCapture {
  private readonly micResampler: PolyphaseResampler;
  private readonly sysResampler: PolyphaseResampler;
  private micOut: Float32Array;
  private sysOut: Float32Array;
  private micFrame: Int16Array;
  private sysFrame: Int16Array;
  private fill = 0;
  private nextAudioFrame = 0;

  constructor(
    design: ResamplerDesign,
    private readonly frameSamples: number,
  ) {
    this.micResampler = new PolyphaseResampler(design);
    this.sysResampler = new PolyphaseResampler(design);
    const capacity = this.micResampler.maxOutput(1024);
    this.micOut = new Float32Array(capacity);
    this.sysOut = new Float32Array(capacity);
    this.micFrame = new Int16Array(frameSamples);
    this.sysFrame = new Int16Array(frameSamples);
  }

  /** 同じレンダー量子の mic と、出力へ書いたサンプル（sys）を渡す。 */
  push(mic: Float32Array, sys: Float32Array, length: number, onFrame: CaptureFrameHandler): void {
    if (this.micResampler.maxOutput(length) > this.micOut.length) {
      this.micOut = new Float32Array(this.micResampler.maxOutput(length));
      this.sysOut = new Float32Array(this.micResampler.maxOutput(length));
    }
    const count = this.micResampler.process(mic, 0, length, this.micOut, 0);
    const sysCount = this.sysResampler.process(sys, 0, length, this.sysOut, 0);
    if (count !== sysCount) throw new Error(`channel skew in resampler: ${count} != ${sysCount}`);
    for (let i = 0; i < count; i++) {
      this.micFrame[this.fill] = floatToInt16(this.micOut[i] as number);
      this.sysFrame[this.fill] = floatToInt16(this.sysOut[i] as number);
      this.fill++;
      if (this.fill === this.frameSamples) {
        onFrame(this.nextAudioFrame, this.micFrame, this.sysFrame);
        this.nextAudioFrame += this.frameSamples;
        this.fill = 0;
        // 渡した配列は転送されるので作り直す。
        this.micFrame = new Int16Array(this.frameSamples);
        this.sysFrame = new Int16Array(this.frameSamples);
      }
    }
  }
}
