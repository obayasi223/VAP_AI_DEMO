'use client';

import { useEffect, useState } from 'react';
import type { ResearchFeed } from './feed';
import { ResearchViewStore, type ResearchSnapshot } from './view_store';

/** feed を動かし、一定間隔で表示内容を作り直す。イベントごとには再描画しない。 */
export function useResearchFeed(feed: ResearchFeed, refreshMs = 500): ResearchSnapshot {
  const [snapshot, setSnapshot] = useState<ResearchSnapshot>(() => new ResearchViewStore(feed).snapshot());
  useEffect(() => {
    const store = new ResearchViewStore(feed);
    setSnapshot(store.snapshot());
    const stop = feed.start(store);
    const timer = setInterval(() => setSnapshot(store.snapshot()), refreshMs);
    return () => {
      clearInterval(timer);
      stop();
    };
  }, [feed, refreshMs]);
  return snapshot;
}
