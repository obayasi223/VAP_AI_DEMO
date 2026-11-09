/**
 * 候補の状態遷移表（仕様 §4 の初期状態遷移案、計画 §4.6）。純粋な関数で、状態も時刻も持たない。
 *
 * 表は「from → to を許す原因」の一覧。表にない from → to は invalid_transition、
 * 表にあるが原因が違えば cause_not_allowed で拒否する。モデル由来の遷移（NEW、WITHDRAW）は
 * 原因の代わりに model_decision を使う。
 *
 * want_to_speak（候補がある）、permitted_to_speak（E1 の turn_allowed）、speaking（実際の再生）は混ぜない。
 * この表は want の生涯だけを決める。SPEAKING へ入れる原因（turn_allowed など）は呼び手が判断した結果で、
 * ここでは許可を判定しない。
 */
import type { CandidateCause, CandidateState } from '@llm-vap/contracts';

/** 遷移の原因。コード由来は契約の CandidateCause、モデル由来は model_decision。 */
export type TransitionCause = CandidateCause | 'model_decision';

/** 未解決（want がある）状態。SPEAKING も未解決だが、内容の更新は受けない。 */
export const TERMINAL_STATES: readonly CandidateState[] = ['SPOKEN', 'WITHDRAWN'];

/** KEEP／REVISE／WITHDRAW を適用してよい状態。再生中の SPEAKING には内容の判定を当てない。 */
export const MODEL_APPLICABLE_STATES: readonly CandidateState[] = [
  'INTENT_READY',
  'BREATH_INHALE',
  'BREATH_HOLD_OR_READY',
  'DEFERRED',
];

/** 期限切れ、通常応答の開始、根拠の消失で撤回する対象。SPEAKING は話し終えるまで撤回しない（再生の失敗と無音の終了は finishSpeech）。 */
export const WITHDRAWABLE_STATES = MODEL_APPLICABLE_STATES;

/** 撤回の原因。コード由来のもの。 */
const WITHDRAW_CAUSES: readonly TransitionCause[] = [
  'model_decision',
  'expired',
  'evidence_lost',
  'stale_result',
  'normal_response_started',
  'audio_unavailable',
  'already_said',
  'woz',
];

/** 発話の開始の原因。いずれも呼び手（E3、J）の判断で、この表は許可を判定しない。 */
const SPEAK_CAUSES: readonly TransitionCause[] = ['turn_allowed', 'invitation', 'woz'];

type Table = Partial<Record<CandidateState, Partial<Record<CandidateState, readonly TransitionCause[]>>>>;

export interface TransitionOptions {
  /** DEFERRED からの再合図（計画 §4.6「既定は無効で開始」）。 */
  allow_recue: boolean;
}

export const DEFAULT_TRANSITION_OPTIONS: TransitionOptions = { allow_recue: false };

function table(options: TransitionOptions): Table {
  return {
    INTENT_READY: {
      BREATH_INHALE: ['signal_gate_allowed'],
      // 表は条件を持たず、許可の判定もしない。selectSpeech は提案条件のどちらでも INTENT_READY を選ばない（吸気の期間を経て話す）ので、通常の経路では通らない。
      SPEAKING: SPEAK_CAUSES,
      WITHDRAWN: WITHDRAW_CAUSES,
    },
    BREATH_INHALE: {
      // 吸気は1回で完結する。吸気中に人が続けても、まず吸気を終える（計画 §4.6）。
      BREATH_HOLD_OR_READY: ['inhale_completed'],
      WITHDRAWN: WITHDRAW_CAUSES,
    },
    BREATH_HOLD_OR_READY: {
      SPEAKING: SPEAK_CAUSES,
      DEFERRED: ['user_continued'],
      WITHDRAWN: WITHDRAW_CAUSES,
    },
    DEFERRED: {
      // 再吸気しない（短い準備動作のみ）。
      SPEAKING: SPEAK_CAUSES,
      ...(options.allow_recue ? { BREATH_INHALE: ['signal_gate_allowed'] as const } : {}),
      WITHDRAWN: WITHDRAW_CAUSES,
    },
    SPEAKING: {
      SPOKEN: ['speech_finished', 'speech_interrupted'],
      // 話し終えていない終わり方。通常の撤回（WITHDRAWABLE_STATES）とは別で、D の報告だけが通す。
      WITHDRAWN: ['speech_failed', 'speech_no_audio'],
    },
  };
}

export type TransitionCheck =
  | { ok: true }
  | { ok: false; reason: 'invalid_transition' | 'cause_not_allowed'; details: string[] };

/** from が null は登録（NEW）。登録で入れるのは INTENT_READY と、同時に棄却する WITHDRAWN だけ。 */
export function checkTransition(
  from: CandidateState | null,
  to: CandidateState,
  cause: TransitionCause,
  options: TransitionOptions = DEFAULT_TRANSITION_OPTIONS,
): TransitionCheck {
  if (from === null) {
    if (to === 'INTENT_READY' && cause === 'model_decision') return { ok: true };
    if (to === 'WITHDRAWN' && cause === 'active_candidate_exists') return { ok: true };
    return { ok: false, reason: 'invalid_transition', details: ['registration_target'] };
  }
  if (TERMINAL_STATES.includes(from)) return { ok: false, reason: 'invalid_transition', details: ['terminal_state'] };
  if (from === to) return { ok: false, reason: 'invalid_transition', details: ['same_state'] };
  const causes = table(options)[from]?.[to];
  if (!causes) return { ok: false, reason: 'invalid_transition', details: [`${from}->${to}`] };
  if (!causes.includes(cause)) return { ok: false, reason: 'cause_not_allowed', details: [`${from}->${to}:${cause}`] };
  return { ok: true };
}

/** 表の全経路。試験と文書の生成に使う。 */
export function transitionTable(
  options: TransitionOptions = DEFAULT_TRANSITION_OPTIONS,
): { from: CandidateState | null; to: CandidateState; causes: readonly TransitionCause[] }[] {
  const rows: { from: CandidateState | null; to: CandidateState; causes: readonly TransitionCause[] }[] = [
    { from: null, to: 'INTENT_READY', causes: ['model_decision'] },
    { from: null, to: 'WITHDRAWN', causes: ['active_candidate_exists'] },
  ];
  for (const [from, targets] of Object.entries(table(options)) as [CandidateState, Table[CandidateState]][]) {
    for (const [to, causes] of Object.entries(targets ?? {}) as [CandidateState, readonly TransitionCause[]][]) {
      rows.push({ from, to, causes });
    }
  }
  return rows;
}
