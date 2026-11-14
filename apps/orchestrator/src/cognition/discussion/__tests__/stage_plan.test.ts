/**
 * 段ごとの計画（02 §2.5.1）：段 1 と点・板を先に凍結し、段 2〜4 の拍は話し合いの間に埋める。
 * 間に合わない段は定型の拍。拍の数・id・話者・kind は変わらず、点の日程と中身の時計は最初の凍結のまま。
 */
import { describe, expect, it } from 'vitest';
import { checkBeats } from '../plan';
import { safeLedger } from '../safety';
import { assembleStageBeats, buildStagePrompt } from '../stage_plan';
import { beatsPerStage } from '../stages';
import { fakePlanOutput, fakeStageOutput, isStageRequest, makeRig, readyRig, runDiscussion, signature, SLIP_STATEMENT, SLIP_VALUE, testConfig } from './helpers';

describe('段ごとの計画（02 §2.5.1）', () => {
  it('凍結の時点で段 2〜4 は定型の拍：段ごとの数、交互の話者、段 4 の最後は close、帯と並びの検査を通る', async () => {
    const rig = makeRig({ handlers: { discussion_plan: (r) => (isStageRequest(r) ? { hang: true } : { text: fakePlanOutput(r) }) } });
    const { feedIntake } = await import('./helpers');
    await feedIntake(rig.gen);
    expect((await rig.gen.finalizePlan(new AbortController().signal)).ok).toBe(true);
    const plan = rig.gen.frozenPlan()!;
    expect(plan.staged_stages).toEqual([2, 3, 4]);
    const per = beatsPerStage(testConfig());
    for (const s of [1, 2, 3, 4] as const) expect(plan.beats.filter((b) => b.stage === s).length).toBe(per[s - 1]);
    const later = plan.beats.filter((b) => b.stage > 1);
    for (let i = 1; i < later.length; i++) expect(later[i]!.speaker).not.toBe(later[i - 1]!.speaker);
    expect(plan.beats.at(-1)!.kind).toBe('close');
    expect(checkBeats(plan.beats)).toEqual([]);
    // 定型の拍は取り違える事実を材料にしない
    for (const b of later) expect(b.ledger_refs).not.toContain('prior_deadline');
    rig.gen.dispose();
  });

  it('段の呼び出しが間に合わない：その段が要るときに定型の拍に決めて記録し、最後まで話す。ターンの並びは埋まった場合と同じ形', async () => {
    const hung = makeRig({ handlers: { discussion_plan: (r) => (isStageRequest(r) ? { hang: true } : { text: fakePlanOutput(r) }) } });
    const { feedIntake } = await import('./helpers');
    await feedIntake(hung.gen);
    await hung.gen.finalizePlan(new AbortController().signal);
    hung.gen.startDiscussion();
    const a = await runDiscussion(hung.gen);
    const reasons = hung.sink.ofType('two_ai.plan').map((e) => `${e.stage}:${e.reason}`);
    expect(reasons.filter((r) => r.includes('stage_beats_fallback'))).toEqual([
      'failed:stage_beats_fallback: stage 2: code-template beats kept: not ready when the stage was needed',
      'failed:stage_beats_fallback: stage 3: code-template beats kept: not ready when the stage was needed',
      'failed:stage_beats_fallback: stage 4: code-template beats kept: not ready when the stage was needed',
    ]);
    // 段 3 は段 2 が定型に決まってから呼ぶ（前の段が決まってから。段 2 の定型の拍を前の段として渡す）
    const stageCalls = hung.llm.callsOf('discussion_plan').filter(isStageRequest);
    expect(stageCalls.map((c) => /段 (\d) の拍を書きます/u.exec(c.system)?.[1])).toEqual(['2', '3', '4']);
    const filled = await readyRig();
    const b = await runDiscussion(filled.gen);
    const shape = (t: (typeof a.turns)[number]) => [t.speaker, t.turn_kind, t.point_id ?? '-', t.discussion_stage, t.board_card?.order ?? '-'].join('|');
    expect(a.turns.map(shape)).toEqual(b.turns.map(shape));
    // 点の文は同じ
    expect(a.turns.filter((t) => t.point_id !== null).map(signature)).toEqual(b.turns.filter((t) => t.point_id !== null).map(signature));
  });

  it('埋まった段の拍は話す前に差し替わり、同じ plan_id で記録される', async () => {
    const rig = await readyRig();
    await rig.gen.stagesIdle();
    const plan = rig.gen.frozenPlan()!;
    expect(plan.beats.filter((b) => b.stage > 1).every((b) => b.intent.startsWith('段の拍'))).toBe(true);
    const { turns } = await runDiscussion(rig.gen);
    expect(turns.some((t) => t.discussion_stage === 4 && t.turn_kind === 'discussion')).toBe(true);
    const calls = rig.llm.callsOf('discussion_plan').filter(isStageRequest);
    expect(calls.map((c) => /段 (\d) の拍を書きます/u.exec(c.system)?.[1])).toEqual(['2', '3', '4']);
    // 後の段の要求は前の段の決まった拍を含む
    expect(calls[2]!.system).toContain('段の拍b08の意図');
  });

  it('訂正の後に作る段：プロンプトが訂正を伝え、fallback_text も訂正後の文になる', async () => {
    const rig = await readyRig();
    await rig.gen.stagesIdle();
    const plan = rig.gen.frozenPlan()!;
    const deps = { config: testConfig(), script: null, ...(await import('../assets')).loadDiscussionAssets((await import('./helpers')).REPO_ROOT, testConfig()) };
    const ledger = safeLedger(rig.gen.currentLedger(), deps.safety).ledger;
    const p = buildStagePrompt(deps, ledger, plan, 3, { fact_state: 'corrected' });
    expect(p.system).toContain('すでに正した');
    const before = buildStagePrompt(deps, ledger, plan, 3, { fact_state: 'normal' });
    expect(before.system).toContain(SLIP_STATEMENT);
    // 出力の fallback_text に取り違えた値があっても、訂正の後は訂正後の文を使う
    const raw = JSON.parse(fakeStageOutput({ system: p.system } as never)) as { beats: Record<string, string>[] };
    raw.beats[0]!.fallback_text = `${raw.beats[0]!.fallback_text_corrected}締切は${SLIP_VALUE}でした。`.slice(0, 80);
    const r = assembleStageBeats(deps, ledger, plan, 3, raw, { fact_state: 'corrected' });
    expect(r.ok).toBe(true);
    if (r.ok) for (const b of r.beats) expect(b.fallback_text).toBe(b.fallback_text_corrected);
    // 訂正後の版に取り違えた値があれば不合格（定型の拍のまま）
    raw.beats[1]!.fallback_text_corrected = `締切は${SLIP_VALUE}だと思います。そこから考えてみたいです。もう少し具体的に整理してみます。`;
    expect(assembleStageBeats(deps, ledger, plan, 3, raw, { fact_state: 'corrected' }).ok).toBe(false);
  });

  it('数の合わない段の出力は不合格', async () => {
    const rig = await readyRig();
    await rig.gen.stagesIdle();
    const plan = rig.gen.frozenPlan()!;
    const deps = { config: testConfig(), script: null, ...(await import('../assets')).loadDiscussionAssets((await import('./helpers')).REPO_ROOT, testConfig()) };
    const ledger = safeLedger(rig.gen.currentLedger(), deps.safety).ledger;
    const r = assembleStageBeats(deps, ledger, plan, 2, { beats: [] }, { fact_state: 'normal' });
    expect(r.ok).toBe(false);
  });
});
