/**
 * MaaiWorkerClient。ワーカーは本物の Python プロセスと RPC サーバーで、エンジンだけ test double
 * （is_fake=true、FAKE_NOT_MAAI）。実 MaAI は real_worker.test.ts。
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  FAKE_MODEL_VARIANT,
  MaaiConfigure,
  MemoryEventSink,
  createEventEmitter,
  SystemTimeSource,
  type MaaiFramesDropped,
  type MaaiVapStateMessage,
  type ResearchEvent,
} from '@llm-vap/contracts';
import path from 'node:path';
import { WorkerClockRecorder } from '../../src/logging';
import {
  MaaiWorkerClient,
  WORKER_DIR,
  attachMaaiEventBridge,
  buildMaaiConfigure,
  loadMaaiSessionConfig,
  portFromWorkerUrl,
  realMaaiLaunch,
  workerEnv,
  type MaaiAvailability,
} from '../../src/maai';
import { crc32, noise, scriptedClient, scriptedLaunch, sleep, until } from './worker_process';

const clients: MaaiWorkerClient[] = [];

function track(client: MaaiWorkerClient) {
  clients.push(client);
  const history: MaaiAvailability[] = [];
  const vap: MaaiVapStateMessage[] = [];
  const drops: MaaiFramesDropped[] = [];
  client.subscribe({
    onAvailability: (a) => history.push(a),
    onVapState: (m) => vap.push(m),
    onFramesDropped: (m) => drops.push(m),
  });
  return { history, vap, drops };
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.stop('test_end')));
});

async function stream(client: MaaiWorkerClient, mic: Int16Array, sys: Int16Array, start = 0, paceMs = 5) {
  for (let i = 0; i + 320 <= mic.length; i += 320) {
    client.sendAudio({ audio_frame: start + i, mic: mic.subarray(i, i + 320), sys: sys.subarray(i, i + 320) });
    if (paceMs > 0) await sleep(paceMs);
  }
}

/** 契約を破る相手。実物のワーカーでは起こせない分岐を試す。 */
const STUB = `
import asyncio, json, sys
from websockets.asyncio.server import serve
REPLY = sys.argv[1]
async def handler(ws):
    await ws.recv()
    await ws.send(REPLY)
    await asyncio.sleep(30)
async def main():
    server = await serve(handler, "127.0.0.1", 0, compression=None)
    print(json.dumps({"event": "listening", "port": server.sockets[0].getsockname()[1]}), flush=True)
    await asyncio.sleep(60)
asyncio.run(main())
`;
const READY_WRONG_RATE = JSON.stringify({
  type: 'READY', protocol_version: 1, maai_version: 'x', checkpoint: 'x', lang: 'jp_kyoto', model_type: 'normal-ver2',
  channel_layout: '2ch', frame_rate_hz: 10, device: 'cpu', is_fake: true,
});
const GARBAGE = JSON.stringify({ type: 'VAP_STATE', p_now: 'high' });

function stubWorker(reply: string) {
  return { ...scriptedLaunch(), args: ['-c', STUB, reply] };
}

describe('startup', () => {
  it('reports starting, loading, then ready, and identifies the double', async () => {
    const client = scriptedClient({ launch: scriptedLaunch() });
    const { history } = track(client);
    const availability = await client.start('s1');
    expect(availability).toMatchObject({ state: 'ready', vap_available: true, is_fake: true });
    expect(history.map((h) => h.state).slice(0, 3)).toEqual(['starting', 'loading', 'ready']);
    expect(client.ready()).toMatchObject({ checkpoint: FAKE_MODEL_VARIANT, is_fake: true });
  });

  it('refuses a fake worker on the production path', async () => {
    const client = scriptedClient({ launch: scriptedLaunch(), allowFake: false });
    const { history } = track(client);
    const availability = await client.start('s1');
    expect(availability).toMatchObject({ state: 'down', vap_available: false, gave_up: true });
    expect(availability.reason).toContain('fake_worker_refused');
    expect(history.some((h) => h.vap_available)).toBe(false);
    expect(client.providerClass).toBe('production');
  });

  it('marks test double sessions as test_double', () => {
    expect(scriptedClient({ launch: scriptedLaunch() }).providerClass).toBe('test_double');
  });

  it('does not retry a model load failure and says why', async () => {
    const client = scriptedClient({ launch: scriptedLaunch('--fail-load') });
    track(client);
    const availability = await client.start('s1');
    expect(availability).toMatchObject({ state: 'down', gave_up: true, restart_attempt: 0 });
    expect(availability.reason).toContain('model_load');
  });

  it('names a missing python executable', async () => {
    const launch = { ...scriptedLaunch(), command: '/nonexistent/python' };
    const client = scriptedClient({ launch });
    track(client);
    const availability = await client.start('s1');
    expect(availability).toMatchObject({ state: 'down', gave_up: true });
    expect(availability.reason).toContain('spawn_failed');
  });

  it('gives up after retrying a worker that exits at startup, keeping the reason', async () => {
    const launch = { ...scriptedLaunch(), args: ['-c', 'import sys; print("no such module", file=sys.stderr); sys.exit(7)'] };
    const client = scriptedClient({ launch });
    const { history } = track(client);
    const availability = await client.start('s1');
    expect(availability).toMatchObject({ state: 'down', gave_up: true, restart_attempt: 2 });
    expect(availability.reason).toContain('code=7');
    expect(availability.reason).toContain('no such module');
    expect(history.filter((h) => h.state === 'starting')).toHaveLength(3);
  });

  it('諦めた後の新しいセッション（reconfigure）では、回数を数え直してもう一度起動を試みる', async () => {
    const launch = { ...scriptedLaunch(), args: ['-c', 'import sys; sys.exit(7)'] };
    const client = scriptedClient({ launch });
    const { history } = track(client);
    expect(await client.start('s1')).toMatchObject({ gave_up: true });
    const startsBefore = history.filter((h) => h.state === 'starting').length;
    const again = await client.reconfigure('s2');
    expect(again).toMatchObject({ state: 'down', gave_up: true, restart_attempt: 2 });
    expect(history.filter((h) => h.state === 'starting').length).toBe(startsBefore + 3);
  });

  it('refuses a READY that does not match the request', async () => {
    const client = scriptedClient({ launch: stubWorker(READY_WRONG_RATE) });
    track(client);
    const availability = await client.start('s1');
    expect(availability).toMatchObject({ state: 'down', gave_up: true, vap_available: false });
    expect(availability.reason).toContain('ready_mismatch: frame_rate_hz');
  });

  it('treats a message outside the contract as a failure, not as data', async () => {
    const client = scriptedClient({ launch: stubWorker(GARBAGE), restart: { maxAttempts: 0 } });
    track(client);
    const availability = await client.start('s1');
    expect(availability).toMatchObject({ state: 'down', gave_up: true });
    expect(availability.reason).toContain('contract_violation');
  });
});

describe('audio and results', () => {
  it('refuses audio while not ready and counts it', async () => {
    const client = scriptedClient({ launch: scriptedLaunch() });
    track(client);
    expect(client.sendAudio({ audio_frame: 0, mic: new Int16Array(320), sys: new Int16Array(320) })).toBe(false);
    expect(client.undeliveredSamples()).toBe(320);
    await client.start('s1');
    expect(client.sendAudio({ audio_frame: 0, mic: new Int16Array(320), sys: new Int16Array(320) })).toBe(true);
  });

  it('receives VAP_STATE with the positions and both channels as sent', async () => {
    const client = scriptedClient({ launch: scriptedLaunch() });
    const { vap } = track(client);
    await client.start('s1');
    const mic = noise(11, 6400);
    const sys = noise(22, 6400);
    await stream(client, mic, sys);
    await until(() => vap.length >= 4, 5000, 'VAP_STATE');
    for (const state of vap) {
      const end = state.audio_frame;
      expect(end % 1280).toBe(0);
      const digest = state.raw.worker_input as { x1_crc32: number; x2_crc32: number };
      expect(digest.x1_crc32).toBe(crc32(mic.subarray(end - 1280, end)));
      expect(digest.x2_crc32).toBe(crc32(sys.subarray(end - 1280, end)));
    }
  });

  it('overload drops both channels together and later states stay aligned', async () => {
    const client = scriptedClient({ launch: scriptedLaunch('--delay-ms', '200') });
    const { vap, drops, history } = track(client);
    await client.start('s1');
    const mic = noise(33, 64000);
    const sys = noise(44, 64000);
    await stream(client, mic, sys, 0, 0);
    await until(() => drops.some((d) => d.cause === 'overload') && vap.length >= 2, 8000, 'overload drop');
    for (const drop of drops) {
      expect(drop).toMatchObject({ channels: 'both', zero_filled: false, cause: 'overload' });
    }
    for (const state of vap) {
      const end = state.audio_frame;
      const digest = state.raw.worker_input as { x1_crc32: number; x2_crc32: number };
      expect(digest.x1_crc32).toBe(crc32(mic.subarray(end - 1280, end)));
      expect(digest.x2_crc32).toBe(crc32(sys.subarray(end - 1280, end)));
    }
    await until(() => history.some((h) => h.state === 'degraded'), 5000, 'degraded');
    expect(history.find((h) => h.state === 'degraded')?.reason).toContain('recent_overload_drop');
    expect(client.current().vap_available).toBe(true);
  });
});

describe('stop and crash', () => {
  it('stop sends SHUTDOWN, waits for exit, and reports stopped', async () => {
    const client = scriptedClient({ launch: scriptedLaunch() });
    const { history } = track(client);
    await client.start('s1');
    const pid = client.pid() as number;
    await client.stop('session_end');
    expect(client.current()).toMatchObject({ state: 'stopped', vap_available: false, reason: 'session_end' });
    expect(() => process.kill(pid, 0)).toThrow();
    expect(history.at(-1)?.state).toBe('stopped');
  });

  it('crash reports down, resets the clock, restarts, and resumes', async () => {
    const client = scriptedClient({ launch: scriptedLaunch() });
    const { history, vap } = track(client);
    let resets = 0;
    client.subscribe({ onClockReset: () => (resets += 1) });
    await client.start('s1');
    const before = client.pid() as number;
    const resetsBefore = resets;
    process.kill(before, 'SIGKILL');
    await until(() => client.current().next_retry_ms !== null, 5000, 'retry scheduled');
    expect(client.current()).toMatchObject({ state: 'down', vap_available: false, restart_attempt: 1, gave_up: false });
    expect(client.current().reason).toContain('SIGKILL');
    expect(client.sendAudio({ audio_frame: 0, mic: new Int16Array(320), sys: new Int16Array(320) })).toBe(false);
    expect(resets).toBeGreaterThan(resetsBefore);
    await until(() => client.current().state === 'ready', 10000, 'restart');
    expect(client.pid()).not.toBe(before);
    expect(history.map((h) => h.state)).toEqual(expect.arrayContaining(['down', 'starting', 'loading', 'ready']));
    await stream(client, noise(1, 3200), noise(2, 3200), 640000);
    await until(() => vap.length > 0, 5000, 'VAP_STATE after restart');
    expect(vap[0]?.audio_frame).toBe(640000 + 2560);
  });

  it('a fatal runtime fault reaches the listener before the restart', async () => {
    const client = scriptedClient({ launch: scriptedLaunch('--fault', 'swap_channels', '--fault-after', '3') });
    const errors: string[] = [];
    const { history } = track(client);
    client.subscribe({ onError: (e) => errors.push(`${e.code}:${e.fatal}`) });
    await client.start('s1');
    await stream(client, noise(1, 3200), noise(2, 3200)).catch(() => undefined);
    await stream(client, noise(1, 3200), noise(2, 3200), 3200).catch(() => undefined);
    await until(() => errors.length > 0, 5000, 'fatal error');
    expect(errors[0]).toBe('channel_misaligned:true');
    await until(() => history.some((h) => h.state === 'down' && h.reason?.includes('channel_misaligned') === true), 5000, 'down');
  });

  it('a silent worker is treated as stopped and is killed', async () => {
    const client = scriptedClient({
      launch: scriptedLaunch(),
      timeouts: { silenceMs: 300, pingIntervalMs: 100 },
      restart: { maxAttempts: 0 },
    });
    track(client);
    await client.start('s1');
    process.kill(client.pid() as number, 'SIGSTOP');
    await until(() => client.current().state === 'down', 5000, 'heartbeat timeout');
    expect(client.current()).toMatchObject({ gave_up: true });
    expect(client.current().reason).toContain('heartbeat_timeout');
  });

  it('stop force-kills a worker that does not answer SHUTDOWN', async () => {
    const client = scriptedClient({ launch: scriptedLaunch() });
    track(client);
    await client.start('s1');
    const pid = client.pid() as number;
    process.kill(pid, 'SIGSTOP');
    await client.stop('session_end');
    expect(() => process.kill(pid, 0)).toThrow();
  }, 10000);
});

describe('event bridge', () => {
  it('emits vap.state on the worker clock mapping, audio.health and provider.status', async () => {
    const sink = new MemoryEventSink();
    const time = new SystemTimeSource();
    const emitter = createEventEmitter({ session_id: 's1', condition: () => 'reactive', time, sink });
    const clock = new WorkerClockRecorder(emitter, { emitIntervalMs: 0 });
    const client = scriptedClient({ launch: scriptedLaunch(), time });
    track(client);
    attachMaaiEventBridge(client, { emitter, clock, systemChannelSource: 'written' });
    await client.start('s1');
    await stream(client, noise(1, 6400), noise(2, 6400));
    const of = (name: ResearchEvent['event']) => sink.events.filter((e) => e.event === name);
    await until(() => of('vap.state').length >= 3 && of('audio.health').length >= 1, 8000, 'events');
    const state = of('vap.state')[0] as Extract<ResearchEvent, { event: 'vap.state' }>;
    expect(state.time_basis?.source).toBe('worker_audio_frame');
    expect(state.model_variant).toBe(FAKE_MODEL_VARIANT);
    expect(of('clock.sync').some((e) => e.event === 'clock.sync' && e.source === 'worker_audio_frame')).toBe(true);
    const health = of('audio.health')[0] as Extract<ResearchEvent, { event: 'audio.health' }>;
    expect(health).toMatchObject({ reporter: 'worker', system_ch_source: 'written' });
    const status = of('provider.status').map((e) => e as Extract<ResearchEvent, { event: 'provider.status' }>);
    expect(status.every((s) => s.provider === 'maai_worker' && s.provider_class === 'test_double')).toBe(true);
    expect(status.map((s) => s.status)).toContain('ok');
    expect(clock.estimate()).not.toBeNull();
    let estimateAtDown: unknown = 'not_seen';
    const off = client.subscribe({
      onAvailability: (a) => {
        if (a.state === 'down' && estimateAtDown === 'not_seen') estimateAtDown = clock.estimate();
      },
    });
    process.kill(client.pid() as number, 'SIGKILL');
    await until(() => estimateAtDown !== 'not_seen', 5000, 'down');
    off();
    expect(estimateAtDown).toBeNull();
    expect(of('provider.status').some((e) => e.event === 'provider.status' && e.status === 'down')).toBe(true);
  });
});

describe('config', () => {
  it('builds CONFIGURE from the config file and the policy, without hardcoded weights', () => {
    const config = loadMaaiSessionConfig(undefined, {});
    const message = buildMaaiConfigure(config, { channel_layout: '2ch', speaking_threshold: 0.42 });
    expect(MaaiConfigure.parse({ ...message, session_id: 's9' })).toMatchObject({ speaking_threshold: 0.42, lang: config.lang, frame_rate_hz: config.frame_rate_hz });
    expect(['provisional', 'confirmed']).toContain(config.config_status);
  });

  it('env overrides are validated', () => {
    const base = { MAAI_LANG: 'jp', MAAI_MODEL_TYPE: 'normal', MAAI_FRAME_RATE_HZ: '10' };
    expect(loadMaaiSessionConfig(undefined, base)).toMatchObject({ lang: 'jp', model_type: 'normal', frame_rate_hz: 10 });
    expect(() => loadMaaiSessionConfig(undefined, { MAAI_LANG: 'en' })).toThrow();
    expect(() => loadMaaiSessionConfig(undefined, { MAAI_DEVICE: 'cuda' })).toThrow();
  });

  it('the production launch runs the real entry and does not pass API keys', () => {
    const launch = realMaaiLaunch({
      env: { MAAI_WORKER_URL: 'ws://127.0.0.1:8788', GEMINI_API_KEY: 'k', ELEVENLABS_API_KEY: 'k', HF_HOME: '/h', PATH: '/bin' },
    });
    expect(launch.args.slice(0, 2)).toEqual(['-m', 'maai_worker']);
    expect(launch.args).toContain('8788');
    expect(launch.args.join(' ')).not.toContain('scripted');
    expect(launch.cwd).toBe(WORKER_DIR);
    expect(launch.env).toMatchObject({ HF_HOME: '/h', PATH: '/bin' });
    expect(Object.keys(launch.env)).not.toContain('GEMINI_API_KEY');
    expect(Object.keys(launch.env)).not.toContain('ELEVENLABS_API_KEY');
    expect(path.isAbsolute(launch.command)).toBe(true);
  });

  it('only accepts a loopback worker URL', () => {
    expect(portFromWorkerUrl('ws://localhost:9000')).toBe(9000);
    expect(() => portFromWorkerUrl('ws://10.0.0.1:9000')).toThrow();
    expect(() => portFromWorkerUrl('ws://127.0.0.1')).toThrow();
  });

  it('workerEnv keeps offline flags only from the allowed set', () => {
    expect(workerEnv({ HF_HUB_OFFLINE: '1', SECRET: 'x' })).toEqual({ HF_HUB_OFFLINE: '1', PYTHONUNBUFFERED: '1' });
  });
});
