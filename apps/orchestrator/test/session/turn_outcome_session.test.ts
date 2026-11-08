/**
 * AI の発話の結果（turn.outcome）の配線と、開始の判断を変えないこと（記録の有無で turn.allowed が同じ）。
 * 偽の MaAI と台本のプロバイダ（session の結合試験と同じ）。値は台本で、VAP や認識の性能は表さない。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PolicyJa, type EventOf, type Policy, type ResearchEvent } from '@llm-vap/contracts';
import * as turnOutcomeModule from '../../src/control/turn_outcome';
import { Session } from '../../src/session/session';
import type { Rig } from './helpers';
import { createRig, ended, productionJaPolicy, started, userTurnUntilBegin, warmUp } from './helpers';

let rig: Rig | null = null;
afterEach(async () => {
  vi.restoreAllMocks();
  if (rig) await rig.session.close('test_done');
  rig = null;
});

const USER: [number, number, boolean] = [0.1, 0.1, true];
const AI_YIELD: [number, number, boolean] = [0.9, 0.9, false];

const outcomes = (r: Rig): EventOf<'turn.outcome'>[] => r.events.events.filter((e): e is EventOf<'turn.outcome'> => e.event === 'turn.outcome');
const aiOutcomes = (r: Rig) => outcomes(r).filter((o): o is Extract<EventOf<'turn.outcome'>, { kind: 'ai_utterance' }> => o.kind === 'ai_utterance');

/** 利用者の発話 → AI の開始 → 再生の報告 → 再生の終わり → settle まで進める。 */
async function userTurnThenAi(r: Rig, text: string, options: { afterStart?: () => Promise<void> } = {}): Promise<void> {
  await r.steps(30, { p: USER, loud: true });
  const begin = await userTurnUntilBegin(r, text);
  r.browser(started(begin));
  await options.afterStart?.();
  await r.steps(30, { p: AI_YIELD });
  r.browser(ended(begin, 'completed', 16000));
  await r.steps(Math.ceil(1000 / 20) + 3, { p: AI_YIELD });
}

describe('結果の記録', () => {
  it('発話ごとに終わりの後に1件。ラベルなしの普通の発話も開始の時点の値を残す', async () => {
    rig = await createRig({ reply: '今日は暑いですね。' });
    await warmUp(rig);
    await userTurnThenAi(rig, '今日はとても暑いです。');
    const [one, ...rest] = aiOutcomes(rig);
    expect(rest).toEqual([]);
    expect(one?.labels.value).toEqual([]);
    expect(one?.start.p_now.value).toBeCloseTo(0.9);
    expect(one?.start.vad_user.value).toBeLessThan(0.5);
    expect(one?.start.vap_freshness).toBe('fresh');
    expect(one?.origin).toBe('response');
    expect(one?.observed.user_voiced_just_before).toBe(true);
    expect(one?.observed.continuation.continued).toBe(false);
    expect(one?.speech_started_at.value).not.toBeNull();
    expect(one?.played_ms.value).toBeGreaterThan(0);
    const allowedStart = rig.events.events.find((e) => e.event === 'turn.allowed' && e.turn_allowed);
    expect(allowedStart).toBeDefined();
  });

  it('開始の直後に続きの文が来たら suspected_premature_start と user_continued_after_start', async () => {
    rig = await createRig({ reply: '今日は暑いですね。' });
    await warmUp(rig);
    await userTurnThenAi(rig, '今日はとても暑いです。', {
      afterStart: async () => {
        await rig!.steps(5, { p: AI_YIELD });
        rig!.stt().deliver({ kind: 'interim', text: 'それでね', audio_frame_end: rig!.frame });
        await rig!.steps(5, { p: USER, loud: true });
      },
    });
    const one = aiOutcomes(rig)[0];
    expect(one?.observed.continuation.continued).toBe(true);
    expect(one?.labels.value).toEqual(expect.arrayContaining(['user_continued_after_start', 'suspected_premature_start']));
  });

  it('前の AI の発話の後に人の声がないまま話し始めたら spoke_twice', async () => {
    rig = await createRig({ reply: '今日は暑いですね。' });
    await warmUp(rig);
    await userTurnThenAi(rig, '今日はとても暑いです。');
    // 無音のまま AI が続けて話し始める状況（判断は変えない）。vad[0] は 0.5 未満のまま文だけ届く。
    const begin = await userTurnUntilBegin(rig, 'えっと。', 400);
    rig.browser(started(begin));
    await rig.steps(10, { p: AI_YIELD });
    rig.browser(ended(begin, 'completed', 8000));
    await rig.steps(55, { p: AI_YIELD });
    expect(aiOutcomes(rig)[1]?.labels.value).toContain('spoke_twice');
  });

  it('人が話し終えても AI が話し始めないまま待ちを超えたら no_response（1回）', async () => {
    rig = await createRig({ reply: '今日は暑いですね。' });
    await warmUp(rig);
    rig.pauseTts = true; // 音声の準備が進まない
    await rig.steps(30, { p: USER, loud: true });
    rig.stt().deliver({ kind: 'final', text: 'まだ話したいことがあります', audio_frame_end: rig.frame });
    await rig.steps(Math.ceil(4500 / 20), { p: [0.2, 0.2, false] });
    const found = outcomes(rig).filter((o) => o.kind === 'no_response');
    expect(found).toHaveLength(1);
    expect(found[0]?.labels.value).toEqual(['no_response_after_user_yield']);
    expect(found[0]?.kind === 'no_response' && found[0].wait_state).toBeDefined();
  });

  it('再生の途中でセッションを閉じたら確定せず null_reason を残す', async () => {
    rig = await createRig({ reply: '今日は暑いですね。' });
    await warmUp(rig);
    await rig.steps(30, { p: USER, loud: true });
    const begin = await userTurnUntilBegin(rig, '今日はとても暑いです。');
    rig.browser(started(begin));
    await rig.steps(5, { p: AI_YIELD });
    const current = rig;
    await current.session.close('test_done');
    rig = null;
    const one = aiOutcomes(current)[0];
    expect(one?.labels).toEqual({ value: null, null_reason: 'playback_ended_abnormally' });
  });

  it('音声が流れずに再生が終わった場合も確定しない', async () => {
    rig = await createRig({ reply: '今日は暑いですね。' });
    await warmUp(rig);
    await rig.steps(30, { p: USER, loud: true });
    const begin = await userTurnUntilBegin(rig, '今日はとても暑いです。');
    rig.browser(ended(begin, 'completed', 0));
    await rig.steps(5, { p: AI_YIELD });
    const one = aiOutcomes(rig)[0];
    expect(one?.labels).toEqual({ value: null, null_reason: 'no_audio_played' });
  });

  it('方策に turn.outcome がなければ記録しない', async () => {
    const policy = PolicyJa.parse(productionJaPolicy());
    delete policy.turn.outcome;
    rig = await createRig({ policy, reply: '今日は暑いですね。' });
    await warmUp(rig);
    await userTurnThenAi(rig, '今日はとても暑いです。');
    expect(outcomes(rig)).toEqual([]);
  });
});

/** turn.allowed の列（開始の判断）だけを抜き出す。 */
function allowedOf(events: ResearchEvent[]): unknown[] {
  return events
    .filter((e): e is EventOf<'turn.allowed'> => e.event === 'turn.allowed')
    .map((e) => ({ t: e.t_monotonic_ms, allowed: e.turn_allowed, source: e.decision_source, reason: e.reason }));
}

async function scripted(policy: Policy, disableOutcome: boolean): Promise<ResearchEvent[]> {
  if (disableOutcome) vi.spyOn(turnOutcomeModule, 'turnOutcomeSettings').mockReturnValue(null);
  const r = await createRig({ policy, reply: '今日は暑いですね。' });
  await warmUp(r);
  await userTurnThenAi(r, '今日はとても暑いです。', {
    afterStart: async () => {
      r.stt().deliver({ kind: 'interim', text: 'それでね', audio_frame_end: r.frame });
      await r.steps(5, { p: USER, loud: true });
    },
  });
  await userTurnThenAi(r, '次はいつですか。');
  await r.session.close('test_done');
  vi.restoreAllMocks();
  return [...r.events.events];
}

describe('記録は開始の判断を変えない', () => {
  it('ja: 記録の有無で turn.allowed の列と開始の時刻が同じ', async () => {
    const a = await scripted(productionJaPolicy(), true);
    const b = await scripted(productionJaPolicy(), false);
    expect(a.some((e) => e.event === 'turn.outcome')).toBe(false);
    expect(b.some((e) => e.event === 'turn.outcome')).toBe(true);
    expect(allowedOf(b)).toEqual(allowedOf(a));
    const starts = (events: ResearchEvent[]) => events.filter((e) => e.event === 'speech.started').map((e) => e.t_monotonic_ms);
    expect(starts(b)).toEqual(starts(a));
  });

  it('hri2025: 記録の有無で turn.allowed の列が同じ', async () => {
    const hri = JSON.parse((await import('node:fs')).readFileSync((await import('node:path')).join(import.meta.dirname, '..', '..', '..', '..', 'config', 'policy.hri2025.json'), 'utf8')) as Policy;
    const a = await scripted(hri, true);
    const b = await scripted(hri, false);
    expect(allowedOf(b)).toEqual(allowedOf(a));
  });
});

describe('ゼロ埋めの区間の VAP（docs/known_gaps.md §12）', () => {
  it('ゼロ埋めの範囲の VAP は使わず stale になり、範囲を抜けると戻る', async () => {
    rig = await createRig({ reply: '今日は暑いですね。' });
    await warmUp(rig);
    expect(rig.session.turnState.vap_freshness).toBe('fresh');
    const fromFrame = rig.frame + 200;
    const maai = rig.maai!;
    for (const l of (maai as unknown as { listeners: Set<{ onFramesDropped?: (m: unknown, at: number) => void }> }).listeners) {
      l.onFramesDropped?.({ type: 'FRAMES_DROPPED', from_audio_frame: fromFrame, sample_count: 16000 * 2, cause: 'network_gap', zero_filled: true, channels: 'both' }, rig.time.monotonicMs());
    }
    await rig.steps(40); // 800ms: 範囲に入ってから VAP を入れない → arrival_lag で stale
    expect(rig.session.turnState.vap_freshness).toBe('stale');
    await rig.steps(Math.ceil(2200 / 20)); // 範囲を抜ける
    expect(rig.session.turnState.vap_freshness).toBe('fresh');
  });

  it('ゼロ埋めの範囲外の VAP は今までどおり使う（判定の感度の確認）', async () => {
    rig = await createRig({ reply: '今日は暑いですね。' });
    await warmUp(rig);
    vi.spyOn(Session.prototype as unknown as { overlapsZeroFill(): boolean }, 'overlapsZeroFill').mockReturnValue(false);
    const fromFrame = rig.frame + 200;
    for (const l of (rig.maai as unknown as { listeners: Set<{ onFramesDropped?: (m: unknown, at: number) => void }> }).listeners) {
      l.onFramesDropped?.({ type: 'FRAMES_DROPPED', from_audio_frame: fromFrame, sample_count: 16000 * 2, cause: 'network_gap', zero_filled: true, channels: 'both' }, rig.time.monotonicMs());
    }
    await rig.steps(40);
    expect(rig.session.turnState.vap_freshness).toBe('fresh');
  });
});
