/**
 * 用途ごとの LLM を 1 回呼ぶ。時間切れ（timeout_ms）と呼び手の中止をまとめる。
 * プロバイダは再試行しない（gemini.ts の方針）。作り直しの回数は呼び手（生成器）が決めて記録する。
 * llm.request／llm.response はプロバイダが出す。
 */
import type { JsonValue, LlmMessage, LlmProvider, LlmPurpose } from '@llm-vap/contracts';

export interface LlmCallInput {
  request_id: string;
  purpose: LlmPurpose;
  system: string;
  messages: LlmMessage[];
  response_json_schema: JsonValue | null;
  timeout_ms: number;
  signal?: AbortSignal;
}

export type LlmCallResult =
  | { ok: true; text: string; latency_ms: number; first_text_ms: number | null; model: string }
  | { ok: false; reason: string; latency_ms: number | null; model: string };

export async function callLlm(llm: LlmProvider, input: LlmCallInput): Promise<LlmCallResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), input.timeout_ms);
  const onAbort = () => controller.abort(new Error('aborted'));
  if (input.signal?.aborted) controller.abort(new Error('aborted'));
  input.signal?.addEventListener('abort', onAbort, { once: true });
  const model = llm.model_version;
  try {
    const result = await llm.generate({
      request_id: input.request_id,
      purpose: input.purpose,
      system: input.system,
      messages: input.messages,
      response_json_schema: input.response_json_schema,
      transcript_revision: 0,
      signal: controller.signal,
    });
    const latency = Math.max(0, Math.round(result.received_at - result.sent_at));
    const first = result.first_text_at === undefined ? null : Math.max(0, Math.round(result.first_text_at - result.sent_at));
    if (result.text.trim() === '') return { ok: false, reason: `empty (${result.finish_reason.value ?? 'no finish reason'})`, latency_ms: latency, model: result.model_version };
    return { ok: true, text: result.text, latency_ms: latency, first_text_ms: first, model: result.model_version };
  } catch (error) {
    const reason = controller.signal.aborted
      ? input.signal?.aborted
        ? 'aborted'
        : 'timeout'
      : error instanceof Error
        ? error.message
        : String(error);
    return { ok: false, reason: reason.slice(0, 200) || 'error', latency_ms: null, model };
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', onAbort);
  }
}
