'use client';

/**
 * 参加者画面（レーン J）。「はじめる」を1回押すと、あとはハンズフリーで話せる。
 * クエリ: ?ws=ws://localhost:8787/ws（既定は NEXT_PUBLIC_ORCHESTRATOR_WS_URL、なければ同じホストの 8787）
 *         ?model=/models/xxx.vrm
 *         ?condition=reactive|initiative_inhale|initiative_no_cue（開始画面の選択の初期値。既定は
 *           NEXT_PUBLIC_DEFAULT_CONDITION、なければ未選択で orchestrator の CONDITION に任せる）
 *         ?conversation_kind=joint_thinking|companion ?timing_strategy=llm|immediate|v2（開始画面の選択の初期値。
 *           既定は NEXT_PUBLIC_DEFAULT_CONVERSATION_KIND／NEXT_PUBLIC_DEFAULT_TIMING_STRATEGY、なければ未選択で orchestrator の既定）
 * 研究条件の選択は開始画面に出す。本番の実験で参加者に条件名を見せないときは NEXT_PUBLIC_HIDE_CONDITION_PICKER=1 で
 * 選択を隠す（条件を送らず、orchestrator の CONDITION に任せる。orchestrator 側も CONDITION_FROM_CLIENT=0 で固定する）。
 * 試験（apps/orchestrator/test/e2e）は window.__participant を読む。
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { Avatar } from '../../src/avatar';
import {
  CONDITION_LABELS,
  CONVERSATION_KIND_LABELS,
  INITIAL_VIEW,
  ParticipantController,
  TIMING_STRATEGY_LABELS,
  type ParticipantView,
} from '../../src/session/participant';
import type { Condition } from '@llm-vap/contracts/common';
import type { ConversationKind, TimingStrategy } from '@llm-vap/contracts';

const CONDITIONS: Condition[] = ['reactive', 'initiative_inhale', 'initiative_no_cue'];
const isCondition = (value: string | null | undefined): value is Condition => CONDITIONS.includes(value as Condition);
const CONVERSATION_KINDS: ConversationKind[] = ['joint_thinking', 'companion'];
const TIMING_STRATEGIES: TimingStrategy[] = ['llm', 'immediate', 'v2'];

/** URL、環境変数の順で初期値を読む。どちらもなければ null（未選択で orchestrator の既定に任せる）。 */
function initialChoice<T extends string>(param: string, env: string | undefined, allowed: readonly T[]): T | null {
  if (typeof window !== 'undefined') {
    const query = new URLSearchParams(window.location.search).get(param);
    if (allowed.includes(query as T)) return query as T;
  }
  return allowed.includes(env as T) ? (env as T) : null;
}

/** 選択を隠す（本番の実験）。隠すときは条件を送らない。 */
const HIDE_CONDITION_PICKER = process.env.NEXT_PUBLIC_HIDE_CONDITION_PICKER === '1';

/** 開始画面の選択の初期値。null は未選択で、条件を送らず orchestrator の CONDITION に任せる。 */
function initialCondition(): Condition | null {
  if (typeof window !== 'undefined') {
    const query = new URLSearchParams(window.location.search).get('condition');
    if (isCondition(query)) return query;
  }
  const env = process.env.NEXT_PUBLIC_DEFAULT_CONDITION;
  return isCondition(env) ? env : null;
}

const DEFAULT_MODEL = '/models/Sendagaya_Shino.vrm';

declare global {
  interface Window {
    __participant?: {
      controller: ParticipantController;
      avatar: () => Avatar | null;
      avatarError: () => string | null;
    };
  }
}

function defaultWsUrl(): string {
  const query = new URLSearchParams(window.location.search).get('ws');
  if (query) return query;
  const env = process.env.NEXT_PUBLIC_ORCHESTRATOR_WS_URL;
  if (env) return env;
  return `ws://${window.location.hostname}:8787/ws`;
}

function describeReason(reason: string): string | null {
  if (reason.startsWith('vap:rewarm')) return '話者交替の予測（VAP）を準備しています。始めの10秒ほどは AI が返事をしにくいことがあります。';
  if (reason.startsWith('vap:worker_not_started') || reason.startsWith('vap:no_vap_state')) return '話者交替の予測（VAP）が動いていません。';
  if (reason.startsWith('vap:')) return '話者交替の予測（VAP）が一時的に使えません。';
  if (reason.startsWith('vap_unavailable')) return '話者交替の予測（MaAI）を起動していません。';
  if (reason.startsWith('stt_unavailable')) return '音声認識に接続できません。';
  if (reason.startsWith('tts_unavailable')) return '音声合成に接続できません。';
  if (reason.startsWith('llm_unavailable')) return '応答生成に接続できません。';
  if (reason.startsWith('completion_unavailable')) return '発話の終わりの推定が使えません。AI の返事が遅れることがあります。';
  if (reason.startsWith('negotiation_unavailable')) return '発話の申し出の機能が動いていません。研究者に知らせてください。';
  if (reason.startsWith('test_double')) return null; // 下の「試験用」の表示で出す
  return reason;
}

const LINK_TEXT: Record<ParticipantView['link'], string> = {
  none: '未接続',
  connecting: '接続中…',
  open: '接続中…',
  ready: '接続済み',
  closed: '切断（自動で再接続します）',
  elsewhere: '別のタブで接続中のため、つないでいません',
};

export default function ParticipantPage() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const avatarRef = useRef<Avatar | null>(null);
  const avatarErrorRef = useRef<string | null>(null);
  const controllerRef = useRef<ParticipantController | null>(null);
  const [view, setView] = useState<ParticipantView>(INITIAL_VIEW);
  const [avatarStatus, setAvatarStatus] = useState('アバターを読み込み中…');
  const [condition, setCondition] = useState<Condition | null>(null);
  const [conversationKind, setConversationKind] = useState<ConversationKind | null>(null);
  const [timingStrategy, setTimingStrategy] = useState<TimingStrategy | null>(null);
  useEffect(() => {
    setCondition(initialCondition());
    setConversationKind(initialChoice('conversation_kind', process.env.NEXT_PUBLIC_DEFAULT_CONVERSATION_KIND, CONVERSATION_KINDS));
    setTimingStrategy(initialChoice('timing_strategy', process.env.NEXT_PUBLIC_DEFAULT_TIMING_STRATEGY, TIMING_STRATEGIES));
  }, []);

  if (controllerRef.current === null && typeof window !== 'undefined') {
    controllerRef.current = new ParticipantController({
      wsUrl: defaultWsUrl(),
      avatar: () => avatarRef.current,
      onView: setView,
    });
  }

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    let created: Avatar | null = null;
    const modelUrl = new URLSearchParams(window.location.search).get('model') ?? DEFAULT_MODEL;
    (async () => {
      try {
        const { createAvatar } = await import('../../src/avatar/runtime');
        const avatar = await createAvatar({
          container,
          modelUrl,
          framing: 'bust',
          onGazeReport: (report) => controllerRef.current?.gazeRendered(report),
        });
        if (cancelled) {
          avatar.dispose();
          return;
        }
        created = avatar;
        avatarRef.current = avatar;
        setAvatarStatus('');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        avatarErrorRef.current = message;
        setAvatarStatus(`アバターを表示できません（${message}）。会話はできます。`);
      }
    })();
    return () => {
      cancelled = true;
      created?.dispose();
      avatarRef.current = null;
    };
  }, []);

  useEffect(() => {
    const controller = controllerRef.current;
    if (!controller) return;
    window.__participant = { controller, avatar: () => avatarRef.current, avatarError: () => avatarErrorRef.current };
    return () => {
      delete window.__participant;
    };
  }, []);

  const reasons = [...new Set(view.reasons.map(describeReason).filter((r): r is string => r !== null))];
  const settings = view.trackSettings;
  const flag = (v: { value: boolean | null } | undefined) => (v?.value === null || v === undefined ? '不明' : v.value ? 'ON' : 'OFF');

  return (
    <main style={styles.main}>
      <div style={styles.stage}>
        <div ref={containerRef} style={styles.canvas} data-testid="avatar-stage" />
        {avatarStatus && <p style={styles.avatarStatus}>{avatarStatus}</p>}
      </div>
      <aside style={styles.panel}>
        {view.phase === 'idle' || view.phase === 'failed' || view.phase === 'stopped' ? (
          <>
            <p style={styles.notice}>
              <strong>有線のヘッドセット</strong>（マイク付き）を使ってください。スピーカーや Bluetooth
              では正しく動きません。
            </p>
            <button
              id="start"
              type="button"
              style={styles.button}
              onClick={() =>
                void controllerRef.current?.start(
                  HIDE_CONDITION_PICKER
                    ? { condition: null, conversation_kind: null, timing_strategy: null }
                    : { condition, conversation_kind: conversationKind, timing_strategy: timingStrategy },
                )
              }
            >
              はじめる
            </button>
            {!HIDE_CONDITION_PICKER && (
              <fieldset style={styles.conditions} data-testid="condition-picker">
                <legend style={styles.small}>応答のしかた（体験用）</legend>
                <label style={styles.conditionLabel}>
                  <input
                    type="radio"
                    name="condition"
                    value=""
                    checked={condition === null}
                    onChange={() => setCondition(null)}
                  />{' '}
                  指定しない（サーバーの既定）
                </label>
                {CONDITIONS.map((c) => (
                  <label key={c} style={styles.conditionLabel}>
                    <input
                      type="radio"
                      name="condition"
                      value={c}
                      checked={condition === c}
                      onChange={() => setCondition(c)}
                    />{' '}
                    {CONDITION_LABELS[c]}
                  </label>
                ))}
              </fieldset>
            )}
            {!HIDE_CONDITION_PICKER && (
              <fieldset style={styles.conditions} data-testid="conversation-kind-picker">
                <legend style={styles.small}>会話の種類（体験用）</legend>
                <label style={styles.conditionLabel}>
                  <input
                    type="radio"
                    name="conversation_kind"
                    value=""
                    checked={conversationKind === null}
                    onChange={() => setConversationKind(null)}
                  />{' '}
                  指定しない（サーバーの既定）
                </label>
                {CONVERSATION_KINDS.map((k) => (
                  <label key={k} style={styles.conditionLabel}>
                    <input
                      type="radio"
                      name="conversation_kind"
                      value={k}
                      checked={conversationKind === k}
                      onChange={() => setConversationKind(k)}
                    />{' '}
                    {CONVERSATION_KIND_LABELS[k]}
                  </label>
                ))}
              </fieldset>
            )}
            {!HIDE_CONDITION_PICKER && (
              <fieldset style={styles.conditions} data-testid="timing-strategy-picker">
                <legend style={styles.small}>申し出るタイミング（体験用）</legend>
                <label style={styles.conditionLabel}>
                  <input
                    type="radio"
                    name="timing_strategy"
                    value=""
                    checked={timingStrategy === null}
                    onChange={() => setTimingStrategy(null)}
                  />{' '}
                  指定しない（サーバーの既定）
                </label>
                {TIMING_STRATEGIES.map((t) => (
                  <label key={t} style={styles.conditionLabel}>
                    <input
                      type="radio"
                      name="timing_strategy"
                      value={t}
                      checked={timingStrategy === t}
                      onChange={() => setTimingStrategy(t)}
                    />{' '}
                    {TIMING_STRATEGY_LABELS[t]}
                  </label>
                ))}
              </fieldset>
            )}
            <p style={styles.small}>押すとマイクの許可を求められます。「許可」を選んでください。</p>
          </>
        ) : (
          <div data-testid="state">
            <p style={styles.big}>
              {view.phase === 'starting' ? '準備中…' : view.aiSpeaking ? 'AI が話しています' : 'どうぞ話してください'}
            </p>
            <p style={styles.small}>接続: {LINK_TEXT[view.link]}</p>
            <button type="button" style={styles.stopButton} onClick={() => void controllerRef.current?.stop()}>
              終了する
            </button>
          </div>
        )}
        {view.error && (
          <p role="alert" style={styles.error}>
            {view.error}
          </p>
        )}
        {view.isFake && (
          <p style={styles.warn} data-testid="fake">
            試験用の設定です（台本のプロバイダを使っています）。本番の記録には数えません。
          </p>
        )}
        {reasons.map((reason) => (
          <p key={reason} style={styles.warn}>
            {reason}
          </p>
        ))}
        {view.warnings.map((warning) => (
          <p key={warning} style={styles.warn}>
            {warning}
          </p>
        ))}
        {settings && (
          <details style={styles.details}>
            <summary>マイクの設定</summary>
            <ul style={styles.list}>
              <li>エコーキャンセル: {flag(settings.echoCancellation)}（OFF が正常）</li>
              <li>ノイズ抑制: {flag(settings.noiseSuppression)}（OFF が正常）</li>
              <li>自動音量調整: {flag(settings.autoGainControl)}（OFF が正常）</li>
              <li>処理レート: {view.sampleRateHz ?? '不明'} Hz</li>
              {view.inputDevices.map((d) => (
                <li key={d.label + String(d.isDefault)}>
                  {d.isDefault ? '使用中（既定）: ' : '接続あり: '}
                  {d.label}
                </li>
              ))}
            </ul>
            <p style={styles.small}>
              使うマイクを変えるには、Windows の「サウンドの設定」で入力と出力の既定をヘッドセットにしてから、ページを再読み込みしてください。
            </p>
          </details>
        )}
        {view.sessionId && (
          <p style={styles.tiny}>
            session: {view.sessionId}
            {!HIDE_CONDITION_PICKER && view.condition && ` ／ ${CONDITION_LABELS[view.condition]}`}
          </p>
        )}
      </aside>
    </main>
  );
}

const styles: Record<string, CSSProperties> = {
  main: { display: 'flex', height: '100vh', margin: 0, fontFamily: 'system-ui, sans-serif', background: '#f4f4f2' },
  stage: { flex: 1, position: 'relative', minWidth: 0 },
  canvas: { position: 'absolute', inset: 0 },
  avatarStatus: { position: 'absolute', left: 16, bottom: 16, margin: 0, color: '#555' },
  panel: { width: 340, padding: 20, boxSizing: 'border-box', background: '#fff', borderLeft: '1px solid #ddd', overflowY: 'auto' },
  notice: { fontSize: 15, lineHeight: 1.6 },
  button: { fontSize: 22, padding: '14px 40px', borderRadius: 8, border: 'none', background: '#2f6fdd', color: '#fff', cursor: 'pointer' },
  stopButton: { fontSize: 14, padding: '6px 16px', marginTop: 12 },
  big: { fontSize: 22, margin: '8px 0' },
  small: { fontSize: 13, color: '#555' },
  tiny: { fontSize: 11, color: '#999', marginTop: 24 },
  warn: { fontSize: 13, background: '#fff4d6', border: '1px solid #e9c46a', padding: 8, borderRadius: 4 },
  error: { fontSize: 14, background: '#fde2e1', border: '1px solid #e07a7a', padding: 8, borderRadius: 4 },
  details: { marginTop: 16, fontSize: 13 },
  list: { paddingLeft: 18 },
  conditions: { marginTop: 16, border: '1px solid #ddd', borderRadius: 4, padding: '6px 10px' },
  conditionLabel: { display: 'block', fontSize: 14, margin: '4px 0' },
};
