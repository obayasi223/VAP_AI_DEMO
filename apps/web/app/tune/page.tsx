'use client';

/**
 * 開発用の調整画面（/tune）。VAP の予測と方策の閾値、「なぜ AI が話し始めた／まだ話さない」、発話希望の流れを見て、
 * 録音を画面の方策で再生し直す。参加者の画面とは別。
 *   /tune                                   ライブ（ws://localhost:8787/research?tune=1）と再生（http://127.0.0.1:8790）
 *   /tune?ws=ws://localhost:8799/research?tune=1&dev=http://127.0.0.1:8798&tab=offline
 */
import { useEffect, useState } from 'react';
import { DEFAULT_DEV_URL, DEFAULT_LIVE_WS } from '../../src/tune/api';
import { LiveTab } from '../../src/tune/LiveTab';
import { OfflineTab } from '../../src/tune/OfflineTab';
import styles from '../../src/tune/tune.module.css';

type Tab = 'live' | 'offline';

export default function TunePage() {
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState<Tab>('offline');
  const [ws, setWs] = useState(DEFAULT_LIVE_WS);
  const [dev, setDev] = useState(DEFAULT_DEV_URL);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const w = q.get('ws');
    const d = q.get('dev');
    if (w) setWs(w);
    if (d) setDev(d);
    if (q.get('tab') === 'live') setTab('live');
    setReady(true);
  }, []);
  return (
    <main className={styles.page}>
      <h1 className={styles.title}>調整画面（開発用）</h1>
      <p className={styles.muted}>
        参加者には見せない画面です。録音には利用者の発話が入っています。再生の口は 127.0.0.1 だけで開きます（npm run dev:tune）。
      </p>
      <div className={styles.tabs}>
        <button type="button" className={tab === 'live' ? styles.tabOn : styles.tab} onClick={() => setTab('live')}>
          ライブ
        </button>
        <button type="button" className={tab === 'offline' ? styles.tabOn : styles.tab} onClick={() => setTab('offline')}>
          録音の再生
        </button>
      </div>
      {!ready ? null : tab === 'live' ? <LiveTab initialUrl={ws} /> : <OfflineTab devUrl={dev} />}
    </main>
  );
}
