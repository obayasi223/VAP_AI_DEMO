/** E2a の試験の部品。LLM は使わない（判定は手で作る）。ここの結果は LLM の性能を何も示さない。 */
import { ManualTimeSource, MemoryEventSink, createEventEmitter, modelOutput } from '@llm-vap/contracts';
import type { CandidateRef, SpeechStartResult } from '@llm-vap/contracts';
import { CandidateLedger } from '../../../src/control/candidates';
import type {
  AsrSegmentSnapshot,
  CandidateLedgerSettings,
  CandidateSpeechPort,
  ModelDecision,
} from '../../../src/control/candidates';

export const seg = (asr_segment_id: number, stable_text: string, segment_id = 0): AsrSegmentSnapshot => ({
  asr_segment_id,
  segment_id,
  stable_text,
  is_final: false,
  audio_frame_end: 0,
});

/** D の startChecked と discardCandidate の規則を写した偽物（本物との一致は speech_integration.test.ts で確かめる）。 */
export class FakeSpeech implements CandidateSpeechPort {
  readonly prepared = new Map<number, { candidate_id: string; candidate_version: number; ready: boolean }>();
  readonly discards: { candidate_id: string; reason: string; keep_version: number | undefined }[] = [];
  readonly starts: { audio_playback_id: number; expected: CandidateRef | undefined }[] = [];
  private next = 1;

  prepare(ref: CandidateRef, ready = true): number {
    const id = this.next++;
    this.prepared.set(id, { ...ref, ready });
    return id;
  }

  startChecked(audio_playback_id: number, expected?: CandidateRef): SpeechStartResult {
    this.starts.push({ audio_playback_id, expected });
    const entry = this.prepared.get(audio_playback_id);
    if (!entry) return { ok: false, reason: 'unknown_playback' };
    if (!expected) return { ok: false, reason: 'expected_candidate_required' };
    if (entry.candidate_id !== expected.candidate_id || entry.candidate_version !== expected.candidate_version) {
      this.prepared.delete(audio_playback_id);
      return { ok: false, reason: 'candidate_mismatch' };
    }
    if (!entry.ready) return { ok: false, reason: 'not_ready' };
    return { ok: true, generation: 1 };
  }

  discardCandidate(candidate_id: string, reason: string, keep_version?: number): number {
    this.discards.push({ candidate_id, reason, keep_version });
    let n = 0;
    for (const [id, e] of this.prepared) {
      if (e.candidate_id === candidate_id && e.candidate_version !== keep_version) {
        this.prepared.delete(id);
        n += 1;
      }
    }
    return n;
  }
}

export const SETTINGS: CandidateLedgerSettings = {
  max_active_candidates: 1,
  candidate_expiry_ms: null,
  candidate_expires_on_segment_change: null,
  post_turn_silence_ms: 500,
};

export const STABLE = [seg(1, '来週の展示会ですが、予算は五十万円のまま'), seg(2, '進めようと思っていて。でも部長は追加で出してもらえると')];

export function rig(settings: Partial<CandidateLedgerSettings> = {}, speech: CandidateSpeechPort = new FakeSpeech()) {
  const time = new ManualTimeSource();
  const sink = new MemoryEventSink();
  const emitter = createEventEmitter({ time, session_id: 's', condition: () => 'initiative_inhale', sink });
  const state = { stable: [...STABLE] };
  const ledger = new CandidateLedger({
    emitter,
    stable: () => state.stable,
    speech,
    settings: { ...SETTINGS, ...settings },
  });
  return { ledger, sink, state, speech, time };
}

let requestSeq = 0;
const meta = (over: { rev?: number; segment_id?: number; at?: number; input?: AsrSegmentSnapshot[]; request_id?: string }) => ({
  request_id: over.request_id ?? `ini_${++requestSeq}`,
  transcript_revision: over.rev ?? 10,
  segment_id: over.segment_id ?? 0,
  received_at: over.at ?? 1000,
  input_segments: over.input ?? [...STABLE],
});

export const NOTES = {
  reason: modelOutput('確認したい'),
  why_now: modelOutput('後の説明に響く'),
  cost_of_waiting: modelOutput('誤解が続く'),
};

export type MetaOver = Parameters<typeof meta>[0];

export function newD(over: MetaOver & { span?: string; ids?: number[]; utter?: string; notes?: typeof NOTES } = {}): ModelDecision {
  return {
    decision: 'NEW',
    ...meta(over),
    content: {
      intent_type: 'CLARIFICATION',
      evidence_span: over.span ?? '五十万円のまま',
      evidence_segment_ids: over.ids ?? [1],
      proposed_utterance: over.utter ?? '予算は増やせないのですか？',
      expiry_policy: 'RECHECK_ON_NEW_INFORMATION',
      urgency: 'NORMAL',
    },
    notes: over.notes ?? NOTES,
  };
}

export function reviseD(target: CandidateRef, over: MetaOver & { span?: string; ids?: number[]; utter?: string } = {}): ModelDecision {
  const base = newD(over);
  if (base.decision !== 'NEW') throw new Error('unreachable');
  return { ...base, decision: 'REVISE', target };
}

export function keepD(target: CandidateRef, over: MetaOver = {}): ModelDecision {
  return { decision: 'KEEP', target, ...meta(over) };
}

export function withdrawD(target: CandidateRef, over: MetaOver & { span?: string; ids?: number[] } = {}): ModelDecision {
  return {
    decision: 'WITHDRAW',
    target,
    ...meta(over),
    withdraw_evidence_span: over.span ?? '追加で出してもらえる',
    withdraw_evidence_segment_ids: over.ids ?? [2],
    withdraw_reason: modelOutput('本人が補足した'),
  };
}

export function noneD(over: MetaOver = {}): ModelDecision {
  return { decision: 'NONE', ...meta(over) };
}
