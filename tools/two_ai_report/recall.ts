/**
 * 刺激再生の頭出しの表（--recall の recall_points.csv。04 D、AC19。計画 v2 C-4）。
 * 行：段の境界（two_ai.stage の started／ended）、印（two_ai.marker）、① の声の割り込みの onset、同期の印（two_ai.sync_mark からだけ）。
 */
import { csv } from './csv';
import { audioOffsetMs, ofType, type TwoAiSessionData } from './session';
import { turnAt } from './timeline';

export const RECALL_COLUMNS = ['kind', 'seq', 'trigger', 'stage', 'heading', 'edge', 'id', 't_monotonic_ms', 'wall_clock', 'offset_in_audio_ms', 'ai_speaking', 'point_id', 'counted'] as const;

export function buildRecallRows(data: TwoAiSessionData): Record<string, unknown>[] {
  const rows: (Record<string, unknown> & { _t: number; _o: number })[] = [];
  const add = (t: number, order: number, r: Record<string, unknown>) => rows.push({ _t: t, _o: order, t_monotonic_ms: Math.round(t), offset_in_audio_ms: audioOffsetMs(data, t), ...r });
  for (const m of ofType(data.events, 'two_ai.sync_mark')) {
    add(m.t_monotonic_ms, 0, { kind: 'sync', seq: m.seq, trigger: m.trigger, wall_clock: new Date(m.t_wall_ms).toISOString() });
  }
  for (const s of ofType(data.events, 'two_ai.stage')) {
    const speaking = turnAt(data.events, s.t_monotonic_ms);
    add(s.t_monotonic_ms, s.edge === 'ended' ? -1 : 1, { kind: 'stage', stage: s.discussion_stage, heading: s.heading, edge: s.edge, id: s.turn_id, wall_clock: s.wall_clock, ai_speaking: s.edge === 'started' ? (speaking?.ai_id ?? null) : null, point_id: s.edge === 'started' ? (speaking?.point_id ?? null) : null });
  }
  for (const m of ofType(data.events, 'two_ai.marker')) {
    add(m.t_monotonic_ms, 2, { kind: 'marker', stage: m.discussion_stage, id: m.marker_id, wall_clock: m.wall_clock, ai_speaking: m.ai_speaking, point_id: m.during_point_id, counted: m.counted });
  }
  const onSpot = (data.two_ai?.condition ?? data.events[0]?.condition) === 'respond_on_spot';
  if (onSpot) {
    for (const i of ofType(data.events, 'two_ai.interjection').filter((x) => x.stage === 'onset')) {
      add(i.t_monotonic_ms, 2, { kind: 'onset', stage: i.two_ai?.discussion_stage ?? null, id: i.interjection_id, wall_clock: i.wall_clock, ai_speaking: i.interrupted_ai, point_id: i.during_point_id });
    }
  }
  rows.sort((a, b) => a._t - b._t || a._o - b._o);
  return rows.map(({ _t: _a, _o: _b, ...r }) => r);
}

export function recallCsv(data: TwoAiSessionData): string {
  return csv(RECALL_COLUMNS, buildRecallRows(data));
}
