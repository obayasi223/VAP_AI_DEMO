// 試験用の合成ログ。実会話は使わない。話の中身は作り物で、時刻と番号も実測ではない。
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SESSION = 's_synthetic';
const base = (t: number) => ({
  schema_version: 1,
  t_monotonic_ms: t,
  wall_clock: '2026-01-01T00:00:00.000Z',
  session_id: SESSION,
  condition: 'initiative_inhale',
  time_basis: { source: 'orchestrator', uncertainty_ms: { value: 0 } },
});
const model = (value: unknown) => ({ source: 'model_output', value });
const stt = (t: number, segment: number, asr: number, revision: number, stable: string, text: string, final: boolean) => ({
  ...base(t),
  event: final ? 'stt.final' : 'stt.interim',
  text,
  stable_text: stable,
  unstable_text: final ? '' : text.slice(stable.length),
  parts: [],
  segment_id: segment,
  asr_segment_id: asr,
  asr_segment_frame_start: (asr + 1) * 16000,
  transcript_revision: revision,
  stability: { value: 0.5 },
  stability_source: 'provider',
  audio_frame_end: (asr + 2) * 16000,
  timing_precision: 'result_end_offset',
  words: { value: null, null_reason: 'interim_words_unavailable' },
  stream_id: 'stream_1',
  provider: 'synthetic',
  model_version: 'synthetic-asr',
});
const llmRequest = (t: number, id: string, revision: number) => ({
  ...base(t),
  event: 'llm.request',
  request_id: id,
  purpose: 'initiative',
  input: { messages: [{ role: 'user', text: `入力 ${id}` }] },
  transcript_revision: revision,
  sent_at: t,
  model_version: 'synthetic-llm',
});
const llmResponse = (t: number, id: string, revision: number, output: Record<string, unknown>) => ({
  ...base(t),
  event: 'llm.response',
  request_id: id,
  purpose: 'initiative',
  output: model({ text: JSON.stringify(output), finish_reason: 'STOP' }),
  transcript_revision: revision,
  sent_at: t - 500,
  received_at: t,
  model_version: 'synthetic-llm',
  first_text_at: t - 100,
});
const decision = (t: number, id: string, revision: number, fields: Record<string, unknown>) => ({
  ...base(t),
  event: 'initiative.decision',
  segment_id: 1,
  transcript_revision: revision,
  request_id: id,
  sent_at: t - 500,
  received_at: t,
  model_version: 'synthetic-llm',
  ...fields,
});
const body = (version: number, utterance: string) => ({
  candidate_id: 'c_0001',
  candidate_version: version,
  intent_type: model('CLARIFICATION'),
  evidence_span: model('大きい方の箱'),
  reason: model('箱の大きさが前と違う'),
  why_now: model('数を決める前に確かめたい'),
  cost_of_waiting: { source: 'model_output', value: null, null_reason: 'model_left_empty' },
  proposed_utterance: model(utterance),
  expiry_policy: model('RECHECK_ON_NEW_INFORMATION'),
  urgency: model('NORMAL'),
  evidence_valid: { source: 'verified', value: true, method: 'exact_substring_of_stable_text' },
  evidence_segment_ids: { source: 'verified', value: [1], method: 'asr_segment_lookup' },
});
const candidateEnvelope = { candidate_id: 'c_0001', candidate_version: 1 };

export function syntheticEvents(): unknown[] {
  const events: unknown[] = [];
  for (let frame = 16000; frame <= 16000 * 12; frame += 16000) events.push({ ...base(frame / 16 + 200), event: 'vap.state', audio_frame: frame });
  events.push(
    stt(1000, 1, 0, 1, '箱の', '箱の話', false),
    stt(1200, 1, 0, 2, '箱の話', '箱の話', true),
    stt(2000, 1, 1, 3, 'まず大きい方の', 'まず大きい方の箱を', false),
    stt(2400, 1, 1, 4, 'まず大きい方の箱を十個', 'まず大きい方の箱を十個', false),
    stt(3000, 1, 1, 5, 'まず大きい方の箱を十個と言いました', 'まず大きい方の箱を十個と言いました', true),
    llmRequest(2500, 'ini_0001', 4),
    llmResponse(3000, 'ini_0001', 4, { decision: 'NEW', reason: '箱の大きさが前と違う', resolution_outlook: '本人が直しそうにない' }),
    decision(3000, 'ini_0001', 4, { ...body(1, '大きい方というのは前の箱のことですか？'), decision: 'NEW', decided_at: 3005 }),
    { ...base(3010), event: 'candidate.state_changed', ...candidateEnvelope, from: null, to: 'INTENT_READY', cause_source: 'model_decision', decision: 'NEW', request_id: 'ini_0001' },
    { ...base(3020), event: 'negotiation.decision', stage: 'signal_gate', candidate_id: { value: 'c_0001' }, candidate_version: { value: 1 }, candidate_state: 'INTENT_READY', outcome: 'cue', reasons: ['fresh'] },
    { ...base(3100), event: 'signal.sent', candidate_id: 'c_0001', phase: 'inhale', parameters: {}, sent_at: 3100 },
    { ...base(3150), event: 'signal.started', candidate_id: 'c_0001', phase: 'inhale', parameters: {}, visible: true, started_at: 3150 },
    { ...base(3200), event: 'candidate.state_changed', ...candidateEnvelope, from: 'INTENT_READY', to: 'BREATH_INHALE', cause_source: 'code', cause: 'signal_gate_allowed' },
    decision(4000, 'ini_0002', 5, { ...body(2, '大きい方は前の箱と同じですか？'), decision: 'REVISE', updated_at: 4005 }),
    decision(5000, 'ini_0003', 5, {
      candidate_id: 'c_0001',
      candidate_version: 2,
      decision: 'WITHDRAW',
      withdrawn_at: 5005,
      withdraw_reason: model('本人が直後に説明した'),
      reason: { source: 'model_output', value: null, null_reason: 'model_left_empty' },
      withdraw_evidence_segment_ids: { source: 'verified', value: [2], method: 'asr_segment_lookup' },
    }),
    { ...base(5010), event: 'candidate.state_changed', ...candidateEnvelope, candidate_version: 2, from: 'BREATH_INHALE', to: 'WITHDRAWN', cause_source: 'model_decision', decision: 'WITHDRAW', request_id: 'ini_0003' },
    { ...base(5020), event: 'initiative.timing_note', candidate_id: 'c_0001', note: '新しい段の試し' },
  );
  events.push(
    stt(6000, 2, 2, 6, '別の話です', '別の話です', true),
    llmRequest(6500, 'ini_0004', 6),
    llmResponse(7000, 'ini_0004', 6, { decision: 'NONE', reason: '言う価値がない', why_now: '' }),
    decision(7000, 'ini_0004', 6, { decision: 'NONE', reason: model('言う価値がない'), segment_id: 2 }),
    llmRequest(8000, 'ini_0005', 7),
    llmResponse(8400, 'ini_0005', 7, { decision: 'NEW', reason: '遅れて届いた', proposed_utterance: '棄てられる一言' }),
    { ...base(8410), event: 'candidate.rejected', candidate_id: { value: null, null_reason: 'not_numbered' }, candidate_version: { value: null, null_reason: 'not_numbered' }, source: 'model_decision', operation: 'NEW', current_state: null, requested_state: null, cause: null, request_id: { value: 'ini_0005' }, reason: 'stale_segment', details: ['input_segment=2'], held: false, input_transcript_revision: { value: 7 }, applied_transcript_revision: { value: 6 } },
    { ...base(8420), event: 'initiative.discarded', candidate_id: { value: null, null_reason: 'not_numbered_yet' }, reason: 'stale_segment_from_e2a', input_transcript_revision: 7, latest_transcript_revision: 8, revision_gap: 1 },
    { ...base(9000), event: 'speech.started', audio_playback_id: 7, audio_frame: 150000, started_at: 9400, first_pcm_written_at: 9380, output_latency_ms: { value: 20 }, origin: 'response' },
    { ...base(9900), event: 'speech.ended', audio_playback_id: 7, audio_frame: 160000, started_at: 9400, first_pcm_written_at: 9380, output_latency_ms: { value: 20 }, origin: 'response', spoken_text: 'こちらは応答の例です', spoken_text_precision: 'alignment_char', samples_written: 8000, ended_at: 9990 },
  );
  return events;
}

/** 二段判定の合成イベント（話の中身は作り物）。 */
export function stagedEvents(kind = 'companion', immediate = false): unknown[] {
  const stage = (t: number, id: string, fields: Record<string, unknown>) => ({
    ...base(t),
    request_id: id,
    segment_id: 1,
    transcript_revision: 4,
    sent_at: t - 400,
    received_at: t,
    latency_ms: 400,
    model_version: 'synthetic-llm',
    conversation_kind: kind,
    profile_version: 1,
    history_version: { value: 3 },
    input_segment_ids: [1],
    recent_turn_count: 0,
    gate: { source: 'verified', value: { passed: true, reasons: [] }, method: 'staged_gate' },
    ledger_reason: { value: null, null_reason: 'accepted' },
    ...fields,
  });
  const none = { source: 'model_output', value: null, null_reason: 'model_left_empty' };
  const timing = (t: number, id: string, verdict: string) =>
    stage(t, id, {
      event: 'initiative.timing',
      timing_strategy: 'llm',
      timing: verdict,
      candidate_id: 'c_0002',
      candidate_version: 1,
      desire_request_id: 'ini_0011',
      prompt_version: 'timing-v',
      reason: model('まだ話している'),
      why_now: none,
      cost_of_waiting: none,
      withdraw_reason: none,
      withdraw_evidence_segment_ids: { value: null, null_reason: 'not_withdrawn' },
      outcome: 'kept',
    });
  const events: unknown[] = [
    stage(3000, 'ini_0011', {
      event: 'initiative.desire',
      desire: 'NEW',
      prompt_version: 'desire-v',
      candidate_id: { value: 'c_0002' },
      candidate_version: { value: 1 },
      intent_type: model('CLARIFICATION'),
      proposed_utterance: model('確認の一言'),
      evidence_span: model('大きい方の箱'),
      reason: model('確かめたい'),
      evidence_segment_ids: { value: { source: 'verified', value: [1], method: 'listed_segments_contain_span' } },
      prior_turn_evidence_span: none,
      prior_turn_evidence: { value: null, null_reason: 'no_prior_turn_evidence' },
      outcome: 'registered',
    }),
  ];
  if (immediate) {
    events.push({
      ...base(3005),
      event: 'initiative.timing',
      timing_strategy: 'immediate',
      timing: 'OFFER_NOW',
      model_call: false,
      decided_at: 3005,
      candidate_id: 'c_0002',
      candidate_version: 1,
      desire_request_id: 'ini_0011',
      segment_id: 1,
      transcript_revision: 4,
      conversation_kind: kind,
      profile_version: 1,
      outcome: 'kept',
      ledger_reason: { value: null, null_reason: 'accepted' },
    });
  } else {
    events.push(timing(3400, 'ini_0011_timing', 'WAIT_FOR_TURN_END'), timing(4400, 'ini_0012_timing', 'WAIT_FOR_TURN_END'), timing(5400, 'ini_0013_timing', 'OFFER_NOW'));
  }
  return events;
}

export function writeSession(root: string, id: string, options: { manifest?: Record<string, unknown>; extraLines?: string[]; events?: unknown[] } = {}): string {
  const dir = path.join(root, id);
  mkdirSync(dir, { recursive: true });
  const lines = (options.events ?? syntheticEvents()).map((e) => JSON.stringify(e));
  writeFileSync(path.join(dir, 'events.jsonl'), `${[...lines, ...(options.extraLines ?? [])].join('\n')}\n`);
  writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify({
      session_id: id,
      started_wall_clock: '2026-01-01T00:00:00.000Z',
      condition: 'initiative_inhale',
      initiative: { prompt_version: 'test-prompt-v1', persona_id: 'persona_a' },
      ...options.manifest,
    }),
  );
  return dir;
}

export function tempRoot(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'initiative-review-'));
}
