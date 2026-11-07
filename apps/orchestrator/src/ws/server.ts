/**
 * HTTP と WS の入口（レーン J）。
 *   /ws        参加者のブラウザ（browser_rpc の JSON と AUDIO／PCM 枠）。同時に1人。
 *   /research  研究者画面へイベントを1件1テキスト枠で配信（apps/web/src/research/feed.ts の createWsFeed）。
 *   /health    状態の JSON（キーの値は含めない）。
 *
 * セッションの規則:
 *   - client.hello の session_id が今のセッションで、切断から resume_grace_ms 以内なら同じセッションへ戻す。
 *   - それ以外の hello は新しいセッション。前のセッションは閉じる（参加者は1人）。
 *   - 切断したら再生中の音声の終わりを代行し（発話済みのみ履歴へ）、猶予の後に閉じる。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { BrowserToNode, SystemTimeSource } from '@llm-vap/contracts';
import type { ClientHello, EmitOptions, EventDraft, EventEmitter, ResearchEvent, TimeSource } from '@llm-vap/contracts';
import { openSessionLogging } from '../logging';
import type { MaaiWorkerClient } from '../maai';
import type { OrchestratorConfig } from '../app/config';
import { createSessionProviders } from '../app/providers';
import { Session, type BrowserLink } from '../session/session';

/** MaAI クライアントはプロセスに1つなので、時刻源をセッションの時計へ切り替える。 */
export class SwitchableTimeSource implements TimeSource {
  private current: TimeSource;
  constructor(private readonly fallback: TimeSource = new SystemTimeSource()) {
    this.current = fallback;
  }
  use(time: TimeSource | null): void {
    this.current = time ?? this.fallback;
  }
  monotonicMs(): number {
    return this.current.monotonicMs();
  }
  wallClock(): string {
    return this.current.wallClock();
  }
}

export interface ServerOptions {
  config: OrchestratorConfig;
  maai: MaaiWorkerClient | null;
  maaiUnavailableReason?: string;
  /** maai の時刻源。セッションの時計へ切り替える。 */
  maaiTime?: SwitchableTimeSource;
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
}

const RESEARCH_BACKLOG = 3000;

function newSessionId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
  return `s${stamp}-${randomBytes(3).toString('hex')}`;
}

export class OrchestratorServer {
  readonly http: Server;
  private readonly browserWss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  private readonly researchWss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  private session: Session | null = null;
  private sessionSocket: WebSocket | null = null;
  private graceTimer: NodeJS.Timeout | null = null;
  private starting: Promise<void> | null = null;
  private readonly backlog: string[] = [];
  private readonly log: (message: string) => void;
  /** 試験が閉じたセッションも調べられるように残す。 */
  readonly pastSessions: Session[] = [];

  constructor(private readonly options: ServerOptions) {
    this.log = options.log ?? ((message) => console.log(`[orchestrator] ${message}`));
    this.http = createServer((req, res) => this.onHttp(req, res));
    this.http.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (!this.originAllowed(req)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      if (url.pathname === '/ws') {
        this.browserWss.handleUpgrade(req, socket, head, (ws) => this.onBrowser(ws));
      } else if (url.pathname === '/research') {
        this.researchWss.handleUpgrade(req, socket, head, (ws) => this.onResearch(ws));
      } else {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
      }
    });
  }

  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.http.once('error', reject);
      this.http.listen(this.options.config.port, this.options.config.host, () => {
        const address = this.http.address();
        resolve(typeof address === 'object' && address !== null ? address.port : this.options.config.port);
      });
    });
  }

  current(): Session | null {
    return this.session;
  }

  /** Origin のないクライアント（Node、試験）は通す。ブラウザは localhost の画面からだけ。 */
  private originAllowed(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (origin === undefined) return true;
    try {
      return this.options.config.allowed_origin_hosts.includes(new URL(origin).hostname);
    } catch {
      return false;
    }
  }

  private onHttp(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/health') {
      const session = this.session;
      const body = {
        ok: true,
        maai: this.options.maai?.current() ?? { state: 'disabled', reason: this.options.maaiUnavailableReason ?? null },
        session:
          session === null
            ? null
            : {
                session_id: session.session_id,
                attached: session.attached,
                status: session.status(),
                counters: session.counters,
              },
        providers: { stt: this.options.config.stt, tts: this.options.config.tts, llm: this.options.config.llm },
      };
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify(body));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found. WS: /ws (participant), /research (researcher feed), GET /health\n');
  }

  // ---- 研究者画面 ----------------------------------------------------------------

  private onResearch(ws: WebSocket): void {
    for (const line of this.backlog) ws.send(line);
  }

  private broadcast(event: ResearchEvent): void {
    const line = JSON.stringify(event);
    this.backlog.push(line);
    if (this.backlog.length > RESEARCH_BACKLOG) this.backlog.shift();
    for (const client of this.researchWss.clients) {
      if (client.readyState === WebSocket.OPEN && client.bufferedAmount < 4 * 1024 * 1024) client.send(line);
    }
  }

  // ---- 参加者 --------------------------------------------------------------------

  private onBrowser(ws: WebSocket): void {
    let session: Session | null = null;
    const link: BrowserLink = {
      sendJson: (message) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
      },
      sendBinary: (data) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(data, { binary: true });
      },
    };
    ws.on('message', (data: RawData, isBinary: boolean) => {
      const bytes = toBytes(data);
      if (isBinary) {
        if (session !== null && this.sessionSocket === ws) session.handleBinary(bytes);
        return;
      }
      let parsed: ReturnType<typeof BrowserToNode.safeParse>;
      try {
        parsed = BrowserToNode.safeParse(JSON.parse(Buffer.from(bytes).toString('utf8')));
      } catch {
        return;
      }
      if (!parsed.success) {
        this.log(`browser message violates contract: ${parsed.error.message.slice(0, 200)}`);
        return;
      }
      const message = parsed.data;
      if (message.type === 'client.hello') {
        void this.onHello(ws, link, message).then((s) => {
          session = s;
        });
        return;
      }
      if (session !== null && this.sessionSocket === ws) session.handleJson(message);
    });
    ws.on('close', () => {
      if (this.sessionSocket !== ws) return;
      this.sessionSocket = null;
      const current = this.session;
      if (current === null) return;
      current.detach('ws_closed');
      this.log(`browser disconnected; keeping ${current.session_id} for ${this.options.config.resume_grace_ms} ms`);
      this.graceTimer = setTimeout(() => {
        this.graceTimer = null;
        if (this.session === current && !current.attached) void this.endSession('resume_grace_expired');
      }, this.options.config.resume_grace_ms);
    });
  }

  private async onHello(ws: WebSocket, link: BrowserLink, hello: ClientHello): Promise<Session | null> {
    // 前の hello の処理（セッションの準備）を待つ。
    while (this.starting !== null) await this.starting;
    const previousSocket = this.sessionSocket;
    if (previousSocket !== null && previousSocket !== ws) {
      // 参加者は1人。新しい画面が来たら古い接続を閉じる。
      this.sessionSocket = null;
      this.session?.detach('replaced_by_new_connection');
      previousSocket.close(4000, 'replaced by a new connection');
    }
    const wanted = hello.session_id.value;
    const current = this.session;
    if (current !== null && wanted === current.session_id && !current.attached) {
      if (this.graceTimer !== null) clearTimeout(this.graceTimer);
      this.graceTimer = null;
      this.sessionSocket = ws;
      current.reattach(link, hello);
      this.log(`browser reattached to ${current.session_id}`);
      return current;
    }
    if (current !== null) await this.endSession('new_client_session');
    let resolveStarting!: () => void;
    this.starting = new Promise((resolve) => (resolveStarting = resolve));
    try {
      const session = await this.createSession();
      this.session = session;
      this.sessionSocket = ws;
      await session.start(link, hello);
      this.log(`session ${session.session_id} started (stt=${this.options.config.stt} tts=${this.options.config.tts} llm=${this.options.config.llm})`);
      if (ws.readyState !== WebSocket.OPEN) {
        this.sessionSocket = null;
        session.detach('closed_during_start');
      }
      return session;
    } catch (error) {
      this.log(`session start failed: ${error instanceof Error ? error.message : String(error)}`);
      ws.close(1011, 'session start failed');
      return null;
    } finally {
      this.starting = null;
      resolveStarting();
    }
  }

  private async createSession(): Promise<Session> {
    const { config } = this.options;
    const session_id = newSessionId();
    const time = new SystemTimeSource();
    const logging = await openSessionLogging({
      dir: config.sessions_dir,
      session_id,
      time,
      condition: () => config.condition,
      provider_class: 'production',
    });
    const inner = logging.emitter;
    const emitter: EventEmitter = {
      emit: (draft: EventDraft, emitOptions?: EmitOptions) => {
        const event = inner.emit(draft, emitOptions);
        this.broadcast(event);
        return event;
      },
    };
    this.backlog.length = 0;
    this.options.maaiTime?.use(time);
    const providers = await createSessionProviders({ config, time, emitter, ...(this.options.env ? { env: this.options.env } : {}) });
    return new Session({
      session_id,
      condition: config.condition,
      policy: config.policy,
      time,
      emitter,
      log: logging.log,
      providers,
      maai: this.options.maai,
      ...(this.options.maaiUnavailableReason ? { maaiUnavailableReason: this.options.maaiUnavailableReason } : {}),
    });
  }

  async endSession(reason: string): Promise<void> {
    const session = this.session;
    if (session === null) return;
    this.session = null;
    if (this.graceTimer !== null) clearTimeout(this.graceTimer);
    this.graceTimer = null;
    this.pastSessions.push(session);
    await session.close(reason);
    this.log(`session ${session.session_id} closed (${reason})`);
  }

  async close(): Promise<void> {
    await this.endSession('server_shutdown');
    for (const client of this.browserWss.clients) client.terminate();
    for (const client of this.researchWss.clients) client.terminate();
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }
}

function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}
