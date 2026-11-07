/**
 * 参加者画面のブラウザ側の配線（レーン J）。React に依存しない。
 *  - 音声: startBrowserAudio（レーン A）。「はじめる」のクリックの中で呼ぶ。
 *  - 口: 再生音（outputNode）に AnalyserNode をつなぎ、毎フレームの RMS を Avatar.setMouthLevel へ。
 *  - 視線: Node の gaze.command → Avatar.setGaze。描画の報告（onGazeReport）を gaze.report で返す。
 *  - 状態: server.hello、session.status、playback.begin／stop、リンクの状態。
 */
import type { GazeReport, GazeTarget, NodeToBrowser, TrackSettings } from '@llm-vap/contracts/browser_rpc';
import { startBrowserAudio, type BrowserAudioSession, type LinkState } from '../audio';
import type { Avatar } from '../avatar';

/** 別のタブが会話中で、このタブの接続を断られた（Worker は張り直さない）。 */
export const SESSION_OPEN_ELSEWHERE_TEXT =
  'この会話は別のタブで開かれています。このタブはつながりません。使わないほうのタブを閉じてください。';

export interface ParticipantView {
  phase: 'idle' | 'starting' | 'running' | 'stopped' | 'failed';
  /** elsewhere は別のタブで接続中のため断られた状態。 */
  link: LinkState | 'none' | 'elsewhere';
  sessionId: string | null;
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
    mouthOpenWhilePlaying: 0,
    mouthSamplesWhilePlaying: 0,
    maxMouthOpen: 0,
    messages: [] as string[],
  };

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

  /** クリックのハンドラの中で呼ぶこと（自動再生の制限）。 */
  async start(): Promise<void> {
    if (this.view.phase === 'starting' || this.view.phase === 'running') return;
    this.update({ phase: 'starting', error: null });
    try {
      this.audio = await startBrowserAudio({
        wsUrl: this.options.wsUrl,
        onMessage: (message) => this.onMessage(message),
        // 再生の始まりと終わりは Worker が Node へ送る報告で知る（主スレッドには別に届かない）。
        onSent: (message) => {
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
      case 'server.hello':
        this.update({ sessionId: message.session_id, isFake: message.is_fake });
        break;
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

  async stop(): Promise<void> {
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    this.raf = null;
    this.analyser = null;
    await this.audio?.stop();
    this.audio = null;
    this.playing.clear();
    this.update({ phase: 'stopped', aiSpeaking: false, link: 'closed' });
  }
}
