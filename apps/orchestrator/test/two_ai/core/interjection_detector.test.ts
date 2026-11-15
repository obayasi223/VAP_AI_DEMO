/** 本人の話し始めの検出（06 §7.4、01 §3.5）。純粋関数 stepInterjection。 */
import { describe, expect, it } from 'vitest';
import { OVERLAP_OFF, initialInterjectionState, stepInterjection } from '../../../src/two_ai/interjection';
import type { AttemptUpdate, InterjectionInput, InterjectionSettings, InterjectionSignal, InterjectionState } from '../../../src/two_ai/interjection';

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
  overlap: OVERLAP_OFF,
  attempt_merge_gap_ms: 300,
};
const SUSTAIN: InterjectionSettings = { ...S, overlap: { ...OVERLAP_OFF, enabled: true, sustain_ms: 700, sustain_p_now_mean_min: 0.4 } };
const vap = (vad: number, pn = 0.8, pf = 0.8): InterjectionInput => ({ vap: { p_now_user: pn, p_future_user: pf, vad_user: vad }, vap_freshness: 'fresh', mic_dbfs: -20, ai_playing: true });
const mic = (db: number): InterjectionInput => ({ vap: null, vap_freshness: 'stale', mic_dbfs: db, ai_playing: true });

function drive(inputs: [number, InterjectionInput][], settings = S): { signals: [number, InterjectionSignal][]; state: InterjectionState; attempts: [number, AttemptUpdate][] } {
  let state = initialInterjectionState();
  const signals: [number, InterjectionSignal][] = [];
  const attempts: [number, AttemptUpdate][] = [];
  for (const [t, i] of inputs) {
    const r = stepInterjection(state, i, t, settings);
    state = r.state;
    if (r.signal.kind !== 'none') signals.push([t, r.signal]);
    if (r.attempt !== null) attempts.push([t, r.attempt]);
  }
  return { signals, state, attempts };
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

describe('重なりの中の検出（overlap）', () => {
  // 実測の止めそこねに近い形：vad は 1、p_now は 0.5 前後、p_future は 0.3〜0.45 で、通常の and に届かない。
  const hesitant = (ai = true): InterjectionInput => ({ vap: { p_now_user: 0.48, p_future_user: 0.38, vad_user: 1 }, vap_freshness: 'fresh', mic_dbfs: -20, ai_playing: ai });

  it('enabled: false（既定）なら従来どおり発火しない', () => {
    expect(drive(ticks(0, 2000, hesitant())).signals.filter(([, x]) => x.kind === 'onset')).toHaveLength(0);
  });

  it('持続の経路：声が sustain_ms 続き p_now の平均が下限以上なら onset（rule: overlap_sustain）', () => {
    const { signals } = drive(ticks(0, 2000, hesitant()), SUSTAIN);
    expect(signals).toHaveLength(1);
    expect(signals[0]![0]).toBe(700);
    expect(signals[0]![1]).toMatchObject({ kind: 'onset', rule: 'overlap_sustain', first_voiced_at: 0 });
  });

  it('持続の経路は AI が話していないときは使わない', () => {
    expect(drive(ticks(0, 2000, hesitant(false)), SUSTAIN).signals.filter(([, x]) => x.kind === 'onset')).toHaveLength(0);
  });

  it('相づち程度の短い声（600 ms）は持続の経路に届かず sub_threshold', () => {
    const r = drive([...ticks(0, 600, hesitant()), [600, vap(0.1)]], SUSTAIN);
    expect(r.signals.map(([, x]) => x.kind)).toEqual(['sub_threshold']);
  });

  it('エコーの形（vad だけ高く p_now_user が低い）は平均の下限で落とす', () => {
    const echo: InterjectionInput = { vap: { p_now_user: 0.15, p_future_user: 0.2, vad_user: 0.9 }, vap_freshness: 'fresh', mic_dbfs: -40, ai_playing: true };
    expect(drive(ticks(0, 3000, echo), SUSTAIN).signals.filter(([, x]) => x.kind === 'onset')).toHaveLength(0);
  });

  it('mic_dbfs_min：重なりの中の追加の経路に mic の音量の下限を課す', () => {
    const quiet: InterjectionInput = { ...hesitant(), mic_dbfs: -45 };
    const st: InterjectionSettings = { ...SUSTAIN, overlap: { ...SUSTAIN.overlap, mic_dbfs_min: -35 } };
    expect(drive(ticks(0, 2000, quiet), st).signals.filter(([, x]) => x.kind === 'onset')).toHaveLength(0);
    expect(drive(ticks(0, 2000, hesitant()), st).signals[0]![1]).toMatchObject({ rule: 'overlap_sustain' });
  });

  it('閾値の差し替え：重なりの中だけ p の閾値を下げる（rule: overlap_threshold）。通常の条件を満たせば p_threshold', () => {
    const st: InterjectionSettings = { ...S, overlap: { ...OVERLAP_OFF, enabled: true, p_now_user_min: 0.45, p_future_user_min: 0.3 } };
    expect(drive(ticks(0, 600, hesitant()), st).signals[0]![1]).toMatchObject({ kind: 'onset', rule: 'overlap_threshold' });
    expect(drive(ticks(0, 600, hesitant(false)), st).signals.filter(([, x]) => x.kind === 'onset')).toHaveLength(0);
    expect(drive(ticks(0, 600, vap(0.9)), st).signals[0]![1]).toMatchObject({ rule: 'p_threshold' });
  });
});

describe('試み（attempt）', () => {
  it('声の始まりで started、merge_gap_ms 静かなら ended。短い切れ目はつなぐ。onset と最大値を持つ', () => {
    const seq: [number, InterjectionInput][] = [
      ...ticks(0, 300, vap(0.9, 0.3, 0.3)),
      ...ticks(300, 400, vap(0.1)), // 100 ms の切れ目（つなぐ）
      ...ticks(400, 900, vap(0.9, 0.7, 0.6)),
      ...ticks(900, 1300, vap(0.1)),
    ];
    const r = drive(seq);
    expect(r.attempts.map(([t, a]) => [t, a.kind])).toEqual([
      [0, 'started'],
      [1180, 'ended'],
    ]);
    const ended = r.attempts[1]![1];
    if (ended.kind !== 'ended') throw new Error('ended');
    expect(ended.stats).toMatchObject({ started_at: 0, ended_at: 880, p_now_user_max: 0.7, p_future_user_max: 0.6, vad_user_max: 0.9, ai_playing_at_start: true, onset: { at: 600, rule: 'p_threshold' } });
    // 声の tick の長さ：0〜280 と 400〜880（切れ目を除く）。
    expect(ended.stats.voiced_ms).toBe(760);
    expect(ended.stats.overlap_ms).toBe(760);
  });

  it('onset に届かない試みも ended を出す（onset: null）', () => {
    const r = drive([...ticks(0, 400, vap(0.9, 0.2, 0.2)), ...ticks(400, 800, vap(0.1))]);
    const ended = r.attempts.find(([, a]) => a.kind === 'ended')![1];
    expect(ended.kind === 'ended' && ended.stats.onset).toBeNull();
  });

  it('fallback（VAP が stale）だけの試みは p の最大値が null', () => {
    const r = drive([...ticks(0, 500, mic(-30)), ...ticks(500, 900, mic(-60))]);
    const ended = r.attempts.find(([, a]) => a.kind === 'ended')![1];
    expect(ended.kind === 'ended' && ended.stats).toMatchObject({ p_now_user_max: null, mic_dbfs_max: -30, onset: { rule: 'fallback' } });
  });
});
