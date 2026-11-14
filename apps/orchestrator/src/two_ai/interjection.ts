/**
 * 本人の話し始めの検出（docs/design/two_ai/06 §7.4、01 §3.5）。純粋関数。
 *
 * - 声の連続：VAP が fresh なら vad_user ≥ vad_threshold、そうでなければ mic の dBFS ≥ fallback_dbfs（source: fallback）。
 * - onset：連続が onset_min_ms（fallback は fallback_onset_min_ms）続き、確定の tick で p_now_user と p_future_user が閾値以上
 *   （p_combine が and なら両方、or ならどちらか）。fallback は p を見ない。
 * - 発火の後 refractory_ms は次を受けない。1 つの声の連続で発火は 1 回。
 * - 条件に届かずに終わった連続（sub_threshold_min_ms 以上）は sub_threshold。
 */
import type { VapFreshness } from '@llm-vap/contracts';

export interface InterjectionSettings {
  vad_threshold: number;
  p_now_user_min: number;
  p_future_user_min: number;
  p_combine: 'and' | 'or';
  onset_min_ms: number;
  refractory_ms: number;
  fallback_dbfs: number;
  fallback_onset_min_ms: number;
  sub_threshold_min_ms: number;
}

/** sub_logged：この声の連続は扱い済み（発火した、または sub_threshold を出した）。 */
export interface InterjectionState {
  run_since: number | null;
  first_voiced_at: number | null;
  run_source: 'vap' | 'fallback' | null;
  refractory_until: number | null;
  sub_logged: boolean;
}

export interface InterjectionInput {
  /** fresh のときだけ値。 */
  vap: { p_now_user: number; p_future_user: number; vad_user: number } | null;
  vap_freshness: VapFreshness;
  mic_dbfs: number | null;
  ai_playing: boolean;
}

export type InterjectionSignal =
  | { kind: 'none'; voiced: boolean }
  | { kind: 'sub_threshold'; first_voiced_at: number; ended_at: number }
  | {
      kind: 'onset';
      source: 'vap' | 'fallback';
      first_voiced_at: number;
      detected_at: number;
      p_now_user: number | null;
      p_future_user: number | null;
      vad_user: number | null;
      mic_dbfs: number | null;
    };

export function initialInterjectionState(): InterjectionState {
  return { run_since: null, first_voiced_at: null, run_source: null, refractory_until: null, sub_logged: false };
}

export function stepInterjection(
  state: InterjectionState,
  input: InterjectionInput,
  now: number,
  settings: InterjectionSettings,
): { state: InterjectionState; signal: InterjectionSignal } {
  const vap = input.vap_freshness === 'fresh' ? input.vap : null;
  const source: 'vap' | 'fallback' | null = vap !== null ? 'vap' : input.mic_dbfs !== null ? 'fallback' : null;
  const voiced =
    source === 'vap' ? vap!.vad_user >= settings.vad_threshold : source === 'fallback' ? (input.mic_dbfs as number) >= settings.fallback_dbfs : false;

  if (!voiced) {
    if (state.run_since !== null && !state.sub_logged && now - state.run_since >= settings.sub_threshold_min_ms) {
      return {
        state: { ...state, run_since: null, first_voiced_at: null, run_source: null, sub_logged: false },
        signal: { kind: 'sub_threshold', first_voiced_at: state.first_voiced_at ?? state.run_since, ended_at: now },
      };
    }
    return { state: { ...state, run_since: null, first_voiced_at: null, run_source: null, sub_logged: false }, signal: { kind: 'none', voiced: false } };
  }

  // 声の連続の始まり（出どころが替わったら数え直す）。
  let next: InterjectionState = state;
  if (state.run_since === null || state.run_source !== source) {
    next = { ...state, run_since: now, first_voiced_at: now, run_source: source, sub_logged: false };
  }
  const inRefractory = next.refractory_until !== null && now < next.refractory_until;
  if (next.sub_logged || inRefractory) return { state: next, signal: { kind: 'none', voiced: true } };

  const duration = now - (next.run_since as number);
  const min = source === 'vap' ? settings.onset_min_ms : settings.fallback_onset_min_ms;
  if (duration < min) return { state: next, signal: { kind: 'none', voiced: true } };
  if (source === 'vap') {
    const nowOk = vap!.p_now_user >= settings.p_now_user_min;
    const futOk = vap!.p_future_user >= settings.p_future_user_min;
    const pass = settings.p_combine === 'and' ? nowOk && futOk : nowOk || futOk;
    if (!pass) return { state: next, signal: { kind: 'none', voiced: true } };
  }
  return {
    state: { ...next, sub_logged: true, refractory_until: now + settings.refractory_ms },
    signal: {
      kind: 'onset',
      source: source as 'vap' | 'fallback',
      first_voiced_at: next.first_voiced_at as number,
      detected_at: now,
      p_now_user: vap?.p_now_user ?? null,
      p_future_user: vap?.p_future_user ?? null,
      vad_user: vap?.vad_user ?? null,
      mic_dbfs: input.mic_dbfs,
    },
  };
}
