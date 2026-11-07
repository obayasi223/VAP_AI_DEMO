/**
 * 口。入力は MouthSource という小さな口で、今は音量駆動の VolumeMouthSource だけがある。
 * 語境界・時間比例の口形は同じ口を実装して Avatar.setMouthSource で差し替える（計画 §4.7）。
 */
import type { AvatarLayer, LayerContext, PoseFrame } from './pose';
import { clamp01, smoothAsymmetric } from './util';

/** VRM の5母音の重み。 */
export interface MouthShape {
  aa: number;
  ih: number;
  ou: number;
  ee: number;
  oh: number;
}

export const CLOSED_MOUTH: Readonly<MouthShape> = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 };

export interface MouthSource {
  /** 毎フレーム1回呼ばれる。 */
  update(dtMs: number): MouthShape;
}

/** Float32 の PCM（-1〜1）の RMS。 */
export function computeRms(samples: ArrayLike<number>): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const s = samples[i] ?? 0;
    sum += s * s;
  }
  return Math.sqrt(sum / samples.length);
}

export interface LevelMapping {
  /** これ以下は閉じる。 */
  floorDb: number;
  /** これ以上は全開。 */
  ceilDb: number;
  /** 1 未満で小さい音でも開きやすくなる。 */
  gamma: number;
}

/** 音声の値は未調整。実音声で確認して変える（人の評価が必要）。 */
export const DEFAULT_LEVEL_MAPPING: LevelMapping = { floorDb: -46, ceilDb: -14, gamma: 0.8 };

/** RMS → 口の開き（0〜1）。dB で線形に写す。 */
export function rmsToOpen(rms: number, mapping: LevelMapping = DEFAULT_LEVEL_MAPPING): number {
  if (!(rms > 0)) return 0;
  const db = 20 * Math.log10(rms);
  const t = clamp01((db - mapping.floorDb) / (mapping.ceilDb - mapping.floorDb));
  return Math.pow(t, mapping.gamma);
}

export interface VolumeMouthOptions {
  mapping: LevelMapping;
  attackMs: number;
  releaseMs: number;
  /** closeNow の後の閉じる速さ。発話停止と同時に閉じるため短い。 */
  closeMs: number;
  /** この間に音量が来なければ閉じる（再生が止まったのに口が開いたままになるのを防ぐ）。 */
  staleAfterMs: number;
  /** aa の最大値。1 だと口が開きすぎるモデルがあるので絞る。 */
  maxOpen: number;
}

export const DEFAULT_VOLUME_MOUTH: VolumeMouthOptions = {
  mapping: DEFAULT_LEVEL_MAPPING,
  attackMs: 30,
  releaseMs: 80,
  closeMs: 25,
  staleAfterMs: 150,
  maxOpen: 0.85,
};

export class VolumeMouthSource implements MouthSource {
  private readonly options: VolumeMouthOptions;
  private level = 0;
  private open = 0;
  private sinceLevelMs = Number.POSITIVE_INFINITY;
  private closing = false;

  constructor(options: Partial<VolumeMouthOptions> = {}) {
    this.options = { ...DEFAULT_VOLUME_MOUTH, ...options };
  }

  /** 再生中の RMS を入れる。一定間隔で呼び続けること（来なくなると閉じる）。 */
  setLevel(rms: number): void {
    this.level = Number.isFinite(rms) ? Math.max(rms, 0) : 0;
    this.sinceLevelMs = 0;
    this.closing = false;
  }

  /** 再生中の PCM をそのまま入れる。 */
  pushPcm(samples: ArrayLike<number>): void {
    this.setLevel(computeRms(samples));
  }

  /** 発話の停止。次に音量が来るまで速く閉じる。 */
  closeNow(): void {
    this.level = 0;
    this.closing = true;
  }

  update(dtMs: number): MouthShape {
    // 判定してから進める。描画が遅くて dt が staleAfterMs より長くても、前のフレームの後に届いた音量は新しい。
    const fresh = !this.closing && this.sinceLevelMs <= this.options.staleAfterMs;
    this.sinceLevelMs += dtMs;
    const target = fresh ? rmsToOpen(this.level, this.options.mapping) : 0;
    const release = this.closing ? this.options.closeMs : this.options.releaseMs;
    this.open = smoothAsymmetric(this.open, target, dtMs, this.options.attackMs, release);
    if (this.open < 1e-3) this.open = 0;
    return { ...CLOSED_MOUTH, aa: this.open * this.options.maxOpen };
  }
}

/** 口の開きの代表値。テレメトリに出す。 */
export function mouthOpenAmount(shape: MouthShape): number {
  return Math.max(shape.aa, shape.ih, shape.ou, shape.ee, shape.oh);
}

export class MouthLayer implements AvatarLayer {
  readonly name = 'mouth';
  shape: MouthShape = { ...CLOSED_MOUTH };

  constructor(public source: MouthSource) {}

  update(context: LayerContext, frame: PoseFrame): void {
    this.shape = this.source.update(context.dtMs);
    frame.addExpression('aa', this.shape.aa);
    frame.addExpression('ih', this.shape.ih);
    frame.addExpression('ou', this.shape.ou);
    frame.addExpression('ee', this.shape.ee);
    frame.addExpression('oh', this.shape.oh);
  }
}
