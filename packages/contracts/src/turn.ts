/**
 * TurnManager の入出力（計画 §4.1）。`step(state, inputs, now) -> {state, decisions[]}` の純粋関数。
 * 実装は E1。session が固定周期で tick するので、VAP が止まっても時間は進む。
 * 準備の判断（Appendix A の A44〜54 相当）も decisions に含める。D は prepare/cancel を実行するだけ。
 *
 * 方策は引数ではなく TurnManagerFactory で束縛する（リプレイでは同じ方策で作り直す）。
 * 入力と出力は zod のスキーマを持つので、そのままログへ書いてリプレイに使える。
 */
import { z } from 'zod';
import { GazeTarget } from './browser_rpc';
import {
  AsrSegmentId,
  AudioFrameIndex,
  AudioPlaybackId,
  CandidateId,
  CandidateVersion,
  Maybe,
  MonotonicMs,
  NonEmptyString,
  NonNegativeInt,
  NonNegativeMs,
  Probability,
  SegmentId,
  Stability,
  StabilitySource,
  TimedWord,
  TimingPrecision,
  TranscriptRevision,
} from './common';
import type { Policy } from './policy';
import { Vap2chState } from './vap';

// ---- turn.allowed と gaze.decision の本体。イベントと decisions で共有する ------

/** 明示的な招待。STT の語句検出であり誤認しうる（仕様§4）。 */
export const Invitation = z.discriminatedUnion('detected', [
  z.strictObject({ detected: z.literal(false) }),
  z.strictObject({
    detected: z.literal(true),
    kind: z.enum(['go_ahead', 'direct_question', 'other']),
    phrase: NonEmptyString,
    segment_id: SegmentId,
    transcript_revision: TranscriptRevision,
  }),
]);
export type Invitation = z.infer<typeof Invitation>;

export const VapFreshness = z.enum(['fresh', 'stale', 'warming_up', 'down']);
export type VapFreshness = z.infer<typeof VapFreshness>;

/**
 * 発話開始の判定の入力すべて（仕様§4）。システムの暫定判断であり、譲渡を確定的に知ったとは扱わない。
 * VAP が使えないとき p_now と p_future は null と理由で、fallback_energy を別名で記録する。
 */
export const TurnAllowedPayload = z.strictObject({
  turn_allowed: z.boolean(),
  invitation: Invitation,
  user_speaking: z.boolean(),
  /** AI 側の値（p_now[p_ai_index]）。 */
  p_now: Maybe(Probability),
  p_future: Maybe(Probability),
  completion_p: Maybe(Probability),
  /** completion_p の元になった revision（U-9。ASR の遅れで p が古いことがある）。 */
  completion_revision: Maybe(TranscriptRevision),
  gap_ms: Maybe(NonNegativeMs),
  /** intent_type と会話上の価値から決める。urgency は使わない（計画 §4.5）。 */
  priority: Maybe(z.enum(['low', 'normal', 'high'])),
  policy_id: NonEmptyString,
  /** woz は Wizard-of-Oz の上書き。詳細は woz.override に残る。 */
  decision_source: z.enum(['vap', 'fallback', 'invitation', 'completion_timeout', 'woz']),
  vap_freshness: VapFreshness,
  /** degraded 時専用。VAP ではない。 */
  fallback_energy: Maybe(z.number()),
  reason: NonEmptyString,
});
export type TurnAllowedPayload = z.infer<typeof TurnAllowedPayload>;

/** 視線の判断（計画 §4.2）。 */
export const GazeDecisionPayload = z.strictObject({
  target: GazeTarget,
  reason: NonEmptyString,
  p_now: Maybe(Probability),
  p_future: Maybe(Probability),
  /** AI 発話中のポーズ（system チャネルの無音）か。 */
  in_speech_pause: z.boolean(),
  vap_freshness: VapFreshness,
});
export type GazeDecisionPayload = z.infer<typeof GazeDecisionPayload>;

// ---- 入力 ------------------------------------------------------------------

export const TranscriptSnapshot = z.strictObject({
  segment_id: SegmentId,
  asr_segment_id: AsrSegmentId,
  asr_segment_frame_start: AudioFrameIndex,
  transcript_revision: TranscriptRevision,
  text: z.string(),
  stable_text: z.string(),
  unstable_text: z.string(),
  is_final: z.boolean(),
  stability: Stability,
  stability_source: StabilitySource,
  audio_frame_end: AudioFrameIndex,
  timing_precision: TimingPrecision,
  words: Maybe(z.array(TimedWord)),
  received_at: MonotonicMs,
});
export type TranscriptSnapshot = z.infer<typeof TranscriptSnapshot>;

/** 応答の先行生成の状況（D が報告）。 */
export const PrefetchInput = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('idle') }),
  z.strictObject({
    state: z.literal('preparing'),
    audio_playback_id: AudioPlaybackId,
    segment_id: SegmentId,
    transcript_revision: TranscriptRevision,
    started_at: MonotonicMs,
  }),
  z.strictObject({
    state: z.literal('ready'),
    audio_playback_id: AudioPlaybackId,
    segment_id: SegmentId,
    transcript_revision: TranscriptRevision,
    started_at: MonotonicMs,
  }),
]);
export type PrefetchInput = z.infer<typeof PrefetchInput>;

/** AI の再生の状況（A の報告を J が渡す）。 */
export const PlaybackInput = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('idle') }),
  z.strictObject({
    state: z.literal('playing'),
    audio_playback_id: AudioPlaybackId,
    samples_written: NonNegativeInt,
    /** system チャネルが無音になってからの時間。発話中でなければ 0。 */
    system_silence_ms: NonNegativeMs,
  }),
]);
export type PlaybackInput = z.infer<typeof PlaybackInput>;

export const WozInput = z.strictObject({
  action: z.enum(['allow_turn', 'deny_turn', 'interrupt', 'force_gaze_user']),
  operator: NonEmptyString,
});
export type WozInput = z.infer<typeof WozInput>;

export const TurnInputs = z.strictObject({
  /** 最新の VAP_STATE。一度も届いていなければ null と理由。2ch のみ（1ch の値は渡せない）。 */
  vap: Maybe(Vap2chState),
  /** 最新の VAP_STATE を受信した orchestrator 時刻。 */
  vap_received_at: Maybe(MonotonicMs),
  /** 受信済み音声の先頭。鮮度切れの判定に使う（計画 §4.1）。 */
  received_audio_frame: AudioFrameIndex,
  /** ワーカーの再起動後は助走が過ぎるまで VAP を制御に使わない。 */
  vap_worker_started_at: Maybe(MonotonicMs),
  /** Node が音声枠から計算する。degraded 時専用で、VAP として扱わない。 */
  fallback_energy: Maybe(z.number()),
  transcript: Maybe(TranscriptSnapshot),
  completion_p: Maybe(Probability),
  completion_revision: Maybe(TranscriptRevision),
  /** 最新の認識文と、準備中または準備済みの入力文の類似度。初回は null と理由。 */
  similarity_to_prepared: Maybe(Probability),
  prefetch: PrefetchInput,
  playback: PlaybackInput,
  woz: z.array(WozInput),
});
export type TurnInputs = z.infer<typeof TurnInputs>;

// ---- 状態 ------------------------------------------------------------------

/**
 * 契約で固定する核の部分。E1 は TurnStateCore を拡張してよい（TurnManager<S> の S）。
 * ログに書けるように JSON 化できる値だけを持つ。
 */
export const TurnStateCore = z.looseObject({
  mode: z.enum(['listening', 'ai_speaking']),
  segment_id: SegmentId,
  user_speaking: z.boolean(),
  /** Appendix A の user_turn_end_time。 */
  user_turn_end_time: MonotonicMs.nullable(),
  last_prepare_at: MonotonicMs.nullable(),
  gaze_target: GazeTarget,
});
export type TurnStateCore = z.infer<typeof TurnStateCore>;

// ---- 出力 ------------------------------------------------------------------

export const TurnDecision = z.discriminatedUnion('kind', [
  /** 応答の先行生成を始める（古い準備があれば D が取り消す）。 */
  z.strictObject({
    kind: z.literal('prepare'),
    segment_id: SegmentId,
    transcript_revision: TranscriptRevision,
    text: z.string(),
    trigger: z.enum(['completion_threshold', 'asr_timeout', 'final_transcript']),
    similarity: Maybe(Probability),
  }),
  /** 未再生の準備だけが対象。再生中の音声は interrupt_speech で止める（hri2025_mapping の U-2）。 */
  z.strictObject({
    kind: z.literal('cancel_prepare'),
    audio_playback_id: AudioPlaybackId,
    reason: NonEmptyString,
  }),
  /** 準備済みの応答の再生を始める。候補の音声は Negotiator 側の経路で扱う。 */
  z.strictObject({
    kind: z.literal('start_speech'),
    audio_playback_id: AudioPlaybackId,
  }),
  /** 割り込みによる停止。語境界の判定は D、実行は A。 */
  z.strictObject({
    kind: z.literal('interrupt_speech'),
    audio_playback_id: AudioPlaybackId,
    stop_point: z.enum(['word_boundary', 'immediate']),
    max_wait_ms: NonNegativeMs,
    decision_source: z.enum(['vap', 'fallback', 'woz']),
    reason: NonEmptyString,
  }),
  /** ASR.reset の定義: AI が話し始めたら segment_id を増やす。所属は音声位置で決める（計画 §4.1）。 */
  z.strictObject({
    kind: z.literal('advance_segment'),
    new_segment_id: SegmentId,
    at_audio_frame: AudioFrameIndex,
  }),
  z.strictObject({ kind: z.literal('turn_allowed'), payload: TurnAllowedPayload }),
  z.strictObject({ kind: z.literal('gaze'), payload: GazeDecisionPayload }),
  /** degraded 表示の切替（計画 §4.1 の表）。 */
  z.strictObject({
    kind: z.literal('set_degraded'),
    degraded: z.boolean(),
    reason: NonEmptyString,
  }),
]);
export type TurnDecision = z.infer<typeof TurnDecision>;

export const TurnStepOutput = z.strictObject({
  state: TurnStateCore,
  decisions: z.array(TurnDecision),
});
export type TurnStepOutput = z.infer<typeof TurnStepOutput>;

/** 純粋関数の型。now は orchestrator の t_monotonic_ms。 */
export type TurnStep<S extends TurnStateCore = TurnStateCore> = (
  state: S,
  inputs: TurnInputs,
  now: number,
) => { state: S; decisions: TurnDecision[] };

export interface TurnManager<S extends TurnStateCore = TurnStateCore> {
  initialState(): S;
  step: TurnStep<S>;
}

/** 方策を束縛して TurnManager を作る。E1 はこの形の関数を公開する。 */
export type TurnManagerFactory<S extends TurnStateCore = TurnStateCore> = (
  policy: Policy,
) => TurnManager<S>;

/** 候補の参照。speech と Negotiator の連携で使う。 */
export const CandidateRef = z.strictObject({
  candidate_id: CandidateId,
  candidate_version: CandidateVersion,
});
export type CandidateRef = z.infer<typeof CandidateRef>;
