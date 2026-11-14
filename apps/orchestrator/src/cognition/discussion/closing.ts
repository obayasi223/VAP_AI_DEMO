/**
 * 最後の段（作り直しの凍結文）と当日の撤回の文（02 §2.8、§2.9）。LLM を使わない。
 * 作り直しは訂正の有無と条件に関係なく、訂正後の板を読む同じ文。
 * 撤回の文は end で inference_form を決めて 3 文にする（元の推論を話した回は inference、話していない回は inference_unspoken）。
 */
import type { AiId, RetractionSpec, TwoAiPointTemplates, TwoAiScript, TwoAiSessionConfig } from '@llm-vap/contracts';
import { frozenTurn, otherAi } from './points';
import { fillTemplate, sha256 } from './text';
import type { BoardCard, FrozenTurn, PointBlock } from './types';

export function rebuildFromScript(turns: NonNullable<TwoAiScript['rebuild_turns']>): FrozenTurn[] {
  return turns.map((t) => frozenTurn(t.turn_key, t.speaker, t.text));
}

/** 文型の穴 {card_1}〜{card_4} に訂正後の板の文を入れる。文末の「。」の重なりは 1 つにする。 */
export function rebuildFromTemplates(templates: TwoAiPointTemplates, board: readonly BoardCard[], closingSpeaker: AiId): { ok: true; turns: FrozenTurn[] } | { ok: false; reasons: string[] } {
  const slots: Record<string, string> = {};
  for (const c of board) slots[`card_${c.order}`] = c.corrected_text.replace(/[。．.]+$/u, '');
  const reasons: string[] = [];
  const turns: FrozenTurn[] = [];
  for (const t of templates.rebuild_templates) {
    const f = fillTemplate(t.template, slots);
    if (f.missing.length > 0) {
      reasons.push(`rebuild ${t.turn_key}: missing ${f.missing.join(',')}`);
      continue;
    }
    turns.push(frozenTurn(t.turn_key, t.role === 'closing_speaker' ? closingSpeaker : otherAi(closingSpeaker), f.text));
  }
  return reasons.length > 0 ? { ok: false, reasons } : { ok: true, turns };
}

export function rebuildFromOutline(lines: readonly string[], closingSpeaker: AiId): FrozenTurn[] {
  return lines.map((text, i) => frozenTurn(`R.${i}`, i === 0 ? closingSpeaker : otherAi(closingSpeaker), text));
}

/**
 * 撤回の文の穴を埋める（計画の凍結で 1 回）。fact_slip がなければ null（過程の説明だけを言う）。
 * 穴：{slip_statement}、{correct_statement}、{inference_steps}、{inference_conclusion}。
 */
export function fillRetraction(
  template: RetractionSpec,
  point: PointBlock | null,
): { ok: true; spec: RetractionSpec | null } | { ok: false; reasons: string[] } {
  if (point === null || point.slip === null) return { ok: true, spec: null };
  const slots = {
    slip_statement: point.slip.slip_statement,
    correct_statement: point.slip.correct_statement,
    inference_steps: point.inference ? point.inference.steps.join('、') : '',
    inference_conclusion: point.inference?.conclusion ?? '',
  };
  const out: Partial<RetractionSpec> = {};
  const reasons: string[] = [];
  for (const key of ['fact', 'inference', 'inference_unspoken', 'process'] as const) {
    const f = fillTemplate(template[key], slots);
    if (f.missing.length > 0) reasons.push(`retraction ${key}: missing ${f.missing.join(',')}`);
    out[key] = f.text;
  }
  return reasons.length > 0 ? { ok: false, reasons } : { ok: true, spec: out as RetractionSpec };
}

export function retractionTemplate(script: TwoAiScript | null, config: TwoAiSessionConfig): RetractionSpec {
  return script?.retraction ?? config.retraction.template;
}

/** 撤回の文（end で確定）。lines の sha256 は manifest と two_ai.retraction の照合に使う。 */
export function retractionLines(input: {
  spec: RetractionSpec | null;
  process: string;
  speaker: AiId;
  form: 'spoken' | 'not_spoken' | 'none';
}): { lines: { ai_id: AiId; text: string }[]; sha256: string } {
  const texts =
    input.spec === null || input.form === 'none'
      ? [input.process]
      : [input.spec.fact, input.form === 'spoken' ? input.spec.inference : input.spec.inference_unspoken, input.spec.process];
  const lines = texts.map((text) => ({ ai_id: input.speaker, text }));
  // 06 §4.3：行の text を改行でつないだ sha256（要約の道具が lines から照合する）。
  return { lines, sha256: sha256(lines.map((l) => l.text).join('\n')) };
}
