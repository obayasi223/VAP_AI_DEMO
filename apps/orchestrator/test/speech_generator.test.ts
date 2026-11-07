import { beforeEach, describe, expect, it } from 'vitest';
import { ManualTimeSource, MemoryEventSink, absent, createEventEmitter, present, ttsContextId } from '@llm-vap/contracts';
import type { PlaybackStopMode, PrepareRequest, TtsChunk, TtsContextLoss } from '@llm-vap/contracts';
import { ScriptedLlmProvider, ScriptedTtsProvider } from '@llm-vap/testkit';
import type { ScriptedTtsConnection } from '@llm-vap/testkit';
import { SpeechGeneratorImpl } from '../src/speech';
import type { SpeechAudioSink, SpeechFinished, SpeechStateChange } from '../src/speech';

class RecordingSink implements SpeechAudioSink {
  begins: { audio_playback_id: number; generation: number; sample_rate_hz: number }[] = [];
  frames: Parameters<SpeechAudioSink['pcm']>[0][] = [];
  alignments: Parameters<SpeechAudioSink['alignment']>[0][] = [];
  stops: { audio_playback_id: number; generation: number; stop: PlaybackStopMode; reason: string }[] = [];
  begin = (m: RecordingSink['begins'][number]) => void this.begins.push(m);
  pcm = (f: RecordingSink['frames'][number]) => void this.frames.push(f);
  alignment = (m: RecordingSink['alignments'][number]) => void this.alignments.push(m);
  stop = (m: RecordingSink['stops'][number]) => void this.stops.push(m);
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
};

const RESPONSE: PrepareRequest = {
  segment_id: 1,
  transcript_revision: 5,
  text: '明日の会議は何時からですか',
  origin: { kind: 'response' },
};
const candidate = (version: number, text = 'それは違うと思います。'): PrepareRequest => ({
  segment_id: 1,
  transcript_revision: 5,
  text,
  origin: { kind: 'candidate', candidate_id: 'c1', candidate_version: version },
});
const EXPECT_V1 = { candidate_id: 'c1', candidate_version: 1 };

interface Rig {
  speech: SpeechGeneratorImpl;
  tts: ScriptedTtsConnection;
  llm: ScriptedLlmProvider;
  sink: RecordingSink;
  events: MemoryEventSink;
  time: ManualTimeSource;
  states: SpeechStateChange[];
  finished: SpeechFinished[];
}

async function rig(options: { reply?: string; ready_ms?: number; ms_per_char?: number; rate?: number; delta_delay_ms?: number } = {}): Promise<Rig> {
  const provider = new ScriptedTtsProvider({ ms_per_char: options.ms_per_char ?? 100, chars_per_chunk: 4 });
  const tts = await provider.open({ preferred_sample_rate_hz: options.rate ?? 16000 });
  const llm = new ScriptedLlmProvider({
    responder: () => options.reply ?? '三時からです。',
    delta_delay_ms: options.delta_delay_ms ?? 0,
    chars_per_delta: 3,
  });
  const sink = new RecordingSink();
  const events = new MemoryEventSink();
  const time = new ManualTimeSource();
  const emitter = createEventEmitter({ time, session_id: 's', condition: () => 'reactive', sink: events });
  const speech = new SpeechGeneratorImpl({
    tts,
    llm,
    prompt: (request) => ({ system: 'sys', messages: [{ role: 'user', text: request.text }] }),
    sink,
    time,
    emitter,
    is_ready_buffer_ms: options.ready_ms ?? 200,
  });
  const states: SpeechStateChange[] = [];
  const finished: SpeechFinished[] = [];
  speech.onStateChange((change) => states.push(change));
  speech.onFinished((f) => finished.push(f));
  return { speech, tts, llm, sink, events, time, states, finished };
}

const estimate = (chars: string[], each: number) => ({
  source: 'estimated_time_proportional' as const,
  chars,
  char_start_ms: chars.map((_, i) => i * each),
  char_duration_ms: chars.map(() => each),
});

const contextOf = (r: Rig, id: number) => r.tts.contexts.find((c) => c.audio_playback_id === id);

const chunkFor = (id: number, generation: number, overrides: Partial<TtsChunk> = {}): TtsChunk => ({
  context_id: `p${id}_g${generation}`,
  audio_playback_id: id,
  generation,
  seq: 100,
  sample_rate_hz: 16000,
  pcm: new Int16Array(16000),
  alignment: absent('test'),
  is_last: false,
  ...overrides,
});

const started = (id: number, generation: number) => ({
  type: 'playback.started' as const,
  audio_playback_id: id,
  generation,
  audio_frame: 1000,
  client_t_ms: 1,
  output_latency_ms: present(0),
});
const ended = (
  id: number,
  generation: number,
  reason: 'completed' | 'stopped' | 'discarded_before_start',
  samples_written: number,
  latency = 0,
) => ({
  type: 'playback.ended' as const,
  audio_playback_id: id,
  generation,
  reason,
  samples_written,
  samples_discarded: 0,
  audio_frame: 2000,
  client_t_ms: 2,
  output_latency_ms: present(latency),
});
const position = (id: number, generation: number, samples_written: number) => ({
  type: 'playback.position' as const,
  audio_playback_id: id,
  generation,
  samples_written,
  samples_buffered: 0,
  audio_frame: 1500,
  client_t_ms: 1,
  output_latency_ms: present(0),
  system_ch_source: 'written' as const,
});

describe('SpeechGenerator: is_ready', () => {
  it('prepare 直後は偽。PCM が規定量に達して真になる', async () => {
    const r = await rig({ ms_per_char: 100, ready_ms: 200 });
    const { audio_playback_id: id } = r.speech.prepare(candidate(1, 'あいうえおかきくけこ'));
    expect(r.speech.isReady(id)).toBe(false);
    await flush();
    const context = contextOf(r, id);
    expect(r.speech.isReady(id)).toBe(false);
    // 4文字 = 400ms で規定量を超える。
    context?.pump();
    expect(r.speech.isReady(id)).toBe(true);
    expect(r.states.filter((s) => s.state === 'ready')).toHaveLength(1);
  });

  it('規定量の手前では偽のまま', async () => {
    const r = await rig({ ms_per_char: 10, ready_ms: 200 });
    const { audio_playback_id: id } = r.speech.prepare(candidate(1, 'あいうえおかきくけこさしすせそ'.repeat(2)));
    await flush();
    contextOf(r, id)?.pump(); // 40ms
    expect(r.speech.isReady(id)).toBe(false);
    for (let i = 0; i < 3; i++) contextOf(r, id)?.pump(); // 160ms
    expect(r.speech.isReady(id)).toBe(false);
    contextOf(r, id)?.pump(); // 200ms
    expect(r.speech.isReady(id)).toBe(true);
  });

  it('規定量より短い発話は合成の完了で真（永久に待たない）', async () => {
    const r = await rig({ ms_per_char: 10, ready_ms: 200 });
    const { audio_playback_id: id } = r.speech.prepare(candidate(1, 'はい'));
    await flush();
    contextOf(r, id)?.pumpAll();
    expect(r.speech.isReady(id)).toBe(true);
  });

  it('未知の ID、再生中、取消後は偽', async () => {
    const r = await rig();
    expect(r.speech.isReady(999)).toBe(false);
    const { audio_playback_id: id } = r.speech.prepare(candidate(1));
    await flush();
    contextOf(r, id)?.pumpAll();
    expect(r.speech.start(id, EXPECT_V1)).toBe(true);
    expect(r.speech.isReady(id)).toBe(false);
    const other = r.speech.prepare(candidate(2));
    await flush();
    contextOf(r, other.audio_playback_id)?.pumpAll();
    r.speech.cancel(other.audio_playback_id, 'x');
    expect(r.speech.isReady(other.audio_playback_id)).toBe(false);
  });
});

describe('SpeechGenerator: LLM→TTS の連鎖と取消', () => {
  it('通常応答は LLM の delta を TTS へ流し、文末で flush、最後に endInput', async () => {
    const r = await rig({ reply: '三時です。会議室で。' });
    const { audio_playback_id: id } = r.speech.prepare(RESPONSE);
    await flush();
    const context = contextOf(r, id);
    expect(r.llm.requests[0]?.purpose).toBe('prefetch');
    expect(r.llm.requests[0]?.transcript_revision).toBe(5);
    expect(context?.sent.join('')).toBe('三時です。会議室で。');
    context?.pumpAll();
    expect(r.speech.isReady(id)).toBe(true);
    expect(r.speech.start(id)).toBe(true);
    expect(r.sink.frames.at(-1)?.end_of_stream).toBe(true);
  });

  it('候補は LLM を通さず発話文を TTS へ渡す', async () => {
    const r = await rig();
    const { audio_playback_id: id } = r.speech.prepare(candidate(1));
    await flush();
    expect(r.llm.requests).toHaveLength(0);
    expect(contextOf(r, id)?.sent.join('')).toBe('それは違うと思います。');
  });

  it('cancel は LLM の中断、文脈の取消、保持 PCM の破棄まで連鎖する', async () => {
    const r = await rig({ reply: 'あ'.repeat(90), delta_delay_ms: 1 });
    const { audio_playback_id: id } = r.speech.prepare(RESPONSE);
    await new Promise((resolve) => setTimeout(resolve, 15));
    const context = contextOf(r, id);
    const sentBefore = context?.sent.length ?? 0;
    expect(sentBefore).toBeGreaterThan(0);
    expect(r.speech.cancel(id, 'superseded')).toBe(true);
    expect(r.llm.requests[0]?.signal?.aborted).toBe(true);
    expect(context?.cancelled).toBe('superseded');
    await new Promise((resolve) => setTimeout(resolve, 15));
    // 取消の後は TTS へ送らない。
    expect(context?.sent.length).toBe(sentBefore);
    expect(r.speech.start(id)).toBe(false);
    expect(r.sink.frames).toHaveLength(0);
    expect(r.tts.activeContextCount).toBe(0);
  });

  it('文脈を開く前の cancel は LLM を呼ばない', async () => {
    const r = await rig();
    const { audio_playback_id: id } = r.speech.prepare(RESPONSE);
    r.speech.cancel(id, 'immediately');
    await flush();
    expect(r.llm.requests).toHaveLength(0);
    expect(r.tts.contexts).toHaveLength(0);
  });

  it('cancel は再生中の音声を止めない（U-2）', async () => {
    const r = await rig();
    const { audio_playback_id: id } = r.speech.prepare(candidate(1));
    await flush();
    contextOf(r, id)?.pumpAll();
    r.speech.start(id, EXPECT_V1);
    expect(r.speech.cancel(id, 'should_not_stop')).toBe(false);
    expect(r.speech.stateOf(id)).toBe('playing');
    expect(r.sink.stops).toHaveLength(0);
  });

  it('LLM の失敗は failed。途中まで作った PCM を準備として残さない', async () => {
    const r = await rig();
    (r.llm as unknown as { options: { responder: () => string } }).options.responder = () => {
      throw new Error('model_unavailable: HTTP 404');
    };
    const { audio_playback_id: id } = r.speech.prepare(RESPONSE);
    await flush();
    expect(r.states.at(-1)?.state).toBe('failed');
    expect(r.states.at(-1)?.reason).toContain('model_unavailable');
    expect(r.speech.isReady(id)).toBe(false);
    expect(r.speech.start(id)).toBe(false);
  });

  it('TTS が down になると未完了の準備は failed', async () => {
    const r = await rig();
    const { audio_playback_id: id } = r.speech.prepare(candidate(1, 'あいうえおかきくけこ'));
    await flush();
    contextOf(r, id)?.pump();
    expect(r.speech.isReady(id)).toBe(true);
    r.tts.deliverStatus('down', 'socket closed');
    expect(r.speech.isReady(id)).toBe(false);
    expect(r.states.at(-1)?.reason).toContain('tts_down');
  });

  it('文脈の喪失: 未再生は failed、再生中は届いた分で終わるよう end_of_stream を送る', async () => {
    const r = await rig();
    let notify: (loss: TtsContextLoss) => void = () => undefined;
    const tts = Object.assign(r.tts, {
      onContextLost: (listener: typeof notify) => {
        notify = listener;
        return () => undefined;
      },
    });
    const speech = new SpeechGeneratorImpl({
      tts,
      llm: r.llm,
      prompt: () => ({ system: '', messages: [] }),
      sink: r.sink,
      time: r.time,
      emitter: createEventEmitter({ time: r.time, session_id: 's', condition: () => 'reactive', sink: r.events }),
      is_ready_buffer_ms: 200,
    });
    const unstarted = speech.prepare(candidate(1, 'あいうえおかきくけこ'));
    const playing = speech.prepare(candidate(2, 'さしすせそたちつてと'));
    await flush();
    contextOf(r, playing.audio_playback_id)?.pump();
    speech.start(playing.audio_playback_id, { candidate_id: 'c1', candidate_version: 2 });
    notify({ ...unstarted, context_id: ttsContextId(unstarted.audio_playback_id, unstarted.generation), reason: 'socket closed' });
    expect(speech.stateOf(unstarted.audio_playback_id)).toBeNull();
    notify({ ...playing, context_id: ttsContextId(playing.audio_playback_id, playing.generation), reason: 'socket closed' });
    expect(speech.stateOf(playing.audio_playback_id)).toBe('playing');
    expect(r.sink.frames.at(-1)?.end_of_stream).toBe(true);
    expect(r.sink.frames.at(-1)?.pcm.length).toBe(0);
  });

  it('文脈は 4 本までで、未再生の通常応答から取り消す', async () => {
    const r = await rig();
    const ids = [
      r.speech.prepare(candidate(1)),
      r.speech.prepare(RESPONSE),
      r.speech.prepare(candidate(2)),
      r.speech.prepare(candidate(3)),
    ].map((p) => p.audio_playback_id);
    await flush();
    expect(r.tts.activeContextCount).toBe(4);
    r.speech.prepare(candidate(4));
    await flush();
    expect(r.tts.activeContextCount).toBe(4);
    expect(r.speech.stateOf(ids[1] as number)).toBeNull();
    expect(r.states.find((s) => s.state === 'cancelled')?.reason).toBe('context_limit');
  });
});

describe('SpeechGenerator: 世代違いの棄却', () => {
  it('取消後に届いた chunk を棄てる', async () => {
    const r = await rig();
    const { audio_playback_id: id, generation } = r.speech.prepare(candidate(1));
    await flush();
    r.speech.cancel(id, 'x');
    r.tts.emitChunk(chunkFor(id, generation));
    expect(r.speech.stats().stale_chunks_dropped).toBe(1);
    expect(r.speech.isReady(id)).toBe(false);
  });

  it('世代と文脈 ID が違う chunk を棄てる', async () => {
    const r = await rig();
    const { audio_playback_id: id, generation } = r.speech.prepare(candidate(1));
    await flush();
    r.tts.emitChunk(chunkFor(id, generation + 1));
    r.tts.emitChunk(chunkFor(id, generation, { context_id: 'other' }));
    r.tts.emitChunk(chunkFor(12345, 0));
    expect(r.speech.stats().stale_chunks_dropped).toBe(3);
    expect(r.speech.isReady(id)).toBe(false);
  });

  it('同じ seq の重複を棄てる', async () => {
    const r = await rig();
    const { audio_playback_id: id, generation } = r.speech.prepare(candidate(1));
    await flush();
    r.tts.emitChunk(chunkFor(id, generation, { seq: 0, pcm: new Int16Array(100) }));
    r.tts.emitChunk(chunkFor(id, generation, { seq: 0, pcm: new Int16Array(16000) }));
    expect(r.speech.stats().duplicate_chunks_dropped).toBe(1);
    expect(r.speech.isReady(id)).toBe(false);
  });

  it('stop で世代が増え、以後の PCM をブラウザへ流さない', async () => {
    const r = await rig({ reply: 'x' });
    const { audio_playback_id: id, generation } = r.speech.prepare(candidate(1, 'あいうえおかきく'));
    await flush();
    contextOf(r, id)?.pump();
    r.speech.start(id, EXPECT_V1);
    const framesBefore = r.sink.frames.length;
    r.speech.stop(id, 'interrupt', { stop_point: 'immediate', max_wait_ms: 200, decision_source: 'vap' });
    expect(r.sink.stops[0]?.generation).toBe(generation + 1);
    expect(r.speech.generation).toBe(generation + 1);
    r.tts.emitChunk(chunkFor(id, generation));
    expect(r.sink.frames.length).toBe(framesBefore);
    expect(r.speech.stats().stale_chunks_dropped).toBe(1);
    expect(contextOf(r, id)?.cancelled).toBe('interrupt');
  });

  it('別の音声の stop の前に準備した音声は、現在の世代で再生する（ブラウザに棄てられない）', async () => {
    const r = await rig();
    const a = r.speech.prepare(candidate(1, 'あいうえ'));
    const b = r.speech.prepare(RESPONSE);
    await flush();
    contextOf(r, a.audio_playback_id)?.pumpAll();
    contextOf(r, b.audio_playback_id)?.pumpAll();
    r.speech.start(a.audio_playback_id, EXPECT_V1);
    r.speech.stop(a.audio_playback_id, 'x');
    r.speech.handlePlaybackEnded(ended(a.audio_playback_id, r.speech.generation, 'stopped', 0), 10);
    expect(r.speech.start(b.audio_playback_id)).toBe(true);
    expect(r.sink.begins.at(-1)?.generation).toBe(r.speech.generation);
    expect(r.sink.frames.at(-1)?.generation).toBe(r.speech.generation);
  });

  it('古い世代のブラウザ報告を棄てる', async () => {
    const r = await rig();
    r.speech.prepare(RESPONSE);
    await flush();
    const first = r.speech.prepare(candidate(1, 'あいうえ'));
    await flush();
    contextOf(r, first.audio_playback_id)?.pumpAll();
    r.speech.stop(1, 'x'); // 未再生の取消。世代は増えない
    expect(r.speech.generation).toBe(0);
    const second = r.speech.prepare(candidate(2, 'かきくけ'));
    await flush();
    contextOf(r, second.audio_playback_id)?.pumpAll();
    r.speech.start(first.audio_playback_id, EXPECT_V1);
    r.speech.stop(first.audio_playback_id, 'x');
    r.speech.handlePlaybackEnded(ended(first.audio_playback_id, 1, 'stopped', 0), 1);
    r.speech.start(second.audio_playback_id, { candidate_id: 'c1', candidate_version: 2 });
    r.speech.handlePlaybackStarted(started(second.audio_playback_id, 0), 5);
    expect(r.speech.stats().stale_reports_dropped).toBe(1);
    expect(r.events.ofType('speech.started')).toHaveLength(0);
  });
});

describe('SpeechGenerator: 候補の版と PCM の一致', () => {
  async function readyCandidate(version = 1) {
    const r = await rig();
    const { audio_playback_id: id } = r.speech.prepare(candidate(version));
    await flush();
    contextOf(r, id)?.pumpAll();
    return { r, id };
  }

  it('一致すれば開始する', async () => {
    const { r, id } = await readyCandidate();
    expect(r.speech.startChecked(id, EXPECT_V1).ok).toBe(true);
    expect(r.sink.begins[0]?.audio_playback_id).toBe(id);
  });

  it('版が違えば拒否して旧 PCM を破棄する', async () => {
    const { r, id } = await readyCandidate();
    expect(r.speech.startChecked(id, { candidate_id: 'c1', candidate_version: 2 })).toEqual({
      ok: false,
      reason: 'candidate_mismatch',
    });
    expect(r.speech.stateOf(id)).toBeNull();
    expect(r.sink.frames).toHaveLength(0);
    expect(r.speech.start(id, EXPECT_V1)).toBe(false);
  });

  it('ID が違えば拒否する', async () => {
    const { r, id } = await readyCandidate();
    expect(r.speech.start(id, { candidate_id: 'other', candidate_version: 1 })).toBe(false);
  });

  it('候補を expected なしで開始できない。通常応答を候補として開始できない', async () => {
    const { r, id } = await readyCandidate();
    expect(r.speech.startChecked(id)).toEqual({ ok: false, reason: 'expected_candidate_required' });
    expect(r.speech.isReady(id)).toBe(true);

    const other = await rig();
    const response = other.speech.prepare(RESPONSE);
    await flush();
    contextOf(other, response.audio_playback_id)?.pumpAll();
    expect(other.speech.start(response.audio_playback_id, EXPECT_V1)).toBe(false);
  });

  it('REVISE／WITHDRAW: discardCandidate が旧版の PCM を破棄し、指定の版は残す', async () => {
    const r = await rig();
    const v1 = r.speech.prepare(candidate(1));
    const v2 = r.speech.prepare(candidate(2));
    await flush();
    expect(r.speech.discardCandidate('c1', 'revise', 2)).toBe(1);
    expect(r.speech.stateOf(v1.audio_playback_id)).toBeNull();
    expect(contextOf(r, v1.audio_playback_id)?.cancelled).toBe('revise');
    expect(r.speech.stateOf(v2.audio_playback_id)).toBe('preparing');
    expect(r.speech.discardCandidate('c1', 'withdraw')).toBe(1);
    expect(r.speech.stateOf(v2.audio_playback_id)).toBeNull();
  });

  it('準備中の start は not_ready、他の再生中は another_playback_active（U-1）', async () => {
    const r = await rig();
    const a = r.speech.prepare(candidate(1, 'あいうえ'));
    expect(r.speech.startChecked(a.audio_playback_id, EXPECT_V1)).toEqual({ ok: false, reason: 'not_ready' });
    const b = r.speech.prepare(RESPONSE);
    await flush();
    contextOf(r, a.audio_playback_id)?.pumpAll();
    contextOf(r, b.audio_playback_id)?.pumpAll();
    expect(r.speech.start(a.audio_playback_id, EXPECT_V1)).toBe(true);
    expect(r.speech.startChecked(b.audio_playback_id)).toEqual({ ok: false, reason: 'another_playback_active' });
  });
});

describe('SpeechGenerator: 再生と語境界の停止', () => {
  const TEXT = '今日は天気がいいです。';

  async function playing(rate = 16000) {
    const r = await rig({ ms_per_char: 100, rate });
    const { audio_playback_id: id } = r.speech.prepare(candidate(1, TEXT));
    await flush();
    contextOf(r, id)?.pumpAll();
    r.speech.start(id, EXPECT_V1);
    r.speech.handlePlaybackStarted(started(id, 0), 100);
    return { r, id };
  }

  it('保持した PCM を順に流し、seq は 0 から連番、大きな chunk は分割する', async () => {
    const r = await rig({ ms_per_char: 1000 });
    const { audio_playback_id: id } = r.speech.prepare(candidate(1, 'あいうえ'));
    await flush();
    contextOf(r, id)?.pumpAll();
    r.speech.start(id, EXPECT_V1);
    expect(r.sink.frames.map((f) => f.seq)).toEqual(r.sink.frames.map((_, i) => i));
    expect(Math.max(...r.sink.frames.map((f) => f.pcm.length))).toBeLessThanOrEqual(4800);
    expect(r.sink.frames.reduce((n, f) => n + f.pcm.length, 0)).toBe(64000);
    expect(r.sink.frames.filter((f) => f.end_of_stream)).toHaveLength(1);
  });

  it('再生中に届いた chunk はそのまま流す', async () => {
    const r = await rig({ ms_per_char: 100 });
    const { audio_playback_id: id } = r.speech.prepare(candidate(1, 'あいうえおかきくけこ'));
    await flush();
    const context = contextOf(r, id);
    context?.pump();
    r.speech.start(id, EXPECT_V1);
    const before = r.sink.frames.length;
    context?.pump();
    expect(r.sink.frames.length).toBeGreaterThan(before);
  });

  it('語時刻を差分で送る', async () => {
    const { r } = await playing();
    const text = r.sink.alignments.flatMap((a) => a.items.map((i) => i.text)).join('');
    expect(text).toBe(TEXT);
    expect(r.sink.alignments[0]?.items[0]?.granularity).toBe('word');
  });

  it('語境界で止める: 次の語境界の位置を 16kHz のサンプルで命令する', async () => {
    const { r, id } = await playing();
    r.speech.handlePlaybackPosition(position(id, 0, 250 * 16), r.time.monotonicMs());
    r.speech.stop(id, 'barge_in', { stop_point: 'word_boundary', max_wait_ms: 200, decision_source: 'vap' });
    // 「今日」200ms「は」300ms なので 250ms の次は 300ms。
    expect(r.sink.stops[0]?.stop).toEqual({
      mode: 'at_sample',
      stop_at_sample: 300 * 16,
      fade_ms: 30,
      deadline_ms: 200,
    });
  });

  it('TTS が 24kHz でも位置は 16kHz で換算する', async () => {
    const { r, id } = await playing(24000);
    r.speech.handlePlaybackPosition(position(id, 0, 250 * 16), r.time.monotonicMs());
    r.speech.stop(id, 'barge_in', { stop_point: 'word_boundary', max_wait_ms: 200, decision_source: 'vap' });
    expect(r.sink.stops[0]?.stop).toMatchObject({ stop_at_sample: 300 * 16 });
    r.speech.handlePlaybackEnded(ended(id, 1, 'stopped', 300 * 16), 500);
    expect(r.finished[0]?.spoken_text).toBe('今日は');
  });

  it('語境界が上限より遠ければ上限で止める', async () => {
    const { r, id } = await playing();
    r.speech.handlePlaybackPosition(position(id, 0, 250 * 16), r.time.monotonicMs());
    r.speech.stop(id, 'barge_in', { stop_point: 'word_boundary', max_wait_ms: 10, decision_source: 'fallback' });
    expect(r.sink.stops[0]?.stop).toMatchObject({ stop_at_sample: 260 * 16 });
    r.speech.handlePlaybackEnded(ended(id, 1, 'stopped', 260 * 16), 500);
    expect(r.events.ofType('speech.interrupted')[0]?.stop_point).toBe('fade_at_limit');
  });

  it('語境界の位置まで届かずに止まれば上限での停止と記録する', async () => {
    const { r, id } = await playing();
    r.speech.handlePlaybackPosition(position(id, 0, 250 * 16), r.time.monotonicMs());
    r.speech.stop(id, 'barge_in', { stop_point: 'word_boundary', max_wait_ms: 200, decision_source: 'vap' });
    r.speech.handlePlaybackEnded(ended(id, 1, 'stopped', 270 * 16), 500);
    expect(r.events.ofType('speech.interrupted')[0]?.stop_point).toBe('fade_at_limit');
  });

  it('前回の報告からの経過時間を位置に足す', async () => {
    const { r, id } = await playing();
    r.speech.handlePlaybackPosition(position(id, 0, 150 * 16), r.time.monotonicMs());
    r.time.advance(100); // 250ms 相当
    r.speech.stop(id, 'barge_in', { stop_point: 'word_boundary', max_wait_ms: 200, decision_source: 'vap' });
    expect(r.sink.stops[0]?.stop).toMatchObject({ stop_at_sample: 300 * 16 });
  });

  it('語境界の待ち中に命令を重ねない。immediate への格上げだけ受ける（U-8）', async () => {
    const { r, id } = await playing();
    const options = { stop_point: 'word_boundary', max_wait_ms: 200, decision_source: 'vap' } as const;
    r.speech.stop(id, 'a', options);
    r.speech.stop(id, 'b', options);
    expect(r.sink.stops).toHaveLength(1);
    r.speech.stop(id, 'c', { ...options, stop_point: 'immediate' });
    expect(r.sink.stops).toHaveLength(2);
    expect(r.sink.stops[1]?.stop).toEqual({ mode: 'immediate' });
    expect(r.sink.stops[1]?.generation).toBeGreaterThan(r.sink.stops[0]?.generation as number);
    r.speech.stop(id, 'd', { ...options, stop_point: 'immediate' });
    expect(r.sink.stops).toHaveLength(2);
  });

  it('割り込みの発話済みは語境界までで、speech.interrupted と履歴用の報告に残す', async () => {
    const { r, id } = await playing();
    r.speech.stop(id, 'barge_in', { stop_point: 'word_boundary', max_wait_ms: 500, decision_source: 'vap' });
    r.speech.handlePlaybackEnded(ended(id, 1, 'stopped', 450 * 16), 600);
    const [event] = r.events.ofType('speech.interrupted');
    expect(event?.spoken_text).toBe('今日は');
    expect(event?.spoken_text_precision).toBe('alignment_char');
    expect(event?.decision_source).toBe('vap');
    expect(event?.origin).toBe('candidate');
    expect(r.events.ofType('speech.ended')).toHaveLength(0);
    expect(r.finished).toEqual([
      {
        audio_playback_id: id,
        origin: { kind: 'candidate', candidate_id: 'c1', candidate_version: 1 },
        spoken_text: '今日は',
        spoken_text_precision: 'alignment_char',
        interrupted: true,
      },
    ]);
  });

  it('発話済みは出力遅延を差し引く（書き込み済みと聞こえた位置は違う）', async () => {
    const { r, id } = await playing();
    r.speech.stop(id, 'barge_in', { stop_point: 'immediate', max_wait_ms: 0, decision_source: 'vap' });
    r.speech.handlePlaybackEnded(ended(id, 1, 'stopped', 350 * 16, 100), 600);
    expect(r.finished[0]?.spoken_text).toBe('今日');
  });

  it('最後まで話せば全文で speech.ended', async () => {
    const { r, id } = await playing();
    r.speech.handlePlaybackEnded(ended(id, 0, 'completed', 1100 * 16, 50), 1300);
    const [event] = r.events.ofType('speech.ended');
    expect(event?.spoken_text).toBe(TEXT);
    expect(r.finished[0]?.interrupted).toBe(false);
    expect(r.speech.stateOf(id)).toBeNull();
  });

  it('割り込み以外の stop は speech.ended', async () => {
    const { r, id } = await playing();
    r.speech.stop(id, 'session_closing');
    r.speech.handlePlaybackEnded(ended(id, 1, 'stopped', 200 * 16), 400);
    expect(r.events.ofType('speech.interrupted')).toHaveLength(0);
    expect(r.events.ofType('speech.ended')[0]?.spoken_text).toBe('今日');
    expect(r.finished[0]?.interrupted).toBe(false);
  });

  it('speech.started は書き込み時刻＋出力遅延（§3.6）', async () => {
    const r = await rig();
    const { audio_playback_id: id } = r.speech.prepare(candidate(1));
    await flush();
    contextOf(r, id)?.pumpAll();
    r.speech.start(id, EXPECT_V1);
    r.speech.handlePlaybackStarted({ ...started(id, 0), output_latency_ms: present(40) }, 100);
    const [event] = r.events.ofType('speech.started');
    expect(event?.first_pcm_written_at).toBe(100);
    expect(event?.started_at).toBe(140);
    expect(event?.audio_frame).toBe(1000);
  });

  it('出力遅延が不明なら null と理由で、差し引かない', async () => {
    const r = await rig();
    const { audio_playback_id: id } = r.speech.prepare(candidate(1));
    await flush();
    contextOf(r, id)?.pumpAll();
    r.speech.start(id, EXPECT_V1);
    r.speech.handlePlaybackStarted({ ...started(id, 0), output_latency_ms: absent('unsupported') }, 100);
    expect(r.events.ofType('speech.started')[0]?.output_latency_ms.value).toBeNull();
    expect(r.events.ofType('speech.started')[0]?.started_at).toBe(100);
  });

  it('alignment がなければ time_proportional と明記する', async () => {
    const r = await rig();
    const { audio_playback_id: id, generation } = r.speech.prepare(candidate(1, 'あいうえ'));
    await flush();
    r.tts.emitChunk(chunkFor(id, generation, { seq: 0, pcm: new Int16Array(16000), alignment: absent('none'), is_last: true }));
    r.speech.start(id, EXPECT_V1);
    r.speech.handlePlaybackStarted(started(id, 0), 100);
    r.speech.stop(id, 'x', { stop_point: 'immediate', max_wait_ms: 0, decision_source: 'woz' });
    r.speech.handlePlaybackEnded(ended(id, 1, 'stopped', 8000), 500);
    expect(r.finished[0]).toMatchObject({ spoken_text: 'あい', spoken_text_precision: 'time_proportional' });
    expect(r.speech.stats().alignment_gaps).toBe(1);
  });

  it('alignment がないとき、比例配分は合成済みの文に限る（2文目の合成前の割り込み）', async () => {
    // Gemini TTS の形: 文ごとに1要求、alignment なし、推定の chars だけ付く。
    const r = await rig({ ready_ms: 100 });
    const { audio_playback_id: id, generation } = r.speech.prepare(candidate(1, 'はい。そうです。'));
    await flush();
    r.tts.emitChunk(
      chunkFor(id, generation, { seq: 1000, alignment: absent('provider_has_no_alignment'), estimated_alignment: estimate(['は', 'い', '。'], 300) }),
    );
    expect(r.speech.startChecked(id, EXPECT_V1).ok).toBe(true);
    r.speech.handlePlaybackStarted(started(id, generation), 1);
    r.speech.stop(id, 'x', { stop_point: 'immediate', max_wait_ms: 0, decision_source: 'vap' });
    // 合成済み 1 秒のうち 0.9 秒。送った全文（8文字）で配分すると「はい。そうです」になる。
    r.speech.handlePlaybackEnded(ended(id, generation + 1, 'stopped', 14400), 2);
    expect(r.finished[0]).toMatchObject({ spoken_text: 'はい', spoken_text_precision: 'time_proportional' });
  });

  it('合成の途中で文脈を失って最後まで再生しても（completed）、合成済みの範囲までしか話していない', async () => {
    const r = await rig({ ready_ms: 100 });
    const { audio_playback_id: id, generation } = r.speech.prepare(candidate(1, 'はい。そうです。'));
    await flush();
    r.tts.emitChunk(
      chunkFor(id, generation, { seq: 1000, alignment: absent('provider_has_no_alignment'), estimated_alignment: estimate(['は', 'い', '。'], 300) }),
    );
    expect(r.speech.startChecked(id, EXPECT_V1).ok).toBe(true);
    r.speech.handlePlaybackStarted(started(id, generation), 1);
    r.tts.deliverStatus('down', 'socket closed');
    expect(r.sink.frames.at(-1)?.end_of_stream).toBe(true);
    r.speech.handlePlaybackEnded(ended(id, generation, 'completed', 16000), 2);
    expect(r.finished[0]?.spoken_text).toBe('はい。');
  });

  it('再生前に捨てられたら発話イベントなしで空の発話済み', async () => {
    const r = await rig();
    const { audio_playback_id: id } = r.speech.prepare(candidate(1));
    await flush();
    contextOf(r, id)?.pumpAll();
    r.speech.start(id, EXPECT_V1);
    r.speech.stop(id, 'x');
    r.speech.handlePlaybackEnded(ended(id, 1, 'discarded_before_start', 0), 5);
    expect(r.events.ofType('speech.ended')).toHaveLength(0);
    expect(r.finished[0]?.spoken_text).toBe('');
  });

  it('未再生の stop は cancel と同じで世代を増やさない', async () => {
    const r = await rig();
    const { audio_playback_id: id } = r.speech.prepare(candidate(1));
    await flush();
    r.speech.stop(id, 'x');
    expect(r.speech.stateOf(id)).toBeNull();
    expect(r.sink.stops).toHaveLength(0);
    expect(r.speech.generation).toBe(0);
  });

  it('下りの失敗は failed として明示する', async () => {
    const r = await rig();
    r.sink.pcm = () => {
      throw new Error('ws closed');
    };
    const { audio_playback_id: id } = r.speech.prepare(candidate(1));
    await flush();
    contextOf(r, id)?.pumpAll();
    expect(r.speech.start(id, EXPECT_V1)).toBe(false);
    expect(r.states.at(-1)?.reason).toContain('sink_failed');
  });

  it('dispose で全部の準備を畳む', async () => {
    const r = await rig({ reply: 'あ'.repeat(30), delta_delay_ms: 2 });
    const { audio_playback_id: id } = r.speech.prepare(RESPONSE);
    await flush();
    r.speech.dispose();
    expect(r.llm.requests[0]?.signal?.aborted).toBe(true);
    expect(r.speech.stateOf(id)).toBeNull();
  });
});

describe('テストの前提', () => {
  let r: Rig;
  beforeEach(async () => {
    r = await rig();
  });
  it('発行したイベントは emitter のスキーマ検証を通っている', async () => {
    const { audio_playback_id: id } = r.speech.prepare(candidate(1));
    await flush();
    contextOf(r, id)?.pumpAll();
    r.speech.start(id, EXPECT_V1);
    r.speech.handlePlaybackStarted(started(id, 0), 1);
    r.speech.handlePlaybackEnded(ended(id, 0, 'completed', 16000), 2);
    expect(r.events.events.map((e) => e.event)).toEqual(['speech.started', 'speech.ended']);
  });
});

describe('推定の語時刻（TtsChunk.estimated_alignment）', () => {
  const prepareCandidate = async (r: Rig) => {
    const { audio_playback_id: id, generation } = r.speech.prepare(candidate(1, 'はい、わかりました。'));
    await flush();
    return { id, generation };
  };

  it('playback.alignment へ推定の印つきで転送し、発話済みは time_proportional のまま', async () => {
    const r = await rig({ ready_ms: 100 });
    const { id, generation } = await prepareCandidate(r);
    const seqBase = 1000;
    const send = (seq: number, overrides: Partial<TtsChunk>) =>
      r.tts.emitChunk(chunkFor(id, generation, { seq: seqBase + seq, alignment: absent('provider_has_no_alignment'), ...overrides }));
    send(0, { estimated_alignment: estimate(['は', 'い', '、'], 100) });
    expect(r.speech.startChecked(id, EXPECT_V1).ok).toBe(true);
    send(1, { estimated_alignment: estimate(['わ', 'か', 'り'], 100) });
    send(2, { pcm: new Int16Array(0), is_last: true });

    const estimated = r.sink.alignments.filter((a) => a.source === 'estimated_time_proportional');
    expect(estimated.length).toBeGreaterThan(0);
    expect(r.sink.alignments.every((a) => a.source === 'estimated_time_proportional')).toBe(true);
    const items = estimated.flatMap((a) => a.items);
    expect(items.map((w) => w.text).join('')).toBe('はい、わかり');
    // 2番目の chunk は最初の chunk の PCM（1 秒）の後ろに置かれる。
    expect(items.at(-1)?.end_ms).toBeCloseTo(1300);

    r.speech.handlePlaybackStarted(started(id, generation), 1);
    r.speech.handlePlaybackEnded(ended(id, generation, 'stopped', 16000), 2);
    expect(r.finished[0]?.spoken_text_precision).toBe('time_proportional');
  });

  it('プロバイダの時刻があれば印を付けず、推定は使わない', async () => {
    const r = await rig({ ready_ms: 100 });
    const { id, generation } = await prepareCandidate(r);
    r.tts.emitChunk(
      chunkFor(id, generation, {
        seq: 1000,
        alignment: present({ chars: ['は', 'い'], char_start_ms: [0, 100], char_duration_ms: [100, 100] }),
        estimated_alignment: estimate(['違', 'う'], 100),
        is_last: true,
      }),
    );
    expect(r.speech.startChecked(id, EXPECT_V1).ok).toBe(true);
    const items = r.sink.alignments.flatMap((a) => a.items).map((w) => w.text).join('');
    expect(items).toContain('はい');
    expect(items).not.toContain('違');
    expect(r.sink.alignments.every((a) => a.source === undefined)).toBe(true);
  });

  it('推定の語境界を停止点に使わない（語境界で止めたと記録しない）', async () => {
    const r = await rig({ ready_ms: 100 });
    const { id, generation } = await prepareCandidate(r);
    r.tts.emitChunk(
      chunkFor(id, generation, {
        seq: 1000,
        alignment: absent('provider_has_no_alignment'),
        estimated_alignment: estimate(['は', 'い', '、', 'そ', 'う'], 100),
      }),
    );
    expect(r.speech.startChecked(id, EXPECT_V1).ok).toBe(true);
    r.speech.handlePlaybackStarted(started(id, generation), 1);
    r.speech.stop(id, 'interrupt', { stop_point: 'word_boundary', max_wait_ms: 200, decision_source: 'vap' });
    r.speech.handlePlaybackEnded(ended(id, generation + 1, 'stopped', 3200), 2);
    const interrupted = r.events.ofType('speech.interrupted')[0];
    expect(interrupted?.stop_point).toBe('fade_at_limit');
  });
});
