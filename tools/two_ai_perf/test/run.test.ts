// perf:two_ai の集計（04 §性能の予算の表）。合成のログに手で audio.health と render.health を足して見る。
import { describe, expect, it } from 'vitest';
import { buildSyntheticSession } from '../../../fixtures/two_ai/synthetic_session';
import { renderPerfMarkdown, summarizePerf } from '../run';

type Raw = Record<string, unknown>;
const health = (t: number, rtf: number, queue = 0): Raw => ({ event: 'audio.health', reporter: 'worker', t_monotonic_ms: t, rtf: { value: rtf }, queue_depth: queue, frames_dropped_network: 0, frames_dropped_overload: 0 });
const render = (t: number, fps_p5: number, long_tasks = 0): Raw => ({ event: 'render.health', t_monotonic_ms: t, fps_p5, fps_median: 60, frame_ms_p95: 20, long_tasks, renderer: 'ANGLE (NVIDIA)', avatars: 2, pixel_ratio: 1 });

describe('summarizePerf', () => {
  const base = buildSyntheticSession({ condition: 'respond_on_spot' }).events as Raw[];

  it('予算内の値は合格、合成のログは test_double と注記する', () => {
    const events = [...base, ...Array.from({ length: 60 }, (_, i) => health(i * 1000, 0.4 + (i % 10) * 0.02, 1)), ...Array.from({ length: 12 }, (_, i) => render(i * 5000, 45))];
    const s = summarizePerf('two', events);
    expect(s.test_double).toBe(true);
    expect(s.rows.find((r) => r.item.startsWith('VAP の RTF'))?.ok).toBe(true);
    expect(s.rows.find((r) => r.item.startsWith('描画'))?.ok).toBe(true);
    expect(s.rows.find((r) => r.item.startsWith('長いタスク'))?.ok).toBe(true);
    expect(s.audio_drops).toBe(0);
    expect(s.gap_ms.n).toBeGreaterThan(0);
    expect(renderPerfMarkdown([s])).toContain('性能の証拠ではない');
  });

  it('RTF p95、fps p5、長いタスクの予算外を出す。計測がない行は null', () => {
    const events = [...Array.from({ length: 20 }, (_, i) => health(i * 1000, i < 15 ? 0.5 : 1.2, 9)), render(0, 20, 30), render(5000, 25, 30)];
    const s = summarizePerf('bad', events);
    expect(s.rows.find((r) => r.item.startsWith('VAP の RTF'))?.ok).toBe(false);
    expect(s.rows.find((r) => r.item.startsWith('VAP の backlog'))?.ok).toBe(false);
    expect(s.rows.find((r) => r.item.startsWith('描画'))?.ok).toBe(false);
    expect(s.rows.find((r) => r.item.startsWith('長いタスク'))?.ok).toBe(false);
    expect(s.rows.find((r) => r.item.startsWith('AI 同士'))?.ok).toBeNull();
    expect(renderPerfMarkdown([s])).toContain('F1〜F8');
  });
});
