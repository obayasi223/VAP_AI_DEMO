/**
 * VAP の鮮度（計画 §4.1）。fresh 以外では VAP の値を制御に使わない。
 *
 * 計画の定義は「最新の VAP_STATE の audio_frame が受信済み音声の先頭より一定時間遅れた」。
 * 音声そのものが止まると frame の差は開かないので、受信時刻の遅れも見る（どちらか一方で stale）。
 */
import { SAMPLE_RATE_HZ } from '@llm-vap/contracts';
import type { TurnInputs, VapFreshness } from '@llm-vap/contracts';

export interface FreshnessResult {
  freshness: VapFreshness;
  reason: string;
}

export function assessVapFreshness(
  inputs: Pick<TurnInputs, 'vap' | 'vap_received_at' | 'received_audio_frame' | 'vap_worker_started_at'>,
  now: number,
  limits: { vap_stale_ms: number; vap_rewarm_ms: number },
): FreshnessResult {
  const workerStartedAt = inputs.vap_worker_started_at.value;
  if (workerStartedAt === null) {
    return { freshness: 'down', reason: `worker_not_started:${nullReason(inputs.vap_worker_started_at)}` };
  }
  // 再起動後は文脈が空なので、値が届いていても助走が過ぎるまで使わない（計画 §4.1 の「復帰時」）。
  if (now - workerStartedAt < limits.vap_rewarm_ms) {
    return { freshness: 'warming_up', reason: `rewarm:${now - workerStartedAt}ms<${limits.vap_rewarm_ms}ms` };
  }
  const vap = inputs.vap.value;
  const receivedAt = inputs.vap_received_at.value;
  if (vap === null || receivedAt === null) {
    return { freshness: 'down', reason: `no_vap_state:${nullReason(inputs.vap)}` };
  }
  const frameLagMs = ((inputs.received_audio_frame - vap.audio_frame) / SAMPLE_RATE_HZ) * 1000;
  if (frameLagMs > limits.vap_stale_ms) {
    return { freshness: 'stale', reason: `audio_frame_lag:${frameLagMs}ms>${limits.vap_stale_ms}ms` };
  }
  const arrivalLagMs = now - receivedAt;
  if (arrivalLagMs > limits.vap_stale_ms) {
    return { freshness: 'stale', reason: `arrival_lag:${arrivalLagMs}ms>${limits.vap_stale_ms}ms` };
  }
  return { freshness: 'fresh', reason: 'fresh' };
}

function nullReason(m: { value: unknown; null_reason?: string }): string {
  return m.null_reason ?? 'unknown';
}
