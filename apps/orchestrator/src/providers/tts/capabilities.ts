/**
 * TTS プロバイダの能力の差。契約の TtsConnection にはまだないので、ここで定義して実装が持つ（統括へ契約への追加を依頼）。
 * 呼び出し側は ttsCapabilitiesOf(connection) で判別する。
 */
import type { TtsChunk, TtsConnection } from '@llm-vap/contracts';

export type TtsAlignmentSource =
  /** プロバイダが返した文字単位の時刻（ElevenLabs）。TtsChunk.alignment に入る。 */
  | 'provider_char'
  /** 文字数と音声の長さからの推定（Gemini TTS）。実測ではない。TtsChunk.alignment は null のまま。 */
  | 'estimated_time_proportional'
  | 'unknown';

export interface TtsCapabilities {
  alignment_source: TtsAlignmentSource;
  /**
   * sendText の文字を送った順に生成へ足せるか。false なら flush か endInput の単位で1要求にまとめる。
   * 文の途中の文字では音声が始まらない。
   */
  incremental_input: boolean;
  /** cancel のときプロバイダへ未送信のテキストを確実に捨てられるか。手元の分はどちらでも捨てる。 */
  cancel_discards_unsent_text: boolean;
  /**
   * cancel で生成中の音声を止める手段。
   *  - context_close: 接続を保ったまま文脈を閉じる（close_context 後に音声が届くかは未検証）
   *  - request_abort: 要求を中断する（クライアント側のみ。課金は続きうる）
   */
  cancel_generation: 'context_close' | 'request_abort' | 'unknown';
  /**
   * cancel で生成中の音声が届かなくなるか。false なら flush 済みの分は届き続けるので、接続の層で棄てる。
   * 実測: ElevenLabs は close_context の後も 3.7 秒ぶんの音声が 420ms 以内に届いた（棄てる必要がある、課金も止まらない見込み）。
   */
  cancel_stops_in_flight_audio: boolean;
  /**
   * 再生の途中で止めた発話を、同じ接続で続きから生成し直せるか。
   * どのプロバイダも false で、停止は Node とブラウザが持つ PCM の破棄で行う。
   */
  resumes_after_stop: boolean;
  /** 実 API で確かめた範囲。偽サーバーのみなら false。 */
  verified_with_real_api: boolean;
}

export const ELEVENLABS_CAPABILITIES: TtsCapabilities = {
  alignment_source: 'provider_char',
  incremental_input: true,
  cancel_discards_unsent_text: true,
  cancel_generation: 'context_close',
  cancel_stops_in_flight_audio: false,
  resumes_after_stop: false,
  verified_with_real_api: true,
};

export const GEMINI_TTS_CAPABILITIES: TtsCapabilities = {
  alignment_source: 'estimated_time_proportional',
  incremental_input: false,
  // flush していない文字はサーバーへ送っていない。送った要求の中のテキストは取り消せない。
  cancel_discards_unsent_text: true,
  cancel_generation: 'request_abort',
  cancel_stops_in_flight_audio: true,
  resumes_after_stop: false,
  verified_with_real_api: true,
};

const UNKNOWN_CAPABILITIES: TtsCapabilities = {
  alignment_source: 'unknown',
  incremental_input: false,
  cancel_discards_unsent_text: false,
  cancel_generation: 'unknown',
  cancel_stops_in_flight_audio: false,
  resumes_after_stop: false,
  verified_with_real_api: false,
};

export function ttsCapabilitiesOf(connection: TtsConnection): TtsCapabilities {
  return (connection as { capabilities?: TtsCapabilities }).capabilities ?? UNKNOWN_CAPABILITIES;
}

/** 推定の文字時刻。chunk 内の相対時刻で、TtsCharAlignment と同じ並び。 */
export interface EstimatedAlignment {
  source: 'estimated_time_proportional';
  chars: string[];
  char_start_ms: number[];
  char_duration_ms: number[];
}

/** Gemini の chunk。口の同期に使うなら estimated_alignment を読み、推定として記録する。 */
export type TtsChunkWithEstimate = TtsChunk & { estimated_alignment?: EstimatedAlignment };

export interface LostContext {
  context_id: string;
  audio_playback_id: number;
  generation: number;
  reason: string;
}
