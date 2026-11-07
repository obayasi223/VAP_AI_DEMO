import { describe, expect, it } from 'vitest';
import { InitiativeDecisionKind } from '@llm-vap/contracts';
import { DECISIONS, INITIATIVE_JSON_SCHEMA, parseModelOutput } from '../model_output';
import { output } from './helpers';

describe('parseModelOutput', () => {
  it('列挙値は契約と同じ5つだけ', () => {
    expect([...DECISIONS].sort()).toEqual([...InitiativeDecisionKind.options].sort());
    expect(INITIATIVE_JSON_SCHEMA.properties.decision.enum).toEqual([...DECISIONS]);
  });
  it.each(['NO_INTENT', 'CLARIFY', 'none', ''])('%s は不合格', (decision) => {
    expect(parseModelOutput(JSON.stringify({ decision }))).toEqual({ ok: false, reason: 'model_output_unknown_decision' });
  });
  it('JSON でなければ不合格', () => {
    expect(parseModelOutput('NEW です')).toEqual({ ok: false, reason: 'model_output_not_json' });
  });
  it('正しい出力を受け取る', () => {
    const r = parseModelOutput(output({ decision: 'NEW', evidence_segment_ids: [1, 2] }));
    expect(r.ok && r.output.evidence_segment_ids).toEqual([1, 2]);
  });
});
