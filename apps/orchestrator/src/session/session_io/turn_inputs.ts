/**
 * TurnManager の入力の組み立て（session.ts の inputs から切り出し。docs/design/two_ai/06 §11、01 §1.3。WP1a）。
 * prefetch、start_blocked_reason、similarity は呼び手が渡す（2 体では受け止めの音声と進行役の止め）。
 */
import { absent, present } from '@llm-vap/contracts';
import type { TranscriptSnapshot, TurnInputs } from '@llm-vap/contracts';
import type { CompletionTracker } from './completion';
import type { MaaiSessionWiring } from './maai_wiring';
import type { UplinkAudio } from './uplink';

export function buildTurnInputs(parts: {
  maai: MaaiSessionWiring;
  maaiEnabled: boolean;
  uplink: UplinkAudio;
  transcript: TranscriptSnapshot | null;
  completion: CompletionTracker;
  prefetch: TurnInputs['prefetch'];
  similarity: TurnInputs['similarity_to_prepared'];
  playback: TurnInputs['playback'];
  start_blocked_reason: string | null;
}): TurnInputs {
  const { maai, uplink, completion } = parts;
  const t = parts.transcript;
  const vap = maai.vap;
  const vapReceivedAt = maai.vapReceivedAt;
  const workerReadyAt = maai.workerReadyAt;
  const micDbfs = uplink.lastMicDbfs;
  return {
    vap: vap === null ? absent('no_vap_state_since_ready') : present(vap),
    vap_received_at: vapReceivedAt === null ? absent('no_vap_state_since_ready') : present(vapReceivedAt),
    start_blocked_reason: parts.start_blocked_reason,
    received_audio_frame: uplink.receivedAudioFrame,
    vap_worker_started_at: workerReadyAt === null ? absent(parts.maaiEnabled ? 'worker_not_ready' : 'maai_disabled') : present(workerReadyAt),
    // 単位は mic の RMS の dBFS（Node が計算）。VAP ではない。
    fallback_energy: micDbfs === null ? absent('no_uplink_audio_yet') : present(micDbfs),
    transcript: t === null ? absent('no_transcript_yet') : present(t),
    completion_p: completion.p,
    completion_revision: completion.revision === null ? absent('no_estimate_yet') : present(completion.revision),
    similarity_to_prepared: parts.similarity,
    prefetch: parts.prefetch,
    playback: parts.playback,
    woz: [],
  };
}
