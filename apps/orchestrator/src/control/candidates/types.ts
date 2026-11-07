/**
 * E2a の入出力の型。G（InitiativeMonitor）と E2／E3／J がこれを使う。
 *
 * モデルの説明文（reason、why_now、cost_of_waiting、withdraw_reason）は ModelOutput で受け、記録するだけで
 * 判定に使わない（追補1）。判定に使う値（evidence_span、区間 ID、版、revision）とは別の項目にしてある。
 */
import type {
  CandidateCause,
  CandidateRecord,
  CandidateRef,
  CandidateRejectReason,
  CandidateState,
  MaybeModelOutput,
  ModelOutput,
  SpeechStartRefusal,
  Verified,
} from '@llm-vap/contracts';
import type { AsrSegmentSnapshot } from '../../cognition/initiative/transcript_view';

export type { AsrSegmentSnapshot };

/** モデルの出力のうち候補の中身。evidence_segment_ids はモデルの申告で、E2a が入力と照合する。 */
export interface CandidateContent {
  intent_type: string;
  evidence_span: string;
  evidence_segment_ids: readonly number[];
  proposed_utterance: string;
  expiry_policy: string;
  /** ログのみ。優先度や許可に使わない（計画 §4.5）。 */
  urgency: string;
}

/** 記録だけするモデルの説明文。E2a のどの判定もこれを読まない。 */
export interface CandidateModelNotes {
  reason: MaybeModelOutput<string>;
  why_now: MaybeModelOutput<string>;
  cost_of_waiting: MaybeModelOutput<string>;
}

/** 判定の出所。request_id で initiative.decision と llm.response へ結ぶ。 */
export interface DecisionMeta {
  request_id: string;
  /** LLM に渡した入力の revision と segment。 */
  transcript_revision: number;
  segment_id: number;
  /** 結果を受けた時刻（実測）。 */
  received_at: number;
  /** LLM に渡した安定テキストの区間。根拠の照合に使う。 */
  input_segments: readonly AsrSegmentSnapshot[];
}

export type ModelDecision =
  | ({ decision: 'NONE' } & DecisionMeta)
  | ({ decision: 'NEW'; content: CandidateContent; notes: CandidateModelNotes } & DecisionMeta)
  | ({ decision: 'KEEP'; target: CandidateRef } & DecisionMeta)
  | ({ decision: 'REVISE'; target: CandidateRef; content: CandidateContent; notes: CandidateModelNotes } & DecisionMeta)
  | ({
      decision: 'WITHDRAW';
      target: CandidateRef;
      withdraw_evidence_span: string;
      withdraw_evidence_segment_ids: readonly number[];
      withdraw_reason: ModelOutput<string>;
    } & DecisionMeta);

/**
 * active_candidate_exists は candidate.rejected でなく candidate.state_changed（from=null → WITHDRAWN）に残る
 * （契約の取り決め）。それ以外は candidate.rejected に残る。
 */
export type RejectionReason = CandidateRejectReason | 'active_candidate_exists';

export interface Rejection {
  ok: false;
  reason: RejectionReason;
  details: string[];
  /** true は棄てずに保留した（話の後の NEW）。 */
  held: boolean;
  /** 登録と同時に棄却した NEW（active_candidate_exists）は番号を持つ。 */
  ref: CandidateRef | null;
}

export type DecisionResult =
  | {
      ok: true;
      decision: ModelDecision['decision'];
      /** NONE は null。 */
      ref: CandidateRef | null;
      from: CandidateState | null;
      to: CandidateState | null;
      /** NEW と REVISE で、照合を通った区間 ID（G が initiative.decision の evidence_segment_ids に使う）。 */
      evidence_segment_ids: Verified<number[]> | null;
      /** WITHDRAW で、照合を通った後続区間 ID。 */
      withdraw_evidence_segment_ids: Verified<number[]> | null;
    }
  | Rejection;

export type TransitionResult =
  | { ok: true; record: CandidateRecord; from: CandidateState; to: CandidateState }
  | Rejection;

export type SpeechStartResult =
  | { ok: true; record: CandidateRecord; generation: number }
  | (Rejection & { speech_refusal: SpeechStartRefusal | null });

/** 追補2の時刻。すべて実測で、別々に持つ。cue_at、speech_at は E2／D の報告を写すだけ。 */
export interface CandidateTimeline {
  decided_at: number;
  cue_at: number | null;
  speech_at: number | null;
  resolved_at: number | null;
}

/** 撤回の記録（追補2の withdraw_reason）。モデル由来とコード由来を区別する。 */
export type WithdrawRecord =
  | {
      source: 'model_decision';
      request_id: string;
      withdraw_reason: ModelOutput<string>;
      evidence_segment_ids: Verified<number[]>;
    }
  | { source: 'code'; cause: CandidateCause };

/** E2a が持つ候補の記録。契約の CandidateRecord の上位集合。 */
export interface LedgerRecord extends CandidateRecord {
  /** 最後に適用したモデル判定の request_id と revision。 */
  last_request_id: string;
  last_model_revision: number;
  /** 判定を受けた時刻（実測）。 */
  received_at: number;
  notes: CandidateModelNotes;
  timeline: CandidateTimeline;
  withdraw: WithdrawRecord | null;
  /** SPEAKING に入った再生。 */
  audio_playback_id: number | null;
}

/** 話し終えた後に届いた NEW。候補にはしない（E3 で調停する）。 */
export interface HeldDecision {
  decision: Extract<ModelDecision, { decision: 'NEW' }>;
  held_at: number;
  evidence_segment_ids: number[];
}

/** E2a が持つ want の正本。permitted（E1）と speaking（D）は持たない。 */
export type CandidateWant =
  | { kind: 'none' }
  | { kind: 'candidate'; candidate_id: string; candidate_version: number; state: CandidateState };
