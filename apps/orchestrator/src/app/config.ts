/**
 * 起動の設定（レーン J）。値は .env と環境変数から読み、キーの値は表示しない。
 * プロバイダの切替は .env.example の *_PROVIDER_CLASS:
 *   production（既定）: Google STT／ElevenLabs または Gemini TTS／Gemini
 *   test_double       : 台本（app/scripted.ts）。受け入れの証拠に数えない
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Condition, ConversationKind, Policy, TimingStrategy, VocalCueMode, type PolicyOverrideInfo } from '@llm-vap/contracts';
import { loadOverrideFile } from '../dev/policy_override';
import { REPO_ROOT } from '../maai';

export type ProviderMode = 'production' | 'test_double';

export interface OrchestratorConfig {
  host: string;
  port: number;
  policy: Policy;
  policy_file: string;
  /**
   * POLICY_OVERRIDE_FILE（/tune が書く config/policy.ja.local.json など）を正本に重ねたときの記録。なしは null。
   * 指定したときだけ読む（暗黙には読まない）。上書きの項目は起動ログと manifest に残す。
   */
  policy_override: PolicyOverrideInfo | null;
  /** 研究条件の既定（CONDITION）。参加者画面が求めなければこれを使う。 */
  condition: Condition;
  /**
   * 参加者画面が WS の URL（?condition=）で求めた条件をセッションごとに使うか（CONDITION_FROM_CLIENT、既定 true）。
   * false なら画面の求めを無視して CONDITION に固定する（本番の実験で参加者に条件を選ばせない運用）。
   */
  condition_from_client: boolean;
  /**
   * 会話の種類の既定（CONVERSATION_KIND、なければ policy.initiative.staged.conversation_kind）。
   * 二段判定の節がない方策では null（1段判定のままで、会話の種類を使わない）。
   */
  conversation_kind: ConversationKind | null;
  /** 申し出るタイミングの方式の既定（TIMING_STRATEGY、なければ policy.initiative.staged.timing_strategy、節がなければ v2）。 */
  timing_strategy: TimingStrategy;
  /** 画面の ?conversation_kind= を使うか（CONVERSATION_KIND_FROM_CLIENT、既定 true）。false なら既定に固定する。 */
  conversation_kind_from_client: boolean;
  /** 画面の ?timing_strategy= を使うか（TIMING_STRATEGY_FROM_CLIENT、既定 true）。false なら既定に固定する。 */
  timing_strategy_from_client: boolean;
  /** 吸気の後の短い声の既定（VOCAL_CUE、既定は none＝無音の吸気だけ。不正値は none）。initiative_inhale のときだけ効く。 */
  vocal_cue: VocalCueMode;
  /** 画面の ?vocal_cue= を使うか（VOCAL_CUE_FROM_CLIENT、既定 true）。false なら既定に固定する。 */
  vocal_cue_from_client: boolean;
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
  /**
   * InitiativeMonitor（発話希望の判定）を動かす条件。既定は ja の方策で3条件とも（計画 §4.6「候補の生成までは
   * 同じ経路」）。INITIATIVE_CONDITIONS=none で止める。波2では候補を作るだけで、発声と吸気には使わない。
   */
  initiative_conditions: Condition[];
  /**
   * AI の役割・関心（PERSONA_FILE）。既定は自由な会話向けの暫定の persona（config/persona.ja.conversation.json）。
   * 展示会の同僚（config/persona.ja.json）は反例の予備実験用に残している。
   */
  persona_file: string;
  /** 判定に使う Gemini のモデル。S の推奨（docs/initiative_spike.md）の flash-lite（minimal）が既定。 */
  initiative_model: string;
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

function conditions(value: string | undefined): Condition[] {
  if (value === undefined || value.trim() === '') return [...Condition.options];
  if (value.trim() === 'none') return [];
  return value.split(',').map((c) => Condition.parse(c.trim()));
}

function flag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return value === '1' || value.toLowerCase() === 'true';
}

/** 会話の音声の保存（既定は保存しない）。docs/runbook.md の自己実験の手順と docs/known_gaps.md §13。 */
export interface SessionAudioConfig {
  /** SAVE_SESSION_AUDIO=1（または true）のときだけ true。 */
  enabled: boolean;
  /** 空きがこれを下回ると保存を始めない・止める（SAVE_SESSION_AUDIO_MIN_FREE_MB、既定 1024）。 */
  min_free_bytes: number;
}

const DEFAULT_SESSION_AUDIO_MIN_FREE_MB = 1024;

export function readSessionAudioConfig(env: NodeJS.ProcessEnv = process.env): SessionAudioConfig {
  const raw = Number(env.SAVE_SESSION_AUDIO_MIN_FREE_MB);
  const minFreeMb = env.SAVE_SESSION_AUDIO_MIN_FREE_MB && Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_SESSION_AUDIO_MIN_FREE_MB;
  return { enabled: flag(env.SAVE_SESSION_AUDIO, false), min_free_bytes: minFreeMb * 1024 * 1024 };
}

/** VOCAL_CUE。不正値は既定の none（無音の吸気だけの動作を変えない）。 */
function vocalCueFromEnv(value: string | undefined): VocalCueMode {
  if (value === undefined || value === '') return 'none';
  const parsed = VocalCueMode.safeParse(value);
  if (parsed.success) return parsed.data;
  console.warn(`[orchestrator] ignored an invalid VOCAL_CUE (${value.slice(0, 40)}); using none`);
  return 'none';
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): OrchestratorConfig {
  const policyFile = path.resolve(REPO_ROOT, env.POLICY_FILE || 'config/policy.ja.json');
  const basePolicy = Policy.parse(JSON.parse(readFileSync(policyFile, 'utf-8')));
  const overrideFile = env.POLICY_OVERRIDE_FILE ? path.resolve(REPO_ROOT, env.POLICY_OVERRIDE_FILE) : null;
  const overridden = overrideFile === null ? null : loadOverrideFile(basePolicy, overrideFile);
  const policy = overridden?.policy ?? basePolicy;
  const staged = policy.policy_id === 'ja' ? (policy.initiative.staged ?? null) : null;
  return {
    // WSL2 の localhost 転送は 127.0.0.1 の待ち受けにも届く（Windows の curl.exe で確認、2026-11-08）。
    // LAN へ公開しないため既定は 127.0.0.1。
    host: env.ORCHESTRATOR_HOST || '127.0.0.1',
    port: Number(env.ORCHESTRATOR_PORT || 8787),
    policy,
    policy_file: policyFile,
    policy_override: overridden?.info ?? null,
    condition: Condition.parse(env.CONDITION || 'reactive'),
    condition_from_client: flag(env.CONDITION_FROM_CLIENT, true),
    conversation_kind: env.CONVERSATION_KIND ? ConversationKind.parse(env.CONVERSATION_KIND) : (staged?.conversation_kind ?? null),
    timing_strategy: TimingStrategy.parse(env.TIMING_STRATEGY || staged?.timing_strategy || 'v2'),
    conversation_kind_from_client: flag(env.CONVERSATION_KIND_FROM_CLIENT, true),
    timing_strategy_from_client: flag(env.TIMING_STRATEGY_FROM_CLIENT, true),
    vocal_cue: vocalCueFromEnv(env.VOCAL_CUE),
    vocal_cue_from_client: flag(env.VOCAL_CUE_FROM_CLIENT, true),
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
    initiative_conditions: conditions(env.INITIATIVE_CONDITIONS),
    persona_file: path.resolve(REPO_ROOT, env.PERSONA_FILE || 'config/persona.ja.conversation.json'),
    initiative_model: env.INITIATIVE_GEMINI_MODEL || 'gemini-3.5-flash-lite',
  };
}
