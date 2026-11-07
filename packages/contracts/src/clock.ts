/**
 * 時刻源のインターフェース（計画 §3.4）。依存なし。
 * t_monotonic_ms はセッション開始を 0 とする orchestrator の単調時計。
 * 別プロセスのローカル単調時計を直接比較しないこと（追補2）。
 */

export interface TimeSource {
  /** セッション単位の単調増加時刻（ミリ秒）。 */
  monotonicMs(): number;
  /** WallClock。ISO 8601（UTC）。 */
  wallClock(): string;
}

/** 実時間の時刻源。performance はブラウザと Node の両方にある。 */
export class SystemTimeSource implements TimeSource {
  private readonly origin: number;
  constructor() {
    this.origin = performance.now();
  }
  monotonicMs(): number {
    return performance.now() - this.origin;
  }
  wallClock(): string {
    return new Date().toISOString();
  }
}

/** 試験とリプレイ用。時刻は明示的に進める。 */
export class ManualTimeSource implements TimeSource {
  private now: number;
  private readonly wallOriginMs: number;
  constructor(startMs = 0, wallOrigin = '2026-01-01T00:00:00.000Z') {
    this.now = startMs;
    this.wallOriginMs = Date.parse(wallOrigin);
  }
  monotonicMs(): number {
    return this.now;
  }
  wallClock(): string {
    return new Date(this.wallOriginMs + this.now).toISOString();
  }
  advance(ms: number): number {
    if (ms < 0) throw new Error('ManualTimeSource cannot go backwards');
    this.now += ms;
    return this.now;
  }
  set(ms: number): number {
    if (ms < this.now) throw new Error('ManualTimeSource cannot go backwards');
    this.now = ms;
    return this.now;
  }
}

export interface ClockSample {
  /** サーバー時刻 = クライアント時刻 + offset_ms */
  offset_ms: number;
  rtt_ms: number;
  /** 往復が対称と仮定したときの最大誤差（RTT の半分）。 */
  uncertainty_ms: number;
}

/**
 * clock.ping / clock.pong の往復から時計差を求める（計画 §3.4）。
 * 複数の標本のうち RTT が最小のものを使うのは呼び出し側（A、J）の判断。
 */
export function computeClockSample(
  clientSentMs: number,
  serverMs: number,
  clientReceivedMs: number,
): ClockSample {
  const rtt_ms = clientReceivedMs - clientSentMs;
  if (rtt_ms < 0) throw new Error('clock sample with negative RTT');
  return {
    offset_ms: serverMs - (clientSentMs + clientReceivedMs) / 2,
    rtt_ms,
    uncertainty_ms: rtt_ms / 2,
  };
}
