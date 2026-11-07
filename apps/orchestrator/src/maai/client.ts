/**
 * MaAI ワーカーのクライアント。プロセスの起動、WS 接続、再起動、未稼働の通知を持つ。
 *
 * 未稼働の間は VAP_STATE が届かないだけで、ここで値を作らない（計画 §3.3）。鮮度切れの扱いは §4.1 の TurnManager。
 * 既定では READY の is_fake=true を起動失敗として扱う（本番の経路に偽サーバーを入れない）。
 * allowFake は test double の試験専用で、provider_class は test_double になる。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { WebSocket } from 'ws';
import {
  MaaiConfigure,
  MaaiWorkerToNode,
  encodeAudioFrame,
  type MaaiError,
  type MaaiFramesDropped,
  type MaaiPong,
  type MaaiReady,
  type MaaiVapStateMessage,
  type MaaiWorkerStatus,
  type TimeSource,
} from '@llm-vap/contracts';
import type { MaaiLaunch } from './config';

export type MaaiWorkerState = 'stopped' | 'starting' | 'loading' | 'ready' | 'degraded' | 'down';

export interface MaaiAvailability {
  state: MaaiWorkerState;
  /** VAP_STATE が来る見込みがあるか。ready と degraded だけ true。 */
  vap_available: boolean;
  reason: string | null;
  /** 今の障害からの再起動の回数。 */
  restart_attempt: number;
  /** 再起動を待っているときの残り。諦めたら null で gave_up=true。 */
  next_retry_ms: number | null;
  gave_up: boolean;
  /** READY で確かめた後の値。READY の前は null。 */
  is_fake: boolean | null;
}

export interface MaaiClientListeners {
  /** t の受信時刻 receivedAtMs は options.time の基準。WorkerClockRecorder.observe(msg.t, receivedAtMs) に渡せる。 */
  onVapState?(message: MaaiVapStateMessage, receivedAtMs: number): void;
  onFramesDropped?(message: MaaiFramesDropped, receivedAtMs: number): void;
  onWorkerStatus?(message: MaaiWorkerStatus, receivedAtMs: number): void;
  onReady?(message: MaaiReady, receivedAtMs: number): void;
  onError?(message: MaaiError, receivedAtMs: number): void;
  /** worker_t_ms も同じ時計。rttMs は Node で測った往復。 */
  onPong?(message: MaaiPong, receivedAtMs: number, rttMs: number): void;
  onAvailability?(availability: MaaiAvailability): void;
  /** ワーカーの時計の基準が変わるとき。WorkerClockRecorder.reset() を呼ぶ。 */
  onClockReset?(): void;
}

export interface MaaiRestartPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** ここまで動き続けたら回数を数え直す。 */
  stableAfterMs: number;
}

export interface MaaiClientTimeouts {
  /** プロセス起動から待ち受けの告知まで。 */
  listenMs: number;
  /** CONFIGURE から READY まで（重みの読み込みを含む）。 */
  readyMs: number;
  pingIntervalMs: number;
  /** ready の間、何も届かなければ停止と見なす。 */
  silenceMs: number;
  /** SHUTDOWN から終了まで。過ぎたら強制終了。 */
  shutdownMs: number;
}

export interface MaaiClientOptions {
  launch: MaaiLaunch;
  /** session_id は start で入れる。 */
  configure: Omit<MaaiConfigure, 'session_id'>;
  time: TimeSource;
  restart?: Partial<MaaiRestartPolicy>;
  timeouts?: Partial<MaaiClientTimeouts>;
  /** test double の試験専用。 */
  allowFake?: boolean;
  /** WS の未送信がこれを超えたら枠を拒否する（2チャネルは1枠なので同時）。 */
  maxBufferedBytes?: number;
}

const DEFAULT_RESTART: MaaiRestartPolicy = { maxAttempts: 5, baseDelayMs: 500, maxDelayMs: 8000, stableAfterMs: 30000 };
const DEFAULT_TIMEOUTS: MaaiClientTimeouts = {
  listenMs: 30000,
  readyMs: 180000,
  pingIntervalMs: 1000,
  silenceMs: 5000,
  shutdownMs: 3000,
};
const STDERR_TAIL_LINES = 40;
const SOCKET_CLOSE_GRACE_MS = 500;

/** 再起動しても直らない異常。 */
const PERMANENT_ERROR_CODES = new Set(['model_load', 'bad_configure']);

interface Attempt {
  id: number;
  child: ChildProcess;
  socket: WebSocket | null;
  startedReadyAt: number | null;
  timers: Set<NodeJS.Timeout>;
  lastReceivedAt: number;
  fatal: MaaiError | null;
  ended: boolean;
  heartbeat: boolean;
}

export class MaaiWorkerClient {
  private readonly listeners = new Set<MaaiClientListeners>();
  private readonly restartPolicy: MaaiRestartPolicy;
  private readonly timeouts: MaaiClientTimeouts;
  private readonly maxBufferedBytes: number;
  private availability: MaaiAvailability = {
    state: 'stopped',
    vap_available: false,
    reason: 'not_started',
    restart_attempt: 0,
    next_retry_ms: null,
    gave_up: false,
    is_fake: null,
  };
  private attempt: Attempt | null = null;
  private attemptSeq = 0;
  private restartCount = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private sessionId: string | null = null;
  private wanted = false;
  private firstOutcome: ((availability: MaaiAvailability) => void) | null = null;
  private stopWaiters: (() => void)[] = [];
  private readyInfo: MaaiReady | null = null;
  private refusedSamples = 0;
  private pingSeq = 0;
  private readonly stderrLines: string[] = [];

  constructor(private readonly options: MaaiClientOptions) {
    this.restartPolicy = { ...DEFAULT_RESTART, ...options.restart };
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
    this.maxBufferedBytes = options.maxBufferedBytes ?? 1024 * 1024;
  }

  subscribe(listeners: MaaiClientListeners): () => void {
    this.listeners.add(listeners);
    return () => this.listeners.delete(listeners);
  }

  get providerClass(): 'production' | 'test_double' {
    return this.options.allowFake === true ? 'test_double' : 'production';
  }

  current(): MaaiAvailability {
    return this.availability;
  }

  ready(): MaaiReady | null {
    return this.readyInfo;
  }

  /** 未稼働などで届けられなかったサンプル数（1チャネルあたり）。再起動の間の穴の記録に使う。 */
  undeliveredSamples(): number {
    return this.refusedSamples;
  }

  stderrTail(): string[] {
    return [...this.stderrLines];
  }

  pid(): number | null {
    return this.attempt?.child.pid ?? null;
  }

  /** 最初の READY か、諦めたところで解決する。失敗でも reject せず、availability で伝える。 */
  start(session_id: string): Promise<MaaiAvailability> {
    if (this.wanted) throw new Error('MaaiWorkerClient is already started');
    this.wanted = true;
    this.sessionId = session_id;
    this.restartCount = 0;
    this.refusedSamples = 0;
    return new Promise((resolve) => {
      this.firstOutcome = resolve;
      this.launch();
    });
  }

  /** SHUTDOWN を送り、終了を待つ。待ちきれなければ強制終了する。 */
  stop(reason: string): Promise<void> {
    this.wanted = false;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    const attempt = this.attempt;
    if (attempt === null) {
      this.update({ state: 'stopped', reason, next_retry_ms: null, gave_up: false });
      this.settleFirst();
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.stopWaiters.push(resolve);
      if (attempt.socket?.readyState === WebSocket.OPEN) {
        attempt.socket.send(JSON.stringify({ type: 'SHUTDOWN', reason }));
      } else {
        attempt.child.kill('SIGTERM');
      }
      this.addTimer(attempt, this.timeouts.shutdownMs, () => attempt.child.kill('SIGKILL'));
      this.update({ state: 'stopped', vap_available: false, reason, next_retry_ms: null, gave_up: false });
    });
  }

  /**
   * 動いているワーカーへ新しい CONFIGURE を送る（J が追加）。ブラウザが audio_frame を 0 から振り直す
   * 新しいセッションの始めに呼ぶ。ワーカーは文脈を捨てて READY を返す。READY か失敗で解決し、reject しない。
   * 起動中や再起動待ちのときは、次の CONFIGURE が新しい session_id を使う（そのワーカーはまだ音声を受けていない）。
   */
  reconfigure(session_id: string): Promise<MaaiAvailability> {
    if (!this.wanted) throw new Error('MaaiWorkerClient is not started');
    this.sessionId = session_id;
    this.refusedSamples = 0;
    const attempt = this.attempt;
    const socket = attempt?.socket ?? null;
    if (attempt === null || socket === null || socket.readyState !== WebSocket.OPEN || attempt.startedReadyAt === null) {
      return Promise.resolve(this.availability);
    }
    this.notifyClockReset();
    this.readyInfo = null;
    attempt.startedReadyAt = null;
    this.update({ state: 'loading', vap_available: false, reason: 'reconfiguring_for_new_session' });
    return new Promise((resolve) => {
      this.settleFirst();
      this.firstOutcome = resolve;
      socket.send(JSON.stringify(MaaiConfigure.parse({ ...this.options.configure, session_id })));
      this.addTimer(attempt, this.timeouts.readyMs, () => {
        if (attempt.startedReadyAt === null) {
          this.failAttempt(attempt, 'ready_timeout: READY did not arrive after reconfigure', true);
        }
      });
    });
  }

  /** Browser からの AUDIO 枠をそのまま渡す。届けられないときは false。 */
  sendEncodedAudio(frame: Uint8Array, sampleCount: number): boolean {
    const socket = this.attempt?.socket;
    if (
      !this.availability.vap_available ||
      socket === null ||
      socket === undefined ||
      socket.readyState !== WebSocket.OPEN ||
      socket.bufferedAmount > this.maxBufferedBytes
    ) {
      this.refusedSamples += sampleCount;
      return false;
    }
    socket.send(frame, { binary: true });
    return true;
  }

  sendAudio(input: { audio_frame: number; mic: Int16Array; sys: Int16Array }): boolean {
    return this.sendEncodedAudio(encodeAudioFrame(input), input.mic.length);
  }

  // ---- 起動 ---------------------------------------------------------------

  private launch(): void {
    const { command, args, cwd, env } = this.options.launch;
    this.readyInfo = null;
    this.notifyClockReset();
    this.update({ state: 'starting', vap_available: false, reason: 'spawning_worker', next_retry_ms: null, gave_up: false, is_fake: null });
    const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const attempt: Attempt = {
      id: ++this.attemptSeq,
      child,
      socket: null,
      startedReadyAt: null,
      timers: new Set(),
      lastReceivedAt: this.options.time.monotonicMs(),
      fatal: null,
      ended: false,
      heartbeat: false,
    };
    this.attempt = attempt;

    child.on('error', (error) => this.failAttempt(attempt, `spawn_failed: ${error.message}`, false));
    child.stdin?.on('error', () => undefined); // 相手の終了は close で扱う
    child.on('close', (code, signal) => this.onExit(attempt, code, signal));
    this.readLines(child.stderr, (line) => {
      this.stderrLines.push(line);
      if (this.stderrLines.length > STDERR_TAIL_LINES) this.stderrLines.shift();
    });
    let announced = false;
    this.readLines(child.stdout, (line) => {
      if (announced) return;
      const port = parseAnnouncement(line);
      if (port === null) return;
      announced = true;
      this.connect(attempt, port);
    });
    this.addTimer(attempt, this.timeouts.listenMs, () => {
      if (!announced) this.failAttempt(attempt, 'startup_timeout: worker did not start listening', true);
    });
  }

  private readLines(stream: NodeJS.ReadableStream | null, onLine: (line: string) => void): void {
    if (stream === null) return;
    let buffer = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        onLine(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
      }
    });
  }

  private connect(attempt: Attempt, port: number): void {
    if (attempt.ended) return;
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, { perMessageDeflate: false });
    attempt.socket = socket;
    socket.on('open', () => {
      if (attempt.ended) return;
      this.update({ state: 'loading', vap_available: false, reason: 'loading_model' });
      socket.send(JSON.stringify(MaaiConfigure.parse({ ...this.options.configure, session_id: this.sessionId })));
      this.addTimer(attempt, this.timeouts.readyMs, () => {
        if (attempt.startedReadyAt === null) this.failAttempt(attempt, 'ready_timeout: READY did not arrive', true);
      });
    });
    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        this.failAttempt(attempt, 'contract_violation: binary message from worker', true);
        return;
      }
      this.onMessage(attempt, String(data));
    });
    socket.on('error', (error) => {
      // 接続できないのは異常。切断は close と exit で扱う。
      if (attempt.startedReadyAt === null) this.failAttempt(attempt, `connect_failed: ${error.message}`, true);
    });
    socket.on('close', (code, reason) => {
      if (attempt.ended || !this.wanted) return;
      // VAP は今この時点で届かない。プロセスの終了が続けば、その理由（終了コード）を残すために少し待つ。
      // プロセスが残ったままなら状態が分からないので作り直す。
      const message = `socket_closed: code=${code} ${String(reason)}`.trim();
      // down の通知より先に時計の推定を捨てる。ここから再起動まで古い推定で写さない。
      this.notifyClockReset();
      this.update({ state: 'down', vap_available: false, reason: attempt.fatal ? this.availability.reason : message });
      this.addTimer(attempt, SOCKET_CLOSE_GRACE_MS, () => this.failAttempt(attempt, message, true));
    });
  }

  private onMessage(attempt: Attempt, text: string): void {
    if (attempt.ended || attempt !== this.attempt) return;
    const receivedAt = this.options.time.monotonicMs();
    attempt.lastReceivedAt = receivedAt;
    const parsed = parseWorkerMessage(text);
    if ('error' in parsed) {
      this.failAttempt(attempt, `contract_violation: ${parsed.error.slice(0, 300)}`, true);
      return;
    }
    const { message } = parsed;
    switch (message.type) {
      case 'READY':
        this.onReady(attempt, message, receivedAt);
        break;
      case 'VAP_STATE':
        this.forEachListener((l) => l.onVapState?.(message, receivedAt));
        break;
      case 'FRAMES_DROPPED':
        this.forEachListener((l) => l.onFramesDropped?.(message, receivedAt));
        break;
      case 'WORKER_STATUS':
        this.onWorkerStatus(attempt, message, receivedAt);
        break;
      case 'PONG':
        this.forEachListener((l) => l.onPong?.(message, receivedAt, receivedAt - message.t_ms));
        break;
      case 'ERROR':
        if (message.fatal) attempt.fatal = message;
        this.forEachListener((l) => l.onError?.(message, receivedAt));
        if (message.fatal && this.wanted) {
          this.update({ state: 'down', vap_available: false, reason: `${message.code}: ${message.message}` });
        }
        break;
    }
  }

  private onReady(attempt: Attempt, ready: MaaiReady, receivedAt: number): void {
    if (!this.wanted) return;
    const wanted = this.options.configure;
    if (ready.is_fake && this.options.allowFake !== true) {
      this.failAttempt(attempt, 'fake_worker_refused: READY.is_fake=true on the production path', false);
      return;
    }
    const mismatch = (['lang', 'model_type', 'channel_layout', 'frame_rate_hz'] as const).filter(
      (key) => ready[key] !== wanted[key],
    );
    if (mismatch.length > 0) {
      this.failAttempt(attempt, `ready_mismatch: ${mismatch.join(',')}`, false);
      return;
    }
    attempt.startedReadyAt = receivedAt;
    this.readyInfo = ready;
    this.update({ state: 'ready', vap_available: true, reason: null, next_retry_ms: null, gave_up: false, is_fake: ready.is_fake });
    this.forEachListener((l) => l.onReady?.(ready, receivedAt));
    this.startHeartbeat(attempt);
    this.settleFirst();
  }

  private onWorkerStatus(attempt: Attempt, status: MaaiWorkerStatus, receivedAt: number): void {
    this.forEachListener((l) => l.onWorkerStatus?.(status, receivedAt));
    if (!this.wanted) return; // 停止の途中。stopped を上書きしない
    const reason = status.reason.value;
    if (status.status === 'down') {
      this.update({ state: 'down', vap_available: false, reason: reason ?? 'worker_down' });
      return;
    }
    if (attempt.startedReadyAt === null) return;
    if (receivedAt - attempt.startedReadyAt >= this.restartPolicy.stableAfterMs) {
      this.restartCount = 0;
      if (this.availability.restart_attempt !== 0) this.update({ restart_attempt: 0 });
    }
    const next = status.status === 'degraded' ? 'degraded' : 'ready';
    if (this.availability.state !== next || this.availability.reason !== reason) {
      this.update({ state: next, vap_available: true, reason });
    }
  }

  private startHeartbeat(attempt: Attempt): void {
    if (attempt.heartbeat) return; // reconfigure の後の READY で重ねない
    attempt.heartbeat = true;
    const timer = setInterval(() => {
      if (attempt.ended) return;
      const now = this.options.time.monotonicMs();
      if (now - attempt.lastReceivedAt > this.timeouts.silenceMs) {
        this.failAttempt(attempt, `heartbeat_timeout: nothing received for ${Math.round(now - attempt.lastReceivedAt)} ms`, true);
        return;
      }
      if (attempt.socket?.readyState === WebSocket.OPEN) {
        attempt.socket.send(JSON.stringify({ type: 'PING', seq: this.pingSeq++, t_ms: now }));
      }
    }, this.timeouts.pingIntervalMs);
    attempt.timers.add(timer);
  }

  // ---- 終了と再起動 --------------------------------------------------------

  private addTimer(attempt: Attempt, ms: number, fn: () => void): void {
    const timer = setTimeout(() => {
      attempt.timers.delete(timer);
      if (!attempt.ended) fn();
    }, ms);
    attempt.timers.add(timer);
  }

  private clearAttempt(attempt: Attempt): void {
    attempt.ended = true;
    for (const timer of attempt.timers) clearTimeout(timer);
    attempt.timers.clear();
    const socket = attempt.socket;
    if (socket !== null && socket.readyState !== WebSocket.CLOSED) socket.terminate();
    if (this.attempt === attempt) this.attempt = null;
  }

  /** 稼働中の異常。プロセスを消して down を知らせ、必要なら再起動を予約する。 */
  private failAttempt(attempt: Attempt, reason: string, retryable: boolean): void {
    if (attempt.ended) return;
    const fatal = attempt.fatal;
    const message = fatal ? `${fatal.code}: ${fatal.message}` : reason;
    const retry = retryable && !(fatal && PERMANENT_ERROR_CODES.has(fatal.code));
    attempt.child.kill('SIGKILL');
    this.clearAttempt(attempt);
    this.afterFailure(message, retry);
  }

  private onExit(attempt: Attempt, code: number | null, signal: NodeJS.Signals | null): void {
    if (attempt.ended) {
      this.finishStopIfDone();
      return;
    }
    this.clearAttempt(attempt);
    if (!this.wanted) {
      this.update({ state: 'stopped', vap_available: false, next_retry_ms: null });
      this.finishStopIfDone();
      return;
    }
    const fatal = attempt.fatal;
    // シグナルで落ちたときの stderr の最後の行は原因と関係がない。
    const lastLine = signal === null ? this.stderrLines.at(-1) : undefined;
    const detail = fatal
      ? `${fatal.code}: ${fatal.message}`
      : `worker_exit: code=${code} signal=${signal}${lastLine ? ` (${lastLine.slice(0, 200)})` : ''}`;
    const permanent = fatal !== null && PERMANENT_ERROR_CODES.has(fatal.code);
    this.afterFailure(detail, !permanent);
  }

  private afterFailure(reason: string, retry: boolean): void {
    this.notifyClockReset();
    this.readyInfo = null;
    if (!this.wanted) {
      this.update({ state: 'stopped', vap_available: false, next_retry_ms: null });
      this.finishStopIfDone();
      return;
    }
    if (!retry || this.restartCount >= this.restartPolicy.maxAttempts) {
      this.update({
        state: 'down',
        vap_available: false,
        reason,
        next_retry_ms: null,
        gave_up: true,
        restart_attempt: this.restartCount,
      });
      this.settleFirst();
      return;
    }
    const delay = Math.min(this.restartPolicy.maxDelayMs, this.restartPolicy.baseDelayMs * 2 ** this.restartCount);
    this.restartCount += 1;
    this.update({
      state: 'down',
      vap_available: false,
      reason,
      next_retry_ms: delay,
      gave_up: false,
      restart_attempt: this.restartCount,
    });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.wanted) this.launch();
    }, delay);
  }

  private finishStopIfDone(): void {
    if (this.attempt !== null) return;
    const waiters = this.stopWaiters;
    this.stopWaiters = [];
    for (const resolve of waiters) resolve();
    if (!this.wanted) this.settleFirst();
  }

  private settleFirst(): void {
    const resolve = this.firstOutcome;
    if (resolve === null) return;
    this.firstOutcome = null;
    resolve(this.availability);
  }

  private update(patch: Partial<MaaiAvailability>): void {
    this.availability = { ...this.availability, ...patch };
    const snapshot = this.availability;
    this.forEachListener((l) => l.onAvailability?.(snapshot));
  }

  private notifyClockReset(): void {
    this.forEachListener((l) => l.onClockReset?.());
  }

  private forEachListener(fn: (listener: MaaiClientListeners) => void): void {
    for (const listener of this.listeners) fn(listener);
  }
}

function parseWorkerMessage(text: string): { message: MaaiWorkerToNode } | { error: string } {
  try {
    return { message: MaaiWorkerToNode.parse(JSON.parse(text)) };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

function parseAnnouncement(line: string): number | null {
  try {
    const value = JSON.parse(line) as { event?: unknown; port?: unknown };
    if (value.event === 'listening' && typeof value.port === 'number') return value.port;
  } catch {
    return null;
  }
  return null;
}
