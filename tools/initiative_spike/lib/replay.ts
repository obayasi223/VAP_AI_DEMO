/** §3.5 の stt.* を記録の時刻どおりに流す。待ち方を差し替えられるので、試験では仮想時刻で動かす。 */
import type { TimeSource } from '@llm-vap/contracts';
import type { SttEvent } from '../../../apps/orchestrator/src/cognition/initiative/transcript_view';

export interface ReplayOptions {
  time: TimeSource;
  /** 1 が実時間。関門の判定には 1 以外を使わない。 */
  speed?: number;
  /** 指定の時刻まで待つ。 */
  waitUntil?: (t_ms: number) => Promise<void>;
  onEvent: (event: SttEvent) => void;
}

export async function replayStt(events: readonly SttEvent[], options: ReplayOptions): Promise<void> {
  const speed = options.speed ?? 1;
  const start = options.time.monotonicMs();
  const waitUntil =
    options.waitUntil ??
    (async (t_ms: number) => {
      const wait = t_ms - options.time.monotonicMs();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    });
  for (const event of events) {
    await waitUntil(start + event.t_monotonic_ms / speed);
    options.onEvent(event);
  }
}
