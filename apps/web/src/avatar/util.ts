/** アバターの純粋な計算で使う小道具。three に依存しない。 */

export type Rng = () => number;

/** 試験で再現できる乱数（mulberry32）。実行時の既定は Math.random。 */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

export function smoothstep(t: number): number {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}

export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;

/** 標準正規乱数（Box-Muller）。 */
export function gaussian(rng: Rng): number {
  const u = Math.max(rng(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

/** 立ち上がりと立ち下がりで時定数が違う一次遅れ。dt が大きくても目標を越えない。 */
export function smoothAsymmetric(
  current: number,
  target: number,
  dtMs: number,
  attackMs: number,
  releaseMs: number,
): number {
  const tau = target > current ? attackMs : releaseMs;
  if (tau <= 0) return target;
  return target + (current - target) * Math.exp(-Math.max(dtMs, 0) / tau);
}

/**
 * 臨界減衰のばね（Unity の SmoothDamp と同じ近似）。途中で目標が変わっても速度が連続する。
 * smoothTimeMs はおおよそ目標に届くまでの時間の半分。
 */
export class SmoothDamp {
  value: number;
  velocity = 0;

  constructor(initial = 0) {
    this.value = initial;
  }

  update(target: number, smoothTimeMs: number, dtMs: number): number {
    const dt = Math.max(dtMs, 0) / 1000;
    const smoothTime = Math.max(smoothTimeMs / 1000, 1e-4);
    const omega = 2 / smoothTime;
    const x = omega * dt;
    const decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
    const change = this.value - target;
    const temp = (this.velocity + omega * change) * dt;
    this.velocity = (this.velocity - omega * temp) * decay;
    this.value = target + (change + temp) * decay;
    return this.value;
  }
}
