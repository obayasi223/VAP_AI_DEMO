import { describe, expect, it } from 'vitest';
import { checkBeats, chooseFacts, pointSpecs } from '../plan';
import { CORRECTED_TOLERANCE } from '../points';
import { checkStages } from '../stages';
import { C_CORE_SHORT, FICTIONAL, preparedScript, SLIP_STATEMENT, SLIP_VALUE, fakePlanOutput, feedIntake, makeRig, readyRig, testConfig, testScript } from './helpers';

const signal = () => new AbortController().signal;

describe('plan（02 §2.5(c)、§3.2）', () => {
  it('凍結した計画：4 段、点の 2 版、板の 2 版、作り直し、撤回。plan_hash は内容で決まる', async () => {
    const a = await readyRig();
    const b = await readyRig();
    await a.gen.stagesIdle();
    const pa = a.gen.frozenPlan()!;
    expect(pa.plan_hash).toBe(b.gen.frozenPlan()!.plan_hash);
    expect(pa.points.map((p) => p.point_id)).toEqual(['F1', 'K1', 'C1']);
    expect(pa.board.map((c) => c.order)).toEqual([1, 2, 3, 4]);
    expect(pa.rebuild_turns.length).toBe(2);
    expect(pa.retraction?.fact).toContain(SLIP_STATEMENT);
    expect(pa.fact_slip_source).toBe('prior');
    const frozen = a.sink.ofType('two_ai.plan').filter((e) => e.stage === 'frozen' && e.reason === 'ok');
    expect(frozen.length).toBe(1);
    expect(frozen[0]!.plan_hash).toBe(pa.plan_hash);
    // 段ごとの計画：段 2〜4 は後から埋めた記録（同じ plan_id）
    const stages = a.sink.ofType('two_ai.plan').filter((e) => e.stage === 'frozen' && e.reason.startsWith('stage_beats_frozen'));
    expect(stages.map((e) => e.reason)).toEqual(['stage_beats_frozen: stage 2', 'stage_beats_frozen: stage 3', 'stage_beats_frozen: stage 4']);
    for (const e of stages) expect(e.plan_id).toBe(pa.plan_id);
  });

  it('段 1〜3 に optional がなく、各段に拍がある', async () => {
    const { gen } = await readyRig();
    const plan = gen.frozenPlan()!;
    expect(plan.beats.filter((b) => b.optional && b.stage !== 4)).toEqual([]);
    for (const s of [1, 2, 3, 4]) expect(plan.beats.some((b) => b.stage === s)).toBe(true);
    expect(checkStages([{ ...plan.beats[0]!, optional: true }])).toContain('beat b01: optional outside stage 4');
  });

  it('訂正後の版：取り違えた文と値が出ず、文字数は元の ±15% 以内。F と K の帯は同じ', async () => {
    const { gen } = await readyRig();
    const plan = gen.frozenPlan()!;
    const f = plan.points.find((p) => p.kind === 'fact_slip')!;
    for (const [i, t] of f.corrected_turns.entries()) {
      if (i > 0) expect(t.text.includes(SLIP_VALUE) || t.text.includes(SLIP_STATEMENT)).toBe(false);
      expect(Math.abs(t.chars - f.turns[i]!.chars)).toBeLessThanOrEqual(f.turns[i]!.chars * CORRECTED_TOLERANCE);
    }
    expect(f.uptake?.text).toBe('あ、インターンの締切は2月末なんですね。失礼しました。');
    for (const c of plan.board) expect(c.corrected_text.includes(SLIP_VALUE)).toBe(false);
    for (const t of plan.rebuild_turns) expect(t.text.includes(SLIP_VALUE)).toBe(false);
    const templates = (await import('../assets')).loadDiscussionAssets((await import('./helpers')).REPO_ROOT, testConfig()).templates;
    const bands = (k: string) => templates.points.find((p) => p.kind === k)!.turns.map((t) => t.target_chars.join('-'));
    expect(bands('fact_slip')).toEqual(bands('control_inference'));
    const k = plan.points.find((p) => p.kind === 'control_inference')!;
    expect(k.turns.map((t) => t.speaker)).toEqual(f.turns.map((t) => t.speaker));
  });

  it('推論の結論が主な選択（台帳の options）に向くなら不合格で、1 回だけ作り直す', async () => {
    const rig = makeRig({
      handlers: {
        discussion_plan: (r) => ({ text: fakePlanOutput(r, (o) => (o.fact_slip.conclusion = '大学院に進むのをやめる')) }),
      },
    });
    await feedIntake(rig.gen);
    const r = await rig.gen.finalizePlan(signal());
    expect(r.ok).toBe(false);
    expect(rig.llm.callsOf('discussion_plan').length).toBe(2);
    const failed = rig.sink.ofType('two_ai.plan').filter((e) => e.stage === 'failed');
    expect(failed.length).toBe(2);
    expect(failed[0]!.reason).toContain('main option');
    // 2 回目の要求は理由つき
    expect(rig.llm.callsOf('discussion_plan')[1]!.messages.at(-1)!.text).toContain('main option');
  });

  it('C の語が筋書きに漏れる、quote が逐語でない、話者が 3 拍続く、で不合格', async () => {
    for (const [patch, reason] of [
      [(o: any) => (o.beats[2].fallback_text = `${C_CORE_SHORT}の話をしてみます。二人で順番に考えてみたいと思います。`), 'c_term'],
      [(o: any) => (o.framing_C.quote = '自分で早く稼ぎたい'), 'quote is not verbatim'],
      [(o: any) => ((o.beats[1].speaker = 'A'), (o.beats[2].speaker = 'A')), 'same speaker 3 times'],
      [(o: any) => (o.board[0].corrected_text = '12月末に書類を出す'), 'slip text in corrected_text'],
    ] as const) {
      const rig = makeRig({ handlers: { discussion_plan: (r) => ({ text: fakePlanOutput(r, patch) }) } });
      await feedIntake(rig.gen);
      const res = await rig.gen.finalizePlan(signal());
      expect(res.ok).toBe(false);
      expect(rig.sink.ofType('two_ai.plan').filter((e) => e.stage === 'failed')[0]!.reason).toContain(reason);
    }
  });

  it('作り直しで合格すれば凍結する', async () => {
    const rig = makeRig({ handlers: { discussion_plan: (r, n) => (n === 1 ? { text: '{"beats": [' } : { text: fakePlanOutput(r) }) } });
    await feedIntake(rig.gen);
    const r = await rig.gen.finalizePlan(signal());
    expect(r.ok).toBe(true);
    expect(rig.sink.ofType('two_ai.plan').map((e) => `${e.stage}:${e.trigger}`)).toEqual(['requested:final', 'failed:final', 'requested:regenerate', 'frozen:regenerate']);
  });

  it('拍の検査：react が 3 拍続く', () => {
    const beat = (i: number, kind: 'react' | 'close') => ({ beat_id: `b${i}`, stage: 1 as const, speaker: (i % 2 ? 'A' : 'B') as 'A' | 'B', kind, intent: 'x', ledger_refs: [], target_chars: [15, 35] as [number, number], optional: false, fallback_text: 'なるほど、そうですね。考えてみます。', fallback_text_corrected: 'なるほど、そうですね。考えてみます。', live: true });
    expect(checkBeats([beat(1, 'react'), beat(2, 'react'), beat(3, 'react'), beat(4, 'close')]).some((r) => r.includes('react 3 times'))).toBe(true);
  });
});

describe('取り違えの事実の出どころ（06 §9.5）', () => {
  it('prior.facts → 台帳 → なし', async () => {
    const rig = makeRig();
    await feedIntake(rig.gen);
    const ledger = rig.gen.currentLedger();
    const withPrior = chooseFacts(testScript(), ledger, pointSpecs({ script: testScript(), templates: null as never }));
    expect(withPrior).toMatchObject({ source: 'prior', slip: { fact_id: 'prior_deadline' }, control: { fact_id: 'prior_info' } });
    const noPrior = testScript((s) => (s.prior.facts = []));
    expect(chooseFacts(noPrior, ledger, noPrior.planned_points)).toMatchObject({ source: 'ledger', slip: { fact_id: 'fact_1' }, control: { fact_id: 'fact_2' } });
    const none = chooseFacts(noPrior, { ...ledger, facts: [] }, noPrior.planned_points);
    expect(none).toEqual({ slip: null, control: null, source: 'none' });
  });

  it('事実がない intake でも計画が凍結し、fact_slip と対照は unavailable。プロンプトから fact_slip の節が消える', async () => {
    const rig = makeRig({
      script: testScript((s) => (s.prior.facts = [])),
      handlers: { ledger: () => ({ text: JSON.stringify({ ...FICTIONAL.ledger_output, facts: [] }) }) },
    });
    await feedIntake(rig.gen);
    const r = await rig.gen.finalizePlan(signal());
    expect(r).toMatchObject({ ok: true, fact_slip: 'unavailable', control_inference: 'unavailable', fact_slip_source: 'none', points_ok: false });
    const system = rig.llm.callsOf('discussion_plan')[0]!.system;
    expect(system).not.toContain('- fact_slip：');
    expect(system).not.toContain('- control_inference：');
    rig.gen.startDiscussion();
    expect(rig.gen.pendingPoints({ content_elapsed_ms: 0 }).filter((p) => p.state === 'unavailable').map((p) => p.point_id)).toEqual(['F1', 'K1']);
    expect(rig.gen.framingState('A').state.fact_slip).toBe('unavailable');
    expect(rig.gen.retractionScript().inference_form).toBe('none');
  });

  it('事実が 1 つなら対照の推論だけ unavailable（no_second_fact）', async () => {
    const rig = makeRig({
      script: testScript((s) => (s.prior.facts = s.prior.facts.slice(0, 1))),
      handlers: { ledger: () => ({ text: JSON.stringify({ ...FICTIONAL.ledger_output, facts: [] }) }) },
    });
    await feedIntake(rig.gen);
    const r = await rig.gen.finalizePlan(signal());
    expect(r).toMatchObject({ ok: true, fact_slip: 'available', control_inference: 'unavailable', fact_slip_source: 'prior' });
    expect(rig.gen.frozenPlan()!.unavailable_points).toEqual([{ point_id: 'K1', kind: 'control_inference', speaker: 'B', reason: 'no_second_fact' }]);
  });
});

describe('計画の待ちと予備（02 §3.1-7、§3.2-6）', () => {
  it('早い計画を、終わりの台帳で core と事実が同じなら再使用する', async () => {
    const rig = makeRig();
    await feedIntake(rig.gen);
    expect(rig.gen.planStatus().can_start_early).toBe(true);
    const early = await rig.gen.preparePlan(signal());
    expect(rig.gen.planStatus().state).toBe('early_ready');
    const final = await rig.gen.finalizePlan(signal());
    expect(final.ok && early.ok && final.plan_hash === early.plan_hash).toBe(true);
    expect(rig.llm.callsOf('discussion_plan').length).toBe(1);
    expect(rig.sink.ofType('two_ai.plan').at(-1)).toMatchObject({ stage: 'reused', trigger: 'final' });
  });

  it('core が変われば作り直す', async () => {
    let core = 'どっちを選んでも後悔しそう';
    const rig = makeRig({ handlers: { ledger: () => ({ text: JSON.stringify({ ...FICTIONAL.ledger_output, core: { id: 'core_1', text: core, evidence: [{ span: core, segment_ids: [5] }] } }) }) } });
    await feedIntake(rig.gen);
    await rig.gen.preparePlan(signal());
    core = '研究は楽しい';
    rig.gen.onUserUtterance({ role: 'user', text: 'やっぱり研究は楽しいです。', segment_id: 9, transcript_revision: 1, is_final: true, audio_frame_end: 0 }, { phase: 'intake', interjection_id: null });
    await rig.gen.ledgerIdle();
    await rig.gen.finalizePlan(signal());
    expect(rig.llm.callsOf('discussion_plan').length).toBe(2);
  });

  it('fallbackPlan の順：早い計画 → 台本の prepared＋予備の筋書き → 予備の筋書きだけ', async () => {
    // (1) 早い計画
    const a = makeRig();
    await feedIntake(a.gen);
    await a.gen.preparePlan(signal());
    expect(a.gen.fallbackPlan('timeout')).toMatchObject({ ok: true, source: 'generated' });
    // (3) prepared がなければ予備の筋書きだけ（generated の点は unavailable）
    const b = makeRig();
    await feedIntake(b.gen);
    const rb = b.gen.fallbackPlan('timeout');
    expect(rb).toMatchObject({ ok: true, source: 'fallback_outline', fact_slip: 'unavailable', control_inference: 'unavailable' });
    expect(b.gen.frozenPlan()!.beats[0]!.fallback_text).toBe('サトウさんは、どちらを選んでも後悔しそうということで迷っているんですよね。まずは、いまの状況を二人で整理してみます。');
    // 穴が埋まらなければ text_generic
    const c = makeRig();
    c.gen.fallbackPlan('timeout');
    expect(c.gen.frozenPlan()!.beats[0]!.fallback_text).toBe('まずは、いまのお話の状況を、二人で順番に整理してみますね。');
  });

  it('fallbackPlan(2)：台本の prepared の点は予備の筋書きでも使う', async () => {
    const rig = makeRig({ script: preparedScript() });
    const r = rig.gen.fallbackPlan('timeout');
    expect(r).toMatchObject({ ok: true, source: 'fallback_outline', fact_slip: 'available' });
    expect(rig.gen.frozenPlan()!.points.map((p) => p.point_id)).toEqual(['F1']);
  });
});
