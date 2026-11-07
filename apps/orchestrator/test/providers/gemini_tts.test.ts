import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ManualTimeSource, MemoryEventSink, ResearchEvent, createEventEmitter } from '@llm-vap/contracts';
import { ScriptedTtsProvider } from '@llm-vap/testkit';
import {
  CharEstimator,
  ELEVENLABS_CAPABILITIES,
  GEMINI_TTS_CAPABILITIES,
  GeminiTtsProvider,
  chooseTtsProvider,
  createTtsProviderFromEnv,
  ttsCapabilitiesOf,
} from '../../src/providers/tts/index';
import type { GeminiTtsConnection, TtsChunkWithEstimate } from '../../src/providers/tts/index';

const API_KEY = 'unit-test-gemini-key';
const until = async (test: () => boolean, timeoutMs = 3000): Promise<void> => {
  const start = Date.now();
  while (!test()) {
    if (Date.now() - start > timeoutMs) throw new Error('until timed out');
    await new Promise((r) => setTimeout(r, 2));
  }
};

/** 実 API で観察した SSE の形を返す試験用サーバー（本番の検証には数えない）。 */
interface StubStep {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  chunks?: number;
  delay_ms?: number;
  /** 途中で接続を切る。 */
  break_after?: number;
}

async function stubServer(steps: StubStep[]) {
  const requests: { url: string; key: string | undefined; body: Record<string, unknown> }[] = [];
  let aborted = 0;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', async () => {
      requests.push({ url: req.url ?? '', key: req.headers['x-goog-api-key'] as string, body: JSON.parse(raw) });
      const step = steps[Math.min(requests.length - 1, steps.length - 1)] as StubStep;
      if (step.status) {
        res.writeHead(step.status, { 'content-type': 'application/json', ...step.headers });
        res.end(JSON.stringify(step.body ?? {}));
        return;
      }
      res.on('close', () => {
        if (!res.writableFinished) aborted += 1;
      });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (e: unknown) => res.write(`data: ${JSON.stringify(e)}\n\n`);
      send({ event_type: 'interaction.created' });
      send({ index: 0, step: { type: 'model_output' }, event_type: 'step.start' });
      const pcm = Buffer.alloc(4800); // 100ms
      for (let i = 0; i < (step.chunks ?? 3); i++) {
        if (step.break_after === i) {
          res.destroy();
          return;
        }
        if (step.delay_ms) await new Promise((r) => setTimeout(r, step.delay_ms));
        if (res.destroyed) return;
        send({ event_type: 'step.delta', delta: { type: 'audio', mime_type: 'audio/l16', sample_rate: 24000, channels: 1, data: pcm.toString('base64') } });
      }
      send({ event_type: 'step.stop', index: 0 });
      send({ event_type: 'interaction.completed' });
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return { requests, port, aborted: () => aborted, stop: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

async function setup(steps: StubStep[], options = {}) {
  const stub = await stubServer(steps);
  cleanups.push(stub.stop);
  const sink = new MemoryEventSink();
  const time = new ManualTimeSource(1);
  const emitter = createEventEmitter({ time, session_id: 's', condition: () => 'reactive', sink });
  const provider = new GeminiTtsProvider({
    api_key: API_KEY,
    time,
    emitter,
    provider_class: 'test_double',
    options: { base_url: `http://127.0.0.1:${stub.port}`, retry_base_ms: 2, ...options },
  });
  const connection = (await provider.open({ preferred_sample_rate_hz: 24000 })) as GeminiTtsConnection;
  cleanups.unshift(() => connection.close());
  const chunks: TtsChunkWithEstimate[] = [];
  connection.onChunk((c) => chunks.push(c));
  const lost: string[] = [];
  connection.onContextLost((l) => lost.push(l.reason));
  const statuses: { status: string; reason: string | null }[] = [];
  connection.onStatus((s) => statuses.push({ status: s.status, reason: s.reason.value }));
  return { stub, sink, connection, chunks, lost, statuses };
}

describe('Gemini TTS（試験用サーバー）', () => {
  it('要求の形: store:false、キーはヘッダのみ、flush まで送らない', async () => {
    const { stub, connection, chunks } = await setup([{}]);
    const context = connection.openContext({ audio_playback_id: 1, generation: 1 });
    context.sendText('こんにちは。');
    await new Promise((r) => setTimeout(r, 15));
    expect(stub.requests).toHaveLength(0);
    context.endInput();
    await until(() => chunks.some((c) => c.is_last));
    const request = stub.requests[0];
    expect(request?.key).toBe(API_KEY);
    expect(request?.url).not.toContain(API_KEY);
    expect(request?.body).toMatchObject({ model: 'gemini-3.8-flash-lite-tts', stream: true, store: false, response_format: { type: 'audio' } });
  });

  it('chunk の alignment は null で、推定は印のついた別項目に入る', async () => {
    const { connection, chunks, sink, statuses } = await setup([{ chunks: 4 }]);
    const context = connection.openContext({ audio_playback_id: 2, generation: 3 });
    const text = 'おはようございます';
    context.sendText(text);
    context.endInput();
    await until(() => chunks.some((c) => c.is_last));
    const audio = chunks.filter((c) => c.pcm.length > 0);
    expect(audio).toHaveLength(4);
    expect(audio[0]?.pcm.length).toBe(2400);
    expect(audio[0]?.sample_rate_hz).toBe(24000);
    for (const c of audio) {
      expect(c.alignment).toEqual({ value: null, null_reason: 'provider_has_no_alignment' });
      expect(c.estimated_alignment?.source).toBe('estimated_time_proportional');
    }
    expect(audio.flatMap((c) => c.estimated_alignment?.chars ?? []).join('')).toBe(text);
    expect(chunks.map((c) => c.seq)).toEqual(chunks.map((_, i) => i));
    expect(statuses[0]?.reason).toContain('alignment=estimated_time_proportional');
    expect(sink.ofType('cost.usage')[0]).toMatchObject({ unit: 'audio_seconds', quantity: 0.4 });
    for (const event of sink.events) expect(ResearchEvent.safeParse(event).success).toBe(true);
  });

  it('flush ごとに1要求で、文脈の中では順に出る', async () => {
    const { stub, connection, chunks } = await setup([{ chunks: 2, delay_ms: 5 }]);
    const context = connection.openContext({ audio_playback_id: 1, generation: 1 });
    context.sendText('ひとつめ。');
    context.flush();
    context.sendText('ふたつめ。');
    context.flush();
    context.endInput();
    await until(() => chunks.some((c) => c.is_last));
    expect(stub.requests).toHaveLength(2);
    expect(chunks.filter((c) => c.pcm.length > 0).flatMap((c) => c.estimated_alignment?.chars ?? []).join('')).toBe('ひとつめ。ふたつめ。');
  });

  it('取消: 未送信を捨て、要求を中断し、以後 chunk を出さない', async () => {
    const { stub, connection, chunks } = await setup([{ chunks: 50, delay_ms: 10 }]);
    const context = connection.openContext({ audio_playback_id: 1, generation: 1 });
    context.sendText('とりけす。');
    context.flush();
    context.sendText('まだおくっていない。');
    await until(() => chunks.length >= 1);
    context.cancel('withdrawn');
    const count = chunks.length;
    await until(() => stub.aborted() === 1);
    await new Promise((r) => setTimeout(r, 30));
    expect(chunks.length).toBe(count);
    expect(stub.requests).toHaveLength(1);
    expect(() => context.sendText('x')).toThrow(/after cancel/);
  });

  it('上限と再利用', async () => {
    const { connection } = await setup([{}], { max_contexts: 2 });
    connection.openContext({ audio_playback_id: 1, generation: 1 });
    const second = connection.openContext({ audio_playback_id: 2, generation: 1 });
    expect(() => connection.openContext({ audio_playback_id: 3, generation: 1 })).toThrow(/too many/);
    second.cancel('x');
    connection.openContext({ audio_playback_id: 3, generation: 1 });
    expect(() => connection.openContext({ audio_playback_id: 2, generation: 1 })).toThrow(/already used/);
  });

  it('429: 待ち時間が短ければ1回開き直す', async () => {
    const { stub, connection, chunks, statuses } = await setup([
      { status: 429, body: { error: { message: 'quota', details: [{ retryDelay: '0.01s' }] } } },
      {},
    ]);
    const context = connection.openContext({ audio_playback_id: 1, generation: 1 });
    context.sendText('はい。');
    context.endInput();
    await until(() => chunks.some((c) => c.is_last));
    expect(stub.requests).toHaveLength(2);
    expect(statuses.some((s) => s.status === 'degraded' && s.reason?.includes('HTTP 429'))).toBe(true);
    expect(statuses.at(-1)?.status).toBe('ok');
    expect(chunks.filter((c) => c.pcm.length > 0).length).toBeGreaterThan(0);
    expect(connection.diagnostics().rate_limited).toBe(1);
  });

  it('429: 待ち時間が長ければ失敗として知らせ、is_last で待ちを終わらせる', async () => {
    const { stub, connection, chunks, lost, statuses } = await setup([
      { status: 429, body: { error: { message: 'free tier quota', details: [{ retryDelay: '40s' }] } } },
    ]);
    const context = connection.openContext({ audio_playback_id: 1, generation: 1 });
    context.sendText('はい。');
    context.endInput();
    await until(() => chunks.some((c) => c.is_last));
    expect(stub.requests).toHaveLength(1);
    expect(lost[0]).toContain('HTTP 429');
    expect(statuses.at(-1)?.status).toBe('degraded');
    expect(chunks.at(-1)?.alignment).toEqual({ value: null, null_reason: 'context_lost' });
  });

  it('認証の失敗は down で、以後の文脈を開かせない。キーは状態に出ない', async () => {
    const { connection, chunks, statuses } = await setup([{ status: 403, body: { error: { message: `bad key ${API_KEY}` } } }]);
    const context = connection.openContext({ audio_playback_id: 1, generation: 1 });
    context.sendText('はい。');
    context.endInput();
    await until(() => chunks.some((c) => c.is_last));
    expect(statuses.at(-1)?.status).toBe('down');
    expect(JSON.stringify(statuses)).not.toContain(API_KEY);
    expect(() => connection.openContext({ audio_playback_id: 2, generation: 1 })).toThrow(/down/);
  });

  it('音声が出た後の切断は開き直さない（同じ音声を二重に出さない）', async () => {
    const { stub, connection, chunks, lost } = await setup([{ chunks: 5, break_after: 3, delay_ms: 10 }]);
    const context = connection.openContext({ audio_playback_id: 1, generation: 1 });
    context.sendText('きれる。');
    context.endInput();
    await until(() => chunks.some((c) => c.is_last));
    expect(stub.requests).toHaveLength(1);
    expect(lost).toHaveLength(1);
  });
});

describe('CharEstimator', () => {
  it('見積もりで割り当て、最後に残りを全部入れる', () => {
    const e = new CharEstimator('あいうえお', 100);
    expect(e.next(150, false).chars).toEqual(['あ']);
    const second = e.next(100, false);
    expect(second.chars).toEqual(['い']);
    expect(second.char_duration_ms).toEqual([100]);
    const last = e.next(100, true);
    expect(last.chars).toEqual(['う', 'え', 'お']);
    expect(last.char_start_ms[2]).toBeCloseTo(66.67, 1);
  });
});

describe('プロバイダの選択', () => {
  const time = new ManualTimeSource(0);
  it('既定は ElevenLabs のキーと声 ID の両方があれば ElevenLabs、なければ Gemini', () => {
    expect(chooseTtsProvider({ ELEVENLABS_API_KEY: 'k', ELEVENLABS_VOICE_ID: 'v' })).toBe('elevenlabs');
    expect(chooseTtsProvider({ ELEVENLABS_API_KEY: 'k' })).toBe('gemini');
    expect(chooseTtsProvider({})).toBe('gemini');
    expect(createTtsProviderFromEnv({ time, env: { GEMINI_API_KEY: 'g' } }).provider).toBe('gemini_tts');
    expect(createTtsProviderFromEnv({ time, env: { ELEVENLABS_API_KEY: 'k', ELEVENLABS_VOICE_ID: 'v', GEMINI_API_KEY: 'g' } }).provider).toBe('elevenlabs');
  });

  it('TTS_PROVIDER で固定でき、誤った値と不足は名前だけで失敗する', () => {
    expect(chooseTtsProvider({ TTS_PROVIDER: 'gemini', ELEVENLABS_API_KEY: 'k', ELEVENLABS_VOICE_ID: 'v' })).toBe('gemini');
    expect(chooseTtsProvider({ TTS_PROVIDER: 'elevenlabs' })).toBe('elevenlabs');
    expect(() => chooseTtsProvider({ TTS_PROVIDER: 'other' })).toThrow(/TTS_PROVIDER/);
    expect(() => createTtsProviderFromEnv({ time, env: {} })).toThrow('GEMINI_API_KEY');
    expect(() => createTtsProviderFromEnv({ time, env: { TTS_PROVIDER: 'elevenlabs' } })).toThrow('ELEVENLABS_API_KEY');
  });

  it('能力を判別できる。持たない実装は unknown', async () => {
    expect(GEMINI_TTS_CAPABILITIES.alignment_source).toBe('estimated_time_proportional');
    expect(GEMINI_TTS_CAPABILITIES.cancel_generation).toBe('request_abort');
    expect(ELEVENLABS_CAPABILITIES.alignment_source).toBe('provider_char');
    expect(ELEVENLABS_CAPABILITIES.cancel_stops_in_flight_audio).toBe(false);
    expect(GEMINI_TTS_CAPABILITIES.cancel_stops_in_flight_audio).toBe(true);
    const scripted = await new ScriptedTtsProvider().open({ preferred_sample_rate_hz: 24000 });
    expect(ttsCapabilitiesOf(scripted).alignment_source).toBe('unknown');
  });
});
