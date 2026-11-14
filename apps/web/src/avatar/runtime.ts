/**
 * 1 体のアバター（参加者画面の 1 対 1、dev ページ）。公開の型と createAvatar の引数・挙動は従来のまま。
 * 中身は「1 体のステージ」（stage.ts の createStage に 1 体を渡す）。層と制御は core.ts、
 * 描画（1 つの canvas、レンダラー、rAF）は stage.ts にある（docs/design/two_ai/03 §1）。
 * 判断はしない: 視線は setGaze で外から受け、音量は setMouthLevel／pushPcm で、語時刻と再生位置は
 * onPlaybackAlignment／onPlaybackReport で受ける（配線は J）。
 *
 * 層の順: rest → idle → gaze → saccade → expression → breath → blink → mouth。
 * 1フレームの順序: 層の合成 → ボーンへ適用 → 視線 → 表情 → vrm.update → 描画 → 報告。
 * 吸気と準備姿勢（H2）は breath の層（expression と blink の間）。胸郭のモーフは読み込み時に作る。ループは増やさない。
 */
import type { GazeReport, GazeTarget } from '@llm-vap/contracts';
import type { AvatarModelSpec } from './avatar_models';
import type {
  BreathController,
  BreathParams,
  BreathPhaseEvent,
  BreathTelemetry,
  NormalBreathParams,
  PrepBreathParams,
} from './breath';
import type { SpeechFeatures } from './face';
import type { LipSyncMode, PlaybackAlignmentLike, PlaybackReportLike, AlignmentMouthSource } from './lipsync';
import type { MouthShape, MouthSource, VolumeMouthSource } from './mouth';
import type { AvatarLayer } from './pose';
import type { RenderSettings } from './render_settings';
import { createStage } from './stage';
import type { Rng } from './util';

export type Framing = 'bust' | 'face';

export interface AvatarOptions {
  container: HTMLElement;
  modelUrl: string;
  /** モデルの種類と対応表（avatar_models.ts）。省略は VRM（従来どおり）。 */
  model?: AvatarModelSpec;
  framing?: Framing;
  rng?: Rng;
  onProgress?: (loadedBytes: number, totalBytes: number) => void;
  /** browser_rpc の gaze.report の元。送信は呼び出し側（J）。 */
  onGazeReport?: (report: GazeReport) => void;
  /** 描画の設定の上書き。'h1' は比較用の旧設定。 */
  render?: Partial<RenderSettings> | 'h1';
  /** 吸気の phase の遷移（rAF 時刻つき）。inhale の nowMs が吸気が最初に描かれたフレーム。記録は呼び出し側。 */
  onBreathPhase?: (event: BreathPhaseEvent) => void;
  /** 測定用（/dev/avatar_measure）。毎フレーム render の直後に呼ぶ。指定がなければ何もしない。 */
  onFrameRendered?: (timing: FrameTiming) => void;
}

/** 1フレームの時刻（performance.now の軸）。 */
export interface FrameTiming {
  rafMs: number;
  startedMs: number;
  renderedMs: number;
  /** 描いたフレームの胸郭モーフの重み（吸気の最初の変化の検出に使う）。 */
  chestWeight: number;
}

/** 読める形で公開する値。avatar.* イベントは契約に無いので、今は取りに来てもらう。 */
export interface AvatarTelemetry {
  frame: number;
  /** 直近のフレームの rAF 時刻。 */
  rafMs: number;
  fps: number;
  mouth: { open: number; shape: MouthShape; appliedAa: number; mode: LipSyncMode; playbackPositionMs: number | null };
  blink: { weight: number; count: number; gazeCount: number };
  saccade: { count: number; yawDeg: number; pitchDeg: number };
  speech: SpeechFeatures;
  gaze: {
    target: GazeTarget;
    awayAmount: number;
    settled: boolean;
    /** 指令値（lookAt の入力、度）。 */
    eyeInputYawDeg: number;
    eyeInputPitchDeg: number;
    /** シーングラフから読んだ左眼ボーンの回転（度）。 */
    leftEyeYawDeg: number;
    leftEyePitchDeg: number;
    rightEyeYawDeg: number;
    rightEyePitchDeg: number;
  };
  /** シーングラフから読んだ頭部の向き（待機の揺れと視線の合計、度）。 */
  head: { yawDeg: number; pitchDeg: number; rollDeg: number };
  idleIntensity: number;
  breath: BreathTelemetry;
  layers: string[];
}

/** 読み込み時に作った胸郭モーフの情報。 */
export interface BreathMorphInfo {
  meshes: string[];
  movedVertices: number;
  maxDisplacementMm: number;
  chestBone: string;
}

export interface AvatarModelInfo {
  specVersion: string;
  meta: Record<string, unknown>;
  expressions: string[];
  humanBones: string[];
  missingHumanBones: string[];
  lookAt: {
    applier: string;
    horizontalInner: [number, number] | null;
    horizontalOuter: [number, number] | null;
    verticalDown: [number, number] | null;
    verticalUp: [number, number] | null;
  };
  meshes: { name: string; primitives: number; morphTargets: string[]; vertices: number }[];
  springBoneJoints: number;
  breathMorph: BreathMorphInfo;
}

export interface Avatar {
  readonly mouth: VolumeMouthSource;
  /** 既定の口（語時刻＋音量包絡）。語時刻が無ければ音量だけの口と同じに動く。 */
  readonly lipSync: AlignmentMouthSource;
  setMouthLevel(rms: number): void;
  pushPcm(samples: ArrayLike<number>): void;
  closeMouth(): void;
  /** Node から届いた playback.alignment（PlaybackAlignment をそのまま渡せる）。 */
  onPlaybackAlignment(message: PlaybackAlignmentLike): void;
  /** Worker が送った playback.started／position／ended（BrowserAudioOptions.onSent で受ける。そのまま渡せる）。 */
  onPlaybackReport(message: PlaybackReportLike): void;
  /** 口を差し替える。null で既定（lipSync）へ戻す。 */
  setMouthSource(source: MouthSource | null): void;
  setGaze(target: GazeTarget): void;
  triggerBlink(): void;
  setAutoBlink(enabled: boolean): void;
  setIdleIntensity(intensity: number): void;
  /** 相手を見ている間の小さな視線移動。 */
  setSaccades(enabled: boolean): void;
  /** 表情の層（待機の表情、眉、話している間の頭の動き）の強さ 0〜1。 */
  setExpressionIntensity(intensity: number): void;
  setFraming(framing: Framing): void;
  /** 確認用: カメラを目の周りに水平に回す（度、0 が正面）。参加者画面では使わない。 */
  setViewYaw(deg: number): void;
  /**
   * 確認用: 層の時間の倍率（1 が実時間、0 で止める）。描画は続く。参加者画面では使わない。
   * 遅い描画（SwiftShader）で時刻つきの連続画像を撮るため。
   */
  setTimeScale(scale: number): void;
  /** 確認用: 次のフレームで層の時間を ms だけ進める（16ms ずつ）。 */
  advanceTime(ms: number): void;
  /** 発話希望の準備吸気（H2）。フレームの更新はランタイムが行う。 */
  readonly breath: BreathController;
  /** 吸気の phase の遷移（rAF 時刻つき）を受ける。戻り値で解除する。signal.ended の報告に使う（participant.ts）。 */
  onBreathPhase(listener: (event: BreathPhaseEvent) => void): () => void;
  /** 呼吸のパラメータの部分的な上書き（確認ページ用）。 */
  setBreathParams(patch: { normal?: Partial<NormalBreathParams>; prep?: Partial<PrepBreathParams> }): void;
  getBreathParams(): BreathParams;
  addLayer(layer: AvatarLayer, position?: { before: string }): void;
  removeLayer(name: string): void;
  getTelemetry(): AvatarTelemetry;
  getModelInfo(): AvatarModelInfo;
  /** ボーンのワールド位置。無ければ null。確認と H2 の調整用。 */
  getBoneWorldPosition(name: string): { x: number; y: number; z: number } | null;
  dispose(): void;
}

export async function createAvatar(options: AvatarOptions): Promise<Avatar> {
  let loadError: string | null = null;
  const stage = await createStage({
    container: options.container,
    avatars: [{ ai_id: 'A', modelUrl: options.modelUrl, model: options.model ?? { kind: 'vrm' } }],
    framing: options.framing ?? 'bust',
    maxFps: null,
    ...(options.rng ? { rng: options.rng } : {}),
    ...(options.render ? { render: options.render } : {}),
    onProgress: (_ai, loaded, total) => options.onProgress?.(loaded, total),
    onGazeReport: (_ai, report) => options.onGazeReport?.(report),
    onBreathPhase: (_ai, event) => options.onBreathPhase?.(event),
    ...(options.onFrameRendered ? { onFrameRendered: options.onFrameRendered } : {}),
    onAvatarLoad: (_ai, result) => {
      if (result.status === 'failed') loadError = result.error;
    },
  });
  const avatar = stage.avatar('A');
  if (avatar === null) {
    stage.dispose();
    throw new Error(loadError ?? 'アバターを読み込めなかった');
  }
  // avatar.dispose は 1 体のステージ全体を破棄する（core.ts の hooks）。
  return avatar;
}
