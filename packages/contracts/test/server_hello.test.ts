/** server.hello の mode で判別する共用体（docs/design/two_ai/06 §2.3）。 */
import { describe, expect, it } from 'vitest';
import { NodeToBrowser, ServerHello, toJsonSchema, type Condition } from '../src/index';

const oneToOne = { type: 'server.hello', protocol_version: 1, session_id: 's_1', condition: 'reactive', is_fake: false };
const twoAi = {
  type: 'server.hello',
  protocol_version: 1,
  mode: 'two_ai',
  session_id: 's_2',
  condition: null,
  is_fake: false,
  two_ai: { ai_ids: ['A', 'B'], avatar_keys: { A: 'a', B: 'b' }, labels: { A: 'アオイ', B: 'ハル' }, phase: 'intake' },
};

describe('server.hello', () => {
  it('1 対 1 の今の形（mode なし）が通る', () => {
    expect(ServerHello.parse(oneToOne)).toEqual(oneToOne);
    expect(NodeToBrowser.parse(oneToOne)).toEqual(oneToOne);
  });

  it("1 対 1 は mode: 'one_to_one' を付けても通る", () => {
    expect(NodeToBrowser.safeParse({ ...oneToOne, mode: 'one_to_one' }).success).toBe(true);
  });

  it("2 体は mode: 'two_ai' と condition: null で通る", () => {
    expect(NodeToBrowser.parse(twoAi)).toEqual(twoAi);
  });

  it('2 体の枝で condition が値を持つと不合格', () => {
    for (const condition of ['respond_on_spot', 'respond_at_end', 'reactive']) {
      expect(NodeToBrowser.safeParse({ ...twoAi, condition }).success, condition).toBe(false);
    }
  });

  it('1 対 1 の枝に two_ai を付けると不合格、2 体の枝で two_ai がないと不合格', () => {
    expect(NodeToBrowser.safeParse({ ...oneToOne, two_ai: twoAi.two_ai }).success).toBe(false);
    const { two_ai: _t, ...noBlock } = twoAi;
    expect(NodeToBrowser.safeParse(noBlock).success).toBe(false);
  });

  it('ai_ids は [A, B] の順に固定', () => {
    expect(NodeToBrowser.safeParse({ ...twoAi, two_ai: { ...twoAi.two_ai, ai_ids: ['B', 'A'] } }).success).toBe(false);
  });

  it('JSON Schema が作れる', () => {
    const schema = JSON.stringify(toJsonSchema('browser_rpc.node_to_browser'));
    expect(schema).toContain('"two_ai"');
    expect(schema).toContain('"one_to_one"');
  });

  it('型：message.condition は Condition | null（participant.ts と page.tsx が変えずに通る）', () => {
    const read = (m: ServerHello): Condition | null => m.condition;
    expect(read(ServerHello.parse(twoAi))).toBeNull();
    expect(read(ServerHello.parse(oneToOne))).toBe('reactive');
  });
});
