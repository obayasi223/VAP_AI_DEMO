/**
 * 文字列の小さな道具（文字数、文の区切り、穴埋め、ハッシュ、種つきの乱数）。
 * 文字数は文字（コードポイント）で数える（wp0_notes S6 と同じ）。
 */
import { createHash } from 'node:crypto';

export function charCount(text: string): number {
  return [...text].length;
}

/** 文末（。！？!?）で区切る。区切りの記号は前の文に付ける。空の文は作らない。 */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let current = '';
  for (const ch of text) {
    current += ch;
    if (ch === '。' || ch === '！' || ch === '？' || ch === '!' || ch === '?') {
      if (current.trim() !== '') out.push(current);
      current = '';
    }
  }
  if (current.trim() !== '') out.push(current);
  return out;
}

/** 穴 {name} を埋める。埋まらない穴があれば missing に名前を返す。 */
export function fillTemplate(template: string, slots: Record<string, string | undefined | null>): { text: string; missing: string[] } {
  const missing: string[] = [];
  const text = template.replace(/\{([a-zA-Z0-9_]+)\}/g, (whole, name: string) => {
    const value = slots[name];
    if (value === undefined || value === null || value === '') {
      missing.push(name);
      return whole;
    }
    return value;
  });
  return { text, missing };
}

/** 帯の上限以下の最後の文末で切る。文末がなければ null。 */
export function cutAtSentence(text: string, maxChars: number): string | null {
  const sentences = splitSentences(text);
  let out = '';
  for (const s of sentences) {
    if (charCount(out + s) > maxChars) break;
    out += s;
  }
  return out === '' ? null : out;
}

/** キーを並べた JSON（ハッシュ用）。 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** 種（文字列）から [0, 1) の値。同じ種なら同じ値（条件の間で間をそろえる）。 */
export function seededUnit(seed: string): number {
  const digest = createHash('sha256').update(seed).digest();
  return digest.readUInt32BE(0) / 0x1_0000_0000;
}

/** 中央値と上下限から、種つきで 1 つ選ぶ（下半分と上半分を同じ確率に分ける）。 */
export function seededGap(seed: string, dist: { median: number; min: number; max: number }): number {
  const u = seededUnit(seed);
  const value = u < 0.5 ? dist.min + (dist.median - dist.min) * (u / 0.5) : dist.median + (dist.max - dist.median) * ((u - 0.5) / 0.5);
  return Math.round(value);
}

/** ```json の囲いを外して JSON を読む。読めなければ null。 */
export function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}
