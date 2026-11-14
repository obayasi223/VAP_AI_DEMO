/**
 * 候補の板（docs/design/two_ai/03 §2.4、§3.2、06 §2.2）。React に依存しない純粋な状態。
 *  - two_ai.board は板の全体（差分ではない）。届くたびに全体で置き換える。
 *  - カードを押せるのは mode が pick の間だけ。two_ai.board_pick はセッションで 1 回だけ送る。
 *  - 両条件で同じ規則（条件の値を持たない）。書き換えの欄は置かない（押して選ぶだけ）。
 */
import type { BoardCardView, TwoAiBoardMessage, TwoAiBoardPick } from '@llm-vap/contracts/browser_rpc';

export type BoardMode = TwoAiBoardMessage['mode'];

export interface BoardView {
  version: number;
  mode: BoardMode;
  /** order の順。 */
  cards: BoardCardView[];
  picked_card_id: string | null;
}

/** 板の全体の置き換え。カードは order で並べ直す（届いた順に依らない）。 */
export function boardFromMessage(message: TwoAiBoardMessage): BoardView {
  return {
    version: message.board_version,
    mode: message.mode,
    cards: [...message.cards].sort((a, b) => a.order - b.order),
    picked_card_id: message.picked_card_id,
  };
}

export interface BoardPickOptions {
  now?: () => number;
  newId?: () => string;
}

let pickCounter = 0;
function defaultPickId(): string {
  pickCounter += 1;
  return `pick_${Date.now().toString(36)}_${pickCounter}_${Math.random().toString(36).slice(2, 6)}`;
}

export class BoardState {
  private board: BoardView | null = null;
  /** 送った選択（1 回だけ）。 */
  private sentPick: { card_id: string; board_version: number } | null = null;

  constructor(private readonly options: BoardPickOptions = {}) {}

  apply(message: TwoAiBoardMessage): BoardView {
    this.board = boardFromMessage(message);
    return this.board;
  }

  view(): BoardView | null {
    return this.board;
  }

  /** カードを押せるか（pick の間で、まだ選んでいない）。 */
  canPick(): boolean {
    return this.board !== null && this.board.mode === 'pick' && this.sentPick === null;
  }

  /** 画面が押した（送る前の）カード。Node の picked が届くまでの強調に使う。 */
  pendingPick(): string | null {
    return this.sentPick?.card_id ?? null;
  }

  /** 板から 1 枚を選ぶ。pick の間で、板にあるカードの初回だけメッセージを返す。それ以外は null（送らない）。 */
  pick(card_id: string): TwoAiBoardPick | null {
    const board = this.board;
    if (board === null || !this.canPick()) return null;
    if (!board.cards.some((card) => card.card_id === card_id)) return null;
    this.sentPick = { card_id, board_version: board.version };
    return {
      type: 'two_ai.board_pick',
      pick_id: (this.options.newId ?? defaultPickId)(),
      card_id,
      board_version: board.version,
      client_t_ms: Math.max(0, (this.options.now ?? (() => performance.now()))()),
    };
  }
}
