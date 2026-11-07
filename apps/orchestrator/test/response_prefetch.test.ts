import { describe, expect, it } from 'vitest';
import { ManualTimeSource, MemoryEventSink, absent, createEventEmitter, present } from '@llm-vap/contracts';
import type { Maybe, TurnDecision } from '@llm-vap/contracts';
import { ScriptedLlmProvider, ScriptedTtsProvider } from '@llm-vap/testkit';
import { ResponsePrefetch } from '../src/cognition/prefetch';
import { SpeechGeneratorImpl } from '../src/speech';

const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
};

async function rig(responder: () => string = () => '三時からです。') {
  const tts = await new ScriptedTtsProvider({ ms_per_char: 100 }).open({ preferred_sample_rate_hz: 16000 });
  const llm = new ScriptedLlmProvider({ responder });
  const events = new MemoryEventSink();
  const time = new ManualTimeSource();
  const emitter = createEventEmitter({ time, session_id: 's', condition: () => 'reactive', sink: events });
  const speech = new SpeechGeneratorImpl({
    tts,
    llm,
    prompt: (request) => ({ system: '', messages: [{ role: 'user', text: request.text }] }),
    sink: { begin: () => undefined, pcm: () => undefined, alignment: () => undefined, stop: () => undefined },
    time,
    emitter,
    is_ready_buffer_ms: 200,
  });
  const prefetch = new ResponsePrefetch({ speech, time, emitter });
  return { tts, llm, events, time, speech, prefetch };
}

const prepare = (text: string, similarity: Maybe<number> = absent('first'), segment_id = 1): TurnDecision => ({
  kind: 'prepare',
  segment_id,
  transcript_revision: 4,
  text,
  trigger: 'completion_threshold',
  similarity,
});

describe('ResponsePrefetch', () => {
  it('prepare を実行し、prefetch.started に類似度と手法を残す。初回は null と理由', async () => {
    const r = await rig();
    r.time.set(50);
    r.prefetch.execute(prepare('明日の会議は'));
    const [event] = r.events.ofType('prefetch.started');
    expect(event?.similarity).toEqual({ value: null, null_reason: 'first' });
    expect(event?.similarity_method).toBe('char_ngram_cosine:n=2');
    expect(event?.model_version).toBe('test_double');
    expect(r.prefetch.input()).toMatchObject({ state: 'preparing', segment_id: 1, started_at: 50 });
  });

  it('PCM がたまると ready になり prefetch.ready を1回出す', async () => {
    const r = await rig();
    r.prefetch.execute(prepare('明日の会議は'));
    await flush();
    r.tts.contexts[0]?.pumpAll();
    expect(r.prefetch.input().state).toBe('ready');
    expect(r.events.ofType('prefetch.ready')).toHaveLength(1);
  });

  it('新しい prepare は古い準備を取り消す（L48）', async () => {
    const r = await rig();
    r.prefetch.execute(prepare('明日の'));
    const first = r.prefetch.input();
    await flush();
    r.prefetch.execute(prepare('明日の会議は', present(0.4)));
    const [cancelled] = r.events.ofType('prefetch.cancelled');
    expect(cancelled?.cancel_reason).toBe('superseded');
    expect(first.state).toBe('preparing');
    if (first.state === 'preparing') expect(cancelled?.audio_playback_id).toBe(first.audio_playback_id);
    expect(r.events.ofType('prefetch.started')).toHaveLength(2);
    expect(r.prefetch.input().state).toBe('preparing');
  });

  it('cancel_prepare は一致する準備だけを取り消す。他の決定は無視する', async () => {
    const r = await rig();
    r.prefetch.execute(prepare('明日の'));
    const input = r.prefetch.input();
    if (input.state !== 'preparing') throw new Error('unexpected');
    r.prefetch.execute({ kind: 'cancel_prepare', audio_playback_id: 999, reason: 'x' });
    expect(r.prefetch.input().state).toBe('preparing');
    r.prefetch.execute({
      kind: 'set_degraded',
      degraded: true,
      reason: 'x',
    });
    r.prefetch.execute({ kind: 'cancel_prepare', audio_playback_id: input.audio_playback_id, reason: 'user_resumed' });
    expect(r.prefetch.input()).toEqual({ state: 'idle' });
    expect(r.events.ofType('prefetch.cancelled')[0]?.cancel_reason).toBe('user_resumed');
  });

  it('再生に入ると idle。再生中の音声を新しい prepare で取り消さない', async () => {
    const r = await rig();
    r.prefetch.execute(prepare('明日の'));
    const input = r.prefetch.input();
    if (input.state !== 'preparing') throw new Error('unexpected');
    await flush();
    r.tts.contexts[0]?.pumpAll();
    expect(r.speech.start(input.audio_playback_id)).toBe(true);
    expect(r.prefetch.input()).toEqual({ state: 'idle' });
    r.prefetch.execute(prepare('次の'));
    expect(r.speech.stateOf(input.audio_playback_id)).toBe('playing');
    expect(r.events.ofType('prefetch.cancelled')).toHaveLength(0);
  });

  it('類似度: 比較対象がなければ null と理由。同じ segment なら計算する', async () => {
    const r = await rig();
    expect(r.prefetch.similarityToPrepared('はい', 1)).toEqual({ value: null, null_reason: 'no_previous_prepare' });
    r.prefetch.execute(prepare('はい'));
    expect(r.prefetch.similarityToPrepared('はい', 1).value).toBeCloseTo(1);
  });

  it('segment が変わったら前の入力と比べない（U-4「はい」→「はい」）', async () => {
    const r = await rig();
    r.prefetch.execute(prepare('はい'));
    expect(r.prefetch.similarityToPrepared('はい', 2)).toEqual({
      value: null,
      null_reason: 'previous_prepare_in_other_segment',
    });
  });

  it('取消の後も基準を残す（L51）。失敗の後は再試行を止めない', async () => {
    const r = await rig();
    r.prefetch.execute(prepare('明日の会議は'));
    const input = r.prefetch.input();
    if (input.state !== 'preparing') throw new Error('unexpected');
    r.prefetch.execute({ kind: 'cancel_prepare', audio_playback_id: input.audio_playback_id, reason: 'x' });
    expect(r.prefetch.similarityToPrepared('明日の会議は', 1).value).toBeCloseTo(1);

    const failing = await rig(() => {
      throw new Error('model_unavailable');
    });
    failing.prefetch.execute(prepare('明日の会議は'));
    await flush();
    expect(failing.prefetch.input()).toEqual({ state: 'idle' });
    expect(failing.events.ofType('prefetch.cancelled')[0]?.cancel_reason).toContain('model_unavailable');
    expect(failing.prefetch.similarityToPrepared('明日の会議は', 1).value).toBeNull();
  });
});
