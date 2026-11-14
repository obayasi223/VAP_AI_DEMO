'use client';

/**
 * 2 体のモードの参加者画面の見た目（docs/design/two_ai/03 §3.2）。状態は持たず、TwoAiView から描くだけ。
 * 試験（apps/web/test/two_ai/condition_parity.test.ts）は renderToStaticMarkup でこの部品を描き、① と ② で
 * 案内の文を除いて DOM が同じことを確かめる。条件の値はここに届かない（鍵だけ）。
 *
 * 両条件で同じにするもの：段の見出し、候補の板、印のボタン（位置・見た目・光る反応）、選ぶ画面、同期の印。
 * 出さないもの：字幕、残り時間、見本の人物の札、条件名。
 */
import type { Ref } from 'react';
import type { AiId } from '@llm-vap/contracts/common';
import type { TwoAiView } from '../../../src/session/two_ai_participant';
import { instructionText, UI_COPY } from '../../../src/session/two_ai_copy';
import styles from './two_ai.module.css';

const AI_ORDER: AiId[] = ['A', 'B'];

export interface TwoAiScreenProps {
  view: TwoAiView;
  /** アバターを描く要素（canvas はステージが中に作る）。 */
  stageRef?: Ref<HTMLDivElement>;
  /** 案内のカード（discussion の始めの 8 秒）を出しているか。 */
  instructionCard: boolean;
  /** 印のボタンが光っているか。 */
  markerFlash: boolean;
  /** 同期の印（右下の白い四角）を出しているか。 */
  syncFlash: boolean;
  /** 印のボタンの置き場（マイクから遠い側。既定は左）。 */
  markerSide?: 'left' | 'right';
  onStart?: () => void;
  onStop?: () => void;
  onMark?: () => void;
  onPick?: (card_id: string) => void;
}

function NameTag({ view, ai_id }: { view: TwoAiView; ai_id: AiId }) {
  const speaking = view.speaking === ai_id;
  const failed = view.avatarLoad[ai_id] === 'failed' || view.avatarLoad[ai_id] === 'disabled';
  return (
    <div className={styles.nameTag} data-ai={ai_id} data-side={ai_id === 'A' ? 'left' : 'right'} data-speaking={speaking ? 'yes' : 'no'} data-testid={`name-tag-${ai_id}`}>
      {failed && (
        <div className={styles.plate} data-testid={`avatar-plate-${ai_id}`}>
          <p className={styles.plateNote}>{UI_COPY.avatar_failed}</p>
          <span className={styles.speakingLamp} data-on={speaking ? 'yes' : 'no'}>
            {UI_COPY.speaking_badge}
          </span>
        </div>
      )}
      <span className={styles.label}>{view.labels[ai_id]}</span>
    </div>
  );
}

function Headings({ view }: { view: TwoAiView }) {
  const stage = view.stage;
  if (stage === null || stage.show === 'none') return null;
  const items = stage.headings.map((text, index) => ({ text, n: index + 1 }));
  const shown = stage.show === 'all' ? items : items.filter((item) => item.n === stage.current);
  if (shown.length === 0) return null;
  return (
    <ol className={styles.headings} data-testid="stage-headings" data-show={stage.show}>
      {shown.map((item) => (
        <li key={item.n} className={styles.heading} data-current={item.n === stage.current ? 'yes' : 'no'} data-stage={item.n}>
          {item.text}
        </li>
      ))}
    </ol>
  );
}

function Board({ view, onPick }: { view: TwoAiView; onPick?: (card_id: string) => void }) {
  const board = view.board;
  const picked = board?.picked_card_id ?? view.boardPending;
  return (
    <aside className={styles.board} data-testid="board" data-mode={board?.mode ?? 'none'}>
      <h2 className={styles.boardTitle}>{UI_COPY.board_title}</h2>
      {board !== null && board.mode === 'pick' && view.boardPickable && <p className={styles.boardPrompt}>{UI_COPY.next_step_pick}</p>}
      {board === null || board.cards.length === 0 ? (
        <p className={styles.boardEmpty}>{UI_COPY.board_empty}</p>
      ) : (
        <ol className={styles.cards}>
          {board.cards.map((card) => (
            <li key={card.card_id} className={styles.cardItem}>
              <button
                type="button"
                className={styles.card}
                data-testid="board-card"
                data-card={card.card_id}
                data-picked={picked === card.card_id ? 'yes' : 'no'}
                disabled={!view.boardPickable}
                onClick={() => onPick?.(card.card_id)}
              >
                {card.text}
                {picked === card.card_id && <span className={styles.pickedMark}>{UI_COPY.picked}</span>}
              </button>
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
}

export function TwoAiScreen(props: TwoAiScreenProps) {
  const { view } = props;
  const live = view.lifecycle === 'starting' || view.lifecycle === 'running';
  const instruction = instructionText(view.instructionKey);
  const markerSide = props.markerSide ?? 'left';
  return (
    <main className={styles.shell} data-mode={live ? 'live' : 'setup'} data-testid="two-ai-screen">
      <div className={styles.stageArea}>
        <div ref={props.stageRef} className={styles.canvas} data-testid="avatar-stage" />
        <div className={styles.nameRow}>
          {AI_ORDER.map((ai_id) => (
            <NameTag key={ai_id} view={view} ai_id={ai_id} />
          ))}
        </div>
        {live && <Headings view={view} />}
        {live && instruction !== null && (
          <div className={props.instructionCard ? styles.instructionCard : styles.instructionLine} data-testid="instruction" data-card={props.instructionCard ? 'yes' : 'no'}>
            {instruction}
          </div>
        )}
        {live && <Board view={view} {...(props.onPick ? { onPick: props.onPick } : {})} />}
      </div>
      {live ? (
        <footer className={styles.dock} data-marker-side={markerSide}>
          {view.markerEnabled && (
            <button type="button" className={styles.marker} data-testid="marker-button" data-flash={props.markerFlash ? 'yes' : 'no'} onClick={() => props.onMark?.()}>
              {UI_COPY.marker_button}
            </button>
          )}
          <div className={styles.dockSpacer} />
          {view.error && <p className={styles.error} role="alert">{view.error}</p>}
          <button type="button" className={styles.stopButton} onClick={() => props.onStop?.()}>
            {UI_COPY.stop_label}
          </button>
        </footer>
      ) : (
        <aside className={styles.panel}>
          <h1 className={styles.title}>{view.lifecycle === 'stopped' ? UI_COPY.stopped_title : view.lifecycle === 'failed' ? UI_COPY.failed_title : UI_COPY.start_title}</h1>
          {view.error && <p className={styles.error} role="alert">{view.error}</p>}
          <ol className={styles.steps}>
            <li>
              <strong>有線のヘッドセット</strong>（マイク付き）をつけてください。
            </li>
            <li>「{UI_COPY.start_label}」を押すと、マイクの使用の確認が出ます。「許可」を選んでください。</li>
          </ol>
          <button id="start" type="button" className={styles.startButton} onClick={() => props.onStart?.()}>
            {UI_COPY.start_label}
          </button>
        </aside>
      )}
      <div className={styles.syncMark} data-testid="sync-mark" data-on={props.syncFlash ? 'yes' : 'no'} aria-hidden="true" />
    </main>
  );
}
