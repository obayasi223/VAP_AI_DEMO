/**
 * 本人の話し始めの検出（docs/design/two_ai/06 §7.4、01 §3.5）。純粋関数。
 *
 * - 声の連続：VAP が fresh なら vad_user ≥ vad_threshold、そうでなければ mic の dBFS ≥ fallback_dbfs（source: fallback）。
 * - onset：連続が onset_min_ms（fallback は fallback_onset_min_ms）続き、確定の tick で p_now_user と p_future_user が閾値以上
 *   （p_combine が and なら両方、or ならどちらか）。fallback は p を見ない。
 * - 重なりの中（ai_playing、overlap.enabled）：
 *   - 閾値の差し替え：overlap.p_now_user_min／p_future_user_min（null は通常の値）。rule: overlap_threshold。
 *   - 持続の経路：声の連続が overlap.sustain_ms 続き、連続の中の p_now_user の平均が sustain_p_now_mean_min 以上なら、
 *     p の閾値を見ずに onset（rule: overlap_sustain）。相づち・咳・息は短いので届かない。AI の声のエコーで vad_user だけが
 *     上がる場合は、VAP が人の側の p_now を低く見るので平均で落とす。mic_dbfs_min はさらに mic の音量の下限を課す（任意）。
 * - 発火の後 refractory_ms は次を受けない。1 つの声の連続で発火は 1 回。
 * - 条件に届かずに終わった連続（sub_threshold_min_ms 以上）は sub_threshold。
 * - 試み（attempt）：声の連続を merge_gap_ms 未満の切れ目でつないだまとまり。始まりと終わりを attempt で知らせ、
 *   終わりに声の長さ、重なりの長さ、p の最大値、onset の有無を渡す（進行役が two_ai.interjection_attempt にする）。
 */
import type { VapFreshness } from '@llm-vap/contracts';

export interface OverlapDetectorSettings {
  enabled: boolean;
  p_now_user_min: number | null;
  p_future_user_min: number | null;
  /** null は持続の経路を使わない。 */
  sustain_ms: number | null;
  sustain_p_now_mean_min: number;
  mic_dbfs_min: number | null;
}

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
  overlap: OverlapDetectorSettings;
  /** 試みの中の声の切れ目の上限（これ以上静かなら試みを閉じる）。 */
  attempt_merge_gap_ms: number;
}

export const OVERLAP_OFF: OverlapDetectorSettings = { enabled: false, p_now_user_min: null, p_future_user_min: null, sustain_ms: null, sustain_p_now_mean_min: 0.4, mic_dbfs_min: null };

export type OnsetRule = 'p_threshold' | 'overlap_threshold' | 'overlap_sustain' | 'fallback';

/** 進行中の試み（声の連続のまとまり）。 */
export interface AttemptAccum {
  started_at: number;
  last_voiced_at: number;
  last_tick_at: number;
  prev_voiced: boolean;
  voiced_ms: number;
  overlap_ms: number;
  ai_playing_at_start: boolean;
  p_now_user_max: number | null;
  p_future_user_max: number | null;
  vad_user_max: number | null;
  mic_dbfs_max: number | null;
  onset: { at: number; rule: OnsetRule } | null;
}

/** sub_logged：この声の連続は扱い済み（発火した、または sub_threshold を出した）。 */
export interface InterjectionState {
  run_since: number | null;
  first_voiced_at: number | null;
  run_source: 'vap' | 'fallback' | null;
  refractory_until: number | null;
  sub_logged: boolean;
  /** 連続の中の p_now_user の和と数（持続の経路の平均）。 */
  run_p_now_sum: number;
  run_p_now_n: number;
  attempt: AttemptAccum | null;
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
      rule: OnsetRule;
      first_voiced_at: number;
      detected_at: number;
      p_now_user: number | null;
      p_future_user: number | null;
      vad_user: number | null;
      mic_dbfs: number | null;
    };

export interface AttemptStats {
  started_at: number;
  ended_at: number;
  voiced_ms: number;
  overlap_ms: number;
  ai_playing_at_start: boolean;
  p_now_user_max: number | null;
  p_future_user_max: number | null;
  vad_user_max: number | null;
  mic_dbfs_max: number | null;
  onset: { at: number; rule: OnsetRule } | null;
}

export type AttemptUpdate = { kind: 'started'; started_at: number; ai_playing: boolean } | { kind: 'ended'; stats: AttemptStats };

export function initialInterjectionState(): InterjectionState {
  return { run_since: null, first_voiced_at: null, run_source: null, refractory_until: null, sub_logged: false, run_p_now_sum: 0, run_p_now_n: 0, attempt: null };
}

const maxOf = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : Math.max(a, b));

function closeAttempt(a: AttemptAccum): AttemptStats {
  return {
    started_at: a.started_at,
    ended_at: a.last_voiced_at,
    voiced_ms: Math.round(a.voiced_ms),
    overlap_ms: Math.round(a.overlap_ms),
    ai_playing_at_start: a.ai_playing_at_start,
    p_now_user_max: a.p_now_user_max,
    p_future_user_max: a.p_future_user_max,
    vad_user_max: a.vad_user_max,
    mic_dbfs_max: a.mic_dbfs_max,
    onset: a.onset,
  };
}

/** 試みの集計（声の tick ごと、静かな tick ごと）。 */
function stepAttempt(
  prev: AttemptAccum | null,
  voiced: boolean,
  input: InterjectionInput,
  vap: InterjectionInput['vap'],
  now: number,
  settings: InterjectionSettings,
): { attempt: AttemptAccum | null; update: AttemptUpdate | null } {
  if (!voiced) {
    if (prev === null) return { attempt: null, update: null };
    if (now - prev.last_voiced_at >= settings.attempt_merge_gap_ms) return { attempt: null, update: { kind: 'ended', stats: closeAttempt(prev) } };
    return { attempt: { ...prev, last_tick_at: now, prev_voiced: false }, update: null };
  }
  const mic = input.mic_dbfs;
  if (prev === null) {
    return {
      attempt: {
        started_at: now,
        last_voiced_at: now,
        last_tick_at: now,
        prev_voiced: true,
        voiced_ms: 0,
        overlap_ms: 0,
        ai_playing_at_start: input.ai_playing,
        p_now_user_max: vap?.p_now_user ?? null,
        p_future_user_max: vap?.p_future_user ?? null,
        vad_user_max: vap?.vad_user ?? null,
        mic_dbfs_max: mic,
        onset: null,
      },
      update: { kind: 'started', started_at: now, ai_playing: input.ai_playing },
    };
  }
  const dt = prev.prev_voiced ? Math.max(0, now - prev.last_tick_at) : 0;
  return {
    attempt: {
      ...prev,
      last_voiced_at: now,
      last_tick_at: now,
      prev_voiced: true,
      voiced_ms: prev.voiced_ms + dt,
      overlap_ms: prev.overlap_ms + (input.ai_playing ? dt : 0),
      p_now_user_max: maxOf(prev.p_now_user_max, vap?.p_now_user ?? null),
      p_future_user_max: maxOf(prev.p_future_user_max, vap?.p_future_user ?? null),
      vad_user_max: maxOf(prev.vad_user_max, vap?.vad_user ?? null),
      mic_dbfs_max: maxOf(prev.mic_dbfs_max, mic),
    },
    update: null,
  };
}

export function stepInterjection(
  state: InterjectionState,
  input: InterjectionInput,
  now: number,
  settings: InterjectionSettings,
): { state: InterjectionState; signal: InterjectionSignal; attempt: AttemptUpdate | null } {
  const vap = input.vap_freshness === 'fresh' ? input.vap : null;
  const source: 'vap' | 'fallback' | null = vap !== null ? 'vap' : input.mic_dbfs !== null ? 'fallback' : null;
  const voiced =
    source === 'vap' ? vap!.vad_user >= settings.vad_threshold : source === 'fallback' ? (input.mic_dbfs as number) >= settings.fallback_dbfs : false;
  const att = stepAttempt(state.attempt, voiced, input, vap, now, settings);

  if (!voiced) {
    const cleared = { ...state, run_since: null, first_voiced_at: null, run_source: null, sub_logged: false, run_p_now_sum: 0, run_p_now_n: 0, attempt: att.attempt };
    if (state.run_since !== null && !state.sub_logged && now - state.run_since >= settings.sub_threshold_min_ms) {
      return { state: cleared, signal: { kind: 'sub_threshold', first_voiced_at: state.first_voiced_at ?? state.run_since, ended_at: now }, attempt: att.update };
    }
    return { state: cleared, signal: { kind: 'none', voiced: false }, attempt: att.update };
  }

  // 声の連続の始まり（出どころが替わったら数え直す）。
  let next: InterjectionState = { ...state, attempt: att.attempt };
  if (state.run_since === null || state.run_source !== source) {
    next = { ...next, run_since: now, first_voiced_at: now, run_source: source, sub_logged: false, run_p_now_sum: 0, run_p_now_n: 0 };
  }
  if (vap !== null) next = { ...next, run_p_now_sum: next.run_p_now_sum + vap.p_now_user, run_p_now_n: next.run_p_now_n + 1 };
  const inRefractory = next.refractory_until !== null && now < next.refractory_until;
  if (next.sub_logged || inRefractory) return { state: next, signal: { kind: 'none', voiced: true }, attempt: att.update };

  const duration = now - (next.run_since as number);
  const ov = settings.overlap;
  const overlapOn = ov.enabled && input.ai_playing;
  let rule: OnsetRule = source === 'vap' ? 'p_threshold' : 'fallback';
  if (source === 'vap') {
    const pNowMin = overlapOn && ov.p_now_user_min !== null ? ov.p_now_user_min : settings.p_now_user_min;
    const pFutMin = overlapOn && ov.p_future_user_min !== null ? ov.p_future_user_min : settings.p_future_user_min;
    const pass = (nowMin: number, futMin: number) => {
      const nowOk = vap!.p_now_user >= nowMin;
      const futOk = vap!.p_future_user >= futMin;
      return settings.p_combine === 'and' ? nowOk && futOk : nowOk || futOk;
    };
    const micOk = ov.mic_dbfs_min === null || (input.mic_dbfs !== null && input.mic_dbfs >= ov.mic_dbfs_min);
    if (duration >= settings.onset_min_ms && pass(settings.p_now_user_min, settings.p_future_user_min)) {
      rule = 'p_threshold';
    } else if (overlapOn && micOk && duration >= settings.onset_min_ms && pass(pNowMin, pFutMin)) {
      rule = 'overlap_threshold';
    } else if (
      overlapOn &&
      micOk &&
      ov.sustain_ms !== null &&
      duration >= ov.sustain_ms &&
      next.run_p_now_n > 0 &&
      next.run_p_now_sum / next.run_p_now_n >= ov.sustain_p_now_mean_min
    ) {
      rule = 'overlap_sustain';
    } else {
      return { state: next, signal: { kind: 'none', voiced: true }, attempt: att.update };
    }
  } else if (duration < settings.fallback_onset_min_ms) {
    return { state: next, signal: { kind: 'none', voiced: true }, attempt: att.update };
  }
  const attempt = next.attempt !== null && next.attempt.onset === null ? { ...next.attempt, onset: { at: now, rule } } : next.attempt;
  return {
    state: { ...next, attempt, sub_logged: true, refractory_until: now + settings.refractory_ms },
    signal: {
      kind: 'onset',
      source: source as 'vap' | 'fallback',
      rule,
      first_voiced_at: next.first_voiced_at as number,
      detected_at: now,
      p_now_user: vap?.p_now_user ?? null,
      p_future_user: vap?.p_future_user ?? null,
      vad_user: vap?.vad_user ?? null,
      mic_dbfs: input.mic_dbfs,
    },
    attempt: att.update,
  };
}
