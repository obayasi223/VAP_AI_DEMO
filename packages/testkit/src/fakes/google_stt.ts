/**
 * Google STT v2 ストリームの偽物。実物は gRPC だが、ここでは GoogleSttTransport の層で差し替える。
 * 入力音声の量（送られたサンプル数）で台本を進めるので決定的。音声認識はしない。
 *
 * 【未確認】応答の形、オフセットの起点、ストリーム上限のエラー名は想定（vendor_shapes.ts、R4 で確認）。
 * 送信単位は固定しない（write の長さは任意。本番の想定は 40ms）。
 * max_stream_audio_ms は既定で無効。資料の上限は 5 分だが実際に切れる時刻は要実測なので、試験が明示する。
 */
import { SAMPLE_RATE_HZ } from '@llm-vap/contracts';
import type {
  GoogleSttResponse,
  GoogleSttStream,
  GoogleSttStreamError,
  GoogleSttTransport,
  GoogleSttWord,
  Unsubscribe,
} from '@llm-vap/contracts';
import { Listeners } from '../listeners';

export interface FakeSttScriptEntry {
  /** 全ストリーム累計の音声がこの長さに達したら返す。 */
  at_audio_ms: number;
  transcript: string;
  is_final?: boolean;
  stability?: number;
  words?: GoogleSttWord[];
  /** 1応答に複数の結果を返す（0.9 の安定部分と 0.01 の末尾など）。指定すると transcript は使わない。 */
  results?: { transcript: string; stability: number }[];
  /** 指定すると文字起こしの代わりに音声イベントだけを返す。 */
  speech_event_type?: 'SPEECH_ACTIVITY_BEGIN' | 'SPEECH_ACTIVITY_END';
}

export interface FakeGoogleSttOptions {
  script: FakeSttScriptEntry[];
  response_delay_ms?: number;
  max_stream_audio_ms?: number;
  /** 累計の音声がこの長さに達したら UNAVAILABLE で切る（1回限り）。 */
  disconnect_at_audio_ms?: number;
}

class FakeStream implements GoogleSttStream {
  private readonly responses = new Listeners<GoogleSttResponse>();
  private readonly errors = new Listeners<GoogleSttStreamError>();
  private readonly ends = new Listeners<void>();
  private streamSamples = 0;
  ended = false;

  constructor(private readonly owner: FakeGoogleSttTransport) {}

  write(linear16: Int16Array): void {
    if (this.ended) throw new Error('write after end');
    this.streamSamples += linear16.length;
    this.owner.onAudio(this, linear16.length);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.ends.emit();
  }

  onResponse(listener: (response: GoogleSttResponse) => void): Unsubscribe {
    return this.responses.add(listener);
  }

  onError(listener: (error: GoogleSttStreamError) => void): Unsubscribe {
    return this.errors.add(listener);
  }

  onEnd(listener: () => void): Unsubscribe {
    return this.ends.add(() => listener());
  }

  get audioMs(): number {
    return (this.streamSamples / SAMPLE_RATE_HZ) * 1000;
  }

  deliver(response: GoogleSttResponse): void {
    if (!this.ended) this.responses.emit(response);
  }

  fail(error: GoogleSttStreamError): void {
    if (this.ended) return;
    this.ended = true;
    this.errors.emit(error);
  }
}

export class FakeGoogleSttTransport implements GoogleSttTransport {
  readonly configs: { model: string; language_code: string; sample_rate_hz: number }[] = [];
  private cumulativeSamples = 0;
  private scriptIndex = 0;
  private disconnected = false;

  constructor(private readonly options: FakeGoogleSttOptions) {}

  get openCount(): number {
    return this.configs.length;
  }

  openStream(config: { model: string; language_code: string; sample_rate_hz: number }): GoogleSttStream {
    this.configs.push(config);
    return new FakeStream(this);
  }

  /** @internal */
  onAudio(stream: FakeStream, samples: number): void {
    this.cumulativeSamples += samples;
    const totalMs = (this.cumulativeSamples / SAMPLE_RATE_HZ) * 1000;

    const disconnectAt = this.options.disconnect_at_audio_ms;
    if (disconnectAt !== undefined && !this.disconnected && totalMs >= disconnectAt) {
      this.disconnected = true;
      stream.fail({ code: 'UNAVAILABLE', message: 'fake disconnect' });
      return;
    }
    const limit = this.options.max_stream_audio_ms;
    if (limit !== undefined && stream.audioMs >= limit) {
      stream.fail({ code: 'OUT_OF_RANGE', message: 'fake stream duration limit' });
      return;
    }

    while (this.scriptIndex < this.options.script.length) {
      const entry = this.options.script[this.scriptIndex] as FakeSttScriptEntry;
      if (entry.at_audio_ms > totalMs) break;
      this.scriptIndex += 1;
      const response: GoogleSttResponse = entry.speech_event_type ? {
        results: [],
        speech_event_type: entry.speech_event_type,
        speech_event_offset_ms: stream.audioMs,
      } : {
        results: (entry.results ?? [{ transcript: entry.transcript, stability: entry.stability ?? 0 }]).map(
          (r) => ({
            transcript: r.transcript,
            is_final: entry.is_final ?? false,
            // 未設定の既定値 0.0 を再現する（provider_matrix §2.2）。
            stability: r.stability,
            result_end_offset_ms: stream.audioMs,
            ...(entry.words ? { words: entry.words } : {}),
          }),
        ),
      };
      const delay = this.options.response_delay_ms ?? 0;
      if (delay > 0) setTimeout(() => stream.deliver(response), delay);
      else stream.deliver(response);
    }
  }
}
