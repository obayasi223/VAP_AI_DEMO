/**
 * 時刻の写像。Worker の中で使う。依存は clock.ts のみ。
 *
 * - ClockEstimator: clock.ping/pong の往復から orchestrator との時計差を求める（計画 §3.4）。
 *   直近の窓で RTT が最小の標本を採る。誤差は RTT/2。
 * - RenderClock: Worklet のフレーム番号をクライアント時刻へ写す。AudioWorkletGlobalScope には
 *   performance がないので、Worker の受信時刻の下側包絡（メッセージの揺れを除いたもの）を使う。
 */
import { computeClockSample, type ClockSample } from '@llm-vap/contracts/clock';

export interface ClockEstimate extends ClockSample {
  samples: number;
  /** この推定の元の標本を受けたクライアント時刻。 */
  measured_at_client_ms: number;
}

export class ClockEstimator {
  private readonly samples: (ClockSample & { at: number })[] = [];

  constructor(
    private readonly windowMs = 60_000,
    private readonly maxSamples = 32,
  ) {}

  add(clientSentMs: number, serverMs: number, clientReceivedMs: number): ClockEstimate | null {
    const sample = computeClockSample(clientSentMs, serverMs, clientReceivedMs);
    this.samples.push({ ...sample, at: clientReceivedMs });
    while (
      this.samples.length > this.maxSamples ||
      (this.samples.length > 1 && clientReceivedMs - (this.samples[0] as { at: number }).at > this.windowMs)
    ) {
      this.samples.shift();
    }
    return this.best();
  }

  best(): ClockEstimate | null {
    let best: (ClockSample & { at: number }) | null = null;
    for (const s of this.samples) {
      if (best === null || s.rtt_ms < best.rtt_ms) best = s;
    }
    if (best === null) return null;
    return {
      offset_ms: best.offset_ms,
      rtt_ms: best.rtt_ms,
      uncertainty_ms: best.uncertainty_ms,
      samples: this.samples.length,
      measured_at_client_ms: best.at,
    };
  }

  reset(): void {
    this.samples.length = 0;
  }
}

/**
 * Worker の performance.now() を主スレッドの performance.now() へ写す差。timeOrigin の引き算は使わない
 * （Chromium の timeOrigin は文脈ごとに実時計へ換算され、ずれることがある。実測で 1.3 秒。docs/overnight_verification.md）。
 * メッセージの往復で測り、RTT が最小の標本を採る。誤差は RTT/2。
 */
export class ThreadAxisEstimator {
  private best: { offset_ms: number; rtt_ms: number } | null = null;

  /** workerSent と workerReceived は Worker の now、mainT は主スレッドの now。 */
  add(workerSentMs: number, mainMs: number, workerReceivedMs: number): void {
    const rtt = workerReceivedMs - workerSentMs;
    if (this.best === null || rtt < this.best.rtt_ms) {
      this.best = { offset_ms: mainMs - (workerSentMs + workerReceivedMs) / 2, rtt_ms: rtt };
    }
  }

  get offsetMs(): number | null {
    return this.best === null ? null : this.best.offset_ms;
  }

  get uncertaintyMs(): number {
    return this.best === null ? 0 : this.best.rtt_ms / 2;
  }

  get rttMs(): number | null {
    return this.best === null ? null : this.best.rtt_ms;
  }
}

export class RenderClock {
  private readonly offsets: Float64Array;
  private count = 0;
  private cursor = 0;
  private currentMin = Number.POSITIVE_INFINITY;
  private firstOffset: number | null = null;
  private lastArrivalDelay = 0;

  constructor(
    private readonly rate: number,
    windowObservations = 256,
  ) {
    this.offsets = new Float64Array(windowObservations);
  }

  observe(renderFrame: number, arrivalMs: number): void {
    const offset = arrivalMs - (renderFrame * 1000) / this.rate;
    this.offsets[this.cursor] = offset;
    this.cursor = (this.cursor + 1) % this.offsets.length;
    this.count = Math.min(this.count + 1, this.offsets.length);
    let min = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.count; i++) {
      const v = this.offsets[i] as number;
      if (v < min) min = v;
    }
    this.currentMin = min;
    if (this.firstOffset === null) this.firstOffset = min;
    this.lastArrivalDelay = offset - min;
  }

  /** フレーム番号をクライアント時刻へ。観測がなければ null。 */
  toClientMs(renderFrame: number): number | null {
    if (this.count === 0) return null;
    return (renderFrame * 1000) / this.rate + this.currentMin;
  }

  /** 実時間に対するレンダーの遅れ（ms）。増え続けるならコールバックが抜けている。 */
  get renderLagMs(): number {
    return this.firstOffset === null ? 0 : this.currentMin - this.firstOffset;
  }

  get arrivalDelayMs(): number {
    return this.lastArrivalDelay;
  }
}
