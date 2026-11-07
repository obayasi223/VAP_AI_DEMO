import { describe, expect, it } from 'vitest';
import { StableTranscriptView } from '../transcript_view';
import { final, interim } from './helpers';

const stableOf = (view: StableTranscriptView) => view.snapshot().map((s) => s.stable_text).join('');

describe('StableTranscriptView', () => {
  // 文字列と順序は実測の long（ja.wav）から。0.9 の範囲が revision ごとに縮む形を再現する。
  const measured = [
    interim('国があなたのために。'),
    interim('国があなたのために', '何'),
    interim('', '国があなたのために何'),
    interim('国があなたのために何ができるかを問うのではなく。'),
    interim('', '国があなたのために何ができるかを問うのではなく、あな'),
    interim('国があなたのために何ができるかを問うのではなく、あなたが', ' 国の'),
  ];

  it('high_water: 0.9 の範囲が一時的に縮んでも、文字が同じなら安定のまま', () => {
    const view = new StableTranscriptView({ min_stability: 0.8 });
    const lengths = measured.map((e) => {
      view.apply(e);
      return view.totalStableChars();
    });
    expect(lengths).toEqual([...lengths].sort((a, b) => a - b));
    expect(view.totalRewrites()).toBe(0);
    expect(stableOf(view)).toBe('国があなたのために何ができるかを問うのではなく、あなたが');
  });

  it('literal: 比較用。最新の revision の値だけを使うので途中で空になる', () => {
    const view = new StableTranscriptView({ min_stability: 0.8, mode: 'literal' });
    view.apply(measured[0]!);
    expect(stableOf(view)).toBe('国があなたのために。');
    view.apply(measured[2]!);
    expect(stableOf(view)).toBe('');
  });

  it('0.01 の部分は安定に入らない', () => {
    const view = new StableTranscriptView({ min_stability: 0.8 });
    view.apply(interim('予算は', '五千万円です'));
    expect(stableOf(view)).toBe('予算は');
  });

  it('安定と扱った文字が書き換わったら共通接頭部まで縮める', () => {
    const view = new StableTranscriptView({ min_stability: 0.8 });
    view.apply(interim('出展料は五千万円。'));
    const result = view.apply(interim('', '出展料は五十万円です'));
    expect(result.rewrote_stable).toBe(true);
    expect(stableOf(view)).toBe('出展料は五');
    expect(view.totalRewrites()).toBe(1);
  });

  it('安定の末尾の仮の句点は入力に残らない', () => {
    const view = new StableTranscriptView({ min_stability: 0.8 });
    view.apply(interim('国があなたのために。'));
    view.apply(interim('', '国があなたのために何'));
    expect(stableOf(view)).toBe('国があなたのために');
    expect(view.interiorSentenceBoundaries()).toBe(0);
  });

  it('stability が取れないモデル（derived）では C が決めた stable_text を使い、未安定の語を入れない', () => {
    const view = new StableTranscriptView({ min_stability: 0.8 });
    const base = interim('', '予算は五千万円です');
    view.apply({
      ...base,
      stability_source: 'derived',
      stable_text: '予算は',
      unstable_text: '五千万円です',
      parts: [{ text: '予算は五千万円です', stability: { value: null, null_reason: 'provider_returned_no_stability' } }],
      stability: { value: null, null_reason: 'provider_returned_no_stability' },
    });
    expect(stableOf(view)).toBe('予算は');
  });

  it('final は全文を安定にし、区間を確定する', () => {
    const view = new StableTranscriptView({ min_stability: 0.8 });
    view.apply(interim('予算は', '五十万'));
    view.apply(final('予算は五十万円です。'));
    expect(view.snapshot()).toMatchObject([{ asr_segment_id: 0, stable_text: '予算は五十万円です。', is_final: true }]);
  });

  it('min_stability を上げると 0.9 も安定に入らない（閾値を変えた再生）', () => {
    const view = new StableTranscriptView({ min_stability: 0.95 });
    view.apply(interim('予算は', '五十万'));
    expect(view.totalStableChars()).toBe(0);
  });
});
