/**
 * 研究条件をセッションごとに切り替える（参加者画面の WS の URL の ?condition=）。実際の WS で、台本のプロバイダと
 * MaAI なしで動かす。JSONL の condition が選んだ条件で残ること、CONDITION_FROM_CLIENT=0 で固定できることを見る。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { readConfig } from '../../src/app/config';
import { OrchestratorServer } from '../../src/ws/server';
import { hello } from './helpers';

let dir: string | null = null;
let server: OrchestratorServer | null = null;
const sockets: WebSocket[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  await server?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
  server = null;
  dir = null;
});

async function start(env: Record<string, string> = {}): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), 'orch-condition-'));
  const config = readConfig({
    STT_PROVIDER_CLASS: 'test_double',
    TTS_PROVIDER_CLASS: 'test_double',
    LLM_PROVIDER_CLASS: 'test_double',
    SESSIONS_DIR: dir,
    ORCHESTRATOR_PORT: '0',
    ORCHESTRATOR_HOST: '127.0.0.1',
    MAAI_ENABLED: '0',
    CONDITION: 'reactive',
    ...env,
  });
  server = new OrchestratorServer({ config, maai: null, maaiUnavailableReason: 'test', log: () => undefined });
  return `ws://127.0.0.1:${await server.listen()}`;
}

/** 接続して hello を送り、server.hello の condition を返す。 */
async function open(url: string, query: string): Promise<string> {
  const ws = new WebSocket(`${url}/ws${query}`, { headers: { origin: 'http://localhost:3000' } });
  sockets.push(ws);
  const condition = new Promise<string>((resolve) =>
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const m = JSON.parse(String(data)) as { type: string; condition?: string };
      if (m.type === 'server.hello') resolve(m.condition as string);
    }),
  );
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  ws.send(JSON.stringify(hello()));
  return condition;
}

async function loggedConditions(): Promise<Set<string>> {
  const s = server!;
  const session = s.current()!;
  await s.endSession('test_done');
  await sleep(20);
  const lines = (await readFile(join(dir!, session.session_id, 'events.jsonl'), 'utf8')).split('\n').filter((l) => l.trim() !== '');
  return new Set(lines.map((l) => (JSON.parse(l) as { condition: string }).condition));
}

describe('研究条件の切替（セッション単位）', () => {
  it('?condition= の条件でセッションを作り、server.hello と JSONL の condition に残す', async () => {
    const url = await start();
    expect(await open(url, '?condition=initiative_inhale')).toBe('initiative_inhale');
    expect(server!.current()?.condition).toBe('initiative_inhale');
    expect(await loggedConditions()).toEqual(new Set(['initiative_inhale']));
  });

  it('求めがなければ、または不正な値なら CONDITION（既定）', async () => {
    const url = await start({ CONDITION: 'initiative_no_cue' });
    expect(await open(url, '')).toBe('initiative_no_cue');
    await server!.endSession('next');
    expect(await open(url, '?condition=nonsense')).toBe('initiative_no_cue');
    expect(await loggedConditions()).toEqual(new Set(['initiative_no_cue']));
  });

  it('CONDITION_FROM_CLIENT=0 なら画面の求めを無視して CONDITION に固定する（参加者に条件を選ばせない運用）', async () => {
    const url = await start({ CONDITION_FROM_CLIENT: '0', CONDITION: 'reactive' });
    expect(await open(url, '?condition=initiative_inhale')).toBe('reactive');
    expect(await loggedConditions()).toEqual(new Set(['reactive']));
  });
});
