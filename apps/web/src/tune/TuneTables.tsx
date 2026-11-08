'use client';

/**
 * 調整画面の表（ライブと再生で共用）。
 *  - DiagnosticTable: その時刻の「なぜ AI が話し始めた／まだ話さない」。分岐ごとに成立と値・閾値。
 *  - FlowTable: 発話希望の流れ。実測の時刻と LLM 生成の欄を分ける。数値の「話したい度合い」は出さない。
 *  - MetricsTable: 記録と再計算の指標を並べる。
 */
import { summarizeTurnOutcomes, turnOutcomeRows } from '@llm-vap/analysis';
import type { TuneMetricSet, TurnDiagnosticBody, TurnOutcomeBody } from '@llm-vap/contracts';
import type { FlowRow } from './initiative_flow';
import { quantile } from './chart_spec';
import styles from './tune.module.css';

const fmt = (v: number | null, digits = 3) => (v === null ? '—' : Number.isInteger(v) ? String(v) : v.toFixed(digits));

export function DiagnosticTable({ diag, origin, title }: { diag: TurnDiagnosticBody | null; origin: number; title: string }) {
  if (diag === null) return <p className={styles.muted}>{title}: まだ判断の材料が届いていません。</p>;
  return (
    <div data-testid="diagnostic-table">
      <h3 className={styles.sub}>
        {title}（{((diag.t_monotonic_ms - origin) / 1000).toFixed(2)}s）
      </h3>
      <p className={styles.muted}>
        VAP: {diag.vap_freshness}　AI: {diag.ai_phase}　利用者の発話中: {diag.user_speaking ? 'はい' : 'いいえ'}　p_now(AI)={fmt(diag.p_now_ai)}　p_future(AI)=
        {fmt(diag.p_future_ai)}　vad(利用者)={fmt(diag.vad_user)}
      </p>
      <p className={styles.muted}>
        間={fmt(diag.gap_ms, 0)}ms　L64 の継続={fmt(diag.since_turn_end_ms, 0)}ms　最小の間={diag.min_gap_ms}ms　completion={fmt(diag.completion_p)}
        （rev {diag.completion_revision ?? '—'}）　L74 の待ち={diag.completion_wait_ms}ms（turnGptTimeout {diag.yield_timeout_ms}ms）　許可:{' '}
        {diag.permitted_to_speak ? 'あり' : 'なし'}　準備: {diag.want_to_speak}　招待: {diag.invitation.detected ? `${diag.invitation.kind}「${diag.invitation.phrase}」` : 'なし'}
      </p>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>分岐</th>
            <th>意味</th>
            <th>成立</th>
            <th>値と閾値</th>
          </tr>
        </thead>
        <tbody>
          {diag.branches.map((b) => (
            <tr key={b.id}>
              <td>{b.id}</td>
              <td>{b.label}</td>
              <td className={b.holds === true ? styles.holds : styles.notHolds}>{b.holds === null ? '評価せず' : b.holds ? '成立' : '不成立'}</td>
              <td className={styles.path}>{b.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className={styles.muted}>
        最後の turn.allowed の理由（TurnManager が書いた正本）: <span className={styles.path}>{diag.last_turn_allowed_reason ?? '—'}</span>
      </p>
      <p className={styles.muted}>この表は state と VAP から計算し直した読み出しで、判断そのものではありません。食い違うときは turn.allowed の理由が正です。</p>
    </div>
  );
}

export function FlowTable({ rows, origin, limit = 80 }: { rows: FlowRow[]; origin: number; limit?: number }) {
  const shown = rows.slice(-limit);
  if (shown.length === 0) return <p className={styles.muted}>発話希望（initiative）の記録はまだありません。</p>;
  const s = (t: number) => `${((t - origin) / 1000).toFixed(2)}s`;
  return (
    <div data-testid="initiative-flow">
      <table className={styles.table}>
        <thead>
          <tr>
            <th>時刻（実測）</th>
            <th>種類</th>
            <th>実測とコードの値</th>
            <th>
              <span className={styles.llm}>LLM 生成</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => {
            if (r.kind === 'request')
              return (
                <tr key={r.key}>
                  <td className={styles.num}>{s(r.t)}</td>
                  <td>起動</td>
                  <td>
                    {r.request_id}・rev {r.transcript_revision}・契機の推定: {r.trigger_guess}
                  </td>
                  <td />
                </tr>
              );
            if (r.kind === 'decision') {
              const d = r.row;
              return (
                <tr key={r.key}>
                  <td className={styles.num}>{s(r.t)}</td>
                  <td>
                    判定 <b>{d.decision}</b>
                  </td>
                  <td>
                    LLM {Math.round(d.measured.llm_ms)}ms・{d.candidate_id ?? '候補なし'}
                    {d.candidate_version !== null ? ` v${d.candidate_version}` : ''}
                    {d.verified.map((v) => (
                      <div key={v.label} className={styles.muted}>
                        {v.label}: {v.value}（{v.method}）
                      </div>
                    ))}
                  </td>
                  <td>
                    {d.model
                      .filter((m) => m.value !== null)
                      .map((m) => (
                        <div key={m.label}>
                          <span className={styles.muted}>{m.label}:</span> {m.value}
                        </div>
                      ))}
                  </td>
                </tr>
              );
            }
            if (r.kind === 'state')
              return (
                <tr key={r.key}>
                  <td className={styles.num}>{s(r.t)}</td>
                  <td>候補の状態</td>
                  <td>
                    {r.candidate_id} v{r.version}: {r.from ?? '—'} → <b>{r.to}</b>（{r.cause}）
                  </td>
                  <td />
                </tr>
              );
            return (
              <tr key={r.key}>
                <td className={styles.num}>{s(r.t)}</td>
                <td>{r.held ? '保留' : '撤回・破棄'}</td>
                <td>
                  {r.source}: {r.candidate_id ?? '—'} {r.reason}
                </td>
                <td />
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className={styles.muted}>「LLM 生成」の欄（理由、なぜ今、待つ損失、緊急度など）はモデルの出力で、実測でもコードの判定でもありません。緊急度は判定に使っていません。</p>
    </div>
  );
}

function delayStats(delays: (number | null)[]): string {
  const v = delays.filter((d): d is number => d !== null);
  if (v.length === 0) return '—';
  const q = (p: number) => Math.round(quantile(v, p) as number);
  return `中央 ${q(0.5)} ／ 最小 ${Math.min(...v)} ／ 最大 ${Math.max(...v)}（${v.length} 件）`;
}

function avertStats(ms: number[]): string {
  if (ms.length === 0) return '—';
  return `中央 ${Math.round(quantile(ms, 0.5) as number)} ／ 計 ${ms.reduce((a, b) => a + b, 0)}`;
}

export function MetricsTable({ recorded, replayed }: { recorded: TuneMetricSet; replayed: TuneMetricSet }) {
  const rows: { label: string; def: string; a: string; b: string }[] = [
    { label: '開始', def: 'AI が話し始めた回数（speech.started）', a: String(recorded.starts), b: String(replayed.starts) },
    {
      label: '発話の途中での開始',
      def: '開始後 1.5 秒以内に、開始より後の音声で同じ利用者の発話の認識文が伸びた開始',
      a: String(recorded.mid_utterance_starts),
      b: String(replayed.mid_utterance_starts),
    },
    {
      label: '同（vad で数えた参考）',
      def: '開始後 1.5 秒以内に vad[0] が発話中の閾値以上になった開始',
      a: String(recorded.mid_utterance_starts_vad),
      b: String(replayed.mid_utterance_starts_vad),
    },
    { label: '発話の終わりから開始までの遅れ（ms）', def: '最後に vad[0] が閾値以上だった時刻から開始まで', a: delayStats(recorded.delays_ms), b: delayStats(replayed.delays_ms) },
    {
      label: 'AI の連続発話',
      def: '前の AI の発話の終わりから利用者の声がないまま始めた開始',
      a: String(recorded.consecutive_ai_starts),
      b: String(replayed.consecutive_ai_starts),
    },
    { label: '視線を逸らした回数', def: 'gaze.decision が away に変わった回数', a: String(recorded.gaze_averts), b: String(replayed.gaze_averts) },
    { label: '逸らした長さ（ms）', def: '逸らしてから戻すまで', a: avertStats(recorded.gaze_avert_ms), b: avertStats(replayed.gaze_avert_ms) },
    { label: '割り込みで止めた発話', def: 'speech.interrupted（再生では L59 で止めた数）', a: String(recorded.interrupts), b: String(replayed.interrupts) },
  ];
  return (
    <table className={styles.table} data-testid="metrics-table">
      <thead>
        <tr>
          <th>指標</th>
          <th>記録</th>
          <th>再計算</th>
          <th>定義</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.label}>
            <td>{r.label}</td>
            <td className={styles.num}>{r.a}</td>
            <td className={styles.num} style={r.a !== r.b ? { fontWeight: 700 } : undefined}>
              {r.b}
            </td>
            <td className={styles.muted}>{r.def}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** 開始の一覧の1件の表示（観測に基づく推定のラベル）。 */
export function outcomeText(outcome: TurnOutcomeBody): string {
  if (outcome.labels.value === null) return `分類なし（${outcome.labels.null_reason}）`;
  return outcome.labels.value.length === 0 ? 'ラベルなし' : outcome.labels.value.join(' ');
}

const OUTCOME_DEFS: [string, string][] = [
  ['suspected_premature_start', '開始の直前まで人の声があり、開始の直後に同じ発話の続きが来た（疑い）'],
  ['user_continued_after_start', '開始より後の音声で ASR の文が伸びた（発話の途中での開始と同じ定義、相槌だけは除く）'],
  ['user_overlap', 'AI の発話中に人の声と内容のある文が重なった'],
  ['backchannel_overlap', 'AI の発話中の人の声が相槌だけ（別に数える）'],
  ['overlap_without_asr', '人の声（vad）は重なったが文にならなかった'],
  ['ai_interrupted_early', 'AI の発話が短いうちに止められた'],
  ['spoke_twice', '前の AI の発話から人の声がないまま話し始めた'],
  ['no_response_after_user_yield', '人が話し終えた後、待っても AI が話し始めなかった'],
];

/** 分類の件数を記録と再計算で並べる。中央値の値は参考。ラベルは推定で、確定した失敗ではない。 */
export function OutcomeMetricsTable({ recorded, replayed, note }: { recorded: TurnOutcomeBody[]; replayed: TurnOutcomeBody[]; note: string | null }) {
  const a = summarizeTurnOutcomes(turnOutcomeRows(recorded));
  const b = summarizeTurnOutcomes(turnOutcomeRows(replayed));
  const count = (s: typeof a, key: string) => String(s.by_label[key] ?? 0);
  const rows = OUTCOME_DEFS.map(([key, def]) => ({ key, def, a: count(a, key), b: count(b, key) }));
  return (
    <div>
      {note ? <p className={styles.muted}>{note}</p> : null}
      <table className={styles.table} data-testid="outcome-metrics-table">
        <thead>
          <tr>
            <th>ラベル</th>
            <th>記録</th>
            <th>再計算</th>
            <th>定義（暫定の閾値、turn.outcome）</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td className={styles.path}>{r.key}</td>
              <td className={styles.num}>{r.a}</td>
              <td className={styles.num} style={r.a !== r.b ? { fontWeight: 700 } : undefined}>
                {r.b}
              </td>
              <td className={styles.muted}>{r.def}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className={styles.muted}>
        発話 記録 {a.ai_utterances}（分類なし {a.unsettled}）／再計算 {b.ai_utterances}（分類なし {b.unsettled}）。重なり（ms）の中央値: 記録 {a.medians.overlap_ms.median ?? '—'}、再計算{' '}
        {b.medians.overlap_ms.median ?? '—'}
      </p>
    </div>
  );
}
