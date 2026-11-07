/**
 * Gemini の偽物。実際の HTTP と SSE で話す。文章は台本で、判断はしない。
 * generateContent 系（legacy）と Interactions の両方を持つ（どちらを使うかは D の判断）。
 * 中断は実物でも課金が続く（provider_matrix §1 の #12）。ここでは abortedResponses で検知できるだけ。
 *
 * 【未確認】応答項目の完全な一覧、Interactions の SSE の正確な形、エラーの本文は想定（vendor_shapes.ts）。
 * これの結果を LLM の性能として報告しない（計画 §4.5a）。
 */
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type {
  GeminiInteractionEvent,
  GeminiInteractionRequest,
  GeminiRequestBody,
  GeminiStreamChunk,
} from '@llm-vap/contracts';

export type FakeGeminiResponder = (body: GeminiRequestBody, model: string) => string;

export interface FakeGeminiOptions {
  port?: number;
  responder?: FakeGeminiResponder;
  first_chunk_delay_ms?: number;
  chunk_delay_ms?: number;
  chars_per_chunk?: number;
}

export class FakeGeminiServer {
  readonly requests: { model: string; body: GeminiRequestBody; api_key: string | null }[] = [];
  readonly interactions: { body: GeminiInteractionRequest; api_key: string | null }[] = [];
  /** 途中で接続を切られた回数（取消の確認用）。 */
  abortedResponses = 0;
  private server: Server | null = null;
  private failures: number[] = [];

  constructor(private readonly options: FakeGeminiOptions = {}) {}

  async start(): Promise<number> {
    const server = createServer((req, res) => void this.handle(req, res));
    this.server = server;
    await new Promise<void>((resolve) => server.listen(this.options.port ?? 0, '127.0.0.1', resolve));
    return (server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.server = null;
  }

  /** 障害の注入: 次の要求を指定のステータスで失敗させる。 */
  failNext(status: number): void {
    this.failures.push(status);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '', 'http://fake');
    if (req.method === 'POST' && url.pathname === '/v1beta/interactions') {
      await this.handleInteraction(req, res, url);
      return;
    }
    const match = /^\/v1beta\/models\/([^:]+):(streamGenerateContent|generateContent)$/.exec(url.pathname);
    if (req.method !== 'POST' || !match) {
      res.writeHead(404).end(JSON.stringify({ error: { code: 404, message: 'not found' } }));
      return;
    }
    const model = match[1] as string;
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as GeminiRequestBody;
    const api_key = (req.headers['x-goog-api-key'] as string | undefined) ?? url.searchParams.get('key');
    this.requests.push({ model, body, api_key });

    const failure = this.failures.shift();
    if (failure !== undefined) {
      res
        .writeHead(failure, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: { code: failure, message: 'fake failure' } }));
      return;
    }

    const text = (this.options.responder ?? (() => 'fake response'))(body, model);
    if (match[2] === 'generateContent') {
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify(this.chunk(text, model, true)));
      return;
    }

    res.writeHead(200, { 'content-type': 'text/event-stream' });
    let aborted = false;
    res.on('close', () => {
      if (!res.writableEnded) {
        aborted = true;
        this.abortedResponses += 1;
      }
    });
    const size = this.options.chars_per_chunk ?? 8;
    const firstDelay = this.options.first_chunk_delay_ms ?? 0;
    if (firstDelay > 0) await new Promise((r) => setTimeout(r, firstDelay));
    for (let i = 0; i < text.length || i === 0; i += size) {
      if (aborted) return;
      const part = text.slice(i, i + size);
      const last = i + size >= text.length;
      res.write(`data: ${JSON.stringify(this.chunk(part, model, last))}\n\n`);
      const delay = this.options.chunk_delay_ms ?? 0;
      if (delay > 0 && !last) await new Promise((r) => setTimeout(r, delay));
    }
    if (!aborted) res.end();
  }

  private async handleInteraction(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const parts: Buffer[] = [];
    for await (const chunk of req) parts.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(parts).toString('utf8')) as GeminiInteractionRequest;
    const api_key = (req.headers['x-goog-api-key'] as string | undefined) ?? url.searchParams.get('key');
    this.interactions.push({ body, api_key });

    const failure = this.failures.shift();
    if (failure !== undefined) {
      res
        .writeHead(failure, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: { code: failure, message: 'fake failure' } }));
      return;
    }
    const text = (this.options.responder ?? (() => 'fake response'))({ contents: [] }, body.model);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const size = this.options.chars_per_chunk ?? 8;
    const send = (event: GeminiInteractionEvent) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    for (let i = 0; i < text.length; i += size) {
      send({ event_type: 'step.delta', delta: { type: 'text', text: text.slice(i, i + size) } });
    }
    send({ event_type: 'interaction.completed', model_version: `fake:${body.model}` });
    res.end();
  }

  private chunk(text: string, model: string, last: boolean): GeminiStreamChunk {
    return {
      candidates: [
        {
          content: { role: 'model', parts: [{ text }] },
          ...(last ? { finishReason: 'STOP' } : {}),
        },
      ],
      modelVersion: `fake:${model}`,
    };
  }
}
