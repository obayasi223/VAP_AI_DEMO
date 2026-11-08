/**
 * AI の発話の終わりの扱い（ja の turn.after_ai_speech、原著にない。docs/known_gaps.md §10）。config の値のまま見る。
 *  (a) AI の発話中に始まり、AI が話し終えた時点で止んでいる短い断片（正規化で 4 文字以下、または相槌の語句だけ）は
 *      応答の対象にしない（準備しない）。断片から文が伸びたら通常どおり。
 *  (b) AI の発話の終わりに user_speak_end_time と user_turn_end_time を終わりの時刻へ数え直す。
 * hri2025 は原著どおり（どちらもしない）。
 */
import { describe, expect, it } from 'vitest';
import type { Policy } from '@llm-vap/contracts';
import { controlSettings } from '../../src/control';
import { fragmentReason } from '../../src/control/turn_manager';
import { Driver, T0, hri2025, ja, jaAppendixA, kinds, pick, playing, ready, turnAllowed } from './helpers';

const USER: [number, number, boolean] = [0.05, 0.3, true];
/** AI の発話中の利用者の声。p_future_ai ≥ 0.4 なので L59 の割り込みにならない（実ログ 50.4s の「で」の形）。 */
const USER_OVER_AI: [number, number, boolean] = [0.6, 0.5, true];
const QUIET_AI: [number, number, boolean] = [0.9, 0.5, false];
const QUIET_LOW: [number, number, boolean] = [0.1, 0.1, false];

/** AI の発話中（playing）に利用者が text を言って止み、AI が endAt に自然に話し終える。 */
function fragmentDuringAi(policy: Policy, text: string, endAt = T0 + 5000): Driver {
  const d = new Driver(policy);
  d.tick(T0, { p: QUIET_AI, playback: playing(9) });
  d.tick(T0 + 200, { p: USER_OVER_AI, playback: playing(9), text, p_completion: 0.1 });
  d.tick(T0 + 400, { p: USER_OVER_AI, playback: playing(9) });
  for (let t = T0 + 420; t < endAt; t += 200) d.tick(t, { p: QUIET_AI, playback: playing(9), p_completion: 0.1 });
  return d;
}

/** AI の終わりの後 ms までに出た決定。 */
function afterEnd(d: Driver, from: number, ms: number, extra: { prefetch?: ReturnType<typeof ready> } = {}) {
  const out = [];
  for (let t = from; t <= from + ms; t += 20) out.push(...d.tick(t, { p: QUIET_LOW, p_completion: 0.1, ...extra }));
  return out;
}

describe('fragmentReason（config の語句と上限）', () => {
  const after = controlSettings(ja()).after_ai_speech!;
  it.each([
    ['で。', 'short:chars=1'],
    ['うん', 'short:chars=2'],
    ['あのね、', 'short:chars=3'],
    ['はい、そうですね。', 'backchannel:chars=7'],
    ['なるほどなるほど', 'backchannel:chars=8'],
    ['そうなんですね', 'backchannel:chars=7'],
  ])('%s → %s', (text, reason) => {
    expect(fragmentReason(text, after)).toBe(reason);
  });
  it.each(['それで次の話ですが', 'そうですねそれで', '研究しています', '。、'])('%s は断片でない', (text) => {
    expect(fragmentReason(text, after)).toBeNull();
  });
  it('上限 0 なら文字数で判定しない', () => {
    expect(fragmentReason('で', { ...after, fragment_max_chars: 0 })).toBeNull();
  });
});

describe('(a) AI の発話中の短い断片（ja）', () => {
  it('AI が話し終えても断片には準備せず、話し始めない。許可の理由に残す', () => {
    const d = fragmentDuringAi(ja(), 'で。');
    const decisions = afterEnd(d, T0 + 5000, 5000);
    expect(kinds(decisions)).not.toContain('prepare');
    expect(kinds(decisions)).not.toContain('start_speech');
    expect(d.state.ignored_fragment).toMatchObject({ segment_id: 0, text: 'で。', reason: 'short:chars=1' });
    const allowed = pick(decisions, 'turn_allowed').find((x) => x.payload.turn_allowed);
    expect(allowed?.payload.reason).toContain('ignored_ai_speech_fragment:short:chars=1');
  });

  it('相槌の語句（5 文字以上）も同じ', () => {
    const d = fragmentDuringAi(ja(), 'はいそうですね');
    expect(kinds(afterEnd(d, T0 + 5000, 4000))).not.toContain('prepare');
    expect(d.state.ignored_fragment?.reason).toBe('backchannel:chars=7');
  });

  it('断片の後に利用者が続けたら、続きを含めて通常どおり準備する', () => {
    const d = fragmentDuringAi(ja(), 'で。');
    afterEnd(d, T0 + 5000, 200);
    d.tick(T0 + 5300, { p: USER, text: 'で、次の展示の話なんですが', p_completion: 0.1 });
    expect(d.state.ignored_fragment).toBeNull();
    const decisions = afterEnd(d, T0 + 5320, 600);
    expect(pick(decisions, 'prepare')[0]?.text).toBe('で、次の展示の話なんですが');
  });

  it('句読点の違いだけなら断片のまま', () => {
    const d = fragmentDuringAi(ja(), 'で。');
    afterEnd(d, T0 + 5000, 100);
    d.tick(T0 + 5200, { p: QUIET_LOW, text: 'で' });
    expect(d.state.ignored_fragment).not.toBeNull();
    expect(kinds(afterEnd(d, T0 + 5220, 3000))).not.toContain('prepare');
  });

  it('長い発話は断片にしない（AI の終わりの後に準備する）', () => {
    const d = fragmentDuringAi(ja(), '展示の予算について聞きたいです');
    expect(pick(afterEnd(d, T0 + 5000, 600), 'prepare')).toHaveLength(1);
    expect(d.state.ignored_fragment).toBeNull();
  });

  it('AI の終わりの時点で利用者がまだ話していれば断片にしない', () => {
    const d = new Driver(ja());
    d.tick(T0, { p: QUIET_AI, playback: playing(9) });
    d.tick(T0 + 200, { p: USER_OVER_AI, playback: playing(9), text: 'で' });
    d.tick(T0 + 220, { p: USER }); // AI の終わり。利用者は発話中
    expect(d.state.ignored_fragment).toBeNull();
  });

  it('割り込みで止めた後（stopping から）は断片にしない', () => {
    const d = new Driver(ja());
    d.tick(T0, { p: QUIET_AI, playback: playing(9) });
    const decisions = d.tick(T0 + 200, { p: [0.1, 0.1, true], playback: playing(9), text: 'あの' });
    expect(kinds(decisions)).toContain('interrupt_speech');
    decisions.push(...d.tick(T0 + 400, { p: [0.1, 0.1, false], playback: playing(9) }));
    decisions.push(...d.tick(T0 + 420, { p: QUIET_LOW }));
    expect(d.state.speaking.phase).toBe('silent');
    expect(d.state.ignored_fragment).toBeNull();
    // 割り込みの後は準備を再開する（U-2）。断片として外さない。
    decisions.push(...afterEnd(d, T0 + 440, 400));
    expect(pick(decisions, 'prepare').map((x) => x.text)).toEqual(['あの']);
  });

  it('AI が黙っている間に来た短い発話は断片にしない', () => {
    const d = new Driver(ja());
    d.tick(T0, { p: USER, text: 'うん' });
    expect(pick(afterEnd(d, T0 + 200, 400), 'prepare')).toHaveLength(1);
  });
});

describe('(b) AI の発話の終わりで利用者の発話の終わりを数え直す（ja）', () => {
  /** 利用者が AI の発話中に長く話して止み（断片ではない）、AI はそのまま 5 秒話して終わる。準備は済んでいる。 */
  function overlapThenEnd(policy: Policy) {
    const d = new Driver(policy);
    d.tick(T0, { p: QUIET_AI, playback: playing(9) });
    d.tick(T0 + 200, { p: USER_OVER_AI, playback: playing(9), text: '展示の予算について聞きたいです', p_completion: 0.1 });
    for (let t = T0 + 400; t < T0 + 5000; t += 200) d.tick(t, { p: QUIET_AI, playback: playing(9), p_completion: 0.1 });
    return d;
  }

  it('ja: AI の終わりから L74 の待ち（p=0.1 は 2000ms）を数え直し、すぐには続けて話さない', () => {
    const d = overlapThenEnd(ja());
    const end = T0 + 5000;
    const early = afterEnd(d, end, 1980, { prefetch: ready(11, 0) });
    expect(kinds(early)).not.toContain('start_speech');
    expect(d.state.user_speak_end_time).toBe(end);
    expect(kinds(d.tick(end + 2000, { p: QUIET_LOW, p_completion: 0.1, prefetch: ready(11, 0) }))).toContain('start_speech');
  });

  it('ja: 数え直しの間に利用者が話せば、その発話の終わりから数える', () => {
    const d = overlapThenEnd(ja());
    const end = T0 + 5000;
    afterEnd(d, end, 500);
    d.tick(end + 600, { p: USER });
    expect(d.state.user_speak_end_time).toBe(end + 600);
  });

  it('数え直しを外すと（Appendix A のまま）AI の終わりの直後に続けて話す（この試験が (b) を見ている確認）', () => {
    const d = overlapThenEnd(jaAppendixA());
    const decisions = afterEnd(d, T0 + 5000, 100, { prefetch: ready(11, 0) });
    expect(kinds(decisions)).toContain('start_speech');
    expect(turnAllowed(decisions)?.reason).toContain('L74_completion_timeout');
  });

  it('hri2025: 原著どおり数え直さない（AI の終わりで user_speak_end_time は動かない）', () => {
    const d = overlapThenEnd(hri2025());
    const before = d.state.user_speak_end_time;
    d.tick(T0 + 5000, { p: QUIET_LOW, p_completion: 0.1 });
    expect(d.state.user_speak_end_time).toBe(before);
    expect(d.state.ignored_fragment).toBeNull();
  });

  it('hri2025: 断片も原著どおり準備の対象（AI の発話中にも L45-54 が走る）', () => {
    const d = fragmentDuringAi(hri2025(), 'で。');
    expect(d.state.ignored_fragment).toBeNull();
    expect(d.state.last_sent_asr_result).toBe('で。');
  });
});
