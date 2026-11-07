/**
 * ワーカーの設定（workers/maai/worker_config.json）と起動コマンド。
 * 重み、frame rate などの既定はコードに持たない。CONFIGURE は設定と方策から組み立てる。
 * p の向き（p_ai_index）はワーカーに渡さない。ワーカーは MaAI の添字（ch1=mic, ch2=sys）のまま返し、
 * 読み手が policy.vap.p_ai_index で選ぶ。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAAI_RPC_PROTOCOL_VERSION,
  MaaiConfigure,
  MaaiLang,
  MaaiModelType,
  SAMPLE_RATE_HZ,
  type ChannelLayout,
} from '@llm-vap/contracts';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
export const WORKER_DIR = path.join(REPO_ROOT, 'workers', 'maai');
export const DEFAULT_WORKER_CONFIG = path.join(WORKER_DIR, 'worker_config.json');

export interface MaaiWorkerSessionDefaults {
  lang: MaaiLang;
  model_type: MaaiModelType;
  frame_rate_hz: number;
  frame_samples: number;
  device: 'cpu';
}

function positive(name: string, value: unknown): number {
  const number = typeof value === 'string' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isFinite(number) || number <= 0) {
    throw new Error(`${name} must be a positive number, got ${String(value)}`);
  }
  return number;
}

export interface MaaiSessionConfig extends MaaiWorkerSessionDefaults {
  /** provisional なら R2 の確定前の値。研究者画面やログで区別できるように返す。 */
  config_status: 'provisional' | 'confirmed';
}

type EnvLike = Record<string, string | undefined>;

/** ファイルの値に MAAI_LANG、MAAI_MODEL_TYPE、MAAI_FRAME_RATE_HZ を上書きする（.env.example の変数）。 */
export function loadMaaiSessionConfig(file: string = DEFAULT_WORKER_CONFIG, env: EnvLike = process.env): MaaiSessionConfig {
  const parsed = JSON.parse(readFileSync(file, 'utf-8')) as { status?: unknown; session_defaults?: Record<string, unknown> };
  const defaults = parsed.session_defaults;
  if (defaults === undefined) throw new Error(`${file}: session_defaults is missing`);
  if (parsed.status !== 'provisional' && parsed.status !== 'confirmed') {
    throw new Error(`${file}: status must be provisional or confirmed`);
  }
  if (defaults.device !== 'cpu') throw new Error(`${file}: device must be cpu`);
  if (env.MAAI_DEVICE !== undefined && env.MAAI_DEVICE !== '' && env.MAAI_DEVICE !== 'cpu') {
    throw new Error(`MAAI_DEVICE=${env.MAAI_DEVICE} is not supported; the contract allows cpu only`);
  }
  return {
    device: 'cpu',
    frame_samples: positive('frame_samples', defaults.frame_samples),
    lang: MaaiLang.parse(env.MAAI_LANG || defaults.lang),
    model_type: MaaiModelType.parse(env.MAAI_MODEL_TYPE || defaults.model_type),
    frame_rate_hz: positive('frame_rate_hz', env.MAAI_FRAME_RATE_HZ || defaults.frame_rate_hz),
    config_status: parsed.status,
  };
}

/** policy の vap 節のうち CONFIGURE に要る分。 */
export interface MaaiVapPolicy {
  channel_layout: ChannelLayout;
  speaking_threshold: number;
}

/** session_id は MaaiWorkerClient.start で入れる。 */
export function buildMaaiConfigure(config: MaaiSessionConfig, vap: MaaiVapPolicy): Omit<MaaiConfigure, 'session_id'> {
  return {
    type: 'CONFIGURE',
    protocol_version: MAAI_RPC_PROTOCOL_VERSION,
    lang: config.lang,
    model_type: config.model_type,
    channel_layout: vap.channel_layout,
    frame_rate_hz: config.frame_rate_hz,
    sample_rate_hz: SAMPLE_RATE_HZ,
    frame_samples: config.frame_samples,
    device: config.device,
    speaking_threshold: vap.speaking_threshold,
  };
}

export interface MaaiLaunch {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

/**
 * ワーカーへ渡す環境変数。process.env を丸ごと渡さない（API キーを別プロセスへ広げない）。
 * MAAI_ で始まるものと HF_ で始まるもの（重みのキャッシュと offline の指定）は通す。
 */
const PASSED_ENV = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'OMP_NUM_THREADS', 'LD_LIBRARY_PATH'];

export function workerEnv(env: EnvLike = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (PASSED_ENV.includes(key) || key.startsWith('HF_') || key === 'TRANSFORMERS_OFFLINE') out[key] = value;
  }
  out.PYTHONUNBUFFERED = '1';
  return out;
}

/** MAAI_WORKER_URL からポートを読む（.env.example）。localhost 以外は受けない。 */
export function portFromWorkerUrl(url: string): number {
  const parsed = new URL(url);
  if (parsed.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) {
    throw new Error(`MAAI_WORKER_URL must be a ws:// loopback URL, got ${url}`);
  }
  if (parsed.port === '') throw new Error(`MAAI_WORKER_URL needs an explicit port, got ${url}`);
  return Number(parsed.port);
}

export interface MaaiLaunchOptions {
  env?: EnvLike;
  /** 省略時は MAAI_WORKER_URL のポート。0 は空きポート。 */
  port?: number;
  /** 省略時は MAAI_PYTHON、それも無ければルートの .venv。 */
  python?: string;
  configFile?: string;
}

/** 本番のワーカー（実 MaAI）の起動コマンド。 */
export function realMaaiLaunch(options: MaaiLaunchOptions = {}): MaaiLaunch {
  const env = options.env ?? process.env;
  const port = options.port ?? (env.MAAI_WORKER_URL ? portFromWorkerUrl(env.MAAI_WORKER_URL) : undefined);
  if (port === undefined) throw new Error('MAAI_WORKER_URL is not set and no port was given');
  return {
    command: options.python ?? env.MAAI_PYTHON ?? path.join(REPO_ROOT, '.venv', 'bin', 'python'),
    args: ['-m', 'maai_worker', '--port', String(port), '--config', options.configFile ?? DEFAULT_WORKER_CONFIG, '--exit-on-stdin-eof'],
    cwd: WORKER_DIR,
    env: workerEnv(env),
  };
}
