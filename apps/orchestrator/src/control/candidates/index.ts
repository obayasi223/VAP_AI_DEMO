/**
 * 候補の状態と採番（E2a）。G、E2、E3、J の入口は CandidateLedger と candidateLedgerSettings。
 * want_to_speak の正本だけを持つ。permitted_to_speak は E1、speaking は D。
 */
import type { PolicyJa } from '@llm-vap/contracts';
import { turnConstants } from '@llm-vap/contracts';
import type { CandidateLedgerSettings } from './ledger';

export { CandidateLedger } from './ledger';
export type { CandidateLedgerDeps, CandidateLedgerSettings, CandidateSpeechPort } from './ledger';
export {
  DEFAULT_TRANSITION_OPTIONS,
  MODEL_APPLICABLE_STATES,
  TERMINAL_STATES,
  WITHDRAWABLE_STATES,
  checkTransition,
  transitionTable,
} from './transitions';
export type { TransitionCause, TransitionCheck, TransitionOptions } from './transitions';
export { evidenceStillStable, verifyEvidence, verifyWithdrawEvidence } from './evidence';
export type * from './types';

/**
 * policy.ja.json から設定を作る。null（未校正）は別の値へ置き換えず、そのまま渡す（扱いは ledger.ts の注記）。
 * 話の後の判定の無音の長さは turn の MIN_GAP_TIME_MS（AI がそれより前に話し始めないため）。
 */
export function candidateLedgerSettings(policy: PolicyJa): CandidateLedgerSettings {
  return {
    max_active_candidates: policy.initiative.max_active_candidates,
    candidate_expiry_ms: policy.initiative.candidate_expiry_ms,
    candidate_expires_on_segment_change: policy.initiative.candidate_expires_on_segment_change,
    post_turn_silence_ms: turnConstants(policy).MIN_GAP_TIME_MS,
    allow_recue: false,
    max_new_stable_chars_since_input: policy.initiative.max_new_stable_chars_since_input,
  };
}
