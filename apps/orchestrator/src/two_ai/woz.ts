/**
 * WoZ の受け付け（docs/design/two_ai/06 §8、05 §2.2 の表）。純粋関数。断ったものも呼び手が woz.override に残す。
 * recorded は流れを変えずに記録だけ（応答の段の correction）。
 */
import type { PointKind, TwoAiCondition, TwoAiPhase, WozAction } from '@llm-vap/contracts';
import type { FloorHolder } from './director_state';

export interface WozInputTwoAi {
  woz_id: string;
  action: WozAction;
  point_id: string | null;
  operator: string;
  received_at: number;
}

export interface WozView {
  condition: TwoAiCondition;
  phase: TwoAiPhase;
  floor: FloorHolder | null;
  woz_paused: boolean;
  user_floor: boolean;
  /** 判定の保留の間。この間の resume は applied で、研究者の「訂正でない」（06 §6.2 (2)。第 5 回 M1）。 */
  correction_hold: { interjection_id: string; hold_until: number } | null;
  known_points: ReadonlyMap<string, { kind: PointKind; started: boolean; switched: boolean }>;
}

export interface WozAdmission {
  status: 'applied' | 'recorded' | 'rejected';
  reason: string;
  condition_note: 'protocol_deviation' | null;
}

const ok = (reason: string, condition_note: 'protocol_deviation' | null = null): WozAdmission => ({ status: 'applied', reason, condition_note });
const no = (reason: string): WozAdmission => ({ status: 'rejected', reason, condition_note: null });

/** correction の対象の点。point_id が null なら fact_slip の点（1 つだけのとき）。 */
export function resolveCorrectionPoint(point_id: string | null, known: WozView['known_points']): string | null {
  if (point_id !== null) return known.has(point_id) ? point_id : null;
  const slips = [...known.entries()].filter(([, p]) => p.kind === 'fact_slip');
  return slips.length === 1 ? (slips[0] as [string, unknown])[0] : null;
}

export function admitWoz(cmd: WozInputTwoAi, view: WozView): WozAdmission {
  const atEnd = view.condition === 'respond_at_end';
  switch (cmd.action) {
    case 'stop':
      if (view.floor === null) return no('no_ai_speaking');
      return ok('stop', atEnd ? 'protocol_deviation' : null);
    case 'face_user':
      return ok('face_user');
    case 'yield':
      if (view.phase !== 'discussion') return no('phase');
      if (atEnd) return no('condition_respond_at_end');
      return ok('yield');
    case 'resume':
      if (view.correction_hold !== null) return ok('not_correction');
      if (view.woz_paused) return ok('resume_paused');
      if (view.user_floor) return ok('resume_user_floor');
      return no('nothing_to_resume');
    case 'correction': {
      if (view.phase === 'response') return { status: 'recorded', reason: 'response_phase', condition_note: null };
      if (view.phase !== 'discussion') return no('phase');
      if (atEnd) return no('condition_respond_at_end');
      const id = resolveCorrectionPoint(cmd.point_id, view.known_points);
      if (id === null) return no('unknown_point');
      const point = view.known_points.get(id)!;
      if (point.kind !== 'fact_slip') return no('unknown_point');
      if (point.switched) return no('already_switched');
      if (!point.started) return no('point_not_started');
      return ok('correction');
    }
    case 'advance_phase':
      if (view.phase === 'end') return no('phase');
      return ok('advance_phase');
    case 'abort':
      return ok('abort');
  }
}
