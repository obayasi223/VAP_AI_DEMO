/**
 * 発話希望の交渉（E2 の合図のゲートと E3 の発話の選択、計画 §4.6）。純粋関数で、状態は呼び手が持つ。
 *
 * want_to_speak（候補、E2a の CandidateLedger が正本）、permitted_to_speak（TurnManager の turn_allowed）、
 * speaking（再生の報告）は別の変数のまま。ここはどれも作らず、読んだ値から「合図を出すか」「どちらを話すか」を決めて
 * 理由を返すだけ。NEW は発話の許可ではない。許可の判定そのもの（VAP など）は TurnManager のまま変えない。
 *
 * 研究条件（計画 §4.6 末尾）。候補の生成までは3条件とも同じ経路で、違いはここの設定だけ。
 *  - reactive          : 候補は記録するが、合図も発話もしない（通常の応答だけ）。
 *  - initiative_no_cue : 合図を経ずに INTENT_READY のまま発話の機会を待ち、許可が出たら候補を話す。
 *  - initiative_inhale : 合図（吸気1回）→ 準備姿勢 → 許可で発話。人が話し続けたら DEFERRED（脱力）、
 *                        DEFERRED からは再吸気せず、許可が出たら話す。吸気中は通常の応答も含めて開始を保留する。
 */
import type { CandidateState, Condition, Invitation } from '@llm-vap/contracts';
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
}

/** 候補の先行音声（D の SpeechGenerator の状態）。 */
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
}

export function initialNegotiatorState(): NegotiatorState {
  return { cue_seq: 0, last_cue_at: null, cue: null };
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
}

export type NegotiatorAction =
  | { kind: 'cue'; cue_id: string; candidate_id: string; candidate_version: number; duration_ms: number }
  | { kind: 'inhale_completed'; candidate_id: string; candidate_version: number }
  | { kind: 'defer'; candidate_id: string; candidate_version: number }
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
  /** cue は合図した、blocked は条件のどれかで止めた、no_cue_condition は条件で合図しない。 */
  outcome: 'cue' | 'blocked' | 'no_cue_condition';
  reasons: string[];
}

export interface NegotiatorStep {
  state: NegotiatorState;
  actions: NegotiatorAction[];
  /** 合図のゲートの判定（INTENT_READY の候補がなければ null）。 */
  gate: GateResult | null;
  /** 通常の応答を含めて開始を保留する理由（吸気中）。なければ null。TurnInputs.start_blocked_reason に入れる。 */
  hold_start: string | null;
}

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
 * 加えて、アバターを描けること（仕様 §4 の avatar available）、候補の音声が準備済み（合図の後の発話の遅れを抑える。
 * 3条件で発話できる時点をそろえる）を見る。
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
  if (settings.condition !== 'initiative_inhale') {
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
  if (candidate.audio !== 'ready') reasons.push(`candidate_audio_${candidate.audio}`);
  if (reasons.length > 0) return { ...base, outcome: 'blocked', reasons };
  return {
    ...base,
    outcome: 'cue',
    reasons: ['judgement_fresh', 'ai_silent', 'avatar_available', 'cooldown_passed', 'single_active_candidate', 'candidate_audio_ready'],
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

  // 合図した候補が消えた（撤回、期限、通常応答の開始で撤回）か、発話に入った。合図を解く。
  if (state.cue !== null) {
    const target = cueTarget(state, inputs);
    if (target === null || !UNRESOLVED.includes(target.state)) {
      actions.push({ kind: 'release', cue_id: state.cue.cue_id, candidate_id: state.cue.candidate_id, reason: inputs.ai_speaking ? 'speech_started' : 'withdrawn' });
      state = { ...state, cue: null };
    } else if (target.state === 'SPEAKING') {
      actions.push({ kind: 'release', cue_id: state.cue.cue_id, candidate_id: state.cue.candidate_id, reason: 'speech_started' });
      state = { ...state, cue: null };
    }
  }

  // 吸気の完了は orchestrator の時計（ブラウザの報告を待たない）。
  const target = cueTarget(state, inputs);
  if (state.cue !== null && target !== null) {
    const cue = state.cue;
    if (target.state === 'BREATH_INHALE' && now >= cue.inhale_ends_at) {
      actions.push({ kind: 'inhale_completed', candidate_id: target.candidate_id, candidate_version: target.candidate_version });
      state = { ...state, cue: { ...cue, hold_started_at: now } };
    } else if (target.state === 'BREATH_HOLD_OR_READY' && cue.hold_started_at !== null) {
      // 長く保持しない。準備姿勢の長さを過ぎて人が話していたら脱力して DEFERRED（計画 §4.6）。
      if (now - cue.hold_started_at >= settings.hold_max_ms && inputs.user_speaking) {
        actions.push({ kind: 'defer', candidate_id: target.candidate_id, candidate_version: target.candidate_version });
        actions.push({ kind: 'release', cue_id: cue.cue_id, candidate_id: target.candidate_id, reason: 'deferred' });
        state = { ...state, cue: null };
      }
    }
  }

  // 合図のゲート。対象は INTENT_READY の候補（最も早く決まったもの）。
  let gate: GateResult | null = null;
  const ready = inputs.candidates.find((c) => c.state === 'INTENT_READY');
  if (ready !== undefined) {
    gate = signalGate(settings, state, inputs, ready);
    if (gate.outcome === 'cue') {
      const cue_seq = state.cue_seq + 1;
      const cue_id = `cue_${String(cue_seq).padStart(4, '0')}`;
      actions.push({
        kind: 'cue',
        cue_id,
        candidate_id: ready.candidate_id,
        candidate_version: ready.candidate_version,
        duration_ms: settings.inhale_ms,
      });
      state = {
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

  // 吸気中は通常の応答も含めて開始を保留する（吸気を終えてから話す。計画 §4.6）。
  const inhaling = state.cue !== null && state.cue.hold_started_at === null;
  return { state, actions, gate, hold_start: inhaling ? `candidate_inhale_in_progress:${state.cue?.cue_id}` : null };
}

/** 候補の発話を始めたときの合図の解除。合図がその候補のものでなければ何もしない。 */
export function releaseForSpeech(
  state: NegotiatorState,
  candidate_id: string,
): { state: NegotiatorState; action: Extract<NegotiatorAction, { kind: 'release' }> | null } {
  if (state.cue === null || state.cue.candidate_id !== candidate_id) return { state, action: null };
  return {
    state: { ...state, cue: null },
    action: { kind: 'release', cue_id: state.cue.cue_id, candidate_id, reason: 'speech_started' },
  };
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
  const speakable: readonly CandidateState[] =
    settings.condition === 'initiative_inhale' ? ['BREATH_HOLD_OR_READY', 'DEFERRED'] : ['INTENT_READY'];
  if (!speakable.includes(c.state)) {
    return { choice: 'response', reasons: [c.state === 'INTENT_READY' ? 'not_cued' : `state_not_speakable:${c.state}`], cause: null };
  }
  if (c.audio !== 'ready') return { choice: 'response', reasons: [`candidate_audio_${c.audio}`], cause: null };
  const chars = c.new_chars_since_judgement;
  if (chars === null) return { choice: 'response', reasons: ['judgement_input_unknown'], cause: null };
  if (chars > settings.max_new_stable_chars_since_judgement) {
    return { choice: 'response', reasons: [`judgement_stale:chars=${chars}`], cause: null };
  }
  const go_ahead = inputs.invitation.detected && inputs.invitation.kind === 'go_ahead';
  return {
    choice: 'candidate',
    reasons: [go_ahead ? `invitation:${inputs.invitation.detected ? inputs.invitation.phrase : ''}` : 'natural_yield', `from:${c.state}`],
    cause: go_ahead ? 'invitation' : 'turn_allowed',
  };
}

/** 理由の数値を除いた比較の鍵（tick ごとに同じ判断を記録しないため）。 */
export function reasonKey(reasons: readonly string[]): string {
  return reasons.map((r) => r.split(/[:=]/)[0]).join(',');
}
