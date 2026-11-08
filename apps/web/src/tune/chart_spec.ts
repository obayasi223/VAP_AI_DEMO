/**
 * 調整画面の図の中身を作る（React に依存しない）。ライブと録音の再生で同じ段を使う。
 *  - p_now、p_future、vad: AI は実線、利用者は破線。方策の閾値を点線で重ねる（policy_edit.ts の thresholdLines）。
 *  - 間（ms）: 利用者の発話の終わりからの間（L74 が見る値）、L74 の待ち（completion と start_guard から）、最小の間、
 *    L64 が続いた時間（L67 が見る値）。判断の材料（turn_diagnostic）から描く。
 *  - completion: 制御が使った completion_p と準備の閾値。
 */
import type { TurnDiagnosticBody } from '@llm-vap/contracts';
import type { ChartLane, ChartThreshold } from './TuneChart';
import type { ThresholdLines, ThresholdLine } from './policy_edit';

/** 図の色（CSS 変数。tune.module.css で明暗を切り替える）。 */
export const CHART_COLORS = {
  ai: 'var(--series-ai)',
  user: 'var(--series-user)',
  allowed: 'var(--series-allowed)',
  gaze: 'var(--series-gaze)',
  initiative: 'var(--series-initiative)',
  interrupt: 'var(--series-interrupt)',
  recorded: 'var(--series-recorded)',
  replayed: 'var(--series-replayed)',
  guard: 'var(--series-guard)',
  muted: 'var(--muted)',
} as const;

export interface VapLike {
  t: number;
  p_now: readonly [number, number];
  p_future: readonly [number, number];
  vad: readonly [number, number];
}

const ROLE_COLOR: Record<ThresholdLine['role'], string> = {
  yield: CHART_COLORS.allowed,
  interrupt: CHART_COLORS.interrupt,
  guard: CHART_COLORS.guard,
  gaze: CHART_COLORS.gaze,
  speaking: CHART_COLORS.user,
  other: CHART_COLORS.muted,
};

function thresholds(lines: ThresholdLine[]): ChartThreshold[] {
  return lines.map((l) => ({ label: l.label, value: l.value, color: ROLE_COLOR[l.role] }));
}

export function vapLanes(points: VapLike[], aiIndex: 0 | 1, lines: ThresholdLines, height = 70): ChartLane[] {
  const user = aiIndex === 0 ? 1 : 0;
  const pick = (key: 'p_now' | 'p_future', i: number) => points.map((p) => [p.t, p[key][i] as number] as const);
  return [
    {
      name: 'p_now',
      height,
      min: 0,
      max: 1,
      series: [
        { label: 'AI', points: pick('p_now', aiIndex), color: CHART_COLORS.ai },
        { label: '利用者', points: pick('p_now', user), color: CHART_COLORS.user, dash: true },
      ],
      thresholds: thresholds(lines.p_now),
    },
    {
      name: 'p_future',
      height,
      min: 0,
      max: 1,
      series: [
        { label: 'AI', points: pick('p_future', aiIndex), color: CHART_COLORS.ai },
        { label: '利用者', points: pick('p_future', user), color: CHART_COLORS.user, dash: true },
      ],
      thresholds: thresholds(lines.p_future),
    },
    {
      name: 'vad',
      height: Math.round(height * 0.75),
      min: 0,
      max: 1,
      series: [
        { label: '利用者 vad[0]', points: points.map((p) => [p.t, p.vad[0]] as const), color: CHART_COLORS.user, dash: true },
        { label: 'AI vad[1]', points: points.map((p) => [p.t, p.vad[1]] as const), color: CHART_COLORS.ai },
      ],
      thresholds: thresholds(lines.vad),
    },
  ];
}

export const GAP_LANE_MAX_MS = 4000;

export function gapLane(diags: TurnDiagnosticBody[], name = '間（ms）'): ChartLane {
  const clamp = (v: number) => Math.min(GAP_LANE_MAX_MS, v);
  return {
    name,
    height: 70,
    min: 0,
    max: GAP_LANE_MAX_MS,
    series: [
      {
        label: '発話の終わりからの間',
        points: diags.flatMap((d) => (d.gap_ms === null ? [] : [[d.t_monotonic_ms, d.user_speaking ? 0 : clamp(d.gap_ms)] as const])),
        color: CHART_COLORS.user,
      },
      {
        label: 'L74 の待ち',
        points: diags.map((d) => [d.t_monotonic_ms, clamp(d.completion_wait_ms)] as const),
        color: CHART_COLORS.guard,
        step: true,
        dash: true,
      },
      {
        label: '最小の間',
        points: diags.map((d) => [d.t_monotonic_ms, clamp(d.min_gap_ms)] as const),
        color: CHART_COLORS.muted,
        step: true,
        dash: true,
      },
      {
        label: 'L64 の継続',
        points: diags.flatMap((d) => (d.since_turn_end_ms === null ? [] : [[d.t_monotonic_ms, clamp(d.since_turn_end_ms)] as const])),
        color: CHART_COLORS.allowed,
      },
    ],
    thresholds: [],
  };
}

export function completionLane(diags: TurnDiagnosticBody[], prepareThreshold: number | null): ChartLane {
  return {
    name: 'completion',
    height: 46,
    min: 0,
    max: 1,
    series: [{ label: 'completion_p', points: diags.map((d) => [d.t_monotonic_ms, d.completion_p] as const), color: CHART_COLORS.initiative, step: true }],
    thresholds: prepareThreshold === null ? [] : [{ label: '準備の閾値（L46）', value: prepareThreshold, color: CHART_COLORS.initiative }],
  };
}

/** vad[0] が閾値以上の連続を区間にする（利用者の声）。 */
export function voicedSpans(points: VapLike[], threshold: number): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let open: number | null = null;
  let last = 0;
  for (const p of points) {
    if (p.vad[0] >= threshold) {
      if (open === null) open = p.t;
    } else if (open !== null) {
      out.push({ start: open, end: p.t });
      open = null;
    }
    last = p.t;
  }
  if (open !== null) out.push({ start: open, end: last });
  return out;
}

/** 許可の変化の列から、許可の区間を作る。 */
export function allowedSpans(changes: { t: number; allowed: boolean; source: string }[], tEnd: number) {
  const out: { start: number; end: number; label: string }[] = [];
  let open: { start: number; label: string } | null = null;
  for (const c of changes) {
    if (open !== null) {
      out.push({ start: open.start, end: c.t, label: open.label });
      open = null;
    }
    if (c.allowed) open = { start: c.t, label: c.source };
  }
  if (open !== null) out.push({ start: open.start, end: tEnd, label: open.label });
  return out;
}

/** 視線の変化の列から、逸らした区間を作る。 */
export function avertSpans(changes: { t: number; target: string }[], tEnd: number) {
  const out: { start: number; end: number }[] = [];
  let away: number | null = null;
  for (const g of changes) {
    if (g.target === 'away' && away === null) away = g.t;
    if (g.target !== 'away' && away !== null) {
      out.push({ start: away, end: g.t });
      away = null;
    }
  }
  if (away !== null) out.push({ start: away, end: tEnd });
  return out;
}

export function quantile(values: number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return (sorted[lo] as number) + ((sorted[hi] as number) - (sorted[lo] as number)) * (pos - lo);
}
