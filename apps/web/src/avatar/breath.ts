/**
 * 呼吸（レーン H2、計画 §4.7）。通常呼吸と発話希望の準備吸気を別のパラメータで持つ。
 *
 * 準備吸気は「1回の吸気 → 短い保持（息を止めた準備姿勢）→ 発話 または 引き下がり」で完結し、ループしない（§4.6）。
 * 吸気の後の終わり方は3通りで、時系列を分ける（文献の確認は docs/breath_evidence.md。根拠の無い値は暫定）:
 *  - speech_started（成功）: 吸気の直後に声を出し、胸は話しながらゆっくり戻る。口の準備はすぐ口形へ譲る。
 *      根拠: 成功した turn の大半は吸気の直後に始まり、呼気の始めで声が出る（Rochet-Capellan & Fuchs 2014）。
 *            吸気の後に保持を挟んで話す経路には、文献の根拠がない。
 *  - deferred（人が話し続けて引き下がる。後で許可が出れば話すことがある）: 息を止めた後、声を出さずに静かに吐く。
 *      唇はわずかに開いたまま、胸と頭は少しだけ準備を残し、ゆっくり消える。
 *      参考: 発声しない吸気の後の息止め（約 500ms、図 8 の 1 例）を、著者は断念した発話の候補と解釈している
 *            （Włodarczak & Heldner 2020）。唇の形は暫定で、話さずに引き下がった場合の文献は確認できていない。
 *  - withdrawn（申し出をやめる）: 準備を残さず、口を閉じ、少し速めに戻る。
 *      参考: 声を出して割り込めなかった試みは1呼吸周期で終わり、周期は成功時より短い。著者は聞き手の役割へ
 *            早く戻ると解釈している（Rochet-Capellan & Fuchs 2014）。無声の取りやめは対象外で、速さの値は暫定。
 * deferred の後に許可が出たら prepareShort() で再吸気せずに短い準備動作だけを行う（計画 §4.6）。
 *
 * 五つの局面（吸気 → 発話待機（保持）→ 発声／延期 → 再度の発声（短い準備）／撤回）は別々の動きではなく一つの流れ:
 *  - どの局面への移りも「今の姿勢」から始める（from は描いている値、途中の局面の値を捨てない）。
 *  - 局面の境目で速さが飛ばないよう、直前の動きを短く引き継ぐ（CONTINUITY_MS。戻り先の包絡は変えない）。
 *  - 通常呼吸の胸は吸気の開始で準備の値へ引き取る（1本の胸の動きにする。吸気の始めに胸が一度へこまない）。
 *  - 発話の口形へ譲るのは滑らかに（mouthYield）。部位を別々に切らない。
 *  どの局面でも、何も来なくても終わりがあり（吸気 → 保持の上限 → deferred の形で脱力 → idle、発話の戻りも有限）、
 *  聞き手の姿勢へ戻る。発話の失敗（音声が来ない、途中で止まる）は release('withdrawn') で発話の戻りの途中からでも戻す。
 *
 * 胸郭は読み込み時に作る専用モーフを中心に、上胸の小さな反り、肩・鎖骨の小さな挙上（上腕で逆補正）、首・頭の微小な姿勢、
 * 口のわずかな開き、眉を時系列でずらして重ねる。視線は既定では触らない（吸気の効果と分離）。吸気音は session/breath_sound.ts。
 *
 * three と VRM に依存しない。書く名前は output で差し替える。時刻は update の dt を積んだ内部時刻で、
 * startInhale／release／prepareShort は次のフレームから効く。deferred／withdrawn の脱力の途中に来た吸気は今の姿勢から受ける。
 */
import type { AvatarLayer, LayerContext, PoseFrame } from './pose';
import { clamp, clamp01, DEG2RAD, smoothAsymmetric, smoothstep, type Rng } from './util';

// ---- 固定のインターフェース（participant 画面が呼ぶ。既存の4つの形は変えない） ----

export interface InhaleCue {
  cue_id: string;
  /** 吸気そのものの長さ（ms）。保持と脱力は含まない。 */
  duration_ms: number;
}
export type BreathPhase = 'idle' | 'inhale' | 'hold' | 'release';
export type ReleaseReason = 'speech_started' | 'deferred' | 'withdrawn';
export interface BreathController {
  /**
   * 1回の準備吸気 → 保持（準備姿勢）。受け付けたら true、無視したら false（描いていないことを呼び手が報告できるように）。
   * 受け付けるのは idle と、脱力の途中（今の姿勢から滑らかに吸う）。吸気中と保持中、開始待ち、発話中の戻りでは無視する。
   */
  startInhale(cue: InhaleCue): boolean;
  /**
   * speech_started: 保持から発話へ（息を使い始める）／deferred: 声を出さずに吐いて引き下がる（準備を少し残す）／withdrawn: 準備を残さず聞き手へ戻る。
   * withdrawn は発話の戻りの途中でも受ける（発声の失敗: 音声が来ない、途中で止まる）。無理に声を出さない。
   * 実際に姿勢を変えたら true、変えるものがなければ false（idle、同じ戻りの途中、まだ描いていない吸気の取り消し）。
   */
  release(reason: ReleaseReason): boolean;
  phase(): BreathPhase;
  /**
   * 追加（H2 第2版）: deferred の後に許可が出て話すときの短い準備動作（再吸気しない、計画 §4.6）。
   * 口を開き、胸を少しだけ足して保持へ入る。続けて release('speech_started') を呼ぶ。
   * 受け付けるのは idle と、deferred（保持の上限による自動の引き下がりを含む）の脱力の途中だけ。他では無視する。
   * 省略可能なメソッドにしてある（既存の実装を壊さないため）。
   */
  prepareShort?(durationMs?: number): void;
}

/** 吸気の長さの既定。Torreira et al. (2015) の答えの前の吸気の中央値 0.72s（平均 0.887s）に寄せた。 */
export const DEFAULT_INHALE_MS = 700;
/**
 * 保持の安全上限（暫定）。引き下がりの判断は orchestrator の hold_max_ms（人が話し続けたら deferred）が行う。
 * 人が黙っていて許可を待つ間（start_guard の待ちは最長 1500ms）は脱力させないよう、それより長くしてある。
 * orchestrator から解除が来ないときだけ、過ぎたら deferred と同じ形で引き下がる。
 */
export const HOLD_MAX_MS = 1800;
/** cue.duration_ms の受け付ける範囲。外れたら丸める。下限は Torreira et al. (2015) の標本の最小 210ms を丸めた。上限 1400 は出典がなく暫定。 */
export const INHALE_MS_RANGE: readonly [number, number] = [200, 1400];

/** 発話の口が開いているとみなす下限（前フレームの speechOpen）。話している間は口の準備を譲り、吸気も受けない。 */
const SPEECH_OPEN_THRESHOLD = 0.04;

/** 胸郭モーフを表情として登録する名前（runtime.ts が登録する）。 */
export const BREATH_CHEST_EXPRESSION = 'breathChest';

// ---- パラメータ ----

/** 通常呼吸（待機中の微弱な呼吸）。準備吸気とは別。 */
export interface NormalBreathParams {
  /** 胸郭モーフの重み（0〜1）。 */
  depth: number;
  periodMs: number;
  /** 周期の揺らぎ（割合）。 */
  periodJitter: number;
  /** 1周期のうち吸う割合。 */
  inhaleFraction: number;
  /** 頭の上下（度、負が上）。 */
  headPitchDeg: number;
  /** 肩の挙上（度）。待機の肩の挙上は吸気と紛らわしいので既定 0。 */
  shoulderDeg: number;
}

/** 準備吸気。深さ、速度（cue の長さ）、保持、頭部姿勢、終わり方ごとの時系列を連続値で持つ。 */
export interface PrepBreathParams {
  /** 胸郭モーフの重み（0〜1）。 */
  depth: number;
  /** 上胸の反り（度、負が後ろ＝胸が上がる）。首で一部を戻す。 */
  chestPitchDeg: number;
  neckCompensation: number;
  /** 上胸の反りを上腕で戻す割合（1 で腕は垂れたまま、手が前後に振れない）。 */
  armPitchCompensation: number;
  /** 肩・鎖骨の挙上（度）。上腕で armCompensation の割合だけ戻し、腕の向きを保つ。 */
  shoulderDeg: number;
  armCompensation: number;
  /** 頭の上下（度、負が上＝顎がわずかに上がる）。 */
  headPitchDeg: number;
  /** 口のわずかな開き（aa の重み）。 */
  mouthOpen: number;
  /** 眉のわずかな上げ（browUp の重み）。 */
  brow: number;
  /** 保持の上限（ms）。 */
  holdMaxMs: number;
  /** 保持中の胸（頂点に対する割合）。息を止めているので頂点の近くに保つ。 */
  holdChestLevel: number;
  holdMouthLevel: number;
  holdBrowLevel: number;

  /** 成功: 発話開始後に胸が戻る長さ（話しながら息を使う、ms）。 */
  speechExhaleMs: number;
  /** 成功: 口の準備を口形へ譲る速さ（ms）。 */
  speechMouthYieldMs: number;

  /** deferred: 声を出さずに吐く長さ（胸、ms）。他の部位はこれに比例。 */
  deferredExhaleMs: number;
  /** deferred: 吐いた後に残す準備（頂点に対する割合）。胸、唇、頭。 */
  deferredChestResidual: number;
  deferredMouthResidual: number;
  deferredHeadResidual: number;
  /** deferred: 残した準備が消えるまでの長さ（ms）。この間に prepareShort を受ける。 */
  deferredLingerMs: number;

  /** withdrawn: 戻る長さ（胸、ms）。他の部位はこれに比例。 */
  withdrawnExhaleMs: number;
  /** withdrawn: 口を閉じる速さ（ms）。 */
  withdrawnMouthCloseMs: number;

  /** 短い準備動作（prepareShort）の長さ（ms）。250 は暫定（Hamlet et al. 1978 の静止点から音までの約 250ms は間隔で、動作の長さの根拠ではない）。 */
  shortPrepMs: number;
  /** 短い準備動作の目標（頂点に対する割合）。今の値より小さければ今の値を保つ。 */
  shortChest: number;
  shortMouth: number;
  shortHead: number;
  shortShoulder: number;
  shortBrow: number;

  /** 脱力の後、待機の揺れと通常呼吸を戻すまでの間（ms）。 */
  postSuppressMs: number;
  /** 吸気の間の待機の揺れの倍率（0〜1）。 */
  idleDuringPrep: number;
  /** 待機の揺れを抑えるときの時定数（ms）。吸気に重ねて小さくし、頭が一度に戻らないようにする。 */
  idleSuppressMs: number;
  /** 視線を吸気に合わせて相手へ向けるか（既定 false: 視線は吸気の効果と分離）。 */
  gazeToUser: boolean;
}

export interface BreathParams {
  normal: NormalBreathParams;
  prep: PrepBreathParams;
}

export const DEFAULT_NORMAL_BREATH: NormalBreathParams = {
  // 胸郭モーフの変位を 1.19 倍にしたぶん下げ、通常呼吸の見た目の大きさは保つ。
  depth: 0.185,
  periodMs: 4200,
  periodJitter: 0.15,
  inhaleFraction: 0.4,
  headPitchDeg: -0.15,
  shoulderDeg: 0,
};

// 吸気の大きさは、合図として見えやすいよう実際の吸気より誇張している（利用者の指定。暫定で未校正）。
export const DEFAULT_PREP_BREATH: PrepBreathParams = {
  depth: 1,
  chestPitchDeg: -2.15,
  neckCompensation: 0.5,
  armPitchCompensation: 1,
  shoulderDeg: 4.4,
  armCompensation: 1,
  headPitchDeg: -1.9,
  mouthOpen: 0.145,
  brow: 0.24,
  holdMaxMs: HOLD_MAX_MS,
  holdChestLevel: 0.96,
  holdMouthLevel: 0.85,
  holdBrowLevel: 0.5,
  speechExhaleMs: 2200,
  speechMouthYieldMs: 70,
  deferredExhaleMs: 1300,
  deferredChestResidual: 0.2,
  deferredMouthResidual: 0.4,
  deferredHeadResidual: 0.3,
  deferredLingerMs: 2500,
  withdrawnExhaleMs: 750,
  withdrawnMouthCloseMs: 150,
  shortPrepMs: 250,
  shortChest: 0.4,
  shortMouth: 1,
  shortHead: 0.6,
  shortShoulder: 0.2,
  shortBrow: 0.3,
  postSuppressMs: 700,
  idleDuringPrep: 0.25,
  idleSuppressMs: 200,
  gazeToUser: false,
};

export const DEFAULT_BREATH: BreathParams = { normal: DEFAULT_NORMAL_BREATH, prep: DEFAULT_PREP_BREATH };

// ---- 時系列の包絡（純粋関数） ----

export type BreathChannel = 'chest' | 'shoulder' | 'head' | 'mouth' | 'brow';
export const BREATH_CHANNELS: readonly BreathChannel[] = ['chest', 'shoulder', 'head', 'mouth', 'brow'];
export type ChannelValues = Record<BreathChannel, number>;

export const ZERO_CHANNELS: Readonly<ChannelValues> = { chest: 0, shoulder: 0, head: 0, mouth: 0, brow: 0 };
export const FULL_CHANNELS: Readonly<ChannelValues> = { chest: 1, shoulder: 1, head: 1, mouth: 1, brow: 1 };

/**
 * 部位ごとの吸気の時間配分（吸気の長さに対する割合）。口が先に少し開き、胸と頭が続き、肩はわずかに遅れて頂点に着く。
 * 順序の根拠は未確認（暫定）。
 */
export const INHALE_TIMING: Record<BreathChannel, { delay: number; span: number }> = {
  mouth: { delay: 0, span: 0.55 },
  chest: { delay: 0.05, span: 0.95 },
  head: { delay: 0.05, span: 1.05 },
  shoulder: { delay: 0.15, span: 1.0 },
  brow: { delay: 0.1, span: 0.8 },
};

/** 引き下がり（deferred）と取りやめ（withdrawn）の部位ごとの長さ（胸の長さに対する割合）。暫定。 */
export const RELAX_TIMING: Record<BreathChannel, number> = { chest: 1, shoulder: 0.55, head: 0.65, mouth: 0.3, brow: 0.4 };

/**
 * 局面の境目で直前の動きを引き継ぐ長さ（ms、部位ごと）。暫定（根拠なし）。
 * 値の連続は from を今の姿勢にすることで保証し、これは速さの連続のためのもの。口は短い（発話の口形へ譲る）。
 */
export const CONTINUITY_MS: Record<BreathChannel, number> = { chest: 220, shoulder: 200, head: 200, brow: 160, mouth: 70 };

/** 境目の後に足す量。v0 は境目の直前の速さ（/ms）。t=0 で値 0・速さ v0、T で値も速さも 0。 */
export function continuityCarry(v0: number, tMs: number, blendMs: number): number {
  if (tMs <= 0 || tMs >= blendMs || blendMs <= 0) return 0;
  const left = 1 - tMs / blendMs;
  return v0 * tMs * left * left * left;
}

/** 発話開始後の長さ（ms）。口は speechMouthYieldMs、胸は speechExhaleMs。暫定。 */
export const SPEECH_TIMING_MS: Record<Exclude<BreathChannel, 'chest' | 'mouth'>, number> = { shoulder: 350, head: 450, brow: 300 };

/**
 * 吸気の速度曲線（0〜1 → 0〜1）。速く吸い始め、頂点へ減速して着く（速さの山が前寄り）。
 * 始まりは 0 の速さから立ち上げ、切り替えに見えないようにする。
 */
export function inhaleCurve(u: number): number {
  const x = clamp01(u);
  const easeOut = 1 - Math.pow(1 - x, 3);
  return easeOut * smoothstep(x / 0.25);
}

/** 静かな呼気（1 → 0）。両端の速さが 0。 */
export function relaxCurve(u: number): number {
  return 1 - smoothstep(u);
}

/** 発話中の呼気（1 → 0）。話し始めから息を使い、中ほどで最も速く、終わりは滑らかに着く。 */
export function speechExhaleCurve(u: number): number {
  const x = clamp01(u);
  return 1 - (x - Math.sin(2 * Math.PI * x) / (2 * Math.PI));
}

/**
 * 吸気開始から t ms の部位の値（0〜1、頂点が 1）。from から target へ吸い、保持中は息を止めた姿勢で少しだけ沈む。
 * 準備吸気は from=0、target=1。短い準備動作（prepareShort）は from=今の値。
 */
export function prepValues(
  tMs: number,
  inhaleMs: number,
  prep: PrepBreathParams,
  from: Readonly<ChannelValues> = ZERO_CHANNELS,
  target: Readonly<ChannelValues> = FULL_CHANNELS,
): ChannelValues {
  const out = { ...ZERO_CHANNELS };
  for (const channel of BREATH_CHANNELS) {
    const timing = INHALE_TIMING[channel];
    const u = (tMs - timing.delay * inhaleMs) / (timing.span * inhaleMs);
    out[channel] = from[channel] + (target[channel] - from[channel]) * inhaleCurve(u);
  }
  const sinceHold = Math.max(0, tMs - inhaleMs);
  if (sinceHold > 0) {
    const settle = 1 - Math.exp(-sinceHold / 400);
    out.chest *= 1 - (1 - prep.holdChestLevel) * settle;
    out.mouth *= 1 - (1 - prep.holdMouthLevel) * settle;
    out.brow *= 1 - (1 - prep.holdBrowLevel) * settle;
  }
  return out;
}

export type ReleaseKind = 'speech' | 'deferred' | 'withdrawn';

export interface ReleaseSpec {
  /** 部位ごとの主な戻りの長さ（ms）。 */
  durations: ChannelValues;
  /** 主な戻りの後に残す割合（開始値に対する）。 */
  residual: ChannelValues;
  /** 残した分が消えるまでの長さ（ms）。 */
  lingerMs: number;
}

/** 終わり方ごとの時系列。 */
export function releaseSpec(kind: ReleaseKind, prep: PrepBreathParams): ReleaseSpec {
  if (kind === 'speech') {
    return {
      durations: {
        chest: prep.speechExhaleMs,
        mouth: prep.speechMouthYieldMs,
        shoulder: SPEECH_TIMING_MS.shoulder,
        head: SPEECH_TIMING_MS.head,
        brow: SPEECH_TIMING_MS.brow,
      },
      residual: { ...ZERO_CHANNELS },
      lingerMs: 0,
    };
  }
  const base = kind === 'deferred' ? prep.deferredExhaleMs : prep.withdrawnExhaleMs;
  const durations = { ...ZERO_CHANNELS };
  for (const channel of BREATH_CHANNELS) durations[channel] = base * RELAX_TIMING[channel];
  if (kind === 'withdrawn') {
    durations.mouth = prep.withdrawnMouthCloseMs;
    return { durations, residual: { ...ZERO_CHANNELS }, lingerMs: 0 };
  }
  return {
    durations,
    residual: { chest: prep.deferredChestResidual, mouth: prep.deferredMouthResidual, head: prep.deferredHeadResidual, shoulder: 0, brow: 0 },
    lingerMs: prep.deferredLingerMs,
  };
}

/** 終わり方の全体の長さ（ms）。 */
export function releaseTotalMs(spec: ReleaseSpec): number {
  return Math.max(...BREATH_CHANNELS.map((c) => spec.durations[c] + (spec.residual[c] > 0 ? spec.lingerMs : 0)));
}

/** 戻りの開始値 from から t ms の値。 */
export function releaseValues(tMs: number, from: Readonly<ChannelValues>, spec: ReleaseSpec, kind: ReleaseKind): ChannelValues {
  const out = { ...ZERO_CHANNELS };
  for (const channel of BREATH_CHANNELS) {
    const duration = spec.durations[channel];
    const r = clamp01(spec.residual[channel]);
    if (tMs < duration) {
      const u = duration <= 0 ? 1 : tMs / duration;
      const curve = kind === 'speech' && channel === 'chest' ? speechExhaleCurve(u) : relaxCurve(u);
      out[channel] = from[channel] * (r + (1 - r) * curve);
    } else if (r > 0 && spec.lingerMs > 0) {
      out[channel] = from[channel] * r * relaxCurve((tMs - duration) / spec.lingerMs);
    }
  }
  return out;
}

/** 通常呼吸の波（0〜1）。周期内の位置 phase01 で、吸気は inhaleFraction の間。 */
export function normalBreathWave(phase01: number, inhaleFraction: number): number {
  const p = phase01 - Math.floor(phase01);
  const f = clamp(inhaleFraction, 0.1, 0.9);
  if (p < f) return 0.5 - 0.5 * Math.cos((Math.PI * p) / f);
  return 0.5 + 0.5 * Math.cos((Math.PI * (p - f)) / (1 - f));
}

// ---- 層と制御 ----

export type ReleaseCause = ReleaseReason | 'hold_timeout';
/** 吸気の種類。prep は準備吸気（startInhale）、short は短い準備動作（prepareShort）。 */
export type InhaleKind = 'prep' | 'short';

export interface BreathPhaseEvent {
  phase: BreathPhase;
  /** 遷移の起きたフレームの rAF 時刻（ms）。startInhale の場合は吸気が最初に描かれるフレーム。 */
  nowMs: number;
  cueId: string | null;
  cause: ReleaseCause | null;
  /** inhale／hold の種類。release／idle では直前の種類。 */
  kind: InhaleKind | null;
}

export interface BreathTelemetry {
  phase: BreathPhase;
  cueId: string | null;
  inhaleMs: number;
  kind: InhaleKind | null;
  /** 直近の脱力の理由。保持の上限による自動の引き下がりは 'hold_timeout'。 */
  lastReleaseCause: ReleaseCause | null;
  releaseKind: ReleaseKind | null;
  /** 準備吸気の部位の値（0〜1）。 */
  prep: ChannelValues;
  /** 胸郭モーフへ書いた重みの合計。 */
  chestWeight: number;
  normalGain: number;
  /** 待機の揺れへ掛けている倍率。 */
  idleScale: number;
  ignoredStarts: number;
}

/**
 * 層が書く名前。層は VRM を知らない: 表情の名前と骨の名前はここで差し替えられる。
 * 既定は VRM の表情名（aa、browUp）とヒューマノイドの骨名。ARKit の blendshape なら mouthOpen を 'jawOpen'、brow を 'browInnerUp' などにする（未試験）。
 * 骨の回転は pose.ts の規約（VRM 1.0 の向き）で書く。モデルの軸への変換は適用側（runtime.ts）。
 */
export interface BreathOutputNames {
  /** 胸郭モーフを表す表情（重み 0〜1）。 */
  chestMorph: string;
  mouthOpen: string;
  brow: string;
  /** 胸を反らせる骨（上胸、無ければ胸）。 */
  chest: string;
  neck: string;
  head: string;
  leftShoulder: string;
  rightShoulder: string;
  leftUpperArm: string;
  rightUpperArm: string;
}

export const DEFAULT_BREATH_OUTPUT: BreathOutputNames = {
  chestMorph: BREATH_CHEST_EXPRESSION,
  mouthOpen: 'aa',
  brow: 'browUp',
  chest: 'upperChest',
  neck: 'neck',
  head: 'head',
  leftShoulder: 'leftShoulder',
  rightShoulder: 'rightShoulder',
  leftUpperArm: 'leftUpperArm',
  rightUpperArm: 'rightUpperArm',
};

export interface BreathLayerOptions {
  params?: BreathParams;
  /** 書く名前の上書き（既定は DEFAULT_BREATH_OUTPUT）。 */
  output?: Partial<BreathOutputNames>;
  /** 前のフレームの発話の口の開き（0〜1）。開いていれば口の準備を譲る。 */
  speechOpen?: () => number;
  /** 待機の揺れの抑制を受け取る（IdleLayer.suppression を書く）。 */
  setIdleScale?: (scale: number) => void;
  onPhase?: (event: BreathPhaseEvent) => void;
}

interface PendingStart {
  kind: InhaleKind;
  cueId: string | null;
  durationMs: number;
}

export class BreathLayer implements AvatarLayer, BreathController {
  readonly name = 'breath';
  params: BreathParams;
  readonly output: BreathOutputNames;
  onPhase: ((event: BreathPhaseEvent) => void) | undefined;
  private readonly speechOpen: () => number;
  private readonly setIdleScale: (scale: number) => void;

  private current: BreathPhase = 'idle';
  private timeMs = 0;
  private lastNowMs = 0;
  private phaseStartMs = 0;
  private cueId: string | null = null;
  private kind: InhaleKind | null = null;
  private inhaleMs = DEFAULT_INHALE_MS;
  private inhaleFrom: ChannelValues = { ...ZERO_CHANNELS };
  private inhaleTarget: ChannelValues = { ...FULL_CHANNELS };
  /** 次のフレームで始める（startInhale／prepareShort は描画の外から呼ばれる）。 */
  private pendingStart: PendingStart | null = null;
  private pendingRelease: ReleaseCause | null = null;
  private releaseKind: ReleaseKind | null = null;
  private releaseFrom: ChannelValues = { ...ZERO_CHANNELS };
  private spec: ReleaseSpec = releaseSpec('withdrawn', DEFAULT_PREP_BREATH);
  private lastCause: ReleaseCause | null = null;
  private idleSinceMs = Number.NEGATIVE_INFINITY;
  private values: ChannelValues = { ...ZERO_CHANNELS };
  private normalGain = 1;
  private idleScale = 1;
  /** 前のフレームの部位の値の速さ（/ms）。局面の境目の引き継ぎに使う。 */
  private velocity: ChannelValues = { ...ZERO_CHANNELS };
  /** 境目で引き継いだ速さと、その起点の内部時刻。 */
  private carryVelocity: ChannelValues = { ...ZERO_CHANNELS };
  private carryStartMs = Number.NEGATIVE_INFINITY;
  /** 発話の口形へ譲る度合い（0〜1）。口形が開いたら滑らかに上げ、準備の口を消す。 */
  private mouthYield = 0;
  private normalPhase = 0;
  private normalPeriodMs: number;
  private chestWeight = 0;
  private ignored = 0;

  constructor(
    private readonly rng: Rng,
    options: BreathLayerOptions = {},
  ) {
    this.params = options.params ?? DEFAULT_BREATH;
    this.output = { ...DEFAULT_BREATH_OUTPUT, ...options.output };
    this.speechOpen = options.speechOpen ?? (() => 0);
    this.setIdleScale = options.setIdleScale ?? (() => {});
    this.onPhase = options.onPhase;
    this.normalPhase = rng();
    this.normalPeriodMs = this.nextPeriod();
  }

  phase(): BreathPhase {
    if (this.pendingStart) return 'inhale';
    return this.current;
  }

  startInhale(cue: InhaleCue): boolean {
    // 1回で完結: 吸気中、保持中、開始待ちでは二重に吸わない。
    // 脱力の途中は受ける（今の姿勢から吸い直す）。ただし発話の戻りで口が動いている間（＝話している）は受けない。
    // 話し終えた後の発話の戻り（胸がまだ下がっている途中）は口が閉じていて、ここで受ける。
    const relaxing = this.current === 'release' && (this.releaseKind !== 'speech' || this.speechOpen() <= SPEECH_OPEN_THRESHOLD);
    if (this.pendingStart || !(this.current === 'idle' || relaxing)) {
      this.ignored += 1;
      return false;
    }
    this.pendingStart = { kind: 'prep', cueId: cue.cue_id, durationMs: cue.duration_ms };
    this.pendingRelease = null;
    return true;
  }

  prepareShort(durationMs?: number): void {
    const deferredRelease = this.current === 'release' && this.releaseKind === 'deferred';
    if (this.pendingStart || !(this.current === 'idle' || deferredRelease)) {
      this.ignored += 1;
      return;
    }
    this.pendingStart = { kind: 'short', cueId: this.cueId, durationMs: durationMs ?? this.params.prep.shortPrepMs };
    this.pendingRelease = null;
  }

  release(reason: ReleaseReason): boolean {
    if (this.pendingStart) {
      // まだ描いていない動作は取り消す（何も見せていない）。
      this.pendingStart = null;
      this.lastCause = reason;
      return false;
    }
    if (this.current === 'idle') return false;
    if (this.current === 'release') {
      // 引き下がりの途中で発話が始まったら、発話の戻り方へ切り替える（口を口形へ譲る）。
      // deferred の途中の withdrawn は、残した準備を捨てて戻る。
      // 発話の戻りの途中の withdrawn は発声の失敗。胸を速く戻す。
      if ((reason === 'speech_started' && this.releaseKind !== 'speech') || (reason === 'withdrawn' && this.releaseKind !== 'withdrawn')) {
        this.pendingRelease = reason;
        return true;
      }
      return false;
    }
    this.pendingRelease = reason;
    return true;
  }

  telemetry(): BreathTelemetry {
    return {
      phase: this.phase(),
      cueId: this.cueId ?? this.pendingStart?.cueId ?? null,
      inhaleMs: this.inhaleMs,
      kind: this.kind,
      lastReleaseCause: this.lastCause,
      releaseKind: this.releaseKind,
      prep: { ...this.values },
      chestWeight: this.chestWeight,
      normalGain: this.normalGain,
      idleScale: this.idleScale,
      ignoredStarts: this.ignored,
    };
  }

  private nextPeriod(): number {
    const n = this.params.normal;
    return n.periodMs * (1 + (this.rng() * 2 - 1) * n.periodJitter);
  }

  /**
   * 準備吸気の開始値。通常呼吸の胸（と頭、肩）を準備の値へ引き取って通常呼吸は消す（1本の動きにする）。
   * 通常呼吸の山で吸い始めても、胸が一度へこまない。
   */
  private withNormalHandOff(): ChannelValues {
    const { normal, prep } = this.params;
    const wave = normalBreathWave(this.normalPhase, normal.inhaleFraction) * this.normalGain;
    const from: ChannelValues = { ...this.values };
    const transfer = (channel: BreathChannel, normalValue: number, prepValue: number) => {
      if (prepValue !== 0) from[channel] = clamp01(from[channel] + (wave * normalValue) / prepValue);
    };
    transfer('chest', normal.depth, prep.depth);
    transfer('head', normal.headPitchDeg, prep.headPitchDeg);
    transfer('shoulder', normal.shoulderDeg, prep.shoulderDeg);
    this.normalGain = 0;
    return from;
  }

  private enter(phase: BreathPhase, cause: ReleaseCause | null = null): void {
    this.current = phase;
    this.phaseStartMs = this.timeMs;
    this.onPhase?.({ phase, nowMs: this.lastNowMs, cueId: this.cueId, cause, kind: this.kind });
  }

  /** 局面の境目: 今の速さを引き継ぐ（startMs は次の値を描く基準の時刻）。 */
  private armContinuity(startMs: number): void {
    this.carryVelocity = { ...this.velocity };
    this.carryStartMs = startMs;
  }

  private beginRelease(cause: ReleaseCause): void {
    const kind: ReleaseKind = cause === 'speech_started' ? 'speech' : cause === 'withdrawn' ? 'withdrawn' : 'deferred';
    this.releaseKind = kind;
    this.releaseFrom = { ...this.values };
    this.spec = releaseSpec(kind, this.params.prep);
    this.lastCause = cause;
    this.enter('release', cause);
  }

  update(context: LayerContext, frame: PoseFrame): void {
    const { dtMs } = context;
    const dt = Math.max(dtMs, 0);
    this.timeMs += dt;
    this.lastNowMs = context.nowMs;
    const prep = this.params.prep;
    let previous: Readonly<ChannelValues> = { ...this.values };

    if (this.pendingStart) {
      const start = this.pendingStart;
      this.pendingStart = null;
      this.kind = start.kind;
      this.cueId = start.cueId;
      const requested = Number.isFinite(start.durationMs) ? start.durationMs : DEFAULT_INHALE_MS;
      if (start.kind === 'prep') {
        this.inhaleMs = clamp(requested, INHALE_MS_RANGE[0], INHALE_MS_RANGE[1]);
        // 脱力の途中で受けたときは今の姿勢から吸う（idle は全部 0 なので同じ）。不連続にしない。
        this.inhaleFrom = this.withNormalHandOff();
        this.inhaleTarget = { ...FULL_CHANNELS };
      } else {
        this.inhaleMs = clamp(requested, 80, 800);
        // 再吸気しない: 今の値（引き下がりで残した準備）から、短い準備の目標まで。今の値の方が大きければ保つ。
        this.inhaleFrom = this.withNormalHandOff();
        const goal: ChannelValues = { chest: prep.shortChest, mouth: prep.shortMouth, head: prep.shortHead, shoulder: prep.shortShoulder, brow: prep.shortBrow };
        this.inhaleTarget = { ...ZERO_CHANNELS };
        for (const c of BREATH_CHANNELS) this.inhaleTarget[c] = Math.max(goal[c], this.inhaleFrom[c]);
      }
      // 通常呼吸の分は開始値へ引き取っただけで、描いている値は変わっていない（速さを数えない）。
      previous = { ...this.inhaleFrom };
      this.releaseKind = null;
      this.lastCause = null;
      this.enter('inhale');
      // このフレームの dt を吸気の最初の一歩にする（このフレームの rAF 時刻が signal.started_at の元）。
      this.phaseStartMs = this.timeMs - dt;
      this.armContinuity(this.phaseStartMs);
    }
    if (this.pendingRelease && this.current !== 'idle') {
      const cause = this.pendingRelease;
      this.pendingRelease = null;
      this.beginRelease(cause);
      // 戻りもこのフレームから動き始める（1フレーム止まって見えないように）。
      this.phaseStartMs = this.timeMs - dt;
      this.armContinuity(this.phaseStartMs);
    }

    const t = this.timeMs - this.phaseStartMs;
    switch (this.current) {
      case 'inhale':
      case 'hold': {
        // 吸気と保持は吸気開始からの1本の時間で描く（phaseStartMs は吸気の開始）。
        this.values = prepValues(t, this.inhaleMs, prep, this.inhaleFrom, this.inhaleTarget);
        if (this.current === 'inhale' && t >= this.inhaleMs) {
          const start = this.phaseStartMs;
          this.enter('hold');
          this.phaseStartMs = start;
        }
        if (this.current === 'hold' && t - this.inhaleMs >= prep.holdMaxMs) {
          this.beginRelease('hold_timeout');
          this.armContinuity(this.timeMs);
        }
        break;
      }
      case 'release': {
        this.values = releaseValues(t, this.releaseFrom, this.spec, this.releaseKind ?? 'withdrawn');
        if (t >= releaseTotalMs(this.spec)) {
          this.values = { ...ZERO_CHANNELS };
          this.enter('idle', this.lastCause);
          this.cueId = null;
          this.idleSinceMs = this.timeMs;
        }
        break;
      }
      case 'idle':
        this.values = { ...ZERO_CHANNELS };
        break;
    }

    // 局面の境目の速さを短く引き継ぐ（値は from で連続、ここは速さの連続）。
    const sinceBoundary = this.timeMs - this.carryStartMs;
    for (const c of BREATH_CHANNELS) {
      const v = clamp01(this.values[c] + continuityCarry(this.carryVelocity[c], sinceBoundary, CONTINUITY_MS[c]));
      this.velocity[c] = dt > 0 ? (v - previous[c]) / dt : 0;
      this.values[c] = v;
    }

    // 発話の口形が開いたら口の準備を譲る（ぶつけない）。切らずに滑らかに。
    this.mouthYield = smoothAsymmetric(this.mouthYield, this.speechOpen() > SPEECH_OPEN_THRESHOLD ? 1 : 0, dtMs, 40, 120);

    // 待機の揺れと通常呼吸: 準備の間と戻った直後は抑え、ゆっくり戻す。
    const active = this.current !== 'idle';
    const recovering = !active && this.timeMs - this.idleSinceMs < prep.postSuppressMs;
    const suppressed = active || recovering;
    this.normalGain = smoothAsymmetric(this.normalGain, suppressed ? 0 : 1, dtMs, 1200, 80);
    this.idleScale = smoothAsymmetric(this.idleScale, suppressed ? prep.idleDuringPrep : 1, dtMs, 900, prep.idleSuppressMs);
    this.setIdleScale(this.idleScale);

    // 通常呼吸。
    const normal = this.params.normal;
    this.normalPhase += dtMs / this.normalPeriodMs;
    if (this.normalPhase >= 1) {
      this.normalPhase -= Math.floor(this.normalPhase);
      this.normalPeriodMs = this.nextPeriod();
    }
    const wave = normalBreathWave(this.normalPhase, normal.inhaleFraction) * this.normalGain;

    const v = this.values;
    const o = this.output;
    this.chestWeight = clamp01(wave * normal.depth + v.chest * prep.depth);
    frame.addExpression(o.chestMorph, this.chestWeight);
    const chestPitch = v.chest * prep.chestPitchDeg * DEG2RAD;
    if (chestPitch !== 0) {
      frame.addBone(o.chest, chestPitch, 0, 0);
      frame.addBone(o.neck, -chestPitch * prep.neckCompensation, 0, 0);
      frame.addBone(o.leftUpperArm, -chestPitch * prep.armPitchCompensation, 0, 0);
      frame.addBone(o.rightUpperArm, -chestPitch * prep.armPitchCompensation, 0, 0);
    }
    const headPitch = (v.head * prep.headPitchDeg + wave * normal.headPitchDeg) * DEG2RAD;
    if (headPitch !== 0) frame.addBone(o.head, headPitch, 0, 0);
    // 肩の挙上: 左肩は +z、右肩は -z で上がる（VRM 1.0 の規約、pose.ts）。上腕で戻して腕の向きを保つ。
    const shoulder = (v.shoulder * prep.shoulderDeg + wave * normal.shoulderDeg) * DEG2RAD;
    if (shoulder !== 0) {
      frame.addBone(o.leftShoulder, 0, 0, shoulder);
      frame.addBone(o.rightShoulder, 0, 0, -shoulder);
      frame.addBone(o.leftUpperArm, 0, 0, -shoulder * prep.armCompensation);
      frame.addBone(o.rightUpperArm, 0, 0, shoulder * prep.armCompensation);
    }
    const mouth = v.mouth * (1 - this.mouthYield) * prep.mouthOpen;
    if (mouth > 0) frame.addExpression(o.mouthOpen, mouth);
    if (v.brow > 0) frame.addExpression(o.brow, v.brow * prep.brow);
    if (prep.gazeToUser) {
      const g = Math.max(v.head, v.chest);
      frame.eye.yawDeg *= 1 - g;
      frame.eye.pitchDeg *= 1 - g;
      frame.eye.userWeight += (1 - frame.eye.userWeight) * g;
    }
  }
}

/** 部分的な上書きを既定へ重ねる（確認ページのスライダ用）。 */
export function mergeBreathParams(base: BreathParams, patch: { normal?: Partial<NormalBreathParams>; prep?: Partial<PrepBreathParams> }): BreathParams {
  return { normal: { ...base.normal, ...patch.normal }, prep: { ...base.prep, ...patch.prep } };
}
