/**
 * 本番の GoogleSttTransport。@google-cloud/speech の _streamingRecognize() を使う。
 * client.streamingRecognize() は v1 の形で書き込むので v2 には使えない（provider_matrix §1 の #4）。
 * 認証は GOOGLE_APPLICATION_CREDENTIALS か ADC。鍵の内容を読まず、記録もしない。
 */
import type {
  GoogleSttResponse,
  GoogleSttResult,
  GoogleSttStream,
  GoogleSttStreamError,
  GoogleSttTransport,
  GoogleSttWord,
  Unsubscribe,
} from '@llm-vap/contracts';
import { Listeners } from './listeners';

/** gRPC のステータス番号の名前。 */
const GRPC_STATUS: Record<number, string> = {
  1: 'CANCELLED',
  2: 'UNKNOWN',
  3: 'INVALID_ARGUMENT',
  4: 'DEADLINE_EXCEEDED',
  5: 'NOT_FOUND',
  6: 'ALREADY_EXISTS',
  7: 'PERMISSION_DENIED',
  8: 'RESOURCE_EXHAUSTED',
  9: 'FAILED_PRECONDITION',
  10: 'ABORTED',
  11: 'OUT_OF_RANGE',
  12: 'UNIMPLEMENTED',
  13: 'INTERNAL',
  14: 'UNAVAILABLE',
  15: 'DATA_LOSS',
  16: 'UNAUTHENTICATED',
};

interface ProtoDuration {
  seconds?: number | string | null;
  nanos?: number | null;
}

interface ProtoWord {
  word?: string | null;
  startOffset?: ProtoDuration | null;
  endOffset?: ProtoDuration | null;
}

interface ProtoResult {
  alternatives?: { transcript?: string | null; words?: ProtoWord[] | null }[] | null;
  isFinal?: boolean | null;
  stability?: number | null;
  resultEndOffset?: ProtoDuration | null;
}

export interface ProtoStreamingResponse {
  results?: ProtoResult[] | null;
  speechEventType?: string | null;
  speechEventOffset?: ProtoDuration | null;
  metadata?: { totalBilledDuration?: ProtoDuration | null } | null;
}

interface DuplexLike {
  write(chunk: unknown): unknown;
  end(): unknown;
  on(event: string, listener: (...args: never[]) => void): unknown;
}

export interface SpeechClientLike {
  _streamingRecognize(): unknown;
  close(): Promise<void>;
}

export function durationToMs(duration: ProtoDuration | null | undefined): number | undefined {
  if (!duration) return undefined;
  return Number(duration.seconds ?? 0) * 1000 + Number(duration.nanos ?? 0) / 1e6;
}

/** gRPC の応答を vendor_shapes の形へ。stability の 0 は未設定の印のまま渡す。 */
export function mapProtoResponse(response: ProtoStreamingResponse): GoogleSttResponse {
  const results: GoogleSttResult[] = (response.results ?? []).map((result) => {
    const alternative = result.alternatives?.[0];
    const mapped: GoogleSttResult = {
      transcript: alternative?.transcript ?? '',
      is_final: Boolean(result.isFinal),
      stability: result.stability ?? 0,
      result_end_offset_ms: durationToMs(result.resultEndOffset) ?? 0,
    };
    if (alternative?.words?.length) {
      mapped.words = alternative.words.map((word) => {
        const out: GoogleSttWord = { word: word.word ?? '' };
        const start = durationToMs(word.startOffset);
        const end = durationToMs(word.endOffset);
        if (start !== undefined) out.start_offset_ms = start;
        if (end !== undefined) out.end_offset_ms = end;
        return out;
      });
    }
    return mapped;
  });
  const out: GoogleSttResponse = { results };
  const event = response.speechEventType;
  if (event === 'SPEECH_ACTIVITY_BEGIN' || event === 'SPEECH_ACTIVITY_END') {
    out.speech_event_type = event;
    const offset = durationToMs(response.speechEventOffset);
    if (offset !== undefined) out.speech_event_offset_ms = offset;
  }
  return out;
}

class GrpcStream implements GoogleSttStream {
  private readonly responses = new Listeners<GoogleSttResponse>();
  private readonly errors = new Listeners<GoogleSttStreamError>();
  private readonly ends = new Listeners<void>();
  private open = true;

  constructor(
    private readonly duplex: DuplexLike,
    onRaw: ((streamNo: number, response: ProtoStreamingResponse) => void) | undefined,
    streamNo: number,
  ) {
    duplex.on('data', (response: ProtoStreamingResponse) => {
      onRaw?.(streamNo, response);
      this.responses.emit(mapProtoResponse(response));
    });
    duplex.on('error', (error: { code?: number | string; message?: string }) => {
      this.open = false;
      const code = typeof error.code === 'number' ? (GRPC_STATUS[error.code] ?? `CODE_${error.code}`) : String(error.code ?? 'UNKNOWN');
      this.errors.emit({ code, message: error.message ?? 'stream error' });
    });
    duplex.on('end', () => {
      this.open = false;
      this.ends.emit();
    });
  }

  write(linear16: Int16Array): void {
    if (!this.open) return;
    this.duplex.write({ audio: Buffer.from(linear16.buffer, linear16.byteOffset, linear16.byteLength) });
  }

  end(): void {
    if (this.open) this.duplex.end();
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
}

export interface GrpcTransportConfig {
  project: string;
  location: string;
  /** 測定用。生の応答を見る（課金の報告など）。 */
  onRaw?: (streamNo: number, response: ProtoStreamingResponse) => void;
}

export class GrpcGoogleSttTransport implements GoogleSttTransport {
  private streamNo = 0;

  constructor(
    private readonly client: SpeechClientLike,
    private readonly config: GrpcTransportConfig,
  ) {}

  openStream(config: { model: string; language_code: string; sample_rate_hz: number }): GoogleSttStream {
    const duplex = this.client._streamingRecognize() as DuplexLike;
    // 先に購読してから設定を書く。
    const stream = new GrpcStream(duplex, this.config.onRaw, ++this.streamNo);
    duplex.write({
      recognizer: `projects/${this.config.project}/locations/${this.config.location}/recognizers/_`,
      streamingConfig: {
        config: {
          explicitDecodingConfig: {
            encoding: 'LINEAR16',
            sampleRateHertz: config.sample_rate_hz,
            audioChannelCount: 1,
          },
          languageCodes: [config.language_code],
          model: config.model,
          // 語時刻は final のみ返る（実測）。
          features: { enableWordTimeOffsets: true, enableAutomaticPunctuation: true },
        },
        streamingFeatures: { interimResults: true, enableVoiceActivityEvents: true },
      },
    });
    return stream;
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

export async function createGrpcGoogleSttTransport(config: GrpcTransportConfig): Promise<GrpcGoogleSttTransport> {
  const { v2 } = await import('@google-cloud/speech');
  const client = new v2.SpeechClient({
    apiEndpoint: config.location === 'global' ? 'speech.googleapis.com' : `${config.location}-speech.googleapis.com`,
  });
  return new GrpcGoogleSttTransport(client as unknown as SpeechClientLike, config);
}
