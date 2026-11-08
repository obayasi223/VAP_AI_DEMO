/**
 * 開発用の HTTP の口（dev/dev_server.ts）。127.0.0.1 と許可した Origin だけ、参加者の経路とは別。
 * セッションは試験で作った合成のもの（実のログは使わない）。
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PolicyJa } from '@llm-vap/contracts';
import { DevServer } from '../../src/dev/dev_server';
import { productionJaPolicy, repoRoot } from '../session/helpers';

const ALLOWED = 'http://localhost:3481';
let server: DevServer;
let port = 0;
let dir = '';
const local = () => join(dir, 'policy.local.json');

function call(path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers: { host: `127.0.0.1:${port}`, ...options.headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
    });
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dev-server-'));
  const sessions = join(dir, 'sessions');
  mkdirSync(join(sessions, 's_synthetic'), { recursive: true });
  writeFileSync(join(sessions, 's_synthetic', 'manifest.json'), JSON.stringify({ session_id: 's_synthetic', condition: 'reactive', policy_id: 'ja', closed: true }));
  writeFileSync(join(sessions, 's_synthetic', 'events.jsonl'), '');
  server = new DevServer({
    repo_root: repoRoot,
    sessions_dir: sessions,
    policy_file: 'config/policy.ja.json',
    persona_file: 'config/persona.ja.json',
    allowed_origins: [ALLOWED],
    port: 0,
    local_policy_file: local(),
    log: () => undefined,
  });
  port = await server.listen();
});

afterAll(async () => {
  await server.close();
});

describe('入口の検査', () => {
  it('許可した Origin と Origin なしは通し、ほかの Origin は 403', async () => {
    expect((await call('/dev/sessions')).status).toBe(200);
    const ok = await call('/dev/sessions', { headers: { origin: ALLOWED } });
    expect(ok.status).toBe(200);
    expect(ok.headers['access-control-allow-origin']).toBe(ALLOWED);
    const bad = await call('/dev/sessions', { headers: { origin: 'http://evil.example' } });
    expect(bad.status).toBe(403);
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('Host が loopback でなければ 403（DNS の付け替え対策）', async () => {
    expect((await call('/dev/sessions', { headers: { host: 'evil.example:80' } })).status).toBe(403);
  });

  it('セッション名に路の文字は使えない', async () => {
    expect((await call('/dev/sessions/..%2F..%2Fetc/events')).status).toBeGreaterThanOrEqual(400);
  });

  it('JSON 以外の本文は 415、方策が契約に合わなければ 400', async () => {
    expect((await call('/dev/replay', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' })).status).toBe(415);
    const bad = await call('/dev/replay', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: 's_synthetic', policy: { policy_id: 'ja' } }) });
    expect(bad.status).toBe(400);
  });
});

describe('一覧と方策', () => {
  it('セッションの一覧と、いまの方策・項目を返す', async () => {
    const list = JSON.parse((await call('/dev/sessions')).body) as { session_id: string }[];
    expect(list.map((s) => s.session_id)).toEqual(['s_synthetic']);
    const info = JSON.parse((await call('/dev/policy')).body) as { current: { policy: PolicyJa }; leaves: { path: string }[] };
    expect(info.current.policy.policy_id).toBe('ja');
    expect(info.leaves.length).toBeGreaterThan(20);
  });

  it('保存は正本との差分だけを書き、正本の方策ファイルは変えない', async () => {
    const before = readFileSync(join(repoRoot, 'config/policy.ja.json'), 'utf8');
    const edited = productionJaPolicy();
    edited.turn.constants.VAP_PNOW_YIELD = 0.55;
    const res = await call('/dev/policy/local', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ policy: edited }) });
    expect(res.status).toBe(200);
    expect(JSON.parse(readFileSync(local(), 'utf8'))).toEqual({ turn: { constants: { VAP_PNOW_YIELD: 0.55 } } });
    expect(readFileSync(join(repoRoot, 'config/policy.ja.json'), 'utf8')).toBe(before);
  });

  it('上書きで表せない変更（省いた節）は保存しない', async () => {
    const edited = productionJaPolicy() as PolicyJa & { turn: { start_guard?: unknown } };
    if (edited.turn.start_guard === undefined) return;
    delete edited.turn.start_guard;
    writeFileSync(local(), '{}\n');
    const res = await call('/dev/policy/local', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ policy: edited }) });
    expect(res.status).toBe(400);
    expect(existsSync(local()) && readFileSync(local(), 'utf8')).toBe('{}\n');
  });
});
