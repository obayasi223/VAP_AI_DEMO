import { describe, expect, it } from 'vitest';
import { IDLE_BONES, IdleLayer, RestPoseLayer, SmoothNoise } from '../idle';
import { boneSignForMeta, LayerStack, PoseFrame, type AvatarLayer } from '../pose';
import { seededRng } from '../util';

function headYawSeries(seed: number, seconds: number, dt = 20) {
  const layer = new IdleLayer(seededRng(seed));
  const frame = new PoseFrame();
  const series: number[] = [];
  for (let t = 0; t < seconds * 1000; t += dt) {
    frame.begin();
    layer.update({ dtMs: dt, nowMs: t }, frame);
    series.push(frame.bones.get('head')!.y);
  }
  return { series, frame, layer };
}

describe('SmoothNoise', () => {
  it('範囲内で、1ステップの変化が小さい', () => {
    const n = new SmoothNoise(seededRng(1), 1000);
    let previous = n.update(0);
    for (let t = 0; t < 60000; t += 16) {
      const v = n.update(16);
      expect(Math.abs(v)).toBeLessThanOrEqual(1);
      expect(Math.abs(v - previous)).toBeLessThan(0.15);
      previous = v;
    }
  });

  it('大きな dt でも止まらない', () => {
    const n = new SmoothNoise(seededRng(2), 100);
    expect(Math.abs(n.update(100000))).toBeLessThanOrEqual(1);
  });
});

describe('IdleLayer', () => {
  it('振幅が小さく、動いている', () => {
    const { series } = headYawSeries(3, 120);
    const deg = series.map((v) => (v * 180) / Math.PI);
    expect(Math.max(...deg.map(Math.abs))).toBeLessThan(2);
    expect(Math.max(...deg) - Math.min(...deg)).toBeGreaterThan(0.5);
  });

  it('周期を持たない（どのずらし幅でも自己相関が高くない）', () => {
    const { series } = headYawSeries(4, 240);
    const mean = series.reduce((a, b) => a + b, 0) / series.length;
    const x = series.map((v) => v - mean);
    const zero = x.reduce((a, b) => a + b * b, 0);
    let peak = 0;
    // 2 秒以上のずらし（滑らかさの近傍を除く）。
    for (let lag = 100; lag < 3000; lag += 5) {
      let sum = 0;
      for (let i = 0; i + lag < x.length; i += 1) sum += x[i]! * x[i + lag]!;
      peak = Math.max(peak, (sum * x.length) / (x.length - lag) / zero);
    }
    expect(peak).toBeLessThan(0.75);
  });

  it('吸気と紛らわしいボーン（肩、胸）を動かさない（計画 §4.7）', () => {
    const { frame } = headYawSeries(5, 5);
    expect([...frame.bones.keys()].sort()).toEqual([...IDLE_BONES].sort());
    for (const name of ['leftShoulder', 'rightShoulder', 'chest', 'upperChest']) {
      expect(frame.bones.has(name)).toBe(false);
    }
    // 体幹の前後の傾きも使わない。
    expect(frame.bones.get('spine')!.x).toBe(0);
  });

  it('intensity=0 で揺れが消える', () => {
    const layer = new IdleLayer(seededRng(6));
    layer.intensity = 0;
    const frame = new PoseFrame();
    for (let t = 0; t < 5000; t += 16) {
      frame.begin();
      layer.update({ dtMs: 16, nowMs: t }, frame);
    }
    expect(Math.abs(frame.bones.get('head')!.y)).toBeLessThan(1e-4);
  });
});

describe('RestPoseLayer', () => {
  it('腕を左右対称に下ろす', () => {
    const frame = new PoseFrame();
    new RestPoseLayer().update({ dtMs: 16, nowMs: 0 }, frame);
    expect(frame.bones.get('leftUpperArm')!.z).toBeCloseTo(-frame.bones.get('rightUpperArm')!.z, 8);
    expect(frame.bones.get('leftUpperArm')!.z).toBeLessThan(0);
  });
});

describe('PoseFrame と LayerStack', () => {
  const writer = (name: string, fn: (f: PoseFrame) => void): AvatarLayer => ({ name, update: (_c, f) => fn(f) });

  it('ボーンは層の間で加算する', () => {
    const stack = new LayerStack();
    stack.add(writer('a', (f) => f.addBone('head', 0.1, 0.2, 0)));
    stack.add(writer('b', (f) => f.addBone('head', 0.1, -0.1, 0.3)));
    const bone = stack.step({ dtMs: 16, nowMs: 0 }).bones.get('head')!;
    expect(bone.x).toBeCloseTo(0.2);
    expect(bone.y).toBeCloseTo(0.1);
    expect(bone.z).toBeCloseTo(0.3);
  });

  it('表情は加算して 0〜1 に収める', () => {
    const f = new PoseFrame();
    f.addExpression('aa', 0.7);
    f.addExpression('aa', 0.7);
    expect(f.expression('aa')).toBe(1);
    f.begin();
    f.addExpression('aa', -1);
    expect(f.expression('aa')).toBe(0);
  });

  it('書かなくなった層の値は次のフレームで 0 に戻る（固まらない）', () => {
    const stack = new LayerStack();
    stack.add(writer('a', (f) => {
      f.addBone('head', 1, 1, 1);
      f.addExpression('blink', 1);
    }));
    stack.step({ dtMs: 16, nowMs: 0 });
    stack.remove('a');
    const frame = stack.step({ dtMs: 16, nowMs: 16 });
    expect(frame.bones.get('head')).toEqual({ x: 0, y: 0, z: 0 });
    expect(frame.expression('blink')).toBe(0);
    expect(frame.expressions.has('blink')).toBe(true);
  });

  it('後から before で層を差し込める（H2 の吸気用）', () => {
    const stack = new LayerStack();
    const order: string[] = [];
    const rec = (name: string): AvatarLayer => ({ name, update: () => order.push(name) });
    stack.add(rec('idle'));
    stack.add(rec('blink'));
    stack.add(rec('breath'), { before: 'blink' });
    stack.step({ dtMs: 16, nowMs: 0 });
    expect(order).toEqual(['idle', 'breath', 'blink']);
    expect(() => stack.add(rec('idle'))).toThrow();
    expect(() => stack.add(rec('x'), { before: 'none' })).toThrow();
  });
});

describe('boneSignForMeta', () => {
  it('VRM 0.x は x と z が逆で y は同じ、VRM 1.0 はそのまま', () => {
    expect(boneSignForMeta('0')).toEqual({ x: -1, y: 1, z: -1 });
    expect(boneSignForMeta('1')).toEqual({ x: 1, y: 1, z: 1 });
  });
});
