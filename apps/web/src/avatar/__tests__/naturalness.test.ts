import { describe, expect, it } from 'vitest';
import { BlinkScheduler, DEFAULT_BLINK, gazeBlinkProbability } from '../blink';
import { DEFAULT_EXPRESSION, ExpressionLayer, SpeechActivity } from '../face';
import { PoseFrame } from '../pose';
import {
  DEFAULT_RENDER,
  H1_RENDER,
  materialKind,
  matcapScaleFor,
  mipmapAllowed,
  pixelRatioFor,
  resolveRenderSettings,
} from '../render_settings';
import { DEFAULT_SACCADE, nextFixation, nextSaccadeIntervalMs, SaccadeGenerator, SaccadeLayer } from '../saccade';
import { RAD2DEG, seededRng } from '../util';

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs: number[]) => {
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
};

describe('nextSaccadeIntervalMs', () => {
  const rng = seededRng(11);
  const samples = Array.from({ length: 5000 }, () => nextSaccadeIntervalMs(rng));

  it('範囲に収まり、中央値が設定に近い', () => {
    expect(Math.min(...samples)).toBeGreaterThanOrEqual(DEFAULT_SACCADE.minIntervalMs);
    expect(Math.max(...samples)).toBeLessThanOrEqual(DEFAULT_SACCADE.maxIntervalMs);
    const sorted = [...samples].sort((a, b) => a - b);
    expect(sorted[2500]).toBeGreaterThan(DEFAULT_SACCADE.medianIntervalMs * 0.9);
    expect(sorted[2500]).toBeLessThan(DEFAULT_SACCADE.medianIntervalMs * 1.1);
  });

  it('ばらつきが大きく、連続する間隔に相関がない（固定周期でない）', () => {
    expect(sd(samples) / mean(samples)).toBeGreaterThan(0.4);
    const m = mean(samples);
    let num = 0;
    let den = 0;
    for (let i = 0; i < samples.length - 1; i += 1) {
      num += (samples[i]! - m) * (samples[i + 1]! - m);
      den += (samples[i]! - m) ** 2;
    }
    expect(Math.abs(num / den)).toBeLessThan(0.06);
  });
});

describe('nextFixation', () => {
  it('両目と口元を重みどおりに選び、角度は小さい', () => {
    const rng = seededRng(12);
    const counts = { rightEye: 0, leftEye: 0, mouth: 0 };
    for (let i = 0; i < 4000; i += 1) {
      const { point, angles } = nextFixation(rng);
      counts[point] += 1;
      expect(Math.abs(angles.yawDeg)).toBeLessThan(12);
      expect(Math.abs(angles.pitchDeg)).toBeLessThan(15);
      if (point === 'mouth') expect(angles.pitchDeg).toBeGreaterThan(0); // 下
    }
    expect(counts.mouth / 4000).toBeGreaterThan(0.1);
    expect(counts.mouth / 4000).toBeLessThan(0.25);
    expect(Math.abs(counts.rightEye - counts.leftEye) / 4000).toBeLessThan(0.05);
  });
});

describe('SaccadeGenerator', () => {
  it('移動は速く（moveMs で届く）、その後は止まっている', () => {
    const generator = new SaccadeGenerator(seededRng(13));
    let started = false;
    let afterMove: number | null = null;
    let sinceStart = 0;
    for (let t = 0; t < 20000 && afterMove === null; t += 10) {
      const { angles, startedDeg } = generator.update(10);
      if (startedDeg > 0) {
        started = true;
        sinceStart = 0;
        continue;
      }
      if (started) {
        sinceStart += 10;
        if (sinceStart > DEFAULT_SACCADE.moveMs) afterMove = angles.yawDeg;
      }
    }
    expect(afterMove).not.toBeNull();
    const held = generator.update(10).angles.yawDeg;
    expect(held).toBeCloseTo(afterMove!, 6);
  });

  it('enabled=false で正面へ戻り、新しい移動を始めない', () => {
    const generator = new SaccadeGenerator(seededRng(14));
    for (let t = 0; t < 10000; t += 10) generator.update(10);
    generator.enabled = false;
    const count = generator.count;
    let last = generator.update(10).angles;
    for (let t = 0; t < 10000; t += 10) last = generator.update(10).angles;
    expect(generator.count).toBe(count);
    expect(last.yawDeg).toBeCloseTo(0, 6);
    expect(last.pitchDeg).toBeCloseTo(0, 6);
  });

  it('層: そらしている間（userWeight=0）は眼へ足さず、瞬きの連動も呼ばない', () => {
    let shifts = 0;
    const layer = new SaccadeLayer(new SaccadeGenerator(seededRng(15)), () => (shifts += 1));
    const frame = new PoseFrame();
    for (let t = 0; t < 20000; t += 10) {
      frame.begin();
      frame.eye.userWeight = 0;
      layer.update({ dtMs: 10, nowMs: t }, frame);
      expect(frame.eye.yawDeg).toBe(0);
    }
    expect(shifts).toBe(0);
  });
});

describe('瞬きと視線の連動', () => {
  it('小さな移動では瞬かず、大きいほど確率が上がり、上限を超えない', () => {
    expect(gazeBlinkProbability(5)).toBe(0);
    expect(gazeBlinkProbability(DEFAULT_BLINK.gazeBlinkMinDeg)).toBe(0);
    expect(gazeBlinkProbability(30)).toBeGreaterThan(0);
    expect(gazeBlinkProbability(40)).toBeGreaterThan(gazeBlinkProbability(30));
    expect(gazeBlinkProbability(500)).toBe(DEFAULT_BLINK.maxGazeBlinkProbability);
  });

  it('視線をそらす大きさでは半分くらい瞬く', () => {
    let blinks = 0;
    for (let seed = 0; seed < 400; seed += 1) {
      const scheduler = new BlinkScheduler(seededRng(seed));
      if (scheduler.onGazeShift(62)) blinks += 1;
    }
    expect(blinks / 400).toBeGreaterThan(0.45);
    expect(blinks / 400).toBeLessThan(0.75);
  });

  it('瞬きの直後と瞬き中、enabled=false では起こさない', () => {
    const scheduler = new BlinkScheduler(() => 0); // 確率判定は必ず通る
    scheduler.trigger();
    expect(scheduler.onGazeShift(90)).toBe(false); // 瞬き中
    for (let t = 0; t < 300; t += 10) scheduler.update(10);
    expect(scheduler.onGazeShift(90)).toBe(false); // 不応期
    for (let t = 0; t < 1000; t += 10) scheduler.update(10);
    scheduler.enabled = false;
    expect(scheduler.onGazeShift(90)).toBe(false);
  });

  it('話している間は瞬きが多い', () => {
    const run = (speaking: boolean) => {
      const scheduler = new BlinkScheduler(seededRng(21));
      scheduler.speaking = speaking;
      for (let t = 0; t < 600000; t += 10) scheduler.update(10);
      return scheduler.count;
    };
    expect(run(true)).toBeGreaterThan(run(false) * 1.15);
  });
});

describe('SpeechActivity', () => {
  it('話し始めで句の頭を1回だけ出し、話している度合いが上がる', () => {
    const activity = new SpeechActivity();
    let starts = 0;
    let features = activity.update(0, 16);
    for (let t = 0; t < 1000; t += 16) {
      features = activity.update(0.5 + 0.3 * Math.sin(t / 40), 16);
      if (features.phraseStart) starts += 1;
    }
    expect(starts).toBe(1);
    expect(features.speaking).toBeGreaterThan(0.9);
  });

  it('短い切れ目では句の頭にしない、長いポーズの後はする', () => {
    const activity = new SpeechActivity();
    for (let t = 0; t < 500; t += 16) activity.update(0.5, 16);
    for (let t = 0; t < 200; t += 16) activity.update(0, 16);
    expect(activity.update(0.5, 16).phraseStart).toBe(false);
    for (let t = 0; t < DEFAULT_EXPRESSION.phrasePauseMs + 50; t += 16) activity.update(0, 16);
    expect(activity.update(0.5, 16).phraseStart).toBe(true);
  });
});

describe('ExpressionLayer', () => {
  function run(open: (t: number) => number, seconds: number, seed = 31) {
    const layer = new ExpressionLayer(seededRng(seed), () => currentOpen);
    let currentOpen = 0;
    const frame = new PoseFrame();
    const series = { relaxed: [] as number[], brow: [] as number[], pitch: [] as number[], yaw: [] as number[] };
    for (let t = 0; t < seconds * 1000; t += 16) {
      currentOpen = open(t);
      frame.begin();
      layer.update({ dtMs: 16, nowMs: t }, frame);
      series.relaxed.push(frame.expression('relaxed'));
      series.brow.push(frame.expression('browUp'));
      const head = frame.bones.get('head')!;
      series.pitch.push(head.x * RAD2DEG);
      series.yaw.push(head.y * RAD2DEG);
    }
    return { series, frame };
  }

  it('待機: relaxed はわずか、頭は動かさない、眉はごくわずか', () => {
    const { series, frame } = run(() => 0, 60);
    expect(Math.max(...series.relaxed)).toBeLessThanOrEqual(0.2);
    expect(Math.min(...series.relaxed)).toBeGreaterThan(0.05);
    expect(Math.max(...series.pitch.map(Math.abs))).toBeLessThan(0.01);
    expect(Math.max(...series.brow)).toBeLessThanOrEqual(DEFAULT_EXPRESSION.browNoise + 1e-9);
    // 肩・胸は書かない（吸気と紛らわしい動き）。
    expect([...frame.bones.keys()]).toEqual(['head']);
  });

  it('発話中: 頭が小さく動き（3.2 度未満）、relaxed を弱め、眉が上がることがある', () => {
    const syllables = (t: number) => {
      const phrase = Math.floor(t / 2500);
      const inPhrase = t % 2500 < 1800;
      return inPhrase ? Math.max(0, Math.sin((t + phrase * 137) / 45)) * 0.7 : 0;
    };
    const { series } = run(syllables, 60);
    const pitch = series.pitch.map(Math.abs);
    const yaw = series.yaw.map(Math.abs);
    // 上限は揺れ（0.8）、強調（0.5）、句の切れ目のうなずき（1.8）の合計（docs/speech_motion_audit.md）。
    expect(Math.max(...pitch)).toBeLessThan(3.2);
    expect(Math.max(...yaw)).toBeLessThan(1.5);
    expect(sd(series.pitch)).toBeGreaterThan(0.1);
    expect(Math.min(...series.relaxed)).toBeLessThan(DEFAULT_EXPRESSION.relaxedIdle * 0.7);
    expect(Math.max(...series.brow)).toBeGreaterThan(0.15);
    expect(Math.max(...series.brow)).toBeLessThanOrEqual(1);
  });

  it('intensity=0 で何も足さない', () => {
    const layer = new ExpressionLayer(seededRng(32), () => 0.6);
    layer.intensity = 0;
    const frame = new PoseFrame();
    for (let t = 0; t < 3000; t += 16) {
      frame.begin();
      layer.update({ dtMs: 16, nowMs: t }, frame);
    }
    expect(frame.expression('relaxed')).toBe(0);
    expect(frame.expression('browUp')).toBe(0);
    const head = frame.bones.get('head')!;
    expect(Math.abs(head.x) + Math.abs(head.y) + Math.abs(head.z)).toBe(0);
  });
});

describe('render_settings', () => {
  it('VRoid の材質名から種類を判定する', () => {
    expect(materialKind('F00_000_00_Face_00_SKIN')).toBe('skin');
    expect(materialKind('F00_000_00_Face_00_SKIN (Outline)')).toBe('skin');
    expect(materialKind('F00_001_01_Tops_01_CLOTH')).toBe('cloth');
    expect(materialKind('F00_000_Hair_00_HAIR_01')).toBe('hair');
    expect(materialKind('F00_000_00_EyeIris_00_EYE')).toBe('other');
    expect(materialKind('Material')).toBe('other');
  });

  it('マットキャップの倍率は服と肌で下げ、その他は変えない', () => {
    expect(matcapScaleFor('F00_001_01_Tops_01_CLOTH', DEFAULT_RENDER)).toBeLessThan(0.5);
    expect(matcapScaleFor('F00_000_00_EyeIris_00_EYE', DEFAULT_RENDER)).toBe(1);
    expect(matcapScaleFor('F00_001_01_Tops_01_CLOTH', H1_RENDER)).toBe(1);
  });

  it('ミップマップは不透明な髪・肌・服だけ（虹彩とまつげ、透明な材質には付けない）', () => {
    expect(mipmapAllowed('F00_000_Hair_00_HAIR_01', false)).toBe(true);
    expect(mipmapAllowed('F00_000_HairBack_00_HAIR', true)).toBe(false);
    expect(mipmapAllowed('F00_000_00_EyeIris_00_EYE', false)).toBe(false);
    expect(mipmapAllowed('F00_000_00_FaceEyelash_00_FACE', false)).toBe(false);
  });

  it('ピクセル比は下限と上限で切る', () => {
    expect(pixelRatioFor(1, DEFAULT_RENDER)).toBe(DEFAULT_RENDER.minPixelRatio);
    expect(pixelRatioFor(3, DEFAULT_RENDER)).toBe(DEFAULT_RENDER.maxPixelRatio);
    expect(pixelRatioFor(Number.NaN, DEFAULT_RENDER)).toBe(DEFAULT_RENDER.minPixelRatio);
    expect(pixelRatioFor(1, H1_RENDER)).toBe(1);
  });

  it('上書きは一部だけ入れられる', () => {
    const settings = resolveRenderSettings({ springBones: false, matcapScale: { skin: 0.5 } as never });
    expect(settings.springBones).toBe(false);
    expect(settings.matcapScale.skin).toBe(0.5);
    expect(settings.matcapScale.cloth).toBe(DEFAULT_RENDER.matcapScale.cloth);
    expect(resolveRenderSettings('h1')).toBe(H1_RENDER);
  });
});
