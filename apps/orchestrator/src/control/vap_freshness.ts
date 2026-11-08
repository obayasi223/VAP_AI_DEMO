/**
 * VAP の鮮度（計画 §4.1）。fresh 以外では VAP の値を制御に使わない。
 *
 * 計画の定義は「最新の VAP_STATE の audio_frame が受信済み音声の先頭より一定時間遅れた」。
 * 音声そのものが止まると frame の差は開かないので、受信時刻の遅れも見る（どちらか一方で stale）。
 */
import { SAMPLE_RATE_HZ } from '@llm-vap/contracts';
import type { TurnInputs, Vap2chState, VapFreshness } from '@llm-vap/contracts';

export interface FreshnessResult {
  freshness: VapFreshness;
  reason: string;
}

/**
 * 鮮度のほかに「値を信用してよいか」を見る条件（ja の turn.vap_unavailable、原著にない）。hri2025 は null で見ない。
 * 契約の VapFreshness に種類を足していないので、信用できない値は stale として扱い、理由で区別する。
 */
export interface VapTrustSettings {
  direction_status: 'provisional' | 'measured';
  /** AI の再生中に sys チャネルの無音がこれ以上続いたら、AI の音声の参照が来ていないとみなす。null は検査しない。 */
  ai_reference_missing_ms: number | null;
}

function validProbability(v: unknown): boolean {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
}

/** 契約の検証を通らない値（NaN、範囲外、受信より先の音声位置）。Node の外から来る値なので、ここでも止める。 */
function vapValueAnomaly(vap: Vap2chState, receivedAudioFrame: number): string | null {
  for (const name of ['p_now', 'p_future', 'vad'] as const) {
    const pair = vap[name] as readonly unknown[];
    if (!Array.isArray(pair) || pair.length !== 2 || !pair.every(validProbability)) return name;
  }
  if (vap.audio_frame > receivedAudioFrame) return `audio_frame_ahead:${vap.audio_frame}>${receivedAudioFrame}`;
  return null;
}

export function assessVapFreshness(
  inputs: Pick<TurnInputs, 'vap' | 'vap_received_at' | 'received_audio_frame' | 'vap_worker_started_at'> &
    Partial<Pick<TurnInputs, 'playback'>>,
  now: number,
  limits: { vap_stale_ms: number; vap_rewarm_ms: number },
  trust: VapTrustSettings | null = null,
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
  if (trust !== null) {
    const anomaly = vapValueAnomaly(vap, inputs.received_audio_frame);
    if (anomaly !== null) return { freshness: 'stale', reason: `invalid_vap_value:${anomaly}` };
    if (trust.direction_status !== 'measured') return { freshness: 'stale', reason: 'direction_provisional' };
  }
  const frameLagMs = ((inputs.received_audio_frame - vap.audio_frame) / SAMPLE_RATE_HZ) * 1000;
  if (frameLagMs > limits.vap_stale_ms) {
    return { freshness: 'stale', reason: `audio_frame_lag:${frameLagMs}ms>${limits.vap_stale_ms}ms` };
  }
  const arrivalLagMs = now - receivedAt;
  if (arrivalLagMs > limits.vap_stale_ms) {
    return { freshness: 'stale', reason: `arrival_lag:${arrivalLagMs}ms>${limits.vap_stale_ms}ms` };
  }
  const playback = inputs.playback;
  if (trust?.ai_reference_missing_ms != null && playback?.state === 'playing' && playback.system_silence_ms >= trust.ai_reference_missing_ms) {
    return {
      freshness: 'stale',
      reason: `ai_reference_missing:${playback.system_silence_ms}ms>=${trust.ai_reference_missing_ms}ms`,
    };
  }
  return { freshness: 'fresh', reason: 'fresh' };
}

function nullReason(m: { value: unknown; null_reason?: string }): string {
  return m.null_reason ?? 'unknown';
}
