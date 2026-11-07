/**
 * orchestrator の入口の置き場（レーン F の雛形）。
 * WS サーバーと配線の本体はレーン J が src/server.ts と src/session/ に作る。
 * ここでは起動しても何も待ち受けず、未実装であることを正直に表示して終わる。
 */
import { CONTRACTS_VERSION } from '@llm-vap/contracts';
import { WebSocketServer } from 'ws';

export const ORCHESTRATOR_NOT_WIRED = true as const;

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  console.log(
    `[orchestrator] not wired yet (contracts v${CONTRACTS_VERSION}, ws ${typeof WebSocketServer}). レーン J が実装する。`,
  );
}
