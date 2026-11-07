/**
 * 実 VAP の値（MaAI の出力）で向きを確かめる。R2 の結果を読むだけで、MaAI は実行しない。
 * 素材は公式 sample から作った合成の時間割で、実対話の性能ではない。ファイルがなければ飛ばす。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readVap, vapDirectionSettings } from '../../src/control';
import type { VapDirectionSettings } from '../../src/control';
import { hri2025, ja, repoRoot, vapAt } from './helpers';

type Pair = [number, number];
interface Series {
  t: number[];
  p_now: Pair[];
  p_future: Pair[];
  vad: Pair[];
}
const file = join(repoRoot, 'workers/maai/probes/results/direction_jp_kyoto_normal-ver2_12.5hz_mc.json');
const results = existsSync(file)
  ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, { series: Series }>)
  : null;

function frames(direction: VapDirectionSettings, series: Series, from: number, to: number, channel: 0 | 1) {
  const out = [];
  for (let i = 0; i < series.t.length; i++) {
    const t = series.t[i] as number;
    const vad = series.vad[i] as Pair;
    if (t <= from || t > to || vad[channel] < 0.5) continue;
    out.push(readVap({ ...vapAt(0, 0, false), p_now: series.p_now[i] as Pair, p_future: series.p_future[i] as Pair, vad }, direction));
  }
  return out;
}
const fraction = <T>(items: T[], f: (item: T) => boolean) => items.filter(f).length / items.length;

describe.skipIf(results === null).each(['timeline_inoue_on_ch1', 'timeline_sumida_on_ch1'])(
  'MaAI の実測値（%s。jp_kyoto、合成の時間割）',
  (timeline) => {
    const series = () => (results as NonNullable<typeof results>)[timeline]!.series;
    const direction = vapDirectionSettings(ja());

    it('ch1（利用者）だけが話す区間で、p_now_ai は大半が 0.4 未満（L59 の側）', () => {
      const v = frames(direction, series(), 5, 25, 0);
      expect(v.length).toBeGreaterThan(50);
      expect(fraction(v, (x) => x.p_now_ai < 0.4)).toBeGreaterThan(0.8);
      expect(fraction(v, (x) => x.user_speaking)).toBe(1);
    });
    it('ch2（AI）だけが話す区間で、p_now_ai は大半が 0.5 超（L66 の側）', () => {
      const v = frames(direction, series(), 30, 50, 1);
      expect(v.length).toBeGreaterThan(50);
      expect(fraction(v, (x) => x.p_now_ai > 0.5)).toBeGreaterThan(0.8);
      expect(fraction(v, (x) => x.user_speaking)).toBe(0);
    });
    it('添字を逆にすると成り立たない（この試験が向きを見ている確認）', () => {
      const flipped = { ...direction, p_ai_index: 0 as const };
      expect(fraction(frames(flipped, series(), 5, 25, 0), (x) => x.p_now_ai < 0.4)).toBeLessThan(0.2);
    });
  },
);

describe('向きの設定', () => {
  it('現状はどちらの方策も暫定で p_ai_index=1', () => {
    expect(vapDirectionSettings(hri2025())).toEqual({ p_ai_index: 1, speaking_threshold: null, direction_status: 'provisional' });
    expect(vapDirectionSettings(ja())).toEqual({ p_ai_index: 1, speaking_threshold: 0.5, direction_status: 'provisional' });
  });
  it('ja は方策の添字に従う', () => {
    const direction = { p_ai_index: 0 as const, speaking_threshold: 0.5, direction_status: 'provisional' as const };
    expect(readVap(vapAt(0.9, 0.8, false), direction)).toMatchObject({ p_now_ai: expect.closeTo(0.1), p_future_ai: expect.closeTo(0.2) });
  });
  it('hri2025 はワーカーの user_speaking、ja は vad[0] と閾値', () => {
    const state = { ...vapAt(0.5, 0.5, true), vad: [0.2, 0] as Pair };
    expect(readVap(state, vapDirectionSettings(hri2025())).user_speaking).toBe(true);
    expect(readVap(state, vapDirectionSettings(ja())).user_speaking).toBe(false);
  });
});
