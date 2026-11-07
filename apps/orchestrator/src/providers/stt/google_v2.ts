/**
 * Google Speech-to-Text v2 の SttProvider。既定は long、asia-northeast1（計画 §1.1 の実測）。
 *
 * 【ストリーム切替の規則】302 秒で ABORTED になる（実測）ので、計画 §8 のとおり重ねて切り替える。
 *  1. 古いストリーム A が 240 秒に達したら新しい B を開き、同じ音声を両方へ送る。B の結果は出さずに持つ。
 *  2. 切替点 H は無音に置く。音声の無音が silence_min_ms（既定 300ms）続いたら、そこを H とする。
 *     270 秒を過ぎたら 120ms の無音でよい。285 秒までに無音がなければ期限で H を決める。
 *  3. H で A だけを half-close する。A の final を待ち（drain）、これで A の未確定分を必ず final として閉じる。
 *     final が来なければ最後の interim を final に昇格する（文字を失わないため）。
 *  4. その後で B を出力元にする。B の結果は end ≤ H なら棄て、end > H なら A の末尾と重なる先頭を取り除く。
 *     B の final が1回通れば以後の差し引きは不要になる。
 *
 * 【revision の順序】出力元は常に1本で、revision は TranscriptAssembler が出した順に振る。
 *  B の最初の文字は A の final の後にしか出ないので、切替で本文が戻ることはない（新しい ASR 区間から始まる）。
 *  drain の間は出力が止まる。この停止時間が切替時の遅延で、handover 記録の first_b_emit_ms に残す。
 *
 * 【offset】ストリームごとに FrameMap を持ち、offset を audio_frame へ写す。B の offset は B の先頭から数える（実測）。
 *
 * 【切断】A の異常終了では未確定分を final に昇格し、重ねている B があれば即座に切り替える。
 *  なければ指数バックオフで開き直し、最後に結果が届いた位置から直近の音声を再送する。
 *  音声がしばらく来ていなければ、次の音声が来るまで開き直さない（送るものがないのに切断を繰り返すため）。
 */
import { absent, present, stabilityFromProvider } from '@llm-vap/contracts';
import type {
  EventEmitter,
  GoogleSttResponse,
  GoogleSttResult,
  GoogleSttStream,
  GoogleSttStreamError,
  GoogleSttTransport,
  Maybe,
  ProviderClass,
  ProviderHealth,
  ProviderStatusUpdate,
  SttPart,
  SttProvider,
  SttResult,
  SttSession,
  SttSessionConfig,
  TimedWord,
  TimeSource,
  TimingPrecision,
  Unsubscribe,
} from '@llm-vap/contracts';
import { TranscriptAssembler } from './assembler';
import { FrameMap } from './frame_map';
import { Listeners } from './listeners';
import { estimateOverlap, joinParts, normalizeTranscript, stripNormPrefix } from './transcript_text';
import type { OverlapMethod } from './transcript_text';

const SAMPLES_PER_MS = 16;
/** 40ms（provider_matrix §1 の #5）。 */
const BATCH_SAMPLES = 640;
/** 再送で一度に送る上限（15KB の上限に対して 400ms ＝ 12.8KB）。 */
const REPLAY_CHUNK_SAMPLES = 6400;
const TAIL_CHARS = 400;
const NO_OVERLAP_TOLERANCE_FRAMES = 200 * SAMPLES_PER_MS;
/** 無音で切り替えたとき、B の final はこの範囲で切替点の前に来る。 */
const NO_OVERLAP_TOLERANCE_SILENCE_FRAMES = 1000 * SAMPLES_PER_MS;
/** 認証や設定の誤りは開き直しても直らない。 */
const NON_RETRYABLE = new Set(['UNAUTHENTICATED', 'PERMISSION_DENIED', 'INVALID_ARGUMENT', 'NOT_FOUND']);
/** V2 の Standard（provider_matrix §2.5）。 */
const USD_PER_AUDIO_MINUTE = 0.016;

export interface GoogleSttOptions {
  /** 既定 240000。 */
  overlap_start_ms: number;
  /** 既定 285000。実測の打ち切りは 302 秒。 */
  handover_deadline_ms: number;
  /** この時間を過ぎたら短い無音でも切り替える。既定 270000。 */
  relax_silence_after_ms: number;
  silence_min_ms: number;
  silence_relaxed_ms: number;
  /** B へ音声を送ってからこの時間は切り替えない。既定 3000。 */
  min_overlap_ms: number;
  /** A の half-close 後に final を待つ上限。実測の final の遅れは最大 700ms。 */
  drain_grace_ms: number;
  /** 無音と見なす RMS の下限。 */
  silence_rms: number;
  /** 床の推定値の何倍までを無音と見なすか。 */
  silence_floor_ratio: number;
  /** policy.ja.json の initiative.min_stability。 */
  stability_threshold: number;
  /** policy.ja.json の initiative.stable_prefix_revisions と stable_prefix_min_age_ms。 */
  derived_revisions: number;
  derived_min_age_ms: number;
  retry_base_ms: number;
  retry_max_ms: number;
  /** この回数続けて失敗したら down と表示する。 */
  down_after_attempts: number;
  /** 切断の再送に使う音声の保持時間。 */
  replay_buffer_ms: number;
  /** cost.usage をこの音声量ごとに出す。 */
  cost_interval_audio_ms: number;
  close_grace_ms: number;
}

export const DEFAULT_GOOGLE_STT_OPTIONS: GoogleSttOptions = {
  overlap_start_ms: 240_000,
  handover_deadline_ms: 285_000,
  relax_silence_after_ms: 270_000,
  silence_min_ms: 300,
  silence_relaxed_ms: 120,
  min_overlap_ms: 3000,
  drain_grace_ms: 2000,
  silence_rms: 200,
  silence_floor_ratio: 2.5,
  stability_threshold: 0.8,
  derived_revisions: 3,
  derived_min_age_ms: 300,
  retry_base_ms: 200,
  retry_max_ms: 5000,
  down_after_attempts: 3,
  replay_buffer_ms: 15_000,
  cost_interval_audio_ms: 60_000,
  close_grace_ms: 2000,
};

export type HandoverCause = 'silence' | 'deadline' | 'active_failed';

/** 切替1回の記録。stt.handover として発行する。 */
export interface HandoverRecord {
  from_stream: string;
  to_stream: string;
  cause: HandoverCause;
  /** 切替点。これより前を A、後を B から採る。 */
  h_frame: number;
  /** A の経過時間。 */
  a_age_ms: number;
  overlap_ms: number;
  /** half-close から A が閉じるまで。 */
  drain_ms: number | null;
  /** final が来ず、interim を final に昇格したら true。 */
  a_final_synthesized: boolean;
  /** half-close から B の最初の出力まで。出力の止まった時間。 */
  first_b_emit_ms: number | null;
  stripped_chars: number | null;
  strip_method: OverlapMethod | null;
  /** B の offset と B へ送った音声量の差。offset の基準の確認用。 */
  b_first_lag_ms: number | null;
}

export interface GoogleSttDiagnostics {
  streams_opened: number;
  handovers: HandoverRecord[];
  reconnects: number;
  dropped_late_results: number;
  offset_anomalies: number;
  /** ブラウザからの音声が飛んだ量。 */
  input_gap_samples: number;
  input_duplicate_samples: number;
  /** 保持を超えて再送できなかった音声。 */
  replay_lost_samples: number;
  sent_audio_ms: number;
}

interface RawResult {
  kind: 'interim' | 'final';
  parts: SttPart[];
  end_frame: number;
  words: Maybe<TimedWord[]>;
  timing: TimingPrecision;
  /** この結果の属する未確定の発話が始まった位置（ストリームの直前の final、なければ先頭）。 */
  utterance_start_frame: number;
}

type RunRole = 'active' | 'shadow' | 'draining' | 'dead';

interface StreamRun {
  id: string;
  role: RunRole;
  stream: GoogleSttStream;
  map: FrameMap;
  openedAtMs: number;
  /** 最後の final の位置。この後が未確定の発話。 */
  lastFinalEnd: number | null;
  lastEnd: number | null;
  pending: RawResult | null;
  /** B が出力元になるまで持つ結果。 */
  held: RawResult[];
  unsubscribe: Unsubscribe[];
}

interface StripState {
  stream: string;
  h: number;
  tail: string;
  record: HandoverRecord;
  startedAt: number;
}

export interface GoogleSttProviderConfig {
  transport: GoogleSttTransport;
  time: TimeSource;
  emitter?: EventEmitter;
  model?: string;
  /** model_version の一部として記録する。 */
  location?: string;
  provider_class?: ProviderClass;
  options?: Partial<GoogleSttOptions>;
}

export class GoogleSttV2Session implements SttSession {
  private readonly results = new Listeners<SttResult>();
  private readonly statuses = new Listeners<ProviderStatusUpdate>();
  private readonly handovers = new Listeners<HandoverRecord>();
  private readonly options: GoogleSttOptions;
  private readonly assembler: TranscriptAssembler;

  private active: StreamRun | null = null;
  private shadow: StreamRun | null = null;
  private drainTimer: NodeJS.Timeout | null = null;
  private drainStartedAt = 0;
  private drainRecord: HandoverRecord | null = null;
  private drainWaiters: (() => void)[] = [];
  private strip: StripState | null = null;
  private unreported: HandoverRecord | null = null;
  private tail = '';

  private nextStreamNo = 0;
  private batch = new Int16Array(BATCH_SAMPLES);
  private batchLength = 0;
  private batchFrame = 0;
  private expectedFrame: number | null = null;
  private ring: { frame: number; pcm: Int16Array }[] = [];

  private silenceMs = 0;
  private noiseFloor: number | null = null;
  private overlapRequested = false;

  private retryAttempt = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private shadowRetryAttempt = 0;
  private shadowRetryTimer: NodeJS.Timeout | null = null;
  private shadowDisabled = false;
  private pushesSinceFailure = 0;
  private reopenOnAudio = false;
  private resumeFrame: number | null = null;
  private closed = false;
  private lastStatus: string | null = null;
  private costMsSinceReport = 0;

  private readonly diag: GoogleSttDiagnostics = {
    streams_opened: 0,
    handovers: [],
    reconnects: 0,
    dropped_late_results: 0,
    offset_anomalies: 0,
    input_gap_samples: 0,
    input_duplicate_samples: 0,
    replay_lost_samples: 0,
    sent_audio_ms: 0,
  };

  constructor(
    private readonly provider: GoogleSttV2Provider,
    config: SttSessionConfig,
    private readonly transport: GoogleSttTransport,
    private readonly time: TimeSource,
    private readonly emitter: EventEmitter | undefined,
    options: Partial<GoogleSttOptions>,
  ) {
    this.options = { ...DEFAULT_GOOGLE_STT_OPTIONS, ...options };
    this.assembler = new TranscriptAssembler({
      start_audio_frame: config.start_audio_frame,
      stability_threshold: this.options.stability_threshold,
      derived: { revisions: this.options.derived_revisions, min_age_ms: this.options.derived_min_age_ms },
      provider: provider.provider,
      model_version: provider.model_version,
      now: () => this.time.monotonicMs(),
    });
    this.expectedFrame = config.start_audio_frame;
    this.resumeFrame = config.start_audio_frame;
    this.active = this.openRun('active');
    if (this.active) this.setStatus('ok', 'stream_open', 0, absent('not_retrying'));
  }

  // ---- SttSession ------------------------------------------------------------

  pushAudio(audio_frame: number, mic: Int16Array): void {
    if (this.closed) return;
    let frame = audio_frame;
    let samples = mic;
    const expected = this.expectedFrame as number;
    if (frame < expected) {
      const overlap = Math.min(expected - frame, samples.length);
      this.diag.input_duplicate_samples += overlap;
      samples = samples.subarray(overlap);
      frame += overlap;
      if (samples.length === 0) return;
    } else if (frame > expected) {
      this.diag.input_gap_samples += frame - expected;
      this.flushBatch();
    }
    this.expectedFrame = frame + samples.length;
    this.pushesSinceFailure += 1;

    let offset = 0;
    while (offset < samples.length) {
      if (this.batchLength === 0) this.batchFrame = frame + offset;
      const take = Math.min(BATCH_SAMPLES - this.batchLength, samples.length - offset);
      this.batch.set(samples.subarray(offset, offset + take), this.batchLength);
      this.batchLength += take;
      offset += take;
      if (this.batchLength === BATCH_SAMPLES) this.flushBatch();
    }
    if (this.reopenOnAudio && !this.retryTimer) {
      this.reopenOnAudio = false;
      this.reconnect();
    }
  }

  advanceSegment(new_segment_id: number, at_audio_frame: number): void {
    this.assembler.advanceSegment(new_segment_id, at_audio_frame);
  }

  onResult(listener: (result: SttResult) => void): Unsubscribe {
    return this.results.add(listener);
  }

  onStatus(listener: (status: ProviderStatusUpdate) => void): Unsubscribe {
    return this.statuses.add(listener);
  }

  /** 切替1回ごとの記録。測定と研究者画面用で、SttSession の契約の外。 */
  onHandover(listener: (record: HandoverRecord) => void): Unsubscribe {
    return this.handovers.add(listener);
  }

  /**
   * 240 秒を待たずに重ね始める。次の無音で切り替わるので、AI の発話中など切替に都合のよい場面で呼べる。
   * 実 API の試験でも、短時間で無音の切替を起こすために使う。
   */
  startOverlapNow(): void {
    this.overlapRequested = true;
  }

  diagnostics(): GoogleSttDiagnostics {
    return { ...this.diag, handovers: [...this.diag.handovers] };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.flushBatch();
    this.clearTimers();
    if (this.shadow) {
      const shadow = this.shadow;
      this.shadow = null;
      this.kill(shadow);
      try {
        shadow.stream.end();
      } catch {
        // すでに閉じている。
      }
    }
    const active = this.active;
    if (active && active.role === 'active') {
      await new Promise<void>((resolve) => {
        this.drainWaiters.push(resolve);
        this.beginDrain(active, this.options.close_grace_ms);
      });
    } else if (active?.role === 'draining') {
      await new Promise<void>((resolve) => this.drainWaiters.push(resolve));
    }
    this.reportHandover();
    this.flushCost();
  }

  // ---- 送信 ------------------------------------------------------------------

  private flushBatch(): void {
    if (this.batchLength === 0) return;
    const pcm = this.batch.slice(0, this.batchLength);
    const frame = this.batchFrame;
    this.batchLength = 0;
    this.ring.push({ frame, pcm });
    const keep = (this.options.replay_buffer_ms * SAMPLES_PER_MS) / BATCH_SAMPLES;
    if (this.ring.length > keep) this.ring.splice(0, this.ring.length - keep);
    this.updateSilence(pcm);

    const first = this.active;
    if (first?.role === 'active') this.write(first, frame, pcm);
    // A への write が同期で失敗すると B が繰り上がる。write は送信済みの位置を見るので二重には送らない。
    if (this.shadow) this.write(this.shadow, frame, pcm);
    else if (this.active && this.active !== first) this.write(this.active, frame, pcm);
    this.checkHandover();
  }

  private write(run: StreamRun, frame: number, pcm: Int16Array): void {
    if (run.role === 'dead') return;
    const end = run.map.endFrame;
    if (end !== null && end >= frame + pcm.length) return;
    run.map.record(frame, pcm.length);
    const ms = pcm.length / SAMPLES_PER_MS;
    this.diag.sent_audio_ms += ms;
    this.costMsSinceReport += ms;
    if (this.costMsSinceReport >= this.options.cost_interval_audio_ms) this.flushCost();
    try {
      run.stream.write(pcm);
    } catch (error) {
      this.onFailure(run, { code: 'WRITE_FAILED', message: String(error) });
    }
  }

  private updateSilence(pcm: Int16Array): void {
    let sum = 0;
    for (const sample of pcm) sum += sample * sample;
    const rms = Math.sqrt(sum / pcm.length);
    // 床は最小値を追い、ゆっくり戻す（機材ごとの雑音の違いの吸収）。
    // 話し続けると床が声の大きさまで上がるので、無音と見なす上限を silence_rms の 4 倍で抑える。
    this.noiseFloor = this.noiseFloor === null ? rms : Math.min(rms, this.noiseFloor * 1.0005 + 0.01);
    const limit = Math.min(
      this.options.silence_rms * 4,
      Math.max(this.options.silence_rms, this.noiseFloor * this.options.silence_floor_ratio),
    );
    if (rms < limit) this.silenceMs += pcm.length / SAMPLES_PER_MS;
    else this.silenceMs = 0;
  }

  private ageMs(run: StreamRun): number {
    return Math.max(run.map.sentMs, this.time.monotonicMs() - run.openedAtMs);
  }

  private checkHandover(): void {
    const active = this.active;
    if (!active || active.role !== 'active' || this.closed) return;
    const age = this.ageMs(active);
    if (!this.shadow) {
      if ((age >= this.options.overlap_start_ms || this.overlapRequested) && !this.shadowRetryTimer && !this.shadowDisabled) {
        this.overlapRequested = false;
        this.openShadow();
      }
      return;
    }
    const silenceNeeded = age < this.options.relax_silence_after_ms ? this.options.silence_min_ms : this.options.silence_relaxed_ms;
    const overlapMs = this.shadow.map.sentMs;
    if (overlapMs >= this.options.min_overlap_ms && this.silenceMs >= silenceNeeded) {
      this.beginHandover(active, this.shadow, 'silence');
    } else if (age >= this.options.handover_deadline_ms) {
      this.beginHandover(active, this.shadow, 'deadline');
    }
  }

  // ---- ストリームの開閉 -------------------------------------------------------

  private openRun(role: RunRole): StreamRun | null {
    const id = `gstt_${++this.nextStreamNo}`;
    let stream: GoogleSttStream;
    try {
      stream = this.transport.openStream({
        model: this.provider.model,
        language_code: 'ja-JP',
        sample_rate_hz: 16000,
      });
    } catch (error) {
      this.handleOpenFailure(role, { code: 'OPEN_FAILED', message: String(error) });
      return null;
    }
    this.diag.streams_opened += 1;
    const run: StreamRun = {
      id,
      role,
      stream,
      map: new FrameMap(),
      openedAtMs: this.time.monotonicMs(),
      lastFinalEnd: null,
      lastEnd: null,
      pending: null,
      held: [],
      unsubscribe: [],
    };
    run.unsubscribe.push(
      stream.onResponse((response) => this.onResponse(run, response)),
      stream.onError((error) => this.onFailure(run, error)),
      stream.onEnd(() => this.onEnd(run)),
    );
    return run;
  }

  private handleOpenFailure(role: RunRole, error: GoogleSttStreamError): void {
    if (role === 'shadow') this.scheduleShadowRetry(error);
    else this.scheduleReconnect(error);
  }

  private openShadow(): void {
    const shadow = this.openRun('shadow');
    if (!shadow) return;
    this.shadow = shadow;
    this.shadowRetryAttempt = 0;
  }

  private kill(run: StreamRun): void {
    run.role = 'dead';
    this.diag.offset_anomalies += run.map.anomalies;
    for (const off of run.unsubscribe) off();
    run.unsubscribe = [];
  }

  // ---- 切替 ------------------------------------------------------------------

  private beginHandover(a: StreamRun, b: StreamRun, cause: HandoverCause): void {
    this.reportHandover();
    this.drainRecord = this.newRecord(a, b, cause, a.map.endFrame ?? this.assembler.lastEndFrame);
    this.silenceMs = 0;
    this.beginDrain(a, this.options.drain_grace_ms);
  }

  private newRecord(a: StreamRun, b: StreamRun, cause: HandoverCause, h: number): HandoverRecord {
    return {
      from_stream: a.id,
      to_stream: b.id,
      cause,
      h_frame: h,
      a_age_ms: Math.round(this.ageMs(a)),
      overlap_ms: Math.round(b.map.sentMs),
      drain_ms: null,
      a_final_synthesized: false,
      first_b_emit_ms: null,
      stripped_chars: null,
      strip_method: null,
      b_first_lag_ms: null,
    };
  }

  private beginDrain(run: StreamRun, graceMs: number): void {
    this.drainStartedAt = this.time.monotonicMs();
    run.role = 'draining';
    this.drainTimer = setTimeout(() => this.finishDrain(run), graceMs);
    try {
      run.stream.end();
    } catch (error) {
      this.onFailure(run, { code: 'END_FAILED', message: String(error) });
    }
  }

  private finishDrain(run: StreamRun): void {
    if (run.role !== 'draining') return;
    if (this.drainTimer) clearTimeout(this.drainTimer);
    this.drainTimer = null;
    const record = this.drainRecord;
    this.drainRecord = null;
    if (record) record.drain_ms = Math.round(this.time.monotonicMs() - this.drainStartedAt);
    const synthesized = this.promotePending(run);
    if (record) record.a_final_synthesized = synthesized;
    this.kill(run);
    this.active = null;

    const waiters = this.drainWaiters.splice(0);
    if (this.closed) {
      for (const resolve of waiters) resolve();
      return;
    }
    const b = this.shadow;
    if (b && record) {
      this.shadow = null;
      this.promoteShadow(b, record);
    } else {
      // B が先に死んだ。最後の位置から開き直す。
      this.resumeFrame = record?.h_frame ?? this.assembler.lastEndFrame;
      this.scheduleReconnect({ code: 'NO_SHADOW', message: 'shadow stream was not available at handover' });
    }
  }

  private promoteShadow(b: StreamRun, record: HandoverRecord): void {
    this.active = b;
    b.role = 'active';
    this.strip = { stream: b.id, h: record.h_frame, tail: this.tail, record, startedAt: this.drainStartedAt };
    this.diag.handovers.push(record);
    this.unreported = record;
    this.retryAttempt = 0;
    const held = b.held;
    b.held = [];
    for (const raw of held) this.forward(b, raw);
  }

  /** 未確定の本文を final として閉じる。文字を失わないため。 */
  private promotePending(run: StreamRun): boolean {
    const pending = run.pending;
    if (!pending || normalizeTranscript(joinParts(pending.parts)) === '') return false;
    run.pending = null;
    this.forward(run, {
      kind: 'final',
      parts: pending.parts,
      end_frame: pending.end_frame,
      words: absent('synthesized_from_interim'),
      timing: pending.timing,
      utterance_start_frame: pending.utterance_start_frame,
    });
    return true;
  }

  private reportHandover(): void {
    const record = this.unreported;
    if (!record) return;
    this.unreported = null;
    this.handovers.emit(record);
    this.emitter?.emit({
      event: 'stt.handover',
      provider: this.provider.provider,
      model_version: this.provider.model_version,
      from_stream: record.from_stream,
      to_stream: record.to_stream,
      cause: record.cause,
      h_frame: record.h_frame,
      a_age_ms: record.a_age_ms,
      overlap_ms: record.overlap_ms,
      drain_ms: orAbsent(record.drain_ms, 'stream_failed_without_drain'),
      a_final_synthesized: record.a_final_synthesized,
      first_b_emit_ms: orAbsent(record.first_b_emit_ms, 'no_output_from_new_stream_yet'),
      stripped_chars: orAbsent(record.stripped_chars, 'no_output_from_new_stream_yet'),
      strip_method: orAbsent(record.strip_method, 'no_output_from_new_stream_yet'),
      b_first_lag_ms: orAbsent(record.b_first_lag_ms, 'no_interim_from_new_stream_yet'),
    });
    // 測定値は stt.handover に残す。active_failed の degraded からの復帰を伝えるので、状態の通知は続ける。
    this.setStatus('ok', `handover ${record.from_stream}->${record.to_stream} cause=${record.cause}`, 0, absent('not_retrying'));
  }

  // ---- 受信 ------------------------------------------------------------------

  private onResponse(run: StreamRun, response: GoogleSttResponse): void {
    if (run.role === 'dead') {
      this.diag.dropped_late_results += response.results.length;
      return;
    }
    if (response.results.length === 0) return;
    if (run.role === 'active' && this.retryAttempt > 0) {
      this.retryAttempt = 0;
      this.setStatus('ok', 'reconnected', 0, absent('not_retrying'));
    }
    for (const raw of this.mapResponse(run, response)) {
      raw.utterance_start_frame = run.lastFinalEnd ?? run.map.baseFrame ?? 0;
      if (raw.kind === 'final') {
        run.lastFinalEnd = raw.end_frame;
        run.pending = null;
      } else {
        run.pending = raw;
      }
      run.lastEnd = raw.end_frame;
      if (run.role === 'shadow') this.hold(run, raw);
      else this.forward(run, raw);
    }
  }

  private hold(run: StreamRun, raw: RawResult): void {
    const last = run.held.at(-1);
    if (last?.kind === 'interim') run.held.pop();
    run.held.push(raw);
  }

  private mapResponse(run: StreamRun, response: GoogleSttResponse): RawResult[] {
    const out: RawResult[] = [];
    const interims: GoogleSttResult[] = [];
    for (const result of response.results) {
      if (result.is_final) {
        out.push({
          kind: 'final',
          parts: [{ text: result.transcript, stability: stabilityFromProvider(result.stability) }],
          end_frame: this.frameAt(run, result.result_end_offset_ms),
          words: this.mapWords(run, result),
          timing: timingOf(result.result_end_offset_ms),
          utterance_start_frame: 0,
        });
      } else if (result.transcript !== '') {
        interims.push(result);
      }
    }
    if (interims.length > 0) {
      const offset = Math.max(...interims.map((r) => r.result_end_offset_ms));
      out.push({
        kind: 'interim',
        parts: interims.map((r) => ({ text: r.transcript, stability: stabilityFromProvider(r.stability) })),
        end_frame: this.frameAt(run, offset),
        words: absent('interim_has_no_word_times'),
        timing: timingOf(offset),
        utterance_start_frame: 0,
      });
    }
    return out;
  }

  private frameAt(run: StreamRun, offsetMs: number): number {
    // offset がない応答は、受信時に送り終えていた位置で近似する。
    if (offsetMs <= 0) return run.map.endFrame ?? this.assembler.lastEndFrame;
    return run.map.frameAtOffsetMs(offsetMs) ?? this.assembler.lastEndFrame;
  }

  private mapWords(run: StreamRun, result: GoogleSttResult): Maybe<TimedWord[]> {
    if (!result.words || result.words.length === 0) return absent('provider_returned_no_word_times');
    let previousEnd = run.lastFinalEnd ?? run.map.baseFrame ?? 0;
    const words: TimedWord[] = [];
    for (const word of result.words) {
      if (word.end_offset_ms === undefined) return absent('provider_returned_incomplete_word_times');
      const end = this.frameAt(run, word.end_offset_ms);
      // 実測: 先頭の語は start_offset がない。
      const start = word.start_offset_ms === undefined ? previousEnd : this.frameAt(run, word.start_offset_ms);
      words.push({ text: word.word, audio_frame_start: start, audio_frame_end: end });
      previousEnd = end;
    }
    return present(words);
  }

  /** run を出力元として結果を assembler へ渡す。B の先頭の重複はここで取り除く。 */
  private forward(run: StreamRun, raw: RawResult): void {
    let parts = raw.parts;
    let words = raw.words;
    const strip = this.strip;
    // 役割では見ない: B が次の切替や close で drain に入っても、差し引きは最初の final まで続く。
    if (strip && strip.stream === run.id) {
      const stripped = this.applyStrip(run, raw, strip);
      if (stripped === null) return;
      parts = stripped;
      if (words.value !== null) {
        words = present(words.value.filter((w) => w.audio_frame_end > strip.h));
      }
    }
    if (raw.kind === 'final') {
      this.tail = (this.tail + normalizeTranscript(joinParts(parts))).slice(-TAIL_CHARS);
    }
    const outputs = this.assembler.accept({
      kind: raw.kind,
      parts,
      end_frame: raw.end_frame,
      words,
      timing: raw.timing,
      stream_id: run.id,
    });
    for (const result of outputs) this.deliver(result);
  }

  /** @returns 残す部分。全部が重複なら null。 */
  private applyStrip(run: StreamRun, raw: RawResult, strip: StripState): SttPart[] | null {
    const record = strip.record;
    if (record.b_first_lag_ms === null && raw.kind !== 'final') {
      // 送信量との差。B の offset が B の先頭から数えられていれば、通常の遅れと同じ大きさになる。
      const end = run.map.endFrame;
      if (end !== null) record.b_first_lag_ms = (end - raw.end_frame) / SAMPLES_PER_MS;
    }
    if (raw.end_frame <= strip.h) {
      this.diag.dropped_late_results += 1;
      return null;
    }
    const utteranceStart = raw.utterance_start_frame;
    const text = normalizeTranscript(joinParts(raw.parts));
    let chars = 0;
    let method: OverlapMethod = 'none';
    // 発話の始まりが H の直前より後なら重なりはない（B の final が切替点まで来ている）。
    const silent = record.cause === 'silence';
    // 許容を広げるのは B の final が切替点の手前にあるときだけ。B が聞き始めたばかりなら話の途中でありうる。
    const afterBFinal = utteranceStart !== run.map.baseFrame;
    const tolerance = silent && afterBFinal ? NO_OVERLAP_TOLERANCE_SILENCE_FRAMES : NO_OVERLAP_TOLERANCE_FRAMES;
    if (strip.h - utteranceStart > tolerance) {
      const expected = (text.length * (strip.h - utteranceStart)) / Math.max(1, raw.end_frame - utteranceStart);
      const estimate = estimateOverlap(strip.tail, text, expected, !silent);
      chars = estimate.chars;
      method = estimate.method;
    }
    record.stripped_chars = chars;
    record.strip_method = method;
    if (raw.kind === 'final') this.strip = null;
    // final が全部重複でも、出した interim があれば閉じる必要があるので空で通す。
    if (chars >= text.length) return raw.kind === 'final' ? [] : null;
    if (record.first_b_emit_ms === null) {
      record.first_b_emit_ms = Math.round(this.time.monotonicMs() - strip.startedAt);
      this.reportHandover();
    }
    return stripNormPrefix(raw.parts, chars);
  }

  private deliver(result: SttResult): void {
    const { received_at: _received, kind, ...fields } = result;
    this.emitter?.emit({ event: kind === 'final' ? 'stt.final' : 'stt.interim', ...fields });
    this.results.emit(result);
  }

  // ---- 障害 ------------------------------------------------------------------

  private onEnd(run: StreamRun): void {
    if (run.role === 'draining') {
      this.finishDrain(run);
      return;
    }
    if (run.role === 'dead') return;
    this.onFailure(run, { code: 'STREAM_ENDED', message: 'stream ended without an error' });
  }

  private onFailure(run: StreamRun, error: GoogleSttStreamError): void {
    if (run.role === 'dead') return;
    if (run.role === 'draining') {
      this.finishDrain(run);
      return;
    }
    if (run.role === 'shadow') {
      this.shadow = null;
      this.kill(run);
      this.scheduleShadowRetry(error);
      return;
    }
    // active の異常終了。
    const synthesized = this.promotePending(run);
    const b = this.shadow;
    if (b) {
      this.shadow = null;
      this.setStatus('degraded', describe(error), 1, present(0));
      const h = run.lastEnd ?? this.assembler.lastEndFrame;
      this.reportHandover();
      const record = this.newRecord(run, b, 'active_failed', h);
      record.drain_ms = 0;
      record.a_final_synthesized = synthesized;
      this.kill(run);
      this.active = null;
      this.drainStartedAt = this.time.monotonicMs();
      this.promoteShadow(b, record);
      return;
    }
    this.resumeFrame = run.lastEnd ?? run.map.baseFrame ?? this.assembler.lastEndFrame;
    this.kill(run);
    this.active = null;
    this.scheduleReconnect(error);
  }

  private backoff(attempt: number): number {
    return Math.min(this.options.retry_max_ms, this.options.retry_base_ms * 2 ** Math.max(0, attempt - 1));
  }

  private scheduleReconnect(error: GoogleSttStreamError): void {
    if (this.closed) return;
    if (NON_RETRYABLE.has(error.code)) {
      this.setStatus('down', describe(error), this.retryAttempt, absent('non_retryable_error'));
      return;
    }
    this.retryAttempt += 1;
    const delay = this.backoff(this.retryAttempt);
    const status: ProviderHealth = this.retryAttempt >= this.options.down_after_attempts ? 'down' : 'degraded';
    this.setStatus(status, describe(error), this.retryAttempt, present(delay));
    this.pushesSinceFailure = 0;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.pushesSinceFailure === 0) this.reopenOnAudio = true;
      else this.reconnect();
    }, delay);
  }

  private reconnect(): void {
    if (this.closed || this.active) return;
    const run = this.openRun('active');
    if (!run) return;
    this.active = run;
    this.strip = null;
    this.diag.reconnects += 1;
    this.replay(run);
  }

  /** 最後に結果が届いた位置から直近の音声を送り直す。 */
  private replay(run: StreamRun): void {
    const from = this.resumeFrame ?? this.ring[0]?.frame ?? 0;
    const first = this.ring[0]?.frame;
    if (first !== undefined && first > from) this.diag.replay_lost_samples += first - from;
    const pieces: { frame: number; pcm: Int16Array }[] = [];
    for (const entry of this.ring) {
      const end = entry.frame + entry.pcm.length;
      if (end <= from) continue;
      pieces.push(entry.frame >= from ? entry : { frame: from, pcm: entry.pcm.subarray(from - entry.frame) });
    }
    for (const piece of pieces) {
      for (let i = 0; i < piece.pcm.length; i += REPLAY_CHUNK_SAMPLES) {
        if (run.role === 'dead') return;
        this.write(run, piece.frame + i, piece.pcm.subarray(i, i + REPLAY_CHUNK_SAMPLES));
      }
    }
  }

  private scheduleShadowRetry(error: GoogleSttStreamError): void {
    if (this.closed) return;
    if (NON_RETRYABLE.has(error.code)) {
      // 開き直しても直らない。A が切れたら通常の再接続の経路で down と出る。
      this.shadowDisabled = true;
      this.setStatus('degraded', `shadow: ${describe(error)}`, this.shadowRetryAttempt, absent('non_retryable_error'));
      return;
    }
    this.shadowRetryAttempt += 1;
    const delay = this.backoff(this.shadowRetryAttempt);
    this.setStatus('degraded', `shadow: ${describe(error)}`, this.shadowRetryAttempt, present(delay));
    this.shadowRetryTimer = setTimeout(() => {
      this.shadowRetryTimer = null;
      if (this.closed || this.shadow || this.active?.role !== 'active') return;
      this.openShadow();
    }, delay);
  }

  private clearTimers(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.shadowRetryTimer) clearTimeout(this.shadowRetryTimer);
    this.retryTimer = null;
    this.shadowRetryTimer = null;
    this.reopenOnAudio = false;
  }

  private setStatus(
    status: ProviderHealth,
    reason: string,
    retry_attempt: number,
    next_retry_ms: Maybe<number>,
  ): void {
    const key = `${status}|${reason}|${retry_attempt}`;
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    const update: ProviderStatusUpdate = {
      provider: this.provider.provider,
      status,
      reason: present(reason),
      retry_attempt,
      next_retry_ms,
    };
    this.emitter?.emit({ event: 'provider.status', provider_class: this.provider.provider_class, ...update });
    this.statuses.emit(update);
  }

  private flushCost(): void {
    if (this.costMsSinceReport <= 0) return;
    const seconds = this.costMsSinceReport / 1000;
    this.costMsSinceReport = 0;
    this.emitter?.emit({
      event: 'cost.usage',
      provider: this.provider.provider,
      purpose: 'stt_stream',
      quantity: seconds,
      unit: 'audio_seconds',
      // 重ねている間は両方の送信量を数える（課金は要確認。provider_matrix §2.5）。
      estimated_cost_usd: present((seconds / 60) * USD_PER_AUDIO_MINUTE),
    });
  }
}

function orAbsent<T>(value: T | null, reason: string): Maybe<T> {
  return value === null ? absent(reason) : present(value);
}

function timingOf(offsetMs: number): TimingPrecision {
  return offsetMs > 0 ? 'result_end_offset' : 'arrival_minus_rtt';
}

function describe(error: GoogleSttStreamError): string {
  return `${error.code}: ${error.message}`.slice(0, 200);
}

export class GoogleSttV2Provider implements SttProvider {
  readonly provider = 'google_stt_v2';
  readonly model: string;
  readonly model_version: string;
  readonly provider_class: ProviderClass;

  constructor(private readonly config: GoogleSttProviderConfig) {
    this.model = config.model ?? 'long';
    this.model_version = `${this.model}@${config.location ?? 'asia-northeast1'}`;
    this.provider_class = config.provider_class ?? 'production';
  }

  async open(config: SttSessionConfig): Promise<GoogleSttV2Session> {
    return new GoogleSttV2Session(
      this,
      config,
      this.config.transport,
      this.config.time,
      this.config.emitter,
      this.config.options ?? {},
    );
  }
}
