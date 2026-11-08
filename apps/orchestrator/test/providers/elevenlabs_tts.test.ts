import { afterEach, describe, expect, it } from 'vitest';
import { ManualTimeSource, MemoryEventSink, ResearchEvent, createEventEmitter, ttsContextId } from '@llm-vap/contracts';
import type { ProviderStatusUpdate, TtsChunk } from '@llm-vap/contracts';
import { FakeElevenLabsServer } from '@llm-vap/testkit';
import type { FakeElevenLabsOptions } from '@llm-vap/testkit';
import { ElevenLabsTtsProvider, mapAlignment } from '../../src/providers/tts/index';
import type { ElevenLabsConnection, ElevenLabsOptions, LostContext } from '../../src/providers/tts/index';
import { ElevenLabsProviderError, classifyElevenLabsError, createElevenLabsTtsProviderFromEnv, elevenLabsVoiceOptionsFromEnv, toChunkRelative } from '../../src/providers/tts/index';
import { WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';

const API_KEY = 'unit-test-key';
const until = async (test: () => boolean, timeoutMs = 3000): Promise<void> => {
  const start = Date.now();
  while (!test()) {
    if (Date.now() - start > timeoutMs) throw new Error('until timed out');
    await new Promise((r) => setTimeout(r, 2));
  }
};

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

async function setup(fake: FakeElevenLabsOptions = {}, options: Partial<ElevenLabsOptions> = {}) {
  // isFinal が届けば枠はすぐ返る。release_wait_ms は届かない場合の上限。
  const server = new FakeElevenLabsServer(fake);
  const port = await server.start();
  cleanups.push(() => server.stop());
  const sink = new MemoryEventSink();
  const time = new ManualTimeSource(1);
  const emitter = createEventEmitter({ time, session_id: 's', condition: () => 'reactive', sink });
  const provider = new ElevenLabsTtsProvider({
    api_key: API_KEY,
    voice_id: 'voice',
    time,
    emitter,
    provider_class: 'test_double',
    options: { base_url: `ws://127.0.0.1:${port}`, retry_base_ms: 5, retry_max_ms: 20, final_wait_ms: 500, release_wait_ms: 20, ...options },
  });
  const statuses: ProviderStatusUpdate[] = [];
  const connection = (await provider.open({ preferred_sample_rate_hz: 24000 })) as ElevenLabsConnection;
  cleanups.unshift(() => connection.close());
  const chunks: TtsChunk[] = [];
  const lost: LostContext[] = [];
  connection.onChunk((c) => chunks.push(c));
  connection.onStatus((s) => statuses.push(s));
  connection.onContextLost((l) => lost.push(l));
  return { server, connection, chunks, statuses, lost, sink };
}

describe('ElevenLabs（F の偽サーバー）', () => {
  it('計画どおりの接続を張り、キーを URL に入れない', async () => {
    const { server } = await setup();
    expect(server.connections[0]).toMatchObject({
      kind: 'multi-stream-input',
      model_id: 'eleven_flash_v2_5',
      output_format: 'pcm_24000',
      sync_alignment: true,
      auto_mode: true,
      inactivity_timeout_sec: 180,
    });
    expect(JSON.stringify(server.connections[0])).not.toContain(API_KEY);
  });

  it('文字単位の alignment を chunk ごとに渡し、最後に is_last を出す', async () => {
    const { connection, chunks, sink, statuses } = await setup({ ms_per_char: 100, chars_per_chunk: 4 });
    const context = connection.openContext({ audio_playback_id: 7, generation: 2 });
    expect(context.context_id).toBe(ttsContextId(7, 2));
    context.sendText('こんにちは世界');
    context.endInput();
    await until(() => chunks.at(-1)?.is_last === true);
    const audio = chunks.filter((c) => !c.is_last);
    expect(audio.flatMap((c) => c.alignment.value?.chars ?? []).join('')).toBe('こんにちは世界');
    // 偽サーバーは文脈の累積（実測）で返す。C が chunk 相対へ直して渡す。
    expect(audio[1]?.alignment.value?.char_start_ms[0]).toBe(0);
    expect(connection.diagnostics().alignment_rebased_chunks).toBe(1);
    expect(connection.diagnostics().synthesized_last_chunks).toBe(0);
    expect(statuses.every((s) => s.status === 'ok')).toBe(true);
    expect(audio[0]?.pcm.length).toBe(Math.round(0.4 * 24000));
    expect(chunks.map((c) => c.seq)).toEqual(chunks.map((_, i) => i));
    expect(chunks.every((c) => c.audio_playback_id === 7 && c.generation === 2 && c.sample_rate_hz === 24000)).toBe(true);
    const cost = sink.ofType('cost.usage');
    expect(cost[0]).toMatchObject({ quantity: 7, unit: 'characters', provider: 'elevenlabs' });
    for (const event of sink.events) expect(ResearchEvent.safeParse(event).success).toBe(true);
  });

  it('文脈ごとに取消でき、他の文脈は続き、取消の後の chunk は渡らない', async () => {
    const { connection, chunks, server } = await setup({ chunk_delay_ms: 5, chars_per_chunk: 2 });
    const keep = connection.openContext({ audio_playback_id: 1, generation: 1 });
    const drop = connection.openContext({ audio_playback_id: 2, generation: 1 });
    keep.sendText('のこるぶんしょう');
    drop.sendText('けされるぶんしょう');
    keep.flush();
    drop.flush();
    await until(() => chunks.some((c) => c.audio_playback_id === 2));
    drop.cancel('withdrawn');
    const dropped = chunks.filter((c) => c.audio_playback_id === 2).length;
    keep.endInput();
    await until(() => chunks.some((c) => c.audio_playback_id === 1 && c.is_last));
    expect(chunks.filter((c) => c.audio_playback_id === 2).length).toBe(dropped);
    // close_context の後も flush 済みの音声は届く。接続の層で棄てて数える。
    await until(() => connection.diagnostics().late_chunks_after_cancel > 0);
    expect(server.closedContexts).toContain(drop.context_id);
    expect(() => drop.sendText('x')).toThrow(/after cancel/);
    expect(() => keep.sendText('x')).toThrow(/after endInput|after cancel/);
  });

  it('上限を超えると例外。終わった文脈と取消した文脈は枠を返す', async () => {
    const { connection, chunks, server } = await setup();
    const contexts = [1, 2, 3, 4, 5].map((n) => connection.openContext({ audio_playback_id: n, generation: 1 }));
    expect(() => connection.openContext({ audio_playback_id: 6, generation: 1 })).toThrow(/too many/);
    contexts[0]?.cancel('test');
    // isFinal を待つ間は枠に数える（6本目で接続ごと閉じられるのを防ぐ）。
    expect(() => connection.openContext({ audio_playback_id: 6, generation: 1 })).toThrow(/too many/);
    await new Promise((r) => setTimeout(r, 40));
    const next = connection.openContext({ audio_playback_id: 6, generation: 1 });
    next.sendText('はい');
    next.endInput();
    await until(() => chunks.some((c) => c.audio_playback_id === 6 && c.is_last));
    connection.openContext({ audio_playback_id: 7, generation: 1 });
    await new Promise((r) => setTimeout(r, 20));
    // 偽サーバーの枠も超えていない（超えると接続が閉じる）。
    expect(server.connections).toHaveLength(1);
    expect(() => connection.openContext({ audio_playback_id: 6, generation: 1 })).toThrow(/already used/);
  });

  it('keep-alive で無通信の切断を防ぐ', async () => {
    const { connection, statuses, server, lost } = await setup({ idle_timeout_ms: 60 }, { keep_alive_ms: 15 });
    connection.openContext({ audio_playback_id: 1, generation: 1 });
    await new Promise((r) => setTimeout(r, 200));
    expect(lost).toHaveLength(0);
    expect(server.connections).toHaveLength(1);
    expect(statuses.every((s) => s.status === 'ok')).toBe(true);
  });

  it('文脈がないときの無通信の切断は静かに張り直す', async () => {
    const { connection, statuses, server, chunks } = await setup({ idle_timeout_ms: 30 });
    await until(() => server.connections.length >= 2);
    expect(statuses.some((s) => s.status !== 'ok')).toBe(false);
    const context = connection.openContext({ audio_playback_id: 1, generation: 1 });
    context.sendText('はい');
    context.endInput();
    await until(() => chunks.some((c) => c.is_last));
  });

  it('切断: 文脈を失ったと知らせ、degraded を出して張り直し、新しい文脈で続けられる', async () => {
    const { connection, chunks, statuses, lost, server } = await setup({ disconnect_after_chunks: 1, chars_per_chunk: 2, chunk_delay_ms: 1 });
    const context = connection.openContext({ audio_playback_id: 3, generation: 1 });
    context.sendText('きれるまでのぶん');
    context.flush();
    await until(() => lost.length === 1);
    expect(lost[0]).toMatchObject({ audio_playback_id: 3, generation: 1, context_id: context.context_id });
    expect(statuses.some((s) => s.status === 'degraded' && s.retry_attempt === 1)).toBe(true);
    // 失った文脈への操作は例外にしない。
    context.sendText('x');
    context.cancel('after loss');
    await until(() => server.connections.length === 2 && statuses.at(-1)?.status === 'ok');
    expect(connection.diagnostics().lost_contexts).toBe(1);
    expect(chunks.length).toBeGreaterThan(0);
  });

  it('接続を張り直す間に開いた文脈は、繋がってから送る', async () => {
    const { connection, chunks, server, lost } = await setup({ disconnect_after_chunks: 1, chars_per_chunk: 2 });
    const first = connection.openContext({ audio_playback_id: 1, generation: 1 });
    first.sendText('きれる文');
    first.flush();
    await until(() => lost.length === 1);
    await server.stop();
    const port = await server.start();
    expect(port).toBeGreaterThan(0);
    // 別ポートになるので、この接続はもう繋がらない。ここでは送信待ちで例外にならないことだけを見る。
    const pending = connection.openContext({ audio_playback_id: 2, generation: 1 });
    expect(() => pending.sendText('まつ')).not.toThrow();
    expect(chunks.filter((c) => c.audio_playback_id === 2)).toHaveLength(0);
  });

  it('サーバーが止まり続けると down を表示する', async () => {
    const { server, statuses } = await setup({}, { down_after_attempts: 2 });
    await server.stop();
    await until(() => statuses.at(-1)?.status === 'down');
    expect(statuses.at(-1)?.next_retry_ms.value).toBeGreaterThan(0);
    for (const s of statuses) expect(JSON.stringify(s)).not.toContain(API_KEY);
  });

  it('isFinal が来なくても close_context を送り、最後は is_last を自分で出す', async () => {
    const { connection, chunks, server } = await setup({ never_send_final: true }, { final_wait_ms: 30 });
    const context = connection.openContext({ audio_playback_id: 1, generation: 1 });
    context.sendText('はい');
    context.endInput();
    await until(() => chunks.some((c) => c.is_last));
    expect(chunks.at(-1)?.pcm.length).toBe(0);
    expect(server.closedContexts).toContain(context.context_id);
    expect(connection.diagnostics().synthesized_last_chunks).toBe(1);
  });

  it('旧来の手順（close_on_end_input=false）でも、音声が途絶えた後に閉じて終わる', async () => {
    const { connection, chunks, server } = await setup({}, { close_on_end_input: false, end_idle_ms: 20 });
    const context = connection.openContext({ audio_playback_id: 1, generation: 1 });
    context.sendText('はい');
    context.endInput();
    await until(() => chunks.some((c) => c.is_last));
    expect(server.closedContexts).toContain(context.context_id);
    expect(connection.diagnostics().synthesized_last_chunks).toBe(0);
  });

  it('alignment の不正は null と理由にする', () => {
    expect(mapAlignment(null)).toEqual({ value: null, null_reason: 'server_sent_no_alignment' });
    expect(mapAlignment({ chars: ['あ'], charStartTimesMs: [], charDurationsMs: [0] })).toEqual({ value: null, null_reason: 'malformed_alignment' });
    expect(mapAlignment({ chars: ['あ'], charStartTimesMs: [1], charDurationsMs: [2] })).toEqual({
      value: { chars: ['あ'], char_start_ms: [1], char_duration_ms: [2] },
    });
  });

  it('環境変数がなければ名前だけを挙げて失敗する', () => {
    const time = new ManualTimeSource(0);
    expect(() => createElevenLabsTtsProviderFromEnv({ time, env: {} })).toThrow('ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID');
    expect(createElevenLabsTtsProviderFromEnv({ time, env: { ELEVENLABS_API_KEY: 'k', ELEVENLABS_VOICE_ID: 'v' } }).model_version).toBe('eleven_flash_v2_5');
  });
});


describe('ElevenLabs の声の設定（docs/tts_consistency.md）', () => {
  async function capture(options: Partial<ElevenLabsOptions>) {
    const urls: string[] = [];
    const received: Record<string, unknown>[] = [];
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((r) => wss.once('listening', () => r()));
    wss.on('connection', (socket, request) => {
      urls.push(request.url ?? '');
      socket.on('message', (raw) => received.push(JSON.parse(String(raw)) as Record<string, unknown>));
    });
    cleanups.push(() => new Promise<void>((r) => { for (const c of wss.clients) c.terminate(); wss.close(() => r()); }));
    const provider = new ElevenLabsTtsProvider({
      api_key: API_KEY,
      voice_id: 'voice',
      time: new ManualTimeSource(1),
      provider_class: 'test_double',
      options: { base_url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`, final_wait_ms: 50, ...options },
    });
    const connection = (await provider.open({ preferred_sample_rate_hz: 24000 })) as ElevenLabsConnection;
    cleanups.unshift(() => connection.close());
    return { connection, urls, received, provider };
  }

  it('既定は seed を接続のクエリに付け、voice_settings は送らない（登録済みの声の設定のまま）', async () => {
    const { connection, urls, received, provider } = await capture({});
    connection.openContext({ audio_playback_id: 1, generation: 1 });
    await until(() => received.length > 0);
    expect(new URL(urls[0] as string, 'http://x').searchParams.get('seed')).toBe('20261109');
    expect(received[0]?.voice_settings).toBeUndefined();
    expect(provider.describeSettings()).toMatchObject({ seed: 20261109, voice_settings: null, voice_settings_source: 'stored_on_voice', model_id: 'eleven_flash_v2_5' });
  });

  it('voice_settings は各文脈の最初のメッセージにだけ付き、seed=null ならクエリに付かない', async () => {
    const voice_settings = { stability: 0.9, speed: 1 };
    const { connection, urls, received, provider } = await capture({ seed: null, voice_settings });
    const context = connection.openContext({ audio_playback_id: 1, generation: 1 });
    connection.openContext({ audio_playback_id: 2, generation: 1 });
    context.sendText('今');
    await until(() => received.length >= 3);
    expect(new URL(urls[0] as string, 'http://x').searchParams.has('seed')).toBe(false);
    expect(received[0]?.voice_settings).toEqual(voice_settings);
    expect(received[1]?.voice_settings).toEqual(voice_settings);
    expect(received[2]?.text).toBe('今');
    expect(received[2]?.voice_settings).toBeUndefined();
    expect(provider.describeSettings()).toMatchObject({ seed: null, voice_settings, voice_settings_source: 'sent_per_context' });
  });

  it('環境変数: 未設定は何も上書きせず、off で seed を外し、範囲外は起動時に失敗する', () => {
    expect(elevenLabsVoiceOptionsFromEnv({})).toEqual({});
    expect(elevenLabsVoiceOptionsFromEnv({ ELEVENLABS_SEED: 'off' })).toEqual({ seed: null });
    expect(elevenLabsVoiceOptionsFromEnv({ ELEVENLABS_SEED: '42', ELEVENLABS_STABILITY: '0.9', ELEVENLABS_SPEAKER_BOOST: '0' })).toEqual({
      seed: 42,
      voice_settings: { stability: 0.9, use_speaker_boost: false },
    });
    expect(() => elevenLabsVoiceOptionsFromEnv({ ELEVENLABS_SEED: '1.5' })).toThrow(/integer/);
    expect(() => elevenLabsVoiceOptionsFromEnv({ ELEVENLABS_SEED: '4294967296' })).toThrow(/ELEVENLABS_SEED/);
    expect(() => elevenLabsVoiceOptionsFromEnv({ ELEVENLABS_STABILITY: 'high' })).toThrow(/ELEVENLABS_STABILITY/);
    expect(() => elevenLabsVoiceOptionsFromEnv({ ELEVENLABS_SPEED: '1.5' })).toThrow(/ELEVENLABS_SPEED/);
  });
});

/** 実 API で観察した動作を再現する小さなサーバー（flush で isFinal なし、close_context 後も音声が届く、エラーは接続後のメッセージ）。 */
async function realLikeServer(behaviour: { first_message_error?: { error: string; message: string }; reject?: { status: number; body: unknown } } = {}) {
  const received: Record<string, unknown>[] = [];
  const wss = new WebSocketServer({
    port: 0,
    host: '127.0.0.1',
    ...(behaviour.reject
      ? {
          verifyClient: (_info: unknown, done: (ok: boolean, code?: number, message?: string) => void) => done(false, behaviour.reject?.status, JSON.stringify(behaviour.reject?.body)),
        }
      : {}),
  });
  await new Promise<void>((r) => wss.once('listening', () => r()));
  wss.on('connection', (socket) => {
    if (behaviour.first_message_error) {
      socket.once('message', () => {
        socket.send(JSON.stringify({ ...behaviour.first_message_error, code: 1008 }));
        socket.close(1008, behaviour.first_message_error?.message);
      });
      return;
    }
    socket.on('message', (raw) => {
      const m = JSON.parse(String(raw)) as Record<string, unknown>;
      received.push(m);
      const contextId = m.context_id as string;
      const audio = {
        audio: Buffer.alloc(4800).toString('base64'),
        isFinal: null,
        normalizedAlignment: { chars: ['k'], charStartTimesMs: [0], charDurationsMs: [10] },
        alignment: { chars: ['今', ' '], charStartTimesMs: [0, 90], charDurationsMs: [90, 10] },
        contextId,
      };
      if (m.flush) socket.send(JSON.stringify(audio));
      if (m.close_context) {
        // close_context の後も届く。
        setTimeout(() => {
          socket.send(JSON.stringify(audio));
          socket.send(JSON.stringify({ audio: null, isFinal: true, normalizedAlignment: null, alignment: null, contextId }));
        }, 5);
      }
    });
  });
  cleanups.push(() => new Promise<void>((r) => { for (const c of wss.clients) c.terminate(); wss.close(() => r()); }));
  return { port: (wss.address() as AddressInfo).port, received };
}

async function openReal(port: number) {
  const provider = new ElevenLabsTtsProvider({
    api_key: API_KEY,
    voice_id: 'voice',
    time: new ManualTimeSource(1),
    provider_class: 'test_double',
    options: { base_url: `ws://127.0.0.1:${port}`, retry_base_ms: 5, final_wait_ms: 50 },
  });
  const connection = (await provider.open({ preferred_sample_rate_hz: 24000 })) as ElevenLabsConnection;
  cleanups.unshift(() => connection.close());
  const chunks: TtsChunk[] = [];
  const failures: ElevenLabsProviderError[] = [];
  const statuses: ProviderStatusUpdate[] = [];
  const lost: LostContext[] = [];
  connection.onChunk((c) => chunks.push(c));
  connection.onFailure((f) => failures.push(f));
  connection.onStatus((s) => statuses.push(s));
  connection.onContextLost((l) => lost.push(l));
  return { connection, chunks, failures, statuses, lost };
}

describe('ElevenLabs（実 API の観察を再現したサーバー）', () => {
  it('endInput は flush と close_context を続けて送り、音声の後に is_last が出る', async () => {
    const { port, received } = await realLikeServer();
    const { connection, chunks } = await openReal(port);
    const context = connection.openContext({ audio_playback_id: 1, generation: 1 });
    context.sendText('今');
    context.flush();
    context.endInput();
    await until(() => chunks.some((c) => c.is_last));
    expect(received.map((m) => Object.keys(m).filter((k) => k !== 'context_id' && k !== 'xi_api_key')[0])).toEqual(['text', 'text', 'flush', 'flush', 'close_context']);
    expect(chunks.filter((c) => c.pcm.length > 0)).toHaveLength(3);
    // 入力の文字だけを渡す（normalizedAlignment のローマ字は使わない）。
    expect(chunks[0]?.alignment.value?.chars).toEqual(['今', ' ']);
    expect(connection.diagnostics().synthesized_last_chunks).toBe(0);
  });

  it('取消の後は isFinal が来たら枠を返す', async () => {
    const { port } = await realLikeServer();
    const { connection, chunks } = await openReal(port);
    const contexts = [1, 2, 3, 4, 5].map((n) => connection.openContext({ audio_playback_id: n, generation: 1 }));
    contexts[0]?.cancel('x');
    expect(() => connection.openContext({ audio_playback_id: 6, generation: 1 })).toThrow(/too many/);
    await until(() => {
      try {
        connection.openContext({ audio_playback_id: 6, generation: 2 });
        return true;
      } catch {
        return false;
      }
    });
    expect(chunks).toHaveLength(0);
  });

  it('取消の後に届く音声は渡さず数える', async () => {
    const { port } = await realLikeServer();
    const { connection, chunks } = await openReal(port);
    const context = connection.openContext({ audio_playback_id: 1, generation: 1 });
    context.sendText('今');
    context.flush();
    await until(() => chunks.length === 1);
    context.cancel('withdrawn');
    await until(() => connection.diagnostics().late_chunks_after_cancel === 1);
    expect(chunks).toHaveLength(1);
  });

  it('接続の後に来るエラーを種類で知らせ、直らないものは張り直さない', async () => {
    const { port } = await realLikeServer({ first_message_error: { error: 'invalid_api_key', message: 'Invalid API key' } });
    const { connection, failures, statuses, lost, chunks } = await openReal(port);
    connection.openContext({ audio_playback_id: 1, generation: 1 });
    await until(() => failures.length === 1);
    expect(failures[0]?.kind).toBe('auth');
    expect(failures[0]?.provider_code).toBe('invalid_api_key');
    expect(statuses.at(-1)?.status).toBe('down');
    expect(lost).toHaveLength(1);
    expect(chunks.at(-1)?.is_last).toBe(true);
    await new Promise((r) => setTimeout(r, 30));
    expect(connection.diagnostics().connections_opened).toBe(1);
    expect(() => connection.openContext({ audio_playback_id: 2, generation: 1 })).toThrow(/down/);
    expect(connection.lastFailure).toBeInstanceOf(ElevenLabsProviderError);
  });

  it('文脈の上限のエラーは張り直す', async () => {
    const { port } = await realLikeServer({ first_message_error: { error: 'max_active_conversations', message: 'Maximum simultaneous contexts' } });
    const { connection, failures, statuses } = await openReal(port);
    connection.openContext({ audio_playback_id: 1, generation: 1 });
    await until(() => connection.diagnostics().connections_opened >= 2);
    expect(failures[0]?.kind).toBe('context_limit');
    expect(statuses.some((s) => s.status === 'degraded')).toBe(true);
  });

  it('HTTP の拒否でも種類を出す', async () => {
    const { port } = await realLikeServer({ reject: { status: 400, body: {} } });
    const { connection } = await openReal(port);
    // open の待ちの中で起きるので、購読より前。lastFailure で読める。
    expect(connection.lastFailure?.kind).toBe('invalid_request');
    expect(connection.lastFailure?.http_status).toBe(400);
    expect(connection.diagnostics().connections_opened).toBe(1);
  });

  it('alignment を chunk 相対へそろえる（実測の累積の形と資料の相対の形の両方）', () => {
    const cumulative = { value: { chars: ['明'], char_start_ms: [1161, 1300], char_duration_ms: [139, 10] } };
    const out = toChunkRelative(cumulative, 1153);
    expect(out.rebased).toBe(true);
    expect(out.value.value?.char_start_ms).toEqual([8, 147]);
    const relative = { value: { chars: ['明'], char_start_ms: [3], char_duration_ms: [10] } };
    expect(toChunkRelative(relative, 1153)).toEqual({ value: relative, rebased: false });
    expect(toChunkRelative(cumulative, 0).rebased).toBe(false);
  });

  it('実測のコードと資料の名前を分類する', () => {
    expect(classifyElevenLabsError('output_format_not_allowed')).toBe('plan_restricted');
    expect(classifyElevenLabsError('voice_id_does_not_exist')).toBe('invalid_request');
    expect(classifyElevenLabsError('invalid_output_format', 403)).toBe('invalid_request');
    expect(classifyElevenLabsError('unsupported_model', 400)).toBe('invalid_request');
    expect(classifyElevenLabsError('quota_exceeded')).toBe('quota_exceeded');
    expect(classifyElevenLabsError('missing_permissions', 401)).toBe('permission');
    expect(classifyElevenLabsError(null, 401)).toBe('auth');
    expect(classifyElevenLabsError(null, 503)).toBe('server');
    expect(new ElevenLabsProviderError('network', 'x').fatal).toBe(false);
    expect(new ElevenLabsProviderError('quota_exceeded', 'x').fatal).toBe(true);
  });
});
