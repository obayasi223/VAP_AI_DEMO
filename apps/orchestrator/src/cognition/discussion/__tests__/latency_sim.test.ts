/**
 * 遅れの模擬（02 §5）。生のターンの文の遅れを実測の仮定の分布（中央値 1.2 秒、p95 3 秒の対数正規）にして、
 * 次のターンの文が「前のターンの再生の終わり ＋ 間 ＋ max_wait_for_ready_ms」に間に合わない割合（＝凍結の fallback の割合）を出す。
 * 文は 2 本先まで作る（lookahead 2）：ターン n の要求は n−2 の再生の始まりに出る。TTS の最初の音声は 0.25 秒。
 * 結果は目安（04 と合わせる目標は 1% 未満）。分布は仮定で、実測は tools/two_ai_probe。
 */
import { describe, expect, it } from 'vitest';
import { KIND_BANDS } from '../plan';

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s + 0.5) / 0x1_0000_0000;
  };
}

/** 対数正規（中央値 m、p95 p）。 */
function lognormal(r: () => number, m: number, p: number): number {
  const sigma = Math.log(p / m) / 1.6449;
  const z = Math.sqrt(-2 * Math.log(r())) * Math.cos(2 * Math.PI * r());
  return m * Math.exp(sigma * z);
}

export function simulateReadiness(input: { turns: number; lookahead: number; seed: number; maxWaitMs: number; gapMs: number; charsPerSec: number; kinds: (keyof typeof KIND_BANDS)[] }): { overrun_ratio: number } {
  const r = rng(input.seed);
  const dur = input.kinds.map((k) => ((KIND_BANDS[k][0] + KIND_BANDS[k][1]) / 2 / input.charsPerSec) * 1000);
  const start: number[] = [];
  let overruns = 0;
  let t = 0;
  for (let n = 0; n < input.turns; n++) {
    const d = dur[n % dur.length]!;
    const requestAt = n < input.lookahead ? 0 : start[n - input.lookahead]!;
    const ready = requestAt + lognormal(r, 1200, 3000) + 250;
    const due = t + input.gapMs;
    if (ready > due + input.maxWaitMs) overruns += 1;
    const begin = Math.max(due, Math.min(ready, due + input.maxWaitMs));
    start.push(begin);
    t = begin + d;
  }
  return { overrun_ratio: overruns / input.turns };
}

describe('遅れの模擬', () => {
  it('lookahead 2、max_wait 1.5 秒で、fallback の割合を出す（目標 1% 未満）', () => {
    const kinds: (keyof typeof KIND_BANDS)[] = ['develop', 'react', 'question', 'develop', 'react', 'develop'];
    const r2 = simulateReadiness({ turns: 20_000, lookahead: 2, seed: 1, maxWaitMs: 1500, gapMs: 600, charsPerSec: 7, kinds });
    const r1 = simulateReadiness({ turns: 20_000, lookahead: 1, seed: 1, maxWaitMs: 1500, gapMs: 600, charsPerSec: 7, kinds });
    console.info(`[latency_sim] overrun lookahead1=${(r1.overrun_ratio * 100).toFixed(2)}% lookahead2=${(r2.overrun_ratio * 100).toFixed(2)}%`);
    expect(r2.overrun_ratio).toBeLessThanOrEqual(r1.overrun_ratio);
    expect(r2.overrun_ratio).toBeLessThan(0.01);
  });
});
