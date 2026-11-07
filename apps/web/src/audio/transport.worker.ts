/**
 * WS 専用 Worker（計画 §3.2）。Worklet とは MessagePort で直結し、音声は主スレッドを通らない。
 * ビルド: `npm run build:audio -w @llm-vap/web` → public/worklets/transport.worker.js
 *
 * 時間軸: 送る client_t_ms はすべて **主スレッドの performance.now() の時間軸**。rAF の時刻
 * （signal.report、gaze.report）や getOutputTimestamp() と同じ軸なので、1つの時計差で補正できる。
 */
import { BROWSER_RPC_PROTOCOL_VERSION, BrowserToNode, NodeToBrowser } from '@llm-vap/contracts/browser_rpc';
import type { AudioLatency, PlaybackBegin, PlaybackStop } from '@llm-vap/contracts/browser_rpc';
import { absent, present } from '@llm-vap/contracts/common';
import {
  SAMPLE_RATE_HZ,
  decodePcmFrame,
  encodeAudioFrame,
  isStaleGeneration,
  peekFrameKind,
  type PcmFrame,
} from '@llm-vap/contracts/binary';
import { ClockEstimator, RenderClock } from './clock_sync';
import { PolyphaseResampler, designResampler, type ResamplerDesign } from './dsp/resampler';
import type {
  FromWorklet,
  LinkState,
  MainToWorker,
  ToWorklet,
  TransportInit,
  TransportStats,
  WorkerToMain,
} from './protocol';

interface WorkerScope {
  onmessage: ((event: MessageEvent<MainToWorker>) => void) | null;
  postMessage(message: WorkerToMain): void;
  close(): void;
}
const scope = self as unknown as WorkerScope;

const MAX_PENDING_CONTROL = 256;
const CLOCK_BURST = 6;
const CLOCK_BURST_INTERVAL_MS = 100;
const RECONNECT_MIN_MS = 250;
const RECONNECT_MAX_MS = 5000;

interface PlaybackInput {
  gen: number;
  rate: number;
  resampler: PolyphaseResampler;
  nextSeq: number;
}

let init: TransportInit | null = null;
let worklet: MessagePort | null = null;
let socket: WebSocket | null = null;
let link: LinkState = 'closed';
let shuttingDown = false;
let reconnectDelay = RECONNECT_MIN_MS;
let captureStarted = false;
let sessionId: string | null = null;
let generation = 0;
let latency: AudioLatency | null = null;
let contextState: TransportInit['contextState'] = 'suspended';
let visibility: TransportInit['visibility'] = 'visible';
let renderClock: RenderClock | null = null;
const clock = new ClockEstimator();
let pingSeq = 0;
let burstLeft = 0;
let clockTimer: ReturnType<typeof setTimeout> | null = null;
let lastPositionSent = -Infinity;

const inputs = new Map<number, PlaybackInput>();
const designs = new Map<number, ResamplerDesign>();
const pendingControl: BrowserToNode[] = [];

const counters = {
  reconnects: 0,
  frames_sent: 0,
  frames_lost: 0,
  stale_worker: 0,
  stale_control: 0,
  orphan_worker: 0,
  pcm_seq_gaps: 0,
  pcm_rate_mismatches: 0,
  bad_frames: 0,
  rpc_errors: 0,
};
const workletCounters = { underrun_count: 0, underrun_frames: 0, stale_chunks: 0, orphan_chunks: 0 };
let latestAudioFrame = 0;
let expectedAudioFrame: number | null = null;

function clientNow(): number {
  const originMs = init === null ? performance.timeOrigin : init.mainTimeOrigin;
  return Math.max(0, performance.timeOrigin + performance.now() - originMs);
}

function toMain(message: WorkerToMain): void {
  scope.postMessage(message);
}

function toWorklet(message: ToWorklet, transfer: Transferable[] = []): void {
  worklet?.postMessage(message, transfer);
}

function setLink(state: LinkState, detail = ''): void {
  link = state;
  toMain({ t: 'link', state, detail });
}

function sendJson(message: BrowserToNode): boolean {
  const parsed = BrowserToNode.safeParse(message);
  if (!parsed.success) {
    counters.rpc_errors++;
    toMain({ t: 'error', detail: `outgoing ${message.type} violates contract: ${parsed.error.message}` });
    return false;
  }
  if (socket === null || socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(parsed.data));
  toMain({ t: 'sent', message: parsed.data });
  return true;
}

/** 切断中も失いたくない報告は溜め、再接続後に順に送る。 */
function sendControl(message: BrowserToNode): void {
  if (link !== 'ready' || !sendJson(message)) {
    pendingControl.push(message);
    if (pendingControl.length > MAX_PENDING_CONTROL) {
      pendingControl.shift();
      counters.rpc_errors++;
    }
  }
}

function outputLatencyField(): AudioLatency['output_latency_ms'] {
  return latency === null ? absent('not_measured_yet') : latency.output_latency_ms;
}

function clientTimeOfFrame(renderFrame: number): number {
  return Math.max(0, renderClock?.toClientMs(renderFrame) ?? clientNow());
}

function toAudioSamples(contextFrames: number): number {
  if (init === null) return 0;
  return Math.floor((contextFrames * SAMPLE_RATE_HZ) / init.sampleRateHz);
}

function stats(): TransportStats {
  const rate = init?.sampleRateHz ?? SAMPLE_RATE_HZ;
  return {
    link,
    reconnects: counters.reconnects,
    frames_sent: counters.frames_sent,
    frames_lost: counters.frames_lost,
    underrun_count: workletCounters.underrun_count,
    underrun_total_ms: (workletCounters.underrun_frames * 1000) / rate,
    stale_pcm_frames_dropped: counters.stale_worker + workletCounters.stale_chunks,
    stale_control_messages: counters.stale_control,
    orphan_pcm_frames: counters.orphan_worker + workletCounters.orphan_chunks,
    pcm_seq_gaps: counters.pcm_seq_gaps,
    pcm_rate_mismatches: counters.pcm_rate_mismatches,
    bad_frames: counters.bad_frames,
    rpc_errors: counters.rpc_errors,
    audio_frame: latestAudioFrame,
    render_lag_ms: renderClock?.renderLagMs ?? 0,
    worklet_arrival_delay_ms: renderClock?.arrivalDelayMs ?? 0,
  };
}

function sendAudioReport(): void {
  if (init === null || latency === null) return;
  const s = stats();
  toMain({ t: 'stats', stats: s });
  if (link !== 'ready') return;
  sendJson({
    type: 'audio.report',
    client_t_ms: clientNow(),
    audio_frame: latestAudioFrame,
    frames_lost: s.frames_lost,
    underrun_count: s.underrun_count,
    underrun_total_ms: s.underrun_total_ms,
    stale_pcm_frames_dropped: s.stale_pcm_frames_dropped,
    latency,
    track_settings: init.trackSettings,
    system_ch_source: 'written',
    audio_context_state: contextState,
    visibility,
  });
}

// ---- 時計差 -------------------------------------------------------------------

function sendPing(): void {
  sendJson({ type: 'clock.ping', seq: pingSeq++, client_t_ms: clientNow() });
}

function clockTick(): void {
  if (link !== 'ready' || init === null) return;
  sendPing();
  burstLeft = Math.max(0, burstLeft - 1);
  clockTimer = setTimeout(clockTick, burstLeft > 0 ? CLOCK_BURST_INTERVAL_MS : init.clockIntervalMs);
}

function startClock(): void {
  if (clockTimer !== null) clearTimeout(clockTimer);
  clock.reset();
  burstLeft = CLOCK_BURST;
  clockTick();
}

// ---- 下り -------------------------------------------------------------------

function designFor(rate: number): ResamplerDesign {
  let design = designs.get(rate);
  if (!design) {
    if (init === null) throw new Error('worker not initialised');
    design = designResampler(rate, init.sampleRateHz);
    designs.set(rate, design);
  }
  return design;
}

function advanceGeneration(gen: number): void {
  if (gen <= generation) return;
  generation = gen;
  for (const [id, input] of inputs) {
    if (input.gen < gen) inputs.delete(id);
  }
}

function onBegin(message: PlaybackBegin): void {
  if (isStaleGeneration(message.generation, generation)) {
    counters.stale_control++;
    return;
  }
  advanceGeneration(message.generation);
  inputs.set(message.audio_playback_id, {
    gen: message.generation,
    rate: message.sample_rate_hz,
    resampler: new PolyphaseResampler(designFor(message.sample_rate_hz)),
    nextSeq: 0,
  });
  toWorklet({ t: 'begin', id: message.audio_playback_id, gen: message.generation });
}

function onStop(message: PlaybackStop): void {
  if (isStaleGeneration(message.generation, generation)) {
    counters.stale_control++;
    return;
  }
  // 緩やかな停止では、変換器に残った数ミリ秒も流せるように先に押し出す。
  const target = inputs.get(message.audio_playback_id);
  if (target && message.stop.mode !== 'immediate') {
    const tail = target.resampler.flush();
    if (tail.length > 0) {
      const copy = tail.slice();
      toWorklet(
        { t: 'pcm', id: message.audio_playback_id, gen: target.gen, frames: copy, eos: false },
        [copy.buffer],
      );
    }
  }
  inputs.delete(message.audio_playback_id);
  advanceGeneration(message.generation);
  toWorklet({
    t: 'stop',
    id: message.audio_playback_id,
    gen: message.generation,
    stop: message.stop,
  });
}

function onPcm(frame: PcmFrame): void {
  if (isStaleGeneration(frame.generation, generation)) {
    counters.stale_worker++;
    return;
  }
  advanceGeneration(frame.generation);
  const input = inputs.get(frame.audio_playback_id);
  if (!input || input.gen !== frame.generation) {
    counters.orphan_worker++;
    return;
  }
  if (frame.sample_rate_hz !== input.rate) {
    counters.pcm_rate_mismatches++;
    return;
  }
  if (frame.seq !== input.nextSeq) counters.pcm_seq_gaps++;
  input.nextSeq = frame.seq + 1;

  const floats = new Float32Array(frame.sample_count);
  for (let i = 0; i < frame.sample_count; i++) floats[i] = (frame.pcm[i] as number) / 32768;
  const out = new Float32Array(input.resampler.maxOutput(frame.sample_count));
  const count = input.resampler.process(floats, 0, frame.sample_count, out, 0);
  let frames: Float32Array;
  if (frame.end_of_stream) {
    const tail = input.resampler.flush();
    frames = new Float32Array(count + tail.length);
    frames.set(out.subarray(0, count), 0);
    frames.set(tail, count);
    inputs.delete(frame.audio_playback_id);
  } else {
    frames = out.slice(0, count);
  }
  toWorklet(
    { t: 'pcm', id: frame.audio_playback_id, gen: frame.generation, frames, eos: frame.end_of_stream },
    [frames.buffer],
  );
}

function onServerHello(helloSession: string): void {
  if (sessionId !== null && sessionId !== helloSession) {
    generation = 0;
    inputs.clear();
    toWorklet({ t: 'reset' });
  }
  sessionId = helloSession;
  setLink('ready');
  if (!captureStarted) {
    captureStarted = true;
    toWorklet({ t: 'capture_start' });
  }
  startClock();
  const queued = pendingControl.splice(0, pendingControl.length);
  for (const message of queued) sendJson(message);
  sendAudioReport();
}

function onJson(text: string): void {
  let parsed: ReturnType<typeof NodeToBrowser.safeParse>;
  try {
    parsed = NodeToBrowser.safeParse(JSON.parse(text));
  } catch {
    counters.rpc_errors++;
    return;
  }
  if (!parsed.success) {
    counters.rpc_errors++;
    toMain({ t: 'error', detail: `incoming message violates contract: ${parsed.error.message}` });
    return;
  }
  const message = parsed.data;
  switch (message.type) {
    case 'clock.pong': {
      const estimate = clock.add(message.client_t_ms, message.server_t_ms, clientNow());
      if (estimate !== null) toMain({ t: 'clock', estimate });
      return; // 主スレッドへは転送しない
    }
    case 'server.hello':
      onServerHello(message.session_id);
      break;
    case 'playback.begin':
      onBegin(message);
      break;
    case 'playback.stop':
      onStop(message);
      break;
    default:
      break;
  }
  toMain({ t: 'message', message });
}

function onSocketMessage(event: MessageEvent): void {
  if (typeof event.data === 'string') {
    onJson(event.data);
    return;
  }
  try {
    const data = event.data as ArrayBuffer;
    if (peekFrameKind(data) !== 'pcm') {
      counters.bad_frames++;
      return;
    }
    onPcm(decodePcmFrame(data));
  } catch (error) {
    counters.bad_frames++;
    toMain({ t: 'error', detail: `bad binary frame: ${String(error)}` });
  }
}

// ---- 上り -------------------------------------------------------------------

function onWorklet(event: MessageEvent<FromWorklet>): void {
  const message = event.data;
  if (message.t === 'frame') {
    onFrame(message);
    return;
  }
  if (message.t === 'started') {
    sendControl({
      type: 'playback.started',
      audio_playback_id: message.id,
      generation: message.gen,
      audio_frame: message.audio_frame,
      client_t_ms: clientTimeOfFrame(message.render_frame),
      output_latency_ms: outputLatencyField(),
    });
    return;
  }
  sendControl({
    type: 'playback.ended',
    audio_playback_id: message.id,
    generation: message.gen,
    reason: message.reason,
    samples_written: toAudioSamples(message.written),
    samples_discarded: toAudioSamples(message.discarded),
    audio_frame: message.audio_frame,
    client_t_ms: clientTimeOfFrame(message.render_frame),
    output_latency_ms: outputLatencyField(),
  });
}

function onFrame(message: Extract<FromWorklet, { t: 'frame' }>): void {
  if (init === null) return;
  const now = clientNow();
  renderClock?.observe(message.render_frame, now);
  latestAudioFrame = message.head_audio_frame;
  workletCounters.underrun_count = message.underrun_count;
  workletCounters.underrun_frames = message.underrun_frames;
  workletCounters.stale_chunks = message.stale_chunks;
  workletCounters.orphan_chunks = message.orphan_chunks;

  if (expectedAudioFrame !== null && message.audio_frame !== expectedAudioFrame) {
    counters.frames_lost += Math.max(
      0,
      Math.round((message.audio_frame - expectedAudioFrame) / init.frameSamples),
    );
  }
  expectedAudioFrame = message.audio_frame + init.frameSamples;

  const open = socket !== null && socket.readyState === WebSocket.OPEN && link === 'ready';
  if (open && (socket as WebSocket).bufferedAmount <= init.maxUplinkBufferedBytes) {
    (socket as WebSocket).send(
      encodeAudioFrame({ audio_frame: message.audio_frame, mic: message.mic, sys: message.sys }),
    );
    counters.frames_sent++;
  } else {
    // 番号は進むので、Node 側は欠損として扱える（計画 §3.3）。
    counters.frames_lost++;
  }

  if (message.pos_id !== 0 && link === 'ready' && now - lastPositionSent >= init.positionIntervalMs) {
    lastPositionSent = now;
    sendJson({
      type: 'playback.position',
      audio_playback_id: message.pos_id,
      generation: message.pos_gen,
      samples_written: toAudioSamples(message.pos_written),
      samples_buffered: toAudioSamples(message.pos_buffered),
      audio_frame: message.head_audio_frame,
      client_t_ms: clientTimeOfFrame(message.render_frame),
      output_latency_ms: outputLatencyField(),
      system_ch_source: 'written',
    });
  }
}

// ---- 接続 -------------------------------------------------------------------

function connect(): void {
  if (init === null || shuttingDown) return;
  setLink('connecting');
  const ws = new WebSocket(init.url);
  ws.binaryType = 'arraybuffer';
  socket = ws;
  ws.onopen = () => {
    reconnectDelay = RECONNECT_MIN_MS;
    setLink('open');
    if (init === null || latency === null) return;
    sendJson({
      type: 'client.hello',
      protocol_version: BROWSER_RPC_PROTOCOL_VERSION,
      session_id: sessionId === null ? absent('new_session') : present(sessionId),
      audio_context_sample_rate_hz: init.sampleRateHz,
      frame_samples: init.frameSamples,
      track_settings: init.trackSettings,
      latency,
      user_agent: init.userAgent,
    });
  };
  ws.onmessage = onSocketMessage;
  ws.onclose = (event) => {
    if (socket !== ws) return;
    socket = null;
    setLink('closed', `code=${event.code}`);
    if (clockTimer !== null) clearTimeout(clockTimer);
    inputs.clear();
    toWorklet({ t: 'input_lost' });
    if (shuttingDown) return;
    counters.reconnects++;
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
  };
}

scope.onmessage = (event: MessageEvent<MainToWorker>) => {
  const message = event.data;
  switch (message.t) {
    case 'init':
      init = message.init;
      worklet = message.worklet;
      latency = message.init.latency;
      contextState = message.init.contextState;
      visibility = message.init.visibility;
      sessionId = message.init.sessionId;
      renderClock = new RenderClock(message.init.sampleRateHz);
      worklet.onmessage = onWorklet;
      setInterval(sendAudioReport, message.init.reportIntervalMs);
      connect();
      break;
    case 'latency':
      latency = message.latency;
      break;
    case 'context_state':
      contextState = message.state;
      sendAudioReport();
      break;
    case 'visibility':
      visibility = message.visibility;
      sendAudioReport();
      break;
    case 'send':
      sendControl(message.message);
      break;
    case 'shutdown':
      shuttingDown = true;
      sendAudioReport();
      socket?.close();
      scope.close();
      break;
  }
};
