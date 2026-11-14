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
  AiId,
  AudioFrameIndex,
  AudioPlaybackId,
  CandidateId,
  Condition,
  DiscussionStage,
  Generation,
  Maybe,
  MonotonicMs,
  NonEmptyString,
  NonNegativeInt,
  NonNegativeMs,
  ScriptVariant,
  SessionId,
  SystemChannelSource,
  TwoAiPhase,
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

/** peer は two_ai で相手の AI を見る（docs/design/two_ai/06 §2.1）。 */
export const GazeTarget = z.enum(['user', 'away', 'peer']);
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
  /** two_ai のときだけ。省略は 'A'（gaze.command だけは省略＝両方）。 */
  ai_id: AiId.optional(),
});
export type SignalReport = z.infer<typeof SignalReport>;

/** 視線の描画の報告。G1 の「描画に反映される」の証拠。client_t_ms は rAF の時刻。 */
export const GazeReport = z.strictObject({
  type: z.literal('gaze.report'),
  target: GazeTarget,
  visible: z.boolean(),
  client_t_ms: Maybe(NonNegativeMs),
  /** two_ai のときだけ。省略は 'A'（gaze.command だけは省略＝両方）。 */
  ai_id: AiId.optional(),
});
export type GazeReport = z.infer<typeof GazeReport>;

/**
 * 使ったアバターの記録（実験の刺激の記録）。manifest の avatar に残す。
 * 読み込みの結果なので、失敗して会話だけ続いた場合も status: 'failed' で残る。
 */
export const AvatarReport = z.strictObject({
  type: z.literal('avatar.report'),
  avatar_id: z.string().min(1).max(64),
  kind: z.enum(['vrm', 'glb', 'none']),
  model_url: z.string().max(512).nullable(),
  /** 指定の出どころ（既定／?avatar=／環境変数／?model=）。 */
  source: z.enum(['default', 'query', 'env', 'model_query']),
  status: z.enum(['loaded', 'failed', 'disabled']),
  error: z.string().max(300).nullable(),
  /** 吸気音の音量（ノイズの振幅の頂点。0 は無音）。 */
  breath_sound_gain: z.number().min(0).max(1),
  /** 吸気の動きの大きさの切り替え（?breath_profile=）。省略は既定。 */
  breath_profile: z.enum(['default', 'original', 'weak']).optional(),
  client_t_ms: NonNegativeMs,
  /** two_ai のときだけ。省略は 'A'（gaze.command だけは省略＝両方）。 */
  ai_id: AiId.optional(),
  /** two_ai の描画の設定。 */
  render_profile: z
    .strictObject({
      max_fps: z.number().positive(),
      pixel_ratio: z.number().positive(),
      spring_bones: z.enum(['all', 'speaker_only', 'none']),
    })
    .optional(),
  /** two_ai の配置。 */
  layout: z
    .strictObject({
      side: z.enum(['left', 'right']),
      body_yaw_deg: z.number(),
      spacing_m: z.number().positive(),
    })
    .optional(),
});
export type AvatarReport = z.infer<typeof AvatarReport>;

/** Browser→Node。5 秒ごと。同名のイベント render.health として記録する（two_ai。06 §2.2）。 */
export const RenderHealth = z.strictObject({
  type: z.literal('render.health'),
  fps_p5: z.number().min(0),
  fps_median: z.number().min(0),
  frame_ms_p95: NonNegativeMs,
  long_tasks: NonNegativeInt,
  renderer: z.string().max(200),
  avatars: z.number().int().min(0).max(2),
  pixel_ratio: z.number().positive(),
  client_t_ms: NonNegativeMs,
});
export type RenderHealth = z.infer<typeof RenderHealth>;

/** Browser→Node。印のボタン。両条件で同じ見た目。押しても AI は止まらない（記録だけ）。 */
export const TwoAiMarker = z.strictObject({
  type: z.literal('two_ai.marker'),
  marker_id: NonEmptyString,
  client_t_ms: NonNegativeMs,
});
export type TwoAiMarker = z.infer<typeof TwoAiMarker>;

/** Browser→Node。next_step で板から 1 枚を選ぶ。最初の 1 回だけ有効。 */
export const TwoAiBoardPick = z.strictObject({
  type: z.literal('two_ai.board_pick'),
  pick_id: NonEmptyString,
  card_id: NonEmptyString,
  board_version: NonNegativeInt,
  client_t_ms: NonNegativeMs,
});
export type TwoAiBoardPick = z.infer<typeof TwoAiBoardPick>;

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
  AvatarReport,
  RenderHealth,
  TwoAiMarker,
  TwoAiBoardPick,
]);
export type BrowserToNode = z.infer<typeof BrowserToNode>;

// ---- Node → Browser --------------------------------------------------------

/** 1 対 1。今の形のまま。mode は省略（1 対 1 の Node は送らない。送る通信の 1 バイトも変えない）。 */
export const ServerHelloOneToOne = z.strictObject({
  type: z.literal('server.hello'),
  protocol_version: z.literal(BROWSER_RPC_PROTOCOL_VERSION),
  mode: z.literal('one_to_one').optional(),
  session_id: SessionId,
  condition: Condition,
  /** 偽サーバーは true。 */
  is_fake: z.boolean(),
});
export type ServerHelloOneToOne = z.infer<typeof ServerHelloOneToOne>;

/**
 * 2 体。条件の値を持たない。condition は null に固定する（値を送らないための項目で、条件の漏れはない）。
 * null に固定して項目を残すのは、participant.ts の `condition: message.condition`（型 Condition | null）と
 * page.tsx が、共用体のままでも型を変えずに通るようにするため（1 対 1 の画面のファイルを触らない）。
 */
export const ServerHelloTwoAi = z.strictObject({
  type: z.literal('server.hello'),
  protocol_version: z.literal(BROWSER_RPC_PROTOCOL_VERSION),
  mode: z.literal('two_ai'),
  session_id: SessionId,
  condition: z.null(),
  is_fake: z.boolean(),
  two_ai: z.strictObject({
    ai_ids: z.tuple([z.literal('A'), z.literal('B')]),
    /** 画面の配置とモデルの鍵（03 が解釈）。人格の中身は送らない。 */
    avatar_keys: z.strictObject({ A: NonEmptyString, B: NonEmptyString }),
    labels: z.strictObject({ A: NonEmptyString, B: NonEmptyString }),
    phase: TwoAiPhase,
  }),
});
export type ServerHelloTwoAi = z.infer<typeof ServerHelloTwoAi>;

/** mode で判別する。NodeToBrowser の type の判別共用体の要素に入れ子で置く（zod 4.6.7 で確かめた）。 */
export const ServerHello = z.discriminatedUnion('mode', [ServerHelloOneToOne, ServerHelloTwoAi]);
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
  /** two_ai の Node は必ず付ける。ブラウザは省略を 'A' として数える。 */
  ai_id: AiId.optional(),
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
  /** two_ai のときだけ。省略は 'A'（gaze.command だけは省略＝両方）。 */
  ai_id: AiId.optional(),
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
  /** two_ai のときだけ。省略は 'A'（gaze.command だけは省略＝両方）。 */
  ai_id: AiId.optional(),
});
export type BreathRelease = z.infer<typeof BreathRelease>;

/** DEFERRED の候補を話し始めるときの短い準備動作（再吸気しない、計画 §4.6）。解除の合図は続かない。 */
export const BreathPrepare = z.strictObject({
  type: z.literal('breath.prepare'),
  candidate_id: CandidateId,
  /** two_ai のときだけ。省略は 'A'（gaze.command だけは省略＝両方）。 */
  ai_id: AiId.optional(),
});
export type BreathPrepare = z.infer<typeof BreathPrepare>;

export const GazeCommand = z.strictObject({
  type: z.literal('gaze.command'),
  target: GazeTarget,
  /** two_ai では省略は「両方」。1 対 1 は送らない。 */
  ai_id: AiId.optional(),
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
  /** two_ai の Node は必ず付ける。ブラウザは省略を 'A' として数える。 */
  ai_id: AiId.optional(),
});
export type PlaybackAlignment = z.infer<typeof PlaybackAlignment>;

/** 参加者画面と研究者画面の最小表示（計画 §4.1、§4.8）。 */
export const SessionStatus = z.strictObject({
  type: z.literal('session.status'),
  degraded: z.boolean(),
  reasons: z.array(NonEmptyString),
});
export type SessionStatus = z.infer<typeof SessionStatus>;

// ---- two_ai（06 §2.2）。条件の値は送らない ---------------------------------

/** Node→Browser。段の変わり目と、接続・再接続の直後。条件の値は送らない。 */
export const TwoAiPhaseMessage = z.strictObject({
  type: z.literal('two_ai.phase'),
  phase: TwoAiPhase,
  /** 案内の文の鍵（two_ai_copy.ts）。条件名を鍵にも使わない。案内なしは null。 */
  instruction_key: NonEmptyString.nullable(),
  /** 画面の名札（例 { A: 'アオイ', B: 'ハル' }）。名札を出さない段は null。 */
  labels: z.strictObject({ A: NonEmptyString, B: NonEmptyString }).nullable(),
});
export type TwoAiPhaseMessage = z.infer<typeof TwoAiPhaseMessage>;

/** 板の 1 枚。参加者画面に出す文を持つ（条件の値は持たない）。 */
export const BoardCardView = z.strictObject({
  card_id: NonEmptyString,
  order: z.number().int().min(1).max(4),
  discussion_stage: DiscussionStage,
  text: NonEmptyString,
  variant: ScriptVariant,
});
export type BoardCardView = z.infer<typeof BoardCardView>;

/**
 * Node→Browser。板の全体（差分ではない）。送る時機：カードを持つターンの start_turn の直後（building）、
 * 最後の段の作り直しの最初のターンの start_turn の直後（rebuilt）、next_step の始め（pick）、選んだ後（picked）、
 * 接続・再接続の直後（今の状態）。両条件で同じ規則。
 */
export const TwoAiBoardMessage = z.strictObject({
  type: z.literal('two_ai.board'),
  board_version: NonNegativeInt,
  mode: z.enum(['building', 'rebuilt', 'pick', 'picked']),
  cards: z.array(BoardCardView).max(4),
  picked_card_id: NonEmptyString.nullable(),
});
export type TwoAiBoardMessage = z.infer<typeof TwoAiBoardMessage>;

/** Node→Browser。段の見出し。段の始め、response の始め（all）、接続・再接続の直後。 */
export const TwoAiStageMessage = z.strictObject({
  type: z.literal('two_ai.stage'),
  /** 今の段。discussion の外は null。 */
  current: DiscussionStage.nullable(),
  /** 4 つの見出し（条件で変えない）。 */
  headings: z.tuple([NonEmptyString, NonEmptyString, NonEmptyString, NonEmptyString]),
  /** current：今の段だけ強調。all：最後の段の問いのとき 4 つを並べる。none：出さない。 */
  show: z.enum(['current', 'all', 'none']),
});
export type TwoAiStageMessage = z.infer<typeof TwoAiStageMessage>;

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
  TwoAiPhaseMessage,
  TwoAiBoardMessage,
  TwoAiStageMessage,
]);
export type NodeToBrowser = z.infer<typeof NodeToBrowser>;
