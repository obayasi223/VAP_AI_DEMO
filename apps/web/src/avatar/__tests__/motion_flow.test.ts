/**
 * 吸気 → 発話待機 → 発声／延期 → 短い準備／撤回 を一連の動作として試す（包絡の連続性、撤回の終わりの状態、失敗の経路）。
 * 値はすべて暫定の既定の上での機械的な確認で、自然さの評価ではない。
 */
import { describe, expect, it } from 'vitest';
import { BlinkLayer, BlinkScheduler } from '../blink';
import {
  BREATH_CHANNELS,
  BREATH_CHEST_EXPRESSION,
  BreathLayer,
  CONTINUITY_MS,
  DEFAULT_BREATH,
  HOLD_MAX_MS,
  continuityCarry,
  releaseSpec,
  releaseTotalMs,
  type BreathChannel,
  type BreathPhaseEvent,
  type ReleaseReason,
} from '../breath';
import { BreathSignalReporter, type BreathSignalEvent } from '../breath_signal';
import { ExpressionLayer } from '../face';
import { GazeController, GazeLayer } from '../gaze';
import { IdleLayer, RestPoseLayer } from '../idle';
import { applyMotionStep, MOTION_SEQUENCES, type SequenceTarget } from '../motion_sequences';
import { CLOSED_MOUTH, MouthLayer, mouthOpenAmount, type MouthShape, type MouthSource } from '../mouth';
import { LayerStack, PoseFrame } from '../pose';
import { SaccadeGenerator, SaccadeLayer } from '../saccade';
import { seededRng } from '../util';

const P = DEFAULT_BREATH.prep;
const RAD = 180 / Math.PI;
const DT = 16;

type Command = 'inhale' | 'prepareShort' | ReleaseReason;
const COMMANDS: Command[] = ['inhale', 'prepareShort', 'speech_started', 'deferred', 'withdrawn'];
/** 同じ順番で、ある局面の途中に次の命令が来る間隔（ms）。 */
const GAPS = [16, 120, 400, 850, 1700, 3200];

function apply(layer: BreathLayer, command: Command, inhaleMs: number): void {
  if (command === 'inhale') layer.startInhale({ cue_id: 'c', duration_ms: inhaleMs });
  else if (command === 'prepareShort') layer.prepareShort(150);
  else layer.release(command);
}

/** 骨と表情の1フレームの出力（連続性を見る量。度、重み）。 */
function outputsOf(frame: PoseFrame): Record<string, number> {
  const bone = (name: string, axis: 'x' | 'y' | 'z') => (frame.bones.get(name)?.[axis] ?? 0) * RAD;
  return {
    chestMorph: frame.expression(BREATH_CHEST_EXPRESSION),
    aa: frame.expression('aa'),
    browUp: frame.expression('browUp'),
    upperChestX: bone('upperChest', 'x'),
    neckX: bone('neck', 'x'),
    headX: bone('head', 'x'),
    leftShoulderZ: bone('leftShoulder', 'z'),
    rightShoulderZ: bone('rightShoulder', 'z'),
    leftUpperArmX: bone('leftUpperArm', 'x'),
    leftUpperArmZ: bone('leftUpperArm', 'z'),
  };
}

/**
 * 1 フレーム（16ms）の変化量の上限（暫定）。既定の動きの中で最も速いのは 150ms の短い準備（idle から受けた場合）で、それが入るように決めた。
 * 1 フレームで飛ぶ切り替え（口の準備を一度に消す、局面の初期値の取り違えなど）は超える。
 */
const MAX_DELTA_PER_16MS: Record<string, number> = {
  chestMorph: 0.12,
  aa: 0.05,
  browUp: 0.03,
  upperChestX: 0.2,
  neckX: 0.15,
  headX: 0.3,
  leftShoulderZ: 0.5,
  rightShoulderZ: 0.5,
  leftUpperArmX: 0.2,
  leftUpperArmZ: 0.5,
};

/** 命令列を流して、各フレームの出力の変化量が上限に収まり、最後に聞き手へ戻ることを確かめる。 */
function runSequence(commands: Command[], gaps: number[], options: { dt?: number; inhaleMs?: number } = {}) {
  const dt = options.dt ?? DT;
  const inhaleMs = options.inhaleMs ?? 700;
  const layer = new BreathLayer(seededRng(7));
  // 通常呼吸は切って、準備の動きだけを見る（通常呼吸の山での受け渡しは別の試験）。
  layer.params = { ...DEFAULT_BREATH, normal: { ...DEFAULT_BREATH.normal, depth: 0, headPitchDeg: 0 } };
  const frame = new PoseFrame();
  let last: Record<string, number> | null = null;
  const violations: string[] = [];
  let now = 0;
  const step = (ms: number) => {
    const n = Math.max(1, Math.round(ms / dt));
    for (let i = 0; i < n; i += 1) {
      now += dt;
      frame.begin();
      layer.update({ dtMs: dt, nowMs: now }, frame);
      const out = outputsOf(frame);
      if (last) {
        for (const key of Object.keys(out)) {
          const delta = Math.abs((out[key] ?? 0) - (last[key] ?? 0));
          if (delta > (MAX_DELTA_PER_16MS[key] ?? 0.5) * (dt / 16) + 1e-9) {
            violations.push(`${key} ${delta.toFixed(4)} @${now}ms`);
          }
        }
      }
      last = out;
    }
  };
  step(dt);
  commands.forEach((command, i) => {
    apply(layer, command, inhaleMs);
    const gap = gaps[i];
    if (gap !== undefined) step(gap);
  });
  // 最後の命令の後、何も来なくても聞き手へ戻る。
  step(HOLD_MAX_MS + inhaleMs + P.deferredExhaleMs + P.deferredLingerMs + P.speechExhaleMs + 800);
  return { layer, violations };
}

describe('全局面の順番の連続性', () => {
  it('命令の全ての順番（3手まで、途中の局面を含む間隔）で 1 フレームの変化量が上限に収まり、最後は聞き手の姿勢へ戻る', () => {
    const cases: { commands: Command[]; gaps: number[] }[] = [];
    for (const a of COMMANDS) {
      cases.push({ commands: [a], gaps: [] });
      for (const b of COMMANDS) {
        for (const g1 of GAPS) {
          cases.push({ commands: ['inhale', a, b], gaps: [g1, 16] });
          for (const g2 of GAPS) cases.push({ commands: [a, 'inhale', b], gaps: [g1, g2] });
        }
      }
    }
    let total = 0;
    for (const { commands, gaps } of cases) {
      const { layer, violations } = runSequence(commands, gaps);
      expect(violations, `${commands.join('→')} ${gaps.join(',')}`).toEqual([]);
      const t = layer.telemetry();
      expect(t.phase).toBe('idle');
      for (const c of BREATH_CHANNELS) expect(t.prep[c]).toBe(0);
      total += 1;
    }
    expect(total).toBeGreaterThan(1000);
  });

  it('命令の順番は 33ms（30fps）でも連続（上限は dt に比例）', () => {
    for (const a of COMMANDS) {
      for (const b of COMMANDS) {
        for (const gap of [120, 400, 850, 1700]) {
          const { violations } = runSequence(['inhale', a, b], [gap, 16], { dt: 33 });
          expect(violations, `${a}→${b} ${gap}`).toEqual([]);
        }
      }
    }
  });

  it('局面の境目で速さが飛ばない（吸気の途中の撤回で、胸はすぐ止まらず短く進んでから戻る）', () => {
    const layer = new BreathLayer(seededRng(3));
    layer.params = { ...DEFAULT_BREATH, normal: { ...DEFAULT_BREATH.normal, depth: 0, headPitchDeg: 0 } };
    const frame = new PoseFrame();
    let now = 0;
    const tick = () => {
      now += DT;
      frame.begin();
      layer.update({ dtMs: DT, nowMs: now }, frame);
      return layer.telemetry().prep.chest;
    };
    layer.startInhale({ cue_id: 'c', duration_ms: 700 });
    for (let i = 0; i < 18; i += 1) tick();
    const a = tick();
    const b = tick();
    const speedBefore = b - a;
    expect(speedBefore).toBeGreaterThan(0.01);
    layer.release('withdrawn');
    const after = tick();
    // 境目のフレームの速さが、直前の速さの半分を割って急に落ちない。
    expect(after - b).toBeGreaterThan(speedBefore * 0.5);
    let chest = after;
    for (let i = 0; i < 80; i += 1) chest = tick();
    expect(chest).toBe(0);
    expect(layer.phase()).toBe('idle');
  });

  it('continuityCarry は両端で 0、境目で初速を持つ', () => {
    expect(continuityCarry(0.01, 0, 200)).toBe(0);
    expect(continuityCarry(0.01, 200, 200)).toBe(0);
    expect(continuityCarry(0.01, 1, 200)).toBeCloseTo(0.01, 3);
    expect(CONTINUITY_MS.mouth).toBeLessThan(CONTINUITY_MS.chest);
  });

  it('通常呼吸の山で吸い始めても胸が一度へこまない（通常呼吸の胸を吸気へ引き取る）', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const layer = new BreathLayer(seededRng(seed));
      const frame = new PoseFrame();
      let now = 0;
      const tick = () => {
        now += DT;
        frame.begin();
        layer.update({ dtMs: DT, nowMs: now }, frame);
        return frame.expression(BREATH_CHEST_EXPRESSION);
      };
      // 通常呼吸を回して、その山を探してから吸い始める。
      let maxChest = 0;
      for (let i = 0; i < 400; i += 1) maxChest = Math.max(maxChest, tick());
      let chest = tick();
      while (chest < maxChest * 0.92) chest = tick();
      layer.startInhale({ cue_id: 'c', duration_ms: 700 });
      let prev = chest;
      for (let i = 0; i < 38; i += 1) {
        const next = tick();
        expect(next, `seed ${seed} frame ${i}`).toBeGreaterThanOrEqual(prev - 0.005);
        prev = next;
      }
      expect(prev).toBeGreaterThan(0.8);
    }
  });

  it('発話の口形が開いたとき準備の口を一度に消さない（aa の変化量が上限に収まる）', () => {
    let open = 0;
    const layer = new BreathLayer(seededRng(1), { speechOpen: () => open });
    const frame = new PoseFrame();
    let now = 0;
    const tick = () => {
      now += DT;
      frame.begin();
      layer.update({ dtMs: DT, nowMs: now }, frame);
      return frame.expression('aa');
    };
    layer.startInhale({ cue_id: 'c', duration_ms: 700 });
    for (let i = 0; i < 50; i += 1) tick();
    let prev = tick();
    expect(prev).toBeGreaterThan(0.05);
    open = 0.3;
    for (let i = 0; i < 30; i += 1) {
      const next = tick();
      expect(prev - next).toBeLessThanOrEqual(MAX_DELTA_PER_16MS.aa! + 1e-9);
      prev = next;
    }
  });
});

/** 全部の層を重ねて確かめる環境。 */
function makeFullStack(seed: number) {
  const rng = seededRng(seed);
  const stack = new LayerStack();
  let mouthAa = 0;
  const source: MouthSource = {
    update: (): MouthShape => ({ ...CLOSED_MOUTH, aa: mouthAa }),
  };
  const mouthLayer = new MouthLayer(source);
  const idle = new IdleLayer(rng);
  const blink = new BlinkScheduler(rng);
  const gaze = new GazeController(rng);
  const saccades = new SaccadeGenerator(rng);
  const expression = new ExpressionLayer(rng, () => mouthOpenAmount(mouthLayer.shape));
  const breath = new BreathLayer(rng, {
    speechOpen: () => mouthOpenAmount(mouthLayer.shape),
    setIdleScale: (s) => {
      idle.suppression = s;
    },
  });
  stack.add(new RestPoseLayer());
  stack.add(idle);
  stack.add(new GazeLayer(gaze));
  stack.add(new SaccadeLayer(saccades, (deg) => blink.onGazeShift(deg)));
  stack.add(expression);
  stack.add(breath);
  stack.add(new BlinkLayer(blink));
  stack.add(mouthLayer);
  let now = 0;
  let frame: PoseFrame = stack.frame;
  const step = (ms: number, visit?: () => void) => {
    const n = Math.max(1, Math.round(ms / DT));
    for (let i = 0; i < n; i += 1) {
      now += DT;
      frame = stack.step({ dtMs: DT, nowMs: now });
      visit?.();
    }
  };
  return {
    breath,
    gaze,
    blink,
    idle,
    step,
    frame: () => frame,
    setMouth: (aa: number) => {
      mouthAa = aa;
    },
    now: () => now,
  };
}

describe('撤回は自然な聞き手へ戻る（延期と動きを分けたまま）', () => {
  const listenerAfter = (reason: 'withdrawn' | 'deferred') => {
    const env = makeFullStack(11);
    env.step(500);
    env.breath.startInhale({ cue_id: 'c', duration_ms: 700 });
    env.step(900);
    env.breath.release(reason);
    return env;
  };

  it('撤回: 口が閉じ、胸と肩が戻り、準備を残さない。視線は相手のまま、待機の揺れと瞬きが再開する', () => {
    const env = listenerAfter('withdrawn');
    env.step(P.withdrawnExhaleMs + 60);
    expect(env.breath.phase()).toBe('idle');
    const t = env.breath.telemetry();
    expect(t.lastReleaseCause).toBe('withdrawn');
    expect(t.releaseKind).toBe('withdrawn');
    for (const c of BREATH_CHANNELS) expect(t.prep[c]).toBe(0);
    const f = env.frame();
    expect(f.expression('aa')).toBe(0);
    expect(f.expression('browUp')).toBeLessThan(0.1);
    expect(f.expression(BREATH_CHEST_EXPRESSION)).toBeLessThan(0.05);
    expect(f.bones.get('leftShoulder')?.z ?? 0).toBe(0);
    expect(f.eye.userWeight).toBeGreaterThan(0.99);
    // 待機の揺れと通常呼吸は少し後に戻る。
    const blinksBefore = env.blink.count;
    env.step(P.postSuppressMs + 6000);
    expect(env.breath.telemetry().idleScale).toBeGreaterThan(0.9);
    expect(env.breath.telemetry().normalGain).toBeGreaterThan(0.9);
    expect(env.idle.suppression).toBeGreaterThan(0.9);
    // 瞬きは止まらない。
    expect(env.blink.count).toBeGreaterThan(blinksBefore);
  });

  it('延期: 撤回と違い、胸・唇・頭を少し残したまま下がる（short の受け皿）', () => {
    const env = listenerAfter('deferred');
    env.step(P.withdrawnExhaleMs + 60);
    expect(env.breath.phase()).toBe('release');
    const t = env.breath.telemetry();
    expect(t.releaseKind).toBe('deferred');
    expect(t.prep.chest).toBeGreaterThan(0.1);
    expect(t.prep.mouth).toBeGreaterThan(0.15);
    expect(t.prep.head).toBeGreaterThan(0.1);
  });

  it('撤回の途中に Node の gaze.command user が来ても視線は相手へ連続に戻る（視線の判断は Node、ブラウザで上書きしない）', () => {
    const env = makeFullStack(12);
    env.step(300);
    env.gaze.setTarget('away');
    env.step(600);
    expect(env.frame().eye.userWeight).toBeLessThan(0.5);
    env.breath.startInhale({ cue_id: 'c', duration_ms: 700 });
    env.step(900);
    env.breath.release('withdrawn');
    env.step(100);
    env.gaze.setTarget('user');
    const eye = () => ({ yaw: env.frame().eye.yawDeg, user: env.frame().eye.userWeight });
    let prev = eye();
    env.step(800, () => {
      const cur = eye();
      expect(Math.abs(cur.yaw - prev.yaw)).toBeLessThan(25);
      prev = cur;
    });
    expect(env.frame().eye.userWeight).toBeGreaterThan(0.99);
    expect(env.breath.params.prep.gazeToUser).toBe(false);
  });

  it('視線の既定は吸気に連動しない（gazeToUser=false のまま）', () => {
    expect(DEFAULT_BREATH.prep.gazeToUser).toBe(false);
  });
});

describe('失敗の経路（口が開いたまま、胸が膨らんだままにしない）', () => {
  function speechStart() {
    const env = makeFullStack(13);
    env.step(500);
    env.breath.startInhale({ cue_id: 'c', duration_ms: 700 });
    env.step(900);
    env.breath.release('speech_started');
    env.step(64);
    expect(env.breath.telemetry().releaseKind).toBe('speech');
    return env;
  }

  it('音声が来ない: Node の撤回（withdrawn）は発話の戻りの途中でも受け、速く聞き手へ戻る', () => {
    const env = speechStart();
    env.step(400);
    expect(env.breath.release('withdrawn')).toBe(true);
    env.step(DT);
    expect(env.breath.telemetry()).toMatchObject({ releaseKind: 'withdrawn', lastReleaseCause: 'withdrawn' });
    env.step(P.withdrawnExhaleMs + 40);
    expect(env.breath.phase()).toBe('idle');
    expect(env.frame().expression('aa')).toBe(0);
    expect(env.frame().expression(BREATH_CHEST_EXPRESSION)).toBeLessThan(0.05);
  });

  it('途中で止まる: 口形が止まって撤回が来ると口が閉じ、胸が戻る', () => {
    const env = speechStart();
    env.setMouth(0.5);
    env.step(600);
    expect(mouthOpenAmount({ ...CLOSED_MOUTH, aa: env.frame().expression('aa') })).toBeGreaterThan(0.4);
    env.setMouth(0);
    env.breath.release('withdrawn');
    env.step(P.withdrawnExhaleMs + 60);
    expect(env.breath.phase()).toBe('idle');
    expect(env.frame().expression('aa')).toBe(0);
    expect(env.frame().expression(BREATH_CHEST_EXPRESSION)).toBeLessThan(0.05);
  });

  it('Node の解除が来なくても全ての局面に上限があり、聞き手へ戻る（保持の上限・短い準備の後の保持・発話の戻り）', () => {
    // 保持の上限: 吸気 → 保持 → hold_timeout → 脱力 → idle。
    const events: BreathPhaseEvent[] = [];
    const a = new BreathLayer(seededRng(1), { onPhase: (e) => events.push(e) });
    const frame = new PoseFrame();
    const run = (layer: BreathLayer, ms: number) => {
      for (let t = 0; t < ms; t += DT) {
        frame.begin();
        layer.update({ dtMs: DT, nowMs: t }, frame);
      }
    };
    a.startInhale({ cue_id: 'c', duration_ms: 700 });
    run(a, 700 + HOLD_MAX_MS + releaseTotalMs(releaseSpec('deferred', P)) + 200);
    expect(a.phase()).toBe('idle');
    expect(events.map((e) => e.cause ?? e.phase)).toEqual(['inhale', 'hold', 'hold_timeout', 'hold_timeout']);
    // 短い準備の保持の上限。
    const b = new BreathLayer(seededRng(1));
    b.prepareShort(150);
    run(b, 150 + HOLD_MAX_MS + releaseTotalMs(releaseSpec('deferred', P)) + 200);
    expect(b.phase()).toBe('idle');
    // 発話の戻り（音声が来ない、撤回も来ない）は有限の長さで idle へ。
    const c = new BreathLayer(seededRng(1));
    c.startInhale({ cue_id: 'c', duration_ms: 700 });
    run(c, 900);
    c.release('speech_started');
    run(c, P.speechExhaleMs + 100);
    expect(c.phase()).toBe('idle');
    for (const channel of BREATH_CHANNELS as readonly BreathChannel[]) expect(c.telemetry().prep[channel]).toBe(0);
  });
});

describe('breath_signal の報告', () => {
  const mapping = (cue: string | null) => (cue === 'c1' || cue === null ? 'cand_1' : 'cand_2');
  function run(events: Partial<BreathPhaseEvent>[]) {
    const out: BreathSignalEvent[] = [];
    const reporter = new BreathSignalReporter(mapping, (e) => out.push(e));
    let t = 100;
    for (const e of events) {
      t += 100;
      reporter.onPhase({ phase: 'idle', nowMs: t, cueId: 'c1', cause: null, kind: 'prep', ...e } as BreathPhaseEvent);
    }
    return out.map((e) => `${e.candidate_id}:${e.phase}:${e.state}@${e.client_t_ms}`);
  }

  it('吸気 → 保持 → 脱力: inhale と ready の終わり、relax の始まりと終わりを実際の時刻で出す', () => {
    expect(run([{ phase: 'inhale' }, { phase: 'hold' }, { phase: 'release', cause: 'withdrawn' }, { phase: 'idle', cause: 'withdrawn' }])).toEqual([
      'cand_1:inhale:ended@300',
      'cand_1:ready:started@300',
      'cand_1:ready:ended@400',
      'cand_1:relax:ended@500',
    ]);
  });

  it('発話: ready の後に pre_speech の終わりが idle で出る。保持の上限は relax の started も自分で出す', () => {
    expect(run([{ phase: 'inhale' }, { phase: 'hold' }, { phase: 'release', cause: 'speech_started' }, { phase: 'idle' }])).toEqual([
      'cand_1:inhale:ended@300',
      'cand_1:ready:started@300',
      'cand_1:ready:ended@400',
      'cand_1:pre_speech:ended@500',
    ]);
    expect(run([{ phase: 'inhale' }, { phase: 'hold' }, { phase: 'release', cause: 'hold_timeout' }])).toContain('cand_1:relax:started@400');
  });

  it('吸気の途中の脱力は inhale の終わりをそのフレームで出す。次の吸気で割り込まれた脱力も終わりを出す（候補は開いた時のもの）', () => {
    expect(run([{ phase: 'inhale' }, { phase: 'release', cause: 'withdrawn' }, { phase: 'inhale', cueId: 'c2' }])).toEqual([
      'cand_1:inhale:ended@300',
      'cand_1:relax:ended@400',
    ]);
  });

  it('短い準備は pre_speech（再吸気として数えない）で、保持の後も閉じず、発話の後に終わる', () => {
    expect(run([{ phase: 'inhale', kind: 'short', cueId: null }, { phase: 'hold', kind: 'short', cueId: null }, { phase: 'release', cause: 'speech_started', kind: 'short', cueId: null }, { phase: 'idle', cueId: null }])).toEqual([
      'cand_1:pre_speech:started@200',
      'cand_1:pre_speech:ended@500',
    ]);
  });
});

describe('一連の動作の台本（/dev/breath）', () => {
  it('全部の台本が idle で終わり、順番に当てられる', () => {
    expect(MOTION_SEQUENCES.map((s) => s.id).sort()).toEqual(['defer_speak', 'defer_withdraw', 'fail_midway', 'fail_no_audio', 'speak', 'withdraw_mid_inhale']);
    for (const sequence of MOTION_SEQUENCES) {
      let speaking = false;
      const layer = new BreathLayer(seededRng(1), { speechOpen: () => (speaking ? 0.3 : 0) });
      const target: SequenceTarget = { breath: layer, speak: (active) => (speaking = active) };
      const frame = new PoseFrame();
      const sorted = [...sequence.steps].sort((a, b) => a.atMs - b.atMs);
      let t = 0;
      for (const s of sorted) {
        for (; t < s.atMs; t += DT) {
          frame.begin();
          layer.update({ dtMs: DT, nowMs: t }, frame);
        }
        applyMotionStep(target, s);
      }
      for (; t < sequence.totalMs + 800; t += DT) {
        frame.begin();
        layer.update({ dtMs: DT, nowMs: t }, frame);
      }
      expect(layer.phase(), sequence.id).toBe('idle');
      for (const c of BREATH_CHANNELS) expect(layer.telemetry().prep[c]).toBe(0);
    }
  });
});
