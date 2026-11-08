/**
 * /dev/breath の時刻つき連続画像（成功・deferred・withdrawn・deferred→短い準備→発話）。ヘッドレス Chromium（SwiftShader）。
 *   AVATAR_VRM_PATH=/path/to/Sendagaya_Shino.vrm AVATAR_OUT=/path/to/out \
 *     npx tsx apps/web/src/avatar/browser_check/breath_series.ts
 * 描画が遅いので、層の時間を止めて（setTimeScale(0)）advanceTime で決まった時刻まで進めてから撮る。
 * 時刻は吸気の開始からの ms。値は既定のまま（保持の上限なども既定）。発話の口は模擬の音量（実音声ではない）。
 * 自然さの評価はできない。部位の動きの順序と、終わり方の違いが画に出ているかの確認だけ。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Locator, type Page } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '../../..');
const repoRoot = path.resolve(webRoot, '../..');
const PORT = Number(process.env.AVATAR_TEST_PORT ?? 3478);
const vrmPath = process.env.AVATAR_VRM_PATH;
const outDir = process.env.AVATAR_OUT;
if (!vrmPath || !outDir) throw new Error('AVATAR_VRM_PATH と AVATAR_OUT が必要');

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Action =
  | { at: number; do: 'inhale' }
  | { at: number; do: 'release'; reason: 'speech_started' | 'deferred' | 'withdrawn' }
  | { at: number; do: 'short' }
  | { at: number; do: 'shot' };

const inhaleShots = [0, 120, 240, 360, 480, 700, 880].map((at) => ({ at, do: 'shot' as const }));
const SERIES: Record<string, Action[]> = {
  success: [
    { at: 0, do: 'inhale' },
    ...inhaleShots,
    { at: 900, do: 'release', reason: 'speech_started' },
    ...[970, 1200, 1600, 2400, 3200].map((at) => ({ at, do: 'shot' as const })),
  ],
  deferred: [
    { at: 0, do: 'inhale' },
    ...inhaleShots,
    { at: 900, do: 'release', reason: 'deferred' },
    ...[1000, 1300, 1700, 2200, 3000, 4000, 5000].map((at) => ({ at, do: 'shot' as const })),
  ],
  withdrawn: [
    { at: 0, do: 'inhale' },
    ...inhaleShots,
    { at: 900, do: 'release', reason: 'withdrawn' },
    ...[1000, 1100, 1300, 1500, 1800].map((at) => ({ at, do: 'shot' as const })),
  ],
  deferred_then_speak: [
    { at: 0, do: 'inhale' },
    { at: 700, do: 'shot' },
    { at: 900, do: 'release', reason: 'deferred' },
    ...[1300, 2400].map((at) => ({ at, do: 'shot' as const })),
    { at: 2500, do: 'short' },
    ...[2500, 2625, 2750, 2900].map((at) => ({ at, do: 'shot' as const })),
    { at: 2950, do: 'release', reason: 'speech_started' },
    ...[3020, 3400].map((at) => ({ at, do: 'shot' as const })),
  ],
};

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

/** 描画を2フレーム待つ（advanceTime を反映させる）。 */
const frames = (page: Page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

async function sheet(page: Page, tiles: { png: Buffer; label: string }[], title: string): Promise<Buffer> {
  const b64 = await page.evaluate(
    async ({ images, title }) => {
      const loaded = await Promise.all(
        images.map(async ({ png, label }) => {
          const image = new Image();
          image.src = `data:image/png;base64,${png}`;
          await image.decode();
          return { image, label };
        }),
      );
      const scale = 0.5;
      const w = Math.round(loaded[0]!.image.width * scale);
      const h = Math.round(loaded[0]!.image.height * scale);
      const cols = Math.min(6, loaded.length);
      const rows = Math.ceil(loaded.length / cols);
      const canvas = document.createElement('canvas');
      canvas.width = cols * w;
      canvas.height = rows * (h + 22) + 28;
      const c = canvas.getContext('2d')!;
      c.fillStyle = '#fff';
      c.fillRect(0, 0, canvas.width, canvas.height);
      c.fillStyle = '#000';
      c.font = '16px sans-serif';
      c.fillText(title, 6, 20);
      loaded.forEach(({ image, label }, i) => {
        const x = (i % cols) * w;
        const y = 28 + Math.floor(i / cols) * (h + 22);
        c.drawImage(image, x, y + 20, w, h);
        c.fillStyle = '#000';
        c.font = '13px monospace';
        c.fillText(label, x + 4, y + 15);
      });
      return canvas.toDataURL('image/png').split(',')[1]!;
    },
    { images: tiles.map((t) => ({ png: t.png.toString('base64'), label: t.label })), title },
  );
  return Buffer.from(b64, 'base64');
}

async function runSeries(page: Page, stage: Locator, name: string, actions: Action[], view: string): Promise<unknown[]> {
  const box = (await stage.boundingBox())!;
  const clip = { x: box.x + box.width * 0.12, y: box.y + box.height * 0.28, width: box.width * 0.76, height: box.height * 0.72 };
  // 静かな状態から始める。
  await page.evaluate(() => {
    const a = window.__breathDev!.avatar()!;
    a.setTimeScale(0);
    a.advanceTime(1500);
  });
  await frames(page);
  let t = 0;
  const tiles: { png: Buffer; label: string }[] = [];
  const trace: unknown[] = [];
  const sorted = [...actions].sort((a, b) => a.at - b.at || (a.do === 'shot' ? 1 : -1));
  for (const action of sorted) {
    if (action.at > t) {
      await page.evaluate((ms) => window.__breathDev!.avatar()!.advanceTime(ms), action.at - t);
      await frames(page);
      t = action.at;
    }
    if (action.do === 'inhale') await page.evaluate(() => window.__breathDev!.avatar()!.breath.startInhale({ cue_id: 'series', duration_ms: 700 }));
    else if (action.do === 'release') {
      await page.evaluate((reason) => {
        window.__breathDev!.avatar()!.breath.release(reason);
        if (reason === 'speech_started') window.__breathDev!.speak(60000);
      }, action.reason);
    } else if (action.do === 'short') await page.evaluate(() => window.__breathDev!.avatar()!.breath.prepareShort?.());
    else {
      const telemetry = await page.evaluate(() => {
        const tm = window.__breathDev!.avatar()!.getTelemetry();
        return { breath: tm.breath, mouthOpen: tm.mouth.open };
      });
      const png = await page.screenshot({ clip });
      await writeFile(path.join(outDir!, `${name}_${view}_${String(action.at).padStart(5, '0')}ms.png`), png);
      const b = telemetry.breath;
      tiles.push({ png, label: `${action.at}ms ${b.phase}${b.releaseKind ? `/${b.releaseKind}` : ''} 胸${b.prep.chest.toFixed(2)} 口${b.prep.mouth.toFixed(2)}` });
      trace.push({ at: action.at, ...telemetry });
    }
  }
  await writeFile(path.join(outDir!, `sheet_${name}_${view}.png`), await sheet(page, tiles, `${name} (${view})  時刻は吸気開始から`));
  // 次の系列のために戻す（発話の模擬を止め、時間を流して idle へ）。
  await page.evaluate(() => {
    window.__breathDev!.speak(0);
    const a = window.__breathDev!.avatar()!;
    a.advanceTime(8000);
  });
  await frames(page);
  return trace;
}

async function main(): Promise<void> {
  await mkdir(outDir!, { recursive: true });
  const next: ChildProcess = spawn(path.join(repoRoot, 'node_modules/.bin/next'), ['dev', '-p', String(PORT), '--hostname', '127.0.0.1'], {
    cwd: webRoot,
    detached: true,
    stdio: 'ignore',
  });
  const browser = await chromium.launch({
    args: ['--use-angle=swiftshader', '--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  const results: Record<string, unknown> = {};
  let ok = true;
  try {
    await waitForServer(`http://127.0.0.1:${PORT}/dev/breath`);
    const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.addInitScript('window.__name = (f) => f');
    const vrm = await readFile(vrmPath!);
    await page.route('**/models/Sendagaya_Shino.vrm', (route) => route.fulfill({ status: 200, contentType: 'model/gltf-binary', body: vrm }));
    await page.goto(`http://127.0.0.1:${PORT}/dev/breath`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__breathDev?.avatar() != null || window.__breathDev?.error() != null, undefined, { timeout: 180000 });
    const loadError = await page.evaluate(() => window.__breathDev!.error());
    if (loadError) throw new Error(`読み込み失敗: ${loadError}`);
    await page.waitForFunction(() => window.__breathDev!.avatar()!.getTelemetry().frame > 3, undefined, { timeout: 120000 });
    await page.evaluate(() => {
      const a = window.__breathDev!.avatar()!;
      a.setIdleIntensity(0);
      a.setSaccades(false);
      a.setAutoBlink(false);
      a.setExpressionIntensity(0);
      a.setBreathParams({ normal: { depth: 0, headPitchDeg: 0 } });
    });
    const stage = page.locator('[data-testid=avatar-stage]');
    for (const view of [
      { name: 'front', yaw: 0 },
      { name: 'side', yaw: 65 },
    ]) {
      await page.evaluate((yaw) => window.__breathDev!.avatar()!.setViewYaw(yaw), view.yaw);
      for (const [name, actions] of Object.entries(SERIES)) {
        results[`${name}_${view.name}`] = await runSeries(page, stage, name, actions, view.name);
        console.log(`done ${name} ${view.name}`);
      }
    }
    results.events = await page.evaluate(() => window.__breathDev!.events.map((e) => `${e.phase}[${e.kind ?? ''}]:${e.cause ?? ''}`));
    results.errors = errors;
    ok = errors.length === 0;
  } catch (e) {
    console.error(e);
    ok = false;
  } finally {
    await browser.close();
    if (next.pid) {
      try {
        process.kill(-next.pid, 'SIGTERM');
      } catch {
        // 既に終わっている
      }
    }
    await writeFile(path.join(outDir!, 'series.json'), JSON.stringify(results, null, 1));
  }
  console.log(ok ? 'ALL OK' : 'FAILURES');
  process.exitCode = ok ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
