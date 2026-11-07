import { describe, expect, it } from 'vitest';
import {
  CLOSED_MOUTH,
  computeRms,
  MouthLayer,
  mouthOpenAmount,
  rmsToOpen,
  VolumeMouthSource,
  type MouthSource,
} from '../mouth';
import { PoseFrame } from '../pose';

const dbToRms = (db: number) => Math.pow(10, db / 20);

/** 一定間隔で音量を入れながら進める。 */
function drive(source: VolumeMouthSource, rms: number, ms: number, step = 16) {
  let open = 0;
  for (let t = 0; t < ms; t += step) {
    source.setLevel(rms);
    open = source.update(step).aa;
  }
  return open;
}

describe('computeRms', () => {
  it('空は 0、定数はその絶対値、振幅 1 の正弦波は約 0.707', () => {
    expect(computeRms([])).toBe(0);
    expect(computeRms(new Float32Array([0.5, -0.5, 0.5]))).toBeCloseTo(0.5, 6);
    const sine = Float32Array.from({ length: 1600 }, (_, i) => Math.sin((2 * Math.PI * i) / 160));
    expect(computeRms(sine)).toBeCloseTo(Math.SQRT1_2, 3);
  });
});

describe('rmsToOpen', () => {
  it('床以下で閉じ、天井以上で全開', () => {
    expect(rmsToOpen(0)).toBe(0);
    expect(rmsToOpen(dbToRms(-60))).toBe(0);
    expect(rmsToOpen(dbToRms(-46))).toBe(0);
    expect(rmsToOpen(dbToRms(-14))).toBe(1);
    expect(rmsToOpen(1)).toBe(1);
  });

  it('単調に増える', () => {
    let previous = -1;
    for (let db = -60; db <= 0; db += 1) {
      const open = rmsToOpen(dbToRms(db));
      expect(open).toBeGreaterThanOrEqual(previous);
      previous = open;
    }
  });

  it('不正な値でも NaN を返さない', () => {
    expect(rmsToOpen(Number.NaN)).toBe(0);
    expect(rmsToOpen(-1)).toBe(0);
  });
});

describe('VolumeMouthSource', () => {
  it('音量が続くと開き、maxOpen を超えない', () => {
    const source = new VolumeMouthSource({ maxOpen: 0.85 });
    expect(drive(source, 0.5, 400)).toBeCloseTo(0.85, 2);
  });

  it('立ち上がりは立ち下がりより速い', () => {
    const up = new VolumeMouthSource();
    const upOpen = drive(up, 0.5, 48);
    const down = new VolumeMouthSource();
    drive(down, 0.5, 400);
    const downOpen = drive(down, 0, 48);
    expect(upOpen / 0.85).toBeGreaterThan(1 - downOpen / 0.85);
  });

  it('音量が途絶えたら閉じる（再生が止まっても開いたままにならない）', () => {
    const source = new VolumeMouthSource({ staleAfterMs: 150 });
    drive(source, 0.5, 300);
    let open = 1;
    for (let t = 0; t < 800; t += 16) open = source.update(16).aa;
    expect(open).toBe(0);
  });

  it('描画が遅くても（dt が staleAfterMs より長くても）音量が来ていれば開く', () => {
    const source = new VolumeMouthSource({ staleAfterMs: 150 });
    expect(drive(source, 0.5, 2500, 250)).toBeGreaterThan(0.8);
    let open = 1;
    for (let i = 0; i < 6; i += 1) open = source.update(250).aa;
    expect(open).toBe(0);
  });

  it('closeNow は通常の立ち下がりより速く閉じる', () => {
    const normal = new VolumeMouthSource();
    drive(normal, 0.5, 300);
    const normalOpen = drive(normal, 0, 64);
    const stopped = new VolumeMouthSource();
    drive(stopped, 0.5, 300);
    stopped.closeNow();
    let open = 1;
    for (let t = 0; t < 64; t += 16) open = stopped.update(16).aa;
    expect(open).toBeLessThan(normalOpen / 2);
    for (let t = 0; t < 200; t += 16) open = stopped.update(16).aa;
    expect(open).toBe(0);
  });

  it('pushPcm は同じ RMS の setLevel と同じ', () => {
    const a = new VolumeMouthSource();
    const b = new VolumeMouthSource();
    const pcm = new Float32Array(320).fill(0.1);
    a.pushPcm(pcm);
    b.setLevel(0.1);
    expect(a.update(16).aa).toBeCloseTo(b.update(16).aa, 6);
  });

  it('dt が大きくても目標を越えない', () => {
    const source = new VolumeMouthSource({ maxOpen: 1 });
    source.setLevel(1);
    expect(source.update(100)).toMatchObject({ aa: expect.any(Number) });
    source.setLevel(1);
    expect(source.update(100).aa).toBeLessThanOrEqual(1);
  });
});

describe('MouthLayer', () => {
  it('source を差し替えられ、5母音すべてが frame に載る', () => {
    const custom: MouthSource = { update: () => ({ ...CLOSED_MOUTH, oh: 0.4, ih: 0.2 }) };
    const layer = new MouthLayer(new VolumeMouthSource());
    layer.source = custom;
    const frame = new PoseFrame();
    layer.update({ dtMs: 16, nowMs: 0 }, frame);
    expect(frame.expression('oh')).toBeCloseTo(0.4);
    expect(frame.expression('ih')).toBeCloseTo(0.2);
    expect(frame.expression('aa')).toBe(0);
    expect(mouthOpenAmount(layer.shape)).toBeCloseTo(0.4);
  });
});
