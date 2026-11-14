/**
 * 用途ごとの遅れの測定（02 §5 の手動の確認、05 §5.2）。
 * (c) 計画 1 回、(d) 計画の始めの拍から n ターン、(e) 架空の訂正の発話 m 件。STT の確定文の遅れはここでは測らない（未計測として返す）。
 * 本文は返さない（文字数、安全の検査の当たり、判定の正誤だけ）。
 */
import type { LlmProvider, TwoAiSessionConfig } from '@llm-vap/contracts';
import type { DiscussionAssets } from '../../../apps/orchestrator/src/cognition/discussion/assets';
import { buildCorrectionPrompt, CORRECTION_JSON_SCHEMA, CORRECTION_PROMPT_VERSION, parseCorrectionOutput } from '../../../apps/orchestrator/src/cognition/discussion/correction_assist';
import { emptyLedger, mergeLedgerOutput } from '../../../apps/orchestrator/src/cognition/discussion/ledger';
import { callLlm } from '../../../apps/orchestrator/src/cognition/discussion/llm_call';
import {
  assemblePlan,
  buildPlanPrompt,
  chooseFacts,
  outlinePlan,
  planJsonSchema,
  planNeeds,
  pointSpecs,
  PLAN_PROMPT_VERSION,
  PLAN_STAGED_PROMPT_VERSION,
  type PlanDeps,
} from '../../../apps/orchestrator/src/cognition/discussion/plan';
import { checkText, NO_CONTEXT, safeLedger } from '../../../apps/orchestrator/src/cognition/discussion/safety';
import { charCount, parseJsonLoose } from '../../../apps/orchestrator/src/cognition/discussion/text';
import { assembleStageBeats, buildStagePrompt, STAGE_JSON_SCHEMA, STAGE_PROMPT_VERSION } from '../../../apps/orchestrator/src/cognition/discussion/stage_plan';
import { buildTurnPrompt, TURN_PROMPT_VERSION } from '../../../apps/orchestrator/src/cognition/discussion/turn_prompt';
import type { DiscussionPlan, ProblemLedger } from '../../../apps/orchestrator/src/cognition/discussion/types';
import { holdMaxMs, latencyStats, planWaitProposal, type LatencyStats } from './stats';
import { correctionCases, DEFAULT_SLIP, LEDGER_OUTPUT, PROFILE, UTTERANCES } from './synthetic';

export interface ProbeLlms {
  plan: LlmProvider;
  turn: LlmProvider;
  correction: LlmProvider;
}

export interface ProbeOptions {
  turns: number;
  corrections: number;
  /** STT の確定文の p95（ms）。測っていなければ null（仮の値で hold_max_ms を出す）。 */
  stt_p95_ms: number | null;
  /** staged（既定）は段 1 と点・板の呼び出しの後に段 2〜4 の呼び出しを順に測る。single は従来の 1 回。 */
  plan_mode?: 'staged' | 'single';
}

export interface StageCallReport {
  stage: 2 | 3 | 4;
  ok: boolean;
  latency_ms: number | null;
  reasons: string[];
  /** 段の呼び出しを話し合いの始めから順に出したときの終わり（ms）と、その段が要る見込みの時刻（ms）。 */
  done_at_ms: number | null;
  needed_at_ms: number;
}

export interface ProbeReport {
  plan_mode: 'staged' | 'single';
  stages: StageCallReport[];
  plan: { ok: boolean; attempts: number; latency_ms: number | null; first_text_ms: number | null; source: DiscussionPlan['source'] | null; beats: number; reasons: string[]; model: string };
  turns: { stats: LatencyStats; first_text: LatencyStats; failures: string[]; chars: number[]; out_of_band: number; safety_hits: Record<string, number>; model: string };
  correction: { stats: LatencyStats; failures: number; correct: number; wrong: number; model: string };
  stt: { measured: boolean; p95_ms: number | null };
  proposal: { plan_wait: { max_wait_ms: number; plan_start_sec: number } | null; hold_max_ms: number | null };
  prompt_versions: Record<string, string>;
}

export function syntheticLedger(): ProblemLedger {
  const merged = mergeLedgerOutput(emptyLedger(PROFILE), LEDGER_OUTPUT, UTTERANCES);
  if (merged === null) throw new Error('synthetic ledger did not merge');
  return merged.ledger;
}

function ledgerText(ledger: ProblemLedger, id: string): string | null {
  const items = [ledger.core, ...ledger.options, ...ledger.dropped_options, ...ledger.facts, ...ledger.values];
  return items.find((x) => x?.id === id)?.text ?? null;
}

export async function runProbe(input: { config: TwoAiSessionConfig; assets: DiscussionAssets; llms: ProbeLlms; options: ProbeOptions }): Promise<ProbeReport> {
  const { config, assets, llms, options } = input;
  const planMode = options.plan_mode ?? 'staged';
  const deps: PlanDeps = { config, script: null, ...assets, plan_mode: planMode };
  const ledger = safeLedger(syntheticLedger(), assets.safety).ledger;
  const timeouts = config.generation.timeout_ms;

  // (c) 計画
  const facts = chooseFacts(null, ledger, pointSpecs(deps));
  const needs = planNeeds(deps, facts);
  const prompt = buildPlanPrompt(deps, ledger, facts, needs);
  // 生成器と同じく、不合格なら理由を付けて 1 回だけ作り直す（02 §2.5(c)）
  const meta = { models: { discussion_plan: llms.plan.model_version, discussion_turn: llms.turn.model_version }, prompt_versions: { plan: planMode === 'staged' ? PLAN_STAGED_PROMPT_VERSION : PLAN_PROMPT_VERSION, turn: TURN_PROMPT_VERSION } };
  let plan: DiscussionPlan | null = null;
  const reasons: string[] = [];
  const planLatencies: number[] = [];
  let planCall: Awaited<ReturnType<typeof callLlm>> | null = null;
  let retryReason = '';
  let attempts = 0;
  for (let attempt = 0; attempt < 2 && plan === null; attempt++) {
    attempts += 1;
    const messages = attempt === 0 ? prompt.messages : [...prompt.messages, { role: 'user' as const, text: `前の案は次の理由で不合格でした。直して書き直してください：${retryReason}`.slice(0, 1500) }];
    planCall = await callLlm(llms.plan, {
      request_id: `probe_plan_${attempt + 1}`,
      purpose: 'discussion_plan',
      system: prompt.system,
      messages,
      response_json_schema: planJsonSchema(needs),
      timeout_ms: timeouts.discussion_plan,
    });
    if (!planCall.ok) {
      retryReason = planCall.reason;
      reasons.push(`attempt ${attempt + 1}: ${planCall.reason}`);
      continue;
    }
    planLatencies.push(planCall.latency_ms);
    const assembled = assemblePlan(deps, ledger, UTTERANCES, parseJsonLoose(planCall.text), meta);
    if (assembled.ok) plan = assembled.plan;
    else {
      retryReason = assembled.reasons.slice(0, 8).join('; ');
      reasons.push(...assembled.reasons.map((r) => `attempt ${attempt + 1}: ${r}`));
    }
  }
  const generatedOk = plan !== null;
  if (plan === null) {
    const outline = outlinePlan(deps, ledger, false);
    if (outline.ok) plan = outline.plan;
    else reasons.push(...outline.reasons.map((r) => `outline: ${r}`));
  }

  // (c') 段 2〜4（話し合いの始めから順に。前の段が決まってから次の段）
  const stages: StageCallReport[] = [];
  if (plan !== null && plan.staged_stages.length > 0) {
    const d = config.phases.discussion;
    let clock = 0;
    let neededAt = 0;
    for (const stage of [2, 3, 4] as const) {
      neededAt += d.target_sec * d.stage_fracs[stage - 2]! * 1000;
      const sp = buildStagePrompt(deps, ledger, plan, stage, { fact_state: 'normal' });
      const call = await callLlm(llms.plan, {
        request_id: `probe_plan_stage${stage}`,
        purpose: 'discussion_plan',
        system: sp.system,
        messages: sp.messages,
        response_json_schema: STAGE_JSON_SCHEMA,
        timeout_ms: timeouts.discussion_plan,
      });
      const r = call.ok ? assembleStageBeats(deps, ledger, plan, stage, parseJsonLoose(call.text), { fact_state: 'normal' }) : { ok: false as const, reasons: [call.reason] };
      if (r.ok) for (const b of r.beats) plan.beats[plan.beats.findIndex((x) => x.beat_id === b.beat_id)] = b;
      clock += call.latency_ms ?? timeouts.discussion_plan;
      stages.push({ stage, ok: r.ok, latency_ms: call.latency_ms, reasons: r.ok ? [] : r.reasons.slice(0, 6), done_at_ms: call.ok ? clock : null, needed_at_ms: Math.round(neededAt) });
    }
  }

  // (d) 生のターン（計画の始めの拍から）
  const turnLatencies: number[] = [];
  const firstTexts: number[] = [];
  const failures: string[] = [];
  const chars: number[] = [];
  const safetyHits: Record<string, number> = {};
  let outOfBand = 0;
  const beats = plan?.beats ?? [];
  const personas = assets.personas.personas;
  const cTerms = plan?.points.flatMap((p) => p.c_terms) ?? [];
  const history: { speaker_name: string; text: string }[] = [];
  for (let i = 0; i < Math.min(options.turns, beats.length); i++) {
    const beat = beats[i]!;
    const self = beat.speaker === 'A' ? personas[0] : personas[1];
    const peer = beat.speaker === 'A' ? personas[1] : personas[0];
    const turnPrompt = buildTurnPrompt({
      self,
      peer,
      user_name: ledger.user_name,
      beat,
      material: beat.ledger_refs.map((r) => ledgerText(ledger, r)).filter((x): x is string => x !== null),
      next_intents: beats.slice(i + 1, i + 3).map((b) => b.intent),
      banned_c_phrases: cTerms,
      banned_facts: [],
      history: history.slice(-config.generation.history_turns),
      after_point: false,
      fed_interjections: [],
      feed_turn: false,
    });
    const call = await callLlm(llms.turn, {
      request_id: `probe_turn_${i + 1}`,
      purpose: 'discussion_turn',
      system: turnPrompt.system,
      messages: turnPrompt.messages,
      response_json_schema: null,
      timeout_ms: timeouts.discussion_turn,
    });
    if (!call.ok) {
      failures.push(call.reason);
      history.push({ speaker_name: self.display_name, text: beat.fallback_text });
      continue;
    }
    turnLatencies.push(call.latency_ms);
    if (call.first_text_ms !== null) firstTexts.push(call.first_text_ms);
    const check = checkText(call.text, assets.safety, NO_CONTEXT, personas.map((p) => p.display_name));
    if (!check.ok && check.rule !== null) safetyHits[check.rule] = (safetyHits[check.rule] ?? 0) + 1;
    const n = charCount(check.cleaned);
    chars.push(n);
    const [lo, hi] = beat.target_chars;
    if (n < lo * 0.8 || n > hi * 1.2) outOfBand++;
    history.push({ speaker_name: self.display_name, text: check.cleaned });
  }

  // (e) 訂正の判定
  const slip = plan?.points.find((p) => p.slip !== null)?.slip;
  const statements = slip ? { slip_statement: slip.slip_statement, correct_statement: slip.correct_statement } : DEFAULT_SLIP;
  const corrLatencies: number[] = [];
  let corrFailures = 0;
  let correct = 0;
  let wrong = 0;
  const cases = correctionCases(DEFAULT_SLIP, options.corrections);
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i]!;
    const p = buildCorrectionPrompt({ ...statements, utterance: c.utterance });
    const call = await callLlm(llms.correction, {
      request_id: `probe_correction_${i + 1}`,
      purpose: 'correction_assist',
      system: p.system,
      messages: p.messages,
      response_json_schema: CORRECTION_JSON_SCHEMA,
      timeout_ms: timeouts.correction_assist,
    });
    if (!call.ok) {
      corrFailures++;
      continue;
    }
    corrLatencies.push(call.latency_ms);
    const parsed = parseCorrectionOutput(parseJsonLoose(call.text), c.utterance);
    if (parsed === null) corrFailures++;
    else if (parsed.corrects === c.corrects) correct++;
    else wrong++;
  }

  // 作り直しを含めた、計画が凍結するまでの時間（段 1 と点・板）
  const planP95 = generatedOk ? planLatencies.reduce((a, b) => a + b, 0) : null;
  const corrStats = latencyStats(corrLatencies);
  return {
    plan_mode: planMode,
    stages,
    plan: {
      ok: generatedOk,
      latency_ms: planLatencies.length > 0 ? planLatencies.reduce((a, b) => a + b, 0) : null,
      first_text_ms: planCall?.ok ? planCall.first_text_ms : null,
      attempts,
      source: plan?.source ?? null,
      beats: beats.length,
      reasons,
      model: planCall?.model ?? llms.plan.model_version,
    },
    turns: { stats: latencyStats(turnLatencies), first_text: latencyStats(firstTexts), failures, chars, out_of_band: outOfBand, safety_hits: safetyHits, model: llms.turn.model_version },
    correction: { stats: corrStats, failures: corrFailures, correct, wrong, model: llms.correction.model_version },
    stt: { measured: options.stt_p95_ms !== null, p95_ms: options.stt_p95_ms },
    proposal: {
      // (c) は 1 回だけなので p95 の代わりにその値を使う（回数を増やせば p95 に置き換える）
      plan_wait: planWaitProposal(planP95, config.phases.intake),
      hold_max_ms: holdMaxMs(options.stt_p95_ms, corrStats.p95_ms),
    },
    prompt_versions: { plan: planMode === 'staged' ? PLAN_STAGED_PROMPT_VERSION : PLAN_PROMPT_VERSION, plan_stage: STAGE_PROMPT_VERSION, turn: TURN_PROMPT_VERSION, correction: CORRECTION_PROMPT_VERSION },
  };
}

export function formatReport(r: ProbeReport, mode: 'mock' | 'real'): string {
  const s = (x: LatencyStats) => `n=${x.n} 中央値=${x.median_ms ?? '-'}ms p95=${x.p95_ms ?? '-'}ms 最大=${x.max_ms ?? '-'}ms`;
  const lines = [
    `two_ai_probe（計画=${r.plan_mode}、${mode === 'mock' ? '偽の LLM。遅れは仮の値で測定ではない' : '実 Gemini'}）`,
    `(c) 計画 [${r.plan.model}]: ${r.plan.ok ? '合格' : '不合格'} 呼び出し=${r.plan.attempts} 遅れ（合計）=${r.plan.latency_ms ?? '-'}ms 最初の文字=${r.plan.first_text_ms ?? '-'}ms 出どころ=${r.plan.source ?? '-'} 拍=${r.plan.beats}`,
    ...r.plan.reasons.slice(0, 8).map((x) => `    理由: ${x}`),
    ...r.stages.map((x) => `(c') 段 ${x.stage}: ${x.ok ? '合格' : '不合格（定型の拍）'} 遅れ=${x.latency_ms ?? '-'}ms 話し合いの始めから終わり=${x.done_at_ms ?? '-'}ms 要る見込み=${x.needed_at_ms}ms${x.reasons.length ? ` 理由: ${x.reasons.join('; ')}` : ''}`),
    `(d) ターン [${r.turns.model}]: ${s(r.turns.stats)} / 最初の文字 ${s(r.turns.first_text)} 失敗=${r.turns.failures.length} 帯の外=${r.turns.out_of_band} 文字数=[${r.turns.chars.join(',')}] 安全=${JSON.stringify(r.turns.safety_hits)}`,
    `(e) 訂正の判定 [${r.correction.model}]: ${s(r.correction.stats)} 正=${r.correction.correct} 誤=${r.correction.wrong} 失敗=${r.correction.failures}`,
    `STT の確定文: ${r.stt.measured ? `p95=${r.stt.p95_ms}ms` : '未計測（仮に p95=1500ms で計算）'}`,
    `提案: plan_wait.max_wait_ms=${r.proposal.plan_wait?.max_wait_ms ?? '-'} phases.intake.plan_start_sec=${r.proposal.plan_wait?.plan_start_sec ?? '-'} correction.hold_max_ms=${r.proposal.hold_max_ms ?? '-'}`,
  ];
  return `${lines.join('\n')}\n`;
}
