// 1回の実行（--label）の結果を集計し、summary.md と評価シート eval.csv を作る。API は呼ばない。
import { parseArgs } from 'node:util';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RUNS_DIR, loadScenarios, writeJson } from './lib/project';
import { buildEvalCsv, matchesHypothesis, summarizeRun } from './lib/report_core';
import type { EvalRunInput, RawEvent } from './lib/report_core';

const { values: args } = parseArgs({ options: { label: { type: 'string' } } });
if (!args.label) throw new Error('--label を指定してください');
const dir = join(RUNS_DIR, args.label);
const scenarios = loadScenarios();

const quantile = (values: number[], q: number): number | null => {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const low = Math.floor(pos);
  const high = Math.ceil(pos);
  return Math.round((s[low] as number) + ((s[high] as number) - (s[low] as number)) * (pos - low));
};

const metas = readdirSync(dir).filter((f) => f.endsWith('.meta.json')).sort();
const runs = metas.map((file) => {
  const meta = JSON.parse(readFileSync(join(dir, file), 'utf8'));
  const events = readFileSync(join(dir, file.replace('.meta.json', '.events.jsonl')), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as RawEvent);
  const summary = summarizeRun(events, meta.speech_end_ms);
  const scenario = scenarios.find((s) => s.id === meta.scenario);
  const full_text = events.filter((e) => e.event === 'stt.final').map((e) => e.text as string).join(' ');
  return { meta, summary, scenario, full_text };
});

const origin = runs[0]?.meta.asr_origin;
const out: string[] = [`# 実行 ${args.label} の集計`, ''];
if (origin === 'handwritten') {
  out.push('**手書きの逐次 ASR による予備調査。実音声でも実 ASR でもなく、§4.5a の関門の通過ではない。**', '');
} else {
  out.push('実 ASR のリプレイ。下の「仮説との一致」は機械的な比較で、合否は人の評価（eval.csv の3列）で決める。', '');
}
const paths = [...new Set(runs.map((r) => r.meta.path ?? 'spike_monitor'))];
out.push(`経路: ${paths.join(', ')}（production_wiring は本実装の InitiativeWiring と CandidateLedger、spike_monitor はスパイク）。`, '');
out.push(`各行 n=1 回の実行。プロンプト版: ${[...new Set(runs.map((r) => r.meta.prompt_version))].join(', ')}。`, '');
out.push('| 台本 | 種類 | モデル | 要求 | 判定の内訳 | NEW(話の途中) | NEW(話の後) | 話の後の NEW の保留 | モデルの NEW のうちゲート棄却 | 撤回(モデル/コード) | 残った候補 | 仮説との一致 | 遅延 p50/max ms |');
out.push('|---|---|---|---:|---|---:|---:|---:|---:|---:|---:|---|---:|');
for (const r of runs) {
  const s = r.summary;
  const match = r.scenario ? matchesHypothesis(r.scenario.expected.outcome, s) : null;
  out.push(
    `| ${r.meta.scenario} | ${r.scenario?.kind ?? ''} | ${r.meta.model}:${r.meta.thinking} | ${s.llm_requests} | ${Object.entries(s.counts).map(([k, v]) => `${k} ${v}`).join(', ')} | ${s.new_during_speech} | ${s.new_after_speech} | ${s.new_held_post_turn ?? 0} | ${s.gate_rejected_new} | ${s.withdrawn_by_model}/${s.withdrawn_by_code} | ${s.active_at_end} | ${match === null ? '対象外' : match ? '一致' : '不一致'} | ${quantile(s.latency_ms, 0.5)}/${quantile(s.latency_ms, 1)} |`,
  );
}
const holds = runs.flatMap((r) => r.summary.hold.map((h) => ({ scenario: r.meta.scenario, model: r.meta.model, ...h })));
out.push('', '## NEW の後に持続の確認を1段入れていた場合（事後計算）', '');
out.push('| 台本 | モデル | 候補 | NEW 受信 s | 次の判定 | 合図を避けられた | 増える遅れ ms |');
out.push('|---|---|---|---:|---|---|---:|');
for (const h of holds) {
  out.push(`| ${h.scenario} | ${h.model} | ${h.candidate_id} | ${(h.new_at_ms / 1000).toFixed(1)} | ${h.next_decision ?? '（次なし）'} | ${h.cue_avoided ? 'はい' : 'いいえ'} | ${h.added_delay_ms === null ? '' : Math.round(h.added_delay_ms)} |`);
}
out.push('', '## 遅延（モデル別、全要求）', '');
for (const model of [...new Set(runs.map((r) => r.meta.model as string))]) {
  const values = runs.filter((r) => r.meta.model === model).flatMap((r) => r.summary.latency_ms);
  const errors = runs.filter((r) => r.meta.model === model).reduce((n, r) => n + r.summary.llm_errors, 0);
  out.push(`- ${model}: n=${values.length}、p50 ${quantile(values, 0.5)}ms、p95 ${quantile(values, 0.95)}ms、max ${quantile(values, 1)}ms、失敗 ${errors}`);
}
writeFileSync(join(dir, 'summary.md'), `${out.join('\n')}\n`);
writeJson(join(dir, 'summary.json'), runs.map((r) => ({ meta: r.meta, summary: { ...r.summary, rows: undefined } })));
const evalRuns: EvalRunInput[] = runs.map((r) => ({
  scenario: r.meta.scenario,
  asr_origin: r.meta.asr_origin === 'handwritten' ? '手書き(実ASRではない)' : '実ASR',
  model: r.meta.model,
  prompt_version: r.meta.prompt_version,
  summary: r.summary,
  full_text: r.full_text,
}));
writeFileSync(join(dir, 'eval.csv'), buildEvalCsv(evalRuns));
console.log(out.join('\n'));
console.log(`\n評価シート: ${join(dir, 'eval.csv')}`);
