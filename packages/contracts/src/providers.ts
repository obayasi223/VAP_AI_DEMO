/**
 * プロバイダの TS インターフェース。本実装は C（STT、TTS）と D（LLM、SpeechGenerator、推定器）。
 * test double は @llm-vap/testkit。test double の結果を性能として報告しない（計画 §4.5a）。
 *
 * 時刻（sent_at など）は orchestrator の t_monotonic_ms。実装は TimeSource を受け取って記録する。
 */
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
 * 文字単位の時刻。時刻はチャンク内の相対値（provider_matrix §1 の #9）。
 * 3つの配列は同じ長さ。累積と語境界（Intl.Segmenter）は呼び出し側で作る（D）。
 */
export interface TtsCharAlignment {
  chars: string[];
  char_start_ms: number[];
  char_duration_ms: number[];
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

/**
 * 1接続で複数の文脈を扱う（ElevenLabs multi-stream-input に対応、上限は 5）。
 * 接続を要求ごとに開く実装も、この形の裏に隠す。chunk はどの文脈のものも同じ購読に届く。
 */
export interface TtsConnection {
  readonly max_contexts: number;
  /** 上限を超えると例外。context_id は audio_playback_id と世代から作る。 */
  openContext(target: { audio_playback_id: number; generation: number }): TtsContext;
  onChunk(listener: (chunk: TtsChunk) => void): Unsubscribe;
  onStatus(listener: (status: ProviderStatusUpdate) => void): Unsubscribe;
  close(): Promise<void>;
}

export interface TtsProvider extends ProviderIdentity {
  open(config: TtsConnectionConfig): Promise<TtsConnection>;
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

export interface TurnCompletionEstimator {
  readonly name: string;
  estimate(history: readonly HistoryEntryRef[], partial: string): Promise<TurnCompletionEstimate>;
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
  stop(audio_playback_id: number, reason: string): void;
}
