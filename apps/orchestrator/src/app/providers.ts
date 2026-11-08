/**
 * セッションごとのプロバイダの組み立て（レーン J）。emitter と時刻源をセッションに結ぶため、毎回作る。
 * 失敗は例外にせず理由として返す（音声の経路と画面を止めない。黙って台本へ切り替えない）。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { absent } from '@llm-vap/contracts';
import type {
  Condition,
  ConversationKind,
  EventEmitter,
  LlmProvider,
  Policy,
  ProviderClass,
  SttProvider,
  TimeSource,
  TimingStrategy,
  TtsProvider,
  TurnCompletionEstimator,
  VocalCueMode,
} from '@llm-vap/contracts';
import { NullTurnCompletionEstimator, createCompletionEstimator } from '../cognition/completion';
import { CURRENT_PROMPT_VERSION, parseConversationKindProfile, parsePersona } from '../cognition/initiative';
import type { ConversationKindProfile, InitiativePersona } from '../cognition/initiative';
import { REPO_ROOT } from '../maai';
import { createGeminiProviderFromEnv } from '../providers/llm';
import { createGoogleSttProviderFromEnv } from '../providers/stt';
import { chooseTtsProvider, createElevenLabsTtsProviderFromEnv, createGeminiTtsProviderFromEnv } from '../providers/tts';
import type { OrchestratorConfig } from './config';
import { EnergyScriptedSttProvider, INITIATIVE_LONG_STT_SCRIPT, INITIATIVE_STT_SCRIPT, ScriptedReplyLlm, WavScriptedTtsProvider, scriptedSecondJudgementMode } from './scripted';
import type { ScriptedInitiativeMode } from './scripted';

/**
 * 台本の発話希望（SCRIPTED_INITIATIVE。E2E 用、app/scripted.ts）。台本の STT と LLM のとき、STT の台本は reactive 以外のセッションだけ変える。
 * wait_on_input は new_on_input と同じ入力で、タイミング段だけ WAIT_FOR_TURN_END を返す。
 */
function scriptedInitiative(env: NodeJS.ProcessEnv): ScriptedInitiativeMode {
  const value = env.SCRIPTED_INITIATIVE || 'none';
  if (value !== 'none' && value !== 'new_on_input' && value !== 'wait_on_input' && value !== 'revise_on_input' && value !== 'withdraw_on_input' && value !== 'defer_on_input') {
    throw new Error(`SCRIPTED_INITIATIVE must be none, new_on_input, wait_on_input, revise_on_input, withdraw_on_input or defer_on_input, got ${value}`);
  }
  return value;
}

/** 吸気の後の声の E2E の台本の開始。声は VAP が新しいときだけ鳴るので、VAP の助走（policy の vap_rewarm_ms = 10 秒）の後に延期を起こす。 */
const SCRIPTED_DEFER_START_MS = 11_000;

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
  /** 発話希望の判定（G）。省略は無効（試験の台）。 */
  initiative?: InitiativeSetup;
}

/**
 * 発話希望の判定の組み立て。enabled=false は条件や方策で止めたもの（理由つき）。
 * enabled=true で llm か persona が null なら、動かすはずが作れなかったもの（理由つき）。
 */
export interface InitiativeSetup {
  enabled: boolean;
  reason: string | null;
  llm: LlmProvider | null;
  persona: InitiativePersona | null;
  prompt_version: string;
  /** 求めたモデル（Gemini）。台本では test_double。 */
  model: string;
  /** 二段判定の設定。省略は1段判定（v2）で、会話の種類は使っていない。 */
  staged?: StagedSetup;
  /** このセッションの選択とその由来（manifest に残す）。判定を作れなかったときも入る。 */
  choice?: InitiativeChoice;
}

/** 実際に適用した二段判定の設定（manifest はこの値だけを書く）。 */
export interface StagedSetup {
  timing_strategy: Exclude<TimingStrategy, 'v2'>;
  conversation_kind: ConversationKind;
  profile: ConversationKindProfile;
  desire_prompt_version: string;
  timing_prompt_version: string;
  recent_context: { max_turns: number; max_chars_per_turn: number };
}

/** client は画面の求め、default は設定の既定、fixed は *_FROM_CLIENT=0 で画面の求めを断った。 */
export type ChoiceSource = 'client' | 'default' | 'fixed';

export interface InitiativeChoice {
  conversation_kind: ConversationKind | null;
  conversation_kind_source: ChoiceSource;
  timing_strategy: TimingStrategy;
  timing_strategy_source: ChoiceSource;
  /** 吸気の後の短い声（省略は none）。initiative_inhale のときだけ効く。 */
  vocal_cue?: VocalCueMode;
  vocal_cue_source?: ChoiceSource;
}

/** 会話の種類の設定ファイル（config/conversation_kind.<kind>.ja.json）。 */
export function conversationKindFile(kind: ConversationKind): string {
  return path.join(REPO_ROOT, 'config', `conversation_kind.${kind}.ja.json`);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function createSessionProviders(input: {
  config: OrchestratorConfig;
  time: TimeSource;
  emitter: EventEmitter;
  env?: NodeJS.ProcessEnv;
  /** このセッションの研究条件。省略は config.condition（起動時の既定）。 */
  condition?: Condition;
  /** このセッションの会話の種類と方式。省略は設定の既定。 */
  choice?: InitiativeChoice;
}): Promise<SessionProviders> {
  const { config, time, emitter } = input;
  const condition = input.condition ?? config.condition;
  const env = input.env ?? process.env;

  let stt: Built<SttProvider>;
  if (config.stt === 'test_double') {
    // 台本の発話希望は候補を話しうる条件のセッションだけ（reactive のセッションの台本は変えない）。
    const mode = scriptedInitiative(env);
    const scripted = mode !== 'none' && condition !== 'reactive';
    // 内容更新と撤回の台本は長い文で、1文字の長さを短くする（話している間に2回の判定が走るように。実測の話速ではない）。
    const second = scripted && scriptedSecondJudgementMode(mode);
    stt = {
      ok: true,
      value: new EnergyScriptedSttProvider({ time, emitter, ...(scripted ? { stable_interim: true, script: second ? INITIATIVE_LONG_STT_SCRIPT : INITIATIVE_STT_SCRIPT } : {}), ...(second ? { ms_per_char: 90 } : {}), ...(mode === 'defer_on_input' ? { ignore_audio_before_ms: SCRIPTED_DEFER_START_MS } : {}) }),
    };
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
  const choice: InitiativeChoice = input.choice ?? {
    conversation_kind: config.conversation_kind,
    conversation_kind_source: 'default',
    timing_strategy: config.timing_strategy,
    timing_strategy_source: 'default',
    vocal_cue: config.vocal_cue,
    vocal_cue_source: 'default',
  };
  const initiative = initiativeFor({ config, condition, time, emitter, env, choice });
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
    initiative,
  };
}

/**
 * 判定には応答と別の LlmProvider を作る（モデルと思考の段、時間切れが違う）。
 * 時間切れは policy の max_result_age_ms（それより遅い NEW と REVISE は鮮度で棄てるので、待っても使えない）。
 * 出力の上限はスパイクと同じ 4096（説明の項目が多く、1024 では切れうる）。
 */
/** 判定用の Gemini の provider.status の名前。 */
export const INITIATIVE_GEMINI_STATUS = 'gemini:initiative';

function initiativeFor(input: {
  config: OrchestratorConfig;
  condition: Condition;
  time: TimeSource;
  emitter: EventEmitter;
  env: NodeJS.ProcessEnv;
  choice: InitiativeChoice;
}): InitiativeSetup {
  const { config, condition, time, emitter, env, choice } = input;
  const off = (reason: string): InitiativeSetup => ({
    enabled: false,
    reason,
    llm: null,
    persona: null,
    prompt_version: CURRENT_PROMPT_VERSION,
    model: config.llm === 'test_double' ? 'test_double' : config.initiative_model,
    choice,
  });
  if (config.policy.policy_id !== 'ja') return off('policy_has_no_initiative_section');
  if (!config.initiative_conditions.includes(condition)) {
    return off(`disabled_for_condition:${condition}`);
  }
  const unavailable = (reason: string): InitiativeSetup => ({ ...off(reason), enabled: true });
  // 二段判定は会話の種類の設定（persona の項目を含む）を使う。v2 は従来どおり PERSONA_FILE。
  let persona: InitiativePersona;
  let staged: StagedSetup | undefined;
  if (choice.timing_strategy === 'v2') {
    try {
      persona = parsePersona(JSON.parse(readFileSync(config.persona_file, 'utf8')));
    } catch (error) {
      return unavailable(`persona: ${message(error).slice(0, 200)}`);
    }
  } else {
    const section = config.policy.initiative.staged;
    if (!section) return unavailable('policy_has_no_staged_section');
    if (choice.conversation_kind === null) return unavailable('conversation_kind_not_set');
    let profile: ConversationKindProfile;
    try {
      profile = parseConversationKindProfile(JSON.parse(readFileSync(conversationKindFile(choice.conversation_kind), 'utf8')));
    } catch (error) {
      return unavailable(`conversation_kind: ${message(error).slice(0, 200)}`);
    }
    if (profile.conversation_kind !== choice.conversation_kind) {
      return unavailable(`conversation_kind: file is for ${profile.conversation_kind}, not ${choice.conversation_kind}`);
    }
    persona = profile;
    staged = {
      timing_strategy: choice.timing_strategy,
      conversation_kind: choice.conversation_kind,
      profile,
      desire_prompt_version: section.desire_prompt_version,
      timing_prompt_version: section.timing_prompt_version,
      recent_context: section.recent_context,
    };
  }
  let llm: LlmProvider;
  if (config.llm === 'test_double') {
    llm = new ScriptedReplyLlm({ time, emitter, initiative: scriptedInitiative(env) });
  } else if (!env.GEMINI_API_KEY) {
    return unavailable('gemini: GEMINI_API_KEY is not set');
  } else {
    try {
      llm = createGeminiProviderFromEnv({
        time,
        emitter,
        model: config.initiative_model,
        max_output_tokens: 4096,
        // 応答用の Gemini と provider.status の行を分ける（cost.usage は 'gemini' のまま、purpose で分かる）。
        status_name: INITIATIVE_GEMINI_STATUS,
        ...(config.policy.initiative.max_result_age_ms !== null ? { timeout_ms: config.policy.initiative.max_result_age_ms } : {}),
      });
    } catch (error) {
      return unavailable(`gemini: ${message(error).slice(0, 200)}`);
    }
  }
  return {
    enabled: true,
    reason: null,
    llm,
    persona,
    prompt_version: CURRENT_PROMPT_VERSION,
    model: llm.model_version,
    choice,
    ...(staged ? { staged } : {}),
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
