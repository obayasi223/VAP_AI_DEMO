'use client';

/**
 * 録音の再生。記録の入力（VAP、STT、準備と再生の時刻）を Node 側で TurnManager の step に流し直し、
 * 画面の方策での判断を記録の判断と同じ時間軸に重ねる。値を動かすと 300ms 後に計算し直す（LLM と TTS は呼ばない）。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { TuneReplayResult, TuneSessionSummary, TurnDiagnosticBody } from '@llm-vap/contracts';
import { createDevApi, type PolicyInfo } from './api';
import { CHART_COLORS, TuneChart, type ChartSpec } from './TuneChart';
import { allowedSpans, avertSpans, completionLane, gapLane, vapLanes, voicedSpans } from './chart_spec';
import { parseOfflineLog, type OfflineLog } from './offline_log';
import { PolicyEditor } from './PolicyEditor';
import { changedPaths, getAt, replayEffect, thresholdLines } from './policy_edit';
import { DiagnosticTable, FlowTable, MetricsTable } from './TuneTables';
import styles from './tune.module.css';

type BaseChoice = 'head' | 'current' | 'local';

const COUNTERFACTUAL = [
  '再生は記録の入力をそのまま使う反実仮想です。AI の話し始めの時刻が変わっても、利用者の声、STT、VAP は記録のまま（実際には AI の声で利用者の話し方も VAP も変わるはず）。',
  'AI の声の VAP（2ch の AI 側）は記録の音声から計算された値で、再計算の発話の時刻には合いません。',
  '準備（LLM と TTS）の待ち時間は、記録で同じ transcript_revision の準備があればその値、なければ下の仮定の値を使います。発話の長さも同じ。',
  '発話希望（initiative）は記録の判定を出すだけです。initiative.trigger を変えたときは、記録の STT から起動の回数だけ数え直します（LLM がどう判定するかは分かりません）。',
];

function prepareThreshold(policy: unknown): number | null {
  const estimator = getAt(policy, 'completion.estimator');
  const v = typeof estimator === 'string' ? getAt(policy, `completion.thresholds.${estimator}.prepare_threshold`) : undefined;
  return typeof v === 'number' ? v : null;
}

function offlineSpec(log: OfflineLog, result: TuneReplayResult, policy: unknown, t0: number, t1: number): ChartSpec {
  const aiIndex = getAt(policy, 'vap.p_ai_index') === 0 ? 0 : 1;
  const speaking = getAt(policy, 'vap.speaking_threshold');
  const rec = result.recorded;
  const rep = result.replayed;
  return {
    t0,
    t1,
    origin: result.t_start,
    lanes: [...vapLanes(log.vap, aiIndex, thresholdLines(policy), 64), gapLane(rep.diagnostics, '間（再計算）'), completionLane(rep.diagnostics, prepareThreshold(policy))],
    bands: [
      { name: '利用者の声', spans: voicedSpans(log.vap, typeof speaking === 'number' ? speaking : 0.5).map((v) => ({ ...v, color: CHART_COLORS.user })), marks: [] },
      {
        name: 'AI 発話・記録',
        spans: rec.ai_speech.map((s) => ({ ...s, color: CHART_COLORS.recorded })),
        marks: rec.starts.map((s) => ({ t: s.t, color: CHART_COLORS.recorded, label: s.reason })),
      },
      {
        name: 'AI 発話・再計算',
        spans: rep.ai_speech.map((s) => ({ ...s, color: CHART_COLORS.replayed })),
        marks: rep.starts.map((s) => ({ t: s.t, color: CHART_COLORS.replayed, label: s.reason })),
      },
      { name: '許可・記録', spans: allowedSpans(rec.turn_changes, result.t_end).map((s) => ({ ...s, color: CHART_COLORS.recorded })), marks: [] },
      { name: '許可・再計算', spans: allowedSpans(rep.turn_changes, result.t_end).map((s) => ({ ...s, color: CHART_COLORS.replayed })), marks: [] },
      { name: '視線・記録', spans: avertSpans(rec.gaze, result.t_end).map((s) => ({ ...s, color: CHART_COLORS.recorded })), marks: [] },
      { name: '視線・再計算', spans: avertSpans(rep.gaze, result.t_end).map((s) => ({ ...s, color: CHART_COLORS.replayed })), marks: [] },
      {
        name: '準備（再計算）',
        spans: [],
        marks: rep.prepares.map((p) => ({ t: p.t, color: p.matched_recorded ? CHART_COLORS.initiative : CHART_COLORS.muted, label: p.trigger })),
      },
      {
        name: '発話希望・記録',
        spans: [],
        marks: log.flow.flatMap((r) =>
          r.kind === 'decision' ? [{ t: r.t, color: r.row.decision === 'NONE' ? CHART_COLORS.muted : CHART_COLORS.initiative, label: r.row.decision }] : [],
        ),
      },
    ],
  };
}

function StartsTable({ result }: { result: TuneReplayResult }) {
  const s = (t: number) => `${((t - result.t_start) / 1000).toFixed(2)}s`;
  const rows = [
    ...result.recorded.starts.map((x) => ({ ...x, side: '記録' })),
    ...result.replayed.starts.map((x) => ({ ...x, side: '再計算' })),
  ].sort((a, b) => a.t - b.t || a.side.localeCompare(b.side));
  return (
    <table className={styles.table} data-testid="starts-table">
      <thead>
        <tr>
          <th>時刻</th>
          <th>側</th>
          <th>理由（turn.allowed）</th>
          <th>間 ms</th>
          <th>p_now(AI)</th>
          <th>completion</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={`${r.side}${r.t}`}>
            <td className={styles.num}>{s(r.t)}</td>
            <td>{r.side}</td>
            <td className={styles.path}>{r.reason}</td>
            <td className={styles.num}>{r.gap_ms ?? '—'}</td>
            <td className={styles.num}>{r.p_now === null ? '—' : r.p_now.toFixed(3)}</td>
            <td className={styles.num}>{r.completion_p === null ? '—' : r.completion_p.toFixed(2)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function OfflineTab({ devUrl }: { devUrl: string }) {
  const api = useMemo(() => createDevApi(devUrl), [devUrl]);
  const [sessions, setSessions] = useState<TuneSessionSummary[]>([]);
  const [info, setInfo] = useState<PolicyInfo | null>(null);
  const [sessionId, setSessionId] = useState<string>('');
  const [log, setLog] = useState<OfflineLog | null>(null);
  const [baseChoice, setBaseChoice] = useState<BaseChoice>('head');
  const [edited, setEdited] = useState<unknown>(null);
  const [assumedPrepare, setAssumedPrepare] = useState<string>('');
  const [assumedSpeech, setAssumedSpeech] = useState<string>('');
  const [result, setResult] = useState<TuneReplayResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [view, setView] = useState({ start: 0, length: 30 });
  const [hover, setHover] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.sessions(), api.policy()])
      .then(([list, policyInfo]) => {
        if (cancelled) return;
        setSessions(list);
        setInfo(policyInfo);
        // 一覧は新しい順（dev_server.ts）。最新のセッションを選ぶ。
        setSessionId((prev) => prev || (list[0]?.session_id ?? ''));
        setEdited(policyInfo.head.policy ?? policyInfo.current.policy);
        setBaseChoice(policyInfo.head.policy ? 'head' : 'current');
      })
      .catch((e: unknown) => !cancelled && setError(`dev サーバに届かない（${api.base}、npm run dev:tune）: ${String(e)}`));
    return () => {
      cancelled = true;
    };
  }, [api]);

  useEffect(() => {
    if (sessionId === '') return;
    let cancelled = false;
    setLog(null);
    api
      .events(sessionId)
      .then((text) => !cancelled && setLog(parseOfflineLog(text)))
      .catch((e: unknown) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [api, sessionId]);

  const basePolicy = useMemo(() => {
    if (info === null) return null;
    if (baseChoice === 'head') return info.head.policy ?? info.current.policy;
    if (baseChoice === 'local') return info.local?.policy ?? info.current.policy;
    return info.current.policy;
  }, [info, baseChoice]);

  useEffect(() => {
    if (sessionId === '' || edited === null) return;
    const timer = setTimeout(() => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setBusy(true);
      const options: { assumed_prepare_ms?: number; assumed_speech_ms?: number } = {};
      if (assumedPrepare !== '' && Number.isFinite(Number(assumedPrepare))) options.assumed_prepare_ms = Number(assumedPrepare);
      if (assumedSpeech !== '' && Number.isFinite(Number(assumedSpeech))) options.assumed_speech_ms = Number(assumedSpeech);
      api
        .replay({ session_id: sessionId, policy: edited, options, recorded_policy: 'head' }, controller.signal)
        .then((r) => {
          setResult(r);
          setError(null);
        })
        .catch((e: unknown) => {
          if (!controller.signal.aborted) setError(String(e));
        })
        .finally(() => {
          if (abortRef.current === controller) setBusy(false);
        });
    }, 300);
    return () => clearTimeout(timer);
  }, [api, sessionId, edited, assumedPrepare, assumedSpeech]);

  const durationS = result ? Math.max(1, Math.ceil((result.t_end - result.t_start) / 1000)) : 60;
  const t0 = result ? result.t_start + view.start * 1000 : 0;
  const t1 = t0 + view.length * 1000;
  const spec = useMemo(() => (log && result ? offlineSpec(log, result, edited, t0, t1) : null), [log, result, edited, t0, t1]);
  const hoverDiag = useMemo<TurnDiagnosticBody | null>(() => {
    if (!result) return null;
    const list = result.replayed.diagnostics;
    if (hover === null) return null;
    let best: TurnDiagnosticBody | null = null;
    for (const d of list) {
      if (d.t_monotonic_ms > hover) break;
      best = d;
    }
    return best;
  }, [hover, result]);

  const changed = info && basePolicy ? changedPaths(info.leaves, basePolicy, edited) : [];
  const triggerChanged = changed.some((p) => replayEffect(p) === 'initiative_trigger');
  const session = sessions.find((s) => s.session_id === sessionId) ?? null;
  const localName = info ? info.local_file.replace(/^.*?(config\/)/, '$1') : 'config/policy.ja.local.json';

  return (
    <div>
      {error ? <div className={`${styles.banner} ${styles.error}`}>{error}</div> : null}
      <div className={styles.banner} data-testid="counterfactual">
        <b>反実仮想の限界</b>
        <ul>
          {COUNTERFACTUAL.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      </div>
      <div className={styles.layout}>
        <div className={`${styles.card} ${styles.editor}`}>
          <h2 className={styles.heading}>方策</h2>
          <div className={styles.row}>
            <label>
              セッション:{' '}
              <select value={sessionId} onChange={(e) => setSessionId(e.target.value)} aria-label="セッション">
                {sessions.map((s) => (
                  <option key={s.session_id} value={s.session_id}>
                    {s.session_id}（{s.condition ?? '?'}、{Math.round(s.events_bytes / 1024)}KB）
                  </option>
                ))}
              </select>
            </label>
          </div>
          {session?.policy_override ? (
            <p className={styles.muted}>
              この記録は上書き {session.policy_override.file}（{session.policy_override.keys.join('、')}）で動いていた
            </p>
          ) : null}
          <div className={styles.row}>
            <label>
              元にする方策:{' '}
              <select value={baseChoice} onChange={(e) => setBaseChoice(e.target.value as BaseChoice)} aria-label="元にする方策">
                <option value="head">git HEAD（{info?.head.ref?.slice(0, 7) ?? '—'}）</option>
                <option value="current">いまの作業ツリー</option>
                <option value="local" disabled={!info?.local?.policy}>
                  いまの作業ツリー＋{localName}
                </option>
              </select>
            </label>
            <button type="button" className={styles.button} onClick={() => basePolicy && setEdited(basePolicy)}>
              元に戻す
            </button>
          </div>
          <p className={styles.muted}>記録の判断と比べるときは、記録したときの方策（たいてい git HEAD）を元にしてください。</p>
          <div className={styles.row}>
            <label>
              準備の待ちの仮定 ms:{' '}
              <input style={{ width: 80 }} type="number" placeholder="中央値" value={assumedPrepare} onChange={(e) => setAssumedPrepare(e.target.value)} />
            </label>
            <label>
              発話の長さの仮定 ms:{' '}
              <input style={{ width: 80 }} type="number" placeholder="中央値" value={assumedSpeech} onChange={(e) => setAssumedSpeech(e.target.value)} />
            </label>
          </div>
          <div className={styles.row}>
            <button
              type="button"
              className={styles.button}
              disabled={edited === null}
              onClick={() =>
                api
                  .saveLocal(edited)
                  .then((r) => setSaved(`${r.file} に保存（いまの作業ツリーとの差: ${r.keys.length === 0 ? 'なし' : r.keys.join('、')}）`))
                  .catch((e: unknown) => setSaved(`保存できない: ${String(e)}`))
              }
            >
              {localName} に保存
            </button>
          </div>
          <p className={styles.muted}>
            保存するのは「いまの作業ツリーの方策」との差分だけ。使うには orchestrator を POLICY_OVERRIDE_FILE={localName} で起動し直す。
          </p>
          {saved ? <p className={styles.muted}>{saved}</p> : null}
          {info && edited !== null ? <PolicyEditor leaves={info.leaves} edited={edited} base={basePolicy} fallback={info.current.policy} onChange={setEdited} /> : null}
        </div>
        <div>
          <div className={styles.card}>
            <h2 className={styles.heading}>
              記録と再計算 {busy ? <span className={styles.muted}>計算中…</span> : null}
            </h2>
            {result ? (
              <p className={styles.muted} data-testid="start-match">
                開始の対応: 一致 {result.start_match.matched}、記録だけ {result.start_match.recorded_only}、再計算だけ {result.start_match.replayed_only}
                {result.start_match.max_abs_shift_ms !== null ? `、最大のずれ ${result.start_match.max_abs_shift_ms}ms` : ''}　tick {result.tick_ms}ms
              </p>
            ) : null}
            <div className={styles.row}>
              <label>
                窓の始まり {view.start}s
                <input type="range" min={0} max={Math.max(0, durationS - view.length)} value={Math.min(view.start, Math.max(0, durationS - view.length))} onChange={(e) => setView((v) => ({ ...v, start: Number(e.target.value) }))} />
              </label>
              <label>
                窓の長さ {view.length}s
                <input type="range" min={5} max={Math.max(5, durationS)} value={Math.min(view.length, Math.max(5, durationS))} onChange={(e) => setView((v) => ({ ...v, length: Number(e.target.value) }))} />
              </label>
              <span className={styles.muted}>全体 {durationS}s</span>
            </div>
            <div className={styles.legend}>
              <span>
                <span className={styles.swatch} style={{ background: 'var(--series-recorded)' }} />
                記録
              </span>
              <span>
                <span className={styles.swatch} style={{ background: 'var(--series-replayed)' }} />
                再計算
              </span>
              <span>◆ = 開始・準備・判定　実線 = AI、破線 = 利用者、点線 = 画面の方策の閾値</span>
            </div>
            {spec ? <TuneChart spec={spec} onHover={setHover} testId="offline-chart" /> : <p className={styles.muted}>読み込み中…</p>}
          </div>
          {result ? (
            <>
              <div className={styles.card}>
                <h2 className={styles.heading}>なぜ AI が話し始めた／まだ話さないか（再計算）</h2>
                <DiagnosticTable diag={hoverDiag} origin={result.t_start} title="ポインタの時刻" />
              </div>
              <div className={styles.card}>
                <h2 className={styles.heading}>指標</h2>
                <MetricsTable recorded={result.recorded.metrics} replayed={result.replayed.metrics} />
              </div>
              <div className={styles.card}>
                <h2 className={styles.heading}>開始の一覧</h2>
                <StartsTable result={result} />
              </div>
              <div className={styles.card} data-testid="divergences">
                <h2 className={styles.heading}>記録と食い違った点（{result.divergences.length}）</h2>
                {result.divergences.length === 0 ? (
                  <p className={styles.muted}>なし</p>
                ) : (
                  <table className={styles.table}>
                    <tbody>
                      {result.divergences.slice(0, 100).map((d, i) => (
                        <tr key={i}>
                          <td className={styles.num}>{((d.t - result.t_start) / 1000).toFixed(2)}s</td>
                          <td>{d.kind}</td>
                          <td>{d.detail}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
              <div className={styles.card}>
                <h2 className={styles.heading}>再生の仮定と注意</h2>
                <ul>
                  {result.assumptions.map((a) => (
                    <li key={a}>{a}</li>
                  ))}
                  {result.warnings.map((w) => (
                    <li key={w} className={styles.error}>
                      {w}
                    </li>
                  ))}
                  {log && log.invalid > 0 ? <li className={styles.error}>表示用に読めなかった行 {log.invalid}</li> : null}
                </ul>
              </div>
              <div className={styles.card} data-testid="initiative-recount">
                <h2 className={styles.heading}>発話希望（initiative）</h2>
                <p>
                  起動の回数: 記録 {result.initiative.recorded_requests}　記録の起動条件で数え直し {result.initiative.recount_with_recorded_trigger ?? '—'}　画面の起動条件で数え直し{' '}
                  <b>{result.initiative.recount_with_edited_trigger ?? '—'}</b>
                </p>
                {triggerChanged ? <p className={styles.error}>initiative.trigger を変えています。起動の回数は数え直しましたが、LLM がどう判定するか（NEW／NONE など）は分かりません。下の表は記録の判定です。</p> : null}
                {result.initiative.error ? <p className={styles.error}>{result.initiative.error}</p> : null}
                <ul className={styles.muted}>
                  {result.initiative.assumptions.map((a) => (
                    <li key={a}>{a}</li>
                  ))}
                </ul>
                <h3 className={styles.sub}>記録の流れ（再計算はしない）</h3>
                {log ? <FlowTable rows={log.flow} origin={result.t_start} limit={500} /> : null}
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
