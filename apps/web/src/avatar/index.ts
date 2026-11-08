/**
 * アバター（レーン H）。呼び出し側は dynamic import で runtime を読む（three を SSR に持ち込まない）。
 *   const { createAvatar } = await import('.../src/avatar/runtime');
 * 純粋な部品はここから読める。
 */
export * from './blink';
export * from './breath';
export * from './breath_morph';
export * from './face';
export * from './gaze';
export * from './idle';
export * from './lipsync';
export * from './mouth';
export * from './pose';
export * from './render_settings';
export * from './saccade';
export { seededRng, type Rng } from './util';
export type { Avatar, AvatarModelInfo, AvatarOptions, AvatarTelemetry, BreathMorphInfo, Framing } from './runtime';
