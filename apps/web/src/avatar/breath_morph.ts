/**
 * 胸郭の専用モーフ（計画 §4.7）。読み込み時に、頂点のバインド時の位置とスキンウェイトから変位を計算する。
 * 体（肌）も服も同じ関数を通すので、同じ場所の頂点は同じだけ動き、服が肌に潜りにくい。
 * ボーンのスケールは使わない（upperChest のスケールは子の首・肩・腕へ継承されて歪む）。
 *
 * 座標はスキニングの空間（bindMatrix を掛けた頂点と、boneInverses の逆のボーン位置が同じ空間）。
 * three に依存しない。runtime.ts が配列を渡し、返った変位を morphAttributes.position に入れる。
 * 値はすべて暫定。
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface ChestMorphParams {
  /** モーフの重み 1 のときの、胸骨の前の変位（m）。 */
  forwardM: number;
  /** 脇の外向きの変位（m）。 */
  lateralM: number;
  /** 背中の外向きの変位（m）。 */
  backM: number;
  /** 上向きの変位（m）。鎖骨の辺りが持ち上がる。 */
  upM: number;
  /** 高さの広がり（上胸から首までの距離に対する割合、ガウスの標準偏差）。 */
  verticalSigma: number;
  /** 中心の高さ（上胸 → 首の割合。0 で上胸の高さ）。 */
  centerOffset: number;
  /** 胸郭の中心の前後位置（上胸のボーン → 胸の膨らみのボーンの割合）。 */
  axisForward: number;
}

export const DEFAULT_CHEST_MORPH: ChestMorphParams = {
  forwardM: 0.019,
  lateralM: 0.0083,
  backM: 0.0024,
  upM: 0.0071,
  verticalSigma: 0.75,
  centerOffset: 0.1,
  axisForward: 0.5,
};

/** 胸郭とみなすボーンの重み。肩は鎖骨の辺りなので半分。首・頭・腕は 0（動かさない）。 */
export const CHEST_BONE_WEIGHTS: Record<string, number> = {
  upperChest: 1,
  chest: 0.9,
  spine: 0.35,
  leftShoulder: 0.45,
  rightShoulder: 0.45,
  bust: 1,
};

export interface ChestFrame {
  /** 上胸（無ければ胸）のボーンの位置。 */
  upperChest: Vec3;
  /** 胸のボーンの位置（下端の目安）。 */
  chest: Vec3;
  neck: Vec3;
  /** モデルの前の向き（単位ベクトル、水平）。 */
  front: Vec3;
  /** 胸の膨らみのボーン（あれば）。胸郭の中心の前後位置に使う。 */
  bust: Vec3 | null;
}

export interface SkinnedVertices {
  /** xyz の並び（スキニングの空間）。 */
  positions: ArrayLike<number>;
  /** 4つずつ。 */
  skinIndex: ArrayLike<number>;
  skinWeight: ArrayLike<number>;
  /** skinIndex → ヒューマノイドのボーン名（胸の膨らみの副ボーンは 'bust'）。無関係なボーンは null。 */
  boneRole: (index: number) => string | null;
}

export interface ChestMorphResult {
  /** xyz の並びの変位（スキニングの空間）。 */
  displacement: Float32Array;
  maxDisplacementM: number;
  movedVertices: number;
}

/** 頂点がどれだけ胸郭に属するか（0〜1）。 */
export function chestMembership(vertices: SkinnedVertices, i: number): number {
  let sum = 0;
  for (let k = 0; k < 4; k += 1) {
    const w = Number(vertices.skinWeight[i * 4 + k] ?? 0);
    if (w <= 0) continue;
    const role = vertices.boneRole(Number(vertices.skinIndex[i * 4 + k] ?? 0));
    sum += w * (role ? (CHEST_BONE_WEIGHTS[role] ?? 0) : 0);
  }
  return Math.min(1, Math.max(0, sum));
}

/** 1頂点の変位。位置とウェイトだけの関数（体と服で同じ）。 */
export function chestDisplacement(p: Vec3, membership: number, frame: ChestFrame, params: ChestMorphParams = DEFAULT_CHEST_MORPH): Vec3 {
  if (membership <= 0) return { x: 0, y: 0, z: 0 };
  const span = Math.max(frame.neck.y - frame.chest.y, 1e-3);
  const centerY = frame.upperChest.y + (frame.neck.y - frame.upperChest.y) * params.centerOffset;
  const dy = (p.y - centerY) / (span * params.verticalSigma);
  let vertical = Math.exp(-0.5 * dy * dy);
  // 首より上は動かさない。首の付け根の手前で 0 に落とす。
  const neckFade = (frame.neck.y - p.y) / (span * 0.25);
  vertical *= neckFade <= 0 ? 0 : neckFade >= 1 ? 1 : neckFade * neckFade * (3 - 2 * neckFade);
  const amount = membership * vertical;
  if (amount <= 1e-6) return { x: 0, y: 0, z: 0 };

  // 胸郭の中心軸（縦）。前後は上胸のボーンと胸の膨らみの間。
  const f = frame.front;
  const axisDepth = frame.bust ? ((frame.bust.x - frame.upperChest.x) * f.x + (frame.bust.z - frame.upperChest.z) * f.z) * params.axisForward : 0.04;
  const ax = frame.upperChest.x + f.x * axisDepth;
  const az = frame.upperChest.z + f.z * axisDepth;
  let rx = p.x - ax;
  let rz = p.z - az;
  const r = Math.hypot(rx, rz);
  if (r < 1e-6) {
    rx = f.x;
    rz = f.z;
  } else {
    rx /= r;
    rz /= r;
  }
  // 前ほど大きく、脇は中くらい、背中は小さく。
  const facing = rx * f.x + rz * f.z;
  const outward = facing >= 0 ? params.lateralM + (params.forwardM - params.lateralM) * facing : params.lateralM + (params.backM - params.lateralM) * -facing;
  return { x: rx * outward * amount, y: params.upM * amount, z: rz * outward * amount };
}

export function computeChestMorph(vertices: SkinnedVertices, frame: ChestFrame, params: ChestMorphParams = DEFAULT_CHEST_MORPH): ChestMorphResult {
  const count = Math.floor(vertices.positions.length / 3);
  const displacement = new Float32Array(count * 3);
  let max = 0;
  let moved = 0;
  for (let i = 0; i < count; i += 1) {
    const membership = chestMembership(vertices, i);
    if (membership <= 0) continue;
    const p = { x: Number(vertices.positions[i * 3]), y: Number(vertices.positions[i * 3 + 1]), z: Number(vertices.positions[i * 3 + 2]) };
    const d = chestDisplacement(p, membership, frame, params);
    const length = Math.hypot(d.x, d.y, d.z);
    if (length <= 1e-7) continue;
    displacement[i * 3] = d.x;
    displacement[i * 3 + 1] = d.y;
    displacement[i * 3 + 2] = d.z;
    moved += 1;
    if (length > max) max = length;
  }
  return { displacement, maxDisplacementM: max, movedVertices: moved };
}
