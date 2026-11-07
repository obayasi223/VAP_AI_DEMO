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
  /** 設定で求めた区分（開けなかったときの provider.status に使う）。 */
  requested: Record<'stt' | 'tts' | 'llm', ProviderClass>;
  /** ターン完了の推定器の名前（policy.completion.estimator、なければ none）。 */
  completion_name: string;
  /** 推定器を作れなかった理由。作れた（または推定器なしの方策）なら null。 */
  completion_error: string | null;
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
  if (completion.error !== null) console.error(`[orchestrator] completion estimator unavailable: ${completion.error}`);
  const cls = (b: Built<{ provider_class: ProviderClass }>) => (b.ok ? b.value.provider_class : 'unavailable');
  const name = (b: Built<{ provider: string }>) => (b.ok ? b.value.provider : 'unavailable');
  return {
    stt,
    tts,
    llm,
    completion: completion.estimator,
    classes: { stt: cls(stt), tts: cls(tts), llm: cls(llm) },
    names: { stt: name(stt), tts: name(tts), llm: name(llm) },
    requested: { stt: config.stt, tts: config.tts, llm: config.llm },
    completion_name: completion.name,
    completion_error: completion.error,
  };
}

/** 作れなければ Null の推定器へ落とすが、理由を返す（黙って推定器なしにしない）。 */
function completionFor(
  policy: Policy,
  llm: LlmProvider | null,
): { estimator: TurnCompletionEstimator; name: string; error: string | null } {
  if (policy.policy_id !== 'ja') return { estimator: new NullTurnCompletionEstimator(), name: 'none', error: null };
  const name = policy.completion.estimator ?? 'none';
  try {
    return { estimator: createCompletionEstimator(policy.completion, llm ? { llm } : {}), name, error: null };
  } catch (error) {
    return { estimator: new NullTurnCompletionEstimator(), name, error: message(error).slice(0, 300) };
  }
}

export const NO_COMPLETION = absent('no_estimate_yet');
