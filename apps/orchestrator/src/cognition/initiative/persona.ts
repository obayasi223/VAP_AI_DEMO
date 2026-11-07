/** AI の役割・関心・会話目的（計画 §3.1、§4.5）。config/persona.ja.json の形。 */
export interface InitiativePersona {
  persona_id: string;
  version: number;
  role: string;
  interests: string[];
  conversation_purpose: string;
  not_of_interest: string[];
}

export function parsePersona(raw: unknown): InitiativePersona {
  const o = raw as Partial<InitiativePersona> | null;
  const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
  const isTexts = (v: unknown): v is string[] => Array.isArray(v) && v.every(isText);
  if (
    !o ||
    !isText(o.persona_id) ||
    !Number.isInteger(o.version) ||
    !isText(o.role) ||
    !isTexts(o.interests) ||
    !isText(o.conversation_purpose) ||
    !isTexts(o.not_of_interest)
  ) {
    throw new Error('persona: persona_id, version, role, interests, conversation_purpose, not_of_interest are required');
  }
  return o as InitiativePersona;
}
