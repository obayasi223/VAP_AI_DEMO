import { describe, expect, it } from 'vitest';
import { FakeDiscussionLlm } from './fake_discussion_llm';
import { feedIntake, makeRig, readyRig, runDiscussion, testConfig, testScript } from './helpers';

const signal = () => new AbortController().signal;

describe('generator：列と段と板（02 §3.3、§2.8）', () => {
  it('点は段の拍の数で入り（F は段 1 の 1 拍の後、K は段 2 の 2 拍の後、C は段 3 の最初）、段の最後のターンにカードを付ける', async () => {
    const { gen } = await readyRig();
    const { turns } = await runDiscussion(gen);
    const firstOf = (id: string) => turns.findIndex((t) => t.point_id === id && t.turn_kind === 'point');
    const beatsBefore = (i: number, stage: number) => turns.slice(0, i).filter((t) => t.turn_kind === 'discussion' && t.discussion_stage === stage).length;
    expect(beatsBefore(firstOf('F1'), 1)).toBe(1);
    expect(turns[firstOf('K1')]!.discussion_stage).toBe(2);
    expect(beatsBefore(firstOf('K1'), 2)).toBe(2);
    expect(turns[firstOf('C1')]!.discussion_stage).toBe(3);
    expect(beatsBefore(firstOf('C1'), 3)).toBe(0);
    // 段は戻らない
    const stages = turns.map((t) => t.discussion_stage!);
    expect([...stages].sort((a, b) => a - b)).toEqual(stages);
    // カードは 4 枚、各段の最後のターンに 1 枚ずつ
    const cards = turns.filter((t) => t.board_card !== null);
    expect(cards.map((t) => t.board_card!.order)).toEqual([1, 2, 3, 4]);
    for (const t of cards) {
      const last = turns.filter((u) => u.discussion_stage === t.discussion_stage).at(-1)!;
      expect(last.turn_id).toBe(t.turn_id);
    }
    // 点のターンは凍結文
    expect(turns.filter((t) => t.point_id !== null).every((t) => t.text_origin === 'frozen')).toBe(true);
    expect(gen.isDone('discussion', { elapsed_ms: 0, content_elapsed_ms: 0 })).toBe(true);
  });

  it('同じ計画なら間（gap_hint_ms）は乱数の種で決まり、通しで同じ', async () => {
    const a = await runDiscussion((await readyRig()).gen);
    const b = await runDiscussion((await readyRig()).gen);
    expect(a.turns.map((t) => t.gap_hint_ms)).toEqual(b.turns.map((t) => t.gap_hint_ms));
  });

  it('at_frac の台本は中身の時計で入る', async () => {
    const script = testScript((s) => {
      s.planned_points = s.planned_points.filter((p: any) => p.kind === 'framing_C').map((p: any) => ({ ...p, trigger: { at_frac: 0.3 } }));
    });
    const { gen } = await readyRig({ script });
    let contentAtPoint = -1;
    let content = 0;
    const { turns } = await runDiscussion(gen, {
      onTurn: (t) => {
        if (t.point_id === 'C1' && t.turn_kind === 'point') contentAtPoint = content;
        content += t.gap_hint_ms + t.est_duration_ms;
      },
    });
    expect(turns.some((t) => t.point_id === 'C1')).toBe(true);
    expect(contentAtPoint).toBeGreaterThanOrEqual(0.3 * 240_000 - 20_000);
    expect(contentAtPoint).toBeLessThanOrEqual(0.3 * 240_000 + 20_000);
  });

  it('forcePendingPoints の後の最初の nextTurn は未開始の点', async () => {
    const { gen } = await readyRig();
    const t0 = await gen.nextTurn({ turn_id: 't0', content_elapsed_ms: 0, discussion_elapsed_ms: 0 }, signal());
    gen.onTurnPlayed({ turn_id: 't0', audio_playback_id: 0, spoken_text: t0.text, played_ms: 1, completed: true });
    gen.forcePendingPoints();
    const t1 = await gen.nextTurn({ turn_id: 't1', content_elapsed_ms: 1000, discussion_elapsed_ms: 1000 }, signal());
    expect(t1.point_id).toBe('F1');
    gen.onTurnPlayed({ turn_id: 't1', audio_playback_id: 1, spoken_text: t1.text, played_ms: 1, completed: true });
    const rest = await runDiscussion(gen);
    // 点がすべて出た後は close の拍だけ
    const afterPoints = rest.turns.slice(rest.turns.findLastIndex((t) => t.point_id !== null) + 1);
    expect(afterPoints.length).toBe(1);
    expect(gen.pendingPoints({ content_elapsed_ms: 0 }).every((p) => p.state === 'done')).toBe(true);
  });

  it('(d) の失敗 → 1 回作り直し → だめなら拍の fallback_text（記録 fallback）', async () => {
    const rig = await readyRig({ handlers: { discussion_turn: () => ({ error: 'boom' }) } });
    const t = await rig.gen.nextTurn({ turn_id: 't0', content_elapsed_ms: 0, discussion_elapsed_ms: 0 }, signal());
    expect(t.text_origin).toBe('fallback');
    expect(t.text).toBe(rig.gen.frozenPlan()!.beats[0]!.fallback_text);
    expect(rig.sink.ofType('two_ai.generation').at(-1)).toMatchObject({ stage: 'fallback', reason: 'boom' });
  });

  it('時間切れも同じ（timeout_ms）。安全の検査に当たれば作り直しを記録する', async () => {
    const rig = await readyRig({
      config: testConfig((c) => (c.generation.timeout_ms.discussion_turn = 100)),
      handlers: { discussion_turn: (_r, n) => (n === 1 ? { text: 'あなたは本当はどう思っているんでしょうね。二人で順番に考えてみます。' } : { hang: true }) },
    });
    const t = await rig.gen.nextTurn({ turn_id: 't0', content_elapsed_ms: 0, discussion_elapsed_ms: 0 }, signal());
    expect(t.text_origin).toBe('fallback');
    expect(rig.sink.ofType('two_ai.safety_blocked')[0]).toMatchObject({ rule: 'second_person', stage: 'turn', action: 'regenerate' });
    expect(rig.sink.ofType('two_ai.generation').at(-1)!.reason).toBe('timeout');
  });

  it('長すぎる文は帯の上限以下の最後の文末で切る', async () => {
    const long = '最初の文です。'.repeat(30);
    const rig = await readyRig({ handlers: { discussion_turn: () => ({ text: long }) } });
    const t = await rig.gen.nextTurn({ turn_id: 't0', content_elapsed_ms: 0, discussion_elapsed_ms: 0 }, signal());
    expect(t.text_origin).toBe('llm');
    expect([...t.text].length).toBeLessThanOrEqual(100);
    expect(t.text.endsWith('。')).toBe(true);
  });

  it('次の拍を先に作る（02 §3.3-2）。待ちを打ち切ったら fallbackTurn は凍結文', async () => {
    const rig = await readyRig({ fake: { delay_ms: () => 30 } });
    const p0 = rig.gen.nextTurn({ turn_id: 't0', content_elapsed_ms: 0, discussion_elapsed_ms: 0 }, signal());
    const fb = rig.gen.fallbackTurn('t0');
    expect(fb.text_origin).toBe('fallback');
    expect((await p0).text).toBe(fb.text);
    expect(rig.sink.ofType('two_ai.generation').some((e) => e.stage === 'gap_overrun')).toBe(true);
  });

  it('nextTurn を中止したら、同じ位置を次の nextTurn で返す', async () => {
    const rig = await readyRig({ fake: { delay_ms: () => 50 } });
    const c = new AbortController();
    const p = rig.gen.nextTurn({ turn_id: 't0', content_elapsed_ms: 0, discussion_elapsed_ms: 0 }, c.signal);
    c.abort();
    await expect(p).rejects.toThrow('aborted');
    const t = await rig.gen.nextTurn({ turn_id: 't1', content_elapsed_ms: 0, discussion_elapsed_ms: 0 }, signal());
    expect(t.origin).toMatchObject({ kind: 'beat', beat_id: 'b01' });
    expect(t.index).toBe(0);
  });

  it('予備の筋書きでは LLM を呼ばない（text_origin: fallback）', async () => {
    const rig = makeRig();
    await feedIntake(rig.gen);
    rig.gen.fallbackPlan('timeout');
    rig.gen.startDiscussion();
    const { turns } = await runDiscussion(rig.gen);
    expect(turns.every((t) => t.text_origin === 'fallback')).toBe(true);
    expect(rig.llm.callsOf('discussion_turn').length).toBe(0);
  });

  it('定型：段の台詞、つなぎ、最後の段の問い、選ぶ案内、受け止め', async () => {
    const { gen } = await readyRig({ condition: 'respond_on_spot' });
    expect(gen.phaseLine('intake', 'close')).toMatchObject({ ai_id: 'A', line_id: 'opening_two' });
    expect(gen.phaseLine('intake', 'close')!.text).toContain('サトウさん');
    expect(gen.phaseLine('discussion', 'open')).toMatchObject({ ai_id: 'B', line_id: 'opening_cond.respond_on_spot' });
    expect(gen.phaseLine('response', 'open')).toBeNull();
    expect(gen.planFiller(0)?.ai_id).toBe('A');
    expect(gen.planFiller(1)?.ai_id).toBe('B');
    expect(gen.closingQuestion().text).not.toContain('サトウ');
    expect(gen.pickLine('timeout').line_id).toBe('pick_timeout');
    expect(gen.ackTemplates()[0]!.template_id).toBe('ack_1');
    expect(gen.stageHeadings()).toEqual(['いまの状況', '選択肢を並べる', '別の見方', '次の一歩']);
  });

  it('作り直しは訂正の有無にかかわらず訂正後の板', async () => {
    const { gen } = await readyRig();
    const r = gen.closingRebuild();
    expect(r.board.map((c) => c.variant)).toEqual(['corrected', 'corrected', 'corrected', 'corrected']);
    expect(r.board[0]!.text).toBe('2月末までにインターンの書類を出す');
    expect(r.turns.every((t) => t.turn_kind === 'rebuild' && t.text_origin === 'frozen')).toBe(true);
    expect(r.turns[0]!.text).toContain('2月末までにインターンの書類を出す');
  });

  it('分類：相づち、内容、決まらない', async () => {
    const { gen } = makeRig();
    expect(gen.classifyUserUtterance({ text: 'うん', is_final: true, voiced_ms: 300 })).toBe('backchannel');
    expect(gen.classifyUserUtterance({ text: '', is_final: false, voiced_ms: 300 })).toBe('backchannel');
    expect(gen.classifyUserUtterance({ text: '', is_final: false, voiced_ms: 2000 })).toBe('unknown');
    expect(gen.classifyUserUtterance({ text: '締切は', is_final: false, voiced_ms: 800 })).toBe('unknown');
    expect(gen.classifyUserUtterance({ text: 'いや、締切は2月末です', is_final: true, voiced_ms: 1500 })).toBe('content');
  });

  it('FakeDiscussionLlm は用途ごとに呼び出しを残す', () => {
    const llm = new FakeDiscussionLlm({});
    expect(llm.callsOf('intake')).toEqual([]);
  });
});
