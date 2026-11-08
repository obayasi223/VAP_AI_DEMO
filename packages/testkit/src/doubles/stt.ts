import { absent, present } from '@llm-vap/contracts';
import type {
  ProviderStatusUpdate,
  Stability,
  StabilitySource,
  SttProvider,
  SttResult,
  SttSession,
  SttSessionConfig,
  Unsubscribe,
} from '@llm-vap/contracts';
import { Listeners } from '../listeners';

export interface ScriptedSttInput {
  kind?: 'interim' | 'final';
  text: string;
  /** 省略時は final なら text 全部、interim なら空（安定と見なさない）。 */
  stable_text?: string;
  audio_frame_end: number;
  stability?: Stability;
  stability_source?: StabilitySource;
  /** 省略時は現在の ASR 区間（final で次へ進む）。 */
  asr_segment_id?: number;
  /** 省略時は今の segment。音声位置が前の segment の結果が遅れて届く状況を作る。 */
  segment_id?: number;
}

/** 試験が明示的に結果を流し込む STT。音声認識はしない。 */
export class ScriptedSttSession implements SttSession {
  readonly pushed: { audio_frame: number; samples: number }[] = [];
  closed = false;
  private readonly results = new Listeners<SttResult>();
  private readonly statuses = new Listeners<ProviderStatusUpdate>();
  private segmentId = 0;
  private revision = 0;
  private asrSegmentId = 0;
  private asrFrameStart: number;

  constructor(
    private readonly provider: ScriptedSttProvider,
    config: SttSessionConfig,
    private readonly now: () => number,
  ) {
    this.asrFrameStart = config.start_audio_frame;
  }

  pushAudio(audio_frame: number, mic: Int16Array): void {
    this.pushed.push({ audio_frame, samples: mic.length });
  }

  advanceSegment(new_segment_id: number): void {
    this.segmentId = new_segment_id;
  }

  onResult(listener: (result: SttResult) => void): Unsubscribe {
    return this.results.add(listener);
  }

  onStatus(listener: (status: ProviderStatusUpdate) => void): Unsubscribe {
    return this.statuses.add(listener);
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  /** 試験から結果を発生させる。 */
  deliver(input: ScriptedSttInput): SttResult {
    const kind = input.kind ?? 'interim';
    const stable_text = input.stable_text ?? (kind === 'final' ? input.text : '');
    const stability = input.stability ?? absent('test_double_has_no_stability');
    const result: SttResult = {
      kind,
      text: input.text,
      stable_text,
      unstable_text: input.text.slice(stable_text.length),
      parts: [{ text: input.text, stability }],
      segment_id: input.segment_id ?? this.segmentId,
      asr_segment_id: input.asr_segment_id ?? this.asrSegmentId,
      asr_segment_frame_start: this.asrFrameStart,
      transcript_revision: ++this.revision,
      stability,
      stability_source: input.stability_source ?? 'derived',
      audio_frame_end: input.audio_frame_end,
      timing_precision: 'result_end_offset',
      words: absent('test_double_has_no_word_times'),
      stream_id: 'scripted_stream',
      provider: this.provider.provider,
      model_version: this.provider.model_version,
      received_at: this.now(),
    };
    if (kind === 'final') {
      this.asrSegmentId += 1;
      this.asrFrameStart = input.audio_frame_end;
    }
    this.results.emit(result);
    return result;
  }

  deliverStatus(status: ProviderStatusUpdate['status'], reason: string): void {
    this.statuses.emit({
      provider: this.provider.provider,
      status,
      reason: present(reason),
      retry_attempt: 0,
      next_retry_ms: absent('test_double_does_not_retry'),
    });
  }
}

export class ScriptedSttProvider implements SttProvider {
  readonly provider = 'scripted_stt';
  readonly model_version = 'test_double';
  readonly provider_class = 'test_double' as const;
  readonly sessions: ScriptedSttSession[] = [];

  constructor(private readonly now: () => number = () => 0) {}

  async open(config: SttSessionConfig): Promise<ScriptedSttSession> {
    const session = new ScriptedSttSession(this, config, this.now);
    this.sessions.push(session);
    return session;
  }
}
