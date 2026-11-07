/**
 * 台本のプロバイダ（test double）。E2E と、キーのない状態での配線確認だけに使う（レーン J）。
 * 設定で明示したとき（*_PROVIDER_CLASS=test_double）だけ使い、provider_class は必ず test_double。
 * ここの結果を音声認識・応答・合成の性能として報告しない（計画 §4.5a）。
 *
 *  - EnergyScriptedStt: 音声認識はしない。mic のエネルギーで「話している」区間を見て、台本の文を
 *    interim として伸ばし、無音が続いたら final を出す。
 *  - WavScriptedTts: 音声合成はしない。録音済みの WAV（既定は models/ja.wav）を切り出して返す。
 *    句読点の後に無音を入れるので、AI 発話中のポーズができる。文字の時刻は比例配分（provider_char ではない）。
 *  - ScriptedReplyLlm: 決まった返答を返す。
 */
import { readFileSync } from 'node:fs';
import {
  SAMPLE_RATE_HZ,
  absent,
  modelOutput,
  modelOutputAbsent,
  present,
  ttsContextId,
} from '@llm-vap/contracts';
import type {
  EventEmitter,
  LlmProvider,
  LlmRequest,
  LlmResult,
  LlmStream,
  ProviderStatusUpdate,
  SttProvider,
  SttResult,
  SttSession,
  SttSessionConfig,
  TimeSource,
  TtsCapabilities,
  TtsChunk,
  TtsConnection,
  TtsConnectionConfig,
  TtsContext,
  TtsProvider,
  Unsubscribe,
} from '@llm-vap/contracts';
import { rmsDbfs } from '../session/audio_state';

type Listener<T> = (value: T) => void;
class Listeners<T> {
  private readonly set = new Set<Listener<T>>();
  add(listener: Listener<T>): Unsubscribe {
    this.set.add(listener);
    return () => this.set.delete(listener);
  }
  emit(value: T): void {
    for (const listener of this.set) listener(value);
  }
}

// ---- STT -------------------------------------------------------------------------

export const DEFAULT_STT_SCRIPT = [
  'こんにちは、今日はちょっと相談したいことがあります。',
  '最近、朝起きるのがつらくて困っています。',
  '何か良い方法はありますか。',
];

export interface EnergyScriptedSttOptions {
  time: TimeSource;
  emitter?: EventEmitter;
  script?: readonly string[];
  /** この dBFS 以上の枠を発話とみなす。 */
  voiced_dbfs?: number;
  /** 発話がこれだけ途切れたら final。 */
  final_after_silence_ms?: number;
  /** 1文字あたりの発話の長さ。interim の伸び方に使う。 */
  ms_per_char?: number;
}

class EnergyScriptedSttSession implements SttSession {
  private readonly results = new Listeners<SttResult>();
  private readonly statuses = new Listeners<ProviderStatusUpdate>();
  private segmentId = 0;
  private asrSegmentId = 0;
  private asrFrameStart: number;
  private revision = 0;
  private scriptIndex = 0;
  private voicedSamples = 0;
  private lastVoicedEnd: number | null = null;
  private lastEmittedChars = 0;
  private active = false;

  constructor(
    private readonly provider: EnergyScriptedSttProvider,
    config: SttSessionConfig,
    private readonly options: Required<Omit<EnergyScriptedSttOptions, 'emitter'>> & { emitter?: EventEmitter },
  ) {
    this.asrFrameStart = config.start_audio_frame;
  }

  pushAudio(audio_frame: number, mic: Int16Array): void {
    const end = audio_frame + mic.length;
    const voiced = rmsDbfs(mic) >= this.options.voiced_dbfs;
    if (voiced) {
      if (!this.active) {
        this.active = true;
        this.asrFrameStart = audio_frame;
        this.voicedSamples = 0;
        this.lastEmittedChars = 0;
      }
      this.voicedSamples += mic.length;
      this.lastVoicedEnd = end;
      const text = this.currentSentence();
      const chars = Math.min(
        [...text].length,
        Math.floor(((this.voicedSamples / SAMPLE_RATE_HZ) * 1000) / this.options.ms_per_char),
      );
      // 文字が増えるたびではなく 4 文字ごとに interim を出す（実物の頻度に近づける）。
      if (chars >= this.lastEmittedChars + 4) {
        this.lastEmittedChars = chars;
        this.deliver('interim', [...text].slice(0, chars).join(''), end);
      }
      return;
    }
    if (
      this.active &&
      this.lastVoicedEnd !== null &&
      ((end - this.lastVoicedEnd) / SAMPLE_RATE_HZ) * 1000 >= this.options.final_after_silence_ms
    ) {
      this.active = false;
      this.deliver('final', this.currentSentence(), this.lastVoicedEnd);
      this.scriptIndex += 1;
    }
  }

  private currentSentence(): string {
    const script = this.options.script;
    return script[this.scriptIndex % script.length] as string;
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
    this.active = false;
  }

  private deliver(kind: 'interim' | 'final', text: string, audio_frame_end: number): void {
    const stability = kind === 'final' ? absent('final_result') : absent('test_double_has_no_stability');
    const result: SttResult = {
      kind,
      text,
      stable_text: kind === 'final' ? text : '',
      unstable_text: kind === 'final' ? '' : text,
      parts: [{ text, stability }],
      segment_id: this.segmentId,
      asr_segment_id: this.asrSegmentId,
      asr_segment_frame_start: this.asrFrameStart,
      transcript_revision: ++this.revision,
      stability,
      stability_source: 'derived',
      audio_frame_end,
      timing_precision: 'result_end_offset',
      words: absent('test_double_has_no_word_times'),
      stream_id: 'scripted_stream',
      provider: this.provider.provider,
      model_version: this.provider.model_version,
      received_at: this.options.time.monotonicMs(),
    };
    if (kind === 'final') {
      this.asrSegmentId += 1;
      this.asrFrameStart = audio_frame_end;
    }
    const { kind: _kind, received_at: _received, ...fields } = result;
    this.options.emitter?.emit({ event: kind === 'final' ? 'stt.final' : 'stt.interim', ...fields });
    this.results.emit(result);
  }
}

export class EnergyScriptedSttProvider implements SttProvider {
  readonly provider = 'scripted_stt';
  readonly model_version = 'test_double';
  readonly provider_class = 'test_double' as const;
  private readonly options: Required<Omit<EnergyScriptedSttOptions, 'emitter'>> & { emitter?: EventEmitter };

  constructor(options: EnergyScriptedSttOptions) {
    this.options = {
      script: DEFAULT_STT_SCRIPT,
      voiced_dbfs: -40,
      final_after_silence_ms: 600,
      ms_per_char: 120,
      ...options,
    };
  }

  async open(config: SttSessionConfig): Promise<SttSession> {
    return new EnergyScriptedSttSession(this, config, this.options);
  }
}

// ---- TTS -------------------------------------------------------------------------

const PAUSE_AFTER = /[、。！？!?,.]/;

/** 16bit PCM の WAV（モノラルまたはステレオの第1チャネル）を読み、線形補間で rate へ変換する。 */
export function loadWavAsPcm(path: string, rate: number): Int16Array {
  const buf = readFileSync(path);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${path} is not a WAV file`);
  }
  let offset = 12;
  let channels = 1;
  let srcRate = 0;
  let bits = 0;
  let data: Buffer | null = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = buf.subarray(offset + 8, offset + 8 + size);
    if (id === 'fmt ') {
      channels = body.readUInt16LE(2);
      srcRate = body.readUInt32LE(4);
      bits = body.readUInt16LE(14);
    } else if (id === 'data') {
      data = body;
    }
    offset += 8 + size + (size % 2);
  }
  if (data === null || bits !== 16 || srcRate === 0) throw new Error(`${path}: need 16-bit PCM`);
  const frames = Math.floor(data.length / (2 * channels));
  const src = new Float64Array(frames);
  for (let i = 0; i < frames; i += 1) src[i] = data.readInt16LE(i * 2 * channels);
  const outLength = Math.floor((frames * rate) / srcRate);
  const out = new Int16Array(outLength);
  for (let i = 0; i < outLength; i += 1) {
    const x = (i * srcRate) / rate;
    const i0 = Math.floor(x);
    const i1 = Math.min(frames - 1, i0 + 1);
    const t = x - i0;
    out[i] = Math.round((src[i0] as number) * (1 - t) + (src[i1] as number) * t);
  }
  return out;
}

/** 声の区間だけを繋いだ音源にする（WAV の先頭と末尾の無音で「ポーズ」が混ざらないように）。 */
function voicedOnly(pcm: Int16Array, rate: number): Int16Array {
  const win = Math.round(rate * 0.02);
  const parts: Int16Array[] = [];
  for (let at = 0; at + win <= pcm.length; at += win) {
    const frame = pcm.subarray(at, at + win);
    if (rmsDbfs(frame) >= -45) parts.push(frame);
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Int16Array(total);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out.length > 0 ? out : pcm;
}

export interface WavScriptedTtsOptions {
  wav_path: string;
  ms_per_char?: number;
  pause_ms?: number;
  /** chunk を出す間隔（実時間）。合成の待ち時間の代わり。 */
  chunk_interval_ms?: number;
  first_chunk_delay_ms?: number;
}

class WavScriptedContext implements TtsContext {
  readonly context_id: string;
  private pending = '';
  private inputEnded = false;
  private cancelled = false;
  private seq = 0;
  private queue: { text: string; pause: boolean }[] = [];
  private timer: NodeJS.Timeout | null = null;
  private started = false;

  constructor(
    readonly audio_playback_id: number,
    readonly generation: number,
    private readonly owner: WavScriptedTtsConnection,
  ) {
    this.context_id = ttsContextId(audio_playback_id, generation);
  }

  sendText(text: string): void {
    if (this.cancelled || this.inputEnded) return;
    this.pending += text;
    this.cut(false);
  }

  flush(): void {
    this.cut(true);
  }

  endInput(): void {
    this.cut(true);
    this.inputEnded = true;
    this.schedule();
  }

  cancel(): void {
    this.cancelled = true;
    this.queue = [];
    if (this.timer !== null) clearTimeout(this.timer);
    this.owner.release(this);
  }

  /** 句読点までを1つの chunk にする。 */
  private cut(all: boolean): void {
    let index: number;
    while ((index = this.pending.search(PAUSE_AFTER)) >= 0) {
      this.queue.push({ text: this.pending.slice(0, index + 1), pause: true });
      this.pending = this.pending.slice(index + 1);
    }
    if (all && this.pending !== '') {
      this.queue.push({ text: this.pending, pause: false });
      this.pending = '';
    }
    this.schedule();
  }

  private schedule(): void {
    if (this.cancelled || this.timer !== null) return;
    if (this.queue.length === 0 && !(this.inputEnded && this.pending === '')) return;
    const delay = this.started ? this.owner.options.chunk_interval_ms : this.owner.options.first_chunk_delay_ms;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.started = true;
      this.emitNext();
      this.schedule();
    }, delay);
  }

  private emitNext(): void {
    if (this.cancelled) return;
    const item = this.queue.shift();
    const last = this.queue.length === 0 && this.inputEnded && this.pending === '';
    const rate = this.owner.config.preferred_sample_rate_hz;
    if (item === undefined) {
      if (!last) return;
      this.owner.emitChunk(this.chunk(new Int16Array(0), [], rate, true));
      this.owner.release(this);
      this.cancelled = true;
      return;
    }
    const chars = [...item.text];
    const { ms_per_char, pause_ms } = this.owner.options;
    const speechSamples = Math.round(((chars.length * ms_per_char) / 1000) * rate);
    const pauseSamples = item.pause ? Math.round((pause_ms / 1000) * rate) : 0;
    const pcm = new Int16Array(speechSamples + pauseSamples);
    pcm.set(this.owner.takeSpeech(speechSamples), 0);
    this.owner.emitChunk(this.chunk(pcm, chars, rate, last));
    if (last) {
      this.owner.release(this);
      this.cancelled = true;
    }
  }

  private chunk(pcm: Int16Array, chars: string[], rate: number, is_last: boolean): TtsChunk {
    const per = this.owner.options.ms_per_char;
    return {
      context_id: this.context_id,
      audio_playback_id: this.audio_playback_id,
      generation: this.generation,
      seq: this.seq++,
      sample_rate_hz: rate,
      pcm,
      alignment: absent('test_double_has_no_alignment'),
      is_last,
      ...(chars.length === 0
        ? {}
        : {
            estimated_alignment: {
              source: 'estimated_time_proportional' as const,
              chars,
              char_start_ms: chars.map((_, i) => i * per),
              char_duration_ms: chars.map(() => per),
            },
          }),
    };
  }
}

const SCRIPTED_TTS_CAPABILITIES: TtsCapabilities = {
  alignment_source: 'estimated_time_proportional',
  incremental_input: true,
  cancel_discards_unsent_text: true,
  cancel_generation: 'context_close',
  cancel_stops_in_flight_audio: true,
  resumes_after_stop: false,
  verified_with_real_api: false,
};

class WavScriptedTtsConnection implements TtsConnection {
  readonly max_contexts = 5;
  readonly capabilities = SCRIPTED_TTS_CAPABILITIES;
  private readonly active = new Set<WavScriptedContext>();
  private readonly chunks = new Listeners<TtsChunk>();
  private readonly statuses = new Listeners<ProviderStatusUpdate>();
  private cursor = 0;

  constructor(
    readonly config: TtsConnectionConfig,
    readonly options: Required<WavScriptedTtsOptions>,
    private readonly source: Int16Array,
  ) {}

  openContext(target: { audio_playback_id: number; generation: number }): TtsContext {
    if (this.active.size >= this.max_contexts) throw new Error('too many active contexts');
    const context = new WavScriptedContext(target.audio_playback_id, target.generation, this);
    this.active.add(context);
    return context;
  }

  takeSpeech(samples: number): Int16Array {
    const out = new Int16Array(samples);
    for (let i = 0; i < samples; i += 1) {
      out[i] = this.source[this.cursor] as number;
      this.cursor = (this.cursor + 1) % this.source.length;
    }
    return out;
  }

  emitChunk(chunk: TtsChunk): void {
    this.chunks.emit(chunk);
  }

  release(context: WavScriptedContext): void {
    this.active.delete(context);
  }

  onChunk(listener: (chunk: TtsChunk) => void): Unsubscribe {
    return this.chunks.add(listener);
  }

  onStatus(listener: (status: ProviderStatusUpdate) => void): Unsubscribe {
    return this.statuses.add(listener);
  }

  async close(): Promise<void> {
    for (const context of [...this.active]) context.cancel();
  }
}

export class WavScriptedTtsProvider implements TtsProvider {
  readonly provider = 'scripted_tts_wav';
  readonly model_version = 'test_double';
  readonly provider_class = 'test_double' as const;
  private readonly options: Required<WavScriptedTtsOptions>;
  private source: Int16Array | null = null;
  private sourceRate = 0;

  constructor(options: WavScriptedTtsOptions) {
    this.options = { ms_per_char: 130, pause_ms: 450, chunk_interval_ms: 60, first_chunk_delay_ms: 150, ...options };
  }

  async open(config: TtsConnectionConfig): Promise<TtsConnection> {
    if (this.source === null || this.sourceRate !== config.preferred_sample_rate_hz) {
      this.sourceRate = config.preferred_sample_rate_hz;
      this.source = voicedOnly(loadWavAsPcm(this.options.wav_path, this.sourceRate), this.sourceRate);
    }
    return new WavScriptedTtsConnection(config, this.options, this.source);
  }
}

// ---- LLM -------------------------------------------------------------------------

export const DEFAULT_SCRIPTED_REPLY =
  'なるほど、それは大変ですね。朝の光を浴びると、体が目覚めやすくなると言われています。まずは、起きたらすぐにカーテンを開けてみてはどうでしょうか。';

export interface ScriptedReplyLlmOptions {
  time: TimeSource;
  emitter?: EventEmitter;
  reply?: string;
  chars_per_delta?: number;
  delta_delay_ms?: number;
  first_delta_delay_ms?: number;
}

function abortError(): Error {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

export class ScriptedReplyLlm implements LlmProvider {
  readonly provider = 'scripted_llm';
  readonly model_version = 'test_double';
  readonly provider_class = 'test_double' as const;
  private readonly options: Required<Omit<ScriptedReplyLlmOptions, 'emitter'>> & { emitter?: EventEmitter };

  constructor(options: ScriptedReplyLlmOptions) {
    this.options = {
      reply: DEFAULT_SCRIPTED_REPLY,
      chars_per_delta: 6,
      delta_delay_ms: 30,
      first_delta_delay_ms: 300,
      ...options,
    };
  }

  async generate(request: LlmRequest): Promise<LlmResult> {
    const stream = this.stream(request);
    for await (const _ of stream.deltas) {
      // 全部受け取る
    }
    return stream.result;
  }

  stream(request: LlmRequest): LlmStream {
    const { time, emitter, reply, chars_per_delta, delta_delay_ms, first_delta_delay_ms } = this.options;
    const sent_at = time.monotonicMs();
    emitter?.emit({
      event: 'llm.request',
      request_id: request.request_id,
      purpose: request.purpose,
      input: {
        system: request.system,
        messages: request.messages.map((m) => ({ role: m.role, text: m.text })),
        response_json_schema: request.response_json_schema,
      },
      transcript_revision: request.transcript_revision,
      sent_at,
      model_version: this.model_version,
    });
    let resolveResult!: (result: LlmResult) => void;
    let rejectResult!: (error: unknown) => void;
    const result = new Promise<LlmResult>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    result.catch(() => undefined);
    const model_version = this.model_version;
    const respond = (output: string | null, reason: string, first_text_at: number | null) =>
      emitter?.emit({
        event: 'llm.response',
        request_id: request.request_id,
        purpose: request.purpose,
        output: output === null ? modelOutputAbsent(reason) : modelOutput(output),
        transcript_revision: request.transcript_revision,
        sent_at,
        received_at: time.monotonicMs(),
        model_version,
        ...(first_text_at === null ? {} : { first_text_at }),
      });
    async function* deltas(): AsyncGenerator<string> {
      let first: number | null = null;
      try {
        await new Promise((r) => setTimeout(r, first_delta_delay_ms));
        for (let i = 0; i < reply.length; i += chars_per_delta) {
          if (request.signal?.aborted) throw abortError();
          if (i > 0 && delta_delay_ms > 0) await new Promise((r) => setTimeout(r, delta_delay_ms));
          if (request.signal?.aborted) throw abortError();
          first ??= time.monotonicMs();
          yield reply.slice(i, i + chars_per_delta);
        }
        respond(reply, '', first);
        resolveResult({
          request_id: request.request_id,
          purpose: request.purpose,
          text: reply,
          model_version,
          sent_at,
          received_at: time.monotonicMs(),
          ...(first === null ? {} : { first_text_at: first }),
          finish_reason: present('STOP'),
          usage: {
            input_tokens: absent('test_double_does_not_count'),
            output_tokens: absent('test_double_does_not_count'),
          },
        });
      } catch (error) {
        respond(null, 'aborted', first);
        rejectResult(error);
        throw error;
      }
    }
    return { deltas: deltas(), result };
  }
}
