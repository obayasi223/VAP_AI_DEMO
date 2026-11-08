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

  describe('会話の種類とタイミングの方式', () => {
    async function manifest(): Promise<{ initiative: Record<string, unknown> }> {
      const s = server!;
      const session = s.current()!;
      await s.endSession('test_done');
      await sleep(20);
      return JSON.parse(await readFile(join(dir!, session.session_id, 'manifest.json'), 'utf8')) as { initiative: Record<string, unknown> };
    }

    it('?conversation_kind= と ?timing_strategy= を manifest に残す（由来は client）', async () => {
      const url = await start();
      await open(url, '?condition=initiative_inhale&conversation_kind=companion&timing_strategy=immediate');
      expect((await manifest()).initiative).toMatchObject({
        timing_strategy: 'immediate',
        conversation_kind: 'companion',
        conversation_kind_source: 'client',
        timing_strategy_source: 'client',
        desire_prompt_version: 'initiative-desire-ja-v3',
        profile_version: 1,
      });
    });

    it('求めがなければ方策の既定（llm、joint_thinking）', async () => {
      const url = await start();
      await open(url, '');
      expect((await manifest()).initiative).toMatchObject({ timing_strategy: 'llm', conversation_kind: 'joint_thinking', conversation_kind_source: 'default', timing_strategy_source: 'default' });
    });

    it('不正な値は既定へ（由来は default）', async () => {
      const url = await start();
      await open(url, '?conversation_kind=nonsense&timing_strategy=nonsense');
      expect((await manifest()).initiative).toMatchObject({ timing_strategy: 'llm', conversation_kind: 'joint_thinking', timing_strategy_source: 'default' });
    });

    it('*_FROM_CLIENT=0 は既定に固定する（由来は fixed）', async () => {
      const url = await start({ CONVERSATION_KIND_FROM_CLIENT: '0', TIMING_STRATEGY_FROM_CLIENT: '0' });
      await open(url, '?conversation_kind=companion&timing_strategy=immediate');
      expect((await manifest()).initiative).toMatchObject({ timing_strategy: 'llm', conversation_kind: 'joint_thinking', conversation_kind_source: 'fixed', timing_strategy_source: 'fixed' });
    });

    it('?vocal_cue= を manifest に残す。指定なしは none', async () => {
      const url = await start();
      await open(url, '?condition=initiative_inhale&vocal_cue=backchannel');
      expect((await manifest()).initiative).toMatchObject({ vocal_cue: 'backchannel', vocal_cue_requested: 'backchannel', vocal_cue_source: 'client' });
    });

    it('vocal_cue の既定は none で、不正な値も none', async () => {
      const url = await start();
      await open(url, '?condition=initiative_inhale&vocal_cue=nonsense');
      expect((await manifest()).initiative).toMatchObject({ vocal_cue: 'none', vocal_cue_source: 'default' });
    });

    it('VOCAL_CUE_FROM_CLIENT=0 は環境変数の値に固定する（由来は fixed）', async () => {
      const url = await start({ VOCAL_CUE: 'pre_beginning', VOCAL_CUE_FROM_CLIENT: '0' });
      await open(url, '?condition=initiative_inhale&vocal_cue=backchannel');
      expect((await manifest()).initiative).toMatchObject({ vocal_cue: 'pre_beginning', vocal_cue_source: 'fixed' });
    });

    it('initiative_inhale 以外では求めても動かない（none として理由を残す）', async () => {
      const url = await start();
      await open(url, '?condition=reactive&vocal_cue=pre_beginning');
      expect((await manifest()).initiative).toMatchObject({ vocal_cue: 'none', vocal_cue_requested: 'pre_beginning' });
    });

    it('v2 を選ぶと会話の種類は適用しない（記録も null）', async () => {
      const url = await start();
      await open(url, '?timing_strategy=v2&conversation_kind=companion');
      expect((await manifest()).initiative).toMatchObject({ timing_strategy: 'v2', conversation_kind: null, desire_prompt_version: null, profile_version: null });
    });
  });
});
