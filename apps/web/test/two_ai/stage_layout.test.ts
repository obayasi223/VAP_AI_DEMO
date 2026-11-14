import { describe, expect, it } from 'vitest';
import {
  gazeGeometry,
  parseLayoutQuery,
  placeAvatar,
  placeCamera,
  resolveLayout,
  TWO_AI_LAYOUT,
  ZERO_GAZE_GEOMETRY,
} from '../../src/avatar/stage_layout';
import { GazeController } from '../../src/avatar/gaze';
import { seededRng } from '../../src/avatar/util';

describe('stage_layout（03 §2.2）', () => {
  it('配置は左右対称で、A は -x で +yaw、B は +x で -yaw', () => {
    const a = placeAvatar(TWO_AI_LAYOUT, 'A');
    const b = placeAvatar(TWO_AI_LAYOUT, 'B');
    expect(a.x).toBeCloseTo(-TWO_AI_LAYOUT.halfSpacingM);
    expect(b.x).toBeCloseTo(TWO_AI_LAYOUT.halfSpacingM);
    expect(a.z).toBe(b.z);
    expect(a.yawRad).toBeGreaterThan(0);
    expect(b.yawRad).toBeLessThan(0);
    expect(a.yawRad).toBeCloseTo(-b.yawRad);
    expect(a.yawRad).toBeCloseTo((35 * Math.PI) / 180);
  });

  it('カメラは眼の中点の前方、注視点は lookDownM だけ下', () => {
    const c = placeCamera(TWO_AI_LAYOUT, { x: 0, y: 1.5, z: 0 });
    expect(c.position).toEqual({ x: 0, y: 1.5, z: 2.3 });
    expect(c.lookAt.y).toBeCloseTo(1.4);
  });

  it('peer の角は上限を超えず、相手の側（A は +、B は −）', () => {
    const a = gazeGeometry(TWO_AI_LAYOUT, 'A', 1.5);
    const b = gazeGeometry(TWO_AI_LAYOUT, 'B', 1.5);
    expect(a.peer.headYawDeg).toBeGreaterThan(0);
    expect(b.peer.headYawDeg).toBeLessThan(0);
    expect(Math.abs(a.peer.headYawDeg)).toBeLessThanOrEqual(TWO_AI_LAYOUT.maxHeadYawDeg);
    // 体の向き 35 度では相手は正面から 55 度なので、上限 40 で切られる
    expect(a.peer.headYawDeg).toBeCloseTo(40);
    const loose = gazeGeometry(resolveLayout({ maxHeadYawDeg: 80 }), 'A', 1.5);
    expect(loose.peer.headYawDeg).toBeCloseTo(55);
  });

  it('user の角は体の向きの逆符号で、左右対称', () => {
    const a = gazeGeometry(TWO_AI_LAYOUT, 'A', 1.5);
    const b = gazeGeometry(TWO_AI_LAYOUT, 'B', 1.5);
    expect(a.user.headYawDeg).toBeLessThan(0);
    expect(b.user.headYawDeg).toBeGreaterThan(0);
    expect(a.user.headYawDeg).toBeCloseTo(-b.user.headYawDeg);
    // 利用者はカメラ（中点の前方 2.3m）。A から見て世界の yaw は atan(0.45/2.3)
    const expected = (Math.atan2(0.45, 2.3) * 180) / Math.PI - 35;
    expect(a.user.headYawDeg).toBeCloseTo(expected);
    expect(a.user.headPitchDeg).toBeCloseTo(0);
    const tight = gazeGeometry(resolveLayout({ bodyYawDeg: 70, maxHeadYawDeg: 30 }), 'A', 1.5);
    expect(tight.user.headYawDeg).toBeCloseTo(-30);
  });

  it('カメラが眼より低ければ user の頭は下を向く（pitch の正が下）', () => {
    const g = gazeGeometry(resolveLayout({ cameraHeightOffsetM: -0.2 }), 'A', 1.5);
    expect(g.user.headPitchDeg).toBeGreaterThan(0);
  });

  it('away は外側（A は −、B は +）', () => {
    expect(gazeGeometry(TWO_AI_LAYOUT, 'A', 1.5).awaySign).toBe(-1);
    expect(gazeGeometry(TWO_AI_LAYOUT, 'B', 1.5).awaySign).toBe(1);
  });

  it('1 体の幾何は頭の角がすべて 0 で、渡しても渡さなくても視線の値が同じ', () => {
    expect(ZERO_GAZE_GEOMETRY.user).toEqual({ headYawDeg: 0, headPitchDeg: 0 });
    expect(ZERO_GAZE_GEOMETRY.peer).toEqual({ headYawDeg: 0, headPitchDeg: 0 });
    const plain = new GazeController(seededRng(9));
    const zero = new GazeController(seededRng(9), {}, ZERO_GAZE_GEOMETRY);
    for (const target of ['away', 'user', 'away', 'user'] as const) {
      plain.setTarget(target);
      zero.setTarget(target);
      for (let t = 0; t < 600; t += 16) expect(zero.update(16)).toEqual(plain.update(16));
    }
  });

  it('URL の上書きは範囲内だけ', () => {
    expect(parseLayoutQuery('?layout_yaw=30&layout_spacing=1.2&fov=28')).toEqual({ bodyYawDeg: 30, halfSpacingM: 0.6, verticalFovDeg: 28 });
    expect(parseLayoutQuery('?layout_yaw=abc&layout_spacing=99&fov=')).toEqual({});
    expect(parseLayoutQuery('')).toEqual({});
  });
});
