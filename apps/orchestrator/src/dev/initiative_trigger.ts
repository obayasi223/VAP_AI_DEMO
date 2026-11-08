/**
 * 発話希望の判定の「起動の回数」だけを、記録の STT から数え直す（/tune）。LLM は呼ばない。
 *
 * 本物の InitiativeMonitor（session と同じ InitiativeWiring）に記録の stt.* を記録の時刻で流し、LLM の代わりに
 * 「NONE を返す代役」を置く。代役の応答までの時間は、記録の initiative の llm.request→llm.response の遅れを
 * 順に使い（足りなければ中央値）、実行中に来た増分は終わった後の1回にまとめる規則（monitor）もそのまま効く。
 * **判定の結果（NEW などが出たか）は分からない。** NONE 以外が出ると候補の撤回の判定が増えるので、記録と回数が
 * ずれうる（記録の起動条件での数え直しが記録と一致するかで確かめる）。
 */
import { ManualTimeSource, MemoryEventSink, createEventEmitter } from '@llm-vap/contracts';
import type { LlmProvider, LlmRequest, LlmResult, PolicyJa, ResearchEvent, TuneInitiativeCount } from '@llm-vap/contracts';
import type { InitiativePersona } from '../cognition/initiative';
import { InitiativeWiring } from '../session/initiative_wiring';

const NONE_OUTPUT = JSON.stringify({
  reason: '',
  why_now: '',
  cost_of_waiting: '',
  resolution_outlook: '',
  decision: 'NONE',
  target_candidate_id: '',
  intent_type: '',
  evidence_span: '',
  evidence_segment_ids: [],
  proposed_utterance: '',
  expiry_policy: '',
  urgency: '',
  withdraw_reason: '',
  withdraw_evidence_span: '',
  withdraw_evidence_segment_ids: [],
});

interface Pending {
  due: number;
  resolve: (result: LlmResult) => void;
  request: LlmRequest;
  sent_at: number;
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export function recordedInitiativeLatencies(events: ResearchEvent[]): number[] {
  const sent = new Map<string, number>();
  const out: number[] = [];
  for (const e of events) {
    if (e.event === 'llm.request' && e.purpose === 'initiative') sent.set(e.request_id, e.sent_at);
    if (e.event === 'llm.response' && e.purpose === 'initiative') {
      const at = sent.get(e.request_id);
      if (at !== undefined) out.push(e.received_at - at);
    }
  }
  return out;
}

/** 起動の回数を数える。policy の initiative 節（trigger を含む）の値で InitiativeMonitor を作る。 */
export async function countInitiativeRuns(
  events: ResearchEvent[],
  policy: PolicyJa,
  persona: InitiativePersona,
  latencies: number[],
): Promise<{ count: number; sent_at: number[] }> {
  const stt = events.filter((e) => e.event === 'stt.interim' || e.event === 'stt.final');
  const t0 = stt[0]?.t_monotonic_ms ?? 0;
  const time = new ManualTimeSource(t0);
  const sink = new MemoryEventSink();
  const emitter = createEventEmitter({ time, session_id: 'tune_replay', condition: () => 'reactive', sink });
  const sorted = [...latencies].sort((a, b) => a - b);
  const median = sorted.length === 0 ? 1000 : (sorted[sorted.length >> 1] as number);
  const pending: Pending[] = [];
  const sentAt: number[] = [];
  const llm: LlmProvider = {
    provider: 'tune_replay_stub',
    model_version: 'tune_replay_stub',
    provider_class: 'test_double',
    generate(request) {
      const index = sentAt.length;
      const now = time.monotonicMs();
      sentAt.push(now);
      const latency = latencies[index] ?? median;
      return new Promise<LlmResult>((resolve) => pending.push({ due: now + latency, resolve, request, sent_at: now }));
    },
    stream() {
      throw new Error('stream is not used by the initiative monitor');
    },
  };
  const wiring = new InitiativeWiring({ llm, persona, policy, emitter, time, speech: () => null });
  const advanceTo = async (t: number) => {
    for (;;) {
      pending.sort((a, b) => a.due - b.due);
      const next = pending[0];
      if (next === undefined || next.due > t) break;
      pending.shift();
      if (next.due > time.monotonicMs()) time.set(next.due);
      next.resolve({
        request_id: next.request.request_id,
        purpose: next.request.purpose,
        text: NONE_OUTPUT,
        model_version: 'tune_replay_stub',
        sent_at: next.sent_at,
        received_at: next.due,
        finish_reason: { value: 'STOP' },
        usage: { input_tokens: { value: null, null_reason: 'stub' }, output_tokens: { value: null, null_reason: 'stub' } },
      });
      await flush();
    }
    if (t > time.monotonicMs()) time.set(t);
  };
  for (const e of stt) {
    await advanceTo(e.t_monotonic_ms);
    wiring.onStt(e as Parameters<InitiativeWiring['onStt']>[0]);
    await flush();
  }
  await advanceTo(Number.MAX_SAFE_INTEGER / 2);
  await wiring.monitor.whenIdle();
  wiring.close();
  return { count: sentAt.length, sent_at: sentAt };
}

export async function initiativeTriggerReport(
  events: ResearchEvent[],
  recordedPolicy: PolicyJa | null,
  editedPolicy: PolicyJa | null,
  persona: InitiativePersona | null,
): Promise<TuneInitiativeCount> {
  const recorded = events.filter((e) => e.event === 'llm.request' && e.purpose === 'initiative').length;
  const latencies = recordedInitiativeLatencies(events);
  const assumptions = [
    'LLM は呼ばない。判定は「NONE を返す代役」で、応答までの時間は記録の initiative の遅れを順に使う',
    '判定の結果（NEW、WITHDRAW など）は分からない。数え直すのは起動の回数だけ',
    'STT は記録のまま（segment の切り方も記録の AI の開始のまま）',
  ];
  const base: TuneInitiativeCount = {
    recorded_requests: recorded,
    recount_with_recorded_trigger: null,
    recount_with_edited_trigger: null,
    recorded_trigger: recordedPolicy?.initiative.trigger ?? null,
    edited_trigger: editedPolicy?.initiative.trigger ?? null,
    assumptions,
    error: null,
  };
  if (persona === null) return { ...base, error: 'persona を読めない' };
  try {
    if (recordedPolicy !== null) base.recount_with_recorded_trigger = (await countInitiativeRuns(events, recordedPolicy, persona, latencies)).count;
    if (editedPolicy !== null) base.recount_with_edited_trigger = (await countInitiativeRuns(events, editedPolicy, persona, latencies)).count;
  } catch (error) {
    base.error = error instanceof Error ? error.message : String(error);
  }
  return base;
}
