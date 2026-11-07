/**
 * SpeechGenerator（計画 §4.3）。LLM→TTS→保持→ブラウザ の1本の発話音声を世代つきで管理する。
 * ResponsePrefetch と発話候補の両方が使う。準備や開始の判断はしない（E が決める）。
 *
 * 世代の扱い:
 *  - session_generation はセッションで単調増加し、stop のたびに増える（browser_rpc.ts の規則）。
 *  - 各音声は準備時の世代を TTS の文脈に結び、それ以外の世代の chunk を棄てる。
 *  - ブラウザは最後の stop より古い世代を棄てるので、再生の世代は start の時点の session_generation を使う。
 *    先に準備した音声を、別の音声の stop の後で再生しても棄てられない。
 *
 * 時刻の単位: playback.* の samples_* は 16kHz。TTS の PCM は別のレートでありうるので ms へ換算して比べる。
 */
import { SAMPLE_RATE_HZ, absent, present, ttsContextId } from '@llm-vap/contracts';
import type {
  EventDraft,
  EventEmitter,
  LlmProvider,
  PlaybackAlignmentSource,
  PlaybackEnded,
  PlaybackPosition,
  PlaybackReadingSource,
  PlaybackStarted,
  PlaybackStopMode,
  PrepareRequest,
  PreparedSpeech,
  SpeechGenerator,
  SpeechInterruptSource,
  SpeechStartRefusal,
  SpeechStartResult,
  SpeechStopOptions,
  SpokenTextPrecision,
  TimeSource,
  TtsChunk,
  TtsConnection,
  TtsContext,
  TtsContextLoss as ContractTtsContextLoss,
  Unsubscribe,
} from '@llm-vap/contracts';
import { AlignmentTimeline, proportionalText } from './alignment_timeline';
import type { ResponsePromptBuilder } from './response_prompt';
import { SpeechTextTrack, sharedReadingOptions, type ReadingTrackOptions } from './reading';

/** provider_matrix §6.6: 5 が上限だが、上限時の挙動が未確認なので 4 本に抑える。 */
const MAX_ACTIVE_CONTEXTS = 4;
/** PCM 枠の sample_count は u16。ブラウザのバッファを細かく扱えるように小さめに分ける。 */
const MAX_SAMPLES_PER_FRAME = 4800;
const SENTENCE_END = /[。！？!?\n]/;
const DEFAULT_FADE_MS = 30;
/**
 * ブラウザの報告を待つ上限【暫定】。方策に項目がないのでコードで持つ。接続中の時間だけで数える（session が呼ぶ）。
 *  - 開始: start から playback.started まで。下りの begin が届かなかった（送信の直後に切れた）場合に備える。
 *  - 停止: stop から playback.ended まで。停止の猶予（max_wait_ms）に足す。
 *  - 再接続後: 届いた分を流し切るまで（合成済みの長さ − 書き込み済み）に足す。
 */
export const REPORT_TIMEOUTS_MS = { start: 3000, stop: 2000, after_reattach: 3000 } as const;
const SAMPLES_PER_MS = SAMPLE_RATE_HZ / 1000;

/** ブラウザへの下り。J が PCM 枠と JSON に変換する。投げた例外はその音声の失敗として扱う。 */
export interface SpeechAudioSink {
  begin(message: { audio_playback_id: number; generation: number; sample_rate_hz: number }): void;
  pcm(frame: {
    audio_playback_id: number;
    generation: number;
    seq: number;
    sample_rate_hz: number;
    pcm: Int16Array;
    end_of_stream: boolean;
  }): void;
  alignment(message: {
    audio_playback_id: number;
    generation: number;
    items: WordItem[];
    /** 推定の語時刻のときだけ付く。ないときはプロバイダが返した時刻。 */
    source?: PlaybackAlignmentSource;
    /** items に reading があるときだけ付く。 */
    reading_source?: PlaybackReadingSource;
  }): void;
  stop(message: { audio_playback_id: number; generation: number; stop: PlaybackStopMode; reason: string }): void;
}

interface WordItem {
  text: string;
  start_ms: number;
  end_ms: number;
  granularity: 'word';
  /** 口形の読み（形態素解析の推定、カタカナ）。 */
  reading?: string;
}

export type SpeechState = 'preparing' | 'ready' | 'playing' | 'stopping' | 'finished' | 'cancelled' | 'failed';

export interface SpeechStateChange {
  audio_playback_id: number;
  state: SpeechState;
  reason: string | null;
  request: PrepareRequest;
  /** cancelled のときだけ。取消の時点で保持していて棄てた TTS の chunk（prefetch.cancelled の discarded_*）。 */
  discarded?: { chunks: number; samples: number };
}

/** 発話が終わった報告。J が commitAssistantSpoken へ渡す。発話済みの部分だけを持つ。 */
export interface SpeechFinished {
  audio_playback_id: number;
  origin: PrepareRequest['origin'];
  spoken_text: string;
  spoken_text_precision: SpokenTextPrecision;
  interrupted: boolean;
}

export type StartRefusal = SpeechStartRefusal;
export type StartResult = SpeechStartResult;
export type InterruptSource = SpeechInterruptSource;
export type StopOptions = SpeechStopOptions;
export type TtsContextLoss = ContractTtsContextLoss;

export interface SpeechGeneratorOptions {
  tts: TtsConnection;
  llm: LlmProvider;
  prompt: ResponsePromptBuilder;
  sink: SpeechAudioSink;
  time: TimeSource;
  emitter: EventEmitter;
  /** policy.speech.is_ready_buffer_ms */
  is_ready_buffer_ms: number;
  first_playback_id?: number;
  /**
   * 読み（口形の reading と TTS の文の変換）。省略時は起動時に読み込んだ共有の設定（reading/runtime.ts の initReading）。
   * initReading の前なら解析器なしで、従来どおり（TTS の文は元の文のまま、reading なし）。
   */
  reading?: ReadingTrackOptions;
}

interface PlannedStop {
  stop_point: 'word_boundary' | 'fade_at_limit' | 'immediate';
  decision_source: InterruptSource | null;
  planned_ms: number | null;
}

interface Entry {
  id: number;
  generation: number;
  request: PrepareRequest;
  state: SpeechState;
  context: TtsContext | null;
  contextOpen: boolean;
  abort: AbortController;
  held: TtsChunk[];
  heldSamples: number;
  sampleRate: number | null;
  synthComplete: boolean;
  nextChunkSeq: number;
  timeline: AlignmentTimeline;
  /** TtsChunk.estimated_alignment の時間軸。語時刻の送信にだけ使い、停止点と発話済みの計算には使わない。 */
  estimatedTimeline: AlignmentTimeline;
  /** TTS へ送った文。読みの変換が有効なら元の文（track.original）と違う。 */
  textSent: string;
  /** 元の文・TTS の文・alignment の文字の対応と、口形の読み。 */
  track: SpeechTextTrack;
  /** timeline の確定済みの語が覆う alignment の文字数（UTF-16）。語の位置を track へ渡す。 */
  alignmentWordChars: number;
  /**
   * 合成済みの音声に対応する文字数（chunk の alignment か estimated_alignment の chars の合計）。
   * TTS へ送った文の全部が合成済みとは限らない（Gemini は flush ごとに1要求で、次の文はまだ音声がない）。
   */
  synthesizedChars: number;
  /** 合成の途中で続きが来なくなった（文脈の喪失、TTS の down）。textSent の全部は合成されていない。 */
  synthLost: boolean;
  playGeneration: number | null;
  nextFrameSeq: number;
  pendingWords: WordItem[];
  pendingEstimatedWords: { text: string; start_ms: number; end_ms: number; granularity: 'word' }[];
  position: { written_ms: number; at_ms: number } | null;
  firstWrittenAt: number | null;
  startedAudioFrame: number | null;
  outputLatencyMs: number | null;
  plannedStop: PlannedStop | null;
  /** ブラウザの次の報告の期限（orchestrator 時刻）。過ぎたら session が終わりを代行する。null は期限なし。 */
  reportDeadline: number | null;
}

const TERMINAL: ReadonlySet<SpeechState> = new Set(['finished', 'cancelled', 'failed']);

export class SpeechGeneratorImpl implements SpeechGenerator {
  private readonly entries = new Map<number, Entry>();
  private readonly stateListeners = new Set<(change: SpeechStateChange) => void>();
  private readonly finishedListeners = new Set<(finished: SpeechFinished) => void>();
  private readonly unsubscribe: Unsubscribe[];
  private nextId: number;
  private sessionGeneration = 0;
  private counters = {
    stale_chunks_dropped: 0,
    stale_reports_dropped: 0,
    duplicate_chunks_dropped: 0,
    alignment_gaps: 0,
    ended_without_started: 0,
  };

  constructor(private readonly options: SpeechGeneratorOptions) {
    this.nextId = options.first_playback_id ?? 1;
    this.unsubscribe = [
      options.tts.onChunk((chunk) => this.handleChunk(chunk)),
      options.tts.onStatus((status) => {
        if (status.status === 'down') this.failIncomplete(`tts_down: ${status.reason.value ?? status.provider}`);
      }),
    ];
    // 切断で文脈を失った通知。
    const lost = options.tts.onContextLost?.((context) => {
      const entry = this.entries.get(context.audio_playback_id);
      if (entry && entry.generation === context.generation && !entry.synthComplete) {
        this.loseSynthesis(entry, `tts_context_lost: ${context.reason}`);
      }
    });
    if (lost) this.unsubscribe.push(lost);
  }

  get model_version(): string {
    return this.options.llm.model_version;
  }

  get generation(): number {
    return this.sessionGeneration;
  }

  stats(): Readonly<SpeechGeneratorImpl['counters']> {
    return { ...this.counters };
  }

  stateOf(audio_playback_id: number): SpeechState | null {
    return this.entries.get(audio_playback_id)?.state ?? null;
  }

  onStateChange(listener: (change: SpeechStateChange) => void): Unsubscribe {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  onFinished(listener: (finished: SpeechFinished) => void): Unsubscribe {
    this.finishedListeners.add(listener);
    return () => this.finishedListeners.delete(listener);
  }

  // ---- 準備 ----------------------------------------------------------------

  prepare(request: PrepareRequest): PreparedSpeech {
    this.evictForNewContext();
    const entry: Entry = {
      id: this.nextId++,
      generation: this.sessionGeneration,
      request,
      state: 'preparing',
      context: null,
      contextOpen: true,
      abort: new AbortController(),
      held: [],
      heldSamples: 0,
      sampleRate: null,
      synthComplete: false,
      nextChunkSeq: 0,
      timeline: new AlignmentTimeline(),
      estimatedTimeline: new AlignmentTimeline(),
      textSent: '',
      track: new SpeechTextTrack(this.options.reading ?? sharedReadingOptions()),
      alignmentWordChars: 0,
      synthesizedChars: 0,
      synthLost: false,
      playGeneration: null,
      nextFrameSeq: 0,
      pendingWords: [],
      pendingEstimatedWords: [],
      position: null,
      firstWrittenAt: null,
      startedAudioFrame: null,
      outputLatencyMs: null,
      plannedStop: null,
      reportDeadline: null,
    };
    this.entries.set(entry.id, entry);
    // 呼び出し側が ID を受け取ってから動かす（状態の通知の順序を保つ）。
    queueMicrotask(() => void this.runPipeline(entry));
    return { audio_playback_id: entry.id, generation: entry.generation };
  }

  private activeContexts(): number {
    let n = 0;
    for (const entry of this.entries.values()) if (entry.contextOpen) n += 1;
    return n;
  }

  /** 上限に達したら、未再生の古い準備を通常応答から順に取り消す。 */
  private evictForNewContext(): void {
    const limit = Math.min(MAX_ACTIVE_CONTEXTS, this.options.tts.max_contexts);
    while (this.activeContexts() >= limit) {
      const unstarted = [...this.entries.values()].filter(
        (entry) => entry.contextOpen && (entry.state === 'preparing' || entry.state === 'ready'),
      );
      const victim = unstarted.find((entry) => entry.request.origin.kind === 'response') ?? unstarted[0];
      if (!victim) return; // 再生中だけで埋まっている。openContext の例外で失敗として扱う。
      this.cancel(victim.id, 'context_limit');
    }
  }

  private async runPipeline(entry: Entry): Promise<void> {
    if (TERMINAL.has(entry.state)) return;
    try {
      entry.context = this.options.tts.openContext({
        audio_playback_id: entry.id,
        generation: entry.generation,
      });
      if (entry.request.origin.kind === 'candidate') {
        this.sendToTts(entry, entry.request.text);
      } else {
        await this.streamResponse(entry);
      }
      if (TERMINAL.has(entry.state) || entry.state === 'stopping') return;
      // 読みの変換で句読点までためていた残り。
      this.sendConverted(entry, entry.track.end());
      if (entry.textSent === '') {
        this.fail(entry, 'empty_text');
        return;
      }
      entry.context.flush();
      entry.context.endInput();
    } catch (error) {
      if (TERMINAL.has(entry.state) || entry.state === 'stopping') return;
      const reason = error instanceof Error ? error.message : String(error);
      if (entry.state === 'playing') {
        // 話している途中の失敗は、届いた分までで話し終える。途中で切った文を準備として残さない。
        this.closeInputQuietly(entry);
      } else {
        this.fail(entry, `pipeline_failed: ${reason}`.slice(0, 300));
      }
    }
  }

  private async streamResponse(entry: Entry): Promise<void> {
    const prompt = this.options.prompt(entry.request);
    const stream = this.options.llm.stream({
      request_id: `prefetch-p${entry.id}-g${entry.generation}`,
      purpose: 'prefetch',
      system: prompt.system,
      messages: prompt.messages,
      response_json_schema: null,
      transcript_revision: entry.request.transcript_revision,
      signal: entry.abort.signal,
    });
    for await (const delta of stream.deltas) {
      if (TERMINAL.has(entry.state) || entry.state === 'stopping') return;
      this.sendToTts(entry, delta);
    }
    await stream.result;
  }

  private sendToTts(entry: Entry, text: string): void {
    if (text === '' || !entry.context) return;
    // 変換が無効なら text のまま。有効なら句読点までためて、置き換えた文を返す。
    this.sendConverted(entry, entry.track.push(text));
    // 短文は flush がないと音声が始まらない（TtsContext.flush）。
    if (SENTENCE_END.test(text)) entry.context.flush();
    // 口形の読みの解析は送った後（1文 1ms 未満）。
    entry.track.analyzeSent();
  }

  private sendConverted(entry: Entry, ttsText: string): void {
    if (ttsText === '' || !entry.context) return;
    entry.context.sendText(ttsText);
    entry.textSent += ttsText;
  }

  private closeInputQuietly(entry: Entry): void {
    try {
      entry.context?.flush();
      entry.context?.endInput();
    } catch {
      // 接続が落ちている場合は tts の状態通知の側で扱われる。
    }
  }

  // ---- TTS からの受け取り ----------------------------------------------------

  private handleChunk(chunk: TtsChunk): void {
    const entry = this.entries.get(chunk.audio_playback_id);
    if (
      !entry ||
      TERMINAL.has(entry.state) ||
      entry.state === 'stopping' ||
      chunk.generation !== entry.generation ||
      chunk.context_id !== ttsContextId(entry.id, entry.generation)
    ) {
      this.counters.stale_chunks_dropped += 1;
      return;
    }
    if (chunk.seq < entry.nextChunkSeq) {
      this.counters.duplicate_chunks_dropped += 1;
      return;
    }
    entry.nextChunkSeq = chunk.seq + 1;
    if (entry.sampleRate !== null && chunk.pcm.length > 0 && chunk.sample_rate_hz !== entry.sampleRate) {
      this.fail(entry, `sample_rate_changed: ${entry.sampleRate} -> ${chunk.sample_rate_hz}`);
      return;
    }
    if (chunk.pcm.length > 0 || entry.sampleRate === null) entry.sampleRate = chunk.sample_rate_hz;

    if (chunk.alignment.value === null && chunk.pcm.length > 0) this.counters.alignment_gaps += 1;
    const chars = chunk.alignment.value?.chars ?? chunk.estimated_alignment?.chars;
    if (chars) entry.synthesizedChars += [...chars.join('')].length;
    const provided = chunk.alignment.value;
    // timeline が受け取る alignment（3つの配列の長さがそろう）だけを track へ渡し、文字の位置をそろえる。
    if (
      provided &&
      provided.chars.length === provided.char_start_ms.length &&
      provided.chars.length === provided.char_duration_ms.length
    ) {
      entry.track.addAlignment(provided.chars);
    }
    entry.timeline.addChunk({
      sample_rate_hz: chunk.sample_rate_hz,
      samples: chunk.pcm.length,
      alignment: chunk.alignment,
    });
    entry.pendingWords.push(...this.withReadings(entry, entry.timeline.confirm(chunk.is_last)));
    // プロバイダの時刻がある chunk では推定を使わない。音声の長さは時間軸を保つために足す。
    entry.estimatedTimeline.addChunk({
      sample_rate_hz: chunk.sample_rate_hz,
      samples: chunk.pcm.length,
      alignment:
        chunk.alignment.value === null && chunk.estimated_alignment
          ? present(chunk.estimated_alignment)
          : absent('no_estimate_for_this_chunk'),
    });
    entry.pendingEstimatedWords.push(
      ...entry.estimatedTimeline.confirm(chunk.is_last).map((word) => ({ ...word, granularity: 'word' as const })),
    );
    if (chunk.is_last) {
      entry.synthComplete = true;
      entry.contextOpen = false;
    }

    if (entry.state === 'playing') {
      this.forward(entry, chunk);
      return;
    }
    entry.held.push(chunk);
    entry.heldSamples += chunk.pcm.length;
    if (entry.synthComplete && entry.heldSamples === 0) {
      this.fail(entry, 'no_audio');
      return;
    }
    if (entry.state === 'preparing' && this.bufferReached(entry)) this.setState(entry, 'ready', null);
  }

  /** 確定した語に口形の読みを付ける。語は alignment の文字を先頭から隙間なく覆う（AlignmentTimeline.confirm）。 */
  private withReadings(entry: Entry, words: { text: string; start_ms: number; end_ms: number }[]): WordItem[] {
    return words.map((word) => {
      const a0 = entry.alignmentWordChars;
      entry.alignmentWordChars += word.text.length;
      const reading = entry.track.readingForAlignment(a0, entry.alignmentWordChars, word.text);
      return reading === null ? { ...word, granularity: 'word' as const } : { ...word, granularity: 'word' as const, reading };
    });
  }

  /** 定義: 最初の PCM が規定量バッファされた状態。規定量より短い発話は合成の完了で満たす。 */
  private bufferReached(entry: Entry): boolean {
    if (entry.sampleRate === null || entry.heldSamples === 0) return false;
    const heldMs = (entry.heldSamples / entry.sampleRate) * 1000;
    return heldMs >= this.options.is_ready_buffer_ms || entry.synthComplete;
  }

  isReady(audio_playback_id: number): boolean {
    const entry = this.entries.get(audio_playback_id);
    return entry?.state === 'ready';
  }

  // ---- 再生 ----------------------------------------------------------------

  start(audio_playback_id: number, expected?: { candidate_id: string; candidate_version: number }): boolean {
    return this.startChecked(audio_playback_id, expected).ok;
  }

  /**
   * start の理由つき版。候補の版と PCM が合わなければ、その PCM を破棄して拒否する（計画 §4.3）。
   * 音声は準備時の origin に結ばれているので、origin との照合が PCM との照合になる。
   */
  startChecked(
    audio_playback_id: number,
    expected?: { candidate_id: string; candidate_version: number },
  ): StartResult {
    const entry = this.entries.get(audio_playback_id);
    if (!entry) return { ok: false, reason: 'unknown_playback' };
    const origin = entry.request.origin;
    if (origin.kind === 'candidate' && !expected) return { ok: false, reason: 'expected_candidate_required' };
    if (
      expected &&
      (origin.kind !== 'candidate' ||
        origin.candidate_id !== expected.candidate_id ||
        origin.candidate_version !== expected.candidate_version)
    ) {
      if (entry.state === 'preparing' || entry.state === 'ready') this.cancel(entry.id, 'candidate_mismatch');
      return { ok: false, reason: 'candidate_mismatch' };
    }
    if (entry.state !== 'ready') return { ok: false, reason: 'not_ready' };
    for (const other of this.entries.values()) {
      if (other.state === 'playing' || other.state === 'stopping') {
        return { ok: false, reason: 'another_playback_active' };
      }
    }
    entry.playGeneration = this.sessionGeneration;
    entry.reportDeadline = this.options.time.monotonicMs() + REPORT_TIMEOUTS_MS.start;
    this.setState(entry, 'playing', null);
    try {
      this.options.sink.begin({
        audio_playback_id: entry.id,
        generation: entry.playGeneration,
        sample_rate_hz: entry.sampleRate as number,
      });
      const held = entry.held;
      entry.held = [];
      entry.heldSamples = 0;
      for (const chunk of held) this.sendFrames(entry, chunk);
      this.sendWords(entry);
    } catch (error) {
      this.fail(entry, `sink_failed: ${error instanceof Error ? error.message : String(error)}`);
      return { ok: false, reason: 'not_ready' };
    }
    return { ok: true, generation: entry.playGeneration };
  }

  private forward(entry: Entry, chunk: TtsChunk): void {
    try {
      this.sendFrames(entry, chunk);
      this.sendWords(entry);
    } catch (error) {
      this.fail(entry, `sink_failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private sendFrames(entry: Entry, chunk: TtsChunk): void {
    const generation = entry.playGeneration as number;
    if (chunk.pcm.length === 0) {
      if (chunk.is_last) {
        this.options.sink.pcm({
          audio_playback_id: entry.id,
          generation,
          seq: entry.nextFrameSeq++,
          sample_rate_hz: chunk.sample_rate_hz,
          pcm: new Int16Array(0),
          end_of_stream: true,
        });
      }
      return;
    }
    for (let at = 0; at < chunk.pcm.length; at += MAX_SAMPLES_PER_FRAME) {
      const end = Math.min(at + MAX_SAMPLES_PER_FRAME, chunk.pcm.length);
      this.options.sink.pcm({
        audio_playback_id: entry.id,
        generation,
        seq: entry.nextFrameSeq++,
        sample_rate_hz: chunk.sample_rate_hz,
        pcm: chunk.pcm.subarray(at, end),
        end_of_stream: chunk.is_last && end === chunk.pcm.length,
      });
    }
  }

  private sendWords(entry: Entry): void {
    const generation = entry.playGeneration as number;
    if (entry.pendingWords.length > 0) {
      const withReading = entry.pendingWords.some((word) => word.reading !== undefined);
      this.options.sink.alignment({
        audio_playback_id: entry.id,
        generation,
        items: entry.pendingWords,
        ...(withReading ? { reading_source: 'morphological_estimate' as const } : {}),
      });
      entry.pendingWords = [];
    }
    if (entry.pendingEstimatedWords.length > 0) {
      this.options.sink.alignment({
        audio_playback_id: entry.id,
        generation,
        items: entry.pendingEstimatedWords,
        source: 'estimated_time_proportional',
      });
      entry.pendingEstimatedWords = [];
    }
  }

  // ---- 取消と停止 ------------------------------------------------------------

  /**
   * 未再生の準備の取消（U-2）。再生中の音声は対象外で、何もせず false を返す。
   * LLM を中断し、TTS の文脈を閉じ、保持中の PCM を棄てる。この後に届く chunk は棄てられる。
   */
  cancel(audio_playback_id: number, reason: string): boolean {
    const entry = this.entries.get(audio_playback_id);
    if (!entry || (entry.state !== 'preparing' && entry.state !== 'ready')) return false;
    const discarded = { chunks: entry.held.length, samples: entry.heldSamples };
    this.teardown(entry, reason);
    this.setState(entry, 'cancelled', reason, discarded);
    this.entries.delete(entry.id);
    return true;
  }

  /**
   * 候補の REVISE／WITHDRAW に対応する未再生の PCM を破棄する（計画 §4.3、§4.6）。
   * keep_version を渡すと、その版だけ残す。
   */
  discardCandidate(candidate_id: string, reason: string, keep_version?: number): number {
    let discarded = 0;
    for (const entry of [...this.entries.values()]) {
      const origin = entry.request.origin;
      if (origin.kind === 'candidate' && origin.candidate_id === candidate_id && origin.candidate_version !== keep_version) {
        if (this.cancel(entry.id, reason)) discarded += 1;
      }
    }
    return discarded;
  }

  /**
   * 再生中の音声を止める。未再生なら cancel と同じ。
   * options なしは割り込み以外の停止（speech.ended になる）で即時に止める。
   * 語境界の待ち中に同じ要求が来ても命令を重ねない（U-8）。immediate への格上げだけ受ける。
   */
  stop(audio_playback_id: number, reason: string, options?: StopOptions): void {
    const entry = this.entries.get(audio_playback_id);
    if (!entry) return;
    if (entry.state === 'preparing' || entry.state === 'ready') {
      this.cancel(audio_playback_id, reason);
      return;
    }
    const immediate = !options || options.stop_point === 'immediate';
    if (entry.state === 'stopping' && !(immediate && entry.plannedStop?.stop_point !== 'immediate')) return;
    if (entry.state !== 'playing' && entry.state !== 'stopping') return;

    const fade_ms = options?.fade_ms ?? DEFAULT_FADE_MS;
    let stopMode: PlaybackStopMode;
    const decision_source = options?.decision_source ?? entry.plannedStop?.decision_source ?? null;
    if (immediate) {
      stopMode = { mode: 'immediate' };
      entry.plannedStop = { stop_point: 'immediate', decision_source, planned_ms: null };
    } else {
      const positionMs = this.estimatedPositionMs(entry);
      const limitMs = positionMs + options.max_wait_ms;
      const boundary = entry.timeline.nextBoundaryMs(positionMs);
      const useBoundary = boundary !== null && boundary <= limitMs;
      const stopMs = useBoundary ? boundary : limitMs;
      stopMode = {
        mode: 'at_sample',
        stop_at_sample: Math.round(stopMs * SAMPLES_PER_MS),
        fade_ms,
        deadline_ms: options.max_wait_ms,
      };
      entry.plannedStop = {
        stop_point: useBoundary ? 'word_boundary' : 'fade_at_limit',
        decision_source,
        planned_ms: stopMs,
      };
    }

    this.teardown(entry, reason);
    this.setState(entry, 'stopping', reason);
    entry.reportDeadline =
      this.options.time.monotonicMs() + (immediate ? 0 : options.max_wait_ms) + REPORT_TIMEOUTS_MS.stop;
    this.sessionGeneration += 1;
    this.options.sink.stop({
      audio_playback_id: entry.id,
      generation: this.sessionGeneration,
      stop: stopMode,
      reason,
    });
  }

  private estimatedPositionMs(entry: Entry): number {
    if (!entry.position) return 0;
    return entry.position.written_ms + Math.max(0, this.options.time.monotonicMs() - entry.position.at_ms);
  }

  /** LLM→TTS の連鎖を止めて保持中の PCM を棄てる。 */
  private teardown(entry: Entry, reason: string): void {
    entry.abort.abort();
    if (entry.contextOpen && entry.context) {
      try {
        entry.context.cancel(reason);
      } catch {
        // 接続が落ちていれば文脈も残っていない。
      }
    }
    entry.contextOpen = false;
    entry.held = [];
    entry.heldSamples = 0;
  }

  private fail(entry: Entry, reason: string): void {
    this.teardown(entry, reason);
    this.setState(entry, 'failed', reason);
    if (entry.firstWrittenAt === null) this.entries.delete(entry.id);
  }

  /** TTS が落ちたとき、合成が終わっていない音声を失敗にする。作り直しは E の次の prepare で行う。 */
  private failIncomplete(reason: string): void {
    for (const entry of [...this.entries.values()]) {
      if (!entry.synthComplete) this.loseSynthesis(entry, reason);
    }
  }

  /**
   * 合成の続きが来なくなった。未再生は失敗にする。再生中は届いた分で話し終えるよう、
   * 入力を止めて end_of_stream を送る（送らないとブラウザが終わりを知れない）。
   */
  private loseSynthesis(entry: Entry, reason: string): void {
    if (entry.state === 'preparing' || entry.state === 'ready') {
      this.fail(entry, reason);
    } else if (entry.state === 'playing') {
      entry.abort.abort();
      entry.contextOpen = false;
      entry.synthComplete = true;
      entry.synthLost = true;
      entry.pendingWords.push(...this.withReadings(entry, entry.timeline.confirm(true)));
      entry.pendingEstimatedWords.push(
        ...entry.estimatedTimeline.confirm(true).map((word) => ({ ...word, granularity: 'word' as const })),
      );
      this.forward(entry, {
        context_id: ttsContextId(entry.id, entry.generation),
        audio_playback_id: entry.id,
        generation: entry.generation,
        seq: entry.nextChunkSeq,
        sample_rate_hz: entry.sampleRate as number,
        pcm: new Int16Array(0),
        alignment: absent(reason),
        is_last: true,
      });
    }
  }

  private setState(
    entry: Entry,
    state: SpeechState,
    reason: string | null,
    discarded?: SpeechStateChange['discarded'],
  ): void {
    entry.state = state;
    const change: SpeechStateChange = {
      audio_playback_id: entry.id,
      state,
      reason,
      request: entry.request,
      ...(discarded === undefined ? {} : { discarded }),
    };
    for (const listener of this.stateListeners) listener(change);
  }

  // ---- ブラウザの報告（J が時刻を補正して渡す） --------------------------------

  private acceptReport(message: { audio_playback_id: number; generation: number }): Entry | null {
    const entry = this.entries.get(message.audio_playback_id);
    if (!entry || entry.playGeneration === null || message.generation < entry.playGeneration) {
      this.counters.stale_reports_dropped += 1;
      return null;
    }
    return entry;
  }

  /** t_ms は client_t_ms を orchestrator の時刻へ補正した値。 */
  handlePlaybackStarted(message: PlaybackStarted, t_ms: number): void {
    const entry = this.acceptReport(message);
    if (!entry || entry.firstWrittenAt !== null) return;
    entry.firstWrittenAt = t_ms;
    entry.startedAudioFrame = message.audio_frame;
    // 再生が始まった。止めるまでは期限を置かない（長い発話でも代行しない）。
    if (entry.state === 'playing') entry.reportDeadline = null;
    entry.outputLatencyMs = message.output_latency_ms.value;
    entry.position = { written_ms: 0, at_ms: t_ms };
    this.options.emitter.emit({
      event: 'speech.started',
      ...this.speechFields(entry, message.audio_frame, t_ms, message.output_latency_ms.value),
    } as EventDraft);
  }

  handlePlaybackPosition(message: PlaybackPosition, t_ms: number): void {
    const entry = this.acceptReport(message);
    if (!entry) return;
    entry.position = { written_ms: message.samples_written / SAMPLES_PER_MS, at_ms: t_ms };
    if (message.output_latency_ms.value !== null) entry.outputLatencyMs = message.output_latency_ms.value;
  }

  handlePlaybackEnded(message: PlaybackEnded, t_ms: number): void {
    const entry = this.acceptReport(message);
    if (!entry) return;
    if (message.output_latency_ms.value !== null) entry.outputLatencyMs = message.output_latency_ms.value;
    const completed = message.reason === 'completed';
    const { text, precision } = this.spokenText(entry, message.samples_written, completed);
    const planned = entry.plannedStop;
    const interrupted = !completed && planned?.decision_source != null;

    if (entry.firstWrittenAt === null) {
      if (message.samples_written > 0) this.counters.ended_without_started += 1;
    } else {
      const base = {
        ...this.speechFields(entry, entry.startedAudioFrame as number, entry.firstWrittenAt, entry.outputLatencyMs),
        audio_frame: message.audio_frame,
        spoken_text: text,
        spoken_text_precision: precision,
        samples_written: message.samples_written,
        ...(entry.track.transforms && entry.textSent !== entry.track.original ? { tts_text: entry.textSent } : {}),
      };
      if (interrupted && planned) {
        this.options.emitter.emit({
          event: 'speech.interrupted',
          ...base,
          interrupted_at: t_ms,
          stop_point: this.actualStopPoint(planned, message.samples_written),
          decision_source: planned.decision_source as InterruptSource,
        } as EventDraft);
      } else {
        this.options.emitter.emit({ event: 'speech.ended', ...base, ended_at: t_ms } as EventDraft);
      }
    }

    if (!entry.synthComplete) this.teardown(entry, 'playback_ended');
    this.setState(entry, 'finished', message.reason);
    this.entries.delete(entry.id);
    const finished: SpeechFinished = {
      audio_playback_id: entry.id,
      origin: entry.request.origin,
      spoken_text: text,
      spoken_text_precision: precision,
      interrupted,
    };
    for (const listener of this.finishedListeners) listener(finished);
  }

  /** 語境界の位置まで届かずに止まったなら、上限での停止として記録する。 */
  private actualStopPoint(planned: PlannedStop, samples_written: number): PlannedStop['stop_point'] {
    if (planned.stop_point !== 'word_boundary' || planned.planned_ms === null) return planned.stop_point;
    return samples_written / SAMPLES_PER_MS < planned.planned_ms - 5 ? 'fade_at_limit' : 'word_boundary';
  }

  private speechFields(entry: Entry, audio_frame: number, writtenAt: number, latency: number | null) {
    const origin = entry.request.origin;
    return {
      audio_playback_id: entry.id,
      audio_frame,
      started_at: writtenAt + (latency ?? 0),
      first_pcm_written_at: writtenAt,
      output_latency_ms: latency === null ? absent('browser_did_not_report_output_latency') : present(latency),
      ...(origin.kind === 'candidate'
        ? { origin: 'candidate', candidate_id: origin.candidate_id, candidate_version: origin.candidate_version }
        : { origin: 'response' }),
    };
  }

  /**
   * 発話済みテキスト。書き込み済みの位置から出力遅延を引いた時刻までで、語の途中なら直前の語境界まで（計画 §3.2）。
   * alignment が欠けていれば比例配分にして、精度の区分で明示する。
   */
  private spokenText(
    entry: Entry,
    samples_written: number,
    completed: boolean,
  ): { text: string; precision: SpokenTextPrecision } {
    const heardMs = Math.max(0, samples_written / SAMPLES_PER_MS - (entry.outputLatencyMs ?? 0));
    const track = entry.track;
    if (entry.timeline.alignment_complete) {
      const aligned = completed ? entry.timeline.fullText() : entry.timeline.textUntil(heardMs);
      return {
        // 読みの変換では alignment の文字は TTS の文なので、元の文へ戻す（置き換えた語の途中なら、その語の前まで）。
        text: track.transforms ? track.originalForAlignmentPrefix(aligned.length) : aligned,
        precision: 'alignment_char',
      };
    }
    // 比例配分は合成済みの音声に対応する文に限る。最後まで再生した（completed）ときも、合成済みの範囲が上限。
    const synthesized = this.synthesizedText(entry);
    const heard = completed ? synthesized : proportionalText(synthesized, heardMs, entry.timeline.duration_ms);
    return {
      text: track.transforms ? track.originalForTtsPrefix(heard.length) : heard,
      precision: 'time_proportional',
    };
  }

  /**
   * 合成済みの音声に対応する文。合成が正常に終わっていれば送った全文。
   * 途中なら chunk の chars の数だけ先頭から取る。chars のない音声 chunk があると、その分は数えられないので
   * 少なめになる（話していない内容を履歴へ入れない側に倒す）。
   */
  private synthesizedText(entry: Entry): string {
    if (entry.synthComplete && !entry.synthLost) return entry.textSent;
    return [...entry.textSent].slice(0, entry.synthesizedChars).join('');
  }

  // ---- ブラウザの報告が来ないとき（J が呼ぶ） ------------------------------------

  /** 再生中または停止中の音声。start の可否の判断（TurnInputs.start_blocked_reason）に使う。 */
  activePlayback(): number | null {
    for (const entry of this.entries.values()) {
      if (entry.state === 'playing' || entry.state === 'stopping') return entry.id;
    }
    return null;
  }

  /**
   * 再接続した。切断の間に止まった期限を数え直す。ブラウザは受け取った PCM を流し切ってから
   * playback.ended を送るので、合成済みの長さから書き込み済みを引いた分を待つ。
   */
  rearmReportDeadlines(): void {
    const now = this.options.time.monotonicMs();
    for (const entry of this.entries.values()) {
      if (entry.state !== 'playing' && entry.state !== 'stopping') continue;
      const remaining = Math.max(0, entry.timeline.duration_ms - (entry.position?.written_ms ?? 0));
      entry.reportDeadline = now + remaining + REPORT_TIMEOUTS_MS.after_reattach;
    }
  }

  /** 期限を過ぎても報告のない音声の終わりを代行する。代行した ID を返す。 */
  expireOverdueReports(audio_frame: number): number[] {
    const now = this.options.time.monotonicMs();
    const overdue = [...this.entries.values()].filter(
      (entry) =>
        (entry.state === 'playing' || entry.state === 'stopping') && entry.reportDeadline !== null && entry.reportDeadline <= now,
    );
    for (const entry of overdue) this.endOnBehalf(entry, 'browser_report_timeout', audio_frame, now);
    return overdue.map((entry) => entry.id);
  }

  /**
   * ブラウザが報告できなくなった（セッションを閉じる、再接続の猶予が切れた）。再生中と停止中の音声を、
   * 最後に報告された書き込み位置で終わったものとして扱う（発話済みの部分だけが履歴に入る）。代行した ID を返す。
   */
  endActiveOnBehalf(reason: string, audio_frame: number): number[] {
    const now = this.options.time.monotonicMs();
    const active = [...this.entries.values()].filter((entry) => entry.state === 'playing' || entry.state === 'stopping');
    for (const entry of active) this.endOnBehalf(entry, reason, audio_frame, now);
    return active.map((entry) => entry.id);
  }

  private endOnBehalf(entry: Entry, reason: string, audio_frame: number, now: number): void {
    this.handlePlaybackEnded(
      {
        type: 'playback.ended',
        audio_playback_id: entry.id,
        generation: this.sessionGeneration,
        reason: 'error',
        samples_written: Math.round((entry.position?.written_ms ?? 0) * SAMPLES_PER_MS),
        samples_discarded: 0,
        audio_frame,
        client_t_ms: 0,
        output_latency_ms: absent(reason),
      },
      now,
    );
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribe) unsubscribe();
    for (const entry of [...this.entries.values()]) {
      if (!TERMINAL.has(entry.state)) this.teardown(entry, 'dispose');
    }
    this.entries.clear();
  }
}
