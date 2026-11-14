/** 参加者向けの文（docs/design/two_ai/03 §3.4、§5.1）。条件名が文にも鍵にも出ない。 */
import { describe, expect, it } from 'vitest';
import { allCopyStrings, INSTRUCTION_COPY, instructionText } from '../../src/session/two_ai_copy';

const FORBIDDEN = ['①', '②', 'respond_', '条件', 'on_spot', 'at_end', 'condition'];

describe('two_ai_copy', () => {
  it('すべての文と鍵に条件名が含まれない', () => {
    for (const text of allCopyStrings()) {
      for (const word of FORBIDDEN) expect(text, `${text} に ${word}`).not.toContain(word);
    }
  });

  it('discussion の 2 つの文は違い、他の段の文は 1 つずつ（条件で変わらない）', () => {
    expect(instructionText('discussion_a')).not.toBeNull();
    expect(instructionText('discussion_b')).not.toBeNull();
    expect(instructionText('discussion_a')).not.toBe(instructionText('discussion_b'));
    const keys = Object.keys(INSTRUCTION_COPY).filter((k) => !k.startsWith('discussion'));
    expect(keys.sort()).toEqual(['end', 'intake', 'next_step', 'response']);
  });

  it('設定の鍵（config/two_ai/session.ja.json）と 03 の別名で引ける。知らない鍵と null は null', () => {
    for (const key of ['intake', 'discussion_a', 'discussion_b', 'response', 'next_step', 'end']) expect(instructionText(key)).not.toBeNull();
    expect(instructionText('discussion_speak_anytime')).toBe(instructionText('discussion_a'));
    expect(instructionText('discussion_listen_first')).toBe(instructionText('discussion_b'));
    expect(instructionText('unknown_key')).toBeNull();
    expect(instructionText(null)).toBeNull();
  });
});
