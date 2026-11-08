/**
 * 研究の中心の経路: OFFER（吸気の提示）の後の人の反応ごとに、AI が発言、延期、内容変更、撤回できることを、
 * Session、TurnManager、ledger、negotiator、ブラウザへのメッセージ、イベントの全部を通して固定する。
 * LLM、TTS、STT は台本、VAP は偽の値。人の反応の妥当性、自然さ、実音声での VAP の振る舞いは何も試していない。
 *
 * 方式は llm と immediate の両方を全経路で通す。v2 は比較用なので代表の経路だけ。
 * 人が話し止んでから AI が話し始めるまでの時間を経路ごとに測る（OFFER_TIMING_JSON に書き出せる。値は偽の VAP の場合で、実音声の時間ではない）。
 */
import { appendFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { LlmRequest, NodeToBrowser } from '@llm-vap/contracts';
import { TIMING_JSON_SCHEMA } from '../../src/cognition/initiative';
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
const LONGER = `${STABLE}。それと日程は十一月の十二日からで会場は東京の予定です`;
const UTTERANCE = '確認させてください';
const REVISED = '会場の広さで予算は足りそうですか';
const REPLY = 'はい、承知しました。';

type Step = { p: [number, number, boolean]; loud?: boolean };
const SPEAKING: Step = { p: [0.1, 0.1, true], loud: true };
/** 人が黙り、VAP が AI 側を支持する。 */
const YIELD: Step = { p: [0.9, 0.9, false] };
/** 人が黙るが、VAP は AI 側を支持しない（p_now_ai が start_guard の下限未満）。 */
const PAUSE_LOW_VAP: Step = { p: [0.3, 0.3, false] };

type Mode = 'llm' | 'immediate' | 'v2';
type Say =
  | { d: 'NEW' }
  | { d: 'KEEP' }
  | { d: 'REVISE'; utterance?: string }
  | { d: 'WITHDRAW'; kind?: 'question_resolved' | 'premise_changed' | 'topic_moved' };

const NEW: Say = { d: 'NEW' };
const KEEP: Say = { d: 'KEEP' };
const REVISE: Say = { d: 'REVISE' };
const WITHDRAW = (kind: 'question_resolved' | 'premise_changed' | 'topic_moved' = 'premise_changed'): Say => ({ d: 'WITHDRAW', kind });

const desireReply = (say: Say | undefined): string => {
  const base = {
    reason: 'r',
    desire: 'NONE',
    target_candidate_id: '',
    intent_type: '',
    proposed_utterance: '',
    evidence_span: '',
    evidence_segment_ids: [] as number[],
    prior_turn_evidence_span: '',
    withdraw_kind: '',
    withdraw_reason: '',
    withdraw_evidence_span: '',
    withdraw_evidence_segment_ids: [] as number[],
  };
  if (say === undefined) return JSON.stringify(base);
  switch (say.d) {
    case 'NEW':
      return JSON.stringify({ ...base, desire: 'NEW', intent_type: 'CLARIFICATION', proposed_utterance: UTTERANCE, evidence_span: '五十万円', evidence_segment_ids: [0] });
    case 'KEEP':
      return JSON.stringify({ ...base, desire: 'KEEP', target_candidate_id: 'c_0001' });
    case 'REVISE':
      return JSON.stringify({ ...base, desire: 'REVISE', target_candidate_id: 'c_0001', intent_type: 'CLARIFICATION', proposed_utterance: say.utterance ?? REVISED, evidence_span: '五十万円', evidence_segment_ids: [0] });
    case 'WITHDRAW':
      return JSON.stringify({ ...base, desire: 'WITHDRAW', target_candidate_id: 'c_0001', withdraw_kind: say.kind ?? 'premise_changed', withdraw_reason: '前提が変わった', withdraw_evidence_span: '来週は中止', withdraw_evidence_segment_ids: [0] });
  }
};
const v2Reply = (say: Say | undefined): string => {
  const base = {
    reason: 'r',
    why_now: '',
    cost_of_waiting: '',
    resolution_outlook: '',
    decision: 'NONE',
    target_candidate_id: '',
    intent_type: '',
    evidence_span: '',
    evidence_segment_ids: [] as number[],
    proposed_utterance: '',
    expiry_policy: '',
    urgency: '',
    withdraw_reason: '',
    withdraw_evidence_span: '',
    withdraw_evidence_segment_ids: [] as number[],
  };
  if (say === undefined) return JSON.stringify(base);
  switch (say.d) {
    case 'NEW':
      return JSON.stringify({ ...base, decision: 'NEW', intent_type: 'CLARIFICATION', proposed_utterance: UTTERANCE, evidence_span: '五十万円', evidence_segment_ids: [0] });
    case 'KEEP':
      return JSON.stringify({ ...base, decision: 'KEEP', target_candidate_id: 'c_0001' });
    case 'REVISE':
      return JSON.stringify({ ...base, decision: 'REVISE', target_candidate_id: 'c_0001', intent_type: 'CLARIFICATION', proposed_utterance: say.utterance ?? REVISED, evidence_span: '五十万円', evidence_segment_ids: [0] });
    case 'WITHDRAW':
      return JSON.stringify({ ...base, decision: 'WITHDRAW', target_candidate_id: 'c_0001', withdraw_reason: '前提が変わった', withdraw_evidence_span: '来週は中止', withdraw_evidence_segment_ids: [0] });
  }
};
const timingReply = (verdict: string): string => JSON.stringify({ reason: 'r', why_now: '', cost_of_waiting: '', timing: verdict, target_candidate_id: 'c_0001', withdraw_reason: '', withdraw_evidence_span: '', withdraw_evidence_segment_ids: [] });
const isTiming = (request: LlmRequest) => request.response_json_schema === TIMING_JSON_SCHEMA;

/** 判定を順に返す（尽きたら NONE）。llm のタイミング段はいつも OFFER_NOW。 */
function scripted(mode: Mode, says: Say[]): RigInitiative {
  let n = 0;
  if (mode === 'v2') return { responder: () => v2Reply(says[n++]) };
  return { staged: { timing_strategy: mode }, responder: (request) => (isTiming(request) ? timingReply('OFFER_NOW') : desireReply(says[n++])) };
}

async function setup(mode: Mode, says: Say[], edit: (p: ReturnType<typeof productionJaPolicy>) => void = () => undefined): Promise<Rig> {
  const policy = productionJaPolicy();
  edit(policy);
  const r = await createRig({ condition: 'initiative_inhale', policy, reply: REPLY, initiative: scripted(mode, says) });
  await warmUp(r);
  return r;
}

/** 話している途中の文を届ける。判定が走り、結果の適用まで進む。 */
async function speak(r: Rig, text = STABLE): Promise<void> {
  r.stt().deliver({ kind: 'interim', text, stable_text: text, audio_frame_end: r.frame });
  await r.steps(3, SPEAKING);
}

const msgs = <T extends NodeToBrowser['type']>(r: Rig, type: T) => r.link.of(type);
const stateOf = (r: Rig) => r.session.candidates?.list()[0]?.state ?? null;
const states = (r: Rig) => r.events.ofType('candidate.state_changed').map((e) => `${e.from ?? 'null'}->${e.to}:${e.cause_source === 'code' ? e.cause : e.decision}`);
const discarded = (r: Rig) => (r.session.negotiationWiring?.discardedAudio ?? []).map((d) => `${d.candidate_id}@${d.candidate_version}:${d.reason}`);
const contextOf = (r: Rig, text: string) => r.tts().contexts.find((c) => c.sent.join('') === text);
const beginOf = (r: Rig, text: string) => {
  const ids = new Set(r.tts().contexts.filter((c) => c.sent.join('') === text).map((c) => c.audio_playback_id));
  return msgs(r, 'playback.begin').find((b) => ids.has(b.audio_playback_id)) ?? null;
};
async function until(r: Rig, condition: () => boolean, step: Step = YIELD, max = 400): Promise<boolean> {
  for (let i = 0; i < max && !condition(); i++) await r.step(step);
  return condition();
}
const reactions = (r: Rig) => r.events.ofType('negotiation.cue_reaction');
const selections = (r: Rig) => r.events.ofType('negotiation.decision').filter((e) => e.stage === 'speech_selection');

/** 候補の発話の後に共通で確かめる: 合図の後に開始、許可のある tick、1回だけ、状態が残らない。 */
function expectSpokeAfterCue(r: Rig, text: string): void {
  const cue = r.events.ofType('signal.sent').find((e) => e.phase === 'inhale')!;
  const start = r.events.ofType('candidate.state_changed').find((e) => e.to === 'SPEAKING')!;
  expect(cue).toBeDefined();
  expect(start).toBeDefined();
  // 吸気の長さを過ぎてから話す（声が先に出ない）。
  expect(start.t_monotonic_ms - cue.sent_at).toBeGreaterThanOrEqual(cue.parameters.duration_ms as number);
  // 開始の tick の turn.allowed は許可（許可なしで話さない）。
  const allowed = [...r.events.ofType('turn.allowed')].filter((e) => e.t_monotonic_ms <= start.t_monotonic_ms).at(-1);
  expect(allowed?.turn_allowed).toBe(true);
  expect(allowed?.t_monotonic_ms).toBe(start.t_monotonic_ms);
  // 話す音声は1回だけ、候補の版の文。
  const begins = msgs(r, 'playback.begin');
  expect(begins).toHaveLength(1);
  expect(begins[0]!.audio_playback_id).toBe(contextOf(r, text)!.audio_playback_id);
  expect(msgs(r, 'breath.cue')).toHaveLength(1);
  // 合図の状態が残らない。
  expect(r.session.negotiationWiring?.negotiatorState()).toMatchObject({ cue: null, deferred: [] });
}

/** 反応の記録の共通の確かめ: 合図ごとに1件、譲ったと確定する値を持たない。 */
function expectOneReaction(r: Rig) {
  const all = reactions(r);
  expect(all).toHaveLength(1);
  const reaction = all[0]!;
  expect(JSON.stringify(reaction)).not.toMatch(/yield|gave_way|accepted/);
  expect(reaction.cue_id).toBe('cue_0001');
  return reaction;
}

/** 発話の直後の版の PCM を棄てて、発話中に候補の状態を確かめ、話し終えて履歴と終端まで進める。 */
async function finishPlayback(r: Rig, text: string): Promise<void> {
  const begin = beginOf(r, text)!;
  r.browser(started(begin));
  await r.steps(3, YIELD);
  r.browser(ended(begin, 'completed', 16000));
  await r.steps(3, YIELD);
  expect(r.session.candidates?.list({ include_resolved: true })[0]).toMatchObject({ state: 'SPOKEN', proposed_utterance: text });
  expect(r.session.history.snapshot().filter((e) => e.role === 'assistant')).toMatchObject([{ origin: { kind: 'candidate', candidate_id: 'c_0001' }, text: expect.any(String) }]);
}

/** 人が話し止んでから AI の再生の開始までを測る（経路の表用）。 */
const timings: { route: string; mode: Mode; ms: number; vap: string }[] = [];
async function measureYield(r: Rig, route: string, mode: Mode, step: Step, text: string): Promise<number> {
  const stoppedAt = r.time.monotonicMs();
  const ok = await until(r, () => beginOf(r, text) !== null, step, 400);
  expect(ok).toBe(true);
  const ms = r.time.monotonicMs() - stoppedAt;
  timings.push({ route, mode, ms, vap: step === YIELD ? 'p_ai=0.9' : 'p_ai=0.3' });
  if (process.env.OFFER_TIMING_JSON) appendFileSync(process.env.OFFER_TIMING_JSON, `${JSON.stringify(timings.at(-1))}\n`);
  return ms;
}

describe.each(['llm', 'immediate'] as const)('吸気の後の人の反応（%s）', (mode) => {
  describe('受け入れ（間を取る、話し止む、招待で譲る）', () => {
    it('吸気の途中で話し止む → 吸気を終えて、許可の後に候補を話す（吸気の直後の経路）', async () => {
      rig = await setup(mode, [NEW]);
      await speak(rig);
      expect(msgs(rig, 'breath.cue')).toHaveLength(1);
      expect(stateOf(rig)).toBe('BREATH_INHALE');
      const ms = await measureYield(rig, 'inhale_stop', mode, YIELD, UTTERANCE);
      expect(ms).toBeGreaterThanOrEqual(900);
      expect(states(rig)).toEqual(['null->INTENT_READY:NEW', 'INTENT_READY->BREATH_INHALE:signal_gate_allowed', 'BREATH_INHALE->BREATH_HOLD_OR_READY:inhale_completed', 'BREATH_HOLD_OR_READY->SPEAKING:turn_allowed']);
      expectSpokeAfterCue(rig, UTTERANCE);
      await rig.step(YIELD); // 反応の観測は開始の次の tick で閉じる
      expect(msgs(rig, 'breath.release')).toEqual([expect.objectContaining({ reason: 'speech_started' })]);
      expect(msgs(rig, 'breath.prepare')).toEqual([]);
      expect(selections(rig).at(-1)).toMatchObject({ outcome: 'candidate', reasons: ['natural_yield', 'from:BREATH_HOLD_OR_READY'] });
      // 反応の観測: 話していて、止まって、AI が始めた（止まるまでの時間だけを残す）。
      const reaction = expectOneReaction(rig);
      expect(reaction).toMatchObject({ ended_by: 'ai_speech_started', user_speaking_at_cue: true, user_speaking_at_end: false, time_to_user_start_ms: { value: null, null_reason: 'user_speaking_at_cue' } });
      expect(reaction.time_to_user_stop_ms.value).toBeGreaterThanOrEqual(0);
      expect(reaction.p_now_ai_at_cue.value).toBeCloseTo(0.1);
      expect(reaction.p_now_ai_at_end.value).toBeCloseTo(0.9);
      await finishPlayback(rig, UTTERANCE);
    });

    it('保持の間に話し止む → 許可の後に候補を話す（保持の後の経路、DEFERRED に入らない）', async () => {
      rig = await setup(mode, [NEW]);
      await speak(rig);
      // 吸気（700ms）の間は話し続け、保持に入ってから hold_max_ms より前に話し止む。
      expect(await until(rig, () => stateOf(rig!) === 'BREATH_HOLD_OR_READY', SPEAKING)).toBe(true);
      await rig.steps(5, SPEAKING);
      expect(stateOf(rig)).toBe('BREATH_HOLD_OR_READY');
      const ms = await measureYield(rig, 'hold_stop', mode, YIELD, UTTERANCE);
      expect(ms).toBeGreaterThanOrEqual(900);
      expect(states(rig)).not.toContain('BREATH_HOLD_OR_READY->DEFERRED:user_continued');
      expect(states(rig).at(-1)).toBe('BREATH_HOLD_OR_READY->SPEAKING:turn_allowed');
      expectSpokeAfterCue(rig, UTTERANCE);
      expect(msgs(rig, 'breath.release').map((m) => m.reason)).toEqual(['speech_started']);
    });

    it('保持の間に話し止み、VAP が AI を支持しない → 長い待ち（completion_timeout）のあと候補を話す', async () => {
      rig = await setup(mode, [NEW]);
      await speak(rig);
      expect(await until(rig, () => stateOf(rig!) === 'BREATH_HOLD_OR_READY', SPEAKING)).toBe(true);
      await rig.steps(5, SPEAKING);
      const ms = await measureYield(rig, 'hold_stop_low_vap', mode, PAUSE_LOW_VAP, UTTERANCE);
      expect(ms).toBeGreaterThanOrEqual(1500);
      expect(states(rig).at(-1)).toBe('BREATH_HOLD_OR_READY->SPEAKING:turn_allowed');
      expectSpokeAfterCue(rig, UTTERANCE);
      expect(reactions(rig)[0]?.p_now_ai_at_end.value).toBeCloseTo(0.3);
    });

    it('招待（「どうぞ」）で譲る → cause は invitation で候補を話す（質問扱いにしない）', async () => {
      rig = await setup(mode, [NEW, KEEP]);
      await speak(rig);
      const invite = `${STABLE}。どうぞ`;
      rig.stt().deliver({ kind: 'final', text: invite, stable_text: invite, audio_frame_end: rig.frame });
      await rig.steps(2, YIELD);
      const ms = await measureYield(rig, 'invitation', mode, YIELD, UTTERANCE);
      expect(ms).toBeLessThan(1500); // 招待の間（最小の間）。VAP に依らない。
      expect(states(rig).at(-1)).toBe('BREATH_HOLD_OR_READY->SPEAKING:invitation');
      expect(selections(rig).at(-1)).toMatchObject({ outcome: 'candidate', reasons: ['invitation:どうぞ', 'from:BREATH_HOLD_OR_READY'] });
      expectSpokeAfterCue(rig, UTTERANCE);
    });

    it('話し止んで直接の質問で終わる → 通常応答を話し、候補は撤回（吸気は解く）', async () => {
      rig = await setup(mode, [NEW, KEEP]);
      await speak(rig);
      const question = `${STABLE}。どう思いますか`;
      rig.stt().deliver({ kind: 'final', text: question, stable_text: question, audio_frame_end: rig.frame });
      await rig.steps(2, YIELD);
      expect(await until(rig, () => msgs(rig!, 'playback.begin').length > 0)).toBe(true);
      expect(beginOf(rig, UTTERANCE)).toBeNull();
      expect(states(rig).at(-1)).toBe('BREATH_HOLD_OR_READY->WITHDRAWN:normal_response_started');
      expect(selections(rig).at(-1)).toMatchObject({ outcome: 'response', reasons: ['direct_question:invitation:どう思いますか'] });
      await rig.steps(3, YIELD);
      expect(msgs(rig, 'breath.release')).toHaveLength(1);
      expect(rig.session.negotiationWiring?.negotiatorState()).toMatchObject({ cue: null, deferred: [] });
    });
  });

  describe('話し続ける → 延期', () => {
    it('DEFERRED へ移り脱力、声は出さない。その後に譲られたら再吸気せず breath.prepare で話す', async () => {
      rig = await setup(mode, [NEW]);
      await speak(rig);
      expect(await until(rig, () => stateOf(rig!) === 'DEFERRED', SPEAKING)).toBe(true);
      expect(msgs(rig, 'playback.begin')).toHaveLength(0);
      expect(msgs(rig, 'breath.release')).toEqual([expect.objectContaining({ reason: 'deferred' })]);
      // 延期中は話さない（話し続けている間ずっと）。
      await rig.steps(30, SPEAKING);
      expect(msgs(rig, 'playback.begin')).toHaveLength(0);
      const ms = await measureYield(rig, 'deferred_then_yield', mode, YIELD, UTTERANCE);
      expect(ms).toBeGreaterThanOrEqual(900);
      expect(states(rig).slice(-2)).toEqual(['BREATH_HOLD_OR_READY->DEFERRED:user_continued', 'DEFERRED->SPEAKING:turn_allowed']);
      expect(msgs(rig, 'breath.cue')).toHaveLength(1); // 再吸気しない
      expect(msgs(rig, 'breath.prepare')).toEqual([{ type: 'breath.prepare', candidate_id: 'c_0001' }]);
      expect(selections(rig).at(-1)).toMatchObject({ outcome: 'candidate', reasons: ['natural_yield', 'from:DEFERRED'] });
      expectSpokeAfterCue(rig, UTTERANCE);
      // 反応の観測: 窓の間ずっと話していた（止まった時刻を作らない）。
      const reaction = expectOneReaction(rig);
      expect(reaction).toMatchObject({ ended_by: 'window', user_speaking_at_cue: true, user_speaking_at_end: true, time_to_user_stop_ms: { value: null, null_reason: 'user_did_not_stop_in_window' } });
      expect(reaction.user_speaking_ticks).toBe(reaction.ticks);
      expect(reaction.ticks).toBe((reaction.ended_at - reaction.cue_sent_at) / 20 + 1); // 合図の tick を二重に数えない
      expect(reaction.candidate_states).toEqual(expect.arrayContaining(['BREATH_INHALE', 'BREATH_HOLD_OR_READY', 'DEFERRED']));
      await finishPlayback(rig, UTTERANCE);
    });

    it('吸気の途中に話し始めても吸気を終えてから判定し、話し続ければ DEFERRED（声を出さない）', async () => {
      rig = await setup(mode, [NEW]);
      await rig.steps(30, SPEAKING);
      await rig.step(YIELD);
      rig.stt().deliver({ kind: 'final', text: STABLE, stable_text: STABLE, audio_frame_end: rig.frame });
      await rig.steps(3, YIELD); // 話し終わりの直後の NEW（人は黙っている）で合図。
      expect(msgs(rig, 'breath.cue')).toHaveLength(1);
      expect(stateOf(rig)).toBe('BREATH_INHALE');
      await rig.steps(10, SPEAKING); // 吸気の途中で話し始める。
      expect(stateOf(rig)).toBe('BREATH_INHALE');
      expect(await until(rig, () => stateOf(rig!) === 'DEFERRED', SPEAKING)).toBe(true);
      expect(msgs(rig, 'playback.begin')).toHaveLength(0);
      expect(await until(rig, () => reactions(rig!).length > 0, SPEAKING)).toBe(true);
      const reaction = expectOneReaction(rig);
      expect(reaction).toMatchObject({ ended_by: 'window', user_speaking_at_cue: false, time_to_user_stop_ms: { value: null, null_reason: 'user_not_speaking_at_cue' } });
      expect(reaction.time_to_user_start_ms.value).toBeGreaterThan(0);
    });

    it('吸気を長くすると、許可が吸気の間に出ても吸気を終えるまで開始を保留する（開始の直前に許可を再評価）', async () => {
      rig = await setup(mode, [NEW], (p) => {
        p.initiative.negotiation!.inhale_ms = 3000;
      });
      await speak(rig);
      const cueAt = rig.events.ofType('signal.sent')[0]!.sent_at;
      let permittedDuringInhale = false;
      while (rig.time.monotonicMs() < cueAt + 2900) {
        await rig.step(YIELD);
        if (rig.session.turnState.permitted_to_speak) permittedDuringInhale = true;
        expect(msgs(rig, 'playback.begin')).toHaveLength(0);
      }
      expect(permittedDuringInhale).toBe(true);
      expect(await until(rig, () => beginOf(rig!, UTTERANCE) !== null)).toBe(true);
      const start = rig.events.ofType('candidate.state_changed').find((e) => e.to === 'SPEAKING')!;
      expect(start.t_monotonic_ms - cueAt).toBeGreaterThanOrEqual(3000);
      expect(selections(rig).some((e) => e.outcome === 'wait' && e.reasons.includes('inhale_in_progress'))).toBe(true);
    });

    it('吸気の間に許可が出ても、吸気の終わりの前に人が話し始めたら話さない（開始の直前の再評価）', async () => {
      rig = await setup(mode, [NEW], (p) => {
        p.initiative.negotiation!.inhale_ms = 2000;
      });
      await speak(rig);
      const cueAt = rig.events.ofType('signal.sent')[0]!.sent_at;
      while (rig.time.monotonicMs() < cueAt + 1800) await rig.step(YIELD);
      expect(rig.session.turnState.permitted_to_speak).toBe(true);
      await rig.steps(15, SPEAKING); // 吸気の終わり（2000ms）をまたいで話す。
      expect(rig.session.turnState.permitted_to_speak).toBe(false);
      expect(msgs(rig, 'playback.begin')).toHaveLength(0);
      expect(stateOf(rig)).toBe('BREATH_HOLD_OR_READY');
    });
  });

  describe('話し続けて内容が変わる → 内容更新（REVISE）', () => {
    it('延期中に更新し、発言は新しい版（古い版の PCM は話さない）。再吸気しない', async () => {
      rig = await setup(mode, [NEW, REVISE]);
      await speak(rig);
      expect(await until(rig, () => stateOf(rig!) === 'DEFERRED', SPEAKING)).toBe(true);
      const v1 = contextOf(rig, UTTERANCE)!;
      await speak(rig, LONGER);
      expect(rig.session.candidates?.list()).toMatchObject([{ candidate_id: 'c_0001', candidate_version: 2, state: 'DEFERRED', proposed_utterance: REVISED }]);
      expect(discarded(rig)).toEqual(['c_0001@1:candidate_revised']);
      expect(states(rig).at(-1)).toBe('DEFERRED->DEFERRED:REVISE');
      const ms = await measureYield(rig, 'deferred_revise', mode, YIELD, REVISED);
      expect(ms).toBeGreaterThanOrEqual(900);
      expect(msgs(rig, 'playback.begin').map((b) => b.audio_playback_id)).not.toContain(v1.audio_playback_id);
      expectSpokeAfterCue(rig, REVISED);
      expect(msgs(rig, 'breath.prepare')).toEqual([{ type: 'breath.prepare', candidate_id: 'c_0001' }]);
      expect(selections(rig).at(-1)).toMatchObject({ outcome: 'candidate', candidate_version: { value: 2 } });
      // 候補の発話は v2 の音声（D の版の照合を通った）。
      expect(rig.events.ofType('speech.started')).toEqual([]); // 再生の報告の前は speech.started を出さない
      await finishPlayback(rig, REVISED);
    });

    it('保持の間の更新も再吸気せず、新しい版を話す', async () => {
      rig = await setup(mode, [NEW, REVISE]);
      await speak(rig);
      expect(await until(rig, () => stateOf(rig!) === 'BREATH_HOLD_OR_READY', SPEAKING)).toBe(true);
      await speak(rig, LONGER);
      expect(rig.session.candidates?.list()).toMatchObject([{ candidate_version: 2, state: 'BREATH_HOLD_OR_READY' }]);
      expect(discarded(rig)).toEqual(['c_0001@1:candidate_revised']);
      const ms = await measureYield(rig, 'hold_revise', mode, YIELD, REVISED);
      expect(ms).toBeGreaterThanOrEqual(900);
      expectSpokeAfterCue(rig, REVISED);
      expect(msgs(rig, 'breath.release').map((m) => m.reason)).toEqual(['speech_started']);
    });

    it('延期中の更新で新しい版の音声がまだのときに許可が出ても、古い版も通常応答も話さず、新しい版を待って話す', async () => {
      rig = await setup(mode, [NEW, REVISE]);
      await speak(rig);
      expect(await until(rig, () => stateOf(rig!) === 'DEFERRED', SPEAKING)).toBe(true);
      rig.pauseTts = true; // 新しい版の音声が届かない
      await speak(rig, LONGER);
      expect(rig.session.candidates?.list()).toMatchObject([{ candidate_version: 2, state: 'DEFERRED' }]);
      const finalAt = rig.time.monotonicMs();
      rig.stt().deliver({ kind: 'final', text: LONGER, stable_text: LONGER, audio_frame_end: rig.frame });
      await until(rig, () => rig!.session.turnState.permitted_to_speak, YIELD);
      // 通常応答の準備ができて、許可が出ている状況を作る（通常応答の音声だけを流す）。
      for (let i = 0; i < 15; i++) {
        await rig.step(YIELD);
        for (const c of rig.tts().contexts) if (c.sent.join('').startsWith('はい')) c.pumpAll();
      }
      expect(rig.session.turnState.permitted_to_speak).toBe(true);
      expect(rig.events.ofType('prefetch.ready').filter((e) => e.t_monotonic_ms >= finalAt).length).toBeGreaterThan(0); // 通常応答は準備済み
      expect(msgs(rig, 'playback.begin')).toHaveLength(0); // それでも始めない
      expect(selections(rig).at(-1)).toMatchObject({ outcome: 'wait', reasons: ['candidate_audio_preparing'] });
      // 届けば新しい版を話す。
      rig.pauseTts = false;
      await rig.steps(3, YIELD);
      expect(beginOf(rig, REVISED)).not.toBeNull();
      expect(beginOf(rig, UTTERANCE)).toBeNull();
    });

    it('延期中の更新で新しい版の音声が来ないまま許可が出続けたら、待ち時間の上限で候補を撤回し、通常応答へ戻す', async () => {
      rig = await setup(mode, [NEW, REVISE]);
      await speak(rig);
      expect(await until(rig, () => stateOf(rig!) === 'DEFERRED', SPEAKING)).toBe(true);
      rig.pauseTts = true;
      await speak(rig, LONGER);
      rig.stt().deliver({ kind: 'final', text: LONGER, stable_text: LONGER, audio_frame_end: rig.frame });
      const prepared = rig.time.monotonicMs();
      const normal = () => rig!.tts().contexts.find((c) => c.sent.join('') === REPLY);
      expect(await until(rig, () => stateOf(rig!) === null, YIELD, 200)).toBe(true);
      expect(rig.time.monotonicMs() - prepared).toBeLessThan(2500);
      expect(states(rig).at(-1)).toBe('DEFERRED->WITHDRAWN:audio_unavailable');
      expect(msgs(rig, 'breath.release').map((m) => m.reason)).toEqual(['deferred', 'withdrawn']);
      rig.pauseTts = false;
      normal()?.pumpAll();
      expect(await until(rig, () => beginOf(rig!, REPLY) !== null)).toBe(true);
      expect(beginOf(rig, REVISED)).toBeNull();
    });
  });

  describe('話し続けて疑問が解消する、前提が変わる → 撤回', () => {
    it.each(['question_resolved', 'premise_changed', 'topic_moved'] as const)('延期中の撤回（%s）: 声を出さず聞き手に戻す。breath.release(withdrawn)', async (kind) => {
      rig = await setup(mode, [NEW, WITHDRAW(kind)]);
      await speak(rig);
      expect(await until(rig, () => stateOf(rig!) === 'DEFERRED', SPEAKING)).toBe(true);
      const withdrawnAt = rig.time.monotonicMs();
      await speak(rig, MORE);
      expect(states(rig).at(-1)).toBe('DEFERRED->WITHDRAWN:WITHDRAW');
      const change = rig.events.ofType('candidate.state_changed').at(-1)!;
      expect(change.cause_source === 'model_decision' && change.withdraw_kind?.value).toBe(kind);
      expect(rig.events.ofType('initiative.desire').at(-1)).toMatchObject({ desire: 'WITHDRAW', outcome: 'withdrawn', withdraw_kind: { value: kind } });
      expect(discarded(rig)).toEqual(['c_0001@1:candidate_withdrawn']);
      expect(msgs(rig, 'breath.release').map((m) => m.reason)).toEqual(['deferred', 'withdrawn']);
      expect(rig.session.negotiationWiring?.negotiatorState()).toMatchObject({ cue: null, deferred: [] });
      // 以後、人が譲っても候補は話さず、通常の応答が出る。再び吸気しない。
      await rig.steps(200, YIELD);
      expect(beginOf(rig, UTTERANCE)).toBeNull();
      expect(msgs(rig, 'breath.cue')).toHaveLength(1);
      expect(rig.events.ofType('candidate.state_changed').at(-1)).toMatchObject({ to: 'WITHDRAWN' });
      expect(withdrawnAt).toBeGreaterThan(0);
    });

    it('吸気中の撤回: 吸気を解き、許可が出ても候補を話さない', async () => {
      rig = await setup(mode, [NEW, WITHDRAW('question_resolved')]);
      await speak(rig);
      expect(stateOf(rig)).toBe('BREATH_INHALE');
      await speak(rig, MORE);
      expect(states(rig).at(-1)).toBe('BREATH_INHALE->WITHDRAWN:WITHDRAW');
      expect(msgs(rig, 'breath.release').map((m) => m.reason)).toEqual(['withdrawn']);
      expect(reactions(rig)).toMatchObject([{ ended_by: 'candidate_withdrawn', cue_id: 'cue_0001', user_speaking_at_end: true }]);
      await rig.steps(100, YIELD);
      expect(beginOf(rig, UTTERANCE)).toBeNull();
      expect(rig.session.negotiationWiring?.negotiatorState()).toMatchObject({ cue: null, deferred: [] });
    });

    it('保持中の撤回: 候補を話さず release(withdrawn)、状態が残らない', async () => {
      rig = await setup(mode, [NEW, WITHDRAW('premise_changed')]);
      await speak(rig);
      expect(await until(rig, () => stateOf(rig!) === 'BREATH_HOLD_OR_READY', SPEAKING)).toBe(true);
      await speak(rig, MORE);
      expect(states(rig).at(-1)).toBe('BREATH_HOLD_OR_READY->WITHDRAWN:WITHDRAW');
      expect(msgs(rig, 'breath.release').map((m) => m.reason)).toEqual(['withdrawn']);
      await rig.steps(100, YIELD);
      expect(beginOf(rig, UTTERANCE)).toBeNull();
    });
  });

  describe('受け入れたように見えて、すぐ話を再開する', () => {
    it('話し止んで許可の前に再開したら話さず、保持の期限で DEFERRED。反応の観測は止まったことと再開を残す', async () => {
      rig = await setup(mode, [NEW]);
      await speak(rig);
      expect(await until(rig, () => stateOf(rig!) === 'BREATH_HOLD_OR_READY', SPEAKING)).toBe(true);
      await rig.steps(5, SPEAKING);
      await rig.steps(20, YIELD); // 400ms の間（許可の 900ms より短い）
      expect(rig.session.turnState.permitted_to_speak).toBe(false);
      expect(msgs(rig, 'playback.begin')).toHaveLength(0);
      expect(await until(rig, () => stateOf(rig!) === 'DEFERRED', SPEAKING)).toBe(true);
      expect(msgs(rig, 'playback.begin')).toHaveLength(0);
      expect(await until(rig, () => reactions(rig!).length > 0, SPEAKING)).toBe(true);
      const reaction = expectOneReaction(rig);
      expect(reaction.time_to_user_stop_ms.value).toBeGreaterThan(0);
      expect(reaction.user_speaking_at_end).toBe(true);
      expect(reaction).toMatchObject({ ended_by: 'window', user_speaking_at_cue: true });
    });

    it('発話の直後に再開したら割り込みで止まり、turn.outcome に開始の直後の続きとして残る。話した分だけが履歴へ', async () => {
      rig = await setup(mode, [NEW]);
      await speak(rig);
      const begin = await (async () => {
        await until(rig!, () => beginOf(rig!, UTTERANCE) !== null);
        return beginOf(rig!, UTTERANCE)!;
      })();
      rig.browser(started(begin, rig.frame));
      await rig.steps(3, YIELD);
      // 開始の直後に人が続ける（ASR に続きの文、VAP は人を支持）。
      rig.stt().deliver({ kind: 'interim', text: 'それでね予算の話なんですけど', audio_frame_end: rig.frame, segment_id: 1, asr_segment_id: 2 });
      await rig.steps(10, SPEAKING);
      const stop = msgs(rig, 'playback.stop').find((m) => m.audio_playback_id === begin.audio_playback_id);
      expect(stop).toBeDefined();
      rig.browser(ended({ audio_playback_id: begin.audio_playback_id, generation: stop!.generation }, 'stopped', 4800));
      await rig.steps(Math.ceil(1500 / 20), SPEAKING);
      expect(states(rig).at(-1)).toBe('SPEAKING->SPOKEN:speech_interrupted');
      const assistant = rig.session.history.snapshot().filter((e) => e.role === 'assistant');
      expect(assistant).toHaveLength(1);
      expect(assistant[0]?.interrupted).toBe(true);
      const outcome = rig.events.ofType('turn.outcome').find((o) => o.kind === 'ai_utterance');
      expect(outcome).toBeDefined();
      expect(outcome!.kind === 'ai_utterance' && outcome!.origin).toBe('candidate');
      expect(outcome!.labels.value).toEqual(expect.arrayContaining(['user_continued_after_start', 'suspected_premature_start']));
      expect(rig.session.negotiationWiring?.negotiatorState()).toMatchObject({ cue: null, deferred: [] });
    });
  });
});

describe('v2（1段判定、比較用の代表の経路）', () => {
  const mode = 'v2' as const;

  it('受け入れ: 吸気の後に許可で話す', async () => {
    rig = await setup(mode, [NEW]);
    await speak(rig);
    const ms = await measureYield(rig, 'inhale_stop', mode, YIELD, UTTERANCE);
    expect(ms).toBeGreaterThanOrEqual(900);
    expect(states(rig).at(-1)).toBe('BREATH_HOLD_OR_READY->SPEAKING:turn_allowed');
    expectSpokeAfterCue(rig, UTTERANCE);
    await rig.step(YIELD);
    expect(reactions(rig)[0]).toMatchObject({ ended_by: 'ai_speech_started', user_speaking_at_cue: true });
  });

  it('話し続ける → DEFERRED → 譲られたら breath.prepare で話す', async () => {
    rig = await setup(mode, [NEW]);
    await speak(rig);
    expect(await until(rig, () => stateOf(rig!) === 'DEFERRED', SPEAKING)).toBe(true);
    const ms = await measureYield(rig, 'deferred_then_yield', mode, YIELD, UTTERANCE);
    expect(ms).toBeGreaterThanOrEqual(900);
    expect(msgs(rig, 'breath.prepare')).toEqual([{ type: 'breath.prepare', candidate_id: 'c_0001' }]);
    expectSpokeAfterCue(rig, UTTERANCE);
  });

  it('REVISE → 新しい版を話す', async () => {
    rig = await setup(mode, [NEW, REVISE]);
    await speak(rig);
    expect(await until(rig, () => stateOf(rig!) === 'DEFERRED', SPEAKING)).toBe(true);
    await speak(rig, LONGER);
    const ms = await measureYield(rig, 'deferred_revise', mode, YIELD, REVISED);
    expect(ms).toBeGreaterThanOrEqual(900);
    expect(discarded(rig)).toEqual(['c_0001@1:candidate_revised']);
    expectSpokeAfterCue(rig, REVISED);
  });

  it('WITHDRAW → 声を出さず release(withdrawn)', async () => {
    rig = await setup(mode, [NEW, WITHDRAW()]);
    await speak(rig);
    expect(await until(rig, () => stateOf(rig!) === 'DEFERRED', SPEAKING)).toBe(true);
    await speak(rig, MORE);
    expect(states(rig).at(-1)).toBe('DEFERRED->WITHDRAWN:WITHDRAW');
    expect(msgs(rig, 'breath.release').map((m) => m.reason)).toEqual(['deferred', 'withdrawn']);
    await rig.steps(100, YIELD);
    expect(beginOf(rig, UTTERANCE)).toBeNull();
  });
});
