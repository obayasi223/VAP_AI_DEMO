import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const WEB = join(ROOT, 'public');

// No npm dependencies. Load local .env without changing existing process env.
try {
  const envText = await readFile(join(ROOT, '.env'), 'utf8');
  for (const line of envText.split(/\r?\n/)) {
    const match = /^\s*([A-Z_][A-Z_0-9]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
    }
  }
} catch { /* .env is optional; demo runs without Gemini key */ }

const PORT = Number(process.env.PORT || 3977);
const HOST = '127.0.0.1';
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const API_KEY = process.env.GEMINI_API_KEY || '';
const peers = new Set();
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function body(req) {
  let data = '';
  for await (const chunk of req) {
    data += chunk.toString('utf8');
    if (data.length > 25000) throw new Error('入力が長すぎます');
  }
  try { return JSON.parse(data || '{}'); } catch { throw new Error('JSON形式が不正です'); }
}

function broadcast(event, payload) {
  const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const peer of peers) {
    try { peer.write(data); } catch { peers.delete(peer); }
  }
}

const outputSchema = {
  type: 'OBJECT',
  properties: {
    want_to_speak: { type: 'BOOLEAN' },
    intent_type: { type: 'STRING' },
    reason: { type: 'STRING' },
    utterance: { type: 'STRING' },
    intensity: { type: 'NUMBER' }
  },
  required: ['want_to_speak', 'intent_type', 'reason', 'utterance', 'intensity'],
  propertyOrdering: ['want_to_speak', 'intent_type', 'reason', 'utterance', 'intensity']
};

const SYSTEM = `あなたは、人間と音声対話するアバターの「発話希望を生成するLLM」です。
このデモの主目的は、相手が話し終わる前に、内容に基づく独自の質問・疑問・反論・補足を自然に持つ体験を示すことです。
人間の発話途中の部分文字起こしが入力されます。これは発話完了ではありません。
あなたは会話に主体的に参加しますが、毎回発話を希望するわけではありません。
会話の中で生じた具体的な疑問、誤解を防ぐ確認、重要な反対意見、発展的な提案のいずれかがあるときだけ want_to_speak=true にしてください。
話し手の説明がまだ不十分なら待ち、社交辞令だけの介入や無意味な相槌のために want_to_speak=true にしないでください。
特に、会話の内容の特定の一部分に結びついた独自の疑問や提案を重視してください。
want_to_speak=falseの場合 utteranceは空文字。trueの場合、発話できる内容を日本語で20〜65文字程度の自然な一文・二文にしてください。
reasonには「どの発言がきっかけで、何を話したいか」を簡潔に記してください。intent_type は 質問/異議/確認/提案/その他 のいずれか。
intensityは0.0〜1.0です。必ず指定されたJSON形式のみ返してください。
あなたは音声交替の予測AIではありません。発言したい内容と理由のみを判断し、タイミングの最終調整は別の制御器が行います。`;

export async function analyzeWithGemini(input, options = {}) {
  const transcript = String(input.transcript || '').slice(-2300).trim();
  if (transcript.length < 8) throw new Error('文字起こしが短すぎます');
  const scenario = String(input.scenario || '気軽な研究相談').slice(0, 220);
  const recent = Array.isArray(input.history) ? input.history.slice(-6).map((item) => ({
    who: String(item?.who || '').slice(0, 30),
    text: String(item?.text || '').slice(0, 220)
  })) : [];
  const initiative = String(input.initiative || 'normal');
  const inclination = initiative === 'active' ? '積極的：会話内容に関連した独自の疑問や着想が生まれたら、早めに発話希望を持ってよい。ただし無意味な質問はしない。' : initiative === 'quiet' ? '控えめ：非常に重要な疑問や誤解がある時だけ発話希望を持つ。' : '標準：会話内容から具体的な質問・反論・提案を持った時だけ発話希望を持つ。';
  const context = `場面: ${scenario}\n発話スタイル: ${inclination}\n最近の対話: ${JSON.stringify(recent)}\n\n【人間が現在まだ話している内容（暫定文字起こし）】\n${transcript}`;
  const model = options.model || MODEL;
  const key = options.apiKey || API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY が設定されていません');
  if (!/^gemini-[a-z0-9.-]+$/.test(model)) throw new Error('モデル名が不正です');
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const response = await (options.fetchFn || fetch)(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: 'user', parts: [{ text: context }] }],
      generationConfig: {
        temperature: 0.65,
        maxOutputTokens: 640,
        responseMimeType: 'application/json',
        responseSchema: outputSchema
      }
    }),
    signal: AbortSignal.timeout(20000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || `Gemini API HTTP ${response.status}`;
    throw new Error(message.slice(0, 280));
  }
  const reply = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
  if (!reply) throw new Error('LLMの応答が空です（トークン上限などを確認してください）');
  let parsed;
  try { parsed = JSON.parse(reply.replace(/^```(?:json)?\s*|\s*```$/g, '')); }
  catch { throw new Error('LLMのJSONを解析できませんでした'); }
  return {
    want_to_speak: parsed.want_to_speak === true && String(parsed.utterance || '').trim().length > 0,
    intent_type: String(parsed.intent_type || 'その他').slice(0, 20),
    reason: String(parsed.reason || '').slice(0, 260),
    utterance: String(parsed.utterance || '').slice(0, 220),
    intensity: Math.max(0, Math.min(1, Number(parsed.intensity) || 0))
  };
}

export function createAppServer() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);
    try {
      if (req.method === 'GET' && url.pathname === '/api/status') {
        return json(res, 200, {
          llmReady: Boolean(API_KEY), model: MODEL,
          speechEngine: 'Web Speech API + RMS VAD (not MaAI)',
          version: '0.1.0'
        });
      }
      if (req.method === 'GET' && url.pathname === '/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no'
        });
        res.write(': connected\n\n');
        peers.add(res);
        req.on('close', () => peers.delete(res));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/command') {
        const params = await body(req);
        if (!['cue','speak','defer','withdraw','reset'].includes(params.action)) {
          return json(res, 400, { error: '不明なコマンドです' });
        }
        broadcast('command', {
          action: params.action,
          utterance: String(params.utterance || '').slice(0, 280),
          source: 'operator', t: Date.now()
        });
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/analyze') {
        if (!API_KEY) return json(res, 503, { error: 'GEMINI_API_KEY が未設定です。手動モードは利用できます。' });
        const params = await body(req);
        const result = await analyzeWithGemini(params);
        return json(res, 200, { ...result, source: 'gemini', model: MODEL });
      }
      if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
      let filename = url.pathname === '/' ? 'index.html' :
        url.pathname === '/operator' ? 'operator.html' : decodeURIComponent(url.pathname.slice(1));
      const path = resolve(WEB, filename);
      if (!path.startsWith(WEB + '/') && path !== WEB) return json(res, 403, { error: 'Forbidden' });
      const info = await stat(path).catch(() => null);
      if (!info?.isFile()) return json(res, 404, { error: 'Not found' });
      const content = await readFile(path);
      res.writeHead(200, {
        'Content-Type': types[extname(filename)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff'
      });
      res.end(content);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = /JSON形式|長すぎ|文字起こし|不正/.test(message) ? 400 : 502;
      console.error(`[${new Date().toISOString()}] ${req.method} ${url.pathname}: ${message}`);
      json(res, status, { error: message.slice(0, 400) });
    }
  });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const server = createAppServer();
  server.listen(PORT, HOST, () => {
    console.log(`\n  BREATH / Speech-intent demo: http://${HOST}:${PORT}/`);
    console.log(`  Operator console:           http://${HOST}:${PORT}/operator`);
    console.log(`  Gemini: ${API_KEY ? 'configured' : 'not configured (operator/manual mode only)'} | ${MODEL}\n`);
  });
}
