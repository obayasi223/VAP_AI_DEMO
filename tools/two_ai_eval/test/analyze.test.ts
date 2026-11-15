// 技術評価の集計の部品（録音の声の始まり、刺激と録音のずれ、分位点、刺激の乱数）。
import { describe, expect, it } from 'vitest';
import { alignLag, micOnsets, quantile } from '../analyze';
import { rng, voicedSpan, type Stim } from '../stimuli';

const stim = (idx: number, onset_s: number): Stim => ({ idx, kind: 'speech', clip: 'x', text: 't', onset_s, offset_s: onset_s + 1, rms_dbfs: -20 });

describe('two_ai_eval analyze', () => {
  it('micOnsets は 300 ms の静けさの後に 2 枠続けて越えた枠を返す', () => {
    const env = new Float32Array(1000).fill(-90);
    for (let f = 100; f < 150; f++) env[f] = -20;
    for (let f = 160; f < 170; f++) env[f] = -20; // 静けさが短いので新しい始まりではない
    for (let f = 600; f < 650; f++) env[f] = -20;
    expect(micOnsets(env)).toEqual([1, 6]);
  });

  it('alignLag は刺激の始まりと録音の始まりのずれを見つける', () => {
    const stims = [stim(0, 3), stim(1, 14), stim(2, 26), stim(3, 42), stim(4, 80)];
    const onsets = [1.76, 12.76, 24.77, 40.76, 78.75, 100.2];
    const r = alignLag(stims, onsets);
    expect(r.lag).toBeCloseTo(-1.24, 1);
    expect(r.matched).toBe(5);
  });

  it('quantile は線形補間', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([], 0.5)).toBeNull();
  });

  it('刺激の乱数は種で決まり、voicedSpan は声の範囲を返す', () => {
    const a = rng(7);
    const b = rng(7);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
    const x = new Int16Array(48000);
    for (let i = 4800; i < 9600; i++) x[i] = i % 2 ? 8000 : -8000;
    const s = voicedSpan(x, 48000);
    expect(s.on).toBe(4800);
    expect(s.off).toBe(9600);
  });
});
