/** 再生を始められない間（TurnInputs.start_blocked_reason）は、許可が出ても segment を進めない（応答を失わない）。 */
import { describe, expect, it } from 'vitest';
import { Driver, T0, hri2025, ja, kinds, ready } from './helpers';

describe.each([
  ['ja', ja],
  ['hri2025', hri2025],
] as const)('start_blocked_reason（%s）', (_name, policy) => {
  it('拒否される間は start_speech も advance_segment も出さず、入力文を保つ。解けたら始める', () => {
    const d = new Driver(policy());
    d.tick(T0, { text: 'こんにちは', p: [0.9, 0.9, false] });
    // 準備を起動させる（ASR_PREPARE_TIMEOUT）。
    expect(kinds(d.tick(T0 + 300, { p: [0.9, 0.9, false] }))).toContain('prepare');
    const blocked = d.tick(T0 + 600, { p: [0.9, 0.9, false], prefetch: ready(7, 0), start_blocked_reason: 'browser_detached' });
    expect(kinds(blocked)).not.toContain('start_speech');
    expect(kinds(blocked)).not.toContain('advance_segment');
    expect(d.state.segment_id).toBe(0);
    expect(d.state.permitted_to_speak).toBe(true);
    expect(d.state.want_to_speak).toMatchObject({ kind: 'response', audio_playback_id: 7 });
    expect(d.state.asr_result).toBe('こんにちは');
    const go = d.tick(T0 + 620, { p: [0.9, 0.9, false], prefetch: ready(7, 0), start_blocked_reason: null });
    expect(kinds(go)).toEqual(expect.arrayContaining(['start_speech', 'advance_segment']));
    expect(d.state.segment_id).toBe(1);
  });
});
