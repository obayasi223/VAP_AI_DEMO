/**
 * ストリーム内のサンプル位置と audio_frame の対応。
 * Google の offset は「そのストリームへ送った音声の先頭から」の値（切替の実測で確認）なので、ストリームごとに1つ持つ。
 * 送信に欠落があると単純な足し算ではずれるので、不連続点を記録する（provider_matrix §6.2 の 3）。
 */
const SAMPLES_PER_MS = 16;

export class FrameMap {
  private readonly points: { sample: number; frame: number }[] = [];
  private sentSamples = 0;
  /** 送信量を超える offset を受けた回数。基準が想定と違うときの検出に使う。 */
  anomalies = 0;

  get sent(): number {
    return this.sentSamples;
  }

  get sentMs(): number {
    return this.sentSamples / SAMPLES_PER_MS;
  }

  /** 次に送る音声の位置を記録する。 */
  record(frame: number, samples: number): void {
    const last = this.points.at(-1);
    if (!last || last.frame + (this.sentSamples - last.sample) !== frame) {
      this.points.push({ sample: this.sentSamples, frame });
    }
    this.sentSamples += samples;
  }

  /** 送った音声の次の audio_frame。何も送っていなければ null。 */
  get endFrame(): number | null {
    const last = this.points.at(-1);
    return last ? last.frame + (this.sentSamples - last.sample) : null;
  }

  get baseFrame(): number | null {
    return this.points[0]?.frame ?? null;
  }

  /** ストリーム先頭からの offset を audio_frame へ。 */
  frameAtOffsetMs(offsetMs: number): number | null {
    if (this.points.length === 0) return null;
    let sample = Math.round(offsetMs * SAMPLES_PER_MS);
    if (sample > this.sentSamples + 50 * SAMPLES_PER_MS) this.anomalies += 1;
    sample = Math.max(0, Math.min(sample, this.sentSamples));
    for (let i = this.points.length - 1; i >= 0; i--) {
      const point = this.points[i] as { sample: number; frame: number };
      if (point.sample <= sample) return point.frame + (sample - point.sample);
    }
    return null;
  }
}
