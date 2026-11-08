/**
 * 調整画面（/tune）の「なぜ今 AI が話し始めた／まだ話さないのか」の読み出し。
 *
 * TurnManager の state（session.turnState）と最新の vap.state から、Appendix A の分岐の成立を計算し直す。
 * **判断そのものではない**: 判断の正本は TurnManager の turn.allowed（reason）。ここは分岐ごとの値と閾値を並べるだけで、
 * turn_manager.ts の分岐を写した近似（state は直前の tick の値）。turn_manager.ts に分岐が増えたら、ここにも足す。
 * 増えた方策の項目は画面の編集欄と再生には自動で入るが、この分岐の表には足すまで出ない（reason には出る）。
 */
import type { TurnBranchDiagnostic, TurnDiagnosticBody, Vap2chState } from '@llm-vap/contracts';
import { readVap, turnGptTimeout } from '../control';
import type { ControlSettings, TurnState } from '../control';

function round(value: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function since(now: number, at: number | null): number | null {
  return at === null ? null : Math.max(0, round(now - at, 1));
}

/** L74 の待ち（turn_manager.ts の completionTimeoutWait と同じ式）。 */
export function completionWaitMs(settings: ControlSettings, completionP: number, pNowAi: number | null): number {
  const timeout = turnGptTimeout(completionP, settings.yield_timeouts);
  const guard = settings.start_guard;
  if (guard === null) return timeout;
  let wait = Math.max(timeout, guard.min_gap_ms);
  if (pNowAi !== null && pNowAi < guard.completion_timeout_min_p_ai) wait = Math.max(wait, guard.completion_timeout_low_p_min_ms);
  return wait;
}

export function minGapMs(settings: ControlSettings): number {
  return Math.max(settings.constants.MIN_GAP_TIME_MS, settings.start_guard?.min_gap_ms ?? 0);
}

export function buildTurnDiagnostic(
  settings: ControlSettings,
  state: TurnState,
  vap: Vap2chState | null,
  now: number,
  lastReason: string | null,
): TurnDiagnosticBody {
  const c = settings.constants;
  const fresh = state.vap_freshness === 'fresh' && vap !== null;
  const view = fresh ? readVap(vap, settings.direction) : null;
  const gap = since(now, state.user_speak_end_time);
  const sinceTurnEnd = since(now, state.user_turn_end_time);
  const minGap = minGapMs(settings);
  const p = state.turngpt_output;
  const timeout = turnGptTimeout(p, settings.yield_timeouts);
  const wait = completionWaitMs(settings, p, view?.p_now_ai ?? null);
  const aiSpeaking = state.speaking.phase !== 'silent';
  const branches: TurnBranchDiagnostic[] = [];
  const add = (id: string, label: string, holds: boolean | null, detail: string) => branches.push({ id, label, holds, detail });

  if (view === null) {
    add('degraded', 'VAP が使えない（鮮度切れ・助走中）', true, `vap_freshness=${state.vap_freshness}`);
  }
  const userSpeaking = state.user_speaking;
  add(
    'L56',
    '利用者が発話中（VAP の vad[0]、デバウンス後）',
    view === null ? null : userSpeaking,
    view === null
      ? 'VAP なし'
      : `vad[0]=${round(vap!.vad[0])}${settings.direction.speaking_threshold === null ? '' : ` 閾値 ${settings.direction.speaking_threshold}`}`,
  );
  if (view !== null) {
    const interrupt = view.p_now_ai < c.VAP_PNOW_INTERRUPT && view.p_future_ai < c.VAP_PFUT_INTERRUPT;
    add(
      'L59',
      '割り込みで AI を止める（発話中かつ p が低い）',
      userSpeaking && aiSpeaking && interrupt,
      `p_now=${round(view.p_now_ai)}<${c.VAP_PNOW_INTERRUPT} かつ p_future=${round(view.p_future_ai)}<${c.VAP_PFUT_INTERRUPT}: ${interrupt ? '成立' : '不成立'}${aiSpeaking ? '' : '（AI は話していない）'}`,
    );
    const yieldSignal = view.p_now_ai > c.VAP_PNOW_YIELD && view.p_future_ai > c.VAP_PFUT_YIELD;
    add(
      'L64',
      'VAP が AI への譲渡を予測',
      !userSpeaking && yieldSignal,
      `p_now=${round(view.p_now_ai)}>${c.VAP_PNOW_YIELD} かつ p_future=${round(view.p_future_ai)}>${c.VAP_PFUT_YIELD}`,
    );
    add(
      'L67',
      'L64 が続いた時間が最小の間以上',
      !userSpeaking && yieldSignal && sinceTurnEnd !== null && sinceTurnEnd >= minGap,
      `${sinceTurnEnd ?? '-'}ms ≥ ${minGap}ms（L64 が偽の tick ごとに 0 に戻る）`,
    );
    add(
      'L74',
      '発話の終わりからの間が completion の待ち以上',
      !userSpeaking && gap !== null && gap >= wait,
      `間 ${gap ?? '-'}ms ≥ 待ち ${wait}ms（completion=${round(p)} → 表 ${timeout}ms${wait > timeout ? '、start_guard で延長' : ''}）`,
    );
  }
  const invitation = state.invitation;
  add(
    'invitation',
    '明示の招待（語句検出）',
    settings.invitation_grants_turn ? invitation.detected && (gap ?? 0) >= minGap : false,
    invitation.detected
      ? `${invitation.kind}「${invitation.phrase}」${settings.invitation_grants_turn ? '' : '（この方策では記録のみ）'}`
      : '検出なし',
  );
  add('U1', 'AI が話している（話し始めを止める）', aiSpeaking, `phase=${state.speaking.phase}`);
  add(
    'ready',
    '準備済みの応答がある（is_ready）',
    state.want_to_speak.kind !== 'none',
    state.want_to_speak.kind === 'none' ? 'なし' : `audio_playback_id=${state.want_to_speak.audio_playback_id}`,
  );
  if (state.ignored_fragment !== null) {
    add('fragment', 'AI の発話中の断片を応答の対象にしない', true, state.ignored_fragment.reason);
  }
  return {
    t_monotonic_ms: round(now, 1),
    vap_freshness: state.vap_freshness,
    ai_phase: state.speaking.phase,
    user_speaking: userSpeaking,
    p_now_ai: view ? round(view.p_now_ai, 4) : null,
    p_future_ai: view ? round(view.p_future_ai, 4) : null,
    vad_user: vap !== null ? round(vap.vad[0], 4) : null,
    gap_ms: gap,
    since_turn_end_ms: sinceTurnEnd,
    min_gap_ms: minGap,
    completion_p: round(p, 4),
    completion_revision: state.completion_revision,
    yield_timeout_ms: timeout,
    completion_wait_ms: wait,
    permitted_to_speak: state.permitted_to_speak,
    want_to_speak: state.want_to_speak.kind,
    invitation,
    branches,
    last_turn_allowed_reason: lastReason,
  };
}
