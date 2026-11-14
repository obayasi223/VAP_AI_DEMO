/**
 * HTTP と WS の入口（レーン J）。
 *   /ws        参加者のブラウザ（browser_rpc の JSON と AUDIO／PCM 枠）。同時に1人。
 *   /research  研究者画面へイベントを1件1テキスト枠で配信（apps/web/src/research/feed.ts の createWsFeed）。
 *   /health    状態の JSON（キーの値は含めない）。
 *
 * セッションの規則:
 *   - hello は届いた順に1つずつ処理する（同時に届いてもセッションを2つ作らない）。
 *   - client.hello の session_id が今のセッションなら同じセッションへ戻す（切断から resume_grace_ms 以内）。
 *     古い接続がまだ開いて見えても、同じ Worker の張り直しなので新しい接続を採る。
 *   - 別のセッションを求める hello は、今のセッションが接続中なら新しい側を拒否する（code 4000）。
 *     参加者の会話を、誤って開いた2つ目のタブが奪わないため。Worker は 4000 では張り直さない。
 *   - 今のセッションが切断中なら、それを閉じて新しいセッションを始める（参加者は1人）。
 *   - 切断しても再生中の音声の終わりは代行しない（再接続後のブラウザの報告を正とする）。猶予の後に閉じ、
 *     そのとき代行する（発話済みのみ履歴へ）。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { BrowserToNode, Condition, ConversationKind, SystemTimeSource, TimingStrategy, VocalCueMode } from '@llm-vap/contracts';
import type {
  ClientHello,
  EmitOptions,
  EventDraft,
  EventEmitter,
  ResearchEvent,
  ResearchTwoAiArm,
  ResearchTwoAiArmAck,
  ResearchWoz,
  ResearchWozAck,
  TimeSource,
  TwoAiCondition,
  TwoAiEmitContext,
} from '@llm-vap/contracts';
import { openSessionLogging } from '../logging';
import type { MaaiWorkerClient } from '../maai';
import type { OrchestratorConfig } from '../app/config';
import { conversationKindFile, createSessionProviders, createTwoAiProviders, TWO_AI_VOICE_ENV } from '../app/providers';
import type { ChoiceSource, InitiativeChoice } from '../app/providers';
import { Session, type BrowserLink } from '../session/session';
import { handleResearchMessage, researchConfigMessage, type NoteTarget, type TwoAiResearchHandlers } from './research_channel';
import { REPO_ROOT } from '../maai';
// 2 体のモードの部品（生成の側を含む）は 2 体のセッションを作るときに読む（1 対 1 のモードの起動はそれに依らない）。
import type { TwoAiSession } from '../two_ai/two_ai_session';
import type { TwoAiSettingsResult } from '../two_ai/settings';
import { redactForResearch, type RedactionPolicy } from '../two_ai/research_redaction';

/** 参加者のセッション（1 対 1 か 2 体）。 */
type AnySession = Session | TwoAiSession;

/** 2 体のセッションを始められない理由（WS は 1011 とこの理由で閉じる）。 */
class TwoAiStartError extends Error {}

function isTwoAi(session: AnySession | null): session is TwoAiSession {
  return session !== null && !(session instanceof Session);
}
import { TuneChannel } from './tune_channel';

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

/** 参加者画面の WS の URL の ?conversation_kind= と ?timing_strategy=、?vocal_cue=。新しいセッションを作るときだけ使う。 */
interface RequestedInitiative {
  conversation_kind: string | null;
  timing_strategy: string | null;
  vocal_cue: string | null;
}
const NO_REQUEST: RequestedInitiative = { conversation_kind: null, timing_strategy: null, vocal_cue: null };

export class OrchestratorServer {
  readonly http: Server;
  private readonly browserWss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  private readonly researchWss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  private session: AnySession | null = null;
  private sessionSocket: WebSocket | null = null;
  private graceTimer: NodeJS.Timeout | null = null;
  /** hello の処理の列。届いた時点で同期的につなぐ。 */
  private helloQueue: Promise<void> = Promise.resolve();
  private readonly backlog: string[] = [];
  /** 研究者のメモの書き先（I2）。this.session と session_id が一致するときだけ使う。 */
  private noteTarget: NoteTarget | null = null;
  private readonly log: (message: string) => void;
  /** 開発用の調整画面（/research?tune=1）。今のセッションの時計（state の時刻の基準）。 */
  private readonly tune: TuneChannel;
  private sessionTime: TimeSource | null = null;
  /** 試験が閉じたセッションも調べられるように残す。 */
  readonly pastSessions: Session[] = [];
  readonly pastTwoAiSessions: TwoAiSession[] = [];
  /** 研究画面の arm（次の 2 体のセッションに使う。始めたら消す）。 */
  private armed: ResearchTwoAiArm | null = null;
  /** 2 体のモードの設定（最初に要るときに読む。起動の後の設定の書き換えは再起動で反映）。 */
  private twoAiSettings: TwoAiSettingsResult | null = null;
  /** 今の 2 体のセッションの研究画面の伏せ字（1 対 1 は null で何もしない）。 */
  private redaction: RedactionPolicy | null = null;

  constructor(private readonly options: ServerOptions) {
    this.log = options.log ?? ((message) => console.log(`[orchestrator] ${message}`));
    this.tune = new TuneChannel(options.config, () => {
      // 2 体のモードは turn_diagnostic を出さない（TurnManager は受け止めの時機にしか使わない）。
      const session = this.current();
      return session === null || this.sessionTime === null ? null : { session, time: this.sessionTime };
    });
    this.http = createServer((req, res) => this.onHttp(req, res));
    this.http.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (!this.originAllowed(req)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      if (url.pathname === '/ws') {
        this.browserWss.handleUpgrade(req, socket, head, (ws) =>
          this.onBrowser(
            ws,
            url.searchParams.get('condition'),
            {
              conversation_kind: url.searchParams.get('conversation_kind'),
              timing_strategy: url.searchParams.get('timing_strategy'),
              vocal_cue: url.searchParams.get('vocal_cue'),
            },
            url.searchParams.get('mode'),
          ),
        );
      } else if (url.pathname === '/research') {
        this.researchWss.handleUpgrade(req, socket, head, (ws) => this.onResearch(ws, url.searchParams.get('tune') === '1'));
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

  /** 今の 1 対 1 のセッション（2 体のモードでは null）。 */
  current(): Session | null {
    return this.session instanceof Session ? this.session : null;
  }

  /** 今の 2 体のセッション。 */
  currentTwoAi(): TwoAiSession | null {
    return isTwoAi(this.session) ? this.session : null;
  }

  /** 今の参加者のセッション（モードを問わない）。 */
  active(): AnySession | null {
    return this.session;
  }

  /**
   * ブラウザは許可リストの Origin（既定は localhost:3000 の画面）からだけ。Origin のない接続（Node、試験）は
   * 合言葉（ORCHESTRATOR_CLIENT_TOKEN）を明示したときだけ通す。/research は認識文を含むので同じ規則にする。
   */
  private originAllowed(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (origin === undefined) {
      const token = this.options.config.client_token;
      if (token === null) return false;
      const url = new URL(req.url ?? '/', 'http://localhost');
      return url.searchParams.get('token') === token || req.headers['x-orchestrator-token'] === token;
    }
    return this.allowedOrigin(origin);
  }

  private allowedOrigin(origin: string): boolean {
    try {
      return this.options.config.allowed_origins.includes(new URL(origin).origin);
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
      const origin = req.headers.origin;
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        // 許可した画面にだけ CORS を返す（* にしない）。
        ...(origin !== undefined && this.allowedOrigin(origin) ? { 'access-control-allow-origin': origin, vary: 'origin' } : {}),
      });
      res.end(JSON.stringify(body));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found. WS: /ws (participant), /research (researcher feed), GET /health\n');
  }

  // ---- 研究者画面 ----------------------------------------------------------------

  private onResearch(ws: WebSocket, tune = false): void {
    ws.send(JSON.stringify(this.researchConfig()));
    if (tune) this.tune.attach(ws);
    for (const line of this.backlog) ws.send(line);
    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) return;
      const target = this.noteTarget?.session_id === this.active()?.session_id ? this.noteTarget : null;
      const reply = handleResearchMessage(Buffer.from(toBytes(data)).toString('utf8'), target, this.twoAiHandlers());
      if (reply instanceof Promise) {
        reply.then(
          (ack) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(ack));
          },
          (error: unknown) => this.log(`research message failed: ${error instanceof Error ? error.message : String(error)}`),
        );
      } else {
        ws.send(JSON.stringify(reply));
      }
    });
  }

  /** 接続の直後の research.config。1 対 1 は今の形のまま（mode を足さない）。 */
  private researchConfig() {
    const base = researchConfigMessage(this.options.config.policy, this.options.config.condition);
    if (this.options.config.session_mode !== 'two_ai' || base.type !== 'research.config') return base;
    const armed = this.armed;
    return {
      ...base,
      mode: 'two_ai' as const,
      two_ai_armed:
        armed === null ? null : { arm_id: armed.arm_id, condition: armed.condition, script_id: armed.script_id, interjection_feeds_generation: armed.interjection_feeds_generation },
    };
  }

  private twoAiHandlers(): TwoAiResearchHandlers | null {
    if (this.options.config.session_mode !== 'two_ai') return null;
    return { arm: (m) => this.arm(m), woz: (m) => this.woz(m) };
  }

  private async loadTwoAi(): Promise<TwoAiSettingsResult> {
    if (this.twoAiSettings === null) {
      const { loadTwoAiSettings } = await import('../two_ai/settings');
      const { config } = this.options;
      this.twoAiSettings = loadTwoAiSettings({ root: REPO_ROOT, config_path: config.two_ai_config_path, script_path: config.two_ai_script_path });
      if (this.twoAiSettings.ok) for (const r of this.twoAiSettings.settings.rejected) this.log(`two_ai script rejected: ${r.file}: ${r.reason}`);
      else this.log(`two_ai settings invalid: ${this.twoAiSettings.reason}`);
    }
    return this.twoAiSettings;
  }

  /** 研究画面の arm（06 §3、05 §2.2）。セッションの途中は断る。 */
  private async arm(message: ResearchTwoAiArm): Promise<ResearchTwoAiArmAck> {
    const reject = (detail: string): ResearchTwoAiArmAck => ({ type: 'research.two_ai.arm.ack', arm_id: message.arm_id, status: 'rejected', detail });
    const running = this.currentTwoAi();
    if (running !== null && running.attached) return reject('session_running');
    const settings = await this.loadTwoAi();
    if (!settings.ok) return reject(`settings_invalid:${settings.reason}`.slice(0, 200));
    if (!settings.settings.scripts.has(message.script_id)) return reject('unknown_script');
    const env = this.options.env ?? process.env;
    if (this.options.config.tts !== 'test_double' && (!env[TWO_AI_VOICE_ENV.A] || !env[TWO_AI_VOICE_ENV.B])) return reject('voices_not_set');
    this.armed = message;
    this.log(`two_ai armed: ${message.arm_id} condition=${message.condition} script=${message.script_id}`);
    return { type: 'research.two_ai.arm.ack', arm_id: message.arm_id, status: 'armed', detail: 'armed' };
  }

  private woz(message: ResearchWoz): ResearchWozAck {
    const session = this.currentTwoAi();
    if (session === null) return { type: 'research.woz.ack', woz_id: message.woz_id, status: 'no_session', detail: 'not_two_ai_session', phase: null };
    return session.handleWoz(message);
  }

  private broadcast(event: ResearchEvent): void {
    if (this.redaction !== null) {
      // 研究画面へは伏せ字にして配る（06 §4.6）。ログ（JSONL）は伏せない。
      const redacted = redactForResearch(event, this.redaction);
      if (redacted === null) return;
      event = redacted;
    }
    const line = JSON.stringify(event);
    this.tune.observe(event);
    this.backlog.push(line);
    if (this.backlog.length > RESEARCH_BACKLOG) this.backlog.shift();
    for (const client of this.researchWss.clients) {
      if (client.readyState === WebSocket.OPEN && client.bufferedAmount < 4 * 1024 * 1024) client.send(line);
    }
  }

  // ---- 参加者 --------------------------------------------------------------------

  /** requestedCondition は WS の URL の ?condition=（参加者画面の選択）。新しいセッションを作るときだけ使う。 */
  private onBrowser(
    ws: WebSocket,
    requestedCondition: string | null = null,
    requestedInitiative: RequestedInitiative = NO_REQUEST,
    requestedMode: string | null = null,
  ): void {
    let session: AnySession | null = null;
    const link: BrowserLink = {
      sendJson: (message) => {
        if (ws.readyState !== WebSocket.OPEN) return false;
        ws.send(JSON.stringify(message));
        return true;
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
        // 届いた時点で列につなぐ。await の間に別の hello が割り込まない。
        this.helloQueue = this.helloQueue
          .then(() => this.onHello(ws, link, message, requestedCondition, requestedInitiative, requestedMode))
          .then((s) => {
            session = s;
          })
          .catch((error: unknown) => this.log(`hello failed: ${error instanceof Error ? error.message : String(error)}`));
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
      this.scheduleGrace(current);
    });
  }

  /** 切断中のセッションを猶予の後に閉じる。どの経路で切れても（開始の途中を含む）ここを通す。 */
  private scheduleGrace(session: AnySession): void {
    if (this.graceTimer !== null) clearTimeout(this.graceTimer);
    this.log(`browser disconnected; keeping ${session.session_id} for ${this.options.config.resume_grace_ms} ms`);
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      if (this.session === session && !session.attached) void this.endSession('resume_grace_expired');
    }, this.options.config.resume_grace_ms);
  }

  private async onHello(
    ws: WebSocket,
    link: BrowserLink,
    hello: ClientHello,
    requestedCondition: string | null = null,
    requestedInitiative: RequestedInitiative = NO_REQUEST,
    requestedMode: string | null = null,
  ): Promise<AnySession | null> {
    // 列で待つ間に閉じた接続は扱わない。
    if (ws.readyState !== WebSocket.OPEN) return null;
    // 画面の ?mode= は起動の SESSION_MODE と合うときだけ（省略は合うとみなす）。
    if (requestedMode !== null && requestedMode !== '' && requestedMode !== this.options.config.session_mode) {
      this.log(`refused a participant connection: ?mode=${requestedMode.slice(0, 20)} but SESSION_MODE=${this.options.config.session_mode}`);
      ws.close(1008, 'session_mode_mismatch');
      return null;
    }
    const wanted = hello.session_id.value;
    const current = this.session;
    const previousSocket = this.sessionSocket;
    const otherOpen = previousSocket !== null && previousSocket !== ws && previousSocket.readyState === WebSocket.OPEN;

    if (current !== null && wanted === current.session_id) {
      if (previousSocket !== null && previousSocket !== ws) {
        // 同じ Worker の張り直し（古い接続の close がまだ届いていない）。古い方を外す。
        this.sessionSocket = null;
        current.detach('superseded_by_reconnect');
        previousSocket.close(4001, 'superseded by a reconnect of the same session');
      }
      if (this.graceTimer !== null) clearTimeout(this.graceTimer);
      this.graceTimer = null;
      this.sessionSocket = ws;
      current.reattach(link, hello);
      this.log(`browser reattached to ${current.session_id}`);
      return current;
    }
    if (current !== null && current.attached && otherOpen) {
      // 2つ目のタブ。今の会話を守り、新しい側を断る。
      this.log(`refused a second participant connection while ${current.session_id} is attached`);
      ws.close(4000, 'session is open in another tab');
      return null;
    }
    if (current !== null) await this.endSession('new_client_session');
    let session: AnySession | null = null;
    try {
      session = this.options.config.session_mode === 'two_ai' ? await this.createTwoAiSession() : await this.createSession(requestedCondition, requestedInitiative);
      this.session = session;
      this.sessionSocket = ws;
      await session.start(link, hello);
      this.log(`session ${session.session_id} started (condition=${session.condition} stt=${this.options.config.stt} tts=${this.options.config.tts} llm=${this.options.config.llm})`);
      if (ws.readyState !== WebSocket.OPEN && this.session === session && session.attached) {
        // 開始の途中で閉じた。close のハンドラは sessionSocket が決まる前だと何もしないので、ここで猶予を立てる。
        if (this.sessionSocket === ws) this.sessionSocket = null;
        session.detach('closed_during_start');
        this.scheduleGrace(session);
      }
      return session;
    } catch (error) {
      this.log(`session start failed: ${error instanceof Error ? error.message : String(error)}`);
      if (this.sessionSocket === ws) this.sessionSocket = null;
      if (session !== null && this.session === session) await this.endSession('start_failed');
      ws.close(1011, error instanceof TwoAiStartError ? truncateUtf8(error.message, 120) : 'session start failed');
      return null;
    }
  }

  /**
   * セッションの研究条件。画面の求め（?condition=）が正しい値で、CONDITION_FROM_CLIENT が有効ならそれ、なければ CONDITION。
   * 不正な値と無効にした求めは使わず、起動ログに残す。
   */
  private sessionCondition(requested: string | null): Condition {
    const { config } = this.options;
    if (requested === null || requested === '') return config.condition;
    const parsed = Condition.safeParse(requested);
    if (!parsed.success) {
      this.log(`ignored an invalid condition request (${requested.slice(0, 40)}); using ${config.condition}`);
      return config.condition;
    }
    if (!config.condition_from_client) {
      if (parsed.data !== config.condition) this.log(`ignored the participant's condition request (CONDITION_FROM_CLIENT=0); using ${config.condition}`);
      return config.condition;
    }
    return parsed.data;
  }

  /** 会話の種類と方式の選択。画面の求めが正しく *_FROM_CLIENT が有効ならそれ、なければ既定。理由は起動ログと manifest の由来に残す。 */
  private sessionInitiativeChoice(requested: RequestedInitiative): InitiativeChoice {
    const { config } = this.options;
    // 種類の ID は設定ファイルで決まる（形式が正しくてもファイルがなければ既定へ）。
    const kindSchema = { safeParse: (v: unknown): { success: true; data: string } | { success: false } => {
      const parsed = ConversationKind.safeParse(v);
      return parsed.success && existsSync(conversationKindFile(parsed.data)) ? { success: true, data: parsed.data } : { success: false };
    } };
    const kind = this.resolveChoice('conversation_kind', requested.conversation_kind, kindSchema, config.conversation_kind, config.conversation_kind_from_client);
    const timing = this.resolveChoice('timing_strategy', requested.timing_strategy, TimingStrategy, config.timing_strategy, config.timing_strategy_from_client);
    const vocalCue = this.resolveChoice('vocal_cue', requested.vocal_cue, VocalCueMode, config.vocal_cue, config.vocal_cue_from_client);
    return {
      conversation_kind: kind.value,
      conversation_kind_source: kind.source,
      timing_strategy: timing.value,
      timing_strategy_source: timing.source,
      vocal_cue: vocalCue.value,
      vocal_cue_source: vocalCue.source,
    };
  }

  private resolveChoice<T, F>(
    name: string,
    requested: string | null,
    schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } },
    fallback: F,
    fromClient: boolean,
  ): { value: T | F; source: ChoiceSource } {
    if (requested === null || requested === '') return { value: fallback, source: 'default' };
    const parsed = schema.safeParse(requested);
    if (!parsed.success) {
      this.log(`ignored an invalid ${name} request (${requested.slice(0, 40)}); using ${String(fallback)}`);
      return { value: fallback, source: 'default' };
    }
    if (!fromClient) {
      if (parsed.data !== (fallback as unknown)) this.log(`ignored the participant's ${name} request (${name.toUpperCase()}_FROM_CLIENT=0); using ${String(fallback)}`);
      return { value: fallback, source: 'fixed' };
    }
    return { value: parsed.data, source: 'client' };
  }

  private async createSession(requestedCondition: string | null = null, requestedInitiative: RequestedInitiative = NO_REQUEST): Promise<Session> {
    const { config } = this.options;
    const condition = this.sessionCondition(requestedCondition);
    const session_id = newSessionId();
    const time = new SystemTimeSource();
    const logging = await openSessionLogging({
      dir: config.sessions_dir,
      session_id,
      time,
      condition: () => condition,
      // 台本のプロバイダが1つでもあれば、このセッションのログは test_double（受け入れの証拠に数えない）。
      provider_class: [config.stt, config.tts, config.llm].includes('test_double') ? 'test_double' : 'production',
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
    this.tune.resetSession();
    this.sessionTime = time;
    this.noteTarget = { session_id, emitter };
    // 方策の上書き（POLICY_OVERRIDE_FILE）を manifest に残す。manifest は session が describe で書くので、その口に足す。
    const describe = logging.log.describe.bind(logging.log);
    logging.log.describe = (details) =>
      describe({ ...details, policy_file: config.policy_file, policy_override: config.policy_override } as typeof details);
    this.options.maaiTime?.use(time);
    const providers = await createSessionProviders({
      config,
      condition,
      time,
      emitter,
      choice: this.sessionInitiativeChoice(requestedInitiative),
      ...(this.options.env ? { env: this.options.env } : {}),
    });
    return new Session({
      session_id,
      condition,
      policy: config.policy,
      time,
      emitter,
      log: logging.log,
      providers,
      maai: this.options.maai,
      ...(this.options.maaiUnavailableReason ? { maaiUnavailableReason: this.options.maaiUnavailableReason } : {}),
    });
  }

  /** 2 体のセッション（docs/design/two_ai/01 §1.1）。条件は arm、なければ TWO_AI_CONDITION。どちらもなければ始めない。 */
  private async createTwoAiSession(): Promise<TwoAiSession> {
    const { config } = this.options;
    const loaded = await this.loadTwoAi();
    const { TwoAiSession } = await import('../two_ai/two_ai_session');
    const { loadDiscussionAssets } = await import('../cognition/discussion');
    if (!loaded.ok) throw new TwoAiStartError(`two_ai settings invalid: ${loaded.reason}`);
    const settings = loaded.settings;
    const arm = this.armed;
    const condition: TwoAiCondition | null = arm?.condition ?? config.two_ai_condition;
    if (condition === null) throw new TwoAiStartError('two_ai condition not set');
    const script_id = arm?.script_id ?? settings.default_script_id;
    const script = script_id === null ? undefined : settings.scripts.get(script_id);
    if (script === undefined) throw new TwoAiStartError(script_id === null ? 'two_ai script not set' : `two_ai unknown script: ${script_id}`);
    const session_id = newSessionId();
    const time = new SystemTimeSource();
    // セッションを作る前（ログの開始の provider.status）も 2 体の封筒を付ける（06 §4.1：2 体のセッションのすべてのイベント）。
    let context: () => TwoAiEmitContext | null = () => ({ phase: 'intake', discussion_stage: null, script_variant: 'original' });
    const logging = await openSessionLogging({
      dir: config.sessions_dir,
      session_id,
      time,
      condition: () => condition,
      two_ai_context: () => context(),
      provider_class: [config.stt, config.tts, config.llm].includes('test_double') ? 'test_double' : 'production',
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
    this.tune.resetSession();
    this.sessionTime = time;
    this.noteTarget = { session_id, emitter };
    this.redaction = { hide_point_texts: script.script.hide_points_on_research_screen };
    this.options.maaiTime?.use(time);
    const personas = loadDiscussionAssets(settings.root, settings.config, script.script.personas_file).personas;
    const providers = await createTwoAiProviders({ config, twoAi: settings.config, personas, time, emitter, ...(this.options.env ? { env: this.options.env } : {}) });
    if (!providers.ok) {
      await logging.log.close();
      throw new TwoAiStartError(`two_ai providers: ${providers.reason}`);
    }
    this.armed = null;
    return new TwoAiSession({
      session_id,
      condition,
      condition_source: arm !== null ? 'research_screen' : 'env',
      arm:
        arm === null
          ? null
          : { arm_id: arm.arm_id, interjection_feeds_generation: arm.interjection_feeds_generation, session_index: arm.session_index, counterbalance_label: arm.counterbalance_label },
      policy: config.policy,
      time,
      emitter,
      bindEmitContext: (c) => {
        context = c;
      },
      log: logging.log,
      settings,
      script,
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
    if (isTwoAi(session)) this.pastTwoAiSessions.push(session);
    else this.pastSessions.push(session);
    await session.close(reason);
    this.log(`session ${session.session_id} closed (${reason})`);
  }

  async close(): Promise<void> {
    await this.endSession('server_shutdown');
    for (const client of this.browserWss.clients) client.terminate();
    for (const client of this.researchWss.clients) client.terminate();
    this.tune.close();
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }
}

/** WS の close の理由は 123 バイトまで。 */
function truncateUtf8(text: string, maxBytes: number): string {
  let out = text;
  while (Buffer.byteLength(out, 'utf8') > maxBytes) out = out.slice(0, -1);
  return out;
}

function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}
