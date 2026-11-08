/**
 * Browser↔Node の双方向契約（計画 §3.2、§5.1 F）。
 *  - 上りのバイナリ: AUDIO 枠（binary.ts）。mic と sys（出力へ書き込み済みのサンプル）を同じ番号で送る。
 *  - 下りのバイナリ: PCM 枠（binary.ts）。audio_playback_id、generation、seq つき。
 *  - テキスト枠: 以下の JSON。
 *
 * 世代の規則:
 *  - generation はセッション内で単調増加し、playback.stop のたびに増える。
 *  - クライアントは最後に受けた generation より古い PCM 枠と playback.begin を棄てる。
 *  - 順序は同じ WS の中で保たれるので、stop の後に古い世代が届くのは Node 側の不具合だが、棄てて数える。
 */
import { z } from 'zod';
import {
  AudioFrameIndex,
  AudioPlaybackId,
  CandidateId,
  Condition,
  Generation,
  Maybe,
  MonotonicMs,
  NonEmptyString,
  NonNegativeInt,
  NonNegativeMs,
  SessionId,
  SystemChannelSource,
} from './common';

export const BROWSER_RPC_PROTOCOL_VERSION = 1 as const;

/** track.getSettings() のうち記録する項目（計画 §3.2）。値はブラウザが返したまま。 */
export const TrackSettings = z.strictObject({
  echoCancellation: Maybe(z.boolean()),
  noiseSuppression: Maybe(z.boolean()),
  autoGainControl: Maybe(z.boolean()),
  sampleRate: Maybe(z.number().positive()),
  channelCount: Maybe(z.number().int().positive()),
  deviceId: Maybe(z.string()),
  /**
   * マイク側の遅延（MediaTrackSettings.latency）。単位は秒で、ブラウザが返したまま。
   * 古い送信側は項目ごと持たない。ブラウザが返さないときは null と理由。
   */
  latency: Maybe(z.number().min(0)).optional(),
});
export type TrackSettings = z.infer<typeof TrackSettings>;

/** baseLatency、outputLatency、getOutputTimestamp()（計画 §3.2）。取れないブラウザでは null と理由。 */
export const AudioLatency = z.strictObject({
  base_latency_ms: Maybe(NonNegativeMs),
  output_latency_ms: Maybe(NonNegativeMs),
  output_timestamp_context_ms: Maybe(NonNegativeMs),
  output_timestamp_performance_ms: Maybe(NonNegativeMs),
});
export type AudioLatency = z.infer<typeof AudioLatency>;

export const SignalPhase = z.enum(['inhale', 'ready', 'relax', 'pre_speech']);
export type SignalPhase = z.infer<typeof SignalPhase>;

/** 合図の連続値パラメータ（深さ、速度、保持、頭部姿勢など。§4.7）。名前は H が決める。 */
export const SignalParameters = z.record(z.string(), z.union([z.number(), z.boolean(), z.string()]));
export type SignalParameters = z.infer<typeof SignalParameters>;

export const GazeTarget = z.enum(['user', 'away']);
export type GazeTarget = z.infer<typeof GazeTarget>;

export const AudioContextStateName = z.enum(['suspended', 'running', 'closed', 'interrupted']);
export const VisibilityName = z.enum(['visible', 'hidden']);

// ---- Browser → Node --------------------------------------------------------

export const ClientHello = z.strictObject({
  type: z.literal('client.hello'),
  protocol_version: z.literal(BROWSER_RPC_PROTOCOL_VERSION),
  session_id: Maybe(SessionId),
  /** 要求は 48kHz。実際の値を送る（計画 §3.2）。 */
  audio_context_sample_rate_hz: z.number().positive(),
  frame_samples: z.number().int().min(1),
  track_settings: TrackSettings,
  latency: AudioLatency,
  user_agent: z.string(),
});
export type ClientHello = z.infer<typeof ClientHello>;

export const ClockPing = z.strictObject({
  type: z.literal('clock.ping'),
  seq: NonNegativeInt,
  /** クライアントのローカル時刻（performance.now 基準）。 */
  client_t_ms: NonNegativeMs,
});
export type ClockPing = z.infer<typeof ClockPing>;

/**
 * ブラウザが持つ時計差の推定（clock.ping／pong の結果）。browser_rtt の clock.sync の元。
 * Node は clock.pong を送るだけで往復の時刻を知らないので、推定値はブラウザから受ける。
 *
 * 式は clock.ts の ClockSample と同じ: サーバー時刻 = クライアント時刻 + offset_ms。
 */
export const ClockReport = z.strictObject({
  type: z.literal('clock.report'),
  offset_ms: z.number(),
  rtt_ms: NonNegativeMs,
  /** 往復が対称と仮定したときの最大誤差。RTT の半分。 */
  uncertainty_ms: NonNegativeMs,
  /** 推定に使った窓の標本数。 */
  samples: z.number().int().min(1),
  /** この報告を送ったクライアント時刻。 */
  client_t_ms: NonNegativeMs,
});
export type ClockReport = z.infer<typeof ClockReport>;

/** 最初の PCM を出力へ書き込んだ。§3.6 の t_speech_start の元。 */
export const PlaybackStarted = z.strictObject({
  type: z.literal('playback.started'),
  audio_playback_id: AudioPlaybackId,
  generation: Generation,
  /** 最初のサンプルを sys チャネルへ書いた audio_frame。 */
  audio_frame: AudioFrameIndex,
  client_t_ms: NonNegativeMs,
  output_latency_ms: Maybe(NonNegativeMs),
});
export type PlaybackStarted = z.infer<typeof PlaybackStarted>;

/** 再生位置の定期報告。単位はサンプル（16kHz）。 */
export const PlaybackPosition = z.strictObject({
  type: z.literal('playback.position'),
  audio_playback_id: AudioPlaybackId,
  generation: Generation,
  /** この再生の先頭から sys へ書き込み済みのサンプル数。出力遅延は含まない（物理的に聞こえた位置ではない）。 */
  samples_written: NonNegativeInt,
  /** 受信済みで未書き込みのサンプル数。 */
  samples_buffered: NonNegativeInt,
  audio_frame: AudioFrameIndex,
  client_t_ms: NonNegativeMs,
  output_latency_ms: Maybe(NonNegativeMs),
  system_ch_source: SystemChannelSource,
});
export type PlaybackPosition = z.infer<typeof PlaybackPosition>;

/**
 * reason の定義:
 *  - completed: end_of_stream まで書き込んだ。
 *  - stopped: playback.stop で止めた。
 *  - discarded_before_start: 1サンプルも書き込む前に棄てた。
 *  - error: 異常で途切れた。WS の切断で途切れた再生もこれ（stopped にしない）。
 */
export const PlaybackEnded = z.strictObject({
  type: z.literal('playback.ended'),
  audio_playback_id: AudioPlaybackId,
  generation: Generation,
  reason: z.enum(['completed', 'stopped', 'discarded_before_start', 'error']),
  samples_written: NonNegativeInt,
  /** 停止で棄てた未再生のサンプル数。 */
  samples_discarded: NonNegativeInt,
  audio_frame: AudioFrameIndex,
  client_t_ms: NonNegativeMs,
  output_latency_ms: Maybe(NonNegativeMs),
});
export type PlaybackEnded = z.infer<typeof PlaybackEnded>;

/**
 * 上りの health。audio.health イベントの元（forwarding.ts）。
 * 定期送信に加えて、AudioContext の statechange と visibilitychange の時にも直ちに送る（計画 §3.2）。
 */
export const AudioReport = z.strictObject({
  type: z.literal('audio.report'),
  client_t_ms: NonNegativeMs,
  audio_frame: AudioFrameIndex,
  /** 失った上り音声の枠の数。単位は 20ms 枠（client.hello の frame_samples）で、サンプル数ではない。累積。 */
  frames_lost: NonNegativeInt,
  underrun_count: NonNegativeInt,
  underrun_total_ms: NonNegativeMs,
  /** 古い世代で棄てた PCM 枠の数。累積。PCM 枠のみで、playback.begin と playback.stop は含まない。 */
  stale_pcm_frames_dropped: NonNegativeInt,
  latency: AudioLatency,
  track_settings: TrackSettings,
  system_ch_source: SystemChannelSource,
  audio_context_state: AudioContextStateName,
  visibility: VisibilityName,
  /** WS を張り直した回数。累積。 */
  reconnects: NonNegativeInt.optional(),
  /** 対応する playback.begin がなく棄てた PCM 枠の数。累積。stale_pcm_frames_dropped とは別に数える。 */
  orphan_pcm_frames: NonNegativeInt.optional(),
  /** 同じ再生の中で seq が飛んだ回数。累積。枠の数ではない。 */
  pcm_seq_gaps: NonNegativeInt.optional(),
  /** 実時間に対するレンダーの遅れ。増え続けるならコールバックが抜けている。 */
  render_lag_ms: z.number().optional(),
});
export type AudioReport = z.infer<typeof AudioReport>;

/**
 * 描画側の報告。started の client_t_ms は最初に描画した rAF の時刻（計画 §3.5）。
 * 背景タブでは rAF が来ないので visible=false で null と理由を返す。
 */
export const SignalReport = z.strictObject({
  type: z.literal('signal.report'),
  candidate_id: CandidateId,
  phase: SignalPhase,
  state: z.enum(['started', 'ended']),
  visible: z.boolean(),
  client_t_ms: Maybe(NonNegativeMs),
});
export type SignalReport = z.infer<typeof SignalReport>;

/** 視線の描画の報告。G1 の「描画に反映される」の証拠。client_t_ms は rAF の時刻。 */
export const GazeReport = z.strictObject({
  type: z.literal('gaze.report'),
  target: GazeTarget,
  visible: z.boolean(),
  client_t_ms: Maybe(NonNegativeMs),
});
export type GazeReport = z.infer<typeof GazeReport>;

/** Browser→Node の JSON。 */
export const BrowserToNode = z.discriminatedUnion('type', [
  ClientHello,
  ClockPing,
  ClockReport,
  PlaybackStarted,
  PlaybackPosition,
  PlaybackEnded,
  AudioReport,
  GazeReport,
  SignalReport,
]);
export type BrowserToNode = z.infer<typeof BrowserToNode>;

// ---- Node → Browser --------------------------------------------------------

export const ServerHello = z.strictObject({
  type: z.literal('server.hello'),
  protocol_version: z.literal(BROWSER_RPC_PROTOCOL_VERSION),
  session_id: SessionId,
  condition: Condition,
  /** 偽サーバーは true。 */
  is_fake: z.boolean(),
});
export type ServerHello = z.infer<typeof ServerHello>;

export const ClockPong = z.strictObject({
  type: z.literal('clock.pong'),
  seq: NonNegativeInt,
  client_t_ms: NonNegativeMs,
  /** orchestrator の t_monotonic_ms。 */
  server_t_ms: MonotonicMs,
});
export type ClockPong = z.infer<typeof ClockPong>;

/** 続く PCM 枠の予告。sample_rate_hz は PCM 枠の値と同じ。Worklet が 16kHz の時間軸へ揃える。 */
export const PlaybackBegin = z.strictObject({
  type: z.literal('playback.begin'),
  audio_playback_id: AudioPlaybackId,
  generation: Generation,
  sample_rate_hz: z.number().int().positive(),
});
export type PlaybackBegin = z.infer<typeof PlaybackBegin>;

/**
 * 停止の方法（計画 §4.1）。語境界の判定は D、停止の実行は A。
 *  - immediate: 未再生を即時破棄。
 *  - fade: fade_ms で減衰して止める。
 *  - at_sample: samples_written がこの位置に達したら fade_ms で止める。
 *    deadline_ms までに達しなければ、その時点で fade する（語境界の上限）。
 */
export const PlaybackStopMode = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('immediate') }),
  z.strictObject({ mode: z.literal('fade'), fade_ms: NonNegativeMs }),
  z.strictObject({
    mode: z.literal('at_sample'),
    stop_at_sample: NonNegativeInt,
    fade_ms: NonNegativeMs,
    deadline_ms: NonNegativeMs,
  }),
]);
export type PlaybackStopMode = z.infer<typeof PlaybackStopMode>;

export const PlaybackStop = z.strictObject({
  type: z.literal('playback.stop'),
  audio_playback_id: AudioPlaybackId,
  /** 停止後の新しい世代。これより古い PCM は棄てる。 */
  generation: Generation,
  stop: PlaybackStopMode,
  reason: NonEmptyString,
});
export type PlaybackStop = z.infer<typeof PlaybackStop>;

/** 吸気などの合図の指示。signal.sent の元。 */
export const SignalCommand = z.strictObject({
  type: z.literal('signal.command'),
  candidate_id: CandidateId,
  phase: SignalPhase,
  parameters: SignalParameters,
});
export type SignalCommand = z.infer<typeof SignalCommand>;

/**
 * 準備吸気の合図（計画 §4.6、§4.7。条件 initiative_inhale のときだけ送る）。アバターの BreathController.startInhale へ渡す。
 * 吸気の長さは orchestrator が決める。吸気の完了は orchestrator の時計で判定し、ブラウザの完了の報告を待たない。
 * 描画の開始はブラウザが signal.report（phase=inhale、state=started）で返す（記録のため。制御には使わない）。
 */
export const BreathCue = z.strictObject({
  type: z.literal('breath.cue'),
  cue_id: NonEmptyString,
  candidate_id: CandidateId,
  duration_ms: z.number().int().min(1),
});
export type BreathCue = z.infer<typeof BreathCue>;

/** 吸気の解除。BreathController.release(reason) へ渡す。speech_started は保持から発話へ、それ以外は脱力。 */
export const BreathReleaseReason = z.enum(['speech_started', 'deferred', 'withdrawn']);
export type BreathReleaseReason = z.infer<typeof BreathReleaseReason>;

export const BreathRelease = z.strictObject({
  type: z.literal('breath.release'),
  cue_id: NonEmptyString,
  candidate_id: CandidateId,
  reason: BreathReleaseReason,
});
export type BreathRelease = z.infer<typeof BreathRelease>;

/** DEFERRED の候補を話し始めるときの短い準備動作（再吸気しない、計画 §4.6）。解除の合図は続かない。 */
export const BreathPrepare = z.strictObject({
  type: z.literal('breath.prepare'),
  candidate_id: CandidateId,
});
export type BreathPrepare = z.infer<typeof BreathPrepare>;

export const GazeCommand = z.strictObject({
  type: z.literal('gaze.command'),
  target: GazeTarget,
});
export type GazeCommand = z.infer<typeof GazeCommand>;

/** 語単位の時刻。粒度は TTS の実挙動で決まるので granularity を見る（日本語の精度は未確認、R4）。 */
export const AlignmentItem = z.strictObject({
  text: z.string(),
  /** この再生の先頭からの時刻。 */
  start_ms: NonNegativeMs,
  end_ms: NonNegativeMs,
  granularity: z.enum(['word', 'char']),
  /**
   * 語の読み（カタカナの発音）。形態素解析の推定で、誤りうる（reading_source を見る）。口形にだけ使う。
   * 表記がかなで読みも同じ語と、読みの分からない語には付かない。
   */
  reading: z.string().min(1).optional(),
});
export type AlignmentItem = z.infer<typeof AlignmentItem>;

/**
 * 語時刻の由来。estimated_time_proportional は文字数と音声の長さからの推定で、実測の時刻ではない。
 * 項目がないときはプロバイダが返した時刻（provider_char と同じ）。
 */
export const PlaybackAlignmentSource = z.enum(['provider_char', 'estimated_time_proportional']);
export type PlaybackAlignmentSource = z.infer<typeof PlaybackAlignmentSource>;

/** 語の読みの由来。 */
export const PlaybackReadingSource = z.enum(['morphological_estimate']);
export type PlaybackReadingSource = z.infer<typeof PlaybackReadingSource>;

/** 口形と発話済みの計算に使う語時刻。TTS から届くたびに差分で送る。 */
export const PlaybackAlignment = z.strictObject({
  type: z.literal('playback.alignment'),
  audio_playback_id: AudioPlaybackId,
  generation: Generation,
  items: z.array(AlignmentItem),
  source: PlaybackAlignmentSource.optional(),
  /** items に reading があるときの由来。morphological_estimate は形態素解析の辞書の推定（実測ではない）。 */
  reading_source: PlaybackReadingSource.optional(),
});
export type PlaybackAlignment = z.infer<typeof PlaybackAlignment>;

/** 参加者画面と研究者画面の最小表示（計画 §4.1、§4.8）。 */
export const SessionStatus = z.strictObject({
  type: z.literal('session.status'),
  degraded: z.boolean(),
  reasons: z.array(NonEmptyString),
});
export type SessionStatus = z.infer<typeof SessionStatus>;

/** Node→Browser の JSON。 */
export const NodeToBrowser = z.discriminatedUnion('type', [
  ServerHello,
  ClockPong,
  PlaybackBegin,
  PlaybackStop,
  PlaybackAlignment,
  SignalCommand,
  GazeCommand,
  SessionStatus,
  BreathCue,
  BreathRelease,
  BreathPrepare,
]);
export type NodeToBrowser = z.infer<typeof NodeToBrowser>;
