/**
 * 段と中身の時計の時刻の対応（--recall、--coding、要約で共有）。
 * t_content_ms の定義（04 D。第 4 回 m-12）：その時刻までに終わった two_ai.turn(ended) の content_ms の和と、
 * 中身のターン（discussion／point／point_elaboration）の前の gap_hint_ms の和（その中身のターンが始まっていれば）。
 * 保留の時間切れの credited_ms（第 5 回 M2）も、その episode の時刻で足す。
 */
import type { ResearchEvent } from '@llm-vap/contracts';
import { mval, ofType, type TwoAiSessionData } from './session';

const CONTENT_KINDS = new Set(['discussion', 'point', 'point_elaboration']);

export interface ContentClock {
  at(t: number): number;
}

export function contentClock(events: readonly ResearchEvent[]): ContentClock {
  const steps: { t: number; add: number }[] = [];
  for (const e of ofType(events, 'two_ai.turn')) {
    if (e.stage === 'started' && CONTENT_KINDS.has(e.turn_kind)) steps.push({ t: e.t_monotonic_ms, add: mval(e.gap_hint_ms) ?? 0 });
    if (e.stage === 'ended') steps.push({ t: e.t_monotonic_ms, add: mval(e.content_ms) ?? 0 });
  }
  for (const ep of ofType(events, 'two_ai.interjection_episode')) {
    const credited = ep.correction_hold ? mval((ep.correction_hold as { credited_ms?: { value: number | null } }).credited_ms) : null;
    if (credited) steps.push({ t: ep.t_monotonic_ms, add: credited });
  }
  steps.sort((a, b) => a.t - b.t);
  return {
    at(t: number): number {
      let sum = 0;
      for (const s of steps) {
        if (s.t > t) break;
        sum += s.add;
      }
      return Math.round(sum);
    },
  };
}

export interface StageSpan {
  stage: string; // '1'〜'4'、'response'、'closing'
  heading: string;
  started_at: number;
  ended_at: number | null;
  started_wall: string | null;
  ended_wall: string | null;
  started_content_ms: number | null;
  ended_content_ms: number | null;
  first_turn_id: string | null;
  sync_trigger: string;
}

/** 段 1〜4、response、closing（next_step と end）の区間。 */
export function stageSpans(data: TwoAiSessionData): StageSpan[] {
  const out: StageSpan[] = [];
  const stages = ofType(data.events, 'two_ai.stage');
  for (const s of stages.filter((x) => x.edge === 'started')) {
    const end = stages.find((x) => x.edge === 'ended' && x.discussion_stage === s.discussion_stage && x.t_monotonic_ms >= s.t_monotonic_ms);
    out.push({
      stage: String(s.discussion_stage),
      heading: s.heading,
      started_at: s.t_monotonic_ms,
      ended_at: end?.t_monotonic_ms ?? null,
      started_wall: s.wall_clock,
      ended_wall: end?.wall_clock ?? null,
      started_content_ms: s.content_elapsed_ms,
      ended_content_ms: end?.content_elapsed_ms ?? null,
      first_turn_id: s.turn_id,
      sync_trigger: `stage_${s.discussion_stage}`,
    });
  }
  const phases = ofType(data.events, 'two_ai.phase_changed');
  const phaseSpan = (names: string[]) => {
    const start = phases.find((p) => names.includes(p.to));
    if (!start) return null;
    const end = phases.find((p) => p.t_monotonic_ms > start.t_monotonic_ms && !names.includes(p.to)) ?? null;
    const lastEvent = data.events.at(-1);
    return { start, end, endT: end?.t_monotonic_ms ?? lastEvent?.t_monotonic_ms ?? null, endWall: end?.wall_clock ?? lastEvent?.wall_clock ?? null };
  };
  const firstTurnAfter = (t: number) => ofType(data.events, 'two_ai.turn').find((x) => x.stage === 'started' && x.t_monotonic_ms >= t)?.turn_id ?? null;
  const response = phaseSpan(['response']);
  if (response) {
    out.push({ stage: 'response', heading: '最後の段（応答）', started_at: response.start.t_monotonic_ms, ended_at: response.endT, started_wall: response.start.wall_clock, ended_wall: response.endWall, started_content_ms: null, ended_content_ms: null, first_turn_id: firstTurnAfter(response.start.t_monotonic_ms), sync_trigger: 'response' });
  }
  const closing = phaseSpan(['next_step', 'end']);
  if (closing) {
    out.push({ stage: 'closing', heading: '最後の段（次の一歩と終わり）', started_at: closing.start.t_monotonic_ms, ended_at: closing.endT, started_wall: closing.start.wall_clock, ended_wall: closing.endWall, started_content_ms: null, ended_content_ms: null, first_turn_id: firstTurnAfter(closing.start.t_monotonic_ms), sync_trigger: 'next_step' });
  }
  return out;
}

export function syncMarkTime(data: TwoAiSessionData, trigger: string): number | null {
  return ofType(data.events, 'two_ai.sync_mark').find((m) => m.trigger === trigger)?.t_monotonic_ms ?? null;
}

/** その時刻に話している（始まっていて終わっていない）AI のターン。 */
export function turnAt(events: readonly ResearchEvent[], t: number): { turn_id: string; ai_id: string | null; turn_kind: string; point_id: string | null; point_variant: string | null; overlap: boolean } | null {
  const turns = ofType(events, 'two_ai.turn');
  const started = turns.filter((x) => x.stage === 'started' && x.t_monotonic_ms <= t);
  const last = started.at(-1);
  if (!last) return null;
  const ended = turns.find((x) => x.turn_id === last.turn_id && (x.stage === 'ended' || x.stage === 'failed' || x.stage === 'cancelled') && x.t_monotonic_ms >= last.t_monotonic_ms);
  return { turn_id: last.turn_id, ai_id: last.speaker, turn_kind: last.turn_kind, point_id: last.point_id, point_variant: last.point_variant, overlap: ended === undefined || ended.t_monotonic_ms > t };
}
