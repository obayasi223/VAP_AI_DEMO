/**
 * SESSION_MODE の切り替え（docs/design/two_ai/01 §1.2、05 WP1）。実際の WS で、台本のプロバイダと MaAI なしで動かす。
 *  - 1 対 1 のモード：?mode=two_ai は 1008、arm と WoZ は断る、research.config に mode を足さない。
 *  - 2 体のモード：条件がなければ 1011、arm の後は TwoAiSession を作り server.hello(two_ai) を送る。
 */
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { readConfig } from '../../../src/app/config';
import { OrchestratorServer } from '../../../src/ws/server';
import { hello } from '../../session/helpers';

let dir: string | null = null;
let server: OrchestratorServer | null = null;
const sockets: WebSocket[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(what: string, probe: () => T | null | undefined | false, timeoutMs = 8000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > until) throw new Error(`timed out: ${what}`);
    await sleep(10);
  }
}

async function start(env: Record<string, string>): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), 'orch-two-ai-mode-'));
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
    ...env,
  });
  server = new OrchestratorServer({ config, maai: null, maaiUnavailableReason: 'test', log: () => undefined, env: {} });
  const port = await server.listen();
  return `ws://127.0.0.1:${port}`;
}

type Msg = { type: string; [k: string]: unknown };
function open(url: string): Promise<{ ws: WebSocket; closed: Promise<{ code: number; reason: string }>; messages: Msg[] }> {
  const ws = new WebSocket(url, { headers: { origin: 'http://localhost:3000' } });
  sockets.push(ws);
  const messages: Msg[] = [];
  ws.on('message', (data, isBinary) => {
    if (!isBinary) messages.push(JSON.parse(String(data)));
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => ws.on('close', (code, reason) => resolve({ code, reason: String(reason) })));
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve({ ws, closed, messages }));
    ws.once('error', reject);
  });
}

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  await server?.close();
  server = null;
  if (dir !== null) await rm(dir, { recursive: true, force: true });
  dir = null;
});

describe('1 対 1 のモード（既定）', () => {
  it('?mode=two_ai の参加者の接続は 1008 session_mode_mismatch で断る', async () => {
    const url = await start({});
    const c = await open(`${url}/ws?mode=two_ai`);
    c.ws.send(JSON.stringify(hello()));
    expect(await c.closed).toEqual({ code: 1008, reason: 'session_mode_mismatch' });
    expect(server!.active()).toBeNull();
  });

  it('research.config に mode を足さず、arm と WoZ を断る', async () => {
    const url = await start({});
    const r = await open(`${url}/research`);
    await waitFor('config', () => r.messages.find((m) => m.type === 'research.config'));
    expect('mode' in r.messages[0]!).toBe(false);
    r.ws.send(JSON.stringify({ type: 'research.two_ai.arm', arm_id: 'a1', condition: 'respond_on_spot', script_id: 'demo_career', interjection_feeds_generation: null, session_index: null, counterbalance_label: null, operator: 'r1', client_wall_clock: new Date().toISOString() }));
    r.ws.send(JSON.stringify({ type: 'research.woz', woz_id: 'w1', action: 'face_user', point_id: null, operator: 'r1', client_wall_clock: new Date().toISOString() }));
    const arm = await waitFor('arm ack', () => r.messages.find((m) => m.type === 'research.two_ai.arm.ack'));
    const woz = await waitFor('woz ack', () => r.messages.find((m) => m.type === 'research.woz.ack'));
    expect(arm).toMatchObject({ status: 'rejected', detail: 'not_two_ai_mode' });
    expect(woz).toMatchObject({ status: 'rejected', detail: 'not_two_ai_session' });
  });
});

describe('2 体のモード', () => {
  it('条件（arm も TWO_AI_CONDITION も）がなければ 1011 で始めない', async () => {
    const url = await start({ SESSION_MODE: 'two_ai', TWO_AI_SCRIPT: 'config/two_ai/scripts/demo_career.ja.json' });
    const c = await open(`${url}/ws?mode=two_ai`);
    c.ws.send(JSON.stringify(hello()));
    expect(await c.closed).toEqual({ code: 1011, reason: 'two_ai condition not set' });
  });

  it('arm の後の接続は TwoAiSession を作り、server.hello(two_ai)、two_ai.phase(intake)、同期の印を出す', async () => {
    const url = await start({ SESSION_MODE: 'two_ai' });
    const r = await open(`${url}/research`);
    const config = await waitFor('config', () => r.messages.find((m) => m.type === 'research.config'));
    expect(config).toMatchObject({ mode: 'two_ai', two_ai_armed: null });
    r.ws.send(JSON.stringify({ type: 'research.two_ai.arm', arm_id: 'a1', condition: 'respond_at_end', script_id: 'demo_career', interjection_feeds_generation: null, session_index: 1, counterbalance_label: 'AB', operator: 'r1', client_wall_clock: new Date().toISOString() }));
    expect(await waitFor('arm ack', () => r.messages.find((m) => m.type === 'research.two_ai.arm.ack'))).toMatchObject({ status: 'armed' });
    const c = await open(`${url}/ws?mode=two_ai`);
    c.ws.send(JSON.stringify(hello()));
    const sh = await waitFor('server.hello', () => c.messages.find((m) => m.type === 'server.hello'));
    expect(sh).toMatchObject({ mode: 'two_ai', condition: null, two_ai: { ai_ids: ['A', 'B'], phase: 'intake' } });
    await waitFor('phase', () => c.messages.find((m) => m.type === 'two_ai.phase' && m.phase === 'intake'));
    const session = server!.currentTwoAi();
    expect(session).not.toBeNull();
    expect(server!.current()).toBeNull();
    expect(session!.condition).toBe('respond_at_end');
    await sleep(300);
    expect(session!.counters.tick_errors).toBe(0);
    // WoZ は今のセッションへ届く。
    r.ws.send(JSON.stringify({ type: 'research.woz', woz_id: 'w1', action: 'face_user', point_id: null, operator: 'r1', client_wall_clock: new Date().toISOString() }));
    const woz = await waitFor('woz ack', () => r.messages.find((m) => m.type === 'research.woz.ack'));
    expect(woz).toMatchObject({ woz_id: 'w1', phase: 'intake' });
    expect(['applied', 'recorded', 'rejected']).toContain(woz.status);
    const id = session!.session_id;
    await server!.endSession('test_end');
    expect(server!.pastTwoAiSessions.map((s) => s.session_id)).toEqual([id]);
    const files = await readdir(join(dir!, id));
    const events = (await readFile(join(dir!, id, files.find((f) => f.endsWith('.jsonl'))!), 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { event: string; two_ai?: unknown; [k: string]: unknown });
    const names = new Set(events.map((e) => e.event));
    for (const n of ['two_ai.phase_changed', 'two_ai.sync_mark', 'woz.override']) expect(names.has(n), n).toBe(true);
    const phase = events.find((e) => e.event === 'two_ai.phase_changed')!;
    expect(phase.two_ai).toMatchObject({ phase: 'intake', ai_id: null });
    const manifest = JSON.parse(await readFile(join(dir!, id, 'manifest.json'), 'utf8'));
    expect(manifest.mode).toBe('two_ai');
    expect(manifest.two_ai).toMatchObject({ condition: 'respond_at_end', condition_source: 'research_screen', arm_id: 'a1', script_id: 'demo_career' });
  }, 20000);
});
