/**
 * セッションごとのプロバイダの組み立て（レーン J）。emitter と時刻源をセッションに結ぶため、毎回作る。
 * 失敗は例外にせず理由として返す（音声の経路と画面を止めない。黙って台本へ切り替えない）。
 */
import { absent } from '@llm-vap/contracts';
import type {
  EventEmitter,
  LlmProvider,
  Policy,
  ProviderClass,
  SttProvider,
  TimeSource,
  TtsProvider,
  TurnCompletionEstimator,
} from '@llm-vap/contracts';
import { NullTurnCompletionEstimator, createCompletionEstimator } from '../cognition/completion';
import { createGeminiProviderFromEnv } from '../providers/llm';
import { createGoogleSttProviderFromEnv } from '../providers/stt';
import { chooseTtsProvider, createElevenLabsTtsProviderFromEnv, createGeminiTtsProviderFromEnv } from '../providers/tts';
import type { OrchestratorConfig } from './config';
import { EnergyScriptedSttProvider, ScriptedReplyLlm, WavScriptedTtsProvider } from './scripted';

export type Built<T> = { ok: true; value: T } | { ok: false; reason: string };

export interface SessionProviders {
  stt: Built<SttProvider>;
  tts: Built<TtsProvider>;
  llm: Built<LlmProvider>;
  completion: TurnCompletionEstimator;
  /** 画面とログに出す区分。 */
  classes: Record<'stt' | 'tts' | 'llm', ProviderClass | 'unavailable'>;
  names: Record<'stt' | 'tts' | 'llm', string>;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function createSessionProviders(input: {
  config: OrchestratorConfig;
  time: TimeSource;
  emitter: EventEmitter;
  env?: NodeJS.ProcessEnv;
}): Promise<SessionProviders> {
  const { config, time, emitter } = input;
  const env = input.env ?? process.env;

  let stt: Built<SttProvider>;
  if (config.stt === 'test_double') {
    stt = { ok: true, value: new EnergyScriptedSttProvider({ time, emitter }) };
  } else {
    try {
      stt = { ok: true, value: await createGoogleSttProviderFromEnv({ time, emitter, env }) };
    } catch (error) {
      stt = { ok: false, reason: `google_stt: ${message(error)}` };
    }
  }

  let tts: Built<TtsProvider>;
  if (config.tts === 'test_double') {
    tts = { ok: true, value: new WavScriptedTtsProvider({ wav_path: config.scripted_tts_wav }) };
  } else {
    try {
      tts = {
        ok: true,
        value:
          chooseTtsProvider(env) === 'elevenlabs'
            ? createElevenLabsTtsProviderFromEnv({
                time,
                emitter,
                env,
                options: { apply_language_text_normalization: config.elevenlabs_language_normalization },
              })
            : createGeminiTtsProviderFromEnv({ time, emitter, env }),
      };
    } catch (error) {
      tts = { ok: false, reason: `tts: ${message(error)}` };
    }
  }

  let llm: Built<LlmProvider>;
  if (config.llm === 'test_double') {
    llm = { ok: true, value: new ScriptedReplyLlm({ time, emitter }) };
  } else if (!env.GEMINI_API_KEY) {
    llm = { ok: false, reason: 'gemini: GEMINI_API_KEY is not set' };
  } else {
    llm = {
      ok: true,
      value: createGeminiProviderFromEnv({ time, emitter, ...(env.GEMINI_MODEL ? { model: env.GEMINI_MODEL } : {}) }),
    };
  }

  const completion = completionFor(config.policy, llm.ok ? llm.value : null);
  const cls = (b: Built<{ provider_class: ProviderClass }>) => (b.ok ? b.value.provider_class : 'unavailable');
  const name = (b: Built<{ provider: string }>) => (b.ok ? b.value.provider : 'unavailable');
  return {
    stt,
    tts,
    llm,
    completion,
    classes: { stt: cls(stt), tts: cls(tts), llm: cls(llm) },
    names: { stt: name(stt), tts: name(tts), llm: name(llm) },
  };
}

function completionFor(policy: Policy, llm: LlmProvider | null): TurnCompletionEstimator {
  if (policy.policy_id !== 'ja') return new NullTurnCompletionEstimator();
  try {
    return createCompletionEstimator(policy.completion, llm ? { llm } : {});
  } catch {
    return new NullTurnCompletionEstimator();
  }
}

export const NO_COMPLETION = absent('no_estimate_yet');
