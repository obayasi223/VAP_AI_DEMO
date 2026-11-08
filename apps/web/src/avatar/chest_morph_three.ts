/**
 * 胸郭モーフを three の SkinnedMesh に足す（VRM に依存しない）。
 * 入力は「ルートの Object3D」と「骨の役割 → ノード」（首、胸、上胸、背骨、肩、胸の膨らみ）だけ。
 * 変位の計算は breath_morph.ts（純粋関数）。VRM の表情への登録は runtime.ts の適合層が行う。
 * ARKit の blendshape つきの glTF など、VRM 以外のヒューマノイドでも同じ関数が使える（未試験）。
 */
import * as THREE from 'three';
import { computeChestMorph, DEFAULT_CHEST_MORPH, type ChestFrame, type ChestMorphParams, type Vec3 } from './breath_morph';

export interface ChestRig {
  /** 胸を反らせる骨（上胸、無ければ胸）。 */
  upperChest: THREE.Object3D;
  chest: THREE.Object3D | null;
  neck: THREE.Object3D;
  spine?: THREE.Object3D | null;
  leftShoulder?: THREE.Object3D | null;
  rightShoulder?: THREE.Object3D | null;
  /** 胸の膨らみの副ボーン（VRoid の J_Sec_*_Bust* など）。前の向きと胸郭の中心に使う。 */
  bust?: THREE.Object3D[];
  /** 胸の膨らみが無いときの前の向き（スキニングの空間）。 */
  fallbackFront: Vec3;
}

export interface ChestMorphTarget {
  mesh: THREE.SkinnedMesh;
  /** mesh.morphTargetInfluences の添字。 */
  index: number;
}

export interface ChestMorphBuildResult {
  targets: ChestMorphTarget[];
  movedVertices: number;
  maxDisplacementMm: number;
}

/** 胸の膨らみの副ボーンを名前で探す（VRoid の慣例）。無ければ空。 */
export function findBustBones(upperChest: THREE.Object3D): THREE.Object3D[] {
  const found: THREE.Object3D[] = [];
  upperChest.traverse((object) => {
    if (object !== upperChest && /bust/i.test(object.name)) found.push(object);
  });
  return found;
}

/**
 * root の下の SkinnedMesh すべてに胸郭モーフ（名前 morphName、相対）を足す。変位が 0 のメッシュには足さない。
 * 姿勢を当てる前（骨がバインド時の位置）に呼ぶこと。骨の位置は boneInverses から取る。
 */
export function addChestMorph(
  root: THREE.Object3D,
  rig: ChestRig,
  morphName: string,
  params: ChestMorphParams = DEFAULT_CHEST_MORPH,
): ChestMorphBuildResult {
  const result: ChestMorphBuildResult = { targets: [], movedVertices: 0, maxDisplacementMm: 0 };
  const roles = new Map<THREE.Object3D, string>();
  const put = (node: THREE.Object3D | null | undefined, role: string) => {
    if (node) roles.set(node, role);
  };
  put(rig.upperChest, 'upperChest');
  put(rig.chest, 'chest');
  put(rig.spine, 'spine');
  put(rig.leftShoulder, 'leftShoulder');
  put(rig.rightShoulder, 'rightShoulder');
  for (const node of rig.bust ?? []) put(node, 'bust');

  const cache = new Map<string, THREE.BufferAttribute | null>();
  const ids = new WeakMap<object, number>();
  let nextId = 0;
  const idOf = (o: object) => {
    let id = ids.get(o);
    if (id === undefined) ids.set(o, (id = nextId++));
    return id;
  };
  const matrix = new THREE.Matrix4();
  const toVec = (v: THREE.Vector3): Vec3 => ({ x: v.x, y: v.y, z: v.z });

  root.traverse((object) => {
    const mesh = object as THREE.SkinnedMesh;
    if (!mesh.isSkinnedMesh) return;
    const geometry = mesh.geometry;
    const position = geometry.getAttribute('position');
    const skinIndex = geometry.getAttribute('skinIndex');
    const skinWeight = geometry.getAttribute('skinWeight');
    if (!position || !skinIndex || !skinWeight) return;
    const { skeleton, bindMatrix, bindMatrixInverse } = mesh;
    const bindPosition = (node: THREE.Object3D | null | undefined): THREE.Vector3 | null => {
      if (!node) return null;
      const index = skeleton.bones.indexOf(node as THREE.Bone);
      const inverse = skeleton.boneInverses[index];
      if (index < 0 || !inverse) return null;
      return new THREE.Vector3().setFromMatrixPosition(matrix.copy(inverse).invert());
    };
    const upper = bindPosition(rig.upperChest);
    const chest = bindPosition(rig.chest) ?? upper;
    const neck = bindPosition(rig.neck);
    if (!upper || !chest || !neck) return;
    const bust = (rig.bust ?? []).map(bindPosition).filter((v): v is THREE.Vector3 => v !== null);
    const bustCenter = bust.length > 0 ? bust.reduce((a, b) => a.add(b), new THREE.Vector3()).multiplyScalar(1 / bust.length) : null;
    const front = new THREE.Vector3(rig.fallbackFront.x, 0, rig.fallbackFront.z).normalize();
    if (bustCenter) {
      const d = bustCenter.clone().sub(upper).setY(0);
      if (d.lengthSq() > 1e-8) front.copy(d.normalize());
    }
    const frame: ChestFrame = {
      upperChest: toVec(upper),
      chest: toVec(chest),
      neck: toVec(neck),
      front: toVec(front),
      bust: bustCenter ? toVec(bustCenter) : null,
    };

    const key = `${idOf(position)}:${idOf(skinIndex)}:${idOf(skinWeight)}:${idOf(skeleton)}:${bindMatrix.elements.join(',')}`;
    let morph = cache.get(key);
    if (morph === undefined) {
      morph = buildMorph(position, skinIndex, skinWeight, skeleton, bindMatrix, bindMatrixInverse, roles, frame, params, result);
      if (morph) morph.name = morphName;
      cache.set(key, morph);
    }
    if (!morph) return;

    const existing = geometry.morphAttributes.position ?? [];
    if (existing.length === 0) geometry.morphTargetsRelative = true;
    if (!geometry.morphTargetsRelative) return; // 絶対値のモーフを持つメッシュには足さない（混ぜると壊れる）。
    const index = existing.length;
    geometry.morphAttributes.position = [...existing, morph];
    for (const key of ['normal', 'color'] as const) {
      const others = geometry.morphAttributes[key];
      if (!others || others.length === 0) continue;
      const itemSize = others[0]!.itemSize;
      const zero = new THREE.BufferAttribute(new Float32Array(position.count * itemSize), itemSize);
      zero.name = morphName;
      geometry.morphAttributes[key] = [...others, zero];
    }
    mesh.updateMorphTargets();
    result.targets.push({ mesh, index });
  });
  return result;
}

function buildMorph(
  position: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  skinIndex: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  skinWeight: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  skeleton: THREE.Skeleton,
  bindMatrix: THREE.Matrix4,
  bindMatrixInverse: THREE.Matrix4,
  roles: Map<THREE.Object3D, string>,
  frame: ChestFrame,
  params: ChestMorphParams,
  result: ChestMorphBuildResult,
): THREE.BufferAttribute | null {
  const count = position.count;
  const positions = new Float32Array(count * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < count; i += 1) {
    v.fromBufferAttribute(position, i).applyMatrix4(bindMatrix);
    positions[i * 3] = v.x;
    positions[i * 3 + 1] = v.y;
    positions[i * 3 + 2] = v.z;
  }
  const indices = new Float32Array(count * 4);
  const weights = new Float32Array(count * 4);
  for (let i = 0; i < count; i += 1) {
    for (let k = 0; k < 4; k += 1) {
      indices[i * 4 + k] = skinIndex.getComponent(i, k);
      weights[i * 4 + k] = skinWeight.getComponent(i, k);
    }
  }
  const computed = computeChestMorph(
    { positions, skinIndex: indices, skinWeight: weights, boneRole: (index) => roles.get(skeleton.bones[index] as THREE.Object3D) ?? null },
    frame,
    params,
  );
  if (computed.movedVertices === 0) return null;
  // スキニングの空間の変位 → ジオメトリの空間（向きだけ戻す）。
  const rotation = new THREE.Matrix3().setFromMatrix4(bindMatrixInverse);
  const d = new THREE.Vector3();
  const out = computed.displacement;
  for (let i = 0; i < count; i += 1) {
    d.set(out[i * 3]!, out[i * 3 + 1]!, out[i * 3 + 2]!).applyMatrix3(rotation);
    out[i * 3] = d.x;
    out[i * 3 + 1] = d.y;
    out[i * 3 + 2] = d.z;
  }
  result.movedVertices += computed.movedVertices;
  result.maxDisplacementMm = Math.max(result.maxDisplacementMm, computed.maxDisplacementM * 1000);
  return new THREE.BufferAttribute(out, 3);
}
