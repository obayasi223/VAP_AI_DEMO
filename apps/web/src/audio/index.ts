/** ブラウザ音声の公開入口（レーン A）。 */
export {
  startBrowserAudio,
  collectLatency,
  readTrackSettings,
  WORKER_URL,
  WORKLET_URL,
  type BrowserAudioOptions,
  type BrowserAudioSession,
  type LatencySample,
  type LifecycleRecord,
} from './engine';
export type { ClockEstimate } from './clock_sync';
export type { LinkState, TransportStats } from './protocol';
