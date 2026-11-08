/**
 * 参加者画面のブラウザ側の配線（レーン J）。React に依存しない。
 *  - 音声: startBrowserAudio（レーン A）。「はじめる」のクリックの中で呼ぶ。
 *  - 口: 再生音（outputNode）に AnalyserNode をつなぎ、毎フレームの RMS を Avatar.setMouthLevel へ。
 *    語時刻（Node の playback.alignment）と再生の報告（Worker の playback.started／position／ended）を
 *    Avatar.onPlaybackAlignment／onPlaybackReport へ。
 *  - 視線: Node の gaze.command → Avatar.setGaze。描画の報告（onGazeReport）を gaze.report で返す。
 *  - 吸気: Node の breath.cue → アバターの BreathController.startInhale、breath.release → release（波3、条件
 *    initiative_inhale のときだけ届く）。吸気の長さは Node が決め、吸気の完了も Node の時計で判定する
 *    （ここから完了を知らせない）。描画を始めた時刻と局面の実時刻（BreathLayer.onPhase、吸気・保持・脱力の始まりと終わり）を signal.report で返す（記録のため）。
 *  - 研究条件: 開始の前に選んだ条件を WS の URL（?condition=）で Node へ伝える（セッション単位）。
 *  - 状態: server.hello、session.status、playback.begin／stop、リンクの状態。
 */
import type { Condition } from '@llm-vap/contracts/common';
import type { ConversationKind, TimingStrategy } from '@llm-vap/contracts';
import type {
  BreathCue,
  BreathRelease,
  GazeReport,
  GazeTarget,
  NodeToBrowser,
  SignalReport,
  TrackSettings,
} from '@llm-vap/contracts/browser_rpc';
import { startBrowserAudio, type BrowserAudioSession, type LinkState } from '../audio';
import type { Avatar } from '../avatar';
import type { BreathController, BreathPhaseEvent } from '../avatar/breath';
import { BreathSignalReporter } from '../avatar/breath_signal';

/** 研究条件の表示名（開始画面の選択）。本番の実験では選択を隠す（NEXT_PUBLIC_HIDE_CONDITION_PICKER）。 */
export const CONDITION_LABELS: Record<Condition, string> = {
  reactive: '通常応答（ベースライン）',
  initiative_inhale: '吸気あり（提案）',
  initiative_no_cue: '吸気なし',
};

/** 会話の種類の表示名（開始画面。隠すときは NEXT_PUBLIC_HIDE_CONDITION_PICKER）。種類は設定ファイルの ID で、ここにない種類は ID のまま表示する。 */
export const CONVERSATION_KIND_LABELS: Record<string, string> = {
  joint_thinking: '共同思考',
  companion: 'コンパニオン',
};

/** 申し出るタイミングの方式の表示名。 */
export const TIMING_STRATEGY_LABELS: Record<TimingStrategy, string> = {
  llm: 'LLM が判定（既定）',
  immediate: 'すぐ申し出る（比較用）',
  v2: 'v2（比較・再現用）',
};

/** WS の URL に会話の種類と方式を足す。null の項目は足さない（Node の既定）。 */
export function withInitiativeChoice(wsUrl: string, choice: { conversation_kind?: ConversationKind | null; timing_strategy?: TimingStrategy | null }): string {
  const { conversation_kind = null, timing_strategy = null } = choice;
  if (conversation_kind === null && timing_strategy === null) return wsUrl;
  const url = new URL(wsUrl);
  if (conversation_kind !== null) url.searchParams.set('conversation_kind', conversation_kind);
  if (timing_strategy !== null) url.searchParams.set('timing_strategy', timing_strategy);
  return url.toString();
}

/** WS の URL に研究条件を足す。null なら URL のまま（Node の既定 CONDITION）。 */
export function withCondition(wsUrl: string, condition: Condition | null): string {
  if (condition === null) return wsUrl;
  const url = new URL(wsUrl);
  url.searchParams.set('condition', condition);
  return url.toString();
}

/** DEFERRED から話し始めるときの短い準備動作の長さ（暫定）。音声の開始を遅らせないので、発話の出だしと少し重なる。 */
export const DEFERRED_SPEECH_PREP_MS = 150;

/** アバターの呼吸の制御。ランタイムが breath を持たない（古い版、読み込み前）なら null。 */
export function breathOf(avatar: Avatar | null): BreathController | null {
  if (avatar === null) return null;
  return (avatar as Avatar & { breath?: BreathController }).breath ?? null;
}

/** 別のタブが会話中で、このタブの接続を断られた（Worker は張り直さない）。 */
export const SESSION_OPEN_ELSEWHERE_TEXT =
  'この会話は別のタブで開かれています。このタブはつながりません。使わないほうのタブを閉じてください。';

export interface ParticipantView {
  phase: 'idle' | 'starting' | 'running' | 'stopped' | 'failed';
  /** elsewhere は別のタブで接続中のため断られた状態。 */
  link: LinkState | 'none' | 'elsewhere';
  sessionId: string | null;
  /** Node が返したこのセッションの研究条件（server.hello）。参加者には見せない。 */
  condition: Condition | null;
  isFake: boolean;
  degraded: boolean;
  reasons: string[];
  aiSpeaking: boolean;
  gaze: GazeTarget;
  error: string | null;
  trackSettings: TrackSettings | null;
  sampleRateHz: number | null;
  inputDevices: { label: string; isDefault: boolean }[];
  warnings: string[];
}

export const INITIAL_VIEW: ParticipantView = {
  phase: 'idle',
  link: 'none',
  sessionId: null,
  condition: null,
  isFake: false,
  degraded: false,
  reasons: [],
  aiSpeaking: false,
  gaze: 'user',
  error: null,
  trackSettings: null,
  sampleRateHz: null,
  inputDevices: [],
  warnings: [],
};

/** getUserMedia などの失敗を参加者向けの文に直す。 */
export function describeStartError(error: unknown): string {
  const name = error instanceof DOMException ? error.name : error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error);
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'マイクの使用が許可されませんでした。アドレスバー左の鍵のアイコンから「マイク」を「許可」にして、ページを再読み込みしてください。';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'マイクが見つかりません。有線ヘッドセットを接続してから、ページを再読み込みしてください。';
    case 'NotReadableError':
    case 'AbortError':
      return 'マイクを開けませんでした。ほかのアプリ（会議アプリなど）がマイクを使っていないか確認して、ページを再読み込みしてください。';
    default:
      return `開始できませんでした: ${message}`;
  }
}

/** 設定の確認。AEC/NS/AGC は false を要求している（計画 §3.2）。true で返ったら警告する。 */
export function settingsWarnings(settings: TrackSettings, sampleRateHz: number): string[] {
  const warnings: string[] = [];
  const check = (name: string, value: { value: boolean | null }) => {
    if (value.value === true) warnings.push(`${name} が有効のままです（無効を要求しましたが、ブラウザが有効で返しました）。`);
    if (value.value === null) warnings.push(`${name} の状態をブラウザが返しませんでした。`);
  };
  check('エコーキャンセル', settings.echoCancellation);
  check('ノイズ抑制', settings.noiseSuppression);
  check('自動音量調整', settings.autoGainControl);
  if (sampleRateHz !== 48000) warnings.push(`音声の処理レートが ${sampleRateHz} Hz です（48000 Hz を要求）。`);
  return warnings;
}

export function deviceWarnings(devices: { label: string }[]): string[] {
  const def = devices.find((d) => /default|既定/i.test(d.label)) ?? devices[0];
  if (!def) return [];
  if (/bluetooth|hands-?free|airpods|ワイヤレス/i.test(def.label)) {
    return [`既定のマイクが Bluetooth の機器のようです（${def.label}）。遅延が大きいので有線ヘッドセットを使ってください。`];
  }
  return [];
}

export interface ParticipantOptions {
  wsUrl: string;
  avatar: () => Avatar | null;
  onView: (view: ParticipantView) => void;
}

export class ParticipantController {
  private view: ParticipantView = { ...INITIAL_VIEW };
  private audio: BrowserAudioSession | null = null;
  private analyser: AnalyserNode | null = null;
  private buffer: Float32Array<ArrayBuffer> | null = null;
  private raf: number | null = null;
  private playing = new Set<number>();
  /** E2E 向けの記録。 */
  readonly record = {
    gazeCommands: [] as { target: GazeTarget; client_t_ms: number }[],
    gazeReports: [] as GazeReport[],
    /** 届いた吸気の合図と解除（E2E 向け）。breath は BreathController を呼べたか。 */
    breathCommands: [] as { type: 'breath.cue' | 'breath.release' | 'breath.prepare'; cue_id: string | null; reason?: string; client_t_ms: number; breath: boolean }[],
    signalReports: [] as SignalReport[],
    mouthOpenWhilePlaying: 0,
    mouthSamplesWhilePlaying: 0,
    maxMouthOpen: 0,
    messages: [] as string[],
  };

  /** breath.prepare の後に release('speech_started') を呼ぶ予約（撤回が来たら取り消す）。 */
  private prepareTimer: ReturnType<typeof setTimeout> | null = null;
  /** 局面の報告の対応（cue_id → candidate_id）。古い順に落とす。 */
  private readonly breathCandidates = new Map<string, string>();
  /** breath.prepare の候補（短い準備は cue_id が null のことがある）。 */
  private prepareCandidate: string | null = null;
  private breathReportedAvatar: Avatar | null = null;
  private breathReportUnsubscribe: (() => void) | null = null;
  /** アバターの吸気の局面の実時刻を signal.report へ（started の一部と ended、記録だけ）。 */
  private readonly breathSignals = new BreathSignalReporter(
    (cueId) => (cueId !== null ? (this.breathCandidates.get(cueId) ?? this.prepareCandidate) : this.prepareCandidate),
    (event) => {
      const signal: SignalReport = {
        type: 'signal.report',
        candidate_id: event.candidate_id,
        phase: event.phase,
        state: event.state,
        visible: true,
        client_t_ms: { value: event.client_t_ms },
      };
      this.record.signalReports.push(signal);
      this.audio?.send(signal);
    },
  );

  constructor(private readonly options: ParticipantOptions) {}

  current(): ParticipantView {
    return this.view;
  }

  session(): BrowserAudioSession | null {
    return this.audio;
  }

  private update(patch: Partial<ParticipantView>): void {
    this.view = { ...this.view, ...patch };
    this.options.onView(this.view);
  }

  /** アバターの onGazeReport から呼ぶ。 */
  gazeRendered(report: GazeReport): void {
    this.record.gazeReports.push(report);
    this.audio?.send(report);
  }

  /**
   * クリックのハンドラの中で呼ぶこと（自動再生の制限）。condition は開始画面で選んだ研究条件（null は Node の既定）。
   * 再接続も同じ URL を使うので、同じセッションの間は条件が変わらない。
   */
  async start(options: { condition?: Condition | null; conversation_kind?: ConversationKind | null; timing_strategy?: TimingStrategy | null } = {}): Promise<void> {
    if (this.view.phase === 'starting' || this.view.phase === 'running') return;
    this.update({ phase: 'starting', error: null });
    try {
      this.audio = await startBrowserAudio({
        wsUrl: withInitiativeChoice(withCondition(this.options.wsUrl, options.condition ?? null), {
          conversation_kind: options.conversation_kind ?? null,
          timing_strategy: options.timing_strategy ?? null,
        }),
        onMessage: (message) => this.onMessage(message),
        // 再生の始まりと終わりは Worker が Node へ送る報告で知る（主スレッドには別に届かない）。
        onSent: (message) => {
          // 口形（語時刻＋再生位置）。再生の報告は Worker が Node へ送ったものを主スレッドでも受ける。
          if (message.type === 'playback.started' || message.type === 'playback.position' || message.type === 'playback.ended') {
            this.options.avatar()?.onPlaybackReport(message);
          }
          if (message.type === 'playback.started') this.playing.add(message.audio_playback_id);
          else if (message.type === 'playback.ended') this.playing.delete(message.audio_playback_id);
          else return;
          if (this.view.aiSpeaking !== this.playing.size > 0) this.update({ aiSpeaking: this.playing.size > 0 });
        },
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
      this.update({ phase: 'failed', error: describeStartError(error) });
      return;
    }
    const audio = this.audio;
    const analyser = audio.context.createAnalyser();
    analyser.fftSize = 1024;
    audio.outputNode.connect(analyser);
    this.analyser = analyser;
    this.buffer = new Float32Array(analyser.fftSize);
    this.loop();

    let inputDevices: ParticipantView['inputDevices'] = [];
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      inputDevices = devices
        .filter((d) => d.kind === 'audioinput')
        .map((d) => ({ label: d.label || '（名前なし）', isDefault: d.deviceId === 'default' }));
    } catch {
      inputDevices = [];
    }
    this.update({
      phase: 'running',
      trackSettings: audio.trackSettings,
      sampleRateHz: audio.sampleRateHz,
      inputDevices,
      warnings: [...settingsWarnings(audio.trackSettings, audio.sampleRateHz), ...deviceWarnings(inputDevices.filter((d) => d.isDefault))],
    });
  }

  private loop = (): void => {
    const analyser = this.analyser;
    const buffer = this.buffer;
    if (analyser === null || buffer === null) return;
    analyser.getFloatTimeDomainData(buffer);
    let sum = 0;
    for (let i = 0; i < buffer.length; i += 1) sum += (buffer[i] as number) ** 2;
    const rms = Math.sqrt(sum / buffer.length);
    const avatar = this.options.avatar();
    avatar?.setMouthLevel(rms);
    if (avatar && this.playing.size > 0) {
      const open = avatar.getTelemetry().mouth.open;
      this.record.mouthSamplesWhilePlaying += 1;
      if (open > 0.05) this.record.mouthOpenWhilePlaying += 1;
      this.record.maxMouthOpen = Math.max(this.record.maxMouthOpen, open);
    }
    this.raf = requestAnimationFrame(this.loop);
  };

  private onMessage(message: NodeToBrowser): void {
    switch (message.type) {
      case 'playback.alignment':
        this.options.avatar()?.onPlaybackAlignment(message);
        break;
      case 'server.hello':
        this.update({ sessionId: message.session_id, condition: message.condition, isFake: message.is_fake });
        break;
      case 'breath.cue':
      case 'breath.release':
        this.onBreath(message);
        break;
      case 'breath.prepare': {
        const breath = breathOf(this.options.avatar());
        this.record.breathCommands.push({ type: message.type, cue_id: null, client_t_ms: performance.now(), breath: breath !== null });
        this.prepareCandidate = message.candidate_id;
        this.bindBreathPhases();
        breath?.prepareShort?.(DEFERRED_SPEECH_PREP_MS);
        this.clearPrepareTimer();
        this.prepareTimer = setTimeout(() => {
          this.prepareTimer = null;
          breath?.release('speech_started');
        }, DEFERRED_SPEECH_PREP_MS);
        break;
      }
      case 'session.status':
        this.update({ degraded: message.degraded, reasons: message.reasons });
        break;
      case 'gaze.command':
        this.record.gazeCommands.push({ target: message.target, client_t_ms: performance.now() });
        this.options.avatar()?.setGaze(message.target);
        this.update({ gaze: message.target });
        break;
      default:
        break;
    }
  }

  /** 吸気の合図と解除をアバターへ。描画を始めた時刻（次の rAF）を signal.report で返す（記録だけ）。 */
  private onBreath(message: BreathCue | BreathRelease): void {
    const breath = breathOf(this.options.avatar());
    this.record.breathCommands.push({
      type: message.type,
      cue_id: message.cue_id,
      ...(message.type === 'breath.release' ? { reason: message.reason } : {}),
      client_t_ms: performance.now(),
      breath: breath !== null,
    });
    // アバターがなければ描いていないので報告しない（Node は合図を出した記録だけを持つ）。
    if (breath === null) return;
    // Node の解除が先に来たら、予約した短い準備の後の発声はしない（撤回の後に声を出さない）。
    if (message.type === 'breath.release') this.clearPrepareTimer();
    if (message.type === 'breath.cue') this.noteBreathCandidate(message.cue_id, message.candidate_id);
    this.bindBreathPhases();
    // アバターが受け付けなかった合図（吸気中の二重の吸気、話している間の吸気、もう戻っている脱力など）は描かれていない。
    const applied =
      message.type === 'breath.cue'
        ? breath.startInhale({ cue_id: message.cue_id, duration_ms: message.duration_ms })
        : breath.release(message.reason);
    const phase: SignalReport['phase'] =
      message.type === 'breath.cue' ? 'inhale' : message.reason === 'speech_started' ? 'pre_speech' : 'relax';
    const report = (visible: boolean, t: number | null, nullReason = 'not_visible') => {
      const signal: SignalReport = {
        type: 'signal.report',
        candidate_id: message.candidate_id,
        phase,
        state: 'started',
        visible,
        client_t_ms: t === null ? { value: null, null_reason: nullReason } : { value: t },
      };
      this.record.signalReports.push(signal);
      this.audio?.send(signal);
    };
    if (!applied) report(false, null, 'avatar_did_not_apply');
    // 背景タブでは rAF が来ないので、見えていなければその場で visible=false を返す。
    else if (typeof document !== 'undefined' && document.visibilityState !== 'visible') report(false, null);
    else requestAnimationFrame((t) => report(true, t));
  }

  /** 吸気の局面の報告をアバターへつなぐ（アバターの作り直しに備えて毎回確かめる）。 */
  private bindBreathPhases(): void {
    const avatar = this.options.avatar();
    if (avatar === null || avatar === this.breathReportedAvatar) return;
    this.breathReportUnsubscribe?.();
    this.breathReportedAvatar = avatar;
    const subscribe = (avatar as Avatar & { onBreathPhase?: Avatar['onBreathPhase'] }).onBreathPhase;
    this.breathReportUnsubscribe = subscribe?.call(avatar, (event: BreathPhaseEvent) => this.breathSignals.onPhase(event)) ?? null;
  }

  private noteBreathCandidate(cueId: string, candidateId: string): void {
    this.breathCandidates.set(cueId, candidateId);
    if (this.breathCandidates.size > 16) this.breathCandidates.delete(this.breathCandidates.keys().next().value as string);
  }

  private clearPrepareTimer(): void {
    if (this.prepareTimer !== null) clearTimeout(this.prepareTimer);
    this.prepareTimer = null;
  }

  async stop(): Promise<void> {
    this.clearPrepareTimer();
    this.breathReportUnsubscribe?.();
    this.breathReportUnsubscribe = null;
    this.breathReportedAvatar = null;
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    this.raf = null;
    this.analyser = null;
    await this.audio?.stop();
    this.audio = null;
    this.playing.clear();
    this.update({ phase: 'stopped', aiSpeaking: false, link: 'closed' });
  }
}
