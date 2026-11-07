/** 瞬き。間隔は対数正規で揺らし、ときどき連続させる。固定周期に見えないことが目的で、値は未評価。 */
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
};

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
  /** 開始した瞬きの累計。 */
  count = 0;

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

  private start(): void {
    this.elapsedMs = 0;
    this.count += 1;
  }

  update(dtMs: number): number {
    if (this.elapsedMs !== null) {
      this.elapsedMs += dtMs;
      if (this.elapsedMs >= blinkDurationMs(this.options)) {
        this.elapsedMs = null;
        this.nextIsSecond = this.secondPending;
        this.secondPending = false;
        this.waitMs = this.nextIsSecond ? this.options.doubleGapMs : nextBlinkIntervalMs(this.rng, this.options);
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
