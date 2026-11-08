/**
 * 遷移表の全経路（from × to × 原因の全組み合わせ）。期待は仕様 §4 の図と計画 §4.6 から手で写した表で、
 * 実装の表（transitions.ts）から作っていない。
 */
import { describe, expect, it } from 'vitest';
import { CandidateCause, CandidateState } from '@llm-vap/contracts';
import { checkTransition, transitionTable } from '../../../src/control/candidates';
import type { TransitionCause } from '../../../src/control/candidates';

const WITHDRAW = ['model_decision', 'expired', 'evidence_lost', 'stale_result', 'normal_response_started', 'woz'];
const SPEAK = ['turn_allowed', 'invitation', 'woz'];

/** 'from>to' → 許す原因。ここにない組は全部拒否。 */
const EXPECTED: Record<string, string[]> = {
  'null>INTENT_READY': ['model_decision'],
  'null>WITHDRAWN': ['active_candidate_exists'],
  'INTENT_READY>BREATH_INHALE': ['signal_gate_allowed'],
  'INTENT_READY>SPEAKING': SPEAK,
  'INTENT_READY>WITHDRAWN': WITHDRAW,
  'BREATH_INHALE>BREATH_HOLD_OR_READY': ['inhale_completed'],
  'BREATH_INHALE>WITHDRAWN': WITHDRAW,
  'BREATH_HOLD_OR_READY>SPEAKING': SPEAK,
  'BREATH_HOLD_OR_READY>DEFERRED': ['user_continued'],
  'BREATH_HOLD_OR_READY>WITHDRAWN': WITHDRAW,
  'DEFERRED>SPEAKING': SPEAK,
  'DEFERRED>WITHDRAWN': WITHDRAW,
  'SPEAKING>SPOKEN': ['speech_finished', 'speech_interrupted'],
  'SPEAKING>WITHDRAWN': ['speech_failed', 'speech_no_audio'],
};

const FROMS: (CandidateState | null)[] = [null, ...CandidateState.options];
const CAUSES: TransitionCause[] = [...CandidateCause.options, 'model_decision'];

const rows: [string, TransitionCause, boolean][] = [];
for (const from of FROMS) {
  for (const to of CandidateState.options) {
    for (const cause of CAUSES) {
      const key = `${from}>${to}`;
      rows.push([key, cause, EXPECTED[key]?.includes(cause) ?? false]);
    }
  }
}

describe('遷移表（既定: 再合図なし）', () => {
  it('SPEAKING → WITHDRAWN は D の報告（失敗、無音）だけ。モデルの判断や通常の撤回では許さない', () => {
    expect(checkTransition('SPEAKING', 'WITHDRAWN', 'speech_failed')).toEqual({ ok: true });
    expect(checkTransition('SPEAKING', 'WITHDRAWN', 'speech_no_audio')).toEqual({ ok: true });
    for (const cause of ['model_decision', 'expired', 'normal_response_started'] as const) {
      expect(checkTransition('SPEAKING', 'WITHDRAWN', cause)).toMatchObject({ ok: false, reason: 'cause_not_allowed' });
    }
  });

  it(`全 ${rows.length} 通り`, () => {
    const mismatches: string[] = [];
    for (const [key, cause, allowed] of rows) {
      const [fromRaw, to] = key.split('>') as [string, CandidateState];
      const from = fromRaw === 'null' ? null : (fromRaw as CandidateState);
      const got = checkTransition(from, to, cause);
      if (got.ok !== allowed) mismatches.push(`${key}:${cause} expected ${allowed}`);
    }
    expect(mismatches).toEqual([]);
  });

  it.each([
    ['SPOKEN', 'WITHDRAWN', 'expired', 'terminal_state'],
    ['WITHDRAWN', 'SPEAKING', 'turn_allowed', 'terminal_state'],
    ['INTENT_READY', 'INTENT_READY', 'woz', 'same_state'],
    ['INTENT_READY', 'DEFERRED', 'user_continued', 'INTENT_READY->DEFERRED'],
    ['BREATH_INHALE', 'DEFERRED', 'user_continued', 'BREATH_INHALE->DEFERRED'],
    ['DEFERRED', 'BREATH_INHALE', 'signal_gate_allowed', 'DEFERRED->BREATH_INHALE'],
  ] as const)('%s → %s（%s）は invalid_transition', (from, to, cause, detail) => {
    expect(checkTransition(from, to, cause)).toEqual({ ok: false, reason: 'invalid_transition', details: [detail] });
  });

  it('表にある遷移でも原因が違えば cause_not_allowed', () => {
    expect(checkTransition('BREATH_HOLD_OR_READY', 'SPEAKING', 'signal_gate_allowed')).toMatchObject({
      ok: false,
      reason: 'cause_not_allowed',
    });
  });

  it('表の一覧は期待と同じ経路を持つ', () => {
    const listed = Object.fromEntries(transitionTable().map((r) => [`${r.from}>${r.to}`, [...r.causes].sort()]));
    const expected = Object.fromEntries(Object.entries(EXPECTED).map(([k, v]) => [k, [...v].sort()]));
    expect(listed).toEqual(expected);
  });
});

describe('再合図（allow_recue）', () => {
  it('有効なら DEFERRED → BREATH_INHALE を signal_gate_allowed だけで許す', () => {
    const on = { allow_recue: true };
    expect(checkTransition('DEFERRED', 'BREATH_INHALE', 'signal_gate_allowed', on).ok).toBe(true);
    expect(checkTransition('DEFERRED', 'BREATH_INHALE', 'turn_allowed', on).ok).toBe(false);
    expect(checkTransition('DEFERRED', 'BREATH_INHALE', 'signal_gate_allowed').ok).toBe(false);
  });
});
