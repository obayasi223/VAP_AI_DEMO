/**
 * 計画した点（02 §2.3）：文型の穴埋めと 2 版の凍結、文字数の帯の検査。
 * 引き金の評価（in_stage／after_turn は拍の数、at_sec／at_frac は中身の時計）は generator.ts の列が行う。
 */
import type { AiId, PlannedPointSpec, PointKind, TwoAiPointTemplates } from '@llm-vap/contracts';
import { charCount, fillTemplate, splitSentences } from './text';
import type { FrozenTurn, InferenceBlock, PointBlock } from './types';

/** 帯の許容（穴の値は LLM が書くので、帯の両端を 20% 広げて検査する）。 */
export const BAND_TOLERANCE = 0.2;
/** 訂正後の版の文字数は元の ±15% 以内（中身の時計をそろえる。02 §2.3）。 */
export const CORRECTED_TOLERANCE = 0.15;

export function frozenTurn(turn_key: string, speaker: AiId, text: string): FrozenTurn {
  return { turn_key, speaker, text, sentences: splitSentences(text), chars: charCount(text) };
}

export function otherAi(ai: AiId): AiId {
  return ai === 'A' ? 'B' : 'A';
}

export function inBand(chars: number, band: readonly [number, number], tolerance = BAND_TOLERANCE): boolean {
  return chars >= Math.floor(band[0] * (1 - tolerance)) && chars <= Math.ceil(band[1] * (1 + tolerance));
}

/** 文型の既定から台本の点を作る（台本がないとき。id は 02 §2.3 の表）。 */
export function defaultPointSpecs(templates: TwoAiPointTemplates): PlannedPointSpec[] {
  const ids: Record<PointKind, string> = { fact_slip: 'F1', control_inference: 'K1', framing_C: 'C1' };
  return templates.points.map((t) => ({
    id: ids[t.kind],
    kind: t.kind,
    speaker: t.default_speaker,
    trigger: t.default_trigger,
    elaborate_turns: t.elaborate_turns,
    source: 'generated' as const,
    turns: null,
    corrected_turns: null,
    uptake: null,
    slip: null,
    inference: null,
  }));
}

/** C の語を C.0 の文から取り出す（prepared の C。文型「むしろ〜なんじゃ」に合うときだけ）。 */
export function cTermsFromText(text: string): string[] {
  const m = /むしろ(.{2,30}?)(?:なんじゃ|ではない|じゃない|なのでは)/u.exec(text);
  return m ? [m[1]!] : [];
}

/** prepared の点をそのまま凍結する。 */
export function preparedPoint(spec: PlannedPointSpec): PointBlock {
  const turns = (spec.turns ?? []).map((t) => frozenTurn(t.turn_key, t.speaker, t.text));
  const corrected = (spec.corrected_turns ?? spec.turns ?? []).map((t) => frozenTurn(t.turn_key, t.speaker, t.text));
  const inference: InferenceBlock | null = spec.inference
    ? { ...spec.inference, steps: [spec.inference.steps[0], spec.inference.steps[1]] }
    : null;
  return {
    point_id: spec.id,
    kind: spec.kind,
    speaker: spec.speaker,
    trigger: spec.trigger,
    turns,
    corrected_turns: corrected,
    uptake: spec.uptake ? frozenTurn(spec.uptake.turn_key, spec.uptake.speaker, spec.uptake.text) : null,
    inference,
    slip: spec.slip ? { fact_id: spec.slip.fact_id, slip_statement: spec.slip.slip_statement, slip_value: spec.slip.slip_value, correct_statement: spec.slip.correct_statement } : null,
    c_terms: spec.kind === 'framing_C' && turns[0] ? cTermsFromText(turns[0].text) : [],
    slots: {},
    source: 'prepared',
    distance_rating: null,
  };
}

/**
 * generated の点を文型から作る。穴が埋まらない、帯に入らない、訂正後の版が ±15% を外れる、
 * 訂正後の版に取り違えた文と値が出る、のどれかなら reasons を返す（計画の不合格）。
 */
export function generatedPoint(
  spec: PlannedPointSpec,
  templates: TwoAiPointTemplates,
  slots: Record<string, string>,
  extra: { inference: InferenceBlock | null; slip: PointBlock['slip']; c_terms: string[]; distance: number | null },
): { ok: true; point: PointBlock } | { ok: false; reasons: string[] } {
  const template = templates.points.find((t) => t.kind === spec.kind);
  if (template === undefined) return { ok: false, reasons: [`${spec.id}: no point template for ${spec.kind}`] };
  const reasons: string[] = [];
  const turns: FrozenTurn[] = [];
  const corrected: FrozenTurn[] = [];
  for (const t of template.turns) {
    const speaker = t.role === 'speaker' ? spec.speaker : otherAi(spec.speaker);
    const a = fillTemplate(t.template, slots);
    const b = fillTemplate(t.corrected_template, slots);
    if (a.missing.length > 0 || b.missing.length > 0) {
      reasons.push(`${spec.id} ${t.turn_key}: missing slots ${[...new Set([...a.missing, ...b.missing])].join(',')}`);
      continue;
    }
    const fa = frozenTurn(t.turn_key, speaker, a.text);
    const fb = frozenTurn(t.turn_key, speaker, b.text);
    if (!inBand(fa.chars, t.target_chars)) reasons.push(`${spec.id} ${t.turn_key}: ${fa.chars} chars outside ${t.target_chars.join('-')}`);
    if (Math.abs(fb.chars - fa.chars) > fa.chars * CORRECTED_TOLERANCE) {
      reasons.push(`${spec.id} ${t.turn_key}: corrected ${fb.chars} chars not within ±15% of ${fa.chars}`);
    }
    turns.push(fa);
    corrected.push(fb);
  }
  let uptake: FrozenTurn | null = null;
  if (template.uptake_template !== null && spec.kind === 'fact_slip') {
    const u = fillTemplate(template.uptake_template, slots);
    if (u.missing.length > 0) reasons.push(`${spec.id} uptake: missing slots ${u.missing.join(',')}`);
    else uptake = frozenTurn(`${turns[0]?.turn_key.split('.')[0] ?? 'F'}.uptake`, spec.speaker, u.text);
  }
  if (extra.slip !== null) {
    // 訂正後の版（使われない F.0 を除く）と uptake に、取り違えた文と値が出ない
    const after = [...corrected.slice(1), ...(uptake ? [uptake] : [])];
    for (const t of after) {
      if (t.text.includes(extra.slip.slip_value) || t.text.includes(extra.slip.slip_statement)) reasons.push(`${spec.id} ${t.turn_key}: slip text in corrected version`);
    }
  }
  if (reasons.length > 0) return { ok: false, reasons };
  return {
    ok: true,
    point: {
      point_id: spec.id,
      kind: spec.kind,
      speaker: spec.speaker,
      trigger: spec.trigger,
      turns,
      corrected_turns: corrected,
      uptake,
      inference: extra.inference,
      slip: extra.slip,
      c_terms: extra.c_terms,
      slots,
      source: 'generated',
      distance_rating: extra.distance === null ? null : { value: extra.distance, by: 'llm_self' },
    },
  };
}

/** 点のブロックの見込みの長さ（ms。2 版の長い方）。 */
export function blockMs(point: PointBlock, charsPerSec: number): number {
  const sum = (ts: FrozenTurn[]) => ts.reduce((s, t) => s + t.chars, 0);
  return Math.round((Math.max(sum(point.turns), sum(point.corrected_turns)) / charsPerSec) * 1000);
}
