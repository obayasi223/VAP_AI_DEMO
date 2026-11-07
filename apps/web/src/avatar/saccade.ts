/**
 * 相手を見ている間の小さな視線移動（相手の右目・左目・口元のあいだを移る固視の切り替え）。
 * 本来のマイクロサッカード（1 度未満）はこのモデルの眼の範囲（入力 90 度で外 12 度）では見えないので、
 * 見える大きさの「固視の切り替え」として作る。間隔は対数正規で揺らし、固定周期にしない。値は未評価。
 *
 * 角度は vrm.lookAt の入力（度）。眼の回転はモデルの range map で縮む（Sendagaya_Shino は約 1/7〜1/11）。
 * 向きの規約は gaze.ts と同じ: yaw の正がモデルの左（画面の右）、pitch の正が下。
 */
import type { AvatarLayer, LayerContext, PoseFrame } from './pose';
import { clamp, gaussian, smoothstep, type Rng } from './util';

export interface SaccadeOptions {
  medianIntervalMs: number;
  /** 対数の標準偏差。 */
  sigma: number;
  minIntervalMs: number;
  maxIntervalMs: number;
  /** 相手の両目の間の半分（左右に振る量）。 */
  eyeSpreadYawDeg: number;
  /** 口元を見るときの下向き。 */
  mouthPitchDeg: number;
  /** 各注視点のまわりの揺らぎ（標準偏差）。 */
  jitterDeg: number;
  /** 注視点を選ぶ重み（右目、左目、口元）。 */
  weights: { rightEye: number; leftEye: number; mouth: number };
  /** 1 回の移動の時間。サッカードは 20〜50ms。 */
  moveMs: number;
}

export const DEFAULT_SACCADE: SaccadeOptions = {
  medianIntervalMs: 1300,
  sigma: 0.55,
  minIntervalMs: 280,
  maxIntervalMs: 5000,
  eyeSpreadYawDeg: 6,
  mouthPitchDeg: 9,
  jitterDeg: 1.2,
  weights: { rightEye: 0.42, leftEye: 0.42, mouth: 0.16 },
  moveMs: 40,
};

export function nextSaccadeIntervalMs(rng: Rng, options: SaccadeOptions = DEFAULT_SACCADE): number {
  return clamp(options.medianIntervalMs * Math.exp(options.sigma * gaussian(rng)), options.minIntervalMs, options.maxIntervalMs);
}

export type FixationPoint = 'rightEye' | 'leftEye' | 'mouth';

export interface EyeAngles {
  yawDeg: number;
  pitchDeg: number;
}

/** 次の注視点。同じ点を続けて選ぶこともある（揺らぎで少しだけ動く）。 */
export function nextFixation(rng: Rng, options: SaccadeOptions = DEFAULT_SACCADE): { point: FixationPoint; angles: EyeAngles } {
  const { weights } = options;
  const total = weights.rightEye + weights.leftEye + weights.mouth;
  const r = rng() * total;
  const point: FixationPoint = r < weights.rightEye ? 'rightEye' : r < weights.rightEye + weights.leftEye ? 'leftEye' : 'mouth';
  // 相手の右目はこちらから見て左（モデルの右、yaw 負）。
  const base: EyeAngles =
    point === 'rightEye'
      ? { yawDeg: -options.eyeSpreadYawDeg, pitchDeg: 0 }
      : point === 'leftEye'
        ? { yawDeg: options.eyeSpreadYawDeg, pitchDeg: 0 }
        : { yawDeg: 0, pitchDeg: options.mouthPitchDeg };
  return {
    point,
    angles: {
      yawDeg: base.yawDeg + gaussian(rng) * options.jitterDeg,
      pitchDeg: base.pitchDeg + gaussian(rng) * options.jitterDeg,
    },
  };
}

export class SaccadeGenerator {
  private readonly options: SaccadeOptions;
  private waitMs: number;
  private from: EyeAngles = { yawDeg: 0, pitchDeg: 0 };
  private to: EyeAngles = { yawDeg: 0, pitchDeg: 0 };
  private moveElapsedMs = Number.POSITIVE_INFINITY;
  enabled = true;
  /** 始めた移動の累計。 */
  count = 0;
  current: EyeAngles = { yawDeg: 0, pitchDeg: 0 };
  point: FixationPoint | null = null;

  constructor(
    private readonly rng: Rng,
    options: Partial<SaccadeOptions> = {},
  ) {
    this.options = { ...DEFAULT_SACCADE, ...options };
    this.waitMs = nextSaccadeIntervalMs(rng, this.options);
  }

  /** 今の移動の大きさ（度）。移動を始めたフレームだけ正。 */
  update(dtMs: number): { angles: EyeAngles; startedDeg: number } {
    let startedDeg = 0;
    this.waitMs -= dtMs;
    if (this.waitMs <= 0) {
      this.waitMs = nextSaccadeIntervalMs(this.rng, this.options);
      if (this.enabled) {
        const next = nextFixation(this.rng, this.options);
        this.from = { ...this.current };
        this.to = next.angles;
        this.point = next.point;
        this.moveElapsedMs = 0;
        this.count += 1;
        startedDeg = Math.hypot(this.to.yawDeg - this.from.yawDeg, this.to.pitchDeg - this.from.pitchDeg);
      } else {
        this.from = { ...this.current };
        this.to = { yawDeg: 0, pitchDeg: 0 };
        this.point = null;
        this.moveElapsedMs = 0;
      }
    }
    if (this.moveElapsedMs < Number.POSITIVE_INFINITY) {
      this.moveElapsedMs += dtMs;
      const t = smoothstep(this.moveElapsedMs / Math.max(this.options.moveMs, 1));
      this.current = {
        yawDeg: this.from.yawDeg + (this.to.yawDeg - this.from.yawDeg) * t,
        pitchDeg: this.from.pitchDeg + (this.to.pitchDeg - this.from.pitchDeg) * t,
      };
      if (t >= 1) this.moveElapsedMs = Number.POSITIVE_INFINITY;
    }
    return { angles: this.current, startedDeg };
  }
}

/**
 * 視線の層の後に置く。相手を見ている割合（frame.eye.userWeight）だけ効かせ、そらしている間は止める。
 * 移動を始めたら onShift（瞬きとの連動）を呼ぶ。
 */
export class SaccadeLayer implements AvatarLayer {
  readonly name = 'saccade';

  constructor(
    readonly generator: SaccadeGenerator,
    private readonly onShift: (amplitudeDeg: number) => void = () => {},
  ) {}

  update(context: LayerContext, frame: PoseFrame): void {
    const { angles, startedDeg } = this.generator.update(context.dtMs);
    const weight = frame.eye.userWeight;
    if (startedDeg > 0 && weight > 0.5) this.onShift(startedDeg);
    frame.eye.yawDeg += angles.yawDeg * weight;
    frame.eye.pitchDeg += angles.pitchDeg * weight;
  }
}
