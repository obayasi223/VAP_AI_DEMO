/**
 * 全二重音声の主スレッド側の入口（計画 §3.2）。音声は主スレッドを通らない。
 * ここがするのは AudioContext とマイクの用意、レイテンシと状態の定期記録、Worker への橋渡しだけ。
 *
 * 必ずクリック（「はじめる」）のハンドラの中で startBrowserAudio を呼ぶこと。
 */
import type { AudioLatency, BrowserToNode, NodeToBrowser, TrackSettings } from '@llm-vap/contracts/browser_rpc';
import type { ClockEstimate } from './clock_sync';
import type {
  ContextStateName,
  LinkState,
  MainToWorker,
  TransportStats,
  VisibilityStateName,
  WorkerToMain,
} from './protocol';

// 主スレッドの束に zod を持ち込まないよう、契約の present/absent と同じ形をここで作る。
const present = <T,>(value: T) => ({ value });
const absent = (null_reason: string) => ({ value: null, null_reason });

export const WORKLET_URL = '/worklets/duplex.worklet.js';
export const WORKER_URL = '/worklets/transport.worker.js';
export const REQUESTED_SAMPLE_RATE_HZ = 48000;
export const MAAI_FRAME_GCD_SAMPLES = 320;
const LATENCY_HISTORY_LIMIT = 600;

export interface LatencySample {
  client_t_ms: number;
  latency: AudioLatency;
}

export interface LifecycleRecord {
  client_t_ms: number;
  kind: 'statechange' | 'visibilitychange' | 'resume_failed' | 'track_ended' | 'processor_error';
  value: string;
}

export interface BrowserAudioOptions {
  wsUrl: string;
  /** 再接続などで既存セッションを続けるとき。 */
  sessionId?: string | null;
  /** 既定 320（20ms）。MaAI の frame 周期（1280、1600）の約数に限る（計画 §3.2）。 */
  frameSamples?: number;
  /** ジッタバッファ。これだけたまってから再生を始める。アンダーラン後も同じ。既定 60ms。 */
  prebufferMs?: number;
  latencySampleIntervalMs?: number;
  reportIntervalMs?: number;
  positionIntervalMs?: number;
  clockIntervalMs?: number;
  /** 上りの滞留がこれを超えたら枠を棄てて欠損として数える。既定 32KB（約 500ms）。 */
  maxUplinkBufferedBytes?: number;
  /** 試験用。マイクの代わりの入力。これを渡すと getUserMedia を呼ばない。 */
  inputSource?: (context: AudioContext, processor: AudioWorkletNode) => AudioNode | null;
  onMessage?: (message: NodeToBrowser) => void;
  onSent?: (message: BrowserToNode) => void;
  onLink?: (state: LinkState, detail: string) => void;
  onStats?: (stats: TransportStats) => void;
  onClock?: (estimate: ClockEstimate) => void;
  onLifecycle?: (record: LifecycleRecord) => void;
  onError?: (detail: string) => void;
}

export interface BrowserAudioSession {
  readonly context: AudioContext;
  /** AudioWorkletNode。口の音量などは AnalyserNode をここへつなぐ（再生音のみが出る）。 */
  readonly outputNode: AudioWorkletNode;
  readonly sampleRateHz: number;
  readonly trackSettings: TrackSettings;
  /** 同じ WS で JSON を送る。signal.report、gaze.report 用。切断中は溜めて再接続後に送る。 */
  send(message: BrowserToNode): void;
  /** client_t_ms の時間軸（主スレッドの performance.now）。rAF の時刻と同じ軸。 */
  nowClientMs(): number;
  /** 最新の時計差。server_t = client_t + offset_ms。 */
  clockEstimate(): ClockEstimate | null;
  stats(): TransportStats | null;
  latencyHistory(): readonly LatencySample[];
  lifecycleHistory(): readonly LifecycleRecord[];
  stop(): Promise<void>;
}

export function collectLatency(context: AudioContext): AudioLatency {
  const base = context.baseLatency;
  const output = context.outputLatency;
  let timestamp: AudioTimestamp | null = null;
  try {
    timestamp = context.getOutputTimestamp();
  } catch {
    timestamp = null;
  }
  const pick = (value: number | undefined, seconds: boolean) => {
    if (value === undefined || !Number.isFinite(value)) return absent('not_supported_by_browser');
    if (value < 0) return absent('browser_returned_negative');
    return present(seconds ? value * 1000 : value);
  };
  return {
    base_latency_ms: pick(base, true),
    output_latency_ms: pick(output, true),
    output_timestamp_context_ms: pick(timestamp?.contextTime, true),
    output_timestamp_performance_ms: pick(timestamp?.performanceTime, false),
  };
}

export function readTrackSettings(track: MediaStreamTrack | null, reason: string): TrackSettings {
  if (track === null) {
    return {
      echoCancellation: absent(reason),
      noiseSuppression: absent(reason),
      autoGainControl: absent(reason),
      sampleRate: absent(reason),
      channelCount: absent(reason),
      deviceId: absent(reason),
      latency: absent(reason),
    };
  }
  const settings = track.getSettings();
  const wrap = <T,>(value: T | undefined) =>
    value === undefined ? absent('not_reported_by_browser') : present(value);
  return {
    echoCancellation: wrap(settings.echoCancellation),
    noiseSuppression: wrap(settings.noiseSuppression),
    autoGainControl: wrap(settings.autoGainControl),
    sampleRate: wrap(settings.sampleRate),
    channelCount: wrap(settings.channelCount),
    deviceId: wrap(settings.deviceId),
    // MediaTrackSettings.latency（秒）。Chrome は返すが型定義にないことがある。
    latency: wrap((settings as MediaTrackSettings & { latency?: number }).latency),
  };
}

function visibilityNow(): VisibilityStateName {
  return document.visibilityState === 'hidden' ? 'hidden' : 'visible';
}

/** 「はじめる」のクリックの中で呼ぶ。 */
export async function startBrowserAudio(options: BrowserAudioOptions): Promise<BrowserAudioSession> {
  const frameSamples = options.frameSamples ?? MAAI_FRAME_GCD_SAMPLES;
  if (!Number.isInteger(frameSamples) || frameSamples <= 0 || MAAI_FRAME_GCD_SAMPLES % frameSamples !== 0) {
    throw new Error(`frameSamples must divide ${MAAI_FRAME_GCD_SAMPLES}, got ${frameSamples}`);
  }
  // 自動再生の制限があるので、await の前に作って resume する。
  const context = new AudioContext({
    sampleRate: REQUESTED_SAMPLE_RATE_HZ,
    latencyHint: 'interactive',
  });
  const resumed = context.resume();

  let stream: MediaStream | null = null;
  let track: MediaStreamTrack | null = null;
  try {
    if (options.inputSource === undefined) {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
          sampleRate: REQUESTED_SAMPLE_RATE_HZ,
        },
        video: false,
      });
      track = stream.getAudioTracks()[0] ?? null;
    }
    await context.audioWorklet.addModule(WORKLET_URL);
  } catch (error) {
    stream?.getTracks().forEach((t) => t.stop());
    await context.close();
    throw error;
  }
  await resumed;

  const node = new AudioWorkletNode(context, 'duplex-audio-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    channelCount: 1,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers',
    processorOptions: { frameSamples, prebufferMs: options.prebufferMs ?? 60 },
  });
  const source =
    options.inputSource !== undefined
      ? options.inputSource(context, node)
      : context.createMediaStreamSource(stream as MediaStream);
  source?.connect(node);
  node.connect(context.destination);

  const trackSettings = readTrackSettings(
    track,
    options.inputSource !== undefined ? 'test_input_source' : 'no_audio_track',
  );

  let latestStats: TransportStats | null = null;
  let latestClock: ClockEstimate | null = null;
  const latencies: LatencySample[] = [];
  const lifecycle: LifecycleRecord[] = [];
  let stopped = false;

  const worker = new Worker(WORKER_URL, { type: 'module', name: 'audio-transport' });
  const post = (message: MainToWorker, transfer: Transferable[] = []) => worker.postMessage(message, transfer);

  const record = (kind: LifecycleRecord['kind'], value: string) => {
    const entry: LifecycleRecord = { client_t_ms: performance.now(), kind, value };
    lifecycle.push(entry);
    options.onLifecycle?.(entry);
  };

  worker.onmessage = (event: MessageEvent<WorkerToMain>) => {
    const message = event.data;
    switch (message.t) {
      case 'link':
        options.onLink?.(message.state, message.detail);
        break;
      case 'message':
        options.onMessage?.(message.message);
        break;
      case 'sent':
        options.onSent?.(message.message);
        break;
      case 'stats':
        latestStats = message.stats;
        options.onStats?.(message.stats);
        break;
      case 'clock':
        latestClock = message.estimate;
        options.onClock?.(message.estimate);
        break;
      case 'error':
        options.onError?.(message.detail);
        break;
    }
  };
  worker.onerror = (event) => options.onError?.(`worker error: ${event.message}`);
  node.onprocessorerror = () => {
    record('processor_error', 'AudioWorkletProcessor threw');
    options.onError?.('AudioWorkletProcessor threw');
  };

  const sampleLatency = () => {
    const latency = collectLatency(context);
    latencies.push({ client_t_ms: performance.now(), latency });
    if (latencies.length > LATENCY_HISTORY_LIMIT) latencies.shift();
    return latency;
  };

  const tryResume = () => {
    if (stopped || context.state === 'running' || context.state === 'closed') return;
    context.resume().catch((error: unknown) => record('resume_failed', String(error)));
  };

  // 'interrupted' は Safari 系。型にないので string として受ける。
  const stateNow = () => context.state as string as ContextStateName;
  const onStateChange = () => {
    record('statechange', stateNow());
    post({ t: 'context_state', state: stateNow() });
    tryResume();
  };
  const onVisibility = () => {
    record('visibilitychange', visibilityNow());
    post({ t: 'visibility', visibility: visibilityNow() });
    if (visibilityNow() === 'visible') tryResume();
  };
  context.addEventListener('statechange', onStateChange);
  document.addEventListener('visibilitychange', onVisibility);
  track?.addEventListener('ended', () => {
    record('track_ended', track?.label ?? '');
    options.onError?.('microphone track ended');
  });

  const channel = new MessageChannel();
  node.port.postMessage({ t: 'connect' }, [channel.port2]);
  post(
    {
      t: 'init',
      worklet: channel.port1,
      init: {
        url: options.wsUrl,
        mainTimeOrigin: performance.timeOrigin,
        sessionId: options.sessionId ?? null,
        sampleRateHz: context.sampleRate,
        frameSamples,
        trackSettings,
        latency: sampleLatency(),
        contextState: stateNow(),
        visibility: visibilityNow(),
        userAgent: navigator.userAgent,
        reportIntervalMs: options.reportIntervalMs ?? 1000,
        positionIntervalMs: options.positionIntervalMs ?? 100,
        clockIntervalMs: options.clockIntervalMs ?? 5000,
        maxUplinkBufferedBytes: options.maxUplinkBufferedBytes ?? 32 * 1024,
      },
    },
    [channel.port1],
  );

  const latencyTimer = setInterval(() => {
    post({ t: 'latency', latency: sampleLatency() });
  }, options.latencySampleIntervalMs ?? 1000);

  return {
    context,
    outputNode: node,
    sampleRateHz: context.sampleRate,
    trackSettings,
    send: (message) => post({ t: 'send', message }),
    nowClientMs: () => performance.now(),
    clockEstimate: () => latestClock,
    stats: () => latestStats,
    latencyHistory: () => latencies,
    lifecycleHistory: () => lifecycle,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      clearInterval(latencyTimer);
      context.removeEventListener('statechange', onStateChange);
      document.removeEventListener('visibilitychange', onVisibility);
      post({ t: 'shutdown' });
      stream?.getTracks().forEach((t) => t.stop());
      node.disconnect();
      await context.close();
    },
  };
}
