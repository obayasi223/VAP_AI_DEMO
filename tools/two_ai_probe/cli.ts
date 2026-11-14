// two_ai の用途ごとの遅れ（計画 (c)、生のターン (d)、訂正の判定 (e)）を架空の台帳で測る手動の道具（02 §5、05 §5.2）。CI では動かさない。
//   tsx tools/two_ai_probe/cli.ts [--real] [--turns N] [--corrections M] [--stt-p95-ms X] [--plan-timeout-ms T] [--plan-mode staged|single] [--config FILE] [--json]
// 既定は偽の LLM（遅れは仮の値）。--real は .env の GEMINI_API_KEY で実 Gemini を呼ぶ（課金。計画 1 回（staged は＋段 3 回）＋N＋M 回）。
// STT の確定文の遅れはここでは測らない。測った p95 があれば --stt-p95-ms で渡す（なければ 1500 ms と仮に置く）。
// 本文は出力しない。終了コード: 0 正常、2 使い方の誤りかキーがない。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { SystemTimeSource, TwoAiSessionConfig, type EventEmitter, type LlmProvider, type ResearchEvent } from '@llm-vap/contracts';
import { loadDotEnv } from '../../apps/orchestrator/src/app/config';
import { REPO_ROOT } from '../../apps/orchestrator/src/maai';
import { loadDiscussionAssets } from '../../apps/orchestrator/src/cognition/discussion/assets';
import { createGeminiProviderFromEnv } from '../../apps/orchestrator/src/providers/llm/gemini';
import { ProbeMockLlm } from './lib/mock_llm';
import { formatReport, runProbe, type ProbeLlms } from './lib/run';

const USAGE = '使い方: tsx tools/two_ai_probe/cli.ts [--real] [--turns N] [--corrections M] [--stt-p95-ms X] [--plan-timeout-ms T] [--plan-mode staged|single] [--config FILE] [--json]';

function parseCli() {
  try {
    const { values } = parseArgs({
      options: {
        real: { type: 'boolean', default: false },
        turns: { type: 'string', default: '20' },
        corrections: { type: 'string', default: '30' },
        'stt-p95-ms': { type: 'string' },
        'plan-timeout-ms': { type: 'string' },
        config: { type: 'string', default: 'config/two_ai/session.ja.json' },
        json: { type: 'boolean', default: false },
        'plan-mode': { type: 'string', default: 'staged' },
      },
    });
    const turns = Number(values.turns);
    const corrections = Number(values.corrections);
    const stt = values['stt-p95-ms'] === undefined ? null : Number(values['stt-p95-ms']);
    const planTimeout = values['plan-timeout-ms'] === undefined ? null : Number(values['plan-timeout-ms']);
    if ((planTimeout !== null && !(planTimeout > 0)) || !Number.isInteger(turns) || turns < 0 || !Number.isInteger(corrections) || corrections < 0 || (stt !== null && !(stt >= 0))) throw new Error('bad number');
    const planMode = values['plan-mode'];
    if (planMode !== 'staged' && planMode !== 'single') throw new Error('bad plan mode');
    return { planMode: planMode as 'staged' | 'single', real: values.real, turns, corrections, stt, planTimeout, config: values.config, json: values.json };
  } catch {
    console.error(USAGE);
    process.exit(2);
  }
}

const args = parseCli();
const rawConfig = JSON.parse(readFileSync(path.resolve(REPO_ROOT, args.config), 'utf8')) as { generation: { timeout_ms: { discussion_plan: number } } };
// 計画の時間切れより長くかかるときの実の遅れを見るため、時間切れだけを差し替えられる（設定のファイルは変えない）
if (args.planTimeout !== null) rawConfig.generation.timeout_ms.discussion_plan = args.planTimeout;
const config = TwoAiSessionConfig.parse(rawConfig);
const assets = loadDiscussionAssets(REPO_ROOT, config);

function realLlms(): ProbeLlms {
  loadDotEnv();
  if (!process.env.GEMINI_API_KEY) {
    console.error('GEMINI_API_KEY がありません（.env）。--real なしで偽の LLM で動かせます。');
    process.exit(2);
  }
  const time = new SystemTimeSource();
  const emitter: EventEmitter = { emit: (draft) => draft as unknown as ResearchEvent };
  const models = config.generation.models;
  const make = (model: string, max_output_tokens: number, timeout_ms: number): LlmProvider => createGeminiProviderFromEnv({ time, emitter, model, max_output_tokens, timeout_ms });
  const t = config.generation.timeout_ms;
  return { plan: make(models.discussion_plan, 16384, t.discussion_plan), turn: make(models.discussion_turn, 512, t.discussion_turn), correction: make(models.correction_assist, 256, t.correction_assist) };
}

const llms: ProbeLlms = args.real ? realLlms() : { plan: new ProbeMockLlm(), turn: new ProbeMockLlm(), correction: new ProbeMockLlm() };
const report = await runProbe({ config, assets, llms, options: { turns: args.turns, corrections: args.corrections, stt_p95_ms: args.stt, plan_mode: args.planMode } });
if (args.json) process.stdout.write(`${JSON.stringify({ mode: args.real ? 'real' : 'mock', ...report }, null, 2)}\n`);
else process.stdout.write(formatReport(report, args.real ? 'real' : 'mock'));
