/**
 * 2 体の話し合いの技術評価の駆動（停止の遅れ、誤った停止、点の時点、描画と RTF）。
 *
 *   npx tsx tools/two_ai_eval/run.ts --conditions respond_on_spot --sessions 3 --out <dir>
 *   npx tsx --env-file=.env tools/two_ai_eval/run.ts --real --conditions respond_on_spot,respond_at_end --out <dir>
 *
 * 経路：ヘッドレス Chromium（偽マイク＝合成の本人役の声と、咳・息・相づち。stimuli.ts）→ /two_ai → WS → TwoAiSession → 実 MaAI →
 * 台本（既定）か実の LLM／STT／TTS → 2 体の再生。SAVE_SESSION_AUDIO=1 で 2ch の録音（ch1 = マイク、ch2 = AI の再生音）を残し、
 * analyze.ts が録音とログを突き合わせる。
 *
 * 規則：ポートは 3000／8787 を使わない（既定 3482／8808）。利用者の Chrome は使わない（Playwright のヘッドレス Chromium）。
 * セッションのログは --out の下（リポジトリの sessions/ は読まない、書かない）。
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { buildStimuli, repoRoot, type BuildOptions } from './stimuli';

const { values: args } = parseArgs({
  options: {
    conditions: { type: 'string', default: 'respond_on_spot' },
    sessions: { type: 'string', default: '1' },
    seed: { type: 'string', default: '1' },
    out: { type: 'string' },
    real: { type: 'boolean', default: false },
    config: { type: 'string', default: 'config/two_ai/session.demo_short.ja.json' },
    script: { type: 'string', default: 'config/two_ai/scripts/demo_career.ja.json' },
    'web-port': { type: 'string', default: '3482' },
    'orch-port': { type: 'string', default: '8808' },
    'timeout-s': { type: 'string', default: '720' },
    spacing: { type: 'string', default: '11,19' },
    mix: { type: 'string', default: 'speech:6,backchannel:2,cough:1,breath_soft:0.5,breath_loud:0.5' },
    'no-maai': { type: 'boolean', default: false },
    verbose: { type: 'boolean', default: false },
    /** /two_ai に足す問い合わせ（例 avatar_a=none&avatar_b=none）。描画の負荷の比較に使う。 */
    query: { type: 'string', default: '' },
    viewport: { type: 'string', default: '1280x720' },
    /** ブラウザのプロセス木の nice 値（04 §性能の代替 F5。0 は変えない）。 */
    nice: { type: 'string', default: '0' },
  },
});

const WEB_PORT = Number(args['web-port']);
const ORCH_PORT = Number(args['orch-port']);
if ([WEB_PORT, ORCH_PORT].some((p) => p === 3000 || p === 8787)) throw new Error('ports 3000/8787 are reserved for the user');
const TIMEOUT_S = Number(args['timeout-s']);
const OUT = path.resolve(args.out ?? path.join(repoRoot, 'tools/two_ai_eval/out', new Date().toISOString().replace(/[:.]/g, '-')));
const webRoot = path.join(repoRoot, 'apps/web');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function startNext(): Promise<ChildProcess> {
  const next = spawn(path.join(repoRoot, 'node_modules/.bin/next'), ['dev', '-p', String(WEB_PORT), '--hostname', '127.0.0.1'], {
    cwd: webRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
  });
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${WEB_PORT}/worklets/duplex.worklet.js`)).ok) return next;
    } catch {
      /* まだ */
    }
    await sleep(300);
  }
  throw new Error('next dev did not start');
}

function newestSessionDir(dir: string): string | null {
  if (!existsSync(dir)) return null;
  return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(dir, d.name)).sort().at(-1) ?? null;
}
function sessionEnded(dir: string | null): boolean {
  if (dir === null || !existsSync(path.join(dir, 'events.jsonl'))) return false;
  const text = readFileSync(path.join(dir, 'events.jsonl'), 'utf8');
  return text.includes('"to":"end"') && text.includes('"event":"two_ai.retraction"');
}

/** 自分が起動したブラウザ（偽マイクのファイル名を引数に持つ）のプロセス木だけを renice する。 */
function reniceBrowser(micPath: string, nice: number): void {
  const roots = spawnSync('pgrep', ['-f', micPath], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).map(Number);
  const pids = [...roots];
  for (let i = 0; i < pids.length; i++) {
    const r = spawnSync('pgrep', ['-P', String(pids[i])], { encoding: 'utf8' });
    for (const l of r.stdout.split('\n').filter(Boolean)) pids.push(Number(l));
  }
  spawnSync('renice', ['-n', String(nice), '-p', ...pids.map(String)], { stdio: 'ignore' });
  console.log(`  reniced ${pids.length} browser processes to ${nice}`);
}

async function runOne(condition: 'respond_on_spot' | 'respond_at_end', runIdx: number, seed: number): Promise<Record<string, unknown>> {
  const { chromium } = await import('playwright');
  const { readConfig } = await import('../../apps/orchestrator/src/app/config');
  const { OrchestratorServer, SwitchableTimeSource } = await import('../../apps/orchestrator/src/ws/server');
  const { createMaaiClient } = await import('../../apps/orchestrator/src/app/maai_setup');
  const { SystemTimeSource } = await import('@llm-vap/contracts');
  const runDir = path.join(OUT, `${condition}_${runIdx}`);
  const sessionsDir = path.join(runDir, 'sessions');
  await mkdir(sessionsDir, { recursive: true });
  const [s0, s1] = args.spacing.split(',').map(Number) as [number, number];
  const mix = Object.fromEntries(args.mix.split(',').map((kv) => kv.split(':')).map(([k, v]) => [k, Number(v)])) as BuildOptions['mix'];
  const stim = await buildStimuli({ outDir: path.join(runDir, 'stimuli'), seed, startS: 80, endS: TIMEOUT_S, spacing: [s0, s1], mix, totalS: TIMEOUT_S + 120, speechOwnOnly: args.real });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SESSIONS_DIR: sessionsDir,
    ORCHESTRATOR_PORT: String(ORCH_PORT),
    ORCHESTRATOR_HOST: '127.0.0.1',
    ALLOWED_ORIGINS: `http://127.0.0.1:${WEB_PORT}`,
    SESSION_MODE: 'two_ai',
    TWO_AI_CONDITION: condition,
    TWO_AI_CONFIG: args.config,
    TWO_AI_SCRIPT: args.script,
    SAVE_SESSION_AUDIO: '1',
    SCRIPTED_TTS_WAV: stim.ttsWav,
    ...(args.real
      ? {}
      : { STT_PROVIDER_CLASS: 'test_double', TTS_PROVIDER_CLASS: 'test_double', LLM_PROVIDER_CLASS: 'test_double', SCRIPTED_STT_SCRIPT_FILE: stim.sttScript }),
    ...(args['no-maai'] ? { MAAI_ENABLED: '0' } : {}),
  };
  // 実の通しで 2 体の声が未設定なら、Gemini TTS の声（本人役の Kore と別のもの）を使う。値は表示しない。
  if (args.real && (!env.TWO_AI_VOICE_A || !env.TWO_AI_VOICE_B)) Object.assign(env, { TTS_PROVIDER: 'gemini', TWO_AI_VOICE_A: 'Puck', TWO_AI_VOICE_B: 'Charon' });
  // 録音の設定はセッションが process.env から読む（1 対 1 と同じ）。
  process.env.SAVE_SESSION_AUDIO = '1';
  const config = readConfig(env);
  const maaiTime = new SwitchableTimeSource(new SystemTimeSource());
  const maai = createMaaiClient({ policy: config.policy, time: maaiTime, env: { ...env, MAAI_WORKER_URL: 'ws://127.0.0.1:0' }, port: 0 });
  if (!args['no-maai']) await maai.start(`two-ai-eval-${condition}-${Date.now()}`);
  const server = new OrchestratorServer({ config, maai, maaiTime, env, log: (m: string) => args.verbose && console.log(`  [orch] ${m}`) });
  await server.listen();
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${stim.mic}`],
  });
  const started = Date.now();
  let record: unknown = null;
  try {
    const [vw, vh] = args.viewport.split('x').map(Number) as [number, number];
    const page = await browser.newPage({ viewport: { width: vw, height: vh } });
    page.on('pageerror', (e) => console.log(`  pageerror: ${String(e)}`));
    if (args.verbose) page.on('console', (m) => console.log(`  [page] ${m.type()} ${m.text()}`));
    await page.addInitScript('window.__name = (f) => f');
    await page.goto(`http://127.0.0.1:${WEB_PORT}/two_ai?ws=${encodeURIComponent(`ws://127.0.0.1:${ORCH_PORT}/ws?mode=two_ai`)}${args.query ? `&${args.query}` : ''}`, { waitUntil: 'load', timeout: 180_000 });
    await page.waitForFunction(() => (window as unknown as { __twoAi?: unknown }).__twoAi !== undefined, undefined, { timeout: 180_000 });
    await page.click('#start', { timeout: 60_000 });
    if (Number(args.nice) > 0) reniceBrowser(stim.mic, Number(args.nice));
    const deadline = Date.now() + TIMEOUT_S * 1000;
    while (Date.now() < deadline && !sessionEnded(newestSessionDir(sessionsDir))) await sleep(1000);
    record = await page.evaluate(() => {
      const h = (window as unknown as { __twoAi: { controller: { record: { mouth: unknown } } } }).__twoAi;
      return { mouth: h.controller.record.mouth };
    });
    await sleep(1500); // 最後の録音とログを書き切る
  } finally {
    await browser.close().catch(() => undefined);
    await server.close().catch(() => undefined);
    await maai.stop('eval_done').catch(() => undefined);
  }
  const dir = newestSessionDir(sessionsDir);
  const summary = { query: args.query, viewport: args.viewport, nice: Number(args.nice), condition, run: runIdx, seed, session_dir: dir, ended: sessionEnded(dir), wall_s: Math.round((Date.now() - started) / 1000), truth: stim.truth, record, real: args.real };
  await writeFile(path.join(runDir, 'run.json'), JSON.stringify(summary, null, 2));
  console.log(`[${condition} #${runIdx}] ended=${summary.ended} wall=${summary.wall_s}s dir=${dir}`);
  return summary;
}

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const conditions = args.conditions.split(',').map((c) => c.trim()) as ('respond_on_spot' | 'respond_at_end')[];
  const n = Number(args.sessions);
  const next = await startNext();
  const runs: Record<string, unknown>[] = [];
  try {
    let seed = Number(args.seed);
    for (let i = 0; i < n; i++) {
      for (const c of conditions) {
        runs.push(await runOne(c, i, seed));
        seed += 1;
      }
    }
  } finally {
    if (next.pid) {
      try {
        process.kill(-next.pid, 'SIGTERM'); // 自分が起動したプロセスグループだけ
      } catch {
        /* 終了済み */
      }
    }
  }
  await writeFile(path.join(OUT, 'runs.json'), JSON.stringify(runs, null, 2));
  console.log(`out: ${OUT}`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
