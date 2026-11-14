/**
 * ① と ② で参加者画面の DOM が案内の文を除いて同じ（docs/design/two_ai/03 §3.2、§5.1）。
 * 同期の印は 06 §4.7 の 8 回で、再接続の送り直しと two_ai.phase(discussion) では出ない（第 4 回 M4、第 5 回 m3）。
 */
import { describe, expect, it } from 'vitest';
import { instructionText } from '../../src/session/two_ai_copy';
import { conditionRun } from './two_ai_harness';

function withoutInstruction(html: string, key: string): string {
  const text = instructionText(key) as string;
  return html.split(text).join('<<instruction>>');
}

describe('条件の間の DOM の同一性', () => {
  it('案内の文を除いて、すべての段の画面が同じ', () => {
    const a = conditionRun('discussion_a').htmls.map((h) => withoutInstruction(h, 'discussion_a'));
    const b = conditionRun('discussion_b').htmls.map((h) => withoutInstruction(h, 'discussion_b'));
    expect(a).toHaveLength(b.length);
    for (let i = 0; i < a.length; i += 1) expect(a[i], `段 ${i}`).toBe(b[i]);
  });

  it('案内の文だけは違う', () => {
    const a = conditionRun('discussion_a').htmls.join('\n');
    const b = conditionRun('discussion_b').htmls.join('\n');
    expect(a).toContain(instructionText('discussion_a'));
    expect(b).toContain(instructionText('discussion_b'));
    expect(a).not.toContain(instructionText('discussion_b'));
  });

  it('DOM に条件名が出ない（文にも属性にも）', () => {
    for (const key of ['discussion_a', 'discussion_b']) {
      const html = conditionRun(key).htmls.join('\n');
      for (const word of ['respond_on_spot', 'respond_at_end', '①', '②', 'condition', '条件']) expect(html).not.toContain(word);
    }
  });

  it('同期の印は 8 回（intake、段 1〜4、response、next_step、end）で、両条件で同じ時機に出る', () => {
    const runA = conditionRun('discussion_a');
    const runB = conditionRun('discussion_b');
    const keys = runA.harness.controller.record.syncMarks.map((m) => m.key);
    expect(keys).toEqual(['phase:intake', 'stage:1', 'stage:2', 'stage:3', 'stage:4', 'phase:response', 'phase:next_step', 'phase:end']);
    expect(runB.harness.controller.record.syncMarks.map((m) => m.key)).toEqual(keys);
    const flashes = (htmls: string[]) => htmls.map((h, i) => (h.includes('data-testid="sync-mark" data-on="yes"') ? i : -1)).filter((i) => i >= 0);
    expect(flashes(runA.htmls)).toHaveLength(8);
    expect(flashes(runA.htmls)).toEqual(flashes(runB.htmls));
  });
});
