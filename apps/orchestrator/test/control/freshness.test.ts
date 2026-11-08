/** 鮮度切れ（計画 §4.1 の表）。fallback_energy は VAP として扱わない。 */
import { describe, expect, it } from 'vitest';
import { absent, present } from '@llm-vap/contracts';
import { assessVapFreshness } from '../../src/control';
import type { TickInput } from './helpers';
import { Driver, T0, gaze, ja, jaAppendixA, jaWithGaze, kinds, pick, playing, ready, turnAllowed, vapAt } from './helpers';

const limits = { vap_stale_ms: 500, vap_rewarm_ms: 10000 };
const base = {
  vap: present(vapAt(0.9, 0.9, false, 16000)),
  vap_received_at: present(T0),
  received_audio_frame: 16000,
  vap_worker_started_at: present(0),
};

describe('assessVapFreshness', () => {
  it.each([
    ['fresh', base, T0, 'fresh'],
    ['ワーカー未起動は down', { ...base, vap_worker_started_at: absent('not_started') }, T0, 'down'],
    ['値が未着は down', { ...base, vap: absent('none'), vap_received_at: absent('none') }, T0, 'down'],
    ['助走の途中は値があっても warming_up', { ...base, vap_worker_started_at: present(T0 - 9999) }, T0, 'warming_up'],
    ['助走ちょうどで fresh', { ...base, vap_worker_started_at: present(T0 - 10000) }, T0, 'fresh'],
    ['audio_frame が 500ms ちょうど遅れは fresh', { ...base, received_audio_frame: 16000 + 8000 }, T0, 'fresh'],
    ['audio_frame が 500ms 超の遅れは stale', { ...base, received_audio_frame: 16000 + 8001 }, T0, 'stale'],
    ['受信が 500ms ちょうど遅れは fresh', base, T0 + 500, 'fresh'],
    ['音声ごと止まって受信が 500ms 超の遅れは stale', base, T0 + 501, 'stale'],
  ] as const)('%s', (_title, inputs, now, expected) => {
    expect(assessVapFreshness(inputs, now, limits).freshness).toBe(expected);
  });
});

const stale = (now: number, extra: Partial<TickInput> = {}): TickInput => ({
  p: [0.9, 0.9, false],
  vap_received_at: present(now - 1000),
  fallback_energy: present(0.001),
  ...extra,
});

describe('degraded: AI 待機中', () => {
  it('set_degraded は切替のときだけ出す', () => {
    const d = new Driver(jaAppendixA());
    expect(pick(d.tick(T0, stale(T0)), 'set_degraded')[0]).toMatchObject({ degraded: true });
    expect(kinds(d.tick(T0 + 20, stale(T0 + 20)))).not.toContain('set_degraded');
    expect(pick(d.tick(T0 + 40), 'set_degraded')[0]).toMatchObject({ degraded: false });
  });
  it('degraded のまま理由の種類が変わったら（down → 助走 → down）set_degraded を出し直す', () => {
    const d = new Driver(jaAppendixA());
    const down = { vap_worker_started_at: absent('worker_not_ready') } as const;
    expect(pick(d.tick(T0, down), 'set_degraded')[0]?.reason).toContain('worker_not_started');
    const warming = pick(d.tick(T0 + 20, { vap_worker_started_at: present(T0) }), 'set_degraded')[0];
    expect(warming).toMatchObject({ degraded: true });
    expect(warming?.reason).toContain('rewarm');
    // 助走の残り時間が変わるだけでは出さない。
    expect(kinds(d.tick(T0 + 40, { vap_worker_started_at: present(T0) }))).not.toContain('set_degraded');
    const again = pick(d.tick(T0 + 60, down), 'set_degraded')[0];
    expect(again?.reason).toContain('worker_not_started');
  });
  it('VAP の値が譲渡を示していても使わない。L74 も使わない', () => {
    const d = new Driver(jaAppendixA());
    const decisions = d.tick(T0, stale(T0, { prefetch: ready() }));
    d.tick(T0 + 10000, stale(T0 + 10000, { prefetch: ready() }));
    expect(d.state.permitted_to_speak).toBe(false);
    const payload = turnAllowed(decisions);
    expect(payload).toMatchObject({
      turn_allowed: false,
      decision_source: 'fallback',
      vap_freshness: 'stale',
      p_now: { value: null },
      p_future: { value: null },
      fallback_energy: { value: 0.001 },
    });
  });
  it('未校正（無音の上限 null）では無音で開始しない', () => {
    const d = new Driver(jaAppendixA((p) => { p.turn.fallback_silence_max_ms = null; }), { fallback_energy_silence_threshold: 0.01 });
    d.tick(T0, stale(T0));
    expect(kinds(d.tick(T0 + 60000, stale(T0 + 60000, { prefetch: ready() })))).not.toContain('start_speech');
  });
  it('エネルギーの閾値がなければ、無音の上限があっても開始しない', () => {
    const d = new Driver(jaAppendixA((p) => { p.turn.fallback_silence_max_ms = 2000; }));
    d.tick(T0, stale(T0));
    expect(kinds(d.tick(T0 + 60000, stale(T0 + 60000, { prefetch: ready() })))).not.toContain('start_speech');
  });
  it('無音の上限と閾値があれば fallback として開始し、VAP とは区別して残す', () => {
    const d = new Driver(jaAppendixA((p) => { p.turn.fallback_silence_max_ms = 2000; }), { fallback_energy_silence_threshold: 0.01 });
    d.tick(T0, stale(T0));
    expect(kinds(d.tick(T0 + 1999, stale(T0 + 1999, { prefetch: ready() })))).not.toContain('start_speech');
    const decisions = d.tick(T0 + 2000, stale(T0 + 2000, { prefetch: ready() }));
    expect(kinds(decisions)).toContain('start_speech');
    expect(turnAllowed(decisions)).toMatchObject({ decision_source: 'fallback', reason: 'fallback_silence_max', p_now: { value: null } });
  });
  it('エネルギーがあれば無音の起点を更新する', () => {
    const d = new Driver(jaAppendixA((p) => { p.turn.fallback_silence_max_ms = 2000; }), { fallback_energy_silence_threshold: 0.01 });
    d.tick(T0, stale(T0));
    d.tick(T0 + 1000, stale(T0 + 1000, { fallback_energy: present(0.5) }));
    d.tick(T0 + 2000, stale(T0 + 2000));
    expect(d.state.permitted_to_speak).toBe(false);
    d.tick(T0 + 3000, stale(T0 + 3000));
    expect(d.state.permitted_to_speak).toBe(true);
  });
  it('明示の招待は ASR の更新が MIN_GAP 止まれば許可する', () => {
    const d = new Driver(jaAppendixA());
    d.tick(T0, stale(T0, { text: 'お先にどうぞ' }));
    d.tick(T0 + 499, stale(T0 + 499));
    expect(d.state.permitted_to_speak).toBe(false);
    const decisions = d.tick(T0 + 500, stale(T0 + 500, { prefetch: ready() }));
    expect(kinds(decisions)).toContain('start_speech');
    expect(turnAllowed(decisions)).toMatchObject({ decision_source: 'invitation', vap_freshness: 'stale' });
  });
  it('準備の判断は VAP に依存せず続く', () => {
    const d = new Driver(jaAppendixA());
    d.tick(T0, stale(T0, { text: '明日' }));
    expect(kinds(d.tick(T0 + 200, stale(T0 + 200)))).toContain('prepare');
  });
});

describe('degraded: AI 発話中', () => {
  const interruptPolicy = () => jaAppendixA((p) => { p.turn.fallback_interrupt_min_words = 3; });
  const options = { fallback_energy_silence_threshold: 0.01 };
  const voiced = (now: number, extra: Partial<TickInput> = {}) =>
    stale(now, { fallback_energy: present(0.5), playback: playing(9), ...extra });

  it('L59 を VAP の値で判定しない', () => {
    const d = new Driver(jaAppendixA());
    expect(kinds(d.tick(T0, { p: [0.1, 0.1, true], vap_received_at: present(T0 - 1000), playback: playing(9) }))).not.toContain('interrupt_speech');
  });
  it('エネルギーと語数の下限を満たすと fallback の割り込み', () => {
    const d = new Driver(interruptPolicy(), options);
    const [stop] = pick(d.tick(T0, voiced(T0, { text: '明日の会議は三時です' })), 'interrupt_speech');
    expect(stop).toMatchObject({ decision_source: 'fallback', audio_playback_id: 9 });
    expect(stop?.reason).toContain('fallback_energy_with_new_interim');
  });
  it('語数が下限より少ない（相槌）なら止めない', () => {
    const d = new Driver(interruptPolicy(), options);
    expect(kinds(d.tick(T0, voiced(T0, { text: 'うん' })))).not.toContain('interrupt_speech');
  });
  it('エネルギーがなければ語数があっても止めない', () => {
    const d = new Driver(interruptPolicy(), options);
    expect(kinds(d.tick(T0, voiced(T0, { text: '明日の会議は三時です', fallback_energy: present(0.001) })))).not.toContain('interrupt_speech');
  });
  it('未校正（語数の下限 null）では止めない', () => {
    const d = new Driver(jaAppendixA((p) => { p.turn.fallback_interrupt_min_words = null; }), options);
    expect(kinds(d.tick(T0, voiced(T0, { text: '明日の会議は三時です' })))).not.toContain('interrupt_speech');
  });
});

describe('degraded: 視線と復帰', () => {
  it('視線は既定の注視へ戻す', () => {
    const d = new Driver(jaWithGaze());
    d.tick(T0, { p: [0.1, 0.1, false], playback: playing(9, 300) });
    expect(d.state.gaze_target).toBe('away');
    const payload = gaze(d.tick(T0 + 20, { p: [0.1, 0.1, false], vap_received_at: present(T0 - 1000), playback: playing(9, 320) }));
    expect(payload).toMatchObject({ target: 'user', vap_freshness: 'stale', p_now: { value: null } });
    expect(payload?.reason).toContain('vap_stale');
  });
  it('復帰時は計時をやり直し、復帰した最初の tick では許可しない', () => {
    const d = new Driver(jaAppendixA());
    d.tick(T0, stale(T0));
    d.tick(T0 + 10000, { p: [0.9, 0.9, false] });
    expect(d.state.permitted_to_speak).toBe(false);
    d.tick(T0 + 10499, { p: [0.9, 0.9, false] });
    expect(d.state.permitted_to_speak).toBe(false);
    d.tick(T0 + 10500, { p: [0.9, 0.9, false] });
    expect(d.state.permitted_to_speak).toBe(true);
  });
  it('助走の間は値を制御に使わず、過ぎたら使う', () => {
    const d = new Driver(jaAppendixA());
    const started = T0 - 9000;
    d.tick(T0, { p: [0.9, 0.9, false], vap_worker_started_at: present(started) });
    expect(d.state.vap_freshness).toBe('warming_up');
    d.tick(T0 + 999, { p: [0.9, 0.9, false], vap_worker_started_at: present(started) });
    expect(d.state.permitted_to_speak).toBe(false);
    d.tick(T0 + 1000, { p: [0.9, 0.9, false], vap_worker_started_at: present(started) });
    expect(d.state.vap_freshness).toBe('fresh');
  });
});
