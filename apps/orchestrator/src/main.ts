/**
 * Orchestrator の起動点（レーン J）。`npm run dev:orchestrator`（ルート）。
 *
 *  1. .env を読む（キーの値は表示しない）
 *  1b. 読みの辞書（kuromoji）を読む（口形の読み、TTS の読みの変換。speech/reading/runtime.ts）
 *  2. MaAI ワーカー（実 MaAI、.venv の Python）を先に起動して重みを読む。HF_HUB_OFFLINE=1 でネットに出ない
 *  3. HTTP／WS を待ち受ける。参加者の画面が「はじめる」を押すとセッションが始まる
 *  4. Ctrl+C で開いているセッションのログを閉じてから終わる
 */
import { SystemTimeSource } from '@llm-vap/contracts';
import { loadDotEnv, readConfig } from './app/config';
import type { MaaiWorkerClient } from './maai';
import { createMaaiClient } from './app/maai_setup';
import { OrchestratorServer, SwitchableTimeSource } from './ws/server';
import { initReading } from './speech/reading';

export async function main(): Promise<OrchestratorServer> {
  const loaded = loadDotEnv();
  const config = readConfig();
  const say = (message: string) => console.log(`[orchestrator] ${message}`);
  say(`.env ${loaded ? 'loaded' : 'not found (using the environment only)'}; policy ${config.policy.policy_id} (${config.policy_file})`);
  say(`providers: STT=${config.stt} TTS=${config.tts} LLM=${config.llm}${config.stt !== 'production' || config.tts !== 'production' || config.llm !== 'production' ? '  ※ test_double は受け入れの証拠に数えない' : ''}`);

  // 応答の前に辞書を読み込む（1回だけ、0.7 秒前後）。失敗しても起動は続け、口形は従来どおりになる。
  const reading = await initReading();
  say(
    `reading: lip=${reading.config.lip ? 'on' : 'off'} tts_mode=${reading.config.tts_mode} ` +
      (reading.error
        ? `analyzer unavailable (${reading.error})`
        : reading.analyzer
          ? `${reading.analyzer} loaded in ${reading.load_ms?.toFixed(0)} ms (sample sentence ${reading.sample_tokenize_ms?.toFixed(2)} ms)`
          : 'analyzer not loaded'),
  );

  const maaiTime = new SwitchableTimeSource(new SystemTimeSource());
  let maai: MaaiWorkerClient | null = null;
  let maaiUnavailableReason: string | undefined;
  if (config.maai_enabled) {
    try {
      // MAAI_WORKER_URL が無ければ空いているポート（0）で起動し、ワーカーが知らせるポートへつなぐ。
      maai = createMaaiClient({ policy: config.policy, time: maaiTime, ...(process.env.MAAI_WORKER_URL ? {} : { port: 0 }) });
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
