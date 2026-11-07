/**
 * 視線の向き（原著 V-D を原文で確認済み）。
 * 「うっかり譲渡」しうるポーズで逸らし、譲渡されないポーズでは逸らさない。逆にすると赤になる。
 */
import { describe, expect, it } from 'vitest';
import { Driver, T0, gaze, hri2025, ja, jaWithGaze, jaWithGazeHold, kinds, playing, pick } from './helpers';
import { controlSettings } from '../../src/control';

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
  it('ja で gaze が null なら、逸らさず、gaze の決定も出さない', () => {
    const d = new Driver(ja((p) => { p.gaze = { pause_min_ms: null, signal: null, p_threshold: null }; }));
    expect(kinds(d.tick(T0, { p: [0.1, 0.1, false], ...pause(5000) }))).not.toContain('gaze');
    expect(d.state.gaze_target).toBe('user');
  });
  it('hri2025 は原著に数値がないので逸らさない', () => {
    const d = new Driver(hri2025());
    d.tick(T0, { p: [0.1, 0.1, false], ...pause(5000) });
    expect(d.state.gaze_target).toBe('user');
  });
});

describe('保持時間（原著にない、ちらつきの防止）', () => {
  /** E2E で見た形: 200ms のポーズで逸らし、AI が 100ms 後に話し続ける。 */
  const avertThenResume = (d: Driver) => {
    d.tick(T0, { p: [0.2, 0.2, false], ...pause(200) });
    expect(d.state.gaze_target).toBe('away');
    return d.tick(T0 + 100, { p: [0.9, 0.9, false], ...pause(0) });
  };

  it('保持なし（従来）では、ポーズが終わると 100ms でも user へ戻る', () => {
    const d = new Driver(jaWithGaze());
    expect(gaze(avertThenResume(d))).toMatchObject({ target: 'user' });
  });

  it('逸らした後 hold_away_min_ms までは、AI が話し続けても user へ戻さない', () => {
    const d = new Driver(jaWithGazeHold(600, 1000));
    expect(kinds(avertThenResume(d))).not.toContain('gaze');
    expect(d.state.gaze_target).toBe('away');
    expect(kinds(d.tick(T0 + 599, { p: [0.9, 0.9, false], ...pause(0) }))).not.toContain('gaze');
    expect(d.state.gaze_target).toBe('away');
    expect(gaze(d.tick(T0 + 600, { p: [0.9, 0.9, false], ...pause(0) }))).toMatchObject({ target: 'user', reason: 'not_in_speech_pause' });
  });

  it('user へ戻した後 re_avert_min_ms までは、次のポーズで移行が予測されても逸らさない', () => {
    const d = new Driver(jaWithGazeHold(600, 1000));
    d.tick(T0, { p: [0.2, 0.2, false], ...pause(200) });
    d.tick(T0 + 600, { p: [0.9, 0.9, false], ...pause(0) });
    expect(d.state.gaze_target).toBe('user');
    const held = gaze(d.tick(T0 + 900, { p: [0.2, 0.2, false], ...pause(250) }));
    // ポーズの最初の判定は残す（向きは user のまま）。
    expect(held).toMatchObject({ target: 'user' });
    expect(held?.reason).toMatch(/^re_avert_min_ms<1000:pause_predicted_handover/);
    d.tick(T0 + 1599, { p: [0.2, 0.2, false], ...pause(949) });
    expect(d.state.gaze_target).toBe('user');
    expect(gaze(d.tick(T0 + 1600, { p: [0.2, 0.2, false], ...pause(950) }))).toMatchObject({ target: 'away' });
  });

  it('保持中に次のポーズが始まったら、そのポーズの予測で判定し直す（移行が予測されなければ user へ戻す）', () => {
    const d = new Driver(jaWithGazeHold(600, 1000));
    avertThenResume(d);
    expect(d.state.gaze_target).toBe('away');
    // 次のポーズ。最短に満たない間は保持のまま。
    d.tick(T0 + 200, { p: [0.9, 0.9, false], ...pause(100) });
    expect(d.state.gaze_target).toBe('away');
    const payload = gaze(d.tick(T0 + 300, { p: [0.9, 0.9, false], ...pause(200) }));
    expect(payload).toMatchObject({ target: 'user' });
    expect(payload?.reason).toMatch(/^pause_no_handover_predicted/);
  });

  it('保持中の次のポーズでも移行が予測されれば逸らしたまま', () => {
    const d = new Driver(jaWithGazeHold(600, 1000));
    avertThenResume(d);
    d.tick(T0 + 200, { p: [0.2, 0.2, false], ...pause(100) });
    const payload = gaze(d.tick(T0 + 300, { p: [0.2, 0.2, false], ...pause(200) }));
    // 向きは変わらないが、ポーズの最初の判定として新しい予測が残る。
    expect(payload).toMatchObject({ target: 'away' });
    expect(payload?.reason).toMatch(/^pause_predicted_handover/);
    expect(d.state.gaze_target).toBe('away');
    // そのポーズの中では向きを保つ。
    expect(kinds(d.tick(T0 + 320, { p: [0.9, 0.9, false], ...pause(220) }))).not.toContain('gaze');
    expect(d.state.gaze_target).toBe('away');
  });

  it('人が話し始めたら保持時間を待たずに user へ戻す', () => {
    const d = new Driver(jaWithGazeHold(600, 1000));
    d.tick(T0, { p: [0.2, 0.2, false], ...pause(200) });
    expect(gaze(d.tick(T0 + 100, { p: [0.9, 0.9, true], ...pause(300) }))).toMatchObject({ target: 'user', reason: 'user_speaking_in_pause' });
  });

  it('AI の発話中（ポーズでない）でも、人が話し始めたら保持時間を待たずに戻し、理由に残す', () => {
    const d = new Driver(jaWithGazeHold(600, 1000));
    d.tick(T0, { p: [0.2, 0.2, false], ...pause(200) });
    expect(gaze(d.tick(T0 + 100, { p: [0.9, 0.9, true], ...pause(0) }))).toMatchObject({ target: 'user', reason: 'user_speaking:not_in_speech_pause' });
  });

  it('AI の発話の終わりでは保持時間を待たずに user へ戻す', () => {
    const d = new Driver(jaWithGazeHold(600, 1000));
    d.tick(T0, { p: [0.2, 0.2, false], ...pause(200) });
    expect(gaze(d.tick(T0 + 100, { p: [0.2, 0.2, false], playback: { state: 'idle' } }))).toMatchObject({ target: 'user', reason: 'ai_not_speaking' });
  });

  it('割り込みでは保持時間を待たずに user へ戻す', () => {
    const d = new Driver(jaWithGazeHold(600, 1000));
    d.tick(T0, { p: [0.2, 0.2, false], ...pause(200) });
    d.tick(T0 + 20, { p: [0.1, 0.1, true], ...pause(220) });
    expect(d.state.speaking.phase).toBe('stopping');
    expect(d.state.gaze_target).toBe('user');
  });

  it('VAP の鮮度切れでは保持時間を待たずに既定の注視へ戻す', () => {
    const d = new Driver(jaWithGazeHold(600, 1000));
    d.tick(T0, { p: [0.2, 0.2, false], ...pause(200) });
    // VAP の受信が 500ms 以上止まる（stale）。
    d.tick(T0 + 100, { p: [0.2, 0.2, false], ...pause(300), vap_received_at: { value: T0 - 1000 } });
    expect(d.state.vap_freshness).not.toBe('fresh');
    expect(d.state.gaze_target).toBe('user');
  });

  it('ja の方策に暫定値が入り、hri2025 は保持なし（原著どおり）', () => {
    expect(controlSettings(ja()).gaze).toMatchObject({ hold_away_min_ms: 600, re_avert_min_ms: 1000 });
    expect(controlSettings(hri2025()).gaze).toMatchObject({ hold_away_min_ms: null, re_avert_min_ms: null });
  });
});
