// 反実仮想の板（tools/two_ai_counterfactual）：記録の読み、編集、偽の LLM での作り直しと比べ。文は架空。
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BOARD_GEN_PROMPT_VERSION, type BoardGenInput } from '../../../apps/orchestrator/src/cognition/discussion/board_gen';
import type { SafetyLists } from '../../../apps/orchestrator/src/cognition/discussion/safety';
import { ProbeMockLlm } from '../../two_ai_probe/lib/mock_llm';
import { applyEdit, loadRecordedBoard, parseEdit, plannedCalls, renderMarkdown, runCounterfactual, similarity } from '../counterfactual';

const safety: SafetyLists = { banned_terms: [], person_terms: [], evaluation_terms: [] };

const input: BoardGenInput = {
  version: BOARD_GEN_PROMPT_VERSION,
  user_name: 'テスト',
  aspect: '進路',
  personas: [
    { ai_id: 'A', display_name: 'エー', lens_summary: '架空の見方' },
    { ai_id: 'B', display_name: 'ビー', lens_summary: '架空の見方' },
  ],
  items: [
    { id: 'core', kind: 'core', text: '架空の迷いごと', segment_ids: [], said_in: 'intake' },
    { id: 'val_7', kind: 'value', text: '架空の大事にしたいこと', segment_ids: [7], said_in: 'discussion' },
    { id: 'val_9', kind: 'value', text: '架空のもう一つの希望', segment_ids: [9], said_in: 'response' },
  ],
  transcript: [
    { who: 'A', text: '架空の発言その一', segment_id: null },
    { who: 'user', text: '架空の本人の発話', segment_id: 7 },
    { who: 'user', text: '架空の本人の応答', segment_id: 9 },
  ],
  draft: ([1, 2, 3, 4] as const).map((order) => ({ card_id: `c${order}`, order, discussion_stage: order, depends_on: 'none' as const, text: `下書き${order}`, corrected_text: `下書き${order}` })),
  fact: null,
  c_terms: [],
  max_chars: 40,
};

const card = (order: number, ids: string[]) => ({ card_id: `c${order}`, order, discussion_stage: order, depends_on: 'none', text: `架空の${order}を確かめる`, corrected_text: `架空の${order}を確かめる`, ledger_item_ids: ids, segment_ids: [] });

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'two-ai-cf-'));
  const ev = (o: Record<string, unknown>) => JSON.stringify({ event: 'two_ai.board_generated', stage: 'generated', ledger_version: 1, prompt_version: BOARD_GEN_PROMPT_VERSION, ...o });
  await writeFile(
    join(dir, 'events.jsonl'),
    [
      JSON.stringify({ event: 'two_ai.capture', stage: 'captured' }),
      ev({ board_id: 'board_1', trigger: 'ledger_update', input, cards: [1, 2, 3, 4].map((o) => card(o, ['val_7'])) }),
      ev({ board_id: 'board_2', trigger: 'closing', input, cards: [1, 2, 3, 4].map((o) => card(o, o % 2 ? ['val_7'] : ['val_9'])) }),
      ev({ board_id: 'board_3', trigger: 'ledger_update', input: null, cards: [] }),
      '',
    ].join('\n'),
  );
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('two_ai_counterfactual', () => {
  it('記録の板を読む（既定は最後の closing、input が伏せてある板は除く、board_id で選べる）', () => {
    expect(loadRecordedBoard(dir).board_id).toBe('board_2');
    expect(loadRecordedBoard(join(dir, 'events.jsonl'), 'board_1').board_id).toBe('board_1');
    expect(() => loadRecordedBoard(dir, 'board_3')).toThrow();
  });

  it('編集：足すと項目が増え、除くと項目と根拠の発話が写しから消える（元の入力は変わらない）', () => {
    const add = parseEdit({ add: 'fact:discussion:架空の新しい事情', remove: null, keep_transcript: false });
    expect(add).toEqual({ kind: 'add', item: { id: 'cf_add', kind: 'fact', text: '架空の新しい事情', said_in: 'discussion' } });
    expect(parseEdit({ add: 'value:時刻は 9:00', remove: null, keep_transcript: false })).toMatchObject({ item: { said_in: 'response', text: '時刻は 9:00' } });
    expect(() => parseEdit({ add: 'nope:x', remove: null, keep_transcript: false })).toThrow();
    expect(applyEdit(input, add).items.map((i) => i.id)).toEqual(['core', 'val_7', 'val_9', 'cf_add']);
    const removed = applyEdit(input, { kind: 'remove', item_id: 'val_7', keep_transcript: false });
    expect(removed.items.map((i) => i.id)).toEqual(['core', 'val_9']);
    expect(removed.transcript.map((t) => t.segment_id)).toEqual([null, 9]);
    expect(applyEdit(input, { kind: 'remove', item_id: 'val_7', keep_transcript: true }).transcript).toHaveLength(3);
    expect(input.items).toHaveLength(3);
    expect(() => applyEdit(input, { kind: 'remove', item_id: 'missing', keep_transcript: false })).toThrow();
  });

  it('類似度と呼び出しの見込み', () => {
    expect(similarity('同じ文', '同じ文')).toBe(1);
    expect(similarity('あいうえ', 'かきくけ')).toBe(0);
    expect(plannedCalls(5, true)).toEqual({ min: 10, max: 20 });
  });

  it('偽の LLM で N 回作り直して元の板と比べる（足した項目が根拠に入る）', async () => {
    const llm = new ProbeMockLlm();
    const recorded = loadRecordedBoard(dir);
    const edit = parseEdit({ add: 'value:discussion:架空の足した希望', remove: null, keep_transcript: false });
    const report = await runCounterfactual({ recorded, edit, n: 2, withBaseline: true, llm, safety, timeout_ms: 1000 });
    expect(llm.calls).toHaveLength(4);
    expect(llm.calls.every((c) => c.purpose === 'discussion_plan')).toBe(true);
    expect(report.runs.filter((r) => r.ok)).toHaveLength(4);
    const edited = report.summary.find((s) => s.arm === 'edited')!;
    const baseline = report.summary.find((s) => s.arm === 'baseline')!;
    expect(edited.edit_rate).toBeGreaterThan(0);
    expect(baseline.edit_rate).toBe(0);
    expect(edited.llm_calls).toBe(2);
    expect(renderMarkdown(report)).toContain('cf_add');
  });

  it('除く：除いた項目の文を含むカードの割合を数える', async () => {
    const llm = new ProbeMockLlm();
    const report = await runCounterfactual({ recorded: loadRecordedBoard(dir), edit: { kind: 'remove', item_id: 'val_7', keep_transcript: false }, n: 1, withBaseline: true, llm, safety, timeout_ms: 1000 });
    const edited = report.summary.find((s) => s.arm === 'edited')!;
    const baseline = report.summary.find((s) => s.arm === 'baseline')!;
    expect(edited.edit_rate).toBe(0);
    expect(baseline.edit_rate).toBeGreaterThan(0);
    expect(report.runs.find((r) => r.arm === 'edited')!.cards.every((c) => !c.ledger_item_ids.includes('val_7'))).toBe(true);
  });
});
