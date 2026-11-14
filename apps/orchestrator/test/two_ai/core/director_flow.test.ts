/** 進行役の流れ（01 §3.3〜§3.6）：誤った停止、② の扱い、点の発火、壁時計の上限。 */
import { describe, expect, it } from 'vitest';
import { Sim, testConfig } from './harness';

const finish = (sim: Sim) => sim.runUntil((s) => s.state.phase === 'response', 900_000);

describe('誤った停止（false onset）', () => {
  it('声が確かめられないまま false_onset_window が過ぎる → 受け止めなしで resume（mode: false_onset）、notify なし', () => {
    const sim = Sim.create('respond_on_spot');
    sim.toDiscussion();
    sim.runUntil((s) => s.playingKey() === 'd2');
    sim.run(500);
    sim.interject();
    sim.run(200); // backchannel_max_voiced_ms（700）に届かない
    sim.stopTalking();
    sim.runUntil((s) => s.of('request_resume').length > 0, 5000);
    expect(sim.of('stop_turn')).toHaveLength(1);
    expect(sim.of('request_resume')[0]!.mode).toBe('false_onset');
    expect(sim.of('offer_ack')).toHaveLength(0);
    expect(sim.of('notify_interjection_closed')).toHaveLength(0);
    finish(sim);
    expect(sim.played.filter((p) => p.kind === 'ack')).toHaveLength(0);
    expect(sim.emitted('two_ai.interjection_episode')[0]!.outcome).toBe('false_onset');
  });

  it('声が確かめられれば受け止めを申し出る', () => {
    const sim = Sim.create('respond_on_spot');
    sim.toDiscussion();
    sim.runUntil((s) => s.playingKey() === 'd2');
    sim.interject();
    sim.run(1500);
    sim.stopTalking();
    finish(sim);
    expect(sim.of('offer_ack').length).toBeGreaterThan(0);
    expect(sim.of('request_resume')[0]!.mode).toBe('after_ack');
  });
});

describe('② respond_at_end', () => {
  it('話し始めても止めない・視線を向けない・受け止めない。episode は logged_only', () => {
    const sim = Sim.create('respond_at_end');
    sim.toDiscussion();
    for (const key of ['d1', 'F.0', 'd4']) {
      sim.runUntil((s) => s.playingKey() === key);
      sim.interject();
      sim.run(2000);
      sim.stopTalking();
    }
    finish(sim);
    expect(sim.of('stop_turn')).toHaveLength(0);
    expect(sim.of('offer_ack')).toHaveLength(0);
    expect(sim.of('request_resume')).toHaveLength(0);
    expect(sim.of('gaze').filter((g) => g.target === 'user' && /interject/.test(g.reason))).toHaveLength(0);
    const eps = sim.emitted('two_ai.interjection_episode');
    expect(eps.length).toBeGreaterThan(0);
    for (const e of eps) expect(e.outcome).toBe('logged_only');
  });
});

describe('点の発火', () => {
  it('割り込みのない回：全部の点が scheduled → started → completed、各 1 回、順は台本どおり', () => {
    const sim = Sim.create('respond_on_spot');
    finish(sim);
    const pts = sim.emitted('two_ai.point');
    for (const id of ['f1', 'k1', 'c1']) {
      const stages = pts.filter((p) => p.point_id === id).map((p) => p.stage);
      expect(stages.filter((x) => x === 'started')).toHaveLength(1);
      expect(stages.filter((x) => x === 'completed')).toHaveLength(1);
      expect(stages).not.toContain('missed');
    }
    const order = pts.filter((p) => p.stage === 'started').map((p) => p.point_id);
    expect(order).toEqual(['f1', 'k1', 'c1']);
    const fx = sim.emitted('two_ai.point_exposure');
    expect(fx.map((e) => e.point_id).sort()).toEqual(['c1', 'f1', 'k1']);
    for (const e of fx) expect(e.complete).toBe(true);
  });

  it('started の content_elapsed_ms は単調に増える', () => {
    const sim = Sim.create('respond_at_end');
    finish(sim);
    const at = sim.emitted('two_ai.point').filter((p) => p.stage === 'started').map((p) => (p.content_elapsed_ms as { value: number }).value);
    expect(at).toEqual([...at].sort((a, b) => a - b));
  });

  it('壁時計の max_sec で残りの点を force_points（forced）、上限＋overrun で missed', () => {
    const config = testConfig((c) => {
      c.phases.discussion = { ...c.phases.discussion, target_sec: 20, close_at_sec: 15, max_sec: 20, points_overrun_max_sec: 10 };
    });
    const sim = Sim.create('respond_at_end', { config });
    finish(sim);
    expect(sim.of('force_points')).toHaveLength(1);
    const pts = sim.emitted('two_ai.point');
    expect(pts.some((p) => p.stage === 'forced')).toBe(true);
    // どの点も閉じている（completed か missed）。
    for (const id of ['f1', 'k1', 'c1']) {
      const st = pts.filter((p) => p.point_id === id).map((p) => p.stage);
      expect(st.includes('completed') || st.includes('missed')).toBe(true);
    }
  });
});
