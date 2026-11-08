/**
 * 表情の層: 待機のわずかな表情、眉のわずかな動き、話している間の小さな頭の動き。
 *
 * 感情は推定しない（根拠のない演出になる）。使う手掛かりは自分の発話の音量の包絡（口の開き）だけ:
 *  - 待機は relaxed を少しだけ足して、無表情の硬さを和らげる。話している間は口形とぶつかるので弱める。
 *  - 句の頭（ポーズの後に話し始めた時）に、ときどき眉を少し上げる。強調（包絡の立ち上がり）でもわずかに上げる。
 *  - 話している間、ゆっくりした頭の揺れを足し、強調（包絡の立ち上がり）ではごく小さくうなずく。
 *  - 休止を伴う句の切れ目で、ときどき小さくうなずく（Ishi et al. 2007 の日本語の自由会話で、うなずきは強い句境界の最終音節に出て、
 *    ピッチアクセントごとには出ない。ここでは休止を検出してから動かすので最終音節より少し遅い。docs/speech_motion_audit.md）。
 * 肩・鎖骨・胸は書かない（吸気と紛らわしい動き、計画 §4.7）。値は未評価で、過剰に見えないよう小さくしている。
 */
import { SmoothNoise } from './idle';
import type { AvatarLayer, LayerContext, PoseFrame } from './pose';
import { clamp01, DEG2RAD, smoothAsymmetric, type Rng } from './util';

export interface ExpressionOptions {
  relaxedIdle: number;
  relaxedSpeaking: number;
  /** 眉のゆっくりした揺れ（0 以上だけ使う）。 */
  browNoise: number;
  browNoiseSpanMs: number;
  /** 句の頭の眉上げ。 */
  phraseBrowRaise: number;
  phraseBrowProbability: number;
  phraseBrowMs: number;
  /** この間、口が閉じていたら次の開きを句の頭とみなす。 */
  phrasePauseMs: number;
  emphasisBrow: number;
  /** 強調でのうなずき（度、正が下）。 */
  nodDeg: number;
  /** 句の切れ目のうなずき（度）と確率、長さ（ms）。 */
  phraseNodDeg: number;
  phraseNodProbability: number;
  phraseNodMs: number;
  /** この間、口が閉じたら句の切れ目とみなす（ms）。 */
  phraseEndMs: number;
  /** 句の切れ目とみなすのに必要な、直前の発声の長さ（ms）。 */
  phraseMinSpeechMs: number;
  speechYawDeg: number;
  speechRollDeg: number;
  speechPitchDeg: number;
  speechNoiseSpanMs: number;
  /** 口の開きがこれを超えたら話しているとみなす。 */
  openThreshold: number;
}

export const DEFAULT_EXPRESSION: ExpressionOptions = {
  relaxedIdle: 0.14,
  relaxedSpeaking: 0.06,
  browNoise: 0.06,
  browNoiseSpanMs: 4200,
  phraseBrowRaise: 0.3,
  phraseBrowProbability: 0.45,
  phraseBrowMs: 700,
  phrasePauseMs: 450,
  emphasisBrow: 0.12,
  nodDeg: 0.5,
  phraseNodDeg: 1.8,
  phraseNodProbability: 0.5,
  phraseNodMs: 520,
  phraseEndMs: 180,
  phraseMinSpeechMs: 400,
  speechYawDeg: 1.3,
  speechRollDeg: 0.9,
  speechPitchDeg: 0.8,
  speechNoiseSpanMs: 1000,
  openThreshold: 0.04,
};

export interface SpeechFeatures {
  /** 話している度合い（0〜1、ゆっくり変わる）。 */
  speaking: number;
  /** 包絡の立ち上がり（0〜1）。 */
  emphasis: number;
  /** このフレームで句が始まった。 */
  phraseStart: boolean;
  /** このフレームで、休止を伴う句の切れ目になった（発声の後に phraseEndMs 閉じた）。 */
  phraseEnd: boolean;
}

/** 口の開きの列 → 話している度合い、強調、句の頭。 */
export class SpeechActivity {
  private speaking = 0;
  private fast = 0;
  private slow = 0;
  private silentMs = Number.POSITIVE_INFINITY;
  private voicedMs = 0;

  constructor(private readonly options: Pick<ExpressionOptions, 'openThreshold' | 'phrasePauseMs' | 'phraseEndMs' | 'phraseMinSpeechMs'> = DEFAULT_EXPRESSION) {}

  update(open: number, dtMs: number): SpeechFeatures {
    const active = open > this.options.openThreshold;
    const phraseStart = active && this.silentMs >= this.options.phrasePauseMs;
    const previousSilentMs = this.silentMs;
    this.silentMs = active ? 0 : this.silentMs + dtMs;
    // 短い閉じ（子音）は同じ句の中の発声として数え続ける。
    if (active) this.voicedMs += dtMs;
    const phraseEnd = !active && previousSilentMs < this.options.phraseEndMs && this.silentMs >= this.options.phraseEndMs && this.voicedMs >= this.options.phraseMinSpeechMs;
    if (!active && this.silentMs >= this.options.phraseEndMs) this.voicedMs = 0;
    this.speaking = smoothAsymmetric(this.speaking, active || this.silentMs < 300 ? 1 : 0, dtMs, 150, 700);
    this.fast = smoothAsymmetric(this.fast, open, dtMs, 50, 120);
    this.slow = smoothAsymmetric(this.slow, open, dtMs, 450, 450);
    return { speaking: this.speaking, emphasis: clamp01((this.fast - this.slow) / 0.3), phraseStart, phraseEnd };
  }
}

export class ExpressionLayer implements AvatarLayer {
  readonly name = 'expression';
  private readonly options: ExpressionOptions;
  private readonly activity: SpeechActivity;
  private readonly browNoise: SmoothNoise;
  private readonly speechNoise: SmoothNoise[];
  private browPulseMs = Number.POSITIVE_INFINITY;
  private nod = 0;
  private phraseNodMs = Number.POSITIVE_INFINITY;
  features: SpeechFeatures = { speaking: 0, emphasis: 0, phraseStart: false, phraseEnd: false };
  /** 0〜1。H2 などで表情を止めたいときに下げる。 */
  intensity = 1;

  constructor(
    private readonly rng: Rng,
    /** 直前のフレームの口の開き（0〜1）。 */
    private readonly mouthOpen: () => number,
    options: Partial<ExpressionOptions> = {},
  ) {
    this.options = { ...DEFAULT_EXPRESSION, ...options };
    this.activity = new SpeechActivity(this.options);
    this.browNoise = new SmoothNoise(rng, this.options.browNoiseSpanMs);
    this.speechNoise = [0, 1, 2].map(() => new SmoothNoise(rng, this.options.speechNoiseSpanMs));
  }

  update(context: LayerContext, frame: PoseFrame): void {
    const o = this.options;
    const dt = context.dtMs;
    const f = this.activity.update(this.mouthOpen(), dt);
    this.features = f;
    const k = clamp01(this.intensity);

    if (f.phraseStart && this.rng() < o.phraseBrowProbability) this.browPulseMs = 0;
    this.browPulseMs += dt;
    const pulse = this.browPulseMs < o.phraseBrowMs ? Math.sin(Math.PI * (this.browPulseMs / o.phraseBrowMs)) : 0;
    const brow = Math.max(0, this.browNoise.update(dt)) * o.browNoise + pulse * o.phraseBrowRaise + f.emphasis * f.speaking * o.emphasisBrow;
    frame.addExpression('browUp', clamp01(brow) * k);

    const relaxed = o.relaxedIdle + (o.relaxedSpeaking - o.relaxedIdle) * f.speaking;
    frame.addExpression('relaxed', relaxed * k);

    this.nod = smoothAsymmetric(this.nod, f.emphasis * f.speaking, dt, 90, 260);
    if (f.phraseEnd && this.rng() < o.phraseNodProbability) this.phraseNodMs = 0;
    this.phraseNodMs += dt;
    const phraseNod = this.phraseNodMs < o.phraseNodMs ? Math.sin(Math.PI * (this.phraseNodMs / o.phraseNodMs)) * o.phraseNodDeg * k : 0;
    const [yawNoise, rollNoise, pitchNoise] = this.speechNoise.map((n) => n.update(dt)) as [number, number, number];
    const s = f.speaking * k;
    frame.addBone(
      'head',
      (this.nod * o.nodDeg * k + phraseNod + pitchNoise * o.speechPitchDeg * s) * DEG2RAD,
      yawNoise * o.speechYawDeg * s * DEG2RAD,
      rollNoise * o.speechRollDeg * s * DEG2RAD,
    );
  }
}
