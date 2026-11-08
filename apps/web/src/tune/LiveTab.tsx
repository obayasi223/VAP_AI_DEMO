'use client';

/**
 * ライブ表示。/research の WS に ?tune=1 を付けてつなぎ、直近 30 秒の VAP と閾値、判断の材料、発話希望の流れを出す。
 * 再描画は 250ms ごと（イベントごとにはしない）。タブが隠れている間は作り直さない。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { createWsFeed } from '../research/feed';
import { CHART_COLORS, TuneChart, type ChartSpec } from './TuneChart';
import { allowedSpans, avertSpans, completionLane, gapLane, vapLanes, voicedSpans } from './chart_spec';
import { LIVE_WINDOW_MS, TuneLiveStore, type LiveSnapshot } from './live_store';
import { getAt, thresholdLines } from './policy_edit';
import { DiagnosticTable, FlowTable } from './TuneTables';
import styles from './tune.module.css';

function prepareThreshold(policy: unknown): number | null {
  const estimator = getAt(policy, 'completion.estimator');
  const v = typeof estimator === 'string' ? getAt(policy, `completion.thresholds.${estimator}.prepare_threshold`) : undefined;
  return typeof v === 'number' ? v : null;
}

export function liveChartSpec(s: LiveSnapshot): ChartSpec | null {
  if (s.now_ms === null) return null;
  const t1 = s.now_ms;
  const t0 = t1 - LIVE_WINDOW_MS;
  const policy = s.policy?.policy ?? null;
  const lines = thresholdLines(policy);
  const speaking = getAt(policy, 'vap.speaking_threshold');
  const end = (v: number | null) => v ?? t1;
  return {
    t0,
    t1,
    origin: s.origin_ms ?? t0,
    lanes: [...vapLanes(s.vap, s.p_ai_index, lines), gapLane(s.diagnostics), completionLane(s.diagnostics, prepareThreshold(policy))],
    bands: [
      { name: '利用者の声', spans: voicedSpans(s.vap, typeof speaking === 'number' ? speaking : 0.5).map((v) => ({ ...v, color: CHART_COLORS.user })), marks: [] },
      { name: 'AI の発話', spans: s.ai_speech.map((a) => ({ start: a.start, end: end(a.end), color: CHART_COLORS.ai, label: a.label })), marks: [] },
      {
        name: '発話の許可',
        spans: allowedSpans(s.turn_changes, t1).map((a) => ({ ...a, color: CHART_COLORS.allowed })),
        marks: [],
      },
      { name: '視線を逸らす', spans: avertSpans(s.gaze, t1).map((a) => ({ ...a, color: CHART_COLORS.gaze })), marks: [] },
      {
        name: '発話希望',
        spans: [],
        marks: s.initiative.flatMap((r) =>
          r.kind === 'decision' ? [{ t: r.t, color: r.row.decision === 'NONE' ? CHART_COLORS.muted : CHART_COLORS.initiative, label: r.row.decision }] : [],
        ),
      },
    ],
  };
}

export function LiveTab({ initialUrl }: { initialUrl: string }) {
  const [url, setUrl] = useState(initialUrl);
  const [active, setActive] = useState(initialUrl);
  const storeRef = useRef<TuneLiveStore | null>(null);
  const [snap, setSnap] = useState<LiveSnapshot>(() => new TuneLiveStore().snapshot());
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const store = new TuneLiveStore();
    storeRef.current = store;
    const feed = createWsFeed(active);
    const stop = feed.start(store);
    const refresh = () => {
      if (document.hidden) return;
      setSnap(store.snapshot());
    };
    const timer = setInterval(refresh, 250);
    return () => {
      clearInterval(timer);
      stop();
    };
  }, [active]);

  const spec = useMemo(() => liveChartSpec(snap), [snap]);
  const hoverDiag = useMemo(() => {
    if (hover === null) return null;
    let best = null;
    for (const d of snap.diagnostics) {
      if (d.t_monotonic_ms > hover) break;
      best = d;
    }
    return best;
  }, [hover, snap.diagnostics]);
  const origin = spec?.origin ?? 0;

  return (
    <div>
      <div className={styles.card}>
        <div className={styles.row}>
          <label>
            WS:{' '}
            <input className={styles.input} value={url} onChange={(e) => setUrl(e.target.value)} aria-label="ライブの WS の宛先" />
          </label>
          <button type="button" className={styles.button} onClick={() => setActive(url)}>
            つなぎ直す
          </button>
          <span data-testid="live-connection">
            接続: {snap.connection.state}
            {snap.connection.detail ? `（${snap.connection.detail}）` : ''}
          </span>
        </div>
        <p className={styles.muted}>
          セッション: {snap.session_id ?? '—'}　受けたイベント {snap.accepted}　契約に合わない {snap.invalid}
          {snap.last_invalid ? `（最後: ${snap.last_invalid}）` : ''}
        </p>
        <p className={styles.muted}>
          使っている方策:{' '}
          {snap.policy === null
            ? '未受信（orchestrator が調整画面の口に対応していないか、未接続）'
            : `${snap.policy.file}${snap.policy.override ? `、上書き ${snap.policy.override.file}（${snap.policy.override.keys.join('、')}）` : '（上書きなし）'}`}
        </p>
      </div>
      <div className={styles.card}>
        <h2 className={styles.heading}>直近 30 秒</h2>
        <div className={styles.legend}>
          <span>実線 = AI、破線 = 利用者、点線 = 方策の閾値</span>
          <span>間の段: 「発話の終わりからの間」が「L74 の待ち」を超え、かつ「最小の間」を超えると L74 で話し始めうる</span>
        </div>
        {spec === null ? <p className={styles.muted}>まだ何も届いていません。</p> : <TuneChart spec={spec} onHover={setHover} testId="live-chart" />}
      </div>
      <div className={styles.card}>
        <h2 className={styles.heading}>なぜ AI が話し始めた／まだ話さないか</h2>
        <DiagnosticTable diag={hoverDiag ?? snap.latest_diagnostic} origin={origin} title={hoverDiag ? 'ポインタの時刻' : '最新'} />
      </div>
      <div className={styles.card}>
        <h2 className={styles.heading}>発話希望の流れ（initiative）</h2>
        <FlowTable rows={snap.initiative} origin={origin} limit={40} />
      </div>
    </div>
  );
}
