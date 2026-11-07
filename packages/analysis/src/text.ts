/**
 * 根拠の照合に使う文字列の正規化（計画 §1.1、§4.5）。
 * ASR の句読点と空白は revision ごとに変わる（実測: 「国。」「国が？」）ので、比較では除く。
 *
 * 遅延の集計（latency.ts の発話済みテキストの照合）と InitiativeMonitor の根拠の照合が同じ規則を使うため、
 * 正本をここに置き、apps/orchestrator/src/cognition/initiative/text.ts はこれを再 export する。
 */

/** 句読点（Unicode の P）と空白を除く。数字や「円」などの意味のある文字は残す。 */
const IGNORED_ALL = /[\s\p{P}]/gu;

export function normalizeForMatch(text: string): string {
  return text.replace(IGNORED_ALL, '').normalize('NFKC');
}
