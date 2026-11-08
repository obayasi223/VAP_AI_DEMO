/**
 * 会話の種類（docs/initiative_v3_design.md）。config/conversation_kind.<id>.ja.json の形で、<id> がそのまま種類の ID。
 * 種類を増やすのはファイルを足すだけで、コードの変更は要らない。persona の項目に、段ごとの観点と判定の条件を足したもの。
 * 生成の条件（desire_lens）とタイミングの条件（timing_lens）は別々に編集する。どれも暫定の出発点で、特定の議題の語を入れない。
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
    /** 生成の条件（判定の基準）。プロンプトの本体ではなくここで編集する。 */
    conditions: string[];
  };
  timing_lens: {
    viewpoints: string[];
    /** タイミングの条件。生成の条件とは別に編集する。 */
    conditions: string[];
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
    !isTexts(o.desire_lens?.conditions) ||
    !isTexts(o.timing_lens?.viewpoints) ||
    !isTexts(o.timing_lens?.conditions)
  ) {
    throw new Error('conversation_kind: conversation_kind, profile_version, provisional_note, desire_lens (viewpoints, intent_type_examples, conditions), timing_lens (viewpoints, conditions) are required');
  }
  return { ...persona, ...(o as ConversationKindProfile), conversation_kind: kind.data };
}
