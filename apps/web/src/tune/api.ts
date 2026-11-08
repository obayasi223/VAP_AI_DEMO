/**
 * 開発用の HTTP の口（apps/orchestrator/src/dev/dev_server.ts、`npm run dev:tune`）の呼び出し。
 * 既定の宛先は http://127.0.0.1:8790。画面のクエリ ?dev=http://127.0.0.1:<port> で変えられる。
 */
import type { Policy, TunePolicyLeaf, TuneReplayResult, TuneSessionSummary } from '@llm-vap/contracts';

export const DEFAULT_DEV_URL = 'http://127.0.0.1:8790';
export const DEFAULT_LIVE_WS = 'ws://localhost:8787/research?tune=1';

export interface PolicyInfo {
  current: { file: string; policy: Policy };
  head: { policy: Policy | null; ref: string | null; error: string | null };
  local: { file: string; override: unknown; keys: string[]; policy: Policy | null; error: string | null } | null;
  leaves: TunePolicyLeaf[];
  local_file: string;
}

async function call<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base}${path}`, { ...init, cache: 'no-store' });
  // events.jsonl は application/x-ndjson（本文のまま返す）。JSON として読むのは application/json だけ。
  const body = res.headers.get('content-type')?.startsWith('application/json') ? await res.json() : await res.text();
  if (!res.ok) {
    const message = typeof body === 'object' && body !== null && 'error' in body ? String((body as { error: unknown }).error) : String(body);
    throw new Error(`${res.status}: ${message}`);
  }
  return body as T;
}

export function createDevApi(base: string) {
  return {
    base,
    sessions: () => call<TuneSessionSummary[]>(base, '/dev/sessions'),
    events: (id: string) => call<string>(base, `/dev/sessions/${encodeURIComponent(id)}/events`),
    policy: () => call<PolicyInfo>(base, '/dev/policy'),
    replay: (body: { session_id: string; policy: unknown; options?: { assumed_prepare_ms?: number; assumed_speech_ms?: number }; recorded_policy?: 'head' | 'current' }, signal?: AbortSignal) =>
      call<TuneReplayResult>(base, '/dev/replay', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      }),
    saveLocal: (policy: unknown) =>
      call<{ file: string; keys: string[]; override: unknown }>(base, '/dev/policy/local', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ policy }),
      }),
  };
}

export type DevApi = ReturnType<typeof createDevApi>;
