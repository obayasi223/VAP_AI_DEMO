/**
 * 起動の設定（レーン J）。値は .env と環境変数から読み、キーの値は表示しない。
 * プロバイダの切替は .env.example の *_PROVIDER_CLASS:
 *   production（既定）: Google STT／ElevenLabs または Gemini TTS／Gemini
 *   test_double       : 台本（app/scripted.ts）。受け入れの証拠に数えない
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Condition, Policy } from '@llm-vap/contracts';
import { REPO_ROOT } from '../maai';

export type ProviderMode = 'production' | 'test_double';

export interface OrchestratorConfig {
  host: string;
  port: number;
  policy: Policy;
  policy_file: string;
  condition: Condition;
  sessions_dir: string;
  stt: ProviderMode;
  tts: ProviderMode;
  llm: ProviderMode;
  /** false なら MaAI ワーカーを起動しない（VAP は down のまま。偽の値は作らない）。 */
  maai_enabled: boolean;
  /** 切断から再接続を待つ時間。過ぎたらセッションを閉じる。 */
  resume_grace_ms: number;
  /** WS の Origin として受け入れるホスト名。 */
  allowed_origin_hosts: string[];
  /** 台本の TTS が使う WAV。 */
  scripted_tts_wav: string;
  elevenlabs_language_normalization: boolean;
}

/** リポジトリの .env を読む（あれば）。既に設定された環境変数は上書きしない。 */
export function loadDotEnv(file = path.join(REPO_ROOT, '.env')): boolean {
  if (!existsSync(file)) return false;
  process.loadEnvFile(file);
  return true;
}

function mode(name: string, env: NodeJS.ProcessEnv): ProviderMode {
  const value = env[name] || 'production';
  if (value === 'production' || value === 'test_double') return value;
  throw new Error(`${name} must be production or test_double (development is not wired), got ${value}`);
}

function flag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return value === '1' || value.toLowerCase() === 'true';
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): OrchestratorConfig {
  const policyFile = path.resolve(REPO_ROOT, env.POLICY_FILE || 'config/policy.ja.json');
  const policy = Policy.parse(JSON.parse(readFileSync(policyFile, 'utf-8')));
  return {
    host: env.ORCHESTRATOR_HOST || '0.0.0.0',
    port: Number(env.ORCHESTRATOR_PORT || 8787),
    policy,
    policy_file: policyFile,
    condition: Condition.parse(env.CONDITION || 'reactive'),
    sessions_dir: path.resolve(REPO_ROOT, env.SESSIONS_DIR || 'sessions'),
    stt: mode('STT_PROVIDER_CLASS', env),
    tts: mode('TTS_PROVIDER_CLASS', env),
    llm: mode('LLM_PROVIDER_CLASS', env),
    maai_enabled: flag(env.MAAI_ENABLED, true),
    resume_grace_ms: Number(env.SESSION_RESUME_GRACE_MS || 20000),
    allowed_origin_hosts: (env.ALLOWED_ORIGIN_HOSTS || 'localhost,127.0.0.1,[::1]').split(',').map((h) => h.trim()),
    scripted_tts_wav: path.resolve(REPO_ROOT, env.SCRIPTED_TTS_WAV || 'models/ja.wav'),
    elevenlabs_language_normalization: flag(env.ELEVENLABS_LANGUAGE_NORMALIZATION, false),
  };
}
