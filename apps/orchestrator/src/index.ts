/**
 * orchestrator の公開入口。起動は src/main.ts（`npm run dev:orchestrator`）。
 */
export { main } from './main';
export { OrchestratorServer, SwitchableTimeSource } from './ws/server';
export { Session } from './session/session';
export { SessionHistory } from './session/history';

/** 雛形の印。配線は済んだので false（scaffold.test.ts を更新）。 */
export const ORCHESTRATOR_NOT_WIRED = false as const;
