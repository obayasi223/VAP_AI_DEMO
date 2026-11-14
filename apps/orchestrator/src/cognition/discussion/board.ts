/**
 * 候補の板（02 §2.8）。4 枚の 2 版（text／corrected_text）を凍結する。
 * 出どころは台本の board（prepared）か、計画の出力を文型（point_templates の board_cards）に入れたもの（generated）。
 * カードは段の最後のターンの開始で出す（generator.ts）。訂正の後は、まだ出していないカードを corrected_text で渡す。
 */
import type { BoardCardView, BoardDependency, ScriptVariant, TwoAiFallbackOutline, TwoAiPointTemplates, TwoAiScript } from '@llm-vap/contracts';
import { inBand } from './points';
import { charCount, fillTemplate } from './text';
import type { BoardCard } from './types';

export function boardFromScript(board: NonNullable<TwoAiScript['board']>): BoardCard[] {
  return [...board]
    .sort((a, b) => a.order - b.order)
    .map((c) => ({
      card_id: c.card_id,
      order: c.order as BoardCard['order'],
      stage: c.discussion_stage,
      depends_on: c.depends_on,
      text: c.text,
      corrected_text: c.corrected_text,
    }));
}

export function boardFromTemplates(
  templates: TwoAiPointTemplates,
  slots: Record<string, string>,
): { ok: true; board: BoardCard[] } | { ok: false; reasons: string[] } {
  const reasons: string[] = [];
  const board: BoardCard[] = [];
  for (const t of [...templates.board_cards].sort((a, b) => a.order - b.order)) {
    const a = fillTemplate(t.template, slots);
    const b = fillTemplate(t.corrected_template, slots);
    if (a.missing.length > 0 || b.missing.length > 0) {
      reasons.push(`card ${t.order}: missing slots ${[...new Set([...a.missing, ...b.missing])].join(',')}`);
      continue;
    }
    if (!inBand(charCount(a.text), t.target_chars)) reasons.push(`card ${t.order}: ${charCount(a.text)} chars outside ${t.target_chars.join('-')}`);
    board.push({
      card_id: `card_${t.order}`,
      order: t.order as BoardCard['order'],
      stage: t.discussion_stage,
      depends_on: t.depends_on,
      text: a.text,
      // 依存しないカードは同じ文（02 §2.8）
      corrected_text: t.depends_on === 'fact_slip' ? b.text : a.text,
    });
  }
  return reasons.length > 0 ? { ok: false, reasons } : { ok: true, board };
}

export function boardFromOutline(outline: TwoAiFallbackOutline): BoardCard[] {
  return [...outline.board_generic]
    .sort((a, b) => a.order - b.order)
    .map((c) => ({
      card_id: `card_${c.order}`,
      order: c.order as BoardCard['order'],
      stage: c.discussion_stage,
      depends_on: 'none' as BoardDependency,
      text: c.text,
      corrected_text: c.text,
    }));
}

export function cardView(card: BoardCard, variant: ScriptVariant): BoardCardView & { depends_on: BoardDependency } {
  return {
    card_id: card.card_id,
    order: card.order,
    discussion_stage: card.stage,
    text: variant === 'corrected' ? card.corrected_text : card.text,
    variant,
    depends_on: card.depends_on,
  };
}

/** 板の検査：4 枚、順 1〜4、カード 1 は fact_slip、カード 3 は framing_C に依存、訂正後の版に取り違えた文と値が出ない。 */
export function checkBoard(board: readonly BoardCard[], slipTerms: readonly string[]): string[] {
  const reasons: string[] = [];
  if (board.length !== 4 || new Set(board.map((c) => c.order)).size !== 4) reasons.push('board must have 4 cards with orders 1..4');
  if (board.find((c) => c.order === 1)?.depends_on !== 'fact_slip') reasons.push('board card 1 must depend on fact_slip');
  if (board.find((c) => c.order === 3)?.depends_on !== 'framing_C') reasons.push('board card 3 must depend on framing_C');
  for (const c of board) for (const t of slipTerms) if (t !== '' && c.corrected_text.includes(t)) reasons.push(`card ${c.order}: slip text in corrected_text`);
  return reasons;
}
