/**
 * 訂正と判定の保留（01 §3.5.2、06 §6.2。第 3 回 M2、第 4 回 M1・M2、第 5 回 M1・M2・m1・m2）。
 * F.0 の途中で本人が割り込む。止めたターンが F のブロック（元の版）なので、窓の後も hold_until まで resume を頼まない。
 */
import { describe, expect, it } from 'vitest';
import { Sim, testConfig } from './harness';

/** F.0 の途中で 1 秒話して止める。保留に入るところまで進める。 */
function interruptF0(sim: Sim, talkMs = 1000): void {
  sim.toDiscussion();
  sim.runUntil((s) => s.playingKey() === 'F.0');
  sim.run(1000);
  sim.interject();
  sim.run(talkMs);
  sim.stopTalking();
  sim.runUntil((s) => s.state.sub.kind === 'correction_window', 10_000);
}

const fresh = (status: 'pending' | 'done' | 'failed', corrects: boolean | null) => ({ suggestion_id: 'sg1', point_id: 'f1', asr_segment_ids: [], status, corrects, evidence_span: '' });

function finish(sim: Sim): void {
  sim.runUntil((s) => s.state.phase === 'response', 900_000);
}

const keys = (sim: Sim) => sim.played.map((p) => p.key);

describe('director_correction：判定の保留', () => {
  it('保留が始まる：hold_until は本人の発話の終わり＋hold_max_ms、hold_cap は ×2', () => {
    const sim = Sim.create('respond_on_spot');
    interruptF0(sim);
    const sub = sim.state.sub;
    if (sub.kind !== 'correction_window') throw new Error('not in window');
    const track = sim.state.interjection!;
    expect(sub.hold_until).toBe(track.user_ended_at! + 6000);
    expect(sub.hold_cap).toBe(track.user_ended_at! + 12000);
    expect(sub.until).toBeLessThan(sub.hold_until!);
  });

  it('(1) auto の判定が窓の後・上限の前に corrects: true → in_window、resume なし、受け止め → uptake → 訂正後の F.1', () => {
    const sim = Sim.create('respond_on_spot', { correction_mode: 'auto' });
    interruptF0(sim);
    sim.run(4000); // 窓（2.5 秒）の後
    expect(sim.of('request_resume')).toHaveLength(0);
    sim.suggestions = [fresh('done', true)];
    sim.run(200);
    const apply = sim.of('apply_correction');
    expect(apply).toHaveLength(1);
    expect(apply[0]).toMatchObject({ point_id: 'f1', trigger: 'auto_confirmed', timing: 'in_window' });
    finish(sim);
    const k = keys(sim);
    expect(sim.of('request_resume')).toHaveLength(0);
    expect(k.indexOf('F.1')).toBeGreaterThan(k.findIndex((x) => x.startsWith('up_')));
    expect(sim.emitted('two_ai.turn').find((e) => e.stage === 'started' && e.point_id === 'f1' && e.turn_kind === 'point_elaboration')?.point_variant).toBe('corrected');
    const ep = sim.emitted('two_ai.interjection_episode')[0]!;
    expect(ep.correction_hold?.ended_by).toBe('corrected');
    expect(ep.correction).toEqual({ point_id: 'f1', trigger: 'auto_confirmed', timing: 'in_window' });
    expect(sim.of('abandon_resume')).toHaveLength(0);
  });

  it('(2) 研究者の押下が窓の後・上限の前 → in_window、F.0 の言い直しなし', () => {
    const sim = Sim.create('respond_on_spot');
    interruptF0(sim);
    sim.run(4000);
    sim.woz.push({ woz_id: 'w1', action: 'correction', point_id: 'f1', operator: 'r', received_at: sim.now });
    sim.run(100);
    expect(sim.of('apply_correction')[0]).toMatchObject({ trigger: 'woz_researcher', timing: 'in_window' });
    finish(sim);
    expect(sim.played.filter((p) => p.kind === 'resume')).toHaveLength(0);
  });

  it('(3) auto の判定が corrects: false → ふつうの resume（訂正でない）', () => {
    const sim = Sim.create('respond_on_spot', { correction_mode: 'auto' });
    interruptF0(sim);
    sim.run(3000);
    sim.suggestions = [fresh('done', false)];
    sim.run(100);
    expect(sim.of('request_resume')).toHaveLength(1);
    finish(sim);
    expect(sim.emitted('two_ai.interjection_episode')[0]!.correction_hold?.ended_by).toBe('not_correction');
    expect(sim.played.filter((p) => p.kind === 'resume')).toHaveLength(1);
  });

  it('(4) 判定が届かない → hold_until で hold_bridge と abandon_resume が同じ tick に 1 回ずつ、準備済みの F.1 を捨てる', () => {
    const sim = Sim.create('respond_on_spot');
    interruptF0(sim);
    sim.runUntil((s) => s.of('abandon_resume').length > 0, 10_000);
    const tick = sim.log.find((l) => l.actions.some((a) => a.kind === 'abandon_resume'))!;
    expect(tick.actions.filter((a) => a.kind === 'request_fixed' && a.line.kind === 'hold_bridge')).toHaveLength(1);
    expect(tick.actions.filter((a) => a.kind === 'abandon_resume')).toHaveLength(1);
    expect(tick.actions.find((a) => a.kind === 'abandon_resume')).toMatchObject({ reason: 'correction_hold_timeout' });
    // 第 5 回 m1：F のブロックの準備済みの next は同じ step で取り消す。fallback も出さない。
    const cancelled = tick.actions.find((a) => a.kind === 'cancel_turn' && a.reason === 'abandon_resume');
    expect(cancelled).toBeDefined();
    expect(sim.state.next?.turn_id ?? null).not.toBe((cancelled as { turn_id: string }).turn_id);
    finish(sim);
    expect(sim.of('substitute_fallback').filter((a) => a.turn_id === (cancelled as { turn_id: string }).turn_id)).toHaveLength(0);
    expect(keys(sim)).not.toContain('F.1');
    expect(sim.played.filter((p) => p.kind === 'resume')).toHaveLength(0);
    expect(sim.played.filter((p) => p.kind === 'bridge')).toHaveLength(1);
    // F の点は complete: false、segments.cut は interjection。
    const fx = sim.emitted('two_ai.point_exposure').find((e) => e.point_id === 'f1')!;
    expect(fx.complete).toBe(false);
    expect(fx.segments[0]!.cut).toBe('interjection');
  });

  it('(5) ② では保留がない（止めない）', () => {
    const sim = Sim.create('respond_at_end');
    sim.toDiscussion();
    sim.runUntil((s) => s.playingKey() === 'F.0');
    sim.interject();
    sim.run(3000);
    sim.stopTalking();
    finish(sim);
    expect(sim.of('stop_turn')).toHaveLength(0);
    expect(sim.state.sub.kind).not.toBe('correction_window');
    expect(sim.emitted('two_ai.interjection_episode')[0]!.correction_hold).toBeNull();
  });

  it('(6) F のブロックの外の割り込みでは保留がない（窓の後に resume）', () => {
    const sim = Sim.create('respond_on_spot');
    sim.toDiscussion();
    sim.runUntil((s) => s.playingKey() === 'd3');
    sim.run(500);
    sim.interject();
    sim.run(1000);
    sim.stopTalking();
    sim.runUntil((s) => s.state.sub.kind === 'correction_window');
    const sub = sim.state.sub as { hold_until: number | null };
    expect(sub.hold_until).toBeNull();
    sim.runUntil((s) => s.of('request_resume').length > 0, 10_000);
    finish(sim);
    expect(sim.emitted('two_ai.interjection_episode')[0]!.correction_hold).toBeNull();
  });

  it('(7) 研究者の経路で補助が偽の否 → 保留は続き、その後の押下で in_window', () => {
    const sim = Sim.create('respond_on_spot');
    interruptF0(sim);
    sim.run(2000);
    sim.suggestions = [fresh('done', false)];
    sim.run(1000);
    expect(sim.state.sub.kind).toBe('correction_window');
    expect(sim.of('request_resume')).toHaveLength(0);
    sim.woz.push({ woz_id: 'w1', action: 'correction', point_id: null, operator: 'r', received_at: sim.now });
    sim.run(100);
    expect(sim.of('apply_correction')[0]).toMatchObject({ timing: 'in_window', point_id: 'f1' });
    finish(sim);
    expect(sim.played.filter((p) => p.kind === 'resume')).toHaveLength(0);
  });

  it('(8) 研究者の経路で補助が failed → 保留は続き、押下がなければ時間切れ', () => {
    const sim = Sim.create('respond_on_spot');
    interruptF0(sim);
    sim.run(1000);
    sim.suggestions = [fresh('failed', null)];
    sim.run(1000);
    expect(sim.state.sub.kind).toBe('correction_window');
    sim.runUntil((s) => s.of('abandon_resume').length > 0, 10_000);
    expect(sim.of('abandon_resume')[0]!.reason).toBe('correction_hold_timeout');
  });

  it('(9) auto の判定が failed → 時間切れと同じ（correction_judgment_failed、ended_by: timeout）', () => {
    const sim = Sim.create('respond_on_spot', { correction_mode: 'auto' });
    interruptF0(sim);
    sim.run(1000);
    sim.suggestions = [fresh('failed', null)];
    sim.run(100);
    expect(sim.of('abandon_resume')).toHaveLength(1);
    expect(sim.of('abandon_resume')[0]!.reason).toBe('correction_judgment_failed');
    finish(sim);
    const ep = sim.emitted('two_ai.interjection_episode')[0]!;
    expect(ep.correction_hold?.ended_by).toBe('timeout');
    expect(ep.correction_hold?.judgment_after_ms.value).not.toBeNull();
  });

  it('(10) 研究者の WoZ resume は「訂正でない」：保留を woz_resume で終え、F.0 は言い直さず F.1 から話す（第 5 回 M1）', () => {
    const sim = Sim.create('respond_on_spot');
    interruptF0(sim);
    sim.run(3000);
    sim.woz.push({ woz_id: 'w1', action: 'resume', point_id: null, operator: 'r', received_at: sim.now });
    sim.run(100);
    finish(sim);
    expect(sim.of('request_resume')).toHaveLength(0);
    expect(sim.of('abandon_resume')).toHaveLength(0);
    const k = keys(sim);
    expect(k.filter((x) => x === 'F.0')).toHaveLength(1);
    expect(k).toContain('F.1');
    expect(sim.emitted('two_ai.interjection_episode')[0]!.correction_hold?.ended_by).toBe('woz_resume');
  });

  it('(11) 2 回目の訂正は出ない（切り替え済み）', () => {
    const sim = Sim.create('respond_on_spot');
    interruptF0(sim);
    sim.woz.push({ woz_id: 'w1', action: 'correction', point_id: 'f1', operator: 'r', received_at: sim.now });
    sim.run(100);
    sim.woz.push({ woz_id: 'w2', action: 'correction', point_id: 'f1', operator: 'r', received_at: sim.now });
    sim.run(100);
    expect(sim.of('apply_correction')).toHaveLength(1);
  });

  it('(12) 保留の間に本人が話し続けると保留の時計が止まり、上限は hold_cap（第 5 回 m2）', () => {
    const sim = Sim.create('respond_on_spot');
    interruptF0(sim);
    const sub0 = sim.state.sub as { hold_until: number; hold_cap: number };
    sim.user = { speaking: true, voiced_ms: 0 };
    sim.run(3000);
    const sub1 = sim.state.sub as { hold_until: number; hold_cap: number };
    expect(sub1.hold_until).toBeGreaterThanOrEqual(sub0.hold_until + 2900);
    // 話し続けても hold_cap で時間切れ。
    sim.runUntil((s) => s.of('abandon_resume').length > 0, 20_000);
    expect(sim.now).toBeLessThanOrEqual(sub0.hold_cap + 40);
    expect(sim.now).toBeGreaterThanOrEqual(sub0.hold_cap - 40);
  });

  it('窓の外（F の後）の訂正は next_boundary', () => {
    const sim = Sim.create('respond_on_spot');
    sim.toDiscussion();
    sim.runUntil((s) => s.playingKey() === 'd4');
    sim.woz.push({ woz_id: 'w1', action: 'correction', point_id: 'f1', operator: 'r', received_at: sim.now });
    sim.run(100);
    expect(sim.of('apply_correction')[0]).toMatchObject({ timing: 'next_boundary', interrupted_turn_id: null });
    expect(sim.of('stop_turn')).toHaveLength(0);
  });

  it('応答の段の訂正は record_correction_only で何も話さない', () => {
    const sim = Sim.create('respond_on_spot');
    sim.runUntil((s) => s.state.phase === 'response', 900_000);
    sim.runUntil((s) => s.state.sub.kind === 'user_turn');
    const before = sim.played.length;
    sim.woz.push({ woz_id: 'w1', action: 'correction', point_id: 'f1', operator: 'r', received_at: sim.now });
    sim.run(100);
    expect(sim.of('record_correction_only')).toHaveLength(1);
    expect(sim.of('apply_correction')).toHaveLength(0);
    expect(sim.played.length).toBe(before);
  });

  it('auto の設定は self_run: false では読み込みで不合格', () => {
    expect(() => testConfig((c) => { c.self_run = false; c.correction.mode = 'auto'; })).toThrow();
  });
});
