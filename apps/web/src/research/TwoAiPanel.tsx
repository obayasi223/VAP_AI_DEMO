'use client';

/**
 * 2 体の AI の話し合いの研究画面（docs/design/two_ai/03 §3.5、decisions_round5 の M1）。
 * 表示は two_ai_view.ts の集計だけから作る（研究画面へ配信された伏せ字の後のイベント）。計画の本文、LLM の出力、発話の文は出さない。
 * 誤操作を避けるため、キーボードの近道は置かない。未接続・セッションなしでは WoZ のボタンを無効にする。
 */
import { useState } from 'react';
import type { TwoAiCondition, WozAction } from '@llm-vap/contracts';
import styles from './research.module.css';
import { CONDITION_LABEL, type AssistJudgment, type TwoAiViewState, type WozRow } from './two_ai_view';

export interface ArmFields {
  condition: TwoAiCondition;
  script_id: string;
  interjection_feeds_generation: boolean | null;
  session_index: 1 | 2 | null;
  counterbalance_label: string | null;
  operator: string;
}

export type SendResult = { ok: true } | { ok: false; reason: string };

const PHASE_LABEL: Record<string, string> = {
  intake: '聞き取り',
  discussion: '話し合い',
  response: '最後の段（応答）',
  next_step: '最後の段（次の一歩）',
  end: '終わり',
};

const WOZ_LABEL: Record<WozAction, string> = {
  stop: '止める',
  face_user: '本人を向く',
  yield: '譲る',
  resume: '再開',
  correction: '訂正あり',
  advance_phase: '次の段階へ',
  abort: '中止',
};

const STATUS_LABEL: Record<WozRow['status'], string> = {
  sending: '送信中',
  not_sent: '未送信',
  no_response: '応答なし',
  applied: '適用',
  recorded: '記録だけ',
  rejected: '拒否',
  no_session: 'セッションなし',
  invalid: '不正',
};

const ASSIST_LABEL: Record<AssistJudgment, string> = {
  yes: 'yes（訂正と判定）',
  no: 'no（訂正でないと判定）',
  failed: 'failed（判定の失敗）',
  pending: 'pending（判定待ち）',
};

const OUTCOME_LABEL: Record<string, string> = {
  yielded: '止めて譲った',
  backchannel: '相づち',
  false_onset: '誤った停止',
  onset_no_speech: '声なし',
  logged_only: '記録のみ',
  abandoned: '閉じた',
};

function sec(ms: number | null): string {
  return ms === null ? '未計測' : (ms / 1000).toFixed(1);
}

function t(ms: number | null): string {
  return ms === null ? '—' : `${(ms / 1000).toFixed(1)}s`;
}

function Sub({ title, children, testId }: { title: string; children: React.ReactNode; testId?: string }) {
  return (
    <div data-testid={testId}>
      <h3 className={styles.heading}>{title}</h3>
      {children}
    </div>
  );
}

function ArmForm({ state, disabled, onArm }: { state: TwoAiViewState; disabled: boolean; onArm?: (fields: ArmFields) => SendResult }) {
  // 初期値は設定済みの値（なければ ①）。
  const [condition, setCondition] = useState<TwoAiCondition>(state.armed?.condition ?? 'respond_on_spot');
  const [scriptId, setScriptId] = useState('');
  const [sessionIndex, setSessionIndex] = useState<1 | 2 | null>(null);
  const [label, setLabel] = useState('');
  const [feeds, setFeeds] = useState<boolean | null>(null);
  const [operator, setOperator] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const flagDisabled = disabled || condition === 'respond_at_end';
  const submit = () => {
    if (onArm === undefined) return;
    if (scriptId.trim() === '' || operator.trim() === '') {
      setMessage('台本の ID と操作者を入れてください');
      return;
    }
    const result = onArm({
      condition,
      script_id: scriptId.trim(),
      interjection_feeds_generation: condition === 'respond_at_end' ? null : feeds,
      session_index: sessionIndex,
      counterbalance_label: label.trim() === '' ? null : label.trim(),
      operator: operator.trim(),
    });
    setMessage(result.ok ? null : result.reason);
  };
  const armed = state.armed;
  return (
    <div data-testid="two-ai-arm">
      <fieldset disabled={disabled} className={styles.noteForm}>
        {(['respond_on_spot', 'respond_at_end'] as const).map((c) => (
          <label key={c}>
            <input type="radio" name="two_ai_condition" value={c} checked={condition === c} onChange={() => setCondition(c)} /> {CONDITION_LABEL[c]}
          </label>
        ))}
        <label>
          台本の ID <input className={styles.noteInput} value={scriptId} onChange={(e) => setScriptId(e.target.value)} data-testid="arm-script" />
        </label>
        <label>
          セッションの順番{' '}
          <select value={sessionIndex ?? ''} onChange={(e) => setSessionIndex(e.target.value === '' ? null : (Number(e.target.value) as 1 | 2))}>
            <option value="">指定なし</option>
            <option value="1">1 回目</option>
            <option value="2">2 回目</option>
          </select>
        </label>
        <label>
          カウンターバランスの札 <input className={styles.noteInput} value={label} onChange={(e) => setLabel(e.target.value)} />
        </label>
        <label>
          <input
            type="checkbox"
            data-testid="arm-feeds-flag"
            disabled={flagDisabled}
            checked={feeds === true && condition !== 'respond_at_end'}
            onChange={(e) => setFeeds(e.target.checked)}
          />{' '}
          探索：AI が口を挟んだ内容を受けて話す（①′）。未指定は設定の値
        </label>
        <label>
          操作者 <input className={styles.noteInput} value={operator} onChange={(e) => setOperator(e.target.value)} />
        </label>
        <button type="button" className={styles.noteButton} disabled={disabled || onArm === undefined} onClick={submit} data-testid="arm-submit">
          次のセッションに設定
        </button>
      </fieldset>
      {disabled && state.session_running ? <p className={styles.note}>セッション中は設定を変えられません。</p> : null}
      {message ? <p className={styles.warnText}>{message}</p> : null}
      <p data-testid="two-ai-armed">
        設定済み：{armed === null ? 'なし' : `${CONDITION_LABEL[armed.condition]}、組 ${armed.script_id}（${armed.arm_id}）${armed.interjection_feeds_generation === null ? '' : `、旗 ${armed.interjection_feeds_generation ? 'あり' : 'なし'}`}`}
      </p>
      <p data-testid="two-ai-used">このセッションで使った条件：{state.condition_used === null ? '未受信' : CONDITION_LABEL[state.condition_used]}</p>
      {state.arms.length > 0 ? (
        <ul className={styles.noteList}>
          {state.arms.map((a) => (
            <li key={a.arm_id}>
              {a.arm_id}：{CONDITION_LABEL[a.condition]}、組 {a.script_id} → {a.status === 'sending' ? '送信中' : a.status === 'armed' ? '設定済み' : a.status === 'not_sent' ? '未送信' : `拒否（${a.detail ?? a.status}）`}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function WozPanel({
  state,
  enabled,
  onWoz,
}: {
  state: TwoAiViewState;
  enabled: boolean;
  onWoz?: (action: WozAction, point_id: string | null, operator: string) => SendResult;
}) {
  const [operator, setOperator] = useState('');
  const [confirmAbort, setConfirmAbort] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const factSlips = state.points.filter((p) => p.point_kind === 'fact_slip');
  const can = enabled && onWoz !== undefined;
  const send = (action: WozAction, point_id: string | null = null) => {
    if (onWoz === undefined) return;
    const result = onWoz(action, point_id, operator.trim() === '' ? 'researcher' : operator.trim());
    setMessage(result.ok ? null : result.reason);
  };
  const correction = () => {
    if (factSlips.length > 1) setChoosing(true);
    else send('correction', factSlips[0]?.point_id ?? null);
  };
  const actions: WozAction[] = ['stop', 'face_user', 'yield', 'resume', 'correction', 'advance_phase'];
  return (
    <div data-testid="two-ai-woz">
      <label>
        操作者 <input className={styles.noteInput} value={operator} onChange={(e) => setOperator(e.target.value)} />
      </label>
      <div className={styles.noteForm}>
        {actions.map((a) => (
          <button
            key={a}
            type="button"
            className={styles.noteButton}
            disabled={!can}
            data-testid={`woz-${a}`}
            onClick={() => (a === 'correction' ? correction() : send(a))}
          >
            {WOZ_LABEL[a]}
          </button>
        ))}
        {confirmAbort ? (
          <>
            <button type="button" className={styles.noteButton} disabled={!can} data-testid="woz-abort-confirm" onClick={() => { setConfirmAbort(false); send('abort'); }}>
              本当に中止する
            </button>
            <button type="button" className={styles.noteButton} onClick={() => setConfirmAbort(false)}>
              やめる
            </button>
          </>
        ) : (
          <button type="button" className={styles.noteButton} disabled={!can} data-testid="woz-abort" onClick={() => setConfirmAbort(true)}>
            中止
          </button>
        )}
      </div>
      {choosing ? (
        <div className={styles.noteForm}>
          訂正された点：
          {factSlips.map((p) => (
            <button key={p.point_id} type="button" className={styles.noteButton} disabled={!can} onClick={() => { setChoosing(false); send('correction', p.point_id); }}>
              {p.point_id}（{p.speaker}）
            </button>
          ))}
          <button type="button" className={styles.noteButton} onClick={() => setChoosing(false)}>
            やめる
          </button>
        </div>
      ) : null}
      {!enabled ? <p className={styles.note}>未接続か、セッションがないので押せません。</p> : null}
      {message ? <p className={styles.warnText}>{message}</p> : null}
      {state.woz.length > 0 ? (
        <table className={styles.table} data-testid="woz-rows">
          <thead>
            <tr>
              <th>操作</th>
              <th>点</th>
              <th>結果</th>
              <th>段階</th>
            </tr>
          </thead>
          <tbody>
            {state.woz.map((row) => (
              <tr key={row.woz_id} data-status={row.status}>
                <td>{WOZ_LABEL[row.action]}</td>
                <td>{row.point_id ?? ''}</td>
                <td>
                  {STATUS_LABEL[row.status]}
                  {row.status === 'rejected' || row.status === 'no_session' || row.status === 'invalid' || row.status === 'no_response' || row.status === 'not_sent'
                    ? `（${row.detail ?? ''}）`
                    : ''}
                </td>
                <td>{row.phase === null ? '' : (PHASE_LABEL[row.phase] ?? row.phase)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}

export function TwoAiPanel({
  state,
  connected,
  onWoz,
  onArm,
}: {
  state: TwoAiViewState;
  /** WS が開いていて送れる口か。 */
  connected: boolean;
  onWoz?: (action: WozAction, point_id: string | null, operator: string) => SendResult;
  onArm?: (fields: ArmFields) => SendResult;
}) {
  const wozEnabled = connected && state.session_id !== null;
  const can = wozEnabled && onWoz !== undefined;
  const hold = state.hold;
  return (
    <div data-testid="two-ai-panel">
      {state.warnings.length > 0 ? (
        <ul className={styles.warnText} data-testid="two-ai-warnings">
          {state.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      ) : null}

      <Sub title="条件の設定">
        <ArmForm state={state} disabled={!connected || state.session_running} {...(onArm ? { onArm } : {})} />
      </Sub>

      <Sub title="段階" testId="two-ai-phase">
        <p>
          {state.phase === null ? '未受信' : `${PHASE_LABEL[state.phase] ?? state.phase}（経過 ${sec(state.phase_elapsed_ms)} 秒）`}
          {state.session_id ? ` ／ session ${state.session_id}` : ''} ／ 同期の印 {state.sync_marks} 回
        </p>
        {state.plan_wait !== null ? (
          <p data-testid="two-ai-plan-wait">
            計画の待ち：{state.plan_wait.stage}（{sec(state.plan_wait.waited_ms)} 秒）
            {state.plan_wait_paused ? (
              <button type="button" className={styles.noteButton} disabled={!can} onClick={() => onWoz?.('resume', null, 'researcher')}>
                再開
              </button>
            ) : null}
          </p>
        ) : null}
      </Sub>

      {hold !== null ? (
        <Sub title="訂正の判定の保留" testId="two-ai-hold">
          <p>
            点 {hold.point_id ?? '不明'}：残り 約 {sec(hold.remaining_ms)} 秒（推定）／ 補助の判定 {ASSIST_LABEL[hold.assist]}
          </p>
          <button
            type="button"
            className={styles.noteButton}
            disabled={!can}
            data-testid="hold-correction"
            onClick={() => onWoz?.('correction', hold.point_id, 'researcher')}
          >
            訂正
          </button>{' '}
          <button type="button" className={styles.noteButton} disabled={!can} data-testid="hold-resume" onClick={() => onWoz?.('resume', null, 'researcher')}>
            訂正でない
          </button>
        </Sub>
      ) : null}

      <Sub title="WoZ">
        <WozPanel state={state} enabled={wozEnabled} {...(onWoz ? { onWoz } : {})} />
      </Sub>

      <Sub title="計画した点" testId="two-ai-points">
        {state.points.length === 0 ? (
          <p className={styles.unmeasured}>two_ai.point 未受信</p>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>id</th>
                <th>種類</th>
                <th>話す AI</th>
                <th>きっかけ</th>
                <th>状態</th>
                <th className={styles.num}>接触秒数（全体／新しい部分）</th>
                <th>訂正</th>
              </tr>
            </thead>
            <tbody>
              {state.points.map((p) => (
                <tr key={p.point_id}>
                  <td>{p.point_id}</td>
                  <td>{p.point_kind}</td>
                  <td>{p.speaker}</td>
                  <td>{p.trigger}</td>
                  <td>
                    {p.state}
                    {p.state === '展開中' ? `（${p.elaborated_turns} ターン）` : ''}
                  </td>
                  <td className={styles.num}>
                    {sec(p.exposure_total_ms)}／{sec(p.exposure_new_ms)}
                    {p.complete === false ? '（途中）' : ''}
                  </td>
                  <td>{p.correction ?? 'なし'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Sub>

      <Sub title="割り込みのライブの記録" testId="two-ai-interjections">
        <p>
          ① 止めた {state.counts.stopped} 回、譲った {state.counts.yielded} 回 ／ ② 話し始めの記録 {state.counts.logged_only} 回
        </p>
        {state.interjections.length === 0 ? null : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>時刻</th>
                <th>段階</th>
                <th>話していた AI</th>
                <th>検出の元</th>
                <th className={styles.num}>止まるまで（ms）</th>
                <th>結果</th>
                <th>受け止め</th>
                <th>台本へ戻った</th>
              </tr>
            </thead>
            <tbody>
              {state.interjections.map((r) => (
                <tr key={r.interjection_id}>
                  <td>{t(r.at_ms)}</td>
                  <td>{r.phase === null ? '' : (PHASE_LABEL[r.phase] ?? r.phase)}</td>
                  <td>{r.interrupted_ai ?? '（AI 同士の間）'}</td>
                  <td>{r.decision_source}</td>
                  <td className={styles.num}>{r.logged_only ? '—' : r.stop_latency_ms === null ? '未計測' : r.stop_latency_ms.toFixed(0)}</td>
                  <td>{r.logged_only ? '記録のみ（止めない）' : r.outcome === null ? r.last_stage : (OUTCOME_LABEL[r.outcome] ?? r.outcome)}</td>
                  <td>{r.ack_done === null ? '' : r.ack_done ? '済み' : 'なし'}</td>
                  <td>{t(r.resumed_at_ms)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Sub>

      <Sub title="段と板と印" testId="two-ai-board">
        {state.stages.length > 0 ? (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>段</th>
                <th>見出し</th>
                <th>始まり</th>
                <th>終わり</th>
                <th className={styles.num}>中身の時計（秒）</th>
              </tr>
            </thead>
            <tbody>
              {state.stages.map((s) => (
                <tr key={s.discussion_stage}>
                  <td>{s.discussion_stage}</td>
                  <td>{s.heading}</td>
                  <td>{t(s.started_at_ms)}</td>
                  <td>{t(s.ended_at_ms)}</td>
                  <td className={styles.num}>
                    {sec(s.content_start_ms)}〜{s.content_end_ms === null ? '' : sec(s.content_end_ms)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className={styles.unmeasured}>two_ai.stage 未受信</p>
        )}
        {state.board === null ? (
          <p className={styles.unmeasured}>板 未受信</p>
        ) : (
          <>
            <p>
              板：版 {state.board.version}、{state.board.mode}（{t(state.board.at_ms)}）{state.board.rebuilt ? '、作り直し済み' : ''}
              {state.board.picked
                ? `、選択 ${state.board.picked.outcome === 'picked' ? (state.board.picked.card_id ?? '') : state.board.picked.outcome}${state.board.picked.latency_ms === null ? '' : `（${sec(state.board.picked.latency_ms)} 秒）`}`
                : ''}
            </p>
            <ol className={styles.noteList}>
              {state.board.cards.map((c) => (
                <li key={c.card_id} data-picked={state.board?.picked?.card_id === c.card_id ? 'true' : undefined}>
                  [{c.depends_on}／{c.variant}] {c.redacted ? '（伏せ字：再生の後に表示）' : c.text}
                </li>
              ))}
            </ol>
          </>
        )}
        <p data-testid="two-ai-markers">
          印：{state.markers.counted} 件（記録 {state.markers.total} 件）
          {Object.entries(state.markers.by_stage)
            .map(([k, v]) => `、${k} ${v} 件`)
            .join('')}
        </p>
        {state.markers.rows.length > 0 ? (
          <ul className={styles.noteList}>
            {state.markers.rows.map((m) => (
              <li key={m.marker_id}>
                {t(m.at_ms)} 話していた AI {m.ai_speaking ?? 'なし'}
                {m.during_point_id ? `、点 ${m.during_point_id}` : ''}
                {m.counted ? '' : '（連打で数えない）'}
              </li>
            ))}
          </ul>
        ) : null}
      </Sub>

      <Sub title="撤回と描画" testId="two-ai-retraction">
        <p>
          {state.retraction === null
            ? '撤回：未受信'
            : state.retraction.timing === 'after_measures'
              ? '撤回は事後の測度の後に研究者が読む（要約の道具の retraction.md）'
              : `撤回：${t(state.retraction.at_ms)} に話した（${sec(state.retraction.played_ms)} 秒、点 ${state.retraction.point_ids.join('、') || 'なし'}）`}
        </p>
        <p>
          {state.render === null
            ? '描画：render.health 未受信'
            : `描画：fps 中央値 ${state.render.fps_median.toFixed(0)}（p5 ${state.render.fps_p5.toFixed(0)}）、フレーム p95 ${state.render.frame_ms_p95.toFixed(0)}ms、long task ${state.render.long_tasks}、アバター ${state.render.avatars} 体`}
        </p>
        {state.anomalies.length > 0 ? (
          <ul className={styles.noteList}>
            {state.anomalies.slice(-20).map((a, i) => (
              <li key={`${a.at_ms}/${i}`}>
                {t(a.at_ms)} {a.kind}
                {a.speaker ? `（${a.speaker}）` : ''} {a.detail}
              </li>
            ))}
          </ul>
        ) : null}
      </Sub>
    </div>
  );
}
