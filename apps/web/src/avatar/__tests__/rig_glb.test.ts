import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { eyeRotation, mapEyeAngle, createGlbRig } from '../rig_glb';
import type { GlbModelSpec } from '../avatar_models';
import { PoseFrame } from '../pose';
import { DEG2RAD, RAD2DEG } from '../util';

const RANGE = { inputMaxDeg: 90, outerDeg: 12, innerDeg: 8, upDeg: 10, downDeg: 10 };

/** Biped 風の骨（軸がワールドに揃っていない）。肩は首の子。 */
function makeRig(spec?: Partial<GlbModelSpec>) {
  const root = new THREE.Group();
  const add = (name: string, parent: THREE.Object3D, position: [number, number, number], quat?: THREE.Quaternion) => {
    const bone = new THREE.Bone();
    bone.name = name;
    bone.position.set(...position);
    if (quat) bone.quaternion.copy(quat);
    parent.add(bone);
    return bone;
  };
  // ワールドの軸と違う軸を持つ骨。
  const weird = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.4, -1.2, 0.8));
  const chest = add('chest', root, [0, 1, 0], weird);
  const neck = add('neck', chest, [0, 0.3, 0].map((v) => v) as [number, number, number]);
  const head = add('head', neck, [0, 0.1, 0]);
  const lEye = add('leftEye', head, [0.03, 0.1, 0.1]);
  const rEye = add('rightEye', head, [-0.03, 0.1, 0.1]);
  const shoulder = add('leftShoulder', neck, [0.1, -0.05, 0]);
  const arm = add('leftUpperArm', shoulder, [0.2, -0.2, 0]);
  add('leftLowerArm', arm, [0.2, -0.2, 0]);
  void lEye;
  void rEye;
  const glb: GlbModelSpec = {
    kind: 'glb',
    bones: { upperChest: 'chest', neck: 'neck', head: 'head', leftShoulder: 'leftShoulder', leftUpperArm: 'leftUpperArm', leftLowerArm: 'leftLowerArm', leftEye: 'leftEye', rightEye: 'rightEye' },
    expressions: {},
    eyeRange: RANGE,
    ...spec,
  };
  root.updateMatrixWorld(true);
  return { root, chest, neck, head, shoulder, glb };
}

const camera = new THREE.PerspectiveCamera();
camera.position.set(0, 1.6, 2);

function worldDir(node: THREE.Object3D): THREE.Vector3 {
  node.updateWorldMatrix(true, false);
  return node.getWorldDirection(new THREE.Vector3());
}

describe('mapEyeAngle / eyeRotation', () => {
  it('VRM の range map と同じ写像（度）', () => {
    expect(mapEyeAngle(45, 90, 12)).toBeCloseTo(6);
    expect(mapEyeAngle(-180, 90, 12)).toBeCloseTo(-12);
  });

  it('左眼の外（モデルの左）は outer、内は inner', () => {
    expect(eyeRotation('left', 45, 0, RANGE).y).toBeCloseTo(6);
    expect(eyeRotation('left', -45, 0, RANGE).y).toBeCloseTo(-4);
    expect(eyeRotation('right', 45, 0, RANGE).y).toBeCloseTo(4);
  });
});

describe('createGlbRig の正規化（骨の軸が違っても層の向きが同じ）', () => {
  it('頭の首振り（y の正）でモデルの左（+X）へ顔が向く', () => {
    const { root, head, glb } = makeRig();
    const rig = createGlbRig(root, glb);
    const before = worldDir(head);
    const frame = new PoseFrame();
    frame.addBone('head', 0, 0.5, 0);
    rig.applyFrame(frame, camera, 16);
    root.updateMatrixWorld(true);
    const rotation = worldDir(head);
    const expected = before.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), 0.5);
    expect(rotation.distanceTo(expected)).toBeLessThan(1e-3);
  });

  it('鎖骨の counterParent: 首を回しても肩の向きが変わらない', () => {
    const { root, neck, shoulder, glb } = makeRig({ counterParent: { leftShoulder: 'neck' } });
    const rig = createGlbRig(root, glb);
    const shoulderWorld = shoulder.getWorldQuaternion(new THREE.Quaternion()).clone();
    const neckWorld = neck.getWorldQuaternion(new THREE.Quaternion()).clone();
    const frame = new PoseFrame();
    frame.addBone('neck', 0.6, 0.3, -0.2);
    rig.applyFrame(frame, camera, 16);
    root.updateMatrixWorld(true);
    expect(neck.getWorldQuaternion(new THREE.Quaternion()).angleTo(neckWorld)).toBeGreaterThan(0.1);
    expect(shoulder.getWorldQuaternion(new THREE.Quaternion()).angleTo(shoulderWorld)).toBeLessThan(1e-3);
  });

  it('上腕の T ポーズ補正: rest の z=-72 度で腕がほぼ水平から 72 度下を向く', () => {
    const { root, glb } = makeRig({ tPoseArms: true });
    const rig = createGlbRig(root, glb);
    const frame = new PoseFrame();
    frame.addBone('leftUpperArm', 0, 0, -72 * DEG2RAD);
    rig.applyFrame(frame, camera, 16);
    root.updateMatrixWorld(true);
    const arm = rig.rawBone('leftUpperArm')!;
    const lower = rig.rawBone('leftLowerArm')!;
    const dir = lower.getWorldPosition(new THREE.Vector3()).sub(arm.getWorldPosition(new THREE.Vector3())).normalize();
    expect(dir.y).toBeCloseTo(-Math.sin(72 * DEG2RAD), 2);
    expect(dir.x).toBeCloseTo(Math.cos(72 * DEG2RAD), 2);
  });

  it('視線のそらしを眼へ（yaw の正でモデルの左、入力を range map で縮める）', () => {
    const { root, glb } = makeRig();
    const rig = createGlbRig(root, glb);
    const frame = new PoseFrame();
    frame.eye.userWeight = 0;
    frame.eye.yawDeg = 45;
    rig.applyFrame(frame, camera, 16);
    expect(rig.eyeInput().yawDeg).toBeCloseTo(45);
    expect(rig.readEye('left').yawDeg).toBeCloseTo(6);
    expect(rig.readEye('right').yawDeg).toBeCloseTo(4);
    void RAD2DEG;
  });

  it('首と頭の対応がなければ作らない', () => {
    const root = new THREE.Group();
    expect(() => createGlbRig(root, { kind: 'glb', bones: {}, expressions: {}, eyeRange: RANGE })).toThrow(/首か頭/);
  });
});
