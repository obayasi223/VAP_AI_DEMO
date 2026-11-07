/**
 * Orchestrator の起動点（レーン J）。`npm run dev:orchestrator`（ルート）。
 *
 *  1. .env を読む（キーの値は表示しない）
 *  2. MaAI ワーカー（実 MaAI、.venv の Python）を先に起動して重みを読む。HF_HUB_OFFLINE=1 でネットに出ない
 *  3. HTTP／WS を待ち受ける。参加者の画面が「はじめる」を押すとセッションが始まる
 *  4. Ctrl+C で開いているセッションのログを閉じてから終わる
 */
import { SystemTimeSource } from '@llm-vap/contracts';
import { loadDotEnv, readConfig } from './app/config';
import { MaaiWorkerClient, buildMaaiConfigure, loadMaaiSessionConfig, realMaaiLaunch } from './maai';
import { OrchestratorServer, SwitchableTimeSource } from './ws/server';

export async function main(): Promise<OrchestratorServer> {
  const loaded = loadDotEnv();
  const config = readConfig();
  const say = (message: string) => console.log(`[orchestrator] ${message}`);
  say(`.env ${loaded ? 'loaded' : 'not found (using the environment only)'}; policy ${config.policy.policy_id} (${config.policy_file})`);
  say(`providers: STT=${config.stt} TTS=${config.tts} LLM=${config.llm}${config.stt !== 'production' || config.tts !== 'production' || config.llm !== 'production' ? '  ※ test_double は受け入れの証拠に数えない' : ''}`);

  const maaiTime = new SwitchableTimeSource(new SystemTimeSource());
  let maai: MaaiWorkerClient | null = null;
  let maaiUnavailableReason: string | undefined;
  if (config.maai_enabled) {
    try {
      const sessionConfig = loadMaaiSessionConfig();
      maai = new MaaiWorkerClient({
        // 重みは取得済みのキャッシュから読む。版は worker_config.json で固定。
        // MAAI_WORKER_URL が無ければ空いているポート（0）で起動し、ワーカーが知らせるポートへつなぐ。
        launch: realMaaiLaunch({ env: { ...process.env, HF_HUB_OFFLINE: '1' }, ...(process.env.MAAI_WORKER_URL ? {} : { port: 0 }) }),
        configure: buildMaaiConfigure(
          sessionConfig,
          // hri2025 には vap の節がない。ワーカーの判定の閾値は 0.5（ja の方策と同じ値）で、TurnManager は使わない。
          config.policy.policy_id === 'ja' ? config.policy.vap : { channel_layout: '2ch', speaking_threshold: 0.5 },
        ),
        time: maaiTime,
      });
      maai.subscribe({
        onAvailability: (a) => say(`MaAI worker: ${a.state}${a.reason ? ` (${a.reason})` : ''}`),
      });
      void maai.start(`boot-${Date.now()}`).then((a) => say(`MaAI first outcome: ${a.state}${a.reason ? ` (${a.reason})` : ''}`));
    } catch (error) {
      maaiUnavailableReason = `maai_launch_failed: ${error instanceof Error ? error.message : String(error)}`;
      say(maaiUnavailableReason);
      maai = null;
    }
  } else {
    maaiUnavailableReason = 'MAAI_ENABLED=0';
  }

  const server = new OrchestratorServer({ config, maai, maaiTime, ...(maaiUnavailableReason ? { maaiUnavailableReason } : {}) });
  const port = await server.listen();
  say(`listening on ${config.host}:${port}  (participant WS ws://localhost:${port}/ws, research ws://localhost:${port}/research, GET /health)`);
  say(`logs: ${config.sessions_dir}/<session_id>/events.jsonl`);

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    say(`${signal}: closing session logs and the MaAI worker`);
    void (async () => {
      await server.close().catch((error) => console.error(error));
      await maai?.stop('orchestrator_shutdown').catch(() => undefined);
      process.exit(0);
    })();
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  return server;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  void main().catch((error) => {
    console.error('[orchestrator] failed to start:', error);
    process.exit(1);
  });
}
