/**
 * 形態素解析の結果 → 「読みの断片」。断片は入力の連続した区間で、口形の読み（カタカナの発音）と、
 * TTS へ送るときの置き換え（ひらがな）を持つ。漢字の連なり・数詞＋助数詞が1つの断片になり、
 * かなは1語ずつ（送り仮名は残す: 買い → か＋い）。断片は入力の全文字を隙間なく覆う。
 *
 * TTS の読みの規則（risky、実験の前に固定。実験は tools/provider_probe/README.md の reading_tts）:
 *  R1 固有名詞（名詞,固有名詞）と、その直後に続く接尾（東京＋駅、田中＋さん）
 *  R2 数詞（数字・漢数字）と、表にある助数詞（numbers.ts の COUNTERS）。表にない助数詞が続く数は変えない
 *  R3 漢字が1〜2字の名詞（名詞,一般／副詞可能／形容動詞語幹 など。サ変接続・非自立・接尾・代名詞は除く）
 * 読みは辞書の推定。辞書にない語（未知語）と、読みと表記の対応が取れない語は変えない。
 */
import type { ReadingAnalyzer, ReadingToken } from './analyzer';
import { hasKanji, isAllKana, isKanaChar, toHiragana, toKatakana } from './kana';
import { COUNTERS, DIGITS, KANJI_NUMERAL, parseNumber, readCounted, readNumber } from './numbers';

export type PieceKind =
  /** かなだけ。置き換えない。 */
  | 'kana'
  /** R1 */
  | 'proper'
  /** R2 */
  | 'number'
  /** R3 */
  | 'short_noun'
  /** 上のどれでもない漢字（動詞の語幹、サ変名詞など）。 */
  | 'kanji'
  /** 記号、英字、空白。 */
  | 'other';

export interface ReadingPiece {
  start: number;
  end: number;
  /** 口形の読み（カタカナ、発音）。分からなければ null。 */
  lip: string | null;
  /** TTS へ送るときの置き換え（ひらがな）。置き換えられない・不要なら null。 */
  kana: string | null;
  kind: PieceKind;
}

const R3_EXCLUDED_POS1 = new Set(['サ変接続', '非自立', '接尾', '代名詞', '数', '固有名詞']);

interface Segment {
  start: number;
  end: number;
  /** カタカナ。 */
  reading: string;
  kanji: boolean;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 表記と読みの対応（ふりがなの割り付け）。かなの部分を目印に、漢字などの連なりへ読みを割り当てる。
 * 取れなければ null。
 */
export function alignFurigana(surface: string, reading: string, offset = 0): Segment[] | null {
  const runs: { text: string; kana: boolean; start: number }[] = [];
  let index = 0;
  for (const ch of surface) {
    const kana = isKanaChar(ch);
    const last = runs.at(-1);
    if (last && last.kana === kana) last.text += ch;
    else runs.push({ text: ch, kana, start: index });
    index += ch.length;
  }
  const pattern = new RegExp(`^${runs.map((r) => (r.kana ? escapeRegExp(toKatakana(r.text)) : '(.+?)')).join('')}$`, 'u');
  const match = pattern.exec(toKatakana(reading));
  if (!match) return null;
  const segments: Segment[] = [];
  let group = 1;
  for (const run of runs) {
    if (run.kana) {
      let at = run.start;
      for (const ch of run.text) {
        segments.push({ start: offset + at, end: offset + at + ch.length, reading: toKatakana(ch), kanji: false });
        at += ch.length;
      }
    } else {
      segments.push({
        start: offset + run.start,
        end: offset + run.start + run.text.length,
        reading: match[group] as string,
        kanji: true,
      });
      group += 1;
    }
  }
  return segments;
}

const isNumeric = (token: ReadingToken) =>
  token.pos1 === '数' && (DIGITS.test(token.surface) || KANJI_NUMERAL.test(token.surface));

const kanjiCount = (text: string) => [...text].filter((c) => hasKanji(c)).length;

function tokenKind(token: ReadingToken, previous: PieceKind | null): PieceKind {
  if (isAllKana(token.surface)) return 'kana';
  if (!hasKanji(token.surface)) return 'other';
  if (token.pos === '名詞' && token.pos1 === '固有名詞') return 'proper';
  if (token.pos === '名詞' && token.pos1 === '接尾' && previous === 'proper') return 'proper';
  if (token.pos === '名詞' && !R3_EXCLUDED_POS1.has(token.pos1) && kanjiCount(token.surface) <= 2) return 'short_noun';
  return 'kanji';
}

/** 数の並び（3,000 のカンマを含む）の終わりの添字（含まない）。 */
function numberRunEnd(tokens: ReadingToken[], from: number): number {
  let j = from + 1;
  while (j < tokens.length) {
    const t = tokens[j] as ReadingToken;
    if (isNumeric(t) && t.start === (tokens[j - 1] as ReadingToken).start + (tokens[j - 1] as ReadingToken).surface.length) {
      j += 1;
      continue;
    }
    const next = tokens[j + 1];
    if ((t.surface === ',' || t.surface === '，') && next && /^[0-9０-９]{3}$/u.test(next.surface)) {
      j += 2;
      continue;
    }
    break;
  }
  return j;
}

function counterOf(tokens: ReadingToken[], at: number, numberEnd: number): { counter: string; end: number } | null {
  const t = tokens[at];
  if (!t || t.start !== numberEnd) return null;
  const next = tokens[at + 1];
  // 「時＋間」と分かれた場合。
  if (t.surface === '時' && next?.surface === '間' && next.start === t.start + 1) return { counter: '時間', end: at + 2 };
  if (!(t.surface in COUNTERS)) return null;
  // 「3分の1」は ぶん。読みが分かれるので扱わない。
  if (t.surface === '分' && next?.surface === 'の') return null;
  return { counter: t.surface, end: at + 1 };
}

function pushToken(pieces: ReadingPiece[], token: ReadingToken, kind: PieceKind): void {
  const start = token.start;
  const end = token.start + token.surface.length;
  if (kind === 'kana') {
    const surface = toKatakana(token.surface);
    const pron = token.pronunciation;
    // 発音（は＝ワ、そう＝ソー）が同じ長さなら1字ずつ対応する。
    const lip = pron && [...pron].length === [...surface].length ? toKatakana(pron) : surface;
    pieces.push({ start, end, lip, kana: null, kind });
    return;
  }
  if (kind === 'other' || token.reading === null) {
    pieces.push({ start, end, lip: isAllKana(token.surface) ? toKatakana(token.surface) : null, kana: null, kind: kind === 'other' ? 'other' : kind });
    return;
  }
  const byReading = alignFurigana(token.surface, token.reading, start);
  const byPron = token.pronunciation ? alignFurigana(token.surface, token.pronunciation, start) : null;
  if (!byReading) {
    pieces.push({ start, end, lip: toKatakana(token.pronunciation ?? token.reading), kana: toHiragana(token.reading), kind });
    return;
  }
  byReading.forEach((segment, i) => {
    const pron = byPron && byPron.length === byReading.length ? (byPron[i] as Segment).reading : segment.reading;
    pieces.push({
      start: segment.start,
      end: segment.end,
      lip: pron,
      kana: segment.kanji ? toHiragana(segment.reading) : null,
      kind: segment.kanji ? kind : 'kana',
    });
  });
}

/** 入力の全文字を覆う断片。解析器がなければ空。 */
export function analyzePieces(text: string, analyzer: ReadingAnalyzer): ReadingPiece[] {
  const tokens = analyzer.tokenize(text);
  const pieces: ReadingPiece[] = [];
  let previous: PieceKind | null = null;
  for (let i = 0; i < tokens.length; ) {
    const token = tokens[i] as ReadingToken;
    if (isNumeric(token)) {
      const runEnd = numberRunEnd(tokens, i);
      const last = tokens[runEnd - 1] as ReadingToken;
      const numberEnd = last.start + last.surface.length;
      const n = parseNumber(text.slice(token.start, numberEnd));
      const counter = counterOf(tokens, runEnd, numberEnd);
      const next = tokens[runEnd];
      const unknownCounter = !counter && next !== undefined && next.start === numberEnd && next.pos1 === '接尾';
      if (n !== null && counter) {
        const kana = readCounted(n, counter.counter);
        if (kana !== null) {
          const counterToken = tokens[counter.end - 1] as ReadingToken;
          pieces.push({ start: token.start, end: counterToken.start + counterToken.surface.length, lip: toKatakana(kana), kana, kind: 'number' });
          previous = 'number';
          i = counter.end;
          continue;
        }
      }
      const alone = n === null ? null : readNumber(n);
      // 表にない助数詞が続く数は、口形には数だけの読みを使い、TTS へは置き換えない。
      pieces.push({
        start: token.start,
        end: numberEnd,
        lip: alone === null ? null : toKatakana(alone),
        kana: unknownCounter || counter ? null : alone,
        kind: 'number',
      });
      previous = 'number';
      i = runEnd;
      continue;
    }
    const kind = tokenKind(token, previous);
    pushToken(pieces, token, kind);
    previous = kind;
    i += 1;
  }
  return fillGaps(text, pieces);
}

/** 解析器が飛ばした文字（空白など）を 'other' の断片で埋める。 */
function fillGaps(text: string, pieces: ReadingPiece[]): ReadingPiece[] {
  const out: ReadingPiece[] = [];
  let at = 0;
  for (const piece of pieces) {
    if (piece.start < at) continue; // 重なり（位置の探索の失敗）は棄てる
    if (piece.start > at) out.push({ start: at, end: piece.start, lip: null, kana: null, kind: 'other' });
    out.push(piece);
    at = piece.end;
  }
  if (at < text.length) out.push({ start: at, end: text.length, lip: null, kana: null, kind: 'other' });
  return out;
}

export type TtsReadingMode = 'off' | 'risky' | 'all';

/** この断片を TTS へ送るときに置き換えるか。 */
export function replacesForTts(piece: ReadingPiece, mode: TtsReadingMode): boolean {
  if (piece.kana === null || mode === 'off') return false;
  if (mode === 'all') return piece.kind !== 'kana' && piece.kind !== 'other';
  return piece.kind === 'proper' || piece.kind === 'number' || piece.kind === 'short_noun';
}

/** 解析だけで TTS の文を作る（実験の道具と試験が使う）。 */
export function convertForTts(text: string, analyzer: ReadingAnalyzer, mode: TtsReadingMode): string {
  if (mode === 'off') return text;
  return analyzePieces(text, analyzer)
    .map((p) => (replacesForTts(p, mode) ? (p.kana as string) : text.slice(p.start, p.end)))
    .join('');
}
