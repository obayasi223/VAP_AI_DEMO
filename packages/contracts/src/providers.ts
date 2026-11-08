/**
 * プロバイダの TS インターフェース。本実装は C（STT、TTS）と D（LLM、SpeechGenerator、推定器）。
 * test double は @llm-vap/testkit。test double の結果を性能として報告しない（計画 §4.5a）。
 *
 * 時刻（sent_at など）は orchestrator の t_monotonic_ms。実装は TimeSource を受け取って記録する。
 */
import type { PlaybackEnded, PlaybackPosition, PlaybackStarted } from './browser_rpc';
import type {
  JsonValue,
  LlmPurpose,
  Maybe,
  ProviderClass,
  ProviderHealth,
  Stability,
  StabilitySource,
  SttPart,
  TimedWord,
  TimingPrecision,
} from './common';

export type Unsubscribe = () => void;

export interface ProviderIdentity {
  readonly provider: string;
  readonly model_version: string;
  readonly provider_class: ProviderClass;
}

export interface ProviderStatusUpdate {
  provider: string;
  status: ProviderHealth;
  reason: Maybe<string>;
  retry_attempt: number;
  next_retry_ms: Maybe<number>;
}

// ---- STT -------------------------------------------------------------------

export interface SttSessionConfig {
  language_code: 'ja-JP';
  sample_rate_hz: 16000;
  interim_results: true;
  /** セッションの最初の audio_frame。 */
  start_audio_frame: number;
}

export interface SttResult {
  kind: 'interim' | 'final';
  /** stable_text と unstable_text の連結。 */
  text: string;
  /**
   * 安定テキスト。実装は splitInterimParts、または derived の経路で求める。final では text と同じ。
   * 合図の判定はこちらだけを見る。
   */
  stable_text: string;
  unstable_text: string;
  /** プロバイダの結果のまま。 */
  parts: SttPart[];
  segment_id: number;
  asr_segment_id: number;
  asr_segment_frame_start: number;
  /** ストリームを切り替えても単調増加（順序の規則は C）。 */
  transcript_revision: number;
  stability: Stability;
  stability_source: StabilitySource;
  audio_frame_end: number;
  timing_precision: TimingPrecision;
  words: Maybe<TimedWord[]>;
  stream_id: string;
  provider: string;
  model_version: string;
  received_at: number;
}

export interface SttSession {
  /**
   * mic のみを渡す（計画 §3.3）。長さは固定しない。Browser→Node の 20ms のまま渡してよく、
   * プロバイダへの送信単位は実装が束ねる（Google は 40ms の想定。provider_matrix §1 の #5）。
   */
  pushAudio(audio_frame: number, mic: Int16Array): void;
  /** ASR.reset の定義: ストリームは切らず、音声位置で segment を分ける（計画 §4.1）。 */
  advanceSegment(new_segment_id: number, at_audio_frame: number): void;
  onResult(listener: (result: SttResult) => void): Unsubscribe;
  onStatus(listener: (status: ProviderStatusUpdate) => void): Unsubscribe;
  close(): Promise<void>;
}

export interface SttProvider extends ProviderIdentity {
  open(config: SttSessionConfig): Promise<SttSession>;
}

// ---- TTS -------------------------------------------------------------------

export interface TtsConnectionConfig {
  /** 未確認: WS で使える PCM 形式は R4 の実測待ち。実際の値は TtsChunk.sample_rate_hz を見る。 */
  preferred_sample_rate_hz: number;
}

/**
 * 文字単位の時刻。TtsChunk で渡す時刻はチャンク内の相対値。
 * 実物（ElevenLabs）は flush をまたぐ chunk で文脈の累積の時刻で届くので（実測、provider_matrix §10.1）、
 * プロバイダの実装（C）が chunk 相対へ直して渡す。資料の「チャンク相対」とは違う。
 * 3つの配列は同じ長さ。累積と語境界（Intl.Segmenter）は呼び出し側で作る（D）。
 */
export interface TtsCharAlignment {
  chars: string[];
  char_start_ms: number[];
  char_duration_ms: number[];
}

/**
 * 文字数と音声の長さからの推定の時刻（プロバイダが alignment を返さない場合）。実測ではない。
 * TtsChunk.alignment へ入れないのは、alignment_char の精度として記録させないため。
 * 時刻の基準は TtsCharAlignment と同じ chunk 相対。
 */
export interface TtsEstimatedAlignment extends TtsCharAlignment {
  source: 'estimated_time_proportional';
}

export interface TtsChunk {
  context_id: string;
  audio_playback_id: number;
  generation: number;
  /** 文脈の中の連番。 */
  seq: number;
  sample_rate_hz: number;
  pcm: Int16Array;
  /** 実装が受け取った単位のまま。取れなければ null と理由。 */
  alignment: Maybe<TtsCharAlignment>;
  is_last: boolean;
  /** alignment が null のときの推定。口形には使えるが、発話済みの精度は time_proportional のまま。 */
  estimated_alignment?: TtsEstimatedAlignment;
}

/** 1つの発話音声。audio_playback_id と世代に対応する。 */
export interface TtsContext {
  readonly context_id: string;
  readonly audio_playback_id: number;
  readonly generation: number;
  sendText(text: string): void;
  /** ここまでの入力の生成を促す。文末で呼ぶ（既定のスケジュールでは短文の音声が始まらない）。 */
  flush(): void;
  /** 入力の終わり。 */
  endInput(): void;
  /**
   * 文脈の取消。送信中の音声がすぐ止まるかは未確認（要実測）なので、
   * 取消後に届いた chunk は実装か呼び出し側が context_id と世代で棄てる。
   */
  cancel(reason: string): void;
}

export type TtsAlignmentSource =
  /** プロバイダが返した文字単位の時刻。TtsChunk.alignment に入る。 */
  | 'provider_char'
  /** 文字数と音声の長さからの推定。TtsChunk.estimated_alignment に入る。 */
  | 'estimated_time_proportional'
  | 'unknown';

/** プロバイダの能力の差。項目の根拠は実装の capabilities.ts（C）。 */
export interface TtsCapabilities {
  alignment_source: TtsAlignmentSource;
  /** sendText の文字を送った順に生成へ足せるか。false なら flush か endInput の単位で1要求にまとめる。 */
  incremental_input: boolean;
  /** cancel のとき、プロバイダへ未送信のテキストを確実に捨てられるか。 */
  cancel_discards_unsent_text: boolean;
  /** cancel で生成中の音声を止める手段。 */
  cancel_generation: 'context_close' | 'request_abort' | 'unknown';
  /** cancel で生成中の音声が届かなくなるか。false なら届き続けるので、接続の層で棄てる。 */
  cancel_stops_in_flight_audio: boolean;
  /** 再生の途中で止めた発話を、同じ接続で続きから生成し直せるか。 */
  resumes_after_stop: boolean;
  /** 実 API で確かめた範囲。偽サーバーのみなら false。 */
  verified_with_real_api: boolean;
}

/** 切断や要求の失敗で失った文脈。 */
export interface TtsContextLoss {
  context_id: string;
  audio_playback_id: number;
  generation: number;
  reason: string;
}

/** プロバイダの失敗の種類。kind の値はプロバイダごとに違う（ElevenLabsFailureKind など）。 */
export interface TtsFailure {
  readonly kind: string;
  readonly message: string;
  /** 張り直しても直らない。 */
  readonly fatal: boolean;
  readonly http_status: number | null;
  readonly provider_code: string | null;
}

/**
 * 1接続で複数の文脈を扱う（ElevenLabs multi-stream-input に対応、上限は 5）。
 * 接続を要求ごとに開く実装も、この形の裏に隠す。chunk はどの文脈のものも同じ購読に届く。
 */
export interface TtsConnection {
  readonly max_contexts: number;
  /** 持たない実装は能力が不明として扱う。 */
  readonly capabilities?: TtsCapabilities;
  /** 上限を超えると例外。context_id は audio_playback_id と世代から作る。 */
  openContext(target: { audio_playback_id: number; generation: number }): TtsContext;
  onChunk(listener: (chunk: TtsChunk) => void): Unsubscribe;
  onStatus(listener: (status: ProviderStatusUpdate) => void): Unsubscribe;
  /** 文脈を失った通知。続いて is_last の空の chunk が届く。 */
  onContextLost?(listener: (lost: TtsContextLoss) => void): Unsubscribe;
  /** 失敗ごとの通知。種類で分岐するためのもので、健全性は onStatus を見る。 */
  onFailure?(listener: (failure: TtsFailure) => void): Unsubscribe;
  close(): Promise<void>;
}

export interface TtsProvider extends ProviderIdentity {
  open(config: TtsConnectionConfig): Promise<TtsConnection>;
  /** manifest に残す合成の設定（モデル、声の設定、seed など）。持たないプロバイダは省略。 */
  describeSettings?(): Record<string, unknown>;
}

/** 文脈 ID の共通の作り方。 */
export function ttsContextId(audio_playback_id: number, generation: number): string {
  return `p${audio_playback_id}_g${generation}`;
}

// ---- LLM -------------------------------------------------------------------

export interface LlmMessage {
  role: 'user' | 'assistant';
  text: string;
}

export interface LlmRequest {
  request_id: string;
  purpose: LlmPurpose;
  system: string;
  messages: LlmMessage[];
  /** 構造化出力のスキーマ。プロバイダ側の方式は選定後に確認（仕様§4、未確認）。 */
  response_json_schema: JsonValue | null;
  transcript_revision: number;
  signal?: AbortSignal;
}

export interface LlmUsage {
  input_tokens: Maybe<number>;
  output_tokens: Maybe<number>;
}

export interface LlmResult {
  request_id: string;
  purpose: LlmPurpose;
  text: string;
  model_version: string;
  sent_at: number;
  received_at: number;
  /** 思考を除く最初の本文の断片を受けた時刻。本文がなければ項目がない。 */
  first_text_at?: number;
  finish_reason: Maybe<string>;
  usage: LlmUsage;
}

export interface LlmStream {
  deltas: AsyncIterable<string>;
  result: Promise<LlmResult>;
}

export interface LlmProvider extends ProviderIdentity {
  generate(request: LlmRequest): Promise<LlmResult>;
  stream(request: LlmRequest): LlmStream;
}

// ---- 応答完了の推定器（計画 §4.4） ------------------------------------------

export interface TurnCompletionEstimate {
  /** 推定器なし、失敗などでは null と理由。 */
  p: Maybe<number>;
  estimator: string;
}

/** LLM を呼ぶ推定器が使う文脈。呼ばない推定器は無視してよい。 */
export interface TurnCompletionEstimateContext {
  /** 入力の revision。llm.request へ残す。省略すると 0。 */
  transcript_revision?: number;
  /** 入力が古くなったときに呼び出し側が中断する。 */
  signal?: AbortSignal;
}

export interface TurnCompletionEstimator {
  readonly name: string;
  estimate(
    history: readonly HistoryEntryRef[],
    partial: string,
    context?: TurnCompletionEstimateContext,
  ): Promise<TurnCompletionEstimate>;
}

/** providers.ts が history.ts に依存しないための最小の形。HistoryEntry はこれを満たす。 */
export interface HistoryEntryRef {
  role: 'user' | 'assistant';
  text: string;
}

// ---- SpeechGenerator（計画 §4.3、本実装は D） --------------------------------

export interface PrepareRequest {
  segment_id: number;
  transcript_revision: number;
  /** 通常の応答なら入力文、候補なら発話文。 */
  text: string;
  origin:
    | { kind: 'response' }
    | { kind: 'candidate'; candidate_id: string; candidate_version: number };
}

export interface PreparedSpeech {
  audio_playback_id: number;
  generation: number;
}

export type SpeechInterruptSource = 'vap' | 'fallback' | 'woz';

/** 割り込みの停止の指定。TurnDecision の interrupt_speech から渡す。 */
export interface SpeechStopOptions {
  stop_point: 'word_boundary' | 'immediate';
  /** 語境界を待つ上限（policy の stop_boundary_max_ms）。 */
  max_wait_ms: number;
  decision_source: SpeechInterruptSource;
  fade_ms?: number;
}

export type SpeechStartRefusal =
  | 'unknown_playback'
  | 'not_ready'
  | 'another_playback_active'
  | 'candidate_mismatch'
  | 'expected_candidate_required';

export type SpeechStartResult =
  | { ok: true; generation: number }
  | { ok: false; reason: SpeechStartRefusal };

export interface SpeechGenerator {
  prepare(request: PrepareRequest): PreparedSpeech;
  cancel(audio_playback_id: number, reason: string): void;
  /** 最初の PCM が policy の is_ready_buffer_ms だけバッファされた状態。 */
  isReady(audio_playback_id: number): boolean;
  /**
   * 再生を始める。候補の版と PCM が一致しなければ拒否する（計画 §4.3）。
   * @returns 開始できたら true。
   */
  start(
    audio_playback_id: number,
    expected?: { candidate_id: string; candidate_version: number },
  ): boolean;
  /** options なしは割り込み以外の停止で、即時に止める。 */
  stop(audio_playback_id: number, reason: string, options?: SpeechStopOptions): void;
  /** start の理由つき版。 */
  startChecked?(
    audio_playback_id: number,
    expected?: { candidate_id: string; candidate_version: number },
  ): SpeechStartResult;
  /**
   * 候補の REVISE／WITHDRAW に対応する未再生の PCM を破棄する（計画 §4.3、§4.6）。
   * keep_version を渡すと、その版だけ残す。
   * @returns 破棄した音声の数。
   */
  discardCandidate?(candidate_id: string, reason: string, keep_version?: number): number;
  /** ブラウザの報告。t_ms は client_t_ms を orchestrator の時刻へ補正した値。 */
  handlePlaybackStarted?(message: PlaybackStarted, t_ms: number): void;
  handlePlaybackPosition?(message: PlaybackPosition, t_ms: number): void;
  handlePlaybackEnded?(message: PlaybackEnded, t_ms: number): void;
}
