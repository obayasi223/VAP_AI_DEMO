/**
 * VRM 以外の glTF（ARKit／視素の形状と Biped 系の骨）用の適合層（レーン アバター差し替え）。
 * 骨の軸はモデルごとに違うので、three-vrm の正規化ボーンと同じ計算（親のレスト時のワールド回転で挟む）で、
 * 層の書く「VRM 1.0 の向き」（+Z が前、x の正が下、y の正がモデルの左）をモデルの骨へ移す。
 * VRM の経路は通らない。VRM の見た目と動作はここからは変わらない。
 */
import * as THREE from 'three';
import type { GlbModelSpec, EyeRange } from './avatar_models';
import { BREATH_CHEST_EXPRESSION } from './breath';
import { addChestMorph } from './chest_morph_three';
import type { AvatarRig, EyeAngles } from './rig';
import type { AvatarModelInfo, BreathMorphInfo } from './runtime';
import type { BoneOffset, PoseFrame } from './pose';
import { RAD2DEG } from './util';

interface RigBone {
  role: string;
  node: THREE.Object3D;
  restLocal: THREE.Quaternion;
  parentWorld: THREE.Quaternion;
  parentWorldInverse: THREE.Quaternion;
}

/** glTF のノード名（GLTFLoader は空白などを _ にする）を探す。 */
export function findNode(root: THREE.Object3D, name: string): THREE.Object3D | null {
  const sanitized = THREE.PropertyBinding.sanitizeNodeName(name);
  let found: THREE.Object3D | null = null;
  root.traverse((object) => {
    if (found === null && (object.name === name || object.name === sanitized)) found = object;
  });
  return found;
}

const _world = new THREE.Quaternion();

function bindBone(role: string, node: THREE.Object3D): RigBone {
  node.parent?.updateWorldMatrix(true, false);
  const parentWorld = node.parent ? node.parent.getWorldQuaternion(new THREE.Quaternion()) : new THREE.Quaternion();
  return { role, node, restLocal: node.quaternion.clone(), parentWorld, parentWorldInverse: parentWorld.clone().invert() };
}

const _eq = new THREE.Quaternion();
const _e1 = new THREE.Vector3();
const _e2 = new THREE.Vector3();
const _pq = new THREE.Quaternion();

/** 正規化された回転 q をモデルの骨のローカル回転へ（three-vrm の VRMHumanoidRig と同じ式）。 */
function applyNormalized(bone: RigBone, q: THREE.Quaternion): void {
  bone.node.quaternion.copy(bone.parentWorldInverse).multiply(q).multiply(bone.parentWorld).multiply(bone.restLocal);
}

/** VRM の lookAt の range map と同じ写像（度）。 */
export function mapEyeAngle(angleDeg: number, inputMaxDeg: number, outputDeg: number): number {
  return Math.min(Math.abs(angleDeg), inputMaxDeg) / inputMaxDeg * outputDeg * Math.sign(angleDeg);
}

/** 眼の回転（度）。yaw の正はモデルの左、pitch の正は下（lookAt と同じ）。 */
export function eyeRotation(side: 'left' | 'right', yawDeg: number, pitchDeg: number, r: EyeRange): { x: number; y: number } {
  const outward = side === 'left' ? yawDeg > 0 : yawDeg < 0;
  const y = mapEyeAngle(yawDeg, r.inputMaxDeg, outward ? r.outerDeg : r.innerDeg);
  const x = mapEyeAngle(pitchDeg, r.inputMaxDeg, pitchDeg >= 0 ? r.downDeg : r.upDeg);
  return { x, y };
}

export function createGlbRig(root: THREE.Object3D, spec: GlbModelSpec): AvatarRig {
  root.traverse((object) => {
    object.frustumCulled = false;
  });
  root.updateMatrixWorld(true);

  const bones = new Map<string, RigBone>();
  const missing: string[] = [];
  for (const [role, name] of Object.entries(spec.bones)) {
    const node = findNode(root, name);
    if (node) bones.set(role, bindBone(role, node));
    else missing.push(role);
  }
  const need = (role: string): RigBone | null => bones.get(role) ?? null;
  const head = need('head');
  const neck = need('neck');
  if (!head || !neck) throw new Error('GLB の骨の対応に首か頭が無い');

  // バインドが T ポーズでない腕は、差を読み込み時に求める（層の rest は T ポーズからの下ろし角）。
  const armCorrection = new Map<string, THREE.Quaternion>();
  if (spec.tPoseArms) {
    for (const [role, childRole, target] of [
      ['leftUpperArm', 'leftLowerArm', new THREE.Vector3(1, 0, 0)],
      ['rightUpperArm', 'rightLowerArm', new THREE.Vector3(-1, 0, 0)],
    ] as const) {
      const arm = need(role);
      const child = need(childRole);
      if (!arm || !child) continue;
      const dir = child.node.getWorldPosition(new THREE.Vector3()).sub(arm.node.getWorldPosition(new THREE.Vector3())).normalize();
      armCorrection.set(role, new THREE.Quaternion().setFromUnitVectors(dir, target));
    }
  }

  // addChestMorph の updateMorphTargets は名前の辞書を番号に戻す（GLTFLoader は名前を辞書にしか持たない）。VRM は番号で束ねているので影響なし。
  const namedMorphs = new Map<THREE.Mesh, Record<string, number>>();
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh && mesh.morphTargetDictionary) namedMorphs.set(mesh, { ...mesh.morphTargetDictionary });
  });
  // 胸郭モーフ（chest_morph_three.ts は VRM に依存しない）。
  const breathMorph = buildChestMorph(root, need, !!need('upperChest') ? 'upperChest' : 'chest');
  for (const [mesh, names] of namedMorphs) Object.assign(mesh.morphTargetDictionary as Record<string, number>, names);

  // 表情 → モーフの束。名前の無いモーフは飛ばす。
  const binds = new Map<string, { influences: number[]; index: number; weight: number }[]>();
  const morphMeshes: THREE.SkinnedMesh[] = [];
  root.traverse((object) => {
    const mesh = object as THREE.SkinnedMesh;
    if (mesh.isSkinnedMesh && mesh.morphTargetDictionary && mesh.morphTargetInfluences) morphMeshes.push(mesh);
  });
  for (const [expression, list] of Object.entries(spec.expressions)) {
    const items = binds.get(expression) ?? [];
    for (const { morph, weight } of list) {
      for (const mesh of morphMeshes) {
        const index = mesh.morphTargetDictionary?.[morph];
        if (index !== undefined) items.push({ influences: mesh.morphTargetInfluences as number[], index, weight });
      }
    }
    binds.set(expression, items);
  }
  // 胸郭モーフは名前そのまま（addChestMorph の結果）。
  binds.set(
    BREATH_CHEST_EXPRESSION,
    morphMeshes.flatMap((mesh) => {
      const index = mesh.morphTargetDictionary?.[BREATH_CHEST_EXPRESSION];
      return index === undefined ? [] : [{ influences: mesh.morphTargetInfluences as number[], index, weight: 1 }];
    }),
  );

  // 透過の髪・まつげはアルファカットに（並べ替えのちらつきを避ける）。
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      if (spec.cutoutMaterials?.some((part) => material.name.includes(part))) {
        material.transparent = false;
        material.alphaTest = 0.4;
        material.alphaToCoverage = true;
        material.depthWrite = true;
        material.needsUpdate = true;
      }
    }
  });

  const values = new Map<string, number>();
  const leftEye = need('leftEye');
  const rightEye = need('rightEye');
  const headNode = head.node;
  const restHeadWorld = headNode.getWorldQuaternion(new THREE.Quaternion());
  const eyePos = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const roleQ = new Map<string, THREE.Quaternion>();
  const euler = new THREE.Euler();
  const identity = new THREE.Quaternion();
  const eyeState: Record<'left' | 'right', EyeAngles> = { left: { yawDeg: 0, pitchDeg: 0 }, right: { yawDeg: 0, pitchDeg: 0 } };
  const inputEye: EyeAngles = { yawDeg: 0, pitchDeg: 0 };

  const eyeCenter = (target: THREE.Vector3): void => {
    if (leftEye && rightEye) {
      leftEye.node.getWorldPosition(_e1);
      rightEye.node.getWorldPosition(_e2);
      target.copy(_e1).add(_e2).multiplyScalar(0.5);
    } else {
      headNode.getWorldPosition(target);
    }
  };

  const applyEye = (side: 'left' | 'right', bone: RigBone | null, yawDeg: number, pitchDeg: number): void => {
    const { x, y } = eyeRotation(side, yawDeg, pitchDeg, spec.eyeRange);
    eyeState[side] = { yawDeg: y, pitchDeg: x };
    if (!bone) return;
    q.setFromEuler(euler.set(x / RAD2DEG, y / RAD2DEG, 0, 'XYZ'));
    applyNormalized(bone, q);
  };

  return {
    kind: 'glb',
    root,
    breathMorph,
    breathOutput: { chest: breathMorph.chestBone },
    applyFrame(frame: PoseFrame, camera: THREE.Camera) {
      for (const [role, offset] of frame.bones) {
        const bone = bones.get(role);
        if (!bone) continue;
        const rq = roleQ.get(role) ?? new THREE.Quaternion();
        rq.setFromEuler(euler.set(offset.x, offset.y, offset.z, 'XYZ'));
        const correction = armCorrection.get(role);
        if (correction) rq.multiply(correction);
        roleQ.set(role, rq);
      }
      for (const [role, rq] of roleQ) {
        const bone = bones.get(role);
        if (!bone) continue;
        const parentRole = spec.counterParent?.[role];
        if (parentRole) {
          _pq.copy(roleQ.get(parentRole) ?? identity).invert().multiply(rq);
          applyNormalized(bone, _pq);
        } else {
          applyNormalized(bone, rq);
        }
      }
      // 親の無いものにも打ち消しを（鎖骨は吸気の前は書かれない）。
      if (spec.counterParent) {
        for (const [role, parentRole] of Object.entries(spec.counterParent)) {
          if (frame.bones.has(role)) continue;
          const bone = bones.get(role);
          if (!bone) continue;
          applyNormalized(bone, _pq.copy(roleQ.get(parentRole) ?? identity).invert());
        }
      }

      // 視線: 前のフレームの頭の向きでカメラへの向きを求め、そらす量を足す（VRM の lookAt と同じ）。
      eyeCenter(eyePos);
      headNode.getWorldQuaternion(_world).invert();
      dir.copy(camera.position).sub(eyePos).applyQuaternion(_eq.copy(restHeadWorld).multiply(_world)).normalize();
      const baseYaw = Math.atan2(dir.x, dir.z) * RAD2DEG;
      const basePitch = -Math.atan2(dir.y, Math.hypot(dir.x, dir.z)) * RAD2DEG;
      inputEye.yawDeg = baseYaw * frame.eye.userWeight + frame.eye.yawDeg;
      inputEye.pitchDeg = basePitch * frame.eye.userWeight + frame.eye.pitchDeg;
      applyEye('left', leftEye, inputEye.yawDeg, inputEye.pitchDeg);
      applyEye('right', rightEye, inputEye.yawDeg, inputEye.pitchDeg);

      for (const items of binds.values()) for (const b of items) b.influences[b.index] = 0;
      for (const [name, weight] of frame.expressions) {
        values.set(name, weight);
        for (const b of binds.get(name) ?? []) {
          b.influences[b.index] = Math.min(1, (b.influences[b.index] ?? 0) + weight * b.weight);
        }
      }
    },
    settle: () => root.updateMatrixWorld(true),
    prepareTextures(maxAnisotropy: number) {
      const seen = new Set<THREE.Texture>();
      root.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh) return;
        for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
          const std = material as THREE.MeshStandardMaterial;
          for (const tex of [std.map, std.normalMap, std.roughnessMap]) {
            if (!tex || seen.has(tex)) continue;
            seen.add(tex);
            tex.anisotropy = Math.max(1, Math.min(4, maxAnisotropy));
            tex.needsUpdate = true;
          }
        }
      });
    },
    eyeWorldPosition: eyeCenter,
    rawBone: (role) => bones.get(role)?.node ?? null,
    readEye: (side) => eyeState[side],
    eyeInput: () => ({ ...inputEye }),
    expressionValue: (name) => values.get(name) ?? 0,
    describe: () => describeGlb(root, spec, bones, missing, [...binds.keys()]),
    dispose() {
      root.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.geometry.dispose();
        for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
          for (const value of Object.values(material)) if (value instanceof THREE.Texture) value.dispose();
          material.dispose();
        }
      });
    },
  };

  function buildChestMorph(rootNode: THREE.Object3D, get: typeof need, chestBone: string): BreathMorphInfo {
    const upper = get('upperChest') ?? get('chest');
    const neckBone = get('neck');
    const info: BreathMorphInfo = { meshes: [], movedVertices: 0, maxDisplacementMm: 0, chestBone };
    if (!upper || !neckBone) return info;
    const built = addChestMorph(
      rootNode,
      {
        upperChest: upper.node,
        chest: get('chest')?.node ?? null,
        neck: neckBone.node,
        spine: get('spine')?.node ?? null,
        leftShoulder: get('leftShoulder')?.node ?? null,
        rightShoulder: get('rightShoulder')?.node ?? null,
        bust: [],
        fallbackFront: { x: 0, y: 0, z: 1 },
      },
      BREATH_CHEST_EXPRESSION,
    );
    info.movedVertices = built.movedVertices;
    info.maxDisplacementMm = built.maxDisplacementMm;
    info.meshes = built.targets.map((t) => t.mesh.name);
    return info;
  }
}

function describeGlb(
  root: THREE.Object3D,
  spec: GlbModelSpec,
  bones: Map<string, RigBone>,
  missing: string[],
  expressions: string[],
): Omit<AvatarModelInfo, 'breathMorph'> {
  const meshes = new Map<string, AvatarModelInfo['meshes'][number]>();
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const entry = meshes.get(mesh.name) ?? { name: mesh.name, primitives: 0, morphTargets: [], vertices: 0 };
    entry.primitives += 1;
    entry.vertices += mesh.geometry.getAttribute('position')?.count ?? 0;
    if (entry.morphTargets.length === 0) entry.morphTargets = Object.keys(mesh.morphTargetDictionary ?? {});
    meshes.set(mesh.name, entry);
  });
  return {
    specVersion: 'glb',
    meta: { spec_bones: Object.keys(spec.bones).length },
    expressions,
    humanBones: [...bones.keys()],
    missingHumanBones: missing,
    lookAt: { applier: 'glb_bone_rangemap', horizontalInner: [spec.eyeRange.inputMaxDeg, spec.eyeRange.innerDeg], horizontalOuter: [spec.eyeRange.inputMaxDeg, spec.eyeRange.outerDeg], verticalDown: [spec.eyeRange.inputMaxDeg, spec.eyeRange.downDeg], verticalUp: [spec.eyeRange.inputMaxDeg, spec.eyeRange.upDeg] },
    meshes: [...meshes.values()],
    springBoneJoints: 0,
  };
}

export type { BoneOffset };
