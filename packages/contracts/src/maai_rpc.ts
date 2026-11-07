/**
 * Node↔Python（MaAI ワーカー）の契約（計画 §3.3）。localhost の WS。
 *  - バイナリ枠: Node→Python の AUDIO 枠（binary.ts）。
 *  - テキスト枠: 以下の JSON。zod から JSON Schema を生成し、Python でも検証する。
 *
 * ワーカーの義務（実装は B）:
 *  - start() のスレッドを使わず、1スレッドで process(x1, x2) を直接呼ぶ。
 *  - ネットワーク欠損は該当番号をゼロ埋めし、FRAMES_DROPPED(cause=network_gap)。
 *  - 過負荷では2チャネル同時に捨てて process を呼ばず、FRAMES_DROPPED(cause=overload)。
 *  - MaAI が動いていないときは VAP_STATE を出さない。RMS 等で偽装しない。
 */
import { z } from 'zod';
import { DEFAULT_FRAME_SAMPLES, SAMPLE_RATE_HZ } from './binary';
import {
  AudioFrameIndex,
  ChannelLayout,
  Maybe,
  MonotonicMs,
  NonEmptyString,
  NonNegativeInt,
  Probability,
  SessionId,
} from './common';
import { Vap1chState, Vap2chState } from './vap';

export const MAAI_RPC_PROTOCOL_VERSION = 1 as const;

export const MaaiLang = z.enum(['jp', 'jp_kyoto']);
export type MaaiLang = z.infer<typeof MaaiLang>;

/** 比較対象（計画 §5.1 R2）。第1候補は normal-ver2 を 12.5Hz。 */
export const MaaiModelType = z.enum(['normal', 'normal-ver2']);
export type MaaiModelType = z.infer<typeof MaaiModelType>;

export const MaaiConfigure = z.strictObject({
  type: z.literal('CONFIGURE'),
  protocol_version: z.literal(MAAI_RPC_PROTOCOL_VERSION),
  session_id: SessionId,
  lang: MaaiLang,
  model_type: MaaiModelType,
  channel_layout: ChannelLayout,
  frame_rate_hz: z.number().positive(),
  sample_rate_hz: z.literal(SAMPLE_RATE_HZ),
  /** AUDIO 枠の sample_count。既定は DEFAULT_FRAME_SAMPLES。 */
  frame_samples: z.number().int().min(1),
  device: z.literal('cpu'),
  /** vad をこの値以上で speaking とする。policy の turn.user_speaking_threshold から渡す。 */
  speaking_threshold: Probability,
});
export type MaaiConfigure = z.infer<typeof MaaiConfigure>;

export const MaaiShutdown = z.strictObject({
  type: z.literal('SHUTDOWN'),
  reason: NonEmptyString,
});
export type MaaiShutdown = z.infer<typeof MaaiShutdown>;

/** 時計差の推定用。t_ms は orchestrator の t_monotonic_ms。 */
export const MaaiPing = z.strictObject({
  type: z.literal('PING'),
  seq: NonNegativeInt,
  t_ms: MonotonicMs,
});
export type MaaiPing = z.infer<typeof MaaiPing>;

/** Node→Python の JSON。 */
export const MaaiNodeToWorker = z.discriminatedUnion('type', [MaaiConfigure, MaaiShutdown, MaaiPing]);
export type MaaiNodeToWorker = z.infer<typeof MaaiNodeToWorker>;

export const MaaiReady = z.strictObject({
  type: z.literal('READY'),
  protocol_version: z.literal(MAAI_RPC_PROTOCOL_VERSION),
  maai_version: NonEmptyString,
  /** 実際に読み込んだ checkpoint（例: vap_mc）。 */
  checkpoint: NonEmptyString,
  lang: MaaiLang,
  model_type: MaaiModelType,
  channel_layout: ChannelLayout,
  frame_rate_hz: z.number().positive(),
  device: z.literal('cpu'),
  /** 偽サーバーは true。本番のワーカーは必ず false。 */
  is_fake: z.boolean(),
});
export type MaaiReady = z.infer<typeof MaaiReady>;

const vapMessage = { type: z.literal('VAP_STATE') };
export const MaaiVapStateMessage = z.discriminatedUnion('channel_layout', [
  z.strictObject({ ...Vap2chState.shape, ...vapMessage }),
  z.strictObject({ ...Vap1chState.shape, ...vapMessage }),
]);
export type MaaiVapStateMessage = z.infer<typeof MaaiVapStateMessage>;

export const FrameDropCause = z.enum(['network_gap', 'overload']);
export type FrameDropCause = z.infer<typeof FrameDropCause>;

export const MaaiFramesDropped = z.strictObject({
  type: z.literal('FRAMES_DROPPED'),
  from_audio_frame: AudioFrameIndex,
  sample_count: z.number().int().min(1),
  cause: FrameDropCause,
  /** network_gap はゼロ埋めで処理を続けた。overload は process を呼んでいない。 */
  zero_filled: z.boolean(),
  /** 2チャネル同時に扱った証拠。チャネルごとに別々に捨てることは契約違反。 */
  channels: z.literal('both'),
});
export type MaaiFramesDropped = z.infer<typeof MaaiFramesDropped>;

export const MaaiWorkerStatus = z.strictObject({
  type: z.literal('WORKER_STATUS'),
  status: z.enum(['loading', 'ok', 'degraded', 'down']),
  reason: Maybe(NonEmptyString),
  /** 処理済みの先頭。 */
  audio_frame: AudioFrameIndex,
  /** セッション累計。audio.health(reporter=worker) の元（forwarding.ts）。 */
  frames_dropped_network: NonNegativeInt,
  frames_dropped_overload: NonNegativeInt,
  queue_depth: NonNegativeInt,
  /** 直近の RTF。計算前は null と理由。 */
  rtf: Maybe(z.number().min(0)),
});
export type MaaiWorkerStatus = z.infer<typeof MaaiWorkerStatus>;

export const MaaiPong = z.strictObject({
  type: z.literal('PONG'),
  seq: NonNegativeInt,
  t_ms: MonotonicMs,
  /** ワーカーのローカル時刻。 */
  worker_t_ms: MonotonicMs,
});
export type MaaiPong = z.infer<typeof MaaiPong>;

export const MaaiError = z.strictObject({
  type: z.literal('ERROR'),
  code: NonEmptyString,
  message: z.string(),
  fatal: z.boolean(),
});
export type MaaiError = z.infer<typeof MaaiError>;

/** Python→Node の JSON。 */
export const MaaiWorkerToNode = z.discriminatedUnion('type', [
  MaaiReady,
  MaaiVapStateMessage,
  MaaiFramesDropped,
  MaaiWorkerStatus,
  MaaiPong,
  MaaiError,
]);
export type MaaiWorkerToNode = z.infer<typeof MaaiWorkerToNode>;

export const MAAI_DEFAULT_FRAME_SAMPLES = DEFAULT_FRAME_SAMPLES;
