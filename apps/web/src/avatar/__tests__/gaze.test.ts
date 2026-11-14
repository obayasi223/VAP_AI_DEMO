import { GazeReport } from '@llm-vap/contracts';
import { describe, expect, it } from 'vitest';
import { DEFAULT_GAZE, GAZE_SUPERSEDED_BEFORE_RENDER, GazeController, GazeLayer, GazeReporter } from '../gaze';
import { PoseFrame } from '../pose';
import { gazeGeometry, TWO_AI_LAYOUT } from '../stage_layout';
import { seededRng, SmoothDamp } from '../util';

function settle(controller: GazeController, ms = 2000) {
  let state = controller.update(0);
  for (let t = 0; t < ms; t += 16) state = controller.update(16);
  return state;
}

describe('SmoothDamp', () => {
  it('目標に収束し、ほぼ行き過ぎない', () => {
    const d = new SmoothDamp(0);
    let max = 0;
    for (let t = 0; t < 3000; t += 16) max = Math.max(max, d.update(10, 200, 16));
    expect(d.value).toBeCloseTo(10, 3);
    expect(max).toBeLessThan(10.05);
  });

  it('途中で目標が変わっても値が飛ばない', () => {
    const d = new SmoothDamp(0);
    for (let t = 0; t < 100; t += 16) d.update(10, 200, 16);
    const before = d.value;
    const after = d.update(-10, 200, 16);
    expect(Math.abs(after - before)).toBeLessThan(2);
    expect(after).toBeGreaterThan(before - 1);
  });

  it('フレーム間隔が変わっても同じ所へ着く', () => {
    const a = new SmoothDamp(0);
    const b = new SmoothDamp(0);
    for (let t = 0; t < 1000; t += 8) a.update(1, 100, 8);
    for (let t = 0; t < 1000; t += 66) b.update(1, 100, 66);
    expect(a.value).toBeCloseTo(b.value, 2);
  });
});

describe('GazeController', () => {
  it('初期状態はユーザーを見ていて動かない', () => {
    const c = new GazeController(seededRng(1));
    const s = c.update(16);
    expect(s).toMatchObject({ target: 'user', awayAmount: 0, eyeYawDeg: 0, headYawDeg: 0, settled: true });
  });

  it('そらすと揺らぎの範囲で目標へ着き、戻すと 0 に戻る', () => {
    const c = new GazeController(seededRng(2));
    expect(c.setTarget('away')).toBe(true);
    const away = settle(c);
    expect(away.settled).toBe(true);
    expect(away.awayAmount).toBe(1);
    const j = DEFAULT_GAZE.jitter;
    expect(away.eyeYawDeg).toBeGreaterThanOrEqual(DEFAULT_GAZE.awayEyeYawDeg * (1 - j));
    expect(away.eyeYawDeg).toBeLessThanOrEqual(DEFAULT_GAZE.awayEyeYawDeg * (1 + j));
    expect(away.headYawDeg).toBeGreaterThan(0);
    c.setTarget('user');
    const back = settle(c);
    expect(back.settled).toBe(true);
    expect(back.awayAmount).toBeCloseTo(0, 2);
    expect(back.eyeYawDeg).toBeCloseTo(0, 1);
  });

  it('同じ目標の再指定は何もしない', () => {
    const c = new GazeController(seededRng(3));
    expect(c.setTarget('user')).toBe(false);
    c.setTarget('away');
    const before = settle(c);
    expect(c.setTarget('away')).toBe(false);
    expect(settle(c, 200).eyeYawDeg).toBeCloseTo(before.eyeYawDeg, 2);
  });

  it('眼が先に動き、頭が遅れて付く', () => {
    const c = new GazeController(seededRng(4));
    c.setTarget('away');
    let s = c.update(16);
    for (let t = 0; t < 100; t += 16) s = c.update(16);
    expect(s.eyeYawDeg / DEFAULT_GAZE.awayEyeYawDeg).toBeGreaterThan(s.headYawDeg / DEFAULT_GAZE.awayHeadYawDeg);
  });

  it('途中で戻しても飛ばない（1フレームの変化が小さい）', () => {
    const c = new GazeController(seededRng(5));
    c.setTarget('away');
    let s = c.update(16);
    let maxHeadStep = 0;
    for (let t = 0; t < 120; t += 16) {
      const n = c.update(16);
      maxHeadStep = Math.max(maxHeadStep, Math.abs(n.headYawDeg - s.headYawDeg));
      s = n;
    }
    c.setTarget('user');
    for (let t = 0; t < 1500; t += 16) {
      const n = c.update(16);
      maxHeadStep = Math.max(maxHeadStep, Math.abs(n.headYawDeg - s.headYawDeg));
      s = n;
    }
    expect(maxHeadStep).toBeLessThan(2);
    expect(s.headYawDeg).toBeCloseTo(0, 1);
  });

  it('そらす向きは毎回少し変わる', () => {
    const c = new GazeController(seededRng(6));
    const seen = new Set<number>();
    for (let i = 0; i < 6; i += 1) {
      c.setTarget('away');
      seen.add(Math.round(settle(c).eyeYawDeg * 100));
      c.setTarget('user');
      settle(c);
    }
    expect(seen.size).toBeGreaterThan(3);
  });
});

describe('GazeLayer', () => {
  it('頭と首に分け、合計が指令に一致し、そらす間はカメラ補正を切る', () => {
    const c = new GazeController(seededRng(7));
    const layer = new GazeLayer(c, 0.4);
    c.setTarget('away');
    const frame = new PoseFrame();
    for (let t = 0; t < 2000; t += 16) {
      frame.begin();
      layer.update({ dtMs: 16, nowMs: t }, frame);
    }
    const head = frame.bones.get('head')!;
    const neck = frame.bones.get('neck')!;
    expect(((head.y + neck.y) * 180) / Math.PI).toBeCloseTo(layer.state.headYawDeg, 4);
    expect(neck.y / (head.y + neck.y)).toBeCloseTo(0.4, 4);
    expect(frame.eye.userWeight).toBe(0);
    expect(frame.eye.yawDeg).toBeCloseTo(layer.state.eyeYawDeg, 6);
  });
});

describe('GazeReporter', () => {
  it('描画後に1回だけ報告し、契約のスキーマに合う', () => {
    const reports: unknown[] = [];
    const r = new GazeReporter((report) => reports.push(GazeReport.parse(report)));
    r.rendered(1);
    expect(reports).toHaveLength(0);
    r.commanded('away', true);
    expect(reports).toHaveLength(0);
    r.rendered(100.5);
    r.rendered(116.5);
    expect(reports).toEqual([{ type: 'gaze.report', target: 'away', visible: true, client_t_ms: { value: 100.5 } }]);
  });

  it('背景タブでは null と理由を直ちに返し、見えた最初の描画でも報告する', () => {
    const reports: GazeReport[] = [];
    const r = new GazeReporter((report) => reports.push(GazeReport.parse(report)));
    r.commanded('away', false);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ visible: false, client_t_ms: { value: null } });
    r.rendered(200);
    expect(reports).toHaveLength(2);
    expect(reports[1]).toMatchObject({ visible: true, client_t_ms: { value: 200 } });
  });

  it('描画前に目標が変わったら、上書きされた目標を「未描画で上書き」として報告し、最後の目標を描画で報告する', () => {
    const reports: GazeReport[] = [];
    const r = new GazeReporter((report) => reports.push(GazeReport.parse(report)));
    r.commanded('away', true);
    r.commanded('user', true);
    r.rendered(10);
    expect(reports).toEqual([
      { type: 'gaze.report', target: 'away', visible: false, client_t_ms: { value: null, null_reason: GAZE_SUPERSEDED_BEFORE_RENDER } },
      { type: 'gaze.report', target: 'user', visible: true, client_t_ms: { value: 10 } },
    ]);
  });

  it('判断ごとに報告が1つ以上出る（3件の上書きでも消えない）', () => {
    const reports: GazeReport[] = [];
    const r = new GazeReporter((report) => reports.push(report));
    r.commanded('away', true);
    r.commanded('user', true);
    r.commanded('away', true);
    r.rendered(10);
    expect(reports.map((x) => `${x.target}:${x.visible}`)).toEqual(['away:false', 'user:false', 'away:true']);
  });

  it('背景タブで visible=false を出した目標は、上書きされても重ねて出さない', () => {
    const reports: GazeReport[] = [];
    const r = new GazeReporter((report) => reports.push(report));
    r.commanded('away', false);
    r.commanded('user', true);
    r.rendered(10);
    expect(reports.map((x) => [x.target, x.visible, x.client_t_ms.value === null ? (x.client_t_ms as { null_reason: string }).null_reason : x.client_t_ms.value])).toEqual([
      ['away', false, 'page_hidden_no_raf'],
      ['user', true, 10],
    ]);
  });
});

describe('GazeController の幾何（2 体。docs/design/two_ai/03 §2.3）', () => {
  const geometryA = gazeGeometry(TWO_AI_LAYOUT, 'A', 1.5);

  it('peer の目標で頭が幾何の角へ収束し、眼は 0（lookAt が相手の眼へ向ける）', () => {
    const c = new GazeController(seededRng(11), {}, geometryA);
    expect(c.setTarget('peer')).toBe(true);
    const s = settle(c);
    expect(s.target).toBe('peer');
    expect(s.headYawDeg).toBeCloseTo(geometryA.peer.headYawDeg, 2);
    expect(s.eyeYawDeg).toBeCloseTo(0, 6);
    expect(s.awayAmount).toBe(0);
  });

  it('user の目標は幾何の角に従う（体が回っているので頭を利用者へ回す）', () => {
    const c = new GazeController(seededRng(12), {}, geometryA);
    c.setTarget('peer');
    settle(c);
    c.setTarget('user');
    const s = settle(c);
    expect(s.headYawDeg).toBeCloseTo(geometryA.user.headYawDeg, 2);
    expect(s.headPitchDeg).toBeCloseTo(geometryA.user.headPitchDeg, 2);
  });

  it('読み込み後に setGeometry すると、初期の user の目標も幾何の角へ動く', () => {
    const c = new GazeController(seededRng(13));
    c.setGeometry(geometryA);
    expect(settle(c).headYawDeg).toBeCloseTo(geometryA.user.headYawDeg, 2);
  });

  it('away は awaySign の側へ、体の正面を基準に（A は −）', () => {
    const c = new GazeController(seededRng(14), {}, geometryA);
    c.setTarget('peer');
    settle(c);
    c.setTarget('away');
    const s = settle(c);
    expect(s.headYawDeg).toBeLessThan(0);
    expect(s.eyeYawDeg).toBeLessThan(0);
    expect(Math.abs(s.headYawDeg)).toBeLessThanOrEqual(DEFAULT_GAZE.awayHeadYawDeg * (1 + DEFAULT_GAZE.jitter) + 1e-9);
    expect(s.awayAmount).toBe(1);
  });

  it('幾何なしは従来の値と同じ（回帰）', () => {
    const c = new GazeController(seededRng(2));
    c.setTarget('away');
    const s = settle(c);
    // 従来の式: 目標 = 既定の大きさ × 揺らぎ（正の向き）
    const rng = seededRng(2);
    const vary = () => 1 + (rng() * 2 - 1) * DEFAULT_GAZE.jitter;
    const yawScale = vary();
    expect(s.eyeYawDeg).toBeCloseTo(DEFAULT_GAZE.awayEyeYawDeg * yawScale, 2);
    expect(s.headYawDeg).toBeCloseTo(DEFAULT_GAZE.awayHeadYawDeg * yawScale, 2);
    expect(s.eyePitchDeg).toBeCloseTo(DEFAULT_GAZE.awayEyePitchDeg * vary(), 2);
  });

  it('GazeLayer は peer の間もカメラ補正（lookAt）を使う', () => {
    const c = new GazeController(seededRng(15), {}, geometryA);
    const layer = new GazeLayer(c, 0.4);
    c.setTarget('peer');
    const frame = new PoseFrame();
    for (let t = 0; t < 2000; t += 16) {
      frame.begin();
      layer.update({ dtMs: 16, nowMs: t }, frame);
    }
    expect(frame.eye.userWeight).toBe(1);
    const head = frame.bones.get('head')!;
    const neck = frame.bones.get('neck')!;
    expect(((head.y + neck.y) * 180) / Math.PI).toBeCloseTo(geometryA.peer.headYawDeg, 2);
  });

  it('GazeReporter は peer も報告し、契約に合う', () => {
    const reports: GazeReport[] = [];
    const r = new GazeReporter((report) => reports.push(GazeReport.parse(report)));
    r.commanded('peer', true);
    r.rendered(42);
    expect(reports).toEqual([{ type: 'gaze.report', target: 'peer', visible: true, client_t_ms: { value: 42 } }]);
  });
});
