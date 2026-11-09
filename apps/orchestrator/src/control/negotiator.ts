/**
 * 発話希望の交渉（E2 の合図のゲートと E3 の発話の選択、計画 §4.6）。純粋関数で、状態は呼び手が持つ。
 *
 * want_to_speak（候補、E2a の CandidateLedger が正本）、permitted_to_speak（TurnManager の turn_allowed）、
 * speaking（再生の報告）は別の変数のまま。ここはどれも作らず、読んだ値から「合図を出すか」「どちらを話すか」を決めて
 * 理由を返すだけ。NEW は発話の許可ではない。許可の判定そのもの（VAP など）は TurnManager のまま変えない。
 *
 * 研究条件（計画 §4.6 末尾）。候補の生成までは3条件とも同じ経路で、違いはここの設定だけ。
 *  - reactive          : 候補は記録するが、合図も発話もしない（通常の応答だけ）。
 *  - initiative_inhale : 合図（吸気1回）→ 準備姿勢 → 許可で発話。人が話し続けたら DEFERRED（脱力）、
 *                        DEFERRED からは再吸気せず、許可が出たら話す。吸気中は通常の応答も含めて開始を保留する。
 *  - initiative_no_cue : initiative_inhale と同じ制御（影の合図）。違いは参加者に見せないことだけ。
 *
 * 影の合図（shadow cue）: 比較で合図の効果だけを取り出すため、initiative_no_cue の候補も同じ状態遷移、ゲート、冷却時間、
 * inhale_ms と hold_max_ms、DEFERRED、開始の保留を通る。ここは両条件で同じ動作を返し、提示するかどうかは配線
 * （negotiation_wiring.ts）だけが presentsCue で分ける。状態の名前（BREATH_*）は提示を意味しない。提示したかは
 * signal.sent／signal.started／signal.ended の有無で読む。影の合図の記録は outcome が shadow_cue、reasons に
 * not_presented:initiative_no_cue、cue_id の頭が shadow_（docs/initiative_v3_design.md §2）。
 */
import type { CandidateState, Condition, Invitation, TimingVerdict } from '@llm-vap/contracts';
import { normalizeForSimilarity } from '../cognition/similarity';

export interface NegotiatorSettings {
  condition: Condition;
  /** 吸気の長さ。orchestrator が決めて合図に入れ、完了は orchestrator の時計で判定する。 */
  inhale_ms: number;
  /** 吸気の後の準備姿勢の長さ。過ぎた時点で人が話していれば DEFERRED。 */
  hold_max_ms: number;
  /** 合図の冷却時間。null（未校正）なら合図しない。 */
  signal_cooldown_ms: number | null;
  max_active_candidates: number;
  /** 判定の古さの上限（候補の最後の判定の入力以降の新規の安定文字数）。 */
  max_new_stable_chars_since_judgement: number;
  /** 合図の直前の鮮度（候補の最後の判定を受けてからの ms）。 */
  cue_max_judgement_age_ms: number;
  /**
   * 二段判定か（docs/initiative_v3_design.md）。true なら合図にタイミング段の OFFER_NOW が要る（未判定は合図しない）。
   * 省略と false は1段判定（v2）で、振る舞いは従来どおり。
   */
  timing_gate?: boolean;
  /** 合図の後の人の反応を観測する窓（ms、policy の暫定値）。省略は観測しない。 */
  cue_reaction_window_ms?: number;
}

/**
 * 候補の先行音声（D の SpeechGenerator の状態）。合図は preparing でも出す（吸気の間に作る）。
 * 吸気の後に間に合っていなければ、準備姿勢で hold_max_ms まで待ち、なお来なければ撤回する。
 */
export type CandidateAudio = 'none' | 'preparing' | 'ready' | 'failed';

/** 交渉が読む候補の値。E2a の記録と D の状態から呼び手が作る。 */
export interface CandidateView {
  candidate_id: string;
  candidate_version: number;
  state: CandidateState;
  /** 最後の判定（NEW／KEEP／REVISE）を受けた時刻（実測）。 */
  judged_at: number;
  /** 最後の判定の入力より後の新規の安定文字数。不明は null（古いとみなす）。 */
  new_chars_since_judgement: number | null;
  audio: CandidateAudio;
  /** この版の最新のタイミング段の判定。未判定は null。1段判定では読まない。 */
  timing?: TimingVerdict | null;
}

export interface CueState {
  cue_id: string;
  candidate_id: string;
  candidate_version: number;
  started_at: number;
  /** 吸気の完了（orchestrator の時計）。 */
  inhale_ends_at: number;
  /** 準備姿勢（BREATH_HOLD_OR_READY）に入った時刻。吸気中は null。 */
  hold_started_at: number | null;
}

export interface NegotiatorState {
  cue_seq: number;
  /** 最後に合図した時刻（冷却時間の起点）。 */
  last_cue_at: number | null;
  /** 今の合図（吸気〜保持）。DEFERRED、発話、撤回で解く。 */
  cue: CueState | null;
  /**
   * DEFERRED へ移った合図。候補が撤回されたら脱力を解く（breath.release: withdrawn）ために cue_id を覚えておく。
   * audio_wait_started_at は、許可が出たまま新しい音声（改訂の作り直し）を待ち始めた時刻（hold_max_ms の待ちの起点）。
   */
  deferred: { cue_id: string; candidate_id: string; audio_wait_started_at?: number | null }[];
}

export function initialNegotiatorState(): NegotiatorState {
  return { cue_seq: 0, last_cue_at: null, cue: null, deferred: [] };
}

export interface NegotiatorTickInputs {
  now: number;
  /** 未解決（SPOKEN、WITHDRAWN 以外）の候補。決まった順。 */
  candidates: readonly CandidateView[];
  /** AI が話している（再生中、開始の報告待ち、停止中）。 */
  ai_speaking: boolean;
  /** 合図を描けるブラウザがつながっている。 */
  avatar_available: boolean;
  /** TurnManager の user_speaking（前の tick の値）。 */
  user_speaking: boolean;
  /** TurnManager の permitted_to_speak（前の tick の値）。延期中の音声の作り直しの待ちの起点。省略は false。 */
  permitted?: boolean;
}

export type NegotiatorAction =
  | { kind: 'cue'; cue_id: string; candidate_id: string; candidate_version: number; duration_ms: number }
  | { kind: 'inhale_completed'; candidate_id: string; candidate_version: number }
  | { kind: 'defer'; candidate_id: string; candidate_version: number }
  /** 吸気の後に音声が間に合わなかった（期限切れか失敗）。候補を撤回する。 */
  | { kind: 'audio_abandoned'; candidate_id: string; candidate_version: number; reasons: string[] }
  | {
      kind: 'release';
      cue_id: string;
      candidate_id: string;
      reason: 'speech_started' | 'deferred' | 'withdrawn';
    };

export interface GateResult {
  candidate_id: string;
  candidate_version: number;
  candidate_state: CandidateState;
  /** cue は合図した、shadow_cue は同じゲートを通ったが提示しない（影の合図）、blocked は条件のどれかで止めた、no_cue_condition は条件で合図しない（reactive）。 */
  outcome: 'cue' | 'shadow_cue' | 'blocked' | 'no_cue_condition';
  reasons: string[];
}

export interface NegotiatorStep {
  state: NegotiatorState;
  actions: NegotiatorAction[];
  /** 合図のゲートの判定（INTENT_READY の候補がなければ null）。 */
  gate: GateResult | null;
  /** 通常の応答を含めて開始を保留する理由（吸気中、吸気の後に音声を待つ間）。なければ null。TurnInputs.start_blocked_reason に入れる。 */
  hold_start: string | null;
}

/** 合図を参加者に提示する条件か。false の initiative_no_cue は同じ制御を通るが、何も見せない（影の合図）。 */
export function presentsCue(condition: Condition): boolean {
  return condition === 'initiative_inhale';
}

/** 影の合図の記録に付ける理由（提示していないことをログから読めるように）。 */
export const NOT_PRESENTED_REASON = 'not_presented:initiative_no_cue';

const UNRESOLVED: readonly CandidateState[] = [
  'INTENT_READY',
  'BREATH_INHALE',
  'BREATH_HOLD_OR_READY',
  'DEFERRED',
  'SPEAKING',
];

/**
 * E2 の合図のゲート。次を全部満たすときだけ合図する（計画 §4.6）: 判定の鮮度（最後の判定からの新規の安定文字数と経過時間）
 * と検証（E2a に登録済み）に合格、AI 非発話、合図の冷却時間を超過、活動中の候補が1つまで。
 * 加えて、アバターを描けること（仕様 §4 の avatar available）と、候補の音声が用意できること（準備中か準備済み。作れないなら
 * 合図しても話せない）を見る。音声の完成は待たない（吸気の間に作る。known_gaps §11）。
 * initiative_no_cue も同じ基準で判定し、通れば outcome は shadow_cue（提示はしない）。
 */
export function signalGate(
  settings: NegotiatorSettings,
  state: NegotiatorState,
  inputs: NegotiatorTickInputs,
  candidate: CandidateView,
): GateResult {
  const base = {
    candidate_id: candidate.candidate_id,
    candidate_version: candidate.candidate_version,
    candidate_state: candidate.state,
  };
  if (settings.condition === 'reactive') {
    return { ...base, outcome: 'no_cue_condition', reasons: [`condition:${settings.condition}`] };
  }
  const reasons: string[] = [];
  const active = inputs.candidates.filter((c) => UNRESOLVED.includes(c.state)).length;
  if (active > settings.max_active_candidates) reasons.push(`active_candidates=${active}`);
  if (state.cue !== null) reasons.push('cue_in_progress');
  if (inputs.ai_speaking) reasons.push('ai_speaking');
  if (!inputs.avatar_available) reasons.push('avatar_unavailable');
  if (settings.signal_cooldown_ms === null) reasons.push('signal_cooldown_uncalibrated');
  else if (state.last_cue_at !== null && inputs.now - state.last_cue_at < settings.signal_cooldown_ms) {
    reasons.push(`cooldown_remaining_ms=${Math.ceil(settings.signal_cooldown_ms - (inputs.now - state.last_cue_at))}`);
  }
  const chars = candidate.new_chars_since_judgement;
  if (chars === null) reasons.push('judgement_input_unknown');
  else if (chars > settings.max_new_stable_chars_since_judgement) reasons.push(`judgement_stale:chars=${chars}`);
  const age = inputs.now - candidate.judged_at;
  if (age > settings.cue_max_judgement_age_ms) reasons.push(`judgement_old:age_ms=${Math.round(age)}`);
  if (candidate.audio === 'none' || candidate.audio === 'failed') reasons.push(`candidate_audio_${candidate.audio}`);
  // 二段判定: 合図を出すのはタイミング段が「今申し出る」と判定したときだけ（待ちと未判定は合図しない）。
  if (settings.timing_gate === true && candidate.timing !== 'OFFER_NOW') {
    reasons.push(candidate.timing == null ? 'timing_not_judged' : `timing_${candidate.timing.toLowerCase()}`);
  }
  if (reasons.length > 0) return { ...base, outcome: 'blocked', reasons };
  const presented = presentsCue(settings.condition);
  return {
    ...base,
    outcome: presented ? 'cue' : 'shadow_cue',
    reasons: [
      'judgement_fresh',
      'ai_silent',
      'avatar_available',
      'cooldown_passed',
      'single_active_candidate',
      `candidate_audio_${candidate.audio}`,
      ...(settings.timing_gate === true ? ['timing_offer_now'] : []),
      ...(presented ? [] : [NOT_PRESENTED_REASON]),
    ],
  };
}

/** 合図した候補の今の値。なければ null。 */
function cueTarget(state: NegotiatorState, inputs: NegotiatorTickInputs): CandidateView | null {
  const cue = state.cue;
  if (cue === null) return null;
  return inputs.candidates.find((c) => c.candidate_id === cue.candidate_id) ?? null;
}

/**
 * 1 tick の交渉（TurnManager の step より前に呼ぶ）。合図、吸気の完了、DEFERRED、合図の解除を決める。
 * 発話の開始は selectSpeech と呼び手が決め、開始したら releaseForSpeech で合図を解く。
 */
export function negotiate(settings: NegotiatorSettings, previous: NegotiatorState, inputs: NegotiatorTickInputs): NegotiatorStep {
  let state: NegotiatorState = { ...previous };
  const actions: NegotiatorAction[] = [];
  const { now } = inputs;

  // 合図した候補が消えた（撤回、期限、通常応答の開始で撤回）。合図を解く。候補の発話に入るときは releaseForSpeech が解く。
  if (state.cue !== null && cueTarget(state, inputs) === null) {
    actions.push({ kind: 'release', cue_id: state.cue.cue_id, candidate_id: state.cue.candidate_id, reason: inputs.ai_speaking ? 'speech_started' : 'withdrawn' });
    state = { ...state, cue: null };
  }

  // DEFERRED の候補が撤回された。残した準備姿勢を解く（再吸気しない候補の、最後の脱力）。
  for (const deferred of state.deferred) {
    if (inputs.candidates.some((c) => c.candidate_id === deferred.candidate_id)) continue;
    actions.push({ kind: 'release', cue_id: deferred.cue_id, candidate_id: deferred.candidate_id, reason: 'withdrawn' });
  }
  state = { ...state, deferred: state.deferred.filter((d) => inputs.candidates.some((c) => c.candidate_id === d.candidate_id)) };

  // DEFERRED の候補の音声が作れなかった。話せないので状態を残さず閉じ、脱力を解く（発声の失敗の復帰、設計メモ §4）。
  for (const deferred of [...state.deferred]) {
    const candidate = inputs.candidates.find((c) => c.candidate_id === deferred.candidate_id);
    if (candidate?.state !== 'DEFERRED' || candidate.audio !== 'failed') continue;
    actions.push({ kind: 'audio_abandoned', candidate_id: candidate.candidate_id, candidate_version: candidate.candidate_version, reasons: ['candidate_audio_failed'] });
    actions.push({ kind: 'release', cue_id: deferred.cue_id, candidate_id: candidate.candidate_id, reason: 'withdrawn' });
    state = { ...state, deferred: state.deferred.filter((d) => d !== deferred) };
  }

  // DEFERRED の候補の音声を作り直している（延期中の改訂）。開始を保留し（通常の応答に切り替えない）、許可が出たら hold_max_ms まで待つ。
  // 許可が出ているのに間に合わなければ話せないので閉じる。許可が出ていない間（話し続けている、間を待っている）は待ちに数えない。
  let deferredAudioCue: string | null = null;
  for (const deferred of [...state.deferred]) {
    const candidate = inputs.candidates.find((c) => c.candidate_id === deferred.candidate_id);
    const waiting = candidate?.state === 'DEFERRED' && candidate.audio === 'preparing';
    if (waiting) deferredAudioCue = deferred.cue_id;
    if (!waiting || inputs.permitted !== true) {
      if (deferred.audio_wait_started_at != null) state = { ...state, deferred: state.deferred.map((d) => (d === deferred ? { ...d, audio_wait_started_at: null } : d)) };
      continue;
    }
    const since = deferred.audio_wait_started_at ?? now;
    if (now - since >= settings.hold_max_ms) {
      actions.push({ kind: 'audio_abandoned', candidate_id: candidate.candidate_id, candidate_version: candidate.candidate_version, reasons: [`audio_not_ready_by_deadline:deferred_wait_ms=${Math.round(now - since)}`] });
      actions.push({ kind: 'release', cue_id: deferred.cue_id, candidate_id: candidate.candidate_id, reason: 'withdrawn' });
      state = { ...state, deferred: state.deferred.filter((d) => d !== deferred) };
      deferredAudioCue = null;
    } else if (deferred.audio_wait_started_at == null) {
      state = { ...state, deferred: state.deferred.map((d) => (d === deferred ? { ...d, audio_wait_started_at: since } : d)) };
    }
  }

  // 吸気の完了は orchestrator の時計（ブラウザの報告を待たない）。
  const target = cueTarget(state, inputs);
  // 吸気の後に音声を待っている。通常の応答も含めて開始を保留する（待ちは hold_max_ms まで）。
  let waitingForAudio = false;
  if (state.cue !== null && target !== null) {
    const cue = state.cue;
    if (target.state === 'BREATH_INHALE' && now >= cue.inhale_ends_at) {
      actions.push({ kind: 'inhale_completed', candidate_id: target.candidate_id, candidate_version: target.candidate_version });
      state = { ...state, cue: { ...cue, hold_started_at: now } };
      waitingForAudio = target.audio !== 'ready';
    } else if (target.state === 'BREATH_HOLD_OR_READY' && cue.hold_started_at !== null) {
      const held = now - cue.hold_started_at;
      // 長く保持しない。準備姿勢の長さを過ぎて人が話していたら脱力して DEFERRED（計画 §4.6）。
      if (held >= settings.hold_max_ms && inputs.user_speaking) {
        actions.push({ kind: 'defer', candidate_id: target.candidate_id, candidate_version: target.candidate_version });
        actions.push({ kind: 'release', cue_id: cue.cue_id, candidate_id: target.candidate_id, reason: 'deferred' });
        state = { ...state, cue: null, deferred: [...state.deferred, { cue_id: cue.cue_id, candidate_id: target.candidate_id }] };
      } else if (target.audio === 'none' || target.audio === 'failed' || (target.audio === 'preparing' && held >= settings.hold_max_ms)) {
        // 音声が間に合わない（期限か失敗）。合図は出してしまっているので、話さずに引き下がる。
        const reason = target.audio === 'preparing' ? `audio_not_ready_by_deadline:hold_ms=${Math.round(held)}` : `candidate_audio_${target.audio}`;
        actions.push({ kind: 'audio_abandoned', candidate_id: target.candidate_id, candidate_version: target.candidate_version, reasons: [reason] });
        actions.push({ kind: 'release', cue_id: cue.cue_id, candidate_id: target.candidate_id, reason: 'withdrawn' });
        state = { ...state, cue: null };
      } else if (target.audio === 'preparing') {
        waitingForAudio = true;
      }
    }
  }

  // 合図のゲート。対象は INTENT_READY の候補（最も早く決まったもの）。
  let gate: GateResult | null = null;
  const ready = inputs.candidates.find((c) => c.state === 'INTENT_READY');
  if (ready !== undefined) {
    gate = signalGate(settings, state, inputs, ready);
    if (gate.outcome === 'cue' || gate.outcome === 'shadow_cue') {
      const cue_seq = state.cue_seq + 1;
      // 影の合図の ID は頭で見分ける（hold_start の理由と cue_reaction に残るので、提示と取り違えない）。
      const cue_id = `${gate.outcome === 'shadow_cue' ? 'shadow_' : ''}cue_${String(cue_seq).padStart(4, '0')}`;
      actions.push({
        kind: 'cue',
        cue_id,
        candidate_id: ready.candidate_id,
        candidate_version: ready.candidate_version,
        duration_ms: settings.inhale_ms,
      });
      state = {
        ...state,
        cue_seq,
        last_cue_at: now,
        cue: {
          cue_id,
          candidate_id: ready.candidate_id,
          candidate_version: ready.candidate_version,
          started_at: now,
          inhale_ends_at: now + settings.inhale_ms,
          hold_started_at: null,
        },
      };
    }
  }

  // 吸気中は通常の応答も含めて開始を保留する（吸気を終えてから話す。計画 §4.6）。吸気の後に音声を待つ間も同じ。
  const inhaling = state.cue !== null && state.cue.hold_started_at === null;
  const hold_start = inhaling
    ? `candidate_inhale_in_progress:${state.cue?.cue_id}`
    : waitingForAudio && state.cue !== null
      ? `candidate_audio_wait:${state.cue.cue_id}`
      : deferredAudioCue !== null
        ? `candidate_audio_wait:${deferredAudioCue}`
        : null;
  return { state, actions, gate, hold_start };
}

/** 候補の発話を始めたときの合図の解除。合図がその候補のものでなければ何もしない。 */
export function releaseForSpeech(
  state: NegotiatorState,
  candidate_id: string,
): { state: NegotiatorState; action: Extract<NegotiatorAction, { kind: 'release' }> | null } {
  // DEFERRED から話す候補はもう撤回の脱力を送らない（合図の解除ではなく短い準備動作で話す）。
  const deferred = state.deferred.filter((d) => d.candidate_id !== candidate_id);
  if (state.cue === null || state.cue.candidate_id !== candidate_id) return { state: { ...state, deferred }, action: null };
  return {
    state: { ...state, cue: null, deferred },
    action: { kind: 'release', cue_id: state.cue.cue_id, candidate_id, reason: 'speech_started' },
  };
}

/** 候補を発話の前に撤回したときの解除（合図と DEFERRED の脱力の両方。理由は withdrawn）。呼び手が actions を送る。 */
export function releaseForWithdrawal(
  state: NegotiatorState,
  candidate_id: string,
): { state: NegotiatorState; actions: Extract<NegotiatorAction, { kind: 'release' }>[] } {
  const actions: Extract<NegotiatorAction, { kind: 'release' }>[] = [];
  if (state.cue?.candidate_id === candidate_id) actions.push({ kind: 'release', cue_id: state.cue.cue_id, candidate_id, reason: 'withdrawn' });
  for (const deferred of state.deferred) {
    if (deferred.candidate_id === candidate_id) actions.push({ kind: 'release', cue_id: deferred.cue_id, candidate_id, reason: 'withdrawn' });
  }
  return { state: { ...state, cue: state.cue?.candidate_id === candidate_id ? null : state.cue, deferred: state.deferred.filter((d) => d.candidate_id !== candidate_id) }, actions };
}

// ---- 合図の後の人の反応の観測 -----------------------------------------------------

/** 吸気の合図の後の観測。**譲ったと確定する処理ではない**（話し続けた時間と VAP の値を測るだけ）。 */
export interface CueReaction {
  cue_id: string;
  /** 参加者に実際に提示したか（影の合図と、送れなかった合図は false）。 */
  cue_presented: boolean;
  candidate_id: string;
  candidate_version: number;
  cue_sent_at: number;
  window_ms: number;
  ticks: number;
  user_speaking_ticks: number;
  user_speaking_at_cue: boolean;
  last_user_speaking: boolean;
  user_stopped_at: number | null;
  user_started_at: number | null;
  p_at_cue: number | null;
  p_last: number | null;
  p_min: number | null;
  p_max: number | null;
  states: CandidateState[];
}

export function startCueReaction(
  input: { cue_id: string; cue_presented: boolean; candidate_id: string; candidate_version: number; at: number; window_ms: number },
  tick: { user_speaking: boolean; p_now_ai: number | null; candidate_state: CandidateState | null },
): CueReaction {
  const { at, ...identity } = input;
  return {
    ...identity,
    cue_sent_at: at,
    ticks: 1,
    user_speaking_ticks: tick.user_speaking ? 1 : 0,
    user_speaking_at_cue: tick.user_speaking,
    last_user_speaking: tick.user_speaking,
    user_stopped_at: null,
    user_started_at: null,
    p_at_cue: tick.p_now_ai,
    p_last: tick.p_now_ai,
    p_min: tick.p_now_ai,
    p_max: tick.p_now_ai,
    states: tick.candidate_state ? [tick.candidate_state] : [],
  };
}

export function observeCueReaction(
  reaction: CueReaction,
  at: number,
  tick: { user_speaking: boolean; p_now_ai: number | null; candidate_state: CandidateState | null },
): CueReaction {
  const next = { ...reaction, ticks: reaction.ticks + 1, user_speaking_ticks: reaction.user_speaking_ticks + (tick.user_speaking ? 1 : 0), last_user_speaking: tick.user_speaking };
  if (reaction.user_speaking_at_cue && !tick.user_speaking && reaction.user_stopped_at === null) next.user_stopped_at = at;
  if (!reaction.user_speaking_at_cue && tick.user_speaking && reaction.user_started_at === null) next.user_started_at = at;
  if (tick.p_now_ai !== null) {
    next.p_last = tick.p_now_ai;
    next.p_min = reaction.p_min === null ? tick.p_now_ai : Math.min(reaction.p_min, tick.p_now_ai);
    next.p_max = reaction.p_max === null ? tick.p_now_ai : Math.max(reaction.p_max, tick.p_now_ai);
  }
  if (tick.candidate_state !== null && reaction.states.at(-1) !== tick.candidate_state) next.states = [...reaction.states, tick.candidate_state];
  return next;
}

// ---- E3 の選択 -------------------------------------------------------------------

/**
 * 直前の発話が AI への直接の質問か（計画 §4.6「直接の質問なら応答」）。簡単な規則で、誤認しうる。
 * 招待の検出（invitation.ts）の direct_question に加え、文末の疑問の形を見る。句読点は使わない
 * （interim の末尾の「？」は変動する。docs/known_gaps.md §3）。上昇調だけの質問は取れない。
 */
export const DIRECT_QUESTION_RULES: readonly { id: string; re: RegExp }[] = [
  { id: 'desuka', re: /(です|ます|でしょう|ません|でした|ました|ある|ない|いい|よい)か$/u },
  { id: 'kana', re: /(かな|かね|のか|だろうか|ですかね)$/u },
  { id: 'nan_desu', re: /(なんですか|なんでしょう|何ですか|何でしょう|って何|とは)$/u },
  { id: 'dou', re: /(どう|どうして|なぜ|なんで)(なの|なんだろう|でしょう|ですか)?$/u },
];

export function detectDirectQuestion(invitation: Invitation, text: string | null): string | null {
  if (invitation.detected && invitation.kind === 'direct_question') return `invitation:${invitation.phrase}`;
  // 招待（「何かありますか」など）は疑問の形でも質問ではない。文末の規則より招待を先に見る（計画 §4.6「どうぞなら候補」）。
  if (invitation.detected && invitation.kind === 'go_ahead') return null;
  if (text === null) return null;
  const normalized = normalizeForSimilarity(text);
  for (const rule of DIRECT_QUESTION_RULES) if (rule.re.test(normalized)) return `rule:${rule.id}`;
  return null;
}

export interface SelectionInputs {
  /** 交渉の対象の候補（未解決で最も早いもの）。なければ null。 */
  candidate: CandidateView | null;
  /** TurnManager の permitted_to_speak（この tick）。 */
  permitted: boolean;
  invitation: Invitation;
  /** TurnManager の asr_result（今の segment の利用者の発話）。 */
  user_text: string | null;
}

export interface Selection {
  /** candidate は候補を話す、response は通常の応答（あれば）、wait はどちらも始めない、none は許可がない。 */
  choice: 'candidate' | 'response' | 'wait' | 'none';
  reasons: string[];
  /** 候補を話すときの原因（candidate.state_changed の cause）。 */
  cause: 'turn_allowed' | 'invitation' | null;
}

/**
 * E3 の発話の選択（最小）。発話の許可が出たとき、有効な候補があり判定が古くなければ、通常の先行応答の代わりに候補を話す。
 * 直前の発話が直接の質問なら通常応答を優先する。urgency は使わない（計画 §4.5）。
 */
export function selectSpeech(settings: NegotiatorSettings, inputs: SelectionInputs): Selection {
  const c = inputs.candidate;
  if (!inputs.permitted) return { choice: 'none', reasons: ['not_permitted'], cause: null };
  if (settings.condition === 'reactive') return { choice: 'response', reasons: ['condition:reactive'], cause: null };
  if (c === null) return { choice: 'response', reasons: ['no_active_candidate'], cause: null };
  if (c.state === 'SPEAKING') return { choice: 'wait', reasons: ['candidate_speaking'], cause: null };
  if (c.state === 'BREATH_INHALE') return { choice: 'wait', reasons: ['inhale_in_progress'], cause: null };
  const question = detectDirectQuestion(inputs.invitation, inputs.user_text);
  if (question !== null) return { choice: 'response', reasons: [`direct_question:${question}`], cause: null };
  // 二段判定: タイミング段がまだなら候補を話さない（合図の条件と同じ）。通常応答を判定待ちにはしない。
  if (settings.timing_gate === true && c.state === 'INTENT_READY' && c.timing == null) {
    return { choice: 'response', reasons: ['timing_not_judged'], cause: null };
  }
  // WAIT_FOR_TURN_END は話さない（吸気の期間を経ない発話を混ぜない）。通常応答に回し、候補は保留に残す。ここからは2つの提案条件で同じ。
  if (settings.timing_gate === true && c.state === 'INTENT_READY' && c.timing === 'WAIT_FOR_TURN_END') return { choice: 'response', reasons: ['timing_wait_for_turn_end'], cause: null };
  // 吸気の期間の後（BREATH_HOLD_OR_READY、DEFERRED）だけが話せる。声が先に出る経路はない。
  const speakable: readonly CandidateState[] = ['BREATH_HOLD_OR_READY', 'DEFERRED'];
  if (!speakable.includes(c.state)) {
    return { choice: 'response', reasons: [c.state === 'INTENT_READY' ? 'not_cued' : `state_not_speakable:${c.state}`], cause: null };
  }
  // 吸気の後の準備姿勢や延期中の作り直しで音声を待っている間（期限まで）は、通常応答に切り替えない（negotiate が hold_start で止めている）。
  if ((c.state === 'BREATH_HOLD_OR_READY' || c.state === 'DEFERRED') && c.audio === 'preparing') return { choice: 'wait', reasons: ['candidate_audio_preparing'], cause: null };
  if (c.audio !== 'ready') return { choice: 'response', reasons: [`candidate_audio_${c.audio}`], cause: null };
  const chars = c.new_chars_since_judgement;
  if (chars === null) return { choice: 'response', reasons: ['judgement_input_unknown'], cause: null };
  if (chars > settings.max_new_stable_chars_since_judgement) {
    return { choice: 'response', reasons: [`judgement_stale:chars=${chars}`], cause: null };
  }
  const go_ahead = inputs.invitation.detected && inputs.invitation.kind === 'go_ahead';
  return {
    choice: 'candidate',
    reasons: [
      go_ahead ? `invitation:${inputs.invitation.detected ? inputs.invitation.phrase : ''}` : 'natural_yield',
      `from:${c.state}`,
    ],
    cause: go_ahead ? 'invitation' : 'turn_allowed',
  };
}

/** 理由の数値を除いた比較の鍵（tick ごとに同じ判断を記録しないため）。 */
export function reasonKey(reasons: readonly string[]): string {
  return reasons.map((r) => r.split(/[:=]/)[0]).join(',');
}
