import { describe, expect, it } from 'vitest';
import { InitiativeNegotiation } from '@llm-vap/contracts';
import {
  BREATH_CHEST_EXPRESSION,
  BreathLayer,
  DEFAULT_BREATH,
  DEFAULT_INHALE_MS,
  HOLD_MAX_MS,
  INHALE_MS_RANGE,
  inhaleCurve,
  mergeBreathParams,
  normalBreathWave,
  prepValues,
  relaxCurve,
  releaseSpec,
  releaseTotalMs,
  speechExhaleCurve,
  type BreathPhaseEvent,
} from '../breath';
import { chestDisplacement, chestMembership, computeChestMorph, type ChestFrame, type SkinnedVertices } from '../breath_morph';
import { IdleLayer } from '../idle';
import { PoseFrame } from '../pose';
import { seededRng } from '../util';

const DT = 16;

function makeLayer(options: { speechOpen?: () => number; onPhase?: (e: BreathPhaseEvent) => void } = {}) {
  const idleScale = { value: 1 };
  const layer = new BreathLayer(seededRng(1), {
    ...options,
    setIdleScale: (s) => {
      idleScale.value = s;
    },
  });
  const frame = new PoseFrame();
  let now = 1000;
  const step = (ms: number) => {
    const steps = Math.round(ms / DT);
    for (let i = 0; i < steps; i += 1) {
      now += DT;
      frame.begin();
      layer.update({ dtMs: DT, nowMs: now }, frame);
    }
  };
  return { layer, frame, step, idleScale, now: () => now };
}

describe('包絡', () => {
  it('吸気の曲線は 0 から 1 へ単調に上がり、始まりと終わりの速さが小さい', () => {
    let prev = 0;
    for (let i = 0; i <= 100; i += 1) {
      const v = inhaleCurve(i / 100);
      expect(v).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = v;
    }
    expect(inhaleCurve(0)).toBe(0);
    expect(inhaleCurve(1)).toBeCloseTo(1, 6);
    // 速さの山が前寄り（速く吸い始める）。
    expect(inhaleCurve(0.5)).toBeGreaterThan(0.75);
    expect(inhaleCurve(0.01)).toBeLessThan(0.01);
    expect(inhaleCurve(1) - inhaleCurve(0.98)).toBeLessThan(0.001);
  });

  it('脱力の曲線は 1 から 0 へ、発話の呼気も 1 から 0 へ', () => {
    expect(relaxCurve(0)).toBe(1);
    expect(relaxCurve(1)).toBe(0);
    expect(speechExhaleCurve(0)).toBeCloseTo(1, 6);
    expect(speechExhaleCurve(1)).toBeCloseTo(0, 6);
    expect(speechExhaleCurve(0.5)).toBeCloseTo(0.5, 6);
  });

  it('部位の時間がずれる: 口が先に開き、肩は遅れて頂点に着く', () => {
    const prep = DEFAULT_BREATH.prep;
    const early = prepValues(100, 450, prep);
    expect(early.mouth).toBeGreaterThan(early.chest);
    expect(early.chest).toBeGreaterThan(early.shoulder);
    const peak = prepValues(450, 450, prep);
    expect(peak.chest).toBeGreaterThan(0.99);
    expect(peak.shoulder).toBeLessThan(1);
    expect(prepValues(520, 450, prep).shoulder).toBeCloseTo(1, 6);
  });

  it('保持中は凍らずに準備姿勢へ沈む（胸は頂点の holdChestLevel へ）', () => {
    const prep = DEFAULT_BREATH.prep;
    const v = prepValues(450 + 3000, 450, prep);
    expect(v.chest).toBeCloseTo(prep.holdChestLevel, 2);
    expect(v.mouth).toBeCloseTo(prep.holdMouthLevel, 2);
    expect(prepValues(700, 450, prep).chest).toBeLessThan(1);
  });

  it('通常呼吸の波は 0〜1 で、吸気の割合の位置で頂点', () => {
    expect(normalBreathWave(0, 0.4)).toBeCloseTo(0, 6);
    expect(normalBreathWave(0.4, 0.4)).toBeCloseTo(1, 6);
    expect(normalBreathWave(0.999, 0.4)).toBeLessThan(0.01);
  });
});

describe('phase の遷移', () => {
  const P = DEFAULT_BREATH.prep;
  const deferredTotal = releaseTotalMs(releaseSpec('deferred', P));

  it('既定の吸気は 700ms、保持の安全上限は 1800ms（暫定値）', () => {
    expect(DEFAULT_INHALE_MS).toBe(700);
    expect(HOLD_MAX_MS).toBe(1800);
    expect(P.holdMaxMs).toBe(HOLD_MAX_MS);
  });

  it('idle → inhale → hold → 保持の上限で release（hold_timeout、deferred と同じ戻り方）→ idle', () => {
    const events: BreathPhaseEvent[] = [];
    const { layer, step } = makeLayer({ onPhase: (e) => events.push(e) });
    expect(layer.phase()).toBe('idle');
    layer.startInhale({ cue_id: 'c1', duration_ms: DEFAULT_INHALE_MS });
    expect(layer.phase()).toBe('inhale');
    step(DEFAULT_INHALE_MS - 50);
    expect(layer.phase()).toBe('inhale');
    step(100);
    expect(layer.phase()).toBe('hold');
    step(HOLD_MAX_MS - 150);
    expect(layer.phase()).toBe('hold');
    step(200);
    expect(layer.phase()).toBe('release');
    expect(layer.telemetry()).toMatchObject({ lastReleaseCause: 'hold_timeout', releaseKind: 'deferred' });
    step(deferredTotal + 50);
    expect(layer.phase()).toBe('idle');
    expect(events.map((e) => e.phase)).toEqual(['inhale', 'hold', 'release', 'idle']);
    expect(events[0]).toMatchObject({ cueId: 'c1', kind: 'prep' });
    expect(events[2]!.cause).toBe('hold_timeout');
  });

  it('吸気の最初のフレームで onPhase(inhale) が rAF 時刻つきで来る', () => {
    const events: BreathPhaseEvent[] = [];
    const { layer, step, now } = makeLayer({ onPhase: (e) => events.push(e) });
    step(100);
    layer.startInhale({ cue_id: 'c1', duration_ms: 450 });
    expect(events).toHaveLength(0);
    step(DT);
    expect(events[0]).toMatchObject({ phase: 'inhale', nowMs: now() });
    expect(layer.telemetry().prep.mouth).toBeGreaterThan(0);
  });

  it('二重の startInhale は無視する（吸気中・保持中、同じ cue_id でも別でも）。戻り値で受け付けたかを返す', () => {
    const { layer, step } = makeLayer();
    expect(layer.startInhale({ cue_id: 'c1', duration_ms: 450 })).toBe(true);
    expect(layer.startInhale({ cue_id: 'c2', duration_ms: 900 })).toBe(false);
    step(200);
    expect(layer.startInhale({ cue_id: 'c1', duration_ms: 450 })).toBe(false);
    expect(layer.startInhale({ cue_id: 'c3', duration_ms: 300 })).toBe(false);
    expect(layer.telemetry()).toMatchObject({ cueId: 'c1', inhaleMs: 450, ignoredStarts: 3 });
    step(400);
    expect(layer.phase()).toBe('hold');
    expect(layer.startInhale({ cue_id: 'c4', duration_ms: 450 })).toBe(false);
    expect(layer.telemetry().ignoredStarts).toBe(4);
    layer.release('withdrawn');
    step(3000);
    expect(layer.phase()).toBe('idle');
    expect(layer.startInhale({ cue_id: 'c6', duration_ms: 450 })).toBe(true);
    step(DT);
    expect(layer.telemetry().cueId).toBe('c6');
  });

  it.each(['deferred', 'withdrawn'] as const)('%s の脱力の途中の吸気は今の姿勢から滑らかに受ける（不連続にしない）', (reason) => {
    const { layer, step } = makeLayer();
    layer.startInhale({ cue_id: 'c1', duration_ms: 700 });
    step(900);
    layer.release(reason);
    step(200);
    expect(layer.phase()).toBe('release');
    const before = layer.telemetry().prep;
    expect(before.chest).toBeGreaterThan(0.1);
    expect(layer.startInhale({ cue_id: 'c2', duration_ms: 700 })).toBe(true);
    step(DT);
    expect(layer.telemetry()).toMatchObject({ phase: 'inhale', cueId: 'c2', kind: 'prep', ignoredStarts: 0 });
    // 姿勢が飛ばない（1 フレームで 0 へ戻らない）。
    expect(Math.abs(layer.telemetry().prep.chest - before.chest)).toBeLessThan(0.05);
    step(900);
    expect(layer.phase()).toBe('hold');
    expect(layer.telemetry().prep.chest).toBeGreaterThan(0.9);
  });

  it('話している間の発話の戻りでは吸気を受けない。話し終えた後の戻り（口が閉じている）では受ける', () => {
    let speechOpen = 0.5;
    const { layer, step } = makeLayer({ speechOpen: () => speechOpen });
    layer.startInhale({ cue_id: 'c1', duration_ms: 700 });
    step(900);
    layer.release('speech_started');
    step(100);
    expect(layer.telemetry().releaseKind).toBe('speech');
    expect(layer.startInhale({ cue_id: 'c2', duration_ms: 700 })).toBe(false);
    expect(layer.phase()).toBe('release');
    speechOpen = 0;
    step(100);
    expect(layer.phase()).toBe('release');
    expect(layer.startInhale({ cue_id: 'c3', duration_ms: 700 })).toBe(true);
    step(DT);
    expect(layer.telemetry()).toMatchObject({ phase: 'inhale', cueId: 'c3' });
  });

  it('release は動かしたかを返す（idle、同じ戻りの途中は false）', () => {
    const { layer, step } = makeLayer();
    expect(layer.release('withdrawn')).toBe(false);
    layer.startInhale({ cue_id: 'c1', duration_ms: 450 });
    expect(layer.release('withdrawn')).toBe(false); // まだ描いていない吸気の取り消し
    layer.startInhale({ cue_id: 'c2', duration_ms: 450 });
    step(600);
    expect(layer.release('deferred')).toBe(true);
    step(DT);
    expect(layer.release('deferred')).toBe(false);
    expect(layer.release('withdrawn')).toBe(true);
  });

  it('方策の inhale_ms の範囲はアバターの受け付ける範囲と同じ（丸めで描く長さと orchestrator の時計がずれない）', () => {
    expect(InitiativeNegotiation.shape.inhale_ms.safeParse(INHALE_MS_RANGE[0]).success).toBe(true);
    expect(InitiativeNegotiation.shape.inhale_ms.safeParse(INHALE_MS_RANGE[1]).success).toBe(true);
    expect(InitiativeNegotiation.shape.inhale_ms.safeParse(INHALE_MS_RANGE[0] - 1).success).toBe(false);
    expect(InitiativeNegotiation.shape.inhale_ms.safeParse(INHALE_MS_RANGE[1] + 1).success).toBe(false);
  });

  it('cue.duration_ms は範囲に丸め、吸気の長さに使う', () => {
    const { layer, step } = makeLayer();
    layer.startInhale({ cue_id: 'c', duration_ms: 50 });
    step(DT);
    expect(layer.telemetry().inhaleMs).toBe(200);
    const b = makeLayer();
    b.layer.startInhale({ cue_id: 'c', duration_ms: 800 });
    b.step(600);
    expect(b.layer.phase()).toBe('inhale');
    b.step(250);
    expect(b.layer.phase()).toBe('hold');
  });

  /** 保持（息を止めた準備姿勢）まで進めて、理由を渡し、t ms ごとの値を返す。 */
  function runRelease(reason: 'speech_started' | 'deferred' | 'withdrawn', sampleMs: number[]) {
    const env = makeLayer();
    env.layer.startInhale({ cue_id: 'c', duration_ms: 700 });
    env.step(900);
    const atHold = env.layer.telemetry().prep;
    env.layer.release(reason);
    let t = 0;
    const samples = sampleMs.map((ms) => {
      env.step(ms - t);
      t = ms;
      return { ...env.layer.telemetry(), idleScale: env.idleScale.value };
    });
    return { atHold, samples, env };
  }

  it('成功（speech_started）: 口はすぐ口形へ譲り、胸は話しながら長く戻る', () => {
    const { atHold, samples } = runRelease('speech_started', [P.speechMouthYieldMs + 2 * DT, 700, P.speechExhaleMs + 100]);
    expect(atHold.mouth).toBeGreaterThan(0.6);
    expect(samples[0]).toMatchObject({ phase: 'release', lastReleaseCause: 'speech_started', releaseKind: 'speech' });
    expect(samples[0]!.prep.mouth).toBe(0);
    expect(samples[0]!.prep.chest).toBeGreaterThan(0.8);
    expect(samples[1]!.prep.shoulder).toBe(0);
    expect(samples[1]!.prep.chest).toBeGreaterThan(0.4);
    expect(samples[2]!.phase).toBe('idle');
  });

  it('deferred: 声を出さずに吐き、唇・胸・頭の準備を少し残してからゆっくり消える', () => {
    const { atHold, samples } = runRelease('deferred', [DT, P.deferredExhaleMs + DT, P.deferredExhaleMs + P.deferredLingerMs / 2, deferredTotal + 100]);
    expect(Math.abs(samples[0]!.prep.chest - atHold.chest)).toBeLessThan(0.03);
    const residual = samples[1]!.prep;
    expect(samples[1]!.phase).toBe('release');
    expect(residual.chest).toBeCloseTo(atHold.chest * P.deferredChestResidual, 1);
    expect(residual.mouth).toBeGreaterThan(0.2);
    expect(residual.head).toBeGreaterThan(0.2);
    expect(residual.shoulder).toBe(0);
    expect(samples[2]!.prep.mouth).toBeLessThan(residual.mouth);
    expect(samples[2]!.prep.mouth).toBeGreaterThan(0);
    expect(samples[3]!.phase).toBe('idle');
  });

  it('withdrawn: 準備を残さず、口を早く閉じ、deferred より早く戻る', () => {
    const w = runRelease('withdrawn', [P.withdrawnMouthCloseMs + 3 * DT, P.withdrawnExhaleMs + 50]);
    const d = runRelease('deferred', [P.withdrawnMouthCloseMs + 3 * DT, P.withdrawnExhaleMs + 50]);
    expect(w.samples[0]!.prep.mouth).toBe(0);
    expect(d.samples[0]!.prep.mouth).toBeGreaterThan(0.2);
    expect(w.samples[1]!.phase).toBe('idle');
    expect(d.samples[1]!.phase).toBe('release');
    expect(w.samples[1]!.prep.chest).toBe(0);
    expect(d.samples[1]!.prep.chest).toBeGreaterThan(0.1);
  });

  it.each(['deferred', 'withdrawn'] as const)('release(%s) の後は待機の揺れと通常呼吸を少し後に戻す', (reason) => {
    const { env } = runRelease(reason, [10]);
    env.step(releaseTotalMs(releaseSpec(reason, P)) + 50);
    expect(env.layer.phase()).toBe('idle');
    expect(env.idleScale.value).toBeLessThan(0.5);
    env.step(P.postSuppressMs + 4000);
    expect(env.idleScale.value).toBeGreaterThan(0.95);
    expect(env.layer.telemetry().normalGain).toBeGreaterThan(0.95);
  });

  it('deferred の途中の withdrawn は残した準備を捨てて戻る', () => {
    const { env } = runRelease('deferred', [P.deferredExhaleMs + DT]);
    expect(env.layer.telemetry().prep.mouth).toBeGreaterThan(0.2);
    env.layer.release('withdrawn');
    env.step(P.withdrawnExhaleMs + 50);
    expect(env.layer.phase()).toBe('idle');
    expect(env.layer.telemetry().lastReleaseCause).toBe('withdrawn');
  });

  it('保持の上限による自動の引き下がりの途中でも speech_started で発話の戻り方へ切り替わる', () => {
    const { layer, step } = makeLayer();
    layer.startInhale({ cue_id: 'c', duration_ms: 450 });
    step(450 + HOLD_MAX_MS + 50);
    expect(layer.phase()).toBe('release');
    layer.release('speech_started');
    step(DT * 2);
    expect(layer.telemetry()).toMatchObject({ lastReleaseCause: 'speech_started', releaseKind: 'speech' });
  });

  it('吸気の途中の release は今の値から戻る（飛ばない）', () => {
    const { layer, step } = makeLayer();
    layer.startInhale({ cue_id: 'c', duration_ms: 450 });
    step(160);
    const mid = layer.telemetry().prep.chest;
    expect(mid).toBeGreaterThan(0.2);
    layer.release('withdrawn');
    step(DT);
    expect(Math.abs(layer.telemetry().prep.chest - mid)).toBeLessThan(0.05);
    expect(layer.phase()).toBe('release');
  });

  it('idle での release は何もしない。描く前の release は吸気を取り消す', () => {
    const { layer, step } = makeLayer();
    layer.release('deferred');
    expect(layer.phase()).toBe('idle');
    layer.startInhale({ cue_id: 'c', duration_ms: 450 });
    layer.release('withdrawn');
    step(100);
    expect(layer.phase()).toBe('idle');
    expect(layer.telemetry().prep.chest).toBe(0);
  });
});

describe('prepareShort（deferred の後に許可が出たときの短い準備動作）', () => {
  const P = DEFAULT_BREATH.prep;

  it('deferred の途中で受け、再吸気せず残した準備から短い準備へ（口は開き、胸は小さく足すだけ）→ 発話', () => {
    const events: BreathPhaseEvent[] = [];
    const { layer, step } = makeLayer({ onPhase: (e) => events.push(e) });
    layer.startInhale({ cue_id: 'c', duration_ms: 700 });
    step(900);
    const peakChest = layer.telemetry().prep.chest;
    layer.release('deferred');
    step(P.deferredExhaleMs + 200);
    const residual = layer.telemetry().prep;
    layer.prepareShort();
    step(DT);
    expect(layer.phase()).toBe('inhale');
    expect(layer.telemetry().kind).toBe('short');
    // 不連続にしない。
    expect(Math.abs(layer.telemetry().prep.chest - residual.chest)).toBeLessThan(0.05);
    step(P.shortPrepMs + 50);
    const ready = layer.telemetry();
    expect(ready.phase).toBe('hold');
    expect(ready.prep.mouth).toBeGreaterThan(0.7);
    // 胸は準備吸気の頂点より明らかに小さい（再吸気しない）。
    expect(ready.prep.chest).toBeLessThan(peakChest * 0.6);
    expect(ready.prep.chest).toBeGreaterThanOrEqual(residual.chest - 1e-9);
    layer.release('speech_started');
    step(P.speechMouthYieldMs + 2 * DT);
    expect(layer.telemetry()).toMatchObject({ releaseKind: 'speech' });
    expect(layer.telemetry().prep.mouth).toBe(0);
    expect(events.filter((e) => e.phase === 'inhale').map((e) => e.kind)).toEqual(['prep', 'short']);
    // 同じ候補の cue_id を引き継ぐ。
    expect(events.at(-1)!.cueId).toBe('c');
  });

  it('idle でも受ける。吸気中・保持中・発話の戻り・withdrawn の戻りでは無視する', () => {
    const { layer, step } = makeLayer();
    layer.prepareShort();
    step(DT);
    expect(layer.telemetry().kind).toBe('short');
    step(P.shortPrepMs + HOLD_MAX_MS + 3000 + P.deferredLingerMs);
    expect(layer.phase()).toBe('idle');
    layer.startInhale({ cue_id: 'x', duration_ms: 450 });
    step(100);
    layer.prepareShort();
    step(500);
    layer.prepareShort();
    expect(layer.telemetry().ignoredStarts).toBe(2);
    layer.release('withdrawn');
    step(DT);
    layer.prepareShort();
    expect(layer.telemetry().ignoredStarts).toBe(3);
    expect(layer.telemetry().kind).toBe('prep');
  });
});

describe('フレームへの出力', () => {
  it('保持中: 胸郭モーフ、肩の挙上（上腕で逆補正）、頭がわずかに上、口がわずかに開く', () => {
    const { layer, step, frame } = makeLayer();
    layer.startInhale({ cue_id: 'c', duration_ms: 450 });
    step(600);
    const prep = DEFAULT_BREATH.prep;
    expect(frame.expression(BREATH_CHEST_EXPRESSION)).toBeGreaterThan(0.7);
    const ls = frame.bones.get('leftShoulder')!;
    const rs = frame.bones.get('rightShoulder')!;
    expect(ls.z).toBeGreaterThan(0);
    expect(rs.z).toBeCloseTo(-ls.z, 9);
    expect(frame.bones.get('leftUpperArm')!.z).toBeCloseTo(-ls.z * prep.armCompensation, 9);
    expect(frame.bones.get('rightUpperArm')!.z).toBeCloseTo(ls.z * prep.armCompensation, 9);
    expect(frame.bones.get('head')!.x).toBeLessThan(0);
    expect(frame.bones.get('upperChest')!.x).toBeLessThan(0);
    expect(frame.bones.get('neck')!.x).toBeGreaterThan(0);
    // 上胸の反りを上腕で戻す（手が前後に振れない）。
    expect(frame.bones.get('leftUpperArm')!.x).toBeCloseTo(-frame.bones.get('upperChest')!.x * prep.armPitchCompensation, 9);
    expect(frame.bones.get('rightUpperArm')!.x).toBeCloseTo(-frame.bones.get('upperChest')!.x * prep.armPitchCompensation, 9);
    expect(frame.expression('aa')).toBeGreaterThan(0.05);
    expect(frame.expression('aa')).toBeLessThanOrEqual(prep.mouthOpen);
    expect(frame.expression('browUp')).toBeGreaterThan(0);
    // 通常呼吸は抑えている。
    expect(layer.telemetry().normalGain).toBeLessThan(0.1);
  });

  it('待機中の通常呼吸は胸郭モーフだけで、肩を動かさない（既定）', () => {
    const { step, frame } = makeLayer();
    let maxChest = 0;
    for (let i = 0; i < 300; i += 1) {
      step(DT);
      maxChest = Math.max(maxChest, frame.expression(BREATH_CHEST_EXPRESSION));
      expect(frame.bones.get('leftShoulder')?.z ?? 0).toBe(0);
      expect(frame.expression('aa')).toBe(0);
    }
    expect(maxChest).toBeGreaterThan(DEFAULT_BREATH.normal.depth * 0.9);
    expect(maxChest).toBeLessThanOrEqual(DEFAULT_BREATH.normal.depth + 1e-9);
  });

  it('発話の口形が開いていれば口の準備は書かない', () => {
    let open = 0;
    const { layer, step, frame } = makeLayer({ speechOpen: () => open });
    layer.startInhale({ cue_id: 'c', duration_ms: 450 });
    step(500);
    expect(frame.expression('aa')).toBeGreaterThan(0);
    open = 0.3;
    step(DT);
    expect(frame.expression('aa')).toBe(0);
  });

  it('視線は既定では触らない。gazeToUser で相手へ寄せる', () => {
    const { layer, step, frame } = makeLayer();
    layer.startInhale({ cue_id: 'c', duration_ms: 450 });
    const run = () => {
      for (let i = 0; i < 40; i += 1) {
        frame.begin();
        frame.eye.yawDeg = 10;
        frame.eye.userWeight = 0;
        layer.update({ dtMs: DT, nowMs: i * DT }, frame);
      }
    };
    run();
    expect(frame.eye.yawDeg).toBe(10);
    layer.params = mergeBreathParams(layer.params, { prep: { gazeToUser: true } });
    run();
    expect(frame.eye.yawDeg).toBeLessThan(1);
    expect(frame.eye.userWeight).toBeGreaterThan(0.9);
    step(0);
  });

  it('吸気の間は待機の揺れを抑える（IdleLayer.suppression）', () => {
    const { layer, step, idleScale } = makeLayer();
    step(500);
    expect(idleScale.value).toBeCloseTo(1, 3);
    layer.startInhale({ cue_id: 'c', duration_ms: 450 });
    step(300);
    expect(idleScale.value).toBeLessThan(0.3);
  });
});

describe('出力の名前（VRM に依存しない）', () => {
  it('表情と骨の名前を差し替えられる（ARKit 風の名前の例）', () => {
    const layer = new BreathLayer(seededRng(2), {
      output: { chestMorph: 'chestBreath', mouthOpen: 'jawOpen', brow: 'browInnerUp', chest: 'chest' },
    });
    const frame = new PoseFrame();
    layer.startInhale({ cue_id: 'c', duration_ms: 450 });
    for (let i = 0; i < 40; i += 1) {
      frame.begin();
      layer.update({ dtMs: DT, nowMs: i * DT }, frame);
    }
    expect(frame.expression('chestBreath')).toBeGreaterThan(0.5);
    expect(frame.expression('jawOpen')).toBeGreaterThan(0);
    expect(frame.expression('browInnerUp')).toBeGreaterThan(0);
    expect(frame.expressions.has('aa')).toBe(false);
    expect(frame.expressions.has(BREATH_CHEST_EXPRESSION)).toBe(false);
    expect(frame.bones.get('chest')!.x).toBeLessThan(0);
    expect(frame.bones.has('upperChest')).toBe(false);
  });
});

describe('IdleLayer.suppression', () => {
  it('suppression を掛けると揺れが小さくなる', () => {
    const run = (suppression: number) => {
      const idle = new IdleLayer(seededRng(5));
      idle.suppression = suppression;
      const frame = new PoseFrame();
      let max = 0;
      for (let i = 0; i < 400; i += 1) {
        frame.begin();
        idle.update({ dtMs: DT, nowMs: i * DT }, frame);
        max = Math.max(max, Math.abs(frame.bones.get('head')!.y));
      }
      return max;
    };
    expect(run(0.25)).toBeCloseTo(run(1) * 0.25, 6);
  });
});

describe('胸郭モーフ', () => {
  // VRM 0.x の VRoid に近い配置（前が -Z）。
  const frame: ChestFrame = {
    upperChest: { x: 0, y: 1.23, z: -0.01 },
    chest: { x: 0, y: 1.1, z: -0.02 },
    neck: { x: 0, y: 1.34, z: 0.02 },
    front: { x: 0, y: 0, z: -1 },
    bust: { x: 0, y: 1.2, z: -0.07 },
  };
  const roles = ['upperChest', 'chest', 'leftUpperArm', 'head', 'bust', 'neck'];
  const role = (i: number) => {
    const name = roles[i] ?? null;
    return name === 'leftUpperArm' || name === 'head' ? null : name;
  };
  const vertices = (points: [number, number, number][], bone: number[]): SkinnedVertices => ({
    positions: points.flat(),
    skinIndex: bone.flatMap((b) => [b, 0, 0, 0]),
    skinWeight: bone.flatMap(() => [1, 0, 0, 0]),
    boneRole: role,
  });

  it('腕・頭のウェイトの頂点は動かさない', () => {
    const v = vertices(
      [
        [0.2, 1.25, 0],
        [0, 1.5, -0.05],
      ],
      [2, 3],
    );
    expect(chestMembership(v, 0)).toBe(0);
    const result = computeChestMorph(v, frame);
    expect(result.movedVertices).toBe(0);
    expect([...result.displacement].every((x) => x === 0)).toBe(true);
  });

  it('胸骨の前が最も前へ、脇は外へ、背中は小さく、全部少し上へ', () => {
    const front = chestDisplacement({ x: 0, y: 1.24, z: -0.12 }, 1, frame);
    const side = chestDisplacement({ x: 0.13, y: 1.24, z: -0.04 }, 1, frame);
    const back = chestDisplacement({ x: 0, y: 1.24, z: 0.08 }, 1, frame);
    expect(front.z).toBeLessThan(-0.01);
    expect(Math.abs(front.x)).toBeLessThan(1e-6);
    expect(side.x).toBeGreaterThan(0.003);
    expect(Math.hypot(back.x, back.z)).toBeLessThan(Math.hypot(side.x, side.z));
    expect(back.z).toBeGreaterThan(0);
    for (const d of [front, side, back]) expect(d.y).toBeGreaterThan(0);
  });

  it('首より上と腰の下は動かさない（高さで減衰）', () => {
    expect(chestDisplacement({ x: 0, y: 1.36, z: -0.05 }, 1, frame).y).toBe(0);
    const low = chestDisplacement({ x: 0, y: 0.95, z: -0.1 }, 1, frame);
    const mid = chestDisplacement({ x: 0, y: 1.24, z: -0.1 }, 1, frame);
    expect(Math.abs(low.z)).toBeLessThan(Math.abs(mid.z) * 0.3);
  });

  it('体と服は同じ関数: 同じ位置と同じウェイトなら同じ変位', () => {
    const skin = computeChestMorph(vertices([[0.03, 1.22, -0.11]], [0]), frame);
    const cloth = computeChestMorph(vertices([[0.03, 1.22, -0.11]], [0]), frame);
    expect([...skin.displacement]).toEqual([...cloth.displacement]);
    expect(skin.maxDisplacementM).toBeGreaterThan(0.005);
    expect(skin.maxDisplacementM).toBeLessThan(0.03);
  });
});
