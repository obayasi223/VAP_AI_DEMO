/**
 * config/policy.hri2025.json と config/policy.ja.json のスキーマ（計画 §4.1）。
 *
 * hri2025 は Appendix A の原著値。リテラルで固定しているので、値を変えるとスキーマ検証で落ちる。
 * 英語 Furhat の値であり、日本語で最適とは主張しない。
 *
 * ja は日本語調整値。未校正の値は null を許し、status で状態を示す。
 * 節の持ち主: turn、gaze は E、similarity、completion は D、initiative は G。
 */
import { z } from 'zod';
import { ChannelLayout, NonEmptyString, NonNegativeMs, Probability } from './common';

/**
 * Appendix A の定数の形。hri2025 では値もリテラルで固定する。
 *
 * ja では TURNGPT_PREPARE_THRESHOLD と SIMILARITY_PREPARE_THRESHOLD を読まない。正本は completion.thresholds と
 * similarity.threshold で、prepareThresholds() から読む（理由は docs/known_gaps.md）。項目は後方互換のために残す。
 */
const TurnConstantsShape = {
  TURNGPT_PREPARE_THRESHOLD: Probability,
  ASR_PREPARE_TIMEOUT_MS: NonNegativeMs,
  SIMILARITY_PREPARE_THRESHOLD: Probability,
  VAP_PNOW_INTERRUPT: Probability,
  VAP_PFUT_INTERRUPT: Probability,
  VAP_PNOW_YIELD: Probability,
  VAP_PFUT_YIELD: Probability,
  MIN_GAP_TIME_MS: NonNegativeMs,
  YIELD_TIMEOUTS_MS: z.strictObject({
    '0.3': NonNegativeMs,
    '0.2': NonNegativeMs,
    '0.1': NonNegativeMs,
    '0.0': NonNegativeMs,
  }),
};

export const TurnConstants = z.strictObject(TurnConstantsShape);
export type TurnConstants = z.infer<typeof TurnConstants>;

/**
 * 計画 §4.1 の解釈の切替。
 *  - user_turn_end_updates_during_speech: true は発話中の分岐でも更新する（0ms 許可を防ぐ、計画の既定）。
 *    false は擬似コードどおり。
 *  - stop_point: word_boundary は語境界（上限つき、本文の記述）、immediate は比較用の即時停止
 *    （擬似コードは停止点を規定しない。docs/hri2025_mapping.md の I-2）。
 */
export const TurnInterpretation = z.strictObject({
  user_turn_end_updates_during_speech: z.boolean(),
  stop_point: z.enum(['word_boundary', 'immediate']),
  /** docs/hri2025_mapping.md の U 項目の補正を入れるか。false は擬似コードどおり（original）。 */
  apply_u_corrections: z.boolean(),
});
export type TurnInterpretation = z.infer<typeof TurnInterpretation>;

const VapDirection = z.strictObject({
  channel_layout: z.literal('2ch' satisfies ChannelLayout),
  /** p_now_ai = p_now[p_ai_index]。 */
  p_ai_index: z.union([z.literal(0), z.literal(1)]),
  /** R2 の実測前は provisional。 */
  direction_status: z.enum(['provisional', 'measured']),
  /** vad をこの値以上で speaking とする。 */
  speaking_threshold: Probability,
});

export const PolicyHri2025 = z.strictObject({
  $schema: z.string().optional(),
  policy_id: z.literal('hri2025'),
  immutable: z.literal(true),
  source: z.literal('Skantze & Irfan, HRI 2025, Appendix A'),
  note: z.literal(
    'English/Furhat pilot values kept for comparison. Not claimed to be optimal for Japanese.',
  ),
  constants: z.strictObject({
    TURNGPT_PREPARE_THRESHOLD: z.literal(0.2),
    ASR_PREPARE_TIMEOUT_MS: z.literal(200),
    SIMILARITY_PREPARE_THRESHOLD: z.literal(0.8),
    VAP_PNOW_INTERRUPT: z.literal(0.4),
    VAP_PFUT_INTERRUPT: z.literal(0.4),
    VAP_PNOW_YIELD: z.literal(0.5),
    VAP_PFUT_YIELD: z.literal(0.5),
    MIN_GAP_TIME_MS: z.literal(500),
    YIELD_TIMEOUTS_MS: z.strictObject({
      '0.3': z.literal(500),
      '0.2': z.literal(1000),
      '0.1': z.literal(2000),
      '0.0': z.literal(3000),
    }),
  }),
  /** 擬似コードどおりの挙動。計画の既定との差は docs/hri2025_mapping.md に記録する（R1）。 */
  interpretation: z.strictObject({
    user_turn_end_updates_during_speech: z.literal(false),
    stop_point: z.literal('immediate'),
    apply_u_corrections: z.literal(false),
  }),
});
export type PolicyHri2025 = z.infer<typeof PolicyHri2025>;

/** null は未校正。使う側は null を見たら黙って別の値へ置き換えず、未校正として扱う。 */
const Uncalibrated = (schema: z.ZodType<number>) => schema.nullable();

/**
 * InitiativeMonitor の起動の条件（計画 §4.5）。正規化後の新規の安定文字数で数える。
 * 値は【未検証の暫定値】で、実測の根拠はまだない。
 */
export const InitiativeTrigger = z.strictObject({
  /** 新規の安定文字数がこれ以上で起動。 */
  min_new_stable_chars: z.number().int().min(1),
  /** 文の区切りまたは final があるとき、これ以上で起動。null で文の区切りを見ない（final は常に見る）。 */
  min_new_chars_at_boundary: z.number().int().min(1).nullable(),
});
export type InitiativeTrigger = z.infer<typeof InitiativeTrigger>;

export const PolicyJa = z.strictObject({
  $schema: z.string().optional(),
  policy_id: z.literal('ja'),
  immutable: z.literal(false),
  status: z.enum(['template', 'provisional', 'calibrated']),
  note: NonEmptyString,
  vap: VapDirection,
  turn: z.strictObject({
    constants: TurnConstants,
    interpretation: TurnInterpretation,
    /** 計画の【暫定】値。 */
    tick_ms: z.number().min(1),
    stop_boundary_max_ms: NonNegativeMs,
    vap_stale_ms: NonNegativeMs,
    vap_rewarm_ms: NonNegativeMs,
    /** user_speaking の最短継続（hri2025_mapping の U-7）。null は原著どおりなし。 */
    user_speaking_min_ms: Uncalibrated(NonNegativeMs),
    /** VAP の鮮度切れ時の代替（計画 §4.1 の表）。VAP ではない。 */
    fallback_silence_max_ms: Uncalibrated(NonNegativeMs),
    fallback_interrupt_min_words: Uncalibrated(z.number().int().min(1)),
  }),
  gaze: z.strictObject({
    /** 原著に数値の閾値はない（計画 §4.2）。 */
    pause_min_ms: Uncalibrated(NonNegativeMs),
    /** p_now と p_future のどちらで判定するか、原著に書かれていない（計画 §4.2）。 */
    signal: z.enum(['p_now', 'p_future']).nullable(),
    p_threshold: Uncalibrated(Probability),
  }),
  similarity: z.strictObject({
    method: NonEmptyString,
    /** 手法が原著と違うので 0.8 をそのまま適用しない（計画 §4.1）。 */
    threshold: Uncalibrated(Probability),
  }),
  completion: z.strictObject({
    /** 使う推定器の名前。推定器なしは null（仕様§7-4）。 */
    estimator: NonEmptyString.nullable(),
    /** 推定器ごとの閾値表（計画 §4.4）。 */
    thresholds: z.record(
      z.string(),
      z.strictObject({ prepare_threshold: Uncalibrated(Probability) }),
    ),
  }),
  initiative: z.strictObject({
    /** 鮮度の上限（計画 §4.5）: 入力以降の新規安定テキスト量と経過時間。 */
    max_new_stable_chars_since_input: Uncalibrated(z.number().int().min(0)),
    max_result_age_ms: Uncalibrated(NonNegativeMs),
    min_stability: Uncalibrated(Probability),
    /** stability が取れないモデルの代替: 連続 N revision で不変の接頭部（計画 §4.5）。 */
    stable_prefix_revisions: Uncalibrated(z.number().int().min(1)),
    stable_prefix_min_age_ms: Uncalibrated(NonNegativeMs),
    /** 候補の期限。expiry_policy とは別に、コード側で強制する上限。 */
    candidate_expiry_ms: Uncalibrated(NonNegativeMs),
    /** segment_id の変更でも期限切れにするか（計画 §4.6）。 */
    candidate_expires_on_segment_change: z.boolean().nullable(),
    /** 合図のゲート（計画 §4.6）。 */
    signal_cooldown_ms: Uncalibrated(NonNegativeMs),
    max_active_candidates: z.number().int().min(1),
    max_requests_per_session: Uncalibrated(z.number().int().min(1)),
    trigger: InitiativeTrigger.optional(),
  }),
  speech: z.strictObject({
    /** is_ready の定義。最初の PCM がこの長さバッファされた状態（計画 §4.3）。 */
    is_ready_buffer_ms: NonNegativeMs,
  }),
});
export type PolicyJa = z.infer<typeof PolicyJa>;

export const Policy = z.discriminatedUnion('policy_id', [PolicyHri2025, PolicyJa]);
export type Policy = z.infer<typeof Policy>;

/** TurnManager が読む部分を、どちらの方策からでも同じ形で取り出す。 */
export function turnConstants(policy: Policy): TurnConstants {
  return policy.policy_id === 'hri2025' ? policy.constants : policy.turn.constants;
}

export function turnInterpretation(policy: Policy): TurnInterpretation {
  return policy.policy_id === 'hri2025' ? policy.interpretation : policy.turn.interpretation;
}

/** 準備の2つの閾値。null は未校正または推定器なしで、黙って別の値へ置き換えない。 */
export interface PrepareThresholds {
  completion_prepare_threshold: number | null;
  similarity_prepare_threshold: number | null;
}

/**
 * 準備の閾値の唯一の読み口。TurnManager は turnConstants() の同名の項目を読まない。
 *  - hri2025: Appendix A の constants（原著の値を再現するため）。
 *  - ja: 使う推定器の completion.thresholds と similarity.threshold。推定器と類似度の手法が原著と違い、
 *    尺度が合わないので、turn.constants の値は使わない（計画 §4.1、§4.4）。
 */
export function prepareThresholds(policy: Policy): PrepareThresholds {
  if (policy.policy_id === 'hri2025') {
    return {
      completion_prepare_threshold: policy.constants.TURNGPT_PREPARE_THRESHOLD,
      similarity_prepare_threshold: policy.constants.SIMILARITY_PREPARE_THRESHOLD,
    };
  }
  const { estimator, thresholds } = policy.completion;
  return {
    completion_prepare_threshold:
      estimator === null ? null : (thresholds[estimator]?.prepare_threshold ?? null),
    similarity_prepare_threshold: policy.similarity.threshold,
  };
}
