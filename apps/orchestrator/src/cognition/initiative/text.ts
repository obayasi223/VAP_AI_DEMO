/**
 * 根拠の照合に使う文字列の処理（計画 §1.1、§4.5）。
 * ASR の句読点と空白は revision ごとに変わる（実測: 「国。」「国が？」）ので、比較では除く。
 */

/** 句読点（Unicode の P）と空白。normalizeForMatch（正本は @llm-vap/analysis/text）と同じ規則。 */
const IGNORED = /[\s\p{P}]/u;

// 正規化の正本は @llm-vap/analysis（遅延の集計と同じ規則を使うため。層の向きは packages → apps）。
export { normalizeForMatch } from '@llm-vap/analysis/text';

export function commonPrefixLength(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i += 1;
  return i;
}

/**
 * 正規化後の先頭 n 文字に対応する元の文字列の接頭部。n 文字目の直後で切る。
 * 正規化で文字数が変わる字（NFKC の互換文字）は1文字ずつ正規化して数える。
 */
export function rawPrefixForNormalized(raw: string, n: number): string {
  if (n <= 0) return '';
  let count = 0;
  let index = 0;
  for (const ch of raw) {
    index += ch.length;
    if (IGNORED.test(ch)) continue;
    count += ch.normalize('NFKC').length;
    if (count >= n) return raw.slice(0, index);
  }
  return raw;
}
