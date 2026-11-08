/**
 * emit の経路: 本体は Node にある（emit.ts）。Browser と Python は emit を持たず、契約のメッセージを
 * Node へ送り、Node がここの関数で下書きへ変換して emit する。配線は J。
 *
 * EVENT_ROUTES はイベントごとの発行場所の一覧。別プロセスの時刻は補正して EmitOptions.at で渡す。
 */
import type { AudioReport, ClockReport, GazeReport, SignalReport, SignalParameters } from './browser_rpc';
import type { ClockSample } from './clock';
import type { EmitOptions, EventDraft } from './emit';
import type { ResearchEventName, TimeBasis } from './events';
import type { MaaiVapStateMessage, MaaiWorkerStatus } from './maai_rpc';
import { absent, present, type SystemChannelSource } from './common';

export type EventRoute =
  | { origin: 'node' }
  | { origin: 'browser'; via: readonly string[] }
  | { origin: 'worker'; via: readonly string[] };

export const EVENT_ROUTES = {
  'stt.interim': { origin: 'node' },
  'stt.final': { origin: 'node' },
  'stt.handover': { origin: 'node' },
  'llm.request': { origin: 'node' },
  'llm.response': { origin: 'node' },
  'vap.state': { origin: 'worker', via: ['VAP_STATE'] },
  'prefetch.started': { origin: 'node' },
  'prefetch.cancelled': { origin: 'node' },
  'prefetch.ready': { origin: 'node' },
  'initiative.decision': { origin: 'node' },
  'initiative.discarded': { origin: 'node' },
  'initiative.aborted': { origin: 'node' },
  'initiative.desire': { origin: 'node' },
  'initiative.timing': { origin: 'node' },
  'initiative.not_offered': { origin: 'node' },
  'initiative.response_material': { origin: 'node' },
  'initiative.response_reflection': { origin: 'node' },
  'initiative.already_said': { origin: 'node' },
  'candidate.state_changed': { origin: 'node' },
  'candidate.rejected': { origin: 'node' },
  'signal.sent': { origin: 'node' },
  'signal.started': { origin: 'browser', via: ['signal.report'] },
  'signal.ended': { origin: 'browser', via: ['signal.report'] },
  'turn.allowed': { origin: 'node' },
  'speech.started': { origin: 'browser', via: ['playback.started'] },
  'speech.ended': { origin: 'browser', via: ['playback.ended'] },
  'speech.interrupted': { origin: 'browser', via: ['playback.ended'] },
  'gaze.decision': { origin: 'node' },
  'audio.health': { origin: 'browser', via: ['audio.report', 'WORKER_STATUS'] },
  'provider.status': { origin: 'node' },
  'cost.usage': { origin: 'node' },
  'woz.override': { origin: 'node' },
  'clock.sync': { origin: 'node' },
  // 中身は client.hello だが、時刻は Node の受信時刻（時計差の推定の前に届く）。
  'session.client': { origin: 'node' },
  'gaze.rendered': { origin: 'browser', via: ['gaze.report'] },
  // 中身は研究者画面の research.note だが、時刻は Node の受信時刻（研究者のブラウザの時計は補正しない）。
  'research.note': { origin: 'node' },
  'negotiation.decision': { origin: 'node' },
  'negotiation.cue_reaction': { origin: 'node' },
  'turn.outcome': { origin: 'node' },
} as const satisfies Record<ResearchEventName, EventRoute>;

/** ローカル時刻を orchestrator の基準へ写す関数と、その由来。J が clock.sync の推定から作る。 */
export interface TimeMapping {
  toServerMs(localMs: number): number;
  basis: TimeBasis;
}

export function atFromBrowser(clientMs: number, mapping: TimeMapping): EmitOptions {
  return { at: { t_monotonic_ms: mapping.toServerMs(clientMs), time_basis: mapping.basis } };
}

export function draftFromAudioReport(report: AudioReport): EventDraft {
  return {
    event: 'audio.health',
    reporter: 'browser',
    audio_frame: report.audio_frame,
    frames_lost: report.frames_lost,
    underrun_count: report.underrun_count,
    underrun_total_ms: report.underrun_total_ms,
    stale_pcm_frames_dropped: report.stale_pcm_frames_dropped,
    latency: report.latency,
    track_settings: report.track_settings,
    system_ch_source: report.system_ch_source,
    audio_context_state: report.audio_context_state,
    visibility: report.visibility,
    // 古い送信側は項目を持たない。undefined を載せない（スキーマは strict で、ログの JSON にも残さない）。
    ...(report.reconnects === undefined ? {} : { reconnects: report.reconnects }),
    ...(report.orphan_pcm_frames === undefined ? {} : { orphan_pcm_frames: report.orphan_pcm_frames }),
    ...(report.pcm_seq_gaps === undefined ? {} : { pcm_seq_gaps: report.pcm_seq_gaps }),
    ...(report.render_lag_ms === undefined ? {} : { render_lag_ms: report.render_lag_ms }),
  };
}

/**
 * clock.report（またはその推定の ClockSample）を browser_rtt の clock.sync へ。
 * 変換はここだけに置く。Node の BrowserClockRecorder もこれを使う（二重に持たない）。
 */
export function draftFromClockReport(report: ClockReport | ClockSample): EventDraft {
  return {
    event: 'clock.sync',
    source: 'browser_rtt',
    offset_ms: report.offset_ms,
    error_ms: report.uncertainty_ms,
    rtt_ms: present(report.rtt_ms),
  };
}

/** parameters は signal.command を送った Node 側が覚えている値を渡す。 */
export function draftFromSignalReport(
  report: SignalReport,
  parameters: SignalParameters,
  mapping: TimeMapping,
): EventDraft {
  const common = { candidate_id: report.candidate_id, phase: report.phase, parameters };
  const mapped = report.client_t_ms.value === null ? null : mapping.toServerMs(report.client_t_ms.value);
  if (report.state === 'ended') {
    return {
      event: 'signal.ended',
      ...common,
      visible: report.visible,
      ended_at:
        mapped === null
          ? absent('null_reason' in report.client_t_ms ? report.client_t_ms.null_reason : 'unknown')
          : present(mapped),
    };
  }
  if (report.visible && mapped !== null) {
    return { event: 'signal.started', ...common, visible: true, started_at: mapped };
  }
  return {
    event: 'signal.started',
    ...common,
    visible: false,
    started_at: null,
    null_reason:
      'null_reason' in report.client_t_ms ? report.client_t_ms.null_reason : 'tab_not_visible',
  };
}

export function draftFromVapMessage(message: MaaiVapStateMessage): EventDraft {
  const { type: _type, ...rest } = message;
  return { event: 'vap.state', ...rest };
}

export function draftFromWorkerStatus(
  status: MaaiWorkerStatus,
  system_ch_source: SystemChannelSource,
): EventDraft {
  return {
    event: 'audio.health',
    reporter: 'worker',
    audio_frame: status.audio_frame,
    frames_dropped_network: status.frames_dropped_network,
    frames_dropped_overload: status.frames_dropped_overload,
    queue_depth: status.queue_depth,
    rtf: status.rtf,
    system_ch_source,
  };
}

/** gaze.report を gaze.rendered へ。rendered_at は rAF の時刻を orchestrator の基準へ写した値。 */
export function draftFromGazeReport(report: GazeReport, mapping: TimeMapping): EventDraft {
  if (report.visible && report.client_t_ms.value !== null) {
    return {
      event: 'gaze.rendered',
      target: report.target,
      visible: true,
      rendered_at: Math.max(0, mapping.toServerMs(report.client_t_ms.value)),
    };
  }
  return {
    event: 'gaze.rendered',
    target: report.target,
    visible: false,
    rendered_at: null,
    null_reason: 'null_reason' in report.client_t_ms ? report.client_t_ms.null_reason : 'tab_not_visible',
  };
}
