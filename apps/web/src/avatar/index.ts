/**
 * アバター（レーン H）。呼び出し側は dynamic import で runtime を読む（three を SSR に持ち込まない）。
 *   const { createAvatar } = await import('.../src/avatar/runtime');
 * 純粋な部品はここから読める。
 */
export * from './blink';
export * from './gaze';
export * from './idle';
export * from './mouth';
export * from './pose';
export { seededRng, type Rng } from './util';
export type { Avatar, AvatarModelInfo, AvatarOptions, AvatarTelemetry, Framing } from './runtime';
