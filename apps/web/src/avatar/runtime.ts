/**
 * VRM の読み込み、描画、1つの更新ループ。three に触るのはこのファイルと chest_morph_three.ts（VRM に依存しない胸郭モーフ）だけ。
 * 判断はしない: 視線は setGaze で外から受け、音量は setMouthLevel／pushPcm で、語時刻と再生位置は
 * onPlaybackAlignment／onPlaybackReport で受ける（配線は J）。
 *
 * 層の順: rest → idle → gaze → saccade → expression → breath → blink → mouth。
 * 1フレームの順序: 層の合成 → ボーンへ適用 → 視線 → 表情 → vrm.update → 描画 → 報告。
 * 吸気と準備姿勢（H2）は breath の層（expression と blink の間）。胸郭のモーフは読み込み時に作る。ループは増やさない。
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import {
  VRMExpression,
  VRMExpressionMorphTargetBind,
  VRMHumanBoneName,
  VRMLoaderPlugin,
  VRMUtils,
  type VRM,
} from '@pixiv/three-vrm';
import type { GazeReport, GazeTarget } from '@llm-vap/contracts';
import type { AvatarModelSpec } from './avatar_models';
import { BlinkLayer, BlinkScheduler } from './blink';
import {
  BREATH_CHEST_EXPRESSION,
  BreathLayer,
  mergeBreathParams,
  type BreathController,
  type BreathParams,
  type BreathPhaseEvent,
  type BreathTelemetry,
  type NormalBreathParams,
  type PrepBreathParams,
} from './breath';
import { addChestMorph, findBustBones } from './chest_morph_three';
import { ExpressionLayer, type SpeechFeatures } from './face';
import { DEFAULT_GAZE, GazeController, GazeLayer, GazeReporter } from './gaze';
import { IdleLayer, RestPoseLayer } from './idle';
import { AlignmentMouthSource, type LipSyncMode, type PlaybackAlignmentLike, type PlaybackReportLike } from './lipsync';
import { computeRms, MouthLayer, VolumeMouthSource, mouthOpenAmount, type MouthShape, type MouthSource } from './mouth';
import { SaccadeGenerator, SaccadeLayer } from './saccade';
import { boneSignForMeta, LayerStack, type AvatarLayer } from './pose';
import { matcapScaleFor, mipmapAllowed, pixelRatioFor, resolveRenderSettings, type RenderSettings } from './render_settings';
import type { AvatarRig } from './rig';
import { createGlbRig } from './rig_glb';
import { RAD2DEG, type Rng } from './util';

export type Framing = 'bust' | 'face';

export interface AvatarOptions {
  container: HTMLElement;
  modelUrl: string;
  /** モデルの種類と対応表（avatar_models.ts）。省略は VRM（従来どおり）。 */
  model?: AvatarModelSpec;
  framing?: Framing;
  rng?: Rng;
  onProgress?: (loadedBytes: number, totalBytes: number) => void;
  /** browser_rpc の gaze.report の元。送信は呼び出し側（J）。 */
  onGazeReport?: (report: GazeReport) => void;
  /** 描画の設定の上書き。'h1' は比較用の旧設定。 */
  render?: Partial<RenderSettings> | 'h1';
  /** 吸気の phase の遷移（rAF 時刻つき）。inhale の nowMs が吸気が最初に描かれたフレーム。記録は呼び出し側。 */
  onBreathPhase?: (event: BreathPhaseEvent) => void;
  /** 測定用（/dev/avatar_measure）。毎フレーム render の直後に呼ぶ。指定がなければ何もしない。 */
  onFrameRendered?: (timing: FrameTiming) => void;
}

/** 1フレームの時刻（performance.now の軸）。 */
export interface FrameTiming {
  rafMs: number;
  startedMs: number;
  renderedMs: number;
  /** 描いたフレームの胸郭モーフの重み（吸気の最初の変化の検出に使う）。 */
  chestWeight: number;
}

/** 読める形で公開する値。avatar.* イベントは契約に無いので、今は取りに来てもらう。 */
export interface AvatarTelemetry {
  frame: number;
  /** 直近のフレームの rAF 時刻。 */
  rafMs: number;
  fps: number;
  mouth: { open: number; shape: MouthShape; appliedAa: number; mode: LipSyncMode; playbackPositionMs: number | null };
  blink: { weight: number; count: number; gazeCount: number };
  saccade: { count: number; yawDeg: number; pitchDeg: number };
  speech: SpeechFeatures;
  gaze: {
    target: GazeTarget;
    awayAmount: number;
    settled: boolean;
    /** 指令値（lookAt の入力、度）。 */
    eyeInputYawDeg: number;
    eyeInputPitchDeg: number;
    /** シーングラフから読んだ左眼ボーンの回転（度）。 */
    leftEyeYawDeg: number;
    leftEyePitchDeg: number;
    rightEyeYawDeg: number;
    rightEyePitchDeg: number;
  };
  /** シーングラフから読んだ頭部の向き（待機の揺れと視線の合計、度）。 */
  head: { yawDeg: number; pitchDeg: number; rollDeg: number };
  idleIntensity: number;
  breath: BreathTelemetry;
  layers: string[];
}

/** 読み込み時に作った胸郭モーフの情報。 */
export interface BreathMorphInfo {
  meshes: string[];
  movedVertices: number;
  maxDisplacementMm: number;
  chestBone: string;
}

export interface AvatarModelInfo {
  specVersion: string;
  meta: Record<string, unknown>;
  expressions: string[];
  humanBones: string[];
  missingHumanBones: string[];
  lookAt: {
    applier: string;
    horizontalInner: [number, number] | null;
    horizontalOuter: [number, number] | null;
    verticalDown: [number, number] | null;
    verticalUp: [number, number] | null;
  };
  meshes: { name: string; primitives: number; morphTargets: string[]; vertices: number }[];
  springBoneJoints: number;
  breathMorph: BreathMorphInfo;
}

export interface Avatar {
  readonly mouth: VolumeMouthSource;
  /** 既定の口（語時刻＋音量包絡）。語時刻が無ければ音量だけの口と同じに動く。 */
  readonly lipSync: AlignmentMouthSource;
  setMouthLevel(rms: number): void;
  pushPcm(samples: ArrayLike<number>): void;
  closeMouth(): void;
  /** Node から届いた playback.alignment（PlaybackAlignment をそのまま渡せる）。 */
  onPlaybackAlignment(message: PlaybackAlignmentLike): void;
  /** Worker が送った playback.started／position／ended（BrowserAudioOptions.onSent で受ける。そのまま渡せる）。 */
  onPlaybackReport(message: PlaybackReportLike): void;
  /** 口を差し替える。null で既定（lipSync）へ戻す。 */
  setMouthSource(source: MouthSource | null): void;
  setGaze(target: GazeTarget): void;
  triggerBlink(): void;
  setAutoBlink(enabled: boolean): void;
  setIdleIntensity(intensity: number): void;
  /** 相手を見ている間の小さな視線移動。 */
  setSaccades(enabled: boolean): void;
  /** 表情の層（待機の表情、眉、話している間の頭の動き）の強さ 0〜1。 */
  setExpressionIntensity(intensity: number): void;
  setFraming(framing: Framing): void;
  /** 確認用: カメラを目の周りに水平に回す（度、0 が正面）。参加者画面では使わない。 */
  setViewYaw(deg: number): void;
  /**
   * 確認用: 層の時間の倍率（1 が実時間、0 で止める）。描画は続く。参加者画面では使わない。
   * 遅い描画（SwiftShader）で時刻つきの連続画像を撮るため。
   */
  setTimeScale(scale: number): void;
  /** 確認用: 次のフレームで層の時間を ms だけ進める（16ms ずつ）。 */
  advanceTime(ms: number): void;
  /** 発話希望の準備吸気（H2）。フレームの更新はランタイムが行う。 */
  readonly breath: BreathController;
  /** 吸気の phase の遷移（rAF 時刻つき）を受ける。戻り値で解除する。signal.ended の報告に使う（participant.ts）。 */
  onBreathPhase(listener: (event: BreathPhaseEvent) => void): () => void;
  /** 呼吸のパラメータの部分的な上書き（確認ページ用）。 */
  setBreathParams(patch: { normal?: Partial<NormalBreathParams>; prep?: Partial<PrepBreathParams> }): void;
  getBreathParams(): BreathParams;
  addLayer(layer: AvatarLayer, position?: { before: string }): void;
  removeLayer(name: string): void;
  getTelemetry(): AvatarTelemetry;
  getModelInfo(): AvatarModelInfo;
  /** ボーンのワールド位置。無ければ null。確認と H2 の調整用。 */
  getBoneWorldPosition(name: string): { x: number; y: number; z: number } | null;
  dispose(): void;
}

/** 層の時間の上限。描画が遅くても瞬きや口の時間を実時間に合わせ、背景タブから戻った時だけ抑える。 */
const MAX_LAYER_DT_MS = 500;
/** 髪のばねは大きな dt で暴れるので別に抑える。 */
const MAX_SPRING_DT_MS = 66;

export async function createAvatar(options: AvatarOptions): Promise<Avatar> {
  const { container } = options;
  const rng = options.rng ?? Math.random;

  const gltf = await loadGltf(options);
  const settings = resolveRenderSettings(options.render);
  const rig = options.model?.kind === 'glb' ? createGlbRig(gltf.scene, options.model) : createVrmRig(gltf, options.modelUrl, settings);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(settings.background);
  scene.add(rig.root);
  const key = new THREE.DirectionalLight(0xffffff, settings.keyIntensity);
  key.position.set(...settings.keyPosition);
  const fill = new THREE.AmbientLight(0xffffff, settings.ambientIntensity);
  scene.add(key, fill);

  const camera = new THREE.PerspectiveCamera(20, 1, 0.05, 20);
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: false });
  // MToon は sRGB の出力を前提にした色。トーンマッピングは掛けない（明るい部分の色が変わる）。
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  const applyPixelRatio = () => renderer.setPixelRatio(pixelRatioFor(window.devicePixelRatio, settings));
  applyPixelRatio();
  rig.prepareTextures(renderer.capabilities.getMaxAnisotropy());
  container.appendChild(renderer.domElement);
  renderer.domElement.style.display = 'block';

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

  const stack = new LayerStack();
  const mouth = new VolumeMouthSource();
  const lipSync = new AlignmentMouthSource(mouth, () => performance.now());
  const blinkScheduler = new BlinkScheduler(rng);
  const gazeController = new GazeController(rng);
  const idle = new IdleLayer(rng);
  const gazeLayer = new GazeLayer(gazeController);
  const saccades = new SaccadeGenerator(rng);
  const saccadeLayer = new SaccadeLayer(saccades, (deg) => blinkScheduler.onGazeShift(deg));
  const blinkLayer = new BlinkLayer(blinkScheduler);
  const mouthLayer = new MouthLayer(lipSync);
  const expression = new ExpressionLayer(rng, () => mouthOpenAmount(mouthLayer.shape));
  const breathPhaseListeners = new Set<(event: BreathPhaseEvent) => void>();
  const breath = new BreathLayer(rng, {
    output: rig.breathOutput,
    speechOpen: () => mouthOpenAmount(mouthLayer.shape),
    setIdleScale: (scale) => {
      idle.suppression = scale;
    },
    onPhase: (event) => {
      options.onBreathPhase?.(event);
      for (const listener of breathPhaseListeners) listener(event);
    },
  });
  stack.add(new RestPoseLayer());
  stack.add(idle);
  stack.add(gazeLayer);
  stack.add(saccadeLayer);
  stack.add(expression);
  stack.add(breath);
  stack.add(blinkLayer);
  stack.add(mouthLayer);
  /** そらす／戻すの視線移動の大きさ（lookAt の入力の度）。瞬きの確率に使う。 */
  const gazeShiftDeg = Math.hypot(DEFAULT_GAZE.awayEyeYawDeg, DEFAULT_GAZE.awayEyePitchDeg);

  const gazeReporter = new GazeReporter((report) => options.onGazeReport?.(report));

  const applyPose = (dtMs: number, nowMs: number) => {
    blinkScheduler.speaking = expression.features.speaking > 0.5;
    const frame = stack.step({ dtMs, nowMs });
    rig.applyFrame(frame, camera, dtMs);
  };

  // 最初の姿勢を当ててからカメラを置き、髪の揺れを新しい姿勢で初期化する。
  applyPose(0, performance.now());
  rig.settle();

  const eyePosition = new THREE.Vector3();
  let currentFraming: Framing = options.framing ?? 'bust';
  let viewYawRad = 0;
  const placeCamera = (framing: Framing) => {
    currentFraming = framing;
    rig.eyeWorldPosition(eyePosition);
    // bust は参加者画面の既定。ビデオ通話くらいの距離（頭から胸まで）で、カメラは目の高さ（目線が合う）。
    // 縦の画角 20 度、距離 1.6m で約 0.56m が写る。目が上から約 36% の高さに来るよう少し下を向ける。
    const distance = framing === 'face' ? 1.1 : 1.6;
    const lookDownBy = framing === 'face' ? 0.02 : 0.08;
    camera.position.set(eyePosition.x + Math.sin(viewYawRad) * distance, eyePosition.y, eyePosition.z + Math.cos(viewYawRad) * distance);
    camera.lookAt(eyePosition.x, eyePosition.y - lookDownBy, eyePosition.z);
    camera.updateMatrixWorld();
  };
  placeCamera(options.framing ?? 'bust');

  // シーングラフから読む頭の向き。
  const headNode = rig.rawBone('head');
  const restHeadInverse = new THREE.Quaternion();
  headNode?.getWorldQuaternion(restHeadInverse);
  restHeadInverse.invert();
  const headQuat = new THREE.Quaternion();
  const forward = new THREE.Vector3();
  const up = new THREE.Vector3();
  const readHead = () => {
    if (!headNode) return { yawDeg: 0, pitchDeg: 0, rollDeg: 0 };
    headNode.getWorldQuaternion(headQuat).multiply(restHeadInverse);
    forward.set(0, 0, 1).applyQuaternion(headQuat);
    up.set(0, 1, 0).applyQuaternion(headQuat);
    return {
      yawDeg: Math.atan2(forward.x, forward.z) * RAD2DEG,
      pitchDeg: -Math.asin(THREE.MathUtils.clamp(forward.y, -1, 1)) * RAD2DEG,
      rollDeg: Math.atan2(-up.x, up.y) * RAD2DEG,
    };
  };
  let rafId = 0;
  let lastMs: number | null = null;
  let disposed = false;
  let frameCount = 0;
  let lastRafMs = 0;
  let fps = 0;

  let timeScale = 1;
  let pendingAdvanceMs = 0;
  let layerClockMs = 0;
  const tick = (nowMs: number) => {
    if (disposed) return;
    rafId = requestAnimationFrame(tick);
    const frameStartedMs = options.onFrameRendered ? performance.now() : 0;
    const dtMs = lastMs === null ? 16 : Math.min(nowMs - lastMs, MAX_LAYER_DT_MS);
    if (lastMs !== null && nowMs > lastMs) {
      const instant = 1000 / (nowMs - lastMs);
      fps = fps === 0 ? instant : fps * 0.95 + instant * 0.05;
    }
    lastMs = nowMs;
    if (timeScale === 1 && pendingAdvanceMs === 0) {
      applyPose(dtMs, nowMs);
    } else {
      // 確認用の時間制御。層の時刻は実時間と切り離す。
      let pending = pendingAdvanceMs;
      pendingAdvanceMs = 0;
      while (pending > 0) {
        const step = Math.min(16, pending);
        layerClockMs += step;
        applyPose(step, layerClockMs);
        pending -= step;
      }
      layerClockMs += dtMs * timeScale;
      applyPose(dtMs * timeScale, layerClockMs);
    }
    renderer.render(scene, camera);
    options.onFrameRendered?.({ rafMs: nowMs, startedMs: frameStartedMs, renderedMs: performance.now(), chestWeight: breath.telemetry().chestWeight });
    gazeReporter.rendered(nowMs);
    frameCount += 1;
    lastRafMs = nowMs;
  };
  rafId = requestAnimationFrame(tick);

  return {
    mouth,
    lipSync,
    setMouthLevel: (rms) => lipSync.setLevel(rms),
    pushPcm: (samples) => lipSync.setLevel(computeRms(samples)),
    closeMouth: () => {
      lipSync.closeNow();
    },
    onPlaybackAlignment: (message) => lipSync.addAlignment(message),
    onPlaybackReport: (message) => lipSync.onPlaybackReport(message),
    setMouthSource: (source) => {
      mouthLayer.source = source ?? lipSync;
    },
    setGaze: (target) => {
      if (gazeController.setTarget(target)) {
        gazeReporter.commanded(target, !document.hidden);
        blinkScheduler.onGazeShift(gazeShiftDeg);
      }
    },
    triggerBlink: () => blinkScheduler.trigger(),
    setAutoBlink: (enabled) => {
      blinkScheduler.enabled = enabled;
    },
    setIdleIntensity: (intensity) => {
      idle.intensity = intensity;
    },
    setSaccades: (enabled) => {
      saccades.enabled = enabled;
    },
    setExpressionIntensity: (intensity) => {
      expression.intensity = intensity;
    },
    setFraming: placeCamera,
    setTimeScale: (scale) => {
      if (timeScale === 1 && scale !== 1) layerClockMs = performance.now();
      timeScale = Math.max(0, scale);
    },
    advanceTime: (ms) => {
      pendingAdvanceMs += Math.max(0, ms);
    },
    setViewYaw: (deg) => {
      viewYawRad = deg * (Math.PI / 180);
      placeCamera(currentFraming);
    },
    breath,
    onBreathPhase: (listener) => {
      breathPhaseListeners.add(listener);
      return () => breathPhaseListeners.delete(listener);
    },
    setBreathParams: (patch) => {
      breath.params = mergeBreathParams(breath.params, patch);
    },
    getBreathParams: () => breath.params,
    addLayer: (layer, position) => stack.add(layer, position ?? null),
    removeLayer: (name) => stack.remove(name),
    getTelemetry: () => {
      const left = rig.readEye('left');
      const right = rig.readEye('right');
      const g = gazeLayer.state;
      return {
        frame: frameCount,
        rafMs: lastRafMs,
        fps,
        mouth: {
          open: mouthOpenAmount(mouthLayer.shape),
          shape: { ...mouthLayer.shape },
          appliedAa: rig.expressionValue('aa'),
          mode: lipSync.mode,
          playbackPositionMs: lipSync.playbackPositionMs(),
        },
        blink: { weight: blinkLayer.weight, count: blinkScheduler.count, gazeCount: blinkScheduler.gazeCount },
        saccade: { count: saccades.count, yawDeg: saccades.current.yawDeg, pitchDeg: saccades.current.pitchDeg },
        speech: { ...expression.features },
        gaze: {
          target: g.target,
          awayAmount: g.awayAmount,
          settled: g.settled,
          eyeInputYawDeg: rig.eyeInput().yawDeg,
          eyeInputPitchDeg: rig.eyeInput().pitchDeg,
          leftEyeYawDeg: left.yawDeg,
          leftEyePitchDeg: left.pitchDeg,
          rightEyeYawDeg: right.yawDeg,
          rightEyePitchDeg: right.pitchDeg,
        },
        head: readHead(),
        idleIntensity: idle.intensity,
        breath: breath.telemetry(),
        layers: stack.names(),
      };
    },
    getModelInfo: () => ({ ...rig.describe(), breathMorph: rig.breathMorph }),
    getBoneWorldPosition: (name) => {
      const node = rig.rawBone(name);
      if (!node) return null;
      const position = node.getWorldPosition(new THREE.Vector3());
      return { x: position.x, y: position.y, z: position.z };
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(rafId);
      resizeObserver.disconnect();
      rig.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}

/** VRM の適合層。従来 createAvatar の中にあった処理をそのままここへ移した（動作は変えない）。 */
function createVrmRig(gltf: Awaited<ReturnType<typeof loadGltf>>, modelUrl: string, settings: RenderSettings): AvatarRig {
  const vrm = gltf.userData.vrm as VRM | undefined;
  if (!vrm) throw new Error(`VRM として読めなかった: ${modelUrl}`);
  if (!vrm.lookAt || !vrm.expressionManager) throw new Error('VRM に lookAt か表情が無い');
  const { lookAt, expressionManager, humanoid } = vrm;

  VRMUtils.rotateVRM0(vrm);
  // 見えない頂点を落とす処理は H2 の胸モーフ生成に影響しうるので入れない。
  VRMUtils.combineSkeletons(gltf.scene);
  vrm.scene.traverse((object) => {
    object.frustumCulled = false;
  });
  prepareMaterials(vrm, settings);
  registerMorphExpressions(vrm);
  // 姿勢を当てる前（ボーンがバインド時の位置）に作る。
  const breathMorph = registerChestMorph(vrm);
  const sign = boneSignForMeta(vrm.meta.metaVersion);
  const leftEye = humanoid.getNormalizedBoneNode('leftEye');
  const rightEye = humanoid.getNormalizedBoneNode('rightEye');
  const eyeEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  return {
    kind: 'vrm',
    root: vrm.scene,
    breathMorph,
    breathOutput: { chest: breathMorph.chestBone },
    applyFrame(frame, camera, dtMs) {
      for (const [name, offset] of frame.bones) {
        humanoid.getNormalizedBoneNode(name as VRMHumanBoneName)?.rotation.set(offset.x * sign.x, offset.y * sign.y, offset.z * sign.z);
      }
      // 前のフレームの頭の行列でカメラへの向きを求め、そらす量を足す。1フレーム遅れは問題にならない。
      lookAt.lookAt(camera.position);
      const baseYaw = lookAt.yaw;
      const basePitch = lookAt.pitch;
      lookAt.yaw = baseYaw * frame.eye.userWeight + frame.eye.yawDeg;
      lookAt.pitch = basePitch * frame.eye.userWeight + frame.eye.pitchDeg;
      for (const [name, weight] of frame.expressions) expressionManager.setValue(name, weight);
      if (settings.springBones) {
        vrm.update(Math.min(dtMs, MAX_SPRING_DT_MS) / 1000);
      } else {
        // vrm.update から spring bone だけを除いたもの（切り分け用）。
        humanoid.update();
        lookAt.update(dtMs / 1000);
        expressionManager.update();
        vrm.nodeConstraintManager?.update();
      }
    },
    settle() {
      vrm.scene.updateMatrixWorld(true);
      vrm.springBoneManager?.setInitState();
      vrm.springBoneManager?.reset();
    },
    prepareTextures: (maxAnisotropy) => applyTextureFiltering(vrm, settings, maxAnisotropy),
    eyeWorldPosition: (target) => {
      lookAt.getLookAtWorldPosition(target);
    },
    rawBone: (role) => humanoid.getRawBoneNode(role as VRMHumanBoneName),
    readEye: (side) => {
      const node = side === 'left' ? leftEye : rightEye;
      if (!node) return { yawDeg: 0, pitchDeg: 0 };
      eyeEuler.setFromQuaternion(node.quaternion, 'YXZ');
      // 頭と同じ規約（pitch の正が下）で返す。
      return { yawDeg: eyeEuler.y * RAD2DEG, pitchDeg: eyeEuler.x * sign.x * RAD2DEG };
    },
    eyeInput: () => ({ yawDeg: lookAt.yaw, pitchDeg: lookAt.pitch }),
    expressionValue: (name) => expressionManager.getValue(name) ?? 0,
    describe: () => describeModel(vrm),
    dispose: () => VRMUtils.deepDispose(vrm.scene),
  };
}

/**
 * プリセットに無い表情をモーフから足す。今は眉上げ（VRoid の Fcl_BRW_Surprised）だけ。
 * 無いモデルでは登録せず、層が書いた値は expressionManager が無視する。
 */
const MORPH_EXPRESSIONS: { name: string; morphSuffix: string }[] = [{ name: 'browUp', morphSuffix: 'Fcl_BRW_Surprised' }];

function registerMorphExpressions(vrm: VRM): void {
  const manager = vrm.expressionManager;
  if (!manager) return;
  for (const { name, morphSuffix } of MORPH_EXPRESSIONS) {
    if (manager.getExpression(name)) continue;
    const binds = new Map<number, THREE.Mesh[]>();
    vrm.scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh || !mesh.morphTargetDictionary) return;
      for (const [morphName, index] of Object.entries(mesh.morphTargetDictionary)) {
        if (!morphName.endsWith(morphSuffix)) continue;
        binds.set(index, [...(binds.get(index) ?? []), mesh]);
      }
    });
    if (binds.size === 0) continue;
    const expression = new VRMExpression(name);
    for (const [index, primitives] of binds) expression.addBind(new VRMExpressionMorphTargetBind({ primitives, index, weight: 1 }));
    vrm.scene.add(expression);
    manager.registerExpression(expression);
  }
}

/** MToon の加算マットキャップを材質の種類ごとに弱める。 */
function prepareMaterials(vrm: VRM, settings: RenderSettings): void {
  const scaled = new Set<THREE.Color>();
  forEachMaterial(vrm, (material) => {
    const mtoon = material as THREE.Material & { matcapFactor?: THREE.Color; matcapTexture?: THREE.Texture | null };
    const factor = mtoon.matcapFactor;
    // 輪郭線の材質（名前に " (Outline)"）と色の値を共有していても2回掛けない。
    if (!(factor instanceof THREE.Color) || !mtoon.matcapTexture || scaled.has(factor)) return;
    scaled.add(factor);
    factor.multiplyScalar(matcapScaleFor(material.name, settings));
  });
}

/**
 * glTF のサンプラーが minFilter=LINEAR（ミップマップなし）なので、縮小表示で髪の筋やまつげがちらつく。
 * 不透明な髪・肌・服のテクスチャにミップマップと異方性フィルタを付ける（mipmapAllowed）。
 * マットキャップは法線で引くので触らない。
 */
function applyTextureFiltering(vrm: VRM, settings: RenderSettings, maxAnisotropy: number): void {
  if (!settings.mipmaps) return;
  const seen = new Set<THREE.Texture>();
  forEachMaterial(vrm, (material) => {
    if (!mipmapAllowed(material.name, material.transparent)) return;
    const uniforms = (material as THREE.ShaderMaterial).uniforms ?? {};
    const candidates: [string, unknown][] = [
      ...Object.entries(material),
      ...Object.entries(uniforms).map(([name, uniform]) => [name, (uniform as { value: unknown }).value] as [string, unknown]),
    ];
    for (const [key, value] of candidates) {
      if (!(value instanceof THREE.Texture) || seen.has(value) || key === 'matcapTexture') continue;
      seen.add(value);
      value.generateMipmaps = true;
      value.minFilter = THREE.LinearMipmapLinearFilter;
      value.anisotropy = Math.max(1, Math.min(settings.anisotropy, maxAnisotropy));
      value.needsUpdate = true;
    }
  });
}

function forEachMaterial(vrm: VRM, visit: (material: THREE.Material) => void): void {
  const seen = new Set<THREE.Material>();
  vrm.scene.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      if (seen.has(material)) continue;
      seen.add(material);
      visit(material);
    }
  });
}

async function loadGltf(options: AvatarOptions) {
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  return loader.loadAsync(options.modelUrl, (event) => {
    options.onProgress?.(event.loaded, event.total);
  });
}

/**
 * VRM の適合層: ヒューマノイドの骨を ChestRig に渡して胸郭モーフを作り（chest_morph_three.ts、VRM に依存しない）、
 * VRM の表情 BREATH_CHEST_EXPRESSION として登録する。姿勢を当てる前に呼ぶ。
 */
function registerChestMorph(vrm: VRM): BreathMorphInfo {
  const { humanoid } = vrm;
  const upperChest = humanoid.getRawBoneNode('upperChest');
  const chestBone = upperChest ? 'upperChest' : 'chest';
  const info: BreathMorphInfo = { meshes: [], movedVertices: 0, maxDisplacementMm: 0, chestBone };
  const manager = vrm.expressionManager;
  const top = upperChest ?? humanoid.getRawBoneNode('chest');
  const neck = humanoid.getRawBoneNode('neck');
  if (!manager || !top || !neck || manager.getExpression(BREATH_CHEST_EXPRESSION)) return info;
  const built = addChestMorph(
    vrm.scene,
    {
      upperChest: top,
      chest: humanoid.getRawBoneNode('chest'),
      neck,
      spine: humanoid.getRawBoneNode('spine'),
      leftShoulder: humanoid.getRawBoneNode('leftShoulder'),
      rightShoulder: humanoid.getRawBoneNode('rightShoulder'),
      bust: findBustBones(top),
      // glTF の VRM 0.x は -Z、VRM 1.0 は +Z が前。
      fallbackFront: { x: 0, y: 0, z: vrm.meta.metaVersion === '0' ? -1 : 1 },
    },
    BREATH_CHEST_EXPRESSION,
  );
  info.movedVertices = built.movedVertices;
  info.maxDisplacementMm = built.maxDisplacementMm;
  info.meshes = built.targets.map((t) => t.mesh.name);
  if (built.targets.length === 0) return info;
  const binds = new Map<number, THREE.Mesh[]>();
  for (const { mesh, index } of built.targets) binds.set(index, [...(binds.get(index) ?? []), mesh]);
  const expression = new VRMExpression(BREATH_CHEST_EXPRESSION);
  for (const [index, primitives] of binds) expression.addBind(new VRMExpressionMorphTargetBind({ primitives, index, weight: 1 }));
  vrm.scene.add(expression);
  manager.registerExpression(expression);
  return info;
}

function describeModel(vrm: VRM): Omit<AvatarModelInfo, 'breathMorph'> {
  const humanBones = Object.values(VRMHumanBoneName).filter((name) => vrm.humanoid.getRawBoneNode(name) !== null);
  const meshes = new Map<string, AvatarModelInfo['meshes'][number]>();
  vrm.scene.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const dictionary = mesh.morphTargetDictionary ?? {};
    const name = mesh.parent && (mesh.parent as THREE.Group).type === 'Group' ? mesh.parent.name : mesh.name;
    const entry = meshes.get(name) ?? { name, primitives: 0, morphTargets: [], vertices: 0 };
    entry.primitives += 1;
    entry.vertices += mesh.geometry.getAttribute('position')?.count ?? 0;
    if (entry.morphTargets.length === 0) entry.morphTargets = Object.keys(dictionary);
    meshes.set(name, entry);
  });
  const applier = vrm.lookAt?.applier as unknown as {
    constructor: { type?: string; name: string };
    rangeMapHorizontalInner?: { inputMaxValue: number; outputScale: number };
    rangeMapHorizontalOuter?: { inputMaxValue: number; outputScale: number };
    rangeMapVerticalDown?: { inputMaxValue: number; outputScale: number };
    rangeMapVerticalUp?: { inputMaxValue: number; outputScale: number };
  };
  const range = (map?: { inputMaxValue: number; outputScale: number }): [number, number] | null =>
    map ? [map.inputMaxValue, map.outputScale] : null;
  return {
    specVersion: vrm.meta.metaVersion,
    meta: { ...vrm.meta } as unknown as Record<string, unknown>,
    expressions: vrm.expressionManager?.expressions.map((e) => e.expressionName) ?? [],
    humanBones,
    missingHumanBones: Object.values(VRMHumanBoneName).filter((name) => !humanBones.includes(name)),
    lookAt: {
      applier: applier?.constructor.type ?? applier?.constructor.name ?? 'none',
      horizontalInner: range(applier?.rangeMapHorizontalInner),
      horizontalOuter: range(applier?.rangeMapHorizontalOuter),
      verticalDown: range(applier?.rangeMapVerticalDown),
      verticalUp: range(applier?.rangeMapVerticalUp),
    },
    meshes: [...meshes.values()],
    springBoneJoints: vrm.springBoneManager?.joints.size ?? 0,
  };
}
