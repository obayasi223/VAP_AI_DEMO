import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EVIDENCED_RATES, REASON_RATE_NOT_IN_MATRIX, summarizeCost } from '../../src/logging';
import { costEvent, envelope, statusEvent } from './helpers';

describe('summarizeCost', () => {
  it('cost.usage がなければ 0 円でなく no_usage', () => {
    const summary = summarizeCost([statusEvent()]);
    expect(summary.status).toBe('no_usage');
    expect(summary.estimated_usd).toBeNull();
    expect(summary.by_provider).toEqual([]);
  });

  it('根拠のある単価と一致する推定を合計し、プロバイダ別に分ける', () => {
    const summary = summarizeCost([
      costEvent('google_stt_v2', 'audio_seconds', 60, 0.016),
      costEvent('google_stt_v2', 'audio_seconds', 30, 0.008),
      costEvent('elevenlabs', 'characters', 1000, 0.04),
      costEvent('gemini', 'input_tokens', 1_000_000, 0.3),
      costEvent('gemini', 'output_tokens', 1_000_000, 2.5),
    ]);
    expect(summary.status).toBe('complete');
    expect(summary.estimated_usd).toBeCloseTo(0.016 + 0.008 + 0.04 + 0.3 + 2.5, 10);
    const stt = summary.by_provider.find((p) => p.provider === 'google_stt_v2');
    expect(stt?.estimated_usd).toBeCloseTo(0.024, 10);
    expect(stt?.quantities).toEqual([{ unit: 'audio_seconds', quantity: 90 }]);
    expect(stt?.rate_sources[0]).toMatch(/§2.5/);
    expect(stt?.caveats[0]).toMatch(/仮定/);
    expect(summary.by_provider.map((p) => p.provider)).toEqual(['elevenlabs', 'gemini', 'google_stt_v2']);
  });

  it('null の推定は不明として数え、0 として足さない', () => {
    const summary = summarizeCost([
      costEvent('gemini', 'aborted_request', 1, null, 'aborted'),
      costEvent('gemini', 'input_tokens', 1000, 0.0003),
    ]);
    expect(summary.status).toBe('partial');
    expect(summary.unknown_count).toBe(1);
    expect(summary.estimated_usd).toBeCloseTo(0.0003, 10);
    expect(summary.by_provider[0]?.unknown_reasons).toEqual({ aborted: 1 });
  });

  it('すべて不明なら合計は null（0 ではない）', () => {
    const summary = summarizeCost([costEvent('x', 'y', 1, null)]);
    expect(summary.status).toBe('partial');
    expect(summary.estimated_usd).toBeNull();
    expect(summary.by_provider[0]?.estimated_usd).toBeNull();
  });

  it('provider_matrix に根拠のない単価は値があっても不明にする', () => {
    const summary = summarizeCost([
      // Gemini TTS は発行側に単価があるが provider_matrix に記載がない
      costEvent('gemini_tts', 'audio_seconds', 3, 0.000675),
      // 単位はあるが単価が違う
      costEvent('elevenlabs', 'characters', 1000, 0.99),
    ]);
    expect(summary.estimated_usd).toBeNull();
    expect(summary.unknown_count).toBe(2);
    expect(summary.by_provider.find((p) => p.provider === 'gemini_tts')?.unknown_reasons).toEqual({
      [REASON_RATE_NOT_IN_MATRIX]: 1,
    });
  });

  it('期間つきの単価はイベントの日付で判定する', () => {
    const oldPrice = costEvent('gemini', 'input_tokens', 1_000_000, 0.75);
    const newPrice = costEvent('gemini', 'input_tokens', 1_000_000, 1.5);
    expect(summarizeCost([oldPrice, newPrice]).unknown_count).toBe(1);
    const in2027 = { ...newPrice, wall_clock: '2027-01-02T00:00:00.000Z' };
    const oldIn2027 = { ...oldPrice, wall_clock: '2027-01-02T00:00:00.000Z' };
    const summary = summarizeCost([in2027, oldIn2027]);
    expect(summary.estimated_usd).toBeCloseTo(1.5, 10);
    expect(summary.unknown_count).toBe(1);
  });

  it('数量 0 は 0 円で一致する', () => {
    expect(summarizeCost([costEvent('elevenlabs', 'characters', 0, 0)]).status).toBe('complete');
  });

  it('単位が違う数量を足さない', () => {
    const summary = summarizeCost([
      costEvent('gemini', 'input_tokens', 10, 10 * 0.3e-6),
      costEvent('gemini', 'output_tokens', 20, 20 * 2.5e-6),
    ]);
    expect(summary.by_provider[0]?.quantities).toEqual([
      { unit: 'input_tokens', quantity: 10 },
      { unit: 'output_tokens', quantity: 20 },
    ]);
  });

  it('他の種類のイベントを無視する', () => {
    expect(summarizeCost([envelope({ event: 'x' })]).event_count).toBe(0);
  });
});

describe('単価の根拠', () => {
  const matrix = readFileSync(resolve(import.meta.dirname, '../../../../docs/provider_matrix.md'), 'utf8');

  it.each([
    ['V2 の Standard | $0.016／分', 'google_stt_v2', 0.016 / 60],
    ['Flash／Turbo は $0.04／1千文字', 'elevenlabs', 0.04 / 1000],
    ['Multilingual v2 は $0.08', 'elevenlabs', 0.08 / 1000],
    ['料金 3.5-flash-lite | 入力 $0.30、出力 $2.50', 'gemini', 0.3e-6],
    ['料金 3.5-flash-lite | 入力 $0.30、出力 $2.50', 'gemini', 2.5e-6],
    ['料金 3.8-flash | 入力 $0.75、出力 $3.75 → **2027-01-01 から $1.50、$7.50', 'gemini', 0.75e-6],
    ['料金 3.8-flash | 入力 $0.75、出力 $3.75 → **2027-01-01 から $1.50、$7.50', 'gemini', 3.75e-6],
    ['料金 3.8-flash | 入力 $0.75、出力 $3.75 → **2027-01-01 から $1.50、$7.50', 'gemini', 1.5e-6],
    ['料金 3.8-flash | 入力 $0.75、出力 $3.75 → **2027-01-01 から $1.50、$7.50', 'gemini', 7.5e-6],
  ])('%s', (text, provider, rate) => {
    expect(matrix).toContain(text);
    expect(
      EVIDENCED_RATES.some((r) => r.provider === provider && Math.abs(r.usd_per_unit - rate) < 1e-12),
    ).toBe(true);
  });

  it('表の単価の数は上の照合と同じ（根拠のない単価を足すとここで落ちる）', () => {
    expect(EVIDENCED_RATES).toHaveLength(9);
  });
});
