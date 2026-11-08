/**
 * 評価画面のローカルサーバ。127.0.0.1 だけで待ち受け、Host と送信元も 127.0.0.1／localhost に限る（/tune の dev_server と同じ守り）。
 * 外部へは何も送らない。CORS は返さない（画面はこのサーバ自身から配る）。
 *
 *   GET  /                                 画面（public/）
 *   GET  /api/sessions?conversation_type=&prompt_version=  セッションの一覧と絞り込みの選択肢
 *   GET  /api/sessions/<id>?conversation_type=&prompt_version=  判定、会話、音声の情報
 *   GET  /api/sessions/<id>/audio/<name>   音声（Range 対応）
 *   GET  /api/sessions/<id>/audio_timeline?center_sec=&span_sec=&bins=  波形と、同じ時間軸の印（保存した音声があるときだけ）
 *   GET  /api/sessions/<id>/reviewers      評価者の名前
 *   GET  /api/sessions/<id>/reviews/<名前>  評価を読み戻す
 *   PUT  /api/sessions/<id>/reviews/<名前>  {base_revision, items, missed}。revision が合わないと 409
 */
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';
import { ReviewConflict, ReviewInvalid, ReviewStore } from './reviews';
import { audioTimeline, loadMarks } from './audio_timeline';
import { SESSION_ID, eventsStamp, filterItems, filterOptions, listAudioFiles, listSessionDirs, loadSession, sessionMatches } from './session';
import type { ItemFilter, ReviewSession } from './model';

const LOOPBACK = '127.0.0.1';
const MAX_BODY = 8 * 1024 * 1024;
const PUBLIC_DIR = path.join(import.meta.dirname, '..', 'public');
const STATIC_FILES: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/audio_timeline.js': { file: 'audio_timeline.js', type: 'text/javascript; charset=utf-8' },
  '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
};
const AUDIO_TYPES: Record<string, string> = {
  '.wav': 'audio/wav',
  '.webm': 'audio/webm',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface ReviewServerOptions {
  sessions_dir: string;
  port: number;
  log?: (message: string) => void;
}

export class ReviewServer {
  readonly http: Server;
  readonly store: ReviewStore;
  private port = 0;
  private readonly cache = new Map<string, { stamp: string; session: ReviewSession }>();
  private readonly marksCache = new Map<string, { stamp: string; built: ReturnType<typeof loadMarks> }>();
  private readonly log: (message: string) => void;

  constructor(private readonly options: ReviewServerOptions) {
    this.store = new ReviewStore(options.sessions_dir);
    this.log = options.log ?? ((m) => console.log(`[initiative_review] ${m}`));
    this.http = createServer((req, res) => {
      void this.handle(req, res).catch((error: unknown) => {
        if (error instanceof ReviewConflict) return this.json(res, 409, { error: 'conflict', current: error.current });
        if (error instanceof ReviewInvalid) return this.json(res, 400, { error: error.message });
        const status = error instanceof HttpError ? error.status : 500;
        const message = error instanceof Error ? error.message : String(error);
        if (status === 500) this.log(`error: ${message}`);
        return this.json(res, status, { error: message });
      });
    });
  }

  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.http.once('error', reject);
      this.http.listen(this.options.port, LOOPBACK, () => {
        const address = this.http.address();
        this.port = typeof address === 'object' && address !== null ? address.port : this.options.port;
        resolve(this.port);
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.http.close(() => resolve());
      this.http.closeAllConnections();
    });
  }

  private hostOk(host: string | undefined): boolean {
    if (host === undefined) return false;
    return host === `127.0.0.1:${this.port}` || host === `localhost:${this.port}`;
  }

  private originOk(origin: string | undefined): boolean {
    if (origin === undefined) return true;
    return origin === `http://127.0.0.1:${this.port}` || origin === `http://localhost:${this.port}`;
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    if (res.headersSent) {
      res.end();
      return;
    }
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.hostOk(req.headers.host)) throw new HttpError(403, 'host not allowed');
    if (!this.originOk(req.headers.origin)) throw new HttpError(403, 'origin not allowed');
    const remote = req.socket.remoteAddress ?? '';
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) throw new HttpError(403, 'loopback only');
    const url = new URL(req.url ?? '/', `http://${LOOPBACK}`);
    const parts = url.pathname.split('/').filter((p) => p !== '');
    if (req.method === 'GET' && url.pathname in STATIC_FILES) return this.serveStatic(res, url.pathname);
    if (parts[0] !== 'api' || parts[1] !== 'sessions') throw new HttpError(404, 'not found');
    const filter: ItemFilter = {
      conversation_type: url.searchParams.get('conversation_type') ?? undefined,
      prompt_version: url.searchParams.get('prompt_version') ?? undefined,
    };
    if (parts.length === 2 && req.method === 'GET') return this.json(res, 200, this.listSessions(filter));
    const id = parts[2] ?? '';
    if (!SESSION_ID.test(id)) throw new HttpError(400, 'bad session id');
    if (parts.length === 3 && req.method === 'GET') return this.json(res, 200, this.getSession(id, filter));
    if (parts[3] === 'audio' && parts.length === 5 && req.method === 'GET') return this.serveAudio(req, res, id, parts[4] as string);
    if (parts[3] === 'audio_timeline' && parts.length === 4 && req.method === 'GET') {
      const number = (name: string, fallback: number) => {
        const value = Number(url.searchParams.get(name) ?? fallback);
        return Number.isFinite(value) ? value : fallback;
      };
      return this.json(res, 200, this.audioTimeline(id, number('center_sec', 0), number('span_sec', 20), number('bins', 800)));
    }
    if (parts[3] === 'reviewers' && parts.length === 4 && req.method === 'GET') return this.json(res, 200, this.store.reviewers(id));
    if (parts[3] === 'reviews' && parts.length === 5) {
      const reviewer = decodePart(parts[4] as string);
      if (req.method === 'GET') {
        const document = this.store.load(id, reviewer);
        if (document === null) throw new HttpError(404, 'no review');
        return this.json(res, 200, document);
      }
      if (req.method === 'PUT') {
        if (!(req.headers['content-type'] ?? '').startsWith('application/json')) throw new HttpError(415, 'json only');
        const body = (await readJson(req)) as { base_revision?: unknown };
        if (typeof body.base_revision !== 'number') throw new HttpError(400, 'base_revision required');
        return this.json(res, 200, this.store.save(id, reviewer, body, body.base_revision));
      }
    }
    throw new HttpError(404, 'not found');
  }

  private serveStatic(res: ServerResponse, pathname: string): void {
    const entry = STATIC_FILES[pathname] as { file: string; type: string };
    res.writeHead(200, { 'content-type': entry.type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(readFileSync(path.join(PUBLIC_DIR, entry.file)));
  }

  private sessionDir(id: string): string {
    const root = path.resolve(this.options.sessions_dir);
    const dir = path.join(root, id);
    if (path.dirname(dir) !== root || !existsSync(path.join(dir, 'events.jsonl'))) throw new HttpError(404, 'unknown session');
    return dir;
  }

  session(id: string): ReviewSession {
    const dir = this.sessionDir(id);
    const stamp = eventsStamp(dir);
    const cached = this.cache.get(id);
    if (cached !== undefined && cached.stamp === stamp) return cached.session;
    const session = loadSession(dir);
    this.cache.set(id, { stamp, session });
    return session;
  }

  private listSessions(filter: ItemFilter) {
    const metas = listSessionDirs(this.options.sessions_dir).map((id) => this.session(id).meta);
    return { sessions: metas.filter((m) => sessionMatches(m, filter)), options: filterOptions(metas) };
  }

  private audioTimeline(id: string, center_sec: number, span_sec: number, bins: number) {
    const dir = this.sessionDir(id);
    const stamp = eventsStamp(dir);
    let cached = this.marksCache.get(id);
    if (cached === undefined || cached.stamp !== stamp) {
      cached = { stamp, built: loadMarks(dir) };
      this.marksCache.set(id, cached);
    }
    return audioTimeline(dir, { center_sec, span_sec, bins }, cached.built);
  }

  private getSession(id: string, filter: ItemFilter) {
    const session = this.session(id);
    return { ...session, items: filterItems(session.items, filter) };
  }

  private serveAudio(req: IncomingMessage, res: ServerResponse, id: string, rawName: string): void {
    const name = decodePart(rawName);
    const dir = this.sessionDir(id);
    if (!listAudioFiles(dir).includes(name)) throw new HttpError(404, 'no such audio');
    const file = path.join(dir, name);
    const size = statSync(file).size;
    const type = AUDIO_TYPES[path.extname(name).toLowerCase()] ?? 'application/octet-stream';
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    if (range !== null && !(range[1] === '' && range[2] === '')) {
      const suffix = range[1] === '';
      const start = suffix ? Math.max(0, size - Number(range[2])) : Number(range[1]);
      const end = suffix || range[2] === '' ? size - 1 : Math.min(Number(range[2]), size - 1);
      if (start >= size || start > end) {
        res.writeHead(416, { 'content-range': `bytes */${size}` });
        res.end();
        return;
      }
      res.writeHead(206, { 'content-type': type, 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1, 'cache-control': 'no-store' });
      createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': size, 'cache-control': 'no-store' });
    createReadStream(file).pipe(res);
  }
}

function decodePart(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    throw new HttpError(400, 'bad path');
  }
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY) {
        reject(new HttpError(413, 'too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'invalid json'));
      }
    });
  });
}
