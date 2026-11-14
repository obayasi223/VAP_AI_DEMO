/** 研究画面の two_ai の上りと ack（06 §3）。research_rpc は SCHEMAS にないので TS だけで試す（第 3 回 m6）。 */
import { describe, expect, it } from 'vitest';
import {
  NodeToResearch,
  ResearchConfigMessage,
  ResearchToNode,
  ResearchTwoAiArm,
  ResearchWoz,
  TwoAiWozDetail,
  WozAction,
} from '../src/index';

const wall = '2026-11-15T03:00:00.000Z';
const arm = {
  type: 'research.two_ai.arm',
  arm_id: 'arm_1',
  condition: 'respond_on_spot',
  script_id: 'demo_career',
  interjection_feeds_generation: null,
  session_index: 1,
  counterbalance_label: 'AB',
  operator: 'r1',
  client_wall_clock: wall,
};
const woz = { type: 'research.woz', woz_id: 'w_1', action: 'stop', point_id: null, operator: 'r1', client_wall_clock: wall };

describe('research.two_ai.arm', () => {
  it('合格例が通り、ResearchToNode にも入る', () => {
    expect(ResearchTwoAiArm.parse(arm)).toEqual(arm);
    expect(ResearchToNode.parse(arm)).toEqual(arm);
  });
  it.each(Object.keys(arm))('%s がないと不合格', (key) => {
    const copy: Record<string, unknown> = { ...arm };
    delete copy[key];
    expect(ResearchToNode.safeParse(copy).success).toBe(false);
  });
  it('1 対 1 の条件と未知の項目は不合格', () => {
    expect(ResearchToNode.safeParse({ ...arm, condition: 'reactive' }).success).toBe(false);
    expect(ResearchToNode.safeParse({ ...arm, session_index: 3 }).success).toBe(false);
    expect(ResearchToNode.safeParse({ ...arm, extra: 1 }).success).toBe(false);
  });
});

describe('research.woz', () => {
  it('7 つの操作がすべて通る', () => {
    expect(WozAction.options).toEqual(['stop', 'face_user', 'yield', 'resume', 'correction', 'advance_phase', 'abort']);
    for (const action of WozAction.options) {
      const value = { ...woz, action, point_id: action === 'correction' ? 'f1' : null };
      expect(ResearchToNode.parse(value), action).toEqual(value);
    }
  });
  it('未知の操作と point_id の欠けは不合格', () => {
    expect(ResearchWoz.safeParse({ ...woz, action: 'pause' }).success).toBe(false);
    const { point_id: _p, ...noPoint } = woz;
    expect(ResearchWoz.safeParse(noPoint).success).toBe(false);
  });
});

describe('ack と research.config', () => {
  it("woz.ack の recorded と arm.ack が NodeToResearch に通る", () => {
    const recorded = { type: 'research.woz.ack', woz_id: 'w_1', status: 'recorded', detail: 'condition_respond_at_end', phase: 'discussion' };
    expect(NodeToResearch.parse(recorded)).toEqual(recorded);
    const armed = { type: 'research.two_ai.arm.ack', arm_id: 'arm_1', status: 'armed', detail: 'ok' };
    expect(NodeToResearch.parse(armed)).toEqual(armed);
    expect(NodeToResearch.safeParse({ ...recorded, status: 'logged' }).success).toBe(false);
  });
  it('research.config は任意の 2 項目なしでも、ありでも通る', () => {
    const base = { type: 'research.config', policy_id: 'p', p_ai_index: 1, direction_status: 'measured', condition: 'reactive' };
    expect(ResearchConfigMessage.parse(base)).toEqual(base);
    const withTwoAi = {
      ...base,
      mode: 'two_ai',
      two_ai_armed: { arm_id: 'arm_1', condition: 'respond_at_end', script_id: 's', interjection_feeds_generation: true },
    };
    expect(ResearchConfigMessage.parse(withTwoAi)).toEqual(withTwoAi);
    expect(ResearchConfigMessage.parse({ ...base, mode: 'two_ai', two_ai_armed: null }).two_ai_armed).toBeNull();
  });
  it('woz.override の detail の形', () => {
    const detail = { woz_id: 'w_1', status: 'applied', reason: 'ok', phase: 'discussion', ai_speaking: 'A', point_id: null, condition_note: null };
    expect(TwoAiWozDetail.parse(detail)).toEqual(detail);
    expect(TwoAiWozDetail.safeParse({ ...detail, condition_note: 'other' }).success).toBe(false);
  });
});
