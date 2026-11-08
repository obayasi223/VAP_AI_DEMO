/**
 * セッション別の JSONL 書き込み（計画 §3.4、§3.5）。contracts の EventSink の本体。
 *
 * <dir>/<session_id>/
 *   events.jsonl      スキーマに合格したイベントだけ（1 行 1 イベント）
 *   quarantine.jsonl  不合格のもの。捨てずに理由と元の値を残す
 *   manifest.json     開始と終了の記録。closed が false のままなら正常に終わっていない
 *
 * 音声の経路を止めないために:
 *  - write() は同期で、検証と直列化のあとキューへ積むだけ。入出力は裏で進める。ここから例外は出さない。
 *  - キューには上限があり、超えた分は捨てて種類ごとに数える（溜め続けてメモリを使い切らない）。
 * 失敗を隠さないために:
 *  - 書き込みの失敗は reporter と onProblem へ出し、stats に残し、manifest と close の結果に載せる。
 *  - 失敗したら同じ位置から再試行する（行が欠けたり重複したりしない）。
 *  - 既存のセッションのログを上書きしない（排他で作成する）。
 */
import { mkdir, open, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  absent,
  createEventEmitter,
  EVENT_SCHEMA_VERSION,
  present,
  ResearchEvent,
  SystemTimeSource,
  type Condition,
  type EventDraft,
  type EventEmitter,
  type EventSink,
  type InvalidEventError,
  type ProviderClass,
  type TimeSource,
} from '@llm-vap/contracts';

export const DEFAULT_SESSIONS_DIR = 'sessions';
export const EVENTS_FILE = 'events.jsonl';
export const QUARANTINE_FILE = 'quarantine.jsonl';
export const MANIFEST_FILE = 'manifest.json';

/** manifest のプロバイダの行。unavailable は開けなかったもの（理由つき）。 */
export interface ManifestProvider {
  provider: string;
  provider_class: ProviderClass | 'unavailable';
  reason: string | null;
}

/** manifest に載せるセッションの条件（J が渡す）。log_check はこれを必ず見る。 */
export interface SessionManifestDetails {
  condition: Condition;
  policy_id: string;
  /** 使ったアバター（画面の avatar.report）。未報告は null。 */
  avatar?: Record<string, unknown> | null;
  providers: Record<string, ManifestProvider>;
  /** 音声合成の設定（モデル、voice_settings、seed）。設定を持たないプロバイダは null。 */
  tts_settings?: Record<string, unknown> | null;
  /** 発話希望の判定（G）の状態。止めた・作れなかったときは理由。 */
  initiative?: {
    running: boolean;
    reason: string | null;
    prompt_version: string | null;
    model: string | null;
    persona_id: string | null;
    persona_version: number | null;
    candidates_used_for: string;
    /** 申し出るタイミングの方式（適用したもの）。判定が動いていなければ null。 */
    timing_strategy?: string | null;
    /** 会話の種類（適用したもの）。v2 と未適用は null。 */
    conversation_kind?: string | null;
    /** 二段判定の版。v2 と未適用は null。 */
    desire_prompt_version?: string | null;
    timing_prompt_version?: string | null;
    profile_version?: number | null;
    /** 選択の由来（client、default、fixed）。 */
    conversation_kind_source?: string | null;
    timing_strategy_source?: string | null;
  };
}
/** session.log の状態を provider.status に出すときの名前。 */
export const SESSION_LOG_PROVIDER = 'session_log';

// ---- ファイル操作（試験で失敗と詰まりを注入する） ----------------------------

export interface LogFile {
  /** 書けたバイト数を返す。 */
  write(data: Uint8Array): Promise<number>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface LogFileSystem {
  mkdirp(path: string): Promise<void>;
  /** 既にあれば失敗する。 */
  createExclusive(path: string): Promise<LogFile>;
  writeAtomic(path: string, text: string): Promise<void>;
}

export const nodeLogFileSystem: LogFileSystem = {
  async mkdirp(path) {
    await mkdir(path, { recursive: true });
  },
  async createExclusive(path) {
    const handle = await open(path, 'wx');
    return {
      async write(data) {
        const { bytesWritten } = await handle.write(data);
        return bytesWritten;
      },
      sync: () => handle.sync(),
      close: () => handle.close(),
    };
  },
  async writeAtomic(path, text) {
    const temporary = `${path}.tmp`;
    await writeFile(temporary, text);
    await rename(temporary, path);
  },
};

// ---- 公開の型 --------------------------------------------------------------

export type LogProblem =
  | { kind: 'write_failed'; file: string; message: string }
  | { kind: 'write_recovered'; file: string }
  | { kind: 'queue_overflow'; file: string; message: string }
  | { kind: 'invalid_event'; reason: QuarantineReason; event_name: string };

export type QuarantineReason = 'schema_invalid' | 'session_mismatch' | 'draft_invalid';

export interface LogStats {
  /** write() に渡された件数。 */
  received: number;
  /** キューへ積んだ合格イベントの件数。 */
  accepted: number;
  /** ファイルへ書き終えた合格イベントの件数。 */
  written: number;
  /** 不合格で隔離した件数。 */
  quarantined: number;
  quarantined_by_reason: Partial<Record<QuarantineReason, number>>;
  quarantine_written: number;
  /** キューの上限で捨てた件数。隔離の記録を捨てたものも含む。 */
  dropped_overflow: number;
  dropped_by_event: Record<string, number>;
  first_dropped_wall_clock: string | null;
  last_dropped_wall_clock: string | null;
  /** close のあとに届いた件数。ファイルには入らない。 */
  after_close: number;
  write_errors: number;
  last_write_error: string | null;
  /** 今も書き込みに失敗している。 */
  failing: boolean;
  queue_bytes: number;
  queue_peak_bytes: number;
}

export interface FlushResult {
  ok: boolean;
  /** まだファイルへ書けていない行数。 */
  pending_lines: number;
  error: string | null;
}

export interface CloseReport extends FlushResult {
  /** 書けなかった、または捨てた合格イベントの件数。0 でなければ証拠に穴がある。 */
  lost_events: number;
  manifest_written: boolean;
  stats: LogStats;
  paths: SessionLogPaths;
}

export interface SessionLogPaths {
  dir: string;
  events: string;
  quarantine: string;
  manifest: string;
}

export interface SessionLogOptions {
  /** ログの親ディレクトリ。既定 sessions（.gitignore 済み）。 */
  dir?: string;
  session_id: string;
  /** 時刻源は contracts のもの。隔離の記録と manifest の時刻に使う。 */
  time?: TimeSource;
  fs?: LogFileSystem;
  /** キューの上限。合格イベントと隔離で別々に持つ。既定 64MB。 */
  maxQueueBytes?: number;
  maxBatchBytes?: number;
  /** 書き込みに失敗してからの再試行の間隔。既定 500ms。 */
  retryMs?: number;
  /** flush の既定の上限。既定 5 秒。 */
  flushTimeoutMs?: number;
  /** close の上限。この間は再試行を続ける。既定 5 秒。 */
  closeTimeoutMs?: number;
  onProblem?: (problem: LogProblem) => void;
  /** 既定は console.error。失敗を黙らせる設定は用意していない。 */
  reporter?: (message: string) => void;
}

export class InvalidSessionIdError extends Error {
  constructor(session_id: string) {
    super(`session_id cannot be used as a directory name: ${JSON.stringify(session_id)}`);
    this.name = 'InvalidSessionIdError';
  }
}

const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

// ---- キューつきの追記 ------------------------------------------------------

interface AppenderConfig {
  name: string;
  maxQueueBytes: number;
  maxBatchBytes: number;
  retryMs: number;
  onFailed(message: string): void;
  onRecovered(): void;
}

interface Waiter {
  target: number;
  /** 書き込みに失敗した時点で返さず、target まで待つ。 */
  persist: boolean;
  resolve(outcome: 'done' | 'failed'): void;
}

const encoder = new TextEncoder();

class LineAppender {
  linesEnqueued = 0;
  linesWritten = 0;
  queueBytes = 0;
  peakBytes = 0;
  failing = false;
  lastError: string | null = null;

  private pending: Uint8Array[] = [];
  private current: { data: Uint8Array; offset: number; lines: number } | null = null;
  private pumping = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private waiters: Waiter[] = [];

  constructor(
    private readonly file: LogFile,
    private readonly config: AppenderConfig,
  ) {}

  /** 上限を超えると false。呼び出し側が数える。 */
  enqueue(line: string): boolean {
    const data = encoder.encode(`${line}\n`);
    if (this.queueBytes + data.length > this.config.maxQueueBytes) return false;
    this.pending.push(data);
    this.queueBytes += data.length;
    this.peakBytes = Math.max(this.peakBytes, this.queueBytes);
    this.linesEnqueued += 1;
    this.kick();
    return true;
  }

  private kick(): void {
    if (this.pumping || this.retryTimer !== null) return;
    this.pumping = true;
    // 入出力の開始を write() の呼び出しの外へ出す。
    setImmediate(() => void this.pump());
  }

  private takeBatch(): void {
    if (this.pending.length === 0) return;
    let size = 0;
    let count = 0;
    for (const chunk of this.pending) {
      if (count > 0 && size + chunk.length > this.config.maxBatchBytes) break;
      size += chunk.length;
      count += 1;
    }
    const data = new Uint8Array(size);
    let at = 0;
    for (const chunk of this.pending.splice(0, count)) {
      data.set(chunk, at);
      at += chunk.length;
    }
    this.current = { data, offset: 0, lines: count };
  }

  private async pump(): Promise<void> {
    try {
      for (;;) {
        if (this.current === null) this.takeBatch();
        const batch = this.current;
        if (batch === null) break;
        const wrote = await this.file.write(batch.data.subarray(batch.offset));
        if (wrote <= 0) throw new Error('write returned no progress');
        batch.offset += wrote;
        if (batch.offset < batch.data.length) continue;
        this.queueBytes -= batch.data.length;
        this.linesWritten += batch.lines;
        this.current = null;
        if (this.failing) {
          this.failing = false;
          this.config.onRecovered();
        }
        this.settleWaiters();
      }
      this.pumping = false;
    } catch (error) {
      this.pumping = false;
      this.recordFailure(errorMessage(error));
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.kick();
      }, this.config.retryMs);
      this.retryTimer.unref?.();
    }
  }

  private recordFailure(message: string): void {
    this.lastError = message;
    const first = !this.failing;
    this.failing = true;
    this.config.onFailed(first ? message : `${message} (retrying)`);
    const remaining: Waiter[] = [];
    for (const waiter of this.waiters) {
      if (waiter.persist) remaining.push(waiter);
      else waiter.resolve('failed');
    }
    this.waiters = remaining;
  }

  private settleWaiters(): void {
    const remaining: Waiter[] = [];
    for (const waiter of this.waiters) {
      if (this.linesWritten >= waiter.target) waiter.resolve('done');
      else remaining.push(waiter);
    }
    this.waiters = remaining;
  }

  /** 呼び出しの時点までの行を書いて fsync する。persist なら失敗しても期限まで再試行を待つ。 */
  async flush(timeoutMs: number, persist: boolean): Promise<FlushResult> {
    const target = this.linesEnqueued;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
      this.kick();
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    try {
      if (this.linesWritten < target) {
        const written = new Promise<'done' | 'failed'>((resolve) => {
          this.waiters.push({ target, persist, resolve });
        });
        const outcome = await Promise.race([written, timedOut]);
        if (outcome !== 'done') {
          return {
            ok: false,
            pending_lines: this.linesEnqueued - this.linesWritten,
            error: outcome === 'timeout' ? `flush timed out: ${this.lastError ?? 'write stalled'}` : this.lastError,
          };
        }
      }
      const synced = await Promise.race([
        this.file.sync().then(
          () => null,
          (error: unknown) => errorMessage(error),
        ),
        timedOut,
      ]);
      if (synced !== null) {
        const message = synced === 'timeout' ? 'fsync timed out' : `fsync failed: ${synced}`;
        this.lastError = message;
        this.config.onFailed(message);
        return { ok: false, pending_lines: this.linesEnqueued - this.linesWritten, error: message };
      }
      return { ok: true, pending_lines: this.linesEnqueued - this.linesWritten, error: null };
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  async close(timeoutMs: number): Promise<string | null> {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timedOut = new Promise<string>((resolve) => {
      timer = setTimeout(() => resolve('close timed out'), timeoutMs);
    });
    try {
      return await Promise.race([
        this.file.close().then(
          () => null,
          (error: unknown) => `close failed: ${errorMessage(error)}`,
        ),
        timedOut,
      ]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }
}

// ---- 本体 ------------------------------------------------------------------

export class SessionLog implements EventSink {
  private received = 0;
  private accepted = 0;
  private quarantined = 0;
  private readonly quarantinedByReason: Partial<Record<QuarantineReason, number>> = {};
  private droppedOverflow = 0;
  private droppedAccepted = 0;
  private readonly droppedByEvent: Record<string, number> = {};
  private firstDropped: string | null = null;
  private lastDropped: string | null = null;
  private afterClose = 0;
  private writeErrors = 0;
  private overflowActive = false;
  private closing: Promise<CloseReport> | null = null;
  private readonly startedWallClock: string;
  private details: SessionManifestDetails | null = null;

  private constructor(
    readonly session_id: string,
    readonly paths: SessionLogPaths,
    private readonly events: LineAppender,
    private readonly quarantineFile: LineAppender,
    private readonly fs: LogFileSystem,
    private readonly time: TimeSource,
    private readonly flushTimeoutMs: number,
    private readonly closeTimeoutMs: number,
    private readonly notify: (problem: LogProblem) => void,
    private readonly reporter: (message: string) => void,
  ) {
    this.startedWallClock = time.wallClock();
  }

  /** ディレクトリと 2 つのファイルを作り、manifest を書く。作れなければ reject する（黙って続けない）。 */
  static async open(options: SessionLogOptions): Promise<SessionLog> {
    if (!SAFE_SESSION_ID.test(options.session_id)) throw new InvalidSessionIdError(options.session_id);
    const fs = options.fs ?? nodeLogFileSystem;
    const time = options.time ?? new SystemTimeSource();
    const dir = join(options.dir ?? DEFAULT_SESSIONS_DIR, options.session_id);
    const paths: SessionLogPaths = {
      dir,
      events: join(dir, EVENTS_FILE),
      quarantine: join(dir, QUARANTINE_FILE),
      manifest: join(dir, MANIFEST_FILE),
    };
    await fs.mkdirp(dir);
    const eventsFile = await fs.createExclusive(paths.events);
    const quarantineFile = await fs.createExclusive(paths.quarantine);

    const reporter = options.reporter ?? ((message: string) => console.error(message));
    let log: SessionLog | null = null;
    const appender = (name: string, file: LogFile) =>
      new LineAppender(file, {
        name,
        maxQueueBytes: options.maxQueueBytes ?? 64 * 1024 * 1024,
        maxBatchBytes: options.maxBatchBytes ?? 256 * 1024,
        retryMs: options.retryMs ?? 500,
        onFailed: (message) => log?.onWriteFailed(name, message),
        onRecovered: () => log?.notifySafely({ kind: 'write_recovered', file: name }),
      });
    log = new SessionLog(
      options.session_id,
      paths,
      appender(EVENTS_FILE, eventsFile),
      appender(QUARANTINE_FILE, quarantineFile),
      fs,
      time,
      options.flushTimeoutMs ?? 5000,
      options.closeTimeoutMs ?? 5000,
      options.onProblem ?? (() => undefined),
      reporter,
    );
    await fs.writeAtomic(paths.manifest, log.manifestText(false, null));
    return log;
  }

  /** EventSink。検証して積むだけで、失敗しても例外を出さない。 */
  write(event: ResearchEvent): void {
    this.ingest(event);
  }

  /** emit を通らない値（転送の途中など）の入口。型を信用せず同じ検証を通す。 */
  writeUnknown(value: unknown): void {
    this.ingest(value);
  }

  private ingest(value: unknown): void {
    if (this.closing !== null) {
      this.afterClose += 1;
      this.report(`[session_log ${this.session_id}] event after close: ${eventName(value)}`);
      return;
    }
    this.received += 1;
    const parsed = ResearchEvent.safeParse(value);
    if (!parsed.success) {
      this.quarantine('schema_invalid', value, parsed.error.issues);
      return;
    }
    if (parsed.data.session_id !== this.session_id) {
      this.quarantine('session_mismatch', value, [
        { message: `session_id ${parsed.data.session_id} written to log of ${this.session_id}` },
      ]);
      return;
    }
    this.enqueueEvent(parsed.data);
  }

  private enqueueEvent(event: ResearchEvent): void {
    const line = JSON.stringify(event);
    if (this.events.enqueue(line)) {
      this.accepted += 1;
      this.overflowActive = false;
      return;
    }
    this.droppedAccepted += 1;
    this.recordDrop(event.event, EVENTS_FILE);
  }

  private recordDrop(name: string, file: string): void {
    this.droppedOverflow += 1;
    this.droppedByEvent[name] = (this.droppedByEvent[name] ?? 0) + 1;
    const now = this.time.wallClock();
    this.firstDropped ??= now;
    this.lastDropped = now;
    if (!this.overflowActive) {
      this.overflowActive = true;
      const message = `queue full, dropping events (first: ${name})`;
      this.report(`[session_log ${this.session_id}] ${file}: ${message}`);
      this.notifySafely({ kind: 'queue_overflow', file, message });
    }
  }

  /** 不合格の記録。emit の invalid: 'report' からも呼ぶ。 */
  quarantine(reason: QuarantineReason, raw: unknown, issues: unknown): void {
    if (this.closing !== null) {
      this.afterClose += 1;
      this.report(`[session_log ${this.session_id}] ${reason} after close: ${eventName(raw)}`);
      return;
    }
    this.quarantined += 1;
    this.quarantinedByReason[reason] = (this.quarantinedByReason[reason] ?? 0) + 1;
    const name = eventName(raw);
    const record = {
      quarantine_version: 1,
      reason,
      event_name: name,
      session_id: this.session_id,
      t_monotonic_ms: this.time.monotonicMs(),
      wall_clock: this.time.wallClock(),
      issues: Array.isArray(issues) ? issues.slice(0, 20) : issues,
      raw: serializable(raw),
    };
    if (!this.quarantineFile.enqueue(safeStringify(record))) this.recordDrop(`quarantine:${name}`, QUARANTINE_FILE);
    if (this.quarantined === 1 || this.quarantinedByReason[reason] === 1) {
      this.report(`[session_log ${this.session_id}] quarantined ${name}: ${reason}`);
    }
    this.notifySafely({ kind: 'invalid_event', reason, event_name: name });
  }

  stats(): LogStats {
    return {
      received: this.received,
      accepted: this.accepted,
      written: this.events.linesWritten,
      quarantined: this.quarantined,
      quarantined_by_reason: { ...this.quarantinedByReason },
      quarantine_written: this.quarantineFile.linesWritten,
      dropped_overflow: this.droppedOverflow,
      dropped_by_event: { ...this.droppedByEvent },
      first_dropped_wall_clock: this.firstDropped,
      last_dropped_wall_clock: this.lastDropped,
      after_close: this.afterClose,
      write_errors: this.writeErrors,
      last_write_error: this.events.lastError ?? this.quarantineFile.lastError,
      failing: this.events.failing || this.quarantineFile.failing,
      queue_bytes: this.events.queueBytes + this.quarantineFile.queueBytes,
      queue_peak_bytes: Math.max(this.events.peakBytes, this.quarantineFile.peakBytes),
    };
  }

  /** ここまでの行を書いて fsync する。失敗や期限切れは ok: false で返す。 */
  async flush(timeoutMs = this.flushTimeoutMs): Promise<FlushResult> {
    const [events, quarantine] = await Promise.all([
      this.events.flush(timeoutMs, false),
      this.quarantineFile.flush(timeoutMs, false),
    ]);
    return mergeFlush(events, quarantine);
  }

  /**
   * セッションの条件とプロバイダの区分を manifest に書く（log_check が受け入れの証拠かを判定する）。
   * 書けなければ false。閉じた後は何もしない。
   */
  async describe(details: SessionManifestDetails): Promise<boolean> {
    this.details = details;
    if (this.closing !== null) return false;
    try {
      await this.fs.writeAtomic(this.paths.manifest, this.manifestText(false, null));
      return true;
    } catch (failure) {
      this.report(`[session_log ${this.session_id}] manifest not written: ${errorMessage(failure)}`);
      return false;
    }
  }

  /** 何度呼んでも同じ結果を返す。例外は出さず、失敗は CloseReport に載せて stderr にも出す。 */
  close(): Promise<CloseReport> {
    this.closing ??= this.doClose();
    return this.closing;
  }

  private async doClose(): Promise<CloseReport> {
    const [events, quarantine] = await Promise.all([
      this.events.flush(this.closeTimeoutMs, true),
      this.quarantineFile.flush(this.closeTimeoutMs, true),
    ]);
    const flushed = mergeFlush(events, quarantine);
    const closeErrors = (
      await Promise.all([this.events.close(this.closeTimeoutMs), this.quarantineFile.close(this.closeTimeoutMs)])
    ).filter((e): e is string => e !== null);

    const lost_events = this.accepted - this.events.linesWritten + this.droppedAccepted;
    let manifest_written = true;
    const error = flushed.error ?? closeErrors[0] ?? null;
    try {
      await this.fs.writeAtomic(this.paths.manifest, this.manifestText(true, error));
    } catch (failure) {
      manifest_written = false;
      this.report(`[session_log ${this.session_id}] manifest not written: ${errorMessage(failure)}`);
    }
    const ok = flushed.ok && closeErrors.length === 0 && lost_events === 0 && manifest_written;
    if (!ok) {
      this.report(
        `[session_log ${this.session_id}] closed with problems: lost_events=${lost_events} error=${error ?? 'none'}`,
      );
    }
    return {
      ok,
      pending_lines: flushed.pending_lines,
      error,
      lost_events,
      manifest_written,
      stats: this.stats(),
      paths: this.paths,
    };
  }

  private manifestText(closed: boolean, closeError: string | null): string {
    return `${JSON.stringify(
      {
        manifest_version: 1,
        session_id: this.session_id,
        event_schema_version: EVENT_SCHEMA_VERSION,
        started_wall_clock: this.startedWallClock,
        closed,
        closed_wall_clock: closed ? this.time.wallClock() : null,
        close_error: closeError,
        ...(this.details === null ? {} : this.details),
        stats: this.stats(),
      },
      null,
      2,
    )}\n`;
  }

  private onWriteFailed(file: string, message: string): void {
    this.writeErrors += 1;
    this.report(`[session_log ${this.session_id}] ${file}: ${message}`);
    this.notifySafely({ kind: 'write_failed', file, message });
  }

  private report(message: string): void {
    try {
      this.reporter(message);
    } catch {
      // 報告先の失敗で音声の経路を止めない。stats には残っている。
    }
  }

  private notifySafely(problem: LogProblem): void {
    try {
      this.notify(problem);
    } catch (error) {
      this.report(`[session_log ${this.session_id}] onProblem threw: ${errorMessage(error)}`);
    }
  }
}

function mergeFlush(a: FlushResult, b: FlushResult): FlushResult {
  return {
    ok: a.ok && b.ok,
    pending_lines: a.pending_lines + b.pending_lines,
    error: a.error ?? b.error,
  };
}

function eventName(value: unknown): string {
  const name = (value as { event?: unknown } | null | undefined)?.event;
  return typeof name === 'string' ? name : 'unknown';
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ unserializable: true, text: String(value) });
  }
}

/** 循環参照や BigInt でも隔離の記録を失わない。 */
function serializable(value: unknown): unknown {
  try {
    JSON.stringify(value);
    return value;
  } catch (error) {
    return { unserializable: true, error: errorMessage(error), text: String(value) };
  }
}

// ---- J が使う入口 ----------------------------------------------------------

export interface SessionLoggingOptions extends SessionLogOptions {
  /** 条件はセッションの途中で切り替わりうる。 */
  condition: () => Condition;
  /** session_log の provider.status に載せる区分。test double の試験では test_double を渡す。 */
  provider_class?: ProviderClass;
}

export interface SessionLogging {
  log: SessionLog;
  emitter: EventEmitter;
  time: TimeSource;
}

/**
 * ログと emitter を組で作る。
 *  - 契約に合わない emit は例外にせず隔離へ入れる（音声の経路を落とさない）。
 *  - 書き込みの失敗と回復は provider.status（provider=session_log）としても出す。研究者画面はこれで表示する。
 */
export async function openSessionLogging(options: SessionLoggingOptions): Promise<SessionLogging> {
  const time = options.time ?? new SystemTimeSource();
  let emitter: EventEmitter | null = null;
  let attempts = 0;
  let down = false;
  const provider_class = options.provider_class ?? 'production';
  const status = (health: 'ok' | 'degraded' | 'down', reason: string | null, retrying: boolean) =>
    emitter?.emit({
      event: 'provider.status',
      provider: SESSION_LOG_PROVIDER,
      provider_class,
      status: health,
      reason: reason === null ? absent('healthy') : present(reason),
      retry_attempt: attempts,
      next_retry_ms: retrying ? present(options.retryMs ?? 500) : absent('not_retrying'),
    });
  const log = await SessionLog.open({
    ...options,
    time,
    onProblem(problem) {
      if (problem.kind === 'write_failed') {
        attempts += 1;
        // 再試行のたびには出さない。状態が変わったときだけ（回数は回復までの stats に残る）。
        if (!down) status('down', `${problem.file}: ${problem.message}`, true);
        down = true;
      } else if (problem.kind === 'write_recovered') {
        down = false;
        status('ok', null, false);
        attempts = 0;
      } else if (problem.kind === 'queue_overflow') {
        status('degraded', `${problem.file}: ${problem.message}`, false);
      }
      options.onProblem?.(problem);
    },
  });
  emitter = createEventEmitter({
    time,
    session_id: options.session_id,
    condition: options.condition,
    sink: log,
    invalid: 'report',
    onInvalid(error: InvalidEventError, draft: EventDraft) {
      log.quarantine('draft_invalid', draft, error.issues);
    },
  });
  status('ok', null, false);
  return { log, emitter, time };
}

// ---- 終了時の flush --------------------------------------------------------

export interface ShutdownProcess {
  once(signal: string, listener: () => void): unknown;
  off(signal: string, listener: () => void): unknown;
  kill(pid: number, signal: string): unknown;
  pid: number;
}

/**
 * SIGINT／SIGTERM と beforeExit でログを閉じる。シグナルは閉じたあとで送り直し、既定の終了コードで落とす。
 * process.exit() の直接の呼び出しは捕まえられない。そのときは manifest の closed が false のまま残り、
 * ログの検証 CLI が検出する。戻り値で登録を解除する。
 */
export function installShutdownFlush(
  log: Pick<SessionLog, 'close'>,
  proc: ShutdownProcess = process,
  signals: readonly string[] = ['SIGINT', 'SIGTERM'],
): () => void {
  const handlers = new Map<string, () => void>();
  const dispose = () => {
    for (const [signal, handler] of handlers) proc.off(signal, handler);
    handlers.clear();
  };
  for (const signal of signals) {
    const handler = () => {
      dispose();
      void log.close().finally(() => proc.kill(proc.pid, signal));
    };
    handlers.set(signal, handler);
    proc.once(signal, handler);
  }
  const onBeforeExit = () => {
    dispose();
    void log.close();
  };
  handlers.set('beforeExit', onBeforeExit);
  proc.once('beforeExit', onBeforeExit);
  return dispose;
}
