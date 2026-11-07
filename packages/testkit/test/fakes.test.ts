/** 偽サーバー自身の試験。本番の API の動作を確かめるものではない。 */
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  FAKE_MODEL_VARIANT,
  MaaiWorkerToNode,
  encodeAudioFrame,
} from '@llm-vap/contracts';
import type { GeminiStreamChunk, GoogleSttResponse, GoogleSttStreamError, MaaiConfigure } from '@llm-vap/contracts';
import {
  FakeBrowserClient,
  FakeBrowserEchoServer,
  FakeElevenLabsServer,
  FakeGeminiServer,
  FakeGoogleSttTransport,
  FakeMaaiRpcServer,
} from '../src/index';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

const until = async (test: () => boolean, timeoutMs = 3000): Promise<void> => {
  const start = Date.now();
  while (!test()) {
    if (Date.now() - start > timeoutMs) throw new Error('until timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe('FakeBrowserEchoServer + FakeBrowserClient', () => {
  async function setup(options = {}) {
    const server = new FakeBrowserEchoServer(options);
    const port = await server.start();
    cleanups.push(() => server.stop());
    const client = new FakeBrowserClient(`ws://127.0.0.1:${port}`);
    await client.connect();
    cleanups.push(() => client.close());
    await client.waitFor(() => client.events.json.some((m) => m.type === 'server.hello'));
    return { server, client };
  }

  it('says it is fake and answers the clock ping', async () => {
    const { client } = await setup();
    const hello = client.events.json.find((m) => m.type === 'server.hello');
    expect(hello).toMatchObject({ is_fake: true });
    client.sendJson({ type: 'clock.ping', seq: 5, client_t_ms: 100 });
    await client.waitFor(() => client.events.json.some((m) => m.type === 'clock.pong'));
    expect(client.events.json.find((m) => m.type === 'clock.pong')).toMatchObject({ seq: 5, client_t_ms: 100 });
  });

  it('echoes mic as PCM with playback id, generation and increasing seq', async () => {
    const { server, client } = await setup();
    const mic = Int16Array.from({ length: 320 }, (_, i) => i);
    client.sendAudio(mic);
    client.sendAudio(mic);
    await client.waitFor(() => client.events.pcm.length === 2);
    expect(client.events.json.find((m) => m.type === 'playback.begin')).toMatchObject({ generation: 0 });
    expect(client.events.pcm.map((p) => p.seq)).toEqual([0, 1]);
    expect(client.events.pcm[0]?.samples).toEqual(Array.from(mic));
    expect(server.uplinkFrames.map((f) => f.audio_frame)).toEqual([0, 320]);
  });

  it('honours the echo delay', async () => {
    const { client } = await setup({ echo_delay_samples: 320 });
    const first = new Int16Array(320).fill(1);
    client.sendAudio(first);
    client.sendAudio(new Int16Array(320).fill(2));
    await client.waitFor(() => client.events.pcm.length === 1);
    expect(client.events.pcm[0]?.samples[0]).toBe(1);
  });

  it('stop advances the generation; the client drops frames of older generations', async () => {
    const { server, client } = await setup({ echo: false });
    server.sendPcm(new Int16Array(160));
    await client.waitFor(() => client.events.pcm.length === 1);
    const before = server.currentPlaybackId;
    const generation = server.stopPlayback({ mode: 'immediate' });
    expect(generation).toBe(1);
    await client.waitFor(() => client.events.json.some((m) => m.type === 'playback.stop'));
    expect(client.events.json.find((m) => m.type === 'playback.stop')).toMatchObject({ audio_playback_id: before, generation: 1 });
    server.sendPcm(new Int16Array(160));
    await client.waitFor(() => client.events.pcm.length === 2);
    expect(client.events.pcm[1]).toMatchObject({ generation: 1, seq: 0 });
    expect(client.events.pcm[1]?.audio_playback_id).toBe(before + 1);
    expect(client.events.staleDropped).toBe(0);
  });

  it('rejects messages that break the contract', async () => {
    const { server, client } = await setup();
    expect(() => client.sendJson({ type: 'clock.ping' } as never)).toThrow();
    expect(() => server.send({ type: 'gaze.command', target: 'ceiling' } as never)).toThrow();
  });

  it('records reports from the client', async () => {
    const { server, client } = await setup({ echo: false });
    client.sendJson({
      type: 'gaze.report',
      target: 'away',
      visible: true,
      client_t_ms: { value: 10 },
    });
    await until(() => server.received.some((m) => m.type === 'gaze.report'));
  });
});

describe('FakeMaaiRpcServer', () => {
  const configure: MaaiConfigure = {
    type: 'CONFIGURE',
    protocol_version: 1,
    session_id: 's',
    lang: 'jp_kyoto',
    model_type: 'normal-ver2',
    channel_layout: '2ch',
    frame_rate_hz: 12.5,
    sample_rate_hz: 16000,
    frame_samples: 320,
    device: 'cpu',
    speaking_threshold: 0.5,
  };

  async function setup(options = {}) {
    const server = new FakeMaaiRpcServer(options);
    const port = await server.start();
    cleanups.push(() => server.stop());
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise((r) => socket.once('open', r));
    cleanups.push(() => socket.terminate());
    const messages: MaaiWorkerToNode[] = [];
    let closed = false;
    socket.on('close', () => (closed = true));
    socket.on('message', (d) => messages.push(MaaiWorkerToNode.parse(JSON.parse(String(d)))));
    const sendFrames = (from: number, count: number) => {
      for (let i = 0; i < count; i++) {
        socket.send(
          encodeAudioFrame({ audio_frame: from + i * 320, mic: new Int16Array(320), sys: new Int16Array(320) }),
        );
      }
    };
    return { server, socket, messages, sendFrames, isClosed: () => closed };
  }

  const vap = (messages: MaaiWorkerToNode[]) => messages.filter((m) => m.type === 'VAP_STATE');

  it('declares itself fake and emits VAP_STATE once per MaAI frame period', async () => {
    const { socket, messages, sendFrames } = await setup();
    socket.send(JSON.stringify(configure));
    await until(() => messages.some((m) => m.type === 'READY'));
    expect(messages[0]).toMatchObject({ type: 'READY', is_fake: true, checkpoint: FAKE_MODEL_VARIANT });
    sendFrames(0, 8);
    await until(() => vap(messages).length === 2);
    expect(vap(messages).map((m) => m.audio_frame)).toEqual([1280, 2560]);
    expect(vap(messages)[0]).toMatchObject({ model_variant: FAKE_MODEL_VARIANT, raw: { fake: true } });
  });

  it('values come from the script, not from the audio', async () => {
    const script = () => ({
      p_now: [0.2, 0.8] as [number, number],
      p_future: [0.3, 0.7] as [number, number],
      vad: [0.9, 0.1] as [number, number],
    });
    const { socket, messages, sendFrames } = await setup({ script });
    socket.send(JSON.stringify(configure));
    sendFrames(0, 4);
    await until(() => vap(messages).length === 1);
    expect(vap(messages)[0]).toMatchObject({ p_now: [0.2, 0.8], user_speaking: true, system_speaking: false });
  });

  it('reports audio before CONFIGURE', async () => {
    const { messages, sendFrames } = await setup();
    sendFrames(0, 1);
    await until(() => messages.some((m) => m.type === 'ERROR'));
    expect(messages[0]).toMatchObject({ code: 'not_configured', fatal: false });
  });

  it('reports a network gap on both channels', async () => {
    const { socket, messages, sendFrames } = await setup();
    socket.send(JSON.stringify(configure));
    sendFrames(0, 1);
    sendFrames(960, 1);
    await until(() => messages.some((m) => m.type === 'FRAMES_DROPPED'));
    expect(messages.find((m) => m.type === 'FRAMES_DROPPED')).toMatchObject({
      from_audio_frame: 320,
      sample_count: 640,
      cause: 'network_gap',
      zero_filled: true,
      channels: 'both',
    });
  });

  it('can stall, resume and crash', async () => {
    const { server, socket, messages, sendFrames, isClosed } = await setup();
    socket.send(JSON.stringify(configure));
    server.stall();
    sendFrames(0, 8);
    await until(() => server.frames.length === 8);
    expect(vap(messages)).toHaveLength(0);
    server.resume();
    sendFrames(2560, 4);
    await until(() => vap(messages).length === 1);
    server.sendStatus('degraded', 'test');
    await until(() => messages.some((m) => m.type === 'WORKER_STATUS'));
    server.crash();
    await until(isClosed);
  });

  it('answers ping and closes on shutdown', async () => {
    const { socket, messages, isClosed } = await setup();
    socket.send(JSON.stringify({ type: 'PING', seq: 3, t_ms: 9 }));
    await until(() => messages.some((m) => m.type === 'PONG'));
    expect(messages[0]).toMatchObject({ seq: 3, t_ms: 9 });
    socket.send(JSON.stringify({ type: 'SHUTDOWN', reason: 'done' }));
    await until(isClosed);
  });
});

describe('FakeGoogleSttTransport', () => {
  const config = { model: 'fake', language_code: 'ja-JP', sample_rate_hz: 16000 };
  const collect = (stream: ReturnType<FakeGoogleSttTransport['openStream']>) => {
    const responses: GoogleSttResponse[] = [];
    const errors: GoogleSttStreamError[] = [];
    stream.onResponse((r) => responses.push(r));
    stream.onError((e) => errors.push(e));
    return { responses, errors };
  };
  const send = (stream: ReturnType<FakeGoogleSttTransport['openStream']>, ms: number) =>
    stream.write(new Int16Array((16000 * ms) / 1000));

  it('advances the script by audio position; unset stability is 0.0', () => {
    const transport = new FakeGoogleSttTransport({
      script: [
        { at_audio_ms: 100, transcript: 'あ' },
        { at_audio_ms: 200, transcript: 'あい', is_final: true, stability: 0.9 },
      ],
    });
    const stream = transport.openStream(config);
    const { responses } = collect(stream);
    send(stream, 50);
    expect(responses).toHaveLength(0);
    send(stream, 50);
    expect(responses[0]?.results[0]).toMatchObject({ transcript: 'あ', is_final: false, stability: 0, result_end_offset_ms: 100 });
    send(stream, 100);
    expect(responses[1]?.results[0]).toMatchObject({ is_final: true, stability: 0.9, result_end_offset_ms: 200 });
  });

  it('disconnects once; a new stream continues the script with offsets from its own start', () => {
    const transport = new FakeGoogleSttTransport({
      script: [{ at_audio_ms: 300, transcript: '再接続後' }],
      disconnect_at_audio_ms: 100,
    });
    const first = transport.openStream(config);
    const a = collect(first);
    send(first, 100);
    expect(a.errors[0]?.code).toBe('UNAVAILABLE');
    const second = transport.openStream(config);
    const b = collect(second);
    send(second, 200);
    expect(transport.openCount).toBe(2);
    expect(b.responses[0]?.results[0]).toMatchObject({ transcript: '再接続後', result_end_offset_ms: 200 });
    expect(b.errors).toHaveLength(0);
  });

  it('applies a stream limit only when the test sets one', () => {
    const limited = new FakeGoogleSttTransport({ script: [], max_stream_audio_ms: 100 });
    const stream = limited.openStream(config);
    const { errors } = collect(stream);
    send(stream, 100);
    expect(errors[0]?.code).toBe('OUT_OF_RANGE');
    expect(() => send(stream, 10)).toThrow();

    const unlimited = new FakeGoogleSttTransport({ script: [] });
    const other = unlimited.openStream(config);
    const c = collect(other);
    send(other, 10000);
    expect(c.errors).toHaveLength(0);
  });

  it('returns several results with different stability in one response', () => {
    const transport = new FakeGoogleSttTransport({
      script: [
        {
          at_audio_ms: 10,
          transcript: '',
          results: [
            { transcript: '月額料金の', stability: 0.9 },
            { transcript: '話', stability: 0.01 },
          ],
        },
      ],
    });
    const stream = transport.openStream(config);
    const { responses } = collect(stream);
    send(stream, 10);
    expect(responses[0]?.results.map((r) => r.stability)).toEqual([0.9, 0.01]);
  });

  it('accepts any write length and reports speech events', () => {
    const transport = new FakeGoogleSttTransport({
      script: [{ at_audio_ms: 40, transcript: '', speech_event_type: 'SPEECH_ACTIVITY_END' }],
    });
    const stream = transport.openStream(config);
    const { responses } = collect(stream);
    send(stream, 20);
    send(stream, 20);
    expect(responses[0]).toEqual({ results: [], speech_event_type: 'SPEECH_ACTIVITY_END', speech_event_offset_ms: 40 });
  });

  it('delays responses and ends cleanly', async () => {
    const transport = new FakeGoogleSttTransport({
      script: [{ at_audio_ms: 10, transcript: 'あ' }],
      response_delay_ms: 20,
    });
    const stream = transport.openStream(config);
    const { responses } = collect(stream);
    let ended = false;
    stream.onEnd(() => (ended = true));
    send(stream, 10);
    expect(responses).toHaveLength(0);
    await until(() => responses.length === 1);
    stream.end();
    expect(ended).toBe(true);
  });
});

describe('FakeElevenLabsServer', () => {
  type Message = { audio: string | null; isFinal: boolean | null; contextId?: string; alignment: { chars: string[]; charStartTimesMs: number[] } | null };

  async function connect(port: number, query = 'model_id=eleven_flash_v2_5&output_format=pcm_16000&sync_alignment=true', endpoint = 'stream-input') {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/text-to-speech/voice1/${endpoint}?${query}`);
    const messages: Message[] = [];
    const closed: { code?: number; reason?: string } = {};
    let isClosed = false;
    socket.on('message', (d) => messages.push(JSON.parse(String(d))));
    socket.on('close', (code, reason) => {
      closed.code = code;
      closed.reason = String(reason);
      isClosed = true;
    });
    await new Promise((r) => socket.once('open', r));
    cleanups.push(() => socket.terminate());
    return { socket, messages, closed, isClosed: () => isClosed };
  }

  async function setup(options = {}) {
    const server = new FakeElevenLabsServer(options);
    const port = await server.start();
    cleanups.push(() => server.stop());
    return { server, port };
  }

  it('streams PCM with chunk-relative per-character alignment and a final message', async () => {
    const { server, port } = await setup({ ms_per_char: 10, chars_per_chunk: 2 });
    const { socket, messages, isClosed } = await connect(port);
    socket.send(JSON.stringify({ text: ' ', xi_api_key: 'fake' }));
    socket.send(JSON.stringify({ text: 'あいう' }));
    socket.send(JSON.stringify({ text: '' }));
    await until(isClosed);
    expect(messages).toHaveLength(3);
    const first = Buffer.from(messages[0]?.audio as string, 'base64');
    expect(first.length).toBe(((16000 * 20) / 1000) * 2);
    expect(messages[0]?.alignment?.chars).toEqual(['あ', 'い']);
    expect(messages[1]?.alignment?.charStartTimesMs).toEqual([0]);
    expect(messages[2]).toMatchObject({ audio: null, isFinal: true });
    expect(server.textReceived).toEqual(['あいう']);
    expect(server.connections[0]).toMatchObject({ voice_id: 'voice1', model_id: 'eleven_flash_v2_5', kind: 'stream-input' });
  });

  it('omits alignment unless sync_alignment is set', async () => {
    const { port } = await setup({ ms_per_char: 10 });
    const { socket, messages } = await connect(port, 'output_format=pcm_16000');
    socket.send(JSON.stringify({ text: 'あ', xi_api_key: 'fake', flush: true }));
    await until(() => messages.length === 1);
    expect(messages[0]?.alignment).toBeNull();
  });

  it('flush sends what it has without ending', async () => {
    const { port } = await setup({ ms_per_char: 10, chars_per_chunk: 8 });
    const { socket, messages, isClosed } = await connect(port);
    socket.send(JSON.stringify({ text: 'あ', xi_api_key: 'fake', flush: true }));
    await until(() => messages.length === 1);
    expect(isClosed()).toBe(false);
  });

  it.each([
    ['model_id=eleven_v3&output_format=pcm_16000', 'eleven_v3'],
    ['model_id=eleven_flash_v2_5&output_format=mp3_44100', 'output_format'],
    ['output_format=pcm_16000&inactivity_timeout=181', 'inactivity_timeout'],
  ])('rejects %s', async (query, needle) => {
    const { port } = await setup();
    const { closed, isClosed } = await connect(port, query);
    await until(isClosed);
    expect(closed.code).toBe(1008);
    expect(closed.reason).toContain(needle);
  });

  it('requires a key in the first message', async () => {
    const { port } = await setup();
    const { socket, closed, isClosed } = await connect(port);
    socket.send(JSON.stringify({ text: 'あ' }));
    await until(isClosed);
    expect(closed.reason).toContain('xi_api_key');
  });

  it('closes an idle connection', async () => {
    const { port } = await setup({ idle_timeout_ms: 30 });
    const { closed, isClosed } = await connect(port);
    await until(isClosed);
    expect(closed.reason).toBe('input timeout');
  });

  it('can drop the connection mid-stream', async () => {
    const { port } = await setup({ chars_per_chunk: 1, disconnect_after_chunks: 1 });
    const { socket, messages, closed, isClosed } = await connect(port);
    socket.send(JSON.stringify({ text: 'あいう', xi_api_key: 'fake', flush: true }));
    await until(isClosed);
    expect(messages).toHaveLength(1);
    expect(closed.code).toBe(1006);
  });

  describe('multi-stream-input', () => {
    const multi = (port: number) =>
      connect(port, 'model_id=eleven_flash_v2_5&output_format=pcm_24000&sync_alignment=true&auto_mode=true&inactivity_timeout=180', 'multi-stream-input');

    it('keeps contexts apart on one connection', async () => {
      const { server, port } = await setup({ ms_per_char: 10, chars_per_chunk: 8 });
      const { socket, messages } = await multi(port);
      socket.send(JSON.stringify({ context_id: 'p1_g0', text: 'あ', xi_api_key: 'fake', flush: true }));
      socket.send(JSON.stringify({ context_id: 'p2_g0', text: 'い', flush: true }));
      socket.send(JSON.stringify({ context_id: 'p1_g0', close_context: true }));
      socket.send(JSON.stringify({ context_id: 'p2_g0', close_context: true }));
      await until(() => messages.filter((m) => m.isFinal).length === 2);
      expect(messages.filter((m) => m.audio).map((m) => m.contextId)).toEqual(['p1_g0', 'p2_g0']);
      expect(messages.find((m) => m.contextId === 'p2_g0' && m.audio)?.alignment?.chars).toEqual(['い']);
      expect(server.connections[0]).toMatchObject({ kind: 'multi-stream-input', auto_mode: true, inactivity_timeout_sec: 180 });
    });

    it('keeps sending flushed audio after close_context, then isFinal, and leaves the connection open', async () => {
      const { server, port } = await setup({ chars_per_chunk: 1, chunk_delay_ms: 2 });
      const { socket, messages, isClosed } = await multi(port);
      socket.send(JSON.stringify({ context_id: 'p1_g0', text: 'あいうえおかきくけこ', xi_api_key: 'fake', flush: true }));
      await until(() => messages.length >= 1);
      socket.send(JSON.stringify({ context_id: 'p1_g0', close_context: true }));
      await until(() => messages.some((m) => m.isFinal));
      expect(server.closedContexts).toEqual(['p1_g0']);
      expect(messages.filter((m) => m.audio)).toHaveLength(10);
      expect(messages.at(-1)).toMatchObject({ audio: null, isFinal: true, contextId: 'p1_g0' });
      expect(isClosed()).toBe(false);
    });

    it('does not send isFinal on flush', async () => {
      const { port } = await setup({ ms_per_char: 10, chars_per_chunk: 8 });
      const { socket, messages } = await multi(port);
      socket.send(JSON.stringify({ context_id: 'p1_g0', text: 'あ', xi_api_key: 'fake', flush: true }));
      await until(() => messages.length === 1);
      await new Promise((r) => setTimeout(r, 30));
      expect(messages.some((m) => m.isFinal)).toBe(false);
    });

    it('drops text that was not flushed when the context closes', async () => {
      const { port } = await setup({ ms_per_char: 10 });
      const socket = await connect(port, 'output_format=pcm_16000&sync_alignment=true', 'multi-stream-input');
      socket.socket.send(JSON.stringify({ context_id: 'p1_g0', text: 'あ', xi_api_key: 'fake' }));
      socket.socket.send(JSON.stringify({ context_id: 'p1_g0', close_context: true }));
      await until(() => socket.messages.some((m) => m.isFinal));
      expect(socket.messages.filter((m) => m.audio)).toHaveLength(0);
    });

    it('reports alignment times cumulative within the context, across flushes', async () => {
      const { port } = await setup({ ms_per_char: 10, chars_per_chunk: 2 });
      const { socket, messages } = await multi(port);
      socket.send(JSON.stringify({ context_id: 'p1_g0', text: 'あいう', xi_api_key: 'fake', flush: true }));
      socket.send(JSON.stringify({ context_id: 'p2_g0', text: 'か', flush: true }));
      socket.send(JSON.stringify({ context_id: 'p1_g0', text: 'え', flush: true }));
      await until(() => messages.filter((m) => m.audio).length === 4);
      const startsOf = (id: string) =>
        messages.filter((m) => m.contextId === id).map((m) => m.alignment?.charStartTimesMs);
      expect(startsOf('p1_g0')).toEqual([[0, 10], [20], [30]]);
      // 文脈が違えば基準も別。
      expect(startsOf('p2_g0')).toEqual([[0]]);
    });

    it('counts a closed context against the limit until isFinal, and can withhold isFinal', async () => {
      const { port } = await setup({ never_send_final: true });
      const { socket, messages, closed, isClosed } = await multi(port);
      for (let i = 0; i < 5; i++) {
        socket.send(JSON.stringify({ context_id: `c${i}`, text: ' ', xi_api_key: 'fake' }));
      }
      socket.send(JSON.stringify({ context_id: 'c0', close_context: true }));
      await new Promise((r) => setTimeout(r, 20));
      expect(messages.some((m) => m.isFinal)).toBe(false);
      // 枠は queue を送り切った時点で返す。
      socket.send(JSON.stringify({ context_id: 'c5', text: ' ' }));
      await new Promise((r) => setTimeout(r, 20));
      expect(isClosed()).toBe(false);
      socket.send(JSON.stringify({ context_id: 'c6', text: ' ' }));
      await until(isClosed);
      expect(closed.reason).toContain('too many contexts');
    });

    it('treats an empty text as a keep-alive', async () => {
      const { port } = await setup({ idle_timeout_ms: 60 });
      const { socket, isClosed } = await multi(port);
      socket.send(JSON.stringify({ context_id: 'p1_g0', text: '', xi_api_key: 'fake' }));
      await new Promise((r) => setTimeout(r, 40));
      socket.send(JSON.stringify({ context_id: 'p1_g0', text: '' }));
      await new Promise((r) => setTimeout(r, 40));
      expect(isClosed()).toBe(false);
    });

    it('rejects a sixth context', async () => {
      const { port } = await setup({ ms_per_char: 1 });
      const { socket, closed, isClosed } = await multi(port);
      for (let i = 0; i < 6; i++) {
        socket.send(JSON.stringify({ context_id: `c${i}`, text: 'あ', xi_api_key: 'fake' }));
      }
      await until(isClosed);
      expect(closed.reason).toContain('too many contexts');
    });
  });
});

describe('FakeGeminiServer', () => {
  async function setup(options = {}) {
    const server = new FakeGeminiServer(options);
    const port = await server.start();
    cleanups.push(() => server.stop());
    return { server, base: `http://127.0.0.1:${port}/v1beta/models/gemini-3.5-flash-lite` };
  }

  const body = JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'やあ' }] }] });
  const post = (url: string, init: RequestInit = {}) =>
    fetch(url, { method: 'POST', body, headers: { 'x-goog-api-key': 'fake' }, ...init });

  const parseSse = (text: string): GeminiStreamChunk[] =>
    text
      .split('\n\n')
      .filter((b) => b.startsWith('data: '))
      .map((b) => JSON.parse(b.slice('data: '.length)) as GeminiStreamChunk);

  it('streams SSE chunks that concatenate to the scripted text', async () => {
    const { server, base } = await setup({ responder: () => 'こんにちは、世界です', chars_per_chunk: 4 });
    const res = await post(`${base}:streamGenerateContent?alt=sse`);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const chunks = parseSse(await res.text());
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((c) => c.candidates[0]?.content.parts[0]?.text).join('')).toBe('こんにちは、世界です');
    expect(chunks.at(-1)?.candidates[0]?.finishReason).toBe('STOP');
    expect(chunks.at(0)?.candidates[0]?.finishReason).toBeUndefined();
    expect(server.requests[0]).toMatchObject({ model: 'gemini-3.5-flash-lite', api_key: 'fake' });
  });

  it('serves the non-streaming endpoint', async () => {
    const { base } = await setup({ responder: () => 'whole' });
    const res = await post(`${base}:generateContent`);
    const json = (await res.json()) as GeminiStreamChunk;
    expect(json.candidates[0]?.content.parts[0]?.text).toBe('whole');
  });

  it('streams the Interactions API and records store', async () => {
    const { server, base } = await setup({ responder: () => 'こんにちは世界', chars_per_chunk: 3 });
    const url = base.replace('/models/gemini-3.5-flash-lite', '/interactions?alt=sse');
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'x-goog-api-key': 'fake' },
      body: JSON.stringify({ model: 'gemini-3.5-flash-lite', input: 'やあ', stream: true, store: false }),
    });
    const events = (await res.text())
      .split('\n\n')
      .filter((b) => b.startsWith('data: '))
      .map((b) => JSON.parse(b.slice(6)) as { event_type: string; delta?: { text: string } });
    expect(events.at(-1)?.event_type).toBe('interaction.completed');
    expect(events.filter((e) => e.delta).map((e) => e.delta?.text).join('')).toBe('こんにちは世界');
    expect(server.interactions[0]?.body.store).toBe(false);
  });

  it('injects failures once, and 404s unknown paths', async () => {
    const { server, base } = await setup();
    server.failNext(429);
    expect((await post(`${base}:streamGenerateContent`)).status).toBe(429);
    expect((await post(`${base}:streamGenerateContent`)).status).toBe(200);
    expect((await post(`${base}:unknown`)).status).toBe(404);
  });

  it('notices a client that cancels mid-stream', async () => {
    const { server, base } = await setup({
      responder: () => 'x'.repeat(200),
      chars_per_chunk: 1,
      chunk_delay_ms: 5,
    });
    const controller = new AbortController();
    const res = await post(`${base}:streamGenerateContent?alt=sse`, { signal: controller.signal });
    const reader = res.body?.getReader();
    await reader?.read();
    controller.abort();
    await until(() => server.abortedResponses === 1);
  });
});
