import { describe, expect, it } from 'vitest';
import { PolyphaseResampler, designResampler } from '../../src/audio/dsp/resampler';

function tone(freq: number, rate: number, n: number, amp = 0.5): Float32Array {
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate);
  return x;
}

function run(input: Float32Array, inRate: number, outRate: number, block = 128): Float32Array {
  const r = new PolyphaseResampler(designResampler(inRate, outRate));
  const out = new Float32Array(r.maxOutput(input.length) + 16);
  let written = 0;
  for (let i = 0; i < input.length; i += block) {
    written += r.process(input, i, Math.min(block, input.length - i), out, written);
  }
  return out.slice(0, written);
}

function rmsDb(x: Float32Array, skip: number, ref = 0.5): number {
  let sum = 0;
  const end = x.length - skip;
  for (let i = skip; i < end; i++) sum += (x[i] as number) ** 2;
  return 20 * Math.log10(Math.sqrt(sum / (end - skip)) / (ref / Math.SQRT2) + 1e-30);
}

describe('48kHz → 16kHz', () => {
  const design = designResampler(48000, 16000);

  it('遅延が出力の整数サンプルで、設計どおりの大きさ', () => {
    expect(design.L).toBe(1);
    expect(design.M).toBe(3);
    expect((design.N - 1) / 2).toBe(design.skipOutputs * design.M);
    expect(design.delayMs).toBeLessThan(3);
  });

  it.each([100, 1000, 3000, 5000, 6500, 7000])('通過域 %d Hz の利得は ±0.01 dB', (f) => {
    const out = run(tone(f, 48000, 48000), 48000, 16000);
    expect(Math.abs(rmsDb(out, 400))).toBeLessThan(0.01);
  });

  it.each([8000, 8500, 9000, 10000, 12000, 15000, 16000, 20000, 23000])(
    '阻止域 %d Hz は -75 dB 以下まで落ちる（折り返しなし）',
    (f) => {
      const out = run(tone(f, 48000, 48000), 48000, 16000);
      expect(rmsDb(out, 400)).toBeLessThan(-75);
    },
  );

  it('インパルスの位置: 出力 n は入力 3n に揃う', () => {
    const x = new Float32Array(48000);
    x[9000] = 1;
    const out = run(x, 48000, 16000);
    let peak = 0;
    for (let i = 0; i < out.length; i++) if (Math.abs(out[i] as number) > Math.abs(out[peak] as number)) peak = i;
    expect(peak).toBe(3000);
  });

  it('ブロックの切り方で結果が変わらない', () => {
    const x = tone(997, 48000, 4800);
    const a = run(x, 48000, 16000, 128);
    const b = run(x, 48000, 16000, 37);
    expect(a.length).toBe(b.length);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('同じ設計の2インスタンスは同じ入力で完全に同じ出力（群遅延差ゼロ）', () => {
    const r1 = new PolyphaseResampler(design);
    const r2 = new PolyphaseResampler(design);
    const x = tone(1234, 48000, 4800);
    const o1 = new Float32Array(2000);
    const o2 = new Float32Array(2000);
    const n1 = r1.process(x, 0, x.length, o1, 0);
    const n2 = r2.process(x, 0, x.length, o2, 0);
    expect(n1).toBe(n2);
    expect(Array.from(o1)).toEqual(Array.from(o2));
  });
});

describe('再生側の変換', () => {
  it.each([
    [24000, 48000],
    [16000, 48000],
    [22050, 48000],
    [44100, 48000],
    [48000, 44100],
    [44100, 16000],
  ])('%d → %d: 出力数は ceil(n*L/M)、flush で全部出る', (inRate, outRate) => {
    const r = new PolyphaseResampler(designResampler(inRate, outRate));
    const n = 5000;
    const x = tone(440, inRate, n);
    const out = new Float32Array(r.maxOutput(n));
    const count = r.process(x, 0, n, out, 0);
    const tail = r.flush();
    expect(count + tail.length).toBe(Math.ceil((n * outRate) / inRate));
  });

  it('24k→48k: 440 Hz の振幅と時刻が保たれる（遅延は打ち消し済み）', () => {
    const input = tone(440, 24000, 24000);
    const r = new PolyphaseResampler(designResampler(24000, 48000));
    const out = new Float32Array(r.maxOutput(input.length));
    const count = r.process(input, 0, input.length, out, 0);
    const skip = 1000;
    for (let i = skip; i < count - skip; i += 97) {
      const expected = 0.5 * Math.sin((2 * Math.PI * 440 * i) / 48000);
      expect(Math.abs((out[i] as number) - expected)).toBeLessThan(2e-3);
    }
  });

  it('24k→48k: 像（12kHz より上）が -70 dB 以下', () => {
    // 11.5 kHz の入力の像は 12.5 kHz に出る。
    const input = tone(11000, 24000, 24000);
    const r = new PolyphaseResampler(designResampler(24000, 48000));
    const out = new Float32Array(r.maxOutput(input.length));
    const count = r.process(input, 0, input.length, out, 0);
    let re = 0;
    let im = 0;
    const imageHz = 24000 - 11000;
    for (let i = 1000; i < count - 1000; i++) {
      const w = (2 * Math.PI * imageHz * i) / 48000;
      re += (out[i] as number) * Math.cos(w);
      im += (out[i] as number) * Math.sin(w);
    }
    const amp = (2 * Math.hypot(re, im)) / (count - 2000);
    expect(20 * Math.log10(amp / 0.5)).toBeLessThan(-70);
  });

  it('同じレートはそのまま通す', () => {
    const input = tone(440, 48000, 1000);
    const r = new PolyphaseResampler(designResampler(48000, 48000));
    const out = new Float32Array(r.maxOutput(1000));
    expect(r.process(input, 0, 1000, out, 0)).toBe(1000);
    expect(Array.from(out.subarray(0, 1000))).toEqual(Array.from(input));
    expect(r.flush().length).toBe(0);
  });
});
