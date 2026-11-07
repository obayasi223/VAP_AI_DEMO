/**
 * OrchestratorServer の接続の規則（指摘 7、8、9）。実際の WS で、台本のプロバイダと MaAI なしで動かす。
 */
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { readConfig } from '../../src/app/config';
import { OrchestratorServer } from '../../src/ws/server';
import { hello } from './helpers';

let dir: string;
let server: OrchestratorServer;
let url: string;
const sockets: WebSocket[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(what: string, probe: () => T | null | undefined | false, timeoutMs = 3000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > until) throw new Error(`timed out: ${what}`);
    await sleep(10);
  }
}

function connect(): Promise<{ ws: WebSocket; closed: Promise<number>; messages: { type: string; session_id?: string }[] }> {
  const ws = new WebSocket(`${url}/ws`, { headers: { origin: 'http://localhost:3000' } });
  sockets.push(ws);
  const messages: { type: string; session_id?: string }[] = [];
  ws.on('message', (data, isBinary) => {
    if (!isBinary) messages.push(JSON.parse(String(data)));
  });
  const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve({ ws, closed, messages }));
    ws.once('error', reject);
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orch-server-'));
  const config = readConfig({
    STT_PROVIDER_CLASS: 'test_double',
    TTS_PROVIDER_CLASS: 'test_double',
    LLM_PROVIDER_CLASS: 'test_double',
    SESSIONS_DIR: dir,
    SESSION_RESUME_GRACE_MS: '200',
    ORCHESTRATOR_PORT: '0',
    ORCHESTRATOR_HOST: '127.0.0.1',
    MAAI_ENABLED: '0',
    ORCHESTRATOR_CLIENT_TOKEN: 'test-token',
  });
  server = new OrchestratorServer({ config, maai: null, maaiUnavailableReason: 'test', log: () => undefined });
  const port = await server.listen();
  url = `ws://127.0.0.1:${port}`;
});

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  await server.close();
  await rm(dir, { recursive: true, force: true });
});

const sessionDirs = async () => (await readdir(dir)).filter((name) => name.startsWith('s'));

function tryConnect(path: string, headers: Record<string, string>): Promise<'open' | number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${url}${path}`, { headers });
    sockets.push(ws);
    ws.once('open', () => resolve('open'));
    ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    ws.once('error', () => resolve(-1));
  });
}

describe('入口の制限（Origin）', () => {
  it('許可した画面の Origin だけ通す。Origin のない接続は合言葉があるときだけ', async () => {
    expect(await tryConnect('/ws', { origin: 'http://localhost:3000' })).toBe('open');
    expect(await tryConnect('/research', { origin: 'http://127.0.0.1:3000' })).toBe('open');
    expect(await tryConnect('/ws', { origin: 'http://localhost:4000' })).toBe(403);
    expect(await tryConnect('/research', { origin: 'http://evil.example' })).toBe(403);
    expect(await tryConnect('/research', {})).toBe(403);
    expect(await tryConnect('/research?token=wrong', {})).toBe(403);
    expect(await tryConnect('/research?token=test-token', {})).toBe('open');
    expect(await tryConnect('/ws', { 'x-orchestrator-token': 'test-token' })).toBe('open');
  });

  it('/health の CORS は許可した Origin にだけ返す', async () => {
    const http = url.replace('ws://', 'http://');
    const ok = await fetch(`${http}/health`, { headers: { origin: 'http://localhost:3000' } });
    expect(ok.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
    const other = await fetch(`${http}/health`, { headers: { origin: 'http://evil.example' } });
    expect(other.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('OrchestratorServer の接続', () => {
  it('hello が同時に届いても、セッションは1つだけ作り、2つ目の接続を断る（指摘 7）', async () => {
    const a = await connect();
    const b = await connect();
    a.ws.send(JSON.stringify(hello()));
    b.ws.send(JSON.stringify(hello()));
    const code = await Promise.race([a.closed, b.closed]);
    expect(code).toBe(4000);
    await sleep(100);
    expect(await sessionDirs()).toHaveLength(1);
    expect(server.pastSessions).toHaveLength(0);
    expect(server.current()?.attached).toBe(true);
  });

  it('2つ目のタブは断り、1つ目の会話を続ける（指摘 8）', async () => {
    const a = await connect();
    a.ws.send(JSON.stringify(hello()));
    const first = await waitFor('first session', () => server.current());
    await waitFor('server.hello', () => a.messages.find((m) => m.type === 'server.hello'));
    const b = await connect();
    b.ws.send(JSON.stringify(hello()));
    expect(await b.closed).toBe(4000);
    expect(server.current()).toBe(first);
    expect(first.attached).toBe(true);
    expect(a.ws.readyState).toBe(WebSocket.OPEN);
  });

  it('同じセッションの張り直しは、古い接続の close が届く前でも新しい接続を採る', async () => {
    const a = await connect();
    a.ws.send(JSON.stringify(hello()));
    const first = await waitFor('first session', () => server.current());
    const b = await connect();
    b.ws.send(JSON.stringify(hello(first.session_id)));
    expect(await a.closed).toBe(4001);
    await waitFor('reattached', () => first.attached && server.current() === first);
    expect(b.ws.readyState).toBe(WebSocket.OPEN);
  });

  it('開始の途中で接続が切れても、猶予の後にセッションを閉じる（指摘 9）', async () => {
    const a = await connect();
    a.ws.send(JSON.stringify(hello()));
    a.ws.terminate();
    await waitFor('session created', () => server.current() ?? server.pastSessions[0]);
    await waitFor('session closed after grace', () => server.current() === null && server.pastSessions.length === 1, 3000);
  });

  it('切断中のセッションへ新しいセッションの hello が来たら、古い方を閉じて始める', async () => {
    const a = await connect();
    a.ws.send(JSON.stringify(hello()));
    const first = await waitFor('first session', () => server.current());
    a.ws.terminate();
    await waitFor('detached', () => !first.attached);
    const b = await connect();
    b.ws.send(JSON.stringify(hello()));
    const second = await waitFor('second session', () => (server.current() !== first ? server.current() : null));
    expect(second).not.toBe(first);
    expect(server.pastSessions).toContain(first);
  });
});
