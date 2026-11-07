/**
 * 視線の向き（原著 V-D を原文で確認済み）。
 * 「うっかり譲渡」しうるポーズで逸らし、譲渡されないポーズでは逸らさない。逆にすると赤になる。
 */
import { describe, expect, it } from 'vitest';
import { Driver, T0, gaze, hri2025, ja, jaWithGaze, kinds, playing, pick } from './helpers';

const pause = (ms = 300) => ({ playback: playing(9, ms) });

describe('視線の向き（V-D）', () => {
  it('VAP が移行を予測するポーズ（p_ai が低い）で逸らす', () => {
    const d = new Driver(jaWithGaze());
    const payload = gaze(d.tick(T0, { p: [0.2, 0.8, false], ...pause() }));
    expect(payload).toMatchObject({ target: 'away', in_speech_pause: true, p_now: { value: 0.2 } });
    expect(d.state.gaze_target).toBe('away');
  });
  it('VAP が移行を予測しないポーズ（p_ai が高い）では逸らさない', () => {
    const d = new Driver(jaWithGaze());
    const payload = gaze(d.tick(T0, { p: [0.8, 0.2, false], ...pause() }));
    expect(payload).toMatchObject({ target: 'user', in_speech_pause: true });
    expect(payload?.reason).toContain('pause_no_handover_predicted');
    expect(d.state.gaze_target).toBe('user');
  });
  it('閾値ちょうどは移行を予測しない', () => {
    const d = new Driver(jaWithGaze());
    d.tick(T0, { p: [0.5, 0.5, false], ...pause() });
    expect(d.state.gaze_target).toBe('user');
  });
  it('signal=p_future なら p_future で判定する', () => {
    const away = new Driver(jaWithGaze('p_future'));
    away.tick(T0, { p: [0.8, 0.2, false], ...pause() });
    expect(away.state.gaze_target).toBe('away');
    const user = new Driver(jaWithGaze('p_future'));
    user.tick(T0, { p: [0.2, 0.8, false], ...pause() });
    expect(user.state.gaze_target).toBe('user');
  });
});

describe('視線の条件', () => {
  it.each([
    ['AI が話していない', { playback: { state: 'idle' as const } }, [0.1, 0.1, false]],
    ['発話中（ポーズでない）', { playback: playing(9, 0) }, [0.1, 0.1, false]],
    ['ポーズが最短より短い', { playback: playing(9, 199) }, [0.1, 0.1, false]],
    ['利用者が話している', { playback: playing(9, 300) }, [0.45, 0.45, true]],
  ] as const)('%s では逸らさない', (_title, input, p) => {
    const d = new Driver(jaWithGaze());
    d.tick(T0, { ...input, p: [...p] });
    expect(d.state.gaze_target).toBe('user');
  });

  it('最短ちょうどで判定する', () => {
    const d = new Driver(jaWithGaze());
    d.tick(T0, { p: [0.1, 0.1, false], playback: playing(9, 200) });
    expect(d.state.gaze_target).toBe('away');
  });

  it('同じポーズの中で p が戻っても向きを保ち、ポーズの終わりで戻す', () => {
    const d = new Driver(jaWithGaze());
    d.tick(T0, { p: [0.2, 0.2, false], ...pause(300) });
    expect(kinds(d.tick(T0 + 20, { p: [0.9, 0.9, false], ...pause(320) }))).not.toContain('gaze');
    expect(d.state.gaze_target).toBe('away');
    const payload = gaze(d.tick(T0 + 40, { p: [0.9, 0.9, false], ...pause(0) }));
    expect(payload).toMatchObject({ target: 'user', reason: 'not_in_speech_pause' });
  });

  it('判定はポーズごとに1回と、向きの変化のときだけログへ出す', () => {
    const d = new Driver(jaWithGaze());
    expect(pick(d.tick(T0, { p: [0.8, 0.8, false], ...pause(300) }), 'gaze').length).toBe(1);
    expect(pick(d.tick(T0 + 20, { p: [0.8, 0.8, false], ...pause(320) }), 'gaze').length).toBe(0);
    expect(pick(d.tick(T0 + 40, { p: [0.2, 0.2, false], ...pause(340) }), 'gaze').length).toBe(1);
  });

  it('割り込みを出したら既定の注視に戻す', () => {
    const d = new Driver(jaWithGaze());
    d.tick(T0, { p: [0.2, 0.2, false], ...pause() });
    expect(d.state.gaze_target).toBe('away');
    d.tick(T0 + 20, { p: [0.1, 0.1, true], ...pause(320) });
    expect(d.state.gaze_target).toBe('user');
    // 利用者が黙っても、停止の途中では逸らし直さない
    d.tick(T0 + 40, { p: [0.1, 0.1, false], ...pause(340) });
    expect(d.state.speaking.phase).toBe('stopping');
    expect(d.state.gaze_target).toBe('user');
  });

  it('発話開始前には逸らさない（Fig. 1 の読み取りのみが根拠なので入れない）', () => {
    const d = new Driver(jaWithGaze());
    d.tick(T0, { p: [0.9, 0.9, false] });
    d.tick(T0 + 400, { p: [0.9, 0.9, false] });
    expect(d.state.gaze_target).toBe('user');
  });
});

describe('設定が未校正', () => {
  it('ja の config は null のままで、逸らさず、gaze の決定も出さない', () => {
    expect(ja().gaze).toEqual({ pause_min_ms: null, signal: null, p_threshold: null });
    const d = new Driver(ja());
    expect(kinds(d.tick(T0, { p: [0.1, 0.1, false], ...pause(5000) }))).not.toContain('gaze');
    expect(d.state.gaze_target).toBe('user');
  });
  it('hri2025 は原著に数値がないので逸らさない', () => {
    const d = new Driver(hri2025());
    d.tick(T0, { p: [0.1, 0.1, false], ...pause(5000) });
    expect(d.state.gaze_target).toBe('user');
  });
});
