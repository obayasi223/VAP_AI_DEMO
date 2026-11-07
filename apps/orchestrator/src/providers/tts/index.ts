/**
 * TTS の入口。D と J は createTtsProviderFromEnv を呼び、返った TtsProvider の open({preferred_sample_rate_hz: 24000}) を使う。
 * 切替は TTS_PROVIDER（auto／elevenlabs／gemini）。auto は ElevenLabs のキーと声 ID が両方あれば ElevenLabs、なければ Gemini。
 * 能力の差は ttsCapabilitiesOf(connection) で判別する。
 * ElevenLabs の実 API は未検証（キーなし）。偽サーバーでの結果を性能として報告しない。
 */
import type { EventEmitter, TimeSource, TtsProvider } from '@llm-vap/contracts';
import { ElevenLabsTtsProvider } from './elevenlabs';
import type { ElevenLabsOptions } from './elevenlabs';
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
