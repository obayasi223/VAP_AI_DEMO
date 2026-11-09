/**
 * 波3: 発話希望を振る舞いにつなぐ配線（session.ts ＋ negotiation_wiring.ts）の結合試験。
 * LLM は台本（決まった NEW を返す）、TTS と STT も台本、VAP は偽の値。モデルの判断、合成の品質、VAP の性能は何も試していない。
 * 守ること: 条件ごとの振る舞い（reactive は今と同じ、no_cue は inhale と同じ制御で提示だけしない、inhale は吸気の後に話す）、
 * 吸気中の開始の保留、DEFERRED、期限、通常応答による撤回、二つ目の NEW の棄却、直接の質問、PCM の破棄、履歴。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Condition, NodeToBrowser } from '@llm-vap/contracts';
import type { Rig } from './helpers';
import { createRig, ended, position, productionJaPolicy, started, warmUp } from './helpers';

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
const json = (o: Record<string, unknown>) =>
  JSON.stringify({
    reason: 'r',
    why_now: '',
    cost_of_waiting: '',
    resolution_outlook: '',
    decision: 'NONE',
    target_candidate_id: '',
    intent_type: '',
    evidence_span: '',
    evidence_segment_ids: [],
    proposed_utterance: '',
    expiry_policy: '',
    urgency: '',
    withdraw_reason: '',
    withdraw_evidence_span: '',
    withdraw_evidence_segment_ids: [],
    ...o,
  });
const NEW = json({ decision: 'NEW', evidence_span: '五十万円', evidence_segment_ids: [0], proposed_utterance: UTTERANCE, intent_type: 'CLARIFICATION' });
const SPEAKING: { p: [number, number, boolean]; loud: boolean } = { p: [0.1, 0.1, true], loud: true };
/** 人が黙り、VAP が AI 側を支持する（許可が出る値）。 */
const YIELD: { p: [number, number, boolean] } = { p: [0.9, 0.9, false] };

async function setup(condition: Condition, responder: () => string | Promise<string> = () => NEW, policy = productionJaPolicy()): Promise<Rig> {
  const r = await createRig({ condition, policy, reply: 'はい、承知しました。', initiative: { responder } });
  await warmUp(r);
  return r;
}

/** 話している途中の安定テキスト。判定が走り、候補ができる。 */
async function speakMidway(r: Rig, text = STABLE): Promise<void> {
  r.stt().deliver({ kind: 'interim', text, stable_text: text, audio_frame_end: r.frame });
  await r.steps(3, SPEAKING);
}

const discarded = (r: Rig) => (r.session.negotiationWiring?.discardedAudio ?? []).map((d) => `${d.candidate_id}@${d.candidate_version}:${d.reason}`);
const NONE = json({ decision: 'NONE' });
/** 利用者が話を再開した値。 */
const USER_BACK: { p: [number, number, boolean]; loud: boolean } = { p: [0.1, 0.1, true], loud: true };
const candidateContext = (r: Rig) => r.tts().contexts.find((c) => c.sent.join('').includes(UTTERANCE));
const msgs = <T extends NodeToBrowser['type']>(r: Rig, type: T) => r.link.of(type);
/** first の最後の送信が second の最初の送信より前。 */
const sentBefore = (r: Rig, first: NodeToBrowser['type'], second: NodeToBrowser['type']) => {
  const order = r.link.json.map((m) => m.type);
  return order.lastIndexOf(first) >= 0 && order.lastIndexOf(first) < order.indexOf(second);
};
const states = (r: Rig) =>
  r.events.ofType('candidate.state_changed').map((e) => `${e.from ?? 'null'}->${e.to}:${e.cause_source === 'code' ? e.cause : e.decision}`);

/** 候補の再生が始まるまで（playback.begin が候補の音声）進める。 */
async function untilCandidateBegins(r: Rig, step = YIELD, max = 200) {
  for (let i = 0; i < max; i++) {
    await r.step(step);
    const ctx = candidateContext(r);
    const begin = msgs(r, 'playback.begin').find((b) => ctx && b.audio_playback_id === ctx.audio_playback_id);
    if (begin) return begin;
  }
  return null;
}

describe('initiative_inhale（提案: 吸気で合図してから話す）', () => {
  it('話の途中の NEW → 候補の音声（proposed_utterance をそのまま TTS へ）→ 吸気の合図 → 人が話し続けて DEFERRED → 許可で候補を話す（再吸気しない）→ 履歴に AI の発話として残る', async () => {
    rig = await setup('initiative_inhale');
    await speakMidway(rig);
    // 候補の音声は候補の文そのまま（作り直す LLM の呼び出しはない）。
    expect(candidateContext(rig)?.sent.join('')).toBe(UTTERANCE);
    expect(rig.initiativeLlm?.requests.filter((r) => r.purpose !== 'initiative')).toHaveLength(0);
    // 合図（吸気）。長さは orchestrator が決める（policy の inhale_ms）。
    const cue = msgs(rig, 'breath.cue');
    expect(cue).toEqual([{ type: 'breath.cue', cue_id: 'cue_0001', candidate_id: 'c_0001', duration_ms: 700 }]);
    expect(rig.events.ofType('signal.sent')[0]).toMatchObject({ phase: 'inhale', parameters: { cue_id: 'cue_0001', duration_ms: 700, inhale_completion: 'orchestrator_clock' } });
    // 人は話し続ける: 吸気（700ms）→ 準備姿勢（800ms）→ DEFERRED（脱力）。
    await rig.steps(80, SPEAKING);
    expect(msgs(rig, 'breath.release')).toEqual([{ type: 'breath.release', cue_id: 'cue_0001', candidate_id: 'c_0001', reason: 'deferred' }]);
    expect(rig.session.candidates?.list()).toMatchObject([{ candidate_id: 'c_0001', state: 'DEFERRED' }]);
    // 人が黙り、許可が出たら候補を話す。
    const begin = await untilCandidateBegins(rig);
    expect(begin).not.toBeNull();
    expect(msgs(rig, 'breath.cue')).toHaveLength(1); // 再吸気しない
    expect(msgs(rig, 'breath.prepare')).toEqual([{ type: 'breath.prepare', candidate_id: 'c_0001' }]); // 短い準備動作だけ
    expect(sentBefore(rig, 'breath.prepare', 'playback.begin')).toBe(true); // 合図は音より先に届く
    expect(states(rig)).toEqual([
      'null->INTENT_READY:NEW',
      'INTENT_READY->BREATH_INHALE:signal_gate_allowed',
      'BREATH_INHALE->BREATH_HOLD_OR_READY:inhale_completed',
      'BREATH_HOLD_OR_READY->DEFERRED:user_continued',
      'DEFERRED->SPEAKING:turn_allowed',
    ]);
    // 選択の理由が残る。
    expect(rig.events.ofType('negotiation.decision').filter((e) => e.stage === 'speech_selection').at(-1)).toMatchObject({
      outcome: 'candidate',
      reasons: ['natural_yield', 'from:DEFERRED'],
    });
    // 通常の応答は始まらず、候補を話し始めても撤回されない。
    expect(rig.events.ofType('candidate.state_changed').some((e) => e.cause_source === 'code' && e.cause === 'normal_response_started')).toBe(false);
    // 再生が終わったら SPOKEN、履歴に候補の発話（発話済みの部分）として残る。
    rig.browser(started(begin!));
    await rig.steps(3, YIELD);
    rig.browser(ended(begin!, 'completed', 16000));
    await rig.steps(3, YIELD);
    expect(rig.session.candidates?.list({ include_resolved: true })).toMatchObject([{ candidate_id: 'c_0001', state: 'SPOKEN' }]);
    const assistant = rig.session.history.snapshot().filter((e) => e.role === 'assistant');
    expect(assistant).toMatchObject([{ origin: { kind: 'candidate', candidate_id: 'c_0001' } }]);
    expect(rig.session.turnState.segment_id).toBe(1);
  });

  it('吸気中に許可が来ても吸気を終えるまで（通常応答も含めて）開始を保留し、終えたら開始の直前に許可を見直して話す', async () => {
    rig = await setup('initiative_inhale');
    await speakMidway(rig);
    expect(msgs(rig, 'breath.cue')).toHaveLength(1);
    const cueAt = rig.events.ofType('signal.sent')[0]!.sent_at;
    // 合図の直後に人が黙る。許可（最小の間 900ms）は吸気（700ms）より後なので、この試験では許可の前に吸気が終わる。
    // 吸気中の保留そのものは、許可を先に出す方策で次の試験が確かめる。
    const begin = await untilCandidateBegins(rig);
    expect(begin).not.toBeNull();
    expect(rig.time.monotonicMs() - cueAt).toBeGreaterThanOrEqual(700);
    expect(states(rig).slice(-2)).toEqual(['BREATH_INHALE->BREATH_HOLD_OR_READY:inhale_completed', 'BREATH_HOLD_OR_READY->SPEAKING:turn_allowed']);
    expect(msgs(rig, 'breath.release').at(-1)).toMatchObject({ reason: 'speech_started' });
    expect(msgs(rig, 'breath.prepare')).toEqual([]); // 吸気から直接話すときは解除だけ
    expect(sentBefore(rig, 'breath.release', 'playback.begin')).toBe(true); // 合図は音より先に届く
  });

  it('吸気中に許可が出ている間は、準備済みの通常応答も始めない（吸気を終えてから候補を話す）', async () => {
    const policy = productionJaPolicy();
    // 吸気を長くして、吸気の間に許可が出るようにする（値は試験のため）。
    policy.initiative.negotiation!.inhale_ms = 3000;
    rig = await setup('initiative_inhale', () => NEW, policy);
    await speakMidway(rig);
    expect(msgs(rig, 'breath.cue')).toEqual([expect.objectContaining({ duration_ms: 3000 })]);
    const cueAt = rig.events.ofType('signal.sent')[0]!.sent_at;
    let permittedDuringInhale = false;
    let readyDuringInhale = false;
    for (let i = 0; i < 200; i++) {
      await rig.step(YIELD);
      if (rig.time.monotonicMs() - cueAt < 3000) {
        if (rig.session.turnState.permitted_to_speak) permittedDuringInhale = true;
        if (rig.events.ofType('prefetch.ready').length > 0) readyDuringInhale = true;
        expect(msgs(rig, 'playback.begin')).toHaveLength(0);
      }
    }
    expect(permittedDuringInhale).toBe(true);
    // 「準備済みの通常応答」が吸気の間に実在した（ready で待っていた）うえで始まっていないこと。
    expect(readyDuringInhale).toBe(true);
    const ctx = candidateContext(rig)!;
    expect(msgs(rig, 'playback.begin').map((b) => b.audio_playback_id)).toEqual([ctx.audio_playback_id]);
  });

  it('期限（candidate_expiry_ms）で撤回し、吸気を解き、未再生の PCM を棄てる', async () => {
    const policy = productionJaPolicy();
    policy.initiative.candidate_expiry_ms = 2000;
    rig = await setup('initiative_inhale', () => NEW, policy);
    await speakMidway(rig);
    const ctx = candidateContext(rig)!;
    await rig.steps(120, SPEAKING);
    expect(states(rig).at(-1)).toBe('DEFERRED->WITHDRAWN:expired');
    expect(discarded(rig)).toEqual(['c_0001@1:expired']);
    expect(rig.session.negotiationWiring?.negotiatorState().cue).toBeNull();
    // 期限の後に人が黙っても候補は話さない。
    await rig.steps(150, YIELD);
    expect(msgs(rig, 'playback.begin').some((b) => b.audio_playback_id === ctx.audio_playback_id)).toBe(false);
  });

  it('直前の発話が直接の質問なら通常応答を優先し、通常応答を話し始めたら候補を撤回する（PCM も棄てる）', async () => {
    rig = await setup('initiative_inhale');
    await speakMidway(rig);
    await rig.steps(80, SPEAKING); // DEFERRED まで
    const ctx = candidateContext(rig)!;
    // 最後に AI への質問で終える。
    rig.stt().deliver({ kind: 'final', text: `${STABLE}。どう思いますか`, stable_text: `${STABLE}。どう思いますか`, audio_frame_end: rig.frame });
    for (let i = 0; i < 200 && msgs(rig, 'playback.begin').length === 0; i++) await rig.step(YIELD);
    const begin = msgs(rig, 'playback.begin')[0];
    expect(begin).toBeDefined();
    expect(begin!.audio_playback_id).not.toBe(ctx.audio_playback_id);
    expect(states(rig).at(-1)).toBe('DEFERRED->WITHDRAWN:normal_response_started');
    expect(discarded(rig)).toEqual(['c_0001@1:normal_response_started']);
    expect(rig.events.ofType('negotiation.decision').filter((e) => e.stage === 'speech_selection').map((e) => e.reasons[0])).toContain(
      'direct_question:invitation:どう思いますか',
    );
  });

  it('活動中に来た二つ目の NEW は棄却し、理由を candidate.state_changed に残す（吸気は連続しない）', async () => {
    rig = await setup('initiative_inhale');
    await speakMidway(rig);
    await speakMidway(rig, `${STABLE}。それと日程は十一月の十二日からで、会場は東京の予定です`);
    await rig.steps(10, SPEAKING);
    expect(rig.events.ofType('candidate.state_changed').filter((e) => e.from === null).map((e) => `${e.candidate_id}:${e.to}:${e.cause_source === 'code' ? e.cause : e.decision}`)).toEqual([
      'c_0001:INTENT_READY:NEW',
      'c_0002:WITHDRAWN:active_candidate_exists',
    ]);
    expect(msgs(rig, 'breath.cue')).toHaveLength(1);
  });

  it('改訂（REVISE）では再吸気せず、古い版の未再生の PCM を棄てて新しい版の文を準備する', async () => {
    let n = 0;
    const REVISE = json({
      decision: 'REVISE',
      target_candidate_id: 'c_0001',
      evidence_span: '五十万円',
      evidence_segment_ids: [0],
      proposed_utterance: '五十万円で足りますか',
      intent_type: 'CLARIFICATION',
    });
    rig = await setup('initiative_inhale', () => (n++ === 0 ? NEW : REVISE));
    await speakMidway(rig);
    await speakMidway(rig, `${STABLE}。それと日程は十一月の十二日からで、会場は東京の予定です`);
    await rig.steps(3, SPEAKING);
    expect(rig.session.candidates?.list()).toMatchObject([{ candidate_id: 'c_0001', candidate_version: 2 }]);
    expect(discarded(rig)).toEqual(['c_0001@1:candidate_revised']);
    expect(rig.tts().contexts.some((c) => c.sent.join('') === '五十万円で足りますか')).toBe(true);
    await rig.steps(80, SPEAKING);
    expect(msgs(rig, 'breath.cue')).toHaveLength(1);
  });
});

describe('initiative_no_cue（影の合図: inhale と同じ制御で、提示だけしない）', () => {
  /** 同じ入力を流して、候補の状態の時刻と開始の時点を集める。 */
  async function scenario(condition: Condition) {
    const r = await setup(condition);
    await speakMidway(r);
    await r.steps(80, SPEAKING);
    const begin = await untilCandidateBegins(r);
    const t0 = r.events.ofType('candidate.state_changed')[0]!.t_monotonic_ms;
    return {
      r,
      begin,
      states: states(r),
      times: r.events.ofType('candidate.state_changed').map((e) => e.t_monotonic_ms - t0),
      begin_frame: r.frame,
      selection: r.events.ofType('negotiation.decision').filter((e) => e.stage === 'speech_selection').map((e) => `${e.outcome}:${e.reasons.join('+')}`),
    };
  }

  it('同じ状態の経路を通り、参加者には何も提示しない（breath.* も signal.* も出さない）', async () => {
    const run = await scenario('initiative_no_cue');
    rig = run.r;
    expect(run.begin).not.toBeNull();
    expect(run.states).toEqual([
      'null->INTENT_READY:NEW',
      'INTENT_READY->BREATH_INHALE:signal_gate_allowed',
      'BREATH_INHALE->BREATH_HOLD_OR_READY:inhale_completed',
      'BREATH_HOLD_OR_READY->DEFERRED:user_continued',
      'DEFERRED->SPEAKING:turn_allowed',
    ]);
    for (const type of ['breath.cue', 'breath.release', 'breath.prepare'] as const) expect(msgs(rig, type)).toHaveLength(0);
    for (const type of ['signal.sent', 'signal.started', 'signal.ended'] as const) expect(rig.events.ofType(type)).toHaveLength(0);
    expect(rig.session.negotiationWiring?.counters).toMatchObject({ cues: 0, shadow_cues: 1, deferred: 1 });
  });

  it('提示していないことがログから分かる（ゲート、解除、manifest）', async () => {
    const run = await scenario('initiative_no_cue');
    rig = run.r;
    const gates = rig.events.ofType('negotiation.decision').filter((e) => e.stage === 'signal_gate');
    expect(gates.find((e) => e.outcome === 'shadow_cue')).toMatchObject({ reasons: expect.arrayContaining(['not_presented:initiative_no_cue']) });
    expect(gates.filter((e) => e.outcome === 'cue')).toHaveLength(0);
    expect(gates.find((e) => e.outcome === 'shadow_release')).toMatchObject({ reasons: ['reason:deferred', 'cue_id:shadow_cue_0001', 'not_presented:initiative_no_cue'] });
    expect(rig.described.at(-1)?.initiative).toMatchObject({ candidates_used_for: 'negotiation:initiative_no_cue', cue_presentation: 'shadow_not_presented' });
  });

  it('initiative_inhale と同じ時刻に状態が進み、同じ時点で話し始める。違いは提示だけ', async () => {
    const inhale = await scenario('initiative_inhale');
    expect(inhale.r.described.at(-1)?.initiative).toMatchObject({ cue_presentation: 'presented' });
    const cueCount = msgs(inhale.r, 'breath.cue').length;
    await inhale.r.session.close('test_done');
    const shadow = await scenario('initiative_no_cue');
    rig = shadow.r;
    expect(cueCount).toBe(1);
    expect(shadow.states).toEqual(inhale.states);
    expect(shadow.times).toEqual(inhale.times);
    expect(shadow.begin_frame).toBe(inhale.begin_frame);
    expect(shadow.selection).toEqual(inhale.selection);
    expect(candidateContext(shadow.r)?.sent.join('')).toBe(UTTERANCE);
  });

  it('人の様子の観測は同じ窓で測り、提示していないと記録する', async () => {
    const pick = (r: Rig) => r.events.ofType('negotiation.cue_reaction')[0]!;
    const inhale = await scenario('initiative_inhale');
    const shown = pick(inhale.r);
    await inhale.r.session.close('test_done');
    const shadow = await scenario('initiative_no_cue');
    rig = shadow.r;
    const hidden = pick(shadow.r);
    expect(shown).toMatchObject({ cue_id: 'cue_0001', cue_presented: true });
    expect(hidden).toMatchObject({ cue_id: 'shadow_cue_0001', cue_presented: false });
    const observed = (e: typeof shown) => ({ window_ms: e.window_ms, ended_by: e.ended_by, ticks: e.ticks, observed_ms: e.observed_ms, user_speaking_ticks: e.user_speaking_ticks, user_speaking_at_cue: e.user_speaking_at_cue, candidate_states: e.candidate_states });
    expect(observed(hidden)).toEqual(observed(shown));
  });
});

describe('reactive（ベースライン: 通常応答だけ）', () => {
  it('判定は同じ経路で走らせて候補を記録するが、候補の音声を作らず、合図も発話もしない。通常の応答で撤回する', async () => {
    rig = await setup('reactive');
    await speakMidway(rig);
    await rig.steps(80, SPEAKING);
    expect(rig.session.candidates?.list()).toMatchObject([{ state: 'INTENT_READY' }]);
    expect(candidateContext(rig)).toBeUndefined();
    expect(msgs(rig, 'breath.cue')).toHaveLength(0);
    for (let i = 0; i < 200 && msgs(rig, 'playback.begin').length === 0; i++) await rig.step(YIELD);
    expect(msgs(rig, 'playback.begin')).toHaveLength(1);
    expect(states(rig)).toEqual(['null->INTENT_READY:NEW', 'INTENT_READY->WITHDRAWN:normal_response_started']);
    expect(rig.events.ofType('negotiation.decision').map((e) => `${e.stage}:${e.outcome}:${e.reasons.join('+')}`)).toEqual([
      'signal_gate:no_cue_condition:condition:reactive',
      'speech_selection:response:condition:reactive',
    ]);
    expect(rig.described.at(-1)?.initiative).toMatchObject({ candidates_used_for: 'log_and_research_view_only' });
  });
});

describe('撤回と失敗、無音の終わり（波3のレビューの追加）', () => {
  /** 許可が出て候補が話し始めるまで。 */
  async function candidateSpeaking(condition: Condition = 'initiative_no_cue') {
    const r = await setup(condition);
    await speakMidway(r);
    const begin = await untilCandidateBegins(r);
    expect(begin).not.toBeNull();
    return { r, begin: begin! };
  }

  it('DEFERRED の候補の撤回で breath.release(withdrawn) を送る（cue_id は DEFERRED へ移した合図のもの）', async () => {
    const policy = productionJaPolicy();
    policy.initiative.candidate_expiry_ms = 2000;
    rig = await setup('initiative_inhale', () => NEW, policy);
    await speakMidway(rig);
    await rig.steps(120, SPEAKING);
    expect(states(rig).at(-1)).toBe('DEFERRED->WITHDRAWN:expired');
    expect(msgs(rig, 'breath.release')).toEqual([
      { type: 'breath.release', cue_id: 'cue_0001', candidate_id: 'c_0001', reason: 'deferred' },
      { type: 'breath.release', cue_id: 'cue_0001', candidate_id: 'c_0001', reason: 'withdrawn' },
    ]);
    expect(rig.events.ofType('signal.sent').map((e) => e.parameters.reason ?? e.phase)).toEqual(['inhale', 'deferred', 'withdrawn']);
  });

  it('再生の途中で D が失敗したら候補を SPEAKING に残さず終端し、次の NEW を塞がない。遅れた終わりの報告で拒否は出さない', async () => {
    const { r, begin } = await candidateSpeaking();
    rig = r;
    r.browser(started(begin));
    const speech = (r.session as unknown as { speech: { entries: Map<number, unknown>; fail(entry: unknown, reason: string): void } }).speech;
    speech.fail(speech.entries.get(begin.audio_playback_id), 'sink_failed: test');
    await r.step(YIELD);
    expect(states(r).at(-1)).toBe('SPEAKING->WITHDRAWN:speech_failed');
    expect(r.session.candidates?.want()).toEqual({ kind: 'none' });
    expect(r.session.candidates?.getRecord('c_0001')?.withdraw).toMatchObject({ source: 'code', cause: 'speech_failed' });
    // 既に再生が始まっていた音声の終わりの報告が遅れて届く（履歴は発話済みの部分だけ）。拒否の記録は出さない。
    r.browser(ended(begin, 'stopped', 4800));
    await r.step(YIELD);
    expect(r.events.ofType('candidate.rejected').filter((e) => e.operation === 'transition')).toHaveLength(0);
    expect(r.session.history.snapshot().filter((e) => e.role === 'assistant')).toMatchObject([{ origin: { kind: 'candidate', candidate_id: 'c_0001' } }]);
  });

  it('1 音も出ずに終わった候補は SPOKEN にせず speech_no_audio で閉じ、履歴に入れない', async () => {
    const { r, begin } = await candidateSpeaking();
    rig = r;
    // playback.started なし、samples_written 0（reason は completed でも）。
    r.browser(ended(begin, 'completed', 0));
    await r.step(YIELD);
    expect(states(r).at(-1)).toBe('SPEAKING->WITHDRAWN:speech_no_audio');
    expect(r.session.candidates?.list({ include_resolved: true })).toMatchObject([{ state: 'WITHDRAWN' }]);
    expect(r.session.history.snapshot().filter((e) => e.role === 'assistant')).toEqual([]);
  });

  it('割り込まれた候補は発話済みの部分だけが履歴に入る（SPOKEN、speech_interrupted）', async () => {
    const { r, begin } = await candidateSpeaking();
    rig = r;
    r.browser(started(begin));
    await r.steps(5, YIELD);
    // 文の途中まで再生した位置で人が割り込む。
    r.browser(position(begin, 2 * 16000 * 0.3));
    await r.step(YIELD);
    await r.steps(40, USER_BACK);
    expect(msgs(r, 'playback.stop').map((m) => m.audio_playback_id)).toContain(begin.audio_playback_id);
    const stop = msgs(r, 'playback.stop').find((m) => m.audio_playback_id === begin.audio_playback_id)!;
    r.browser(ended({ audio_playback_id: begin.audio_playback_id, generation: stop.generation }, 'stopped', 16000 * 0.3));
    await r.step(USER_BACK);
    expect(states(r).at(-1)).toBe('SPEAKING->SPOKEN:speech_interrupted');
    const assistant = r.session.history.snapshot().filter((e) => e.role === 'assistant');
    expect(assistant).toHaveLength(1);
    expect(assistant[0]?.interrupted).toBe(true);
    expect(assistant[0]?.text.length).toBeGreaterThan(0);
    expect(assistant[0]?.text.length).toBeLessThan(UTTERANCE.length);
    expect(UTTERANCE.startsWith(assistant[0]!.text)).toBe(true);
  });
});

describe('タイミングの結合（波3のレビューの追加）', () => {
  it('吸気中に利用者が再開したら、吸気を終えても話し始めず DEFERRED へ移す', async () => {
    const policy = productionJaPolicy();
    policy.initiative.negotiation!.inhale_ms = 1400;
    rig = await setup('initiative_inhale', () => NEW, policy);
    await speakMidway(rig);
    const cueAt = rig.time.monotonicMs();
    await rig.steps(40, YIELD); // 吸気の途中まで人が黙り
    expect(rig.session.candidates?.list()).toMatchObject([{ state: 'BREATH_INHALE' }]);
    expect(msgs(rig, 'playback.begin')).toHaveLength(0);
    await rig.steps(130, USER_BACK); // 再開して話し続ける
    expect(rig.time.monotonicMs() - cueAt).toBeGreaterThan(1400 + 800);
    expect(msgs(rig, 'playback.begin')).toHaveLength(0);
    expect(rig.session.candidates?.list()).toMatchObject([{ state: 'DEFERRED' }]);
    expect(states(rig)).toContain('BREATH_HOLD_OR_READY->DEFERRED:user_continued');
    expect(msgs(rig, 'breath.release').map((m) => m.reason)).toEqual(['deferred']);
  });

  it('吸気の終わりの直前に REVISE が届くと、許可の tick は新しい版の音声がまだなので候補を話さない（古い版の PCM は再生しない）', async () => {
    let n = 0;
    const REVISED = '五十万円で足りますか';
    const REVISE = json({ decision: 'REVISE', target_candidate_id: 'c_0001', evidence_span: '五十万円', evidence_segment_ids: [0], proposed_utterance: REVISED, intent_type: 'CLARIFICATION' });
    const policy = productionJaPolicy();
    policy.initiative.negotiation!.inhale_ms = 1400; // 吸気の間に許可が出る長さ（値は試験のため）。
    rig = await setup('initiative_inhale', () => (n++ === 0 ? NEW : REVISE), policy);
    await speakMidway(rig);
    const v1 = candidateContext(rig)!;
    const inhaleEnds = rig.events.ofType('signal.sent')[0]!.sent_at + 1400;
    // 吸気が終わる tick の 2 つ前まで。人は黙り、許可は吸気の間に出る。
    while (rig.time.monotonicMs() + 2 * 20 < inhaleEnds) await rig.step(YIELD);
    expect(rig.session.turnState.permitted_to_speak).toBe(true);
    const longer = `${STABLE}。それと日程は十一月の十二日からで会場は東京の予定です`;
    rig.stt().deliver({ kind: 'interim', text: longer, stable_text: longer, audio_frame_end: rig.frame });
    await rig.step(YIELD); // REVISE が適用される（新しい版の音声はまだない）
    expect(rig.session.candidates?.getRecord('c_0001')?.candidate_version).toBe(2);
    expect(discarded(rig)).toEqual(['c_0001@1:candidate_revised']);
    await rig.step(YIELD); // 吸気の完了と許可が同じ tick。音声は準備中
    const selections = rig.events.ofType('negotiation.decision').filter((e) => e.stage === 'speech_selection');
    expect(selections.at(-1)).toMatchObject({ outcome: 'wait', reasons: ['candidate_audio_preparing'] });
    expect(states(rig)).toContain('BREATH_INHALE->BREATH_HOLD_OR_READY:inhale_completed');
    expect(msgs(rig, 'playback.begin')).toHaveLength(0);
    // 音声は次の tick で届き、新しい版を話す（古い版は再生しない）。通常の応答には切り替わらない。
    for (let i = 0; i < 20 && msgs(rig, 'playback.begin').length === 0; i++) await rig.step(YIELD);
    const begun = msgs(rig, 'playback.begin').map((b) => b.audio_playback_id);
    expect(begun).toHaveLength(1);
    expect(begun).not.toContain(v1.audio_playback_id);
    const v2 = rig.tts().contexts.find((c) => c.sent.join('').includes(REVISED))!;
    expect(begun).toEqual([v2.audio_playback_id]);
    expect(states(rig).at(-1)).toBe('BREATH_HOLD_OR_READY->SPEAKING:turn_allowed');
  });

  it('AI の発話中に届いた NEW には合図を出さない。話し終えたら改めてゲートを通す', async () => {
    let propose = false;
    const SECOND = 'お尋ねしてもよいですか';
    const NEW_SECOND = json({ decision: 'NEW', evidence_span: '展示会', evidence_segment_ids: [1], proposed_utterance: SECOND, intent_type: 'CLARIFICATION' });
    rig = await setup('initiative_inhale', () => (propose ? NEW_SECOND : NONE));
    // 通常の応答が始まるまで（判定は NONE）。
    rig.stt().deliver({ kind: 'final', text: `${STABLE}。よろしくお願いします`, stable_text: `${STABLE}。よろしくお願いします`, audio_frame_end: rig.frame });
    for (let i = 0; i < 200 && msgs(rig, 'playback.begin').length === 0; i++) await rig.step(YIELD);
    const begin = msgs(rig, 'playback.begin')[0]!;
    rig.browser(started(begin));
    await rig.steps(2, YIELD);
    // AI の発話中に、次の segment の発話で NEW。
    propose = true;
    const text = '展示会の話なのですが会場の広さはどのくらいになるのでしょうか教えていただけますかお願いします';
    rig.stt().deliver({ kind: 'interim', text, stable_text: text, audio_frame_end: rig.frame });
    // 人が黙っている間の NEW は話の後として保留され、人の再開で候補になる（E2a）。
    await rig.steps(3, YIELD);
    await rig.steps(2, SPEAKING);
    await rig.steps(2, YIELD);
    expect(rig.session.candidates?.list()).toMatchObject([{ state: 'INTENT_READY', proposed_utterance: SECOND }]);
    expect(msgs(rig, 'breath.cue')).toHaveLength(0);
    expect(rig.events.ofType('negotiation.decision').filter((e) => e.stage === 'signal_gate').at(-1)).toMatchObject({ outcome: 'blocked', reasons: expect.arrayContaining(['ai_speaking']) });
    // 話し終えたらゲートを通って合図が出る。
    rig.browser(ended(begin, 'completed', 16000));
    await rig.steps(5, YIELD);
    expect(msgs(rig, 'breath.cue')).toEqual([expect.objectContaining({ candidate_id: 'c_0001' })]);
  });

  it('吸気中に close したら合図は送らず、以後の tick でも何も起きない（アバターは保持の上限で自分で戻る）', async () => {
    rig = await setup('initiative_inhale');
    await speakMidway(rig);
    expect(rig.session.candidates?.list()).toMatchObject([{ state: 'BREATH_INHALE' }]);
    const sent = rig.link.json.length;
    await rig.session.close('test_close');
    rig.time.advance(5000);
    rig.session.tick();
    await rig.steps(5, YIELD);
    expect(rig.link.json.slice(sent).filter((m) => m.type.startsWith('breath.'))).toEqual([]);
    expect(rig.session.counters.tick_errors).toBe(0);
  });
});

describe('記録の正しさ（波3のレビューの追加）', () => {
  it('切断で送れなかった合図は signal.sent に残さず、signal_not_sent として記録する', async () => {
    rig = await setup('initiative_inhale');
    await speakMidway(rig);
    const sentBefore = rig.events.ofType('signal.sent').length;
    // 吸気中に切断。人は話し続けるので、準備姿勢の後に DEFERRED の脱力を送ろうとする。
    rig.session.detach('test_detach');
    await rig.steps(80, SPEAKING);
    expect(rig.session.candidates?.list()).toMatchObject([{ state: 'DEFERRED' }]);
    expect(rig.events.ofType('signal.sent').length).toBe(sentBefore);
    expect(rig.events.ofType('negotiation.decision').filter((e) => e.outcome === 'signal_not_sent')).toMatchObject([
      { stage: 'signal_gate', candidate_id: { value: 'c_0001' }, reasons: ['phase:relax', 'cue_id:cue_0001'] },
    ]);
    expect(rig.session.negotiationWiring?.counters.signals_not_sent).toBe(1);
  });

  it('開始できない理由は同じ種類が続く間 1 回だけ記録する（毎 tick 出さない）', async () => {
    rig = await setup('initiative_no_cue');
    await speakMidway(rig);
    rig.session.detach('test_detach');
    await rig.steps(100, YIELD); // 許可が出て候補が選ばれるが、切断中で開始できない。
    const blocked = rig.events.ofType('negotiation.decision').filter((e) => e.reasons.some((r) => r.startsWith('not_started:')));
    expect(blocked.length).toBe(1);
    expect(blocked[0]).toMatchObject({ outcome: 'wait', reasons: expect.arrayContaining(['not_started:start_blocked:browser_detached']) });
  });

  describe('提案条件で交渉が動かないとき degraded にする', () => {
    const reasons = (r: Rig) => r.session.status().reasons.filter((x) => x.startsWith('negotiation_unavailable:'));

    it('判定が条件で無効（INITIATIVE_CONDITIONS など）', async () => {
      rig = await createRig({ condition: 'initiative_inhale', policy: productionJaPolicy(), initiative: { enabled: false, reason: 'disabled_for_condition:initiative_inhale' } });
      expect(reasons(rig)).toEqual(['negotiation_unavailable:disabled_for_condition:initiative_inhale']);
      expect(rig.session.status().degraded).toBe(true);
      expect(rig.described.at(-1)?.initiative).toMatchObject({ candidates_used_for: 'log_and_research_view_only' });
    });

    it('方策に negotiation がない（negotiatorSettings が null）', async () => {
      const policy = productionJaPolicy();
      delete policy.initiative.negotiation;
      rig = await createRig({ condition: 'initiative_no_cue', policy, initiative: { responder: () => NEW } });
      expect(reasons(rig)).toEqual(['negotiation_unavailable:negotiation_settings_unavailable']);
    });

    it('判定の設定がない（initiative を組み立てない）', async () => {
      rig = await createRig({ condition: 'initiative_inhale', policy: productionJaPolicy() });
      expect(reasons(rig)).toEqual(['negotiation_unavailable:initiative_not_configured']);
    });

    it('reactive は交渉がなくても degraded にしない（振る舞いを変えない）。動いていれば理由は出ない', async () => {
      rig = await createRig({ condition: 'reactive', policy: productionJaPolicy() });
      expect(reasons(rig)).toEqual([]);
      await rig.session.close('test_done');
      rig = await setup('initiative_inhale');
      expect(reasons(rig)).toEqual([]);
    });
  });
});

describe('ブラウザの描画の報告', () => {
  it('合図の signal.report を signal.started に写し、cue_at（noteCueStarted）を残す。合図と対応しない報告は数だけ', async () => {
    rig = await setup('initiative_inhale');
    // 時計差の推定（clock.report）がないと描画の時刻を写せない。
    rig.browser({ type: 'clock.report', offset_ms: 0, rtt_ms: 2, uncertainty_ms: 1, samples: 5, client_t_ms: rig.time.monotonicMs() });
    await speakMidway(rig);
    expect(msgs(rig, 'breath.cue')).toHaveLength(1);
    const t = rig.time.monotonicMs();
    rig.browser({ type: 'signal.report', candidate_id: 'c_0001', phase: 'inhale', state: 'started', visible: true, client_t_ms: { value: t } });
    rig.browser({ type: 'signal.report', candidate_id: 'c_0099', phase: 'inhale', state: 'started', visible: true, client_t_ms: { value: t } });
    expect(rig.events.ofType('signal.started')).toMatchObject([{ candidate_id: 'c_0001', visible: true, phase: 'inhale' }]);
    expect(rig.session.candidates?.getRecord('c_0001')?.timeline.cue_at).not.toBeNull();
    expect(rig.session.counters.signal_reports_ignored).toBe(1);
    // Node の指示なしで始まる局面（保持 ready）も、その候補の合図に結びつけて記録する。
    rig.browser({ type: 'signal.report', candidate_id: 'c_0001', phase: 'ready', state: 'started', visible: true, client_t_ms: { value: t + 700 } });
    rig.browser({ type: 'signal.report', candidate_id: 'c_0001', phase: 'ready', state: 'ended', visible: true, client_t_ms: { value: t + 900 } });
    expect(rig.events.ofType('signal.started').at(-1)).toMatchObject({ phase: 'ready', parameters: { reported_phase: 'ready', report_origin: 'browser_without_command' } });
    expect(rig.events.ofType('signal.ended').at(-1)).toMatchObject({ phase: 'ready', visible: true });
    expect(rig.session.counters.signal_reports_ignored).toBe(1);
  });
});

describe('修正2: 合図と TTS の準備を同時に始める（音声の完成を待たない）', () => {
  const audioStages = (r: Rig) => r.events.ofType('negotiation.decision').filter((e) => e.stage === 'candidate_audio').map((e) => e.outcome);

  it('NEW の tick で候補の音声の準備と合図を同時に始める（音声はまだ preparing）', async () => {
    rig = await setup('initiative_inhale');
    rig.pauseTts = true;
    rig.stt().deliver({ kind: 'interim', text: STABLE, stable_text: STABLE, audio_frame_end: rig.frame });
    await rig.step(SPEAKING);
    await rig.step(SPEAKING); // LLM の結果が届いて候補ができる tick
    expect(msgs(rig, 'breath.cue')).toHaveLength(1);
    expect(candidateContext(rig)).toBeDefined(); // TTS は始まっている
    expect(candidateContext(rig)!.sent.join('')).toBe(UTTERANCE);
    expect(audioStages(rig)).toEqual(['audio_preparing']); // audio_ready はまだ
    const cue = rig.events.ofType('negotiation.decision').find((e) => e.stage === 'signal_gate' && e.outcome === 'cue')!;
    expect(cue.reasons).toContain('candidate_audio_preparing');
  });

  it('間に合う: 吸気の間に音声が届いたら、吸気の後に候補を話す', async () => {
    rig = await setup('initiative_inhale');
    rig.pauseTts = true;
    await speakMidway(rig);
    expect(msgs(rig, 'breath.cue')).toHaveLength(1);
    rig.pauseTts = false; // 吸気の間に TTS が終わる
    const begin = await untilCandidateBegins(rig);
    expect(begin).not.toBeNull();
    expect(audioStages(rig)).toEqual(['audio_preparing', 'audio_ready']);
    expect(states(rig).at(-1)).toBe('BREATH_HOLD_OR_READY->SPEAKING:turn_allowed');
  });

  it('間に合わない（遅れる）: 吸気の後の準備姿勢で待ち、その間は通常応答も始めない。期限の前に届けば話す', async () => {
    rig = await setup('initiative_inhale');
    rig.pauseTts = true;
    await speakMidway(rig);
    const cueAt = rig.events.ofType('signal.sent')[0]!.sent_at;
    // 吸気（700ms）の後も音声は来ない。人は黙り、許可が出る。
    while (rig.time.monotonicMs() < cueAt + 1000) await rig.step(YIELD);
    expect(rig.session.candidates?.list()).toMatchObject([{ state: 'BREATH_HOLD_OR_READY' }]);
    expect(rig.session.turnState.permitted_to_speak).toBe(true);
    expect(msgs(rig, 'playback.begin')).toHaveLength(0);
    const selection = rig.events.ofType('negotiation.decision').filter((e) => e.stage === 'speech_selection').at(-1);
    expect(selection).toMatchObject({ outcome: 'wait', reasons: ['candidate_audio_preparing'] });
    // 期限（吸気の完了から 800ms）の前に音声が届く。
    rig.pauseTts = false;
    const begin = await untilCandidateBegins(rig, YIELD, 20);
    expect(begin).not.toBeNull();
    expect(states(rig).at(-1)).toBe('BREATH_HOLD_OR_READY->SPEAKING:turn_allowed');
  });

  it('間に合わない（期限切れ）: 吸気の完了から hold_max_ms を過ぎたら候補を撤回し（理由を残す）、脱力して、音声は棄てる', async () => {
    rig = await setup('initiative_inhale');
    rig.pauseTts = true;
    await speakMidway(rig);
    const ctx = candidateContext(rig)!;
    const sent = rig.events.ofType('signal.sent')[0]!.sent_at;
    // 吸気 700ms ＋ 準備姿勢 800ms のあいだ TTS は一度も出さない。
    while (rig.time.monotonicMs() < sent + 700 + 800 + 60) await rig.step(YIELD);
    expect(states(rig).at(-1)).toBe('BREATH_HOLD_OR_READY->WITHDRAWN:audio_unavailable');
    expect(discarded(rig)).toEqual(['c_0001@1:audio_unavailable']);
    expect(msgs(rig, 'breath.release')).toEqual([{ type: 'breath.release', cue_id: 'cue_0001', candidate_id: 'c_0001', reason: 'withdrawn' }]);
    const abandoned = rig.events.ofType('negotiation.decision').find((e) => e.outcome === 'audio_abandoned');
    expect(abandoned?.reasons[0]).toMatch(/^audio_not_ready_by_deadline:hold_ms=/);
    expect(rig.session.negotiationWiring?.negotiatorState().cue).toBeNull();
    // 以後、候補の音声は再生されない。候補がなくなれば通常の応答が始まる（TTS を再開）。
    rig.pauseTts = false;
    for (let i = 0; i < 200 && msgs(rig, 'playback.begin').length === 0; i++) await rig.step(YIELD);
    expect(msgs(rig, 'playback.begin').every((b) => b.audio_playback_id !== ctx.audio_playback_id)).toBe(true);
  });

  it('撤回: 音声の準備中に WITHDRAW が届いたら、準備中の音声を棄て、吸気を解く', async () => {
    let n = 0;
    const WITHDRAW = json({
      decision: 'WITHDRAW',
      target_candidate_id: 'c_0001',
      withdraw_evidence_span: '来週は中止',
      withdraw_evidence_segment_ids: [0],
      withdraw_reason: '本人が取り下げた',
    });
    rig = await setup('initiative_inhale', () => (n++ === 0 ? NEW : WITHDRAW));
    rig.pauseTts = true;
    await speakMidway(rig);
    expect(msgs(rig, 'breath.cue')).toHaveLength(1);
    const more = `${STABLE}。でも来週は中止になりました`;
    rig.stt().deliver({ kind: 'interim', text: more, stable_text: more, audio_frame_end: rig.frame });
    await rig.steps(3, SPEAKING);
    expect(states(rig).at(-1)).toBe('BREATH_INHALE->WITHDRAWN:WITHDRAW');
    expect(discarded(rig)).toEqual(['c_0001@1:candidate_withdrawn']);
    expect(msgs(rig, 'breath.release').at(-1)).toMatchObject({ reason: 'withdrawn' });
    rig.pauseTts = false;
    await rig.steps(5, SPEAKING);
    expect(msgs(rig, 'playback.begin')).toHaveLength(0);
  });

  it('配線: 改訂の新しい版の音声も preparing で測れる（audio_preparing が版ごとに出る）', async () => {
    let n = 0;
    const REVISE = json({ decision: 'REVISE', target_candidate_id: 'c_0001', evidence_span: '五十万円', evidence_segment_ids: [0], proposed_utterance: '五十万円で足りますか', intent_type: 'CLARIFICATION' });
    rig = await setup('initiative_inhale', () => (n++ === 0 ? NEW : REVISE));
    await speakMidway(rig);
    const longer = `${STABLE}。それと日程は十一月の十二日からで会場は東京の予定です`;
    rig.stt().deliver({ kind: 'interim', text: longer, stable_text: longer, audio_frame_end: rig.frame });
    await rig.steps(3, SPEAKING);
    const stages = rig.events.ofType('negotiation.decision').filter((e) => e.stage === 'candidate_audio');
    expect(stages.map((e) => [e.candidate_version.value, e.outcome])).toEqual([
      [1, 'audio_preparing'],
      [1, 'audio_ready'],
      [2, 'audio_preparing'],
      [2, 'audio_ready'],
    ]);
  });
});

describe('修正1: 区間の変更をまたぐ判定（segment の変更 = AI の発話開始）', () => {
  const deferred = () => {
    let resolve!: (s: string) => void;
    const promise = new Promise<string>((r) => (resolve = r));
    return { promise, resolve };
  };

  /** 判定の LLM を応答させずに通常の応答が始まるまで進める（人は話し終え、許可で AI が話し始める）。 */
  async function startNormalWhileLlmPending(r: Rig): Promise<void> {
    r.stt().deliver({ kind: 'interim', text: STABLE, stable_text: STABLE, audio_frame_end: r.frame });
    await r.steps(3, SPEAKING); // 判定を起動（結果は保留）
    await r.steps(5, SPEAKING);
    r.stt().deliver({ kind: 'final', text: `${STABLE}。`, stable_text: `${STABLE}。`, audio_frame_end: r.frame });
    for (let i = 0; i < 200 && msgs(r, 'playback.begin').length === 0; i++) await r.step(YIELD);
    expect(msgs(r, 'playback.begin').length).toBeGreaterThan(0);
    expect(r.session.turnState.segment_id).toBe(1);
  }

  it('NEW: LLM の応答が返る前に AI が話し始めた（区間が進んだ）ら、候補にせず ai_started_speaking を残す', async () => {
    const pending = deferred();
    rig = await setup('initiative_inhale', () => pending.promise);
    await startNormalWhileLlmPending(rig);
    pending.resolve(NEW);
    await rig.steps(3, YIELD);
    expect(rig.events.ofType('candidate.state_changed')).toHaveLength(0);
    const rejected = rig.events.ofType('candidate.rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ reason: 'stale_segment', operation: 'NEW' });
    expect(rejected[0]!.details[0]).toBe('ai_started_speaking');
    expect(rejected[0]!.details).toEqual(expect.arrayContaining(['input_segment=0', 'current=1']));
    expect(rig.events.ofType('initiative.discarded').map((e) => e.reason)).toEqual(['e2a_rejected:stale_segment']);
    expect(msgs(rig, 'breath.cue')).toHaveLength(0);
  });

  it('NONE: 同じ状況でも棄却に数えず、initiative.decision の NONE として記録する', async () => {
    const pending = deferred();
    rig = await setup('initiative_inhale', () => pending.promise);
    await startNormalWhileLlmPending(rig);
    pending.resolve(NONE);
    await rig.steps(3, YIELD);
    expect(rig.events.ofType('candidate.rejected')).toHaveLength(0);
    expect(rig.events.ofType('initiative.discarded')).toHaveLength(0);
    const decisions = rig.events.ofType('initiative.decision');
    expect(decisions.map((e) => [e.decision, e.segment_id])).toEqual([['NONE', 0]]);
  });

  it('古すぎるとき: AI の開始より先に G の鮮度（max_result_age_ms）で落ちる（stale_result_too_old）', async () => {
    const pending = deferred();
    const policy = productionJaPolicy();
    policy.initiative.max_result_age_ms = 100;
    rig = await setup('initiative_inhale', () => pending.promise, policy);
    await startNormalWhileLlmPending(rig);
    await rig.steps(10, YIELD); // 100ms を超える
    pending.resolve(NEW);
    await rig.steps(3, YIELD);
    expect(rig.events.ofType('candidate.state_changed')).toHaveLength(0);
    expect(rig.events.ofType('initiative.discarded')[0]?.reason).toMatch(/stale_result_too_old/);
    expect(rig.events.ofType('candidate.rejected')).toHaveLength(0);
  });

  it('話し終わりの直後（MIN_GAP 未満）に受理した NEW: AI が話していなければ、吸気してから話す（吸気の間は通常応答を保留）', async () => {
    rig = await setup('initiative_inhale');
    // 人が話し、黙った直後に final と判定が来る。
    await rig.steps(30, SPEAKING);
    await rig.step(YIELD);
    rig.stt().deliver({ kind: 'final', text: STABLE, stable_text: STABLE, audio_frame_end: rig.frame });
    await rig.steps(3, YIELD);
    expect(states(rig)[0]).toBe('null->INTENT_READY:NEW');
    expect(msgs(rig, 'breath.cue')).toHaveLength(1);
    expect(rig.events.ofType('signal.sent')[0]?.phase).toBe('inhale');
    const begin = await untilCandidateBegins(rig);
    expect(begin).not.toBeNull();
    expect(states(rig).slice(-2)).toEqual(['BREATH_INHALE->BREATH_HOLD_OR_READY:inhale_completed', 'BREATH_HOLD_OR_READY->SPEAKING:turn_allowed']);
    expect(msgs(rig, 'breath.release').at(-1)).toMatchObject({ reason: 'speech_started' });
  });
});
