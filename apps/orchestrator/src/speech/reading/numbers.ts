/**
 * 数詞＋助数詞の読み（ひらがな）。形態素解析は数字に読みを返さず、漢数字も「三／百」と分けて連濁を落とす
 * （三百 → サンヒャク）ので、ここで読む。読めない（小数、表にない助数詞、読みが文脈で分かれる助数詞）なら null。
 *
 * 規則は一般的な読みの1つを選ぶ（4人＝よにん、7時＝しちじ、10分＝じゅっぷん）。人による揺れ（ななじ、じっぷん）は扱わない。
 */

const DIGIT_READING = ['', 'いち', 'に', 'さん', 'よん', 'ご', 'ろく', 'なな', 'はち', 'きゅう'] as const;
const KANJI_DIGIT: Record<string, number> = { 〇: 0, 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const KANJI_SMALL_UNIT: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };
const KANJI_BIG_UNIT: Record<string, number> = { 万: 1e4, 億: 1e8 };

export const KANJI_NUMERAL = /^[〇零一二三四五六七八九十百千万億]+$/u;
export const DIGITS = /^[0-9０-９]+(?:[,，][0-9０-９]{3})*$/u;

/** 数字か漢数字の文字列 → 値。読めなければ null。 */
export function parseNumber(text: string): number | null {
  const ascii = text.replace(/[０-９]/gu, (c) => String.fromCharCode((c.codePointAt(0) as number) - 0xfee0));
  if (DIGITS.test(ascii)) {
    const n = Number(ascii.replace(/[,，]/g, ''));
    return Number.isSafeInteger(n) ? n : null;
  }
  if (!KANJI_NUMERAL.test(text)) return null;
  const chars = [...text];
  // 「二〇二六」のような位取りの書き方。
  if (chars.every((c) => c in KANJI_DIGIT) && chars.length > 1) return Number(chars.map((c) => KANJI_DIGIT[c]).join(''));
  let total = 0;
  let section = 0;
  let digit: number | null = null;
  for (const c of chars) {
    if (c in KANJI_DIGIT) {
      if (digit !== null) return null; // 「三五」のような並びは位取りでも単位つきでもない
      digit = KANJI_DIGIT[c] as number;
    } else if (c in KANJI_SMALL_UNIT) {
      section += (digit ?? 1) * (KANJI_SMALL_UNIT[c] as number);
      digit = null;
    } else {
      total += (section + (digit ?? 0) || 1) * (KANJI_BIG_UNIT[c] as number);
      section = 0;
      digit = null;
    }
  }
  return total + section + (digit ?? 0);
}

/** 末尾の要素。助数詞の音便はここで決まる。 */
type Tail = (typeof DIGIT_READING)[number] | 'じゅう' | 'ひゃく' | 'せん' | 'まん' | 'おく' | 'ぜろ';

interface NumberReading {
  /** 末尾の要素を除いた読み。 */
  head: string;
  tail: Tail;
}

const digitOf = (d: number): (typeof DIGIT_READING)[number] => DIGIT_READING[d] ?? '';

function read4(x: number, big: boolean): NumberReading[] {
  const parts: NumberReading[] = [];
  const th = Math.floor(x / 1000);
  const hu = Math.floor((x % 1000) / 100);
  const te = Math.floor((x % 100) / 10);
  const on = x % 10;
  if (th > 0) {
    // 1000万は「いっせんまん」、1234万は「せんにひゃく…まん」。
    const head = th === 1 ? (big && x === 1000 ? 'いっ' : '') : th === 8 ? 'はっ' : digitOf(th);
    parts.push({ head, tail: 'せん' });
  }
  if (hu > 0) {
    const head = hu === 1 ? '' : hu === 6 ? 'ろっ' : hu === 8 ? 'はっ' : digitOf(hu);
    parts.push({ head, tail: 'ひゃく' });
  }
  if (te > 0) parts.push({ head: te === 1 ? '' : digitOf(te), tail: 'じゅう' });
  if (on > 0) parts.push({ head: '', tail: digitOf(on) });
  return parts;
}

const TAIL_TEXT: Record<string, string> = { せん: 'せん', ひゃく: 'ひゃく', じゅう: 'じゅう', まん: 'まん', おく: 'おく', ぜろ: 'ぜろ' };
/** 「さん＋ひゃく」→ さんびゃく、「ろっ＋ひゃく」→ ろっぴゃく など、要素どうしの連濁。 */
function partText(part: NumberReading): string {
  if (part.tail === 'ひゃく' && part.head === 'さん') return 'さんびゃく';
  if (part.tail === 'ひゃく' && (part.head === 'ろっ' || part.head === 'はっ')) return `${part.head}ぴゃく`;
  if (part.tail === 'せん' && part.head === 'さん') return 'さんぜん';
  return part.head + (TAIL_TEXT[part.tail] ?? part.tail);
}

function readParts(n: number): NumberReading[] | null {
  if (!Number.isSafeInteger(n) || n < 0 || n >= 1e12) return null;
  if (n === 0) return [{ head: '', tail: 'ぜろ' }];
  const oku = Math.floor(n / 1e8);
  const man = Math.floor((n % 1e8) / 1e4);
  const rest = n % 1e4;
  const parts: NumberReading[] = [];
  const group = (x: number, unit: 'まん' | 'おく') => {
    const inner = read4(x, true);
    // 「いちまん」「いちおく」。1 だけのときは一の位の「いち」が残る。
    parts.push({ head: inner.map(partText).join(''), tail: unit });
  };
  if (oku > 0) group(oku, 'おく');
  if (man > 0) group(man, 'まん');
  parts.push(...read4(rest, false));
  return parts;
}

/** 数だけの読み。 */
export function readNumber(n: number): string | null {
  const parts = readParts(n);
  return parts ? parts.map(partText).join('') : null;
}

/**
 * 助数詞の音便の型。
 *  - h: 本・杯・匹（いっぽん、さんぼん、ろっぽん）
 *  - k: 個・回・階・件（いっこ、ろっこ、はっこ、じゅっこ）。階は 3 で濁る。
 *  - s／t: 歳・冊・通・点（いっさい、はっさい、じゅっさい）
 *  - f: 分（いっぷん、さんぷん、よんぷん、ろっぷん）
 *  - plain: 円・時・人・年・枚・度・番・秒・月（4・7・9 の読みだけ変わるものがある）
 */
interface Counter {
  reading: string;
  euphony: 'h' | 'k' | 's' | 'f' | 'plain';
  /** 末尾の要素の読みの差し替え（4 → よ など）。 */
  tail?: Partial<Record<Tail, string>>;
  /** この値だけの特別な読み（1人＝ひとり）。 */
  special?: Record<number, string>;
  /** この範囲だけ読む（月は 1〜12）。 */
  range?: [number, number];
  /** 3 で濁る（さんがい、さんぼん は h で扱う）。 */
  voicedAfterSan?: string;
}

const H_SOKUON: Partial<Record<Tail, string>> = { いち: 'いっ', ろく: 'ろっ', はち: 'はっ', じゅう: 'じゅっ', ひゃく: 'ひゃっ' };
const K_SOKUON: Partial<Record<Tail, string>> = { いち: 'いっ', ろく: 'ろっ', はち: 'はっ', じゅう: 'じゅっ', ひゃく: 'ひゃっ' };
const S_SOKUON: Partial<Record<Tail, string>> = { いち: 'いっ', はち: 'はっ', じゅう: 'じゅっ' };
const F_SOKUON: Partial<Record<Tail, string>> = { いち: 'いっ', ろく: 'ろっ', はち: 'はっ', じゅう: 'じゅっ', ひゃく: 'ひゃっ' };

export const COUNTERS: Record<string, Counter> = {
  円: { reading: 'えん', euphony: 'plain', tail: { よん: 'よ' } },
  時: { reading: 'じ', euphony: 'plain', tail: { よん: 'よ', なな: 'しち', きゅう: 'く' } },
  時間: { reading: 'じかん', euphony: 'plain', tail: { よん: 'よ', なな: 'なな', きゅう: 'く' } },
  人: { reading: 'にん', euphony: 'plain', tail: { よん: 'よ' }, special: { 1: 'ひとり', 2: 'ふたり' } },
  名: { reading: 'めい', euphony: 'plain' },
  年: { reading: 'ねん', euphony: 'plain', tail: { よん: 'よ' } },
  月: { reading: 'がつ', euphony: 'plain', tail: { よん: 'し', なな: 'しち', きゅう: 'く' }, range: [1, 12] },
  枚: { reading: 'まい', euphony: 'plain' },
  度: { reading: 'ど', euphony: 'plain' },
  番: { reading: 'ばん', euphony: 'plain' },
  秒: { reading: 'びょう', euphony: 'plain' },
  キロ: { reading: 'きろ', euphony: 'plain' },
  本: { reading: 'ほん', euphony: 'h', voicedAfterSan: 'ぼん' },
  杯: { reading: 'はい', euphony: 'h', voicedAfterSan: 'ばい' },
  匹: { reading: 'ひき', euphony: 'h', voicedAfterSan: 'びき' },
  泊: { reading: 'はく', euphony: 'h', voicedAfterSan: 'ぱく' },
  個: { reading: 'こ', euphony: 'k' },
  回: { reading: 'かい', euphony: 'k' },
  階: { reading: 'かい', euphony: 'k', voicedAfterSan: 'がい' },
  件: { reading: 'けん', euphony: 'k' },
  曲: { reading: 'きょく', euphony: 'k' },
  歳: { reading: 'さい', euphony: 's' },
  才: { reading: 'さい', euphony: 's' },
  冊: { reading: 'さつ', euphony: 's' },
  週: { reading: 'しゅう', euphony: 's' },
  点: { reading: 'てん', euphony: 's' },
  通: { reading: 'つう', euphony: 's' },
  分: { reading: 'ふん', euphony: 'f' },
  つ: {
    reading: '',
    euphony: 'plain',
    special: { 1: 'ひとつ', 2: 'ふたつ', 3: 'みっつ', 4: 'よっつ', 5: 'いつつ', 6: 'むっつ', 7: 'ななつ', 8: 'やっつ', 9: 'ここのつ' },
    range: [1, 9],
  },
};

const P_FROM_H: Record<string, string> = { は: 'ぱ', ひ: 'ぴ', ふ: 'ぷ', へ: 'ぺ', ほ: 'ぽ' };

/** 数＋助数詞の読み。助数詞がなければ数だけ。読めなければ null。 */
export function readCounted(n: number, counter: string | null): string | null {
  const parts = readParts(n);
  if (!parts) return null;
  if (counter === null) return parts.map(partText).join('');
  const spec = COUNTERS[counter];
  if (!spec) return null;
  if (spec.range && (n < spec.range[0] || n > spec.range[1])) return null;
  const special = spec.special?.[n];
  if (special) return special;
  if (spec.reading === '') return null;
  const last = parts[parts.length - 1] as NumberReading;
  const head = parts.slice(0, -1).map(partText).join('') + last.head;
  // 末尾の要素の読み（連濁を含む: さん＋びゃく）。
  const tailText = partText(last).slice(last.head.length);
  let tail = tailText;
  let reading = spec.reading;
  const replaced = spec.tail?.[last.tail];
  if (replaced !== undefined) tail = replaced;
  const sokuon = (table: Partial<Record<Tail, string>>) => (table[last.tail] ? `${tailText.slice(0, -1)}っ` : null);
  const first = reading[0] as string;
  if (spec.euphony === 'h' || spec.euphony === 'f') {
    const s = sokuon(spec.euphony === 'h' ? H_SOKUON : F_SOKUON);
    if (s) {
      tail = s;
      reading = (P_FROM_H[first] ?? first) + reading.slice(1);
    } else if (spec.euphony === 'h' && (last.tail === 'さん' || last.tail === 'せん' || last.tail === 'まん')) {
      reading = spec.voicedAfterSan ?? reading;
    } else if (spec.euphony === 'f' && (last.tail === 'さん' || last.tail === 'よん')) {
      reading = (P_FROM_H[first] ?? first) + reading.slice(1);
    }
  } else if (spec.euphony === 'k' || spec.euphony === 's') {
    const s = sokuon(spec.euphony === 'k' ? K_SOKUON : S_SOKUON);
    if (s) tail = s;
    else if (last.tail === 'さん' && spec.voicedAfterSan) reading = spec.voicedAfterSan;
  }
  return `${head}${tail}${reading}`;
}
