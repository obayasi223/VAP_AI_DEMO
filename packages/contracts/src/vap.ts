/**
 * VAP_STATE の正規化（計画 §3.3、仕様§6-4）。
 *
 * 1ch と 2ch は別の型。maai 0.2.25 のソースで確認した出力の違い:
 *  - 2ch: p_now, p_future, vad が長さ2の配列で、p_now は2者の配分（ch1 と ch2 の和が約1）。
 *  - 1ch (models/vap_mono.py): スカラーで、2者の配分ではなく自己発話活動の期待値。
 * 同じしきい値を流用できないように、TurnManager の入力は Vap2chState だけを受ける。
 *
 * p の向きは R2 で実測して確定（docs/maai_validation.md §1）。添字 i はチャネル i で、
 * ch1=user、ch2=AI、p_now_ai = p_now[1]。添字は policy の vap.p_ai_index で持つ。
 */
import { z } from 'zod';
import {
  AudioFrameIndex,
  Maybe,
  MonotonicMs,
  NonEmptyString,
  NonNegativeMs,
  Probability,
} from './common';

const Pair = z.tuple([Probability, Probability]);

const VapCommon = {
  /** ワーカーのローカル時刻（ミリ秒）。orchestrator の時計と直接比較しない（追補2）。 */
  t: MonotonicMs,
  /** この結果の入力に含まれる最後のサンプルの次の番号（音声位置で対応づける）。 */
  audio_frame: AudioFrameIndex,
  /** 実際に読み込んだ重みとモデル種別。偽サーバーは FAKE_MODEL_VARIANT を使う。 */
  model_variant: NonEmptyString,
  /** process() にかかった時間。RTF の計算用。 */
  inference_ms: NonNegativeMs,
  /** MaAI の生の結果（音声配列は除く）。ログと向きの検証用。 */
  raw: z.record(z.string(), z.json()),
};

export const Vap2chState = z.strictObject({
  ...VapCommon,
  channel_layout: z.literal('2ch'),
  p_now: Pair,
  p_future: Pair,
  /** ch1=mic, ch2=sys の順。 */
  vad: Pair,
  user_speaking: z.boolean(),
  system_speaking: z.boolean(),
});
export type Vap2chState = z.infer<typeof Vap2chState>;

export const Vap1chState = z.strictObject({
  ...VapCommon,
  channel_layout: z.literal('1ch'),
  /** 2者の配分ではない（自己発話活動の期待値）。Vap2chState と型を分けている理由。 */
  p_now: Probability,
  p_future: Probability,
  vad: Probability,
  user_speaking: z.boolean(),
  /** 1ch では観測できない。 */
  system_speaking: Maybe(z.boolean()),
});
export type Vap1chState = z.infer<typeof Vap1chState>;

export const VapState = z.discriminatedUnion('channel_layout', [Vap2chState, Vap1chState]);
export type VapState = z.infer<typeof VapState>;

/** 偽サーバーが返す model_variant。これが付いた値は本物の VAP ではない。 */
export const FAKE_MODEL_VARIANT = 'FAKE_NOT_MAAI';
