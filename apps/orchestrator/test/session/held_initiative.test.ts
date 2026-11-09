/**
 * 保留中の発話希望の配線（WAIT の持ち越しと材料、撤回の全経路、immediate の全経路、合図への反応の記録、発声の失敗の復帰）の結合試験。
 * LLM、TTS、STT は台本、VAP は偽の値。モデルの判断、自然さ、VAP の性能は何も試していない。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Condition, LlmRequest, NodeToBrowser } from '@llm-vap/contracts';
import { TIMING_JSON_SCHEMA } from '../../src/cognition/initiative';
import { createResponsePromptBuilder } from '../../src/speech/response_prompt';
import type { Rig, RigInitiative } from './helpers';
import { createRig, ended, productionJaPolicy, started, warmUp } from './helpers';

let rig: Rig | null = null;
afterEach(async () => {
  if (rig) {
    expect(rig.session.counters.tick_errors).toBe(0);
    await rig.session.close('test_done');
  }
  rig = null;
});

const STABLE = '来月の展示会の予算は五十万円のままで進めようと思っています';
const MORE = `${STABLE}。でも来週は中止になりました`;
const UTTERANCE = '確認させてください';
const REPLY = 'はい、承知しました。';

const desire = (partial: Record<string, unknown> = {}) =>
  JSON.stringify({
    reason: 'r',
    desire: 'NONE',
    target_candidate_id: '',
    intent_type: '',
    proposed_utterance: '',
    evidence_span: '',
    evidence_segment_ids: [],
    prior_turn_evidence_span: '',
    withdraw_kind: '',
    withdraw_reason: '',
    withdraw_evidence_span: '',
    withdraw_evidence_segment_ids: [],
    ...partial,
  });
const NEW = desire({ desire: 'NEW', intent_type: 'CLARIFICATION', proposed_utterance: UTTERANCE, evidence_span: '五十万円', evidence_segment_ids: [0] });
const WITHDRAW = desire({
  desire: 'WITHDRAW',
  target_candidate_id: 'c_0001',
  withdraw_kind: 'premise_changed',
  withdraw_reason: '前提が変わった',
  withdraw_evidence_span: '来週は中止',
  withdraw_evidence_segment_ids: [0],
});
const timing = (verdict: string) =>
  JSON.stringify({ reason: 'r', why_now: '', cost_of_waiting: '', timing: verdict, target_candidate_id: 'c_0001', withdraw_reason: '', withdraw_evidence_span: '', withdraw_evidence_segment_ids: [] });
const isTiming = (request: LlmRequest) => request.response_json_schema === TIMING_JSON_SCHEMA;

type Step = { p: [number, number, boolean]; loud?: boolean };
const SPEAKING: Step = { p: [0.1, 0.1, true], loud: true };
const YIELD: Step = { p: [0.9, 0.9, false] };

/** 生成段は台本を順に（尽きたら NONE）。タイミング段は最後の値を繰り返す。 */
function staged(desires: string[], timings: string[], strategy: 'llm' | 'immediate' = 'llm'): RigInitiative {
  let d = 0;
  let t = 0;
  return {
    staged: { timing_strategy: strategy },
    responder: (request) => (isTiming(request) ? timings[Math.min(t++, timings.length - 1)]! : (desires[d++] ?? desire())),
  };
}
async function setup(initiative: RigInitiative, condition: Condition = 'initiative_inhale', edit: (p: ReturnType<typeof productionJaPolicy>) => void = () => undefined): Promise<Rig> {
  const policy = productionJaPolicy();
  edit(policy);
  const r = await createRig({ condition, policy, reply: REPLY, initiative });
  await warmUp(r);
  return r;
}
async function speak(r: Rig, text = STABLE): Promise<void> {
  r.stt().deliver({ kind: 'interim', text, stable_text: text, audio_frame_end: r.frame });
  await r.steps(3, SPEAKING);
}
/** 人が話し終わる（final が届き、黙る）。 */
async function finishTurn(r: Rig, text = STABLE): Promise<void> {
  r.stt().deliver({ kind: 'final', text, audio_frame_end: r.frame } as never);
  await r.steps(2, YIELD);
}
const msgs = <T extends NodeToBrowser['type']>(r: Rig, type: T) => r.link.of(type);
const states = (r: Rig) => r.events.ofType('candidate.state_changed').map((e) => `${e.from ?? 'null'}->${e.to}:${e.cause_source === 'code' ? e.cause : e.decision}`);
const contextOf = (r: Rig, text: string) => r.tts().contexts.find((c) => c.sent.join('').includes(text));
/** text の音声の再生の始まり（同じ文の音声が複数あれば、どれかが再生されていれば返す）。 */
const beginOf = (r: Rig, text: string) => {
  const ids = new Set(r.tts().contexts.filter((c) => c.sent.join('').includes(text)).map((c) => c.audio_playback_id));
  return msgs(r, 'playback.begin').find((b) => ids.has(b.audio_playback_id)) ?? null;
};
async function until(r: Rig, condition: () => boolean, step: Step = YIELD, max = 300): Promise<boolean> {
  for (let i = 0; i < max && !condition(); i++) await r.step(step);
  return condition();
}
const discarded = (r: Rig) => (r.session.negotiationWiring?.discardedAudio ?? []).map((d) => `${d.candidate_id}@${d.candidate_version}:${d.reason}`);
const decisions = (r: Rig, stage: string) => r.events.ofType('negotiation.decision').filter((e) => e.stage === stage);
const speechOf = (r: Rig) => r.session as unknown as { speech: { entries: Map<number, unknown>; fail(entry: unknown, reason: string): void } };

describe('WAIT_FOR_TURN_END（話し終わりまで待つ）の候補', () => {
  it.each(['initiative_inhale', 'initiative_no_cue'] as const)('%s: 吸気せず、候補の文を話さず、通常応答へ回す。候補は捨てずに持ち越し、渡したことと版を記録する', async (condition) => {
    rig = await setup(staged([NEW], [timing('WAIT_FOR_TURN_END')]), condition);
    await speak(rig);
    await rig.steps(10, SPEAKING);
    expect(msgs(rig, 'breath.cue')).toHaveLength(0);
    // WAIT の候補の音声は作らない。
    expect(contextOf(rig, UTTERANCE)).toBeUndefined();
    await finishTurn(rig);
    expect(await until(rig, () => beginOf(rig!, REPLY) !== null)).toBe(true);

    expect(beginOf(rig, UTTERANCE)).toBeNull();
    expect(rig.events.ofType('signal.sent')).toHaveLength(0);
    expect(decisions(rig, 'speech_selection').map((e) => e.reasons).flat()).toContain('timing_wait_for_turn_end');
    expect(states(rig)).toEqual(['null->INTENT_READY:NEW']);
    expect(rig.session.candidates?.list()).toMatchObject([{ candidate_id: 'c_0001', candidate_version: 1, state: 'INTENT_READY', carried_over: { from_segment_id: expect.any(Number) } }]);

    const notOffered = rig.events.ofType('initiative.not_offered');
    expect(notOffered).toMatchObject([{ candidate_id: 'c_0001', candidate_version: 1, reason: 'wait_for_turn_end' }]);
    const material = rig.events.ofType('initiative.response_material');
    expect(material).toHaveLength(1);
    expect(material[0]).toMatchObject({ candidate_id: 'c_0001', candidate_version: 1, prompt_version: expect.stringContaining('pending_material_v1'), proposed_utterance: { source: 'model_output', value: UTTERANCE } });
  });

  it('持ち越した候補も期限で消える（原因は expired で、内容の撤回とは別）', async () => {
    rig = await setup(staged([NEW], [timing('WAIT_FOR_TURN_END')]), 'initiative_inhale', (p) => {
      p.initiative.candidate_expiry_ms = 6000;
    });
    await speak(rig);
    await finishTurn(rig);
    await until(rig, () => rig!.events.ofType('initiative.not_offered').length > 0);
    expect(rig.session.candidates?.list()).toHaveLength(1);
    await until(rig, () => rig!.session.candidates?.list().length === 0);
    expect(states(rig).at(-1)).toBe('INTENT_READY->WITHDRAWN:expired');
    // 吸気していないので、解除の合図も出さない。
    expect(msgs(rig, 'breath.release')).toHaveLength(0);
  });

  it('話の途中で WAIT から OFFER_NOW へ変われば、吸気で申し出る', async () => {
    rig = await setup(staged([NEW, desire({ desire: 'KEEP', target_candidate_id: 'c_0001' })], [timing('WAIT_FOR_TURN_END'), timing('OFFER_NOW')]));
    await speak(rig);
    expect(msgs(rig, 'breath.cue')).toHaveLength(0);
    await speak(rig, MORE);
    expect(msgs(rig, 'breath.cue')).toHaveLength(1);
    expect(rig.events.ofType('initiative.timing').map((e) => e.timing_changed)).toEqual([false, true]);
  });

  it('タイミングが OFFER_NOW で吸気した候補は、通常応答の開始で従来どおり撤回する（持ち越さない）', async () => {
    rig = await setup(staged([NEW], [timing('OFFER_NOW')]));
    await speak(rig);
    expect(msgs(rig, 'breath.cue')).toHaveLength(1);
    await rig.session.negotiationWiring?.onNormalResponseStarted(rig.time.monotonicMs());
    expect(rig.session.candidates?.list().filter((c) => c.carried_over)).toHaveLength(0);
    expect(rig.events.ofType('initiative.not_offered')).toHaveLength(0);
  });

  it('initiative_no_cue で OFFER_NOW の候補は影の合図になり、通常応答の開始で inhale と同じく撤回する（持ち越さない）', async () => {
    rig = await setup(staged([NEW], [timing('OFFER_NOW')]), 'initiative_no_cue');
    await speak(rig);
    expect(rig.session.candidates?.list()).toMatchObject([{ state: 'BREATH_INHALE' }]);
    expect(msgs(rig, 'breath.cue')).toHaveLength(0);
    expect(rig.session.negotiationWiring?.counters.shadow_cues).toBe(1);
    await rig.session.negotiationWiring?.onNormalResponseStarted(rig.time.monotonicMs());
    expect(rig.session.candidates?.list().filter((c) => c.carried_over)).toHaveLength(0);
    expect(rig.events.ofType('initiative.not_offered')).toHaveLength(0);
  });

  it('reactive は WAIT を持ち越さず材料にもしない（従来どおり）', async () => {
    rig = await setup(staged([NEW], [timing('WAIT_FOR_TURN_END')]), 'reactive');
    await speak(rig);
    await finishTurn(rig);
    expect(await until(rig, () => beginOf(rig!, REPLY) !== null)).toBe(true);
    expect(rig.events.ofType('initiative.not_offered')).toHaveLength(0);
    expect(rig.events.ofType('initiative.response_material')).toHaveLength(0);
    expect(rig.session.candidates?.list().filter((c) => c.carried_over)).toHaveLength(0);
  });
});

describe('撤回の全経路で声を出さず、聞き手の状態へ戻す', () => {
  const offered = () => staged([NEW, WITHDRAW], [timing('OFFER_NOW')]);

  it('吸気中の内容の撤回: 候補の音声を破棄し、release(withdrawn)', async () => {
    rig = await setup(offered());
    rig.pauseTts = true;
    await speak(rig);
    expect(msgs(rig, 'breath.cue')).toHaveLength(1);
    await speak(rig, MORE);
    expect(states(rig).at(-1)).toBe('BREATH_INHALE->WITHDRAWN:WITHDRAW');
    expect(discarded(rig)).toEqual(['c_0001@1:candidate_withdrawn']);
    expect(msgs(rig, 'breath.release').at(-1)).toMatchObject({ reason: 'withdrawn', candidate_id: 'c_0001' });
    rig.pauseTts = false;
    await rig.steps(5, YIELD);
    expect(beginOf(rig, UTTERANCE)).toBeNull();
  });

  it('保持中の内容の撤回: 候補の音声を破棄し、release(withdrawn)', async () => {
    rig = await setup(offered());
    await speak(rig);
    expect(await until(rig, () => rig!.session.candidates?.list()[0]?.state === 'BREATH_HOLD_OR_READY', SPEAKING)).toBe(true);
    await speak(rig, MORE);
    expect(states(rig).at(-1)).toBe('BREATH_HOLD_OR_READY->WITHDRAWN:WITHDRAW');
    expect(discarded(rig)).toEqual(['c_0001@1:candidate_withdrawn']);
    expect(msgs(rig, 'breath.release').at(-1)).toMatchObject({ reason: 'withdrawn' });
    await rig.steps(5, YIELD);
    expect(beginOf(rig, UTTERANCE)).toBeNull();
  });

  it('DEFERRED の内容の撤回: 候補の音声を破棄し、deferred の後に release(withdrawn)', async () => {
    rig = await setup(offered());
    await speak(rig);
    expect(await until(rig, () => rig!.session.candidates?.list()[0]?.state === 'DEFERRED', SPEAKING)).toBe(true);
    await speak(rig, MORE);
    expect(states(rig).at(-1)).toBe('DEFERRED->WITHDRAWN:WITHDRAW');
    expect(discarded(rig)).toEqual(['c_0001@1:candidate_withdrawn']);
    expect(msgs(rig, 'breath.release').map((m) => m.reason)).toEqual(['deferred', 'withdrawn']);
    await rig.steps(5, YIELD);
    expect(beginOf(rig, UTTERANCE)).toBeNull();
  });

  it('DEFERRED で候補の音声が失敗したら声を出さず、release(withdrawn)、原因は audio_unavailable', async () => {
    rig = await setup(staged([NEW], [timing('OFFER_NOW')]));
    rig.pauseTts = true;
    await speak(rig);
    expect(await until(rig, () => rig!.session.candidates?.list()[0]?.state === 'DEFERRED', SPEAKING)).toBe(true);
    const context = contextOf(rig, UTTERANCE)!;
    const speech = speechOf(rig).speech;
    speech.fail(speech.entries.get(context.audio_playback_id), 'tts_failed: test');
    await rig.steps(2, SPEAKING);
    expect(states(rig).at(-1)).toBe('DEFERRED->WITHDRAWN:audio_unavailable');
    expect(msgs(rig, 'breath.release').at(-1)).toMatchObject({ reason: 'withdrawn' });
    expect(decisions(rig, 'candidate_audio').some((e) => e.outcome === 'audio_abandoned')).toBe(true);
    rig.pauseTts = false;
    await rig.steps(5, YIELD);
    expect(beginOf(rig, UTTERANCE)).toBeNull();
  });
});

describe('immediate（すぐ申し出る）', () => {
  const immediate = () => staged([NEW], [timing('WAIT_FOR_TURN_END')], 'immediate');

  it('人が話している間は吸気で提示するだけで、声を出さない（許可なしに発声しない）', async () => {
    rig = await setup(immediate());
    await speak(rig);
    expect(msgs(rig, 'breath.cue')).toHaveLength(1);
    await rig.steps(10, SPEAKING);
    expect(msgs(rig, 'playback.begin')).toHaveLength(0);
    expect(rig.initiativeLlm?.requests.filter(isTiming)).toHaveLength(0);
  });

  it('保持中に人が止まって許可が出たら話す（吸気→保持→発声の順）', async () => {
    rig = await setup(immediate());
    await speak(rig);
    expect(await until(rig, () => rig!.session.candidates?.list()[0]?.state === 'BREATH_HOLD_OR_READY', SPEAKING)).toBe(true);
    expect(msgs(rig, 'playback.begin')).toHaveLength(0);
    expect(await until(rig, () => beginOf(rig!, UTTERANCE) !== null)).toBe(true);
    expect(states(rig)).toEqual(['null->INTENT_READY:NEW', 'INTENT_READY->BREATH_INHALE:signal_gate_allowed', 'BREATH_INHALE->BREATH_HOLD_OR_READY:inhale_completed', 'BREATH_HOLD_OR_READY->SPEAKING:turn_allowed']);
    const sent = rig.events.ofType('signal.sent')[0]!;
    expect(sent.phase).toBe('inhale');
  });

  it('人が話し続けたら DEFERRED へ移り脱力、声は出さず、後で許可が出たら話す', async () => {
    rig = await setup(immediate());
    await speak(rig);
    expect(await until(rig, () => rig!.session.candidates?.list()[0]?.state === 'DEFERRED', SPEAKING)).toBe(true);
    expect(msgs(rig, 'playback.begin')).toHaveLength(0);
    expect(msgs(rig, 'breath.release').map((m) => m.reason)).toEqual(['deferred']);
    expect(await until(rig, () => beginOf(rig!, UTTERANCE) !== null)).toBe(true);
    expect(msgs(rig, 'breath.cue')).toHaveLength(1);
  });

  it('合図の後の人の反応を cue ごとに記録する（譲ったとは断定しない数値のみ）', async () => {
    rig = await setup(immediate());
    await speak(rig);
    await rig.steps(5, SPEAKING);
    await until(rig, () => rig!.events.ofType('negotiation.cue_reaction').length > 0);
    const [reaction] = rig.events.ofType('negotiation.cue_reaction');
    expect(reaction).toMatchObject({ cue_id: 'cue_0001', candidate_id: 'c_0001', candidate_version: 1, window_ms: 2000, user_speaking_at_cue: true });
    expect(reaction!.ended_by === 'window' || reaction!.ended_by === 'ai_speech_started').toBe(true);
    expect(reaction!.user_speaking_ticks).toBeGreaterThan(0);
    expect(reaction!.candidate_states).toContain('BREATH_INHALE');
    expect(JSON.stringify(reaction)).not.toMatch(/yield|gave_way/);
  });

  it('候補が撤回されたら反応の観測をその時点で閉じる', async () => {
    rig = await setup(staged([NEW, WITHDRAW], [timing('OFFER_NOW')], 'immediate'));
    await speak(rig);
    await speak(rig, MORE);
    expect(rig.events.ofType('negotiation.cue_reaction')).toMatchObject([{ cue_id: 'cue_0001', ended_by: 'candidate_withdrawn' }]);
  });
});

describe('発声の失敗からの復帰（再試行しない）', () => {
  async function speakingCandidate(r: Rig) {
    await speak(r);
    await finishTurn(r);
    expect(await until(r, () => beginOf(r, UTTERANCE) !== null)).toBe(true);
    return beginOf(r, UTTERANCE)!;
  }
  const noCue = () => setup(staged([NEW], [timing('OFFER_NOW')]), 'initiative_no_cue');
  const recovery = (r: Rig) => decisions(r, 'candidate_audio').filter((e) => e.outcome === 'normal_response_recovery' || e.outcome === 'no_recovery');
  const assistantEntries = (r: Rig) => r.session.history.snapshot().filter((e) => e.role === 'assistant');

  it('1 音も出ずに終わったら、人が待っていれば通常の応答へ戻す。候補は再試行しない。原因を残す', async () => {
    rig = await noCue();
    const begin = await speakingCandidate(rig);
    rig.browser(ended(begin, 'completed', 0));
    await rig.step(YIELD);
    expect(states(rig).at(-1)).toBe('SPEAKING->WITHDRAWN:speech_no_audio');
    expect(await until(rig, () => beginOf(rig!, REPLY) !== null)).toBe(true);
    expect(recovery(rig)).toMatchObject([{ outcome: 'normal_response_recovery', reasons: expect.arrayContaining(['cause:speech_no_audio']) }]);
    expect(msgs(rig, 'playback.begin').filter((b) => b.audio_playback_id === begin.audio_playback_id)).toHaveLength(1);
    expect(rig.session.candidates?.want()).toEqual({ kind: 'none' });
    expect(assistantEntries(rig).filter((e) => e.origin.kind === 'candidate')).toEqual([]);
  });

  it('書き込み前に D が失敗したら Node の状態を残さず、通常の応答へ戻す', async () => {
    rig = await noCue();
    const begin = await speakingCandidate(rig);
    const speech = speechOf(rig).speech;
    speech.fail(speech.entries.get(begin.audio_playback_id), 'sink_failed: test');
    await rig.step(YIELD);
    expect(states(rig).at(-1)).toBe('SPEAKING->WITHDRAWN:speech_failed');
    expect(rig.session.turnState.speaking.phase).not.toBe('speaking');
    expect(await until(rig, () => beginOf(rig!, REPLY) !== null)).toBe(true);
    expect(recovery(rig)).toMatchObject([{ outcome: 'normal_response_recovery', reasons: expect.arrayContaining(['cause:speech_failed']) }]);
  });

  it('一部でも再生した後の失敗は通常の応答へ戻さない。履歴には話した部分だけ入る', async () => {
    rig = await noCue();
    const begin = await speakingCandidate(rig);
    rig.browser(started(begin));
    await rig.steps(3, YIELD);
    const speech = speechOf(rig).speech;
    speech.fail(speech.entries.get(begin.audio_playback_id), 'sink_failed: test');
    await rig.step(YIELD);
    rig.browser(ended(begin, 'stopped', 4800));
    await rig.steps(3, YIELD);
    expect(states(rig).at(-1)).toBe('SPEAKING->WITHDRAWN:speech_failed');
    expect(recovery(rig)).toMatchObject([{ outcome: 'no_recovery', reasons: expect.arrayContaining(['partly_spoken']) }]);
    expect(beginOf(rig, REPLY)).toBeNull();
    expect(assistantEntries(rig)).toHaveLength(1);
    expect(assistantEntries(rig)[0]!.text.length).toBeLessThan(UTTERANCE.length);
  });

  it('復帰の時点で人が話し始めていたら通常の応答を起こさない（理由を残す）', async () => {
    rig = await noCue();
    const begin = await speakingCandidate(rig);
    await rig.steps(4, SPEAKING);
    rig.browser(ended(begin, 'completed', 0));
    await rig.step(SPEAKING);
    expect(recovery(rig).at(-1)).toMatchObject({ outcome: 'no_recovery', reasons: expect.arrayContaining(['user_speaking']) });
    expect(beginOf(rig, REPLY)).toBeNull();
  });

  it('吸気で提示した候補の発声が失敗しても、アバターの解除を送り、状態を残さない', async () => {
    rig = await setup(staged([NEW], [timing('OFFER_NOW')]));
    const begin = await speakingCandidate(rig);
    expect(msgs(rig, 'breath.cue')).toHaveLength(1);
    rig.browser(ended(begin, 'completed', 0));
    await rig.step(YIELD);
    expect(states(rig).at(-1)).toBe('SPEAKING->WITHDRAWN:speech_no_audio');
    expect(rig.session.negotiationWiring?.negotiatorState().cue).toBeNull();
  });
});

describe('通常応答のプロンプトへの材料', () => {
  const history = { snapshot: () => [] } as never;
  const request = { text: '話し終わりました', segment_id: 1, origin: { kind: 'response' } } as never;

  it('材料があれば system に「自然に活かせるときだけ」と内容を足す（強制しない）', () => {
    const build = createResponsePromptBuilder({ history, system: 'SYS', pending_material: () => ({ intent_type: 'QUESTION', proposed_utterance: UTTERANCE }) });
    const { system, messages } = build(request);
    expect(system.startsWith('SYS')).toBe(true);
    expect(system).toContain('自然に活かせるときだけ');
    expect(system).toContain('使わずに無視');
    expect(system).toContain(UTTERANCE);
    expect(messages.at(-1)).toEqual({ role: 'user', text: '話し終わりました' });
  });

  it('材料がなければ今までのプロンプトのまま', () => {
    expect(createResponsePromptBuilder({ history, system: 'SYS', pending_material: () => null })(request).system).toBe('SYS');
    expect(createResponsePromptBuilder({ history, system: 'SYS' })(request).system).toBe('SYS');
  });
});
