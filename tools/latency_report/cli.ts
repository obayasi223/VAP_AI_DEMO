// 発話希望の遅延の段（音声 → ASR → 判定 → 候補 → 合図 → 描画）を段ごとに集計する。文は出力しない。
//   npx tsx tools/latency_report/cli.ts <セッションのディレクトリ | events.jsonl> [--json]
// 終了コード: 0 集計できた、2 使い方の誤りか読めない。
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { computeInitiativeChain, type InitiativeChainReport } from '@llm-vap/analysis';
import type { ResearchEvent } from '@llm-vap/contracts';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { json: { type: 'boolean', default: false } } });
const target = positionals[0];
if (target === undefined || positionals.length > 1) {
  console.error('使い方: latency_report <セッションのディレクトリ | events.jsonl> [--json]');
  process.exit(2);
}
const path = existsSync(target) && statSync(target).isDirectory() ? join(target, 'events.jsonl') : target;
let events: ResearchEvent[];
try {
  // ログの検証は log_check の役目。古いログも読むので、ここではスキーマで落とさない。
  events = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim().length > 0).map((l) => JSON.parse(l) as ResearchEvent);
} catch (error) {
  console.error(`読めません: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}

function format(report: InitiativeChainReport): string {
  const ms = (v: number) => `${Math.round(v)}`;
  const lines: string[] = [];
  const j = report.judgements;
  lines.push(`判定 n=${j.total}  起動: final=${j.by_trigger.final} interim=${j.by_trigger.interim} 不明=${j.by_trigger.unknown}`);
  lines.push(`結果: ${Object.entries(j.outcomes).sort().map(([k, v]) => `${k}=${v}`).join('  ') || '-'}`);
  lines.push('');
  lines.push(`${'段'.padEnd(38)} ${'n'.padStart(3)} ${'中央値'.padStart(7)} ${'最大'.padStart(7)}  除外／理由`);
  for (const row of report.rows) {
    const name = row.breakdown === null ? row.id : `  ${row.id} (${row.breakdown})`;
    if (row.stat.status === 'measured') {
      const excluded = Object.entries(row.stat.excluded).map(([k, v]) => `${k}=${v}`).join(' ');
      lines.push(`${name.padEnd(38)} ${String(row.stat.n).padStart(3)} ${ms(row.stat.p50).padStart(9)} ${ms(row.stat.max).padStart(9)}  ${excluded}`);
    } else {
      lines.push(`${name.padEnd(38)} ${'0'.padStart(3)} ${'-'.padStart(9)} ${'-'.padStart(9)}  ${row.stat.reason}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

const report = computeInitiativeChain(events);
process.stdout.write(values.json ? `${JSON.stringify(report, null, 2)}\n` : format(report));
