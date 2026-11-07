/**
 * 評価セット（tools/turngpt_probe/eval_ja.jsonl の形式）で推定器を測る。
 * 指標と基準は tools/turngpt_probe/probe.py に揃える。
 */
import { readFileSync } from 'node:fs';
import type { HistoryEntryRef, TurnCompletionEstimator } from '@llm-vap/contracts';

export const EVAL_CATEGORIES = ['continues', 'complete_with_continuation', 'question_end', 'statement_end'] as const;
export type EvalCategory = (typeof EVAL_CATEGORIES)[number];

export interface EvalItem {
  id: string;
  category: EvalCategory;
  history: string[];
  partial: string;
}

export function loadEvalSet(path: string): EvalItem[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as EvalItem);
}

/** 正例が負例より高い確率。同点は 0.5。 */
export function auc(positive: readonly number[], negative: readonly number[]): number | null {
  if (positive.length === 0 || negative.length === 0) return null;
  let wins = 0;
  for (const p of positive) for (const n of negative) wins += p > n ? 1 : p === n ? 0.5 : 0;
  return wins / (positive.length * negative.length);
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

export interface EvalRow {
  id: string;
  category: EvalCategory;
  p: number | null;
  null_reason?: string;
}

export interface EvalSummary {
  threshold: number;
  n: number;
  null_count: number;
  categories: Record<string, { n: number; median: number | null; fire_rate: number | null }>;
  auc_question_vs_continues: number | null;
  auc_statement_vs_continues: number | null;
  auc_cwc_vs_continues: number | null;
  auc_question_vs_cwc: number | null;
}

/** 「発火」は p が閾値を超えたこと（Appendix A の比較に合わせて >）。 */
export function summarize(rows: readonly EvalRow[], threshold: number): EvalSummary {
  const by = (category: EvalCategory): number[] =>
    rows.filter((r) => r.category === category && r.p !== null).map((r) => r.p as number);
  const categories: EvalSummary['categories'] = {};
  for (const category of EVAL_CATEGORIES) {
    const values = by(category);
    categories[category] = {
      n: values.length,
      median: values.length ? median(values) : null,
      fire_rate: values.length ? values.filter((p) => p > threshold).length / values.length : null,
    };
  }
  return {
    threshold,
    n: rows.length,
    null_count: rows.filter((r) => r.p === null).length,
    categories,
    auc_question_vs_continues: auc(by('question_end'), by('continues')),
    auc_statement_vs_continues: auc(by('statement_end'), by('continues')),
    auc_cwc_vs_continues: auc(by('complete_with_continuation'), by('continues')),
    auc_question_vs_cwc: auc(by('question_end'), by('complete_with_continuation')),
  };
}

/** 評価セットの history は相手の発話の文字列。 */
export function historyOf(item: EvalItem): HistoryEntryRef[] {
  return item.history.map((text) => ({ role: 'assistant' as const, text }));
}

export async function evaluateEstimator(
  estimator: TurnCompletionEstimator,
  items: readonly EvalItem[],
  options: { gap_ms?: number } = {},
): Promise<EvalRow[]> {
  const rows: EvalRow[] = [];
  for (const item of items) {
    const { p } = await estimator.estimate(historyOf(item), item.partial);
    rows.push(
      p.value === null
        ? { id: item.id, category: item.category, p: null, null_reason: p.null_reason }
        : { id: item.id, category: item.category, p: p.value },
    );
    if (options.gap_ms) await new Promise((resolve) => setTimeout(resolve, options.gap_ms));
  }
  return rows;
}
