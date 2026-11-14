/** 2 体の AI の話し合いモード（docs/design/two_ai）。WP1 の部品の入口。 */
export { TwoAiSession } from './two_ai_session';
export type { TwoAiSessionOptions } from './two_ai_session';
export { loadTwoAiSettings, checkScript, DEFAULT_TWO_AI_CONFIG, TWO_AI_SCRIPTS_DIR } from './settings';
export type { LoadedScript, TwoAiSettings, TwoAiSettingsResult } from './settings';
export { redactForResearch } from './research_redaction';
export type { RedactionPolicy } from './research_redaction';
export { scopedEmitter, emitScoped } from './scoped_emitter';
export { createAckBank } from './ack_bank';
export type { AckBank } from './ack_bank';
export { AiSlot } from './ai_slot';
export { createDirector } from './director';
export { admitWoz } from './woz';
