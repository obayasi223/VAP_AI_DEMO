/**
 * 書き起こしの比較に使う文字列処理。句読点と空白を除いて比べる（計画 §1.1 の実測: interim の句読点は変動する）。
 * 「正規化文字数」は normalizeTranscript を通した後の文字数。
 */
import type { SttPart } from '@llm-vap/contracts';

const IGNORABLE = /[\s、。，．,.!?！？「」]/u;
const IGNORABLE_ALL = /[\s、。，．,.!?！？「」]/gu;

export function normalizeTranscript(text: string): string {
  return text.replace(IGNORABLE_ALL, '');
}

/** 正規化文字を n 個含む最短の接頭部の長さ。直後の句読点と空白も含める（「国。」を「国」と「。」に割らない）。 */
export function rawIndexAfterNormChars(text: string, n: number): number {
  let seen = 0;
  let i = 0;
  while (i < text.length && seen < n) {
    if (!IGNORABLE.test(text[i] as string)) seen += 1;
    i += 1;
  }
  while (i < text.length && IGNORABLE.test(text[i] as string)) i += 1;
  return i;
}

export function commonNormPrefix(a: string, b: string): number {
  const x = normalizeTranscript(a);
  const y = normalizeTranscript(b);
  let n = 0;
  while (n < x.length && n < y.length && x[n] === y[n]) n += 1;
  return n;
}

export function joinParts(parts: readonly SttPart[]): string {
  return parts.map((p) => p.text).join('');
}

/** 正規化文字を先頭から n 個取り除く。結果ごとの stability は保つ。 */
export function stripNormPrefix(parts: readonly SttPart[], n: number): SttPart[] {
  if (n <= 0) return [...parts];
  const whole = joinParts(parts);
  let remaining = rawIndexAfterNormChars(whole, n);
  const out: SttPart[] = [];
  for (const part of parts) {
    if (remaining >= part.text.length) {
      remaining -= part.text.length;
      continue;
    }
    out.push({ text: part.text.slice(remaining), stability: part.stability });
    remaining = 0;
  }
  return out;
}

export type OverlapMethod = 'suffix_match' | 'suffix_match_fuzzy' | 'time_proportional' | 'none';

export interface OverlapEstimate {
  /** text の先頭のうち、tail に含まれている正規化文字数。 */
  chars: number;
  method: OverlapMethod;
}

const MIN_ANCHOR_CHARS = 3;
const MAX_TAIL_SKIP = 8;
/** 一致の長さの評価の上限。周期的な繰り返しで、長く一致する別の周回を選ばないよう、距離で決まるようにする。 */
const SCORE_CAP = 12;

/**
 * 重複して認識した先頭の文字数を求める。text の先頭 p 文字の末尾が tail の末尾に一致する p を探す。
 *  - B は途中から聞き始めるので text の頭は tail と違いうる（共通接頭部ではなく、切替点側の一致を見る）。
 *  - A の末尾は切った位置の語が誤認されうるので、tail の末尾を最大 8 文字まで飛ばして試す。
 *  - 同じ句の繰り返しで別の位置に合わないよう、音声位置から求めた expected に近いものを選ぶ。
 * 一致がなければ expected（時間比例）を返す。無音で切り替えたときは一致がなければ重なりなしとする
 * （切替点の前後に音声がないので、時間比例で削ると次の発話の頭を失う。実 API の確認で起きた）。
 */
export function estimateOverlap(
  tailNorm: string,
  textNorm: string,
  expected: number,
  allowTimeProportional = true,
): OverlapEstimate {
  const length = textNorm.length;
  const center = Math.max(0, Math.min(length, Math.round(expected)));
  const window = Math.max(10, length * 0.4);
  let best: { pos: number; score: number; skip: number } | null = null;
  for (let skip = 0; skip <= MAX_TAIL_SKIP && skip < tailNorm.length; skip++) {
    const tailEnd = tailNorm.length - skip;
    for (let p = 1; p <= length; p++) {
      let run = 0;
      while (
        run < SCORE_CAP &&
        run < p &&
        run < tailEnd &&
        textNorm[p - 1 - run] === tailNorm[tailEnd - 1 - run]
      ) {
        run += 1;
      }
      // 短い文は全体が一致していれば採る（無音の直前の2文字など）。
      if (run < MIN_ANCHOR_CHARS && !(run === p && p >= 2)) continue;
      const pos = Math.min(length, p + skip);
      const distance = Math.abs(pos - center);
      if (distance > window) continue;
      const score = run - skip - distance * 0.2;
      if (!best || score > best.score) best = { pos, score, skip };
    }
  }
  if (best) return { chars: best.pos, method: best.skip === 0 ? 'suffix_match' : 'suffix_match_fuzzy' };
  if (!allowTimeProportional) return { chars: 0, method: 'none' };
  return { chars: center, method: center === 0 ? 'none' : 'time_proportional' };
}
