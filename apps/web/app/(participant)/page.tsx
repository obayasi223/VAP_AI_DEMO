'use client';

/**
 * 参加者画面（レーン J）。「はじめる」を1回押すと、あとはハンズフリーで話せる。
 * クエリ: ?ws=ws://localhost:8787/ws（既定は NEXT_PUBLIC_ORCHESTRATOR_WS_URL、なければ同じホストの 8787）
 *         ?model=/models/xxx.vrm
 *         ?avatar=rocketbox|none（既定は VRM。NEXT_PUBLIC_AVATAR でも指定できる。参加者画面には選択肢を出さない。docs/avatar_swap_eval.md）
 *         ?breath_sound=0.006（吸気音の音量。0 で無音）
 *         ?breath_profile=default|original|weak（吸気の動きの大きさ。比較用）
 *         ?condition=reactive|initiative_inhale|initiative_no_cue（開始画面の選択の初期値。既定は
 *           NEXT_PUBLIC_DEFAULT_CONDITION、なければ未選択で orchestrator の CONDITION に任せる）
 *         ?conversation_kind=joint_thinking|companion ?timing_strategy=llm|immediate|v2（開始画面の選択の初期値。
 *           既定は NEXT_PUBLIC_DEFAULT_CONVERSATION_KIND／NEXT_PUBLIC_DEFAULT_TIMING_STRATEGY、なければ未選択で orchestrator の既定）
 * 研究条件の選択は開始画面に出す。本番の実験で参加者に条件名を見せないときは NEXT_PUBLIC_HIDE_CONDITION_PICKER=1 で
 * 選択を隠す（条件を送らず、orchestrator の CONDITION に任せる。orchestrator 側も CONDITION_FROM_CLIENT=0 で固定する）。
 * 試験（apps/orchestrator/test/e2e）は window.__participant を読む。
 */
import { useEffect, useRef, useState } from 'react';
import type { Avatar } from '../../src/avatar';
import { avatarRecord, resolveAvatarChoice } from '../../src/avatar/avatar_models';
import {
  CONDITION_LABELS,
  CONVERSATION_KIND_LABELS,
  INITIAL_VIEW,
  ParticipantController,
  TIMING_STRATEGY_LABELS,
  type ParticipantView,
} from '../../src/session/participant';
import { parseBreathSoundGain } from '../../src/session/breath_sound';
import { BREATH_PROFILES, parseBreathProfile } from '../../src/avatar/breath_profile';
import type { Condition } from '@llm-vap/contracts/common';
import type { ConversationKind, TimingStrategy } from '@llm-vap/contracts';
import styles from './participant.module.css';
import { ChoiceGroup, MicDetails, NoticeList, picker } from './parts';

const CONDITIONS: Condition[] = ['reactive', 'initiative_inhale', 'initiative_no_cue'];
const isCondition = (value: string | null | undefined): value is Condition => CONDITIONS.includes(value as Condition);
// 既知の種類に、環境変数と URL で足せる（種類は config/conversation_kind.<id>.ja.json の ID）。コードを変えずに種類を増やすため。
const CONVERSATION_KIND_ID = /^[a-z][a-z0-9_]{0,63}$/;
const CONVERSATION_KINDS: ConversationKind[] = [
  ...new Set(['joint_thinking', 'companion', ...(process.env.NEXT_PUBLIC_CONVERSATION_KINDS ?? '').split(',').map((k) => k.trim()).filter((k) => CONVERSATION_KIND_ID.test(k))]),
];
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

/** 参加者に見せる文。専門語と内部の名前を出さない（元の理由は研究者画面と記録で見られる）。 */
function describeReason(reason: string): string | null {
  if (reason.startsWith('vap:rewarm')) return '会話の準備をしています。はじめの10秒ほどは、AI が返事をしにくいことがあります。';
  if (reason.startsWith('vap:worker_not_started') || reason.startsWith('vap:no_vap_state')) return '会話の間合いを読む機能が動いていません。研究者に知らせてください。';
  if (reason.startsWith('vap:')) return '会話の間合いを読む機能が、一時的に使えません。';
  if (reason.startsWith('vap_unavailable')) return '会話の間合いを読む機能を起動していません。研究者に知らせてください。';
  if (reason.startsWith('stt_unavailable')) return '声を聞き取る機能につながっていません。研究者に知らせてください。';
  if (reason.startsWith('tts_unavailable')) return 'AI の声を作る機能につながっていません。研究者に知らせてください。';
  if (reason.startsWith('llm_unavailable')) return 'AI の返事を作る機能につながっていません。研究者に知らせてください。';
  if (reason.startsWith('completion_unavailable')) return '話し終わりの判断がしにくくなっています。AI の返事が遅れることがあります。';
  if (reason.startsWith('negotiation_unavailable')) return 'AI の機能の一部が動いていません。研究者に知らせてください。';
  if (reason.startsWith('test_double')) return null; // 「試験用」の表示で出す
  return HIDE_CONDITION_PICKER ? '機能の一部が一時的に使えません。研究者に知らせてください。' : reason;
}

type AvatarLoad = { kind: 'loading' } | { kind: 'done' } | { kind: 'failed'; detail: string };

const SETUP_COPY: Record<'idle' | 'stopped' | 'failed', { title: string; lead: string | null; startLabel: string }> = {
  idle: { title: 'AI と声で話します', lead: null, startLabel: 'はじめる' },
  stopped: { title: '会話を終えました', lead: 'おつかれさまでした。', startLabel: 'もう一度はじめる' },
  failed: { title: 'はじめられませんでした', lead: null, startLabel: 'もう一度はじめる' },
};

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
  const [avatarLoad, setAvatarLoad] = useState<AvatarLoad>({ kind: 'loading' });
  const [condition, setCondition] = useState<Condition | null>(null);
  const [conversationKind, setConversationKind] = useState<ConversationKind | null>(null);
  const [kindChoices, setKindChoices] = useState<ConversationKind[]>(CONVERSATION_KINDS);
  const [timingStrategy, setTimingStrategy] = useState<TimingStrategy | null>(null);
  useEffect(() => {
    setCondition(initialCondition());
    const urlKind = new URLSearchParams(window.location.search).get('conversation_kind');
    const kinds = urlKind !== null && CONVERSATION_KIND_ID.test(urlKind) && !CONVERSATION_KINDS.includes(urlKind) ? [...CONVERSATION_KINDS, urlKind] : CONVERSATION_KINDS;
    setKindChoices(kinds);
    setConversationKind(initialChoice('conversation_kind', process.env.NEXT_PUBLIC_DEFAULT_CONVERSATION_KIND, kinds));
    setTimingStrategy(initialChoice('timing_strategy', process.env.NEXT_PUBLIC_DEFAULT_TIMING_STRATEGY, TIMING_STRATEGIES));
  }, []);

  if (controllerRef.current === null && typeof window !== 'undefined') {
    controllerRef.current = new ParticipantController({
      wsUrl: defaultWsUrl(),
      avatar: () => avatarRef.current,
      onView: setView,
      breathSoundGain: parseBreathSoundGain(new URLSearchParams(window.location.search).get('breath_sound')),
      breathProfile: parseBreathProfile(new URLSearchParams(window.location.search).get('breath_profile')),
    });
  }

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    let created: Avatar | null = null;
    const query = new URLSearchParams(window.location.search);
    const choice = resolveAvatarChoice({ avatarQuery: query.get('avatar'), modelQuery: query.get('model'), env: process.env.NEXT_PUBLIC_AVATAR });
    if (choice.rejected !== null) console.warn(`[avatar] unknown avatar id (${choice.rejected.slice(0, 40)}); using ${choice.id}`);
    // 測定用（dev のみ）: 読み込みの後、自動で「はじめる」を押す（Chrome の --autoplay-policy=no-user-gesture-required が要る）。
    const autoStart = process.env.NODE_ENV !== 'production' && query.get('autostart') === '1';
    const startForMeasure = () => {
      if (!autoStart) return;
      void controllerRef.current?.start({ condition: initialCondition(), conversation_kind: initialChoice('conversation_kind', undefined, CONVERSATION_KINDS), timing_strategy: initialChoice('timing_strategy', undefined, TIMING_STRATEGIES) });
    };
    (async () => {
      try {
        if (choice.spec === null || choice.url === null) {
          // ?avatar=none: 描画なしの比較（測定用）。会話はできる。
          setAvatarLoad({ kind: 'done' });
          controllerRef.current?.setAvatarRecord(avatarRecord(choice, 'disabled'));
          startForMeasure();
          return;
        }
        const { createAvatar } = await import('../../src/avatar/runtime');
        const avatar = await createAvatar({
          container,
          modelUrl: choice.url,
          model: choice.spec,
          framing: 'bust',
          onGazeReport: (report) => controllerRef.current?.gazeRendered(report),
        });
        if (cancelled) {
          avatar.dispose();
          return;
        }
        created = avatar;
        avatar.setBreathParams({ prep: BREATH_PROFILES[parseBreathProfile(new URLSearchParams(window.location.search).get('breath_profile'))] });
        avatarRef.current = avatar;
        setAvatarLoad({ kind: 'done' });
        controllerRef.current?.setAvatarRecord(avatarRecord(choice, 'loaded'));
        startForMeasure();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        avatarErrorRef.current = message;
        controllerRef.current?.setAvatarRecord(avatarRecord(choice, 'failed', message.slice(0, 300)));
        startForMeasure();
        setAvatarLoad({ kind: 'failed', detail: message });
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

  const live = view.phase === 'starting' || view.phase === 'running';
  // 会話の間だけ見せる（終わった後に残っていても意味がない）。
  const messages = live ? [...new Set(view.reasons.map(describeReason).filter((r): r is string => r !== null)), ...view.warnings] : [];
  const notices = <NoticeList error={view.error} isFake={view.isFake} messages={messages} />;

  const settings = view.trackSettings;
  const flag = (v: { value: boolean | null } | undefined) => (v?.value === null || v === undefined ? '不明' : v.value ? 'ON' : 'OFF');
  const micDetails = (settings || view.sessionId) && (
    <MicDetails>
      {settings && (
        <>
          <ul>
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
          <p>使うマイクを変えるには、Windows の「サウンドの設定」で入力と出力の既定をヘッドセットにしてから、ページを再読み込みしてください。</p>
        </>
      )}
      {view.sessionId && (
        <p className={styles.sessionLine}>
          session: {view.sessionId}
          {!HIDE_CONDITION_PICKER && view.condition && ` ／ ${CONDITION_LABELS[view.condition]}`}
        </p>
      )}
    </MicDetails>
  );

  // 選択肢を増やすときは、ここに 1 つ足す（画面の並びと折りたたみの要約に反映される）。
  const pickers = [
    picker({ name: 'condition', legend: '応答のしかた', testId: 'condition-picker', value: condition, values: CONDITIONS, label: (c) => CONDITION_LABELS[c], onChange: setCondition }),
    picker({ name: 'conversation_kind', legend: '会話の種類', testId: 'conversation-kind-picker', value: conversationKind, values: kindChoices, label: (k) => CONVERSATION_KIND_LABELS[k] ?? k, onChange: setConversationKind }),
    picker({ name: 'timing_strategy', legend: '申し出るタイミング', testId: 'timing-strategy-picker', value: timingStrategy, values: TIMING_STRATEGIES, label: (t) => TIMING_STRATEGY_LABELS[t], onChange: setTimingStrategy }),
  ];
  const pickedSummary = pickers.flatMap((p) => p.options.filter((o) => o.value === p.value).map((o) => o.label)).join('、') || 'すべて指定なし';

  const copy = view.phase === 'idle' || view.phase === 'stopped' || view.phase === 'failed' ? SETUP_COPY[view.phase] : SETUP_COPY.idle;
  const linkDown = view.phase === 'running' && view.link !== 'ready';
  const stateText = view.phase === 'starting' ? '準備中…' : linkDown ? LINK_TEXT[view.link] : view.aiSpeaking ? 'AI が話しています' : 'どうぞ話してください';
  const stateTone = view.phase === 'starting' || linkDown ? 'preparing' : view.aiSpeaking ? 'speaking' : 'listening';

  return (
    <main className={styles.shell} data-mode={live ? 'live' : 'setup'}>
      <div className={styles.stage}>
        <div ref={containerRef} className={styles.canvas} data-testid="avatar-stage" />
        {avatarLoad.kind === 'loading' && <p className={styles.avatarStatus}>アバターを読み込み中…</p>}
        {avatarLoad.kind === 'failed' && (
          <div className={styles.avatarFailure} data-testid="avatar-failure">
            <p>アバターを表示できません。会話はできます。</p>
            <p className={styles.avatarFailureDetail}>{avatarLoad.detail}</p>
          </div>
        )}
      </div>
      {live ? (
        <footer className={styles.dock}>
          <div className={styles.dockBar}>
            <div className={styles.state} data-testid="state">
              <p className={styles.stateLine}>
                <span className={styles.dot} data-tone={stateTone} aria-hidden="true" />
                {stateText}
              </p>
              {view.phase === 'starting' && <p className={styles.stateHint}>マイクの使用の確認が出たら、「許可」を選んでください。</p>}
            </div>
            <div className={styles.actions}>
              {micDetails}
              <button type="button" className={styles.stopButton} onClick={() => void controllerRef.current?.stop()}>
                終了する
              </button>
            </div>
          </div>
          {notices}
        </footer>
      ) : (
        <aside className={styles.panel}>
          <h1 className={styles.title}>{copy.title}</h1>
          {copy.lead && <p className={styles.lead}>{copy.lead}</p>}
          {notices}
          <ol className={styles.steps}>
            <li>
              <strong>有線のヘッドセット</strong>（マイク付き）をつけてください。スピーカーや Bluetooth では正しく動きません。
            </li>
            <li>「{copy.startLabel}」を押すと、マイクの使用の確認が出ます。「許可」を選んでください。</li>
            <li>あとは話すだけです。やめるときは「終了する」を押してください。</li>
          </ol>
          <button
            id="start"
            type="button"
            className={styles.startButton}
            onClick={() =>
              void controllerRef.current?.start(
                HIDE_CONDITION_PICKER
                  ? { condition: null, conversation_kind: null, timing_strategy: null }
                  : { condition, conversation_kind: conversationKind, timing_strategy: timingStrategy, vocal_cue: new URLSearchParams(window.location.search).get('vocal_cue') },
              )
            }
          >
            {copy.startLabel}
          </button>
          {micDetails}
          {!HIDE_CONDITION_PICKER && (
            <details className={styles.research} data-testid="research-settings">
              <summary className={styles.foldSummary}>
                実験の設定（研究者用）
                <span className={styles.researchPicked}>{pickedSummary}</span>
              </summary>
              <div className={styles.researchBody}>
                {pickers.map((p) => (
                  <ChoiceGroup key={p.name} choice={p} />
                ))}
                <p className={styles.researchNote}>「指定しない」は、サーバーの既定に従います。</p>
              </div>
            </details>
          )}
        </aside>
      )}
    </main>
  );
}
