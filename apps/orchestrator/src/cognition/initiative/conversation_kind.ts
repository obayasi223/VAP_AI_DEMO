/**
 * 会話の種類（共同思考、コンパニオン。docs/initiative_v3_design.md）。
 * config/conversation_kind.*.ja.json の形。persona の項目に、段ごとの観点を足したもの。
 * 観点と意図の種類の例はどれも暫定の出発点で、特定の議題の語を入れない。
 */
import { ConversationKind } from '@llm-vap/contracts';
import { parsePersona } from './persona';
import type { InitiativePersona } from './persona';

export interface ConversationKindProfile extends InitiativePersona {
  conversation_kind: ConversationKind;
  profile_version: number;
  provisional_note: string;
  desire_lens: {
    viewpoints: string[];
    intent_type_examples: string[];
  };
  timing_lens: {
    viewpoints: string[];
  };
}

const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isTexts = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.every(isText);

export function parseConversationKindProfile(raw: unknown): ConversationKindProfile {
  const persona = parsePersona(raw);
  const o = raw as Partial<ConversationKindProfile>;
  const kind = ConversationKind.safeParse(o.conversation_kind);
  if (
    !kind.success ||
    !Number.isInteger(o.profile_version) ||
    !isText(o.provisional_note) ||
    !isTexts(o.desire_lens?.viewpoints) ||
    !isTexts(o.desire_lens?.intent_type_examples) ||
    !isTexts(o.timing_lens?.viewpoints)
  ) {
    throw new Error('conversation_kind: conversation_kind, profile_version, provisional_note, desire_lens, timing_lens are required');
  }
  return { ...persona, ...(o as ConversationKindProfile), conversation_kind: kind.data };
}
