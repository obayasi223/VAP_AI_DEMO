/**
 * 生成段とタイミング段の出力の形（docs/initiative_v3_design.md）。
 * 説明の項目を判定より前に置き、検討してから結論を書かせる（model_output.ts と同じ）。
 * 説明の項目はログと研究者の評価のためのモデル出力で、ゲートと制御は読まない。
 */
import { ContentWithdrawKind } from '@llm-vap/contracts';

export const CONTENT_WITHDRAW_KINDS = ContentWithdrawKind.options;

export const DESIRES = ['NONE', 'NEW', 'KEEP', 'REVISE', 'WITHDRAW'] as const;
export type DesireKind = (typeof DESIRES)[number];

export const DESIRE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    reason: { type: 'string', description: '言いたいことが生じたかの検討。入力にある語で書く。' },
    desire: { type: 'string', enum: [...DESIRES] },
    target_candidate_id: { type: 'string', description: 'KEEP／REVISE／WITHDRAW で対象の希望の ID。他は空。' },
    intent_type: { type: 'string', description: '意図の種類（短い英大文字）。NEW と REVISE 以外は空。' },
    proposed_utterance: { type: 'string', description: '言いたい内容を、話し言葉で短く書く。NEW と REVISE 以外は空。' },
    evidence_span: { type: 'string', description: '今の発話（# の区間）からそのまま抜き出した根拠。NEW と REVISE 以外は空。' },
    evidence_segment_ids: { type: 'array', items: { type: 'integer' }, description: 'evidence_span を含む区間の番号。' },
    prior_turn_evidence_span: { type: 'string', description: '過去のターンから抜き出した根拠の一部。なければ空。' },
    withdraw_kind: { type: 'string', enum: ['', ...CONTENT_WITHDRAW_KINDS], description: 'WITHDRAW の分類。他は空。' },
    withdraw_reason: { type: 'string', description: 'WITHDRAW の理由。他は空。' },
    withdraw_evidence_span: { type: 'string', description: 'WITHDRAW の根拠になった発話をそのまま抜き出す。他は空。' },
    withdraw_evidence_segment_ids: { type: 'array', items: { type: 'integer' }, description: 'withdraw_evidence_span を含む区間の番号。AI の発話を根拠にしたときは空。' },
  },
  required: ['reason', 'desire', 'target_candidate_id', 'intent_type', 'proposed_utterance', 'evidence_span', 'evidence_segment_ids', 'prior_turn_evidence_span', 'withdraw_kind', 'withdraw_reason', 'withdraw_evidence_span', 'withdraw_evidence_segment_ids'],
};

export interface DesireOutput {
  reason: string;
  desire: DesireKind;
  target_candidate_id: string;
  intent_type: string;
  proposed_utterance: string;
  evidence_span: string;
  evidence_segment_ids: number[];
  prior_turn_evidence_span: string;
  withdraw_kind: string;
  withdraw_reason: string;
  withdraw_evidence_span: string;
  withdraw_evidence_segment_ids: number[];
}

/** 現在のタイミング段が出す値。WITHDRAW は出さない（撤回は生成段。「今は言わない」と分ける）。 */
export const TIMINGS = ['OFFER_NOW', 'WAIT_FOR_TURN_END'] as const;
export type TimingChoice = (typeof TIMINGS)[number];

export const TIMING_JSON_SCHEMA = {
  type: 'object',
  properties: {
    reason: { type: 'string', description: '判定の検討。入力にある語で書く。' },
    why_now: { type: 'string', description: '話し終わりを待たず今申し出る理由の検討。なければ空。' },
    cost_of_waiting: { type: 'string', description: '話し終わりまで待った場合の具体的な不利益の見込み。なければ空。' },
    timing: { type: 'string', enum: [...TIMINGS] },
    target_candidate_id: { type: 'string', description: '判定した希望の ID。' },
  },
  required: ['reason', 'why_now', 'cost_of_waiting', 'timing', 'target_candidate_id'],
};

export interface TimingOutput {
  reason: string;
  why_now: string;
  cost_of_waiting: string;
  timing: TimingChoice;
  target_candidate_id: string;
}

export type StageParseResult<T> = { ok: true; output: T } | { ok: false; reason: string };

const asString = (value: unknown): string => (typeof value === 'string' ? value : '');
const asIds = (value: unknown): number[] =>
  Array.isArray(value) ? value.filter((v): v is number => Number.isInteger(v)) : [];

function parseObject(text: string, stage: string): { ok: true; o: Record<string, unknown> } | { ok: false; reason: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: `${stage}_model_output_not_json` };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: `${stage}_model_output_not_object` };
  }
  return { ok: true, o: raw as Record<string, unknown> };
}

export function parseDesireOutput(text: string): StageParseResult<DesireOutput> {
  const object = parseObject(text, 'desire');
  if (!object.ok) return object;
  const o = object.o;
  if (typeof o.desire !== 'string' || !(DESIRES as readonly string[]).includes(o.desire)) {
    return { ok: false, reason: 'desire_model_output_unknown_kind' };
  }
  return {
    ok: true,
    output: {
      reason: asString(o.reason),
      desire: o.desire as DesireKind,
      target_candidate_id: asString(o.target_candidate_id),
      intent_type: asString(o.intent_type),
      proposed_utterance: asString(o.proposed_utterance),
      evidence_span: asString(o.evidence_span),
      evidence_segment_ids: asIds(o.evidence_segment_ids),
      prior_turn_evidence_span: asString(o.prior_turn_evidence_span),
      withdraw_kind: asString(o.withdraw_kind),
      withdraw_reason: asString(o.withdraw_reason),
      withdraw_evidence_span: asString(o.withdraw_evidence_span),
      withdraw_evidence_segment_ids: asIds(o.withdraw_evidence_segment_ids),
    },
  };
}

export function parseTimingOutput(text: string): StageParseResult<TimingOutput> {
  const object = parseObject(text, 'timing');
  if (!object.ok) return object;
  const o = object.o;
  if (typeof o.timing !== 'string' || !(TIMINGS as readonly string[]).includes(o.timing)) {
    return { ok: false, reason: 'timing_model_output_unknown_verdict' };
  }
  return {
    ok: true,
    output: {
      reason: asString(o.reason),
      why_now: asString(o.why_now),
      cost_of_waiting: asString(o.cost_of_waiting),
      timing: o.timing as TimingChoice,
      target_candidate_id: asString(o.target_candidate_id),
    },
  };
}
