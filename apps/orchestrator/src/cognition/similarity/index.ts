/**
 * 準備の類似度（計画 §4.1）。文字 n-gram のコサイン。Node 内で完結し、依存はない。
 * 原著の all-MiniLM-L6-v2 とは別の尺度なので、原著の 0.8 をそのまま適用しない。
 * U-5: Similarity(x, none) は 0。比較では句読点と空白を除く（計画 §1.1）。
 */
export const SIMILARITY_NGRAM = 2;
/** ログの similarity_method に残す値。 */
export const SIMILARITY_METHOD = `char_ngram_cosine:n=${SIMILARITY_NGRAM}`;

export function normalizeForSimilarity(text: string): string {
  return text.normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '');
}

function ngramCounts(text: string, n: number): Map<string, number> {
  const chars = [...text];
  const counts = new Map<string, number>();
  // n より短い文は全体を1つの gram とする（「はい」→「はい」を 1 にするため）。
  const grams =
    chars.length < n
      ? [chars.join('')]
      : Array.from({ length: chars.length - n + 1 }, (_, i) => chars.slice(i, i + n).join(''));
  for (const gram of grams) counts.set(gram, (counts.get(gram) ?? 0) + 1);
  return counts;
}

export function charNgramCosine(
  x: string | null | undefined,
  y: string | null | undefined,
  n: number = SIMILARITY_NGRAM,
): number {
  if (x === null || x === undefined || y === null || y === undefined) return 0;
  const a = normalizeForSimilarity(x);
  const b = normalizeForSimilarity(y);
  if (a === '' || b === '') return 0;
  const countsA = ngramCounts(a, n);
  const countsB = ngramCounts(b, n);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const [gram, count] of countsA) {
    normA += count * count;
    dot += count * (countsB.get(gram) ?? 0);
  }
  for (const count of countsB.values()) normB += count * count;
  return Math.min(1, dot / Math.sqrt(normA * normB));
}
