// セッションログの検証と集計。関門 G1 の「JSONL のスキーマ検証」で使う。
//   npx tsx tools/log_check/cli.ts <セッションのディレクトリ | events.jsonl> [--json] [--strict]
// 終了コード: 0 合格、1 不合格、2 使い方の誤りか読めない。
import { parseArgs } from 'node:util';
import { checkLog, formatReport } from './check';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    json: { type: 'boolean', default: false },
    strict: { type: 'boolean', default: false },
  },
});

const target = positionals[0];
if (target === undefined || positionals.length > 1) {
  console.error('使い方: log_check <セッションのディレクトリ | events.jsonl> [--json] [--strict]');
  process.exit(2);
}

try {
  const report = await checkLog(target, { strict: values.strict });
  process.stdout.write(values.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report));
  process.exitCode = report.ok ? 0 : 1;
} catch (error) {
  console.error(`読めません: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
}
