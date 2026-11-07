/**
 * 最小の視線。見る／そらすの切替を外から受けて補間するだけで、いつそらすかはここで決めない（判断は E）。
 * 向きの規約: yaw は正がモデルの左（画面の右）、pitch は正が下。
 */
import type { GazeReport, GazeTarget } from '@llm-vap/contracts';
import type { AvatarLayer, LayerContext, PoseFrame } from './pose';
import { DEG2RAD, SmoothDamp, type Rng } from './util';

export interface GazeOptions {
  /**
   * そらしたときの vrm.lookAt の入力（度）。眼球の回転はモデルの range map で縮む。
   * Sendagaya_Shino は 90 度入力で外 12 度、内 8 度、上下 10 度なので、大きめの入力にしている。
   */
  awayEyeYawDeg: number;
  awayEyePitchDeg: number;
  awayHeadYawDeg: number;
  awayHeadPitchDeg: number;
  eyeSmoothMs: number;
  headSmoothMs: number;
  /** そらす向きの毎回の揺らぎ（割合）。 */
  jitter: number;
  /** 頭の回転のうち首に割り振る割合。 */
  neckShare: number;
}

export const DEFAULT_GAZE: GazeOptions = {
  awayEyeYawDeg: 58,
  awayEyePitchDeg: 22,
  awayHeadYawDeg: 13,
  awayHeadPitchDeg: 5,
  eyeSmoothMs: 45,
  headSmoothMs: 210,
  jitter: 0.15,
  neckShare: 0.4,
};

export interface GazeState {
  target: GazeTarget;
  /** 0 が見ている、1 がそらしきった。眼の補間の進み具合。 */
  awayAmount: number;
  eyeYawDeg: number;
  eyePitchDeg: number;
  headYawDeg: number;
  headPitchDeg: number;
  settled: boolean;
}

const SETTLE_EPSILON_DEG = 0.05;

export class GazeController {
  private readonly options: GazeOptions;
  private target: GazeTarget = 'user';
  private goal = { eyeYaw: 0, eyePitch: 0, headYaw: 0, headPitch: 0 };
  private readonly eyeYaw = new SmoothDamp();
  private readonly eyePitch = new SmoothDamp();
  private readonly headYaw = new SmoothDamp();
  private readonly headPitch = new SmoothDamp();

  constructor(
    private readonly rng: Rng,
    options: Partial<GazeOptions> = {},
  ) {
    this.options = { ...DEFAULT_GAZE, ...options };
  }

  get currentTarget(): GazeTarget {
    return this.target;
  }

  /** 同じ目標なら何もしない。変わったら true。 */
  setTarget(target: GazeTarget): boolean {
    if (target === this.target) return false;
    this.target = target;
    if (target === 'user') {
      this.goal = { eyeYaw: 0, eyePitch: 0, headYaw: 0, headPitch: 0 };
    } else {
      const o = this.options;
      const vary = () => 1 + (this.rng() * 2 - 1) * o.jitter;
      const yawScale = vary();
      this.goal = {
        eyeYaw: o.awayEyeYawDeg * yawScale,
        eyePitch: o.awayEyePitchDeg * vary(),
        headYaw: o.awayHeadYawDeg * yawScale,
        headPitch: o.awayHeadPitchDeg * vary(),
      };
    }
    return true;
  }

  update(dtMs: number): GazeState {
    const { eyeSmoothMs, headSmoothMs, awayEyeYawDeg } = this.options;
    const eyeYaw = this.eyeYaw.update(this.goal.eyeYaw, eyeSmoothMs, dtMs);
    const eyePitch = this.eyePitch.update(this.goal.eyePitch, eyeSmoothMs, dtMs);
    const headYaw = this.headYaw.update(this.goal.headYaw, headSmoothMs, dtMs);
    const headPitch = this.headPitch.update(this.goal.headPitch, headSmoothMs, dtMs);
    const near = (a: number, b: number) => Math.abs(a - b) < SETTLE_EPSILON_DEG;
    return {
      target: this.target,
      awayAmount: Math.min(1, Math.abs(eyeYaw) / Math.max(awayEyeYawDeg * (1 - this.options.jitter), 1e-6)),
      eyeYawDeg: eyeYaw,
      eyePitchDeg: eyePitch,
      headYawDeg: headYaw,
      headPitchDeg: headPitch,
      settled:
        near(eyeYaw, this.goal.eyeYaw) &&
        near(eyePitch, this.goal.eyePitch) &&
        near(headYaw, this.goal.headYaw) &&
        near(headPitch, this.goal.headPitch),
    };
  }
}

export class GazeLayer implements AvatarLayer {
  readonly name = 'gaze';
  state: GazeState = {
    target: 'user',
    awayAmount: 0,
    eyeYawDeg: 0,
    eyePitchDeg: 0,
    headYawDeg: 0,
    headPitchDeg: 0,
    settled: true,
  };

  constructor(
    readonly controller: GazeController,
    private readonly neckShare: number = DEFAULT_GAZE.neckShare,
  ) {}

  update(context: LayerContext, frame: PoseFrame): void {
    const s = this.controller.update(context.dtMs);
    this.state = s;
    const pitch = s.headPitchDeg * DEG2RAD;
    const yaw = s.headYawDeg * DEG2RAD;
    frame.addBone('neck', pitch * this.neckShare, yaw * this.neckShare, 0);
    frame.addBone('head', pitch * (1 - this.neckShare), yaw * (1 - this.neckShare), 0);
    frame.eye.yawDeg += s.eyeYawDeg;
    frame.eye.pitchDeg += s.eyePitchDeg;
    frame.eye.userWeight = Math.min(frame.eye.userWeight, 1 - s.awayAmount);
  }
}

/** 描画の前に次の目標で上書きされ、一度も描かれなかった判断の null_reason。 */
export const GAZE_SUPERSEDED_BEFORE_RENDER = 'superseded_before_render';

/**
 * browser_rpc の GazeReport を作る。目標が変わった後の最初の rAF を描画の時刻として報告する。
 * 背景タブでは rAF が来ないので visible=false を直ちに出し、見えるようになった最初の描画でもう一度出す。
 * 描画の前に次の目標が来たら、前の目標は描かれていないので visible=false と
 * GAZE_SUPERSEDED_BEFORE_RENDER で報告する（報告が黙って消えないように。判断ごとに報告が1つ以上出る）。
 * 背景タブで既に visible=false を出した目標は、上書きされても重ねて出さない。
 */
export class GazeReporter {
  private pending: GazeTarget | null = null;
  private pendingReportedHidden = false;

  constructor(private readonly emit: (report: GazeReport) => void) {}

  commanded(target: GazeTarget, visible: boolean): void {
    if (this.pending !== null && !this.pendingReportedHidden) {
      this.emit({
        type: 'gaze.report',
        target: this.pending,
        visible: false,
        client_t_ms: { value: null, null_reason: GAZE_SUPERSEDED_BEFORE_RENDER },
      });
    }
    this.pending = target;
    this.pendingReportedHidden = !visible;
    if (!visible) {
      this.emit({
        type: 'gaze.report',
        target,
        visible: false,
        client_t_ms: { value: null, null_reason: 'page_hidden_no_raf' },
      });
    }
  }

  /** 描画の直後に rAF の時刻で呼ぶ。 */
  rendered(rafMs: number): void {
    if (this.pending === null) return;
    const target = this.pending;
    this.pending = null;
    this.pendingReportedHidden = false;
    this.emit({ type: 'gaze.report', target, visible: true, client_t_ms: { value: rafMs } });
  }
}
