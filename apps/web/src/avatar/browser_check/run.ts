/**
 * /dev/avatar の実ブラウザ確認（ヘッドレス Chromium、WebGL は SwiftShader）。
 *   AVATAR_VRM_PATH=/path/to/Sendagaya_Shino.vrm AVATAR_OUT=/path/to/out \
 *     npx tsx apps/web/src/avatar/browser_check/run.ts
 * VRM は Playwright の route で配信するので、リポジトリには置かない。
 * next dev はこのスクリプトが起動し、自分の子プロセスグループだけを止める。
 * 自然さの評価はできない。描画と値の変化の確認だけ。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright';
import { GazeReport } from '@llm-vap/contracts';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '../../..');
const repoRoot = path.resolve(webRoot, '../..');
const PORT = Number(process.env.AVATAR_TEST_PORT ?? 3477);
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

const telemetry = (page: Page) => page.evaluate(() => window.__avatarDev!.avatar()!.getTelemetry());

async function until(page: Page, predicate: string, timeoutMs = 60000): Promise<void> {
  await page.waitForFunction(
    `(() => { const t = window.__avatarDev?.avatar()?.getTelemetry(); return !!t && (${predicate}); })()`,
    undefined,
    { timeout: timeoutMs, polling: 100 },
  );
}

/** 2枚のスクリーンショットの差（描画領域内の変化した画素の割合）。領域は顔の周り。 */
async function diffRatio(page: Page, a: Buffer, b: Buffer): Promise<number> {
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
        return context.getImageData(0, 0, image.width, image.height).data;
      };
      const [x, y] = [await load(pa!), await load(pb!)];
      let changed = 0;
      for (let i = 0; i < x.length; i += 4) {
        const d = Math.abs(x[i]! - y[i]!) + Math.abs(x[i + 1]! - y[i + 1]!) + Math.abs(x[i + 2]! - y[i + 2]!);
        if (d > 24) changed += 1;
      }
      return changed / (x.length / 4);
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
    await waitForServer(`http://127.0.0.1:${PORT}/dev/avatar`);
    const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text());
    });
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    await page.addInitScript('window.__name = (f) => f');

    // 1. モデルが無いときの表示（route なしの 404）。
    await page.goto(`http://127.0.0.1:${PORT}/dev/avatar`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__avatarDev?.error() != null || window.__avatarDev?.avatar() != null, undefined, {
      timeout: 120000,
    });
    const noModel = await page.evaluate(() => window.__avatarDev!.error());
    check('モデルが無いときに失敗を表示する', noModel !== null, noModel ?? 'エラーにならなかった（public/models に実物がある）');
    await page.screenshot({ path: path.join(outDir!, '00_no_model.png') });
    consoleErrors.length = 0;

    // 2. 実物を route で配信して読む。
    const vrm = await readFile(vrmPath!);
    await page.route('**/models/Sendagaya_Shino.vrm', (route) =>
      route.fulfill({ status: 200, contentType: 'model/gltf-binary', body: vrm }),
    );
    const loadStart = Date.now();
    await page.goto(`http://127.0.0.1:${PORT}/dev/avatar`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__avatarDev?.avatar() != null || window.__avatarDev?.error() != null, undefined, {
      timeout: 180000,
    });
    const loadError = await page.evaluate(() => window.__avatarDev!.error());
    if (loadError) throw new Error(`読み込み失敗: ${loadError}`);
    await until(page, 't.frame > 3', 120000);
    check('VRM を読んで描画ループが回る', true, { loadMs: Date.now() - loadStart });

    const info = await page.evaluate(() => window.__avatarDev!.avatar()!.getModelInfo());
    await writeFile(path.join(outDir!, 'model_info.json'), JSON.stringify(info, null, 1));
    const renderer = await page.evaluate(() => {
      const canvas = document.querySelector('[data-testid=avatar-stage] canvas') as HTMLCanvasElement;
      const gl = canvas.getContext('webgl2');
      const ext = gl?.getExtension('WEBGL_debug_renderer_info');
      return { renderer: ext ? gl?.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null, width: canvas.width, height: canvas.height };
    });
    results.renderer = renderer;
    console.log('renderer', renderer);

    // 姿勢の向き（符号の誤りは値の変化だけでは見つからない）。
    const pose = await page.evaluate(() => {
      const a = window.__avatarDev!.avatar()!;
      const y = (n: string) => a.getBoneWorldPosition(n)!;
      return { lShoulder: y('leftUpperArm'), rShoulder: y('rightUpperArm'), lHand: y('leftHand'), rHand: y('rightHand'), head: y('head') };
    });
    check('腕が下りている（手が肩より下）', pose.lHand.y < pose.lShoulder.y - 0.2 && pose.rHand.y < pose.rShoulder.y - 0.2, pose);
    check('左腕がモデルの左（+X）にある', pose.lHand.x > 0 && pose.rHand.x < 0, { l: pose.lHand.x, r: pose.rHand.x });

    // 比較のため揺れと自動の瞬きを止め、髪が落ち着くのを待つ。
    await page.evaluate(() => {
      const a = window.__avatarDev!.avatar()!;
      a.setIdleIntensity(0);
      a.setAutoBlink(false);
      a.setFraming('bust');
    });
    await sleep(6000);
    const shot = (name: string) => page.screenshot({ path: path.join(outDir!, name) });
    const stage = page.locator('[data-testid=avatar-stage]');
    const stageShot = (name: string) => stage.screenshot({ path: path.join(outDir!, name) });

    await stageShot('01_bust_neutral.png');
    await shot('01_page_full.png');
    await page.evaluate(() => window.__avatarDev!.avatar()!.setFraming('face'));
    await sleep(2500);
    const base = await stageShot('02_face_mouth_closed_gaze_user.png');
    await sleep(1500);
    const baseAgain = await stage.screenshot();
    const noise = await diffRatio(page, base, baseAgain);
    check('対照: 何もしないときの画の変化が小さい', noise < 0.01, { ratio: noise });
    const t0 = await telemetry(page);
    check('初期の値', t0.mouth.open === 0 && t0.gaze.target === 'user', t0);

    // 3. 口。
    await page.evaluate(() => window.__avatarDev!.setManualRms(0.2));
    await until(page, 't.mouth.open > 0.6');
    await sleep(800);
    const open = await stageShot('03_face_mouth_open.png');
    const t1 = await telemetry(page);
    const openDiff = await diffRatio(page, base, open);
    check('音量で口の値と適用値が上がる', t1.mouth.open > 0.6 && t1.mouth.appliedAa > 0.6, t1.mouth);
    check('口の開きで画が変わる', openDiff > noise * 3 && openDiff > 0.001, { ratio: openDiff, noise });
    const levels: Record<string, number> = {};
    for (const rms of [0.003, 0.01, 0.03, 0.1]) {
      await page.evaluate((r) => window.__avatarDev!.setManualRms(r), rms);
      await sleep(900);
      levels[String(rms)] = (await telemetry(page)).mouth.open;
    }
    const values = Object.values(levels);
    check('音量に対して口が単調に開く', values.every((v, i) => i === 0 || v >= values[i - 1]!) && values.at(-1)! > values[0]! + 0.3, levels);
    // 音量が途絶えると閉じる。
    await page.evaluate(() => window.__avatarDev!.setManualRms(null));
    await until(page, 't.mouth.open === 0', 15000);
    check('音量が途絶えると閉じる', true, 'open=0');
    // 発話停止で閉じる。
    await page.evaluate(() => window.__avatarDev!.setManualRms(0.2));
    await until(page, 't.mouth.open > 0.6');
    const closed = await page.evaluate(async () => {
      const dev = window.__avatarDev!;
      dev.setManualRms(null);
      dev.avatar()!.closeMouth();
      const start = performance.now();
      while (dev.avatar()!.getTelemetry().mouth.open > 0.02 && performance.now() - start < 3000) {
        await new Promise((r) => requestAnimationFrame(r));
      }
      return performance.now() - start;
    });
    check('発話停止の後すぐ閉じる（描画フレームの間隔を含む）', closed < 1000, { ms: closed });

    // PCM の経路（模擬の音声包絡）。
    await page.evaluate(() => window.__avatarDev!.setSyntheticSpeech(true));
    const samples: number[] = [];
    for (let i = 0; i < 30; i += 1) {
      samples.push((await telemetry(page)).mouth.open);
      await sleep(100);
    }
    await page.evaluate(() => window.__avatarDev!.setSyntheticSpeech(false));
    check('PCM を入れると口が動く（模擬の包絡）', Math.max(...samples) - Math.min(...samples) > 0.15, {
      min: Math.min(...samples),
      max: Math.max(...samples),
    });
    await until(page, 't.mouth.open === 0', 15000);

    // 4. 視線。
    await sleep(1500);
    const beforeGaze = await stage.screenshot();
    const reportsBefore = await page.evaluate(() => window.__avatarDev!.gazeReports.length);
    await page.evaluate(() => window.__avatarDev!.avatar()!.setGaze('away'));
    await until(page, "t.gaze.target === 'away' && t.gaze.settled");
    await sleep(2500);
    const away = await stageShot('04_face_gaze_away.png');
    const tAway = await telemetry(page);
    const awayDiff = await diffRatio(page, beforeGaze, away);
    check('そらすと頭と眼の値が変わる', Math.abs(tAway.head.yawDeg) > 5 && Math.abs(tAway.gaze.leftEyeYawDeg) > 2, {
      head: tAway.head,
      gaze: tAway.gaze,
    });
    check('頭と眼が同じ向きへ動く', Math.sign(tAway.head.yawDeg) === Math.sign(tAway.gaze.leftEyeYawDeg), {
      headYaw: tAway.head.yawDeg,
      eyeYaw: tAway.gaze.leftEyeYawDeg,
    });
    check('そらすと頭も眼も下を向く（pitch の正が下）', tAway.head.pitchDeg > 1 && tAway.gaze.leftEyePitchDeg > 0.5, {
      head: tAway.head.pitchDeg,
      eye: tAway.gaze.leftEyePitchDeg,
    });
    const headDown = await page.evaluate(() => {
      const a = window.__avatarDev!.avatar()!;
      return a.getBoneWorldPosition('head');
    });
    results.headPositionAway = headDown;
    check('視線で画が変わる', awayDiff > 0.005 && awayDiff > noise * 3, { ratio: awayDiff, noise });
    // 補間の途中が飛ばない（フレームごとの頭の変化）。
    const trace = await page.evaluate(async () => {
      const a = window.__avatarDev!.avatar()!;
      a.setGaze('user');
      const points: { t: number; head: number; eye: number; away: number }[] = [];
      const start = performance.now();
      while (performance.now() - start < 2000) {
        await new Promise((r) => requestAnimationFrame(r));
        const v = a.getTelemetry();
        points.push({ t: performance.now() - start, head: v.head.yawDeg, eye: v.gaze.leftEyeYawDeg, away: v.gaze.awayAmount });
      }
      return points;
    });
    results.gazeReturnTrace = trace;
    const steps = trace.slice(1).map((p, i) => Math.abs(p.head - trace[i]!.head));
    check('戻す間に頭の値が段階的に動く', trace.length > 4 && new Set(trace.map((p) => p.head.toFixed(1))).size > 3, {
      frames: trace.length,
      maxStepDeg: Math.max(...steps),
    });
    await until(page, "t.gaze.target === 'user' && t.gaze.settled");
    await sleep(1500);
    const back = await stageShot('05_face_gaze_back.png');
    const backDiff = await diffRatio(page, beforeGaze, back);
    check('戻すと元の画に近づく', backDiff < awayDiff / 2, { backDiff, awayDiff });
    const reports = await page.evaluate(() => window.__avatarDev!.gazeReports);
    const fresh = reports.slice(reportsBefore);
    const parsed = fresh.map((r) => GazeReport.safeParse(r).success);
    check('gaze.report が契約に合い、目標の順に出る', parsed.length === 2 && parsed.every(Boolean) && fresh[0]?.target === 'away' && fresh[1]?.target === 'user', fresh);

    // 5. 瞬き。
    const blinkShot = await page.evaluate(async () => {
      const a = window.__avatarDev!.avatar()!;
      a.triggerBlink();
      const start = performance.now();
      let peak = 0;
      while (performance.now() - start < 1000) {
        await new Promise((r) => requestAnimationFrame(r));
        peak = Math.max(peak, a.getTelemetry().blink.weight);
      }
      return { peak, count: a.getTelemetry().blink.count };
    });
    check('手動の瞬きの重みが上がる（描画間隔に依存）', blinkShot.count === 1 && blinkShot.peak > 0, blinkShot);
    // 閉じた画は層で 1 に固定して撮る。瞬きの時間は短く、遅い描画では撮れないため。
    await page.evaluate(() => {
      window.__avatarDev!.avatar()!.addLayer({
        name: 'check_closed',
        update: (_c, f) => f.addExpression('blink', 1),
      });
    });
    await sleep(1200);
    const eyesClosed = await stageShot('06_face_eyes_closed.png');
    const blinkDiff = await diffRatio(page, beforeGaze, eyesClosed);
    check('まぶたを閉じると画が変わる', blinkDiff > noise * 3 && blinkDiff > 0.001, { ratio: blinkDiff, noise });
    const layers = (await telemetry(page)).layers;
    check('層を後から足せる', layers.includes('check_closed'), layers);
    await page.evaluate(() => window.__avatarDev!.avatar()!.removeLayer('check_closed'));
    await sleep(1000);
    const reopened = await stage.screenshot();
    check('層を外すと元に戻る', (await diffRatio(page, beforeGaze, reopened)) < blinkDiff / 2, 'reopened');

    // 6. 待機（既定の設定で動かして値を記録する）。
    await page.evaluate(() => {
      const a = window.__avatarDev!.avatar()!;
      a.setIdleIntensity(1);
      a.setAutoBlink(true);
      a.setFraming('bust');
    });
    const idleSeconds = 40;
    const idle = await page.evaluate(async (seconds) => {
      const a = window.__avatarDev!.avatar()!;
      const startCount = a.getTelemetry().blink.count;
      const blinkTimes: number[] = [];
      const yaw: number[] = [];
      const pitch: number[] = [];
      const roll: number[] = [];
      let previous = startCount;
      const startFrame = a.getTelemetry().frame;
      const start = performance.now();
      while (performance.now() - start < seconds * 1000) {
        await new Promise((r) => requestAnimationFrame(r));
        const v = a.getTelemetry();
        yaw.push(v.head.yawDeg);
        pitch.push(v.head.pitchDeg);
        roll.push(v.head.rollDeg);
        if (v.blink.count > previous) {
          blinkTimes.push(performance.now() - start);
          previous = v.blink.count;
        }
      }
      return {
        blinkTimes,
        frames: a.getTelemetry().frame - startFrame,
        seconds: (performance.now() - start) / 1000,
        range: {
          yaw: Math.max(...yaw) - Math.min(...yaw),
          pitch: Math.max(...pitch) - Math.min(...pitch),
          roll: Math.max(...roll) - Math.min(...roll),
        },
      };
    }, idleSeconds);
    results.idle = idle;
    const gaps = idle.blinkTimes.slice(1).map((v, i) => Math.round(v - idle.blinkTimes[i]!));
    check('待機で瞬きが起き、間隔が揃わない', idle.blinkTimes.length >= 3 && new Set(gaps.map((g) => Math.round(g / 200))).size > 1, {
      count: idle.blinkTimes.length,
      gapsMs: gaps,
    });
    check('待機で頭がわずかに動く', idle.range.yaw > 0.2 && idle.range.yaw < 5, idle.range);
    results.fpsSwiftShader = idle.frames / idle.seconds;
    console.log('fps (SwiftShader, 1100x760):', (idle.frames / idle.seconds).toFixed(1));
    await shot('07_page_idle_full.png');

    check('ページのエラーが無い', pageErrors.length === 0, pageErrors);
    const relevantConsole = consoleErrors.filter((m) => !m.includes('404'));
    check('コンソールのエラーが無い', relevantConsole.length === 0, relevantConsole);
    results.consoleErrors = consoleErrors;

    // 7. Strict Mode で破棄してもコンテキストが残らない: 再読み込みで再度描画できる。
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => window.__avatarDev?.avatar() != null, undefined, { timeout: 120000 });
    await until(page, 't.frame > 3', 60000);
    const canvases = await page.evaluate(() => document.querySelectorAll('[data-testid=avatar-stage] canvas').length);
    check('canvas が1枚だけ（Strict Mode の二重実行で増えない）', canvases === 1, { canvases });
  } finally {
    await writeFile(path.join(outDir!, 'results.json'), JSON.stringify(results, null, 1));
    await writeFile(path.join(outDir!, 'next.log'), nextLog);
    await browser.close();
    if (next.pid) {
      try {
        process.kill(-next.pid, 'SIGTERM'); // 自分が起動したプロセスグループのみ
      } catch {
        // 既に終了
      }
    }
  }
  console.log(failures.length === 0 ? 'ALL OK' : `FAILED: ${failures.join(', ')}`);
  process.exitCode = failures.length === 0 ? 0 : 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
