// Gemini measurements through REST, so Node 20/22 both work and no SDK choice is forced on the app.
//   --mode models   model list from the API
//   --mode latency  time to first text, to the parsable decision, and to completion; per API, model, thinking level
//   --mode abort    does client abort stop the stream, and what usage does a full run report for comparison
// Interactions requests send store:false, because the server otherwise keeps them (55 days on paid tier).
import { parseArgs } from 'node:util';
import { writeFileSync } from 'node:fs';
import { requireEnv, requireConfirm, openLog, fail, redact, sleep, distribution } from './lib/common.mjs';

const { values: args } = parseArgs({
  options: {
    mode: { type: 'string' },
    models: { type: 'string', default: 'gemini-3.5-flash-lite:minimal,gemini-3.5-flash-lite:low,gemini-3.8-flash:low' },
    apis: { type: 'string', default: 'interactions,generateContent' },
    repeat: { type: 'string', default: '10' },
    'gap-ms': { type: 'string', default: '1000' },
    yes: { type: 'boolean', default: false },
  },
});
requireEnv(['GEMINI_API_KEY'], 'Gemini の測定には GEMINI_API_KEY=<API キー> を設定してください。');
if (!['models', 'latency', 'abort'].includes(args.mode)) {
  console.error('--mode models|latency|abort を指定してください');
  process.exit(1);
}
const BASE = process.env.GEMINI_TEST_BASE ?? 'https://generativelanguage.googleapis.com';
const API_REVISION = '2026-05-20';
const headers = () => ({ 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY, 'Api-Revision': API_REVISION });

const SCHEMA = {
  type: 'object',
  properties: {
    decision: { type: 'string', enum: ['NONE', 'NEW', 'KEEP', 'REVISE', 'WITHDRAW'] },
    evidence_span: { type: 'string' },
    candidate_text: { type: 'string' },
    reason: { type: 'string' },
  },
  required: ['decision', 'evidence_span', 'candidate_text', 'reason'],
};
const SYSTEM = 'あなたは会議に参加するアシスタントです。相手がまだ話している途中で、今申し出る具体的な質問や異議があるかを判定します。なければ NONE を返します。evidence_span は入力の文字列からそのまま抜き出します。';
const INPUT = '逐次音声認識: 「来週の展示会ですが、予算は先月決めた五十万円のままで進めようと思っていて、ただ会場の費用が去年より倍になったと聞いたので」';

export const parseDecision = (text) => text.match(/"decision"\s*:\s*"(NONE|NEW|KEEP|REVISE|WITHDRAW)"/)?.[1] ?? null;

function requestFor(api, model, thinking) {
  if (api === 'interactions') {
    return {
      url: `${BASE}/v1beta/interactions?alt=sse`,
      body: {
        model,
        input: INPUT,
        system_instruction: SYSTEM,
        stream: true,
        store: false,
        response_format: { type: 'text', mime_type: 'application/json', schema: SCHEMA },
        generation_config: { thinking_level: thinking, max_output_tokens: 512 },
      },
    };
  }
  return {
    url: `${BASE}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
    body: {
      contents: [{ role: 'user', parts: [{ text: INPUT }] }],
      systemInstruction: { parts: [{ text: SYSTEM }] },
      generationConfig: {
        responseMimeType: 'application/json',
        responseJsonSchema: SCHEMA,
        thinkingConfig: { thinkingLevel: thinking.toUpperCase() },
        maxOutputTokens: 512,
      },
    },
  };
}

function textFromEvent(api, ev) {
  if (api === 'interactions') return ev.event_type === 'step.delta' && ev.delta?.type === 'text' ? ev.delta.text ?? '' : '';
  return (ev.candidates?.[0]?.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? '').join('');
}
const usageFromEvent = (api, ev) => (api === 'interactions' ? ev.interaction?.usage : ev.usageMetadata) ?? null;

export async function* sse(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let cut;
    while ((cut = buffer.search(/\r?\n\r?\n/)) >= 0) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut).replace(/^\r?\n\r?\n/, '');
      const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
      if (data && data !== '[DONE]') yield JSON.parse(data);
    }
  }
}

async function once(api, model, thinking, { abortAfterFirstText = false } = {}) {
  const { url, body } = requestFor(api, model, thinking);
  const controller = new AbortController();
  const begin = performance.now();
  const timer = setTimeout(() => controller.abort(), 60_000);
  const row = { api, model, thinking, status: null, headers_ms: null, first_text_ms: null, decision_ms: null, total_ms: null, decision: null, valid_json: null, usage: null, error: null, aborted: false };
  try {
    const res = await fetch(url, { method: 'POST', headers: headers(), body: JSON.stringify(body), signal: controller.signal });
    row.status = res.status;
    row.headers_ms = performance.now() - begin;
    if (!res.ok) {
      row.error = redact((await res.text()).slice(0, 600));
      if (res.status === 429) row.retry_after = res.headers.get('retry-after');
      return row;
    }
    let text = '';
    for await (const ev of sse(res.body)) {
      const piece = textFromEvent(api, ev);
      if (piece) {
        row.first_text_ms ??= performance.now() - begin;
        text += piece;
        if (row.decision === null) {
          row.decision = parseDecision(text);
          if (row.decision) row.decision_ms = performance.now() - begin;
        }
        if (abortAfterFirstText) {
          row.aborted = true;
          controller.abort();
          break;
        }
      }
      row.usage = usageFromEvent(api, ev) ?? row.usage;
    }
    row.total_ms = performance.now() - begin;
    if (!row.aborted) {
      try {
        JSON.parse(text);
        row.valid_json = true;
      } catch {
        row.valid_json = false;
      }
      row.text = text;
    }
  } catch (err) {
    if (!(row.aborted && err.name === 'AbortError')) row.error = redact(`${err.name}: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
  return row;
}

async function runModels(log) {
  const models = [];
  let token = '';
  do {
    const res = await fetch(`${BASE}/v1beta/models?pageSize=200${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`, { headers: headers() });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${redact((await res.text()).slice(0, 400))}`);
    const json = await res.json();
    models.push(...(json.models ?? []));
    token = json.nextPageToken ?? '';
  } while (token);
  const rows = models.map((m) => ({
    name: m.name,
    version: m.version,
    input_limit: m.inputTokenLimit,
    output_limit: m.outputTokenLimit,
    methods: m.supportedGenerationMethods,
    thinking: m.thinking,
  }));
  log.write({ kind: 'models', rows });
  return {
    mode: 'models',
    total: rows.length,
    flash: rows.filter((r) => /flash/.test(r.name)),
    has_required: ['gemini-3.5-flash-lite', 'gemini-3.8-flash'].map((id) => ({ id, listed: rows.some((r) => r.name === `models/${id}`) })),
  };
}

const combos = () => args.apis.split(',').flatMap((api) => args.models.split(',').map((m) => {
  const [model, thinking] = m.split(':');
  return { api, model, thinking };
}));

async function runLatency(log) {
  const out = [];
  for (const { api, model, thinking } of combos()) {
    const rows = [];
    for (let i = 0; i < Number(args.repeat); i++) {
      const row = await once(api, model, thinking);
      log.write({ kind: 'request', i, ...row });
      rows.push(row);
      await sleep(Number(args['gap-ms']));
    }
    const ok = rows.filter((r) => !r.error);
    const usage = ok.map((r) => r.usage).filter(Boolean);
    out.push({
      api,
      model,
      thinking,
      ok: ok.length,
      errors: rows.filter((r) => r.error).map((r) => ({ status: r.status, error: r.error })).slice(0, 2),
      first_text_ms: distribution(ok.map((r) => r.first_text_ms).filter((x) => x !== null)),
      decision_ms: distribution(ok.map((r) => r.decision_ms).filter((x) => x !== null)),
      total_ms: distribution(ok.map((r) => r.total_ms).filter((x) => x !== null)),
      valid_json_share: ok.length ? ok.filter((r) => r.valid_json).length / ok.length : null,
      decisions: ok.map((r) => r.decision),
      usage_sample: usage[0] ?? null,
    });
  }
  return { mode: 'latency', rows: out };
}

async function runAbort(log) {
  const { api, model, thinking } = combos()[0];
  const aborted = await once(api, model, thinking, { abortAfterFirstText: true });
  log.write({ kind: 'aborted', ...aborted });
  const full = await once(api, model, thinking);
  log.write({ kind: 'full', ...full });
  return {
    mode: 'abort',
    aborted,
    full_for_comparison: { ...full, text: undefined },
    note: 'SDK の資料は「クライアント側のみで、課金は止まらない」とする。実際の請求は AI Studio の使用量で比べる。',
  };
}

try {
  const callCount = args.mode === 'models' ? 0 : args.mode === 'abort' ? 2 : combos().length * Number(args.repeat);
  if (args.mode !== 'models') requireConfirm(args, `${args.mode}: 生成要求 ${callCount} 回（1回あたり数百トークン、合計でも $0.10 未満の見込み）`);
  const log = openLog(`gemini-${args.mode}`);
  const summary = await { models: runModels, latency: runLatency, abort: runAbort }[args.mode](log);
  log.write({ kind: 'summary', ...summary });
  await log.close();
  const summaryPath = log.path.replace(/\.jsonl$/, '.summary.json');
  writeFileSync(summaryPath, `${redact(JSON.stringify(summary, null, 2))}\n`);
  console.log(redact(JSON.stringify(summary, null, 2)));
  console.log(`\nログ: ${log.path}\n要約: ${summaryPath}`);
  process.exit(0);
} catch (err) {
  fail(err);
}
