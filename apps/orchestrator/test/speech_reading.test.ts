import { beforeAll, describe, expect, it } from 'vitest';
import { ManualTimeSource, MemoryEventSink, absent, createEventEmitter, present } from '@llm-vap/contracts';
import type { PlaybackStopMode, PrepareRequest } from '@llm-vap/contracts';
import { ScriptedLlmProvider, ScriptedTtsProvider } from '@llm-vap/testkit';
import type { ScriptedTtsConnection } from '@llm-vap/testkit';
import { SpeechGeneratorImpl } from '../src/speech';
import type { SpeechAudioSink, SpeechFinished } from '../src/speech';
import {
  SpeechTextTrack,
  analyzePieces,
  convertForTts,
  loadKuromojiAnalyzer,
  readCounted,
  readReadingConfig,
  sliceReading,
} from '../src/speech/reading';
import type { ReadingAnalyzer, ReadingToken, TtsReadingMode } from '../src/speech/reading';

let kuromoji: ReadingAnalyzer;
beforeAll(async () => {
  kuromoji = await loadKuromojiAnalyzer();
}, 30_000);

/** 試験用の解析器: 決めた語の区切りと読みを返す。 */
function fakeAnalyzer(dictionary: Record<string, { reading: string; pron?: string; pos?: string; pos1?: string }>): ReadingAnalyzer {
  const words = Object.keys(dictionary).sort((a, b) => b.length - a.length);
  return {
    name: 'fake',
    tokenize(text: string): ReadingToken[] {
      const out: ReadingToken[] = [];
      for (let i = 0; i < text.length; ) {
        const word = words.find((w) => text.startsWith(w, i));
        if (word) {
          const entry = dictionary[word] as { reading: string; pron?: string; pos?: string; pos1?: string };
          out.push({
            surface: word,
            start: i,
            pos: entry.pos ?? '名詞',
            pos1: entry.pos1 ?? '一般',
            pos2: '*',
            reading: entry.reading,
            pronunciation: entry.pron ?? entry.reading,
            known: true,
          });
          i += word.length;
        } else {
          const ch = text[i] as string;
          const kana = /[ぁ-んァ-ン]/u.test(ch);
          out.push({ surface: ch, start: i, pos: kana ? '助詞' : '記号', pos1: '*', pos2: '*', reading: kana ? ch : null, pronunciation: kana ? ch : null, known: kana });
          i += 1;
        }
      }
      return out;
    },
  };
}

describe('数詞＋助数詞の読み', () => {
  it.each([
    [300, '円', 'さんびゃくえん'],
    [3000, '円', 'さんぜんえん'],
    [1, '本', 'いっぽん'],
    [3, '本', 'さんぼん'],
    [6, '杯', 'ろっぱい'],
    [10, '分', 'じゅっぷん'],
    [4, '人', 'よにん'],
    [2, '人', 'ふたり'],
    [9, '時', 'くじ'],
    [3, '階', 'さんがい'],
    [8, '歳', 'はっさい'],
    [4, '月', 'しがつ'],
    [3, 'つ', 'みっつ'],
  ] as const)('%d%s → %s', (n, counter, expected) => {
    expect(readCounted(n, counter)).toBe(expected);
  });

  it('表にない助数詞と範囲の外は null', () => {
    expect(readCounted(3, '日')).toBeNull();
    expect(readCounted(13, '月')).toBeNull();
  });
});

describe('形態素解析の断片（kuromoji）', () => {
  it('断片は入力の全文字を隙間なく覆う', () => {
    const text = 'そうですね、AIの話は3,000円くらい。東京駅で！';
    const pieces = analyzePieces(text, kuromoji);
    let at = 0;
    for (const p of pieces) {
      expect(p.start).toBe(at);
      at = p.end;
    }
    expect(at).toBe(text.length);
  });

  it('固有名詞＋接尾、数詞＋助数詞、短い名詞の読み', () => {
    const pieces = analyzePieces('東京駅で三百円の生ビール', kuromoji);
    const by = (surface: string) => pieces.find((p) => '東京駅で三百円の生ビール'.slice(p.start, p.end) === surface);
    expect(by('東京')).toMatchObject({ kind: 'proper', kana: 'とうきょう', lip: 'トーキョー' });
    expect(by('駅')).toMatchObject({ kind: 'proper', kana: 'えき' });
    expect(by('三百円')).toMatchObject({ kind: 'number', kana: 'さんびゃくえん' });
    expect(by('生')).toMatchObject({ kind: 'short_noun', kana: 'なま' });
  });

  it('TTS の文: risky は R1〜R3 だけ、all は漢字と数を全部ひらがな', () => {
    expect(convertForTts('東京駅で待ち合わせしましょう', kuromoji, 'risky')).toBe('とうきょうえきでまちあわせしましょう');
    expect(convertForTts('大阪の友達に会いに行きます', kuromoji, 'risky')).toBe('おおさかのともだちに会いに行きます');
    expect(convertForTts('大阪の友達に会いに行きます', kuromoji, 'all')).toBe('おおさかのともだちにあいにいきます');
    expect(convertForTts('三百円で買いました', kuromoji, 'risky')).toBe('さんびゃくえんで買いました');
    // 送り仮名とカタカナは残す。
    expect(convertForTts('生ビールを一杯ください', kuromoji, 'all')).toBe('なまビールをいっぱいください');
    expect(convertForTts('東京駅', kuromoji, 'off')).toBe('東京駅');
  });

  it('表にない助数詞（日）が続く数は TTS では変えない', () => {
    expect(convertForTts('8日に行きます', kuromoji, 'risky')).toBe('8日に行きます');
  });
});

describe('SpeechTextTrack: 口形の読み', () => {
  const analyzer = fakeAnalyzer({
    今日: { reading: 'キョウ', pron: 'キョー', pos1: '副詞可能' },
    天気: { reading: 'テンキ' },
    東京駅: { reading: 'トウキョウエキ', pron: 'トーキョーエキ', pos1: '固有名詞' },
  });

  const track = (mode: TtsReadingMode = 'off') => new SpeechTextTrack({ analyzer, tts_mode: mode, lip: true });

  it('alignment の語と解析の語が一致すれば、その読み。かなで読みも同じ語は null', () => {
    const t = track();
    expect(t.push('今日は天気。')).toBe('今日は天気。');
    t.addAlignment([...'今日は天気。', ' ']);
    expect(t.readingForAlignment(0, 2, '今日')).toBe('キョー');
    expect(t.readingForAlignment(2, 3, 'は')).toBeNull();
    expect(t.readingForAlignment(3, 6, '天気。')).toBe('テンキ');
  });

  it('alignment の語が解析の語の途中で切れたら、読みを文字数の比で分ける（推定）', () => {
    const t = track();
    t.push('東京駅。');
    t.end();
    t.addAlignment([...'東京駅。']);
    // Intl.Segmenter が「東京｜駅」と切った場合。
    expect(t.readingForAlignment(0, 2, '東京')).toBe('トーキョー');
    expect(t.readingForAlignment(2, 4, '駅。')).toBe('エキ');
  });

  it('alignment の途中の空白で語が割れても、空白を除いた位置で読みを引く', () => {
    const t = track();
    t.push('今日は天気。');
    t.addAlignment([...'今日は天 気。', ' ']);
    expect(t.readingForAlignment(3, 5, '天 ')).toBe('テン');
    expect(t.readingForAlignment(5, 7, '気。')).toBe('キ');
  });

  it('alignment の語が解析の語を複数またげば、読みをつなぐ', () => {
    const t = track();
    t.push('今日天気');
    t.end();
    t.addAlignment([...'今日天気']);
    expect(t.readingForAlignment(0, 4, '今日天気')).toBe('キョーテンキ');
  });

  it('読みの分からない文字（英字）を含む語は null', () => {
    const t = track();
    t.push('AI天気');
    t.end();
    t.addAlignment([...'AI天気']);
    expect(t.readingForAlignment(0, 4, 'AI天気')).toBeNull();
    expect(t.readingForAlignment(2, 4, '天気')).toBe('テンキ');
  });

  it('句読点がまだ来ていない末尾も、語の読みが要るときに解析する', () => {
    const t = track();
    t.push('今日');
    t.addAlignment([...'今日']);
    expect(t.readingForAlignment(0, 2, '今日')).toBe('キョー');
  });

  it('lip=false なら読みを付けない', () => {
    const t = new SpeechTextTrack({ analyzer, tts_mode: 'off', lip: false });
    t.push('今日。');
    t.addAlignment([...'今日。']);
    expect(t.readingForAlignment(0, 2, '今日')).toBeNull();
  });

  it('分け目を小書き・長音の前に置かない', () => {
    expect(sliceReading('トーキョー', 2, 0, 1)).toBe('トー');
    expect(sliceReading('トーキョー', 2, 1, 2)).toBe('キョー');
  });
});

describe('SpeechTextTrack: TTS の文の変換と元の文への対応', () => {
  const analyzer = fakeAnalyzer({ 東京駅: { reading: 'トウキョウエキ', pron: 'トーキョーエキ', pos1: '固有名詞' } });
  const make = () => new SpeechTextTrack({ analyzer, tts_mode: 'risky', lip: true });

  it('句読点までためて、置き換えた文を返す', () => {
    const t = make();
    expect(t.push('東京')).toBe('');
    expect(t.push('駅で、')).toBe('とうきょうえきで、');
    expect(t.push('会う')).toBe('');
    expect(t.end()).toBe('会う');
    expect(t.original).toBe('東京駅で、会う');
    expect(t.tts).toBe('とうきょうえきで、会う');
  });

  it('置き換えた語の途中までは話していない側に倒す', () => {
    const t = make();
    t.push('東京駅で会う。');
    t.end();
    expect(t.tts).toBe('とうきょうえきで会う。');
    expect(t.originalForTtsPrefix(0)).toBe('');
    expect(t.originalForTtsPrefix(4)).toBe(''); // 「とうきょ」まで: 東京駅はまだ
    expect(t.originalForTtsPrefix(7)).toBe('東京駅');
    expect(t.originalForTtsPrefix(8)).toBe('東京駅で');
    expect(t.originalForTtsPrefix(9)).toBe('東京駅で会');
    expect(t.originalForTtsPrefix(t.tts.length)).toBe('東京駅で会う。');
  });

  it('alignment の末尾の空白は TTS の文の位置を進めない', () => {
    const t = make();
    t.push('東京駅。');
    t.end();
    t.addAlignment([...'とうきょうえき。', ' ']);
    expect(t.originalForAlignmentPrefix(9)).toBe('東京駅。');
    expect(t.originalForAlignmentPrefix(3)).toBe('');
    // 口形の読みは発音（トーキョー）。
    expect(t.readingForAlignment(0, 7, 'とうきょうえき')).toBe('トーキョーエキ');
  });

  it('alignment の途中に混じる空白（実測: 「一 階」）も読み飛ばす', () => {
    const t = make();
    t.push('東京駅で会う。');
    t.end();
    t.addAlignment([...'とうきょう えきで会 う。', ' ']);
    expect(t.originalForAlignmentPrefix([...'とうきょう えきで'].length)).toBe('東京駅で');
    expect(t.originalForAlignmentPrefix([...'とうきょう'].length)).toBe('');
    expect(t.stats.alignment_mismatches).toBe(0);
  });

  it('解析器がなければ変換しない（そのまま送る）', () => {
    const t = new SpeechTextTrack({ analyzer: null, tts_mode: 'risky', lip: true });
    expect(t.transforms).toBe(false);
    expect(t.push('東京')).toBe('東京');
    expect(t.originalForTtsPrefix(1)).toBe('東');
  });
});

describe('読みの設定', () => {
  it('既定は口形の読みが有効、TTS の変換は off', () => {
    expect(readReadingConfig({})).toEqual({ lip: true, tts_mode: 'off' });
    expect(readReadingConfig({ LIPSYNC_READING: '0', TTS_READING_MODE: 'risky' })).toEqual({ lip: false, tts_mode: 'risky' });
    expect(() => readReadingConfig({ TTS_READING_MODE: 'kana' })).toThrow();
  });
});

// ---- SpeechGenerator との結合 ---------------------------------------------------

class RecordingSink implements SpeechAudioSink {
  alignments: Parameters<SpeechAudioSink['alignment']>[0][] = [];
  stops: { audio_playback_id: number; generation: number; stop: PlaybackStopMode; reason: string }[] = [];
  begin = () => undefined;
  pcm = () => undefined;
  alignment = (m: RecordingSink['alignments'][number]) => void this.alignments.push(m);
  stop = (m: RecordingSink['stops'][number]) => void this.stops.push(m);
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
};

const candidate = (text: string): PrepareRequest => ({
  segment_id: 1,
  transcript_revision: 1,
  text,
  origin: { kind: 'candidate', candidate_id: 'c1', candidate_version: 1 },
});
const EXPECT = { candidate_id: 'c1', candidate_version: 1 };
const ended = (id: number, generation: number, reason: 'completed' | 'stopped', samples_written: number) => ({
  type: 'playback.ended' as const,
  audio_playback_id: id,
  generation,
  reason,
  samples_written,
  samples_discarded: 0,
  audio_frame: 2000,
  client_t_ms: 2,
  output_latency_ms: present(0),
});
const started = (id: number, generation: number) => ({
  type: 'playback.started' as const,
  audio_playback_id: id,
  generation,
  audio_frame: 1000,
  client_t_ms: 1,
  output_latency_ms: present(0),
});

async function rig(mode: TtsReadingMode, options: { reply?: string; lip?: boolean } = {}) {
  const provider = new ScriptedTtsProvider({ ms_per_char: 100, chars_per_chunk: 4 });
  const tts: ScriptedTtsConnection = await provider.open({ preferred_sample_rate_hz: 16000 });
  const llm = new ScriptedLlmProvider({ responder: () => options.reply ?? '東京駅です。', delta_delay_ms: 0, chars_per_delta: 2 });
  const sink = new RecordingSink();
  const events = new MemoryEventSink();
  const time = new ManualTimeSource();
  const emitter = createEventEmitter({ time, session_id: 's', condition: () => 'reactive', sink: events });
  const speech = new SpeechGeneratorImpl({
    tts,
    llm,
    prompt: (request) => ({ system: 'sys', messages: [{ role: 'user', text: request.text }] }),
    sink,
    time,
    emitter,
    is_ready_buffer_ms: 100,
    reading: { analyzer: kuromoji, tts_mode: mode, lip: options.lip ?? true },
  });
  const finished: SpeechFinished[] = [];
  speech.onFinished((f) => finished.push(f));
  return { speech, tts, sink, events, finished };
}

type Rig = Awaited<ReturnType<typeof rig>>;
const contextOf = (r: Rig, id: number) => r.tts.contexts.find((c) => c.audio_playback_id === id);

async function play(r: Rig, text: string) {
  const { audio_playback_id: id } = r.speech.prepare(candidate(text));
  await flush();
  contextOf(r, id)?.pumpAll();
  expect(r.speech.startChecked(id, EXPECT).ok).toBe(true);
  r.speech.handlePlaybackStarted(started(id, 0), 10);
  return id;
}

describe('SpeechGenerator: 口形の読み（TTS の文はそのまま）', () => {
  it('漢字の語に reading を付け、推定であることを reading_source で示す。TTS の文と発話済みは変わらない', async () => {
    const r = await rig('off');
    const text = '今日は東京駅で会いましょう。';
    const id = await play(r, text);
    expect(contextOf(r, id)?.sent.join('')).toBe(text);
    const items = r.sink.alignments.flatMap((a) => a.items);
    expect(items.map((i) => i.text).join('')).toBe(text);
    expect(items.find((i) => i.text === '今日')?.reading).toBe('キョー');
    expect(items.filter((i) => /[一-龯]/u.test(i.text)).every((i) => typeof i.reading === 'string')).toBe(true);
    // かなで読みも同じ語には付けない。
    expect(items.find((i) => i.text === 'で')?.reading).toBeUndefined();
    expect(r.sink.alignments.every((a) => a.items.some((i) => i.reading) === (a.reading_source === 'morphological_estimate'))).toBe(true);
    r.speech.handlePlaybackEnded(ended(id, 0, 'completed', 1400 * 16), 2000);
    expect(r.finished[0]?.spoken_text).toBe(text);
    expect(r.events.ofType('speech.ended')[0]).not.toHaveProperty('tts_text');
  });

  it('lip=false なら reading も reading_source も付かない', async () => {
    const r = await rig('off', { lip: false });
    await play(r, '今日は晴れ。');
    expect(r.sink.alignments.flatMap((a) => a.items).some((i) => i.reading)).toBe(false);
    expect(r.sink.alignments.some((a) => a.reading_source)).toBe(false);
  });

  it('LLM の応答（細切れの delta）でも語の読みが付く', async () => {
    const r = await rig('off', { reply: '明日は大阪へ行きます。' });
    const { audio_playback_id: id } = r.speech.prepare({ segment_id: 1, transcript_revision: 1, text: 'どこへ', origin: { kind: 'response' } });
    await flush();
    contextOf(r, id)?.pumpAll();
    expect(r.speech.start(id)).toBe(true);
    const items = r.sink.alignments.flatMap((a) => a.items);
    expect(items.find((i) => i.text === '大阪')?.reading).toBe('オーサカ');
  });
});

describe('SpeechGenerator: TTS の文の変換（risky）', () => {
  const TEXT = '東京駅で三百円です。';
  const TTS = 'とうきょうえきでさんびゃくえんです。';

  it('TTS へは変換した文を送り、最後まで話せば spoken_text は元の文。speech.ended に tts_text', async () => {
    const r = await rig('risky');
    const id = await play(r, TEXT);
    expect(contextOf(r, id)?.sent.join('')).toBe(TTS);
    r.speech.handlePlaybackEnded(ended(id, 0, 'completed', [...TTS].length * 100 * 16), 5000);
    expect(r.finished[0]?.spoken_text).toBe(TEXT);
    const [event] = r.events.ofType('speech.ended');
    expect(event?.spoken_text).toBe(TEXT);
    expect(event?.tts_text).toBe(TTS);
  });

  it('割り込みの発話済み: alignment は TTS の文の位置なので元の文へ戻し、置き換えた語の途中は含めない', async () => {
    const r = await rig('risky');
    const id = await play(r, TEXT);
    // 100ms/字。「とうきょうえきで」は 800ms、「さんびゃくえん」はその後 700ms。1000ms では「さんびゃくえん」の途中。
    r.speech.stop(id, 'barge_in', { stop_point: 'immediate', max_wait_ms: 0, decision_source: 'vap' });
    r.speech.handlePlaybackEnded(ended(id, 1, 'stopped', 1000 * 16), 3000);
    expect(r.finished[0]).toMatchObject({ spoken_text_precision: 'alignment_char', interrupted: true });
    const spoken = r.finished[0]?.spoken_text ?? '';
    expect(TEXT.startsWith(spoken)).toBe(true);
    expect(['', '東京駅', '東京駅で']).toContain(spoken);
    expect(spoken).not.toContain('三');
  });

  it('alignment がない音声（比例配分）でも、発話済みは元の文の先頭で返す', async () => {
    const r = await rig('risky');
    const { audio_playback_id: id, generation } = r.speech.prepare(candidate(TEXT));
    await flush();
    const ttsLen = [...TTS].length;
    r.tts.emitChunk({
      context_id: `p${id}_g${generation}`,
      audio_playback_id: id,
      generation,
      seq: 0,
      sample_rate_hz: 16000,
      pcm: new Int16Array(ttsLen * 1600),
      alignment: absent('none'),
      is_last: true,
    });
    expect(r.speech.startChecked(id, EXPECT).ok).toBe(true);
    r.speech.handlePlaybackStarted(started(id, generation), 10);
    r.speech.stop(id, 'x', { stop_point: 'immediate', max_wait_ms: 0, decision_source: 'woz' });
    // TTS の文の 9 字（とうきょうえきでさ）まで → 元の文は「東京駅で」まで。
    r.speech.handlePlaybackEnded(ended(id, generation + 1, 'stopped', 9 * 1600), 500);
    expect(r.finished[0]).toMatchObject({ spoken_text: '東京駅で', spoken_text_precision: 'time_proportional' });
  });

  it('合成済みの文字数（synthesizedChars）は TTS の文で数え、元の文へ戻す', async () => {
    const r = await rig('risky');
    const { audio_playback_id: id, generation } = r.speech.prepare(candidate('東京駅です。大阪です。'));
    await flush();
    expect(contextOf(r, id)?.sent.join('')).toBe('とうきょうえきです。おおさかです。');
    // 1文目だけ合成（推定の chars、alignment なし）して、文脈を失う。
    const first = [...'とうきょうえきです。'];
    r.tts.emitChunk({
      context_id: `p${id}_g${generation}`,
      audio_playback_id: id,
      generation,
      seq: 0,
      sample_rate_hz: 16000,
      pcm: new Int16Array(first.length * 1600),
      alignment: absent('provider_has_no_alignment'),
      estimated_alignment: {
        source: 'estimated_time_proportional',
        chars: first,
        char_start_ms: first.map((_, i) => i * 100),
        char_duration_ms: first.map(() => 100),
      },
      is_last: false,
    });
    expect(r.speech.startChecked(id, EXPECT).ok).toBe(true);
    r.speech.handlePlaybackStarted(started(id, generation), 10);
    r.tts.deliverStatus('down', 'socket closed');
    r.speech.handlePlaybackEnded(ended(id, generation, 'completed', first.length * 1600), 2000);
    expect(r.finished[0]?.spoken_text).toBe('東京駅です。');
  });

  it('句読点で終わらない文も、入力の終わりでためていた分を送る', async () => {
    const r = await rig('risky');
    const id = await play(r, '東京駅です');
    expect(contextOf(r, id)?.sent.join('')).toBe('とうきょうえきです');
    r.speech.handlePlaybackEnded(ended(id, 0, 'completed', 9 * 1600), 3000);
    expect(r.finished[0]?.spoken_text).toBe('東京駅です');
  });

  it('off に戻せば TTS の文は元の文のまま（既定）', async () => {
    const r = await rig('off');
    const id = await play(r, TEXT);
    expect(contextOf(r, id)?.sent.join('')).toBe(TEXT);
  });
});
