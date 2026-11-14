/**
 * 2 体の配置と視線の静止画（docs/design/two_ai/03 §5.2 の two_ai_shots）。ヘッドレス Chromium（WebGL は SwiftShader）だけを使う。
 *   AVATAR_OUT=/path/to/out npx tsx apps/web/src/avatar/browser_check/two_ai_shots.ts
 * 既に動いている next dev を使うときは AVATAR_BASE_URL=http://127.0.0.1:3479 のように渡す（起動しない）。
 * 渡さなければ自分で next dev を AVATAR_TEST_PORT（既定 3479）で起動し、終わったら自分のプロセスグループだけを止める。
 * 利用者の 3000／8787 には触れない。/dev/two_ai に足すクエリは AVATAR_QUERY（例 &a=vrm&b=rb_ma09&layout_yaw=30）。
 * 撮るもの: A／B × user／peer／away の 6 枚と全体の 1 枚。合否は自動で決めず、人が見る（face_shots と同じ扱い）。
 * 自動で確かめるのは頭の yaw の符号だけ（peer: A が +、B が −。user: 頭が利用者の側＝A が −、B が +）。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, type Page } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '../../..');
const repoRoot = path.resolve(webRoot, '../..');

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Ai = 'A' | 'B';
type Target = 'user' | 'peer' | 'away';

export interface TwoAiShotResult {
  checks: { name: string; ok: boolean; detail: unknown }[];
  headYaw: Record<Ai, Partial<Record<Target, number>>>;
  telemetry: unknown;
  errors: Partial<Record<Ai, string>>;
}

/** 開いたページで /dev/two_ai を撮る。run.ts からも呼べる。 */
export async function twoAiShots(page: Page, root: string, outDir: string, query = ''): Promise<TwoAiShotResult> {
  await mkdir(outDir, { recursive: true });
  await page.goto(`${root}/dev/two_ai?${query.replace(/^[?&]/, '')}`, { waitUntil: 'load' });
  await page.waitForFunction(
    () => {
      const dev = window.__twoAiDev;
      if (!dev) return false;
      const stage = dev.stage();
      const errors = dev.errors();
      const done = (ai: 'A' | 'B') => stage?.avatar(ai) != null || errors[ai] != null;
      return (stage !== null && done('A') && done('B')) || (errors.A != null && errors.B != null);
    },
    undefined,
    { timeout: 240000, polling: 250 },
  );
  const errors = await page.evaluate(() => window.__twoAiDev!.errors());
  // 層の揺れを止めて、視線だけが変わるようにする。
  await page.evaluate(() => {
    for (const ai of ['A', 'B'] as const) {
      const a = window.__twoAiDev!.stage()?.avatar(ai);
      if (!a) continue;
      a.setIdleIntensity(0);
      a.setAutoBlink(false);
      a.setSaccades(false);
      a.setExpressionIntensity(0);
    }
  });
  const stageLocator = page.locator('[data-testid=two-ai-stage]');
  const shot = async (name: string) => {
    const box = await stageLocator.boundingBox();
    if (!box) throw new Error('stage が無い');
    await page.screenshot({ path: path.join(outDir, name), clip: box, timeout: 120000 });
  };
  await sleep(3000);
  await shot('two_ai_overview.png');

  const headYaw: TwoAiShotResult['headYaw'] = { A: {}, B: {} };
  for (const ai of ['A', 'B'] as const) {
    if (errors[ai]) continue;
    for (const target of ['user', 'peer', 'away'] as const) {
      await page.evaluate(
        ([id, t]) => {
          const stage = window.__twoAiDev!.stage()!;
          // 撮らない側は利用者を見たまま。
          for (const other of ['A', 'B'] as const) stage.avatar(other)?.setGaze(other === id ? t : 'user');
        },
        [ai, target] as const,
      );
      await sleep(2500);
      headYaw[ai][target] = await page.evaluate((id) => window.__twoAiDev!.stage()!.avatar(id)!.getTelemetry().head.yawDeg, ai);
      await shot(`two_ai_${ai}_${target}.png`);
    }
    await page.evaluate((id) => window.__twoAiDev!.stage()!.avatar(id)!.setGaze('user'), ai);
    await sleep(1500);
  }

  const checks: TwoAiShotResult['checks'] = [];
  const check = (name: string, ok: boolean, detail: unknown) => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(detail)}`);
    checks.push({ name, ok, detail });
  };
  if (!errors.A) {
    check('peer のとき A の頭の yaw が +', (headYaw.A.peer ?? 0) > 0, headYaw.A);
    check('user のとき A の頭が利用者の側（−）', (headYaw.A.user ?? 0) < 0, headYaw.A);
  }
  if (!errors.B) {
    check('peer のとき B の頭の yaw が −', (headYaw.B.peer ?? 0) < 0, headYaw.B);
    check('user のとき B の頭が利用者の側（+）', (headYaw.B.user ?? 0) > 0, headYaw.B);
  }
  const telemetry = await page.evaluate(() => window.__twoAiDev!.stage()?.getTelemetry() ?? null);
  const result: TwoAiShotResult = { checks, headYaw, telemetry, errors };
  await writeFile(path.join(outDir, 'two_ai_shots.json'), JSON.stringify({ ...result, note: 'SwiftShader の値は実機の GPU の値ではない' }, null, 1));
  return result;
}

async function waitForServer(url: string): Promise<void> {
  for (let i = 0; i < 240; i += 1) {
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
    } catch {
      // 起動待ち
    }
    await sleep(500);
  }
  throw new Error('next dev が起動しなかった');
}

async function main(): Promise<void> {
  const outDir = process.env.AVATAR_OUT;
  if (!outDir) throw new Error('AVATAR_OUT が必要');
  const baseUrl = process.env.AVATAR_BASE_URL ?? null;
  const port = Number(process.env.AVATAR_TEST_PORT ?? 3479);
  if (port === 3000 || port === 8787) throw new Error('3000／8787 は利用者のサーバー。別のポートを使う');
  const root = baseUrl ?? `http://127.0.0.1:${port}`;
  let next: ChildProcess | null = null;
  let nextLog = '';
  if (!baseUrl) {
    next = spawn(path.join(repoRoot, 'node_modules/.bin/next'), ['dev', '-p', String(port), '--hostname', '127.0.0.1'], {
      cwd: webRoot,
      detached: true,
      stdio: 'pipe',
    });
    next.stdout?.on('data', (d: Buffer) => (nextLog += d.toString()));
    next.stderr?.on('data', (d: Buffer) => (nextLog += d.toString()));
  }
  // ヘッドレス Chromium のみ（利用者の Chrome は使わない）。
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-angle=swiftshader', '--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  const log: string[] = [];
  try {
    await waitForServer(`${root}/dev/two_ai`);
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') log.push(`${m.type()}: ${m.text()}`);
    });
    page.on('pageerror', (e) => log.push(`pageerror: ${String(e)}`));
    await page.addInitScript('window.__name = (f) => f');
    const result = await twoAiShots(page, root, outDir, process.env.AVATAR_QUERY ?? '');
    const failed = result.checks.filter((c) => !c.ok).map((c) => c.name);
    console.log(failed.length === 0 ? 'SIGNS OK（見た目は人が確認）' : `FAILED: ${failed.join(', ')}`);
    process.exitCode = failed.length === 0 ? 0 : 1;
  } finally {
    await writeFile(path.join(outDir, 'two_ai_shots_log.txt'), `${log.join('\n')}\n----- next\n${nextLog}`);
    await browser.close();
    if (next?.pid) {
      try {
        process.kill(-next.pid, 'SIGTERM'); // 自分が起動したプロセスグループのみ
      } catch {
        // 既に終了
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
