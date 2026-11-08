/**
 * 発話希望の判定の組み立て（app/providers.ts の initiativeFor と config の INITIATIVE_CONDITIONS）。
 * 実 API は呼ばない（キーのない環境と台本の LLM だけ）。
 */
import { describe, expect, it } from 'vitest';
import { ManualTimeSource, MemoryEventSink, createEventEmitter } from '@llm-vap/contracts';
import { readConfig } from '../../src/app/config';
import { createSessionProviders } from '../../src/app/providers';
import { ScriptedReplyLlm } from '../../src/app/scripted';

const time = new ManualTimeSource();
const emitter = createEventEmitter({ time, session_id: 's', condition: () => 'reactive', sink: new MemoryEventSink() });
const base = { STT_PROVIDER_CLASS: 'test_double', TTS_PROVIDER_CLASS: 'test_double', LLM_PROVIDER_CLASS: 'test_double' };

async function setupFor(env: Record<string, string>) {
  const config = readConfig({ ...base, ...env });
  return { config, initiative: (await createSessionProviders({ config, time, emitter, env: { ...base, ...env } })).initiative };
}

describe('発話希望の判定を動かす条件', () => {
  it('既定は ja の方策で3条件とも動かす', async () => {
    for (const condition of ['reactive', 'initiative_no_cue', 'initiative_inhale']) {
      const { config, initiative } = await setupFor({ CONDITION: condition });
      expect(config.initiative_conditions).toEqual(['reactive', 'initiative_no_cue', 'initiative_inhale']);
      expect(initiative).toMatchObject({ enabled: true, reason: null, prompt_version: 'initiative-ja-v2' });
      expect(initiative?.llm).toBeInstanceOf(ScriptedReplyLlm);
      // 既定は二段判定（llm）で、会話の種類の設定が persona を兼ねる（1段判定に戻すのは TIMING_STRATEGY=v2）。
      expect(initiative?.staged).toMatchObject({ timing_strategy: 'llm', conversation_kind: 'joint_thinking', desire_prompt_version: 'initiative-desire-ja-v2' });
      expect(initiative?.persona?.persona_id).toBe('joint_thinking_partner');
    }
  });

  it('v2 は従来の persona（PERSONA_FILE の既定）で、会話の種類を使わない', async () => {
    const { initiative } = await setupFor({ TIMING_STRATEGY: 'v2' });
    expect(initiative?.staged).toBeUndefined();
    expect(initiative?.persona?.persona_id).toBe('conversation_partner');
    expect(initiative?.choice).toMatchObject({ timing_strategy: 'v2' });
  });

  it('会話の種類と方式を環境変数で選べる。不正な値は起動時に落とす', async () => {
    const { initiative } = await setupFor({ CONVERSATION_KIND: 'companion', TIMING_STRATEGY: 'immediate' });
    expect(initiative?.staged).toMatchObject({ timing_strategy: 'immediate', conversation_kind: 'companion' });
    expect(initiative?.staged?.profile.persona_id).toBe('companion_partner');
    expect(() => readConfig({ ...base, CONVERSATION_KIND: 'Bad Kind' })).toThrow();
    expect(() => readConfig({ ...base, TIMING_STRATEGY: 'nonsense' })).toThrow();
  });

  it('PERSONA_FILE で展示会の同僚（反例の予備実験用）を選べる', async () => {
    const { initiative } = await setupFor({ TIMING_STRATEGY: 'v2', PERSONA_FILE: 'config/persona.ja.json' });
    expect(initiative?.persona?.persona_id).toBe('exhibition_colleague');
  });

  it('セッションの条件（condition）を渡すと、起動時の CONDITION でなくそれで判定を動かすかを決める', async () => {
    const env = { ...base, CONDITION: 'initiative_inhale', INITIATIVE_CONDITIONS: 'initiative_inhale' };
    const config = readConfig(env);
    const off = await createSessionProviders({ config, time, emitter, env, condition: 'reactive' });
    expect(off.initiative).toMatchObject({ enabled: false, reason: 'disabled_for_condition:reactive' });
    const on = await createSessionProviders({ config, time, emitter, env });
    expect(on.initiative?.enabled).toBe(true);
  });

  it('INITIATIVE_CONDITIONS に無い条件では止め、LLM を作らない。none で全部止める', async () => {
    const off = await setupFor({ CONDITION: 'reactive', INITIATIVE_CONDITIONS: 'initiative_no_cue,initiative_inhale' });
    expect(off.initiative).toMatchObject({ enabled: false, reason: 'disabled_for_condition:reactive', llm: null });
    const on = await setupFor({ CONDITION: 'initiative_no_cue', INITIATIVE_CONDITIONS: 'initiative_no_cue,initiative_inhale' });
    expect(on.initiative?.enabled).toBe(true);
    const none = await setupFor({ CONDITION: 'initiative_inhale', INITIATIVE_CONDITIONS: 'none' });
    expect(none.initiative).toMatchObject({ enabled: false, reason: 'disabled_for_condition:initiative_inhale' });
    expect(() => readConfig({ ...base, INITIATIVE_CONDITIONS: 'nonsense' })).toThrow();
  });

  it('hri2025 の方策（initiative 節がない）では止める', async () => {
    const { initiative } = await setupFor({ POLICY_FILE: 'config/policy.hri2025.json' });
    expect(initiative).toMatchObject({ enabled: false, reason: 'policy_has_no_initiative_section' });
  });

  it('本番の LLM でキーがなければ、動かすはずだったが作れなかった理由を返す（台本へ切り替えない）', async () => {
    const config = readConfig({ ...base, LLM_PROVIDER_CLASS: 'production', CONDITION: 'initiative_no_cue' });
    const saved = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      const providers = await createSessionProviders({ config, time, emitter, env: { ...base, LLM_PROVIDER_CLASS: 'production' } });
      expect(providers.initiative).toMatchObject({ enabled: true, llm: null, reason: 'gemini: GEMINI_API_KEY is not set' });
    } finally {
      if (saved !== undefined) process.env.GEMINI_API_KEY = saved;
    }
  });

  it('台本の LLM は判定の要求に NONE の構造化出力を返す（判定の経路を E2E で通すため。判断ではない）', async () => {
    const llm = new ScriptedReplyLlm({ time, first_delta_delay_ms: 0, delta_delay_ms: 0 });
    const result = await llm.generate({ request_id: 'r', purpose: 'initiative', system: 's', messages: [], response_json_schema: null, transcript_revision: 1 });
    expect(JSON.parse(result.text)).toMatchObject({ decision: 'NONE' });
  });
});
