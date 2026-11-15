// 反実仮想の板（RQ4）：応答版のセッションの板の生成の入力に台帳の項目を 1 つ足すか除き、N 回作り直して元の板と比べる手動の道具。CI では動かさない。
//   tsx tools/two_ai_counterfactual/cli.ts <session_dir|events.jsonl> (--add kind:said_in:text | --remove item_id [--keep-transcript])
//       [--board-id ID] [--n 5] [--no-baseline] [--config FILE] [--out DIR] [--yes] [--mock]
// 既定は計画（呼び出しの見込み）を出すだけ。--yes で .env の GEMINI_API_KEY の実 Gemini を呼ぶ（課金）。--mock は台本の偽の LLM で通しを確かめる。
// 研究の板（research 版の events）では input が伏せてあるので使えない。終了コード: 0 正常、2 使い方の誤りかキーがない。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { SystemTimeSource, TwoAiSessionConfig, type EventEmitter, type LlmProvider, type ResearchEvent } from '@llm-vap/contracts';
import { loadDotEnv } from '../../apps/orchestrator/src/app/config';
import { REPO_ROOT } from '../../apps/orchestrator/src/maai';
import { loadSafetyLists } from '../../apps/orchestrator/src/cognition/discussion/safety';
import { createGeminiProviderFromEnv } from '../../apps/orchestrator/src/providers/llm/gemini';
import { ProbeMockLlm } from '../two_ai_probe/lib/mock_llm';
import { loadRecordedBoard, parseEdit, plannedCalls, renderMarkdown, runCounterfactual } from './counterfactual';

const USAGE = '使い方: tsx tools/two_ai_counterfactual/cli.ts <session_dir|events.jsonl> (--add kind:said_in:text | --remove item_id [--keep-transcript]) [--board-id ID] [--n 5] [--no-baseline] [--config FILE] [--out DIR] [--yes] [--mock]';

function parseCli() {
  try {
    const { values, positionals } = parseArgs({
      allowPositionals: true,
      options: {
        add: { type: 'string' },
        remove: { type: 'string' },
        'keep-transcript': { type: 'boolean', default: false },
        'board-id': { type: 'string' },
        n: { type: 'string', default: '5' },
        'no-baseline': { type: 'boolean', default: false },
        config: { type: 'string', default: 'config/two_ai/session.responsive.ja.json' },
        out: { type: 'string' },
        yes: { type: 'boolean', default: false },
        mock: { type: 'boolean', default: false },
      },
    });
    const n = Number(values.n);
    if (positionals.length !== 1 || !Number.isInteger(n) || n < 1 || (values.add === undefined) === (values.remove === undefined)) throw new Error('usage');
    const edit = parseEdit({ add: values.add ?? null, remove: values.remove ?? null, keep_transcript: values['keep-transcript'] });
    return { source: positionals[0]!, edit, n, baseline: !values['no-baseline'], board: values['board-id'] ?? null, config: values.config, out: values.out ?? null, yes: values.yes, mock: values.mock };
  } catch (e) {
    console.error(e instanceof Error && e.message !== 'usage' ? `${e.message}\n${USAGE}` : USAGE);
    process.exit(2);
  }
}

const args = parseCli();
const config = TwoAiSessionConfig.parse(JSON.parse(readFileSync(path.resolve(REPO_ROOT, args.config), 'utf8')));
const recorded = loadRecordedBoard(path.resolve(args.source), args.board);
const planned = plannedCalls(args.n, args.baseline);
const header = `板 ${recorded.board_id}（${recorded.trigger}、台帳 v${recorded.ledger_version}、項目 ${recorded.input.items.length}）／N=${args.n}${args.baseline ? '（＋baseline）' : ''}／LLM の呼び出しの見込み ${planned.min}〜${planned.max} 回`;

if (!args.yes && !args.mock) {
  process.stdout.write(`${header}\n計画だけ出した。実の LLM を呼ぶには --yes（課金）、台本の偽の LLM で通すには --mock。\n`);
  process.exit(0);
}

function realLlm(): LlmProvider {
  loadDotEnv();
  if (!process.env.GEMINI_API_KEY) {
    console.error('GEMINI_API_KEY がありません（.env）。--mock なら偽の LLM で通せます。');
    process.exit(2);
  }
  const emitter: EventEmitter = { emit: (draft) => draft as unknown as ResearchEvent };
  return createGeminiProviderFromEnv({ time: new SystemTimeSource(), emitter, model: config.generation.models.discussion_plan, max_output_tokens: 4096, timeout_ms: config.experience.responsive.board_timeout_ms });
}

const llm: LlmProvider = args.yes ? realLlm() : new ProbeMockLlm();
process.stdout.write(`${header}\n`);
const report = await runCounterfactual({
  recorded,
  edit: args.edit,
  n: args.n,
  withBaseline: args.baseline,
  llm,
  safety: loadSafetyLists(config.safety, REPO_ROOT),
  timeout_ms: config.experience.responsive.board_timeout_ms,
});
const md = renderMarkdown(report);
if (args.out !== null) {
  mkdirSync(args.out, { recursive: true });
  writeFileSync(path.join(args.out, `counterfactual_${recorded.board_id}.json`), `${JSON.stringify({ mode: args.yes ? 'real' : 'mock', ...report }, null, 2)}\n`);
  writeFileSync(path.join(args.out, `counterfactual_${recorded.board_id}.md`), md);
  process.stdout.write(`書いた：${args.out}\n`);
} else process.stdout.write(md);
