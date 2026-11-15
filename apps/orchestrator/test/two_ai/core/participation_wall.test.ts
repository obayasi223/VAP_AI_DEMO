/**
 * 本人の参加の時間を話し合いの時間に数えない（統合 2。技術評価 docs/two_ai_tech_eval.md の発見）。
 * U1 は開いている割り込みの時間しか上限の壁時計から引かなかったので、割り込みの多い ① では、停止の遅れ、言い直しの繰り返し、
 * 間が積もって、段 4 が中身を出し切る前に壁時計で閉じた。ここでは、多数の割り込みでも ② と同じく段 4 まで中身が出ること、
 * 割り込みのない ① の時間の流れは ② と同じこと、安全の上限で閉じたときは段の完了の記録に理由が出ることを確かめる。
 */
import { describe, expect, it } from 'vitest';
import type { AiId } from '@llm-vap/contracts';
import { Sim, defaultScript, testConfig, type ScriptTurn } from './harness';

/** 段 2〜4 に点の外のターンを足した台本（割り込みを 14 回入れられるように）。 */
function longScript(): ScriptTurn[] {
  const base = defaultScript();
  const extra = (key: string, speaker: AiId, stage: 2 | 3 | 4): ScriptTurn => ({ key, speaker, kind: 'discussion', point_id: null, stage, ms: 3000, gap: 500 });
  const at = (key: string) => base.findIndex((t) => t.key === key);
  base.splice(at('K.0'), 0, extra('e1', 'B', 2), extra('e2', 'A', 2));
  base.splice(at('C.0'), 0, extra('e3', 'B', 3), extra('e4', 'A', 3));
  base.splice(at('d8'), 0, extra('e5', 'B', 4), extra('e6', 'A', 4), extra('e7', 'B', 4));
  // 板のカード：段ごとに最後の点の外のターンで 1 枚。
  for (const [key, card] of [['d3', 'card_1'], ['d5', 'card_2'], ['C.2', 'card_3'], ['d8', 'card_4']] as const) base[at(key)]!.board_card_id = card;
  return base;
}

const INTERRUPTED = ['d1', 'd2', 'd3', 'd4', 'e1', 'e2', 'd5', 'd6', 'e3', 'e4', 'd7', 'e5', 'e6', 'e7'];

function config(over: (d: Record<string, any>) => void = () => undefined) {
  return testConfig((c) => {
    // ② は中身で閉じる（壁時計 約 90 秒）。上限はそのすぐ上に置く。
    c.phases.discussion = { ...c.phases.discussion, target_sec: 95, close_at_sec: 90, max_sec: 100, points_overrun_max_sec: 20 };
    over(c.phases.discussion);
  });
}

function runAtEnd(cfg = config()): Sim {
  const sim = Sim.create('respond_at_end', { config: cfg, script: longScript() });
  sim.runUntil((s) => s.state.phase === 'response', 900_000);
  return sim;
}

/** 14 回の短い割り込み（話の終わりの近くで止める：停止の遅れ 600 ms、言い直しで文の頭から繰り返す）。 */
function runManyInterjections(cfg = config(), voiceMs = 900): Sim {
  const sim = Sim.create('respond_on_spot', { config: cfg, script: longScript() });
  sim.stopAfterMs = 600;
  sim.toDiscussion();
  for (const key of INTERRUPTED) {
    sim.runUntil((s) => s.playingKey() === key || s.state.phase !== 'discussion');
    if (sim.state.phase !== 'discussion') break;
    sim.run(2500);
    sim.interject();
    sim.run(voiceMs);
    sim.stopTalking();
    sim.runUntil((s) => (s.state.interjection === null && s.state.sub.kind === 'ai_speaking') || s.state.phase !== 'discussion');
  }
  sim.runUntil((s) => s.state.phase === 'response', 900_000);
  return sim;
}

const closed = (sim: Sim) => sim.emitted('two_ai.phase_changed').find((e) => e.from === 'discussion')!;
const stagesEnded = (sim: Sim) => sim.emitted('two_ai.stage').filter((e) => e.edge === 'ended');
const contentKeys = (sim: Sim) => sim.played.filter((p) => p.kind === 'discussion' || p.kind === 'point' || p.kind === 'point_elaboration').map((p) => p.key);

describe('本人の参加の時間（統合 2）', () => {
  it('14 回の割り込みの ① でも、閉じるのは中身が尽きたときで、段 1〜4 の中身と板の 4 枚が ② と同じに出る', () => {
    const ref = runAtEnd();
    expect(closed(ref).source).toBe('auto_content');
    const sim = runManyInterjections();
    const eps = sim.emitted('two_ai.interjection_episode');
    expect(eps.filter((e) => e.outcome === 'yielded').length).toBeGreaterThanOrEqual(14);
    // 壁時計は max_sec を大きく越えたが、中身の完了で閉じた。
    const c = closed(sim);
    expect((c.elapsed_in_from_ms as { value: number }).value).toBeGreaterThan(sim.config.phases.discussion.max_sec * 1000);
    expect(c.source).toBe('auto_content');
    expect(c.reason).toBe('discussion_closed');
    // 中身のターンの列（言い直しを除く）と板が ② と同じ。
    expect(contentKeys(sim)).toEqual(contentKeys(ref));
    expect(sim.state.board.shown_card_ids).toEqual(['card_1', 'card_2', 'card_3', 'card_4']);
    // 段の完了の記録。
    const ended = stagesEnded(sim);
    expect(ended.map((e) => e.completion?.complete)).toEqual([true, true, true, true]);
    expect(ended.map((e) => e.completion?.ended_by)).toEqual(['next_stage', 'next_stage', 'next_stage', 'content_done']);
    expect(ended.map((e) => e.completion?.cards_shown)).toEqual([['card_1'], ['card_2'], ['card_3'], ['card_4']]);
    expect(ended.map((e) => e.completion?.cards_planned)).toEqual([['card_1'], ['card_2'], ['card_3'], ['card_4']]);
    expect(ended.map((e) => e.completion?.points_completed)).toEqual([['f1'], ['k1'], ['c1'], []]);
    expect(stagesEnded(ref).map((e) => e.completion)).toEqual(
      stagesEnded(ref).map((e, i) => ({ ...e.completion, ended_by: ['next_stage', 'next_stage', 'next_stage', 'content_done'][i], participation_ms: 0 })),
    );
    // 参加の時間は、開いている割り込みに加えて、言い直しの繰り返しと間を含む。② との壁時計の差の大半を引く（差は 1 回あたり 1 拍の間以内）。
    const wallA = (c.elapsed_in_from_ms as { value: number }).value;
    const wallB = (closed(ref).elapsed_in_from_ms as { value: number }).value;
    const participation = sim.state.interjection_wall_ms;
    expect(participation).toBeLessThanOrEqual(wallA - wallB + INTERRUPTED.length * 600);
    expect(participation).toBeGreaterThanOrEqual(wallA - wallB - 1000);
    expect(ended.reduce((a, e) => a + (e.completion?.participation_ms ?? 0), 0)).toBeCloseTo(participation, -1);
  });

  it('割り込みのない ① は、② と同じ時間の流れ（参加の時間 0、段の境界の時刻が同じ）', () => {
    const ref = runAtEnd();
    const sim = Sim.create('respond_on_spot', { config: config(), script: longScript() });
    sim.runUntil((s) => s.state.phase === 'response', 900_000);
    expect(sim.state.interjection_wall_ms).toBe(0);
    const times = (s: Sim) => s.emitted('two_ai.stage').map((e) => [e.edge, e.discussion_stage, e.discussion_elapsed_ms, e.content_elapsed_ms]);
    expect(times(sim)).toEqual(times(ref));
    expect(stagesEnded(sim).map((e) => e.completion)).toEqual(stagesEnded(ref).map((e) => e.completion));
  });

  it('参加の時間が延長の上限（interjection_allowance_max_sec）を越えたら、上限で閉じ、段の完了の記録に未完と理由が出る', () => {
    const sim = runManyInterjections(config((d) => (d.interjection_allowance_max_sec = 5)), 900);
    const c = closed(sim);
    expect(c.source).toBe('auto_timer');
    expect(c.reason).toMatch(/^discussion_closed_(wall_max_sec|absolute_limit)$/);
    const ended = stagesEnded(sim);
    const last = ended[ended.length - 1]!;
    expect(last.completion?.complete).toBe(false);
    expect(['wall_max_sec', 'absolute_limit']).toContain(last.completion?.ended_by);
    expect(last.completion?.cards_shown).not.toContain('card_4');
  });
});
