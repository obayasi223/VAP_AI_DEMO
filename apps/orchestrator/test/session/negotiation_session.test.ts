/**
 * 波3: 発話希望を振る舞いにつなぐ配線（session.ts ＋ negotiation_wiring.ts）の結合試験。
 * LLM は台本（決まった NEW を返す）、TTS と STT も台本、VAP は偽の値。モデルの判断、合成の品質、VAP の性能は何も試していない。
 * 守ること: 条件ごとの振る舞い（reactive は今と同じ、no_cue は合図なしで話す、inhale は吸気の後に話す）、
 * 吸気中の開始の保留、DEFERRED、期限、通常応答による撤回、二つ目の NEW の棄却、直接の質問、PCM の破棄、履歴。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Condition, NodeToBrowser } from '@llm-vap/contracts';
import type { Rig } from './helpers';
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
const candidateContext = (r: Rig) => r.tts().contexts.find((c) => c.sent.join('').includes(UTTERANCE));
const msgs = <T extends NodeToBrowser['type']>(r: Rig, type: T) => r.link.of(type);
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
    const cueAt = rig.time.monotonicMs();
    // 合図の直後に人が黙る。許可（最小の間 900ms）は吸気（700ms）より後なので、この試験では許可の前に吸気が終わる。
    // 吸気中の保留そのものは、許可を先に出す方策で次の試験が確かめる。
    const begin = await untilCandidateBegins(rig);
    expect(begin).not.toBeNull();
    expect(rig.time.monotonicMs() - cueAt).toBeGreaterThanOrEqual(700);
    expect(states(rig).slice(-2)).toEqual(['BREATH_INHALE->BREATH_HOLD_OR_READY:inhale_completed', 'BREATH_HOLD_OR_READY->SPEAKING:turn_allowed']);
    expect(msgs(rig, 'breath.release').at(-1)).toMatchObject({ reason: 'speech_started' });
    expect(msgs(rig, 'breath.prepare')).toEqual([]); // 吸気から直接話すときは解除だけ
  });

  it('吸気中に許可が出ている間は、準備済みの通常応答も始めない（吸気を終えてから候補を話す）', async () => {
    const policy = productionJaPolicy();
    // 吸気を長くして、吸気の間に許可が出るようにする（値は試験のため）。
    policy.initiative.negotiation!.inhale_ms = 3000;
    rig = await setup('initiative_inhale', () => NEW, policy);
    await speakMidway(rig);
    expect(msgs(rig, 'breath.cue')).toEqual([expect.objectContaining({ duration_ms: 3000 })]);
    const cueAt = rig.time.monotonicMs();
    let permittedDuringInhale = false;
    for (let i = 0; i < 200; i++) {
      await rig.step(YIELD);
      if (rig.time.monotonicMs() - cueAt < 3000 && rig.session.turnState.permitted_to_speak) permittedDuringInhale = true;
      if (rig.time.monotonicMs() - cueAt < 3000) expect(msgs(rig, 'playback.begin')).toHaveLength(0);
    }
    expect(permittedDuringInhale).toBe(true);
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

describe('initiative_no_cue（合図なしで候補を話す）', () => {
  it('吸気を経ず INTENT_READY のまま発話の機会を待ち、許可で候補を話す', async () => {
    rig = await setup('initiative_no_cue');
    await speakMidway(rig);
    await rig.steps(80, SPEAKING);
    expect(rig.session.candidates?.list()).toMatchObject([{ state: 'INTENT_READY' }]);
    const begin = await untilCandidateBegins(rig);
    expect(begin).not.toBeNull();
    expect(msgs(rig, 'breath.cue')).toHaveLength(0);
    expect(msgs(rig, 'breath.release')).toHaveLength(0);
    expect(rig.events.ofType('signal.sent')).toHaveLength(0);
    expect(states(rig)).toEqual(['null->INTENT_READY:NEW', 'INTENT_READY->SPEAKING:turn_allowed']);
    expect(rig.events.ofType('negotiation.decision').find((e) => e.stage === 'signal_gate')).toMatchObject({ outcome: 'no_cue_condition', reasons: ['condition:initiative_no_cue'] });
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
  });
});
