/** 試験の共通部品。test double のエンジンで本物の RPC サーバーを別プロセスとして起動する。 */
import path from 'node:path';
import { SystemTimeSource, type MaaiConfigure } from '@llm-vap/contracts';
import { MaaiWorkerClient, REPO_ROOT, WORKER_DIR, workerEnv, type MaaiClientOptions, type MaaiLaunch } from '../../src/maai';

export const PYTHON = path.join(REPO_ROOT, '.venv', 'bin', 'python');

export function scriptedLaunch(...args: string[]): MaaiLaunch {
  return {
    command: PYTHON,
    args: [path.join(WORKER_DIR, 'tests', 'support', 'run_scripted_worker.py'), '--exit-on-stdin-eof', ...args],
    cwd: WORKER_DIR,
    env: workerEnv(),
  };
}

export const CONFIGURE: Omit<MaaiConfigure, 'session_id'> = {
  type: 'CONFIGURE',
  protocol_version: 1,
  lang: 'jp_kyoto',
  model_type: 'normal-ver2',
  channel_layout: '2ch',
  frame_rate_hz: 12.5,
  sample_rate_hz: 16000,
  frame_samples: 320,
  device: 'cpu',
  speaking_threshold: 0.5,
};

export function scriptedClient(options: Partial<MaaiClientOptions> & { launch: MaaiLaunch }): MaaiWorkerClient {
  return new MaaiWorkerClient({
    configure: CONFIGURE,
    time: new SystemTimeSource(),
    allowFake: true,
    restart: { baseDelayMs: 50, maxAttempts: 2 },
    ...options,
  });
}

export async function until(condition: () => boolean, timeoutMs = 10000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export function noise(seed: number, count: number): Int16Array {
  const out = new Int16Array(count);
  let state = seed >>> 0 || 1;
  for (let i = 0; i < count; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    out[i] = (state % 40001) - 20000;
  }
  return out;
}

/** zlib.crc32 と同じ。ワーカーの raw.worker_input と比べる。 */
export function crc32(samples: Int16Array): number {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
