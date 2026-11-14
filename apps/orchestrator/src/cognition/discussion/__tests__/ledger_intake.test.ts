import { describe, expect, it } from 'vitest';
import { IntakeTracker, buildIntakeSystem, missingSlots, phaseHint } from '../intake';
import { emptyLedger, mergeLedgerOutput } from '../ledger';
import { FICTIONAL, feedIntake, makeRig, testConfig } from './helpers';

const base = emptyLedger({ aspect: 'どの道を選ぶか', user_name: 'サトウ', user_name_reading: 'サトウ' });

describe('ledger（02 §2.5(b)）', () => {
  it('逐語でない span の項目を捨て、逐語の項目は残す', () => {
    const output = {
      ...FICTIONAL.ledger_output,
      options: [
        { id: 'opt_1', text: '就職する', evidence: [{ span: '就職する', segment_ids: [1] }] },
        { id: 'opt_9', text: '起業', evidence: [{ span: '起業したいと思っています', segment_ids: [1] }] },
      ],
    };
    const r = mergeLedgerOutput(base, output, FICTIONAL.utterances)!;
    expect(r.rejected).toEqual(['opt_9']);
    expect(r.ledger.options.map((o) => o.id)).toEqual(['opt_1']);
    expect(r.ledger.ledger_version).toBe(1);
  });

  it('id を保ち、確定の印を引き継ぐ', () => {
    const first = mergeLedgerOutput(base, FICTIONAL.ledger_output, FICTIONAL.utterances)!.ledger;
    const confirmed = { ...first, core: { ...first.core!, confirmed: true } };
    const second = mergeLedgerOutput(confirmed, FICTIONAL.ledger_output, FICTIONAL.utterances)!.ledger;
    expect(second.core?.id).toBe('core_1');
    expect(second.core?.confirmed).toBe(true);
    expect(second.ledger_version).toBe(2);
  });

  it('読めない出力は null（更新の失敗）', () => {
    expect(mergeLedgerOutput(base, 'not json', FICTIONAL.utterances)).toBeNull();
  });

  it('走っている間の発話はまとめて 1 回にし、古い結果で新しい版を上書きしない', async () => {
    const rig = makeRig({ fake: { delay_ms: () => 5 } });
    for (const u of FICTIONAL.utterances) {
      rig.gen.onUserUtterance({ role: 'user', text: u.text, segment_id: u.segment_id, transcript_revision: 1, is_final: true, audio_frame_end: 0 }, { phase: 'intake', interjection_id: null });
    }
    await rig.gen.ledgerIdle();
    const calls = rig.llm.callsOf('ledger');
    expect(calls.length).toBe(2);
    // 2 回目は最新の発話まで含む
    expect(calls[1]!.messages[0]!.text).toContain('#6：');
    expect(rig.gen.currentLedger().ledger_version).toBe(2);
    expect(rig.sink.ofType('two_ai.ledger').filter((e) => e.stage === 'updated').length).toBe(2);
  });

  it('失敗は update_failed を残す', async () => {
    const rig = makeRig({ handlers: { ledger: () => ({ error: 'boom' }) } });
    await feedIntake(rig.gen);
    expect(rig.sink.ofType('two_ai.ledger').every((e) => e.stage === 'update_failed')).toBe(true);
  });
});

describe('intake（02 §2.5(a)、§3.1）', () => {
  const config = testConfig();

  it('枠と経過時間から missing_slots と phase_hint が決定的に決まる', () => {
    const t = new IntakeTracker(config, 0);
    expect(missingSlots(t.view(base))).toEqual(['overall', 'options', 'dropped', 'facts', 'core']);
    expect(phaseHint(0, config)).toBe('');
    expect(phaseHint(config.phases.intake.soft_sec * 1000, config)).toContain('最後の問い');
    const a = buildIntakeSystem({ aspect: 'x', missing: ['facts'], fixed_question: 'Q', remaining_sec: 30, phase_hint: '' });
    const b = buildIntakeSystem({ aspect: 'x', missing: ['facts'], fixed_question: 'Q', remaining_sec: 30, phase_hint: '' });
    expect(a).toBe(b);
  });

  it('事実の問いは固定の文で、同じ segment では重ねず、2 問目は 1 回だけ', () => {
    const t = new IntakeTracker(config, 0);
    const ledger = { ...base, options: [{ id: 'o', text: 'x', evidence: [], confirmed: false }], dropped_options: [{ id: 'd', text: 'y', reason: '', evidence: [], confirmed: false }] };
    t.onUserFinal(1);
    const q = config.fixed.lines.intake_fact_questions;
    expect(t.factQuestionFor(10, ledger)).toBe(q[0]);
    expect(t.factQuestionFor(10, ledger)).toBe(q[0]);
    expect(t.factQuestionFor(11, ledger)).toBe(q[1]);
    expect(t.factQuestionFor(12, ledger)).toBeNull();
  });

  it('事前の事実が 2 つあれば事実の枠を飛ばす', () => {
    const t = new IntakeTracker(config, 2);
    expect(missingSlots(t.view(base))).not.toContain('facts');
  });

  it('核の読み上げは 1 回だけ（定型の文。LLM を通さない）', async () => {
    const rig = makeRig();
    await feedIntake(rig.gen);
    const min = config.phases.intake.min_sec * 1000;
    expect(rig.gen.intakeReadbackDue({ elapsed_ms: min - 1 })).toBe(false);
    expect(rig.gen.intakeReadbackDue({ elapsed_ms: min })).toBe(true);
    const line = rig.gen.intakeLine('core_readback');
    expect(line.text).toBe('サトウさんがいちばん引っかかっているのは、どちらを選んでも後悔しそう、ということで合っていますか。');
    expect(rig.gen.intakeReadbackDue({ elapsed_ms: min })).toBe(false);
    expect(rig.llm.callsOf('intake').length).toBe(0);
  });

  it('最初の問いは定型の経路', () => {
    const rig = makeRig();
    expect(rig.gen.intakeLine('first_question').text).toBe('今日はどんなことについて話したいですか。');
  });
});
