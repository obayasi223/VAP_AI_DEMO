/** 試みの全記録（two_ai.interjection_attempt）：止まったかどうかにかかわらず、話し合いの段の話し始めの試みを 1 行ずつ残す。 */
import { describe, expect, it } from 'vitest';
import { Sim } from './harness';

const finish = (sim: Sim) => sim.runUntil((s) => s.state.phase === 'response', 900_000);
const attempts = (sim: Sim) => sim.emitted('two_ai.interjection_attempt');

describe('試みの記録', () => {
  it('① で AI を止めた試み：stopped、重なっていたターンと点、onset の規則、episode と結ぶ', () => {
    const sim = Sim.create('respond_on_spot');
    sim.toDiscussion();
    sim.runUntil((s) => s.playingKey() === 'F.0');
    sim.run(500);
    sim.interject();
    sim.run(1500);
    sim.stopTalking();
    finish(sim);
    const a = attempts(sim);
    expect(a).toHaveLength(1);
    const ep = sim.emitted('two_ai.interjection_episode')[0]!;
    expect(a[0]).toMatchObject({
      outcome: 'stopped',
      interjection_id: ep.interjection_id,
      episode_outcome: 'yielded',
      onset_rule: 'p_threshold',
      ai_end_reason: 'stopped',
      overlapped: { turn_kind: 'point', point_id: 'f1', ai_id: 'A' },
      self_finish_window_ms: 1500,
    });
    expect(a[0]!.voiced_ms).toBeGreaterThanOrEqual(1400);
    expect(a[0]!.detect_latency_ms.value).toBe(0);
    // episode の意味は変わらない。
    expect(ep.outcome).toBe('yielded');
  });

  it('onset に届かなかった試み：sub_threshold（episode を作らない）', () => {
    const sim = Sim.create('respond_on_spot');
    sim.toDiscussion();
    sim.runUntil((s) => s.playingKey() === 'd2');
    sim.run(200);
    sim.voiceWithoutOnset();
    sim.run(800);
    sim.stopTalking();
    sim.run(100);
    const a = attempts(sim);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ outcome: 'sub_threshold', interjection_id: null, episode_outcome: null, onset_rule: null, ai_end_reason: null });
    expect(a[0]!.overlapped?.turn_kind).toBe('discussion');
    expect(a[0]!.onset_at).toEqual({ value: null, null_reason: 'no_onset' });
    expect(a[0]!.ai_end_after_ms).toEqual({ value: null, null_reason: 'not_ended_in_attempt' });
    expect(sim.emitted('two_ai.interjection_episode')).toHaveLength(0);
    expect(sim.of('stop_turn')).toHaveLength(0);
  });

  it('AI が残り self_finish_window_ms 以内に自分で話し終えた試み：ai_finished_self（止めそこねと分ける）', () => {
    const sim = Sim.create('respond_on_spot');
    sim.toDiscussion();
    sim.runUntil((s) => s.playingKey() === 'd2');
    sim.run(2400); // d2 は 3000 ms
    sim.voiceWithoutOnset();
    sim.run(1200);
    sim.stopTalking();
    sim.run(100);
    const a = attempts(sim);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ outcome: 'ai_finished_self', ai_end_reason: 'completed', interjection_id: null });
    expect(a[0]!.ai_end_after_ms.value).toBeLessThanOrEqual(1500);
  });

  it('AI が窓より後に話し終えた onset なしの試みは sub_threshold のまま', () => {
    const sim = Sim.create('respond_on_spot', {});
    sim.toDiscussion();
    sim.runUntil((s) => s.playingKey() === 'd2');
    sim.run(500);
    sim.voiceWithoutOnset();
    sim.run(2800);
    sim.stopTalking();
    sim.run(100);
    const a = attempts(sim);
    expect(a[0]).toMatchObject({ outcome: 'sub_threshold', ai_end_reason: 'completed' });
    expect(a[0]!.ai_end_after_ms.value).toBeGreaterThan(1500);
  });

  it('② の onset：logged_only（止めない）', () => {
    const sim = Sim.create('respond_at_end');
    sim.toDiscussion();
    sim.runUntil((s) => s.playingKey() === 'd1');
    sim.interject();
    sim.run(2000);
    sim.stopTalking();
    sim.run(500);
    const a = attempts(sim);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ outcome: 'logged_only', episode_outcome: 'logged_only' });
    expect(sim.of('stop_turn')).toHaveLength(0);
  });

  it('止めたが声が確かめられない：non_speech（episode は false_onset）', () => {
    const sim = Sim.create('respond_on_spot');
    sim.toDiscussion();
    sim.runUntil((s) => s.playingKey() === 'd2');
    sim.run(500);
    sim.interject();
    sim.run(200);
    sim.stopTalking();
    sim.runUntil((s) => s.of('request_resume').length > 0, 5000);
    sim.run(100);
    const a = attempts(sim);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ outcome: 'non_speech', episode_outcome: 'false_onset' });
  });

  it('sub_threshold_min_ms より短い onset なしの声は出さない。intake の声も出さない', () => {
    const sim = Sim.create('respond_on_spot');
    sim.voiceWithoutOnset();
    sim.run(600);
    sim.stopTalking();
    sim.toDiscussion();
    sim.runUntil((s) => s.playingKey() === 'd2');
    sim.voiceWithoutOnset();
    sim.run(60);
    sim.stopTalking();
    sim.run(100);
    expect(attempts(sim)).toHaveLength(0);
  });

  it('開いている割り込みの中で始まった声は新しい試みにしない', () => {
    const sim = Sim.create('respond_on_spot');
    sim.toDiscussion();
    sim.runUntil((s) => s.playingKey() === 'd2');
    sim.interject();
    sim.run(1500);
    sim.stopTalking();
    sim.run(200);
    expect(sim.state.interjection).not.toBeNull();
    sim.voiceWithoutOnset(); // 同じ割り込みの言い足し
    sim.run(600);
    sim.stopTalking();
    finish(sim);
    expect(attempts(sim)).toHaveLength(1);
    expect(attempts(sim)[0]!.outcome).toBe('stopped');
  });
});
