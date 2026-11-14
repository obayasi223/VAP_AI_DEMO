/** WP3c の早い性能の確認の集計（tools/two_ai_perf/quick_rtf.ts）。値は作り物。 */
import { describe, expect, it } from 'vitest';
import { RTF_P95_BUDGET, summarizeQuickRtf } from '../../../../tools/two_ai_perf/quick_rtf';

describe('summarizeQuickRtf', () => {
  it('Worker の rtf の中央値と p95、render.health の値を集め、ソフトウェア描画を注記する', () => {
    const events = [
      ...[0.5, 0.6, 0.7, 0.8].map((rtf) => ({ event: 'audio.health', reporter: 'worker', rtf: { value: rtf } })),
      { event: 'audio.health', reporter: 'worker', rtf: { value: null, null_reason: 'x' } },
      { event: 'audio.health', reporter: 'browser' },
      { event: 'render.health', fps_median: 30, fps_p5: 22, frame_ms_p95: 18, long_tasks: 2, renderer: 'ANGLE (SwiftShader)', avatars: 2 },
      { event: 'render.health', fps_median: 28, fps_p5: 20, frame_ms_p95: 25, long_tasks: 1, renderer: 'ANGLE (SwiftShader)', avatars: 2 },
    ];
    const summary = summarizeQuickRtf('two', events);
    expect(summary.rtf).toMatchObject({ n: 4, p50: 0.6, p95: 0.8 });
    expect(summary.rtf.over_budget_by).toBeCloseTo(0.8 - RTF_P95_BUDGET);
    expect(summary.render).toMatchObject({ n: 2, fps_p5_min: 20, frame_ms_p95_max: 25, long_tasks: 3, avatars: [2], software_renderer: true });
  });

  it('値がなければ null（0 にしない）', () => {
    const summary = summarizeQuickRtf('none', []);
    expect(summary.rtf).toEqual({ n: 0, p50: null, p95: null, over_budget_by: null });
    expect(summary.render.fps_median).toBeNull();
  });
});
