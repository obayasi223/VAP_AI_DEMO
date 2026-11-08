/**
 * 開発用の HTTP の口（調整画面 /tune の録音の再生）。参加者の経路（ws/server.ts の /ws）とは別のプロセス・別のポート。
 *
 *   GET  /dev/sessions                 ローカルの sessions/ の一覧（manifest の要約）
 *   GET  /dev/sessions/<id>/events     events.jsonl の本文（利用者の発話を含む。画面に出すだけで外へ送らない）
 *   GET  /dev/policy                   正本（config/policy.ja.json）、HEAD の版、上書きファイル、項目の一覧（スキーマから列挙）
 *   POST /dev/replay                   {session_id, policy, options?, recorded_policy?} → 再計算（TuneReplayResult）
 *   POST /dev/policy/local             {policy} → 正本との差分を config/policy.ja.local.json に書く（正本は書き換えない）
 *
 * 受け付けるのは 127.0.0.1 の待ち受けへの、Host が 127.0.0.1／localhost で、Origin が許可リスト（ALLOWED_ORIGINS と
 * 同じ）か Origin なし（同じ機械の curl など）の要求だけ。CORS は許可した Origin にだけ返す。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';
import { Policy } from '@llm-vap/contracts';
import type { PolicyJa, TuneReplayResult, TuneSessionSummary, TuneTurnOutcomes } from '@llm-vap/contracts';
import { parsePersona, type InitiativePersona } from '../cognition/initiative';
import { initiativeTriggerReport } from './initiative_trigger';
import { applyOverride, diffOverride, overrideKeys } from './policy_override';
import { policyJsonSchema, policyLeaves } from './policy_schema';
import { parseEventsJsonl, prepareLog, replay, type PreparedLog, type ReplayOptions } from './replay';

export const LOCAL_POLICY_FILE = 'config/policy.ja.local.json';
const SESSION_ID = /^[A-Za-z0-9_-]{1,100}$/;
const MAX_BODY = 4 * 1024 * 1024;

export interface DevServerOptions {
  repo_root: string;
  sessions_dir: string;
  /** 正本の方策（repo_root からの相対、または絶対）。 */
  policy_file: string;
  persona_file: string;
  allowed_origins: string[];
  host?: string;
  port: number;
  /** 上書きの書き先（既定 config/policy.ja.local.json）。試験で変える。 */
  local_policy_file?: string;
  log?: (message: string) => void;
}

interface CachedLog {
  mtimeMs: number;
  size: number;
  prepared: PreparedLog;
  invalid: number;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class DevServer {
  readonly http: Server;
  private readonly cache = new Map<string, CachedLog>();
  private port: number;
  private readonly log: (message: string) => void;

  constructor(private readonly options: DevServerOptions) {
    this.port = options.port;
    this.log = options.log ?? ((m) => console.log(`[dev] ${m}`));
    this.http = createServer((req, res) => {
      void this.handle(req, res).catch((error: unknown) => {
        const status = error instanceof HttpError ? error.status : 500;
        const message = error instanceof Error ? error.message : String(error);
        if (status === 500) this.log(`error: ${message}`);
        this.send(req, res, status, { error: message });
      });
    });
  }

  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.http.once('error', reject);
      this.http.listen(this.options.port, this.options.host ?? '127.0.0.1', () => {
        const address = this.http.address();
        this.port = typeof address === 'object' && address !== null ? address.port : this.options.port;
        resolve(this.port);
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.http.close(() => resolve()));
  }

  // ---- 入口の検査 ----------------------------------------------------------------

  private originOk(origin: string | undefined): boolean {
    if (origin === undefined) return true;
    try {
      return this.options.allowed_origins.includes(new URL(origin).origin);
    } catch {
      return false;
    }
  }

  /** DNS の付け替え（rebinding）対策。Host は 127.0.0.1／localhost／[::1] だけ。 */
  private hostOk(host: string | undefined): boolean {
    if (host === undefined) return false;
    const name = host.replace(/:\d+$/, '');
    return name === '127.0.0.1' || name === 'localhost' || name === '[::1]';
  }

  private cors(req: IncomingMessage): Record<string, string> {
    const origin = req.headers.origin;
    if (origin === undefined || !this.originOk(origin)) return {};
    return {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      vary: 'origin',
    };
  }

  private send(req: IncomingMessage, res: ServerResponse, status: number, body: unknown, type = 'application/json; charset=utf-8'): void {
    if (res.headersSent) return;
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...this.cors(req) });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.hostOk(req.headers.host)) throw new HttpError(403, 'host not allowed');
    if (!this.originOk(req.headers.origin)) throw new HttpError(403, 'origin not allowed');
    const remote = req.socket.remoteAddress ?? '';
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) throw new HttpError(403, 'loopback only');
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, this.cors(req));
      res.end();
      return;
    }
    const parts = url.pathname.split('/').filter((p) => p !== '');
    if (req.method === 'GET' && url.pathname === '/dev/sessions') return this.send(req, res, 200, this.listSessions());
    if (req.method === 'GET' && parts[0] === 'dev' && parts[1] === 'sessions' && parts[3] === 'events' && parts.length === 4) {
      return this.send(req, res, 200, readFileSync(this.sessionFile(parts[2] as string, 'events.jsonl'), 'utf8'), 'application/x-ndjson; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/dev/policy') return this.send(req, res, 200, this.policyInfo());
    if (req.method === 'POST' && url.pathname === '/dev/replay') return this.send(req, res, 200, await this.replay(await readJson(req)));
    if (req.method === 'POST' && url.pathname === '/dev/policy/local') return this.send(req, res, 200, this.saveLocal(await readJson(req)));
    throw new HttpError(404, 'not found. GET /dev/sessions, /dev/sessions/<id>/events, /dev/policy; POST /dev/replay, /dev/policy/local');
  }

  // ---- セッション ----------------------------------------------------------------

  private sessionFile(id: string, name: 'events.jsonl' | 'manifest.json'): string {
    if (!SESSION_ID.test(id)) throw new HttpError(400, 'bad session id');
    const dir = path.join(this.options.sessions_dir, id);
    if (path.dirname(dir) !== path.resolve(this.options.sessions_dir)) throw new HttpError(400, 'bad session id');
    const file = path.join(dir, name);
    if (!existsSync(file)) throw new HttpError(404, `${name} not found for ${id}`);
    return file;
  }

  listSessions(): TuneSessionSummary[] {
    const dir = this.options.sessions_dir;
    if (!existsSync(dir)) return [];
    const out: TuneSessionSummary[] = [];
    for (const id of readdirSync(dir)) {
      if (!SESSION_ID.test(id)) continue;
      const events = path.join(dir, id, 'events.jsonl');
      if (!existsSync(events)) continue;
      let manifest: Record<string, unknown> = {};
      try {
        manifest = JSON.parse(readFileSync(path.join(dir, id, 'manifest.json'), 'utf8')) as Record<string, unknown>;
      } catch {
        // manifest がない・壊れている（書き込みの途中）。一覧には出す。
      }
      const providers = (manifest.providers ?? {}) as Record<string, { provider_class?: unknown }>;
      const override = manifest.policy_override as TuneSessionSummary['policy_override'] | undefined;
      out.push({
        session_id: id,
        started_wall_clock: typeof manifest.started_wall_clock === 'string' ? manifest.started_wall_clock : null,
        closed: typeof manifest.closed === 'boolean' ? manifest.closed : null,
        condition: typeof manifest.condition === 'string' ? manifest.condition : null,
        policy_id: typeof manifest.policy_id === 'string' ? manifest.policy_id : null,
        provider_classes: Object.fromEntries(Object.entries(providers).map(([k, v]) => [k, String(v?.provider_class ?? '?')])),
        events_bytes: statSync(events).size,
        policy_override: override ?? null,
      });
    }
    return out.sort((a, b) => b.session_id.localeCompare(a.session_id));
  }

  private loadLog(id: string): CachedLog {
    const file = this.sessionFile(id, 'events.jsonl');
    const stat = statSync(file);
    const cached = this.cache.get(id);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached;
    const parsed = parseEventsJsonl(readFileSync(file, 'utf8'));
    const entry = { mtimeMs: stat.mtimeMs, size: stat.size, prepared: prepareLog(parsed.events), invalid: parsed.invalid };
    this.cache.set(id, entry);
    if (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value as string);
    return entry;
  }

  // ---- 方策 ----------------------------------------------------------------------

  private policyPath(): string {
    return path.resolve(this.options.repo_root, this.options.policy_file);
  }

  private localPath(): string {
    return path.resolve(this.options.repo_root, this.options.local_policy_file ?? LOCAL_POLICY_FILE);
  }

  currentPolicy(): Policy {
    return Policy.parse(JSON.parse(readFileSync(this.policyPath(), 'utf8')));
  }

  /** git の HEAD の正本（録音したときの方策の候補。決定性の確認に使う）。読めなければ null と理由。 */
  headPolicy(): { policy: Policy | null; ref: string | null; error: string | null } {
    const rel = path.relative(this.options.repo_root, this.policyPath());
    try {
      const ref = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: this.options.repo_root, encoding: 'utf8' }).trim();
      const text = execFileSync('git', ['show', `HEAD:${rel}`], { cwd: this.options.repo_root, encoding: 'utf8' });
      const parsed = Policy.safeParse(JSON.parse(text));
      return parsed.success
        ? { policy: parsed.data, ref, error: null }
        : { policy: null, ref, error: `HEAD の方策が今の契約に合わない: ${parsed.error.issues[0]?.message ?? ''}` };
    } catch (error) {
      return { policy: null, ref: null, error: error instanceof Error ? error.message.split('\n')[0] ?? 'git failed' : String(error) };
    }
  }

  policyInfo() {
    const current = this.currentPolicy();
    const head = this.headPolicy();
    let local: { file: string; override: unknown; keys: string[]; policy: Policy | null; error: string | null } | null = null;
    if (existsSync(this.localPath())) {
      try {
        const override: unknown = JSON.parse(readFileSync(this.localPath(), 'utf8'));
        const checked = applyOverride(current, override);
        local = checked.ok
          ? { file: this.localPath(), override, keys: checked.keys, policy: checked.policy, error: null }
          : { file: this.localPath(), override, keys: overrideKeys(override), policy: null, error: checked.reason };
      } catch (error) {
        local = { file: this.localPath(), override: null, keys: [], policy: null, error: error instanceof Error ? error.message : String(error) };
      }
    }
    return {
      current: { file: this.policyPath(), policy: current },
      head,
      local,
      leaves: policyLeaves(current),
      json_schema: policyJsonSchema(current),
      local_file: this.localPath(),
    };
  }

  private persona(): InitiativePersona | null {
    try {
      return parsePersona(JSON.parse(readFileSync(path.resolve(this.options.repo_root, this.options.persona_file), 'utf8')));
    } catch {
      return null;
    }
  }

  async replay(body: unknown): Promise<TuneReplayResult & { outcomes: TuneTurnOutcomes }> {
    const request = body as { session_id?: unknown; policy?: unknown; options?: ReplayOptions; recorded_policy?: unknown };
    if (typeof request.session_id !== 'string') throw new HttpError(400, 'session_id is required');
    const parsed = Policy.safeParse(request.policy);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new HttpError(400, `policy: ${issue ? `${issue.path.join('.')}: ${issue.message}` : 'invalid'}`);
    }
    const policy = parsed.data;
    const log = this.loadLog(request.session_id);
    const options: ReplayOptions = {};
    const o = request.options ?? {};
    if (typeof o.assumed_prepare_ms === 'number' && o.assumed_prepare_ms >= 0) options.assumed_prepare_ms = o.assumed_prepare_ms;
    if (typeof o.assumed_speech_ms === 'number' && o.assumed_speech_ms >= 0) options.assumed_speech_ms = o.assumed_speech_ms;
    const result = replay(log.prepared, policy, options);
    const recordedChoice = request.recorded_policy === 'current' ? this.currentPolicy() : (this.headPolicy().policy ?? this.currentPolicy());
    const initiative = await initiativeTriggerReport(
      log.prepared.events,
      recordedChoice.policy_id === 'ja' ? (recordedChoice as PolicyJa) : null,
      policy.policy_id === 'ja' ? (policy as PolicyJa) : null,
      this.persona(),
    );
    if (log.invalid > 0) result.warnings.push(`契約に合わない行 ${log.invalid} 件を読み飛ばした`);
    return { ...result, initiative };
  }

  saveLocal(body: unknown): { file: string; keys: string[]; override: unknown } {
    const request = body as { policy?: unknown };
    const current = this.currentPolicy();
    const parsed = Policy.safeParse(request.policy);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new HttpError(400, `policy: ${issue ? `${issue.path.join('.')}: ${issue.message}` : 'invalid'}`);
    }
    const override = diffOverride(current, parsed.data) ?? {};
    const checked = applyOverride(current, override);
    if (!checked.ok) throw new HttpError(400, checked.reason);
    // 上書きは重ねるだけで、正本の項目を消せない（省いた節など）。重ねた結果が画面の方策と違うなら保存しない。
    if (JSON.stringify(checked.policy) !== JSON.stringify(parsed.data)) {
      throw new HttpError(400, 'the override cannot remove items present in the base policy (e.g. an omitted optional section); edit config/policy.ja.json instead');
    }
    writeFileSync(this.localPath(), `${JSON.stringify(override, null, 2)}\n`);
    this.log(`wrote ${this.localPath()} (${checked.keys.length} items)`);
    return { file: this.localPath(), keys: checked.keys, override };
  }
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const type = req.headers['content-type'] ?? '';
    if (!type.startsWith('application/json')) {
      reject(new HttpError(415, 'content-type must be application/json'));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'body is not JSON'));
      }
    });
    req.on('error', reject);
  });
}
