'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ResearchTwoAiArm,
  ResearchWoz,
  ResearchNoteText,
  type ResearchNoteMessage,
  type WozAction,
} from '@llm-vap/contracts';
import type { ArmFields, SendResult } from './TwoAiPanel';
import type { ResearchFeed } from './feed';
import { ResearchViewStore, type ResearchSnapshot } from './view_store';

export interface ResearchFeedHandle {
  snapshot: ResearchSnapshot;
  /** メモを送る。本文が空か長すぎれば送らずに理由を返す。 */
  sendNote(text: string): { ok: true } | { ok: false; reason: string };
  /** two_ai の WoZ を送る（research.woz）。ack まで「送信中」、3 秒で「応答なし」。再送しない。 */
  sendWoz(action: WozAction, point_id: string | null, operator: string): SendResult;
  /** two_ai の次のセッションの条件と台本を送る（research.two_ai.arm）。 */
  armTwoAi(fields: ArmFields): SendResult;
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function newNoteId(): string {
  return newId('note');
}

/**
 * feed を動かし、一定間隔で表示内容を作り直す。イベントごとには再描画しない。
 * タブが見えていない間は作り直さない（イベントは受け続ける）。描画が MaAI の CPU を奪わないように。
 */
export function useResearchFeed(feed: ResearchFeed, refreshMs = 500): ResearchFeedHandle {
  const [snapshot, setSnapshot] = useState<ResearchSnapshot>(() => new ResearchViewStore(feed).snapshot());
  const storeRef = useRef<ResearchViewStore | null>(null);
  useEffect(() => {
    const store = new ResearchViewStore(feed);
    storeRef.current = store;
    setSnapshot(store.snapshot());
    const stop = feed.start(store);
    const refresh = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      setSnapshot(store.snapshot());
    };
    const timer = setInterval(refresh, refreshMs);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
      if (storeRef.current === store) storeRef.current = null;
      stop();
    };
  }, [feed, refreshMs]);

  const sendNote = useCallback(
    (text: string): { ok: true } | { ok: false; reason: string } => {
      const store = storeRef.current;
      if (store === null || feed.send === undefined) return { ok: false, reason: 'このデータ源ではメモを送れません' };
      const parsed = ResearchNoteText.safeParse(text);
      if (!parsed.success) return { ok: false, reason: text.trim() === '' ? '本文が空です' : '長すぎます' };
      const message: ResearchNoteMessage = {
        type: 'research.note',
        note_id: newNoteId(),
        text: parsed.data,
        client_wall_clock: new Date().toISOString(),
      };
      const sent = feed.send(message);
      store.noteSubmitted(message, sent);
      setSnapshot(store.snapshot());
      return { ok: true };
    },
    [feed],
  );

  const sendWoz = useCallback(
    (action: WozAction, point_id: string | null, operator: string): SendResult => {
      const store = storeRef.current;
      if (store === null || feed.send === undefined) return { ok: false, reason: 'このデータ源では送れません' };
      const parsed = ResearchWoz.safeParse({
        type: 'research.woz',
        woz_id: newId('woz'),
        action,
        point_id: action === 'correction' ? point_id : null,
        operator,
        client_wall_clock: new Date().toISOString(),
      });
      if (!parsed.success) return { ok: false, reason: '契約に合いません' };
      store.wozSubmitted(parsed.data, feed.send(parsed.data));
      setSnapshot(store.snapshot());
      return { ok: true };
    },
    [feed],
  );

  const armTwoAi = useCallback(
    (fields: ArmFields): SendResult => {
      const store = storeRef.current;
      if (store === null || feed.send === undefined) return { ok: false, reason: 'このデータ源では送れません' };
      const parsed = ResearchTwoAiArm.safeParse({
        type: 'research.two_ai.arm',
        arm_id: newId('arm'),
        ...fields,
        client_wall_clock: new Date().toISOString(),
      });
      if (!parsed.success) return { ok: false, reason: '入力が契約に合いません' };
      store.armSubmitted(parsed.data, feed.send(parsed.data));
      setSnapshot(store.snapshot());
      return { ok: true };
    },
    [feed],
  );

  return { snapshot, sendNote, sendWoz, armTwoAi };
}
