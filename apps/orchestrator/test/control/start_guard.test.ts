/**
 * 開始の慎重化（ja の turn.start_guard、原著にない。docs/known_gaps.md §10）。config の値のまま見る。
 * 値は【暫定、根拠は実機の1セッションのみ】: min_gap_ms=900、completion_timeout_min_p_ai=0.5、
 * completion_timeout_low_p_min_ms=1500。hri2025 は原著どおり（Appendix A の 500ms）のままであることも固定する。
 */
import { describe, expect, it } from 'vitest';
import type { Policy } from '@llm-vap/contracts';
import { controlSettings } from '../../src/control';
import { Driver, T0, hri2025, ja, jaAppendixA, pick, ready, turnAllowed } from './helpers';

const USER: [number, number, boolean] = [0.05, 0.3, true];
/** VAP は AI 側を支持（p_now_ai ≥ 0.5）だが p_future は譲渡でない（L67 は偽）。実ログ 50.26s の形。 */
const PNOW_HIGH_NO_YIELD: [number, number, boolean] = [0.66, 0.3, false];
/** VAP は利用者側（p_now_ai < 0.5）。実ログ 18.50s、67.47s の形。 */
const PNOW_LOW: [number, number, boolean] = [0.3, 0.28, false];
const YIELD: [number, number, boolean] = [0.7, 0.7, false];

function allowedAt(policy: Policy, p: [number, number, boolean], completion: number, elapsed: number) {
  const d = new Driver(policy);
  d.tick(T0, { p: USER, p_completion: completion, text: 'ですね' });
  const decisions = d.tick(T0 + elapsed, { p, p_completion: completion });
  return { allowed: d.state.permitted_to_speak, payload: turnAllowed(decisions) };
}

describe('ja の start_guard（config の値）', () => {
  it('config に暫定値が入っている', () => {
    expect(ja().turn.start_guard).toEqual({
      min_gap_ms: 900,
      completion_timeout_min_p_ai: 0.5,
      completion_timeout_low_p_min_ms: 1500,
    });
  });

  it.each([
    ['L74: completion 0.75、p_now_ai 0.66 は 899ms で許可なし', PNOW_HIGH_NO_YIELD, 0.75, 899, false],
    ['L74: completion 0.75、p_now_ai 0.66 は 900ms で許可（最小の間）', PNOW_HIGH_NO_YIELD, 0.75, 900, true],
    ['L74: completion 0.75、p_now_ai 0.3 は 1499ms で許可なし（下限未満）', PNOW_LOW, 0.75, 1499, false],
    ['L74: completion 0.75、p_now_ai 0.3 は 1500ms で許可', PNOW_LOW, 0.75, 1500, true],
    ['L74: completion 0.1 は原著の 2000ms のまま（短くしない）', PNOW_LOW, 0.1, 1999, false],
    ['L74: completion 0.1 は 2000ms で許可', PNOW_LOW, 0.1, 2000, true],
  ] as const)('%s', (_title, p, completion, elapsed, expected) => {
    const { allowed, payload } = allowedAt(ja(), [...p], completion, elapsed);
    expect(allowed).toBe(expected);
    if (expected) expect(payload?.decision_source).toBe('completion_timeout');
  });

  it('延ばした待ちは理由に残す（原著の待ちのときは足さない）', () => {
    expect(allowedAt(ja(), [...PNOW_LOW], 0.75, 1500).payload?.reason).toBe('L74_completion_timeout+start_guard:wait=1500ms');
    expect(allowedAt(ja(), [...PNOW_LOW], 0.1, 2000).payload?.reason).toBe('L74_completion_timeout');
  });

  it('p_now_ai がちょうど下限（0.5）なら最小の間だけ', () => {
    expect(allowedAt(ja(), [0.5, 0.3, false], 0.75, 900).allowed).toBe(true);
  });

  it.each([
    [899, false],
    [900, true],
  ])('L67: VAP が譲渡でも %ims（最小の間 900ms）', (elapsed, expected) => {
    const { allowed, payload } = allowedAt(ja(), YIELD, 0, elapsed);
    expect(allowed).toBe(expected);
    if (expected) expect(payload?.reason).toBe('L67_vap_yield');
  });

  it('招待でも最小の間を守る', () => {
    const d = new Driver(ja());
    d.tick(T0, { p: USER, text: 'どう思いますか' });
    expect(d.state.invitation.detected).toBe(true);
    d.tick(T0 + 899, { p: PNOW_LOW });
    expect(d.state.permitted_to_speak).toBe(false);
    d.tick(T0 + 900, { p: PNOW_LOW });
    expect(d.state.permitted_to_speak).toBe(true);
  });

  it('不変条件: 発話終了から 900ms 未満では許可が出ない（固定の乱数列で全経路）', () => {
    let seed = 7;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) % 2 ** 32;
      return seed / 2 ** 32;
    };
    const d = new Driver(ja());
    let now = T0;
    let lastVoiced = now;
    let speaking = true;
    let permittedTicks = 0;
    for (let i = 0; i < 20000; i++) {
      now += 20;
      // 発話と無音の区間（平均 400ms）を作る。0.3〜2 秒の無音が多数できる。
      if (rand() < 0.05) speaking = !speaking;
      const p: [number, number, boolean] = [rand(), rand(), speaking];
      d.tick(now, { p, p_completion: rand(), text: speaking && rand() < 0.2 ? `文${i}` : undefined });
      if (speaking) lastVoiced = now;
      if (d.state.permitted_to_speak) {
        permittedTicks += 1;
        expect(now - lastVoiced).toBeGreaterThanOrEqual(900);
      }
    }
    // 許可が一度も出なければ不変条件を見ていない。
    expect(permittedTicks).toBeGreaterThan(10);
  });

  it('準備ができていれば延ばした待ちの後に開始する（遅れは 1500ms で止まる）', () => {
    const d = new Driver(ja());
    d.tick(T0, { p: USER, p_completion: 0.75, text: 'ですね' });
    expect(pick(d.tick(T0 + 1480, { p: PNOW_LOW, p_completion: 0.75, prefetch: ready() }), 'start_speech')).toHaveLength(0);
    expect(pick(d.tick(T0 + 1500, { p: PNOW_LOW, p_completion: 0.75, prefetch: ready() }), 'start_speech')).toHaveLength(1);
  });
});

describe('hri2025 は原著どおり（start_guard なし）', () => {
  it('設定に start_guard も after_ai_speech もない', () => {
    const settings = controlSettings(hri2025());
    expect(settings.start_guard).toBeNull();
    expect(settings.after_ai_speech).toBeNull();
  });
  it.each([
    ['L74: p=0.75、p_now_ai 0.3 でも 500ms で許可', PNOW_LOW, 0.75, 500, true],
    ['L74: p=0.75、499ms は許可なし', PNOW_LOW, 0.75, 499, false],
  ] as const)('%s', (_title, p, completion, elapsed, expected) => {
    expect(allowedAt(hri2025(), [...p], completion, elapsed).allowed).toBe(expected);
  });
  it('ja でも start_guard を外すと原著の 500ms に戻る（この試験が start_guard を見ている確認）', () => {
    expect(allowedAt(jaAppendixA(), [...PNOW_LOW], 0.75, 500).allowed).toBe(true);
    expect(allowedAt(ja(), [...PNOW_LOW], 0.75, 500).allowed).toBe(false);
  });
});
