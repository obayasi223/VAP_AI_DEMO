/**
 * 二段判定（生成段とタイミング段）をセッションと交渉へつないだ結合試験。LLM、TTS、STT は台本、VAP は偽の値。
 * 配線だけを見る（モデルの判断の良し悪しは何も試していない）。OFFER_NOW で合図、WAIT_FOR_TURN_END は合図なしで話し終わりの候補、
 * 未判定は合図なし、v2 は従来どおり、AI の開始の後の final で判定を起動しない、MaAI の文脈の捨て直しで助走に戻る。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Condition, LlmRequest } from '@llm-vap/contracts';
import { TIMING_JSON_SCHEMA } from '../../src/cognition/initiative';
import type { Rig, RigInitiative } from './helpers';
import { createRig, productionJaPolicy, warmUp } from './helpers';

let rig: Rig | null = null;
afterEach(async () => {
  if (rig) {
    expect(rig.session.counters.tick_errors).toBe(0);
    await rig.session.close('test_done');
  }
  rig = null;
});

const STABLE = '来月の展示会の予算は五十万円のままで進めようと思っています';
const UTTERANCE = '確認させてください';
const DESIRE_NEW = JSON.stringify({
  reason: 'r',
  desire: 'NEW',
  target_candidate_id: '',
  intent_type: 'CLARIFICATION',
  proposed_utterance: UTTERANCE,
  evidence_span: '五十万円',
  evidence_segment_ids: [0],
  prior_turn_evidence_span: '',
});
const DESIRE_NONE = JSON.stringify({ ...JSON.parse(DESIRE_NEW), desire: 'NONE', intent_type: '', proposed_utterance: '', evidence_span: '', evidence_segment_ids: [] });
const timing = (verdict: string) =>
  JSON.stringify({
    reason: 'r',
    why_now: '',
    cost_of_waiting: '',
    timing: verdict,
    target_candidate_id: 'c_0001',
    withdraw_reason: '',
    withdraw_evidence_span: '',
    withdraw_evidence_segment_ids: [],
  });
const isTiming = (request: LlmRequest) => request.response_json_schema === TIMING_JSON_SCHEMA;

const SPEAKING: { p: [number, number, boolean]; loud: boolean } = { p: [0.1, 0.1, true], loud: true };
const YIELD: { p: [number, number, boolean] } = { p: [0.9, 0.9, false] };

async function setup(condition: Condition, initiative: RigInitiative): Promise<Rig> {
  const r = await createRig({ condition, policy: productionJaPolicy(), reply: 'はい、承知しました。', initiative });
  await warmUp(r);
  return r;
}

/** 生成段は初回だけ NEW、タイミング段は verdict（Promise なら待たせる）。 */
function staged(verdict: string | Promise<string>, strategy: 'llm' | 'immediate' = 'llm'): RigInitiative {
  let desired = false;
  return {
    staged: { timing_strategy: strategy },
    responder: (request) => {
      if (isTiming(request)) return verdict;
      if (desired) return DESIRE_NONE;
      desired = true;
      return DESIRE_NEW;
    },
  };
}

async function speakMidway(r: Rig): Promise<void> {
  r.stt().deliver({ kind: 'interim', text: STABLE, stable_text: STABLE, audio_frame_end: r.frame });
  await r.steps(3, SPEAKING);
}

const gate = (r: Rig) => r.events.ofType('negotiation.decision').filter((e) => e.stage === 'signal_gate');
const candidateBegin = (r: Rig) => {
  const context = r.tts().contexts.find((c) => c.sent.join('').includes(UTTERANCE));
  return r.link.of('playback.begin').find((b) => context && b.audio_playback_id === context.audio_playback_id) ?? null;
};
async function untilCandidate(r: Rig, max = 200) {
  for (let i = 0; i < max && candidateBegin(r) === null; i++) await r.step(YIELD);
  return candidateBegin(r);
}

describe('タイミング段の判定と合図', () => {
  it('OFFER_NOW: タイミング段の判定の後に吸気の合図を出し、吸気の後に候補を話す', async () => {
    rig = await setup('initiative_inhale', staged(timing('OFFER_NOW')));
    await speakMidway(rig);
    expect(rig.link.of('breath.cue')).toHaveLength(1);
    expect(rig.events.ofType('initiative.desire').map((e) => e.outcome)).toEqual(['registered']);
    expect(rig.events.ofType('initiative.timing').map((e) => e.outcome)).toEqual(['kept']);
    expect(gate(rig).find((e) => e.outcome === 'cue')?.reasons).toContain('timing_offer_now');
    expect(await untilCandidate(rig)).not.toBeNull();
    expect(rig.events.ofType('candidate.state_changed').map((e) => e.to)).toEqual([
      'INTENT_READY',
      'BREATH_INHALE',
      'BREATH_HOLD_OR_READY',
      'SPEAKING',
    ]);
  });

  it('タイミング段が届くまで（未判定）は合図せず、理由を残す', async () => {
    let release!: (s: string) => void;
    const pending = new Promise<string>((resolve) => (release = resolve));
    rig = await setup('initiative_inhale', staged(pending));
    await speakMidway(rig);
    expect(rig.link.of('breath.cue')).toHaveLength(0);
    expect(gate(rig).at(-1)).toMatchObject({ outcome: 'blocked', reasons: expect.arrayContaining(['timing_not_judged']) });
    release(timing('OFFER_NOW'));
    await rig.steps(2, SPEAKING);
    expect(rig.link.of('breath.cue')).toHaveLength(1);
  });

  it('WAIT_FOR_TURN_END: 合図はせず（吸気も準備動作もなし）、話し終わりの許可で候補を話す', async () => {
    rig = await setup('initiative_inhale', staged(timing('WAIT_FOR_TURN_END')));
    await speakMidway(rig);
    await rig.steps(10, SPEAKING);
    expect(rig.link.of('breath.cue')).toHaveLength(0);
    expect(rig.events.ofType('signal.sent')).toHaveLength(0);
    expect(gate(rig).at(-1)).toMatchObject({ outcome: 'blocked', reasons: expect.arrayContaining(['timing_wait_for_turn_end']) });
    expect(await untilCandidate(rig)).not.toBeNull();
    expect(rig.link.of('breath.cue')).toHaveLength(0);
    expect(rig.link.of('breath.prepare')).toHaveLength(0);
    expect(rig.events.ofType('negotiation.decision').filter((e) => e.stage === 'speech_selection').at(-1)).toMatchObject({
      outcome: 'candidate',
      reasons: ['natural_yield', 'from:INTENT_READY', 'timing_wait_for_turn_end'],
    });
    expect(rig.events.ofType('candidate.state_changed').map((e) => e.to)).toEqual(['INTENT_READY', 'SPEAKING']);
  });

  it('immediate: LLM を呼ばずに OFFER_NOW 相当で合図し、タイミング段の記録は model_call=false', async () => {
    rig = await setup('initiative_inhale', staged(timing('WAIT_FOR_TURN_END'), 'immediate'));
    await speakMidway(rig);
    expect(rig.link.of('breath.cue')).toHaveLength(1);
    expect(rig.initiativeLlm?.requests.filter(isTiming)).toHaveLength(0);
    expect(rig.events.ofType('initiative.timing')[0]).toMatchObject({ timing_strategy: 'immediate', timing: 'OFFER_NOW', model_call: false });
  });

  it('v2（二段なし）は従来どおり NEW の後にタイミング段なしで合図する', async () => {
    const NEW = JSON.stringify({
      reason: 'r',
      why_now: '',
      cost_of_waiting: '',
      resolution_outlook: '',
      decision: 'NEW',
      target_candidate_id: '',
      intent_type: 'CLARIFICATION',
      evidence_span: '五十万円',
      evidence_segment_ids: [0],
      proposed_utterance: UTTERANCE,
      expiry_policy: '',
      urgency: '',
      withdraw_reason: '',
      withdraw_evidence_span: '',
      withdraw_evidence_segment_ids: [],
    });
    rig = await setup('initiative_inhale', { responder: () => NEW });
    await speakMidway(rig);
    expect(rig.link.of('breath.cue')).toHaveLength(1);
    expect(rig.events.ofType('initiative.decision').map((e) => e.decision)).toContain('NEW');
    expect(rig.events.ofType('initiative.desire')).toHaveLength(0);
  });

  it('二段判定は履歴（直近の会話）をプロンプトへ渡し、manifest に種類、方式、版、由来を残す', async () => {
    rig = await setup('initiative_inhale', staged(timing('OFFER_NOW')));
    await speakMidway(rig);
    expect(rig.described.at(-1)?.initiative).toMatchObject({
      running: true,
      timing_strategy: 'llm',
      conversation_kind: 'joint_thinking',
      desire_prompt_version: 'initiative-desire-ja-v1',
      timing_prompt_version: 'initiative-timing-ja-v1',
      profile_version: 1,
      conversation_kind_source: 'client',
      timing_strategy_source: 'default',
      prompt_version: null,
    });
    expect(rig.events.ofType('initiative.desire')[0]).toMatchObject({ conversation_kind: 'joint_thinking', recent_turn_count: 0 });
    expect(rig.events.ofType('initiative.desire')[0]?.history_version.value).not.toBeNull();
  });

  it('v2 は manifest に会話の種類を書かない', async () => {
    rig = await setup('initiative_inhale', { responder: () => '{"decision":"NONE"}' });
    expect(rig.described.at(-1)?.initiative).toMatchObject({ running: true, conversation_kind: null, desire_prompt_version: null });
  });
});

describe('AI の発話が始まった後に届いた final', () => {
  const NO_CANDIDATE_REPLY = '{"decision":"NONE"}';

  async function startAiSpeech(r: Rig): Promise<number> {
    r.stt().deliver({ kind: 'interim', text: STABLE, stable_text: STABLE, audio_frame_end: r.frame });
    await r.steps(5, SPEAKING);
    r.stt().deliver({ kind: 'final', text: STABLE, stable_text: STABLE, audio_frame_end: r.frame });
    for (let i = 0; i < 200 && r.link.of('playback.begin').length === 0; i++) await r.step(YIELD);
    expect(r.session.turnState.segment_id).toBe(1);
    return r.initiativeLlm?.requests.length ?? 0;
  }

  it('前の segment の final では判定を起動しない。履歴の記録と応答は変わらない（reactive）', async () => {
    rig = await setup('reactive', { responder: () => NO_CANDIDATE_REPLY });
    const before = await startAiSpeech(rig);
    const late = `${STABLE}。それと別の話もあります`;
    rig.stt().deliver({ kind: 'final', text: late, stable_text: late, audio_frame_end: rig.frame, segment_id: 0, asr_segment_id: 7 });
    await rig.steps(3, YIELD);
    expect(rig.initiativeLlm?.requests.length).toBe(before);
    expect(rig.events.ofType('candidate.rejected')).toHaveLength(0);
    expect(rig.link.of('playback.begin').length).toBeGreaterThan(0);
    expect(rig.session.history.snapshot().some((e) => e.role === 'user' && e.text.includes('別の話'))).toBe(true);
  });

  it('次の segment の発話（AI の開始より後の音声）は今までどおり判定する', async () => {
    rig = await setup('reactive', { responder: () => NO_CANDIDATE_REPLY });
    const before = await startAiSpeech(rig);
    const text = '次のターンの話を十分な長さで始めています';
    rig.stt().deliver({ kind: 'final', text, stable_text: text, audio_frame_end: rig.frame, asr_segment_id: 8 });
    await rig.steps(3, YIELD);
    expect(rig.initiativeLlm?.requests.length).toBeGreaterThan(before);
  });
});

describe('MaAI の process_failed_reset', () => {
  it('文脈を捨てて続行したら VAP の助走に戻る（READY が来なくても）', async () => {
    rig = await setup('reactive', { responder: () => '{"decision":"NONE"}' });
    await rig.steps(1, YIELD);
    expect(rig.session.turnState.vap_freshness).toBe('fresh');
    rig.maai?.error('process_failed_reset', rig.time.monotonicMs());
    await rig.steps(1, YIELD);
    expect(rig.session.turnState.vap_freshness).toBe('warming_up');
  });

  it('別のコードの ERROR と、準備前の reset では助走を変えない', async () => {
    rig = await setup('reactive', { responder: () => '{"decision":"NONE"}' });
    rig.maai?.error('frames_dropped', rig.time.monotonicMs());
    await rig.steps(1, YIELD);
    expect(rig.session.turnState.vap_freshness).toBe('fresh');
    const fresh = await createRig({ condition: 'reactive', policy: productionJaPolicy() });
    fresh.maai?.error('process_failed_reset', fresh.time.monotonicMs());
    await fresh.steps(1, YIELD);
    expect(fresh.session.turnState.vap_freshness).toBe('down');
    await fresh.session.close('test_done');
  });
});
