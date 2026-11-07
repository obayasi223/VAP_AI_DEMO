import { describe, expect, it } from 'vitest';
import { SIMILARITY_METHOD, charNgramCosine } from '../src/cognition/similarity';

describe('charNgramCosine', () => {
  it('Similarity(x, none) は 0（U-5）', () => {
    expect(charNgramCosine('はい', null)).toBe(0);
    expect(charNgramCosine('はい', undefined)).toBe(0);
    expect(charNgramCosine(null, 'はい')).toBe(0);
    expect(charNgramCosine('', 'はい')).toBe(0);
    expect(charNgramCosine('。、', 'はい')).toBe(0);
  });

  it('同じ文は 1。短い文と句読点の違いでも同じ', () => {
    expect(charNgramCosine('明日の会議', '明日の会議')).toBeCloseTo(1);
    expect(charNgramCosine('はい', 'はい')).toBeCloseTo(1);
    expect(charNgramCosine('は', 'は')).toBeCloseTo(1);
    expect(charNgramCosine('国が？', '国が。')).toBeCloseTo(1);
    expect(charNgramCosine('ＡＢ c', 'ABc')).toBeCloseTo(1);
  });

  it('無関係な文は 0、文が伸びると下がる', () => {
    expect(charNgramCosine('明日の会議', '猫が好き')).toBe(0);
    const base = '昨日駅前の新しいカフェに行った';
    const near = charNgramCosine(base, `${base}んだ`);
    const far = charNgramCosine(base, `${base}んだけどすごく混んでて入れませんでした`);
    expect(near).toBeGreaterThan(far);
    expect(near).toBeLessThanOrEqual(1);
  });

  it('手法の名前を残す', () => {
    expect(SIMILARITY_METHOD).toBe('char_ngram_cosine:n=2');
  });
});
