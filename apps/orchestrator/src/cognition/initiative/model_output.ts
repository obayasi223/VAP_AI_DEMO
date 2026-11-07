/**
 * InitiativeMonitor の structured output の形と、受け取った JSON の検証（仕様 §4、追補2）。
 *
 * 項目の順は意味がある: 説明の項目を decision より前に置き、検討してから結論を書かせる。
 * reason／why_now／cost_of_waiting／resolution_outlook はログと研究者の評価のためのモデル出力で、
 * ゲートの判定には使わない（追補1）。candidate_id は LLM に作らせない。
 * target_candidate_id は入力で示した既存の候補を指すだけで、実在をコードが確かめる。
 */
import type { InitiativeDecisionKind } from '@llm-vap/contracts';

export const DECISIONS = ['NONE', 'NEW', 'KEEP', 'REVISE', 'WITHDRAW'] as const;

export const INITIATIVE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    reason: { type: 'string', description: '話の内容に照らした検討。入力にある語で書く。' },
    why_now: { type: 'string', description: '話し終わりを待たず今申し出る理由の検討。なければ空。' },
    cost_of_waiting: { type: 'string', description: '話し終わりまで待った場合の具体的な不利益の見込み。なければ空。' },
    resolution_outlook: { type: 'string', description: '話者がこの後、自分で説明や修正をしそうかの見込み。' },
    decision: { type: 'string', enum: [...DECISIONS] },
    target_candidate_id: { type: 'string', description: 'KEEP、REVISE、WITHDRAW で対象の候補の ID。他は空。' },
    intent_type: { type: 'string', description: 'CLARIFICATION、OBJECTION、PROPOSAL など。NEW、REVISE 以外は空。' },
    evidence_span: { type: 'string', description: '安定テキストからそのまま抜き出した根拠。NEW、REVISE 以外は空。' },
    evidence_segment_ids: { type: 'array', items: { type: 'integer' }, description: 'evidence_span を含む区間の番号。' },
    proposed_utterance: { type: 'string', description: 'AI が話すとしたら言う一言。NEW、REVISE 以外は空。' },
    expiry_policy: { type: 'string', description: '通常は RECHECK_ON_NEW_INFORMATION。NEW、REVISE 以外は空。' },
    urgency: { type: 'string', description: 'LOW、NORMAL、HIGH のいずれか。NEW、REVISE 以外は空。' },
    withdraw_reason: { type: 'string', description: 'WITHDRAW の理由。他は空。' },
    withdraw_evidence_span: { type: 'string', description: 'WITHDRAW の根拠になった後続の発話を、そのまま抜き出す。他は空。' },
    withdraw_evidence_segment_ids: { type: 'array', items: { type: 'integer' }, description: 'withdraw_evidence_span を含む区間の番号。' },
  },
  required: [
    'reason',
    'why_now',
    'cost_of_waiting',
    'resolution_outlook',
    'decision',
    'target_candidate_id',
    'intent_type',
    'evidence_span',
    'evidence_segment_ids',
    'proposed_utterance',
    'expiry_policy',
    'urgency',
    'withdraw_reason',
    'withdraw_evidence_span',
    'withdraw_evidence_segment_ids',
  ],
};

export interface InitiativeModelOutput {
  decision: InitiativeDecisionKind;
  reason: string;
  why_now: string;
  cost_of_waiting: string;
  resolution_outlook: string;
  target_candidate_id: string;
  intent_type: string;
  evidence_span: string;
  evidence_segment_ids: number[];
  proposed_utterance: string;
  expiry_policy: string;
  urgency: string;
  withdraw_reason: string;
  withdraw_evidence_span: string;
  withdraw_evidence_segment_ids: number[];
}

export type ParseResult =
  | { ok: true; output: InitiativeModelOutput }
  | { ok: false; reason: string };

const asString = (value: unknown): string => (typeof value === 'string' ? value : '');
const asIds = (value: unknown): number[] =>
  Array.isArray(value) ? value.filter((v): v is number => Number.isInteger(v)) : [];

/** 列挙値は NONE/NEW/KEEP/REVISE/WITHDRAW のみ。それ以外（NO_INTENT、CLARIFY など）は不合格にする。 */
export function parseModelOutput(text: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'model_output_not_json' };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: 'model_output_not_object' };
  }
  const o = raw as Record<string, unknown>;
  const decision = o.decision;
  if (typeof decision !== 'string' || !(DECISIONS as readonly string[]).includes(decision)) {
    return { ok: false, reason: 'model_output_unknown_decision' };
  }
  return {
    ok: true,
    output: {
      decision: decision as InitiativeDecisionKind,
      reason: asString(o.reason),
      why_now: asString(o.why_now),
      cost_of_waiting: asString(o.cost_of_waiting),
      resolution_outlook: asString(o.resolution_outlook),
      target_candidate_id: asString(o.target_candidate_id),
      intent_type: asString(o.intent_type),
      evidence_span: asString(o.evidence_span),
      evidence_segment_ids: asIds(o.evidence_segment_ids),
      proposed_utterance: asString(o.proposed_utterance),
      expiry_policy: asString(o.expiry_policy),
      urgency: asString(o.urgency),
      withdraw_reason: asString(o.withdraw_reason),
      withdraw_evidence_span: asString(o.withdraw_evidence_span),
      withdraw_evidence_segment_ids: asIds(o.withdraw_evidence_segment_ids),
    },
  };
}
