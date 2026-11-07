/**
 * 瞬き。間隔は対数正規で揺らし、ときどき連続させる。固定周期に見えないことが目的で、値は未評価。
 * 話している間は間隔を短くする（会話中、話し手の瞬きは聞き手より多い傾向）。
 * 大きな視線移動に伴う瞬き（gaze-evoked blink）は onGazeShift で確率的に起こす。
 */
import type { AvatarLayer, LayerContext, PoseFrame } from './pose';
import { clamp, gaussian, smoothstep, type Rng } from './util';

export interface BlinkOptions {
  medianIntervalMs: number;
  /** 対数の標準偏差。 */
  sigma: number;
  minIntervalMs: number;
  maxIntervalMs: number;
  closeMs: number;
  holdMs: number;
  openMs: number;
  doubleProbability: number;
  doubleGapMs: number;
  /** 話している間の間隔の倍率。 */
  speakingIntervalScale: number;
  /** 視線移動の大きさ（vrm.lookAt の入力の度）→ 瞬きの確率。この大きさ以下は 0、full で maxGazeBlinkProbability。 */
  gazeBlinkMinDeg: number;
  gazeBlinkFullDeg: number;
  maxGazeBlinkProbability: number;
  /** 直前の瞬きからこの間は視線移動でも瞬かない。 */
  gazeBlinkRefractoryMs: number;
}

export const DEFAULT_BLINK: BlinkOptions = {
  medianIntervalMs: 3200,
  sigma: 0.55,
  minIntervalMs: 800,
  maxIntervalMs: 9000,
  closeMs: 60,
  holdMs: 30,
  openMs: 130,
  doubleProbability: 0.12,
  doubleGapMs: 110,
  speakingIntervalScale: 0.75,
  gazeBlinkMinDeg: 15,
  gazeBlinkFullDeg: 50,
  maxGazeBlinkProbability: 0.6,
  gazeBlinkRefractoryMs: 700,
};

/** 視線移動の大きさ（lookAt の入力の度）→ 瞬きの確率。 */
export function gazeBlinkProbability(amplitudeDeg: number, options: BlinkOptions = DEFAULT_BLINK): number {
  const span = options.gazeBlinkFullDeg - options.gazeBlinkMinDeg;
  if (!(amplitudeDeg > options.gazeBlinkMinDeg)) return 0;
  return options.maxGazeBlinkProbability * clamp((amplitudeDeg - options.gazeBlinkMinDeg) / Math.max(span, 1e-6), 0, 1);
}

export function nextBlinkIntervalMs(rng: Rng, options: BlinkOptions = DEFAULT_BLINK): number {
  const value = options.medianIntervalMs * Math.exp(options.sigma * gaussian(rng));
  return clamp(value, options.minIntervalMs, options.maxIntervalMs);
}

export function blinkDurationMs(options: BlinkOptions = DEFAULT_BLINK): number {
  return options.closeMs + options.holdMs + options.openMs;
}

/** 瞬きの開始からの経過 → まぶたの閉じ（0〜1）。閉じは速く、開きは遅い。 */
export function blinkWeight(elapsedMs: number, options: BlinkOptions = DEFAULT_BLINK): number {
  if (elapsedMs <= 0) return 0;
  if (elapsedMs < options.closeMs) return smoothstep(elapsedMs / options.closeMs);
  const afterClose = elapsedMs - options.closeMs;
  if (afterClose < options.holdMs) return 1;
  const afterHold = afterClose - options.holdMs;
  if (afterHold >= options.openMs) return 0;
  return 1 - smoothstep(afterHold / options.openMs);
}

export class BlinkScheduler {
  private readonly options: BlinkOptions;
  /** 次の瞬きまで。 */
  private waitMs: number;
  /** 瞬きの経過。null は瞬き中でない。 */
  private elapsedMs: number | null = null;
  private secondPending = false;
  private nextIsSecond = false;
  enabled = true;
  /** 話している間は間隔を短くする（次の間隔から効く）。 */
  speaking = false;
  /** 開始した瞬きの累計。 */
  count = 0;
  /** 視線移動で起こした瞬きの累計。 */
  gazeCount = 0;
  private sinceBlinkMs = Number.POSITIVE_INFINITY;

  constructor(
    private readonly rng: Rng,
    options: Partial<BlinkOptions> = {},
  ) {
    this.options = { ...DEFAULT_BLINK, ...options };
    this.waitMs = nextBlinkIntervalMs(rng, this.options);
  }

  /** 手動の瞬き。瞬き中なら無視する。 */
  trigger(): void {
    if (this.elapsedMs !== null) return;
    this.start();
  }

  /**
   * 視線が動いた。大きさに応じた確率で瞬く。自動の瞬きと同じく enabled=false では起こさない。
   * 起こしたら次の自動の瞬きまでの間隔を引き直す（すぐ後にもう一度瞬かない）。
   */
  onGazeShift(amplitudeDeg: number): boolean {
    if (!this.enabled || this.elapsedMs !== null) return false;
    if (this.sinceBlinkMs < this.options.gazeBlinkRefractoryMs) return false;
    if (this.rng() >= gazeBlinkProbability(amplitudeDeg, this.options)) return false;
    this.start();
    this.gazeCount += 1;
    this.secondPending = false;
    return true;
  }

  private start(): void {
    this.elapsedMs = 0;
    this.count += 1;
    this.sinceBlinkMs = 0;
  }

  private nextInterval(): number {
    const interval = nextBlinkIntervalMs(this.rng, this.options);
    return this.speaking ? Math.max(this.options.minIntervalMs, interval * this.options.speakingIntervalScale) : interval;
  }

  update(dtMs: number): number {
    this.sinceBlinkMs += dtMs;
    if (this.elapsedMs !== null) {
      this.elapsedMs += dtMs;
      if (this.elapsedMs >= blinkDurationMs(this.options)) {
        this.elapsedMs = null;
        this.nextIsSecond = this.secondPending;
        this.secondPending = false;
        this.waitMs = this.nextIsSecond ? this.options.doubleGapMs : this.nextInterval();
        return 0;
      }
      return blinkWeight(this.elapsedMs, this.options);
    }
    if (!this.enabled) return 0;
    this.waitMs -= dtMs;
    if (this.waitMs > 0) return 0;
    // 連続の2回目からは続けて連続させない。
    if (!this.nextIsSecond && this.rng() < this.options.doubleProbability) this.secondPending = true;
    this.nextIsSecond = false;
    this.start();
    return 0;
  }
}

export class BlinkLayer implements AvatarLayer {
  readonly name = 'blink';
  weight = 0;

  constructor(readonly scheduler: BlinkScheduler) {}

  update(context: LayerContext, frame: PoseFrame): void {
    this.weight = this.scheduler.update(context.dtMs);
    frame.addExpression('blink', this.weight);
  }
}
