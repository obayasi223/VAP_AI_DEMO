import { describe, expect, it } from 'vitest';
import { ClockEstimator, RenderClock, ThreadAxisEstimator, composeMainThreadClock, type ClockEstimate } from '../../src/audio/clock_sync';

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

describe('ClockEstimator の時計の飛び', () => {
  it('飛びの後は、RTT の小さい古い標本を捨てて新しい時計差を使う', () => {
    const c = new ClockEstimator();
    // 時計差 1000、RTT 2 の良い標本。
    c.add(0, 1001, 2);
    // 時計差が 3 秒飛んだ。RTT は 10 で前の標本より大きい。
    const after = c.add(4000, 8005, 4010);
    expect(after?.offset_ms).toBeCloseTo(4000, 3);
    expect(after?.samples).toBe(1);
  });

  it('RTT の範囲に収まる揺れでは窓を捨てない', () => {
    const c = new ClockEstimator();
    c.add(0, 1001, 2);
    const after = c.add(4000, 5008, 4010);
    expect(after?.offset_ms).toBeCloseTo(1000, 3);
    expect(after?.samples).toBe(2);
  });
});

describe('ThreadAxisEstimator', () => {
  it('RTT が最小の往復から差を求め、timeOrigin に依らない', () => {
    const a = new ThreadAxisEstimator();
    expect(a.offsetMs).toBeNull();
    a.add(1000, 6500, 1400); // 主スレッドが詰まった往復（rtt 400）
    a.add(2000, 7300, 2002); // rtt 2、offset 5299
    a.add(3000, 8999, 3100); // rtt 100 は採らない
    expect(a.offsetMs).toBeCloseTo(5299);
    expect(a.rttMs).toBe(2);
    expect(a.uncertaintyMs).toBe(1);
  });
});

describe('axis の推定の更新', () => {
  it('RTT の小さい標本で軸が動いたときだけ true を返す', () => {
    const a = new ThreadAxisEstimator();
    expect(a.add(1000, 6500, 1200)).toBe(true); // 最初の標本
    expect(a.add(2000, 7300, 2300)).toBe(false); // RTT が大きいので採らない
    expect(a.add(3000, 8000, 3002)).toBe(true); // 差が変わった
    expect(a.add(4000, 9000, 4001)).toBe(false); // RTT は小さいが差は 1ms 未満
    expect(a.rttMs).toBe(1);
  });
});

describe('composeMainThreadClock', () => {
  const worker: ClockEstimate = { offset_ms: 5000, rtt_ms: 2, uncertainty_ms: 1, samples: 3, measured_at_client_ms: 10 };

  it('サーバー時刻 = 主スレッド時刻 - 軸の差 + Worker の時計差 で合成し、誤差は足す', () => {
    const main = composeMainThreadClock(worker, 120, 4);
    expect(main.offset_ms).toBeCloseTo(4880);
    expect(main.uncertainty_ms).toBe(5);
    expect(main.rtt_ms).toBe(2);
    expect(main.samples).toBe(3);
  });

  it('軸の推定が良くなれば、同じ Worker の時計差から合成し直すだけで結果が直る（古い偏りが残らない）', () => {
    // 主スレッドが詰まっていた間の偏り（+90ms）を持つ軸の推定。
    const biased = composeMainThreadClock(worker, 210, 90);
    const corrected = composeMainThreadClock(worker, 120, 1);
    expect(corrected.offset_ms - biased.offset_ms).toBeCloseTo(90);
    expect(corrected.uncertainty_ms).toBeLessThan(biased.uncertainty_ms);
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
