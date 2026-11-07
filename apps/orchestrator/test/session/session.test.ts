/**
 * Session の結合試験（偽のブラウザ、台本のプロバイダ、偽の MaAI）。波1の独立レビューの指摘 4〜12 の場面を守る。
 * 値は台本で、認識・合成・VAP の性能は表さない。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { REPORT_TIMEOUTS_MS } from '../../src/speech/speech_generator';
import type { Rig } from './helpers';
import { FakeLink, createRig, ended, hello, position, productionJaPolicy, started, userTurnUntilBegin, warmUp } from './helpers';

let rig: Rig | null = null;
afterEach(async () => {
  if (rig) {
    expect(rig.session.counters.tick_errors).toBe(0);
    await rig.session.close('test_done');
  }
  rig = null;
});

const USER_SPEAKING: [number, number, boolean] = [0.1, 0.1, true];

describe('切断と再接続（指摘 4、5）', () => {
  it('切断しても終わりを代行しない。再接続後に割り込めば止まり、ブラウザの ended で履歴に入る', async () => {
    rig = await createRig({ reply: '今日はとても良い天気ですね。' });
    await warmUp(rig);
    const begin = await userTurnUntilBegin(rig, 'こんにちは');
    rig.browser(started(begin));
    await rig.steps(5);
    rig.browser(position(begin, 4800));

    rig.session.detach('ws_closed');
    await rig.steps(10);
    expect(rig.session.counters.playback_ended_synthesized).toBe(0);
    expect(rig.session.history.snapshot().filter((e) => e.role === 'assistant')).toHaveLength(0);

    const link2 = new FakeLink();
    rig.session.reattach(link2, hello('s_test'));
    rig.link = link2;
    // ブラウザはまだ受信済みの PCM を流している。利用者が話し始めたら止める。
    await rig.steps(5, { p: USER_SPEAKING, loud: true });
    expect(link2.of('playback.stop').map((m) => m.audio_playback_id)).toContain(begin.audio_playback_id);
    const stop = link2.of('playback.stop')[0]!;
    rig.browser(ended({ audio_playback_id: begin.audio_playback_id, generation: stop.generation }, 'stopped', 9600));
    await rig.step({ p: USER_SPEAKING });
    const assistant = rig.session.history.snapshot().filter((e) => e.role === 'assistant');
    expect(assistant).toHaveLength(1);
    expect(assistant[0]?.text.length).toBeGreaterThan(0);
    expect('今日はとても良い天気ですね。'.startsWith(assistant[0]!.text)).toBe(true);
    expect(rig.session.counters.playback_ended_synthesized).toBe(0);
  });

  it('begin の直後に切れて報告が来ない音声は、再接続後の期限で終わらせ、次の応答を止めない', async () => {
    rig = await createRig({ reply: 'はい。' });
    await warmUp(rig);
    const first = await userTurnUntilBegin(rig, 'こんにちは');
    // playback.started を受ける前に切断。
    rig.session.detach('ws_closed');
    await rig.steps(5);
    const link2 = new FakeLink();
    rig.session.reattach(link2, hello('s_test'));
    rig.link = link2;
    const deadlineTicks = Math.ceil((REPORT_TIMEOUTS_MS.after_reattach + 1000) / 20) + 2;
    await rig.steps(deadlineTicks);
    expect(rig.session.counters.playback_ended_synthesized).toBe(1);
    // 声にならなかった（報告がない）ので履歴に入れない。
    expect(rig.session.history.snapshot().filter((e) => e.role === 'assistant')).toHaveLength(0);
    const second = await userTurnUntilBegin(rig, 'もしもし');
    expect(second.audio_playback_id).not.toBe(first.audio_playback_id);
    expect(rig.session.counters.start_refused.another_playback_active ?? 0).toBe(0);
  });

  it('接続中でも、開始の報告が期限までに来なければ終わらせる', async () => {
    rig = await createRig({ reply: 'はい。' });
    await warmUp(rig);
    await userTurnUntilBegin(rig, 'こんにちは');
    await rig.steps(Math.ceil(REPORT_TIMEOUTS_MS.start / 20) + 2);
    expect(rig.session.counters.playback_ended_synthesized).toBe(1);
  });

  it('セッションを閉じるときは再生中の音声の終わりを代行し、話した分だけ履歴に入る', async () => {
    rig = await createRig({ reply: '今日はとても良い天気ですね。' });
    await warmUp(rig);
    const begin = await userTurnUntilBegin(rig, 'こんにちは');
    rig.browser(started(begin));
    rig.browser(position(begin, 8000));
    await rig.session.close('resume_grace_expired');
    expect(rig.session.counters.playback_ended_synthesized).toBe(1);
    const assistant = rig.session.history.snapshot().filter((e) => e.role === 'assistant');
    expect(assistant).toHaveLength(1);
    expect(assistant[0]!.text.length).toBeLessThan('今日はとても良い天気ですね。'.length);
    rig = null;
  });
});

describe('開始できないときの応答（指摘 6）', () => {
  it('切断中に許可が出ても segment を進めず入力を保ち、再接続後に同じ応答を始める', async () => {
    rig = await createRig();
    await warmUp(rig);
    rig.session.detach('ws_closed');
    rig.stt().deliver({ kind: 'final', text: 'こんにちは', audio_frame_end: rig.frame });
    await rig.steps(60);
    expect(rig.session.turnState.segment_id).toBe(0);
    expect(rig.session.turnState.asr_result).toBe('こんにちは');
    expect(rig.session.turnState.permitted_to_speak).toBe(true);
    expect(rig.session.turnState.want_to_speak.kind).toBe('response');
    const link2 = new FakeLink();
    rig.session.reattach(link2, hello('s_test'));
    rig.link = link2;
    await rig.steps(3);
    expect(link2.of('playback.begin')).toHaveLength(1);
    expect(rig.session.turnState.segment_id).toBe(1);
  });

  it('入力で止められなかった開始の拒否では、開始しなかった前提で tick を計算し直す（turn.allowed を毎 tick 出さない）', async () => {
    rig = await createRig();
    await warmUp(rig);
    // D の startChecked が拒否し続ける（入力の start_blocked_reason では分からない拒否）。
    const speech = (rig.session as unknown as { speech: { startChecked: (id: number) => unknown } }).speech;
    const original = speech.startChecked.bind(speech);
    let refuse = true;
    speech.startChecked = (id: number) => (refuse ? { ok: false, reason: 'not_ready' } : original(id));
    rig.stt().deliver({ kind: 'final', text: 'こんにちは', audio_frame_end: rig.frame });
    for (let i = 0; i < 200 && rig.session.counters.start_rolled_back === 0; i++) await rig.step();
    expect(rig.session.counters.start_rolled_back).toBe(1);
    const allowedBefore = rig.events.ofType('turn.allowed').length;
    await rig.steps(10);
    expect(rig.session.counters.start_rolled_back).toBe(11);
    // 許可の状態は変わっていないので、開始しなかった tick では turn.allowed を重ねて出さない。
    expect(rig.events.ofType('turn.allowed').length).toBe(allowedBefore);
    expect(rig.session.turnState.segment_id).toBe(0);
    expect(rig.session.turnState.speaking.phase).toBe('silent');
    expect(rig.session.turnState.want_to_speak.kind).toBe('response');
    refuse = false;
    await rig.steps(2);
    expect(rig.link.of('playback.begin')).toHaveLength(1);
    expect(rig.session.turnState.segment_id).toBe(1);
  });
});

describe('状態の表示とログ（指摘 10、13、14）', () => {
  it('助走中は rewarm、助走後に VAP が落ちたら rewarm を消して down の理由を出す。切替はログにも残る', async () => {
    rig = await createRig();
    await rig.steps(2);
    rig.maai?.ready(rig.time.monotonicMs());
    await rig.steps(5);
    const reasonsAt = () => rig!.link.of('session.status').at(-1)?.reasons ?? [];
    expect(reasonsAt().some((r) => r.startsWith('vap:rewarm'))).toBe(true);
    await rig.steps(Math.ceil(10_000 / 20) + 2);
    expect(reasonsAt().some((r) => r.startsWith('vap:'))).toBe(false);
    rig.maai?.unavailable();
    await rig.steps(2);
    expect(reasonsAt().some((r) => r.startsWith('vap:rewarm'))).toBe(false);
    expect(reasonsAt().some((r) => r.startsWith('vap:worker_not_started'))).toBe(true);
    const vapStatus = rig.events.ofType('provider.status').filter((e) => e.provider === 'vap_freshness').map((e) => e.status);
    expect(vapStatus).toEqual(['down', 'degraded', 'ok', 'down']);
  });

  it('READY の前の VAP_STATE（前の CONFIGURE の結果）はログにも TurnManager にも入れない', async () => {
    rig = await createRig();
    await rig.steps(5);
    expect(rig.events.ofType('vap.state')).toHaveLength(0);
    rig.maai?.ready(rig.time.monotonicMs());
    await rig.steps(5);
    expect(rig.events.ofType('vap.state').length).toBe(5);
  });

  it('時計差の推定の前の gaze.report は、受信時刻で代えずに記録しない', async () => {
    rig = await createRig();
    const report = { type: 'gaze.report', target: 'away', visible: true, client_t_ms: { value: 500 } } as const;
    rig.browser(report);
    expect(rig.events.ofType('gaze.rendered')).toHaveLength(0);
    expect(rig.session.counters.gaze_reports_before_clock).toBe(1);
    rig.browser({ type: 'clock.report', offset_ms: 100, rtt_ms: 4, uncertainty_ms: 2, samples: 6, client_t_ms: 600 });
    rig.browser(report);
    const rendered = rig.events.ofType('gaze.rendered');
    expect(rendered).toHaveLength(1);
    expect(rendered[0]).toMatchObject({ rendered_at: 600 });
  });

  it('開始時に各プロバイダの区分を provider.status と manifest に残す', async () => {
    rig = await createRig();
    const statuses = rig.events.ofType('provider.status');
    expect(statuses.filter((e) => e.provider === 'scripted_stt')[0]).toMatchObject({ provider_class: 'test_double', status: 'ok' });
    expect(statuses.filter((e) => e.provider === 'scripted_tts')[0]).toMatchObject({ provider_class: 'test_double' });
    expect(rig.described[0]).toMatchObject({
      condition: 'reactive',
      policy_id: 'ja',
      providers: { stt: { provider_class: 'test_double' }, tts: { provider_class: 'test_double' }, llm: { provider_class: 'test_double' } },
    });
    expect(rig.link.of('server.hello')[0]?.is_fake).toBe(true);
  });
});

describe('VAP が使えないときの代替（指摘 11）', () => {
  it('本番の方策で、無音の上限で話し始め、話している間の声と interim で止める', async () => {
    rig = await createRig({ maai: false, policy: productionJaPolicy(), reply: '今日はとても良い天気ですね。' });
    await rig.steps(5, { loud: true });
    const begin = await userTurnUntilBegin(rig, 'こんにちは', 200);
    rig.browser(started(begin));
    await rig.steps(3);
    rig.stt().deliver({ kind: 'interim', text: 'ちょっと待ってください', audio_frame_end: rig.frame });
    await rig.steps(3, { loud: true });
    const stops = rig.link.of('playback.stop');
    expect(stops.map((s) => s.audio_playback_id)).toContain(begin.audio_playback_id);
    expect(rig.events.ofType('turn.allowed').some((e) => e.decision_source === 'fallback' && e.turn_allowed)).toBe(true);
  });
});

describe('履歴の並び（指摘 12）', () => {
  it('AI の発話中に利用者が話しても、AI の発話はその前に並ぶ', async () => {
    rig = await createRig({ reply: '今日はとても良い天気ですね。' });
    await warmUp(rig);
    const begin = await userTurnUntilBegin(rig, 'こんにちは');
    rig.browser(started(begin));
    await rig.steps(2);
    // AI の発話中の利用者の発話（相槌）。新しい segment に入る。
    rig.stt().deliver({ kind: 'final', text: 'うん', audio_frame_end: rig.frame });
    await rig.steps(2);
    rig.browser(ended(begin, 'completed', 16000 * 2));
    await rig.steps(1);
    const order = rig.session.history.snapshot().map((e) => `${e.role}:${e.text}`);
    expect(order).toEqual(['user:こんにちは', 'assistant:今日はとても良い天気ですね。', 'user:うん']);
  });
});
