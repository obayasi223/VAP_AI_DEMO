/** 閾値 null の扱い（docs/known_gaps.md §1）。原著の 0.2 と 0.8 へ黙って置き換えない。 */
import { describe, expect, it } from 'vitest';
import { present } from '@llm-vap/contracts';
import type { PolicyJa } from '@llm-vap/contracts';
import { createTurnManager, similarityGate, userTextFor } from '../../src/control';
import { Driver, T0, hri2025, ja, kinds, pick, preparing, transcript } from './helpers';

function fireWith(policy: Parameters<typeof createTurnManager>[0], sim: number | undefined) {
  const d = new Driver(policy);
  d.tick(T0, { text: '明日の会議は' });
  const decisions = d.tick(T0 + 200, sim === undefined ? {} : { sim });
  return { d, fired: pick(decisions, 'prepare').length === 1 };
}

describe('L47: similarity.threshold が null（ja の現状）', () => {
  it('config の ja は null のまま', () => {
    expect(ja().similarity.threshold).toBeNull();
  });
  it.each([
    ['0.8 を流用しない: 0.8 で起動', 0.8, true],
    ['0.85 で起動', 0.85, true],
    ['0.999 で起動', 0.999, true],
    ['1（正規化後に同じ文）は起動しない', 1, false],
  ])('%s', (_title, sim, fired) => {
    expect(fireWith(ja(), sim).fired).toBe(fired);
  });
  it('比較対象なしは起動', () => {
    expect(fireWith(ja(), undefined).fired).toBe(true);
  });
  it('判定の根拠を状態に残す', () => {
    expect(fireWith(ja(), 0.9).d.state.last_prepare_gate).toEqual({
      at: T0 + 200,
      fired: true,
      gate: { outcome: 'pass', basis: 'uncalibrated_text_differs', similarity: 0.9, threshold: null },
    });
    expect(fireWith(ja(), 1).d.state.last_prepare_gate?.gate.basis).toBe('uncalibrated_same_text');
  });
});

describe('L47: 閾値がある方策', () => {
  it.each([
    ['T5 hri2025: 0.8 ちょうどは起動しない', 0.8, false],
    ['hri2025: 0.7999 は起動', 0.7999, true],
  ])('%s', (_title, sim, fired) => {
    expect(fireWith(hri2025(), sim).fired).toBe(fired);
  });
  it('T5: 止めたとき last_sent は不変で、次の tick も再評価する', () => {
    const d = new Driver(hri2025());
    d.tick(T0, { text: '明日は' });
    expect(kinds(d.tick(T0 + 200, { sim: 0.8 }))).not.toContain('prepare');
    expect(d.state.last_sent_asr_result).toBeNull();
    expect(d.state.last_prepare_gate?.fired).toBe(false);
    expect(kinds(d.tick(T0 + 220, { sim: 0.79 }))).toContain('prepare');
  });
  it('ja に校正値が入れば、その値を使う', () => {
    const calibrated = ja((p) => { p.similarity.threshold = 0.6; });
    expect(fireWith(calibrated, 0.6).fired).toBe(false);
    expect(fireWith(calibrated, 0.59).fired).toBe(true);
  });
  it('turn.constants の同名の項目を読まない', () => {
    const p = ja((x) => {
      x.turn.constants.SIMILARITY_PREPARE_THRESHOLD = 0.01;
      x.turn.constants.TURNGPT_PREPARE_THRESHOLD = 0.99;
    });
    expect(fireWith(p, 0.9).fired).toBe(true);
    const d = new Driver(p);
    expect(kinds(d.tick(T0, { text: '明日', p_completion: 0.31 }))).toContain('prepare');
  });
  it('similarityGate の4通り', () => {
    expect(similarityGate(present(0.5), 0.8).basis).toBe('below_threshold');
    expect(similarityGate(present(0.8), 0.8).basis).toBe('at_or_above_threshold');
    expect(similarityGate(present(0.5), null).basis).toBe('uncalibrated_text_differs');
    expect(similarityGate(present(1), null).basis).toBe('uncalibrated_same_text');
  });
});

describe('L46: completion の閾値（prepareThresholds）', () => {
  const fired = (p: number, patch: (x: PolicyJa) => void = () => undefined) =>
    kinds(new Driver(ja(patch)).tick(T0, { text: '明日', p_completion: p })).includes('prepare');

  it('ja_rules_v1 は 0.3 を読む（原著の 0.2 ではない）', () => {
    expect(fired(0.25)).toBe(false);
    expect(fired(0.3)).toBe(false);
    expect(fired(0.31)).toBe(true);
  });
  it('null（未校正の推定器、推定器なし）では completion で起動せず、時間の条件だけが残る', () => {
    for (const estimator of ['llm_completion_v1', null]) {
      const patch = (x: PolicyJa) => { x.completion.estimator = estimator; };
      expect(fired(0.99, patch)).toBe(false);
      const d = new Driver(ja(patch));
      d.tick(T0, { text: '明日', p_completion: 0.99 });
      expect(pick(d.tick(T0 + 200, { p_completion: 0.99 }), 'prepare')[0]?.trigger).toBe('asr_timeout');
    }
  });
});

describe('STT の text は ASR 区間ごとなので segment の中で連結する', () => {
  it('final の後の interim で前の文を失わない', () => {
    const d = new Driver(ja());
    d.tick(T0, { transcript: present(transcript('明日の会議は三時です。', 1, { is_final: true })) });
    d.tick(T0 + 20, { transcript: present(transcript('場所は', 2, { asr_segment_id: 1 })) });
    expect(d.state.asr_result).toBe('明日の会議は三時です。場所は');
    expect(pick(d.tick(T0 + 220), 'prepare')[0]?.text).toBe('明日の会議は三時です。場所は');
  });
  it('final を tick の間に取り逃しても、最後に見た interim を閉じる', () => {
    const d = new Driver(ja());
    d.tick(T0, { transcript: present(transcript('明日の会議', 1)) });
    d.tick(T0 + 20, { transcript: present(transcript('場所', 3, { asr_segment_id: 1 })) });
    expect(d.state.asr_result).toBe('明日の会議場所');
  });
  it('同じ ASR 区間の書き換えは置き換える', () => {
    const d = new Driver(ja());
    d.tick(T0, { transcript: present(transcript('国。', 1)) });
    d.tick(T0 + 20, { transcript: present(transcript('国が？', 2)) });
    expect(d.state.asr_result).toBe('国が？');
  });
  it('userTextFor は step が見る文と同じ（J が類似度に使う）', () => {
    const d = new Driver(ja());
    d.tick(T0, { transcript: present(transcript('明日は。', 1, { is_final: true })) });
    const next = transcript('晴れ', 2, { asr_segment_id: 1 });
    const text = userTextFor(d.state, next);
    d.tick(T0 + 20, { transcript: present(next) });
    expect(text).toBe('明日は。晴れ');
    expect(d.state.asr_result).toBe(text);
  });
  it('句読点だけの文では準備しない', () => {
    const d = new Driver(ja());
    d.tick(T0, { transcript: present(transcript('。', 1)) });
    expect(d.state.asr_result).toBeNull();
    expect(kinds(d.tick(T0 + 500))).not.toContain('prepare');
  });
});

describe('準備の喪失（U の追加案。補正ありの方策のみ）', () => {
  function lostOnce(policy: Parameters<typeof createTurnManager>[0]) {
    const d = new Driver(policy);
    d.tick(T0, { text: '明日は' });
    d.tick(T0 + 200); // prepare
    d.tick(T0 + 220, { prefetch: preparing(7) });
    return d;
  }
  it('ja: 準備が失敗して消えたら同じ文で1回だけ再試行する', () => {
    const d = lostOnce(ja());
    expect(kinds(d.tick(T0 + 240))).toContain('prepare');
    d.tick(T0 + 260, { prefetch: preparing(8) });
    expect(kinds(d.tick(T0 + 280))).not.toContain('prepare');
    expect(kinds(d.tick(T0 + 500))).not.toContain('prepare');
  });
  it('hri2025: 擬似コードに再試行はない', () => {
    const d = lostOnce(hri2025());
    expect(kinds(d.tick(T0 + 240))).not.toContain('prepare');
  });
  it('ja: 再生に入って消えた準備は再試行しない', () => {
    const d = new Driver(ja());
    d.tick(T0, { text: '明日は', p: [0.3, 0.3, false] });
    d.tick(T0 + 200, { p: [0.3, 0.3, false] });
    d.tick(T0 + 220, { prefetch: preparing(7), p: [0.3, 0.3, false] });
    d.tick(T0 + 720, { prefetch: { state: 'ready', audio_playback_id: 7, segment_id: 0, transcript_revision: 1, started_at: 0 }, p: [0.6, 0.6, false] });
    expect(d.state.segment_id).toBe(1);
    expect(kinds(d.tick(T0 + 740))).not.toContain('prepare');
  });
});
