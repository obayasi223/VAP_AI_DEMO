/**
 * 外部 API の「想定の形」。C と D の本実装と偽サーバーが共有する、インターフェース層の吸収点。
 * ここの形はキーなしで書いた想定で、実 API では未確認。R4 の実呼び出しで確定し、違えばここを直す。
 * プロバイダの差はここと providers.ts の間で吸収し、制御側へ漏らさない。
 */
import type { Unsubscribe } from './providers';

// ---- Google Cloud Speech-to-Text v2（gRPC） ----------------------------------
// 資料の確認結果は docs/provider_matrix.md §2。実 API は呼んでいない（キーなし）。
// 【資料で確認】stability の 0.0 は未設定の印、final 済みの部分は次の interim に含まれない、
//   chirp_3 はストリーミングで語時刻なし、ストリームは最大 5 分。送信単位はこの層で固定しない（40ms の想定）。
// 【要実測】chirp_3 の interim と stability の有無、offset の基準、切断時のエラー、gRPC の実際の型。

export interface GoogleSttWord {
  word: string;
  /** 要実測: chirp_3 のストリーミングでは出ない。他のモデルの interim は未確認。 */
  start_offset_ms?: number;
  end_offset_ms?: number;
}

export interface GoogleSttResult {
  transcript: string;
  is_final: boolean;
  /** 0.0 は未設定の印。stabilityFromProvider を通す。 */
  stability: number;
  /** ストリーム先頭からのオフセットと想定（未確認）。 */
  result_end_offset_ms: number;
  words?: GoogleSttWord[];
}

/**
 * 応答の課金の項目（実測。provider_matrix §10.3）。proto の StreamingRecognizeResponse.metadata。
 * 値はストリームの累積で、最後の値がそのストリームの課金の長さ。grpc_transport は proto の形（metadata.totalBilledDuration）で受ける。
 */
export interface GoogleSttBillingMetadata {
  total_billed_ms: number;
}

export interface GoogleSttResponse {
  /** final 0〜1個 → interim 0個以上。1応答に stability の違う interim が複数入る（実測）。 */
  results: GoogleSttResult[];
  metadata?: GoogleSttBillingMetadata;
  /** enable_voice_activity_events のとき。 */
  speech_event_type?: 'SPEECH_ACTIVITY_BEGIN' | 'SPEECH_ACTIVITY_END';
  speech_event_offset_ms?: number;
}

export interface GoogleSttStreamError {
  /** gRPC のステータス名（例: UNAVAILABLE, OUT_OF_RANGE）。 */
  code: string;
  message: string;
}

/** 1本の双方向ストリーム。本番は gRPC、試験は FakeGoogleSttTransport。 */
export interface GoogleSttStream {
  write(linear16: Int16Array): void;
  end(): void;
  onResponse(listener: (response: GoogleSttResponse) => void): Unsubscribe;
  onError(listener: (error: GoogleSttStreamError) => void): Unsubscribe;
  onEnd(listener: () => void): Unsubscribe;
}

export interface GoogleSttTransport {
  openStream(config: { model: string; language_code: string; sample_rate_hz: number }): GoogleSttStream;
}

// ---- ElevenLabs multi-stream-input／stream-input（WS） --------------------------
// 資料の確認結果は docs/provider_matrix.md §3、§6.6。第1候補は multi-stream-input。
// 【資料で確認】alignment は文字単位、sync_alignment はクエリ（既定 false）、
//   1接続 5 文脈、close_context、無通信は既定 20 秒で inactivity_timeout により最大 180 秒、
//   keep-alive は multi が {context_id, text: ""}、stream-input が空白1文字（空文字列は閉じる）。
// 【実測（multi-stream-input。provider_matrix §10.1）】pcm_16000／pcm_24000 は通る、pcm_44100 は Pro 以上で拒否。
//   flush では isFinal が来ず、close_context の後に来る。close_context の後も flush 済みの音声は届く。
//   alignment は flush をまたぐと文脈の累積の時刻（資料はチャンク相対）。chars は入力の1文字ごとで末尾に空白が付く。
//   6本目は接続ごと閉じられる。エラーは接続が開いた後のメッセージで来て、続いて閉じる。
// 【要実測】取消分の課金、切断の close code の全種類。

/** stream-input のテキストメッセージ。 */
export interface ElevenLabsTextMessage {
  text: string;
  /** 認証は最初のメッセージの想定（ヘッダの場合は要確認）。 */
  xi_api_key?: string;
  flush?: boolean;
}

/** multi-stream-input のテキストメッセージ。 */
export interface ElevenLabsMultiMessage {
  context_id: string;
  text?: string;
  flush?: boolean;
  close_context?: boolean;
  xi_api_key?: string;
}

/** 資料はチャンク内の相対値、実測では flush をまたぐと文脈の累積。基準は受信側で判定する（C の toChunkRelative）。 */
export interface ElevenLabsAlignment {
  chars: string[];
  charStartTimesMs: number[];
  charDurationsMs: number[];
}

export interface ElevenLabsAudioMessage {
  /** base64 の PCM（S16LE）。最後のメッセージでは null（実測）。 */
  audio: string | null;
  isFinal: boolean | null;
  alignment: ElevenLabsAlignment | null;
  /**
   * 読みへ正規化した文字の時刻。実測では日本語がローマ字に展開されるので、発話済みや語境界に使わない。
   * sync_alignment のときに届く。
   */
  normalizedAlignment?: ElevenLabsAlignment | null;
  /** multi-stream-input のみ。 */
  contextId?: string;
}

/**
 * 接続が開いた後に届くエラー（実測）。不正なキーも HTTP では拒否されず、これが届いて接続が閉じる。
 * 実測した error の値: invalid_api_key、output_format_not_allowed、voice_id_does_not_exist、max_active_conversations。
 */
export interface ElevenLabsErrorMessage {
  message: string;
  error: string;
  code: 1008;
}

/**
 * 課金の確認に使う GET /v1/user/subscription の項目（tools/provider_probe/lib/tts.mjs）。
 * WS の応答に課金の項目はない。今のキーには user_read がないので、実 API では未確認。
 */
export interface ElevenLabsSubscriptionUsage {
  character_count: number;
  character_limit: number;
  tier: string;
}

// ---- Gemini streamGenerateContent（SSE） ---------------------------------------
// 資料の確認結果は docs/provider_matrix.md §4。実呼び出しは未検証（キーなし）。
// 【資料で確認】Interactions が推奨で generateContent は legacy。Interactions は store: false が必須（§1 の #7）。
//   中断はクライアント側のみで課金は続く。temperature などは指定しない。
// 【未確認】下記の項目の完全な一覧。Interactions の SSE の正確なイベント形は要実測。

export interface GeminiRequestBody {
  contents: { role: 'user' | 'model'; parts: { text: string }[] }[];
  systemInstruction?: { parts: { text: string }[] };
  generationConfig?: Record<string, unknown>;
}

export interface GeminiStreamChunk {
  candidates: {
    content: { role: 'model'; parts: { text: string }[] };
    finishReason?: string;
  }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  modelVersion?: string;
}

export interface GeminiInteractionRequest {
  model: string;
  input: unknown;
  stream?: boolean;
  /** 人の発話の書き起こしを送るので false を必須とする。 */
  store?: boolean;
  generation_config?: Record<string, unknown>;
  response_format?: Record<string, unknown>;
  system_instruction?: unknown;
}

export type GeminiInteractionEvent =
  | { event_type: 'step.delta'; delta: { type: 'text'; text: string } }
  | { event_type: 'interaction.completed'; model_version?: string };
