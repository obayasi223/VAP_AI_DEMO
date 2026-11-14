/** 本人の話し始めの検出（06 §7.4、01 §3.5）。純粋関数 stepInterjection。 */
import { describe, expect, it } from 'vitest';
import { initialInterjectionState, stepInterjection } from '../../../src/two_ai/interjection';
import type { InterjectionInput, InterjectionSettings, InterjectionSignal, InterjectionState } from '../../../src/two_ai/interjection';

const S: InterjectionSettings = {
  vad_threshold: 0.5,
  p_now_user_min: 0.5,
  p_future_user_min: 0.5,
  p_combine: 'and',
  onset_min_ms: 200,
  refractory_ms: 1000,
  fallback_dbfs: -40,
  fallback_onset_min_ms: 300,
  sub_threshold_min_ms: 100,
};
const vap = (vad: number, pn = 0.8, pf = 0.8): InterjectionInput => ({ vap: { p_now_user: pn, p_future_user: pf, vad_user: vad }, vap_freshness: 'fresh', mic_dbfs: -20, ai_playing: true });
const mic = (db: number): InterjectionInput => ({ vap: null, vap_freshness: 'stale', mic_dbfs: db, ai_playing: true });

function drive(inputs: [number, InterjectionInput][], settings = S): { signals: [number, InterjectionSignal][]; state: InterjectionState } {
  let state = initialInterjectionState();
  const signals: [number, InterjectionSignal][] = [];
  for (const [t, i] of inputs) {
    const r = stepInterjection(state, i, t, settings);
    state = r.state;
    if (r.signal.kind !== 'none') signals.push([t, r.signal]);
  }
  return { signals, state };
}
const ticks = (from: number, to: number, i: InterjectionInput): [number, InterjectionInput][] => {
  const out: [number, InterjectionInput][] = [];
  for (let t = from; t < to; t += 20) out.push([t, i]);
  return out;
};

describe('stepInterjection', () => {
  it('VAP が fresh：声が onset_min_ms 続き p が閾値以上で 1 回だけ onset', () => {
    const { signals } = drive(ticks(0, 1000, vap(0.9)));
    expect(signals).toHaveLength(1);
    const [t, s] = signals[0]!;
    expect(t).toBe(200);
    expect(s).toMatchObject({ kind: 'onset', source: 'vap', first_voiced_at: 0, detected_at: 200, p_now_user: 0.8 });
  });

  it('p_combine: and は片方が低いと発火しない、or なら発火する', () => {
    expect(drive(ticks(0, 600, vap(0.9, 0.8, 0.2))).signals.filter(([, s]) => s.kind === 'onset')).toHaveLength(0);
    expect(drive(ticks(0, 600, vap(0.9, 0.8, 0.2)), { ...S, p_combine: 'or' }).signals[0]![1].kind).toBe('onset');
  });

  it('条件に届かずに終わった声の連続は sub_threshold（短すぎる連続は何も出さない）', () => {
    const r = drive([...ticks(0, 160, vap(0.9, 0.1, 0.1)), [160, vap(0.1)]]);
    expect(r.signals).toEqual([[160, { kind: 'sub_threshold', first_voiced_at: 0, ended_at: 160 }]]);
    expect(drive([...ticks(0, 60, vap(0.9)), [60, vap(0.1)]]).signals).toEqual([]);
  });

  it('発火の後の連続の終わりは sub_threshold にしない', () => {
    const r = drive([...ticks(0, 400, vap(0.9)), [400, vap(0.1)]]);
    expect(r.signals.map(([, s]) => s.kind)).toEqual(['onset']);
  });

  it('refractory_ms の間の次の声は受けない。過ぎれば受ける', () => {
    const seq = [...ticks(0, 300, vap(0.9)), [300, vap(0.1)] as [number, InterjectionInput], ...ticks(320, 900, vap(0.9)), [900, vap(0.1)] as [number, InterjectionInput], ...ticks(1300, 1700, vap(0.9))];
    const onsets = drive(seq).signals.filter(([, s]) => s.kind === 'onset').map(([t]) => t);
    expect(onsets).toEqual([200, 1500]);
  });

  it('VAP が stale なら mic の dBFS で判定（fallback_onset_min_ms、p を見ない）', () => {
    const { signals } = drive(ticks(0, 800, mic(-30)));
    expect(signals).toHaveLength(1);
    expect(signals[0]![0]).toBe(300);
    expect(signals[0]![1]).toMatchObject({ kind: 'onset', source: 'fallback', p_now_user: null, mic_dbfs: -30 });
    expect(drive(ticks(0, 800, mic(-50))).signals).toEqual([]);
  });

  it('出どころが替わったら数え直す', () => {
    const seq = [...ticks(0, 200, mic(-30)), ...ticks(200, 600, vap(0.9))];
    const s = drive(seq).signals;
    expect(s).toHaveLength(1);
    expect(s[0]![1]).toMatchObject({ source: 'vap', first_voiced_at: 200, detected_at: 400 });
  });

  it('入力の状態を書き換えない（純粋）', () => {
    const st = initialInterjectionState();
    const copy = structuredClone(st);
    stepInterjection(st, vap(0.9), 0, S);
    expect(st).toEqual(copy);
  });
});
