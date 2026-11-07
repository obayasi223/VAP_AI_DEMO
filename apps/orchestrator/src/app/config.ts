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
  /** WS と /health で受け入れる Origin（scheme://host:port）。既定は画面（Next.js）の localhost:3000。 */
  allowed_origins: string[];
  /**
   * Origin のない接続（Node のクライアント、試験）を受け入れる合言葉。null なら Origin のない接続は断る。
   * WS の URL の ?token= か、x-orchestrator-token ヘッダで渡す。
   */
  client_token: string | null;
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
    // WSL2 の localhost 転送は 127.0.0.1 の待ち受けにも届く（Windows の curl.exe で確認、2026-11-08）。
    // LAN へ公開しないため既定は 127.0.0.1。
    host: env.ORCHESTRATOR_HOST || '127.0.0.1',
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
    allowed_origins: (env.ALLOWED_ORIGINS || 'http://localhost:3000,http://127.0.0.1:3000')
      .split(',')
      .map((h) => h.trim())
      .filter((h) => h !== ''),
    client_token: env.ORCHESTRATOR_CLIENT_TOKEN || null,
    scripted_tts_wav: path.resolve(REPO_ROOT, env.SCRIPTED_TTS_WAV || 'models/ja.wav'),
    elevenlabs_language_normalization: flag(env.ELEVENLABS_LANGUAGE_NORMALIZATION, false),
  };
}
