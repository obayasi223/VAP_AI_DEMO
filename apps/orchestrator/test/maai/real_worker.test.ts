/**
 * 実 MaAI（python -m maai_worker）の試験。重いので MAAI_REAL=1 のときだけ走り、既定では skip と表示される。
 * 実行前に free -m の available を確認すること（1プロセス約 650MB）。
 *
 * 素材は models/ja.wav（44.1kHz モノラル）を 16kHz にしたもの。mic だけに流す区間と sys だけに流す区間を繋ぐ。
 * MAAI_REAL_OUT にファイルを指定すると測定値を JSON で書く。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  SystemTimeSource,
  loadPolicyVapForTest,
  type MaaiFramesDropped,
  type MaaiVapStateMessage,
  type MaaiWorkerStatus,
} from './real_support';
import {
  MaaiWorkerClient,
  REPO_ROOT,
  buildMaaiConfigure,
  loadMaaiSessionConfig,
  realMaaiLaunch,
  type MaaiAvailability,
} from '../../src/maai';
import { PYTHON, crc32, sleep, until } from './worker_process';

const REAL = process.env.MAAI_REAL === '1';
const SPF = 1280;
const report: Record<string, unknown> = {};
let speech = new Int16Array(0);
let tempDir = '';

function makeClient(env: NodeJS.ProcessEnv = process.env) {
  const client = new MaaiWorkerClient({
    launch: realMaaiLaunch({ env: { ...env, HF_HUB_OFFLINE: env.HF_HUB_OFFLINE ?? '1' }, port: 0 }),
    configure: buildMaaiConfigure(loadMaaiSessionConfig(undefined, {}), loadPolicyVapForTest()),
    time: new SystemTimeSource(),
    restart: { baseDelayMs: 200, maxAttempts: 1 },
  });
  const vap: MaaiVapStateMessage[] = [];
  const drops: MaaiFramesDropped[] = [];
  const status: MaaiWorkerStatus[] = [];
  const history: MaaiAvailability[] = [];
  client.subscribe({
    onVapState: (m) => vap.push(m),
    onFramesDropped: (m) => drops.push(m),
    onWorkerStatus: (m) => status.push(m),
    onAvailability: (a) => history.push(a),
  });
  return { client, vap, drops, status, history };
}

/** 枠の送信を音声時刻に合わせる（speed=1 が実時間）。 */
async function paced(client: MaaiWorkerClient, mic: Int16Array, sys: Int16Array, start: number, speed: number) {
  const t0 = performance.now();
  for (let i = 0; i + 320 <= mic.length; i += 320) {
    const due = t0 + (i / 16) / speed;
    const wait = due - performance.now();
    if (wait > 1) await sleep(wait);
    client.sendAudio({ audio_frame: start + i, mic: mic.subarray(i, i + 320), sys: sys.subarray(i, i + 320) });
  }
}

function expectDigest(state: MaaiVapStateMessage, mic: Int16Array, sys: Int16Array, start = 0) {
  const end = state.audio_frame - start;
  const digest = state.raw.worker_input as { x1_crc32: number; x2_crc32: number };
  expect(digest.x1_crc32).toBe(crc32(mic.subarray(end - SPF, end)));
  expect(digest.x2_crc32).toBe(crc32(sys.subarray(end - SPF, end)));
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);
}

describe.runIf(REAL)('real MaAI worker', () => {
  beforeAll(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'maai-real-'));
    const out = path.join(tempDir, 'ja16k.pcm');
    const code = `
import sys, numpy as np, soundfile as sf
from scipy.signal import resample_poly
d, r = sf.read(sys.argv[1], dtype="float64")
assert r == 44100
np.clip(np.round(resample_poly(d, 160, 441) * 32767), -32768, 32767).astype("<i2").tofile(sys.argv[2])
`;
    execFileSync(PYTHON, ['-c', code, path.join(REPO_ROOT, 'models', 'ja.wav'), out]);
    const bytes = readFileSync(out);
    speech = new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  });

  afterAll(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    if (process.env.MAAI_REAL_OUT) writeFileSync(process.env.MAAI_REAL_OUT, JSON.stringify(report, null, 1));
  });

  let active: MaaiWorkerClient | null = null;
  afterEach(async () => {
    await active?.stop('test_end');
    active = null;
  });

  it('2ch: the vad follows the channel with speech, and both channels stay in step', async () => {
    const { client, vap, drops, status } = makeClient();
    active = client;
    const availability = await client.start('real_2ch');
    expect(availability).toMatchObject({ state: 'ready', is_fake: false });
    const ready = client.ready();
    expect(ready).toMatchObject({ is_fake: false, maai_version: '0.2.25' });
    const n = speech.length - (speech.length % 320);
    const voice = speech.subarray(0, n);
    const silence = new Int16Array(n);
    const mic = new Int16Array(2 * n);
    const sys = new Int16Array(2 * n);
    mic.set(voice, 0);
    mic.set(silence, n);
    sys.set(silence, 0);
    sys.set(voice, n);
    await paced(client, mic, sys, 0, 1);
    await sleep(500);
    const first = vap.filter((s) => s.audio_frame <= n);
    const second = vap.filter((s) => s.audio_frame > n + 8000);
    const vadOf = (list: MaaiVapStateMessage[], ch: 0 | 1) =>
      mean(list.map((s) => (s.channel_layout === '2ch' ? s.vad[ch] : 0)));
    const pOf = (list: MaaiVapStateMessage[], ch: 0 | 1) =>
      mean(list.map((s) => (s.channel_layout === '2ch' ? s.p_now[ch] : 0)));
    expect(vadOf(first, 0)).toBeGreaterThan(vadOf(first, 1) + 0.2);
    expect(vadOf(second, 1)).toBeGreaterThan(vadOf(second, 0) + 0.2);
    for (const state of vap) {
      expect(state.channel_layout).toBe('2ch');
      expect(state.model_variant).toBe(`${ready?.lang}/${ready?.model_type}/${ready?.checkpoint}`);
      expectDigest(state, mic, sys);
    }
    // 他のジョブと競合すると実時間でも追いつかず破棄が起きる。起きても同時破棄であることだけを要求する。
    for (const drop of drops) expect(drop).toMatchObject({ cause: 'overload', channels: 'both', zero_filled: false });
    report.two_channel = {
      overload_drops: drops.length,
      checkpoint: ready?.checkpoint,
      vap_states: vap.length,
      first_audio_frame: vap[0]?.audio_frame,
      mic_speech: { vad: [vadOf(first, 0), vadOf(first, 1)], p_now: [pOf(first, 0), pOf(first, 1)] },
      sys_speech: { vad: [vadOf(second, 0), vadOf(second, 1)], p_now: [pOf(second, 0), pOf(second, 1)] },
      last_status: status.at(-1),
      inference_ms_mean: mean(vap.map((s) => s.inference_ms)),
    };
  }, 120000);

  it('a network gap is zero filled on both channels and keeps the period', async () => {
    const { client, vap, drops } = makeClient();
    active = client;
    await client.start('real_gap');
    const n = 64000;
    const mic = speech.slice(0, n);
    const sys = speech.slice(n / 4, n / 4 + n);
    const gapStart = 16000;
    const gapEnd = 24000;
    // 実時間で送る。速く送ると過負荷の破棄が混ざる（ここは欠損だけを見る）。
    await paced(client, mic.subarray(0, gapStart), sys.subarray(0, gapStart), 0, 1);
    await paced(client, mic.subarray(gapEnd), sys.subarray(gapEnd), gapEnd, 1);
    await sleep(500);
    const gaps = drops.filter((d) => d.cause === 'network_gap');
    const overloads = drops.filter((d) => d.cause === 'overload');
    expect(gaps).toEqual([
      {
        type: 'FRAMES_DROPPED',
        from_audio_frame: gapStart,
        sample_count: gapEnd - gapStart,
        cause: 'network_gap',
        zero_filled: true,
        channels: 'both',
      },
    ]);
    report.network_gap_overloads_under_load = overloads.length;
    const expectMic = mic.slice();
    const expectSys = sys.slice();
    expectMic.fill(0, gapStart, gapEnd);
    expectSys.fill(0, gapStart, gapEnd);
    expect(vap.length).toBeGreaterThan(20);
    for (const state of vap) {
      expect(state.audio_frame % SPF).toBe(0);
      expectDigest(state, expectMic, expectSys);
    }
    report.network_gap = { vap_states: vap.length, drops };
  }, 120000);

  it('a burst overloads the real model: both channels dropped together, no shift afterwards', async () => {
    const { client, vap, drops, status, history } = makeClient();
    active = client;
    await client.start('real_overload');
    const n = speech.length - (speech.length % 320);
    const mic = speech.subarray(0, n);
    const sys = speech.slice().reverse().subarray(0, n);
    await paced(client, mic, sys, 0, 1000);
    await until(() => drops.length > 0, 10000, 'overload');
    await sleep(1500);
    for (const drop of drops) {
      expect(drop).toMatchObject({ cause: 'overload', channels: 'both', zero_filled: false });
      expect(drop.from_audio_frame % SPF).toBe(0);
      expect(drop.sample_count % SPF).toBe(0);
    }
    const droppedRanges = drops.map((d) => [d.from_audio_frame, d.from_audio_frame + d.sample_count] as const);
    for (const state of vap) {
      expectDigest(state, mic, sys);
      const start = state.audio_frame - SPF;
      expect(droppedRanges.some(([a, b]) => start >= a && start < b)).toBe(false);
    }
    await until(() => status.some((s) => s.frames_dropped_overload > 0), 5000, 'status');
    await until(() => history.some((h) => h.state === 'degraded'), 5000, 'degraded');
    report.overload = {
      audio_samples: n,
      drops,
      vap_states: vap.length,
      frames_dropped_overload: status.at(-1)?.frames_dropped_overload,
      degraded_reason: history.find((h) => h.state === 'degraded')?.reason,
    };
  }, 120000);

  it('stop notifies, and the real process is gone', async () => {
    const { client, status, history } = makeClient();
    await client.start('real_stop');
    const pid = client.pid() as number;
    await client.stop('session_end');
    expect(() => process.kill(pid, 0)).toThrow();
    expect(client.current()).toMatchObject({ state: 'stopped', vap_available: false, reason: 'session_end' });
    expect(status.at(-1)).toMatchObject({ status: 'down', reason: { value: 'shutdown: session_end' } });
    report.stop = { history: history.map((h) => h.state) };
  }, 120000);

  it('a crash stops VAP, notifies down, and the restart loads real MaAI again', async () => {
    const { client, vap, history } = makeClient();
    active = client;
    await client.start('real_crash');
    const mic = speech.subarray(0, 16000);
    const sys = new Int16Array(16000);
    await paced(client, mic, sys, 0, 1);
    await until(() => vap.length > 3, 10000, 'VAP_STATE');
    const before = client.pid() as number;
    process.kill(before, 'SIGKILL');
    await until(() => client.current().next_retry_ms !== null, 5000, 'down');
    expect(client.current()).toMatchObject({ state: 'down', vap_available: false, restart_attempt: 1 });
    expect(client.current().reason).toContain('SIGKILL');
    const countAtDown = vap.length;
    expect(client.sendAudio({ audio_frame: 16000, mic: new Int16Array(320), sys: new Int16Array(320) })).toBe(false);
    await sleep(100);
    expect(vap.length).toBe(countAtDown);
    await until(() => client.current().state === 'ready', 60000, 'restart');
    expect(client.pid()).not.toBe(before);
    expect(client.ready()).toMatchObject({ is_fake: false });
    await paced(client, mic, sys, 32000, 1);
    await until(() => vap.length > countAtDown, 10000, 'VAP_STATE after restart');
    expect(vap[countAtDown]?.audio_frame).toBe(32000 + 2 * SPF);
    report.crash = {
      down_reasons: history.filter((h) => h.state === 'down').map((h) => h.reason),
      history: history.map((h) => h.state),
      undelivered_samples: client.undeliveredSamples(),
      first_audio_frame_after_restart: vap[countAtDown]?.audio_frame,
    };
  }, 180000);

  it('a missing weight file is an explicit startup failure, not silence', async () => {
    const emptyHome = path.join(tempDir, 'empty_hf');
    const { client, vap } = makeClient({ ...process.env, HF_HOME: emptyHome, HF_HUB_OFFLINE: '1' });
    const availability = await client.start('real_no_weights');
    expect(availability).toMatchObject({ state: 'down', vap_available: false, gave_up: true, is_fake: null });
    expect(availability.reason).toContain('model_load');
    expect(vap).toEqual([]);
    report.no_weights = { reason: availability.reason?.slice(0, 300) };
    await client.stop('x');
  }, 120000);
});

describe.skipIf(REAL)('real MaAI worker', () => {
  it.skip('set MAAI_REAL=1 to run against real MaAI', () => undefined);
});
