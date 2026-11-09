// 候補ごとの遅延の区間（根拠の音声 → 合図の描画）と、合図が話の途中に届いたか。docs/time_axes.md を参照。
//   npm run latency:initiative -- <sessions の親 | セッション | events.jsonl | glob>... [--json]
// 実会話の本文は出力しない。終了コード: 0 正常、2 使い方の誤りか読めない。
import { parseArgs } from 'node:util';
import { analyzePaths } from './lib/load';
import { formatReport, summarize } from './lib/report';

const USAGE = '使い方: latency:initiative <sessions の親 | セッション | events.jsonl | glob>... [--json]';

function parseCli(): { json: boolean; positionals: string[] } {
  try {
    const { values, positionals } = parseArgs({
      allowPositionals: true,
      options: { json: { type: 'boolean', default: false } },
    });
    if (positionals.length > 0) return { json: values.json, positionals };
  } catch {
    // 下で使い方を出す
  }
  console.error(USAGE);
  process.exit(2);
}

const { json, positionals } = parseCli();

try {
  const { files, rows } = await analyzePaths(positionals);
  if (files.length === 0) {
    console.error('events.jsonl が見つかりません');
    process.exit(2);
  }
  const summary = summarize(rows);
  if (json) process.stdout.write(`${JSON.stringify({ sessions: files.length, summary, candidates: rows }, null, 2)}\n`);
  else process.stdout.write(`セッション ${files.length} 件\n${formatReport(rows, summary)}`);
} catch (error) {
  console.error(`読めません: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
