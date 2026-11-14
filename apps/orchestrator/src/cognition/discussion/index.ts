/**
 * 02（話し合いの生成）の公開する口。01 の TwoAiSession は createDiscussionContent で DiscussionContent を作る。
 * 配線（llmFor、emitter、設定と台本の読み込み）は WP1 の two_ai_session.ts が行う。
 */
export { DiscussionGenerator, createDiscussionContent, type DiscussionContentDeps } from './generator';
export { loadDiscussionAssets, type DiscussionAssets } from './assets';
export { loadSafetyLists, checkText, safeLedger, type SafetyLists } from './safety';
export { PLAN_PROMPT_VERSION } from './plan';
export { TURN_PROMPT_VERSION, TURN_FEED_PROMPT_VERSION } from './turn_prompt';
export { LEDGER_PROMPT_VERSION } from './ledger';
export { INTAKE_PROMPT_VERSION } from './intake';
export { CORRECTION_PROMPT_VERSION } from './correction_assist';
export type { DiscussionPlan, ProblemLedger, PointBlock, BoardCard, Beat } from './types';
