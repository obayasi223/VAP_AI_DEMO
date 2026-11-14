/**
 * two_ai の参加者画面の試験の共通部品（*.test.ts ではないので単独では走らない）。
 * 偽のステージ（2 体の偽アバター。呼ばれた値を覚えるだけ）と、Node のメッセージを流す口。
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AiId } from '@llm-vap/contracts/common';
import type { NodeToBrowser } from '@llm-vap/contracts/browser_rpc';
import type { Avatar } from '../../src/avatar';
import type { BreathController, InhaleCue, ReleaseReason } from '../../src/avatar/breath';
import { TwoAiParticipantController, type StageLike, type TwoAiView } from '../../src/session/two_ai_participant';
import { TwoAiScreen } from '../../app/(participant)/two_ai/TwoAiScreen';

export class FakeBreath implements BreathController {
  readonly calls: (InhaleCue | ReleaseReason)[] = [];
  accept = true;
  startInhale(cue: InhaleCue): boolean {
    this.calls.push(cue);
    return this.accept;
  }
  release(reason: ReleaseReason): boolean {
    this.calls.push(reason);
    return this.accept;
  }
  phase() {
    return 'idle' as const;
  }
}

export interface FakeAvatar {
  avatar: Avatar;
  calls: string[];
  breath: FakeBreath;
  level: number;
  alignments: number[];
  reports: string[];
}

export function fakeAvatar(): FakeAvatar {
  const state: FakeAvatar = { avatar: null as unknown as Avatar, calls: [], breath: new FakeBreath(), level: 0, alignments: [], reports: [] };
  state.avatar = {
    breath: state.breath,
    setGaze: (target: string) => state.calls.push(`gaze:${target}`),
    setMouthLevel: (rms: number) => {
      state.level = rms;
    },
    closeMouth: () => state.calls.push('closeMouth'),
    onPlaybackAlignment: (m: { audio_playback_id: number }) => state.alignments.push(m.audio_playback_id),
    onPlaybackReport: (m: { type: string; audio_playback_id: number }) => state.reports.push(`${m.type}:${m.audio_playback_id}`),
    getTelemetry: () => ({ mouth: { open: state.level > 0 ? 0.5 : 0 } }),
    setBreathParams: () => undefined,
  } as unknown as Avatar;
  return state;
}

export interface Harness {
  controller: TwoAiParticipantController;
  sent: { type: string; [key: string]: unknown }[];
  avatars: Record<AiId, FakeAvatar>;
  deliver(message: NodeToBrowser): void;
  sentReport(message: { type: string; audio_playback_id: number }): void;
  sentOf(type: string): { type: string; [key: string]: unknown }[];
  views: TwoAiView[];
}

export function harness(options: { now?: () => number; stage?: StageLike | null } = {}): Harness {
  const avatars: Record<AiId, FakeAvatar> = { A: fakeAvatar(), B: fakeAvatar() };
  const stage: StageLike = options.stage ?? { avatar: (ai_id) => avatars[ai_id].avatar };
  const views: TwoAiView[] = [];
  const controller = new TwoAiParticipantController({
    wsUrl: 'ws://127.0.0.1:8787/ws',
    stage: () => stage,
    onView: (view) => views.push(view),
    breathSoundGain: 0,
    now: options.now ?? (() => 100),
  });
  const sent: Harness['sent'] = [];
  (controller as unknown as { audio: { send(m: unknown): void } }).audio = { send: (m) => sent.push(m as Harness['sent'][number]) };
  return {
    controller,
    sent,
    avatars,
    views,
    deliver: (m) => (controller as unknown as { onMessage(m: NodeToBrowser): void }).onMessage(m),
    sentReport: (m) => (controller as unknown as { onSent(m: unknown): void }).onSent(m),
    sentOf: (type) => sent.filter((m) => m.type === type),
  };
}

export const HEADINGS: [string, string, string, string] = ['いまの状況の整理', '二人の見方', 'もう一歩の掘り下げ', '次の一歩の候補'];

export const HELLO_TWO_AI: NodeToBrowser = {
  type: 'server.hello',
  protocol_version: 1,
  mode: 'two_ai',
  session_id: 'sess_two_ai_test',
  condition: null,
  is_fake: true,
  two_ai: { ai_ids: ['A', 'B'], avatar_keys: { A: 'rb_fa03', B: 'rb_ma09' }, labels: { A: 'アオイ', B: 'ハル' }, phase: 'intake' },
};

function card(n: 1 | 2 | 3 | 4, variant: 'original' | 'corrected' = 'original') {
  return { card_id: `card_${n}${variant === 'corrected' ? 'c' : ''}`, order: n, discussion_stage: n, text: `候補 ${n}${variant === 'corrected' ? '（作り直し）' : ''}`, variant };
}

/**
 * 1 回のセッションのメッセージ列（06 §4.7 の 8 つの同期の印を含む）。条件で違うのは discussion の案内の鍵だけ。
 * 'mark' は印のボタンを押す、'pick' は板の 1 枚を押す、'reconnect' は再接続の直後の送り直し。
 */
export type Step = NodeToBrowser | 'mark' | 'pick' | 'reconnect';

export function sessionSteps(discussionKey: string): Step[] {
  const stage = (current: 1 | 2 | 3 | 4 | null, show: 'current' | 'all' | 'none' = 'current'): NodeToBrowser => ({ type: 'two_ai.stage', current, headings: HEADINGS, show });
  const board = (version: number, mode: 'building' | 'rebuilt' | 'pick' | 'picked', cards: ReturnType<typeof card>[], picked: string | null = null): NodeToBrowser => ({
    type: 'two_ai.board',
    board_version: version,
    mode,
    cards,
    picked_card_id: picked,
  });
  const phase = (p: 'intake' | 'discussion' | 'response' | 'next_step' | 'end', key: string | null): NodeToBrowser => ({ type: 'two_ai.phase', phase: p, instruction_key: key, labels: { A: 'アオイ', B: 'ハル' } });
  const built: ReturnType<typeof card>[] = [];
  const steps: Step[] = [HELLO_TWO_AI, phase('intake', 'intake'), phase('discussion', discussionKey)];
  for (const n of [1, 2, 3, 4] as const) {
    steps.push(stage(n));
    built.push(card(n));
    steps.push(board(n, 'building', [...built]));
    if (n === 2) steps.push('mark');
    if (n === 3) steps.push('reconnect');
  }
  const rebuilt = ([1, 2, 3, 4] as const).map((n) => card(n, 'corrected'));
  steps.push(
    phase('response', 'response'),
    stage(null, 'all'),
    board(5, 'rebuilt', rebuilt),
    phase('next_step', 'next_step'),
    board(6, 'pick', rebuilt),
    'pick',
    board(7, 'picked', rebuilt, 'card_2c'),
    phase('end', 'end'),
  );
  return steps;
}

export interface Run {
  harness: Harness;
  /** 各段の画面（renderToStaticMarkup）。 */
  htmls: string[];
  /** 印を押した直後の画面。 */
  markerStep: number;
}

export function renderView(view: TwoAiView, flags: { instructionCard: boolean; markerFlash: boolean; syncFlash: boolean }): string {
  return renderToStaticMarkup(createElement(TwoAiScreen, { view: { ...view, lifecycle: 'running', link: 'ready' }, ...flags }));
}

export function conditionRun(discussionKey: string): Run {
  const h = harness();
  const htmls: string[] = [];
  let markerStep = -1;
  let lastSync = 0;
  let lastPress = 0;
  for (const step of sessionSteps(discussionKey)) {
    if (step === 'mark') h.controller.mark();
    else if (step === 'pick') h.controller.pick('card_2c');
    else if (step === 'reconnect') {
      // 再接続の直後の送り直し（今の状態の一式）。同期の印は出さない。
      const view = h.controller.current();
      h.deliver({ type: 'two_ai.phase', phase: 'discussion', instruction_key: discussionKey, labels: { A: 'アオイ', B: 'ハル' } });
      h.deliver({ type: 'two_ai.stage', current: view.stage?.current ?? null, headings: HEADINGS, show: 'current' });
      if (view.board) h.deliver({ type: 'two_ai.board', board_version: view.board.version, mode: view.board.mode, cards: view.board.cards, picked_card_id: null });
    } else h.deliver(step);
    const view = h.controller.current();
    const flags = {
      instructionCard: view.phase === 'discussion',
      markerFlash: view.markerPresses > lastPress,
      syncFlash: view.syncMarks > lastSync,
    };
    if (step === 'mark') markerStep = htmls.length;
    lastSync = view.syncMarks;
    lastPress = view.markerPresses;
    htmls.push(renderView(view, flags));
  }
  return { harness: h, htmls, markerStep };
}

/** 印を押した直後の画面のうち、印のボタンの部分。 */
export function markerHtml(run: Run): string {
  const html = run.htmls[run.markerStep] ?? '';
  const match = /<button[^>]*data-testid="marker-button"[^>]*>[^<]*<\/button>/.exec(html);
  return match?.[0] ?? '';
}
