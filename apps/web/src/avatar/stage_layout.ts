/**
 * 2 体の配置の幾何（docs/design/two_ai/03 §2.2）。three に依存しない純粋な関数。
 *
 * 座標: 右手系。カメラ（＝利用者）は +Z 側から -Z を見る。モデルは既定で +Z（カメラ）を向く。
 * 向きの規約は gaze.ts と同じ: yaw の正はモデルの左（モデルが +Z を向くとき +X、画面の右）。
 * A は -x（画面の左）で +yaw（相手の B のほうへ回す）、B は +x で -yaw。
 * 2 体は互いに斜めに向き合い、開いた三角形の残りの一辺に利用者がいる（脇の参加者）。
 */
import type { AiId } from '@llm-vap/contracts';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface StageLayout {
  /** 2 体の眼の間の水平距離の半分（m）。A は -x（画面の左）、B は +x。 */
  halfSpacingM: number;
  /** 体の向き。正で相手のほうへ回す（A は +yaw、B は -yaw）。0 は真正面（利用者）を向く。 */
  bodyYawDeg: number;
  /** カメラ（＝利用者）の位置：2 体の眼の中点から前方の距離。 */
  cameraDistanceM: number;
  /** 眼の高さからのカメラの高さの差（正で上）。 */
  cameraHeightOffsetM: number;
  verticalFovDeg: number;
  /** カメラの注視点を眼の中点からどれだけ下げるか。 */
  lookDownM: number;
  /** 頭で回す角の上限。残りは眼（lookAt。モデルの range map で縮む）。 */
  maxHeadYawDeg: number;
}

export const TWO_AI_LAYOUT: StageLayout = {
  halfSpacingM: 0.45,
  bodyYawDeg: 35,
  cameraDistanceM: 2.3,
  cameraHeightOffsetM: 0,
  verticalFovDeg: 24,
  lookDownM: 0.1,
  maxHeadYawDeg: 40,
};

export interface GazeGeometry {
  /** 体の正面を 0 とした、各目標への頭の目標角（度）。GazeController が使う。pitch の正は下。 */
  user: { headYawDeg: number; headPitchDeg: number };
  peer: { headYawDeg: number; headPitchDeg: number };
  /** away のそらす向きの符号（A は -1＝自分の外側、B は +1）。 */
  awaySign: 1 | -1;
}

/**
 * 1 体のステージの幾何。頭の角はすべて 0 で、away の向きは従来どおり（+1）。
 * GazeController にこれを渡しても、渡さないときと同じ値になる。
 */
export const ZERO_GAZE_GEOMETRY: GazeGeometry = {
  user: { headYawDeg: 0, headPitchDeg: 0 },
  peer: { headYawDeg: 0, headPitchDeg: 0 },
  awaySign: 1,
};

const RAD2DEG = 180 / Math.PI;
const DEG2RAD = Math.PI / 180;

const clampAbs = (value: number, limit: number) => Math.max(-limit, Math.min(limit, value));

/** A は -1（左）、B は +1（右）。 */
function side(ai_id: AiId): -1 | 1 {
  return ai_id === 'A' ? -1 : 1;
}

/** 立ち位置（眼の位置の x と z）と体の yaw（ラジアン）。 */
export function placeAvatar(layout: StageLayout, ai_id: AiId): { x: number; z: number; yawRad: number } {
  const s = side(ai_id);
  return { x: s * layout.halfSpacingM, z: 0, yawRad: -s * layout.bodyYawDeg * DEG2RAD };
}

/** カメラの位置と注視点。eyeMid は 2 体の眼の中点（世界座標）。 */
export function placeCamera(layout: StageLayout, eyeMid: Vec3): { position: Vec3; lookAt: Vec3 } {
  return {
    position: { x: eyeMid.x, y: eyeMid.y + layout.cameraHeightOffsetM, z: eyeMid.z + layout.cameraDistanceM },
    lookAt: { x: eyeMid.x, y: eyeMid.y - layout.lookDownM, z: eyeMid.z },
  };
}

/**
 * 各目標への頭の目標角（体の正面を 0 とする）。上限 maxHeadYawDeg を超えた分は眼（lookAt）が補う。
 * eyeHeightM は眼の高さ（2 体で同じ高さを仮定。カメラの高さは眼の高さ＋cameraHeightOffsetM）。
 */
export function gazeGeometry(layout: StageLayout, ai_id: AiId, eyeHeightM: number): GazeGeometry {
  const me = placeAvatar(layout, ai_id);
  const other = placeAvatar(layout, ai_id === 'A' ? 'B' : 'A');
  const bodyYawDeg = me.yawRad * RAD2DEG;
  // 世界の yaw（+Z が 0、+X が正）。モデルの yaw の正はモデルの左（+X）なので同じ向き。
  const worldYaw = (dx: number, dz: number) => Math.atan2(dx, dz) * RAD2DEG;
  const camera = placeCamera(layout, { x: 0, y: eyeHeightM, z: 0 });
  const toUser = { x: camera.position.x - me.x, y: camera.position.y - eyeHeightM, z: camera.position.z - me.z };
  const userYaw = clampAbs(worldYaw(toUser.x, toUser.z) - bodyYawDeg, layout.maxHeadYawDeg);
  const userPitch = Math.atan2(-toUser.y, Math.hypot(toUser.x, toUser.z)) * RAD2DEG;
  const peerYaw = clampAbs(worldYaw(other.x - me.x, other.z - me.z) - bodyYawDeg, layout.maxHeadYawDeg);
  return {
    user: { headYawDeg: userYaw, headPitchDeg: userPitch },
    peer: { headYawDeg: peerYaw, headPitchDeg: 0 },
    awaySign: ai_id === 'A' ? -1 : 1,
  };
}

/** URL の上書き（?layout_yaw=、?layout_spacing=（眼の間の全幅 m）、?fov=）。範囲外と数でない値は無視する。 */
export function parseLayoutQuery(search: string): Partial<StageLayout> {
  const params = new URLSearchParams(search);
  const read = (name: string, min: number, max: number): number | null => {
    const raw = params.get(name);
    if (raw === null || raw.trim() === '') return null;
    const value = Number(raw);
    return Number.isFinite(value) && value >= min && value <= max ? value : null;
  };
  const out: Partial<StageLayout> = {};
  const yaw = read('layout_yaw', 0, 80);
  if (yaw !== null) out.bodyYawDeg = yaw;
  const spacing = read('layout_spacing', 0.3, 3);
  if (spacing !== null) out.halfSpacingM = spacing / 2;
  const fov = read('fov', 8, 60);
  if (fov !== null) out.verticalFovDeg = fov;
  return out;
}

export function resolveLayout(overrides: Partial<StageLayout> | undefined): StageLayout {
  return { ...TWO_AI_LAYOUT, ...overrides };
}
