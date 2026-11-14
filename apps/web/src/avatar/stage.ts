/**
 * 描画のステージ（docs/design/two_ai/03 §2.1、§6）。1 つの canvas、1 つの WebGLRenderer、1 つのシーン、
 * 1 つの rAF ループ、1 つの ResizeObserver で 1 体（従来の createAvatar）または 2 体（/two_ai）を描く。
 * 判断はしない: 視線、吸気、口は各 Avatar（core.ts）が外から受ける。
 *
 * 1 フレームの順: 各 AvatarCore.step（A、B の順。層の合成 → rig へ適用）→ renderer.render → 各 AI の視線の報告。
 * 眼の目標（lookAtWorld）は AI ごと: user と away はカメラの位置、peer は相手の眼の位置。
 * user と peer の間は眼の補間（DEFAULT_GAZE.eyeSmoothMs）に合わせて線形に混ぜる（切り替えで眼が飛ばない）。
 * フレームの上限（maxFps）を超える rAF は描かずに戻る。層の時間は描いたフレームの間の実時間で進む。
 * WebGL のコンテキストを失ったらループを止める（自動の復帰はしない。刺激が途中で変わるのを避ける）。
 */
import * as THREE from 'three';
import type { AiId, GazeReport } from '@llm-vap/contracts';
import type { AvatarModelSpec } from './avatar_models';
import type { BreathPhaseEvent } from './breath';
import { createAvatarCore, loadRig, type AvatarCore } from './core';
import { DEFAULT_GAZE } from './gaze';
import { pixelRatioFor, resolveRenderSettings, TWO_AI_MAX_FPS, TWO_AI_RENDER, type RenderSettings } from './render_settings';
import type { AvatarRig } from './rig';
import type { Avatar, Framing, FrameTiming } from './runtime';
import { gazeGeometry, placeAvatar, placeCamera, resolveLayout, type StageLayout } from './stage_layout';
import { SmoothDamp, type Rng } from './util';

export interface StageAvatarSpec {
  ai_id: AiId;
  modelUrl: string;
  model: AvatarModelSpec;
}

export type AvatarLoadResult = { status: 'loaded' } | { status: 'failed'; error: string };

export interface StageOptions {
  container: HTMLElement;
  /** 1 体（従来）または 2 体。 */
  avatars: StageAvatarSpec[];
  /** 既定は TWO_AI_LAYOUT（1 体では使わない）。 */
  layout?: Partial<StageLayout>;
  /** 2 体の既定は TWO_AI_RENDER、1 体の既定は DEFAULT_RENDER。'h1' は比較用の旧設定。 */
  render?: Partial<RenderSettings> | 'h1';
  /** フレームの上限（Hz）。null は rAF のまま。省略は 2 体で 30、1 体で null（従来）。 */
  maxFps?: number | null;
  rng?: Rng;
  /** 1 体のステージの画角（従来の bust／face）。2 体では使わない。 */
  framing?: Framing;
  onGazeReport?: (ai_id: AiId, report: GazeReport) => void;
  onBreathPhase?: (ai_id: AiId, event: BreathPhaseEvent) => void;
  onFrameRendered?: (timing: FrameTiming) => void;
  onProgress?: (ai_id: AiId, loadedBytes: number, totalBytes: number) => void;
  /** 1 体ずつの読み込みの結果。片方の失敗でもう片方を止めない。 */
  onAvatarLoad?: (ai_id: AiId, result: AvatarLoadResult) => void;
  /** webglcontextlost。ループはもう止まっている。 */
  onContextLost?: () => void;
}

export interface StageTelemetry {
  /** 描いたフレームの fps（指数移動平均）。 */
  fps: number;
  /** 直近約 5 秒の描いたフレームの間隔から求めた fps の 5 パーセンタイルと中央値（render.health の元）。 */
  fpsP5: number;
  fpsMedian: number;
  frame: number;
  /** 直近約 5 秒の 1 フレームの処理時間（層の合成＋描画の呼び出し）の 95 パーセンタイル（ms）。 */
  frameMsP95: number;
  /** 上限で描かなかった rAF の数（累積）。 */
  droppedByCap: number;
  contextLost: boolean;
  renderer: string;
  pixelRatio: number;
  avatars: number;
}

export interface Stage {
  /** 読み込めた AI のアバター。失敗した AI は null。Avatar は従来の型と同じ（setGaze は peer も受ける）。 */
  avatar(ai_id: AiId): Avatar | null;
  readonly layout: StageLayout;
  getTelemetry(): StageTelemetry;
  setMaxFps(fps: number | null): void;
  dispose(): void;
}

/** 層の時間の上限。描画が遅くても瞬きや口の時間を実時間に合わせ、背景タブから戻った時だけ抑える。 */
const MAX_LAYER_DT_MS = 500;
/** fps と処理時間の統計の窓。 */
const STATS_WINDOW_MS = 5000;
/** 上限の判定の許容（rAF の揺れで 1 フレーム余分に落とさないため）。 */
const CAP_TOLERANCE_MS = 2;

interface Slot {
  ai_id: AiId;
  rig: AvatarRig;
  wrapper: THREE.Group;
  core: AvatarCore;
  blend: SmoothDamp;
  lookAt: THREE.Vector3;
}

/** 最近傍順位の分位点（values は破壊しない）。空なら 0。 */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(p * sorted.length)));
  return sorted[rank - 1] as number;
}

export async function createStage(options: StageOptions): Promise<Stage> {
  const { container } = options;
  const rng = options.rng ?? Math.random;
  const specs = options.avatars.slice(0, 2);
  const two = specs.length === 2;
  const layout = resolveLayout(options.layout);
  const settings =
    options.render === 'h1'
      ? resolveRenderSettings('h1')
      : resolveRenderSettings(two ? { ...TWO_AI_RENDER, ...options.render } : options.render);
  let maxFps: number | null = options.maxFps === undefined ? (two ? TWO_AI_MAX_FPS : null) : options.maxFps;

  // 読み込みは並行で、1 体の失敗でもう片方を止めない。
  const loaded = await Promise.allSettled(
    specs.map((spec) =>
      loadRig(spec.modelUrl, spec.model, settings, (l, t) => options.onProgress?.(spec.ai_id, l, t)),
    ),
  );
  const rigs: { ai_id: AiId; rig: AvatarRig }[] = [];
  const failures: { ai_id: AiId; error: string }[] = [];
  loaded.forEach((result, i) => {
    const ai_id = specs[i]!.ai_id;
    if (result.status === 'fulfilled') rigs.push({ ai_id, rig: result.value });
    else failures.push({ ai_id, error: errorText(result.reason) });
  });
  for (const f of failures) options.onAvatarLoad?.(f.ai_id, { status: 'failed', error: f.error });

  if (rigs.length === 0) return emptyStage(layout);

  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: false });
  } catch (error) {
    for (const { ai_id, rig } of rigs) {
      rig.dispose();
      options.onAvatarLoad?.(ai_id, { status: 'failed', error: `webgl_unavailable: ${errorText(error)}` });
    }
    return emptyStage(layout);
  }

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(settings.background);
  const key = new THREE.DirectionalLight(0xffffff, settings.keyIntensity);
  key.position.set(...settings.keyPosition);
  const fill = new THREE.AmbientLight(0xffffff, settings.ambientIntensity);
  scene.add(key, fill);

  const camera = new THREE.PerspectiveCamera(two ? layout.verticalFovDeg : 20, 1, 0.05, 20);
  // MToon は sRGB の出力を前提にした色。トーンマッピングは掛けない（明るい部分の色が変わる）。
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  const applyPixelRatio = () => renderer.setPixelRatio(pixelRatioFor(window.devicePixelRatio, settings));
  applyPixelRatio();
  for (const { rig } of rigs) rig.prepareTextures(renderer.capabilities.getMaxAnisotropy());
  container.appendChild(renderer.domElement);
  renderer.domElement.style.display = 'block';
  const rendererName = readRendererName(renderer);
  for (const { ai_id } of rigs) options.onAvatarLoad?.(ai_id, { status: 'loaded' });

  const resize = () => {
    // ブラウザの拡大率が変わると devicePixelRatio も変わる。
    applyPixelRatio();
    const width = Math.max(container.clientWidth, 1);
    const height = Math.max(container.clientHeight, 1);
    renderer.setSize(width, height);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };
  resize();
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(container);

  // ループの値（Avatar.getTelemetry が読む）。
  let rafId = 0;
  let lastMs: number | null = null;
  let disposed = false;
  let contextLost = false;
  let frameCount = 0;
  let lastRafMs = 0;
  let fps = 0;
  let droppedByCap = 0;
  const renderTimes: number[] = [];
  const frameDurations: number[] = [];

  const slots = new Map<AiId, Slot>();
  const eye = new THREE.Vector3();
  let currentFraming: Framing = options.framing ?? 'bust';
  let viewYawRad = 0;

  /** 1 体のステージの従来のカメラ（bust は参加者画面の既定）。 */
  const placeSingleCamera = (framing: Framing) => {
    const slot = [...slots.values()][0];
    if (two || !slot) return;
    currentFraming = framing;
    slot.rig.eyeWorldPosition(eye);
    // ビデオ通話くらいの距離（頭から胸まで）で、カメラは目の高さ（目線が合う）。
    // 縦の画角 20 度、距離 1.6m で約 0.56m が写る。目が上から約 36% の高さに来るよう少し下を向ける。
    const distance = framing === 'face' ? 1.1 : 1.6;
    const lookDownBy = framing === 'face' ? 0.02 : 0.08;
    camera.position.set(eye.x + Math.sin(viewYawRad) * distance, eye.y, eye.z + Math.cos(viewYawRad) * distance);
    camera.lookAt(eye.x, eye.y - lookDownBy, eye.z);
    camera.updateMatrixWorld();
  };

  const disposeAll = () => {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(rafId);
    resizeObserver.disconnect();
    for (const slot of slots.values()) slot.rig.dispose();
    slots.clear();
    renderer.dispose();
    renderer.domElement.remove();
  };

  const removeAvatar = (ai_id: AiId) => {
    const slot = slots.get(ai_id);
    if (!slot) return;
    slots.delete(ai_id);
    scene.remove(slot.wrapper);
    slot.rig.dispose();
  };

  // 置く。2 体は眼の位置が (±halfSpacing, ·, 0) に来るよう、置いた後に眼の位置で補正する。
  const bindEyes = new Map<AiId, THREE.Vector3>();
  for (const { ai_id, rig } of rigs) {
    const wrapper = new THREE.Group();
    wrapper.name = `stage_avatar_${ai_id}`;
    wrapper.add(rig.root);
    scene.add(wrapper);
    if (two) {
      const place = placeAvatar(layout, ai_id);
      wrapper.rotation.y = place.yawRad;
      wrapper.updateMatrixWorld(true);
      rig.eyeWorldPosition(eye);
      wrapper.position.set(place.x - eye.x, 0, place.z - eye.z);
    }
    wrapper.updateMatrixWorld(true);
    rig.eyeWorldPosition(eye);
    bindEyes.set(ai_id, eye.clone());
  }
  const eyeHeight = [...bindEyes.values()].reduce((sum, v) => sum + v.y, 0) / Math.max(bindEyes.size, 1);

  for (const { ai_id, rig } of rigs) {
    const wrapper = rig.root.parent as THREE.Group;
    const core = createAvatarCore({
      rig,
      rng,
      geometry: two ? gazeGeometry(layout, ai_id, eyeHeight) : null,
      // 従来どおり、最初の姿勢はまだ置いていないカメラの位置（原点）で当てる。
      initialLookAt: camera.position,
      onGazeReport: (report) => options.onGazeReport?.(ai_id, two ? { ...report, ai_id } : report),
      onBreathPhase: (event) => options.onBreathPhase?.(ai_id, event),
      hooks: {
        setFraming: (framing) => placeSingleCamera(framing),
        setViewYaw: (deg) => {
          viewYawRad = deg * (Math.PI / 180);
          placeSingleCamera(currentFraming);
        },
        dispose: () => (two ? removeAvatar(ai_id) : disposeAll()),
        frameInfo: () => ({ frame: frameCount, rafMs: lastRafMs, fps }),
      },
    });
    slots.set(ai_id, { ai_id, rig, wrapper, core, blend: new SmoothDamp(0), lookAt: new THREE.Vector3() });
  }

  if (two) {
    const mid = new THREE.Vector3();
    for (const slot of slots.values()) {
      slot.rig.eyeWorldPosition(eye);
      mid.add(eye);
    }
    mid.divideScalar(slots.size);
    if (slots.size === 1) mid.x = 0; // 片方が読めなかった: 位置は 2 体のときと同じにする
    const placed = placeCamera(layout, { x: mid.x, y: mid.y, z: mid.z });
    camera.position.set(placed.position.x, placed.position.y, placed.position.z);
    camera.lookAt(placed.lookAt.x, placed.lookAt.y, placed.lookAt.z);
    camera.updateMatrixWorld();
  } else {
    placeSingleCamera(currentFraming);
  }

  renderer.domElement.addEventListener('webglcontextlost', () => {
    if (contextLost) return;
    contextLost = true;
    cancelAnimationFrame(rafId);
    options.onContextLost?.();
  });

  const peerEye = new THREE.Vector3();
  const lookAtFor = (slot: Slot, dtMs: number): THREE.Vector3 => {
    if (!two) return camera.position;
    const other = [...slots.values()].find((s) => s.ai_id !== slot.ai_id) ?? null;
    const wantPeer = slot.core.gazeTarget() === 'peer' && other !== null ? 1 : 0;
    const b = Math.min(1, Math.max(0, slot.blend.update(wantPeer, DEFAULT_GAZE.eyeSmoothMs, dtMs)));
    if (other === null || b <= 0) return slot.lookAt.copy(camera.position);
    other.rig.eyeWorldPosition(peerEye);
    return slot.lookAt.copy(camera.position).lerp(peerEye, b);
  };

  const pushWindow = (nowMs: number, durationMs: number) => {
    renderTimes.push(nowMs);
    frameDurations.push(durationMs);
    while (renderTimes.length > 0 && nowMs - (renderTimes[0] as number) > STATS_WINDOW_MS) {
      renderTimes.shift();
      frameDurations.shift();
    }
  };

  const tick = (nowMs: number) => {
    if (disposed || contextLost) return;
    rafId = requestAnimationFrame(tick);
    if (maxFps !== null && lastMs !== null && nowMs - lastMs < 1000 / maxFps - CAP_TOLERANCE_MS) {
      droppedByCap += 1;
      return;
    }
    const frameStartedMs = performance.now();
    const dtMs = lastMs === null ? 16 : Math.min(nowMs - lastMs, MAX_LAYER_DT_MS);
    if (lastMs !== null && nowMs > lastMs) {
      const instant = 1000 / (nowMs - lastMs);
      fps = fps === 0 ? instant : fps * 0.95 + instant * 0.05;
    }
    lastMs = nowMs;
    for (const slot of slots.values()) slot.core.step(dtMs, nowMs, lookAtFor(slot, dtMs));
    renderer.render(scene, camera);
    const renderedMs = performance.now();
    pushWindow(nowMs, renderedMs - frameStartedMs);
    const first = [...slots.values()][0];
    options.onFrameRendered?.({ rafMs: nowMs, startedMs: frameStartedMs, renderedMs, chestWeight: first?.core.chestWeight() ?? 0 });
    for (const slot of slots.values()) slot.core.rendered(nowMs);
    frameCount += 1;
    lastRafMs = nowMs;
  };
  rafId = requestAnimationFrame(tick);

  return {
    avatar: (ai_id) => slots.get(ai_id)?.core.avatar ?? null,
    layout,
    getTelemetry: () => {
      const rates: number[] = [];
      for (let i = 1; i < renderTimes.length; i += 1) {
        const interval = (renderTimes[i] as number) - (renderTimes[i - 1] as number);
        if (interval > 0) rates.push(1000 / interval);
      }
      return {
        fps,
        fpsP5: percentile(rates, 0.05),
        fpsMedian: percentile(rates, 0.5),
        frame: frameCount,
        frameMsP95: percentile(frameDurations, 0.95),
        droppedByCap,
        contextLost,
        renderer: rendererName,
        pixelRatio: renderer.getPixelRatio(),
        avatars: slots.size,
      };
    },
    setMaxFps: (value) => {
      maxFps = value !== null && Number.isFinite(value) && value > 0 ? value : null;
    },
    dispose: disposeAll,
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readRendererName(renderer: THREE.WebGLRenderer): string {
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    return typeof name === 'string' && name !== '' ? name.slice(0, 200) : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** 描くアバターがない（両方の読み込みの失敗、WebGL が使えない）。名前札で続ける側が使う。 */
function emptyStage(layout: StageLayout): Stage {
  return {
    avatar: () => null,
    layout,
    getTelemetry: () => ({
      fps: 0,
      fpsP5: 0,
      fpsMedian: 0,
      frame: 0,
      frameMsP95: 0,
      droppedByCap: 0,
      contextLost: false,
      renderer: 'none',
      pixelRatio: 1,
      avatars: 0,
    }),
    setMaxFps: () => undefined,
    dispose: () => undefined,
  };
}
