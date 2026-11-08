/**
 * /dev/breath の実ブラウザ確認（ヘッドレス Chromium、WebGL は SwiftShader）。
 *   AVATAR_VRM_PATH=/path/to/Sendagaya_Shino.vrm AVATAR_OUT=/path/to/out \
 *     npx tsx apps/web/src/avatar/browser_check/breath_shots.ts
 * 吸気前・吸気頂点（保持）・脱力後を正面と横から撮り、差分の画像とボーン位置の変化を書き出す。
 * next dev はこのスクリプトが起動し、自分の子プロセスグループだけを止める。
 * 自然さの評価はできない。体積変化が見えるか、頭や腕が歪まないかの確認だけ。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '../../..');
const repoRoot = path.resolve(webRoot, '../..');
const PORT = Number(process.env.AVATAR_TEST_PORT ?? 3478);
const vrmPath = process.env.AVATAR_VRM_PATH;
const outDir = process.env.AVATAR_OUT;
if (!vrmPath || !outDir) throw new Error('AVATAR_VRM_PATH と AVATAR_OUT が必要');

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const results: Record<string, unknown> = {};
const failures: string[] = [];
function check(name: string, ok: boolean, detail: unknown): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
  results[name] = { ok, detail };
  if (!ok) failures.push(name);
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

async function until(page: Page, predicate: string, timeoutMs = 60000): Promise<void> {
  await page.waitForFunction(
    `(() => { const t = window.__breathDev?.avatar()?.getTelemetry(); return !!t && (${predicate}); })()`,
    undefined,
    { timeout: timeoutMs, polling: 30 },
  );
}

const BONES = ['head', 'neck', 'leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'leftHand', 'rightHand', 'upperChest', 'leftShoulder'];

async function bones(page: Page): Promise<Record<string, { x: number; y: number; z: number }>> {
  return page.evaluate(async (names) => {
    // 描画のフレームを待ってから読む（読む時点の姿勢を確かにする）。
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const a = window.__breathDev!.avatar()!;
    return { frame: { x: a.getTelemetry().frame, y: 0, z: 0 }, ...Object.fromEntries(names.map((n) => [n, a.getBoneWorldPosition(n)!])) };
  }, BONES);
}

/** 2枚の差: 変化した画素の割合と、差を強調した画像（PNG の base64）。 */
async function diff(page: Page, a: Buffer, b: Buffer): Promise<{ ratio: number; png: string }> {
  return page.evaluate(
    async ([pa, pb]) => {
      const load = async (b64: string) => {
        const image = new Image();
        image.src = `data:image/png;base64,${b64}`;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext('2d')!;
        context.drawImage(image, 0, 0);
        return { data: context.getImageData(0, 0, image.width, image.height), canvas, context };
      };
      const x = await load(pa!);
      const y = await load(pb!);
      const out = x.context.createImageData(x.data.width, x.data.height);
      let changed = 0;
      for (let i = 0; i < x.data.data.length; i += 4) {
        const d =
          Math.abs(x.data.data[i]! - y.data.data[i]!) + Math.abs(x.data.data[i + 1]! - y.data.data[i + 1]!) + Math.abs(x.data.data[i + 2]! - y.data.data[i + 2]!);
        if (d > 24) changed += 1;
        const gray = (x.data.data[i]! + x.data.data[i + 1]! + x.data.data[i + 2]!) / 3;
        const v = Math.min(255, d * 4);
        out.data[i] = Math.max(gray * 0.5, v);
        out.data[i + 1] = gray * 0.5;
        out.data[i + 2] = gray * 0.5;
        out.data[i + 3] = 255;
      }
      x.context.putImageData(out, 0, 0);
      return { ratio: changed / (x.data.data.length / 4), png: x.canvas.toDataURL('image/png').split(',')[1]! };
    },
    [a.toString('base64'), b.toString('base64')] as const,
  );
}

async function main(): Promise<void> {
  await mkdir(outDir!, { recursive: true });
  const next: ChildProcess = spawn(path.join(repoRoot, 'node_modules/.bin/next'), ['dev', '-p', String(PORT), '--hostname', '127.0.0.1'], {
    cwd: webRoot,
    detached: true,
    stdio: 'pipe',
  });
  let nextLog = '';
  next.stdout?.on('data', (d: Buffer) => (nextLog += d.toString()));
  next.stderr?.on('data', (d: Buffer) => (nextLog += d.toString()));
  const browser = await chromium.launch({
    args: ['--use-angle=swiftshader', '--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  try {
    await waitForServer(`http://127.0.0.1:${PORT}/dev/breath`);
    const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    page.on('console', (m) => {
      if (m.type() === 'error') pageErrors.push(m.text());
    });
    await page.addInitScript('window.__name = (f) => f');
    const vrm = await readFile(vrmPath!);
    await page.route('**/models/Sendagaya_Shino.vrm', (route) => route.fulfill({ status: 200, contentType: 'model/gltf-binary', body: vrm }));
    await page.goto(`http://127.0.0.1:${PORT}/dev/breath`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__breathDev?.avatar() != null || window.__breathDev?.error() != null, undefined, { timeout: 180000 });
    const loadError = await page.evaluate(() => window.__breathDev!.error());
    if (loadError) throw new Error(`読み込み失敗: ${loadError}`);
    await until(page, 't.frame > 3', 120000);

    const info = await page.evaluate(() => window.__breathDev!.avatar()!.getModelInfo().breathMorph);
    check('胸郭モーフを作った', info.movedVertices > 0 && info.maxDisplacementMm > 3, info);

    // 切り分け: 待機の揺れ、視線移動、瞬き、通常呼吸を止める（吸気の変化だけを撮る）。
    await page.evaluate(() => {
      const a = window.__breathDev!.avatar()!;
      a.setIdleIntensity(0);
      a.setSaccades(false);
      a.setAutoBlink(false);
      a.setExpressionIntensity(0);
      a.setBreathParams({ normal: { depth: 0, headPitchDeg: 0 } });
      // SwiftShader の描画は遅く撮影に数秒かかるので、撮影の間だけ保持の上限を延ばす（実際の既定は HOLD_MAX_MS）。
      a.setBreathParams({ prep: { holdMaxMs: 30000 } });
    });
    const stage = page.locator('[data-testid=avatar-stage]');
    const fps = await page.evaluate(() => window.__breathDev!.avatar()!.getTelemetry().fps);
    results.fps = fps;

    for (const view of [
      { name: 'front', yaw: 0 },
      { name: 'side', yaw: 70 },
    ]) {
      await page.evaluate((yaw) => window.__breathDev!.avatar()!.setViewYaw(yaw), view.yaw);
      await sleep(1500);
      await until(page, "t.breath.phase === 'idle' && t.breath.normalGain < 0.02 || t.breath.phase === 'idle'");
      const before = await stage.screenshot({ path: path.join(outDir!, `${view.name}_1_before.png`) });
      const bonesBefore = await bones(page);
      await page.evaluate(() => window.__breathDev!.avatar()!.breath.startInhale({ cue_id: 'shot', duration_ms: 700 }));
      // 頂点（肩が頂点に着いた保持の始め）。描画が遅いので値で待つ。
      await until(page, "t.breath.phase === 'hold' && t.breath.prep.shoulder > 0.97", 20000);
      const bonesPeak = await bones(page);
      const peakTelemetry = await page.evaluate(() => window.__breathDev!.avatar()!.getTelemetry().breath);
      const peak = await stage.screenshot({ path: path.join(outDir!, `${view.name}_2_peak.png`) });
      const stillHolding = await page.evaluate(() => window.__breathDev!.avatar()!.breath.phase());
      check(`${view.name}: 撮影の間は保持のまま`, stillHolding === 'hold', stillHolding);
      await page.evaluate(() => window.__breathDev!.avatar()!.breath.release('deferred'));
      await until(page, "t.breath.phase === 'idle'", 20000);
      await sleep(800);
      const after = await stage.screenshot({ path: path.join(outDir!, `${view.name}_3_after.png`) });
      const bonesAfter = await bones(page);

      const d1 = await diff(page, before, peak);
      await writeFile(path.join(outDir!, `${view.name}_diff_before_peak.png`), Buffer.from(d1.png, 'base64'));
      const d2 = await diff(page, before, after);
      await writeFile(path.join(outDir!, `${view.name}_diff_before_after.png`), Buffer.from(d2.png, 'base64'));
      const moveMm = (a: Record<string, { x: number; y: number; z: number }>, b: Record<string, { x: number; y: number; z: number }>) =>
        Object.fromEntries(BONES.map((n) => [n, Math.round(Math.hypot(a[n]!.x - b[n]!.x, a[n]!.y - b[n]!.y, a[n]!.z - b[n]!.z) * 10000) / 10]));
      const peakMove = moveMm(bonesBefore, bonesPeak);
      const afterMove = moveMm(bonesBefore, bonesAfter);
      results[`${view.name}_peak_telemetry`] = peakTelemetry;
      results[`${view.name}_bone_move_mm_peak`] = peakMove;
      results[`${view.name}_bone_move_mm_after`] = afterMove;
      results[`${view.name}_bones_raw`] = { before: bonesBefore, peak: bonesPeak, after: bonesAfter };
      check(`${view.name}: 吸気の頂点で画が変わる`, d1.ratio > 0.002, { ratio: d1.ratio });
      check(`${view.name}: 脱力後は吸気前へ戻る`, d2.ratio < d1.ratio * 0.2, { ratio: d2.ratio });
      check(`${view.name}: 手の位置はほぼ動かない（上腕の逆補正）`, (peakMove.leftHand ?? 99) < 12 && (peakMove.rightHand ?? 99) < 12, peakMove);
      check(`${view.name}: 頭の移動は小さい`, (peakMove.head ?? 99) < 15, { head: peakMove.head });
    }
    await page.evaluate(() => window.__breathDev!.avatar()!.setViewYaw(0));
    await page.evaluate(() => window.__breathDev!.avatar()!.setBreathParams({ prep: { holdMaxMs: 800 } }));

    // 発話開始: 口の準備を口形へ譲る。
    await sleep(1200);
    await page.evaluate(() => window.__breathDev!.avatar()!.breath.startInhale({ cue_id: 'speech', duration_ms: 700 }));
    await until(page, "t.breath.phase === 'hold'", 20000);
    await page.evaluate(() => {
      window.__breathDev!.avatar()!.breath.release('speech_started');
      window.__breathDev!.speak(2000);
    });
    await until(page, "t.breath.phase === 'release' && t.breath.prep.mouth === 0", 20000);
    const speaking = await page.evaluate(() => window.__breathDev!.avatar()!.getTelemetry());
    await stage.screenshot({ path: path.join(outDir!, 'front_4_speech.png') });
    check('発話開始で口の準備は 0、胸はまだ残る', speaking.breath.prep.mouth === 0 && speaking.breath.phase === 'release', speaking.breath);
    const events = await page.evaluate(() => window.__breathDev!.events.map((e) => `${e.phase}:${e.cause ?? ''}`));
    results.events = events;
    check('ページのエラーが無い', pageErrors.length === 0, pageErrors.slice(0, 5));
  } finally {
    await browser.close();
    if (next.pid) {
      try {
        process.kill(-next.pid, 'SIGTERM');
      } catch {
        // 既に終わっている
      }
    }
    await writeFile(path.join(outDir!, 'results.json'), JSON.stringify(results, null, 1));
    if (failures.length > 0) await writeFile(path.join(outDir!, 'next.log'), nextLog);
  }
  console.log(failures.length === 0 ? 'ALL OK' : `FAILURES: ${failures.join(', ')}`);
  process.exitCode = failures.length === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
