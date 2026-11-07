// 保存した逐次 ASR を時刻どおりに流し、InitiativeMonitor を実モデルで動かす。
//   --asr handwritten|recorded  素材（handwritten は実 ASR ではない）
//   --scenarios C1,C2           既定は素材のあるもの全部（G3 の C5 を除く）
//   --models gemini-3.5-flash-lite:minimal,gemini-3.8-flash:low
//   --label <名前>              結果の保存先 fixtures/initiative/runs/<名前>/
//   --prompt <版>               既定は現在の版
//   --max-calls <n>             実 API の呼び出しの累計の上限（素材の種類ごとに数える。既定は handwritten 200、recorded 600）
//   --min-new-chars、--boundary-chars  起動の条件（既定は policy の initiative.trigger）
//   --yes                       実行（課金あり）
import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { SystemTimeSource, createEventEmitter } from '@llm-vap/contracts';
import type { LlmProvider, ResearchEvent, TimeSource } from '@llm-vap/contracts';
import { InMemoryCandidateStore } from '@llm-vap/testkit';
import {
  CURRENT_PROMPT_VERSION,
  InitiativeMonitor,
} from '../../apps/orchestrator/src/cognition/initiative';
import type { TriggerOptions } from '../../apps/orchestrator/src/cognition/initiative';
import { CallBudget } from './lib/call_budget';
import { ThinGeminiProvider } from './lib/gemini_thin';
import { RUNS_DIR, existsSync, loadPersona, loadPolicy, loadScenarios, readSttJsonl, sttPath, writeJson } from './lib/project';
import type { Scenario } from './lib/project';
import { replayStt } from './lib/replay';

const { values: args } = parseArgs({
  options: {
    asr: { type: 'string', default: 'recorded' },
    scenarios: { type: 'string' },
    models: { type: 'string', default: 'gemini-3.5-flash-lite:minimal,gemini-3.8-flash:low' },
    label: { type: 'string' },
    prompt: { type: 'string', default: CURRENT_PROMPT_VERSION },
    take: { type: 'string', default: '1' },
    concurrency: { type: 'string', default: '4' },
    'max-calls': { type: 'string' },
    'min-new-chars': { type: 'string' },
    'boundary-chars': { type: 'string' },
    yes: { type: 'boolean', default: false },
  },
});

const origin = args.asr === 'handwritten' ? 'handwritten' : 'recorded';
const take = Number(args.take);
const policy = loadPolicy();
const budget = new CallBudget(
  join(RUNS_DIR, origin === 'handwritten' ? 'call_ledger.json' : 'call_ledger.recorded.json'),
  Number(args['max-calls'] ?? (origin === 'handwritten' ? 200 : 600)),
);
const policyTrigger = policy.initiative.trigger;
if (!policyTrigger) throw new Error('policy.initiative.trigger is not set');
const trigger: TriggerOptions = {
  min_new_stable_chars: args['min-new-chars'] ? Number(args['min-new-chars']) : policyTrigger.min_new_stable_chars,
  min_new_chars_at_boundary:
    args['boundary-chars'] === 'none'
      ? null
      : args['boundary-chars']
        ? Number(args['boundary-chars'])
        : policyTrigger.min_new_chars_at_boundary,
};

function pickScenarios(): Scenario[] {
  const only = args.scenarios?.split(',');
  return loadScenarios()
    .filter((s) => s.expected.outcome !== 'not_applicable_until_g3' || only?.includes(s.id))
    .filter((s) => !only || only.includes(s.id))
    .filter((s) => s.id !== 'C3' || only?.includes('C3'))
    .filter((s) => existsSync(sttPath(origin, s.id, take)));
}

/** D の実装ができたら、ここを差し替える。 */
function makeProvider(model: string, thinking_level: string, time: TimeSource): LlmProvider {
  return new ThinGeminiProvider({ model, thinking_level, time, budget });
}

async function runOne(scenario: Scenario, model: string, thinking: string, dir: string): Promise<void> {
  const stem = `${scenario.id}__${model}__${thinking}__${args.prompt}`;
  const eventsPath = join(dir, `${stem}.events.jsonl`);
  writeFileSync(eventsPath, '');
  const source = readSttJsonl(sttPath(origin, scenario.id, take));
  const time = new SystemTimeSource();
  const sink = { write: (event: ResearchEvent) => appendFileSync(eventsPath, `${JSON.stringify(event)}\n`) };
  const emitter = createEventEmitter({
    time,
    session_id: `${args.label}_${stem}`,
    condition: () => 'initiative_no_cue',
    sink,
  });
  const llm = makeProvider(model, thinking, time);
  const monitor = new InitiativeMonitor({
    llm,
    store: new InMemoryCandidateStore(),
    emitter,
    time,
    persona: loadPersona(scenario),
    limits: policy.initiative,
    trigger,
    prompt_version: args.prompt,
  });
  await replayStt(source, {
    time,
    onEvent: (event) => {
      const { schema_version: _s, t_monotonic_ms: _t, wall_clock: _w, session_id: _i, condition: _c, time_basis: _b, ...draft } = event;
      emitter.emit(draft);
      monitor.onStt(event);
    },
  });
  const speech_end_ms = time.monotonicMs();
  await monitor.finishInput();
  writeJson(join(dir, `${stem}.meta.json`), {
    asr_origin: origin,
    not_real_asr: origin === 'handwritten',
    preliminary: origin === 'handwritten',
    note: origin === 'handwritten' ? '手書きの逐次 ASR による予備調査。§4.5a の関門の通過ではない。' : '実 ASR のリプレイ。人の評価が別途必要。',
    scenario: scenario.id,
    take: origin === 'recorded' ? take : null,
    model,
    thinking,
    provider: llm.provider,
    prompt_version: args.prompt,
    persona: loadPersona(scenario).persona_id,
    trigger,
    limits: policy.initiative,
    speech_end_ms,
    llm_requests: monitor.requestCount(),
    finished_at: new Date().toISOString(),
  });
  console.log(`done ${stem}: ${monitor.requestCount()} requests`);
}

async function main(): Promise<void> {
  const scenarios = pickScenarios();
  const models = (args.models as string).split(',').map((m) => m.split(':') as [string, string]);
  if (!args.label) throw new Error('--label を指定してください');
  if (scenarios.length === 0) throw new Error(`素材が見つかりません（--asr ${origin}）`);
  console.log(`素材: ${origin}${origin === 'handwritten' ? '（実 ASR ではない。予備調査）' : ''}`);
  console.log(`対象: ${scenarios.map((s) => s.id).join(', ')} × ${models.map((m) => m.join(':')).join(', ')}、プロンプト ${args.prompt}`);
  console.log(`呼び出し: 使用済み ${budget.used()} / 上限 ${budget.limit}`);
  if (!args.yes) {
    console.log('課金が発生するので、実行するには --yes を付けてください。実 API は呼び出していません。');
    process.exit(3);
  }
  if (!process.env.GEMINI_API_KEY) {
    console.log('GEMINI_API_KEY が設定されていません。.env を確認してください。');
    process.exit(2);
  }
  const dir = join(RUNS_DIR, args.label);
  mkdirSync(dir, { recursive: true });
  const queue = scenarios.flatMap((s) => models.map(([m, t]) => ({ s, m, t })));
  const workers = Array.from({ length: Number(args.concurrency) }, async () => {
    for (let job = queue.shift(); job; job = queue.shift()) await runOne(job.s, job.m, job.t, dir);
  });
  await Promise.all(workers);
  console.log(`呼び出し: 使用済み ${budget.used()} / 上限 ${budget.limit}`);
  console.log(`結果: ${dir}`);
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(`エラー: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
