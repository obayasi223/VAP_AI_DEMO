// 発話希望の評価画面を 127.0.0.1 で開く。使い方は docs/runbook.md の 8。
//   npm run review:initiative -- [--port 8791] [--sessions sessions]
import path from 'node:path';
import { parseArgs } from 'node:util';
import { ReviewServer } from './lib/server';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '8791' },
    sessions: { type: 'string', default: path.join(REPO_ROOT, 'sessions') },
  },
});

const port = Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error('--port が不正です');
  process.exit(2);
}

const server = new ReviewServer({ sessions_dir: path.resolve(values.sessions), port });
try {
  const actual = await server.listen();
  console.log(`[initiative_review] http://127.0.0.1:${actual}/ （止めるときは Ctrl+C）`);
} catch (error) {
  console.error(`開けません: ${error instanceof Error ? error.message : String(error)}（--port で別の番号を指定できます）`);
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void server.close().then(() => process.exit(0));
  });
}
