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
  StartGuard,
  TurnAllowedPayload,
  TurnDecision,
  TurnInputs,
  TurnManager,
  TranscriptSnapshot,
  VapUnavailable,
} from '@llm-vap/contracts';
import { normalizeForSimilarity } from '../cognition/similarity';
import { judgeGaze } from './gaze';
import { NO_INVITATION, detectInvitation } from './invitation';
import { prepareTrigger, similarityGate } from './prepare';
import { START_ACK_TIMEOUT_MS, asrSettleMs, controlSettings, vapUnavailableInvitationWaitMs, vapUnavailableStartWaitMs } from './settings';
import type { AfterAiSpeechSettings, ControlOptions, ControlSettings, YieldTimeout } from './settings';
import { createInitialState } from './state';
import type { IgnoredFragment, Speaking, TurnState, UtteranceBuffer, WantToSpeak } from './state';
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
function appendToUtterance(buffer: UtteranceBuffer | null, t: TranscriptSnapshot, aiSpeaking = false): UtteranceBuffer {
  if (buffer === null || buffer.segment_id !== t.segment_id) {
    return {
      segment_id: t.segment_id,
      closed_text: '',
      asr_segment_id: t.asr_segment_id,
      current_text: t.text,
      started_during_ai: aiSpeaking,
    };
  }
  if (buffer.asr_segment_id !== t.asr_segment_id) {
    // final の is_final を見ない。tick の間に final と次の interim が来ると final を受け取れないため。
    return {
      ...buffer,
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
  /** turn_allowed を出し直す単位（数値を除いた判断の種類）。省略は allowed と source の変化だけで出す。 */
  logKey?: string;
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
    s.utterance = appendToUtterance(s.utterance, t, isAiSpeaking(s));
    const text = s.utterance.closed_text + s.utterance.current_text;
    s.asr_result = normalizeForSimilarity(text) === '' ? null : text;
    // 断片から文が伸びたら、新しい発話として扱う（after_ai_speech）。
    if (s.ignored_fragment !== null && !isIgnoredFragment(s, text)) s.ignored_fragment = null;
    s.asr_revision = t.transcript_revision;
    s.last_asr_time = now;
    s.asr_is_final = t.is_final;
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
  // 原著にない: AI の発話中の短い断片には応答を準備しない（after_ai_speech）。
  if (isIgnoredFragment(s, text)) return false;
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
  if (view.user_speaking && settings.vap_unavailable !== null) s.voice_evidence_segment = s.segment_id;
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
  const guard = settings.start_guard;
  // 原著にない（ja の start_guard）: どの経路でも最小の間を延ばす。null なら MIN_GAP_TIME のまま。
  const minGap = Math.max(c.MIN_GAP_TIME_MS, guard?.min_gap_ms ?? 0);
  // L64: turn_shift_allowed は毎 tick 計算し直す。
  let allowed = false;
  if (view.p_now_ai > c.VAP_PNOW_YIELD && view.p_future_ai > c.VAP_PFUT_YIELD) {
    // L66〜L69
    if (now - (s.user_turn_end_time as number) >= minGap) {
      allowed = true;
      reasons.push('L67_vap_yield');
    }
  } else {
    s.user_turn_end_time = now; // L71
  }
  const gap = now - (s.user_speak_end_time as number);
  const timeout = turnGptTimeout(s.turngpt_output, settings.yield_timeouts);
  const wait = completionTimeoutWait(timeout, guard, view.p_now_ai);
  if (gap >= wait) {
    // L74〜L76
    if (!allowed) source = 'completion_timeout';
    allowed = true;
    reasons.push('L74_completion_timeout');
    if (wait > timeout) reasons.push(`start_guard:wait=${wait}ms`);
  }
  // 原著にない追加。L67 と同じ最小時間を守る。
  if (settings.invitation_grants_turn && s.invitation.detected && gap >= minGap) {
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

/**
 * L74 の待ち。原著は turnGptTimeout(p) のまま。ja の start_guard は最小の間を延ばし、VAP が AI 側を支持して
 * いない（p_now_ai が下限未満）ときはさらに長く待つ。ja_rules_v1 の p は TurnGPT と尺度が違い、
 * 話の途中の言い切り（「〜ですね」）でも 0.75 を返すため（docs/known_gaps.md §10）。
 */
function completionTimeoutWait(timeout: number, guard: StartGuard | null, pNowAi: number): number {
  if (guard === null) return timeout;
  let wait = Math.max(timeout, guard.min_gap_ms);
  if (pNowAi < guard.completion_timeout_min_p_ai) wait = Math.max(wait, guard.completion_timeout_low_p_min_ms);
  return wait;
}

/** after_ai_speech: 今の文が応答の対象にしない断片か。 */
function isIgnoredFragment(s: TurnState, text: string): boolean {
  const f = s.ignored_fragment;
  return f !== null && f.segment_id === s.segment_id && normalizeForSimilarity(f.text) === normalizeForSimilarity(text);
}

/** 断片とみなす理由。対象でなければ null。 */
export function fragmentReason(text: string, after: AfterAiSpeechSettings): string | null {
  const normalized = normalizeForSimilarity(text);
  if (normalized === '') return null;
  const chars = [...normalized].length;
  if (chars <= after.fragment_max_chars) return `short:chars=${chars}`;
  let rest = normalized;
  while (rest !== '') {
    const phrase = after.backchannel_phrases.find((p) => rest.startsWith(p));
    if (phrase === undefined) return null;
    rest = rest.slice(phrase.length);
  }
  return `backchannel:chars=${chars}`;
}

/**
 * AI の発話が終わった tick（原著にない、ja の after_ai_speech）。
 *  - 利用者の発話の終わりの時刻を AI の発話の終わりへ数え直す。AI の発話中の利用者の声で L74 の待ちが
 *    満ちていて、話し終えた直後に AI が続けて話し始めるのを防ぐ。
 *  - 自然に終わったとき、AI の発話中に始まり、もう止んでいる短い断片（相槌など）を応答の対象から外す。
 *    割り込みで止めた後（stopping から）は外さない（人が発話権を取ろうとした）。
 */
function onAiSpeechEnded(s: TurnState, tick: Tick, natural: boolean): void {
  const after = tick.settings.after_ai_speech;
  if (after === null) return;
  const { now } = tick;
  if (after.rebase_user_end_times) {
    s.user_speak_end_time = Math.max(s.user_speak_end_time as number, now);
    s.user_turn_end_time = Math.max(s.user_turn_end_time as number, now);
  }
  const u = s.utterance;
  const text = s.asr_result;
  if (!natural || s.user_speaking || u === null || text === null) return;
  if (u.segment_id !== s.segment_id || u.started_during_ai !== true) return;
  const reason = fragmentReason(text, after);
  if (reason === null) return;
  s.ignored_fragment = { segment_id: s.segment_id, text, transcript_revision: s.asr_revision, reason, at: now };
}

/** 受信済み音声の先頭の進みを見る（ja の vap_unavailable）。上りが止まると fallback_energy は最後の値のまま変わらない。 */
function observeUplink(s: TurnState, tick: Tick): void {
  if (tick.inputs.received_audio_frame !== s.uplink_frame) {
    s.uplink_frame = tick.inputs.received_audio_frame;
    s.uplink_advanced_at = tick.now;
  }
}

function uplinkFresh(s: TurnState, tick: Tick): boolean {
  return s.uplink_advanced_at !== null && tick.now - s.uplink_advanced_at <= tick.settings.vap_stale_ms;
}

interface StartBlock {
  /** ログの出し直しの単位（数値を含まない）。 */
  key: string;
  detail: string;
}

/**
 * VAP が使えないときに開始してよいか（ja の vap_unavailable）。人の発話が確かに終わったと音声と ASR で言えるまで止める。
 * 止める理由を返し、許可なら null。VAP の値は見ない。
 */
function vapUnavailableStartBlock(
  s: TurnState,
  tick: Tick,
  guard: VapUnavailable,
  energy: { known: boolean; voiced: boolean; silenceMs: number },
  requiredSilenceMs: number,
): StartBlock | null {
  if (!energy.known) return { key: 'energy_unavailable', detail: 'energy_unavailable' };
  // 文のない許可を出さない。発話候補も turn_allowed で話し始める。
  if (s.asr_result === null) return { key: 'no_utterance', detail: 'no_utterance' };
  if (s.voice_evidence_segment !== s.segment_id) return { key: 'no_voice_evidence', detail: 'no_voice_evidence' };
  if (energy.voiced || energy.silenceMs < requiredSilenceMs) {
    return { key: 'wait_silence', detail: `wait_silence:${energy.silenceMs}ms<${requiredSilenceMs}ms` };
  }
  const quietMs = tick.now - (s.last_asr_time as number);
  const needMs = asrSettleMs(guard, s.asr_is_final);
  if (quietMs < needMs) return { key: 'wait_asr', detail: `wait_asr:${quietMs}ms<${needMs}ms` };
  return null;
}

/** fallback の割り込みを止める理由（新しい発話の内容がない、相槌だけ）。ja の vap_unavailable のときだけ見る。 */
function fallbackInterruptHold(s: TurnState, tick: Tick, guard: VapUnavailable): StartBlock | null {
  const quietMs = tick.now - (s.last_asr_time as number);
  if (quietMs > guard.interrupt_asr_recent_ms) {
    return { key: 'asr_not_recent', detail: `asr_not_recent:${quietMs}ms>${guard.interrupt_asr_recent_ms}ms` };
  }
  const after = tick.settings.after_ai_speech;
  const fragment = after === null ? null : fragmentReason(s.asr_result ?? '', after);
  return fragment === null ? null : { key: 'backchannel_only', detail: `backchannel_only:${fragment}` };
}

/** ja の vap_unavailable の開始の判断。hri2025 と省略のときは decideDegraded の元の分岐のまま。 */
function decideVapUnavailableStart(
  s: TurnState,
  tick: Tick,
  guard: VapUnavailable,
  energy: { known: boolean; voiced: boolean; silenceMs: number },
  interruptHold: StartBlock | null,
): Permission {
  const { settings } = tick;
  const gap_ms = present(energy.silenceMs);
  const note = `vap_unavailable:${tick.freshnessReason}`;
  if (isAiSpeaking(s)) {
    const held = interruptHold === null ? '' : `|interrupt_held:${interruptHold.detail}`;
    return {
      allowed: false,
      source: 'fallback',
      reason: `degraded:${tick.freshnessReason}|ai_speaking${held}`,
      gap_ms,
      logKey: `ai_speaking:${interruptHold?.key ?? 'none'}`,
    };
  }
  const asrNote = `asr_${s.asr_is_final ? 'final' : 'quiet'}`;
  if (settings.invitation_grants_turn && s.invitation.detected) {
    const wait = vapUnavailableInvitationWaitMs(settings);
    if (vapUnavailableStartBlock(s, tick, guard, energy, wait) === null) {
      return {
        allowed: true,
        source: 'invitation',
        reason: `invitation:${s.invitation_rule_id}+wait=${wait}ms+${asrNote}+${note}`,
        gap_ms,
        logKey: 'invitation',
      };
    }
  }
  let block: StartBlock = { key: 'uncalibrated', detail: 'fallback_silence_max_uncalibrated' };
  if (settings.fallback_silence_max_ms !== null) {
    const wait = vapUnavailableStartWaitMs(settings);
    const blocked = vapUnavailableStartBlock(s, tick, guard, energy, wait);
    if (blocked === null) {
      return {
        allowed: true,
        source: 'fallback',
        reason: `fallback_silence_max+wait=${wait}ms+${asrNote}+${note}`,
        gap_ms,
        logKey: 'fallback_start',
      };
    }
    block = blocked;
  }
  return { allowed: false, source: 'fallback', reason: `degraded:${tick.freshnessReason}|${block.detail}`, gap_ms, logKey: block.key };
}

/** 鮮度切れの間（計画 §4.1 の表）。fallback_energy は VAP として扱わず、別の decision_source で残す。 */
function decideDegraded(s: TurnState, tick: Tick): Permission {
  const { inputs, now, settings } = tick;
  const guard = settings.vap_unavailable;
  const energy = inputs.fallback_energy.value;
  const silenceThreshold = settings.fallback_energy_silence_threshold;
  // 上りが止まったら古いエネルギーを無音や声の根拠にしない（ja）。
  const energyKnown = energy !== null && silenceThreshold !== null && (guard === null || uplinkFresh(s, tick));
  const voiced = energyKnown && energy >= silenceThreshold;
  if (voiced || s.fallback_last_voiced_at === null || (guard !== null && !energyKnown)) s.fallback_last_voiced_at = now;
  if (voiced && guard !== null) s.voice_evidence_segment = s.segment_id;
  const silenceMs = now - s.fallback_last_voiced_at;
  const asrQuietMs = now - (s.last_asr_time as number);
  // user_speaking は推定。エネルギーの尺度がなければ、ASR の更新が続いているかで見る。
  s.user_speaking = energyKnown ? voiced : asrQuietMs < settings.constants.MIN_GAP_TIME_MS;

  const minWords = settings.fallback_interrupt_min_words;
  const t = inputs.transcript.value;
  let interruptHold: StartBlock | null = null;
  if (minWords !== null && t !== null && t.segment_id === s.segment_id) {
    const words = countWords(s.asr_result ?? '');
    if (words >= minWords) {
      interruptHold = guard === null ? null : fallbackInterruptHold(s, tick, guard);
      if (voiced && interruptHold === null) {
        const detail = guard === null ? '' : `+asr_quiet=${asrQuietMs}ms+vap_unavailable:${tick.freshnessReason}`;
        pushInterrupt(s, tick, 'fallback', `fallback_energy_with_new_interim:words=${words}${detail}`);
      }
    }
  }
  if (guard !== null) {
    return decideVapUnavailableStart(s, tick, guard, { known: energyKnown, voiced, silenceMs }, interruptHold);
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
    now: tick.now,
    changed_at: s.gaze_changed_at,
    pause_evaluated: s.gaze_pause_logged,
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
  if (judgement.target !== s.gaze_target) s.gaze_changed_at = tick.now;
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

  const trust = settings.vap_unavailable === null
    ? null
    : { direction_status: settings.direction.direction_status, ai_reference_missing_ms: settings.vap_unavailable.ai_reference_missing_ms };
  const freshness = assessVapFreshness(inputs, now, settings, trust);
  const vap = inputs.vap.value;
  const view = freshness.freshness === 'fresh' && vap !== null ? readVap(vap, settings.direction) : null;
  const tick: Tick = { inputs, now, settings, view, freshnessReason: freshness.reason, decisions, completionAdopted: false };

  if (settings.vap_unavailable !== null) observeUplink(s, tick);
  applyFreshness(s, tick, freshness.freshness);
  const speakingBefore: Speaking['phase'] = s.speaking.phase;
  s.speaking = syncSpeaking(s.speaking, inputs.playback, now);
  const speakingAfter: Speaking['phase'] = s.speaking.phase;
  observeTranscript(s, tick);
  if ((speakingBefore === 'playing' || speakingBefore === 'stopping') && speakingAfter === 'silent') {
    onAiSpeechEnded(s, tick, speakingBefore === 'playing');
  }

  const prefetch = superviseCurrentPrepare(s, tick);
  const preparedNow = decidePrepare(s, tick, prefetch);

  const permission = view ? decideWithVap(s, tick, view) : decideDegraded(s, tick);
  // U-1: 話している間は許可しない。補正なしでは L78 のとおり is_speaking を見ない。
  if (settings.corrected && permission.allowed && isAiSpeaking(s)) {
    permission.allowed = false;
    permission.reason = 'ai_speaking';
  }
  // 許可は出ても、断片には準備しないので話し始めない。ログで分かるように理由を足す。
  if (permission.allowed && s.asr_result !== null && isIgnoredFragment(s, s.asr_result)) {
    permission.reason += `+ignored_ai_speech_fragment:${(s.ignored_fragment as IgnoredFragment).reason}`;
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
  const key =
    permission.logKey === undefined
      ? `${permission.allowed}:${permission.source}`
      : `${permission.allowed}:${permission.source}:${s.vap_freshness}:${permission.logKey}`;
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
    s.asr_is_final = false;
    s.ignored_fragment = null;
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
