/**
 * 実 API の短い確認（遅延と形式のみ。応答の内容は評価しない）。
 *   node --env-file=.env --import tsx apps/orchestrator/src/providers/llm/live_check.ts --repeat 10
 * --holdout は評価の控え（別のモデルが書いた発話）を1回の要求で作って保存する。
 * キーは表示しない。イベントは本文を除いて JSON で出す。
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { MemoryEventSink, SystemTimeSource, createEventEmitter } from '@llm-vap/contracts';
import { GeminiProviderError, createGeminiProviderFromEnv } from './gemini';

const { values: args } = parseArgs({
  options: {
    repeat: { type: 'string', default: '10' },
    'gap-ms': { type: 'string', default: '1000' },
    holdout: { type: 'boolean', default: false },
  },
});

const sink = new MemoryEventSink();
const time = new SystemTimeSource();
const emitter = createEventEmitter({ time, session_id: 'live-check', condition: () => 'reactive', sink });

function quantiles(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? null;
  return { n: sorted.length, p50: at(0.5), p95: at(0.95), max: sorted.at(-1) ?? null };
}

if (args.holdout) {
  const generator = createGeminiProviderFromEnv({ time, emitter, model: 'gemini-3.8-flash', max_output_tokens: 8000, timeout_ms: 120_000 });
  const result = await generator.generate({
    request_id: 'holdout-1',
    purpose: 'completion',
    system: '日本語の日常会話の研究用データを作ります。',
    messages: [
      {
        role: 'user',
        text: [
          '音声認識の途中結果を模した、句読点のない日本語の話し言葉の発話を作ってください。話題と言い回しは多様に。',
          '次の4区分をそれぞれ15件ずつ、合計60件。',
          'continues: 文の途中で明らかに続きがある（名詞で途切れる、助詞で途切れる、接続表現で終わるなど色々）。',
          'complete_with_continuation: 文法的には言い切っているが、同じ話者がまだ話を続ける場面。',
          'question_end: 相手への質問で終わる（丁寧、くだけた形の両方）。',
          'statement_end: 発話が完結して相手に番を渡す（答え、同意、あいさつ、報告など）。',
          'history は直前の相手の発話を入れる配列で、なくてもよい。',
        ].join('\n'),
      },
    ],
    response_json_schema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              category: { type: 'string', enum: ['continues', 'complete_with_continuation', 'question_end', 'statement_end'] },
              history: { type: 'array', items: { type: 'string' } },
              partial: { type: 'string' },
            },
            required: ['category', 'history', 'partial'],
          },
        },
      },
      required: ['items'],
    },
    transcript_revision: 0,
  });
  const items = (JSON.parse(result.text) as { items: { category: string; history: string[]; partial: string }[] }).items;
  const counts = new Map<string, number>();
  const lines = items.map((item) => {
    const n = (counts.get(item.category) ?? 0) + 1;
    counts.set(item.category, n);
    return JSON.stringify({ id: `h_${item.category}_${n}`, ...item, source: result.model_version });
  });
  const here = dirname(fileURLToPath(import.meta.url));
  const path = resolve(here, '../../cognition/completion/eval_holdout_ja.jsonl');
  writeFileSync(path, `${lines.join('\n')}\n`);
  console.log(JSON.stringify({ written: path, n: lines.length, by_category: Object.fromEntries(counts), model: result.model_version }));
  process.exit(0);
}

const provider = createGeminiProviderFromEnv({ time, emitter });
console.log(JSON.stringify({ check: await provider.checkModelAvailable(), thinking: provider.thinking_level }));

const firstText: number[] = [];
const total: number[] = [];
const repeat = Number(args.repeat);
let failures = 0;
for (let i = 0; i < repeat; i++) {
  const begin = performance.now();
  const stream = provider.stream({
    request_id: `live-${i}`,
    purpose: 'prefetch',
    system: 'あなたは会話の相手です。1〜2文の話し言葉で簡潔に答えます。',
    messages: [{ role: 'user', text: '週末に京都へ行こうと思うんですけど、おすすめの場所はありますか' }],
    response_json_schema: null,
    transcript_revision: i,
  });
  let first: number | null = null;
  try {
    for await (const _ of stream.deltas) first ??= performance.now() - begin;
    await stream.result;
    if (first !== null) firstText.push(first);
    total.push(performance.now() - begin);
  } catch (error) {
    failures += 1;
    console.log(JSON.stringify({ i, error: error instanceof GeminiProviderError ? error.kind : String(error) }));
  }
  await new Promise((resolve) => setTimeout(resolve, Number(args['gap-ms'])));
}
const results = sink.ofType('llm.response');
const last = results.at(-1);
console.log(
  JSON.stringify(
    {
      model_reported: last?.model_version,
      failures,
      first_text_ms: quantiles(firstText),
      total_ms: quantiles(total),
      logged_sent_to_received_ms: quantiles(results.map((e) => e.received_at - e.sent_at)),
      sample_finish_reason: last?.output.value && (last.output.value as { finish_reason: string }).finish_reason,
      sample_text_chars: last?.output.value ? (last.output.value as { text: string }).text.length : null,
      cost_events: sink.ofType('cost.usage').slice(0, 2).map((e) => ({ unit: e.unit, quantity: e.quantity, usd: e.estimated_cost_usd.value })),
      status_events: sink.ofType('provider.status').map((e) => [e.status, e.provider_class]),
    },
    null,
    1,
  ),
);

// 中断の確認（1回）: 最初の delta で止める。
const controller = new AbortController();
const abortBegin = performance.now();
const aborted = provider.stream({
  request_id: 'live-abort',
  purpose: 'prefetch',
  system: '',
  messages: [{ role: 'user', text: '日本の四季についてできるだけ長く説明してください' }],
  response_json_schema: null,
  transcript_revision: 0,
  signal: controller.signal,
});
let outcome = 'finished_without_abort';
try {
  for await (const _ of aborted.deltas) {
    controller.abort();
  }
} catch (error) {
  outcome = (error as Error).name;
}
await aborted.result.catch(() => undefined);
console.log(
  JSON.stringify({
    abort_outcome: outcome,
    aborted_after_ms: Math.round(performance.now() - abortBegin),
    response_logged: sink.ofType('llm.response').at(-1)?.output.value === null,
    cost_unit: sink.ofType('cost.usage').at(-1)?.unit,
  }),
);

// モデル不可の明示（生成なし）
const missing = createGeminiProviderFromEnv({ time, emitter, model: 'gemini-does-not-exist', thinking_level: 'low' });
await missing
  .checkModelAvailable()
  .then(() => console.log('unexpected: model available'))
  .catch((error: GeminiProviderError) => console.log(JSON.stringify({ missing_model_kind: error.kind, http: error.http_status })));
process.exit(0);
