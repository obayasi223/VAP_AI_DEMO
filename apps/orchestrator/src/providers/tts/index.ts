/**
 * TTS の入口。D と J は createTtsProviderFromEnv を呼び、返った TtsProvider の open({preferred_sample_rate_hz: 24000}) を使う。
 * 切替は TTS_PROVIDER（auto／elevenlabs／gemini）。auto は ElevenLabs のキーと声 ID が両方あれば ElevenLabs、なければ Gemini。
 * 能力の差は ttsCapabilitiesOf(connection) で判別する。
 * ElevenLabs の実 API は未検証（キーなし）。偽サーバーでの結果を性能として報告しない。
 */
import type { EventEmitter, TimeSource, TtsProvider } from '@llm-vap/contracts';
import { ElevenLabsTtsProvider } from './elevenlabs';
import type { ElevenLabsOptions, ElevenLabsVoiceSettings } from './elevenlabs';
import { GeminiTtsProvider } from './gemini';
import type { GeminiTtsOptions } from './gemini';

export * from './capabilities';
export * from './elevenlabs';
export * from './gemini';

export type TtsProviderChoice = 'elevenlabs' | 'gemini';

/** 値は読まない。あるかどうかだけで決める。 */
export function chooseTtsProvider(env: NodeJS.ProcessEnv): TtsProviderChoice {
  const setting = env.TTS_PROVIDER || 'auto';
  if (setting === 'elevenlabs' || setting === 'gemini') return setting;
  if (setting !== 'auto') throw new Error(`TTS_PROVIDER must be auto, elevenlabs or gemini: ${setting}`);
  return env.ELEVENLABS_API_KEY && env.ELEVENLABS_VOICE_ID ? 'elevenlabs' : 'gemini';
}

function numberInRange(name: string, raw: string, min: number, max: number): number {
  const value = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be a number in ${min}..${max}: ${raw}`);
  }
  return value;
}

/**
 * 声の設定（docs/tts_consistency.md）。ELEVENLABS_SEED: 整数、または off で付けない。未設定は既定（DEFAULT_ELEVENLABS_OPTIONS.seed）。
 * ELEVENLABS_STABILITY、ELEVENLABS_SIMILARITY_BOOST、ELEVENLABS_STYLE、ELEVENLABS_SPEED、ELEVENLABS_SPEAKER_BOOST（1／0）:
 * 1 つでも設定すると、設定した項目だけを voice_settings として文脈ごとに送る。全部未設定なら送らない（登録済みの声の設定が使われる）。
 * 不正な値は起動時に失敗させる（実験の条件を黙って変えない）。
 */
export function elevenLabsVoiceOptionsFromEnv(env: NodeJS.ProcessEnv): Partial<ElevenLabsOptions> {
  const options: Partial<ElevenLabsOptions> = {};
  const seed = env.ELEVENLABS_SEED;
  if (seed !== undefined && seed !== '') {
    if (seed.toLowerCase() === 'off') {
      options.seed = null;
    } else {
      const value = numberInRange('ELEVENLABS_SEED', seed, 0, 4294967295);
      if (!Number.isInteger(value)) throw new Error(`ELEVENLABS_SEED must be an integer: ${seed}`);
      options.seed = value;
    }
  }
  const settings: ElevenLabsVoiceSettings = {};
  const set = (raw: string | undefined, apply: (value: string) => void) => {
    if (raw !== undefined && raw !== '') apply(raw);
  };
  set(env.ELEVENLABS_STABILITY, (v) => (settings.stability = numberInRange('ELEVENLABS_STABILITY', v, 0, 1)));
  set(env.ELEVENLABS_SIMILARITY_BOOST, (v) => (settings.similarity_boost = numberInRange('ELEVENLABS_SIMILARITY_BOOST', v, 0, 1)));
  set(env.ELEVENLABS_STYLE, (v) => (settings.style = numberInRange('ELEVENLABS_STYLE', v, 0, 1)));
  set(env.ELEVENLABS_SPEED, (v) => (settings.speed = numberInRange('ELEVENLABS_SPEED', v, 0.7, 1.2)));
  set(env.ELEVENLABS_SPEAKER_BOOST, (v) => (settings.use_speaker_boost = v === '1' || v.toLowerCase() === 'true'));
  if (Object.keys(settings).length > 0) options.voice_settings = settings;
  return options;
}

export function createElevenLabsTtsProviderFromEnv(input: {
  time: TimeSource;
  emitter?: EventEmitter;
  env?: NodeJS.ProcessEnv;
  options?: Partial<ElevenLabsOptions>;
}): ElevenLabsTtsProvider {
  const env = input.env ?? process.env;
  const missing = ['ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID'].filter((name) => !env[name]);
  if (missing.length > 0) throw new Error(`not set: ${missing.join(', ')}`);
  return new ElevenLabsTtsProvider({
    api_key: env.ELEVENLABS_API_KEY as string,
    voice_id: env.ELEVENLABS_VOICE_ID as string,
    time: input.time,
    ...(input.emitter ? { emitter: input.emitter } : {}),
    options: {
      ...(env.ELEVENLABS_MODEL_ID ? { model_id: env.ELEVENLABS_MODEL_ID } : {}),
      ...elevenLabsVoiceOptionsFromEnv(env),
      ...input.options,
    },
  });
}

export function createGeminiTtsProviderFromEnv(input: {
  time: TimeSource;
  emitter?: EventEmitter;
  env?: NodeJS.ProcessEnv;
  options?: Partial<GeminiTtsOptions>;
}): GeminiTtsProvider {
  const env = input.env ?? process.env;
  if (!env.GEMINI_API_KEY) throw new Error('not set: GEMINI_API_KEY');
  return new GeminiTtsProvider({
    api_key: env.GEMINI_API_KEY,
    time: input.time,
    ...(input.emitter ? { emitter: input.emitter } : {}),
    options: {
      ...(env.GEMINI_TTS_MODEL ? { model: env.GEMINI_TTS_MODEL } : {}),
      ...(env.GEMINI_TTS_VOICE ? { voice: env.GEMINI_TTS_VOICE } : {}),
      ...input.options,
    },
  });
}

export function createTtsProviderFromEnv(input: {
  time: TimeSource;
  emitter?: EventEmitter;
  env?: NodeJS.ProcessEnv;
}): TtsProvider {
  const env = input.env ?? process.env;
  return chooseTtsProvider(env) === 'elevenlabs'
    ? createElevenLabsTtsProviderFromEnv({ ...input, env })
    : createGeminiTtsProviderFromEnv({ ...input, env });
}
