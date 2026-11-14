/**
 * 黄金のプロンプト（02 §5）。架空の台帳から組んだ文字列の写しと比べる。版を上げたときだけ写しを更新する（vitest -u）。
 * 禁止の項目（本人の話し合い中の発言、C の語、取り違えた値）が (d) の入力に入っていないことを、写しとは別に検査する。
 */
import { describe, expect, it } from 'vitest';
import type { LlmMessage } from '@llm-vap/contracts';
import { loadDiscussionAssets } from '../assets';
import { buildCorrectionPrompt } from '../correction_assist';
import { IntakeTracker, buildIntakeSystem, missingSlots } from '../intake';
import { buildLedgerPrompt, emptyLedger, mergeLedgerOutput } from '../ledger';
import { buildPlanPrompt, chooseFacts, planNeeds, pointSpecs } from '../plan';
import { safeLedger } from '../safety';
import { buildTurnPrompt } from '../turn_prompt';
import { C_CORE, C_CORE_SHORT, FICTIONAL, REPO_ROOT, SLIP_VALUE, readyRig, runDiscussion, testConfig, testScript } from './helpers';

function render(p: { system: string; messages: LlmMessage[] }): string {
  return `# system\n${p.system}\n\n# messages\n${p.messages.map((m) => `[${m.role}]\n${m.text}`).join('\n')}\n`;
}

const config = testConfig();
const script = testScript();
const assets = loadDiscussionAssets(REPO_ROOT, config);
const base = emptyLedger({ aspect: script.aspect, user_name: script.user_name, user_name_reading: script.user_name_reading });
const ledger = mergeLedgerOutput(base, FICTIONAL.ledger_output, FICTIONAL.utterances)!.ledger;

describe('golden prompts', () => {
  it('(a) intake_v1', async () => {
    const t = new IntakeTracker(config, 0);
    const system = buildIntakeSystem({ aspect: script.aspect, missing: missingSlots(t.view(base)), fixed_question: null, remaining_sec: 100, phase_hint: '' });
    await expect(render({ system, messages: [{ role: 'user', text: FICTIONAL.utterances[0]!.text }] })).toMatchFileSnapshot('./golden/intake_v1.txt');
  });

  it('(b) ledger_v1', async () => {
    await expect(render(buildLedgerPrompt(base, FICTIONAL.utterances))).toMatchFileSnapshot('./golden/ledger_v1.txt');
  });

  it('(c) plan_v1（1 回で全部の拍）', async () => {
    const deps = { config, script, ...assets, plan_mode: 'single' as const };
    const safe = safeLedger(ledger, assets.safety).ledger;
    const facts = chooseFacts(script, safe, pointSpecs(deps));
    await expect(render(buildPlanPrompt(deps, safe, facts, planNeeds(deps, facts)))).toMatchFileSnapshot('./golden/plan_v1.txt');
  });

  it('(c) plan_v1_staged（段 1 の拍と点・板）', async () => {
    const deps = { config, script, ...assets };
    const safe = safeLedger(ledger, assets.safety).ledger;
    const facts = chooseFacts(script, safe, pointSpecs(deps));
    await expect(render(buildPlanPrompt(deps, safe, facts, planNeeds(deps, facts)))).toMatchFileSnapshot('./golden/plan_v1_staged.txt');
  });

  it("(c') plan_stage_v1：実際の生成器が組んだ段 2 の要求", async () => {
    const rig = await readyRig();
    await runDiscussion(rig.gen, { max: 2 });
    const call = rig.llm.callsOf('discussion_plan').find((c) => c.system.includes('段 2 の拍を書きます'))!;
    await expect(render(call)).toMatchFileSnapshot('./golden/plan_stage_v1.txt');
    // C の中身と本人の発言は入らない
    expect(call.system).not.toContain(C_CORE_SHORT);
    for (const u of FICTIONAL.utterances) expect(call.system).not.toContain(u.text);
  });

  it('(d) turn_v1：実際の生成器が組んだ段 2 の最初の拍の要求', async () => {
    const rig = await readyRig();
    await runDiscussion(rig.gen, { max: 12 });
    const call = rig.llm.callsOf('discussion_turn').find((c) => /# このターンでやること\n\w+：段の拍b08の意図\n/u.test(c.system))!;
    await expect(render(call)).toMatchFileSnapshot('./golden/turn_v1.txt');
    // 旗 false：本人の発言の節と feed の指示がなく、C の語の禁止がある
    expect(call.system).not.toContain('話し合いの途中で言ったこと');
    expect(call.system).not.toContain('# このターンでは');
    expect(call.system).toContain(`次の見方を持ち出す：${C_CORE_SHORT}、${C_CORE}。`);
    // C の語と取り違えた値は、禁止の行の外（材料と履歴）に出ない
    const outsideBan = call.system.replace(/^- 次の見方を持ち出す：.*$/mu, '') + call.messages.map((m) => m.text).join('\n');
    expect(outsideBan).not.toContain(C_CORE_SHORT);
    // 取り違えの後の拍なので、材料の事実は取り違えた値でよい（訂正前）。ただし本人の発言は入らない
    for (const u of FICTIONAL.utterances) expect(outsideBan).not.toContain(u.text);
  });

  it('(d) turn_v1_feed（体験の旗）', async () => {
    const [A, B] = assets.personas.personas;
    const p = buildTurnPrompt({
      self: A,
      peer: B,
      user_name: 'サトウ',
      beat: { beat_id: 'b16', stage: 3, speaker: 'A', kind: 'develop', intent: '拍b16の意図', ledger_refs: [], target_chars: [60, 90], optional: false, fallback_text: 'x', fallback_text_corrected: 'x', live: true },
      material: ['研究は楽しい'],
      next_intents: ['拍b17の意図'],
      banned_c_phrases: null,
      banned_facts: [],
      history: [{ speaker_name: 'アオイ', text: '（架空の直前の発話）' }],
      after_point: true,
      fed_interjections: [{ label: '#1', text: '（架空の本人の割り込み）才能の話じゃなくて、締切の話なんです。' }],
      feed_turn: true,
    });
    expect(p.version).toBe('turn_v1_feed');
    expect(p.system).not.toContain('次の見方を持ち出す');
    expect(p.system).toContain('計画した見方を撤回したり弱めたりしない');
    await expect(render(p)).toMatchFileSnapshot('./golden/turn_v1_feed.txt');
  });

  it('(e) correction_v1', async () => {
    const p = buildCorrectionPrompt({ slip_statement: 'インターンの締切は12月末', correct_statement: 'インターンの締切は2月末', utterance: 'いや、2月末です。' });
    await expect(render(p)).toMatchFileSnapshot('./golden/correction_v1.txt');
    expect(p.system).toContain(SLIP_VALUE);
  });
});
