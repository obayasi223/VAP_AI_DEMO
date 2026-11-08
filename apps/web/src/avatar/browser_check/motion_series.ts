/**
 * 一連の動作（motion_sequences.ts の台本）の連続画像。ヘッドレス Chromium（SwiftShader）。
 *   AVATAR_VRM_PATH=/path/to/Sendagaya_Shino.vrm AVATAR_OUT=/path/to/out npx tsx apps/web/src/avatar/browser_check/motion_series.ts
 * 層の時間を止めて（setTimeScale(0)）決まった時刻まで進めて撮る（遅い描画でも時刻が揃う）。発声は模擬の口形（setMouthSource）。
 * 待機の揺れ・瞬き・表情・通常呼吸は切り、部位の動きの順序と破綻の有無だけを見る。自然さの評価はできない。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright';
import { MOTION_SEQUENCES, type MotionSequence } from '../motion_sequences';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '../../..');
const repoRoot = path.resolve(webRoot, '../..');
const PORT = Number(process.env.AVATAR_TEST_PORT ?? 3479);
const vrmPath = process.env.AVATAR_VRM_PATH;
const outDir = process.env.AVATAR_OUT;
if (!vrmPath || !outDir) throw new Error('AVATAR_VRM_PATH と AVATAR_OUT が必要');

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 撮る時刻（ms）: 全手の前後と、等間隔を混ぜる。 */
function shotTimes(sequence: MotionSequence): number[] {
  const times = new Set<number>([0]);
  for (let t = 0; t <= sequence.totalMs; t += 500) times.add(t);
  for (const step of sequence.steps) for (const offset of [-32, 120]) times.add(Math.max(0, step.atMs + offset));
  return [...times].filter((t) => t <= sequence.totalMs).sort((a, b) => a - b);
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

const frames = (page: Page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

async function runSequence(page: Page, sequence: MotionSequence, view: string): Promise<unknown[]> {
  const stage = page.locator('[data-testid=avatar-stage]');
  const box = (await stage.boundingBox())!;
  const clip = { x: box.x + box.width * 0.2, y: box.y + box.height * 0.25, width: box.width * 0.6, height: box.height * 0.7 };
  // 模擬の口形（layer 時間で）と静かな開始。
  await page.evaluate(() => {
    const a = window.__breathDev!.avatar()!;
    (window as unknown as { __mouthOpen: number }).__mouthOpen = 0;
    a.setMouthSource({
      update: () => ({ aa: (window as unknown as { __mouthOpen: number }).__mouthOpen, ih: 0, ou: 0, ee: 0, oh: 0 }),
    });
    a.setTimeScale(0);
    a.advanceTime(4000);
  });
  await frames(page);

  const steps = [...sequence.steps].sort((a, b) => a.atMs - b.atMs);
  const shots = shotTimes(sequence);
  const actions = [...steps.map((s) => ({ at: s.atMs, step: s })), ...shots.map((at) => ({ at, shot: true as const }))].sort(
    (a, b) => a.at - b.at || ('shot' in a ? 1 : -1),
  );
  let t = 0;
  const trace: unknown[] = [];
  const tiles: { png: Buffer; label: string }[] = [];
  for (const action of actions) {
    if (action.at > t) {
      await page.evaluate((ms) => window.__breathDev!.avatar()!.advanceTime(ms), action.at - t);
      await frames(page);
      t = action.at;
    }
    if ('step' in action) {
      await page.evaluate((step: { do: string; durationMs?: number }) => {
        const a = window.__breathDev!.avatar()!;
        const w = window as unknown as { __mouthOpen: number };
        switch (step.do) {
          case 'inhale':
            a.breath.startInhale({ cue_id: 'series', duration_ms: step.durationMs ?? 700 });
            break;
          case 'prepare_short':
            a.breath.prepareShort?.(step.durationMs ?? 150);
            break;
          case 'speak_start':
            w.__mouthOpen = 0.45;
            break;
          case 'speak_stop':
            w.__mouthOpen = 0;
            break;
          default:
            a.breath.release(step.do as 'speech_started' | 'deferred' | 'withdrawn');
        }
      }, action.step);
      continue;
    }
    const telemetry = await page.evaluate(() => {
      const tm = window.__breathDev!.avatar()!.getTelemetry();
      return { breath: tm.breath, mouth: tm.mouth.open };
    });
    const png = await page.screenshot({ clip });
    const b = telemetry.breath;
    await writeFile(path.join(outDir!, `${sequence.id}_${view}_${String(action.at).padStart(5, '0')}ms.png`), png);
    tiles.push({ png, label: `${action.at}ms ${b.phase}${b.releaseKind ? `/${b.releaseKind}` : ''} 胸${b.prep.chest.toFixed(2)} 肩${b.prep.shoulder.toFixed(2)} 頭${b.prep.head.toFixed(2)} 口${b.prep.mouth.toFixed(2)}` });
    trace.push({ at: action.at, ...telemetry });
  }
  await writeFile(path.join(outDir!, `sheet_${sequence.id}_${view}.png`), await sheet(page, tiles, `${sequence.label} (${view})`));
  await page.evaluate(() => {
    const a = window.__breathDev!.avatar()!;
    (window as unknown as { __mouthOpen: number }).__mouthOpen = 0;
    a.setMouthSource(null);
    a.advanceTime(6000);
  });
  await frames(page);
  return trace;
}

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
      const scale = 0.42;
      const w = Math.round(loaded[0]!.image.width * scale);
      const h = Math.round(loaded[0]!.image.height * scale);
      const cols = 8;
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
        c.font = '11px monospace';
        c.fillText(label, x + 2, y + 15, w - 4);
      });
      return canvas.toDataURL('image/png').split(',')[1]!;
    },
    { images: tiles.map((t) => ({ png: t.png.toString('base64'), label: t.label })), title },
  );
  return Buffer.from(b64, 'base64');
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
    // 描画が遅い（SwiftShader）ので小さく撮る。
    const page = await browser.newPage({ viewport: { width: 760, height: 560 } });
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
    // 横からは胸の動きの確認。時間がかかるので AVATAR_SIDE=1 のときだけ。
    for (const view of process.env.AVATAR_SIDE === '1' ? [{ name: 'front', yaw: 0 }, { name: 'side', yaw: 65 }] : [{ name: 'front', yaw: 0 }]) {
      await page.evaluate((yaw) => window.__breathDev!.avatar()!.setViewYaw(yaw), view.yaw);
      for (const sequence of MOTION_SEQUENCES) {
        results[`${sequence.id}_${view.name}`] = await runSequence(page, sequence, view.name);
        console.log(`done ${sequence.id} ${view.name}`);
      }
    }
    // 画面のボタンで1本だけ実時間で再生して、タイムラインが出るのと、onBreathPhase（参加者画面の報告の経路）に局面が届くのを確かめる。
    await page.evaluate(() => {
      const a = window.__breathDev!.avatar()!;
      a.setTimeScale(1);
      const seen: string[] = [];
      (window as unknown as { __phases: string[] }).__phases = seen;
      a.onBreathPhase((e) => seen.push(`${e.phase}:${e.cause ?? ''}:${Math.round(e.nowMs)}`));
      window.__breathDev!.playSequence('withdraw_mid_inhale');
    });
    await sleep(3000);
    results.timeline = await page.locator('[data-testid=timeline]').innerText();
    results.phasesFromListener = await page.evaluate(() => (window as unknown as { __phases: string[] }).__phases);
    if ((results.phasesFromListener as string[]).length < 3) throw new Error('onBreathPhase に局面が届いていない');
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
