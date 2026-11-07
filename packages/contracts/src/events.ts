/**
 * 研究ログのイベント（計画 §3.5）。`event` で判別する共用体で、すべて strict（未知の項目は不合格）。
 * 別名の扱い: 追補の decision_at／cue_at／speech_at は decided_at、signal.started_at、speech.started_at の
 * 分析ビュー上の別名であり、ここには持たない（計画 §3.6）。
 */
import { z } from 'zod';
import {
  AudioContextStateName,
  AudioLatency,
  SignalParameters,
  SignalPhase,
  TrackSettings,
  VisibilityName,
} from './browser_rpc';
import { CandidateCause, CandidateState } from './candidates';
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
import { GazeDecisionPayload, TurnAllowedPayload } from './turn';
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
export const PrefetchStartedEvent = eventSchema('prefetch.started', PrefetchShape);
export const PrefetchCancelledEvent = eventSchema('prefetch.cancelled', {
  ...PrefetchShape,
  cancel_reason: NonEmptyString,
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
  reason: ModelOutput(z.string()),
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
    withdraw_reason: ModelOutput(z.string()),
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

/**
 * 候補の状態遷移。発行は E（候補の状態の正本）。
 * モデル由来の撤回は initiative.decision(WITHDRAW) が withdraw_reason を必ず持ち、ここからは
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

// ---- 全体 ------------------------------------------------------------------

export const ResearchEvent = z.discriminatedUnion('event', [
  SttInterimEvent,
  SttFinalEvent,
  LlmRequestEvent,
  LlmResponseEvent,
  VapStateEvent,
  PrefetchStartedEvent,
  PrefetchCancelledEvent,
  PrefetchReadyEvent,
  InitiativeDecisionEvent,
  InitiativeDiscardedEvent,
  InitiativeAbortedEvent,
  CandidateStateChangedEvent,
  SignalSentEvent,
  SignalStartedEvent,
  SignalEndedEvent,
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
]);
export type ResearchEvent = z.infer<typeof ResearchEvent>;
export type ResearchEventName = ResearchEvent['event'];

/** 計画 §3.5 の表のイベント名すべて（第5版の追加を含む）。 */
export const EVENT_NAMES = [
  'stt.interim',
  'stt.final',
  'llm.request',
  'llm.response',
  'vap.state',
  'prefetch.started',
  'prefetch.cancelled',
  'prefetch.ready',
  'initiative.decision',
  'initiative.discarded',
  'initiative.aborted',
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
] as const satisfies readonly ResearchEventName[];

export type EventOf<N extends ResearchEventName> = Extract<ResearchEvent, { event: N }>;
