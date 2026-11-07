/**
 * 本物の部品との接続。
 *  - D の SpeechGeneratorImpl: 版が変わると旧版の PCM が実際に消え、旧版の再生は startChecked で拒否される。
 *  - S の InitiativeMonitor（変更しない）: asStore() で差し替えると、ID は E2a が振り、イベントは二重にならない。
 * LLM と TTS は test double で、LLM の判断は何も試していない。
 */
import { describe, expect, it } from 'vitest';
import { ManualTimeSource, MemoryEventSink, createEventEmitter } from '@llm-vap/contracts';
import type { PrepareRequest } from '@llm-vap/contracts';
import { ScriptedLlmProvider, ScriptedTtsProvider } from '@llm-vap/testkit';
import { CandidateLedger } from '../../../src/control/candidates';
import { SpeechGeneratorImpl } from '../../../src/speech';
import type { SpeechAudioSink } from '../../../src/speech';
import { interim, makeMonitor, output } from '../../../src/cognition/initiative/__tests__/helpers';
import { FakeSpeech, SETTINGS, STABLE, newD, reviseD, withdrawD } from './helpers';

const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
};

async function realSpeech() {
  const provider = new ScriptedTtsProvider({ ms_per_char: 100, chars_per_chunk: 4 });
  const tts = await provider.open({ preferred_sample_rate_hz: 16000 });
  const time = new ManualTimeSource();
  const events = new MemoryEventSink();
  const emitter = createEventEmitter({ time, session_id: 's', condition: () => 'initiative_inhale', sink: events });
  const begins: number[] = [];
  const sink: SpeechAudioSink = {
    begin: (m) => void begins.push(m.audio_playback_id),
    pcm: () => undefined,
    alignment: () => undefined,
    stop: () => undefined,
  };
  const speech = new SpeechGeneratorImpl({
    tts,
    llm: new ScriptedLlmProvider({ responder: () => 'unused' }),
    prompt: (request) => ({ system: 's', messages: [{ role: 'user', text: request.text }] }),
    sink,
    time,
    emitter,
    is_ready_buffer_ms: 200,
  });
  const ledger = new CandidateLedger({ emitter, stable: () => STABLE, speech, settings: SETTINGS });
  const prepare = async (candidate_id: string, candidate_version: number, text: string) => {
    const request: PrepareRequest = {
      segment_id: 0,
      transcript_revision: 10,
      text,
      origin: { kind: 'candidate', candidate_id, candidate_version },
    };
    const { audio_playback_id } = speech.prepare(request);
    await flush();
    tts.contexts.find((c) => c.audio_playback_id === audio_playback_id)?.pumpAll();
    return audio_playback_id;
  };
  return { speech, ledger, prepare, begins, events };
}

describe('D の SpeechGeneratorImpl と', () => {
  it('REVISE で旧版の PCM を棄て、新しい版だけが再生できる', async () => {
    const r = await realSpeech();
    const created = r.ledger.applyModelDecision(newD());
    if (!created.ok || !created.ref) throw new Error('setup');
    const id = created.ref.candidate_id;
    const v1 = await r.prepare(id, 1, '予算は増やせないのですか？');
    expect(r.speech.isReady(v1)).toBe(true);

    r.ledger.applyModelDecision(reviseD(created.ref, { rev: 12, utter: '部長に確認しますか？' }));
    expect(r.speech.stateOf(v1)).toBeNull();

    // 旧版の再生 ID は D の側でも残っていない。
    expect(r.ledger.startSpeech(id, 2, v1, 'turn_allowed', 1200)).toMatchObject({ speech_refusal: 'unknown_playback' });
    const v2 = await r.prepare(id, 2, '部長に確認しますか？');
    expect(r.ledger.startSpeech(id, 2, v2, 'turn_allowed', 1300)).toMatchObject({ ok: true });
    expect(r.begins).toEqual([v2]);
  });

  it('REVISE の後に棄て損ねた旧版の PCM があっても、startChecked が版の不一致で拒否して棄てる', async () => {
    const r = await realSpeech();
    const created = r.ledger.applyModelDecision(newD());
    if (!created.ok || !created.ref) throw new Error('setup');
    const id = created.ref.candidate_id;
    r.ledger.applyModelDecision(reviseD(created.ref, { rev: 12 }));
    // 改訂の後に（遅れて）旧版の準備が始まった場合。
    const stale = await r.prepare(id, 1, '古い文');
    expect(r.ledger.startSpeech(id, 2, stale, 'turn_allowed', 1300)).toMatchObject({ speech_refusal: 'candidate_mismatch' });
    expect(r.speech.stateOf(stale)).toBeNull();
    expect(r.begins).toEqual([]);
    expect(r.ledger.get(id)?.state).toBe('INTENT_READY');
  });

  it('WITHDRAW で未再生の PCM を棄てる', async () => {
    const r = await realSpeech();
    const created = r.ledger.applyModelDecision(newD());
    if (!created.ok || !created.ref) throw new Error('setup');
    const pid = await r.prepare(created.ref.candidate_id, 1, '予算は増やせないのですか？');
    r.ledger.applyModelDecision(withdrawD(created.ref, { rev: 12 }));
    expect(r.speech.stateOf(pid)).toBeNull();
  });
});

describe('S の InitiativeMonitor（変更なし）と asStore()', () => {
  it('ID は E2a が振り、撤回の遷移は表で確かめ、candidate.state_changed は monitor の1件だけ', async () => {
    const ledgerSink = new MemoryEventSink();
    const time = new ManualTimeSource();
    const speech = new FakeSpeech();
    const ledger = new CandidateLedger({
      emitter: createEventEmitter({ time, session_id: 's', condition: () => 'initiative_no_cue', sink: ledgerSink }),
      // asStore() は根拠を照合しない（monitor のゲートが照合済み）ので、安定テキストは読まれない。
      stable: () => [],
      speech,
      settings: SETTINGS,
    });
    const STABLE_TEXT = '予算は五十万円のままで進めます';
    const LATER = `${STABLE_TEXT}。でも部長が追加で出してもらえると言っていました`;
    const parts = makeMonitor(
      (_r, i) =>
        i === 0
          ? output({ decision: 'NEW', evidence_span: '五十万円', evidence_segment_ids: [0], proposed_utterance: '確認です', reason: 'r' })
          : output({
              decision: 'WITHDRAW',
              target_candidate_id: 'c_0001',
              withdraw_reason: '解消',
              withdraw_evidence_span: '追加で出してもらえる',
              withdraw_evidence_segment_ids: [0],
            }),
      { store: ledger.asStore() },
    );
    parts.monitor.onStt(interim(STABLE_TEXT));
    await parts.monitor.whenIdle();
    expect(ledger.get('c_0001')?.state).toBe('INTENT_READY');
    parts.monitor.onStt(interim(LATER));
    await parts.monitor.whenIdle();

    expect(ledger.get('c_0001')?.state).toBe('WITHDRAWN');
    expect(parts.sink.ofType('candidate.state_changed')).toHaveLength(1);
    expect(ledgerSink.events).toHaveLength(0);
    expect(speech.discards).toEqual([{ candidate_id: 'c_0001', reason: 'candidate_withdrawn', keep_version: undefined }]);
  });

  it('asStore() でも表にない遷移と旧い版の更新は拒否する', () => {
    const ledger = new CandidateLedger({
      emitter: createEventEmitter({ time: new ManualTimeSource(), session_id: 's', condition: () => 'reactive', sink: new MemoryEventSink() }),
      stable: () => STABLE,
      speech: new FakeSpeech(),
      settings: SETTINGS,
    });
    const store = ledger.asStore();
    const ref = store.register({
      segment_id: 0,
      transcript_revision: 10,
      intent_type: 'X',
      evidence_span: '五十万円',
      proposed_utterance: 'u',
      expiry_policy: 'p',
      urgency: 'NORMAL',
      evidence_segment_ids: [1],
      decided_at: 1,
    });
    expect(ref).toEqual({ candidate_id: 'c_0001', candidate_version: 1 });
    expect(() => store.setState('c_0001', 'SPOKEN', 2)).toThrow(/not in the table/);
    expect(store.update('c_0001', 1, { proposed_utterance: 'v' }, 3)).toEqual({ candidate_id: 'c_0001', candidate_version: 2 });
    expect(() => store.update('c_0001', 1, { proposed_utterance: 'w' }, 4)).toThrow(/expected version 1/);
    store.setState('c_0001', 'WITHDRAWN', 5);
    expect(() => store.setState('c_0001', 'INTENT_READY', 6)).toThrow();
  });
});
