/**
 * 評価の実行器。
 *   npx tsx apps/orchestrator/src/cognition/completion/run_eval.ts
 *   node --env-file=.env --import tsx apps/orchestrator/src/cognition/completion/run_eval.ts --llm --yes
 * --llm は評価セットの件数だけ実 API を呼ぶ。結果は eval_results/ へ書く。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { MemoryEventSink, SystemTimeSource, createEventEmitter } from '@llm-vap/contracts';
import { JA_RULES_ESTIMATOR, JaRulesTurnCompletionEstimator, scoreJaRules } from './ja_rules';
import { LLM_COMPLETION_ESTIMATOR, LlmTurnCompletionEstimator } from './llm_estimator';
import { evaluateEstimator, historyOf, loadEvalSet, summarize } from './evaluate';
import type { EvalItem, EvalRow } from './evaluate';
import { createGeminiProviderFromEnv } from '../../providers/llm';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../../..');
const { values: args } = parseArgs({
  options: {
    set: { type: 'string', default: resolve(root, 'tools/turngpt_probe/eval_ja.jsonl') },
    tag: { type: 'string', default: 'eval_ja' },
    threshold: { type: 'string', default: '0.3' },
    llm: { type: 'boolean', default: false },
    'llm-threshold': { type: 'string', default: '0.3' },
    'gap-ms': { type: 'string', default: '1000' },
    yes: { type: 'boolean', default: false },
  },
});

const outDir = resolve(here, 'eval_results');
mkdirSync(outDir, { recursive: true });
const items: EvalItem[] = loadEvalSet(args.set);
const threshold = Number(args.threshold);

const rulesRows = await evaluateEstimator(new JaRulesTurnCompletionEstimator(), items);
const rulesBegin = performance.now();
for (let round = 0; round < 200; round++) {
  for (const item of items) scoreJaRules(historyOf(item), item.partial);
}
const rulesUsPerCall = ((performance.now() - rulesBegin) * 1000) / (200 * items.length);
const rulesOut = {
  estimator: JA_RULES_ESTIMATOR,
  set: args.tag,
  summary: summarize(rulesRows, threshold),
  us_per_call: Number(rulesUsPerCall.toFixed(2)),
  rows: rulesRows.map((row, i) => ({ ...row, cue: scoreJaRules(historyOf(items[i] as EvalItem), (items[i] as EvalItem).partial).cue })),
};
writeFileSync(resolve(outDir, `${JA_RULES_ESTIMATOR}.${args.tag}.json`), `${JSON.stringify(rulesOut, null, 1)}\n`);
console.log(JSON.stringify({ estimator: JA_RULES_ESTIMATOR, summary: rulesOut.summary, us_per_call: rulesOut.us_per_call }, null, 1));

const misses = (rows: readonly EvalRow[], t: number) =>
  rows
    .filter((r) => r.p !== null && ((r.category === 'continues' && r.p > t) || ((r.category === 'question_end' || r.category === 'statement_end') && r.p <= t)))
    .map((r) => r.id);
console.log('rules misses:', misses(rulesRows, threshold));

const baselinePath = resolve(root, 'tools/turngpt_probe/results_baseline.json');
if (args.tag === 'eval_ja' && existsSync(baselinePath)) {
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as { threshold: number; summary: { p_plain: unknown } };
  console.log('TurnGPT probe baseline p_plain (別レーン R3 の結果):', JSON.stringify({ threshold: baseline.threshold, ...(baseline.summary.p_plain as object) }));
}

if (args.llm) {
  if (!args.yes) {
    console.error(`--llm は実 API を ${items.length} 回呼びます。--yes を付けてください。`);
    process.exit(1);
  }
  const sink = new MemoryEventSink();
  const time = new SystemTimeSource();
  const emitter = createEventEmitter({ time, session_id: 'completion-eval', condition: () => 'reactive', sink });
  const provider = createGeminiProviderFromEnv({ time, emitter });
  const estimator = new LlmTurnCompletionEstimator(provider);
  const llmThreshold = Number(args['llm-threshold']);
  const rows = await evaluateEstimator(estimator, items, { gap_ms: Number(args['gap-ms']) });
  const latencies = sink
    .ofType('llm.response')
    .map((event) => event.received_at - event.sent_at)
    .sort((a, b) => a - b);
  const at = (q: number) => latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))];
  const out = {
    estimator: LLM_COMPLETION_ESTIMATOR,
    model: provider.model_version,
    thinking_level: provider.thinking_level,
    set: args.tag,
    summary: summarize(rows, llmThreshold),
    latency_ms: { n: latencies.length, p50: at(0.5), p95: at(0.95), max: latencies.at(-1) },
    rows,
  };
  writeFileSync(resolve(outDir, `${LLM_COMPLETION_ESTIMATOR}.${args.tag}.json`), `${JSON.stringify(out, null, 1)}\n`);
  console.log(JSON.stringify({ estimator: out.estimator, model: out.model, summary: out.summary, latency_ms: out.latency_ms }, null, 1));
  console.log('llm misses:', misses(rows, llmThreshold));
}
process.exit(0);
