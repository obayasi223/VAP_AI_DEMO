import { describe, expect, it } from 'vitest';
import { BlinkScheduler, blinkDurationMs, blinkWeight, DEFAULT_BLINK, nextBlinkIntervalMs } from '../blink';
import { seededRng } from '../util';

describe('nextBlinkIntervalMs', () => {
  const rng = seededRng(1);
  const samples = Array.from({ length: 5000 }, () => nextBlinkIntervalMs(rng));

  it('範囲に収まる', () => {
    expect(Math.min(...samples)).toBeGreaterThanOrEqual(DEFAULT_BLINK.minIntervalMs);
    expect(Math.max(...samples)).toBeLessThanOrEqual(DEFAULT_BLINK.maxIntervalMs);
  });

  it('中央値が設定に近く、ばらつきが大きい（固定周期でない）', () => {
    const sorted = [...samples].sort((a, b) => a - b);
    expect(sorted[2500]).toBeGreaterThan(DEFAULT_BLINK.medianIntervalMs * 0.9);
    expect(sorted[2500]).toBeLessThan(DEFAULT_BLINK.medianIntervalMs * 1.1);
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    const sd = Math.sqrt(samples.reduce((a, b) => a + (b - mean) ** 2, 0) / samples.length);
    expect(sd / mean).toBeGreaterThan(0.4);
  });

  it('連続する間隔に相関がない', () => {
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    let num = 0;
    let den = 0;
    for (let i = 0; i < samples.length - 1; i += 1) {
      num += (samples[i]! - mean) * (samples[i + 1]! - mean);
      den += (samples[i]! - mean) ** 2;
    }
    expect(Math.abs(num / den)).toBeLessThan(0.06);
  });
});

describe('blinkWeight', () => {
  it('0 から始まり 1 に届いて 0 に戻る', () => {
    expect(blinkWeight(-5)).toBe(0);
    expect(blinkWeight(0)).toBe(0);
    expect(blinkWeight(DEFAULT_BLINK.closeMs + 1)).toBe(1);
    expect(blinkWeight(blinkDurationMs())).toBe(0);
    expect(blinkWeight(blinkDurationMs() + 100)).toBe(0);
  });

  it('閉じる時間より開く時間が長い', () => {
    expect(DEFAULT_BLINK.openMs).toBeGreaterThan(DEFAULT_BLINK.closeMs);
    const halfClose = blinkWeight(DEFAULT_BLINK.closeMs / 2);
    const halfOpen = blinkWeight(DEFAULT_BLINK.closeMs + DEFAULT_BLINK.holdMs + DEFAULT_BLINK.openMs / 2);
    expect(halfClose).toBeCloseTo(0.5, 2);
    expect(halfOpen).toBeCloseTo(0.5, 2);
  });
});

describe('BlinkScheduler', () => {
  /** 瞬きの開始時刻の列。 */
  function run(seed: number, seconds: number, options = {}) {
    const scheduler = new BlinkScheduler(seededRng(seed), options);
    const starts: number[] = [];
    let previous = 0;
    for (let t = 0; t < seconds * 1000; t += 10) {
      scheduler.update(10);
      if (scheduler.count > previous) {
        starts.push(t);
        previous = scheduler.count;
      }
    }
    return { scheduler, starts };
  }

  it('10 分で 1 分あたり 10〜30 回', () => {
    const { starts } = run(2, 600);
    const perMinute = starts.length / 10;
    expect(perMinute).toBeGreaterThan(10);
    expect(perMinute).toBeLessThan(30);
  });

  it('間隔が固定でない', () => {
    const { starts } = run(3, 600);
    const gaps = starts.slice(1).map((s, i) => s - starts[i]!);
    expect(new Set(gaps).size).toBeGreaterThan(gaps.length / 3);
  });

  it('ときどき連続の瞬きがあり、3連続にならない', () => {
    const { starts } = run(4, 1200);
    const near = blinkDurationMs() + DEFAULT_BLINK.doubleGapMs + 30;
    const gaps = starts.slice(1).map((s, i) => s - starts[i]!);
    const doubles = gaps.filter((g) => g < near);
    expect(doubles.length).toBeGreaterThan(5);
    for (let i = 0; i < gaps.length - 1; i += 1) {
      expect(gaps[i]! < near && gaps[i + 1]! < near).toBe(false);
    }
  });

  it('enabled=false で自動の瞬きが止まり、trigger は効く', () => {
    const scheduler = new BlinkScheduler(seededRng(5));
    scheduler.enabled = false;
    for (let t = 0; t < 30000; t += 16) scheduler.update(16);
    expect(scheduler.count).toBe(0);
    scheduler.trigger();
    let peak = 0;
    for (let t = 0; t < 400; t += 16) peak = Math.max(peak, scheduler.update(16));
    expect(scheduler.count).toBe(1);
    expect(peak).toBe(1);
  });
});
