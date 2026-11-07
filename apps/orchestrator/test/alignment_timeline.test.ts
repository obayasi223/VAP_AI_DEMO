import { describe, expect, it } from 'vitest';
import { absent, present } from '@llm-vap/contracts';
import { AlignmentTimeline, proportionalText } from '../src/speech/alignment_timeline';

const RATE = 16000;

/** 1文字 100ms、チャンク内の相対時刻（実物の形）。 */
function chunk(text: string, msPerChar = 100) {
  const chars = [...text];
  return {
    sample_rate_hz: RATE,
    samples: (chars.length * msPerChar * RATE) / 1000,
    alignment: present({
      chars,
      char_start_ms: chars.map((_, i) => i * msPerChar),
      char_duration_ms: chars.map(() => msPerChar),
    }),
  };
}

describe('AlignmentTimeline', () => {
  it('チャンク相対の時刻を PCM の長さで累積する', () => {
    const timeline = new AlignmentTimeline();
    timeline.addChunk(chunk('今日は'));
    timeline.addChunk(chunk('天気'));
    expect(timeline.duration_ms).toBeCloseTo(500);
    timeline.confirm(true);
    // 「天気」の終わりは 300 + 200。
    expect(timeline.nextBoundaryMs(450)).toBeCloseTo(500);
  });

  it('語境界は Intl.Segmenter。語の途中なら直前の語境界まで', () => {
    const timeline = new AlignmentTimeline();
    timeline.addChunk(chunk('今日は天気がいいです。'));
    timeline.confirm(true);
    expect(timeline.textUntil(0)).toBe('');
    // 「今日」(200ms) の途中
    expect(timeline.textUntil(150)).toBe('');
    expect(timeline.textUntil(200)).toBe('今日');
    expect(timeline.textUntil(250)).toBe('今日');
    expect(timeline.textUntil(10_000)).toBe('今日は天気がいいです。');
    expect(timeline.fullText()).toBe('今日は天気がいいです。');
  });

  it('語の途中で切らない。どの時刻でも語の並びの接頭になる', () => {
    const timeline = new AlignmentTimeline();
    const text = '東京都に住んでいます。';
    timeline.addChunk(chunk(text));
    const words = timeline.confirm(true).map((w) => w.text);
    expect(words.join('')).toBe(text);
    const prefixes = words.reduce<string[]>((acc, w) => [...acc, (acc.at(-1) ?? '') + w], ['']);
    for (let ms = 0; ms <= 1200; ms += 50) {
      expect(prefixes).toContain(timeline.textUntil(ms));
    }
  });

  it('末尾の語は合成の完了まで確定しない。確定済みの語は変わらない', () => {
    const timeline = new AlignmentTimeline();
    timeline.addChunk(chunk('今日は天'));
    const first = timeline.confirm(false);
    expect(first.map((w) => w.text).join('')).toBe('今日は');
    expect(timeline.nextBoundaryMs(350)).toBeNull();
    timeline.addChunk(chunk('気です'));
    const second = timeline.confirm(true);
    expect(second.map((w) => w.text).join('')).toBe('天気です');
    expect(second[0]?.start_ms).toBeCloseTo(300);
  });

  it('1要素が複数の符号単位でも語境界を要素へ寄せる', () => {
    const timeline = new AlignmentTimeline();
    timeline.addChunk({
      sample_rate_hz: RATE,
      samples: 3200,
      alignment: present({ chars: ['😀', '今日'], char_start_ms: [0, 100], char_duration_ms: [100, 100] }),
    });
    expect(timeline.confirm(true).map((w) => w.text).join('')).toBe('😀今日');
  });

  it('alignment の欠けは完全でないと示す', () => {
    const missing = new AlignmentTimeline();
    missing.addChunk(chunk('今日は'));
    missing.addChunk({ sample_rate_hz: RATE, samples: 1600, alignment: absent('no_alignment') });
    expect(missing.alignment_complete).toBe(false);

    const uneven = new AlignmentTimeline();
    uneven.addChunk({
      sample_rate_hz: RATE,
      samples: 1600,
      alignment: present({ chars: ['あ', 'い'], char_start_ms: [0], char_duration_ms: [100, 100] }),
    });
    expect(uneven.alignment_complete).toBe(false);

    // 音声のない最後の chunk は欠けに数えない。
    const tail = new AlignmentTimeline();
    tail.addChunk(chunk('はい'));
    tail.addChunk({ sample_rate_hz: RATE, samples: 0, alignment: absent('final_message') });
    expect(tail.alignment_complete).toBe(true);
  });

  it('時間比例の代替', () => {
    expect(proportionalText('あいうえ', 500, 1000)).toBe('あい');
    expect(proportionalText('あいうえ', 5000, 1000)).toBe('あいうえ');
    expect(proportionalText('あいうえ', 500, 0)).toBe('');
  });
});
