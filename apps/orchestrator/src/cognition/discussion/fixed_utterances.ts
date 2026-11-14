/**
 * 定型文（02 §2.4、06 §9.1 の fixed と acknowledgment）。設定から読み、話者と line_id を付けて返す。
 * 名前を含む定型文は条件の間で同じなので、そろえる対象から外す。受け止めには名前を入れない。
 */
import type { AiId, TwoAiCondition, TwoAiPhase, TwoAiSessionConfig } from '@llm-vap/contracts';
import { fillTemplate } from './text';

export interface FixedLine {
  ai_id: AiId;
  line_id: string;
  text: string;
}

export function fill(text: string, slots: Record<string, string>): string {
  return fillTemplate(text, slots).text;
}

export function ackTemplates(config: TwoAiSessionConfig): { template_id: string; text: string }[] {
  return config.acknowledgment.templates.map((t) => ({ template_id: t.id, text: t.text }));
}

/** 段の台詞。intake の終わり＝opening_two（A）、discussion の始め＝条件の教示（B）、discussion の終わり＝closing_two（A）。 */
export function phaseLine(config: TwoAiSessionConfig, condition: TwoAiCondition, phase: TwoAiPhase, edge: 'open' | 'close', slots: Record<string, string>): FixedLine | null {
  const l = config.fixed.lines;
  if (phase === 'intake' && edge === 'close') return { ai_id: 'A', line_id: 'opening_two', text: fill(l.opening_two, slots) };
  if (phase === 'discussion' && edge === 'open') return { ai_id: 'B', line_id: `opening_cond.${condition}`, text: fill(l.opening_cond[condition], slots) };
  if (phase === 'discussion' && edge === 'close') return { ai_id: 'A', line_id: 'closing_two', text: fill(l.closing_two, slots) };
  return null;
}

export function planFiller(config: TwoAiSessionConfig, index: 0 | 1): FixedLine | null {
  const text = config.fixed.lines.plan_fillers[index];
  if (text === undefined) return null;
  return { ai_id: index === 0 ? 'A' : 'B', line_id: `plan_fillers.${index}`, text };
}

export function closingQuestion(config: TwoAiSessionConfig): FixedLine {
  return { ai_id: config.speakers.closing, line_id: 'closing_question', text: config.fixed.lines.closing_question };
}

export function responseMore(config: TwoAiSessionConfig): FixedLine {
  return { ai_id: config.speakers.closing, line_id: 'response_more', text: config.fixed.lines.response_more };
}

export function pickLine(config: TwoAiSessionConfig, line: 'prompt' | 'confirm' | 'timeout'): FixedLine {
  const l = config.fixed.lines;
  const text = line === 'prompt' ? l.pick_prompt : line === 'confirm' ? l.pick_confirm : l.pick_timeout;
  return { ai_id: config.speakers.next_step, line_id: `pick_${line}`, text };
}

export function intakeFirstQuestion(config: TwoAiSessionConfig, slots: Record<string, string>): FixedLine {
  return { ai_id: config.speakers.intake, line_id: 'intake_first_question', text: fill(config.fixed.lines.intake_first_question, slots) };
}

export function coreReadback(config: TwoAiSessionConfig, core: string | null, slots: Record<string, string>): FixedLine {
  const l = config.fixed.lines;
  if (core === null) return { ai_id: config.speakers.intake, line_id: 'core_readback_no_core', text: fill(l.core_readback_no_core, slots) };
  return { ai_id: config.speakers.intake, line_id: 'core_readback', text: fill(l.core_readback, { ...slots, core: core.replace(/[。．.]+$/u, '') }) };
}
