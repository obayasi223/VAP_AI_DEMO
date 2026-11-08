/**
 * 候補ストアのインターフェース（本実装は E2a）。候補の状態の正本は E にある。
 * candidate_id と版は register／update で E が採番する。LLM には生成させない（計画 §4.5）。
 *
 * 順序の約束: initiative.decision の NEW は register の戻り値を受けた後に emit する
 * （イベントに candidate_id が必須なので、採番前に emit できない）。
 * REVISE も同様に update の戻り値の版で emit する。
 * G は list() で未解決の候補を受け取り、KEEP などの照合に使う。
 */
import { z } from 'zod';
import type { CandidateRef } from './turn';

/** 仕様§4 の遷移と計画 §4.6。 */
export const CandidateState = z.enum([
  'INTENT_READY',
  'BREATH_INHALE',
  'BREATH_HOLD_OR_READY',
  'DEFERRED',
  'SPEAKING',
  'SPOKEN',
  'WITHDRAWN',
]);
export type CandidateState = z.infer<typeof CandidateState>;

/** コード由来の遷移の原因。モデルの判断（WITHDRAW など）はここに入れない。 */
export const CandidateCause = z.enum([
  'signal_gate_allowed',
  'inhale_completed',
  'user_continued',
  'turn_allowed',
  'invitation',
  'expired',
  'evidence_lost',
  'stale_result',
  /** 活動中の候補があるので棄却（合図のゲート、計画 §4.6）。 */
  'active_candidate_exists',
  'signal_cooldown',
  'normal_response_started',
  'speech_finished',
  'speech_interrupted',
  /** 再生の途中で D が失敗した（SPEAKING を終端する）。 */
  'speech_failed',
  /** 開始はしたが 1 音も出ずに終わった（SPOKEN にしない）。 */
  'speech_no_audio',
  'woz',
]);
export type CandidateCause = z.infer<typeof CandidateCause>;

/**
 * E2a が受け付けなかった要求の理由（candidate.rejected）。E2a の追加。
 * G の決定的なゲートでの棄却は従来どおり initiative.discarded に残し、ここには E2a 自身の判断だけを入れる。
 */
export const CandidateRejectReason = z.enum([
  'unknown_candidate',
  /** 要求の版が候補の現在の版と違う（遅れて届いた結果）。 */
  'version_mismatch',
  /** すでに適用した判定より古い transcript_revision の入力から出た判定。 */
  'stale_transcript_revision',
  /** 現在より前の segment_id（AI の発話開始より前）の入力から出た判定。 */
  'stale_segment',
  /** 遷移表にない from → to。 */
  'invalid_transition',
  /** 遷移は表にあるが、その原因では許していない。 */
  'cause_not_allowed',
  /** その状態では判定（KEEP／REVISE／WITHDRAW）を適用しない。 */
  'state_not_applicable',
  'evidence_invalid',
  'withdraw_evidence_invalid',
  'proposed_utterance_empty',
  /** 人が話し終えた後に届いた NEW。候補にせず保留した（held=true）。 */
  'post_turn_new_held',
  /** 保留していた NEW を棄てた（人の再開、通常応答の開始、期限など）。 */
  'held_dropped',
  /** D の startChecked が開始を拒否した。details に D の理由。 */
  'speech_start_refused',
]);
export type CandidateRejectReason = z.infer<typeof CandidateRejectReason>;

/**
 * 発話希望の二段判定（docs/initiative_v3_design.md）。
 * 会話の種類。種類ごとの persona と観点は config/conversation_kind.*.ja.json。
 */
export const ConversationKind = z.enum(['joint_thinking', 'companion']);
export type ConversationKind = z.infer<typeof ConversationKind>;

/** タイミング段の方式。llm=希望があるときだけ2回目の LLM、immediate=希望が出たら次の機会に申し出る、v2=既存の1段判定。 */
export const TimingStrategy = z.enum(['llm', 'immediate', 'v2']);
export type TimingStrategy = z.infer<typeof TimingStrategy>;

/** タイミング段の判定（話の途中で申し出る／話し終わりまで待つ／取り下げる）。NONE/NEW/KEEP/REVISE/WITHDRAW とは別の軸。 */
export const TimingVerdict = z.enum(['OFFER_NOW', 'WAIT_FOR_TURN_END', 'WITHDRAW']);
export type TimingVerdict = z.infer<typeof TimingVerdict>;

export interface CandidateRegistration {
  segment_id: number;
  transcript_revision: number;
  /** ここから下は LLM の出力の素の値。ログでは ModelOutput で包む。判定には使わない。 */
  intent_type: string;
  evidence_span: string;
  proposed_utterance: string;
  expiry_policy: string;
  urgency: string;
  /** コードが検証した ASR 区間 ID。 */
  evidence_segment_ids: number[];
  decided_at: number;
}

export interface CandidateRecord extends CandidateRegistration {
  candidate_id: string;
  candidate_version: number;
  state: CandidateState;
  updated_at: number;
}

export type CandidateContentPatch = Partial<
  Pick<
    CandidateRegistration,
    | 'transcript_revision'
    | 'intent_type'
    | 'evidence_span'
    | 'proposed_utterance'
    | 'expiry_policy'
    | 'urgency'
    | 'evidence_segment_ids'
  >
>;

export class CandidateConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CandidateConflictError';
  }
}

export interface CandidateStore {
  /** 採番して登録する。状態は INTENT_READY、版は 1。 */
  register(input: CandidateRegistration): CandidateRef;
  get(candidate_id: string): CandidateRecord | null;
  /** 既定は未解決（SPOKEN、WITHDRAWN 以外）のみ。 */
  list(options?: { include_resolved?: boolean }): readonly CandidateRecord[];
  /**
   * 内容の更新（REVISE）。版を1つ増やして返す。
   * expected_version が古ければ CandidateConflictError（遅れて届いた結果の適用を防ぐ）。
   */
  update(
    candidate_id: string,
    expected_version: number,
    patch: CandidateContentPatch,
    updated_at: number,
  ): CandidateRef;
  /** 状態の更新。内容は変わらないので版は増えない。遷移の妥当性は E の状態機械が決める。 */
  setState(candidate_id: string, state: CandidateState, updated_at: number): CandidateRecord;
}
