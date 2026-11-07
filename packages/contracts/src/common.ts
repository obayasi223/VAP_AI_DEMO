/**
 * 契約全体で使う部品。
 *
 * 規則（計画 §3.5）:
 *  - 値が本来ありうるのに得られないときは Maybe を使い、`{value: null, null_reason}` で理由を残す。偽の値は入れない。
 *  - 値が場面の上で不要なものは、判別共用体の側で項目ごと持たない（NONE に candidate_id は無い）。
 *  - 省略可能な項目は原則作らない。すべて必須にして、欠落はスキーマ試験で検出する。
 *    例外は、発行側と受信側を同時に変えられない後方互換の追加のみ（fixtures.ts の OPTIONAL_FIXTURES に載せる）。
 *  - モデルが書いたものは ModelOutput、コードが検証したものは Verified で包む。
 *    包まない数値の時刻は orchestrator が実測した値。型が違うので取り違えるとコンパイルと検証で落ちる。
 */
import { z } from 'zod';

const U32_MAX = 0xffffffff;

export const NonEmptyString = z.string().min(1);
export const Probability = z.number().min(0).max(1);
export const NonNegativeMs = z.number().min(0);
/** orchestrator の基準に揃えたセッション単調時刻（ミリ秒）。ブラウザ等の値は補正してから入れる。 */
export const MonotonicMs = z.number().min(0);
export const WallClock = z.iso.datetime();
export const NonNegativeInt = z.number().int().min(0);
export const U32 = z.number().int().min(0).max(U32_MAX);

export const SessionId = NonEmptyString;
/** 16kHz サンプルの連番（計画 §3.2）。STT、VAP、再生の時間軸をこれで結ぶ。 */
export const AudioFrameIndex = U32;
/** AI が話し始めるたびに増える（ASR.reset の定義、計画 §4.1）。C が保持し、E が境界を決める。 */
export const SegmentId = NonNegativeInt;
/**
 * ASR 区間 ID。segment_id（AI の発話で区切る会話上の区間）とは別物。
 * STT が final の単位で振る。final までの interim は同じ ID を持ち、音声範囲は
 * asr_segment_frame_start から audio_frame_end まで。ストリームを切り替えても再利用しない。
 * evidence_segment_ids と撤回の後続区間 ID はこの ID を指す。
 */
export const AsrSegmentId = NonNegativeInt;
export const TranscriptRevision = NonNegativeInt;
/** 1回の発話音声の ID。バイナリ枠に入るので u32。0 は使わない。 */
export const AudioPlaybackId = z.number().int().min(1).max(U32_MAX);
/** セッション内で単調増加。停止命令のたびに増え、古い世代の PCM は全段で棄てる（計画 §4.3）。 */
export const Generation = U32;
/** E が採番する。LLM には生成させない（計画 §4.5）。 */
export const CandidateId = NonEmptyString;
export const CandidateVersion = z.number().int().min(1);
export const ModelVersion = NonEmptyString;

/** 研究条件（計画 §4.6）。 */
export const Condition = z.enum(['reactive', 'initiative_no_cue', 'initiative_inhale']);
export type Condition = z.infer<typeof Condition>;

/** ChannelLayout。1ch と 2ch は別の型にする（計画 §3.3）。 */
export const ChannelLayout = z.enum(['1ch', '2ch']);
export type ChannelLayout = z.infer<typeof ChannelLayout>;

// ---- 値がない場面 ----------------------------------------------------------

export type Maybe<T> = { value: T } | { value: null; null_reason: string };

/** 値、または null と理由。 */
export function Maybe<T extends z.ZodType>(value: T) {
  return z.union([
    z.strictObject({ value }),
    z.strictObject({ value: z.null(), null_reason: NonEmptyString }),
  ]);
}

export function present<T>(value: T): { value: T } {
  return { value };
}

export function absent(null_reason: string): { value: null; null_reason: string } {
  return { value: null, null_reason };
}

/** Maybe を素の値へ。理由が必要な場面ではこれを使わず value を見て分岐する。 */
export function maybeValue<T>(m: Maybe<T>): T | null {
  return m.value;
}

// ---- モデル出力と検証結果の区別 --------------------------------------------

/**
 * モデルが生成した説明や分類。真の内的動機や適時性の正解ではない（追補1）。
 * 判定（ゲート）の入力に使ってはならない。素の string ではないので、そのままでは代入できない。
 */
export type ModelOutput<T> = { source: 'model_output'; value: T };

export function ModelOutput<T extends z.ZodType>(value: T) {
  return z.strictObject({ source: z.literal('model_output'), value });
}

/** モデル出力。モデルが返さなかったときは null と理由。 */
export type MaybeModelOutput<T> =
  | { source: 'model_output'; value: T }
  | { source: 'model_output'; value: null; null_reason: string };

export function MaybeModelOutput<T extends z.ZodType>(value: T) {
  return z.union([
    z.strictObject({ source: z.literal('model_output'), value }),
    z.strictObject({
      source: z.literal('model_output'),
      value: z.null(),
      null_reason: NonEmptyString,
    }),
  ]);
}

export function modelOutput<T>(value: T): ModelOutput<T> {
  return { source: 'model_output', value };
}

export function modelOutputAbsent(null_reason: string): {
  source: 'model_output';
  value: null;
  null_reason: string;
} {
  return { source: 'model_output', value: null, null_reason };
}

/** コードが入力と照合して決めた結果。method に検証方法を残す。 */
export type Verified<T> = { source: 'verified'; value: T; method: string };

export function Verified<T extends z.ZodType>(value: T) {
  return z.strictObject({ source: z.literal('verified'), value, method: NonEmptyString });
}

export function verified<T>(value: T, method: string): Verified<T> {
  return { source: 'verified', value, method };
}

// ---- 共有の列挙 ------------------------------------------------------------

export const JsonValue = z.json();
export type JsonValue = z.infer<typeof JsonValue>;

export const SystemChannelSource = z.enum(['written', 'scheduled']);
export type SystemChannelSource = z.infer<typeof SystemChannelSource>;

/** 開発用と test double のセッションは受け入れの証拠に数えない（計画 §4.8）。 */
export const ProviderClass = z.enum(['production', 'development', 'test_double']);
export type ProviderClass = z.infer<typeof ProviderClass>;

export const ProviderHealth = z.enum(['ok', 'degraded', 'down']);
export type ProviderHealth = z.infer<typeof ProviderHealth>;

export const LlmPurpose = z.enum(['prefetch', 'initiative', 'completion']);
export type LlmPurpose = z.infer<typeof LlmPurpose>;

/** STT の時刻の精度（計画 §3.6）。 */
export const TimingPrecision = z.enum([
  'word_offset',
  'result_end_offset',
  'arrival_minus_rtt',
  'posthoc_alignment',
]);
export type TimingPrecision = z.infer<typeof TimingPrecision>;

/** 発話済みテキストの精度（仕様§5、計画 §4.3）。 */
export const SpokenTextPrecision = z.enum([
  'word_timing',
  'alignment_char',
  'time_proportional',
]);
export type SpokenTextPrecision = z.infer<typeof SpokenTextPrecision>;

/**
 * STT の安定度。0.0 は Google の「未設定」の印なので値として許さない（docs/provider_matrix.md §6.1）。
 * 不安定と扱うと、返さないモデルで合図が永久に出なくなる。値がなければ null と理由。
 */
export const Stability = Maybe(z.number().gt(0).max(1));
export type Stability = z.infer<typeof Stability>;

/**
 * 安定度の由来。provider はプロバイダが返した値。
 * derived は「連続 N revision で不変の接頭部＋経過時間」でコードが判定する経路で、stability は null になりうる。
 */
export const StabilitySource = z.enum(['provider', 'derived']);
export type StabilitySource = z.infer<typeof StabilitySource>;

/** プロバイダの生の値を契約の形へ。0 と範囲外は未設定として扱う。 */
export function stabilityFromProvider(raw: number | null | undefined): Stability {
  if (raw === null || raw === undefined) return absent('provider_returned_no_stability');
  if (raw === 0) return absent('provider_unset_marker_0.0');
  if (raw < 0 || raw > 1) return absent('provider_value_out_of_range');
  return present(raw);
}

/** interim の1応答の中の1結果。安定度はこの単位で違う（実測: 0.9 の安定部分と 0.01 の末尾）。 */
export const SttPart = z.strictObject({
  text: z.string(),
  stability: Stability,
});
export type SttPart = z.infer<typeof SttPart>;

export interface SplitInterim {
  /** parts の連結。 */
  text: string;
  /** 先頭から連続して stability ≥ 閾値 の部分（provider_matrix §6.1）。 */
  stable_text: string;
  /** その残り。最初に閾値を下回った結果より後は、値が高くても安定に入れない。 */
  unstable_text: string;
  /** 先頭の結果の値。 */
  stability: Stability;
}

/**
 * プロバイダの結果を安定テキストと未安定テキストへ分ける。安定度が得られない結果は安定に入れない。
 * そのときの安定テキストは stability_source=derived の経路（連続 N revision で不変の接頭部）で別に求める。
 */
export function splitInterimParts(parts: readonly SttPart[], threshold: number): SplitInterim {
  let stable_text = '';
  let unstable_text = '';
  let stillStable = true;
  for (const part of parts) {
    const value = part.stability.value;
    if (stillStable && value !== null && value >= threshold) stable_text += part.text;
    else {
      stillStable = false;
      unstable_text += part.text;
    }
  }
  return {
    text: stable_text + unstable_text,
    stable_text,
    unstable_text,
    stability: parts[0]?.stability ?? absent('no_results'),
  };
}

/** 語単位の時刻。STT と履歴で共有する。 */
export const TimedWord = z.strictObject({
  text: z.string(),
  audio_frame_start: AudioFrameIndex,
  audio_frame_end: AudioFrameIndex,
});
export type TimedWord = z.infer<typeof TimedWord>;
