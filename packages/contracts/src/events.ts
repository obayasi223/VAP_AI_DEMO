/**
 * 研究ログのイベント（計画 §3.5）。`event` で判別する共用体で、すべて strict（未知の項目は不合格）。
 * 別名の扱い: 追補の decision_at／cue_at／speech_at は decided_at、signal.started_at、speech.started_at の
 * 分析ビュー上の別名であり、ここには持たない（計画 §3.6）。
 */
import { z } from 'zod';
import {
  AudioContextStateName,
  AudioLatency,
  GazeTarget,
  SignalParameters,
  SignalPhase,
  TrackSettings,
  VisibilityName,
} from './browser_rpc';
import { CandidateCause, CandidateRejectReason, CandidateState, ConversationKind, TimingVerdict } from './candidates';
import {
  AsrSegmentId,
  AudioFrameIndex,
  AudioPlaybackId,
  CandidateId,
  CandidateVersion,
  Condition,
  JsonValue,
  LlmPurpose,
  Maybe,
  MaybeModelOutput,
  ModelOutput,
  ModelVersion,
  MonotonicMs,
  NonEmptyString,
  NonNegativeInt,
  NonNegativeMs,
  Probability,
  ProviderClass,
  ProviderHealth,
  SegmentId,
  SessionId,
  SpokenTextPrecision,
  SttPart,
  Stability,
  StabilitySource,
  SystemChannelSource,
  TimedWord,
  TimingPrecision,
  TranscriptRevision,
  Verified,
  WallClock,
} from './common';
import { GazeDecisionPayload, PrepareTrigger, TurnAllowedPayload } from './turn';
import { Vap1chState, Vap2chState } from './vap';

export const EVENT_SCHEMA_VERSION = 1 as const;

/**
 * t_monotonic_ms の由来（追補2、計画 §3.4）。別プロセスの時刻は補正して入れ、推定誤差を残す。
 *  - orchestrator: 自身の時計（誤差 0）
 *  - browser_rtt: ブラウザの時刻を往復計測で補正
 *  - worker_audio_frame: Python ワーカーの結果を audio_frame と受信時刻で写像
 */
export const TimeBasis = z.strictObject({
  source: z.enum(['orchestrator', 'browser_rtt', 'worker_audio_frame']),
  uncertainty_ms: Maybe(NonNegativeMs),
});
export type TimeBasis = z.infer<typeof TimeBasis>;

/** 全イベント共通（計画 §3.5）。 */
const Envelope = {
  schema_version: z.literal(EVENT_SCHEMA_VERSION),
  t_monotonic_ms: MonotonicMs,
  wall_clock: WallClock,
  session_id: SessionId,
  condition: Condition,
  time_basis: TimeBasis,
};

export const ENVELOPE_FIELDS = [
  'schema_version',
  't_monotonic_ms',
  'wall_clock',
  'session_id',
  'condition',
  'time_basis',
] as const;
export type EnvelopeField = (typeof ENVELOPE_FIELDS)[number];

function eventSchema<Name extends string, Shape extends z.ZodRawShape>(name: Name, shape: Shape) {
  return z.strictObject({ ...Envelope, event: z.literal(name), ...shape });
}

// ---- STT -------------------------------------------------------------------

const SttShape = {
  /** stable_text と unstable_text の連結。 */
  text: z.string(),
  /** 合図の判定に使ってよい部分。final では text と同じ。 */
  stable_text: z.string(),
  unstable_text: z.string(),
  /** プロバイダの結果のまま。閾値を変えたリプレイに使う。derived の経路や final では1要素でよい。 */
  parts: z.array(SttPart),
  segment_id: SegmentId,
  /** evidence_segment_ids が指す ID。定義は common.ts の AsrSegmentId。 */
  asr_segment_id: AsrSegmentId,
  asr_segment_frame_start: AudioFrameIndex,
  transcript_revision: TranscriptRevision,
  /** parts の先頭の値。取れないモデルでは null と理由。0.0 は未設定の印なのでスキーマで拒否する（common.ts の Stability）。 */
  stability: Stability,
  stability_source: StabilitySource,
  audio_frame_end: AudioFrameIndex,
  /** audio_frame_end の精度（計画 §3.6）。 */
  timing_precision: TimingPrecision,
  /** 語時刻が取れれば t_content_evidence に使う（計画 §3.6）。 */
  words: Maybe(z.array(TimedWord)),
  /** ストリーム切替時の順序の確認用（計画 §5.1 C）。 */
  stream_id: NonEmptyString,
  provider: NonEmptyString,
  model_version: ModelVersion,
};
export const SttInterimEvent = eventSchema('stt.interim', SttShape);
export const SttFinalEvent = eventSchema('stt.final', SttShape);

/**
 * ストリーム切替の1回の記録（計画 §8）。provider.status は健全性だけを伝え、測定値はここに残す。
 * 切替の完了（B の最初の出力）か、次の切替か、セッションの終わりのうち早い時に出る。
 */
export const SttHandoverEvent = eventSchema('stt.handover', {
  provider: NonEmptyString,
  model_version: ModelVersion,
  from_stream: NonEmptyString,
  to_stream: NonEmptyString,
  /** silence と deadline は計画どおりの切替、active_failed は A の異常終了での繰り上げ。 */
  cause: z.enum(['silence', 'deadline', 'active_failed']),
  /** 切替点。これより前を A、後を B から採る。 */
  h_frame: AudioFrameIndex,
  /** A の経過時間。 */
  a_age_ms: NonNegativeMs,
  /** B へ音声を送っていた長さ。 */
  overlap_ms: NonNegativeMs,
  /** half-close から A が閉じるまで。 */
  drain_ms: Maybe(NonNegativeMs),
  /** A の final が来ず、最後の interim を final に昇格したら true。 */
  a_final_synthesized: z.boolean(),
  /** half-close から B の最初の出力まで。出力の止まった時間で、話者の無音を含みうる。 */
  first_b_emit_ms: Maybe(NonNegativeMs),
  /** B の先頭から取り除いた重複の文字数。 */
  stripped_chars: Maybe(NonNegativeInt),
  strip_method: Maybe(NonEmptyString),
  /** B の offset と B へ送った音声量の差。offset の基準の確認用。 */
  b_first_lag_ms: Maybe(z.number()),
});

// ---- LLM -------------------------------------------------------------------

/** リプレイの注入元。response は request_id で request の入力へ結ぶ。 */
export const LlmRequestEvent = eventSchema('llm.request', {
  request_id: NonEmptyString,
  purpose: LlmPurpose,
  input: JsonValue,
  transcript_revision: TranscriptRevision,
  sent_at: MonotonicMs,
  model_version: ModelVersion,
});
export const LlmResponseEvent = eventSchema('llm.response', {
  request_id: NonEmptyString,
  purpose: LlmPurpose,
  /** 失敗や途中キャンセルでは null と理由。 */
  output: MaybeModelOutput(JsonValue),
  transcript_revision: TranscriptRevision,
  sent_at: MonotonicMs,
  received_at: MonotonicMs,
  model_version: ModelVersion,
  /**
   * 思考を除く最初の本文の断片を受けた時刻。出力までの遅延の元（received_at は最後の受信）。
   * 本文が1文字も届かなかったときと、古いログには項目がない。
   */
  first_text_at: MonotonicMs.optional(),
});

// ---- VAP -------------------------------------------------------------------

export const VapStateEvent = z.discriminatedUnion('channel_layout', [
  eventSchema('vap.state', Vap2chState.shape),
  eventSchema('vap.state', Vap1chState.shape),
]);

// ---- 先行生成 --------------------------------------------------------------

const PrefetchShape = {
  segment_id: SegmentId,
  transcript_revision: TranscriptRevision,
  audio_playback_id: AudioPlaybackId,
  /** 初回は比較対象がないので null と理由。 */
  similarity: Maybe(Probability),
  similarity_method: NonEmptyString,
  model_version: ModelVersion,
};
export const PrefetchStartedEvent = eventSchema('prefetch.started', {
  ...PrefetchShape,
  /** TurnDecision.prepare の trigger をそのまま残す。 */
  trigger: PrepareTrigger.optional(),
});
export const PrefetchCancelledEvent = eventSchema('prefetch.cancelled', {
  ...PrefetchShape,
  cancel_reason: NonEmptyString,
  /** 取消の時点で保持していて棄てた TTS の chunk 数。取消の後に届いて棄てた分は数えない（発行の後に届くため）。 */
  discarded_chunks: NonNegativeInt.optional(),
  /** 棄てた chunk の合計サンプル数。単位は TTS の PCM のレート。 */
  discarded_samples: NonNegativeInt.optional(),
});
export const PrefetchReadyEvent = eventSchema('prefetch.ready', PrefetchShape);

// ---- 発話希望 --------------------------------------------------------------

export const InitiativeDecisionKind = z.enum(['NONE', 'NEW', 'KEEP', 'REVISE', 'WITHDRAW']);
export type InitiativeDecisionKind = z.infer<typeof InitiativeDecisionKind>;

/**
 * 既知の値は例示で、現時点では閉じない。LLM の分類は実モデルで確認する（追補2は v3 の列挙を導入しないと規定）。
 * 列挙を増やすのではなく文字列で受ける。
 */
const IntentType = NonEmptyString;
const ExpiryPolicy = NonEmptyString;
const Urgency = NonEmptyString;

/** LLM 要求の測定値と対応づけ。実測側の項目。 */
const InitiativeBase = {
  event: z.literal('initiative.decision'),
  segment_id: SegmentId,
  transcript_revision: TranscriptRevision,
  request_id: NonEmptyString,
  sent_at: MonotonicMs,
  received_at: MonotonicMs,
  model_version: ModelVersion,
};

/** 候補の中身。NEW と REVISE で必須。KEEP と WITHDRAW は既存の候補を指すので持たない。 */
const InitiativeCandidateBody = {
  candidate_id: CandidateId,
  candidate_version: CandidateVersion,
  // モデル出力（判定に使わない。追補1）
  intent_type: ModelOutput(IntentType),
  evidence_span: ModelOutput(z.string()),
  /** 空ならモデルが書かなかった（null と理由）。コードの値で埋めない。 */
  reason: MaybeModelOutput(z.string()),
  why_now: MaybeModelOutput(z.string()),
  cost_of_waiting: MaybeModelOutput(z.string()),
  proposed_utterance: ModelOutput(z.string()),
  expiry_policy: ModelOutput(ExpiryPolicy),
  /** ログのみ。turn_allowed の優先度に使わない（計画 §4.5）。 */
  urgency: ModelOutput(Urgency),
  // コードの検証結果
  evidence_valid: Verified(z.boolean()),
  /** ASR 区間 ID。入力との一致を検証した結果。 */
  evidence_segment_ids: Verified(z.array(AsrSegmentId)),
};

export const InitiativeDecisionEvent = z.discriminatedUnion('decision', [
  z.strictObject({
    ...Envelope,
    ...InitiativeBase,
    decision: z.literal('NONE'),
    reason: MaybeModelOutput(z.string()),
  }),
  z.strictObject({
    ...Envelope,
    ...InitiativeBase,
    ...InitiativeCandidateBody,
    decision: z.literal('NEW'),
    decided_at: MonotonicMs,
  }),
  z.strictObject({
    ...Envelope,
    ...InitiativeBase,
    candidate_id: CandidateId,
    candidate_version: CandidateVersion,
    decision: z.literal('KEEP'),
    updated_at: MonotonicMs,
    reason: MaybeModelOutput(z.string()),
    evidence_valid: Verified(z.boolean()),
  }),
  z.strictObject({
    ...Envelope,
    ...InitiativeBase,
    ...InitiativeCandidateBody,
    decision: z.literal('REVISE'),
    updated_at: MonotonicMs,
  }),
  z.strictObject({
    ...Envelope,
    ...InitiativeBase,
    candidate_id: CandidateId,
    candidate_version: CandidateVersion,
    decision: z.literal('WITHDRAW'),
    withdrawn_at: MonotonicMs,
    /** 空ならモデルが書かなかった（null と理由）。reason やコードの値で埋めない（追補2）。 */
    withdraw_reason: MaybeModelOutput(z.string()),
    /** モデルの判定全体の理由（withdraw_reason とは別の項目）。 */
    reason: MaybeModelOutput(z.string()),
    /** 撤回の判断に使った後続区間の ID（追補2）。入力と照合した結果なので Verified。 */
    withdraw_evidence_segment_ids: Verified(z.array(AsrSegmentId).min(1)),
  }),
]);
export type InitiativeDecisionEvent = z.infer<typeof InitiativeDecisionEvent>;

const InitiativeDropShape = {
  /** NEW の結果を棄てたときはまだ採番していないので null と理由。 */
  candidate_id: Maybe(CandidateId),
  reason: NonEmptyString,
  input_transcript_revision: TranscriptRevision,
  latest_transcript_revision: TranscriptRevision,
  revision_gap: NonNegativeInt,
};
export const InitiativeDiscardedEvent = eventSchema('initiative.discarded', InitiativeDropShape);
export const InitiativeAbortedEvent = eventSchema('initiative.aborted', InitiativeDropShape);

// ---- 発話希望の二段判定（docs/initiative_v3_design.md）--------------------------

/**
 * 生成段とタイミング段の結果に共通の項目。モデル名、プロンプトの版、会話の種類、入力の版と実測の遅延を、
 * 段ごとに別々に残す（「内容の妥当性」と「申し出る時点の適切さ」を別々に評価するため）。
 * LLM が書いた理由は ModelOutput で包み、ゲートも制御も読まない。
 */
const InitiativeStageMeta = {
  segment_id: SegmentId,
  /** LLM に渡した入力の版。 */
  transcript_revision: TranscriptRevision,
  /** llm.request と llm.response へ結ぶ。 */
  request_id: NonEmptyString,
  sent_at: MonotonicMs,
  received_at: MonotonicMs,
  /** received_at - sent_at（実測）。 */
  latency_ms: NonNegativeMs,
  model_version: ModelVersion,
  prompt_version: NonEmptyString,
  conversation_kind: ConversationKind,
  profile_version: NonNegativeInt,
  /** 渡した直近の会話の、会話履歴の版。履歴を渡していなければ null と理由。 */
  history_version: Maybe(NonNegativeInt),
  /** 今話している側の入力として渡した ASR 区間 ID。 */
  input_segment_ids: z.array(AsrSegmentId),
  /** 直近の会話として渡したターン数。 */
  recent_turn_count: NonNegativeInt,
};

/** コードのゲートの結果。理由はコードの値（gate.ts の理由）で、モデルの説明文は入れない。 */
const StageGate = Verified(z.strictObject({ passed: z.boolean(), reasons: z.array(NonEmptyString) }));

export const InitiativeDesireOutcome = z.enum([
  /** NONE（言いたいことは生じていない）を E2a に渡した。 */
  'none',
  /** NEW を候補にした。 */
  'registered',
  /** REVISE で候補の内容を更新した。 */
  'revised',
  /** コードのゲートで棄却した（gate の reasons）。 */
  'gate_rejected',
  /** 話の後に届いた NEW を E2a が保留した。 */
  'held',
  /** 保留していた NEW を、人の再開で候補にした。 */
  'held_promoted',
  /** E2a が受け付けなかった（ledger_reason）。 */
  'rejected',
]);
export type InitiativeDesireOutcome = z.infer<typeof InitiativeDesireOutcome>;

/**
 * 生成段の結果（言いたいことが生じたかと、その内容）。「今言うべきか」はここに入らない。
 * desire の値は initiative.decision の正本（NONE/NEW/REVISE）の部分集合。
 */
export const InitiativeDesireEvent = eventSchema('initiative.desire', {
  ...InitiativeStageMeta,
  desire: z.enum(['NONE', 'NEW', 'REVISE']),
  /** 候補にならなかったときは null と理由。 */
  candidate_id: Maybe(CandidateId),
  candidate_version: Maybe(CandidateVersion),
  intent_type: MaybeModelOutput(IntentType),
  proposed_utterance: MaybeModelOutput(z.string()),
  evidence_span: MaybeModelOutput(z.string()),
  /** LLM 生成の説明。ゲートも制御も読まない。 */
  reason: MaybeModelOutput(z.string()),
  /** 根拠になった今の発話の ASR 区間（コードで照合）。 */
  evidence_segment_ids: Maybe(Verified(z.array(AsrSegmentId))),
  /** 過去のターンの根拠の抜き出し。空なら null と理由。 */
  prior_turn_evidence_span: MaybeModelOutput(z.string()),
  /** 過去のターンの根拠をコードが見つけた位置。役割は input の値。 */
  prior_turn_evidence: Maybe(
    Verified(z.strictObject({ turn_index: NonNegativeInt, role: z.enum(['user', 'ai']) })),
  ),
  gate: StageGate,
  outcome: InitiativeDesireOutcome,
  ledger_reason: Maybe(NonEmptyString),
});

const TimingBody = {
  candidate_id: CandidateId,
  candidate_version: CandidateVersion,
  /** 同じ起動の生成段の request_id。 */
  desire_request_id: NonEmptyString,
  segment_id: SegmentId,
  transcript_revision: TranscriptRevision,
  conversation_kind: ConversationKind,
  profile_version: NonNegativeInt,
  outcome: z.enum(['kept', 'withdrawn', 'gate_rejected', 'rejected']),
  ledger_reason: Maybe(NonEmptyString),
};

/**
 * タイミング段の結果（話の途中で申し出る／話し終わりまで待つ／取り下げる）。生成段とは別のイベント。
 * immediate は LLM を呼ばないので遅延の項目を持たない。v2 は1段判定なのでこのイベントを出さない。
 */
export const InitiativeTimingEvent = z.discriminatedUnion('timing_strategy', [
  eventSchema('initiative.timing', {
    ...TimingBody,
    timing_strategy: z.literal('llm'),
    timing: TimingVerdict,
    request_id: NonEmptyString,
    sent_at: MonotonicMs,
    received_at: MonotonicMs,
    latency_ms: NonNegativeMs,
    model_version: ModelVersion,
    prompt_version: NonEmptyString,
    history_version: Maybe(NonNegativeInt),
    input_segment_ids: z.array(AsrSegmentId),
    recent_turn_count: NonNegativeInt,
    // LLM 生成。ゲートも制御も読まない。
    reason: MaybeModelOutput(z.string()),
    why_now: MaybeModelOutput(z.string()),
    cost_of_waiting: MaybeModelOutput(z.string()),
    withdraw_reason: MaybeModelOutput(z.string()),
    withdraw_evidence_segment_ids: Maybe(Verified(z.array(AsrSegmentId).min(1))),
    gate: StageGate,
  }),
  eventSchema('initiative.timing', {
    ...TimingBody,
    timing_strategy: z.literal('immediate'),
    timing: z.literal('OFFER_NOW'),
    decided_at: MonotonicMs,
    /** LLM を呼んでいない。 */
    model_call: z.literal(false),
  }),
]);
export type InitiativeTimingEvent = z.infer<typeof InitiativeTimingEvent>;

/**
 * 候補の状態遷移。発行は E（候補の状態の正本）。
 * モデル由来の撤回は initiative.decision(WITHDRAW) が withdraw_reason の項目を必ず持ち（空なら null と理由）、ここからは
 * request_id で指す。コード由来（期限切れ、根拠の消失など）はモデルの理由を持たないので cause で区別する。
 */
export const CandidateStateChangedEvent = z.discriminatedUnion('cause_source', [
  eventSchema('candidate.state_changed', {
    candidate_id: CandidateId,
    candidate_version: CandidateVersion,
    /** 登録と同時に棄却した候補は null。 */
    from: CandidateState.nullable(),
    to: CandidateState,
    cause_source: z.literal('code'),
    cause: CandidateCause,
  }),
  eventSchema('candidate.state_changed', {
    candidate_id: CandidateId,
    candidate_version: CandidateVersion,
    /** 登録と同時に棄却した候補は null。 */
    from: CandidateState.nullable(),
    to: CandidateState,
    cause_source: z.literal('model_decision'),
    decision: z.enum(['NEW', 'REVISE', 'WITHDRAW']),
    /** 元の initiative.decision と llm.response の request_id。 */
    request_id: NonEmptyString,
  }),
]);

/**
 * E2a が受け付けなかった要求（計画 §5 E2a の「不正な遷移は拒否して理由を残す」）。発行は E。
 * source=model_decision は G から渡された判定、code は制御器（E2、E3、J）からの遷移の要求。
 * held=true は棄てずに保留したもの（話の後に届いた NEW。E3 で調停する）。
 */
export const CandidateRejectedEvent = eventSchema('candidate.rejected', {
  /** 採番の前に棄てた NEW は null と理由。 */
  candidate_id: Maybe(CandidateId),
  candidate_version: Maybe(CandidateVersion),
  source: z.enum(['model_decision', 'code']),
  operation: z.enum(['NONE', 'NEW', 'KEEP', 'REVISE', 'WITHDRAW', 'transition', 'speech_start', 'held']),
  /** 要求の時点の状態。候補がなければ null。 */
  current_state: CandidateState.nullable(),
  /** 要求された状態。KEEP など状態を変えない要求は null。 */
  requested_state: CandidateState.nullable(),
  /** code の要求の原因。model_decision では null。 */
  cause: CandidateCause.nullable(),
  /** model_decision の元の request_id。 */
  request_id: Maybe(NonEmptyString),
  reason: CandidateRejectReason,
  /** 検証の内訳（gate の理由、D の拒否理由など）。コードの値で、モデルの説明文は入れない。 */
  details: z.array(NonEmptyString),
  held: z.boolean(),
  input_transcript_revision: Maybe(TranscriptRevision),
  /** すでに適用した判定の最大の transcript_revision。 */
  applied_transcript_revision: Maybe(TranscriptRevision),
});

// ---- 合図 ------------------------------------------------------------------

const SignalShape = {
  candidate_id: CandidateId,
  phase: SignalPhase,
  parameters: SignalParameters,
};
export const SignalSentEvent = eventSchema('signal.sent', {
  ...SignalShape,
  sent_at: MonotonicMs,
});
/** started_at は最初に描画した rAF の時刻。背景タブで描画されなければ null と理由（visible=false）。 */
export const SignalStartedEvent = z.discriminatedUnion('visible', [
  eventSchema('signal.started', {
    ...SignalShape,
    visible: z.literal(true),
    started_at: MonotonicMs,
  }),
  eventSchema('signal.started', {
    ...SignalShape,
    visible: z.literal(false),
    started_at: z.null(),
    null_reason: NonEmptyString,
  }),
]);
export const SignalEndedEvent = eventSchema('signal.ended', {
  ...SignalShape,
  visible: z.boolean(),
  ended_at: Maybe(MonotonicMs),
});

/**
 * 発話希望の交渉の判断（計画 §4.6。E2 の合図のゲートと、E3 の発話の選択）。判断か理由が変わったときだけ出す。
 *  - signal_gate: 合図（吸気）を出したか、出さなかった理由。条件 reactive と initiative_no_cue では合図しない理由を残す。
 *  - speech_selection: 発話の許可（turn_allowed）が出ている間に、候補と通常の応答のどちらを話すか（または待つか）。
 * outcome と reasons はコードの値で、モデルの説明文は入れない。urgency は使わない（計画 §4.5）。
 */
export const NegotiationDecisionEvent = eventSchema('negotiation.decision', {
  /** candidate_audio は候補の先行音声の段階（outcome が audio_preparing／audio_ready／audio_failed／audio_abandoned）。 */
  stage: z.enum(['signal_gate', 'speech_selection', 'candidate_audio']),
  candidate_id: Maybe(CandidateId),
  candidate_version: Maybe(CandidateVersion),
  candidate_state: CandidateState.nullable(),
  outcome: NonEmptyString,
  reasons: z.array(NonEmptyString),
});

// ---- 発話開始の判定、視線 ---------------------------------------------------

export const TurnAllowedEvent = eventSchema('turn.allowed', TurnAllowedPayload.shape);
export const GazeDecisionEvent = eventSchema('gaze.decision', GazeDecisionPayload.shape);

// ---- 発話 ------------------------------------------------------------------

/** 発話の種類ごとの型。通常の応答に candidate_id は不要。 */
function speechEvent<Name extends string, Shape extends z.ZodRawShape>(name: Name, shape: Shape) {
  return z.discriminatedUnion('origin', [
    eventSchema(name, { ...shape, origin: z.literal('response') }),
    eventSchema(name, {
      ...shape,
      origin: z.literal('candidate'),
      candidate_id: CandidateId,
      candidate_version: CandidateVersion,
    }),
  ]);
}

const SpeechShape = {
  audio_playback_id: AudioPlaybackId,
  audio_frame: AudioFrameIndex,
  /** t_speech_start。最初の PCM を書き込んだ時刻＋outputLatency（計画 §3.6）。 */
  started_at: MonotonicMs,
  first_pcm_written_at: MonotonicMs,
  output_latency_ms: Maybe(NonNegativeMs),
};
const SpeechFinishShape = {
  ...SpeechShape,
  /** 実際に声として出た箇所だけ。履歴にはこれを入れる。 */
  spoken_text: z.string(),
  spoken_text_precision: SpokenTextPrecision,
  samples_written: NonNegativeInt,
  /**
   * TTS へ実際に送った文。読みの変換（TTS_READING_MODE）で元の文と違うときだけ付く。spoken_text は元の文のまま。
   */
  tts_text: z.string().optional(),
};
export const SpeechStartedEvent = speechEvent('speech.started', SpeechShape);
export const SpeechEndedEvent = speechEvent('speech.ended', {
  ...SpeechFinishShape,
  ended_at: MonotonicMs,
});
export const SpeechInterruptedEvent = speechEvent('speech.interrupted', {
  ...SpeechFinishShape,
  interrupted_at: MonotonicMs,
  stop_point: z.enum(['word_boundary', 'fade_at_limit', 'immediate']),
  decision_source: z.enum(['vap', 'fallback', 'woz']),
});

// ---- 音声の健全性 ----------------------------------------------------------

/** ブラウザとワーカーで観測できる項目が違うので分ける。 */
export const AudioHealthEvent = z.discriminatedUnion('reporter', [
  eventSchema('audio.health', {
    reporter: z.literal('browser'),
    audio_frame: AudioFrameIndex,
    frames_lost: NonNegativeInt,
    underrun_count: NonNegativeInt,
    underrun_total_ms: NonNegativeMs,
    stale_pcm_frames_dropped: NonNegativeInt,
    latency: AudioLatency,
    track_settings: TrackSettings,
    system_ch_source: SystemChannelSource,
    audio_context_state: AudioContextStateName,
    visibility: VisibilityName,
    // 定義は browser_rpc.ts の AudioReport。
    reconnects: NonNegativeInt.optional(),
    orphan_pcm_frames: NonNegativeInt.optional(),
    pcm_seq_gaps: NonNegativeInt.optional(),
    render_lag_ms: z.number().optional(),
  }),
  eventSchema('audio.health', {
    reporter: z.literal('worker'),
    audio_frame: AudioFrameIndex,
    frames_dropped_network: NonNegativeInt,
    frames_dropped_overload: NonNegativeInt,
    queue_depth: NonNegativeInt,
    rtf: Maybe(z.number().min(0)),
    system_ch_source: SystemChannelSource,
  }),
]);

// ---- プロバイダ、費用、WoZ --------------------------------------------------

export const ProviderStatusEvent = eventSchema('provider.status', {
  provider: NonEmptyString,
  /** development と test_double は受け入れの証拠に数えない（計画 §4.8）。 */
  provider_class: ProviderClass,
  status: ProviderHealth,
  reason: Maybe(NonEmptyString),
  retry_attempt: NonNegativeInt,
  next_retry_ms: Maybe(NonNegativeMs),
});

export const CostUsageEvent = eventSchema('cost.usage', {
  provider: NonEmptyString,
  purpose: NonEmptyString,
  quantity: z.number().min(0),
  unit: NonEmptyString,
  /** 料金が未確認のときは null と理由（偽の値を入れない）。 */
  estimated_cost_usd: Maybe(z.number().min(0)),
});

export const WozOverrideEvent = eventSchema('woz.override', {
  action: NonEmptyString,
  operator: NonEmptyString,
  detail: JsonValue,
});

// ---- 時計差（追補2、計画 §3.4） ----------------------------------------------

export const ClockSyncEvent = eventSchema('clock.sync', {
  source: z.enum(['browser_rtt', 'worker_audio_frame']),
  /** orchestrator 時刻 = ローカル時刻 + offset_ms */
  offset_ms: z.number(),
  /** 推定誤差。browser_rtt では RTT の半分。 */
  error_ms: NonNegativeMs,
  rtt_ms: Maybe(NonNegativeMs),
});

// ---- セッションの接続、視線の描画（J が追加） -------------------------------------

/**
 * client.hello の内容の記録。AudioContext の実際のレートと user_agent をログに残す（計画 §3.2）。
 * 時刻は Node が受けた時刻（時計差の推定より前に届くので補正できない）。中身はブラウザの申告のまま。
 */
export const SessionClientEvent = eventSchema('session.client', {
  protocol_version: z.number().int().min(1),
  audio_context_sample_rate_hz: z.number().positive(),
  frame_samples: z.number().int().min(1),
  user_agent: z.string(),
  track_settings: TrackSettings,
  latency: AudioLatency,
  /** new_session は新しいセッション、reattached は切断後の同じセッションへの再接続。 */
  connection: z.enum(['new_session', 'reattached']),
});

/** gaze.report の記録。G1 の「gaze.decision が描画に反映される」の証拠。rendered_at は rAF の時刻。 */
export const GazeRenderedEvent = z.discriminatedUnion('visible', [
  eventSchema('gaze.rendered', { target: GazeTarget, visible: z.literal(true), rendered_at: MonotonicMs }),
  eventSchema('gaze.rendered', {
    target: GazeTarget,
    visible: z.literal(false),
    rendered_at: z.null(),
    null_reason: NonEmptyString,
  }),
]);

// ---- 研究者のメモ（I2 が追加） ------------------------------------------------

/**
 * 研究者画面の自由回答の欄から送ったメモ（research_rpc.ts の research.note）。
 * 時刻は Node が受けた時刻。研究者のブラウザの時計は補正していないので、client_wall_clock は参考値。
 * 本文は人が書いたもので、モデル出力でも実測でもない。
 */
export const ResearchNoteEvent = eventSchema('research.note', {
  note_id: NonEmptyString,
  text: z.string().min(1).max(4000),
  client_wall_clock: WallClock,
});

// ---- 全体 ------------------------------------------------------------------

export const ResearchEvent = z.discriminatedUnion('event', [
  SttInterimEvent,
  SttFinalEvent,
  SttHandoverEvent,
  LlmRequestEvent,
  LlmResponseEvent,
  VapStateEvent,
  PrefetchStartedEvent,
  PrefetchCancelledEvent,
  PrefetchReadyEvent,
  InitiativeDecisionEvent,
  InitiativeDiscardedEvent,
  InitiativeAbortedEvent,
  InitiativeDesireEvent,
  InitiativeTimingEvent,
  CandidateStateChangedEvent,
  CandidateRejectedEvent,
  SignalSentEvent,
  SignalStartedEvent,
  SignalEndedEvent,
  NegotiationDecisionEvent,
  TurnAllowedEvent,
  SpeechStartedEvent,
  SpeechEndedEvent,
  SpeechInterruptedEvent,
  GazeDecisionEvent,
  AudioHealthEvent,
  ProviderStatusEvent,
  CostUsageEvent,
  WozOverrideEvent,
  ClockSyncEvent,
  SessionClientEvent,
  GazeRenderedEvent,
  ResearchNoteEvent,
]);
export type ResearchEvent = z.infer<typeof ResearchEvent>;
export type ResearchEventName = ResearchEvent['event'];

/** 計画 §3.5 の表のイベント名すべて（第5版の追加を含む）。 */
export const EVENT_NAMES = [
  'stt.interim',
  'stt.final',
  'stt.handover',
  'llm.request',
  'llm.response',
  'vap.state',
  'prefetch.started',
  'prefetch.cancelled',
  'prefetch.ready',
  'initiative.decision',
  'initiative.discarded',
  'initiative.aborted',
  'initiative.desire',
  'initiative.timing',
  'candidate.state_changed',
  'signal.sent',
  'signal.started',
  'signal.ended',
  'turn.allowed',
  'speech.started',
  'speech.ended',
  'speech.interrupted',
  'gaze.decision',
  'audio.health',
  'provider.status',
  'cost.usage',
  'woz.override',
  'clock.sync',
  'session.client',
  'gaze.rendered',
  'research.note',
  'candidate.rejected',
  'negotiation.decision',
] as const satisfies readonly ResearchEventName[];

export type EventOf<N extends ResearchEventName> = Extract<ResearchEvent, { event: N }>;
