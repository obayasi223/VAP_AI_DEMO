import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ManualTimeSource, MemoryEventSink, createEventEmitter } from '@llm-vap/contracts';
import type { LlmRequest } from '@llm-vap/contracts';
import { FakeGeminiServer } from '@llm-vap/testkit';
import { GeminiLlmProvider, GeminiProviderError, parseSse } from '../src/providers/llm';

const API_KEY = 'test-key-not-real';

function setup(server: FakeGeminiServer, port: number, overrides: Record<string, unknown> = {}) {
  const sink = new MemoryEventSink();
  const time = new ManualTimeSource();
  const emitter = createEventEmitter({ time, session_id: 's', condition: () => 'reactive', sink });
  const provider = new GeminiLlmProvider({
    api_key: API_KEY,
    time,
    emitter,
    base_url: `http://127.0.0.1:${port}`,
    ...overrides,
  });
  return { sink, provider };
}

const request = (overrides: Partial<LlmRequest> = {}): LlmRequest => ({
  request_id: 'r1',
  purpose: 'prefetch',
  system: 'sys',
  messages: [
    { role: 'user', text: 'こんにちは' },
    { role: 'assistant', text: 'はい' },
    { role: 'user', text: '元気？' },
  ],
  response_json_schema: null,
  transcript_revision: 3,
  ...overrides,
});

describe('GeminiLlmProvider（偽サーバー、性能の証拠にしない）', () => {
  let server: FakeGeminiServer;
  let port: number;

  beforeEach(async () => {
    server = new FakeGeminiServer({ responder: () => 'こんにちは、元気です。', chars_per_chunk: 3 });
    port = await server.start();
  });
  afterEach(async () => {
    await server.stop();
  });

  it('要求の形: 既定モデル、低遅延の thinking、役割の変換、サンプリング項目なし、キーはヘッダ', async () => {
    const { provider } = setup(server, port);
    await provider.generate(request());
    const sent = server.requests[0];
    expect(sent?.model).toBe('gemini-3.5-flash-lite');
    expect(sent?.api_key).toBe(API_KEY);
    expect(sent?.body.contents.map((c) => c.role)).toEqual(['user', 'model', 'user']);
    expect(sent?.body.systemInstruction?.parts[0]?.text).toBe('sys');
    expect(sent?.body.generationConfig?.thinkingConfig).toEqual({ thinkingLevel: 'MINIMAL' });
    expect(sent?.body.generationConfig).not.toHaveProperty('temperature');
    expect(sent?.body.generationConfig).not.toHaveProperty('responseMimeType');
    expect(server.interactions).toHaveLength(0);
  });

  it('3.8-flash の既定は low（minimal はエラーになるモデル）。下限が不明なモデルは指定を求める', async () => {
    const { provider } = setup(server, port, { model: 'gemini-3.8-flash' });
    expect(provider.thinking_level).toBe('low');
    expect(() => setup(server, port, { model: 'unknown-model' })).toThrow(/thinking_level/);
  });

  it('構造化出力のスキーマを渡す', async () => {
    const { provider } = setup(server, port);
    const schema = { type: 'object', properties: { p: { type: 'number' } } };
    await provider.generate(request({ response_json_schema: schema }));
    expect(server.requests[0]?.body.generationConfig?.responseMimeType).toBe('application/json');
    expect(server.requests[0]?.body.generationConfig?.responseJsonSchema).toEqual(schema);
  });

  it('ストリーミング: delta の連結が結果と一致し、llm.request/response と状態を出す', async () => {
    const { provider, sink } = setup(server, port);
    const stream = provider.stream(request());
    let joined = '';
    let pieces = 0;
    for await (const delta of stream.deltas) {
      joined += delta;
      pieces += 1;
    }
    const result = await stream.result;
    expect(pieces).toBeGreaterThan(1);
    expect(joined).toBe('こんにちは、元気です。');
    expect(result.text).toBe(joined);
    expect(result.finish_reason).toEqual({ value: 'STOP' });
    expect(result.model_version).toBe('fake:gemini-3.5-flash-lite');

    const [req] = sink.ofType('llm.request');
    const [res] = sink.ofType('llm.response');
    expect(req?.transcript_revision).toBe(3);
    expect(req?.input).toMatchObject({ system: 'sys', thinking_level: 'minimal' });
    expect(res?.output).toEqual({
      source: 'model_output',
      value: { text: joined, finish_reason: 'STOP' },
    });
    expect(res?.request_id).toBe(req?.request_id);
    const [status] = sink.ofType('provider.status');
    expect(status?.status).toBe('ok');
    // 偽サーバーを本番として記録しない。
    expect(status?.provider_class).toBe('test_double');
  });

  it('最初の本文の受信時刻を llm.response と結果に残す', async () => {
    const { provider, sink } = setup(server, port);
    const result = await provider.generate(request());
    const [res] = sink.ofType('llm.response');
    expect(res?.first_text_at).toBeTypeOf('number');
    expect(res?.first_text_at).toBeGreaterThanOrEqual(res?.sent_at as number);
    expect(res?.first_text_at).toBeLessThanOrEqual(res?.received_at as number);
    expect(result.first_text_at).toBe(res?.first_text_at);
  });

  it('読み手がいなくても結果は完了する', async () => {
    const { provider } = setup(server, port);
    const stream = provider.stream(request());
    await expect(stream.result).resolves.toMatchObject({ text: 'こんにちは、元気です。' });
  });

  it('usage がない応答は cost.usage に理由つきで残す', async () => {
    const { provider, sink } = setup(server, port);
    await provider.generate(request());
    const [cost] = sink.ofType('cost.usage');
    expect(cost?.unit).toBe('request_without_usage_metadata');
    expect(cost?.estimated_cost_usd.value).toBeNull();
  });

  it.each([
    [404, 'model_unavailable', 'down'],
    [403, 'auth', 'down'],
    [400, 'bad_request', 'down'],
    [429, 'rate_limited', 'degraded'],
    [503, 'server', 'degraded'],
  ] as const)('HTTP %i は %s として明示し、状態 %s を出す', async (http, kind, status) => {
    const { provider, sink } = setup(server, port);
    server.failNext(http);
    const stream = provider.stream(request());
    await expect(stream.result).rejects.toMatchObject({ name: 'GeminiProviderError', kind, http_status: http });
    await expect(
      (async () => {
        for await (const _ of stream.deltas) {
          // 失敗が読み手にも届く
        }
      })(),
    ).rejects.toBeInstanceOf(GeminiProviderError);
    expect(sink.ofType('provider.status')[0]?.status).toBe(status);
    const res = sink.ofType('llm.response')[0];
    expect(res?.output.value).toBeNull();
    // 本文が届かなかった失敗では項目がない。
    expect(res).not.toHaveProperty('first_text_at');
    expect(JSON.stringify(sink.events)).not.toContain(API_KEY);
  });

  it('モデルの失敗から回復したら ok を出す。擬似結果へ切り替えない', async () => {
    const { provider, sink } = setup(server, port);
    server.failNext(404);
    await expect(provider.generate(request())).rejects.toBeInstanceOf(GeminiProviderError);
    await provider.generate(request());
    expect(sink.ofType('provider.status').map((e) => e.status)).toEqual(['down', 'ok']);
  });

  it('キーがなければ作れない', () => {
    expect(() => setup(server, port, { api_key: '' })).toThrow(/GEMINI_API_KEY/);
  });

  it('事前に中断済みなら送らない', async () => {
    const { provider, sink } = setup(server, port);
    const controller = new AbortController();
    controller.abort();
    await expect(provider.generate(request({ signal: controller.signal }))).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(server.requests).toHaveLength(0);
    expect(sink.events).toHaveLength(0);
  });
});

describe('GeminiLlmProvider の中断（偽サーバー）', () => {
  it('中断で接続が切れ、AbortError と理由つきの llm.response、課金不明の記録が残る', async () => {
    const server = new FakeGeminiServer({
      responder: () => 'あ'.repeat(200),
      chars_per_chunk: 2,
      chunk_delay_ms: 5,
    });
    const port = await server.start();
    try {
      const { provider, sink } = setup(server, port);
      const controller = new AbortController();
      const stream = provider.stream(request({ signal: controller.signal }));
      let received = 0;
      const reading = (async () => {
        for await (const delta of stream.deltas) {
          received += delta.length;
          if (received >= 4) controller.abort();
        }
      })();
      await expect(reading).rejects.toMatchObject({ name: 'AbortError' });
      await expect(stream.result).rejects.toMatchObject({ name: 'AbortError' });
      const res = sink.ofType('llm.response')[0];
      expect(res?.output.value).toBeNull();
      expect(JSON.stringify(res?.output)).toContain('aborted_by_caller');
      expect(sink.ofType('cost.usage')[0]?.unit).toBe('aborted_request');
      // 中断は失敗ではないので状態を変えない。
      expect(sink.ofType('provider.status')).toHaveLength(0);
      await expect.poll(() => server.abortedResponses).toBe(1);
    } finally {
      await server.stop();
    }
  });

  it('時間切れは timeout として明示する', async () => {
    const server = new FakeGeminiServer({ first_chunk_delay_ms: 300 });
    const port = await server.start();
    try {
      const { provider, sink } = setup(server, port, { timeout_ms: 20 });
      await expect(provider.generate(request())).rejects.toMatchObject({ kind: 'timeout' });
      expect(sink.ofType('provider.status')[0]?.status).toBe('degraded');
    } finally {
      await server.stop();
    }
  });
});

describe('GeminiLlmProvider の応答の扱い（fetch を差し替え）', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function respondWith(events: unknown[]): void {
    const body = events.map((e) => `data: ${JSON.stringify(e)}\r\n\r\n`).join('');
    globalThis.fetch = (async () => new Response(body, { status: 200 })) as typeof fetch;
  }

  function direct() {
    const sink = new MemoryEventSink();
    const time = new ManualTimeSource();
    const emitter = createEventEmitter({ time, session_id: 's', condition: () => 'reactive', sink });
    return { sink, provider: new GeminiLlmProvider({ api_key: API_KEY, time, emitter }) };
  }

  it('思考の部分を除き、usage から費用を出す（思考トークンは出力に含める）', async () => {
    respondWith([
      { candidates: [{ content: { parts: [{ text: '考え中', thought: true }] } }] },
      {
        candidates: [{ content: { parts: [{ text: '答え' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 100, thoughtsTokenCount: 50 },
        modelVersion: 'gemini-3.5-flash-lite-001',
      },
    ]);
    const { provider, sink } = direct();
    expect(provider.provider_class).toBe('production');
    const result = await provider.generate(request());
    expect(result.text).toBe('答え');
    expect(result.usage).toEqual({ input_tokens: { value: 1000 }, output_tokens: { value: 150 } });
    const costs = sink.ofType('cost.usage');
    expect(costs.map((c) => [c.unit, c.quantity])).toEqual([
      ['input_tokens', 1000],
      ['output_tokens', 150],
    ]);
    expect(costs[0]?.estimated_cost_usd.value).toBeCloseTo(0.0003);
    expect(costs[1]?.estimated_cost_usd.value).toBeCloseTo(0.000375);
    expect(sink.ofType('llm.response')[0]?.model_version).toBe('gemini-3.5-flash-lite-001');
  });

  it.each([
    ['打ち切り', [{ candidates: [{ content: { parts: [{ text: '途中' }] } }] }], 'incomplete_stream'],
    ['入力の拒否', [{ promptFeedback: { blockReason: 'SAFETY' } }], 'blocked'],
    ['出力なし', [{ candidates: [{ finishReason: 'SAFETY' }] }], 'no_output'],
    ['ストリーム内のエラー', [{ error: { code: 503, message: 'overloaded' } }], 'server'],
  ])('%s は明示の失敗', async (_name, events, kind) => {
    respondWith(events);
    const { provider } = direct();
    await expect(provider.generate(request())).rejects.toMatchObject({ kind });
  });

  it('モデルの確認: 使えなければ down と例外、使えれば版を返す', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: 'not found' } }), { status: 404 })) as typeof fetch;
    const missing = direct();
    await expect(missing.provider.checkModelAvailable()).rejects.toMatchObject({ kind: 'model_unavailable' });
    expect(missing.sink.ofType('provider.status')[0]?.status).toBe('down');

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ version: '001', supportedGenerationMethods: ['generateContent'] }), {
        status: 200,
      })) as typeof fetch;
    const present = direct();
    await expect(present.provider.checkModelAvailable()).resolves.toEqual({
      model: 'gemini-3.5-flash-lite',
      version: '001',
    });

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ supportedGenerationMethods: ['embedContent'] }), { status: 200 })) as typeof fetch;
    await expect(direct().provider.checkModelAvailable()).rejects.toMatchObject({ kind: 'model_unavailable' });
  });
});

describe('parseSse', () => {
  it('CRLF、分割された到着、複数行の data、[DONE] を扱う', async () => {
    const encoder = new TextEncoder();
    async function* source() {
      yield encoder.encode('data: {"a":');
      yield encoder.encode('1}\r\n\r\ndata: {"b":\ndata: 2}\n\n');
      yield encoder.encode('data: [DONE]\n\ndata: {"c":3}');
    }
    const out: unknown[] = [];
    for await (const event of parseSse(source())) out.push(event);
    expect(out).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });
});
