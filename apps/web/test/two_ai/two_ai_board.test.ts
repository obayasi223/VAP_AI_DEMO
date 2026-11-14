/** 候補の板（docs/design/two_ai/03 §3.2、§5.1）。全体の置き換え、pick の間だけ 1 回、picked の強調、両条件で同じ DOM。 */
import { describe, expect, it } from 'vitest';
import { TwoAiBoardPick, type TwoAiBoardMessage } from '@llm-vap/contracts/browser_rpc';
import { BoardState } from '../../src/session/two_ai_board';
import { conditionRun, harness } from './two_ai_harness';

function message(version: number, mode: TwoAiBoardMessage['mode'], orders: number[], picked: string | null = null): TwoAiBoardMessage {
  return {
    type: 'two_ai.board',
    board_version: version,
    mode,
    cards: orders.map((n) => ({ card_id: `c${n}`, order: n, discussion_stage: n, text: `カード ${n}`, variant: 'original' as const })),
    picked_card_id: picked,
  };
}

describe('BoardState', () => {
  it('two_ai.board の全体で置き換える（差分ではない）。order で並べる', () => {
    const board = new BoardState();
    board.apply(message(1, 'building', [1]));
    board.apply(message(2, 'building', [2, 1]));
    expect(board.view()?.cards.map((c) => c.card_id)).toEqual(['c1', 'c2']);
    board.apply(message(3, 'building', [3]));
    expect(board.view()?.cards.map((c) => c.card_id)).toEqual(['c3']);
  });

  it('pick の間だけ押せ、two_ai.board_pick は 1 回だけ', () => {
    const board = new BoardState({ now: () => 50, newId: () => 'p1' });
    board.apply(message(4, 'building', [1, 2, 3, 4]));
    expect(board.pick('c1')).toBeNull();
    board.apply(message(5, 'pick', [1, 2, 3, 4]));
    expect(board.pick('zz')).toBeNull();
    const pick = board.pick('c2');
    expect(pick).toEqual({ type: 'two_ai.board_pick', pick_id: 'p1', card_id: 'c2', board_version: 5, client_t_ms: 50 });
    expect(TwoAiBoardPick.safeParse(pick).success).toBe(true);
    expect(board.pick('c3')).toBeNull();
    expect(board.canPick()).toBe(false);
    expect(board.pendingPick()).toBe('c2');
  });
});

describe('controller の板', () => {
  it('building で 1 枚ずつ増え、rebuilt で訂正後の 4 枚、pick の間だけ押せ、picked を強調する', () => {
    const run = conditionRun('discussion_a');
    const boards = run.harness.controller.record.boards;
    // 再接続の送り直し（同じ版）を除いて、版ごとに 1 枚ずつ増える。
    const byVersion = new Map(boards.filter((b) => b.mode === 'building').map((b) => [b.version, b.card_ids.length]));
    expect([...byVersion.values()]).toEqual([1, 2, 3, 4]);
    expect(boards.find((b) => b.mode === 'rebuilt')?.card_ids).toEqual(['card_1c', 'card_2c', 'card_3c', 'card_4c']);
    expect(run.harness.sentOf('two_ai.board_pick')).toHaveLength(1);
    const last = run.htmls.at(-1) as string;
    expect(last).toMatch(/data-card="card_2c" data-picked="yes"/);
    // pick の前の画面ではカードは押せない（disabled）。
    const building = run.htmls.find((html) => html.includes('data-mode="building"')) as string;
    expect(building).toMatch(/data-testid="board-card"[^>]*disabled/);
  });

  it('pick でないときに pick() を呼んでも送らない', () => {
    const h = harness();
    h.deliver(message(1, 'building', [1]));
    h.controller.pick('c1');
    expect(h.sentOf('two_ai.board_pick')).toHaveLength(0);
  });

  it('板の DOM は ① と ② で同じ', () => {
    const boardOf = (html: string) => /<aside[^>]*data-testid="board"[\s\S]*?<\/aside>/.exec(html)?.[0] ?? '';
    const a = conditionRun('discussion_a').htmls.map(boardOf);
    const b = conditionRun('discussion_b').htmls.map(boardOf);
    expect(a).toEqual(b);
  });
});
