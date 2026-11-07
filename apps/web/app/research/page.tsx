'use client';

/**
 * 研究者画面（I1 の状態表示＋I2 のライブ表示）。データ源はクエリで選ぶ。
 *   /research                       データ源なし
 *   /research?source=fake           偽のイベント列（画面に偽データと表示する）
 *   /research?source=ws&url=ws://…  WS（配線は J）
 * JSONL は下のファイル選択から読む。
 */
import { useEffect, useState } from 'react';
import { createJsonlFeed, createNoFeed, feedFromQuery, type ResearchFeed } from '../../src/research/feed';
import { ResearchDashboard } from '../../src/research/ResearchDashboard';
import styles from '../../src/research/research.module.css';
import { useResearchFeed } from '../../src/research/useResearchFeed';

const INITIAL_FEED = createNoFeed();

export default function ResearchPage() {
  const [feed, setFeed] = useState<ResearchFeed>(INITIAL_FEED);
  useEffect(() => {
    setFeed(feedFromQuery(window.location.search));
  }, []);
  const { snapshot, sendNote } = useResearchFeed(feed);
  return (
    <>
      <ResearchDashboard snapshot={snapshot} onSendNote={sendNote} />
      <div className={styles.controls}>
        <label>
          JSONL を読む:{' '}
          <input
            type="file"
            accept=".jsonl,application/x-ndjson,text/plain"
            data-testid="jsonl-input"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void file.text().then((text) => setFeed(createJsonlFeed(text, file.name)));
            }}
          />
        </label>
      </div>
    </>
  );
}
