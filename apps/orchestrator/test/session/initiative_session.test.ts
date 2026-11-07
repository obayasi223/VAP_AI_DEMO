/**
 * 発話希望（G）のセッションへの配線の試験（波2）。LLM は台本で、モデルの判断は何も試していない。
 * 守ること: STT の増分で起動、E2a へ渡る、tick を止めない、条件で止めたら呼ばない、候補で参加者の見える振る舞いを変えない。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { LlmRequest } from '@llm-vap/contracts';
import type { Rig } from './helpers';
import { createRig, productionJaPolicy, userTurnUntilBegin, warmUp } from './helpers';

let rig: Rig | null = null;
afterEach(async () => {
  if (rig) {
    expect(rig.session.counters.tick_errors).toBe(0);
    await rig.session.close('test_done');
  }
  rig = null;
});

const STABLE = '来月の展示会の予算は五十万円のままで進めようと思っています';
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
const NEW = json({ decision: 'NEW', evidence_span: '五十万円', evidence_segment_ids: [0], proposed_utterance: '確認させてください', intent_type: 'CLARIFICATION' });

const initiativeRequests = (rig: Rig): LlmRequest[] => (rig.initiativeLlm?.requests ?? []).filter((r) => r.purpose === 'initiative');

async function speak(rig: Rig, stable: string, kind: 'interim' | 'final' = 'interim'): Promise<void> {
  rig.stt().deliver({ kind, text: stable, stable_text: stable, audio_frame_end: rig.frame });
  await rig.step({ p: [0.1, 0.1, true], loud: true });
}

describe('発話希望の配線', () => {
  it('STT の安定テキストの増分で判定し、E2a が採番した候補を initiative.decision と candidate.state_changed に残す', async () => {
    rig = await createRig({ initiative: { responder: () => NEW } });
    await warmUp(rig);
    expect(rig.session.initiativeStatus()).toEqual({ running: true, reason: null });
    await speak(rig, STABLE);
    await rig.steps(3, { p: [0.1, 0.1, true], loud: true });
    expect(initiativeRequests(rig)).toHaveLength(1);
    expect(rig.events.ofType('initiative.decision')).toMatchObject([{ decision: 'NEW', candidate_id: 'c_0001', candidate_version: 1 }]);
    expect(rig.events.ofType('candidate.state_changed')).toMatchObject([
      { candidate_id: 'c_0001', from: null, to: 'INTENT_READY', cause_source: 'model_decision', decision: 'NEW' },
    ]);
    expect(rig.session.candidates?.want()).toMatchObject({ kind: 'candidate', candidate_id: 'c_0001' });
  });

  it('候補ができても参加者の見える振る舞いは変えない（候補の音声を作らず、話さず、合図も出さない）', async () => {
    rig = await createRig({ initiative: { responder: () => NEW } });
    await warmUp(rig);
    await speak(rig, STABLE);
    await rig.steps(60, { p: [0.1, 0.1, true], loud: true });
    expect(rig.session.candidates?.list()).toHaveLength(1);
    expect(rig.link.of('playback.begin')).toHaveLength(0);
    // TTS は通常の応答の準備（prefetch）の分だけで、候補の発話案は合成しない。
    expect(rig.tts().contexts).toHaveLength(rig.events.ofType('prefetch.started').length);
    expect(rig.tts().contexts.some((c) => c.sent.join('').includes('確認させてください'))).toBe(false);
    expect(rig.events.ofType('signal.sent')).toHaveLength(0);
    // TurnManager の want は準備済みの応答だけで、候補を混ぜない（want_to_speak の正本は E2a が別に持つ）。
    expect(['none', 'response']).toContain(rig.session.turnState.want_to_speak.kind);
    expect(rig.session.turnState.permitted_to_speak).toBe(false);
  });

  it('LLM の応答を待つ間も tick は止まらず、通常の応答は始まる', async () => {
    const never = new Promise<string>(() => undefined);
    rig = await createRig({ initiative: { responder: () => never }, reply: 'はい。' });
    await warmUp(rig);
    await speak(rig, STABLE);
    expect(initiativeRequests(rig)).toHaveLength(1);
    const begin = await userTurnUntilBegin(rig, 'こんにちは');
    expect(begin.audio_playback_id).toBeGreaterThan(0);
    expect(rig.events.ofType('initiative.decision')).toHaveLength(0);
  });

  it('条件で止めたときは LLM を呼ばず、止めた理由を provider.status と manifest に残す', async () => {
    rig = await createRig({ initiative: { enabled: false, reason: 'disabled_for_condition:reactive' } });
    await warmUp(rig);
    await speak(rig, STABLE);
    await speak(rig, `${STABLE}。それと日程は十一月です`, 'final');
    await rig.steps(5);
    expect(initiativeRequests(rig)).toHaveLength(0);
    expect(rig.session.candidates).toBeNull();
    expect(rig.session.initiativeStatus()).toEqual({ running: false, reason: 'disabled_for_condition:reactive' });
    expect(rig.events.ofType('provider.status').find((e) => e.provider === 'initiative_monitor')).toMatchObject({
      reason: { value: 'disabled_for_condition:reactive' },
    });
    expect(rig.described.at(-1)?.initiative).toMatchObject({ running: false, reason: 'disabled_for_condition:reactive' });
    expect(rig.described.at(-1)?.providers.initiative).toBeUndefined();
  });

  it('通常の応答を話し始めたら残っている候補を撤回し、segment の変更も E2a へ伝える', async () => {
    rig = await createRig({ initiative: { responder: () => NEW }, reply: 'はい。' });
    await warmUp(rig);
    await speak(rig, STABLE);
    await rig.steps(2, { p: [0.1, 0.1, true], loud: true });
    expect(rig.session.candidates?.list()).toHaveLength(1);
    await userTurnUntilBegin(rig, STABLE);
    expect(rig.session.candidates?.list()).toHaveLength(0);
    expect(rig.events.ofType('candidate.state_changed').at(-1)).toMatchObject({
      candidate_id: 'c_0001',
      to: 'WITHDRAWN',
      cause_source: 'code',
      cause: 'normal_response_started',
    });
    expect(rig.session.candidates?.segmentId()).toBe(rig.session.turnState.segment_id);
    expect(rig.session.turnState.segment_id).toBeGreaterThan(0);
  });

  it('tick が期限（candidate_expiry_ms）を進める', async () => {
    const policy = productionJaPolicy();
    policy.initiative.candidate_expiry_ms = 400;
    rig = await createRig({ policy, initiative: { responder: () => NEW } });
    await warmUp(rig);
    await speak(rig, STABLE);
    await rig.steps(2, { p: [0.1, 0.1, true], loud: true });
    expect(rig.session.candidates?.list()).toHaveLength(1);
    await rig.steps(25, { p: [0.1, 0.1, true], loud: true });
    expect(rig.session.candidates?.list()).toHaveLength(0);
    expect(rig.events.ofType('candidate.state_changed').at(-1)).toMatchObject({ cause: 'expired' });
  });

  it('人が話し終えた後に届いた NEW は候補にせず保留する（tick が人の発話の有無を E2a へ伝える）', async () => {
    let release!: (text: string) => void;
    const pending = new Promise<string>((r) => {
      release = r;
    });
    rig = await createRig({ initiative: { responder: () => pending } });
    await warmUp(rig);
    await speak(rig, STABLE);
    // 人は黙った（VAP の user_speaking=false が続く。AI へ譲る値ではないので AI も話し始めない）。応答はまだ来ない。
    await rig.steps(60, { p: [0.1, 0.1, false] });
    release(NEW);
    await rig.steps(2, { p: [0.1, 0.1, false] });
    expect(rig.link.of('playback.begin')).toHaveLength(0);
    expect(rig.session.candidates?.list()).toHaveLength(0);
    expect(rig.session.candidates?.heldPostTurn()).not.toBeNull();
    expect(rig.events.ofType('initiative.discarded').map((e) => e.reason)).toEqual(['e2a_rejected:post_turn_new_held']);
    expect(rig.events.ofType('candidate.rejected')).toMatchObject([{ reason: 'post_turn_new_held', held: true }]);
  });

  it('保留した NEW は、人が話を再開したら（話の途中の間だった）照合し直して候補にし、initiative.decision を出す', async () => {
    let release!: (text: string) => void;
    const pending = new Promise<string>((r) => {
      release = r;
    });
    rig = await createRig({ initiative: { responder: () => pending } });
    await warmUp(rig);
    await speak(rig, STABLE);
    await rig.steps(60, { p: [0.1, 0.1, false] });
    release(NEW);
    await rig.steps(2, { p: [0.1, 0.1, false] });
    expect(rig.session.candidates?.heldPostTurn()).not.toBeNull();
    // 人が続きを話し始めた。
    await rig.steps(3, { p: [0.1, 0.1, true], loud: true });
    expect(rig.session.candidates?.heldPostTurn()).toBeNull();
    expect(rig.session.candidates?.list()).toMatchObject([{ candidate_id: 'c_0001', state: 'INTENT_READY' }]);
    expect(rig.events.ofType('initiative.decision')).toMatchObject([{ decision: 'NEW', candidate_id: 'c_0001', request_id: 'ini_0001' }]);
    expect(rig.events.ofType('candidate.rejected').map((e) => e.reason)).toEqual(['post_turn_new_held']);
    // 候補ができても話さない（波2）。
    expect(rig.link.of('playback.begin')).toHaveLength(0);
  });

  it('セッションを閉じた後に届いた判定は適用しない', async () => {
    let release!: (text: string) => void;
    const pending = new Promise<string>((r) => {
      release = r;
    });
    const local = await createRig({ initiative: { responder: () => pending } });
    await warmUp(local);
    await speak(local, STABLE);
    expect(initiativeRequests(local)).toHaveLength(1);
    await local.session.close('test_done');
    release(NEW);
    await new Promise((r) => setTimeout(r, 0));
    expect(local.events.ofType('initiative.decision')).toHaveLength(0);
    expect(local.events.ofType('candidate.state_changed')).toHaveLength(0);
  });

  it('不正な出力は候補を作らず理由を残し、すぐには再実行しない', async () => {
    rig = await createRig({ initiative: { responder: () => 'これは JSON ではない' } });
    await warmUp(rig);
    await speak(rig, STABLE);
    await rig.step({ p: [0.1, 0.1, true], loud: true });
    await speak(rig, `${STABLE}。それと日程は十一月の十二日からです`);
    await rig.steps(5, { p: [0.1, 0.1, true], loud: true });
    expect(initiativeRequests(rig)).toHaveLength(1);
    expect(rig.events.ofType('initiative.discarded').map((e) => e.reason)).toEqual(['model_output_not_json;backoff_ms=2000']);
    expect(rig.session.candidates?.list()).toHaveLength(0);
    // 待ちが明けたら tick（poll）で残りの増分を判定する。
    await rig.steps(100, { p: [0.1, 0.1, true], loud: true });
    expect(initiativeRequests(rig)).toHaveLength(2);
  });
});
