'use client';

/**
 * I2 の表示部品: p の時系列の凡例と図、候補のライブ表示、準備・割り込みの率、研究者のメモ。
 * 規則（I1 と同じ）: 未計測は 0 と書かない。LLM の出力は「LLM 生成」と書き、実測の時刻と別の欄に置く。
 */
import { useState } from 'react';
import type { CandidateSummary, DecisionRow } from './candidates_view';
import type { InterruptStats, PrepareStats, Rate } from './rates';
import styles from './research.module.css';
import { TimelineCanvas } from './TimelineCanvas';
import type { DirectionInfo, LiveSnapshot, NoteRow } from './view_store';

const RATE_REASON: Record<string, string> = {
  no_prefetch: 'prefetch.started なし',
  no_settled_prefetch: '決着した準備なし（進行中のみ）',
  no_ready_prefetch: '合成を終えた準備なし',
  no_settled_ready_prefetch: '合成を終えて決着した準備なし',
  no_ai_speech: 'AI の発話なし',
};

function RateText({ value }: { value: Rate }) {
  if (value.status === 'unmeasured') {
    return <span className={styles.unmeasured}>未計測（{RATE_REASON[value.reason] ?? value.reason}）</span>;
  }
  return (
    <span>
      {(value.rate * 100).toFixed(0)}%（{value.numerator} / {value.denominator}）
    </span>
  );
}

function ms(v: number): string {
  return v.toFixed(0);
}

// ---- p の時系列 --------------------------------------------------------------

function directionText(d: DirectionInfo): string {
  const user = d.p_ai_index === 0 ? 1 : 0;
  const base = `AI = p[${d.p_ai_index}]（ch${d.p_ai_index + 1}）、利用者 = p[${user}]（ch${user + 1}）`;
  if (d.source === 'orchestrator') {
    return `${base}。orchestrator の方策 ${d.policy_id ?? '不明'} の policy.vap.p_ai_index（${d.direction_status === 'measured' ? '実測で確定' : '暫定'}）`;
  }
  if (d.source === 'fake') return `${base}。偽の口が送った設定`;
  return `${base}。orchestrator から向きを受けていないので、実測で確定した既定の向きを仮定して描いています`;
}

export function TimelinePanel({ live, direction }: { live: LiveSnapshot; direction: DirectionInfo }) {
  const view = live.timeline;
  const layouts = new Set(view.vap.map((s) => s.layout));
  return (
    <>
      <div className={styles.legend} data-testid="timeline-legend">
        <span>
          <i className={`${styles.swatch} ${styles.swatchAi}`} /> AI（実線）
        </span>
        <span>
          <i className={`${styles.swatch} ${styles.swatchUser}`} /> 利用者（破線）
        </span>
        <span>
          <i className={`${styles.swatch} ${styles.swatchAllowed}`} /> 発話の許可（turn.allowed）
        </span>
        <span>
          <i className={`${styles.dot} ${styles.dotGaze}`} /> 視線の判断
        </span>
        <span>
          <i className={`${styles.dot} ${styles.dotInitiative}`} /> 発話希望（NEW 等）
        </span>
        <span>
          <i className={`${styles.swatch} ${styles.swatchInterrupt}`} /> 割り込みで停止
        </span>
      </div>
      <p className={direction.source === 'assumed' ? styles.warnText : styles.note} data-testid="direction-text">
        p の添字: {directionText(direction)}。vad は常に [0]=利用者（mic）、[1]=AI（sys）。
      </p>
      <p className={styles.note}>
        直近 {view.window_ms / 1000} 秒。右端は受信した最新のイベントの時刻（t_monotonic_ms）。利用者の発話は VAP の
        user_speaking、AI の発話は speech.started〜ended／interrupted。表示の更新は 0.5 秒ごとで、タブが見えない間は止まります。
        {layouts.has('1ch') ? ' 1ch の p は 2 者の配分ではなく自己発話の期待値なので、利用者の線だけに描いています。' : ''}
      </p>
      {view.vap.length === 0 ? <p className={styles.unmeasured}>vap.state 未受信</p> : null}
      <TimelineCanvas view={view} direction={direction} />
    </>
  );
}

// ---- 候補 --------------------------------------------------------------------

const DECISION_LABEL: Record<string, string> = {
  NONE: 'NONE（希望なし）',
  NEW: 'NEW',
  KEEP: 'KEEP',
  REVISE: 'REVISE',
  WITHDRAW: 'WITHDRAW',
};

function DecisionCard({ row }: { row: DecisionRow }) {
  return (
    <li className={styles.decision} data-testid="decision-row">
      <div className={styles.decisionHead}>
        <strong>
          {row.stage === 'desire' ? '生成段 ' : row.stage === 'timing' ? 'タイミング段 ' : ''}
          {DECISION_LABEL[row.decision] ?? row.decision}
        </strong>
        {row.candidate_id === null ? null : (
          <span>
            {row.candidate_id} v{row.candidate_version}
          </span>
        )}
        <span className={styles.note}>
          segment {row.segment_id} / rev {row.transcript_revision} / {row.request_id} / {row.model_version}
        </span>
      </div>
      <div className={styles.decisionBody}>
        <div>
          <div className={styles.colLabel}>実測（orchestrator の時計, ms）</div>
          <div>
            {row.model_call ? (
              <>
                送信 {ms(row.measured.sent_at)} → 受信 {ms(row.measured.received_at)}（LLM {ms(row.measured.llm_ms)}ms）
              </>
            ) : (
              'LLM の呼び出しなし（コードの判定）'
            )}
          </div>
          {row.measured.decision_time === null ? null : (
            <div>
              {row.measured.decision_time.name} {ms(row.measured.decision_time.t_ms)}
            </div>
          )}
          {row.verified.map((v) => (
            <div key={v.label}>
              <span className={styles.colLabel}>コード検証</span> {v.label}: {v.value}（{v.method}）
            </div>
          ))}
        </div>
        <div className={styles.modelCol}>
          <div className={styles.colLabel}>
            <span className={styles.llmChip}>LLM 生成</span> 判定に使っていない文。事実の記録ではありません
          </div>
          {row.model.map((m) => (
            <div key={m.label}>
              <span className={styles.colLabel}>{m.label}:</span>{' '}
              {m.value === null ? <span className={styles.unmeasured}>なし（{m.null_reason}）</span> : `「${m.value}」`}
            </div>
          ))}
        </div>
      </div>
    </li>
  );
}

export function CandidatePanel({ candidates }: { candidates: CandidateSummary }) {
  const counts = Object.entries(candidates.counts);
  const empty = candidates.decisions.length === 0 && candidates.state_changes.length === 0;
  return (
    <>
      <p data-testid="candidate-counts">
        判断の回数:{' '}
        {counts.length === 0 ? <span className={styles.unmeasured}>initiative.decision／desire／timing 未受信</span> : counts.map(([k, n]) => `${k} ${n}`).join('、')}
        {' / '}棄却 {candidates.discarded}・中断 {candidates.aborted}（initiative.discarded／aborted。E2a の拒否の写しは除く）・E2a の拒否{' '}
        {candidates.rejected}（candidate.rejected と active_candidate_exists）
      </p>
      {empty ? (
        <p className={styles.unmeasured} data-testid="candidates-empty">
          候補のイベントはまだありません（initiative.decision、initiative.desire、initiative.timing と candidate.state_changed を待っています）
        </p>
      ) : null}
      {candidates.current.length === 0 ? null : (
        <p>
          いまの候補:{' '}
          {candidates.current.map((c) => `${c.candidate_id} v${c.candidate_version} ${c.state}（${ms(c.since_ms)}ms から）`).join('、')}
        </p>
      )}
      {candidates.decisions.length === 0 ? null : (
        <ul className={styles.decisionList}>
          {candidates.decisions.map((row) => (
            <DecisionCard key={row.key} row={row} />
          ))}
        </ul>
      )}
      {candidates.drops.length === 0 ? null : (
        <table className={`${styles.table} ${styles.wrapTable}`} data-testid="candidate-drops">
          <thead>
            <tr>
              <th className={styles.num}>時刻 ms</th>
              <th>出所</th>
              <th>候補</th>
              <th>理由（コードの値）</th>
            </tr>
          </thead>
          <tbody>
            {candidates.drops.map((row) => (
              <tr key={row.key}>
                <td className={styles.num}>{ms(row.t_ms)}</td>
                <td>{row.source === 'candidate.rejected' ? `E2a の拒否（${row.operation ?? '?'}）` : 'G の棄却'}</td>
                <td>{row.candidate_id ?? '（未採番）'}</td>
                <td>
                  {row.reason}
                  {row.held ? '（保留）' : ''}
                  {row.details.length > 0 ? ` — ${row.details.join('、')}` : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {candidates.state_changes.length === 0 ? null : (
        <table className={`${styles.table} ${styles.wrapTable}`}>
          <thead>
            <tr>
              <th className={styles.num}>時刻 ms</th>
              <th>候補</th>
              <th>遷移</th>
              <th>原因</th>
            </tr>
          </thead>
          <tbody>
            {candidates.state_changes.map((row) => (
              <tr key={row.key}>
                <td className={styles.num}>{ms(row.t_ms)}</td>
                <td>
                  {row.candidate_id} v{row.candidate_version}
                </td>
                <td>
                  {row.from ?? '（登録）'} → {row.to}
                </td>
                <td>
                  {row.cause.source === 'code'
                    ? `コード: ${row.cause.cause}`
                    : `モデルの判断 ${row.cause.decision}（${row.cause.request_id}）`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

// ---- 準備と割り込み ------------------------------------------------------------

export function OutcomePanel({ prepare, interrupts }: { prepare: PrepareStats; interrupts: InterruptStats }) {
  const reasons = Object.entries(prepare.cancel_reasons);
  const sources = Object.entries(interrupts.by_decision_source);
  return (
    <>
      <dl className={styles.list}>
        <div className={styles.listRow}>
          <dt>準備の取消率</dt>
          <dd data-testid="cancel-rate">
            <RateText value={prepare.cancel_rate} />
            <span className={styles.note}> 取り消した準備 / 決着した準備（取消＋再生）</span>
          </dd>
        </div>
        <div className={styles.listRow}>
          <dt>空振り率</dt>
          <dd data-testid="miss-rate">
            <RateText value={prepare.miss_rate} />
            <span className={styles.note}> 合成を終えたのに使わなかった準備 / 合成を終えて決着した準備</span>
          </dd>
        </div>
        <div className={styles.listRow}>
          <dt>準備の件数</dt>
          <dd>
            {prepare.started === 0 ? (
              <span className={styles.unmeasured}>未計測（prefetch.started なし）</span>
            ) : (
              `開始 ${prepare.started}・合成済み ${prepare.ready}・再生 ${prepare.used}・取消 ${prepare.cancelled}・進行中 ${prepare.in_progress}`
            )}
            {prepare.unmatched > 0 ? `（開始を受けていない ${prepare.unmatched} 件は数えていない）` : ''}
          </dd>
        </div>
        <div className={styles.listRow}>
          <dt>取消の理由</dt>
          <dd>{reasons.length === 0 ? <span className={styles.unmeasured}>なし</span> : reasons.map(([k, n]) => `${k} ${n}`).join('、')}</dd>
        </div>
        <div className={styles.listRow}>
          <dt>割り込み</dt>
          <dd data-testid="interrupts">
            {interrupts.ai_speech_started === 0 && interrupts.interrupted === 0 ? (
              <span className={styles.unmeasured}>未計測（AI の発話なし）</span>
            ) : (
              <>
                {interrupts.interrupted} 回（AI の発話 {interrupts.ai_speech_started} 回のうち <RateText value={interrupts.interrupt_rate} />）
                {sources.length === 0 ? '' : ` 判定: ${sources.map(([k, n]) => `${k} ${n}`).join('、')}`}
              </>
            )}
          </dd>
        </div>
      </dl>
      <p className={styles.note}>
        今のセッションの受信分の累計です。画面を後から開いた場合、それより前は orchestrator の backlog（最新 3000 件）に残っている分だけです。
      </p>
    </>
  );
}

// ---- 研究者のメモ ---------------------------------------------------------------

const NOTE_STATUS: Record<NoteRow['status'], string> = {
  sending: '送信中',
  logged: 'ログに記録済み',
  no_session: '記録されていません（セッションなし）',
  invalid: '記録されていません（契約に合わない）',
  not_sent: '送れませんでした',
};

export function NotePanel({
  notes,
  canSend,
  onSend,
}: {
  notes: NoteRow[];
  canSend: boolean;
  onSend?: (text: string) => { ok: true } | { ok: false; reason: string };
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    if (!onSend) return;
    const result = onSend(text);
    if (result.ok) {
      setText('');
      setError(null);
    } else setError(result.reason);
  };
  return (
    <>
      <p className={styles.note}>
        自由回答のメモは、送ると今のセッションの events.jsonl に research.note として記録されます（時刻は orchestrator の受信時刻）。
      </p>
      {canSend ? null : (
        <p className={styles.unmeasured} data-testid="note-disabled">
          このデータ源ではメモを送れません（WS で orchestrator に接続したときだけ送れます）
        </p>
      )}
      <form
        className={styles.noteForm}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <textarea
          className={styles.noteInput}
          data-testid="note-input"
          value={text}
          rows={2}
          maxLength={4000}
          disabled={!canSend}
          placeholder="例: 利用者が言い直した、AI の声が重なった"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <button type="submit" className={styles.noteButton} data-testid="note-send" disabled={!canSend}>
          記録する（Ctrl+Enter）
        </button>
      </form>
      {error ? <p className={styles.warnText}>{error}</p> : null}
      {notes.length === 0 ? null : (
        <ul className={styles.noteList} data-testid="note-list">
          {notes.map((n) => (
            <li key={n.note_id}>
              <span className={n.status === 'logged' ? styles.health_ok : styles.warnText}>{NOTE_STATUS[n.status]}</span>
              {n.logged_at_ms === null ? '' : `（${ms(n.logged_at_ms)}ms）`}
              {n.detail ? `（${n.detail}）` : ''} {n.text}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
