// 保存した逐次 ASR を時刻どおりに流し、発話希望の判定を**本実装の経路**で動かす（関門 G2 の準備）。
//   経路: session/initiative_wiring.ts の InitiativeWiring（G の InitiativeMonitor → E2a の CandidateLedger）。
//         LLM は D の実 Gemini プロバイダ（streamGenerateContent）。セッションと同じ部品を通る。
//   --asr handwritten|recorded  素材（handwritten は実 ASR ではない）
//   --scenarios C1,C2           既定は素材のあるもの全部（G3 の C5 を除く）
//   --models gemini-3.5-flash-lite:minimal  モデルと思考の段（既定は S の推奨）
//   --label <名前>              結果の保存先 fixtures/initiative/runs/<名前>/
//   --prompt <版>               1段判定（v2）の版。既定は現在の版
//   --timing-strategy v2|llm|immediate  既定は v2（1段判定）。リプレイでは指定したときだけ二段判定にする
//   --conversation-kind joint_thinking|companion  二段判定の会話の種類（v2 では指定できない）。既定は joint_thinking
//   --desire-prompt、--timing-prompt <版>  二段判定のプロンプトの版
//   --max-calls <n>             実 API の呼び出しの累計の上限（--ledger のファイルで数える）
//   --ledger <名前>             呼び出しの台帳（fixtures/initiative/runs/<名前>.json）。既定は素材ごとの台帳
//   --min-new-chars、--boundary-chars  起動の条件（既定は policy の initiative.trigger。none で文の区切りを見ない）
//   --yes                       実行（課金あり）
import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { ConversationKind, SystemTimeSource, TimingStrategy, createEventEmitter } from '@llm-vap/contracts';
import type { EventEmitter, LlmProvider, LlmRequest, LlmResult, LlmStream, ResearchEvent, TimeSource } from '@llm-vap/contracts';
import {
  CURRENT_DESIRE_PROMPT_VERSION,
  CURRENT_PROMPT_VERSION,
  CURRENT_TIMING_PROMPT_VERSION,
  parseConversationKindProfile,
} from '../../apps/orchestrator/src/cognition/initiative';
import type { StagedOptions, TriggerOptions } from '../../apps/orchestrator/src/cognition/initiative';
import { createGeminiProviderFromEnv } from '../../apps/orchestrator/src/providers/llm';
import type { GeminiThinkingLevel } from '../../apps/orchestrator/src/providers/llm/gemini';
import { InitiativeWiring, NO_CANDIDATE_SPEECH } from '../../apps/orchestrator/src/session/initiative_wiring';
import { CallBudget } from './lib/call_budget';
import { ROOT, RUNS_DIR, existsSync, loadPersona, loadPolicy, loadScenarios, readSttJsonl, sttPath, writeJson } from './lib/project';
import type { Scenario } from './lib/project';
import { replayStt } from './lib/replay';

const { values: args } = parseArgs({
  options: {
    asr: { type: 'string', default: 'recorded' },
    scenarios: { type: 'string' },
    models: { type: 'string', default: 'gemini-3.5-flash-lite:minimal' },
    label: { type: 'string' },
    prompt: { type: 'string', default: CURRENT_PROMPT_VERSION },
    take: { type: 'string', default: '1' },
    concurrency: { type: 'string', default: '4' },
    'max-calls': { type: 'string' },
    ledger: { type: 'string' },
    'min-new-chars': { type: 'string' },
    'boundary-chars': { type: 'string' },
    'timing-strategy': { type: 'string', default: 'v2' },
    'conversation-kind': { type: 'string' },
    'desire-prompt': { type: 'string', default: CURRENT_DESIRE_PROMPT_VERSION },
    'timing-prompt': { type: 'string', default: CURRENT_TIMING_PROMPT_VERSION },
    yes: { type: 'boolean', default: false },
  },
});

const origin = args.asr === 'handwritten' ? 'handwritten' : 'recorded';
const take = Number(args.take);
const policy = loadPolicy();
const ledgerName = args.ledger ?? (origin === 'handwritten' ? 'call_ledger' : 'call_ledger.recorded');
const budget = new CallBudget(
  join(RUNS_DIR, `${ledgerName}.json`),
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
const timingStrategy = TimingStrategy.parse(args['timing-strategy']);
if (timingStrategy === 'v2' && args['conversation-kind']) {
  throw new Error('--conversation-kind は二段判定（--timing-strategy llm|immediate）のときだけ指定できます');
}
/** 二段判定の設定。v2 は null。リプレイは直前のターンを持たないので、直近の会話は渡さない（recent_context の max_turns=0 と同じ結果）。 */
function stagedOptions(): StagedOptions | null {
  if (timingStrategy === 'v2') return null;
  const kind = ConversationKind.parse(args['conversation-kind'] ?? 'joint_thinking');
  return {
    timing_strategy: timingStrategy,
    profile: parseConversationKindProfile(JSON.parse(readFileSync(join(ROOT, 'config', `conversation_kind.${kind}.ja.json`), 'utf8'))),
    recent_context: { max_turns: 0, max_chars_per_turn: 300 },
    desire_prompt_version: args['desire-prompt'] as string,
    timing_prompt_version: args['timing-prompt'] as string,
  };
}
const staged = stagedOptions();
/** 結果のファイル名に入れる判定の設定（1段判定は従来の形のまま）。 */
const judgementLabel = staged === null ? (args.prompt as string) : `${timingStrategy}__${staged.profile.conversation_kind}__${args['desire-prompt']}__${args['timing-prompt']}`;

/** E2a へ人の発話の有無を伝える間隔。セッションの tick（20ms）より粗いが、話の後の判定（MIN_GAP_TIME_MS）には足りる。 */
const FLOOR_TICK_MS = 100;

function pickScenarios(): Scenario[] {
  const only = args.scenarios?.split(',');
  return loadScenarios()
    .filter((s) => s.expected.outcome !== 'not_applicable_until_g3' || only?.includes(s.id))
    .filter((s) => !only || only.includes(s.id))
    .filter((s) => s.id !== 'C3' || only?.includes('C3'))
    .filter((s) => existsSync(sttPath(origin, s.id, take)));
}

/** 実 API の呼び出しの前に台帳で1回ぶん確保する（上限を超える前に止める）。 */
class BudgetedLlm implements LlmProvider {
  readonly provider: string;
  readonly provider_class;
  readonly model_version: string;
  constructor(
    private readonly inner: LlmProvider,
    private readonly label: string,
  ) {
    this.provider = inner.provider;
    this.provider_class = inner.provider_class;
    this.model_version = inner.model_version;
  }
  generate(request: LlmRequest): Promise<LlmResult> {
    budget.consume(`${this.label}:${request.request_id}`);
    return this.inner.generate(request);
  }
  stream(_request: LlmRequest): LlmStream {
    throw new Error('the initiative judge needs the whole JSON; stream is not used');
  }
}

function makeProvider(model: string, thinking: string, time: TimeSource, emitter: EventEmitter): LlmProvider {
  // セッション（app/providers.ts の initiativeFor）と同じ設定: 時間切れは max_result_age_ms、出力の上限 4096。
  const inner = createGeminiProviderFromEnv({
    time,
    emitter,
    model,
    thinking_level: thinking as GeminiThinkingLevel,
    max_output_tokens: 4096,
    ...(policy.initiative.max_result_age_ms !== null ? { timeout_ms: policy.initiative.max_result_age_ms } : {}),
  });
  return new BudgetedLlm(inner, model);
}

async function runOne(scenario: Scenario, model: string, thinking: string, dir: string): Promise<void> {
  const stem = `${scenario.id}__${model}__${thinking}__${judgementLabel}`;
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
  const llm = makeProvider(model, thinking, time, emitter);
  const wiring = new InitiativeWiring({
    llm,
    persona: loadPersona(scenario),
    policy,
    emitter,
    time,
    speech: () => NO_CANDIDATE_SPEECH,
    trigger,
    prompt_version: args.prompt,
    ...(staged ? { staged } : {}),
  });
  // 人の発話の有無: 記録を流している間は話している、流し終えたら黙った（VAP がないので記録の範囲で近似する）。
  let speaking = true;
  const floor = setInterval(() => wiring.tick(time.monotonicMs(), speaking), FLOOR_TICK_MS);
  wiring.tick(time.monotonicMs(), true);
  await replayStt(source, {
    time,
    onEvent: (event) => {
      const { schema_version: _s, t_monotonic_ms: _t, wall_clock: _w, session_id: _i, condition: _c, time_basis: _b, ...draft } = event;
      emitter.emit(draft);
      wiring.onStt(event);
    },
  });
  const speech_end_ms = time.monotonicMs();
  speaking = false;
  wiring.tick(speech_end_ms, false);
  await wiring.monitor.finishInput();
  clearInterval(floor);
  wiring.close();
  writeJson(join(dir, `${stem}.meta.json`), {
    asr_origin: origin,
    not_real_asr: origin === 'handwritten',
    preliminary: origin === 'handwritten',
    note:
      origin === 'handwritten'
        ? '手書きの逐次 ASR による予備調査。§4.5a の関門（G2 を含む）の通過ではない。'
        : '実 ASR のリプレイ。人の評価が別途必要。',
    path: 'production_wiring',
    scenario: scenario.id,
    take: origin === 'recorded' ? take : null,
    model,
    thinking,
    provider: llm.provider,
    provider_class: llm.provider_class,
    // スパイク（p2_v2_tune など）は tools/initiative_spike/lib/gemini_thin.ts の Interactions API だった。
    api: 'streamGenerateContent',
    prompt_version: staged === null ? args.prompt : null,
    timing_strategy: timingStrategy,
    conversation_kind: staged?.profile.conversation_kind ?? null,
    profile_version: staged?.profile.profile_version ?? null,
    desire_prompt_version: staged === null ? null : args['desire-prompt'],
    timing_prompt_version: staged === null ? null : args['timing-prompt'],
    persona: loadPersona(scenario).persona_id,
    trigger,
    limits: policy.initiative,
    floor_tick_ms: FLOOR_TICK_MS,
    speech_end_ms,
    llm_requests: wiring.monitor.requestCount(),
    candidates_at_end: wiring.ledger.list().length,
    finished_at: new Date().toISOString(),
  });
  console.log(`done ${stem}: ${wiring.monitor.requestCount()} requests`);
}

async function main(): Promise<void> {
  const scenarios = pickScenarios();
  const models = (args.models as string).split(',').map((m) => m.split(':') as [string, string]);
  if (!args.label) throw new Error('--label を指定してください');
  if (scenarios.length === 0) throw new Error(`素材が見つかりません（--asr ${origin}）`);
  console.log(`素材: ${origin}${origin === 'handwritten' ? '（実 ASR ではない。予備調査）' : ''}`);
  console.log('経路: 本実装（InitiativeWiring → CandidateLedger）、D の Gemini プロバイダ');
  console.log(`対象: ${scenarios.map((s) => s.id).join(', ')} × ${models.map((m) => m.join(':')).join(', ')}、プロンプト ${args.prompt}`);
  console.log(`起動の条件: ${JSON.stringify(trigger)}`);
  console.log(`呼び出し: 使用済み ${budget.used()} / 上限 ${budget.limit}（${ledgerName}）`);
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
