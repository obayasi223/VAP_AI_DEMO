/**
 * 重複発言の防止（発話の直前のガード、発話の後の照合、二度話さない）と、通常応答の材料の反映の推定の結合試験。
 * LLM、TTS、STT は台本。閾値とモデルの判断の妥当性は試していない（未校正の暫定値）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Condition, LlmRequest, NodeToBrowser } from '@llm-vap/contracts';
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
const UTTERANCE = '予算は五十万円で本当に足りるのか確認させてください';
const OTHER = 'はい、承知しました。';
/** 候補の文を一文として含む通常応答。 */
const REPLY_WITH_UTTERANCE = `わかりました。${UTTERANCE}。`;

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
const NEW = (utterance = UTTERANCE) => desire({ desire: 'NEW', intent_type: 'CLARIFICATION', proposed_utterance: utterance, evidence_span: '五十万円', evidence_segment_ids: [0] });
const REVISE = (utterance: string, ids: number[] = [0], target = 'c_0001') => desire({ desire: 'REVISE', target_candidate_id: target, intent_type: 'QUESTION', proposed_utterance: utterance, evidence_span: '五十万円', evidence_segment_ids: ids });
const timing = (verdict: string) => JSON.stringify({ reason: 'r', why_now: '', cost_of_waiting: '', timing: verdict, target_candidate_id: 'c_0001' });
const isTiming = (request: LlmRequest) => request.response_json_schema === TIMING_JSON_SCHEMA;

type Step = { p: [number, number, boolean]; loud?: boolean };
const SPEAKING: Step = { p: [0.1, 0.1, true], loud: true };
const YIELD: Step = { p: [0.9, 0.9, false] };

function staged(desires: string[], timings: string[] = ['WAIT_FOR_TURN_END']): RigInitiative {
  let d = 0;
  let t = 0;
  return {
    staged: { timing_strategy: 'llm' },
    responder: (request) => (isTiming(request) ? timing(timings[Math.min(t++, timings.length - 1)]!) : (desires[d++] ?? desire())),
  };
}
async function setup(initiative: RigInitiative, reply: string, condition: Condition = 'initiative_inhale'): Promise<Rig> {
  const r = await createRig({ condition, policy: productionJaPolicy(), reply, initiative });
  await warmUp(r);
  return r;
}
async function speak(r: Rig, text = STABLE): Promise<void> {
  r.stt().deliver({ kind: 'interim', text, stable_text: text, audio_frame_end: r.frame });
  await r.steps(3, SPEAKING);
}
async function finishTurn(r: Rig, text = STABLE): Promise<void> {
  r.stt().deliver({ kind: 'final', text, audio_frame_end: r.frame } as never);
  await r.steps(2, YIELD);
}
async function until(r: Rig, condition: () => boolean, step: Step = YIELD, max = 300): Promise<boolean> {
  for (let i = 0; i < max && !condition(); i++) await r.step(step);
  return condition();
}
const msgs = <T extends NodeToBrowser['type']>(r: Rig, type: T) => r.link.of(type);
const beginOf = (r: Rig, text: string) => {
  const ids = new Set(r.tts().contexts.filter((c) => c.sent.join('').includes(text)).map((c) => c.audio_playback_id));
  return msgs(r, 'playback.begin').find((b) => ids.has(b.audio_playback_id)) ?? null;
};
const states = (r: Rig) => r.events.ofType('candidate.state_changed').map((e) => `${e.from ?? 'null'}->${e.to}:${e.cause_source === 'code' ? e.cause : e.decision}`);
const FULL = 10_000_000;

/** 割り込みと同じ停止（D の stop）をかけて、指定の位置で終わったことにする。 */
function interrupt(r: Rig, begin: { audio_playback_id: number; generation: number }, samples: number): void {
  const speech = (r.session as unknown as { speech: { stop(id: number, reason: string, o: unknown): void } }).speech;
  speech.stop(begin.audio_playback_id, 'test_interrupt', { stop_point: 'immediate', max_wait_ms: 200, decision_source: 'vap' });
  r.browser(ended(begin, 'stopped', samples));
}
/** 入力の区間の番号を request から拾う（ASR の区間はターンごとに増える）。 */
const segmentIds = (request: LlmRequest): number[] => [...new Set([...request.messages.map((m) => m.text).join('\n').matchAll(/#(\d+)（/gu)].map((m) => Number(m[1])))];

/** 通常応答を始め、指定の報告で終える。 */
async function respond(r: Rig, reply: string, finish: (begin: { audio_playback_id: number; generation: number }) => void): Promise<void> {
  await finishTurn(r);
  expect(await until(r, () => beginOf(r, reply) !== null)).toBe(true);
  const begin = beginOf(r, reply)!;
  r.browser(started(begin));
  await r.steps(2, YIELD);
  finish(begin);
  await r.steps(2, YIELD);
}

describe('通常応答の材料の反映の推定（発話の終わり）', () => {
  it('実際に話した文と比べて、一致すれば estimated_reflected。渡した版と一致の値を残し、確定と書かない', async () => {
    rig = await setup(staged([NEW()]), REPLY_WITH_UTTERANCE);
    await speak(rig);
    await respond(rig, REPLY_WITH_UTTERANCE, (b) => rig!.browser(ended(b, 'completed', FULL)));
    const [event] = rig.events.ofType('initiative.response_reflection');
    expect(event).toMatchObject({
      candidate_id: 'c_0001',
      candidate_version: 1,
      spoken_outcome: 'spoken',
      interrupted: false,
      estimated_reflected: { value: true },
      proposed_utterance: { source: 'model_output', value: UTTERANCE },
    });
    expect(event!.spoken_text).toContain('わかりました');
    const material = rig.events.ofType('initiative.response_material')[0]!;
    expect({ s: event!.segment_id, r: event!.transcript_revision }).toEqual({ s: material.segment_id, r: material.transcript_revision });
    expect(event!.estimate.value).toMatchObject({ threshold: 0.5, method: expect.stringContaining('containment') });
    expect(JSON.stringify(event)).not.toMatch(/"reflected"/);
  });

  it('使わなかった応答は estimated_reflected が偽で、候補は保留のまま残る', async () => {
    rig = await setup(staged([NEW()]), OTHER);
    await speak(rig);
    await respond(rig, OTHER, (b) => rig!.browser(ended(b, 'completed', FULL)));
    const [event] = rig.events.ofType('initiative.response_reflection');
    expect(event).toMatchObject({ spoken_outcome: 'spoken', estimated_reflected: { value: false } });
    expect(rig.session.candidates?.list()).toHaveLength(1);
    expect(states(rig)).toEqual(['null->INTENT_READY:NEW']);
  });

  it('割り込まれて途中で終わったら、話した部分だけで判定する（まだ言っていない文は反映に数えない）', async () => {
    const long = `${OTHER}${UTTERANCE}。`;
    rig = await setup(staged([NEW()]), long);
    await speak(rig);
    await respond(rig, long, (b) => interrupt(rig!, b, 2400 * 2));
    const [event] = rig.events.ofType('initiative.response_reflection');
    expect(event).toMatchObject({ spoken_outcome: 'partly_spoken', estimated_reflected: { value: false } });
    expect(event!.spoken_text.length).toBeLessThan(long.length);
    expect(event!.spoken_text).not.toContain('確認させて');
    expect(rig.session.candidates?.list()).toHaveLength(1);
  });

  it('1 音も出ずに終わった応答は比較せず not_spoken', async () => {
    rig = await setup(staged([NEW()]), OTHER);
    await speak(rig);
    await finishTurn(rig);
    expect(await until(rig, () => beginOf(rig!, OTHER) !== null)).toBe(true);
    rig.browser(ended(beginOf(rig, OTHER)!, 'completed', 0));
    await rig.steps(2, YIELD);
    expect(rig.events.ofType('initiative.response_reflection')).toMatchObject([{ spoken_outcome: 'not_spoken', estimated_reflected: { value: null }, estimate: { value: null } }]);
  });

  it('話さずに取り消された材料の応答も not_spoken として記録する', async () => {
    rig = await setup(staged([NEW()]), OTHER);
    rig.pauseTts = true;
    await speak(rig);
    await finishTurn(rig);
    expect(await until(rig, () => rig!.events.ofType('initiative.response_material').length > 0)).toBe(true);
    const speech = (rig.session as unknown as { speech: { cancel(id: number, reason: string): void } }).speech;
    const context = rig.tts().contexts.find((c) => c.sent.length === 0 || c.sent.join('').includes(OTHER));
    speech.cancel(context!.audio_playback_id, 'test_cancel');
    await rig.steps(2, YIELD);
    expect(rig.events.ofType('initiative.response_reflection')).toMatchObject([{ spoken_outcome: 'not_spoken', estimated_reflected: { value: null } }]);
  });
});

describe('重複発言の防止', () => {
  it('発話の後の照合: 通常応答がその候補の文を話し終えたら、撤回する（WAIT の判断や内容の撤回と別の分類）', async () => {
    rig = await setup(staged([NEW()]), REPLY_WITH_UTTERANCE);
    await speak(rig);
    await respond(rig, REPLY_WITH_UTTERANCE, (b) => rig!.browser(ended(b, 'completed', FULL)));
    expect(rig.session.candidates?.list()).toHaveLength(0);
    expect(states(rig).at(-1)).toBe('INTENT_READY->WITHDRAWN:already_said');
    const [said] = rig.events.ofType('initiative.already_said');
    expect(said).toMatchObject({ candidate_id: 'c_0001', stage: 'after_ai_speech', candidate_state: 'INTENT_READY', matched_origin: 'response', comparison: { value: { threshold: 0.8 } } });
    expect(said!.comparison.value.similarity).toBeGreaterThanOrEqual(0.8);
    // 通常応答の開始は判定を待たない（開始の時点ではまだ候補がある）。
    expect(states(rig).filter((s) => s.includes('normal_response'))).toHaveLength(0);
  });

  it('発話の後の照合: 途中で切れて言い終えていなければ撤回しない', async () => {
    const long = `${OTHER}${UTTERANCE}。`;
    rig = await setup(staged([NEW()]), long);
    await speak(rig);
    await respond(rig, long, (b) => interrupt(rig!, b, 2400 * 2));
    expect(rig.session.candidates?.list()).toHaveLength(1);
    expect(rig.events.ofType('initiative.already_said')).toHaveLength(0);
  });

  it('発話の後の照合: 候補の発話でも通常応答でも同じ照合を行う（候補の発話の終わり）', async () => {
    rig = await setup(staged([NEW()]), OTHER);
    await speak(rig);
    await rig.steps(2, SPEAKING);
    rig.session.negotiationWiring?.onAiSpeechFinished({ audio_playback_id: 99, origin: { kind: 'candidate', candidate_id: 'c_x', candidate_version: 1 }, spoken_text: UTTERANCE, spoken_text_precision: 'alignment_char', interrupted: false, no_audio: false }, rig.time.monotonicMs());
    expect(rig.events.ofType('initiative.already_said')).toMatchObject([{ stage: 'after_ai_speech', matched_origin: 'candidate', matched_audio_playback_id: 99 }]);
  });

  it('発話の直前のガード: 改訂で「すでに話した文」になった候補は話さず撤回し、音声を棄てて合図を解く', async () => {
    let queue: ((ids: number[]) => string)[] = [];
    const responder = (request: LlmRequest) => {
      if (isTiming(request)) return timing('OFFER_NOW');
      const next = queue.shift();
      return next ? next(segmentIds(request)) : desire();
    };
    rig = await setup({ staged: { timing_strategy: 'llm' }, responder }, REPLY_WITH_UTTERANCE);
    // 1回目の応答で候補の文を話しておく（履歴に入る）。候補はまだない。
    await speak(rig);
    await respond(rig, REPLY_WITH_UTTERANCE, (b) => rig!.browser(ended(b, 'completed', FULL)));
    expect(rig.session.candidates?.list()).toHaveLength(0);
    // 次のターン: NEW（別の内容）→ REVISE でさきほど話した文へ。
    const next = '次は別の話として来月の五十万円の使い方について順番に話をしていきたいです';
    const more = `${next}。特にそこの見積もりの部分が一番気になっていて確かめておきたいのです`;
    queue = [(ids) => desire({ desire: 'NEW', intent_type: 'CLARIFICATION', proposed_utterance: 'この件は別の角度から見てもいいでしょうか', evidence_span: '五十万円', evidence_segment_ids: ids })];
    await speak(rig, next);
    await rig.steps(3, SPEAKING);
    expect(rig.session.candidates?.list()).toMatchObject([{ candidate_version: 1 }]);
    queue = [(ids) => REVISE(UTTERANCE, ids, 'c_0001')];
    await speak(rig, more);
    expect(await until(rig, () => (rig!.session.candidates?.list()[0]?.candidate_version ?? 0) === 2, SPEAKING, 60)).toBe(true);
    expect(rig.session.candidates?.list()).toMatchObject([{ candidate_version: 2, proposed_utterance: UTTERANCE }]);
    // 吸気と保持が進んでから、話し終える。
    await until(rig, () => ['BREATH_HOLD_OR_READY', 'DEFERRED'].includes(rig!.session.candidates?.list()[0]?.state ?? ''), SPEAKING, 80);
    await finishTurn(rig, more);
    expect(await until(rig, () => rig!.events.ofType('initiative.already_said').length > 0)).toBe(true);
    const [said] = rig.events.ofType('initiative.already_said');
    expect(said).toMatchObject({ stage: 'before_speech', candidate_version: 2 });
    expect(states(rig).at(-1)).toMatch(/->WITHDRAWN:already_said$/);
    expect(rig.session.negotiationWiring?.discardedAudio.some((a) => a.reason === 'already_said')).toBe(true);
    expect(msgs(rig, 'breath.release').at(-1)?.reason).toBe('withdrawn');
    // その候補の音声は再生していない。
    expect(rig.session.negotiationWiring?.counters.candidate_speech_started).toBe(0);
    expect(rig.session.candidates?.list()).toHaveLength(0);
  });

  it('候補を話した後: 同じ候補を二度話さない（SPOKEN は再開できず、選択の対象にならない）。同じ文の再 NEW も棄却する', async () => {
    rig = await setup(staged([NEW(), NEW()], ['OFFER_NOW']), OTHER, 'initiative_no_cue');
    await speak(rig);
    await finishTurn(rig);
    expect(await until(rig, () => beginOf(rig!, UTTERANCE) !== null)).toBe(true);
    const begin = beginOf(rig, UTTERANCE)!;
    rig.browser(started(begin));
    await rig.steps(2, YIELD);
    rig.browser(ended(begin, 'completed', FULL));
    await rig.steps(2, YIELD);
    expect(states(rig).at(-1)).toBe('SPEAKING->SPOKEN:speech_finished');
    expect(rig.session.candidates?.want()).toEqual({ kind: 'none' });
    const replay = rig.session.candidates!.startSpeech('c_0001', 1, begin.audio_playback_id, 'turn_allowed', rig.time.monotonicMs());
    expect(replay).toMatchObject({ ok: false, reason: 'invalid_transition' });
    const again = `${STABLE}。もう一度五十万円の件です`;
    await speak(rig, again);
    const rejected = rig.events.ofType('initiative.desire').filter((e) => e.outcome === 'gate_rejected');
    expect(rejected.at(-1)?.gate.value.reasons).toContain('already_said');
    expect(msgs(rig, 'playback.begin').filter((b) => b.audio_playback_id === begin.audio_playback_id)).toHaveLength(1);
  });
});
