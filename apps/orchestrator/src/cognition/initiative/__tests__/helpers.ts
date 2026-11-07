/** 試験の部品。LLM は ScriptedLlmProvider（test double）で、ここの結果は LLM の性能を何も示さない（計画 §4.5a）。 */
import { ManualTimeSource, MemoryEventSink, absent, createEventEmitter, present, splitInterimParts } from '@llm-vap/contracts';
import type { LlmRequest, SttPart } from '@llm-vap/contracts';
import { ScriptedLlmProvider } from '@llm-vap/testkit';
import { CandidateLedger } from '../../../control/candidates';
import type { CandidateLedgerSettings, CandidateSpeechPort } from '../../../control/candidates';
import { InitiativeMonitor } from '../monitor';
import type { InitiativeMonitorDeps } from '../monitor';
import type { InitiativeModelOutput } from '../model_output';
import type { InitiativePersona } from '../persona';
import type { SttEvent } from '../transcript_view';

export const PERSONA: InitiativePersona = {
  persona_id: 'test',
  version: 1,
  role: '試験用の役割',
  interests: ['試験'],
  conversation_purpose: '試験',
  not_of_interest: ['無関係な話'],
};

export const LIMITS = {
  max_new_stable_chars_since_input: 60,
  max_result_age_ms: 6000,
  min_stability: 0.8,
  max_active_candidates: 1,
  max_requests_per_session: 50,
};

let revision = 0;

export function interim(stable: string, unstable = '', asr_segment_id = 0): SttEvent {
  const parts: SttPart[] = [];
  if (stable) parts.push({ text: stable, stability: present(0.9) });
  if (unstable) parts.push({ text: unstable, stability: present(0.01) });
  const split = splitInterimParts(parts, 0.8);
  revision += 1;
  return {
    schema_version: 1,
    event: 'stt.interim',
    t_monotonic_ms: 0,
    wall_clock: '2026-11-08T00:00:00.000Z',
    session_id: 's',
    condition: 'initiative_no_cue',
    time_basis: { source: 'orchestrator', uncertainty_ms: { value: 0 } },
    text: split.text,
    stable_text: split.stable_text,
    unstable_text: split.unstable_text,
    parts,
    segment_id: 0,
    asr_segment_id,
    asr_segment_frame_start: 0,
    transcript_revision: revision,
    stability: split.stability,
    stability_source: 'provider',
    audio_frame_end: 1000,
    timing_precision: 'result_end_offset',
    words: absent('interim_words_unavailable'),
    stream_id: 'stream_1',
    provider: 'test_double',
    model_version: 'test_double',
  };
}

export function final(text: string, asr_segment_id = 0): SttEvent {
  const base = interim('', text, asr_segment_id);
  return {
    ...base,
    event: 'stt.final',
    stable_text: text,
    unstable_text: '',
    parts: [{ text, stability: absent('provider_unset_marker_0.0') }],
    stability: absent('provider_unset_marker_0.0'),
  };
}

export function output(partial: Partial<InitiativeModelOutput>): string {
  return JSON.stringify({
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
    ...partial,
  });
}

export type Responder = (request: LlmRequest, index: number) => string | Promise<string>;

/** E2a の既定（話の後の判定は試験の時刻の進め方に依らないよう、人の発話の有無を伝えない限り働かない）。 */
export const LEDGER_SETTINGS: CandidateLedgerSettings = {
  max_active_candidates: 1,
  candidate_expiry_ms: null,
  candidate_expires_on_segment_change: null,
  post_turn_silence_ms: 500,
};

/** D の discardCandidate の呼び出しを記録するだけの口。 */
export class RecordingSpeech implements CandidateSpeechPort {
  readonly discards: { candidate_id: string; reason: string; keep_version: number | undefined }[] = [];
  startChecked() {
    return { ok: false as const, reason: 'unknown_playback' as const };
  }
  discardCandidate(candidate_id: string, reason: string, keep_version?: number): number {
    this.discards.push({ candidate_id, reason, keep_version });
    return 0;
  }
}

export function makeMonitor(
  responder: Responder,
  overrides: Partial<InitiativeMonitorDeps> = {},
  ledgerSettings: Partial<CandidateLedgerSettings> = {},
) {
  const time = new ManualTimeSource();
  const sink = new MemoryEventSink();
  const emitter = createEventEmitter({ time, session_id: 's', condition: () => 'initiative_no_cue', sink });
  const speech = new RecordingSpeech();
  let monitorRef: InitiativeMonitor | null = null;
  const ledger = new CandidateLedger({
    emitter,
    stable: () => monitorRef?.stableSnapshot() ?? [],
    speech,
    settings: { ...LEDGER_SETTINGS, ...ledgerSettings },
  });
  let count = 0;
  const llm = new ScriptedLlmProvider({
    responder: (request) => responder(request, count++),
    now: () => time.monotonicMs(),
    chars_per_delta: 100_000,
  });
  const monitor = new InitiativeMonitor({
    llm,
    ledger,
    emitter,
    time,
    persona: PERSONA,
    limits: LIMITS,
    trigger: { min_new_stable_chars: 10, min_new_chars_at_boundary: 4 },
    ...overrides,
  });
  monitorRef = monitor;
  return { monitor, llm, ledger, store: ledger, sink, time, speech };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
