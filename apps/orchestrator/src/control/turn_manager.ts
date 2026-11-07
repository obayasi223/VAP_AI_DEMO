/**
 * TurnManager（Appendix A、計画 §4.1）。`step(state, inputs, now) -> {state, decisions[]}` の純粋関数。
 * 行番号は docs/hri2025_mapping.md §1 の原著の番号。U-n は同じ文書の未規定の項目。
 *
 * apply_u_corrections=false（hri2025）は擬似コードどおりで、U-1、U-2、U-4、U-8 の補正を入れない。
 * 次は擬似コードだけでは動かないので両方の方策で入れる: U-3（ASR.reset の定義）、U-5（Similarity(x, none)=0）、
 * U-6（tick と VAP の分離）、鮮度切れの扱い（原著にない）。
 *
 * E1 の範囲外: 候補と合図（E2a、E2）、交渉、優先度、WoZ の入力（E3）。inputs.woz はまだ読まない。
 */
import { absent, present } from '@llm-vap/contracts';
import type {
  Maybe,
  Policy,
  TurnAllowedPayload,
  TurnDecision,
  TurnInputs,
  TurnManager,
  TranscriptSnapshot,
} from '@llm-vap/contracts';
import { normalizeForSimilarity } from '../cognition/similarity';
import { judgeGaze } from './gaze';
import { NO_INVITATION, detectInvitation } from './invitation';
import { prepareTrigger, similarityGate } from './prepare';
import { START_ACK_TIMEOUT_MS, controlSettings } from './settings';
import type { ControlOptions, ControlSettings, YieldTimeout } from './settings';
import { createInitialState } from './state';
import type { Speaking, TurnState, UtteranceBuffer, WantToSpeak } from './state';
import { readVap } from './vap_direction';
import type { VapView } from './vap_direction';
import { assessVapFreshness } from './vap_freshness';

/** L86〜L92。p は 0 以上なので最後の行で必ず返る。 */
export function turnGptTimeout(p: number, table: readonly YieldTimeout[]): number {
  for (const entry of table) {
    if (p >= entry.threshold) return entry.timeout_ms;
  }
  return (table.at(-1) as YieldTimeout).timeout_ms;
}

/** 利用者の発話文の積み上げ。STT の text は final で切れるので、segment の中で連結する。 */
function appendToUtterance(buffer: UtteranceBuffer | null, t: TranscriptSnapshot): UtteranceBuffer {
  if (buffer === null || buffer.segment_id !== t.segment_id) {
    return { segment_id: t.segment_id, closed_text: '', asr_segment_id: t.asr_segment_id, current_text: t.text };
  }
  if (buffer.asr_segment_id !== t.asr_segment_id) {
    // final の is_final を見ない。tick の間に final と次の interim が来ると final を受け取れないため。
    return {
      segment_id: t.segment_id,
      closed_text: buffer.closed_text + buffer.current_text,
      asr_segment_id: t.asr_segment_id,
      current_text: t.text,
    };
  }
  return { ...buffer, current_text: t.text };
}

/**
 * step がこの transcript で見る利用者の発話文。similarity_to_prepared はこの文で求める
 * （ResponsePrefetch.similarityToPrepared(userTextFor(state, transcript), state.segment_id)）。
 */
export function userTextFor(state: TurnState, transcript: TranscriptSnapshot): string {
  const buffer = appendToUtterance(state.utterance, transcript);
  return buffer.closed_text + buffer.current_text;
}

function countWords(text: string): number {
  let count = 0;
  for (const part of new Intl.Segmenter('ja', { granularity: 'word' }).segment(text)) {
    if (part.isWordLike) count += 1;
  }
  return count;
}

function syncSpeaking(previous: Speaking, playback: TurnInputs['playback'], now: number): Speaking {
  if (playback.state === 'playing') {
    return previous.phase === 'stopping' && previous.audio_playback_id === playback.audio_playback_id
      ? previous
      : { phase: 'playing', audio_playback_id: playback.audio_playback_id };
  }
  if (previous.phase === 'starting' && now - previous.requested_at < START_ACK_TIMEOUT_MS) return previous;
  return { phase: 'silent' };
}

/** tick の間で共有する、この tick の判定材料。 */
interface Tick {
  inputs: TurnInputs;
  now: number;
  settings: ControlSettings;
  view: VapView | null;
  freshnessReason: string;
  decisions: TurnDecision[];
  /** 入力の completion_p をこの tick で採用したか。前の segment の値なら false。 */
  completionAdopted: boolean;
}

interface Permission {
  allowed: boolean;
  source: TurnAllowedPayload['decision_source'];
  reason: string;
  gap_ms: Maybe<number>;
}

function isAiSpeaking(s: TurnState): boolean {
  return s.speaking.phase !== 'silent';
}

/** 鮮度の判定と degraded の切替。復帰時は VAP がなかった間の計時を信用せず、ここから数え直す。 */
function applyFreshness(s: TurnState, tick: Tick, freshness: TurnState['vap_freshness']): void {
  const { now, decisions } = tick;
  const degraded = freshness !== 'fresh';
  // 理由の種類（down／warming_up／stale）が変わったときも出す。助走の表示と、助走後の down を画面へ反映するため。
  if (degraded !== s.degraded || (degraded && freshness !== s.vap_freshness)) {
    decisions.push({ kind: 'set_degraded', degraded, reason: tick.freshnessReason });
    if (degraded && !s.degraded) s.fallback_last_voiced_at = now;
  }
  if (!degraded && s.vap_freshness !== 'fresh') {
    s.user_speak_end_time = now;
    s.user_turn_end_time = now;
    s.user_speaking_raw = false;
    s.user_speaking_raw_since = null;
    s.user_last_voiced_at = null;
  }
  s.degraded = degraded;
  s.vap_freshness = freshness;
}

/** L37〜L42 と招待の検出。 */
function observeTranscript(s: TurnState, tick: Tick): void {
  const { inputs, now, settings } = tick;
  const t = inputs.transcript.value;
  // 境界より前の音声に属する結果は旧 segment のもの（計画 §4.1）。今のターンの入力にしない。
  if (t !== null && t.segment_id >= s.segment_id && t.transcript_revision !== s.asr_revision) {
    s.utterance = appendToUtterance(s.utterance, t);
    const text = s.utterance.closed_text + s.utterance.current_text;
    s.asr_result = normalizeForSimilarity(text) === '' ? null : text;
    s.asr_revision = t.transcript_revision;
    s.last_asr_time = now;
    const detection = detectInvitation(text, t);
    s.invitation = detection.invitation;
    s.invitation_rule_id = detection.rule_id;
  }
  // L40。推定は非同期なので入力の最新値を読む。値がなければ L28 の 0。
  const p = inputs.completion_p.value;
  const revision = inputs.completion_revision.value;
  const floor = s.completion_floor_revision;
  if (p === null) {
    s.turngpt_output = 0;
    s.completion_revision = null;
  } else if (!settings.corrected || floor === null || (revision !== null && revision > floor)) {
    s.turngpt_output = p;
    s.completion_revision = revision;
    tick.completionAdopted = true;
  }
}

/** D が報告する準備の状況を見て、古い準備の取消と、失敗した準備の再試行を判断する（U-2、U-4）。 */
function superviseCurrentPrepare(s: TurnState, tick: Tick): TurnInputs['prefetch'] {
  const { inputs, settings, decisions } = tick;
  const prefetch = inputs.prefetch;
  if (!settings.corrected) return prefetch;
  if (prefetch.state === 'idle') {
    // 準備が見えていたのに消え、再生にも入っていない。失敗や取消で、同じ文のままだと L45 が偽で二度と起動しない。
    const track = s.prepare_track;
    if (track !== null && track.audio_playback_id !== null && !isAiSpeaking(s)) {
      s.prepare_track = null;
      if (s.prepare_retried_text !== track.text && s.last_sent_asr_result === track.text) {
        s.prepare_retried_text = track.text;
        s.last_sent_asr_result = null;
      }
    }
    return prefetch;
  }
  if (s.prepare_track !== null && s.prepare_track.audio_playback_id === null) {
    s.prepare_track = { ...s.prepare_track, audio_playback_id: prefetch.audio_playback_id };
  }
  const onAir = s.speaking.phase !== 'silent' && s.speaking.audio_playback_id === prefetch.audio_playback_id;
  if (prefetch.segment_id < s.segment_id && !onAir) {
    if (s.last_cancelled_prepare_id !== prefetch.audio_playback_id) {
      decisions.push({
        kind: 'cancel_prepare',
        audio_playback_id: prefetch.audio_playback_id,
        reason: 'prepared_for_previous_segment',
      });
      s.last_cancelled_prepare_id = prefetch.audio_playback_id;
    }
    return { state: 'idle' };
  }
  return prefetch;
}

/** L45〜L54。この tick で新しい準備を起動したら true（古い準備は L78 で使えない）。 */
function decidePrepare(s: TurnState, tick: Tick, prefetch: TurnInputs['prefetch']): boolean {
  const { inputs, now, settings, decisions } = tick;
  // U-2: AI 発話中の準備は抑止する。割り込みを出した後（stopping）は再開する。
  if (settings.corrected && (s.speaking.phase === 'starting' || s.speaking.phase === 'playing')) return false;
  const text = s.asr_result;
  if (text === null || s.last_sent_asr_result === text) return false; // L45
  const trigger = prepareTrigger({
    completion_p: s.turngpt_output,
    elapsed_since_asr_ms: now - (s.last_asr_time as number),
    thresholds: settings.prepare,
    asr_prepare_timeout_ms: settings.constants.ASR_PREPARE_TIMEOUT_MS,
  }); // L46
  if (trigger === null) return false;
  const gate = similarityGate(inputs.similarity_to_prepared, settings.prepare.similarity_prepare_threshold); // L47
  s.last_prepare_gate = { at: now, gate, fired: gate.outcome === 'pass' };
  if (gate.outcome === 'block') return false;
  if (prefetch.state !== 'idle') {
    // L48。未再生の準備だけが対象（U-2）。
    decisions.push({
      kind: 'cancel_prepare',
      audio_playback_id: prefetch.audio_playback_id,
      reason: 'superseded_by_new_prepare',
    });
  }
  decisions.push({
    kind: 'prepare',
    segment_id: s.segment_id,
    transcript_revision: s.asr_revision as number,
    text,
    trigger,
    similarity: inputs.similarity_to_prepared,
  }); // L50
  s.last_sent_asr_result = text; // L51
  s.last_prepare_at = now;
  s.prepare_track = { text, audio_playback_id: null };
  return true;
}

/** U-7。min が null なら生の値のまま（原著どおり）。 */
function debounceUserSpeaking(s: TurnState, raw: boolean, now: number, minMs: number | null): boolean {
  if (raw !== s.user_speaking_raw || s.user_speaking_raw_since === null) {
    s.user_speaking_raw = raw;
    s.user_speaking_raw_since = now;
  }
  if (raw) s.user_last_voiced_at = now;
  if (minMs === null) return raw;
  return raw !== s.user_speaking && now - s.user_speaking_raw_since >= minMs ? raw : s.user_speaking;
}

function pushInterrupt(s: TurnState, tick: Tick, source: 'vap' | 'fallback', reason: string): void {
  const { settings, decisions } = tick;
  const speaking = s.speaking;
  if (speaking.phase === 'silent') return;
  if (speaking.phase === 'stopping') return; // U-8。補正なしでは stopping にならないので L60 が毎 tick 出る。
  decisions.push({
    kind: 'interrupt_speech',
    audio_playback_id: speaking.audio_playback_id,
    stop_point: settings.interpretation.stop_point,
    max_wait_ms: settings.stop_max_wait_ms,
    decision_source: source,
    reason,
  });
  if (settings.corrected) s.speaking = { phase: 'stopping', audio_playback_id: speaking.audio_playback_id };
}

/** L56〜L76。VAP が使えるとき。 */
function decideWithVap(s: TurnState, tick: Tick, view: VapView): Permission {
  const { now, settings } = tick;
  const c = settings.constants;
  const speaking = debounceUserSpeaking(s, view.user_speaking, now, settings.user_speaking_min_ms);
  s.user_speaking = speaking;
  if (speaking) {
    const voicedAt = s.user_last_voiced_at ?? now;
    s.user_speak_end_time = voicedAt; // L57
    // 計画 §4.1: 発話中も更新し、話し終えた直後の 0ms 許可を防ぐ（I-4、T9）。
    if (settings.interpretation.user_turn_end_updates_during_speech) s.user_turn_end_time = voicedAt;
    if (view.p_now_ai < c.VAP_PNOW_INTERRUPT && view.p_future_ai < c.VAP_PFUT_INTERRUPT) {
      pushInterrupt(s, tick, 'vap', `L59:p_now=${view.p_now_ai},p_future=${view.p_future_ai}`); // L59〜L60
    }
    return {
      allowed: false,
      source: 'vap',
      reason: 'user_speaking',
      gap_ms: absent('user_still_speaking'),
    };
  }
  const reasons: string[] = [];
  let source: TurnAllowedPayload['decision_source'] = 'vap';
  // L64: turn_shift_allowed は毎 tick 計算し直す。
  let allowed = false;
  if (view.p_now_ai > c.VAP_PNOW_YIELD && view.p_future_ai > c.VAP_PFUT_YIELD) {
    // L66〜L69
    if (now - (s.user_turn_end_time as number) >= c.MIN_GAP_TIME_MS) {
      allowed = true;
      reasons.push('L67_vap_yield');
    }
  } else {
    s.user_turn_end_time = now; // L71
  }
  const gap = now - (s.user_speak_end_time as number);
  if (gap >= turnGptTimeout(s.turngpt_output, settings.yield_timeouts)) {
    // L74〜L76
    if (!allowed) source = 'completion_timeout';
    allowed = true;
    reasons.push('L74_completion_timeout');
  }
  // 原著にない追加。L67 と同じ最小時間を守る。
  if (settings.invitation_grants_turn && s.invitation.detected && gap >= c.MIN_GAP_TIME_MS) {
    allowed = true;
    source = 'invitation';
    reasons.unshift(`invitation:${s.invitation_rule_id}`);
  }
  return {
    allowed,
    source,
    reason: allowed ? reasons.join('+') : 'no_yield_signal',
    gap_ms: present(gap),
  };
}

/** 鮮度切れの間（計画 §4.1 の表）。fallback_energy は VAP として扱わず、別の decision_source で残す。 */
function decideDegraded(s: TurnState, tick: Tick): Permission {
  const { inputs, now, settings } = tick;
  const energy = inputs.fallback_energy.value;
  const silenceThreshold = settings.fallback_energy_silence_threshold;
  const energyKnown = energy !== null && silenceThreshold !== null;
  const voiced = energyKnown && energy >= silenceThreshold;
  if (voiced || s.fallback_last_voiced_at === null) s.fallback_last_voiced_at = now;
  const silenceMs = now - s.fallback_last_voiced_at;
  const asrQuietMs = now - (s.last_asr_time as number);
  // user_speaking は推定。エネルギーの尺度がなければ、ASR の更新が続いているかで見る。
  s.user_speaking = energyKnown ? voiced : asrQuietMs < settings.constants.MIN_GAP_TIME_MS;

  const minWords = settings.fallback_interrupt_min_words;
  const t = inputs.transcript.value;
  if (voiced && minWords !== null && t !== null && t.segment_id === s.segment_id) {
    const words = countWords(s.asr_result ?? '');
    if (words >= minWords) {
      pushInterrupt(s, tick, 'fallback', `fallback_energy_with_new_interim:words=${words}`);
    }
  }
  const gap_ms = present(silenceMs);
  if (settings.invitation_grants_turn && s.invitation.detected && !voiced && asrQuietMs >= settings.constants.MIN_GAP_TIME_MS) {
    return { allowed: true, source: 'invitation', reason: `invitation:${s.invitation_rule_id}`, gap_ms };
  }
  const maxSilence = settings.fallback_silence_max_ms;
  if (energyKnown && maxSilence !== null && !voiced && silenceMs >= maxSilence) {
    return { allowed: true, source: 'fallback', reason: 'fallback_silence_max', gap_ms };
  }
  return { allowed: false, source: 'fallback', reason: `degraded:${tick.freshnessReason}`, gap_ms };
}

function buildTurnAllowed(s: TurnState, tick: Tick, permission: Permission): TurnAllowedPayload {
  const { inputs, settings, view } = tick;
  const noVap = absent(`vap_${s.vap_freshness}`);
  const noCompletion = absent(
    inputs.completion_p.value === null ? inputs.completion_p.null_reason : 'completion_from_previous_segment',
  );
  return {
    turn_allowed: permission.allowed,
    invitation: s.invitation,
    user_speaking: s.user_speaking,
    p_now: view ? present(view.p_now_ai) : noVap,
    p_future: view ? present(view.p_future_ai) : noVap,
    completion_p: tick.completionAdopted ? inputs.completion_p : noCompletion,
    completion_revision: tick.completionAdopted ? inputs.completion_revision : noCompletion,
    gap_ms: permission.gap_ms,
    priority: absent('priority_not_implemented_until_e3'),
    policy_id: settings.policy_id,
    decision_source: permission.source,
    vap_freshness: s.vap_freshness,
    fallback_energy: view ? absent('vap_is_fresh') : inputs.fallback_energy,
    reason: permission.reason,
  };
}

function pushGaze(s: TurnState, tick: Tick): void {
  const { inputs, settings, view, decisions } = tick;
  const playback = inputs.playback;
  const judgement = judgeGaze({
    settings: settings.gaze,
    ai_playing: playback.state === 'playing',
    interrupted: s.speaking.phase === 'stopping',
    system_silence_ms: playback.state === 'playing' ? playback.system_silence_ms : 0,
    freshness: s.vap_freshness,
    view,
    user_speaking: s.user_speaking,
    previous_target: s.gaze_target,
  });
  // 向きの変化に加え、ポーズごとに最初の判定を1回残す（譲渡なしの判定もログから確かめられるように）。
  const firstInPause = judgement.evaluated && !s.gaze_pause_logged;
  if (judgement.target !== s.gaze_target || firstInPause) {
    decisions.push({
      kind: 'gaze',
      payload: {
        target: judgement.target,
        reason: judgement.reason,
        p_now: view ? present(view.p_now_ai) : absent(`vap_${s.vap_freshness}`),
        p_future: view ? present(view.p_future_ai) : absent(`vap_${s.vap_freshness}`),
        in_speech_pause: judgement.in_speech_pause,
        vap_freshness: s.vap_freshness,
      },
    });
  }
  s.gaze_target = judgement.target;
  s.gaze_pause_logged = judgement.in_speech_pause && (s.gaze_pause_logged || judgement.evaluated);
}

function step(settings: ControlSettings, previous: TurnState, inputs: TurnInputs, now: number) {
  const s: TurnState = { ...previous };
  const decisions: TurnDecision[] = [];
  // L23〜L25
  s.user_speak_end_time ??= now;
  s.user_turn_end_time ??= now;
  s.last_asr_time ??= now;

  const freshness = assessVapFreshness(inputs, now, settings);
  const vap = inputs.vap.value;
  const view = freshness.freshness === 'fresh' && vap !== null ? readVap(vap, settings.direction) : null;
  const tick: Tick = { inputs, now, settings, view, freshnessReason: freshness.reason, decisions, completionAdopted: false };

  applyFreshness(s, tick, freshness.freshness);
  s.speaking = syncSpeaking(s.speaking, inputs.playback, now);
  observeTranscript(s, tick);

  const prefetch = superviseCurrentPrepare(s, tick);
  const preparedNow = decidePrepare(s, tick, prefetch);

  const permission = view ? decideWithVap(s, tick, view) : decideDegraded(s, tick);
  // U-1: 話している間は許可しない。補正なしでは L78 のとおり is_speaking を見ない。
  if (settings.corrected && permission.allowed && isAiSpeaking(s)) {
    permission.allowed = false;
    permission.reason = 'ai_speaking';
  }
  s.permitted_to_speak = permission.allowed;

  // L48 で取り消した準備はこの tick では is_ready ではない。前の segment の準備は上で idle にしてある（U-4）。
  const usable: WantToSpeak =
    prefetch.state === 'ready' && !preparedNow
      ? { kind: 'response', audio_playback_id: prefetch.audio_playback_id, segment_id: prefetch.segment_id }
      : { kind: 'none' };
  s.want_to_speak = usable;

  // L78。再生を始められない間（切断中など）は is_ready と同じく偽にする。segment を進めず、応答を失わない。
  const startBlocked = inputs.start_blocked_reason ?? null;
  const starting = s.permitted_to_speak && usable.kind !== 'none' && startBlocked === null;
  const key = `${permission.allowed}:${permission.source}`;
  if (key !== s.last_turn_allowed_key || starting) {
    decisions.push({ kind: 'turn_allowed', payload: buildTurnAllowed(s, tick, permission) });
    s.last_turn_allowed_key = key;
  }
  if (usable.kind !== 'none' && starting) {
    decisions.push({ kind: 'start_speech', audio_playback_id: usable.audio_playback_id }); // L79
    s.speaking = { phase: 'starting', audio_playback_id: usable.audio_playback_id, requested_at: now };
    s.segment_id += 1;
    decisions.push({
      kind: 'advance_segment',
      new_segment_id: s.segment_id,
      at_audio_frame: inputs.received_audio_frame,
    }); // L80（U-3）
    s.utterance = null;
    s.invitation = NO_INVITATION;
    s.invitation_rule_id = null;
    s.prepare_track = null;
    s.want_to_speak = { kind: 'none' };
    if (settings.corrected) {
      // U-4
      s.asr_result = null;
      s.last_sent_asr_result = null;
      s.turngpt_output = 0;
      s.completion_revision = null;
      s.completion_floor_revision = s.asr_revision ?? -1;
      s.prepare_retried_text = null;
    }
  }
  s.mode = isAiSpeaking(s) ? 'ai_speaking' : 'listening';
  pushGaze(s, tick);
  return { state: s, decisions };
}

/** TurnManagerFactory の形。options は契約に尺度がない fallback_energy の閾値だけ（settings.ts）。 */
export function createTurnManager(policy: Policy, options: ControlOptions = {}): TurnManager<TurnState> & {
  settings: ControlSettings;
} {
  const settings = controlSettings(policy, options);
  return {
    settings,
    initialState: createInitialState,
    step: (state, inputs, now) => step(settings, state, inputs, now),
  };
}
