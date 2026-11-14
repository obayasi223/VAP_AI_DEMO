/**
 * 中身の時計（06 §6.0、01 §3.3。第 2 回 M1、第 4 回 M3、第 5 回 M2）。
 * ① の割り込み（受け止め、resume、保留の時間切れの bridge）は中身の時計を進めない。保留の時間切れで捨てた F.1、F.2 の見込みは
 * credited_ms として 1 回だけ足すので、F の後の点の拍は ② と同じ、時刻の差は 1 拍の見込み以内。
 */
import { describe, expect, it } from 'vitest';
import { Sim } from './harness';

function pointStarts(sim: Sim): Map<string, { content: number; beats: number }> {
  const out = new Map<string, { content: number; beats: number }>();
  for (const e of sim.emitted('two_ai.point')) {
    if (e.stage !== 'started') continue;
    out.set(e.point_id, { content: (e.content_elapsed_ms as { value: number }).value, beats: 0 });
  }
  // 拍：その点の開始より前に話し終えた discussion のターンの数。
  for (const [id, v] of out) {
    const startKey = sim.played.find((p) => sim.delivered.get(p.turn_id)?.point_id === id)!;
    v.beats = sim.played.filter((p) => p.kind === 'discussion' && p.started_at < startKey.started_at).length;
  }
  return out;
}

function runAtEnd(): Sim {
  const sim = Sim.create('respond_at_end');
  sim.runUntil((s) => s.state.phase === 'response', 900_000);
  return sim;
}

describe('content_clock', () => {
  it('割り込みのない ② で、点の開始の時計は前の中身のターンの長さと間の和', () => {
    const sim = runAtEnd();
    const starts = pointStarts(sim);
    // d1 3000+500、d2 3000+500 の後に F.0。
    expect(starts.get('f1')!.content).toBe(7000);
    expect(starts.get('f1')!.beats).toBe(2);
  });

  it('① の割り込み（受け止め → resume）を入れても、点の開始の時計と拍は ② と同じ', () => {
    const ref = pointStarts(runAtEnd());
    const sim = Sim.create('respond_on_spot');
    sim.toDiscussion();
    for (const key of ['d1', 'd4', 'd6']) {
      sim.runUntil((s) => s.playingKey() === key);
      sim.run(1000);
      sim.interject();
      sim.run(1200);
      sim.stopTalking();
      sim.runUntil((s) => s.state.interjection === null && s.state.sub.kind === 'ai_speaking');
    }
    sim.runUntil((s) => s.state.phase === 'response', 900_000);
    const got = pointStarts(sim);
    for (const id of ['f1', 'k1', 'c1']) {
      expect(got.get(id), id).toEqual(ref.get(id));
    }
    expect(sim.emitted('two_ai.interjection_episode').map((e) => e.outcome)).toEqual(['yielded', 'yielded', 'yielded']);
    expect(sim.played.filter((p) => p.kind === 'ack')).toHaveLength(3);
    expect(sim.played.filter((p) => p.kind === 'resume')).toHaveLength(3);
  });

  it('保留の時間切れ（F.0 の途中）：bridge は 0、credited_ms を 1 回だけ足し、F の後の点は拍が ② と同じで差は 1 拍の見込み以内', () => {
    const refSim = runAtEnd();
    const ref = pointStarts(refSim);
    const sim = Sim.create('respond_on_spot');
    sim.toDiscussion();
    sim.runUntil((s) => s.playingKey() === 'F.0');
    sim.run(1000);
    sim.interject();
    sim.run(1000);
    sim.stopTalking();
    sim.runUntil((s) => s.of('abandon_resume').length > 0, 20_000);
    expect(sim.of('request_fixed').filter((a) => a.line.kind === 'hold_bridge')).toHaveLength(1);
    sim.runUntil((s) => s.state.phase === 'response', 900_000);

    // bridge は中身の時計に入らない。
    const bridgeEnded = sim.emitted('two_ai.turn').filter((e) => e.turn_kind === 'bridge' && e.stage === 'ended');
    expect(bridgeEnded).toHaveLength(1);
    expect(bridgeEnded[0]!.content_ms).toEqual({ value: 0 });
    // F.1、F.2 は話さない。F.0 の言い直しもない。
    expect(sim.played.map((p) => p.key)).not.toContain('F.1');
    expect(sim.played.map((p) => p.key)).not.toContain('F.2');
    expect(sim.played.filter((p) => p.kind === 'resume')).toHaveLength(0);
    // credited_ms は F.1 と F.2 の見込みの和で、episode に残る。
    const ep = sim.emitted('two_ai.interjection_episode')[0]!;
    expect(ep.correction_hold?.ended_by).toBe('timeout');
    expect(ep.correction_hold?.credited_ms).toEqual({ value: 8000 });
    expect(sim.state.credited_interjection_ids).toEqual([ep.interjection_id]);

    const got = pointStarts(sim);
    const beat = sim.config.phases.discussion.avg_turn_sec_estimate * 1000;
    for (const id of ['k1', 'c1']) {
      expect(got.get(id)!.beats, id).toBe(ref.get(id)!.beats);
      expect(Math.abs(got.get(id)!.content - ref.get(id)!.content), id).toBeLessThanOrEqual(beat);
    }
  });

  it('同じ interjection_id の credited_ms は 2 回届いても 1 回だけ足す', async () => {
    const { directorStep } = await import('../../../src/two_ai/director');
    const { emptyInputs, initialDirectorState } = await import('../../../src/two_ai/director_state');
    const sim = Sim.create('respond_on_spot');
    let state = initialDirectorState(sim.init, 0);
    state = { ...state, phase: 'discussion', sub: { kind: 'between_turns' }, discussion_started_at: 0 };
    const inputs = emptyInputs();
    inputs.plan = { state: 'ready', can_start_early: true, plan_id: 'p', source: 'prepared' };
    inputs.content_credits = [{ interjection_id: 'ij1', credited_ms: 5000 }];
    state = directorStep(sim.config, sim.init, state, inputs, 20).state;
    state = directorStep(sim.config, sim.init, state, inputs, 40).state;
    expect(state.content_elapsed_ms).toBe(5000);
  });
});
