/**
 * 顔の見え方の確認用スクリーンショット（ヘッドレス Chromium、WebGL は SwiftShader）。
 *   AVATAR_OUT=/path/to/out AVATAR_LABEL=after npx tsx apps/web/src/avatar/browser_check/face_shots.ts
 * 既に動いている next dev を使うときは AVATAR_BASE_URL=http://127.0.0.1:3000 を渡す（起動しない）。
 * 渡さなければ自分で next dev を起動し、終わったら自分のプロセスグループだけを止める。
 * SwiftShader と実 GPU では、アンチエイリアスやテクスチャの補間の見え方が違いうる。自然さの評価には使えない。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '../../..');
const repoRoot = path.resolve(webRoot, '../..');
const outDir = process.env.AVATAR_OUT;
const label = process.env.AVATAR_LABEL ?? 'shot';
const PORT = Number(process.env.AVATAR_TEST_PORT ?? 3478);
const baseUrl = process.env.AVATAR_BASE_URL ?? null;
const scale = Number(process.env.AVATAR_DPR ?? 1);
/** /dev/avatar に足すクエリ（例: &render=h1）。 */
const extraQuery = process.env.AVATAR_QUERY ?? '';
const skipParticipant = process.env.AVATAR_SKIP_PARTICIPANT === '1';
if (!outDir) throw new Error('AVATAR_OUT が必要');

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

async function waitAvatar(page: Page, key: '__avatarDev' | '__participant'): Promise<void> {
  await page.waitForFunction(
    (k) => {
      const w = window as unknown as Record<string, { avatar(): unknown; error?: () => unknown; avatarError?: () => unknown } | undefined>;
      const h = w[k];
      return !!h && (h.avatar() != null || (h.error?.() ?? h.avatarError?.()) != null);
    },
    key,
    { timeout: 240000, polling: 250 },
  );
}

async function main(): Promise<void> {
  await mkdir(outDir!, { recursive: true });
  let next: ChildProcess | null = null;
  let nextLog = '';
  const root = baseUrl ?? `http://127.0.0.1:${PORT}`;
  if (!baseUrl) {
    next = spawn(path.join(repoRoot, 'node_modules/.bin/next'), ['dev', '-p', String(PORT), '--hostname', '127.0.0.1'], {
      cwd: webRoot,
      detached: true,
      stdio: 'pipe',
    });
    next.stdout?.on('data', (d: Buffer) => (nextLog += d.toString()));
    next.stderr?.on('data', (d: Buffer) => (nextLog += d.toString()));
  }
  const browser = await chromium.launch({
    args: ['--use-angle=swiftshader', '--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  const log: string[] = [];
  try {
    await waitForServer(`${root}/dev/avatar`);
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: scale });
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') log.push(`${m.type()}: ${m.text()}`);
    });
    page.on('pageerror', (e) => log.push(`pageerror: ${String(e)}`));
    await page.addInitScript('window.__name = (f) => f');

    // 参加者画面の既定の画角（はじめるを押す前の状態）。
    if (!skipParticipant) {
      await page.goto(`${root}/`, { waitUntil: 'load' });
      await waitAvatar(page, '__participant');
      await page.evaluate(() => {
        const a = (window as unknown as { __participant: { avatar(): import('../runtime').Avatar } }).__participant.avatar();
        a.setIdleIntensity(0);
        a.setAutoBlink(false);
        a.setSaccades?.(false);
      });
      await sleep(7000);
      const box = await page.locator('[data-testid=avatar-stage]').boundingBox();
      await page.screenshot({ path: path.join(outDir!, `${label}_participant.png`), clip: box!, timeout: 120000 });
    }

    await page.goto(`${root}/dev/avatar?framing=face${extraQuery}`, { waitUntil: 'load' });
    await waitAvatar(page, '__avatarDev');
    const error = await page.evaluate(() => window.__avatarDev!.error());
    if (error) throw new Error(error);
    await page.evaluate(() => {
      const a = window.__avatarDev!.avatar()!;
      a.setIdleIntensity(0);
      a.setAutoBlink(false);
      // H1 にはこの口が無い（比較の 'before' は H1 のコードで撮る）。
      a.setSaccades?.(false);
    });
    await sleep(7000);
    const stageLocator = page.locator('[data-testid=avatar-stage]');
    // locator.screenshot は要素が「安定」するまで待ち、描画が重い SwiftShader では時間切れになることがある。範囲で撮る。
    const stage = {
      screenshot: async (options: { path: string }) => {
        const box = await stageLocator.boundingBox();
        if (!box) throw new Error('stage が無い');
        await page.screenshot({ path: options.path, clip: box, timeout: 120000 });
      },
    };
    await stage.screenshot({ path: path.join(outDir!, `${label}_face_closed.png`) });

    await page.evaluate(() => window.__avatarDev!.setManualRms(Math.pow(10, -18 / 20)));
    await sleep(800);
    await stage.screenshot({ path: path.join(outDir!, `${label}_face_open.png`) });
    await page.evaluate(() => {
      window.__avatarDev!.setManualRms(null);
      window.__avatarDev!.avatar()!.closeMouth();
    });
    await sleep(800);

    if (process.env.AVATAR_EXTRA === '1') {
      // 母音の口形（VOWEL_SHAPES × 0.85）を固定で当てて形を見る。
      const vowels: Record<string, Record<string, number>> = {
        a: { aa: 0.85 },
        i: { ih: 0.6, aa: 0.085 },
        u: { ou: 0.64 },
        e: { ee: 0.64, aa: 0.13 },
        o: { oh: 0.77 },
        blink: { blink: 1 },
      };
      for (const [name, weights] of Object.entries(vowels)) {
        await page.evaluate((w) => {
          window.__avatarDev!.avatar()!.addLayer({
            name: 'shot',
            update: (_c, frame) => {
              for (const [k, v] of Object.entries(w)) frame.addExpression(k, v);
            },
          });
        }, weights);
        await sleep(900);
        await stage.screenshot({ path: path.join(outDir!, `${label}_shape_${name}.png`) });
        await page.evaluate(() => window.__avatarDev!.avatar()!.removeLayer('shot'));
      }
      await sleep(500);
      // 模擬の発話の間の口の値（語時刻が使えた区間と、漢字の語で音量だけへ戻る区間）。
      const series = await page.evaluate(async () => {
        const dev = window.__avatarDev!;
        const duration = dev.speakKana();
        const start = performance.now();
        const out: { t: number; mode: string; open: number; shape: Record<string, number>; pos: number | null }[] = [];
        while (performance.now() - start < duration + 300) {
          const t = dev.avatar()!.getTelemetry();
          out.push({ t: Math.round(performance.now() - start), mode: t.mouth.mode, open: t.mouth.open, shape: t.mouth.shape as unknown as Record<string, number>, pos: t.mouth.playbackPositionMs });
          await new Promise((r) => setTimeout(r, 40));
        }
        return out;
      });
      await writeFile(path.join(outDir!, `${label}_lipsync_series.json`), JSON.stringify(series));
      await page.evaluate(() => window.__avatarDev!.speakKana(['あおいうえお', 'まみむめも'], 160));
      await sleep(700);
      await stage.screenshot({ path: path.join(outDir!, `${label}_speaking.png`) });
      await sleep(2500);
    }

    await page.evaluate(() => window.__avatarDev!.avatar()!.setFraming('bust'));
    await sleep(2500);
    await stage.screenshot({ path: path.join(outDir!, `${label}_bust.png`) });
    log.push(JSON.stringify(await page.evaluate(() => window.__avatarDev!.avatar()!.getTelemetry())));
  } finally {
    await writeFile(path.join(outDir!, `${label}_log.txt`), `${log.join('\n')}\n----- next\n${nextLog}`);
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

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
