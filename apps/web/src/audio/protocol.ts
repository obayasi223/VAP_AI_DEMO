/** Main↔Worker↔Worklet の内部メッセージ。外部契約（browser_rpc、binary）とは別。 */
import type {
  AudioLatency,
  BrowserToNode,
  NodeToBrowser,
  PlaybackStopMode,
  TrackSettings,
} from '@llm-vap/contracts/browser_rpc';
import type { PlaybackEndReason } from './dsp/playback_scheduler';
import type { ClockEstimate } from './clock_sync';

export type ContextStateName = 'suspended' | 'running' | 'closed' | 'interrupted';
export type VisibilityStateName = 'visible' | 'hidden';

// ---- Worker → Worklet ---------------------------------------------------------
export type ToWorklet =
  | { t: 'capture_start' }
  | { t: 'begin'; id: number; gen: number }
  | { t: 'pcm'; id: number; gen: number; frames: Float32Array; eos: boolean }
  | { t: 'stop'; id: number; gen: number; stop: PlaybackStopMode }
  | { t: 'input_lost' }
  | { t: 'reset' };

// ---- Worklet → Worker ---------------------------------------------------------
export type FromWorklet =
  | {
      t: 'frame';
      audio_frame: number;
      mic: Int16Array;
      sys: Int16Array;
      /** この枠を送った量子の終わりのコンテキストフレーム。 */
      render_frame: number;
      /** 現在の audio_frame（量子の終わり）。 */
      head_audio_frame: number;
      /** id=0 は再生なし。 */
      pos_id: number;
      pos_gen: number;
      pos_written: number;
      pos_buffered: number;
      underrun_count: number;
      underrun_frames: number;
      stale_chunks: number;
      orphan_chunks: number;
    }
  | { t: 'started'; id: number; gen: number; render_frame: number; audio_frame: number }
  | {
      t: 'ended';
      id: number;
      gen: number;
      reason: PlaybackEndReason;
      written: number;
      discarded: number;
      render_frame: number;
      audio_frame: number;
    };

// ---- Main → Worker ------------------------------------------------------------
export interface TransportInit {
  url: string;
  /** 主スレッドの performance.timeOrigin。時間軸の測定が届くまでの代用（ThreadAxisEstimator が優先）。 */
  mainTimeOrigin: number;
  sessionId: string | null;
  sampleRateHz: number;
  frameSamples: number;
  trackSettings: TrackSettings;
  latency: AudioLatency;
  contextState: ContextStateName;
  visibility: VisibilityStateName;
  userAgent: string;
  reportIntervalMs: number;
  positionIntervalMs: number;
  clockIntervalMs: number;
  maxUplinkBufferedBytes: number;
}

export type MainToWorker =
  | { t: 'init'; init: TransportInit; worklet: MessagePort }
  | { t: 'latency'; latency: AudioLatency }
  | { t: 'context_state'; state: ContextStateName }
  | { t: 'visibility'; visibility: VisibilityStateName }
  | { t: 'send'; message: BrowserToNode }
  | { t: 'axis_pong'; worker_t_ms: number; main_t_ms: number }
  | { t: 'shutdown' };

// ---- Worker → Main ------------------------------------------------------------
export type LinkState = 'connecting' | 'open' | 'ready' | 'closed';

export interface TransportStats {
  link: LinkState;
  reconnects: number;
  frames_sent: number;
  frames_lost: number;
  underrun_count: number;
  underrun_total_ms: number;
  stale_pcm_frames_dropped: number;
  stale_control_messages: number;
  orphan_pcm_frames: number;
  pcm_seq_gaps: number;
  pcm_rate_mismatches: number;
  bad_frames: number;
  rpc_errors: number;
  audio_frame: number;
  render_lag_ms: number;
  worklet_arrival_delay_ms: number;
  /** 主スレッドと Worker の時間軸の測定（ThreadAxisEstimator）。skew_ms は timeOrigin の引き算との差（観測用）。 */
  thread_axis: { offset_ms: number; rtt_ms: number; skew_ms: number } | null;
}

export type WorkerToMain =
  | { t: 'link'; state: LinkState; detail: string }
  | { t: 'message'; message: NodeToBrowser }
  | { t: 'sent'; message: BrowserToNode }
  | { t: 'stats'; stats: TransportStats }
  | { t: 'clock'; estimate: ClockEstimate }
  | { t: 'axis_ping'; worker_t_ms: number }
  | { t: 'error'; detail: string };
