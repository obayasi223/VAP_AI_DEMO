import { afterEach, describe, expect, it } from 'vitest';
import { ManualTimeSource, MemoryEventSink, ResearchEvent, createEventEmitter } from '@llm-vap/contracts';
import type { SttResult } from '@llm-vap/contracts';
import { FakeGoogleSttTransport } from '@llm-vap/testkit';
import { GoogleSttV2Provider } from '../../src/providers/stt/index';
import type { GoogleSttOptions, GoogleSttV2Session } from '../../src/providers/stt/index';
import { normalizeTranscript } from '../../src/providers/stt/transcript_text';
import { makeTimeline, TimelineSttTransport } from './timeline_stt_fake';
import type { TimelineOptions } from './timeline_stt_fake';

const SR = 16;
const until = async (test: () => boolean, timeoutMs = 3000): Promise<void> => {
  const start = Date.now();
  while (!test()) {
    if (Date.now() - start > timeoutMs) throw new Error('until timed out');
    await new Promise((r) => setTimeout(r, 2));
  }
};

const sessions: GoogleSttV2Session[] = [];
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.close();
});

async function setup(transport: ConstructorParameters<typeof GoogleSttV2Provider>[0]['transport'], options: Partial<GoogleSttOptions> = {}) {
  const time = new ManualTimeSource(1);
  const sink = new MemoryEventSink();
  const emitter = createEventEmitter({ time, session_id: 's', condition: () => 'reactive', sink });
  const provider = new GoogleSttV2Provider({ transport, time, emitter, provider_class: 'test_double', options: { drain_grace_ms: 50, retry_base_ms: 2, retry_max_ms: 5, ...options } });
  const session = await provider.open({ language_code: 'ja-JP', sample_rate_hz: 16000, interim_results: true, start_audio_frame: 0 });
  sessions.push(session);
  const results: SttResult[] = [];
  const statuses: { status: string; reason: string | null; attempt: number }[] = [];
  session.onResult((r) => results.push(r));
  session.onStatus((s) => statuses.push({ status: s.status, reason: s.reason.value, attempt: s.retry_attempt }));
  return { session, results, statuses, sink, time };
}

/** 発話の有無で振幅を変えた音声を流す。speaking が false の間は無音。 */
function pump(
  session: GoogleSttV2Session,
  transport: TimelineSttTransport | null,
  fromMs: number,
  toMs: number,
  speaking: (ms: number) => boolean = () => true,
): void {
  for (let ms = fromMs; ms < toMs; ms += 20) {
    if (transport) transport.nowMs = ms;
    const pcm = new Int16Array(20 * SR).fill(speaking(ms) ? 3000 : 0);
    session.pushAudio(ms * SR, pcm);
  }
}

const finalText = (results: SttResult[]) => results.filter((r) => r.kind === 'final').map((r) => r.text).join('');

function expectOrdered(results: SttResult[]) {
  for (let i = 1; i < results.length; i++) {
    const a = results[i - 1] as SttResult;
    const b = results[i] as SttResult;
    expect(b.transcript_revision).toBe(a.transcript_revision + 1);
    expect(b.audio_frame_end).toBeGreaterThanOrEqual(a.audio_frame_end);
    expect(b.asr_segment_id).toBeGreaterThanOrEqual(a.asr_segment_id);
    // 同じ ASR 区間で本文が縮まない（この偽物は書き直しをしないので、縮めば切替の不具合）。
    if (a.kind === 'interim' && b.asr_segment_id === a.asr_segment_id) {
      expect(normalizeTranscript(b.text).startsWith(normalizeTranscript(a.text))).toBe(true);
    }
  }
}

function expectEveryEventValid(sink: MemoryEventSink) {
  for (const event of sink.events) expect(ResearchEvent.safeParse(event).success).toBe(true);
}

// 切替を短い時間で起こす。比率は既定（240／285／270）と同じ順序。
const FAST = { overlap_start_ms: 4000, handover_deadline_ms: 8000, relax_silence_after_ms: 7000, min_overlap_ms: 500 };
const LONG_TEXT = 'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをんがぎぐげござじずぜぞだぢづでどばびぶべぼ';

describe('切替（2本が同じ音声を聞く）', () => {
  async function run(text: string, options: TimelineOptions, sessionOptions: Partial<GoogleSttOptions> = {}, endMs = 12000) {
    const timeline = makeTimeline(text);
    const transport = new TimelineSttTransport(timeline, options);
    const ctx = await setup(transport, { ...FAST, ...sessionOptions });
    const silentAt = (ms: number) => !timeline.some((c) => Math.abs(c.at_ms - ms) < 200);
    pump(ctx.session, transport, 0, endMs, (ms) => !silentAt(ms));
    await until(() => transport.streams.length >= 2 && ctx.session.diagnostics().handovers.length >= 1 && ctx.results.length > 0);
    await ctx.session.close();
    sessions.pop();
    return { ...ctx, transport, timeline };
  }

  it('無音に置く: 文字の欠落も重複もなく、revision は戻らない', async () => {
    // 4.1 秒から 1 秒の無音を置く位置に | を入れる。
    const text = `${LONG_TEXT.slice(0, 28)}|${LONG_TEXT.slice(28, 50)}`;
    const { results, session, transport, timeline, sink } = await run(text, {});
    const record = session.diagnostics().handovers[0];
    expect(record?.cause).toBe('silence');
    expect(normalizeTranscript(finalText(results))).toBe(timeline.map((c) => c.ch).join(''));
    expectOrdered(results);
    // A の最後の結果の後に B が来て、混ざらない。
    const streams = results.map((r) => r.stream_id);
    expect(streams.lastIndexOf('gstt_1')).toBeLessThan(streams.indexOf('gstt_2'));
    expect(transport.log[0]).toMatch(/^end:1/);
    expectEveryEventValid(sink);
  });

  it('話し続けて無音がない: 期限で切り替えても欠落も重複もない', async () => {
    const text = LONG_TEXT.slice(0, 70);
    const { results, session, timeline } = await run(text, {}, { handover_deadline_ms: 6000, relax_silence_after_ms: 5900 }, 11000);
    const record = session.diagnostics().handovers[0];
    expect(record?.cause).toBe('deadline');
    expect(record?.strip_method).toBe('suffix_match');
    expect(normalizeTranscript(finalText(results))).toBe(timeline.map((c) => c.ch).join(''));
    expectOrdered(results);
  });

  it('A の final が遅れても B は A の final より先に出ない', async () => {
    const text = LONG_TEXT.slice(0, 70);
    const { results, timeline, session } = await run(text, { close_delay_ms: 20 }, { handover_deadline_ms: 6000, relax_silence_after_ms: 5900 }, 11000);
    expect(normalizeTranscript(finalText(results))).toBe(timeline.map((c) => c.ch).join(''));
    expectOrdered(results);
    const firstB = results.findIndex((r) => r.stream_id === 'gstt_2');
    expect(results[firstB - 1]?.kind).toBe('final');
    expect(session.diagnostics().handovers[0]?.drain_ms).toBeGreaterThanOrEqual(0);
  });

  it('B の頭が崩れていても切替点の側で合わせる', async () => {
    const text = LONG_TEXT.slice(0, 70);
    const { results, timeline } = await run(text, { garble: { stream: 2, chars: 3 } }, { handover_deadline_ms: 6000, relax_silence_after_ms: 5900 }, 11000);
    expect(normalizeTranscript(finalText(results))).toBe(timeline.map((c) => c.ch).join(''));
  });

  it('同じ句の繰り返しでも別の周回へ合わせない', async () => {
    const text = 'くにのためになにができるか'.repeat(6);
    const { results, timeline, session } = await run(text, {}, { handover_deadline_ms: 6000, relax_silence_after_ms: 5900 }, 13000);
    expect(session.diagnostics().handovers[0]?.cause).toBe('deadline');
    expect(normalizeTranscript(finalText(results))).toBe(timeline.map((c) => c.ch).join(''));
  });

  it('A の half-close に応答がなくても grace で最後の interim を final にする', async () => {
    const text = LONG_TEXT.slice(0, 70);
    const timeline = makeTimeline(text);
    const transport = new TimelineSttTransport(timeline, { close_delay_ms: 10_000 });
    const { session, results } = await setup(transport, { ...FAST, handover_deadline_ms: 6000, relax_silence_after_ms: 5900 });
    pump(session, transport, 0, 6200);
    await until(() => session.diagnostics().handovers.length === 1);
    expect(session.diagnostics().handovers[0]?.a_final_synthesized).toBe(true);
    const finals = results.filter((r) => r.kind === 'final');
    expect(finals).toHaveLength(1);
    expect(finals[0]?.words).toEqual({ value: null, null_reason: 'synthesized_from_interim' });
  });

  it('重ねている間に A が切れたら B へ即座に移る', async () => {
    const text = LONG_TEXT.slice(0, 70);
    const timeline = makeTimeline(text);
    const transport = new TimelineSttTransport(timeline);
    const { session, results, statuses } = await setup(transport, { ...FAST, handover_deadline_ms: 9000, relax_silence_after_ms: 8900 });
    pump(session, transport, 0, 5000);
    expect(transport.streams).toHaveLength(2);
    transport.streams[0]?.fail('UNAVAILABLE');
    expect(session.diagnostics().handovers[0]?.cause).toBe('active_failed');
    pump(session, transport, 5000, 11000);
    await session.close();
    sessions.pop();
    expect(statuses.some((s) => s.status === 'degraded')).toBe(true);
    expect(normalizeTranscript(finalText(results))).toBe(timeline.map((c) => c.ch).join(''));
  });

  it('切替を stt.handover で発行し、provider.status には測定値を載せない', async () => {
    const timeline = makeTimeline(LONG_TEXT.slice(0, 40));
    const transport = new TimelineSttTransport(timeline);
    const { session, statuses, sink } = await setup(transport, { ...FAST, handover_deadline_ms: 6000, relax_silence_after_ms: 5900 });
    pump(session, transport, 0, 6200);
    await until(() => session.diagnostics().handovers.length === 1);
    await session.close();
    const events = sink.ofType('stt.handover');
    expect(events).toHaveLength(1);
    const record = session.diagnostics().handovers[0];
    expect(events[0]).toMatchObject({
      provider: 'google_stt_v2',
      from_stream: 'gstt_1',
      to_stream: 'gstt_2',
      cause: record?.cause,
      h_frame: record?.h_frame,
      a_age_ms: record?.a_age_ms,
      overlap_ms: record?.overlap_ms,
      a_final_synthesized: record?.a_final_synthesized,
    });
    const summary = statuses.find((s) => /^handover /.test(s.reason ?? ''));
    expect(summary?.status).toBe('ok');
    expect(summary?.reason).toBe(`handover gstt_1->gstt_2 cause=${record?.cause}`);
    expectEveryEventValid(sink);
  });

  it('B が開けなければ A で続け、後で開き直す', async () => {
    const timeline = makeTimeline(LONG_TEXT.slice(0, 40));
    const transport = new TimelineSttTransport(timeline);
    const { session, statuses } = await setup(transport, { ...FAST, handover_deadline_ms: 7000, relax_silence_after_ms: 6900 });
    pump(session, transport, 0, 4100);
    expect(transport.streams).toHaveLength(2);
    transport.streams[1]?.fail('UNAVAILABLE');
    expect(statuses.at(-1)?.reason).toMatch(/^shadow: UNAVAILABLE/);
    await new Promise((r) => setTimeout(r, 10));
    pump(session, transport, 4100, 4300);
    expect(transport.streams).toHaveLength(3);
    pump(session, transport, 4300, 7200);
    await until(() => session.diagnostics().handovers.length === 1);
    expect(session.diagnostics().handovers[0]?.to_stream).toBe('gstt_3');
  });

  it('既定値で 240 秒に重ね始め、285 秒までに切り替え、302 秒に達しない', async () => {
    const transport = new TimelineSttTransport(makeTimeline('あ'.repeat(3)));
    const { session } = await setup(transport);
    pump(session, transport, 0, 239_900);
    expect(transport.streams).toHaveLength(1);
    pump(session, transport, 239_900, 240_100);
    expect(transport.streams).toHaveLength(2);
    // この音声は無音なし。
    pump(session, transport, 240_100, 284_900);
    expect(session.diagnostics().handovers).toHaveLength(0);
    pump(session, transport, 284_900, 285_100);
    expect(session.diagnostics().handovers[0]?.cause).toBe('deadline');
    expect(session.diagnostics().handovers[0]?.a_age_ms).toBeLessThan(286_000);
  });
});

describe('安定と未安定', () => {
  it('stability の違う結果を分け、一度安定した接頭部を戻さない', async () => {
    const transport = new FakeGoogleSttTransport({
      script: [
        { at_audio_ms: 100, transcript: '', results: [{ transcript: '国が', stability: 0.9 }, { transcript: 'あな', stability: 0.01 }] },
        // 実測: 0.9 の部分が短くなることがある。
        { at_audio_ms: 200, transcript: '', results: [{ transcript: '国', stability: 0.9 }, { transcript: 'があなた', stability: 0.01 }] },
        // 書き直しなら戻す。
        { at_audio_ms: 300, transcript: '', results: [{ transcript: '国', stability: 0.9 }, { transcript: 'でも', stability: 0.01 }] },
        { at_audio_ms: 400, transcript: '国でも何か', is_final: true },
      ],
    });
    const { session, results, sink } = await setup(transport);
    pump(session, null, 0, 420);
    expect(results.map((r) => r.stable_text)).toEqual(['国が', '国が', '国', '国でも何か']);
    expect(results.map((r) => r.unstable_text)).toEqual(['あな', 'あなた', 'でも', '']);
    expect(results[0]?.stability).toEqual({ value: 0.9 });
    expect(results[0]?.parts).toHaveLength(2);
    // final の 0.0 は未設定の印。
    expect(results[3]?.stability.value).toBeNull();
    expect(results[3]?.asr_segment_id).toBe(0);
    expectEveryEventValid(sink);
    expect(sink.ofType('stt.interim')).toHaveLength(3);
    expect(sink.ofType('stt.final')).toHaveLength(1);
  });

  it('句読点の変動では安定の境界を動かさない', async () => {
    const transport = new FakeGoogleSttTransport({
      script: [
        { at_audio_ms: 100, transcript: '国。', stability: 0.9 },
        { at_audio_ms: 200, transcript: '', results: [{ transcript: '国が？', stability: 0.01 }] },
      ],
    });
    const { session, results } = await setup(transport);
    pump(session, null, 0, 220);
    expect(results[1]?.stable_text).toBe('国');
    expect(results[1]?.text).toBe('国が？');
  });

  it('stability が返らなければ N revision と経過時間の両方で求め、source を derived にする', async () => {
    const transport = new FakeGoogleSttTransport({
      script: [
        { at_audio_ms: 100, transcript: 'きょうは' },
        { at_audio_ms: 200, transcript: 'きょうはい' },
        { at_audio_ms: 300, transcript: 'きょうはいい' },
        { at_audio_ms: 400, transcript: 'きょうはいいて' },
      ],
    });
    const { session, results, time } = await setup(transport, { derived_revisions: 3, derived_min_age_ms: 300 });
    pump(session, null, 0, 320);
    expect(results.map((r) => r.stable_text)).toEqual(['', '', '']);
    expect(results[0]?.stability_source).toBe('derived');
    expect(results[0]?.stability.value).toBeNull();
    time.advance(400);
    pump(session, null, 320, 420);
    // 最も新しい条件を満たす revision（「きょうはい」）から今までの共通接頭部。
    expect(results.at(-1)?.stable_text).toBe('きょうはい');
  });
});

describe('segment_id は音声位置で決まる', () => {
  it('境界より前の語尾は到着が後でも旧 segment へ、差分は新 segment へ入る', async () => {
    const transport = new FakeGoogleSttTransport({
      script: [
        { at_audio_ms: 100, transcript: 'あのね', stability: 0.9 },
        { at_audio_ms: 200, transcript: 'あのねそれは', stability: 0.9 },
        { at_audio_ms: 300, transcript: 'あのねそれはちがう', stability: 0.9 },
        { at_audio_ms: 400, transcript: 'あのねそれはちがうよ', is_final: true },
        { at_audio_ms: 500, transcript: 'つぎ', stability: 0.9 },
      ],
    });
    const { session, results, sink } = await setup(transport);
    pump(session, null, 0, 100);
    // 境界は 200ms。呼ばれた時点ではまだ 200ms の結果は届いていない。
    session.advanceSegment(1, 200 * SR);
    pump(session, null, 100, 520);
    expect(results.map((r) => [r.kind, r.segment_id, r.asr_segment_id, r.text])).toEqual([
      ['interim', 0, 0, 'あのね'],
      ['interim', 0, 0, 'あのねそれは'],
      // 新しい文字が出たので旧 segment を閉じる。
      ['final', 0, 0, 'あのねそれは'],
      ['interim', 1, 1, 'ちがう'],
      // final 済みの部分は次へ含まれない前提で、差し引きは未確定部分だけ。
      ['final', 1, 1, 'ちがうよ'],
      ['interim', 1, 2, 'つぎ'],
    ]);
    expect(results[2]?.audio_frame_end).toBe(200 * SR);
    expect(results[3]?.asr_segment_frame_start).toBe(200 * SR);
    expectEveryEventValid(sink);
  });

  it('境界の後に新しい文字がなければ final まで全部旧 segment', async () => {
    const transport = new FakeGoogleSttTransport({
      script: [
        { at_audio_ms: 100, transcript: 'おわり', stability: 0.9 },
        { at_audio_ms: 300, transcript: 'おわり', stability: 0.9 },
        { at_audio_ms: 400, transcript: 'おわり。', is_final: true },
        { at_audio_ms: 500, transcript: 'はい', stability: 0.9 },
      ],
    });
    const { session, results } = await setup(transport);
    session.advanceSegment(1, 200 * SR);
    pump(session, null, 0, 520);
    expect(results.map((r) => [r.kind, r.segment_id, r.text])).toEqual([
      ['interim', 0, 'おわり'],
      ['interim', 0, 'おわり'],
      ['final', 0, 'おわり。'],
      ['interim', 1, 'はい'],
    ]);
  });

  it('本文が書き直されたら共通接頭部までを旧へ入れる', async () => {
    const transport = new FakeGoogleSttTransport({
      script: [
        { at_audio_ms: 100, transcript: 'あいう', stability: 0.9 },
        { at_audio_ms: 300, transcript: 'あいXYZ', is_final: true },
      ],
    });
    const { session, results } = await setup(transport);
    session.advanceSegment(1, 200 * SR);
    pump(session, null, 0, 320);
    expect(results.map((r) => [r.kind, r.segment_id, r.text])).toEqual([
      ['interim', 0, 'あいう'],
      ['final', 0, 'あい'],
      ['final', 1, 'XYZ'],
    ]);
  });

  it('final の語時刻は境界で分け、音声に欠落があっても audio_frame へ正しく写す', async () => {
    const transport = new FakeGoogleSttTransport({
      script: [
        {
          at_audio_ms: 200,
          transcript: 'はい',
          is_final: true,
          words: [{ word: 'はい', end_offset_ms: 150 }],
        },
      ],
    });
    const { session, results } = await setup(transport);
    pump(session, null, 0, 100);
    // 100ms 分が欠けた。
    pump(session, null, 200, 320);
    expect(session.diagnostics().input_gap_samples).toBe(100 * SR);
    // offset 150ms は送信音声で 150ms、つまり audio_frame では 250ms。
    expect(results[0]?.words).toEqual({ value: [{ text: 'はい', audio_frame_start: 0, audio_frame_end: 250 * SR }] });
  });
});

describe('送信の束ね', () => {
  it('任意の長さの入力を 40ms に束ねる', async () => {
    const written: number[] = [];
    const transport = new FakeGoogleSttTransport({ script: [] });
    const real = transport.openStream.bind(transport);
    transport.openStream = (config) => {
      const stream = real(config);
      const write = stream.write.bind(stream);
      stream.write = (pcm) => {
        written.push(pcm.length);
        write(pcm);
      };
      return stream;
    };
    const { session } = await setup(transport);
    session.pushAudio(0, new Int16Array(320));
    session.pushAudio(320, new Int16Array(100));
    expect(written).toEqual([]);
    session.pushAudio(420, new Int16Array(1000));
    expect(written).toEqual([640, 640]);
    session.pushAudio(1420, new Int16Array(100));
    expect(written).toEqual([640, 640]);
    await session.close();
    sessions.pop();
    // 端数は閉じるときに送る。
    expect(written).toEqual([640, 640, 240]);
  });
});

describe('切断と再接続（F の偽トランスポート）', () => {
  it('切れたら degraded、未確定を final に昇格し、最後の結果の位置から再送して ok へ戻る', async () => {
    const transport = new FakeGoogleSttTransport({
      script: [
        { at_audio_ms: 100, transcript: 'きれる', stability: 0.9 },
        { at_audio_ms: 400, transcript: 'つづき', stability: 0.9 },
      ],
      disconnect_at_audio_ms: 200,
    });
    const { session, results, statuses, sink } = await setup(transport);
    pump(session, null, 0, 240);
    expect(transport.openCount).toBe(1);
    expect(statuses.at(-1)).toMatchObject({ status: 'degraded', attempt: 1 });
    expect(results.map((r) => [r.kind, r.text])).toEqual([['interim', 'きれる'], ['final', 'きれる']]);
    await until(() => {
      pump(session, null, 240 + cursor, 260 + cursor);
      cursor += 20;
      return transport.openCount === 2;
    });
    const before = results.length;
    pump(session, null, 240 + cursor, 700 + cursor);
    await until(() => results.length > before);
    expect(results.at(-1)?.text).toBe('つづき');
    expect(results.at(-1)?.stream_id).toBe('gstt_2');
    expect(results.at(-1)?.asr_segment_id).toBe(1);
    expect(statuses.at(-1)).toMatchObject({ status: 'ok', reason: 'reconnected', attempt: 0 });
    // 再送の分も offset を audio_frame へ戻す（100ms の位置から再送しているので順序が戻らない）。
    expectOrdered(results);
    expectEveryEventValid(sink);
  });
  let cursor = 0;

  it('応答の遅れがあっても順序と所属が変わらない', async () => {
    const transport = new FakeGoogleSttTransport({
      script: [
        { at_audio_ms: 100, transcript: 'おそい', stability: 0.9 },
        { at_audio_ms: 200, transcript: 'おそいね', is_final: true },
      ],
      response_delay_ms: 15,
    });
    const { session, results } = await setup(transport);
    pump(session, null, 0, 220);
    expect(results).toHaveLength(0);
    await until(() => results.length === 2);
    expect(results.map((r) => r.transcript_revision)).toEqual([1, 2]);
    expect(results[1]?.audio_frame_end).toBe(200 * SR);
  });

  it('上限のエラーでも開き直す。認証の誤りでは止まって down', async () => {
    const limited = new FakeGoogleSttTransport({ script: [], max_stream_audio_ms: 100 });
    const a = await setup(limited);
    pump(a.session, null, 0, 120);
    expect(a.statuses.at(-1)).toMatchObject({ status: 'degraded' });
    expect(a.statuses.at(-1)?.reason).toMatch(/^OUT_OF_RANGE/);

    const denied = new TimelineSttTransport(makeTimeline('あ'));
    const b = await setup(denied);
    denied.streams[0]?.fail('PERMISSION_DENIED');
    expect(b.statuses.at(-1)).toMatchObject({ status: 'down' });
    await new Promise((r) => setTimeout(r, 15));
    pump(b.session, denied, 0, 100);
    expect(denied.streams).toHaveLength(1);
  });

  it('繰り返し失敗すると down を表示し、音声が来なければ開き直さない', async () => {
    const transport = new TimelineSttTransport(makeTimeline('あ'));
    const { session, statuses } = await setup(transport, { down_after_attempts: 2 });
    transport.streams[0]?.fail('UNAVAILABLE');
    await new Promise((r) => setTimeout(r, 15));
    expect(transport.streams).toHaveLength(1);
    pump(session, transport, 0, 60);
    expect(transport.streams).toHaveLength(2);
    transport.streams[1]?.fail('UNAVAILABLE');
    expect(statuses.at(-1)).toMatchObject({ status: 'down', attempt: 2 });
  });

  it('cost.usage を送信量で記録する（重ねた分も数える）', async () => {
    const transport = new TimelineSttTransport(makeTimeline('あ'));
    const { session, sink } = await setup(transport, { ...FAST, handover_deadline_ms: 100_000, relax_silence_after_ms: 90_000, cost_interval_audio_ms: 2000 });
    pump(session, transport, 0, 5000);
    await session.close();
    sessions.pop();
    const usage = sink.ofType('cost.usage');
    const seconds = usage.reduce((sum, u) => sum + u.quantity, 0);
    expect(usage.length).toBeGreaterThan(1);
    // 5 秒＋重ねた 1 秒弱。
    expect(seconds).toBeGreaterThan(5.5);
    expect(seconds).toBeLessThan(6.2);
    expect(usage[0]?.estimated_cost_usd.value).toBeCloseTo((usage[0]!.quantity / 60) * 0.016);
  });
});
