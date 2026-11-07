/**
 * プロセス間の時計差補正の記録（計画 §3.4、追補2）。
 * 推定のたびに clock.sync を出し、同じ推定から EmitOptions.at に渡す TimeMapping を作る。
 * mapping() は推定がなければ null を返す。そのときは補正していない時刻を入れないこと。
 */
import type { EventEmitter, TimeMapping } from '@llm-vap/contracts';
import { absent, present, type ClockSample } from '@llm-vap/contracts';

/**
 * ブラウザの往復計測。ClockEstimator（apps/web/src/audio/clock_sync.ts）の推定を受ける。
 * 注意: 推定はブラウザの Worker の中にあり、Node へ届ける契約のメッセージが今はない（最終報告の契約の不足）。
 */
export class BrowserClockRecorder {
  private latest: ClockSample | null = null;

  constructor(private readonly emitter: EventEmitter) {}

  record(sample: ClockSample): void {
    this.emitter.emit({
      event: 'clock.sync',
      source: 'browser_rtt',
      offset_ms: sample.offset_ms,
      error_ms: sample.uncertainty_ms,
      rtt_ms: present(sample.rtt_ms),
    });
    if (Number.isFinite(sample.offset_ms) && Number.isFinite(sample.uncertainty_ms)) this.latest = sample;
  }

  current(): ClockSample | null {
    return this.latest;
  }

  /** 今の推定に固定した写像。basis の誤差と toServerMs の offset は同じ推定から出る。 */
  mapping(): TimeMapping | null {
    const sample = this.latest;
    if (sample === null) return null;
    return {
      toServerMs: (localMs) => localMs + sample.offset_ms,
      basis: { source: 'browser_rtt', uncertainty_ms: present(sample.uncertainty_ms) },
    };
  }
}

export interface WorkerClockOptions {
  /** 下側包絡を取る窓の標本数。 */
  windowSamples?: number;
  /** clock.sync を出す最小間隔。VAP_STATE ごとには出さない。 */
  emitIntervalMs?: number;
}

/**
 * Python ワーカーの時計（VAP_STATE の t）と受信時刻から補正する。一方向なので往復は測れない。
 * 受信時刻と t の差の下側包絡を offset とし、窓内の幅を誤差とする。
 * この誤差には通信の固定の遅れが入らない（localhost の WS の一方向分は測れない）。
 * ワーカーを再起動したら t の基準が変わるので reset() を呼ぶ。
 */
export class WorkerClockRecorder {
  private readonly offsets: number[] = [];
  private lastEmitAt: number | null = null;
  private readonly windowSamples: number;
  private readonly emitIntervalMs: number;

  constructor(
    private readonly emitter: EventEmitter,
    options: WorkerClockOptions = {},
  ) {
    this.windowSamples = options.windowSamples ?? 128;
    this.emitIntervalMs = options.emitIntervalMs ?? 1000;
  }

  observe(workerTMs: number, receivedAtMs: number): void {
    this.offsets.push(receivedAtMs - workerTMs);
    if (this.offsets.length > this.windowSamples) this.offsets.shift();
    if (this.lastEmitAt !== null && receivedAtMs - this.lastEmitAt < this.emitIntervalMs) return;
    this.lastEmitAt = receivedAtMs;
    const { offset_ms, error_ms } = this.estimate() as { offset_ms: number; error_ms: number };
    this.emitter.emit({
      event: 'clock.sync',
      source: 'worker_audio_frame',
      offset_ms,
      error_ms,
      rtt_ms: absent('worker_clock_is_one_way'),
    });
  }

  estimate(): { offset_ms: number; error_ms: number } | null {
    if (this.offsets.length === 0) return null;
    const min = Math.min(...this.offsets);
    return { offset_ms: min, error_ms: Math.max(...this.offsets) - min };
  }

  mapping(): TimeMapping | null {
    const estimate = this.estimate();
    if (estimate === null) return null;
    return {
      toServerMs: (localMs) => localMs + estimate.offset_ms,
      basis: { source: 'worker_audio_frame', uncertainty_ms: present(estimate.error_ms) },
    };
  }

  reset(): void {
    this.offsets.length = 0;
    this.lastEmitAt = null;
  }
}
