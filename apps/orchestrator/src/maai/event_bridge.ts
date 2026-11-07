/**
 * クライアントの通知を研究イベントへ変換する（計画 §3.5 の vap.state、audio.health、provider.status）。
 * 時刻は WorkerClockRecorder で orchestrator の基準へ写す（プロセス間の時計を直接比較しない）。
 */
import {
  draftFromVapMessage,
  draftFromWorkerStatus,
  absent,
  present,
  type EventEmitter,
  type ProviderHealth,
  type SystemChannelSource,
} from '@llm-vap/contracts';
import type { WorkerClockRecorder } from '../logging';
import type { MaaiAvailability, MaaiClientListeners, MaaiWorkerClient, MaaiWorkerState } from './client';

export const MAAI_PROVIDER_NAME = 'maai_worker';

const HEALTH: Record<MaaiWorkerState, ProviderHealth> = {
  ready: 'ok',
  degraded: 'degraded',
  starting: 'degraded',
  loading: 'degraded',
  down: 'down',
  stopped: 'down',
};

export interface MaaiEventBridgeOptions {
  emitter: EventEmitter;
  clock: WorkerClockRecorder;
  /** audio.health の system_ch_source。ブラウザの実装の値を渡す（計画 §3.2）。 */
  systemChannelSource: SystemChannelSource;
}

export function maaiProviderStatusDraft(availability: MaaiAvailability, providerClass: 'production' | 'test_double') {
  return {
    event: 'provider.status' as const,
    provider: MAAI_PROVIDER_NAME,
    provider_class: providerClass,
    status: HEALTH[availability.state],
    reason: availability.reason === null ? absent('healthy') : present(availability.reason),
    retry_attempt: availability.restart_attempt,
    next_retry_ms:
      availability.next_retry_ms === null
        ? absent(availability.gave_up ? 'gave_up' : 'not_retrying')
        : present(availability.next_retry_ms),
  };
}

/** 外すときは返り値を呼ぶ。 */
export function attachMaaiEventBridge(client: MaaiWorkerClient, options: MaaiEventBridgeOptions): () => void {
  const { emitter, clock, systemChannelSource } = options;
  // READY の前の VAP_STATE は前の CONFIGURE（前のセッションの番号）の結果なので、このセッションのログに書かない。
  // session.ts も同じ条件で TurnManager へ渡さない。
  let ready = false;
  const listeners: MaaiClientListeners = {
    onReady() {
      ready = true;
    },
    onVapState(message, receivedAtMs) {
      if (!ready) return;
      clock.observe(message.t, receivedAtMs);
      const mapping = clock.mapping();
      if (mapping === null) throw new Error('WorkerClockRecorder has no mapping right after observe');
      emitter.emit(draftFromVapMessage(message), {
        at: { t_monotonic_ms: Math.max(0, mapping.toServerMs(message.t)), time_basis: mapping.basis },
      });
    },
    onPong(message, receivedAtMs) {
      clock.observe(message.worker_t_ms, receivedAtMs);
    },
    onWorkerStatus(message) {
      emitter.emit(draftFromWorkerStatus(message, systemChannelSource));
    },
    onAvailability(availability) {
      if (!availability.vap_available) ready = false;
      emitter.emit(maaiProviderStatusDraft(availability, client.providerClass));
    },
    onClockReset() {
      ready = false;
      clock.reset();
    },
  };
  return client.subscribe(listeners);
}
