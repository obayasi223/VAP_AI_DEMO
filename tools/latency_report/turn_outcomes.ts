// AI の発話ごとの結果（turn.outcome）の一覧と中央値を出す。文は出力しない。
//   npx tsx tools/latency_report/turn_outcomes.ts <セッションのディレクトリ | events.jsonl> [--json] [--policy <file>]
// 記録に turn.outcome がない古いログは、記録の入力から同じ規則で算出する（--policy の方策の turn.outcome で閾値を読む。既定は config/policy.ja.json）。
// 既定は実際に起きた開始の評価。--replay はその方策で開始を計算し直した値（/tune と同じ反実仮想。no_response を含む）を出す。
// 終了コード: 0 集計できた、2 使い方の誤りか読めない。
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { summarizeTurnOutcomes, turnOutcomeRows } from '@llm-vap/analysis';
import { Policy } from '@llm-vap/contracts';
import type { ResearchEvent, TurnOutcomeBody } from '@llm-vap/contracts';
import { parseEventsJsonl, prepareLog, replay } from '../../apps/orchestrator/src/dev/replay';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { json: { type: 'boolean', default: false }, replay: { type: 'boolean', default: false }, policy: { type: 'string' } } });
const target = positionals[0];
if (target === undefined || positionals.length > 1) {
  console.error('使い方: turn_outcomes <セッションのディレクトリ | events.jsonl> [--json] [--policy <file>] [--replay]');
  process.exit(2);
}
const path = existsSync(target) && statSync(target).isDirectory() ? join(target, 'events.jsonl') : target;
let text: string;
try {
  text = readFileSync(path, 'utf8');
} catch (error) {
  console.error(`読めません: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
const raw = text
  .split('\n')
  .filter((l) => l.trim().length > 0)
  .map((l) => JSON.parse(l) as ResearchEvent);
const recorded = raw.filter((e) => e.event === 'turn.outcome') as (TurnOutcomeBody & { t_monotonic_ms: number })[];
let outcomes: (TurnOutcomeBody & { t_monotonic_ms?: number })[];
let source: string;
if (recorded.length > 0 && !values.replay) {
  outcomes = recorded;
  source = `記録の turn.outcome（${recorded.length} 件）`;
} else {
  const policyFile = resolve(values.policy ?? join(import.meta.dirname, '..', '..', 'config', 'policy.ja.json'));
  const policy = Policy.parse(JSON.parse(readFileSync(policyFile, 'utf8')));
  const { events } = parseEventsJsonl(text);
  const result = replay(prepareLog(events), policy);
  if (values.replay) {
    outcomes = result.outcomes.replayed;
    source = `再生で算出（方策 ${policyFile}。開始を計算し直した反実仮想。/tune と同じ限界）`;
  } else {
    outcomes = result.outcomes.recorded;
    source = `記録の入力から算出（turn.outcome のない古いログ、閾値は方策 ${policyFile}。no_response は --replay でだけ出る）`;
  }
}

const rows = turnOutcomeRows(outcomes);
const summary = summarizeTurnOutcomes(rows);
if (values.json) {
  process.stdout.write(`${JSON.stringify({ source, rows, summary }, null, 2)}\n`);
  process.exit(0);
}
const t0 = rows[0]?.t_ms ?? 0;
const num = (v: number | null, digits = 0) => (v === null ? '-' : v.toFixed(digits));
const lines: string[] = [`出所: ${source}`, ''];
lines.push(`${'t(s)'.padStart(8)} ${'id'.padStart(4)} ${'origin'.padEnd(9)} ${'判断の元'.padEnd(18)} ${'p_now'.padStart(5)} ${'間ms'.padStart(6)} ${'声→開始'.padStart(7)} ${'重なり'.padStart(6)} ${'再生ms'.padStart(7)}  ラベル`);
for (const r of rows) {
  const labels = r.labels.length > 0 ? r.labels.join(' ') : r.null_reason === null ? '-' : `（分類なし: ${r.null_reason}）`;
  const id = r.audio_playback_id === null ? '-' : String(r.audio_playback_id);
  const source_ = r.kind === 'no_response' ? `no_response:${r.reason ?? ''}` : (r.decision_source ?? '-');
  lines.push(
    `${((r.t_ms - t0) / 1000).toFixed(2).padStart(8)} ${id.padStart(4)} ${(r.origin ?? '-').padEnd(9)} ${source_.padEnd(18)} ${num(r.p_now, 2).padStart(5)} ${num(r.gap_ms).padStart(6)} ${num(r.voice_gap_before_ms).padStart(7)} ${num(r.overlap_ms).padStart(6)} ${num(r.played_ms).padStart(7)}  ${labels}${r.echo_suspected ? ' [エコーの疑い]' : ''}`,
  );
}
lines.push('');
lines.push(`発話 ${summary.ai_utterances}　分類なし ${summary.unsettled}　全行 ${summary.rows}`);
lines.push(`ラベルの件数: ${Object.entries(summary.by_label).sort().map(([k, v]) => `${k}=${v}`).join('  ') || '-'}`);
if (Object.keys(summary.by_null_reason).length > 0) lines.push(`分類なしの理由: ${Object.entries(summary.by_null_reason).sort().map(([k, v]) => `${k}=${v}`).join('  ')}`);
lines.push(`中央値: ${Object.entries(summary.medians).map(([k, v]) => `${k}=${v.median === null ? '-' : Math.round(v.median)}(n=${v.n})`).join('  ')}`);
process.stdout.write(`${lines.join('\n')}\n`);
