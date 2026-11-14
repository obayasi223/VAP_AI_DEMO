/**
 * 2 体のモードの参加者画面の配線（apps/web/src/session/two_ai_participant.ts。docs/design/two_ai/03 §2.4、§2.5、§5.1）。
 * アバターとステージは偽物（呼ばれた値を覚えるだけ）。描画は何も試していない。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AvatarReport, GazeReport, RenderHealth, SignalReport, type NodeToBrowser } from '@llm-vap/contracts/browser_rpc';
import { INITIAL_TWO_AI_VIEW, isSyncMarkMessage, withTwoAiMode } from '../../src/session/two_ai_participant';
import { HEADINGS, HELLO_TWO_AI, harness } from './two_ai_harness';

const raf = globalThis.requestAnimationFrame;
beforeEach(() => {
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    cb(123.5);
    return 1;
  }) as typeof requestAnimationFrame;
});
afterEach(() => {
  globalThis.requestAnimationFrame = raf;
});

describe('WS の URL', () => {
  it('mode=two_ai を足し、条件は付けない', () => {
    const url = new URL(withTwoAiMode('ws://127.0.0.1:8787/ws'));
    expect(url.searchParams.get('mode')).toBe('two_ai');
    expect(url.searchParams.has('condition')).toBe(false);
    expect(url.searchParams.has('discussion_condition')).toBe(false);
    expect(INITIAL_TWO_AI_VIEW).not.toHaveProperty('condition');
  });
});

describe('吸気の振り分け', () => {
  it('breath.cue { ai_id: B } は B だけに届き、signal.report に ai_id: B', () => {
    const h = harness();
    h.deliver({ type: 'breath.cue', cue_id: 'cue_1', candidate_id: 'c_1', duration_ms: 450, ai_id: 'B' });
    expect(h.avatars.B.breath.calls).toEqual([{ cue_id: 'cue_1', duration_ms: 450 }]);
    expect(h.avatars.A.breath.calls).toEqual([]);
    const signals = h.sentOf('signal.report');
    expect(signals).toEqual([
      { type: 'signal.report', candidate_id: 'c_1', phase: 'inhale', state: 'started', visible: true, client_t_ms: { value: 123.5 }, ai_id: 'B' },
    ]);
    expect(SignalReport.safeParse(signals[0]).success).toBe(true);
    expect(h.controller.record.unknownAiId).toBe(0);
  });

  it('ai_id のない吸気は A へ回し、数える', () => {
    const h = harness();
    h.deliver({ type: 'breath.release', cue_id: 'cue_1', candidate_id: 'c_1', reason: 'deferred' });
    expect(h.avatars.A.breath.calls).toEqual(['deferred']);
    expect(h.controller.record.unknownAiId).toBe(1);
    expect(h.controller.record.breathCommands[0]).toMatchObject({ ai_id: null, type: 'breath.release' });
  });
});

describe('視線の振り分け', () => {
  it('ai_id ありは片方、なしは両方', () => {
    const h = harness();
    h.deliver({ type: 'gaze.command', target: 'peer', ai_id: 'A' });
    expect(h.avatars.A.calls).toEqual(['gaze:peer']);
    expect(h.avatars.B.calls).toEqual([]);
    h.deliver({ type: 'gaze.command', target: 'user' });
    expect(h.avatars.A.calls).toEqual(['gaze:peer', 'gaze:user']);
    expect(h.avatars.B.calls).toEqual(['gaze:user']);
    expect(h.controller.current().gaze).toEqual({ A: 'user', B: 'user' });
    expect(h.controller.record.gazeCommands.map((c) => c.ai_id)).toEqual(['A', null]);
  });

  it('描画の報告は ai_id を付けて送る', () => {
    const h = harness();
    h.controller.gazeRendered('B', { type: 'gaze.report', target: 'peer', visible: true, client_t_ms: { value: 10 } });
    const [report] = h.sentOf('gaze.report');
    expect(report).toMatchObject({ ai_id: 'B', target: 'peer' });
    expect(GazeReport.safeParse(report).success).toBe(true);
  });
});

describe('口の振り分け', () => {
  it('語時刻と再生の報告はその AI の口にだけ届き、A の再生中に B の口は開かない', () => {
    const h = harness();
    h.deliver({ type: 'playback.begin', audio_playback_id: 11, generation: 1, sample_rate_hz: 16000, ai_id: 'A' });
    h.deliver({ type: 'playback.begin', audio_playback_id: 12, generation: 1, sample_rate_hz: 16000, ai_id: 'B' });
    h.deliver({ type: 'playback.alignment', audio_playback_id: 11, generation: 1, items: [], ai_id: 'A' });
    h.deliver({ type: 'playback.alignment', audio_playback_id: 12, generation: 1, items: [] });
    expect(h.avatars.A.alignments).toEqual([11]);
    expect(h.avatars.B.alignments).toEqual([12]);

    h.sentReport({ type: 'playback.started', audio_playback_id: 11 });
    expect(h.controller.current().speaking).toBe('A');
    expect(h.avatars.A.reports).toEqual(['playback.started:11']);
    expect(h.avatars.B.reports).toEqual([]);
    for (let i = 0; i < 5; i += 1) h.controller.routeMouth(0.2);
    expect(h.avatars.B.level).toBe(0);
    expect(h.controller.record.mouth.A.openWhilePlaying).toBe(5);
    expect(h.controller.record.mouth.B.openWhileOtherPlaying).toBe(0);

    h.sentReport({ type: 'playback.ended', audio_playback_id: 11 });
    h.sentReport({ type: 'playback.started', audio_playback_id: 12 });
    expect(h.controller.current().speaking).toBe('B');
    h.controller.routeMouth(0.2);
    expect(h.avatars.A.level).toBe(0);
    expect(h.avatars.B.level).toBe(0.2);
    h.sentReport({ type: 'playback.ended', audio_playback_id: 12 });
    expect(h.controller.current().speaking).toBeNull();
    h.controller.routeMouth(0.2);
    expect(h.avatars.A.level).toBe(0);
    expect(h.avatars.B.level).toBe(0);
  });

  it('表にない再生の報告は口へ渡さず、speaking を変えず、数える', () => {
    const h = harness();
    h.sentReport({ type: 'playback.started', audio_playback_id: 99 });
    expect(h.controller.current().speaking).toBeNull();
    expect(h.controller.record.unknownPlayback).toBe(1);
    expect(h.avatars.A.reports).toEqual([]);
  });
});

describe('段階、見出し、板', () => {
  it('two_ai.phase で段階が変わり、名札が更新される', () => {
    const h = harness();
    h.deliver(HELLO_TWO_AI);
    expect(h.controller.current().labels).toEqual({ A: 'アオイ', B: 'ハル' });
    h.deliver({ type: 'two_ai.phase', phase: 'discussion', instruction_key: 'discussion_a', labels: { A: 'ミオ', B: 'ソラ' } });
    expect(h.controller.current()).toMatchObject({ phase: 'discussion', instructionKey: 'discussion_a', labels: { A: 'ミオ', B: 'ソラ' }, markerEnabled: true });
    expect(h.controller.record.phases.map((p) => p.phase)).toEqual(['discussion']);
  });

  it('two_ai.stage で見出し、two_ai.board で板を全体で置き換える', () => {
    const h = harness();
    h.deliver({ type: 'two_ai.stage', current: 2, headings: HEADINGS, show: 'current' });
    expect(h.controller.current().stage).toEqual({ current: 2, headings: HEADINGS, show: 'current' });
    h.deliver({ type: 'two_ai.board', board_version: 1, mode: 'building', cards: [{ card_id: 'a', order: 1, discussion_stage: 1, text: 'x', variant: 'original' }], picked_card_id: null });
    h.deliver({ type: 'two_ai.board', board_version: 2, mode: 'building', cards: [{ card_id: 'b', order: 2, discussion_stage: 2, text: 'y', variant: 'original' }], picked_card_id: null });
    expect(h.controller.current().board?.cards.map((c) => c.card_id)).toEqual(['b']);
  });

  it('1 対 1 の Node（mode が two_ai でない）なら始めない', async () => {
    const h = harness();
    h.deliver({ type: 'server.hello', protocol_version: 1, session_id: 's1', condition: 'reactive', is_fake: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.controller.current().lifecycle).toBe('failed');
    expect(h.controller.current().error).toContain('1 対 1');
  });
});

describe('同期の印（06 §4.7、第 5 回 m3）', () => {
  const prev = (seen: string[] = [], stage: number | null = null) => ({ seen: new Set(seen), stage });
  const phase = (p: 'intake' | 'discussion' | 'response' | 'next_step' | 'end'): NodeToBrowser => ({ type: 'two_ai.phase', phase: p, instruction_key: null, labels: null });
  const stage = (current: 1 | 2 | 3 | 4 | null): NodeToBrowser => ({ type: 'two_ai.stage', current, headings: HEADINGS, show: current === null ? 'all' : 'current' });

  it('表の 8 つのメッセージだけで出す', () => {
    expect(isSyncMarkMessage(phase('intake'), prev())).toBe('phase:intake');
    expect(isSyncMarkMessage(phase('discussion'), prev())).toBeNull();
    expect(isSyncMarkMessage(phase('response'), prev())).toBe('phase:response');
    expect(isSyncMarkMessage(phase('next_step'), prev())).toBe('phase:next_step');
    expect(isSyncMarkMessage(phase('end'), prev())).toBe('phase:end');
    for (const n of [1, 2, 3, 4] as const) expect(isSyncMarkMessage(stage(n), prev())).toBe(`stage:${n}`);
    expect(isSyncMarkMessage(stage(null), prev())).toBeNull();
    expect(isSyncMarkMessage({ type: 'two_ai.board', board_version: 1, mode: 'building', cards: [], picked_card_id: null }, prev())).toBeNull();
    expect(isSyncMarkMessage(HELLO_TWO_AI, prev())).toBeNull();
  });

  it('current が変わらない two_ai.stage と、同じ（phase, stage）の 2 回目以降は出さない', () => {
    expect(isSyncMarkMessage(stage(2), prev([], 2))).toBeNull();
    expect(isSyncMarkMessage(phase('response'), prev(['phase:response']))).toBeNull();
    expect(isSyncMarkMessage(stage(3), prev(['stage:3'], 2))).toBeNull();
  });

  it('接続直後の送り直しで同じ段の印を 2 回数えない', () => {
    const h = harness();
    h.deliver(phase('intake'));
    h.deliver(HELLO_TWO_AI);
    h.deliver(phase('intake'));
    h.deliver(stage(1));
    h.deliver(stage(null));
    h.deliver(stage(1));
    expect(h.controller.record.syncMarks.map((m) => m.key)).toEqual(['phase:intake', 'stage:1']);
    expect(h.controller.current().syncMarks).toBe(2);
  });
});

describe('アバターの記録と描画の健康', () => {
  it('avatar.report を AI ごとに ai_id つきで送る', () => {
    const h = harness();
    h.controller.setAvatarRecord('B', { avatar_id: 'rb_ma09', kind: 'glb', model_url: '/models/rb_ma09.glb', source: 'default', status: 'failed', error: 'x' }, {
      layout: { side: 'right', body_yaw_deg: 35, spacing_m: 0.9 },
    });
    const [report] = h.sentOf('avatar.report');
    expect(report).toMatchObject({ ai_id: 'B', status: 'failed', layout: { side: 'right' } });
    expect(AvatarReport.safeParse(report).success).toBe(true);
    expect(h.controller.current().avatarLoad.B).toBe('failed');
  });

  it('render.health は契約の形', () => {
    const h = harness({
      stage: {
        avatar: () => null,
        getTelemetry: () => ({ fps: 30, fpsP5: 24, fpsMedian: 30, frameMsP95: 12.5, renderer: 'SwiftShader', pixelRatio: 1, avatars: 2 }),
      },
    });
    const health = h.controller.renderHealth();
    expect(health).toMatchObject({ type: 'render.health', fps_p5: 24, fps_median: 30, avatars: 2, renderer: 'SwiftShader' });
    expect(RenderHealth.safeParse(health).success).toBe(true);
  });
});
