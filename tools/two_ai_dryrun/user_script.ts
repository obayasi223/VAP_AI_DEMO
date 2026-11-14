/**
 * 試走の「本人」の台本（04 T4）。点や段からの相対時刻で書けるので、生成の長さが変わっても割り込みが C や取り違えに当たる。
 * resolveUserTimeline は、実際のログ（または進行中のセッション）の点と段階の開始時刻から、絶対時刻の列に直す。
 */
import { readFileSync } from 'node:fs';
import { z } from 'zod';

const Text = z.string().min(1);
const Ms = z.number().min(0);
const Woz = z.enum(['correction', 'stop', 'face_user', 'resume']);

export const UserUtterance = z.union([
  z.strictObject({ phase: z.literal('intake'), at_sec: Ms, text: Text, duration_ms: Ms }),
  z.strictObject({ after_point_started: Text, offset_ms: Ms, text: Text, duration_ms: Ms, woz: Woz.optional() }),
  /** 点の外の割り込み（段の始まりから。旗の比較で使う）。 */
  z.strictObject({ after_stage_started: z.number().int().min(1).max(4), offset_ms: Ms, text: Text, duration_ms: Ms, woz: Woz.optional() }),
  /** 兆しだけ（声にならない）。 */
  z.strictObject({ onset_only: z.literal(true), at_sec: Ms, ramp_ms: Ms }),
  z.strictObject({ onset_only: z.literal(true), after_point_started: Text, offset_ms: Ms, ramp_ms: Ms }),
  z.strictObject({ phase: z.literal('response'), at_sec: Ms, text: Text, duration_ms: Ms }),
  z.strictObject({ marker: z.literal(true), at_sec: Ms }),
  z.strictObject({ marker: z.literal(true), after_point_started: Text, offset_ms: Ms }),
  /** next_step で order の札を選ぶ。 */
  z.strictObject({ pick: z.number().int().min(1).max(4), after_phase_started_ms: Ms }),
]);
export type UserUtterance = z.infer<typeof UserUtterance>;

export const UserScript = z.strictObject({ version: z.literal(1), note: z.string().optional(), utterances: z.array(UserUtterance) });
export type UserScript = z.infer<typeof UserScript>;

export function loadUserScript(path: string): UserScript {
  return UserScript.parse(JSON.parse(readFileSync(path, 'utf8')));
}

/** 絶対時刻の行動。voice は STT が区間の終わりに text を返す。onset_only は vad だけ上がる。 */
export type UserAction =
  | { kind: 'voice'; at_ms: number; duration_ms: number; text: string; woz: z.infer<typeof Woz> | null; source: string }
  | { kind: 'onset_only'; at_ms: number; ramp_ms: number; source: string }
  | { kind: 'marker'; at_ms: number; source: string }
  | { kind: 'pick'; at_ms: number; order: number; source: string };

/** セッションの基準の時刻（orchestrator の ms）。分からないものは null（その行動はまだ決まらない）。 */
export interface TimelineAnchors {
  session_start_ms: number;
  phase_started_ms: Partial<Record<'intake' | 'discussion' | 'response' | 'next_step' | 'end', number>>;
  point_started_ms: Record<string, number>;
  stage_started_ms: Partial<Record<1 | 2 | 3 | 4, number>>;
  discussion_started_ms?: number;
}

/** 決まった行動（時刻の順）と、基準がまだない行動の数。 */
export function resolveUserTimeline(script: UserScript, anchors: TimelineAnchors): { actions: UserAction[]; pending: number } {
  const actions: UserAction[] = [];
  let pending = 0;
  script.utterances.forEach((u, i) => {
    const source = `utterances[${i}]`;
    const push = (base: number | undefined, a: (base: number) => UserAction) => {
      if (base === undefined) pending += 1;
      else actions.push(a(base));
    };
    if ('pick' in u) push(anchors.phase_started_ms.next_step, (b) => ({ kind: 'pick', at_ms: b + u.after_phase_started_ms, order: u.pick, source }));
    else if ('marker' in u) {
      if ('after_point_started' in u) push(anchors.point_started_ms[u.after_point_started], (b) => ({ kind: 'marker', at_ms: b + u.offset_ms, source }));
      else push(anchors.discussion_started_ms ?? anchors.phase_started_ms.discussion, (b) => ({ kind: 'marker', at_ms: b + u.at_sec * 1000, source }));
    } else if ('onset_only' in u) {
      if ('after_point_started' in u) push(anchors.point_started_ms[u.after_point_started], (b) => ({ kind: 'onset_only', at_ms: b + u.offset_ms, ramp_ms: u.ramp_ms, source }));
      else push(anchors.phase_started_ms.discussion, (b) => ({ kind: 'onset_only', at_ms: b + u.at_sec * 1000, ramp_ms: u.ramp_ms, source }));
    } else if ('phase' in u) {
      push(anchors.phase_started_ms[u.phase], (b) => ({ kind: 'voice', at_ms: b + u.at_sec * 1000, duration_ms: u.duration_ms, text: u.text, woz: null, source }));
    } else if ('after_point_started' in u) {
      push(anchors.point_started_ms[u.after_point_started], (b) => ({ kind: 'voice', at_ms: b + u.offset_ms, duration_ms: u.duration_ms, text: u.text, woz: u.woz ?? null, source }));
    } else {
      push(anchors.stage_started_ms[u.after_stage_started as 1 | 2 | 3 | 4], (b) => ({ kind: 'voice', at_ms: b + u.offset_ms, duration_ms: u.duration_ms, text: u.text, woz: u.woz ?? null, source }));
    }
  });
  actions.sort((a, b) => a.at_ms - b.at_ms);
  return { actions, pending };
}
