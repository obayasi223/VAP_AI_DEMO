/**
 * 1 体ぶんの層と制御（AvatarCore。docs/design/two_ai/03 §2.1）。レンダラー、カメラ、rAF は持たない（stage.ts が持つ）。
 * runtime.ts の createAvatar から、描画に依らない部分をそのまま移した（動作は変えない）。
 * 判断はしない: 視線は setGaze で外から受け、音量は setMouthLevel／pushPcm で、語時刻と再生位置は
 * onPlaybackAlignment／onPlaybackReport で受ける（配線は J）。
 *
 * 層の順: rest → idle → gaze → saccade → expression → breath → blink → mouth。
 * 1フレームの順序（ステージから）: applyPose（層の合成 → ボーンへ適用 → 視線 → 表情 → vrm.update）→ 描画 → rendered（報告）。
 * VRM の読み込みと適合層（createVrmRig）もここに置く（stage.ts と runtime.ts の循環を避ける）。
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
import { BREATH_CHEST_EXPRESSION, BreathLayer, mergeBreathParams, type BreathPhaseEvent } from './breath';
import { addChestMorph, findBustBones } from './chest_morph_three';
import { ExpressionLayer } from './face';
import { DEFAULT_GAZE, GazeController, GazeLayer, GazeReporter } from './gaze';
import { IdleLayer, RestPoseLayer } from './idle';
import { AlignmentMouthSource } from './lipsync';
import { computeRms, MouthLayer, VolumeMouthSource, mouthOpenAmount } from './mouth';
import { SaccadeGenerator, SaccadeLayer } from './saccade';
import { boneSignForMeta, LayerStack } from './pose';
import { matcapScaleFor, mipmapAllowed, type RenderSettings } from './render_settings';
import type { AvatarRig } from './rig';
import { createGlbRig } from './rig_glb';
import type { Avatar, AvatarModelInfo, BreathMorphInfo, Framing } from './runtime';
import type { GazeGeometry } from './stage_layout';
import { RAD2DEG, type Rng } from './util';

/** 髪のばねは大きな dt で暴れるので別に抑える。 */
const MAX_SPRING_DT_MS = 66;

/** ステージが持つ操作（カメラと破棄）。1 体のステージだけが意味を持つ。 */
export interface AvatarStageHooks {
  setFraming(framing: Framing): void;
  setViewYaw(deg: number): void;
  dispose(): void;
  /** 描画のループの値（getTelemetry 用）。 */
  frameInfo(): { frame: number; rafMs: number; fps: number };
}

export interface AvatarCoreOptions {
  rig: AvatarRig;
  rng: Rng;
  hooks: AvatarStageHooks;
  geometry?: GazeGeometry | null;
  /** 最初の姿勢を当てるときの眼の目標（従来はまだ置いていないカメラの位置＝原点）。 */
  initialLookAt: THREE.Vector3;
  onGazeReport?: (report: GazeReport) => void;
  onBreathPhase?: (event: BreathPhaseEvent) => void;
}

export interface AvatarCore {
  readonly rig: AvatarRig;
  /** 公開の Avatar（runtime.ts の型と同じ）。 */
  readonly avatar: Avatar;
  /** 1 フレームぶん層を進めて rig へ当てる。時間の倍率（setTimeScale／advanceTime）はここで扱う。 */
  step(dtMs: number, nowMs: number, lookAtWorld: THREE.Vector3): void;
  /** 層の時間をそのまま当てる（最初の姿勢など）。 */
  applyPose(dtMs: number, nowMs: number, lookAtWorld: THREE.Vector3): void;
  /** 描画の直後に rAF の時刻で呼ぶ（視線の報告）。 */
  rendered(nowMs: number): void;
  gazeTarget(): GazeTarget;
  setGeometry(geometry: GazeGeometry | null): void;
  chestWeight(): number;
}

export function createAvatarCore(options: AvatarCoreOptions): AvatarCore {
  const { rig, rng, hooks } = options;
  const geometry = options.geometry ?? null;
  const stack = new LayerStack();
  const mouth = new VolumeMouthSource();
  const lipSync = new AlignmentMouthSource(mouth, () => performance.now());
  const blinkScheduler = new BlinkScheduler(rng);
  const gazeController = new GazeController(rng, {}, geometry);
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
  let currentGeometry = geometry;
  /** 目標の間の頭の角の差（peer への切り替えは大きい）。1 体では 0 なので従来の値のまま。 */
  const headShiftDeg = (from: GazeTarget, to: GazeTarget): number => {
    if (currentGeometry === null || (from !== 'peer' && to !== 'peer')) return 0;
    const angle = (t: GazeTarget) => (t === 'away' ? 0 : currentGeometry![t].headYawDeg);
    return Math.abs(angle(from) - angle(to));
  };

  const gazeReporter = new GazeReporter((report) => options.onGazeReport?.(report));

  const applyPose = (dtMs: number, nowMs: number, lookAtWorld: THREE.Vector3) => {
    blinkScheduler.speaking = expression.features.speaking > 0.5;
    const frame = stack.step({ dtMs, nowMs });
    rig.applyFrame(frame, lookAtWorld, dtMs);
  };

  // 最初の姿勢を当ててから髪の揺れを新しい姿勢で初期化する（カメラはこの後にステージが置く）。
  applyPose(0, performance.now(), options.initialLookAt);
  rig.settle();

  // シーングラフから読む頭の向き（体に対して。ステージが置いた後に作るので、置いた向きが基準）。
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

  let timeScale = 1;
  let pendingAdvanceMs = 0;
  let layerClockMs = 0;
  const step = (dtMs: number, nowMs: number, lookAtWorld: THREE.Vector3) => {
    if (timeScale === 1 && pendingAdvanceMs === 0) {
      applyPose(dtMs, nowMs, lookAtWorld);
      return;
    }
    // 確認用の時間制御。層の時刻は実時間と切り離す。
    let pending = pendingAdvanceMs;
    pendingAdvanceMs = 0;
    while (pending > 0) {
      const s = Math.min(16, pending);
      layerClockMs += s;
      applyPose(s, layerClockMs, lookAtWorld);
      pending -= s;
    }
    layerClockMs += dtMs * timeScale;
    applyPose(dtMs * timeScale, layerClockMs, lookAtWorld);
  };

  const avatar: Avatar = {
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
      const from = gazeController.currentTarget;
      if (gazeController.setTarget(target)) {
        gazeReporter.commanded(target, typeof document === 'undefined' || !document.hidden);
        blinkScheduler.onGazeShift(Math.max(gazeShiftDeg, headShiftDeg(from, target)));
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
    setFraming: (framing) => hooks.setFraming(framing),
    setTimeScale: (scale) => {
      if (timeScale === 1 && scale !== 1) layerClockMs = performance.now();
      timeScale = Math.max(0, scale);
    },
    advanceTime: (ms) => {
      pendingAdvanceMs += Math.max(0, ms);
    },
    setViewYaw: (deg) => hooks.setViewYaw(deg),
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
      const info = hooks.frameInfo();
      return {
        frame: info.frame,
        rafMs: info.rafMs,
        fps: info.fps,
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
    dispose: () => hooks.dispose(),
  };

  return {
    rig,
    avatar,
    step,
    applyPose,
    rendered: (nowMs) => gazeReporter.rendered(nowMs),
    gazeTarget: () => gazeController.currentTarget,
    setGeometry: (g) => {
      currentGeometry = g;
      gazeController.setGeometry(g);
    },
    chestWeight: () => breath.telemetry().chestWeight,
  };
}

/** VRM の適合層。従来 createAvatar の中にあった処理をそのままここへ移した（動作は変えない）。 */
export function createVrmRig(gltf: Awaited<ReturnType<typeof loadGltf>>, modelUrl: string, settings: RenderSettings): AvatarRig {
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
    applyFrame(frame, lookAtWorld, dtMs) {
      for (const [name, offset] of frame.bones) {
        humanoid.getNormalizedBoneNode(name as VRMHumanBoneName)?.rotation.set(offset.x * sign.x, offset.y * sign.y, offset.z * sign.z);
      }
      // 前のフレームの頭の行列で lookAtWorld（1 体ではカメラ）への向きを求め、そらす量を足す。1フレーム遅れは問題にならない。
      lookAt.lookAt(lookAtWorld);
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

async function loadGltf(modelUrl: string, onProgress?: (loadedBytes: number, totalBytes: number) => void) {
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  return loader.loadAsync(modelUrl, (event) => {
    onProgress?.(event.loaded, event.total);
  });
}

/** モデルを読み、適合層を作る（VRM は createVrmRig、それ以外は rig_glb.ts）。描画の設定は材質とばねに使う。 */
export async function loadRig(
  modelUrl: string,
  model: AvatarModelSpec | undefined,
  settings: RenderSettings,
  onProgress?: (loadedBytes: number, totalBytes: number) => void,
): Promise<AvatarRig> {
  const gltf = await loadGltf(modelUrl, onProgress);
  return model?.kind === 'glb' ? createGlbRig(gltf.scene, model) : createVrmRig(gltf, modelUrl, settings);
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
