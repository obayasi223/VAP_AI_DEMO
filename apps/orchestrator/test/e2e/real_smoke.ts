/**
 * 実 STT／Gemini／ElevenLabs の短い通し確認（SAVE_SESSION_AUDIO なしの本番の経路）。課金あり。Node 24。
 *   REAL_SMOKE_MIC=<48kHz mono WAV> REAL_SMOKE_SESSIONS='immediate,llm' REAL_SMOKE_SECONDS=72 \
 *     tsx apps/orchestrator/test/e2e/real_smoke.ts
 *
 * 偽マイクは合成音声のファイルを流すだけなので、人の会話の頻度や内容の妥当性を表さない（発話希望の頻度は評価しない）。
 * orchestrator は main.ts を子プロセスで起動する（固定ポート 8787）。結果は標準出力の JSON と sessions/<id>/。
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');
const WEB_PORT = Number(process.env.REAL_SMOKE_WEB_PORT ?? 3205);
const ORCH_PORT = 8787;
const SECONDS = Number(process.env.REAL_SMOKE_SECONDS ?? 72);
const STRATEGIES = (process.env.REAL_SMOKE_SESSIONS ?? 'immediate,llm').split(',').filter(Boolean);
const MAX_TOTAL_S = 180;
const mic = process.env.REAL_SMOKE_MIC;
if (!mic) throw new Error('REAL_SMOKE_MIC が必要です');
if (STRATEGIES.length > 2 || STRATEGIES.length * SECONDS > MAX_TOTAL_S) throw new Error('上限（2 セッション、合計 180 秒）を超えています');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitHttp(url: string, what: string, timeoutMs: number, accept: (body: string) => boolean = () => true): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok && accept(await r.text())) return;
    } catch {
      /* まだ */
    }
    await sleep(300);
  }
  throw new Error(`${what} が起動しませんでした`);
}

async function runSession(browser: import('playwright').Browser, strategy: string): Promise<Record<string, unknown>> {
  const page: Page = await browser.newPage({ viewport: { width: 480, height: 360 } });
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await page.addInitScript('window.__name = (f) => f');
  const query = `ws=${encodeURIComponent(`ws://127.0.0.1:${ORCH_PORT}/ws`)}&condition=initiative_inhale&conversation_kind=joint_thinking&timing_strategy=${strategy}`;
  await page.goto(`http://127.0.0.1:${WEB_PORT}/?${query}`, { waitUntil: 'load', timeout: 120_000 });
  await page.waitForFunction(() => (window as unknown as { __participant?: unknown }).__participant !== undefined, undefined, { timeout: 120_000 });
  await page.waitForFunction(() => {
    const p = (window as unknown as { __participant: { avatar(): unknown; avatarError(): string | null } }).__participant;
    return p.avatar() !== null || p.avatarError() !== null;
  }, undefined, { timeout: 120_000 });
  await page.click('#start');
  const startedAt = Date.now();
  await sleep(SECONDS * 1000);
  const view = await page.evaluate(() => {
    const c = (window as unknown as { __participant: { controller: { current(): unknown; record: Record<string, unknown> } } }).__participant.controller;
    const r = c.record as { breathCommands: unknown[]; signalReports: unknown[]; messages: unknown[] };
    return { current: c.current(), breathCommands: r.breathCommands, signalReports: r.signalReports };
  });
  await page.getByRole('button', { name: '終了する' }).click({ timeout: 5000 }).catch(() => undefined);
  await sleep(1500);
  const elapsed_s = (Date.now() - startedAt) / 1000;
  await page.close();
  return { strategy, elapsed_s, pageErrors, view };
}

async function main(): Promise<void> {
  const workDir = await mkdtemp(path.join(process.env.REAL_SMOKE_WORKDIR ?? tmpdir(), 'real-smoke-'));
  const wrapper = path.join(workDir, 'chromium-nice.sh');
  await writeFile(wrapper, `#!/bin/sh\nexec nice -n 15 ${JSON.stringify(chromium.executablePath())} "$@"\n`, { mode: 0o755 });

  let orch: ChildProcess | null = null;
  let next: ChildProcess | null = null;
  let browser: import('playwright').Browser | null = null;
  const output: Record<string, unknown> = {};
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  delete childEnv.SAVE_SESSION_AUDIO;
  try {
    next = spawn(path.join(repoRoot, 'node_modules/.bin/next'), ['dev', '-p', String(WEB_PORT), '--hostname', '127.0.0.1'], {
      cwd: path.join(repoRoot, 'apps/web'),
      stdio: 'ignore',
      detached: true,
      env: { ...childEnv, NEXT_TELEMETRY_DISABLED: '1' },
    });
    await waitHttp(`http://127.0.0.1:${WEB_PORT}/worklets/duplex.worklet.js`, 'next dev', 90_000);
    const orchLog: string[] = [];
    orch = spawn(path.join(repoRoot, 'node_modules/.bin/tsx'), ['apps/orchestrator/src/main.ts'], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...childEnv, ALLOWED_ORIGINS: `http://127.0.0.1:${WEB_PORT}`, SESSION_RESUME_GRACE_MS: '3000' },
    });
    const collect = (d: Buffer) => orchLog.push(d.toString());
    orch.stdout?.on('data', collect);
    orch.stderr?.on('data', collect);
    await waitHttp(`http://127.0.0.1:${ORCH_PORT}/health`, 'orchestrator', 60_000);
    const readyDeadline = Date.now() + 60_000;
    while (!orchLog.join('').includes('MaAI worker: ready') && Date.now() < readyDeadline) await sleep(300);
    output.orchestrator_ready = orchLog.join('').includes('MaAI worker: ready');
    browser = await chromium.launch({
      executablePath: wrapper,
      headless: true,
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${mic}`],
    });
    output.sessions = [];
    for (const strategy of STRATEGIES) (output.sessions as unknown[]).push(await runSession(browser, strategy));
    output.orchestrator_log_tail = orchLog
      .join('')
      .split('\n')
      .filter((l) => /providers:|session audio|unavailable|failed|error/i.test(l))
      .slice(-40);
  } finally {
    await browser?.close().catch(() => undefined);
    if (orch && orch.exitCode === null) {
      orch.kill('SIGTERM');
      await new Promise((r) => {
        orch!.once('exit', r);
        setTimeout(r, 8000);
      });
    }
    if (next?.pid) {
      try {
        process.kill(-next.pid, 'SIGTERM');
      } catch {
        /* 終了済み */
      }
    }
    execFileSync('sleep', ['1']);
  }
  const out = path.join(workDir, 'result.json');
  await writeFile(out, JSON.stringify(output, null, 2));
  console.log(out);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
