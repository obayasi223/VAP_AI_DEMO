/**
 * 待機の微小な揺れ。滑らかな乱数で頭と体幹を少しだけ動かす。
 * 吸気と紛らわしい動き（肩、鎖骨、胸の前後）は書かない（計画 §4.7）。試験で確認している。
 * 通常呼吸はここに入れない（H2）。
 */
import type { AvatarLayer, LayerContext, PoseFrame } from './pose';
import { DEG2RAD, SmoothDamp, smoothstep, type Rng } from './util';

/** 節の間隔を毎回変える滑らかな乱数。周期を持たない。値は -1〜1。 */
export class SmoothNoise {
  private from: number;
  private to: number;
  private spanMs: number;
  private elapsedMs = 0;

  constructor(
    private readonly rng: Rng,
    private readonly meanSpanMs: number,
  ) {
    this.from = rng() * 2 - 1;
    this.to = rng() * 2 - 1;
    this.spanMs = this.nextSpan();
  }

  private nextSpan(): number {
    return this.meanSpanMs * (0.55 + this.rng() * 0.9);
  }

  update(dtMs: number): number {
    this.elapsedMs += dtMs;
    while (this.elapsedMs >= this.spanMs) {
      this.elapsedMs -= this.spanMs;
      this.from = this.to;
      this.to = this.rng() * 2 - 1;
      this.spanMs = this.nextSpan();
    }
    return this.from + (this.to - this.from) * smoothstep(this.elapsedMs / this.spanMs);
  }
}

export interface IdleAmplitudes {
  headYawDeg: number;
  headPitchDeg: number;
  headRollDeg: number;
  spineYawDeg: number;
  spineRollDeg: number;
}

export const DEFAULT_IDLE: IdleAmplitudes = {
  headYawDeg: 1.8,
  headPitchDeg: 1.1,
  headRollDeg: 1.0,
  spineYawDeg: 0.7,
  spineRollDeg: 0.5,
};

/** 頭と体幹だけを書く。IDLE_BONES の外へ書かないことを試験で確認している。 */
export const IDLE_BONES = ['head', 'spine'] as const;

export class IdleLayer implements AvatarLayer {
  readonly name = 'idle';
  /** 0〜1。H2 で吸気の前後に下げる。 */
  intensity = 1;
  private readonly smoothedIntensity = new SmoothDamp(1);
  private readonly slow: SmoothNoise[];
  private readonly fast: SmoothNoise[];
  private readonly posture: SmoothNoise[];

  constructor(
    rng: Rng,
    private readonly amplitudes: IdleAmplitudes = DEFAULT_IDLE,
  ) {
    const make = (n: number, span: number) => Array.from({ length: n }, () => new SmoothNoise(rng, span));
    this.slow = make(3, 3400);
    this.fast = make(3, 1150);
    // 姿勢の入れ替え。遅く動いて体幹まで届く。
    this.posture = make(2, 9000);
  }

  update(context: LayerContext, frame: PoseFrame): void {
    const { dtMs } = context;
    const scale = this.smoothedIntensity.update(this.intensity, 400, dtMs);
    const head = (i: number) => (this.slow[i]?.update(dtMs) ?? 0) * 0.72 + (this.fast[i]?.update(dtMs) ?? 0) * 0.28;
    const a = this.amplitudes;
    const postureYaw = this.posture[0]?.update(dtMs) ?? 0;
    const postureRoll = this.posture[1]?.update(dtMs) ?? 0;
    frame.addBone(
      'head',
      head(0) * a.headPitchDeg * DEG2RAD * scale,
      (head(1) * 0.6 + postureYaw * 0.4) * a.headYawDeg * DEG2RAD * scale,
      (head(2) * 0.6 + postureRoll * 0.4) * a.headRollDeg * DEG2RAD * scale,
    );
    frame.addBone('spine', 0, postureYaw * a.spineYawDeg * DEG2RAD * scale, postureRoll * a.spineRollDeg * DEG2RAD * scale);
  }
}

/** T ポーズから腕を下ろす固定の層。 */
export class RestPoseLayer implements AvatarLayer {
  readonly name = 'rest';

  update(_context: LayerContext, frame: PoseFrame): void {
    frame.addBone('leftUpperArm', 0, 0, -72 * DEG2RAD);
    frame.addBone('rightUpperArm', 0, 0, 72 * DEG2RAD);
    frame.addBone('leftLowerArm', 0, -8 * DEG2RAD, 0);
    frame.addBone('rightLowerArm', 0, 8 * DEG2RAD, 0);
  }
}
