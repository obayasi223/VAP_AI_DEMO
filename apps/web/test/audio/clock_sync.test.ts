import { describe, expect, it } from 'vitest';
import { ClockEstimator, RenderClock } from '../../src/audio/clock_sync';

describe('ClockEstimator', () => {
  it('RTT が最小の標本を採る', () => {
    const c = new ClockEstimator();
    c.add(0, 1020, 40); // rtt 40, offset 1000
    const e = c.add(100, 1105, 110); // rtt 10, offset 1000
    expect(e).toMatchObject({ rtt_ms: 10, uncertainty_ms: 5, samples: 2 });
    expect(e?.offset_ms).toBeCloseTo(1000);
    const e2 = c.add(200, 1230, 260); // rtt 60
    expect(e2?.rtt_ms).toBe(10);
  });

  it('窓より古い標本は使わない（ドリフトへの追従）', () => {
    const c = new ClockEstimator(1000, 32);
    c.add(0, 1005, 10);
    const e = c.add(5000, 6030, 5040);
    expect(e?.rtt_ms).toBe(40);
    expect(e?.samples).toBe(1);
  });
});

describe('RenderClock', () => {
  it('メッセージの揺れを除いてフレームを時刻へ写す', () => {
    const r = new RenderClock(48000);
    const base = 1000;
    let maxError = 0;
    for (let i = 0; i < 400; i++) {
      const frame = i * 960;
      const trueT = base + i * 20;
      const jitter = i % 7 === 0 ? 0 : ((i * 37) % 11) * 0.5;
      r.observe(frame, trueT + jitter);
      if (i > 20) maxError = Math.max(maxError, Math.abs((r.toClientMs(frame) as number) - trueT));
    }
    expect(maxError).toBeLessThan(0.01);
    expect(r.renderLagMs).toBeLessThan(0.01);
  });

  it('コールバックが抜けると renderLagMs に出る', () => {
    const r = new RenderClock(48000, 8);
    for (let i = 0; i < 8; i++) r.observe(i * 960, i * 20);
    for (let i = 8; i < 40; i++) r.observe(i * 960, i * 20 + 100);
    expect(r.renderLagMs).toBeCloseTo(100);
  });
});
