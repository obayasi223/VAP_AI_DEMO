/**
 * AI の発話中の動き（docs/speech_motion_audit.md）。機械的な確認で、自然さの評価ではない。
 * 値（時定数、深さ、確率）はどれも暫定の既定の上で確かめている。
 */
import { describe, expect, it } from 'vitest';
import { BreathLayer, BREATH_CHEST_EXPRESSION, DEFAULT_BREATH, type ReleaseReason } from '../breath';
import { DEFAULT_EXPRESSION, ExpressionLayer, SpeechActivity } from '../face';
import { DEFAULT_VOLUME_MOUTH, VolumeMouthSource } from '../mouth';
import { PoseFrame } from '../pose';
import { RAD2DEG, seededRng } from '../util';

const DT = 16;
const P = DEFAULT_BREATH.prep;
const db = (x: number) => 10 ** (x / 20);

describe('口: 再生音の大きさに合わせた開き', () => {
  /** peakDb と troughDb を交互に流し、後半の山と谷の開きを返す。 */
  function syllables(source: VolumeMouthSource, peakDb: number, troughDb: number) {
    let peak = 0;
    let trough = 1;
    for (let t = 0; t < 4000; t += DT) {
      const onPeak = Math.floor(t / 130) % 2 === 0;
      source.setLevel(db(onPeak ? peakDb : troughDb));
      const open = source.update(DT).aa;
      if (t > 2000) {
        peak = Math.max(peak, open);
        trough = Math.min(trough, open);
      }
    }
    return { peak, trough };
  }

  it('大きい TTS（山 -11dB、谷 -24dB）でも谷で口が閉じる方へ戻る', () => {
    const { peak, trough } = syllables(new VolumeMouthSource(), -11, -24);
    expect(trough).toBeLessThan(peak * 0.6);
    expect(peak).toBeLessThanOrEqual(DEFAULT_VOLUME_MOUTH.maxOpen + 1e-9);
  });

  it('小さい音声（山 -24dB）でも同じくらい開く（固定の dB の写像だと小さくなる）', () => {
    const loud = syllables(new VolumeMouthSource(), -11, -24);
    const quiet = syllables(new VolumeMouthSource(), -24, -37);
    expect(quiet.peak).toBeGreaterThan(loud.peak * 0.8);
  });

  it('音が止まると 170ms 以内に 0.1 を切る', () => {
    const source = new VolumeMouthSource();
    for (let t = 0; t < 1000; t += DT) {
      source.setLevel(db(-12));
      source.update(DT);
    }
    let open = 1;
    for (let t = 0; t < 170; t += DT) {
      source.setLevel(0);
      open = source.update(DT).aa;
    }
    expect(open).toBeLessThan(0.1);
  });

  it('床（-46dB）より小さい音では開かない。参照が下がっていても開かない', () => {
    const source = new VolumeMouthSource();
    for (let t = 0; t < 30000; t += DT) {
      source.setLevel(db(-30));
      source.update(DT);
    }
    // 直前まで開いていた分が閉じるのを待ってから見る。
    for (let t = 0; t < 400; t += DT) {
      source.setLevel(db(-50));
      source.update(DT);
    }
    let open = 0;
    for (let t = 0; t < 1000; t += DT) {
      source.setLevel(db(-50));
      open = Math.max(open, source.update(DT).aa);
    }
    expect(open).toBe(0);
  });

  it('発話の途中で声が大きく小さくなっても、やがて開くようになる（参照は下がる）', () => {
    const source = new VolumeMouthSource();
    for (let t = 0; t < 3000; t += DT) {
      source.setLevel(db(-10));
      source.update(DT);
    }
    let open = 0;
    for (let t = 0; t < 30000; t += DT) {
      source.setLevel(db(-34));
      open = source.update(DT).aa;
    }
    expect(open).toBeGreaterThan(0.2);
  });
});

function makeBreath(seed = 5) {
  let open = 0;
  const layer = new BreathLayer(seededRng(seed), {
    speechOpen: () => open,
  });
  const frame = new PoseFrame();
  let now = 0;
  const step = (ms: number, visit?: () => void) => {
    const n = Math.max(1, Math.round(ms / DT));
    for (let i = 0; i < n; i += 1) {
      now += DT;
      frame.begin();
      layer.update({ dtMs: DT, nowMs: now }, frame);
      visit?.();
    }
  };
  return {
    layer,
    frame,
    step,
    setOpen: (v: number) => (open = v),
    chest: () => frame.expression(BREATH_CHEST_EXPRESSION),
    start: (reason: ReleaseReason) => layer.release(reason),
  };
}

describe('呼吸: 発話中の胸', () => {
  it('話している間は通常呼吸を止め、声の間は胸が上がらない', () => {
    const env = makeBreath();
    env.step(1500);
    env.setOpen(0.5);
    env.step(400);
    let prev = env.chest();
    env.step(6000, () => {
      const c = env.chest();
      expect(c).toBeLessThanOrEqual(prev + 1e-6);
      prev = c;
    });
    expect(env.layer.telemetry().normalGain).toBeLessThan(0.05);
  });

  it('話し始めで通常呼吸の胸が一度へこまない（通常呼吸の山で話し始めても）', () => {
    for (const seed of [1, 2, 3, 4]) {
      const env = makeBreath(seed);
      let peak = 0;
      env.step(5000, () => (peak = Math.max(peak, env.chest())));
      while (env.chest() < peak * 0.92) env.step(DT);
      const before = env.chest();
      env.setOpen(0.5);
      let prev = before;
      let maxDrop = 0;
      env.step(600, () => {
        maxDrop = Math.max(maxDrop, prev - env.chest());
        prev = env.chest();
      });
      // 通常呼吸の吐きより速くは下がらない。
      expect(maxDrop, `seed ${seed}`).toBeLessThan(0.02);
    }
  });

  it('句の切れ目の無音で小さく吸う。胸だけで、肩・上胸・頭・口は書かない', () => {
    const env = makeBreath();
    env.setOpen(0.5);
    env.step(3000);
    const before = env.chest();
    env.setOpen(0);
    let peak = before;
    env.step(450, () => {
      peak = Math.max(peak, env.chest());
      expect(env.frame.bones.get('leftShoulder')?.z ?? 0).toBe(0);
      expect(env.frame.bones.get('upperChest')?.x ?? 0).toBe(0);
      expect(env.frame.bones.get('head')?.x ?? 0).toBe(0);
      expect(env.frame.expression('aa')).toBe(0);
    });
    expect(peak).toBeGreaterThan(before + 0.03);
    // 発話前の吸気より十分小さい。
    expect(peak).toBeLessThan(P.depth * 0.4);
  });

  it('短い切れ目（100ms）では吸わない。続けて切れ目があっても吸う間隔を空ける', () => {
    const env = makeBreath();
    env.setOpen(0.5);
    env.step(3000);
    let prev = env.chest();
    env.setOpen(0);
    env.step(100);
    env.setOpen(0.5);
    let rises = 0;
    env.step(300, () => {
      if (env.chest() > prev + 1e-4) rises += 1;
      prev = env.chest();
    });
    expect(rises).toBe(0);
    // 吸った直後の切れ目では吸わない。
    env.setOpen(0);
    env.step(400);
    env.setOpen(0.5);
    env.step(300);
    const afterBreath = env.chest();
    env.setOpen(0);
    let peak = afterBreath;
    env.step(400, () => (peak = Math.max(peak, env.chest())));
    expect(peak).toBeLessThan(afterBreath + 0.01);
  });

  it('発話の後は通常呼吸へ戻る', () => {
    const env = makeBreath();
    env.setOpen(0.5);
    env.step(4000);
    env.setOpen(0);
    env.step(6000);
    expect(env.layer.telemetry().normalGain).toBeGreaterThan(0.9);
  });

  it('発話の途中の胸も吸気の開始へ引き取る（吸い始めで胸がへこまない）', () => {
    const env = makeBreath();
    env.setOpen(0.5);
    env.step(3000);
    env.setOpen(0);
    env.step(300);
    const before = env.chest();
    env.step(300);
    // 口が閉じた後の吸気（発話の戻りではない）。
    env.layer.startInhale({ cue_id: 'c', duration_ms: 700 });
    let prev = before;
    env.step(400, () => {
      expect(env.chest()).toBeGreaterThanOrEqual(prev - 0.01);
      prev = env.chest();
    });
  });
});

describe('呼吸: 吸気から発声への接続', () => {
  function toHold() {
    const env = makeBreath();
    env.layer.startInhale({ cue_id: 'c', duration_ms: 700 });
    env.step(900);
    return env;
  }

  it('speech_started の後、声が出るまで口の準備を閉じない', () => {
    const env = toHold();
    const atHold = env.frame.expression('aa');
    env.layer.release('speech_started');
    env.step(150);
    expect(env.frame.expression('aa')).toBeGreaterThan(atHold * 0.9);
  });

  it('声が出たら 1 フレームで消さずに譲る。譲った後の無音で口の準備が戻らない', () => {
    const env = toHold();
    env.layer.release('speech_started');
    env.step(100);
    env.setOpen(0.3);
    let prev = env.frame.expression('aa');
    env.step(200, () => {
      expect(Math.abs(env.frame.expression('aa') - prev)).toBeLessThanOrEqual(0.05);
      prev = env.frame.expression('aa');
    });
    expect(env.layer.telemetry().prep.mouth).toBe(0);
    env.setOpen(0);
    env.step(300);
    expect(env.layer.telemetry().prep.mouth).toBe(0);
  });

  it('声が来なければ上限で閉じる（口が開いたままにならない）', () => {
    const env = toHold();
    env.layer.release('speech_started');
    env.step(P.speechMouthWaitMs + P.speechMouthYieldMs + 2 * DT);
    expect(env.layer.telemetry().prep.mouth).toBe(0);
  });

  it('発話が始まったら待機の揺れの抑えを解く（発話中に頭が止まらない）。発話の戻りの後で下げ直さない', () => {
    let idle = 1;
    let open = 0;
    const layer = new BreathLayer(seededRng(3), {
      speechOpen: () => open,
      setIdleScale: (s) => {
        idle = s;
      },
    });
    const frame = new PoseFrame();
    let now = 0;
    const step = (ms: number) => {
      for (let t = 0; t < ms; t += DT) {
        now += DT;
        frame.begin();
        layer.update({ dtMs: DT, nowMs: now }, frame);
      }
    };
    layer.startInhale({ cue_id: 'c', duration_ms: 700 });
    step(900);
    expect(idle).toBeLessThan(0.3);
    layer.release('speech_started');
    open = 0.4;
    step(2000);
    expect(idle).toBeGreaterThan(0.8);
    let min = 1;
    open = 0.4;
    for (let t = 0; t < 3000; t += DT) {
      step(DT);
      min = Math.min(min, idle);
    }
    expect(min).toBeGreaterThan(0.8);
  });
});

describe('頭: 句末のうなずき', () => {
  function phrases(pauseMs: number, seed: number) {
    let open = 0;
    const layer = new ExpressionLayer(seededRng(seed), () => open);
    const frame = new PoseFrame();
    const pitch: number[] = [];
    let t = 0;
    const run = (ms: number, value: number) => {
      for (let e = 0; e < ms; e += DT, t += DT) {
        open = value;
        frame.begin();
        layer.update({ dtMs: DT, nowMs: t }, frame);
        pitch.push((frame.bones.get('head')?.x ?? 0) * RAD2DEG);
      }
    };
    run(800, 0.5);
    run(pauseMs, 0);
    run(800, 0.5);
    return pitch;
  }

  it('休止の無い切れ目では出さない（短い切れ目の後の pitch が小さい）', () => {
    const activity = new SpeechActivity();
    for (let t = 0; t < 1000; t += DT) activity.update(0.5, DT);
    let ends = 0;
    for (let t = 0; t < DEFAULT_EXPRESSION.phraseEndMs - 40; t += DT) if (activity.update(0, DT).phraseEnd) ends += 1;
    for (let t = 0; t < 500; t += DT) activity.update(0.5, DT);
    expect(ends).toBe(0);
  });

  it('休止で句末とみなし、1 回だけ句末の印を出す。話した長さが短いときは出さない', () => {
    const a = new SpeechActivity();
    for (let t = 0; t < 1000; t += DT) a.update(0.5, DT);
    let ends = 0;
    for (let t = 0; t < 1000; t += DT) if (a.update(0, DT).phraseEnd) ends += 1;
    expect(ends).toBe(1);
    // 短い発声の後は句末としない。
    const b = new SpeechActivity();
    for (let t = 0; t < DT * 4; t += DT) b.update(0.5, DT);
    let shortEnds = 0;
    for (let t = 0; t < 1000; t += DT) if (b.update(0, DT).phraseEnd) shortEnds += 1;
    expect(shortEnds).toBe(0);
  });

  it('うなずきは確率的で、出たときは下向きに 1.2 度以上動き、滑らかに戻る', () => {
    let nods = 0;
    for (let seed = 1; seed <= 40; seed += 1) {
      const pitch = phrases(500, seed);
      const baselineEnd = Math.round(800 / DT);
      const peak = Math.max(...pitch.slice(baselineEnd, baselineEnd + 40));
      if (peak > 1.2) nods += 1;
      for (let i = 1; i < pitch.length; i += 1) expect(Math.abs((pitch[i] ?? 0) - (pitch[i - 1] ?? 0))).toBeLessThan(0.3);
    }
    expect(nods).toBeGreaterThan(8);
    expect(nods).toBeLessThan(35);
  });
});
