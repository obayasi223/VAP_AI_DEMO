/**
 * 調整画面の指標（dev/metrics.ts）の定義。値は手で作った合成のもの。
 */
import { describe, expect, it } from 'vitest';
import { computeMetrics, midUtterance, type MetricInputs } from '../../src/dev/metrics';

/** 1ms = 16 frame（16kHz）。 */
const frameAt = (t: number) => t * 16;
const start = (t: number) => ({ t, audio_playback_id: 1, decision_source: 'vap', reason: 'L67_vap_yield', gap_ms: null, p_now: null, completion_p: null });

function base(overrides: Partial<MetricInputs> = {}): MetricInputs {
  return {
    starts: [],
    ai_speech: [],
    gaze: [],
    interrupts: 0,
    vap: [],
    stt: [],
    frameAt,
    speaking_threshold: 0.5,
    t_end: 20_000,
    ...overrides,
  };
}

describe('発話の途中での開始', () => {
  it('開始の後 1.5 秒以内に、開始より後の音声で文が伸びたら数える', () => {
    const stt = [
      { t: 900, key: 0, audio_frame_end: frameAt(900), text: 'きょうは' },
      { t: 1400, key: 0, audio_frame_end: frameAt(1300), text: 'きょうはいい天気' },
    ];
    expect(midUtterance({ stt, frameAt }, 1000)).toBe(true);
  });

  it('開始より前の音声の確定（final が遅れて届いた）は数えない', () => {
    const stt = [
      { t: 900, key: 0, audio_frame_end: frameAt(800), text: 'きょうは' },
      { t: 1300, key: 0, audio_frame_end: frameAt(950), text: 'きょうはね' },
    ];
    expect(midUtterance({ stt, frameAt }, 1000)).toBe(false);
  });

  it('1.5 秒より後の続きは数えない', () => {
    const stt = [
      { t: 900, key: 0, audio_frame_end: frameAt(900), text: 'きょうは' },
      { t: 2600, key: 0, audio_frame_end: frameAt(2500), text: 'きょうはいい天気' },
    ];
    expect(midUtterance({ stt, frameAt }, 1000)).toBe(false);
  });
});

describe('遅れ、連続発話、視線', () => {
  it('遅れは最後の声から開始まで、連続発話は前の AI の発話の後に声がない開始', () => {
    const vap = [
      { t: 100, vad_user: 0.9 },
      { t: 400, vad_user: 0.9 },
      { t: 480, vad_user: 0.1 },
      { t: 3000, vad_user: 0.1 },
    ];
    const m = computeMetrics(
      base({
        vap,
        starts: [start(1000), start(5000)],
        ai_speech: [
          { start: 1010, end: 3500, label: '#1' },
          { start: 5010, end: 6000, label: '#2' },
        ],
      }),
    );
    expect(m.starts).toBe(2);
    expect(m.delays_ms).toEqual([600, 4600]);
    expect(m.consecutive_ai_starts).toBe(1);
  });

  it('視線は away に変わった回数と、戻るまでの長さ（戻らないものは長さに入れない）', () => {
    const m = computeMetrics(
      base({
        gaze: [
          { t: 1000, target: 'away', reason: 'x' },
          { t: 1600, target: 'user', reason: 'x' },
          { t: 3000, target: 'away', reason: 'x' },
          { t: 3000, target: 'away', reason: 'x' },
        ],
      }),
    );
    expect(m.gaze_averts).toBe(2);
    expect(m.gaze_avert_ms).toEqual([600]);
  });
});
