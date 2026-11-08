/**
 * 開発用の調整画面（/tune）の録音の再生の口を、orchestrator とは別のプロセスで起動する。`npm run dev:tune`。
 * MaAI、STT、LLM、TTS を開かない（キーも読まない）。参加者の経路（8787 の /ws）には触れない。
 *
 *   DEV_TUNE_PORT      既定 8790（127.0.0.1 のみで待ち受ける）
 *   ALLOWED_ORIGINS    画面の Origin（既定は orchestrator と同じ http://localhost:3000,http://127.0.0.1:3000）
 *   SESSIONS_DIR、POLICY_FILE、PERSONA_FILE は orchestrator と同じ既定
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT } from '../maai';
import { DevServer } from './dev_server';

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<DevServer> {
  const server = new DevServer({
    repo_root: REPO_ROOT,
    sessions_dir: path.resolve(REPO_ROOT, env.SESSIONS_DIR || 'sessions'),
    policy_file: env.POLICY_FILE || 'config/policy.ja.json',
    persona_file: env.PERSONA_FILE || 'config/persona.ja.json',
    allowed_origins: (env.ALLOWED_ORIGINS || 'http://localhost:3000,http://127.0.0.1:3000')
      .split(',')
      .map((o) => o.trim())
      .filter((o) => o !== ''),
    host: '127.0.0.1',
    port: Number(env.DEV_TUNE_PORT || 8790),
  });
  const port = await server.listen();
  console.log(`[dev] tune replay API on http://127.0.0.1:${port}/dev/sessions (sessions: ${path.resolve(REPO_ROOT, env.SESSIONS_DIR || 'sessions')})`);
  console.log('[dev] open the screen: http://localhost:3000/tune');
  const stop = () => void server.close().then(() => process.exit(0));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  void main().catch((error) => {
    console.error('[dev] failed to start:', error);
    process.exit(1);
  });
}
