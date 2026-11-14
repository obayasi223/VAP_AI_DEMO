/**
 * 本人の台本から VAP の出力を作る偽物（04 T2、T4。FakeVapFromScript）。実の MaAI の代わりに、試走と結合の試験で使う。
 * ch0 = 本人（mic）、ch1 = AI（sys）。値は 2ch の vap.state の p_now／p_future／vad と同じ並び。
 * - 声の区間：立ち上がり ramp_ms で vad と p が上がり、区間の間は高いまま、終わりで下がる。
 * - 兆しだけ（onset_only）：vad が ramp_ms だけ上がって消える（声にならない。sub_threshold や false_onset の材料）。
 * - AI の再生中は sys の vad を上げる（ai_speaking を渡す）。
 * 結果は性能や自然さの証拠ではない（偽の VAP）。
 */
import type { UserAction } from './user_script';

export interface FakeVapFrame {
  t_ms: number;
  p_now: [number, number];
  p_future: [number, number];
  vad: [number, number];
}

export interface FakeVapOptions {
  /** 声の立ち上がり（既定 150 ms）。 */
  ramp_ms?: number;
  /** 声の前に p_future が先に上がる長さ（既定 200 ms）。 */
  lead_ms?: number;
  high?: number;
  low?: number;
}

export class FakeVapFromScript {
  private readonly ramp: number;
  private readonly lead: number;
  private readonly high: number;
  private readonly low: number;

  constructor(private readonly actions: readonly UserAction[], options: FakeVapOptions = {}) {
    this.ramp = options.ramp_ms ?? 150;
    this.lead = options.lead_ms ?? 200;
    this.high = options.high ?? 0.9;
    this.low = options.low ?? 0.05;
  }

  /** 時刻 t の本人の声の強さ（0〜1）と、先の見込み。 */
  private user(t: number): { vad: number; future: number } {
    let vad = 0;
    let future = 0;
    for (const a of this.actions) {
      if (a.kind === 'voice') {
        const end = a.at_ms + a.duration_ms;
        if (t >= a.at_ms && t < end) vad = Math.max(vad, Math.min(1, (t - a.at_ms) / this.ramp));
        if (t >= a.at_ms - this.lead && t < end - this.lead) future = Math.max(future, 1);
      } else if (a.kind === 'onset_only') {
        if (t >= a.at_ms && t < a.at_ms + a.ramp_ms) vad = Math.max(vad, 0.6 * Math.sin((Math.PI * (t - a.at_ms)) / a.ramp_ms));
      }
    }
    return { vad, future };
  }

  frame(t: number, ai_speaking: boolean): FakeVapFrame {
    const u = this.user(t);
    const lerp = (x: number) => this.low + (this.high - this.low) * x;
    const pUser = lerp(Math.max(u.vad, u.future * 0.8));
    const pFuture = lerp(u.future);
    const sys = ai_speaking ? this.high : this.low;
    return {
      t_ms: t,
      p_now: [pUser, 1 - pUser],
      p_future: [pFuture, 1 - pFuture],
      vad: [lerp(u.vad), sys],
    };
  }

  /** start から end まで step ごとの枠（既定 50 ms。MaAI の出力の間隔に近い）。 */
  frames(start: number, end: number, ai_speaking: (t: number) => boolean, step = 50): FakeVapFrame[] {
    const out: FakeVapFrame[] = [];
    for (let t = start; t < end; t += step) out.push(this.frame(t, ai_speaking(t)));
    return out;
  }

  /** 本人の声がある区間（STT の偽物が確定文を返す区間）。 */
  voicedSegments(): { start_ms: number; end_ms: number; text: string }[] {
    return this.actions.filter((a): a is Extract<UserAction, { kind: 'voice' }> => a.kind === 'voice').map((a) => ({ start_ms: a.at_ms, end_ms: a.at_ms + a.duration_ms, text: a.text }));
  }
}
