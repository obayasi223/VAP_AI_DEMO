import { describe, expect, it } from 'vitest';
import { CandidateConflictError, ManualTimeSource, MemoryEventSink, createEventEmitter, modelOutput, modelOutputAbsent, present, verified } from '@llm-vap/contracts';
import type { CandidateRegistration, LlmRequest, TtsChunk } from '@llm-vap/contracts';
import {
  InMemoryCandidateStore,
  InMemoryConversationHistory,
  ScriptedLlmProvider,
  ScriptedSttProvider,
  ScriptedTtsProvider,
} from '../src/index';

const llmRequest = (over: Partial<LlmRequest> = {}): LlmRequest => ({
  request_id: 'r_1',
  purpose: 'prefetch',
  system: '',
  messages: [{ role: 'user', text: 'こんにちは' }],
  response_json_schema: null,
  transcript_revision: 1,
  ...over,
});

const registration: CandidateRegistration = {
  segment_id: 1,
  transcript_revision: 5,
  intent_type: 'CLARIFICATION',
  evidence_span: '月額',
  proposed_utterance: '月額ですか？',
  expiry_policy: 'RECHECK_ON_NEW_INFORMATION',
  urgency: 'NORMAL',
  evidence_segment_ids: [2],
  decided_at: 100,
};

describe('ScriptedSttProvider', () => {
  it('assigns increasing revisions, keeps the ASR segment until final, follows the segment boundary', async () => {
    const provider = new ScriptedSttProvider(() => 42);
    expect(provider.provider_class).toBe('test_double');
    const session = await provider.open({
      language_code: 'ja-JP',
      sample_rate_hz: 16000,
      interim_results: true,
      start_audio_frame: 0,
    });
    const seen: number[] = [];
    session.onResult((r) => seen.push(r.transcript_revision));
    session.pushAudio(0, new Int16Array(320));
    expect(session.pushed).toEqual([{ audio_frame: 0, samples: 320 }]);

    const a = session.deliver({ text: 'あ', audio_frame_end: 100 });
    const b = session.deliver({ kind: 'final', text: 'あい', audio_frame_end: 200 });
    const c = session.deliver({ text: 'う', audio_frame_end: 300 });
    expect(seen).toEqual([1, 2, 3]);
    expect([a.asr_segment_id, b.asr_segment_id, c.asr_segment_id]).toEqual([0, 0, 1]);
    expect(c.asr_segment_frame_start).toBe(200);
    expect(a.stability.value).toBeNull();
    expect(a).toMatchObject({ stable_text: '', unstable_text: 'あ' });
    expect(b).toMatchObject({ stable_text: 'あい', unstable_text: '' });
    const partly = session.deliver({ text: 'かきく', stable_text: 'かき', audio_frame_end: 320 });
    expect(partly).toMatchObject({ stable_text: 'かき', unstable_text: 'く' });

    session.advanceSegment(4);
    expect(session.deliver({ text: 'え', audio_frame_end: 400 }).segment_id).toBe(4);
  });
});

describe('ScriptedTtsProvider', () => {
  const open = (options = {}) =>
    new ScriptedTtsProvider({ ms_per_char: 100, chars_per_chunk: 2, ...options }).open({ preferred_sample_rate_hz: 16000 });

  it('produces chunks with ids and stops after cancel', async () => {
    const connection = await open();
    const context = connection.openContext({ audio_playback_id: 7, generation: 2 });
    const chunks: TtsChunk[] = [];
    connection.onChunk((c) => chunks.push(c));
    context.sendText('あいうえお');
    expect(context.pump()).toBe(true);
    context.cancel('withdrawn');
    expect(context.pump()).toBe(false);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ context_id: 'p7_g2', audio_playback_id: 7, generation: 2, seq: 0, sample_rate_hz: 16000, is_last: false });
    expect(chunks[0]?.pcm.length).toBe(3200);
    expect(() => context.sendText('x')).toThrow();
  });

  it('returns per-character alignment relative to each chunk', async () => {
    const connection = await open();
    const context = connection.openContext({ audio_playback_id: 1, generation: 0 });
    const chunks: TtsChunk[] = [];
    connection.onChunk((c) => chunks.push(c));
    context.sendText('あいう');
    context.endInput();
    expect(context.pumpAll()).toBe(2);
    expect(chunks.map((c) => c.is_last)).toEqual([false, true]);
    expect(chunks[0]?.alignment.value).toEqual({ chars: ['あ', 'い'], char_start_ms: [0, 100], char_duration_ms: [100, 100] });
    // 2つ目のチャンクも 0 から始まる。累積は呼び出し側の仕事。
    expect(chunks[1]?.alignment.value).toEqual({ chars: ['う'], char_start_ms: [0], char_duration_ms: [100] });
    expect(() => context.sendText('x')).toThrow();
  });

  it('runs several contexts on one connection and frees slots', async () => {
    const connection = await open({ max_contexts: 2 });
    expect(connection.max_contexts).toBe(2);
    const seen: string[] = [];
    connection.onChunk((c) => seen.push(c.context_id));
    const a = connection.openContext({ audio_playback_id: 1, generation: 0 });
    const b = connection.openContext({ audio_playback_id: 2, generation: 0 });
    expect(() => connection.openContext({ audio_playback_id: 3, generation: 0 })).toThrow('too many');
    a.sendText('あ');
    b.sendText('い');
    b.pump();
    a.pump();
    expect(seen).toEqual(['p2_g0', 'p1_g0']);
    a.cancel('superseded');
    expect(connection.activeContextCount).toBe(1);
    connection.openContext({ audio_playback_id: 3, generation: 0 });
    await connection.close();
    expect(() => connection.openContext({ audio_playback_id: 4, generation: 0 })).toThrow('closed');
  });
});

describe('ScriptedLlmProvider', () => {
  it('streams and resolves the result', async () => {
    const time = new ManualTimeSource(10);
    const provider = new ScriptedLlmProvider({
      responder: () => 'こんにちは世界',
      now: () => time.monotonicMs(),
      chars_per_delta: 3,
    });
    const stream = provider.stream(llmRequest());
    const parts: string[] = [];
    for await (const part of stream.deltas) parts.push(part);
    expect(parts.join('')).toBe('こんにちは世界');
    const result = await stream.result;
    expect(result).toMatchObject({ request_id: 'r_1', text: 'こんにちは世界', sent_at: 10, model_version: 'test_double' });
    expect(provider.requests).toHaveLength(1);
  });

  it('honours abort', async () => {
    const controller = new AbortController();
    const provider = new ScriptedLlmProvider({ responder: () => 'abcdefgh', chars_per_delta: 2 });
    const stream = provider.stream(llmRequest({ signal: controller.signal }));
    const iterator = stream.deltas[Symbol.asyncIterator]();
    await iterator.next();
    controller.abort();
    await expect(iterator.next()).rejects.toThrow('aborted');
    await expect(stream.result).rejects.toThrow('aborted');
  });

  it('generate returns the whole text', async () => {
    const provider = new ScriptedLlmProvider({ responder: (r) => `echo:${r.purpose}` });
    expect((await provider.generate(llmRequest())).text).toBe('echo:prefetch');
  });
});

describe('InMemoryConversationHistory', () => {
  const user = { text: 'あ', segment_id: 1, transcript_revision: 2, is_final: false, audio_frame_end: 100 };
  const spoken = {
    text: 'それは',
    audio_playback_id: 3,
    spoken_text_precision: 'time_proportional' as const,
    interrupted: true,
    origin: { kind: 'response' as const },
  };

  it('replaces a segment and ignores older revisions', () => {
    const history = new InMemoryConversationHistory();
    const versions: number[] = [];
    history.onChange((v) => versions.push(v));
    history.upsertUserSegment(user);
    history.upsertUserSegment({ ...user, text: 'あい', transcript_revision: 3 });
    history.upsertUserSegment({ ...user, text: '古い', transcript_revision: 1 });
    expect(history.snapshot()).toHaveLength(1);
    expect(history.snapshot()[0]?.text).toBe('あい');
    expect(versions).toEqual([1, 2]);
  });

  it('commits spoken text once and returns copies', () => {
    const history = new InMemoryConversationHistory();
    history.commitAssistantSpoken(spoken);
    expect(() => history.commitAssistantSpoken(spoken)).toThrow();
    const snapshot = history.snapshot();
    (snapshot[0] as { text: string }).text = 'changed';
    expect(history.snapshot()[0]?.text).toBe('それは');
  });
});

describe('InMemoryCandidateStore', () => {
  it('numbers candidates so that NEW can be emitted after registration', () => {
    const store = new InMemoryCandidateStore();
    const sink = new MemoryEventSink();
    const emitter = createEventEmitter({
      time: new ManualTimeSource(200),
      session_id: 's',
      condition: () => 'initiative_inhale',
      sink,
    });
    const ref = store.register(registration);
    expect(ref).toEqual({ candidate_id: 'c_0001', candidate_version: 1 });
    expect(store.register(registration).candidate_id).toBe('c_0002');
    emitter.emit({
      event: 'initiative.decision',
      decision: 'NEW',
      ...ref,
      segment_id: 1,
      transcript_revision: 5,
      request_id: 'r_1',
      sent_at: 90,
      received_at: 99,
      decided_at: 100,
      model_version: 'test_double',
      intent_type: modelOutput('CLARIFICATION'),
      evidence_span: modelOutput('月額'),
      reason: modelOutput('x'),
      why_now: modelOutputAbsent('not_returned'),
      cost_of_waiting: modelOutputAbsent('not_returned'),
      proposed_utterance: modelOutput('月額ですか？'),
      expiry_policy: modelOutput('RECHECK_ON_NEW_INFORMATION'),
      urgency: modelOutput('NORMAL'),
      evidence_valid: verified(true, 'test'),
      evidence_segment_ids: verified([2], 'test'),
    });
    expect(sink.ofType('initiative.decision')).toHaveLength(1);
  });

  it('bumps the version on update and rejects stale versions', () => {
    const store = new InMemoryCandidateStore();
    const { candidate_id } = store.register(registration);
    const next = store.update(candidate_id, 1, { proposed_utterance: '新しい文' }, 150);
    expect(next.candidate_version).toBe(2);
    expect(store.get(candidate_id)).toMatchObject({ proposed_utterance: '新しい文', updated_at: 150 });
    expect(() => store.update(candidate_id, 1, {}, 160)).toThrow(CandidateConflictError);
  });

  it('keeps the version on a state change and hides resolved candidates', () => {
    const store = new InMemoryCandidateStore();
    const { candidate_id } = store.register(registration);
    expect(store.setState(candidate_id, 'BREATH_INHALE', 120).candidate_version).toBe(1);
    expect(store.list()).toHaveLength(1);
    store.setState(candidate_id, 'WITHDRAWN', 130);
    expect(store.list()).toHaveLength(0);
    expect(store.list({ include_resolved: true })).toHaveLength(1);
    expect(store.get('c_9999')).toBeNull();
    expect(() => store.setState('c_9999', 'SPOKEN', 1)).toThrow();
    expect(present(1)).toEqual({ value: 1 });
  });
});
