/**
 * 2 体のモードの参加者画面の配線（docs/design/two_ai/03 §2.4、§2.5、§3）。React に依存しない。
 * 1 対 1 の ParticipantController（participant.ts）は変えず、export 済みの関数だけを使う。
 *
 * ブラウザは判断しない：誰がいつ話すか、どちらをどこへ向かせるか、吸気を出すかは Node が決め、ここは ai_id つきの
 * 指示を実行して報告する。
 *  - 口：再生の持ち主の表（playback.begin の ai_id）で、語時刻と再生の報告をその AI のアバターへ。出力の RMS は再生中の AI にだけ。
 *  - 視線：gaze.command の ai_id。省略は両方。
 *  - 吸気：AI ごとの BreathRouter。省略は 'A' と数える。
 *  - 段・見出し・板・印：two_ai.phase／two_ai.stage／two_ai.board と、印のボタン（two_ai.marker）、板の選択（two_ai.board_pick）。
 *  - 同期の印：06 §4.7 の表のメッセージだけで出す（isSyncMarkMessage）。同じ（phase, stage）の 2 回目以降は数えない（第 5 回 m3）。
 * 条件は受け取らない・選ばない（参加者画面に条件の値は届かない）。
 */
import type { AiId, TwoAiPhase } from '@llm-vap/contracts/common';
import type {
  AvatarReport,
  GazeReport,
  GazeTarget,
  NodeToBrowser,
  RenderHealth,
  SignalReport,
  TrackSettings,
} from '@llm-vap/contracts/browser_rpc';
import { startBrowserAudio, type BrowserAudioSession } from '../audio';
import type { Avatar } from '../avatar';
import type { AvatarRecord } from '../avatar/avatar_models';
import type { BreathProfileId } from '../avatar/breath_profile';
import { AI_IDS, PlaybackOwnerTable, commandTarget, gazeTargets, isAiId, routeMouthLevel } from './ai_routing';
import { BreathRouter, type BreathCommandRecord } from './breath_router';
import { BreathSound, DEFAULT_BREATH_SOUND_GAIN } from './breath_sound';
import { describeStartError, deviceWarnings, settingsWarnings, SESSION_OPEN_ELSEWHERE_TEXT, type ParticipantView } from './participant';
import { BoardState, type BoardView } from './two_ai_board';
import { DEFAULT_LABELS, UI_COPY } from './two_ai_copy';
import { MarkerButton } from './two_ai_marker';

/** 参加者画面が使うステージの部分（stage.ts の Stage はこれを満たす）。試験では偽物を渡す。 */
export interface StageLike {
  avatar(ai_id: AiId): Avatar | null;
  getTelemetry?(): {
    fps: number;
    fpsP5?: number;
    fpsMedian?: number;
    frameMsP95: number;
    renderer?: string;
    pixelRatio?: number;
    avatars?: number;
  };
}

export type AvatarLoadState = 'loading' | 'loaded' | 'failed' | 'disabled';

export interface TwoAiStageView {
  current: 1 | 2 | 3 | 4 | null;
  headings: string[];
  show: 'current' | 'all' | 'none';
}

export interface TwoAiView {
  link: ParticipantView['link'];
  lifecycle: 'idle' | 'starting' | 'running' | 'stopped' | 'failed';
  sessionId: string | null;
  /** Node の two_ai.phase。届くまで null。 */
  phase: TwoAiPhase | null;
  /** 案内の鍵（two_ai_copy.ts で文に）。 */
  instructionKey: string | null;
  /** 今再生中の AI（再生の報告から）。 */
  speaking: AiId | null;
  stage: TwoAiStageView | null;
  board: BoardView | null;
  /** 押せるか（pick の間でまだ選んでいない）。 */
  boardPickable: boolean;
  /** 押した（Node の picked が届く前の強調）。 */
  boardPending: string | null;
  /** discussion の間だけ true（両条件で同じ）。 */
  markerEnabled: boolean;
  /** 印のボタンを押した回数（光らせる反応のきっかけ。両条件で同じ）。 */
  markerPresses: number;
  /** 同期の印を出した回数（右下の白い四角のきっかけ）。 */
  syncMarks: number;
  gaze: Record<AiId, GazeTarget>;
  labels: Record<AiId, string>;
  avatarLoad: Record<AiId, AvatarLoadState>;
  isFake: boolean;
  degraded: boolean;
  reasons: string[];
  error: string | null;
  trackSettings: TrackSettings | null;
  sampleRateHz: number | null;
  warnings: string[];
}

export const INITIAL_TWO_AI_VIEW: TwoAiView = {
  link: 'none',
  lifecycle: 'idle',
  sessionId: null,
  phase: null,
  instructionKey: null,
  speaking: null,
  stage: null,
  board: null,
  boardPickable: false,
  boardPending: null,
  markerEnabled: false,
  markerPresses: 0,
  syncMarks: 0,
  gaze: { A: 'user', B: 'user' },
  labels: { ...DEFAULT_LABELS },
  avatarLoad: { A: 'loading', B: 'loading' },
  isFake: false,
  degraded: false,
  reasons: [],
  error: null,
  trackSettings: null,
  sampleRateHz: null,
  warnings: [],
};

/** WS の URL に mode=two_ai を足す。条件は付けない（研究画面の arm → Node の設定の順で Node が決める）。 */
export function withTwoAiMode(wsUrl: string, scenario: string | null = null): string {
  const url = new URL(wsUrl);
  url.searchParams.set('mode', 'two_ai');
  if (scenario !== null && scenario !== '') url.searchParams.set('scenario', scenario);
  return url.toString();
}

/** 起動から two_ai.phase を待つ上限。超えたら「準備ができていません」。 */
export const PHASE_WAIT_MS = 10_000;
/** render.health の間隔（06 §2.2）。 */
export const RENDER_HEALTH_INTERVAL_MS = 5_000;

const SYNC_PHASES: ReadonlySet<TwoAiPhase> = new Set(['intake', 'response', 'next_step', 'end']);

/**
 * 同期の印を出すメッセージか（06 §4.7 の表が唯一の定義）。出すなら鍵（`phase:intake`、`stage:2` など）、出さないなら null。
 *  - two_ai.phase の intake／response／next_step／end。discussion は出さない。
 *  - two_ai.stage の current が 1〜4 に変わったとき（prevStage と違う）。current: null は出さない。
 *  - two_ai.board、その他は出さない。
 *  - 同じ鍵の 2 回目以降（接続・再接続の直後の送り直しを含む）は出さない（第 5 回 m3）。
 */
export function isSyncMarkMessage(
  message: NodeToBrowser,
  prev: { seen: ReadonlySet<string>; stage: number | null },
): string | null {
  let key: string | null = null;
  if (message.type === 'two_ai.phase') {
    if (SYNC_PHASES.has(message.phase)) key = `phase:${message.phase}`;
  } else if (message.type === 'two_ai.stage') {
    if (message.current !== null && message.current !== prev.stage) key = `stage:${message.current}`;
  }
  if (key === null || prev.seen.has(key)) return null;
  return key;
}

/** E2E と試験の記録の口（AI ごと）。 */
export interface MouthRecord {
  samplesWhilePlaying: number;
  openWhilePlaying: number;
  openWhileOtherPlaying: number;
  max: number;
}

export interface TwoAiParticipantOptions {
  wsUrl: string;
  stage: () => StageLike | null;
  onView: (view: TwoAiView) => void;
  breathSoundGain?: number;
  breathProfile?: BreathProfileId;
  /** 試験用。既定は performance.now。 */
  now?: () => number;
  /** 同期の印を出した瞬間（画面の白い四角）。 */
  onSyncMark?: (key: string) => void;
}

/** 口が開いているとみなす量（participant.ts の記録と同じ）。 */
const MOUTH_OPEN = 0.05;

export class TwoAiParticipantController {
  private view: TwoAiView = { ...INITIAL_TWO_AI_VIEW, gaze: { ...INITIAL_TWO_AI_VIEW.gaze }, labels: { ...DEFAULT_LABELS }, avatarLoad: { ...INITIAL_TWO_AI_VIEW.avatarLoad } };
  private audio: Pick<BrowserAudioSession, 'send'> & Partial<BrowserAudioSession> | null = null;
  private analyser: AnalyserNode | null = null;
  private buffer: Float32Array<ArrayBuffer> | null = null;
  private raf: number | null = null;
  private readonly owners = new PlaybackOwnerTable('A');
  /** 再生中の audio_playback_id → AI。 */
  private readonly active = new Map<number, AiId>();
  private readonly board: BoardState;
  private readonly marker: MarkerButton;
  private readonly syncSeen = new Set<string>();
  private readonly breathRouters: Record<AiId, BreathRouter>;
  private readonly breathSounds: Partial<Record<AiId, BreathSound>> = {};
  private readonly avatarRecords: Partial<Record<AiId, { record: AvatarRecord; extra: Pick<AvatarReport, 'render_profile' | 'layout'> }>> = {};
  private phaseTimer: ReturnType<typeof setTimeout> | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private longTasks = 0;
  private longTaskObserver: PerformanceObserver | null = null;

  readonly record = {
    gazeCommands: [] as { ai_id: AiId | null; target: GazeTarget; client_t_ms: number }[],
    gazeReports: [] as (GazeReport & { ai_id: AiId; reported_t_ms: number })[],
    breathCommands: [] as BreathCommandRecord[],
    signalReports: [] as SignalReport[],
    mouth: { A: emptyMouth(), B: emptyMouth() } as Record<AiId, MouthRecord>,
    phases: [] as { phase: TwoAiPhase; client_t_ms: number }[],
    markers: [] as { marker_id: string; client_t_ms: number }[],
    boards: [] as { version: number; mode: string; card_ids: string[]; client_t_ms: number }[],
    syncMarks: [] as { key: string; client_t_ms: number }[],
    /** ai_id のない、または未知の指示の数（gaze.command の省略は両方なので数えない）。 */
    unknownAiId: 0,
    /** 表にない audio_playback_id の再生の報告の数。 */
    unknownPlayback: 0,
    messages: [] as string[],
  };

  constructor(private readonly options: TwoAiParticipantOptions) {
    const now = () => this.now();
    this.board = new BoardState({ now });
    this.marker = new MarkerButton({ now });
    const make = (ai_id: AiId) =>
      new BreathRouter(ai_id, {
        avatar: () => this.avatar(ai_id),
        send: (signal) => this.sendSignal(signal),
        record: (entry) => this.record.breathCommands.push(entry),
        breathSound: () => this.breathSoundFor(ai_id),
        now,
      });
    this.breathRouters = { A: make('A'), B: make('B') };
  }

  private now(): number {
    return this.options.now?.() ?? performance.now();
  }

  current(): TwoAiView {
    return this.view;
  }

  /** await をまたいで読む（開始の途中で止めたかの確認。型の絞り込みを外す）。 */
  private lifecycle(): TwoAiView['lifecycle'] {
    return this.view.lifecycle;
  }

  session(): BrowserAudioSession | null {
    return (this.audio as BrowserAudioSession | null) ?? null;
  }

  private update(patch: Partial<TwoAiView>): void {
    this.view = { ...this.view, ...patch };
    this.options.onView(this.view);
  }

  private avatar(ai_id: AiId): Avatar | null {
    return this.options.stage()?.avatar(ai_id) ?? null;
  }

  private get breathSoundGain(): number {
    return this.options.breathSoundGain ?? DEFAULT_BREATH_SOUND_GAIN;
  }

  private breathSoundFor(ai_id: AiId): BreathSound | null {
    const context = this.audio?.context;
    if (!context) return null;
    this.breathSounds[ai_id] ??= new BreathSound(context, this.breathSoundGain);
    return this.breathSounds[ai_id] ?? null;
  }

  private sendSignal(signal: SignalReport): void {
    this.record.signalReports.push(signal);
    this.audio?.send(signal);
  }

  // ---- ステージの報告 -------------------------------------------------------

  /** 1 体ずつの読み込みの結果。接続前なら接続後に送る。 */
  setAvatarRecord(ai_id: AiId, record: AvatarRecord, extra: Pick<AvatarReport, 'render_profile' | 'layout'> = {}): void {
    this.avatarRecords[ai_id] = { record, extra };
    this.update({ avatarLoad: { ...this.view.avatarLoad, [ai_id]: record.status } });
    this.sendAvatarRecord(ai_id);
  }

  private sendAvatarRecord(ai_id: AiId): void {
    const entry = this.avatarRecords[ai_id];
    if (entry === undefined || this.audio === null) return;
    const report: AvatarReport = {
      type: 'avatar.report',
      ...entry.record,
      breath_sound_gain: this.breathSoundGain,
      breath_profile: this.options.breathProfile ?? 'default',
      client_t_ms: Math.max(0, this.now()),
      ai_id,
      ...(entry.extra.render_profile ? { render_profile: entry.extra.render_profile } : {}),
      ...(entry.extra.layout ? { layout: entry.extra.layout } : {}),
    };
    this.audio.send(report);
  }

  /** ステージの onGazeReport から呼ぶ。 */
  gazeRendered(ai_id: AiId, report: GazeReport): void {
    const withAi: GazeReport = { ...report, ai_id };
    this.record.gazeReports.push({ ...withAi, ai_id, reported_t_ms: this.now() });
    this.audio?.send(withAi);
  }

  // ---- 操作 -----------------------------------------------------------------

  /** 印のボタン。discussion の外では何もしない。 */
  mark(): void {
    const message = this.marker.press();
    if (message === null) return;
    this.record.markers.push({ marker_id: message.marker_id, client_t_ms: message.client_t_ms });
    this.audio?.send(message);
    this.update({ markerPresses: this.marker.presses });
  }

  /** 板から 1 枚を選ぶ。pick の間だけ、1 回だけ送る。 */
  pick(card_id: string): void {
    const message = this.board.pick(card_id);
    if (message === null) return;
    this.audio?.send(message);
    this.update({ boardPickable: this.board.canPick(), boardPending: this.board.pendingPick() });
  }

  /** クリックのハンドラの中で呼ぶこと（自動再生の制限）。条件は受け取らない。 */
  async start(choice: { scenario?: string | null } = {}): Promise<void> {
    if (this.view.lifecycle === 'starting' || this.view.lifecycle === 'running') return;
    this.update({ lifecycle: 'starting', error: null });
    try {
      this.audio = await startBrowserAudio({
        wsUrl: withTwoAiMode(this.options.wsUrl, choice.scenario ?? null),
        onMessage: (message) => this.onMessage(message),
        onSent: (message) => this.onSent(message),
        onLink: (state, detail) => {
          if (state === 'closed' && detail.includes('session_open_elsewhere')) {
            this.update({ link: 'elsewhere', error: SESSION_OPEN_ELSEWHERE_TEXT });
            return;
          }
          this.update({ link: state });
        },
        onError: (detail) => this.record.messages.push(`error: ${detail}`),
      });
    } catch (error) {
      this.update({ lifecycle: 'failed', error: describeStartError(error) });
      return;
    }
    const audio = this.audio as BrowserAudioSession;
    if (this.lifecycle() !== 'starting') {
      // 開始の途中で止めた（1 対 1 の Node だった、など）。
      this.audio = null;
      await audio.stop();
      return;
    }
    for (const ai_id of AI_IDS) this.sendAvatarRecord(ai_id);
    const analyser = audio.context.createAnalyser();
    analyser.fftSize = 1024;
    audio.outputNode.connect(analyser);
    this.analyser = analyser;
    this.buffer = new Float32Array(analyser.fftSize);
    this.loop();
    this.startPhaseTimer();
    this.startHealth();

    let warnings = settingsWarnings(audio.trackSettings, audio.sampleRateHz);
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices.filter((d) => d.kind === 'audioinput').map((d) => ({ label: d.label || '（名前なし）', isDefault: d.deviceId === 'default' }));
      warnings = [...warnings, ...deviceWarnings(inputs.filter((d) => d.isDefault))];
    } catch {
      // 機器の一覧が取れなくても続ける。
    }
    if (this.lifecycle() !== 'starting') return; // 開始中に hello で止めた
    this.update({ lifecycle: 'running', trackSettings: audio.trackSettings, sampleRateHz: audio.sampleRateHz, warnings });
  }

  private startPhaseTimer(): void {
    this.clearPhaseTimer();
    this.phaseTimer = setTimeout(() => {
      this.phaseTimer = null;
      if (this.view.phase === null) this.update({ error: UI_COPY.not_ready });
    }, PHASE_WAIT_MS);
  }

  private clearPhaseTimer(): void {
    if (this.phaseTimer !== null) clearTimeout(this.phaseTimer);
    this.phaseTimer = null;
  }

  private startHealth(): void {
    if (typeof PerformanceObserver !== 'undefined') {
      try {
        this.longTaskObserver = new PerformanceObserver((list) => {
          this.longTasks += list.getEntries().length;
        });
        this.longTaskObserver.observe({ type: 'longtask', buffered: false });
      } catch {
        this.longTaskObserver = null;
      }
    }
    this.healthTimer = setInterval(() => this.sendRenderHealth(), RENDER_HEALTH_INTERVAL_MS);
  }

  /** 5 秒ごとの描画の健康（render.health）。ステージがなければ送らない。 */
  renderHealth(): RenderHealth | null {
    const telemetry = this.options.stage()?.getTelemetry?.();
    if (!telemetry) return null;
    const pixelRatio = telemetry.pixelRatio ?? (typeof window !== 'undefined' ? window.devicePixelRatio : 1);
    return {
      type: 'render.health',
      fps_p5: Math.max(0, telemetry.fpsP5 ?? telemetry.fps),
      fps_median: Math.max(0, telemetry.fpsMedian ?? telemetry.fps),
      frame_ms_p95: Math.max(0, telemetry.frameMsP95),
      long_tasks: this.longTasks,
      renderer: (telemetry.renderer ?? 'unknown').slice(0, 200),
      avatars: Math.max(0, Math.min(2, telemetry.avatars ?? AI_IDS.filter((id) => this.avatar(id) !== null).length)),
      pixel_ratio: pixelRatio > 0 ? pixelRatio : 1,
      client_t_ms: Math.max(0, this.now()),
    };
  }

  private sendRenderHealth(): void {
    const health = this.renderHealth();
    if (health === null) return;
    this.longTasks = 0;
    this.audio?.send(health);
  }

  // ---- 口 -------------------------------------------------------------------

  private loop = (): void => {
    const analyser = this.analyser;
    const buffer = this.buffer;
    if (analyser === null || buffer === null) return;
    analyser.getFloatTimeDomainData(buffer);
    let sum = 0;
    for (let i = 0; i < buffer.length; i += 1) sum += (buffer[i] as number) ** 2;
    this.routeMouth(Math.sqrt(sum / buffer.length));
    this.raf = requestAnimationFrame(this.loop);
  };

  /** 1 フレームぶん：RMS を再生中の AI にだけ渡し、口の記録を数える。試験からも呼ぶ。 */
  routeMouth(rms: number): void {
    const playing = new Set(this.active.values());
    const levels = routeMouthLevel(rms, playing);
    const open: Partial<Record<AiId, number>> = {};
    for (const ai_id of AI_IDS) {
      const avatar = this.avatar(ai_id);
      if (avatar === null) continue;
      avatar.setMouthLevel(levels[ai_id]);
      open[ai_id] = avatar.getTelemetry().mouth.open;
    }
    for (const ai_id of AI_IDS) {
      const value = open[ai_id];
      if (value === undefined) continue;
      const rec = this.record.mouth[ai_id];
      rec.max = Math.max(rec.max, value);
      if (playing.has(ai_id)) {
        rec.samplesWhilePlaying += 1;
        if (value > MOUTH_OPEN) rec.openWhilePlaying += 1;
      } else if (playing.size > 0 && value > MOUTH_OPEN) {
        rec.openWhileOtherPlaying += 1;
      }
    }
  }

  // ---- 受信 -----------------------------------------------------------------

  /** Worker が Node へ送った報告（再生の始まりと終わり）。 */
  private onSent(message: { type: string; audio_playback_id?: number }): void {
    if (message.type !== 'playback.started' && message.type !== 'playback.position' && message.type !== 'playback.ended') return;
    const id = message.audio_playback_id as number;
    const owner = this.owners.ownerOf(id);
    if (owner === null) {
      this.record.unknownPlayback += 1;
      return;
    }
    this.avatar(owner)?.onPlaybackReport(message as Parameters<Avatar['onPlaybackReport']>[0]);
    if (message.type === 'playback.started') this.active.set(id, owner);
    else if (message.type === 'playback.ended') {
      this.active.delete(id);
      this.owners.forget(id);
    } else return;
    const speaking = this.active.size > 0 ? ([...this.active.values()].at(-1) as AiId) : null;
    if (speaking !== this.view.speaking) this.update({ speaking });
  }

  private onMessage(message: NodeToBrowser): void {
    this.noteSyncMark(message);
    switch (message.type) {
      case 'server.hello':
        if (message.mode !== 'two_ai') {
          this.update({ sessionId: message.session_id, isFake: message.is_fake, error: UI_COPY.wrong_mode });
          void this.stop('failed');
          return;
        }
        this.update({ sessionId: message.session_id, isFake: message.is_fake, labels: { ...message.two_ai.labels } });
        break;
      case 'playback.begin': {
        const owner = this.owners.noteBegin(message);
        if (owner === null || message.ai_id === undefined) this.record.unknownAiId += 1;
        break;
      }
      case 'playback.alignment': {
        const owner = message.ai_id !== undefined ? (isAiId(message.ai_id) ? message.ai_id : null) : this.owners.ownerOf(message.audio_playback_id);
        if (owner === null) {
          this.record.unknownAiId += 1;
          break;
        }
        this.avatar(owner)?.onPlaybackAlignment(message);
        break;
      }
      case 'gaze.command': {
        const targets = gazeTargets(message.ai_id);
        this.record.gazeCommands.push({ ai_id: message.ai_id ?? null, target: message.target, client_t_ms: this.now() });
        if (targets.length === 0) {
          this.record.unknownAiId += 1;
          break;
        }
        const gaze = { ...this.view.gaze };
        for (const ai_id of targets) {
          this.avatar(ai_id)?.setGaze(message.target);
          gaze[ai_id] = message.target;
        }
        this.update({ gaze });
        break;
      }
      case 'breath.cue':
      case 'breath.release':
      case 'breath.prepare': {
        const target = commandTarget(message.ai_id);
        if (target === null || target.missing) this.record.unknownAiId += 1;
        if (target === null) break;
        const router = this.breathRouters[target.ai_id];
        const recordAi = target.missing ? null : target.ai_id;
        if (message.type === 'breath.prepare') router.onPrepare(message, recordAi);
        else router.onCue(message, recordAi);
        break;
      }
      case 'session.status':
        this.update({ degraded: message.degraded, reasons: message.reasons });
        break;
      case 'two_ai.phase': {
        this.clearPhaseTimer();
        this.record.phases.push({ phase: message.phase, client_t_ms: this.now() });
        this.marker.setEnabled(message.phase === 'discussion');
        this.update({
          phase: message.phase,
          instructionKey: message.instruction_key,
          markerEnabled: message.phase === 'discussion',
          ...(message.labels ? { labels: { ...message.labels } } : {}),
          ...(this.view.error === UI_COPY.not_ready ? { error: null } : {}),
        });
        break;
      }
      case 'two_ai.stage':
        this.update({ stage: { current: message.current as TwoAiStageView['current'], headings: [...message.headings], show: message.show } });
        break;
      case 'two_ai.board': {
        const board = this.board.apply(message);
        this.record.boards.push({ version: board.version, mode: board.mode, card_ids: board.cards.map((c) => c.card_id), client_t_ms: this.now() });
        this.update({ board, boardPickable: this.board.canPick(), boardPending: this.board.pendingPick() });
        break;
      }
      default:
        break;
    }
  }

  /** 同期の印（06 §4.7、第 5 回 m3）。 */
  private noteSyncMark(message: NodeToBrowser): void {
    const key = isSyncMarkMessage(message, { seen: this.syncSeen, stage: this.view.stage?.current ?? null });
    if (key === null) return;
    this.syncSeen.add(key);
    this.record.syncMarks.push({ key, client_t_ms: this.now() });
    this.view = { ...this.view, syncMarks: this.view.syncMarks + 1 };
    this.options.onSyncMark?.(key);
  }

  async stop(lifecycle: 'stopped' | 'failed' = 'stopped'): Promise<void> {
    this.clearPhaseTimer();
    if (this.healthTimer !== null) clearInterval(this.healthTimer);
    this.healthTimer = null;
    this.longTaskObserver?.disconnect();
    this.longTaskObserver = null;
    for (const ai_id of AI_IDS) this.breathRouters[ai_id].stop();
    for (const ai_id of AI_IDS) delete this.breathSounds[ai_id];
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    this.raf = null;
    this.analyser = null;
    const audio = this.audio;
    this.audio = null;
    await audio?.stop?.();
    this.active.clear();
    for (const ai_id of AI_IDS) this.avatar(ai_id)?.closeMouth();
    this.marker.setEnabled(false);
    this.update({ lifecycle, speaking: null, link: 'closed', markerEnabled: false });
  }
}

function emptyMouth(): MouthRecord {
  return { samplesWhilePlaying: 0, openWhilePlaying: 0, openWhileOtherPlaying: 0, max: 0 };
}
