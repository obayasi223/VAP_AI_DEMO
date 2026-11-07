/**
 * MaAI クライアントの組み立て（レーン J）。起動点（main.ts）と E2E で同じ設定を使う。
 */
import type { Policy, TimeSource } from '@llm-vap/contracts';
import { MaaiWorkerClient, buildMaaiConfigure, loadMaaiSessionConfig, realMaaiLaunch } from '../maai';
import type { MaaiVapPolicy } from '../maai';

/**
 * hri2025 の方策には vap と speech の節がない。ワーカーの発話判定の閾値は ja と同じ 0.5（TurnManager は使わない）、
 * is_ready の量は計画 §4.3 の【暫定】200ms。原著の値ではない。
 */
export const HRI2025_WORKER_VAP: MaaiVapPolicy = { channel_layout: '2ch', speaking_threshold: 0.5 };
export const HRI2025_IS_READY_BUFFER_MS = 200;

export function workerVapPolicy(policy: Policy): MaaiVapPolicy {
  return policy.policy_id === 'ja' ? policy.vap : HRI2025_WORKER_VAP;
}

export function isReadyBufferMs(policy: Policy): number {
  return policy.policy_id === 'ja' ? policy.speech.is_ready_buffer_ms : HRI2025_IS_READY_BUFFER_MS;
}

/**
 * 実 MaAI のワーカー（.venv の Python）。重みは取得済みのキャッシュから読む（HF_HUB_OFFLINE=1、版は worker_config.json）。
 * port を省くと MAAI_WORKER_URL のポート、0 なら空いているポートでワーカーが知らせるポートへつなぐ。
 */
export function createMaaiClient(input: { policy: Policy; time: TimeSource; env?: NodeJS.ProcessEnv; port?: number }): MaaiWorkerClient {
  const env = input.env ?? process.env;
  return new MaaiWorkerClient({
    launch: realMaaiLaunch({ env: { ...env, HF_HUB_OFFLINE: '1' }, ...(input.port === undefined ? {} : { port: input.port }) }),
    configure: buildMaaiConfigure(loadMaaiSessionConfig(), workerVapPolicy(input.policy)),
    time: input.time,
  });
}
