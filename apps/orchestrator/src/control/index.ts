/** 制御（E1）。J の入口は createTurnManager と userTextFor。 */
export { createTurnManager, turnGptTimeout, userTextFor } from './turn_manager';
export { INVITATION_RULES, NO_INVITATION, detectInvitation } from './invitation';
export { judgeGaze } from './gaze';
export { prepareTrigger, similarityGate } from './prepare';
export { HRI2025_P_AI_INDEX, readVap, vapDirectionSettings } from './vap_direction';
export { assessVapFreshness } from './vap_freshness';
export { START_ACK_TIMEOUT_MS, controlSettings } from './settings';
export { createInitialState } from './state';
export type { ControlOptions, ControlSettings, GazeSettings, YieldTimeout } from './settings';
export type { Speaking, TurnState, WantToSpeak } from './state';
export type { VapDirectionSettings, VapView } from './vap_direction';
export type { GazeJudgement } from './gaze';
export type { SimilarityGate } from './prepare';
