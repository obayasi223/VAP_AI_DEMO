import { describe, expect, it } from 'vitest';
import {
  AlignmentMouthSource,
  kanaToMorae,
  labialClosure,
  VOWEL_SHAPES,
  wordToSegments,
} from '../lipsync';
import { mouthOpenAmount, VolumeMouthSource } from '../mouth';

const kinds = (text: string) => kanaToMorae(text)?.map((m) => m.kind).join('') ?? null;

describe('kanaToMorae', () => {
  it('ひらがなとカタカナの母音', () => {
    expect(kinds('こんにちは')).toBe('oNiia');
    expect(kinds('カタカナ')).toBe('aaaa');
    expect(kinds('てんき')).toBe('eNi');
  });

  it('拗音は前のモーラの母音を変え、モーラを増やさない', () => {
    expect(kinds('きょう')).toBe('ou');
    expect(kinds('しゃしん')).toBe('aiN');
    expect(kinds('ファイル')).toBe('aiu');
  });

  it('長音は前の母音を伸ばし、促音は閉じる', () => {
    expect(kinds('ラーメン')).toBe('aaeN');
    expect(kinds('きって')).toBe('iQe');
  });

  it('句読点と空白はモーラを持たない。記号だけの語は空', () => {
    expect(kinds('はい、')).toBe('ai');
    expect(kinds('。')).toBe('');
    expect(kinds('ね！')).toBe('e');
  });

  it('漢字、英数字を含む語は読めないので null', () => {
    expect(kanaToMorae('今日')).toBeNull();
    expect(kanaToMorae('天気です')).toBeNull();
    expect(kanaToMorae('AI')).toBeNull();
    expect(kanaToMorae('3つ')).toBeNull();
  });

  it('ま・ば・ぱ行は唇音', () => {
    const morae = kanaToMorae('まばぱか')!;
    expect(morae.map((m) => m.labial)).toEqual([true, true, true, false]);
  });
});

describe('wordToSegments', () => {
  it('語の長さをモーラ数で等分する', () => {
    const segments = wordToSegments({ text: 'てんき', start_ms: 100, end_ms: 400 })!;
    expect(segments.map((s) => [s.startMs, s.endMs, s.mora.kind])).toEqual([
      [100, 200, 'e'],
      [200, 300, 'N'],
      [300, 400, 'i'],
    ]);
  });

  it('読めない語は null、長さ 0 は空', () => {
    expect(wordToSegments({ text: '天気', start_ms: 0, end_ms: 300 })).toBeNull();
    expect(wordToSegments({ text: 'あ', start_ms: 10, end_ms: 10 })).toEqual([]);
  });
});

describe('labialClosure', () => {
  it('モーラの頭で閉じ、すぐ開く', () => {
    expect(labialClosure(0, 150)).toBeCloseTo(0.1, 5);
    expect(labialClosure(25, 150)).toBeGreaterThan(0.1);
    expect(labialClosure(60, 150)).toBe(1);
  });
});

/** 時計を手で進める口。 */
function rig(options: ConstructorParameters<typeof AlignmentMouthSource>[2] = {}) {
  let now = 1000;
  const volume = new VolumeMouthSource();
  const source = new AlignmentMouthSource(volume, () => now, { lookaheadMs: 0, shapeSmoothMs: 0, ...options });
  const advance = (ms: number, rms = 0.2, step = 10) => {
    let shape = source.update(0);
    for (let t = 0; t < ms; t += step) {
      now += step;
      source.setLevel(rms);
      shape = source.update(step);
    }
    return shape;
  };
  return { source, advance, setNow: (t: number) => (now = t), getNow: () => now };
}

const items = (...words: [string, number, number][]) =>
  words.map(([text, start_ms, end_ms]) => ({ text, start_ms, end_ms, granularity: 'word' as const }));

describe('AlignmentMouthSource', () => {
  it('位置の報告が無ければ音量だけ（aa）', () => {
    const { source, advance } = rig();
    source.addAlignment({ audio_playback_id: 1, generation: 0, items: items(['いい', 0, 400]) });
    const shape = advance(200);
    expect(source.mode).toBe('volume');
    expect(shape.aa).toBeGreaterThan(0.3);
    expect(shape.ih).toBe(0);
  });

  it('かなの語は再生位置の母音の形になる', () => {
    const { source, advance, getNow } = rig();
    source.addAlignment({ audio_playback_id: 1, generation: 0, items: items(['いい', 0, 400], ['おお', 400, 800]) });
    source.onPlaybackReport({ type: 'playback.started', audio_playback_id: 1, generation: 0, client_t_ms: getNow() });
    let shape = advance(200);
    expect(source.mode).toBe('alignment');
    expect(shape.ih).toBeGreaterThan(shape.aa);
    expect(shape.oh).toBe(0);
    // 位置の報告で進める（samples_written は 16kHz）。
    source.onPlaybackReport({
      type: 'playback.position',
      audio_playback_id: 1,
      generation: 0,
      samples_written: 500 * 16,
      client_t_ms: getNow(),
    });
    shape = advance(20);
    expect(shape.oh).toBeGreaterThan(0.3);
    expect(shape.ih).toBe(0);
  });

  it('漢字の語と推定の語時刻では音量だけに戻す', () => {
    const { source, advance, getNow } = rig();
    source.addAlignment({ audio_playback_id: 1, generation: 0, items: items(['天気', 0, 400]) });
    source.addAlignment({ audio_playback_id: 1, generation: 0, items: items(['いい', 400, 800]), source: 'estimated_time_proportional' });
    source.onPlaybackReport({ type: 'playback.started', audio_playback_id: 1, generation: 0, client_t_ms: getNow() });
    expect(advance(200).ih).toBe(0);
    expect(source.mode).toBe('volume');
    expect(advance(400).ih).toBe(0);
    expect(source.mode).toBe('volume');
  });

  it('音が無ければ語時刻があっても口は開かない', () => {
    const { source, advance, getNow } = rig();
    source.addAlignment({ audio_playback_id: 1, generation: 0, items: items(['ああ', 0, 1000]) });
    source.onPlaybackReport({ type: 'playback.started', audio_playback_id: 1, generation: 0, client_t_ms: getNow() });
    expect(mouthOpenAmount(advance(300, 0))).toBe(0);
  });

  it('報告が途絶えると外挿を止めて音量だけへ戻す', () => {
    const { source, advance, getNow } = rig({ maxExtrapolateMs: 300 });
    source.addAlignment({ audio_playback_id: 1, generation: 0, items: items(['いいいいいい', 0, 3000]) });
    source.onPlaybackReport({ type: 'playback.started', audio_playback_id: 1, generation: 0, client_t_ms: getNow() });
    advance(100);
    expect(source.mode).toBe('alignment');
    advance(400);
    expect(source.mode).toBe('volume');
  });

  it('古い世代の語時刻と報告は棄て、新しい世代で作り直す', () => {
    const { source, advance, getNow } = rig();
    source.addAlignment({ audio_playback_id: 1, generation: 2, items: items(['おお', 0, 1000]) });
    source.addAlignment({ audio_playback_id: 1, generation: 1, items: items(['いい', 0, 1000]) });
    source.onPlaybackReport({ type: 'playback.started', audio_playback_id: 1, generation: 2, client_t_ms: getNow() });
    const shape = advance(100);
    expect(shape.oh).toBeGreaterThan(0);
    expect(shape.ih).toBe(0);
  });

  it('再生の終わりで語時刻を消す', () => {
    const { source, advance, getNow } = rig();
    source.addAlignment({ audio_playback_id: 1, generation: 0, items: items(['いい', 0, 1000]) });
    source.onPlaybackReport({ type: 'playback.started', audio_playback_id: 1, generation: 0, client_t_ms: getNow() });
    advance(100);
    source.onPlaybackReport({ type: 'playback.ended', audio_playback_id: 1, generation: 0 });
    advance(50);
    expect(source.mode).toBe('volume');
  });

  it('唇音の頭で口がほぼ閉じる', () => {
    const { source, advance, getNow } = rig();
    source.addAlignment({ audio_playback_id: 1, generation: 0, items: items(['ああまあ', 0, 800]) });
    source.onPlaybackReport({ type: 'playback.started', audio_playback_id: 1, generation: 0, client_t_ms: getNow() });
    advance(300);
    source.onPlaybackReport({
      type: 'playback.position',
      audio_playback_id: 1,
      generation: 0,
      samples_written: 300 * 16,
      client_t_ms: getNow(),
    });
    const open = mouthOpenAmount(advance(80));
    const closed = mouthOpenAmount(advance(20)); // 「ま」の頭（400ms）付近
    expect(closed).toBeLessThan(open * 0.5);
  });

  it('先読みで母音の切り替えが音より少し早い', () => {
    const { source, advance, getNow } = rig({ lookaheadMs: 40 });
    source.addAlignment({ audio_playback_id: 1, generation: 0, items: items(['いお', 0, 400]) });
    source.onPlaybackReport({ type: 'playback.started', audio_playback_id: 1, generation: 0, client_t_ms: getNow() });
    const shape = advance(170); // 位置 170ms、先読みで 210ms の「お」
    expect(shape.oh).toBeGreaterThan(0);
  });

  it('音の遅れを付けると口の開きも同じだけ遅れる', () => {
    const { source, advance } = rig({ audioDelayMs: 60 });
    expect(mouthOpenAmount(advance(40))).toBe(0);
    expect(mouthOpenAmount(advance(80))).toBeGreaterThan(0);
  });

  it('口形の重みは 0〜1', () => {
    for (const shape of Object.values(VOWEL_SHAPES)) {
      for (const value of Object.values(shape)) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    }
  });
});
