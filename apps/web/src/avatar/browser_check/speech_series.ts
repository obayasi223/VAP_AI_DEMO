/**
 * AI の発話中とその前後の連続画像と時系列（docs/speech_motion_audit.md）。ヘッドレス Chromium（SwiftShader）。
 *   AVATAR_VRM_PATH=/path/to/Sendagaya_Shino.vrm AVATAR_WAV=/path/to/ja.wav AVATAR_OUT=/path/to/out \
 *     npx tsx apps/web/src/avatar/browser_check/speech_series.ts
 * 音声（16bit モノラル WAV）から再生音の RMS を AnalyserNode と同じ窓（1024 サンプル @48kHz）で求め、本物の口（lipsync.ts）へ通した
 * 口形を層の時間に沿って流す。層の時間を止めて（setTimeScale(0)）決まった時刻で撮るので、遅い描画でも時刻が揃う。
 * 語時刻は無し（Gemini TTS と同じ音量だけの口）。層は全部動かす（待機の揺れ、瞬き、視線移動、表情、通常呼吸）。自然さの評価はできない。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright';
import { AlignmentMouthSource } from '../lipsync';
import { VolumeMouthSource, type MouthShape } from '../mouth';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '../../..');
const repoRoot = path.resolve(webRoot, '../..');
const PORT = Number(process.env.AVATAR_TEST_PORT ?? 3481);
const vrmPath = process.env.AVATAR_VRM_PATH;
const wavPath = process.env.AVATAR_WAV;
const outDir = process.env.AVATAR_OUT;
if (!vrmPath || !wavPath || !outDir) throw new Error('AVATAR_VRM_PATH、AVATAR_WAV、AVATAR_OUT が必要');

const STEP_MS = 16;
const SAMPLE_RATE = 48000;
const ANALYSER_SIZE = 1024;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function parseWav(b: Buffer): Float32Array {
  const rate = b.readUInt32LE(24);
  let p = 12;
  while (b.toString('latin1', p, p + 4) !== 'data') p += 8 + b.readUInt32LE(p + 4);
  const n = b.readUInt32LE(p + 4) / 2;
  const out = new Float32Array(Math.floor((n * SAMPLE_RATE) / rate));
  for (let i = 0; i < out.length; i += 1) {
    const x = (i * rate) / SAMPLE_RATE;
    const j = Math.min(Math.floor(x), n - 2);
    const f = x - j;
    out[i] = ((1 - f) * b.readInt16LE(p + 8 + j * 2) + f * b.readInt16LE(p + 8 + (j + 1) * 2)) / 32768;
  }
  return out;
}

/** 本物の口の計算を通した、層の 1 ステップ（16ms）ごとの口形。音が終わった後の閉じる分も含む。 */
function mouthTable(pcm: Float32Array, stopMs: number | null, tailMs: number): MouthShape[] {
  const lip = new AlignmentMouthSource(new VolumeMouthSource(), () => 0);
  const end = stopMs ?? (pcm.length / SAMPLE_RATE) * 1000;
  const table: MouthShape[] = [];
  for (let t = 0; t < end + tailMs; t += STEP_MS) {
    let rms = 0;
    if (t < end) {
      const e = Math.floor((t / 1000) * SAMPLE_RATE);
      let sum = 0;
      for (let i = Math.max(0, e - ANALYSER_SIZE); i < Math.min(e, pcm.length); i += 1) sum += (pcm[i] ?? 0) ** 2;
      rms = Math.sqrt(sum / ANALYSER_SIZE);
    }
    lip.setLevel(rms);
    table.push(lip.update(STEP_MS));
  }
  return table;
}

interface Scenario {
  id: string;
  label: string;
  framing: 'bust' | 'face';
  /** 発声の開始（シーンの先頭からの ms）。 */
  speechAtMs: number;
  /** 音声を途中で止める（割り込み）。 */
  stopSpeechMs: number | null;
  totalMs: number;
  shotStepMs: number;
  actions: { atMs: number; do: 'inhale' | 'speech_started' | 'withdrawn' }[];
}

const SCENARIOS: Scenario[] = [
  { id: 'speech_face', label: '音量だけの口（顔）', framing: 'face', speechAtMs: 700, stopSpeechMs: null, totalMs: 3700, shotStepMs: 200, actions: [] },
  { id: 'speech_bust', label: '通常応答（吸気なし）、バスト', framing: 'bust', speechAtMs: 500, stopSpeechMs: null, totalMs: 9000, shotStepMs: 500, actions: [] },
  {
    id: 'inhale_speech',
    label: '吸気→保持→発声',
    framing: 'bust',
    speechAtMs: 1300,
    stopSpeechMs: null,
    totalMs: 4400,
    shotStepMs: 260,
    actions: [
      { atMs: 300, do: 'inhale' },
      { atMs: 1300, do: 'speech_started' },
    ],
  },
  {
    id: 'barge_in',
    label: '発話の途中で割り込まれて止まる',
    framing: 'face',
    speechAtMs: 400,
    stopSpeechMs: 2400,
    totalMs: 3600,
    shotStepMs: 240,
    actions: [],
  },
];

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

interface ProbeRow {
  t: number;
  open: number;
  aa: number;
  blink: number;
  chest: number;
  head: [number, number, number];
  eye: [number, number];
}

interface WindowWithTable {
  __table: MouthShape[];
  __tableIndex: number;
  __tableElapsed: number;
  __tableActive: boolean;
  __probe: ProbeRow[];
  __probeT: number;
}

async function runScenario(page: Page, scenario: Scenario, pcm: Float32Array): Promise<{ series: ProbeRow[]; shots: unknown[] }> {
  const stopRel = scenario.stopSpeechMs === null ? null : scenario.stopSpeechMs - scenario.speechAtMs;
  const table = mouthTable(pcm, stopRel, 600);
  await page.evaluate(
    ({ table, framing }) => {
      const w = window as unknown as WindowWithTable;
      w.__table = table;
      w.__tableIndex = 0;
      w.__tableElapsed = 0;
      w.__tableActive = false;
      w.__probe = [];
      w.__probeT = 0;
      const a = window.__breathDev!.avatar()!;
      a.setFraming(framing);
      a.setMouthSource({
        update: (dt: number) => {
          if (!w.__tableActive) return { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 };
          w.__tableElapsed += dt;
          w.__tableIndex = Math.floor(w.__tableElapsed / 16);
          return w.__table[Math.min(w.__tableIndex, w.__table.length - 1)] ?? { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 };
        },
      });
      a.removeLayer('speech_probe');
      a.addLayer({
        name: 'speech_probe',
        update: (context, frame) => {
          if (context.dtMs <= 0) return;
          w.__probeT += context.dtMs;
          const bone = (name: string, axis: 'x' | 'y' | 'z') => (frame.bones.get(name)?.[axis] ?? 0) * (180 / Math.PI);
          w.__probe.push({
            t: w.__probeT,
            open: Math.max(frame.expression('aa'), frame.expression('ih'), frame.expression('ou'), frame.expression('ee'), frame.expression('oh')),
            aa: frame.expression('aa'),
            blink: frame.expression('blink'),
            chest: frame.expression('breathChest'),
            head: [bone('head', 'x') + bone('neck', 'x'), bone('head', 'y') + bone('neck', 'y'), bone('head', 'z') + bone('neck', 'z')],
            eye: [frame.eye.yawDeg, frame.eye.pitchDeg],
          });
        },
      });
      a.setTimeScale(0);
      a.advanceTime(4000);
    },
    { table, framing: scenario.framing },
  );
  await frames(page);

  const stage = page.locator('[data-testid=avatar-stage]');
  const box = (await stage.boundingBox())!;
  const clip = { x: box.x + box.width * 0.2, y: box.y, width: box.width * 0.6, height: box.height };
  type Action = { at: number; do?: string; shot?: true };
  const actions: Action[] = [
    ...scenario.actions.map((a) => ({ at: a.atMs, do: a.do })),
    { at: scenario.speechAtMs, do: 'speech' },
  ];
  for (let t = 0; t <= scenario.totalMs; t += scenario.shotStepMs) actions.push({ at: t, shot: true });
  actions.sort((a, b) => a.at - b.at || (a.shot ? 1 : -1));
  let t = 0;
  const tiles: { png: Buffer; label: string }[] = [];
  const shots: unknown[] = [];
  for (const action of actions) {
    if (action.at > t) {
      await page.evaluate((ms) => window.__breathDev!.avatar()!.advanceTime(ms), action.at - t);
      await frames(page);
      t = action.at;
    }
    if (action.do) {
      await page.evaluate((d) => {
        const a = window.__breathDev!.avatar()!;
        const w = window as unknown as WindowWithTable;
        if (d === 'speech') w.__tableActive = true;
        else if (d === 'inhale') a.breath.startInhale({ cue_id: 'series', duration_ms: 700 });
        else a.breath.release(d as 'speech_started' | 'withdrawn');
      }, action.do);
      continue;
    }
    const telemetry = await page.evaluate(() => {
      const tm = window.__breathDev!.avatar()!.getTelemetry();
      return { open: tm.mouth.open, aa: tm.mouth.appliedAa, head: tm.head, eye: tm.gaze.leftEyeYawDeg, blink: tm.blink.weight, breath: tm.breath, speech: tm.speech };
    });
    const png = await page.screenshot({ clip });
    await writeFile(path.join(outDir!, `${scenario.id}_${String(action.at).padStart(5, '0')}ms.png`), png);
    tiles.push({ png, label: `${action.at} aa${telemetry.aa.toFixed(2)} ${telemetry.breath.phase}${telemetry.breath.releaseKind ? `/${telemetry.breath.releaseKind}` : ''} 胸${telemetry.breath.chestWeight.toFixed(2)} 頭p${telemetry.head.pitchDeg.toFixed(1)}` });
    shots.push({ at: action.at, ...telemetry });
  }
  await writeFile(path.join(outDir!, `sheet_${scenario.id}.png`), await sheet(page, tiles, `${scenario.label}（発声の開始 ${scenario.speechAtMs}ms）`));
  const series = await page.evaluate(() => (window as unknown as WindowWithTable).__probe);
  await page.evaluate(() => {
    const a = window.__breathDev!.avatar()!;
    a.removeLayer('speech_probe');
    a.setMouthSource(null);
    a.advanceTime(5000);
  });
  await frames(page);
  return { series, shots };
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
      const scale = 0.5;
      const w = Math.round(loaded[0]!.image.width * scale);
      const h = Math.round(loaded[0]!.image.height * scale);
      const cols = 8;
      const rows = Math.ceil(loaded.length / cols);
      const canvas = document.createElement('canvas');
      canvas.width = cols * w;
      canvas.height = rows * (h + 18) + 26;
      const c = canvas.getContext('2d')!;
      c.fillStyle = '#fff';
      c.fillRect(0, 0, canvas.width, canvas.height);
      c.fillStyle = '#000';
      c.font = '15px sans-serif';
      c.fillText(title, 6, 18);
      loaded.forEach(({ image, label }, i) => {
        const x = (i % cols) * w;
        const y = 26 + Math.floor(i / cols) * (h + 18);
        c.drawImage(image, x, y + 16, w, h);
        c.fillStyle = '#000';
        c.font = '10px monospace';
        c.fillText(label, x + 2, y + 12, w - 4);
      });
      return canvas.toDataURL('image/png').split(',')[1]!;
    },
    { images: tiles.map((t) => ({ png: t.png.toString('base64'), label: t.label })), title },
  );
  return Buffer.from(b64, 'base64');
}

async function main(): Promise<void> {
  await mkdir(outDir!, { recursive: true });
  const pcm = parseWav(await readFile(wavPath!));
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
    const page = await browser.newPage({ viewport: { width: 620, height: 460 } });
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
    for (const scenario of SCENARIOS) {
      results[scenario.id] = await runScenario(page, scenario, pcm);
      console.log(`done ${scenario.id}`);
    }
    results.errors = errors;
    ok = errors.length === 0;
    await page.evaluate(() => window.__breathDev!.avatar()!.setTimeScale(1));
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
    await writeFile(path.join(outDir!, 'speech_series.json'), JSON.stringify(results));
  }
  console.log(ok ? 'ALL OK' : 'FAILURES');
  process.exitCode = ok ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
