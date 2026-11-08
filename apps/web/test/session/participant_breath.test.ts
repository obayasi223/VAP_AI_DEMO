/**
 * 参加者画面の吸気の配線（apps/web/src/session/participant.ts）。Node の breath.cue／breath.release を
 * アバターの BreathController へ渡し、描画を始めた時刻を signal.report で返す。研究条件を WS の URL に足す。
 * アバターは偽物（呼ばれた値を覚えるだけ）。吸気の見た目は何も試していない。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NodeToBrowser } from '@llm-vap/contracts/browser_rpc';
import type { Avatar } from '../../src/avatar';
import type { BreathController, InhaleCue, ReleaseReason } from '../../src/avatar/breath';
import { CONDITION_LABELS, DEFERRED_SPEECH_PREP_MS, ParticipantController, breathOf, withCondition } from '../../src/session/participant';

class FakeBreath implements BreathController {
  readonly calls: (InhaleCue | ReleaseReason)[] = [];
  startInhale(cue: InhaleCue): void {
    this.calls.push(cue);
  }
  release(reason: ReleaseReason): void {
    this.calls.push(reason);
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
  const controller = new ParticipantController({ wsUrl: 'ws://127.0.0.1:8787/ws', avatar: () => avatar, onView: () => undefined });
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

describe('研究条件', () => {
  it('WS の URL に ?condition= を足す。null は足さない', () => {
    expect(withCondition('ws://127.0.0.1:8787/ws', 'initiative_inhale')).toBe('ws://127.0.0.1:8787/ws?condition=initiative_inhale');
    expect(withCondition('ws://h:1/ws?token=x', 'reactive')).toBe('ws://h:1/ws?token=x&condition=reactive');
    expect(withCondition('ws://h:1/ws', null)).toBe('ws://h:1/ws');
  });
  it('表示名', () => {
    expect(CONDITION_LABELS).toEqual({ reactive: '通常応答（ベースライン）', initiative_inhale: '吸気あり（提案）', initiative_no_cue: '吸気なし' });
  });
});
