import { describe, expect, it } from 'vitest';
import type { DiscussionTurn } from '../../../two_ai/content_port';
import type { DiscussionGenerator } from '../generator';
import { SLIP_STATEMENT, SLIP_VALUE, preparedScript, readyRig, runDiscussion } from './helpers';

const signal = () => new AbortController().signal;
let seq = 0;
async function next(gen: DiscussionGenerator, content = 0): Promise<DiscussionTurn> {
  return gen.nextTurn({ turn_id: `x${seq++}`, content_elapsed_ms: content, discussion_elapsed_ms: content }, signal());
}
function play(gen: DiscussionGenerator, t: DiscussionTurn, ms = t.est_duration_ms): void {
  gen.onTurnPlayed({ turn_id: t.turn_id, audio_playback_id: 1, spoken_text: t.text, played_ms: ms, completed: true });
}
/** 指定の点のターンまで進める（それより前は再生する）。 */
async function until(gen: DiscussionGenerator, pred: (t: DiscussionTurn) => boolean): Promise<DiscussionTurn> {
  for (let i = 0; i < 100; i++) {
    const t = await next(gen);
    if (pred(t)) return t;
    play(gen, t);
  }
  throw new Error('not found');
}
const isKey = (key: string) => (t: DiscussionTurn) => t.origin.kind === 'point' && t.origin.turn_key === key;

describe('planInterjection（02 §3.4）', () => {
  it('文の途中：戻りの句＋その文の頭から。repeat は戻りの句と言い直しの文字数', async () => {
    const { gen } = await readyRig();
    const t = await next(gen);
    const [s1, s2] = t.sentences;
    const prefix = s1! + [...s2!].slice(0, 3).join('');
    const plan = gen.planInterjection({ interrupted_turn_id: t.turn_id, spoken_prefix: prefix, last_speaker: t.speaker, mode: 'after_ack' });
    expect(plan.ack_speaker).toBe(t.speaker);
    expect(plan.resume!.text).toBe('話を戻すと、' + t.sentences.slice(1).join(''));
    expect(plan.resume!.repeat).toEqual({ bridge_chars: 6, restated_chars: 3 });
    expect(plan.resume!.turn_kind).toBe('resume');
    expect(plan.keep_queue).toBe(true);
  });

  it('文の境界：次の文から（言い直しは 0）。最後まで声に出ていれば resume なし', async () => {
    const { gen } = await readyRig();
    const t = await next(gen);
    const atBoundary = gen.planInterjection({ interrupted_turn_id: t.turn_id, spoken_prefix: t.sentences[0]!, last_speaker: t.speaker, mode: 'after_ack' });
    expect(atBoundary.resume!.repeat).toEqual({ bridge_chars: 6, restated_chars: 0 });
    const done = gen.planInterjection({ interrupted_turn_id: t.turn_id, spoken_prefix: t.text, last_speaker: t.speaker, mode: 'after_ack' });
    expect(done.resume).toBeNull();
  });

  it('AI 同士の間なら resume は null、受け止めは直前に話した AI', async () => {
    const { gen } = await readyRig();
    expect(gen.planInterjection({ interrupted_turn_id: null, spoken_prefix: '', last_speaker: 'B', mode: 'after_ack' })).toEqual({ ack_speaker: 'B', resume: null, keep_queue: true });
  });

  it('誤った停止：戻りの句なし（bridge_chars = 0）で文の頭から', async () => {
    const { gen } = await readyRig();
    const t = await next(gen);
    const plan = gen.planInterjection({ interrupted_turn_id: t.turn_id, spoken_prefix: [...t.text].slice(0, 4).join(''), last_speaker: t.speaker, mode: 'false_onset' });
    expect(plan.resume!.text).toBe(t.text);
    expect(plan.resume!.repeat).toEqual({ bridge_chars: 0, restated_chars: 4 });
  });

  it('resume の最中の割り込み：元の文の座標で言い直す', async () => {
    const { gen } = await readyRig();
    const t = await next(gen);
    const s1 = t.sentences[0]!;
    const r1 = gen.planInterjection({ interrupted_turn_id: t.turn_id, spoken_prefix: s1 + 'あ', last_speaker: t.speaker, mode: 'after_ack' }).resume!;
    // 戻りの句と 2 文目を全部話した後、3 文目の途中で止まった
    const spoken = '話を戻すと、' + t.sentences[1]! + 'もう';
    const r2 = gen.planInterjection({ interrupted_turn_id: r1.turn_id, spoken_prefix: spoken, last_speaker: t.speaker, mode: 'after_ack' }).resume!;
    expect(r2.text).toBe('話を戻すと、' + t.sentences.slice(2).join(''));
    expect(r2.repeat!.restated_chars).toBe(2);
  });

  it('点のブロックの途中：point_id は元のまま、ブロックの残りはそのまま話す', async () => {
    const { gen } = await readyRig();
    const c0 = await until(gen, isKey('C.0'));
    const plan = gen.planInterjection({ interrupted_turn_id: c0.turn_id, spoken_prefix: [...c0.text].slice(0, 10).join(''), last_speaker: c0.speaker, mode: 'after_ack' });
    expect(plan.resume!.point_id).toBe('C1');
    play(gen, c0, 100);
    play(gen, plan.resume!);
    const c1 = await next(gen);
    expect(c1.origin).toMatchObject({ kind: 'point', turn_key: 'C.1' });
  });
});

describe('訂正（02 §3.5、06 §6.2）', () => {
  it('F.0 の途中の訂正：drop_resume、準備済みの F.1 を訂正後の版に替え、以後に取り違えの文と値が出ない', async () => {
    const { gen } = await readyRig({ condition: 'respond_on_spot' });
    const f0 = await until(gen, isKey('F.0'));
    const f1prepared = await next(gen); // 先行して準備済み
    expect(f1prepared.point_variant).toBe('original');
    gen.onTurnPlayed({ turn_id: f0.turn_id, audio_playback_id: 1, spoken_text: 'そういえば', played_ms: 300, completed: false });
    const r = gen.applyCorrection('F1', 'woz_researcher', 'in_window', f0.turn_id);
    expect(r.drop_resume).toBe(true);
    expect(r.replace_point_turn_ids).toEqual([f1prepared.turn_id]);
    expect(r.uptake).toMatchObject({ turn_kind: 'uptake', text: 'あ、インターンの締切は2月末なんですね。失礼しました。', point_variant: 'corrected', fact_state: 'corrected' });
    expect(gen.scriptVariant()).toBe('corrected');
    const rest = await runDiscussion(gen);
    expect(rest.turns[0]).toMatchObject({ point_variant: 'corrected', origin: { turn_key: 'F.1' }, index: f1prepared.index });
    expect(rest.turns[1]).toMatchObject({ point_variant: 'corrected', origin: { turn_key: 'F.2' } });
    for (const t of rest.turns) {
      expect(t.text.includes(SLIP_VALUE) || t.text.includes(SLIP_STATEMENT)).toBe(false);
      if (t.board_card) expect(t.board_card.text.includes(SLIP_VALUE)).toBe(false);
    }
    const card1 = rest.turns.find((t) => t.board_card?.order === 1)!.board_card!;
    expect(card1).toMatchObject({ variant: 'corrected', text: '2月末までにインターンの書類を出す' });
    // 元の推論を話していない回の撤回の文
    const retraction = gen.retractionScript();
    expect(retraction.inference_form).toBe('not_spoken');
    expect(retraction.lines.length).toBe(3);
    expect(retraction.lines[1]!.text).toContain('する予定でしたが');
    expect(retraction.lines[0]!.text).toContain(SLIP_STATEMENT);
    // 2 回目の訂正は 01 が記録だけ（02 は受けない）
    expect(() => gen.applyCorrection('F1', 'woz_researcher', 'next_boundary', null)).toThrow();
  });

  it('F のブロックの後の訂正（next_boundary）：準備済みの生のターンの取り違えの材料を取り消す。撤回の文は spoken', async () => {
    const { gen } = await readyRig({ condition: 'respond_on_spot' });
    await until(gen, isKey('F.2')).then((t) => play(gen, t));
    const prepared = await next(gen);
    expect(prepared.fact_state).toBe('slipped');
    const r = gen.applyCorrection('F1', 'woz_researcher', 'next_boundary', null);
    expect(r.drop_resume).toBe(false);
    expect(r.invalidate_turn_ids).toEqual([prepared.turn_id]);
    const again = await next(gen);
    expect(again).toMatchObject({ index: prepared.index, fact_state: 'corrected' });
    expect(gen.retractionScript().inference_form).toBe('spoken');
  });

  it('prepared の台本でも訂正後の版に替わる', async () => {
    const { gen } = await readyRig({ condition: 'respond_on_spot', script: preparedScript() });
    const f0 = await until(gen, isKey('F.0'));
    gen.applyCorrection('F1', 'woz_researcher', 'in_window', f0.turn_id);
    const f1 = await next(gen);
    expect(f1.text).toBe('それなら、冬の説明会にも、申し込みがまだ十分に間に合いますね。');
  });
});

describe('abandonResume（06 §6.2 (3)、decisions_round5 m1、M2）', () => {
  it('F.1 の途中で時間切れ：F の残り（F.2）を言い直さず、ブロックの次のターンへ。credited_ms は F.2 の見込み', async () => {
    const { gen } = await readyRig({ condition: 'respond_on_spot' });
    const f1 = await until(gen, isKey('F.1'));
    gen.onTurnPlayed({ turn_id: f1.turn_id, audio_playback_id: 1, spoken_text: 'それなら', played_ms: 300, completed: false });
    const plan = gen.frozenPlan()!;
    const f2 = plan.points.find((p) => p.point_id === 'F1')!.turns[2]!;
    const r = gen.abandonResume(f1.turn_id, 'correction_hold_timeout');
    expect(r.credited_ms).toBe(Math.round((f2.chars / 7) * 1000));
    const rest = await runDiscussion(gen);
    expect(rest.turns[0]!.point_id).toBeNull();
    expect(rest.turns.some((t) => t.point_id === 'F1')).toBe(false);
    expect(gen.pendingPoints({ content_elapsed_ms: 0 }).find((p) => p.point_id === 'F1')!.state).toBe('done');
  });

  it('準備済みの F.2 も捨てて数える。後のターンの通し番号は ② と同じ', async () => {
    const a = await readyRig();
    const full = (await runDiscussion(a.gen)).turns;
    const { gen } = await readyRig({ condition: 'respond_on_spot' });
    const f1 = await until(gen, isKey('F.1'));
    const f2 = await next(gen);
    const r = gen.abandonResume(f1.turn_id, 'correction_judgment_failed');
    expect(r.credited_ms).toBe(f2.est_duration_ms);
    expect(gen.abandonedCredit()!.dropped_turn_keys).toEqual(['F.2']);
    const after = await next(gen);
    const expected = full[full.findIndex((t) => t.origin.kind === 'point' && t.origin.turn_key === 'F.2') + 1]!;
    expect(after.index).toBe(expected.index);
    expect(after.text).toBe(expected.text);
    expect(after.gap_hint_ms).toBe(expected.gap_hint_ms);
  });

  it('AI 同士の間（interrupted null）で F.1 を待たせていたら、F.1 も F.2 も言い直さない', async () => {
    const { gen } = await readyRig({ condition: 'respond_on_spot' });
    await until(gen, isKey('F.0')).then((t) => play(gen, t));
    const f1 = await next(gen);
    const r = gen.abandonResume(null, 'correction_hold_timeout');
    expect(r.credited_ms).toBeGreaterThan(f1.est_duration_ms);
    const t = await next(gen);
    expect(t.point_id).toBeNull();
  });

  it('F の外では何もしない', async () => {
    const { gen } = await readyRig({ condition: 'respond_on_spot' });
    const t = await next(gen);
    expect(gen.abandonResume(t.turn_id, 'correction_hold_timeout')).toEqual({ credited_ms: 0 });
  });
});

describe('撤回の文（02 §2.9）', () => {
  it('訂正がなく元の推論を話した回は spoken。3 文の穴埋めで、sha256 は文で決まる', async () => {
    const { gen } = await readyRig();
    await runDiscussion(gen);
    const r = gen.retractionScript();
    expect(r.inference_form).toBe('spoken');
    expect(r.point_ids).toEqual(['F1']);
    expect(r.lines.map((l) => l.ai_id)).toEqual(['B', 'B', 'B']);
    expect(r.lines[1]!.text).toContain('冬の説明会には、申し込みがもう間に合わないですね、春のオンラインの回だけ見ておけば足りそうです');
    const again = await readyRig();
    await runDiscussion(again.gen);
    expect(again.gen.retractionScript().sha256).toBe(r.sha256);
    expect(gen.framingState('A').state.fact_slip).toBe('retracted');
  });
});
