/**
 * 2 体の話し合いモードのヘッドレスの e2e（docs/design/two_ai/04 T3）。重いので vitest には入れない。
 *   npm run test:e2e:two_ai                       台本のプロバイダ（test_double）＋実 MaAI、① と ② を順に
 *   E2E_MAAI=off npm run test:e2e:two_ai          メモリが足りないとき MaAI を切る（MAAI_ENABLED=0。VAP の停止の検査は飛ばす）
 *   E2E_CONDITIONS=respond_on_spot npm run test:e2e:two_ai
 *
 * 経路：ヘッドレス Chromium（偽マイク = models/ja.wav の声と無音）→ /two_ai → WS（mode=two_ai）→ TwoAiSession → MaAI →
 * 台本の LLM／STT／TTS → 2 体の再生 → 口と視線。記録は window.__twoAi（03 §2.4）から読む。
 *
 * 限界：偽マイクは人の会話の頻度や遅れを表さない。合格は配線の確認で、性能や自然さの証拠ではない。
 * ポートは 3000 と 8787 を使わない（既定 3472、8798）。空きメモリ 2.5 GB 以上、ほかの重い処理と重ねない（runbook §6）。
 *
 * 状態（2026-11-16）：統合 1（05 §5.2）の後。前提（統合の入口、空きメモリ、ポート）が揃わないときだけ保留で終わる。
 * 終了コード：0 合格、1 不合格、3 保留（前提が揃っていない）。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { freemem, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');
const webRoot = path.join(repoRoot, 'apps/web');
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 3472);
const ORCH_PORT = Number(process.env.E2E_ORCH_PORT ?? 8798);
const MAAI_OFF = process.env.E2E_MAAI === 'off';
const SESSION_TIMEOUT_S = Number(process.env.E2E_SESSION_TIMEOUT_S ?? 600);
const MIC_SILENCE_S = Number(process.env.E2E_MIC_SILENCE_S ?? 30);
const CONDITIONS = (process.env.E2E_CONDITIONS ?? 'respond_on_spot,respond_at_end').split(',').map((c) => c.trim()) as ('respond_on_spot' | 'respond_at_end')[];
const CONFIG = process.env.E2E_TWO_AI_CONFIG ?? 'config/two_ai/session.demo_short.ja.json';
const SCRIPT = process.env.E2E_TWO_AI_SCRIPT ?? 'config/two_ai/scripts/demo_career.ja.json';
const MIN_FREE_BYTES = 2.5 * 1024 ** 3;
export const INTEGRATION_ENTRY = 'apps/orchestrator/src/two_ai/two_ai_session.ts';
const LIMITATION = '偽マイクと台本のプロバイダによる配線の確認。性能や自然さの証拠ではない（04 T3）。';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const failures: string[] = [];
const results: Record<string, unknown> = { limitation: LIMITATION, ports: { web: WEB_PORT, orchestrator: ORCH_PORT } };
function check(name: string, ok: boolean, detail: unknown): void {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`);
  if (!ok) failures.push(name);
}

/** 空きメモリ（/proc/meminfo の MemAvailable。読めなければ os.freemem）。 */
function availableBytes(): number {
  try {
    const m = /MemAvailable:\s+(\d+) kB/.exec(readFileSync('/proc/meminfo', 'utf8'));
    if (m) return Number(m[1]) * 1024;
  } catch {
    /* Linux 以外 */
  }
  return freemem();
}

/** 前提。揃っていなければ保留の理由を返す。 */
export function pendingReasons(): string[] {
  const reasons: string[] = [];
  if (!existsSync(path.join(repoRoot, INTEGRATION_ENTRY))) reasons.push(`${INTEGRATION_ENTRY} がない（WP1）`);
  const server = path.join(repoRoot, 'apps/orchestrator/src/ws/server.ts');
  if (!existsSync(server) || !readFileSync(server, 'utf8').includes('two_ai')) reasons.push('server.ts に SESSION_MODE=two_ai の切り替えがない（WP1、統合 1）');
  const config = path.join(repoRoot, 'apps/orchestrator/src/app/config.ts');
  if (!existsSync(config) || !readFileSync(config, 'utf8').includes('SESSION_MODE')) reasons.push('config.ts が SESSION_MODE を読まない（WP1）');
  if (!existsSync(path.join(webRoot, 'app/(participant)/two_ai/page.tsx'))) reasons.push('/two_ai のページがない（WP3）');
  if (!existsSync(path.join(repoRoot, 'models/ja.wav'))) reasons.push('models/ja.wav がない（偽マイクの素材）');
  return reasons;
}

async function startNext(): Promise<ChildProcess> {
  const next = spawn(path.join(repoRoot, 'node_modules/.bin/next'), ['dev', '-p', String(WEB_PORT), '--hostname', '127.0.0.1'], {
    cwd: webRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
  });
  const deadline = Date.now() + 90_000;
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

/** 偽マイクの声の始まり（秒）。intake は試走の本人の台本と同じ 3 つの文と、読み上げへの返事。その後は MIC_SILENCE_S ごと。 */
const INTAKE_VOICE_AT_S = [3, 14, 26, 42];
/**
 * 台本の STT が声の区間ごとに返す文（SCRIPTED_STT_SCRIPT_FILE。試験だけ。U4）。intake の穴を埋める文（fixtures の本人の台本）と、
 * 読み上げへの返事、話し合いの短い発言。台本の STT は声の区間の順に文を返すので、偽マイクの声の数と順に合わせる。
 */
const E2E_STT_SCRIPT = [
  '博士課程に進むか、インターンに応募して就職するかで迷っています。',
  'いちばん引っかかっているのは、自分に研究の才能があるか分からないことです。',
  'インターンの締切は 2 月末で、研究科の説明会は 1 月 15 日です。',
  'はい、そのとおりです。',
  'そこは、もう少し考えたいです。',
  '締切の日付は、2 月末で合っています。',
  'なるほど、そういう見方もありますね。',
  '説明会には行ってみたいです。',
  'うーん、まだ決めきれません。',
  'それなら、先輩に話を聞いてみます。',
  'ありがとうございます。',
  'はい。',
  'そうですね。',
  'わかりました。',
  'たぶん、そうだと思います。',
  'もう少し考えてみます。',
];

/**
 * 偽マイク：intake は INTAKE_VOICE_AT_S に声 4 秒、その後は声 4 秒と無音 MIC_SILENCE_S 秒を交互に。ループが 1 回のセッションより長くなるようにする。
 * 無音が 8 秒だと ① では受け止めの後の言い直しが毎回次の声で切れ、話し合いが段 1 から進まなかった（統合 1）。
 */
async function buildFakeMic(workDir: string): Promise<{ mic: string; sttScript: string }> {
  const { readWavMono16, resampleInt16, writeWavMono16 } = await import('../../../web/test/audio_browser/signal');
  const source = await readWavMono16(path.join(repoRoot, 'models/ja.wav'));
  const speech = resampleInt16(source.samples, source.rate, 48000).subarray(0, 4 * 48000);
  const totalS = SESSION_TIMEOUT_S + 120;
  const starts = [...INTAKE_VOICE_AT_S];
  for (let t = (INTAKE_VOICE_AT_S.at(-1) ?? 0) + 4 + MIC_SILENCE_S; t + 4 < totalS; t += 4 + MIC_SILENCE_S) starts.push(t);
  const mic = new Int16Array(totalS * 48000);
  for (const t of starts) mic.set(speech, t * 48000);
  const file = path.join(workDir, 'fake_mic_48k.wav');
  await writeWavMono16(file, 48000, mic);
  const sttScript = path.join(workDir, 'stt_script.json');
  await writeFile(sttScript, JSON.stringify(E2E_STT_SCRIPT));
  return { mic: file, sttScript };
}

function newestSessionDir(sessionsDir: string): string | null {
  if (!existsSync(sessionsDir)) return null;
  const dirs = readdirSync(sessionsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(sessionsDir, d.name));
  return dirs.sort().at(-1) ?? null;
}

function sessionEnded(dir: string | null): boolean {
  if (dir === null || !existsSync(path.join(dir, 'events.jsonl'))) return false;
  // manifest.json はログを開いた時点で書かれるので、終わりの印にしない。end に入った後も撤回を話すので、
  // 撤回の記録（two_ai.retraction。話し終えたときに出る）まで待つ（end への移行で止めると撤回が途中で切れた）。
  const text = readFileSync(path.join(dir, 'events.jsonl'), 'utf8');
  return text.includes('"to":"end"') && text.includes('"event":"two_ai.retraction"');
}

async function runCondition(condition: 'respond_on_spot' | 'respond_at_end', fakeMic: { mic: string; sttScript: string }, workDir: string): Promise<string | null> {
  const { chromium } = await import('playwright');
  const { readConfig } = await import('../../src/app/config');
  const { OrchestratorServer, SwitchableTimeSource } = await import('../../src/ws/server');
  const { createMaaiClient } = await import('../../src/app/maai_setup');
  const { SystemTimeSource } = await import('@llm-vap/contracts');
  const sessionsDir = path.join(workDir, `sessions_${condition}`);
  await mkdir(sessionsDir, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SESSIONS_DIR: sessionsDir,
    ORCHESTRATOR_PORT: String(ORCH_PORT),
    ORCHESTRATOR_HOST: '127.0.0.1',
    ALLOWED_ORIGINS: `http://127.0.0.1:${WEB_PORT}`,
    SESSION_MODE: 'two_ai',
    TWO_AI_CONDITION: condition,
    TWO_AI_CONFIG: CONFIG,
    TWO_AI_SCRIPT: SCRIPT,
    STT_PROVIDER_CLASS: 'test_double',
    TTS_PROVIDER_CLASS: 'test_double',
    LLM_PROVIDER_CLASS: 'test_double',
    SCRIPTED_STT_SCRIPT_FILE: fakeMic.sttScript,
    ...(MAAI_OFF ? { MAAI_ENABLED: '0' } : {}),
  };
  const config = readConfig(env);
  const maaiTime = new SwitchableTimeSource(new SystemTimeSource());
  const maai = createMaaiClient({ policy: config.policy, time: maaiTime, env: { ...env, MAAI_WORKER_URL: 'ws://127.0.0.1:0' }, port: 0 });
  if (!MAAI_OFF) await maai.start(`e2e-two-ai-${condition}-${Date.now()}`);
  const server = new OrchestratorServer({ config, maai, maaiTime, env, log: (m: string) => process.env.E2E_VERBOSE && console.log(`  [orch] ${m}`) });
  await server.listen();
  let next: ChildProcess | null = null;
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${fakeMic.mic}`],
  });
  try {
    next = await startNext();
    const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
    page.on('pageerror', (e) => console.log(`  pageerror: ${String(e)}`));
    if (process.env.E2E_VERBOSE) {
      page.on('console', (m) => console.log(`  [page] ${m.type()} ${m.text()}`));
      page.on('websocket', (ws) => console.log(`  [page] websocket ${ws.url()}`));
    }
    await page.addInitScript('window.__name = (f) => f');
    await page.goto(`http://127.0.0.1:${WEB_PORT}/two_ai?ws=${encodeURIComponent(`ws://127.0.0.1:${ORCH_PORT}/ws?mode=two_ai`)}`, { waitUntil: 'load', timeout: 120_000 });
    await page.waitForFunction(() => (window as unknown as { __twoAi?: unknown }).__twoAi !== undefined, undefined, { timeout: 120_000 });
    // 参加者の「はじめる」（マイクの許可とセッションの開始は押下から。03 §3.1）。
    await page.click('#start', { timeout: 60_000 });
    const deadline = Date.now() + SESSION_TIMEOUT_S * 1000;
    while (Date.now() < deadline && !sessionEnded(newestSessionDir(sessionsDir))) await sleep(1000);
    const record = await page.evaluate(() => {
      const h = (window as unknown as { __twoAi: { controller: { record: { mouth: Record<string, { openWhilePlaying: number; samplesWhilePlaying: number }>; gazeReports: { target: string }[] } }; stage: () => unknown } }).__twoAi;
      return { mouth: h.controller.record.mouth, gazeTargets: [...new Set(h.controller.record.gazeReports.map((g) => g.target))], stage: h.stage() !== null };
    });
    results[`browser_${condition}`] = record;
    check(`${condition}: 2 体とも口が動いた`, (record.mouth.A?.openWhilePlaying ?? 0) > 0 && (record.mouth.B?.openWhilePlaying ?? 0) > 0, record.mouth);
    if (condition === 'respond_on_spot') check(`${condition}: 視線の報告に peer と user`, record.gazeTargets.includes('user') && record.gazeTargets.some((t) => t !== 'user'), record.gazeTargets);
  } finally {
    await browser.close().catch(() => undefined);
    if (next?.pid) {
      try {
        process.kill(-next.pid, 'SIGTERM'); // 自分が起動したプロセスグループだけ
      } catch {
        /* 終了済み */
      }
    }
    await server.close().catch(() => undefined);
    await maai.stop('e2e_done').catch(() => undefined);
  }
  return newestSessionDir(sessionsDir);
}

async function main(): Promise<void> {
  const workDir = await mkdtemp(path.join(tmpdir(), 'e2e-two-ai-'));
  const out = path.join(workDir, 'e2e_two_ai_result.json');
  const reasons = pendingReasons();
  const free = availableBytes();
  if (free < MIN_FREE_BYTES) reasons.push(`空きメモリ ${(free / 1024 ** 3).toFixed(1)} GB < 2.5 GB（ほかの重い処理が終わってから。E2E_MAAI=off でも足りないときは待つ）`);
  if ([WEB_PORT, ORCH_PORT].some((p) => p === 3000 || p === 8787)) reasons.push('ポート 3000 と 8787 は使わない');
  if (reasons.length > 0) {
    results.status = 'pending';
    results.pending = reasons;
    await writeFile(out, JSON.stringify(results, null, 2));
    console.log(`【保留】e2e two_ai の前提が揃っていない：\n  - ${reasons.join('\n  - ')}\nresult: ${out}`);
    process.exitCode = 3;
    return;
  }
  const { checkLog } = await import('../../../../tools/log_check/check');
  const { runReport } = await import('../../../../tools/two_ai_report/cli');
  const fakeMic = await buildFakeMic(workDir);
  const dirs: Partial<Record<string, string>> = {};
  try {
    for (const condition of CONDITIONS) {
      const dir = await runCondition(condition, fakeMic, workDir);
      check(`${condition}: セッションのログができ、end まで進んだ`, dir !== null && sessionEnded(dir), dir);
      if (dir === null) continue;
      dirs[condition] = dir;
      const lc = await checkLog(dir);
      check(`${condition}: log_check`, lc.ok, lc.failures.slice(0, 5));
      const events = readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
      const vapStops = events.filter((e) => e.event === 'speech.interrupted' && e.decision_source === 'vap' && e.origin === 'two_ai_turn' && (e.two_ai as { phase?: string } | undefined)?.phase === 'discussion').length;
      // 話し合いの停止だけ（intake は 1 対 1 と同じ順番取りで、本人の声で AI の定型が止まる）。
      if (!MAAI_OFF) check(`${condition}: VAP の停止 ${condition === 'respond_on_spot' ? '1 件以上' : '0 件'}`, condition === 'respond_on_spot' ? vapStops > 0 : vapStops === 0, vapStops);
      const fps = events.filter((e) => e.event === 'render.health').map((e) => e.fps_p5 as number);
      results[`render_${condition}`] = { n: fps.length, fps_p5_min: fps.length ? Math.min(...fps) : null };
    }
    const both = dirs.respond_on_spot !== undefined && dirs.respond_at_end !== undefined;
    const report = await runReport(Object.values(dirs) as string[], { pair: both, recall: true, post: true, coding: true });
    check('要約の受け入れの自動の列', report.ok, report.written.length);
  } catch (error) {
    failures.push(`exception: ${String(error).split('\n')[0]}`);
  } finally {
    results.status = failures.length === 0 ? 'ok' : 'failed';
    results.failures = failures;
    results.sessions = dirs;
    await writeFile(out, JSON.stringify(results, null, 2));
    console.log(`\n${LIMITATION}\nresult: ${out}`);
    console.log(failures.length === 0 ? 'ALL OK' : `FAILED: ${failures.join(', ')}`);
    process.exitCode = failures.length === 0 ? 0 : 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
