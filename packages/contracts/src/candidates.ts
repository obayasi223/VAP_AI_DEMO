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
  /** AI がすでに話した内容と同じだった（コードの比較。発話の直前のガードと、AI の発話の後の照合）。詳細は initiative.already_said。 */
  'already_said',
  /** 候補の音声を発声の前に用意できなかった（TTS の失敗、吸気の後の期限切れ）。内容の撤回でも期限切れでもない。 */
  'audio_unavailable',
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
 * 会話の種類の ID。種類ごとの persona と判定の条件は config/conversation_kind.<id>.ja.json にあり、ID はそのファイル名の <id>。
 * 種類を増やすのにコードを変えない（ここは形式だけを検証する。実在の確認はファイルの読み込みで行う）。
 */
export const ConversationKind = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
export type ConversationKind = z.infer<typeof ConversationKind>;

/**
 * 吸気の後の短い声（docs/initiative_v3_design.md §10）。研究の主眼は無音の吸気なので既定は none（無音の吸気だけ）で、別モードとして分けて分析する。
 * pre_beginning は発話権の申し出（「あ、」など）、backchannel は相槌（「うん」のみ、発話権を主張しない）。
 */
export const VocalCueMode = z.enum(['none', 'pre_beginning', 'backchannel']);
export type VocalCueMode = z.infer<typeof VocalCueMode>;
export const VocalCueKind = z.enum(['pre_beginning', 'backchannel']);
export type VocalCueKind = z.infer<typeof VocalCueKind>;

/** タイミング段の方式。llm=希望があるときだけ2回目の LLM、immediate=希望が出たら次の機会に申し出る、v2=既存の1段判定。 */
export const TimingStrategy = z.enum(['llm', 'immediate', 'v2']);
export type TimingStrategy = z.infer<typeof TimingStrategy>;

/**
 * タイミング段の判定（話の途中で申し出る／話し終わりまで待つ）。NONE/NEW/KEEP/REVISE/WITHDRAW とは別の軸。
 * WITHDRAW は initiative-timing-ja-v1 の時点の値（残っているログを読むために残す）。現在のタイミング段は出さない（撤回は生成段）。
 */
export const TimingVerdict = z.enum(['OFFER_NOW', 'WAIT_FOR_TURN_END', 'WITHDRAW']);
export type TimingVerdict = z.infer<typeof TimingVerdict>;

/**
 * 内容の撤回の分類（生成段が付ける。docs/initiative_v3_design.md §4）。タイミングの「今は言わない」とは別の軸。
 * 意味の定義は設計メモ。分類は LLM の判断で、ログでは ModelOutput で包む。
 * already_said は AI がすでに話した内容（initiative-desire-ja-v3 から）。コードの比較による同じ名前の撤回は CandidateCause の already_said で区別する。
 */
export const ContentWithdrawKind = z.enum(['question_resolved', 'premise_changed', 'topic_moved', 'already_said']);
export type ContentWithdrawKind = z.infer<typeof ContentWithdrawKind>;

/**
 * 内容の撤回の根拠がどちらの発話にあったか（コードの照合の結果。docs/initiative_v3_design.md §1）。
 * user_utterance は今話している人の発話（希望の根拠より後ろ）、ai_utterance は直近の会話の AI の発話（実際に声に出た部分）。
 */
export const WithdrawEvidenceSource = z.enum(['user_utterance', 'ai_utterance']);
export type WithdrawEvidenceSource = z.infer<typeof WithdrawEvidenceSource>;

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
  /**
   * 通常応答の開始を越えて保留を続けている（WAIT_FOR_TURN_END の候補）。元の根拠は前の segment にあり、今の安定テキストには
   * 無いので、根拠の残存の検査と撤回の根拠の位置の検査は行わない（docs/initiative_v3_design.md §4）。
   */
  carried_over?: { from_segment_id: number; at: number };
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
