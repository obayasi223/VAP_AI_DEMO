/**
 * 参加者画面の吸気の配線（apps/web/src/session/participant.ts）。Node の breath.cue／breath.release を
 * アバターの BreathController へ渡し、描画を始めた時刻を signal.report で返す。研究条件を WS の URL に足す。
 * アバターは偽物（呼ばれた値を覚えるだけ）。吸気の見た目は何も試していない。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NodeToBrowser } from '@llm-vap/contracts/browser_rpc';
import type { Avatar } from '../../src/avatar';
import type { BreathController, BreathPhaseEvent, InhaleCue, ReleaseReason } from '../../src/avatar/breath';
import { CONDITION_LABELS, DEFERRED_SPEECH_PREP_MS, ParticipantController, breathOf, withCondition, withInitiativeChoice } from '../../src/session/participant';

class FakeBreath implements BreathController {
  readonly calls: (InhaleCue | ReleaseReason)[] = [];
  /** startInhale／release の戻り値（false はアバターが受け付けなかった）。 */
  accept = true;
  startInhale(cue: InhaleCue): boolean {
    this.calls.push(cue);
    return this.accept;
  }
  release(reason: ReleaseReason): boolean {
    this.calls.push(reason);
    return this.accept;
  }
  phase() {
    return 'idle' as const;
  }
}

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

function controllerWith(avatar: Avatar | null) {
  const controller = new ParticipantController({ wsUrl: 'ws://127.0.0.1:8787/ws', avatar: () => avatar, onView: () => undefined, breathSoundGain: 0 });
  const sent: unknown[] = [];
  (controller as unknown as { audio: { send(m: unknown): void } }).audio = { send: (m) => sent.push(m) };
  const deliver = (m: NodeToBrowser) => (controller as unknown as { onMessage(m: NodeToBrowser): void }).onMessage(m);
  return { controller, sent, deliver };
}

describe('吸気の合図をアバターへ', () => {
  it('breath.cue → startInhale（長さは Node の値のまま）、breath.release → release。描画の開始を signal.report で返す', () => {
    const breath = new FakeBreath();
    const { controller, sent, deliver } = controllerWith({ breath } as unknown as Avatar);
    deliver({ type: 'breath.cue', cue_id: 'cue_0001', candidate_id: 'c_0001', duration_ms: 450 });
    deliver({ type: 'breath.release', cue_id: 'cue_0001', candidate_id: 'c_0001', reason: 'deferred' });
    deliver({ type: 'breath.release', cue_id: 'cue_0002', candidate_id: 'c_0002', reason: 'speech_started' });
    expect(breath.calls).toEqual([{ cue_id: 'cue_0001', duration_ms: 450 }, 'deferred', 'speech_started']);
    expect(sent).toEqual([
      { type: 'signal.report', candidate_id: 'c_0001', phase: 'inhale', state: 'started', visible: true, client_t_ms: { value: 123.5 } },
      { type: 'signal.report', candidate_id: 'c_0001', phase: 'relax', state: 'started', visible: true, client_t_ms: { value: 123.5 } },
      { type: 'signal.report', candidate_id: 'c_0002', phase: 'pre_speech', state: 'started', visible: true, client_t_ms: { value: 123.5 } },
    ]);
    expect(controller.record.breathCommands.map((c) => c.breath)).toEqual([true, true, true]);
  });

  it('アバターが受け付けなかった吸気と解除は visible:false で報告する（描いていないのに描いたと記録しない）', () => {
    const breath = new FakeBreath();
    breath.accept = false;
    const { sent, deliver } = controllerWith({ breath } as unknown as Avatar);
    deliver({ type: 'breath.cue', cue_id: 'cue_0001', candidate_id: 'c_0001', duration_ms: 450 });
    deliver({ type: 'breath.release', cue_id: 'cue_0001', candidate_id: 'c_0001', reason: 'withdrawn' });
    expect(sent).toEqual([
      { type: 'signal.report', candidate_id: 'c_0001', phase: 'inhale', state: 'started', visible: false, client_t_ms: { value: null, null_reason: 'avatar_did_not_apply' } },
      { type: 'signal.report', candidate_id: 'c_0001', phase: 'relax', state: 'started', visible: false, client_t_ms: { value: null, null_reason: 'avatar_did_not_apply' } },
    ]);
  });

  it('breath.prepare → prepareShort の後、短い準備の長さだけ置いて release(speech_started)', () => {
    vi.useFakeTimers();
    try {
      const calls: unknown[] = [];
      const breath = { startInhale: () => undefined, release: (r: ReleaseReason) => calls.push(r), phase: () => 'idle' as const, prepareShort: (ms?: number) => calls.push(['short', ms]) };
      const { controller, deliver } = controllerWith({ breath } as unknown as Avatar);
      deliver({ type: 'breath.prepare', candidate_id: 'c_0001' });
      expect(calls).toEqual([['short', DEFERRED_SPEECH_PREP_MS]]);
      vi.advanceTimersByTime(DEFERRED_SPEECH_PREP_MS);
      expect(calls).toEqual([['short', DEFERRED_SPEECH_PREP_MS], 'speech_started']);
      expect(controller.record.breathCommands).toMatchObject([{ type: 'breath.prepare', cue_id: null, breath: true }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('アバターに breath がなければ呼ばず、報告もしない（記録だけ残す）', () => {
    const { controller, sent, deliver } = controllerWith({} as Avatar);
    deliver({ type: 'breath.cue', cue_id: 'cue_0001', candidate_id: 'c_0001', duration_ms: 450 });
    expect(sent).toEqual([]);
    expect(controller.record.breathCommands).toMatchObject([{ type: 'breath.cue', breath: false }]);
    expect(breathOf(null)).toBeNull();
  });
});

describe('局面の実時刻の報告（signal.ended など）', () => {
  /** onBreathPhase で局面の遷移を流せる偽アバター。 */
  function avatarWithPhases(breath = new FakeBreath()) {
    let listener: ((e: BreathPhaseEvent) => void) | null = null;
    return {
      avatar: { breath, onBreathPhase: (l: (e: BreathPhaseEvent) => void) => {
        listener = l;
        return () => {
          listener = null;
        };
      } } as unknown as Avatar,
      emit: (e: Partial<BreathPhaseEvent>) => listener?.({ phase: 'idle', nowMs: 0, cueId: 'cue_0001', cause: null, kind: 'prep', ...e } as BreathPhaseEvent),
      bound: () => listener !== null,
    };
  }

  it('onPhase の時刻で ended を返す: 吸気の終わり、保持、脱力の終わり（Node の指示の started は別に返している）', () => {
    const f = avatarWithPhases();
    const { sent, deliver, controller } = controllerWith(f.avatar);
    deliver({ type: 'breath.cue', cue_id: 'cue_0001', candidate_id: 'c_0001', duration_ms: 700 });
    expect(f.bound()).toBe(true);
    sent.length = 0;
    f.emit({ phase: 'inhale', nowMs: 1000 });
    f.emit({ phase: 'hold', nowMs: 1700 });
    deliver({ type: 'breath.release', cue_id: 'cue_0001', candidate_id: 'c_0001', reason: 'withdrawn' });
    f.emit({ phase: 'release', nowMs: 2000, cause: 'withdrawn' });
    f.emit({ phase: 'idle', nowMs: 2750, cause: 'withdrawn' });
    expect(sent).toEqual([
      { type: 'signal.report', candidate_id: 'c_0001', phase: 'inhale', state: 'ended', visible: true, client_t_ms: { value: 1700 } },
      { type: 'signal.report', candidate_id: 'c_0001', phase: 'ready', state: 'started', visible: true, client_t_ms: { value: 1700 } },
      { type: 'signal.report', candidate_id: 'c_0001', phase: 'relax', state: 'started', visible: true, client_t_ms: { value: 123.5 } },
      { type: 'signal.report', candidate_id: 'c_0001', phase: 'ready', state: 'ended', visible: true, client_t_ms: { value: 2000 } },
      { type: 'signal.report', candidate_id: 'c_0001', phase: 'relax', state: 'ended', visible: true, client_t_ms: { value: 2750 } },
    ]);
    expect(controller.record.signalReports).toHaveLength(6);
  });

  it('撤回が来たら、短い準備の後の発声の予約を取り消す（声を出さない）', () => {
    vi.useFakeTimers();
    try {
      const calls: unknown[] = [];
      const breath = { startInhale: () => true, release: (r: ReleaseReason) => { calls.push(r); return true; }, phase: () => 'idle' as const, prepareShort: () => undefined };
      const { deliver } = controllerWith({ breath } as unknown as Avatar);
      deliver({ type: 'breath.prepare', candidate_id: 'c_0001' });
      vi.advanceTimersByTime(DEFERRED_SPEECH_PREP_MS / 2);
      deliver({ type: 'breath.release', cue_id: 'cue_0001', candidate_id: 'c_0001', reason: 'withdrawn' });
      vi.advanceTimersByTime(DEFERRED_SPEECH_PREP_MS);
      expect(calls).toEqual(['withdrawn']);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('研究条件', () => {
  it('WS の URL に ?condition= を足す。null は足さない', () => {
    expect(withCondition('ws://127.0.0.1:8787/ws', 'initiative_inhale')).toBe('ws://127.0.0.1:8787/ws?condition=initiative_inhale');
    expect(withCondition('ws://h:1/ws?token=x', 'reactive')).toBe('ws://h:1/ws?token=x&condition=reactive');
    expect(withCondition('ws://h:1/ws', null)).toBe('ws://h:1/ws');
  });
  it('WS の URL に会話の種類と方式を足す。null の項目は足さない', () => {
    expect(withInitiativeChoice('ws://h:1/ws', { conversation_kind: 'companion', timing_strategy: 'immediate' })).toBe('ws://h:1/ws?conversation_kind=companion&timing_strategy=immediate');
    expect(withInitiativeChoice('ws://h:1/ws?token=x', { conversation_kind: null, timing_strategy: 'llm' })).toBe('ws://h:1/ws?token=x&timing_strategy=llm');
    expect(withInitiativeChoice('ws://h:1/ws', { conversation_kind: null, timing_strategy: null })).toBe('ws://h:1/ws');
  });
  it('WS の URL に吸気の後の声のモードを足す。指定がなければ足さない', () => {
    expect(withInitiativeChoice('ws://h:1/ws', { conversation_kind: null, timing_strategy: null, vocal_cue: 'pre_beginning' })).toBe('ws://h:1/ws?vocal_cue=pre_beginning');
    expect(withInitiativeChoice('ws://h:1/ws', { conversation_kind: null, timing_strategy: null, vocal_cue: null })).toBe('ws://h:1/ws');
  });
  it('表示名', () => {
    expect(CONDITION_LABELS).toEqual({ reactive: '通常応答（ベースライン）', initiative_inhale: '吸気あり（提案）', initiative_no_cue: '吸気なし' });
  });
});
