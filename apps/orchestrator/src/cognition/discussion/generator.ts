/**
 * DiscussionContent の実装（02 §3、06 §6）。01 の進行役は「いつ」、ここは「何を、誰が」を決める。
 *
 * 予定の列：nextTurn のたびに、(1) 取り消して頼み直すもの、(2) 点のブロックの残り、(3) 引き金が満ちた点、(4) 次の拍、の順で 1 つを選ぶ。
 * 点の引き金：in_stage と after_turn は拍の数、at_sec と at_frac は中身の時計の見込み（content_elapsed_ms ＋ 未再生の列の間と長さ）。
 * 本人の話し合い中の発言は生成の入力に入れない（体験の旗が有効なセッションの fed_interjections だけが例外。02 §3.7）。
 * 訂正（applyCorrection）の後は、点、カード、拍の fallback、生のターンの材料を訂正後の版にする（02 §3.5、06 §6.2）。
 * 保留の時間切れ（abandonResume）では、中断した F のターンの残りも F のブロックの残りも言い直さない（decisions_round5 m1）。
 *
 * 応答版（設定 experience.mode: 'responsive'）：① でも ② でも、話し合いと応答の段の本人の確定文を台帳に入れ（two_ai.capture）、
 * まだ話していない段の拍の作り直し、生のターンの資料、板の生成（board_gen.ts、two_ai.board_generated）に反映する。
 * ① の割り込みには、受け止めの後の resume の頭に内容に応じた短い応答を入れる（completeResume）。AI の文が本人の発言を参照したかは
 * two_ai.reflection に残す。点のブロックの文、段の拍の数、板の役割と出す時機は統制版と同じ。統制版では何も変えない。
 */
import {
  absent,
  present,
  type AiId,
  type ConversationHistoryReader,
  type DiscussionStage,
  type EventEmitter,
  type JsonValue,
  type LlmProvider,
  type LlmPurpose,
  type ScriptVariant,
  type TimeSource,
  type TwoAiAiState,
  type TwoAiCondition,
  type TwoAiPhase,
  type UserHistoryEntry,
  type UtteranceClass,
} from '@llm-vap/contracts';
import type { ResponsePromptBuilder } from '../../speech/response_prompt';
import type {
  AbandonResumeReason,
  ClosingRebuild,
  CorrectionResult,
  CorrectionSuggestion,
  DiscussionContent,
  DiscussionTurn,
  InterjectionPlan,
  PendingPointView,
  PlanResult,
  PlanStatus,
  RetractionScriptView,
} from '../../two_ai/content_port';
import { cardView } from './board';
import { BOARD_GEN_PROMPT_VERSION, boardItemsFromLedger, draftFromBoard, runBoardGeneration, type BoardGenInput, type GeneratedCard } from './board_gen';
import { buildReplyPrompt, referenceMethod, sharesSubstring } from './responsive';
import { retractionLines } from './closing';
import { CORRECTION_JSON_SCHEMA, CORRECTION_PROMPT_VERSION, buildCorrectionPrompt, parseCorrectionOutput } from './correction_assist';
import * as fixed from './fixed_utterances';
import { INTAKE_PROMPT_VERSION, IntakeTracker, createIntakePromptBuilder, isReadbackDenial, missingSlots } from './intake';
import { LEDGER_JSON_SCHEMA, LEDGER_PROMPT_VERSION, buildLedgerPrompt, emptyLedger, mergeLedgerOutput, type Utterance } from './ledger';
import type { LedgerItem } from './types';
import { callLlm } from './llm_call';
import { STAGE_JSON_SCHEMA, STAGE_PROMPT_VERSION, assembleStageBeats, buildStagePrompt } from './stage_plan';
import { PLAN_PROMPT_VERSION, PLAN_STAGED_PROMPT_VERSION, isStaged, assemblePlan, buildPlanPrompt, chooseFacts, outlinePlan, planJson, planJsonSchema, planNeeds, pointSpecs, type PlanDeps } from './plan';
import { blockMs, otherAi } from './points';
import { checkText, safeLedger } from './safety';
import { StanceTracker } from './stance';
import { charCount, cutAtSentence, fillTemplate, parseJsonLoose, seededGap, splitSentences } from './text';
import { TURN_PROMPT_VERSION, buildTurnPrompt } from './turn_prompt';
import type { Beat, BoardCard, DiscussionPlan, FrozenTurn, PointBlock, ProblemLedger } from './types';

export interface DiscussionContentDeps extends PlanDeps {
  /** ai_id を渡すと、その AI の範囲つき emitter の LLM（discussion_turn。06 §4.1）。 */
  llmFor: (purpose: LlmPurpose, ai_id?: AiId) => LlmProvider;
  emitter: EventEmitter;
  time: TimeSource;
  /** intake の応答の経路の履歴（ResponsePromptBuilder が読む）。話し合いの生成には使わない。 */
  history: ConversationHistoryReader;
  /** 台本がないときの側面と呼び名。台本があれば台本の値。 */
  profile?: { aspect: string; user_name: string; user_name_reading: string };
}

type Item =
  | { kind: 'beat'; beat: Beat; stage_last: boolean }
  | { kind: 'align'; beat: Beat; point_id: string }
  | { kind: 'point'; point: PointBlock; turn_idx: number; block_last: boolean; stage: DiscussionStage | null; stage_last: boolean };

interface Issued {
  turn: DiscussionTurn;
  item: Item;
  index: number;
  played: boolean;
  played_ms: number;
  cancelled: boolean;
  /** resume のとき：元のターンと、言い直しを始めた文の位置（元の文字数）と戻りの句の文字数。 */
  resume_of: { base: Issued; offset_chars: number; bridge_chars: number; start_sentence: number } | null;
}

interface PendingGen {
  item: Item;
  index: number;
  fallback_used: boolean;
}

/** 応答版：プロンプトに入れた本人の発言の 1 つ（台帳の項目か、まだ台帳にない割り込みの発話）。 */
interface OfferedLink {
  item_id: string | null;
  segment_ids: number[];
  /** 参照の判定に使う文（項目の文、根拠の逐語、発話）。 */
  texts: string[];
}

interface StageFill {
  state: 'pending' | 'requested' | 'filled' | 'fallback';
  controller: AbortController | null;
  /** 応答版：本人の発言で台帳が変わったので作り直す（前に埋めた拍は残っている）。 */
  refill?: boolean;
}

/** 生のターンの帯に対する作り直しの下限（帯の下限の半分に満たなければ 1 回作り直す。02 §3.3-3）。 */
const SHORT_RATIO = 0.5;
/** 位置合わせの react の凍結文（点の話者と前の話者がそろうときだけ入る。02 §3.3）。 */
const ALIGN_FALLBACK = 'なるほど、そうですね。';

export class DiscussionGenerator implements DiscussionContent {
  private readonly deps: DiscussionContentDeps;
  private readonly profile: { aspect: string; user_name: string; user_name_reading: string };
  private condition: TwoAiCondition = 'respond_at_end';
  private feedsRequested = false;
  private correctionMode: 'researcher' | 'auto' = 'researcher';
  private disposed = false;
  private readonly controllers = new Set<AbortController>();

  // intake と台帳
  private ledger: ProblemLedger;
  private readonly utterances: Utterance[] = [];
  private readonly tracker: IntakeTracker;
  private intakeStartMs: number;
  private ledgerRunning: Promise<void> | null = null;
  private ledgerDirty = false;
  private readbackReplyPending = false;

  // 計画
  private state: PlanStatus['state'] = 'none';
  private earlyPromise: Promise<DiscussionPlan | null> | null = null;
  private earlyPlan: DiscussionPlan | null = null;
  private plan: DiscussionPlan | null = null;
  private stance: StanceTracker;
  /** 段ごとの計画（02 §2.5.1）：後から埋める段の状態。 */
  private readonly stageFill = new Map<DiscussionStage, StageFill>();
  private stageChain: Promise<void> = Promise.resolve();
  private planTrigger: 'early' | 'final' | 'regenerate' | 'fallback' = 'final';

  // 話し合い
  private started = false;
  private beatIdx = 0;
  private stageDone: [number, number, number, number] = [0, 0, 0, 0];
  private beatsDone = 0;
  private pointState = new Map<string, PendingPointView['state']>();
  private pointStartMs = new Map<string, number>();
  private aligned = new Set<string>();
  private activeBlock: { point: PointBlock; next: number; stage: DiscussionStage | null } | null = null;
  private forced = false;
  private reissue: { item: Item; index: number }[] = [];
  private readonly issued = new Map<string, Issued>();
  private readonly order: Issued[] = [];
  private readonly pending = new Map<string, PendingGen>();
  private nextIndex = 0;
  private lastSpeaker: AiId | null = null;
  private lastWasBlockEnd = false;
  private variant: ScriptVariant = 'original';
  private factState: DiscussionTurn['fact_state'] = 'normal';
  private cardsShown = new Map<string, string>();
  private spokenOriginalInference = false;
  private resumeCount = 0;
  private prefetch: { key: string; beat_id: string; promise: Promise<GenResult> } | null = null;
  /** 最後の abandonResume（decisions_round5 M2 の credited_ms の元）。 */
  private lastAbandon: { point_id: string; reason: AbandonResumeReason; dropped_turn_keys: string[]; credited_ms: number } | null = null;

  // 訂正の補助と体験の旗
  private readonly suggestions: CorrectionSuggestion[] = [];
  private suggestionSeq = 0;
  private readonly fed: { interjection_id: string; text: string; asr_segment_ids: number[] }[] = [];
  private feedTarget: { kind: 'next_live_turn' | 'after_point_block'; ids: string[] } | null = null;
  private requestSeq = 0;

  // 応答版（experience.mode: 'responsive'）
  /** 話し合いと応答の段の本人の確定文（segment_id → 段階、割り込み、取得の状態）。 */
  private readonly userSegs = new Map<number, { phase: 'discussion' | 'response'; interjection_id: string | null; chars: number; text: string; reported: boolean; captured: boolean }>();
  /** 割り込みごとの文（onInterjectionClosed の文と、その後の確定文）。 */
  private readonly interjections = new Map<string, { text: string; accepted: boolean; segment_ids: number[]; finals: Map<number, string> }>();
  private liveBoard: GeneratedCard[] | null = null;
  private boardSeq = 0;
  private boardRunning: Promise<void> | null = null;
  private boardDirty = false;
  private boardRegens = 0;
  private boardLedgerVersion = -1;
  private readonly stageRefills = new Map<DiscussionStage, number>();
  /** 作り直し（closingRebuild）の後は、板の生成の結果を使わない。 */
  private boardFrozen = false;
  /** 板の生成に渡す話し合い（話した文と本人の確定文。古い順）。 */
  private readonly transcriptLog: { who: AiId | 'user'; text: string; segment_id: number | null }[] = [];

  constructor(deps: DiscussionContentDeps) {
    this.deps = deps;
    const profile = deps.script
      ? { aspect: deps.script.aspect, user_name: deps.script.user_name, user_name_reading: deps.script.user_name_reading }
      : deps.profile;
    if (profile === undefined) throw new Error('DiscussionGenerator needs a script or a profile (aspect, user_name)');
    this.profile = profile;
    this.ledger = emptyLedger(profile);
    const priorCore = deps.script?.prior.core ?? null;
    if (priorCore !== null) {
      this.ledger = { ...this.ledger, core: { id: 'prior_core', text: priorCore, evidence: [], confirmed: false }, source: 'prepared' };
    }
    this.tracker = new IntakeTracker(deps.config, deps.script?.prior.facts.length ?? 0);
    this.intakeStartMs = deps.time.monotonicMs();
    this.stance = new StanceTracker(deps.personas.personas);
  }

  // ---- 開始 -------------------------------------------------------------------

  init(input: { condition: TwoAiCondition; feeds_generation: boolean; self_run: boolean; correction_mode: 'researcher' | 'auto'; retraction_timing: 'end_of_session' | 'after_measures' }): void {
    this.condition = input.condition;
    this.feedsRequested = input.feeds_generation;
    this.correctionMode = input.correction_mode;
    this.intakeStartMs = this.deps.time.monotonicMs();
  }

  /** 旗が効くのは ① だけ（02 §3.7）。応答版は旗に関係なく ① の割り込みを入れる。 */
  private get feedsEffective(): boolean {
    return (this.feedsRequested || this.responsive) && this.condition === 'respond_on_spot';
  }

  /** 応答版か（設定 experience.mode）。 */
  private get responsive(): boolean {
    return this.deps.config.experience.mode === 'responsive';
  }

  private get slots(): Record<string, string> {
    return { user_name: this.profile.user_name, aspect: this.profile.aspect };
  }

  // ---- intake -----------------------------------------------------------------

  promptBuilder(_phase: 'intake', _ai_id: AiId): ResponsePromptBuilder {
    return createIntakePromptBuilder({
      history: this.deps.history,
      config: this.deps.config,
      tracker: this.tracker,
      ledger: () => this.ledger,
      elapsed_ms: () => this.deps.time.monotonicMs() - this.intakeStartMs,
    });
  }

  responder(_phase: 'intake'): AiId {
    return this.deps.config.speakers.intake;
  }

  intakeReadbackDue(view: { elapsed_ms: number }): boolean {
    return !this.tracker.readback && this.ledger.core !== null && view.elapsed_ms >= this.deps.config.phases.intake.min_sec * 1000;
  }

  intakeLine(line: 'first_question' | 'core_readback'): { ai_id: AiId; line_id: string; text: string } {
    if (line === 'first_question') {
      this.intakeStartMs = this.deps.time.monotonicMs();
      return fixed.intakeFirstQuestion(this.deps.config, this.slots);
    }
    this.tracker.markReadback();
    this.readbackReplyPending = true;
    return fixed.coreReadback(this.deps.config, this.ledger.core?.text ?? null, this.slots);
  }

  /** 試験と probe 用：今の台帳。 */
  currentLedger(): ProblemLedger {
    return this.ledger;
  }

  /** 試験用：台帳の更新が終わるまで待つ。 */
  async ledgerIdle(): Promise<void> {
    while (this.ledgerRunning !== null) await this.ledgerRunning;
  }

  private scheduleLedger(): void {
    if (this.ledgerRunning !== null) {
      this.ledgerDirty = true;
      return;
    }
    this.ledgerRunning = this.runLedger().finally(() => {
      this.ledgerRunning = null;
      if (this.ledgerDirty && !this.disposed) {
        this.ledgerDirty = false;
        this.scheduleLedger();
      }
    });
  }

  private async runLedger(): Promise<void> {
    const utterances = [...this.utterances];
    const base = this.ledger;
    const prompt = buildLedgerPrompt(base, utterances);
    const controller = this.controller();
    const result = await callLlm(this.deps.llmFor('ledger'), {
      request_id: this.requestId('ledger'),
      purpose: 'ledger',
      system: prompt.system,
      messages: prompt.messages,
      response_json_schema: LEDGER_JSON_SCHEMA,
      timeout_ms: this.deps.config.generation.timeout_ms.ledger,
      signal: controller.signal,
    });
    this.controllers.delete(controller);
    if (this.disposed) return;
    const merged = result.ok ? mergeLedgerOutput(base, parseJsonLoose(result.text), utterances) : null;
    if (merged === null) {
      this.emitContent({ event: 'two_ai.ledger', stage: 'update_failed', ledger_version: this.ledger.ledger_version, item_ids: [], reason: result.ok ? 'unreadable output' : result.reason });
      return;
    }
    // 読み上げの後に core が変わらなければ、確定の印を引き継ぐ
    let next = merged.ledger;
    if (this.ledger.core?.confirmed && next.core && next.core.text === this.ledger.core.text) next = { ...next, core: { ...next.core, confirmed: true } };
    this.ledger = next;
    this.tracker.onLedger(next);
    if (merged.rejected.length > 0) {
      this.emitContent({ event: 'two_ai.ledger', stage: 'item_rejected', ledger_version: next.ledger_version, item_ids: merged.rejected, reason: 'evidence span is not verbatim' });
    }
    this.emitContent({ event: 'two_ai.ledger', stage: 'updated', ledger_version: next.ledger_version, item_ids: merged.updated, reason: 'ok' });
    if (this.responsive && utterances.some((u) => u.phase !== undefined)) this.afterResponsiveLedger(utterances, next);
  }

  // ---- 計画 -------------------------------------------------------------------

  planStatus(): PlanStatus {
    const p = this.plan ?? this.earlyPlan;
    return { state: this.state, can_start_early: this.ledger.core !== null, plan_id: p?.plan_id ?? null, source: p?.source ?? null };
  }

  async preparePlan(signal: AbortSignal): Promise<PlanResult> {
    if (this.plan !== null) return this.result(this.plan);
    this.state = 'preparing_early';
    this.earlyPromise = this.generatePlan('early', signal);
    const plan = await this.earlyPromise;
    if (this.plan !== null) return this.result(this.plan);
    if (plan === null) {
      this.state = 'none';
      return { ok: false, reason: 'early plan failed' };
    }
    this.earlyPlan = plan;
    this.state = 'early_ready';
    return this.result(plan);
  }

  async finalizePlan(signal: AbortSignal): Promise<PlanResult> {
    if (this.plan !== null) return this.result(this.plan);
    this.state = 'finalizing';
    if (this.earlyPromise !== null) await this.earlyPromise;
    if (this.plan !== null) return this.result(this.plan);
    const early = this.earlyPlan;
    if (early !== null && this.sameBasis(early)) {
      this.emitPlan('reused', 'final', early, null, 'core and slip fact unchanged');
      this.activate(early);
      return this.result(early);
    }
    const plan = await this.generatePlan('final', signal);
    if (this.plan !== null) return this.result(this.plan);
    if (plan === null) {
      this.state = 'failed';
      return { ok: false, reason: 'plan generation failed twice' };
    }
    this.activate(plan);
    return this.result(plan);
  }

  fallbackPlan(reason: string): PlanResult {
    if (this.plan !== null) return this.result(this.plan);
    if (this.earlyPlan !== null) {
      this.emitPlan('reused', 'fallback', this.earlyPlan, null, `early plan used: ${reason}`);
      this.activate(this.earlyPlan);
      return this.result(this.earlyPlan);
    }
    const safe = safeLedger(this.ledger, this.deps.safety).ledger;
    const hasPrepared = pointSpecs(this.deps).some((p) => p.source === 'prepared');
    let r = hasPrepared ? outlinePlan(this.deps, safe, true) : null;
    if (r === null || !r.ok) r = outlinePlan(this.deps, safe, false);
    if (!r.ok) {
      this.state = 'failed';
      this.emitPlan('failed', 'fallback', null, null, r.reasons.join('; ').slice(0, 500));
      return { ok: false, reason: r.reasons.join('; ') };
    }
    this.emitPlan('frozen', 'fallback', r.plan, null, `fallback outline: ${reason}`);
    this.activate(r.plan);
    return this.result(r.plan);
  }

  private sameBasis(plan: DiscussionPlan): boolean {
    const safe = safeLedger(this.ledger, this.deps.safety).ledger;
    const facts = chooseFacts(this.deps.script, safe, pointSpecs(this.deps));
    return plan.basis.core === (safe.core?.text ?? null) && plan.basis.slip_fact_id === (facts.slip?.fact_id ?? null);
  }

  private models(): Record<string, string> {
    return { ...this.deps.config.generation.models };
  }

  /** (c) を 1 回、不合格なら理由つきで 1 回だけ作り直す。 */
  private async generatePlan(trigger: 'early' | 'final', signal: AbortSignal): Promise<DiscussionPlan | null> {
    const safe = safeLedger(this.ledger, this.deps.safety).ledger;
    const facts = chooseFacts(this.deps.script, safe, pointSpecs(this.deps));
    const needs = planNeeds(this.deps, facts);
    const prompt = buildPlanPrompt(this.deps, safe, facts, needs);
    const utterances = [...this.utterances];
    let lastReason = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      const t = attempt === 0 ? trigger : 'regenerate';
      this.emitPlan('requested', t, null, null, attempt === 0 ? 'start' : `retry: ${lastReason}`.slice(0, 500));
      const messages = attempt === 0 ? prompt.messages : [...prompt.messages, { role: 'user' as const, text: `前の案は次の理由で不合格でした。直して書き直してください：${lastReason}`.slice(0, 1500) }];
      const result = await callLlm(this.deps.llmFor('discussion_plan'), {
        request_id: this.requestId('plan'),
        purpose: 'discussion_plan',
        system: prompt.system,
        messages,
        response_json_schema: planJsonSchema(needs),
        timeout_ms: this.deps.config.generation.timeout_ms.discussion_plan,
        signal,
      });
      if (this.disposed || signal.aborted) return null;
      if (!result.ok) {
        lastReason = result.reason;
        this.emitPlan('failed', t, null, result.latency_ms, lastReason);
        continue;
      }
      const raw = parseJsonLoose(result.text);
      const assembled = raw === null ? { ok: false as const, reasons: ['unreadable JSON'] } : assemblePlan(this.deps, safe, utterances, raw, {
        models: { ...this.models(), discussion_plan: result.model },
        prompt_versions: { plan: isStaged(this.deps) ? PLAN_STAGED_PROMPT_VERSION : PLAN_PROMPT_VERSION, ...(isStaged(this.deps) ? { plan_stage: STAGE_PROMPT_VERSION } : {}), turn: TURN_PROMPT_VERSION, ledger: LEDGER_PROMPT_VERSION, intake: INTAKE_PROMPT_VERSION, correction: CORRECTION_PROMPT_VERSION },
      });
      if (!assembled.ok) {
        lastReason = assembled.reasons.slice(0, 8).join('; ');
        for (const r of assembled.reasons.filter((x) => x.includes('safety'))) {
          this.emitContent({ event: 'two_ai.safety_blocked', rule: r.replace(/^.*safety (\S+).*$/u, '$1') || 'plan', stage: 'plan', text: r.slice(0, 300), action: 'regenerate' });
        }
        this.emitPlan('failed', t, null, result.latency_ms, lastReason);
        continue;
      }
      this.planTrigger = t;
      this.emitPlan('frozen', t, assembled.plan, result.latency_ms, 'ok');
      return assembled.plan;
    }
    return null;
  }

  private activate(plan: DiscussionPlan): void {
    this.plan = plan;
    this.state = 'ready';
    this.stageFill.clear();
    for (const s of plan.staged_stages) this.stageFill.set(s, { state: 'pending', controller: null });
    for (const p of plan.points) this.pointState.set(p.point_id, 'unscheduled');
    for (const u of plan.unavailable_points) this.pointState.set(u.point_id, 'unavailable');
    this.stance.setAvailability({
      framing_C: plan.points.some((p) => p.kind === 'framing_C'),
      fact_slip: plan.points.some((p) => p.kind === 'fact_slip'),
    });
  }

  private result(plan: DiscussionPlan): PlanResult {
    const has = (k: PointBlock['kind']) => plan.points.some((p) => p.kind === k);
    return {
      ok: true,
      plan_id: plan.plan_id,
      plan_hash: plan.plan_hash,
      source: plan.source,
      fact_slip: has('fact_slip') ? 'available' : 'unavailable',
      fact_slip_source: plan.fact_slip_source,
      control_inference: has('control_inference') ? 'available' : 'unavailable',
      points_ok: plan.schedule_check.ok && plan.unavailable_points.length === 0,
    };
  }

  /** 試験と probe 用：凍結した計画。 */
  frozenPlan(): DiscussionPlan | null {
    return this.plan;
  }

  // ---- 話し合い -----------------------------------------------------------------

  startDiscussion(): void {
    if (this.plan === null) throw new Error('startDiscussion before a plan is frozen');
    this.started = true;
    if (this.stageFill.size > 0) this.stageChain = this.runStageChain().catch(() => undefined);
  }

  /** 試験と probe 用：段の拍の呼び出しがすべて終わるまで待つ。 */
  async stagesIdle(): Promise<void> {
    await this.stageChain;
  }

  // ---- 段ごとの計画（02 §2.5.1） --------------------------------------------------------

  /** 段 2→3→4 の順に、前の段が決まってから次の段の拍を作る（その時点の訂正の状態を渡す）。 */
  private async runStageChain(): Promise<void> {
    for (const stage of [...this.stageFill.keys()].sort()) {
      if (this.disposed) return;
      const fill = this.stageFill.get(stage)!;
      if (fill.state !== 'pending') continue;
      await this.fillStage(stage as 2 | 3 | 4, fill);
    }
  }

  private async fillStage(stage: 2 | 3 | 4, fill: StageFill): Promise<void> {
    const plan = this.plan!;
    const safe = safeLedger(this.ledger, this.deps.safety).ledger;
    const userItems = this.responsive ? this.userItems() : [];
    const correction = userItems.length > 0 ? { fact_state: this.factState, user_items: userItems } : { fact_state: this.factState };
    const ledgerVersion = this.ledger.ledger_version;
    const prompt = buildStagePrompt(this.deps, safe, plan, stage, correction);
    const controller = this.controller();
    fill.state = 'requested';
    fill.controller = controller;
    const label = fill.refill ? 'stage_beats_refill_requested' : 'stage_beats_requested';
    this.emitStage('requested', plan, null, `${label}: stage ${stage} (fact_state ${correction.fact_state}${userItems.length > 0 ? `, user_items ${userItems.map((x) => x.id).join(',')}` : ''})`.slice(0, 500));
    const r = await callLlm(this.deps.llmFor('discussion_plan'), {
      request_id: this.requestId(`plan_stage${stage}`),
      purpose: 'discussion_plan',
      system: prompt.system,
      messages: prompt.messages,
      response_json_schema: STAGE_JSON_SCHEMA,
      timeout_ms: this.deps.config.generation.timeout_ms.discussion_plan,
      signal: controller.signal,
    });
    this.controllers.delete(controller);
    fill.controller = null;
    if (fill.state !== 'requested' || this.disposed) return; // 間に合わず定型にした（記録は済み）
    if (!r.ok) return this.stageFallback(stage, `call failed: ${r.reason}`, r.latency_ms);
    const assembled = assembleStageBeats(this.deps, safe, plan, stage, parseJsonLoose(r.text), { fact_state: this.factState });
    if (!assembled.ok) {
      for (const x of assembled.reasons.filter((y) => y.includes('safety'))) {
        this.emitContent({ event: 'two_ai.safety_blocked', rule: x.replace(/^.*safety (\S+).*$/u, '$1') || 'plan', stage: 'plan', text: x.slice(0, 300), action: 'fallback' });
      }
      return this.stageFallback(stage, assembled.reasons.slice(0, 6).join('; '), r.latency_ms);
    }
    // 拍の id、段、話者、kind、数は変わらないので、その場で差し替える（まだ話していない段だけ）
    for (const b of assembled.beats) {
      const i = plan.beats.findIndex((x) => x.beat_id === b.beat_id);
      if (i >= this.beatIdx) plan.beats[i] = b;
    }
    fill.state = 'filled';
    this.emitStage('frozen', plan, r.latency_ms, `${fill.refill ? 'stage_beats_refilled' : 'stage_beats_frozen'}: stage ${stage}`);
    // 応答版：呼んでいる間に本人の発言で台帳が変わったら、もう一度（上限まで）
    if (this.responsive && this.ledger.ledger_version !== ledgerVersion) this.refillStages();
  }

  private stageFallback(stage: DiscussionStage, reason: string, latency: number | null): void {
    const fill = this.stageFill.get(stage);
    if (fill === undefined || fill.state === 'filled' || fill.state === 'fallback') return;
    fill.state = 'fallback';
    fill.controller?.abort(new Error('stage needed'));
    fill.controller = null;
    const kept = fill.refill ? `stage_beats_refill_skipped: stage ${stage}: previous beats kept` : `stage_beats_fallback: stage ${stage}: code-template beats kept`;
    this.emitStage('failed', this.plan!, latency, `${kept}: ${reason}`.slice(0, 500));
  }

  /** 段の拍が要るときに、まだ埋まっていなければ定型の拍に決める。 */
  private stageReady(stage: DiscussionStage): boolean {
    const fill = this.stageFill.get(stage);
    return fill === undefined || fill.state === 'filled' || fill.state === 'fallback';
  }

  private emitStage(stage: 'requested' | 'frozen' | 'failed', plan: DiscussionPlan, latency: number | null, reason: string): void {
    this.emitPlan(stage, this.planTrigger, plan, latency, reason);
  }

  stageHeadings(): [string, string, string, string] {
    return this.plan?.stage_headings ?? this.deps.script?.stages ?? this.deps.config.fixed.stage_headings;
  }

  private requirePlan(): DiscussionPlan {
    if (this.plan === null || !this.started) throw new Error('discussion has not started');
    return this.plan;
  }

  /** 列の末尾の終わりの見込み（中身の時計、ms）。 */
  private projectedMs(content_elapsed_ms: number): number {
    let sum = content_elapsed_ms;
    for (const r of this.order) {
      if (!r.played && !r.cancelled && r.resume_of === null && this.isContent(r.turn)) sum += r.turn.gap_hint_ms + r.turn.est_duration_ms;
    }
    return sum;
  }

  private isContent(turn: DiscussionTurn): boolean {
    return turn.turn_kind === 'discussion' || turn.turn_kind === 'point' || turn.turn_kind === 'point_elaboration';
  }

  private estMs(text: string): number {
    return Math.round((charCount(text) / this.deps.config.phases.discussion.chars_per_sec_estimate) * 1000);
  }

  /** 次の拍（close_at を過ぎたら段 4 の optional を飛ばす。forced の後は close だけを残す）。 */
  private nextBeat(projected_ms: number, turn_id: string): Beat | null {
    const plan = this.requirePlan();
    const closeAt = this.deps.config.phases.discussion.close_at_sec * 1000;
    const allPointsClosed = [...this.pointState.values()].every((s) => s === 'done' || s === 'unavailable');
    while (this.beatIdx < plan.beats.length) {
      if (!this.stageReady(plan.beats[this.beatIdx]!.stage)) this.stageFallback(plan.beats[this.beatIdx]!.stage, 'not ready when the stage was needed', null);
      const b = plan.beats[this.beatIdx]!;
      const isLast = this.beatIdx === plan.beats.length - 1;
      const skip = (b.optional && projected_ms >= closeAt) || (this.forced && allPointsClosed && !isLast);
      if (!skip) return b;
      this.emitContent(
        { event: 'two_ai.generation', turn_id, beat_id: b.beat_id, stage: 'compressed', prompt_version: TURN_PROMPT_VERSION, model: this.deps.config.generation.models.discussion_turn, latency_ms: absent('not generated'), chars: 0, fed_interjection_ids: [], feed_turn: false, c_ban_lifted: false, reason: this.forced ? 'forced points: skip to close' : 'close_at_sec passed: optional beat skipped' },
        b.speaker,
      );
      this.beatIdx += 1;
    }
    return null;
  }

  private isStageEndPoint(point: PointBlock): boolean {
    const plan = this.requirePlan();
    if (!('in_stage' in point.trigger)) return false;
    const s = point.trigger.in_stage;
    const count = plan.beats.filter((b) => b.stage === s).length;
    return point.trigger.after_stage_turn >= count;
  }

  private triggeredPoint(nb: Beat | null, projected_ms: number): PointBlock | null {
    const plan = this.requirePlan();
    const cs = nb?.stage ?? 5;
    for (const p of plan.points) {
      if (this.pointState.get(p.point_id) !== 'unscheduled') continue;
      if (this.forced) return p;
      const t = p.trigger;
      if ('in_stage' in t) {
        if ((t.in_stage === cs && (this.stageDone[t.in_stage - 1] ?? 0) >= t.after_stage_turn) || t.in_stage < cs) return p;
      } else if ('after_turn' in t) {
        if (this.beatsDone >= t.after_turn || nb === null) return p;
      } else if ('at_sec' in t) {
        if (projected_ms >= t.at_sec * 1000 || nb === null) return p;
      } else if (projected_ms >= t.at_frac * this.deps.config.phases.discussion.target_sec * 1000 || nb === null) return p;
    }
    return null;
  }

  /** 列から次の 1 つを取り出す（状態を進める）。 */
  private take(content_elapsed_ms: number, turn_id: string): { item: Item; index: number } {
    const plan = this.requirePlan();
    const again = this.reissue.shift();
    if (again !== undefined) return again;
    if (this.activeBlock !== null) {
      const { point, next, stage } = this.activeBlock;
      const block_last = next === point.turns.length - 1;
      if (block_last) this.activeBlock = null;
      else this.activeBlock = { point, next: next + 1, stage };
      if (block_last) this.pointState.set(point.point_id, 'done');
      const stage_last = block_last && this.isStageEndPoint(point) && !this.morePointsAtStageEnd(point);
      return { item: { kind: 'point', point, turn_idx: next, block_last, stage, stage_last }, index: this.nextIndex++ };
    }
    const projected = this.projectedMs(content_elapsed_ms);
    const nb = this.nextBeat(projected, turn_id);
    const point = this.triggeredPoint(nb, projected);
    if (point !== null) {
      if (!this.forced && this.lastSpeaker === point.speaker && !this.aligned.has(point.point_id)) {
        this.aligned.add(point.point_id);
        const stage = ('in_stage' in point.trigger ? point.trigger.in_stage : (nb?.stage ?? 4)) as DiscussionStage;
        const beat: Beat = {
          beat_id: `align_${point.point_id}`,
          stage,
          speaker: otherAi(point.speaker),
          kind: 'react',
          intent: '直前の発話を短く受ける。新しい見方は足さない。',
          ledger_refs: [],
          target_chars: [10, 30],
          optional: false,
          fallback_text: ALIGN_FALLBACK,
          fallback_text_corrected: ALIGN_FALLBACK,
          live: plan.source !== 'fallback_outline',
        };
        return { item: { kind: 'align', beat, point_id: point.point_id }, index: this.nextIndex++ };
      }
      const stage = ('in_stage' in point.trigger ? point.trigger.in_stage : (nb?.stage ?? this.lastStage())) as DiscussionStage | null;
      this.pointState.set(point.point_id, 'in_block');
      this.pointStartMs.set(point.point_id, projected);
      const single = point.turns.length === 1;
      if (single) this.pointState.set(point.point_id, 'done');
      else this.activeBlock = { point, next: 1, stage };
      const stage_last = single && this.isStageEndPoint(point) && !this.morePointsAtStageEnd(point);
      return { item: { kind: 'point', point, turn_idx: 0, block_last: single, stage, stage_last }, index: this.nextIndex++ };
    }
    if (nb === null) {
      // 先読みが最後の拍の後に来た（01 が名前で見分け、代わりの文も skipped も出さずに取り下げる。U2）。
      const e = new Error('discussion has no more turns');
      e.name = 'ContentExhausted';
      throw e;
    }
    this.beatIdx += 1;
    this.stageDone[nb.stage - 1] = (this.stageDone[nb.stage - 1] ?? 0) + 1;
    this.beatsDone += 1;
    const stageBeats = plan.beats.filter((b) => b.stage === nb.stage);
    const isStageLastBeat = stageBeats.at(-1)?.beat_id === nb.beat_id || (nb.stage === 4 && this.beatIdx === plan.beats.length);
    const pointAfter = plan.points.some(
      (p) => this.pointState.get(p.point_id) === 'unscheduled' && 'in_stage' in p.trigger && p.trigger.in_stage === nb.stage && this.isStageEndPoint(p),
    );
    return { item: { kind: 'beat', beat: nb, stage_last: isStageLastBeat && !pointAfter }, index: this.nextIndex++ };
  }

  private morePointsAtStageEnd(point: PointBlock): boolean {
    const plan = this.requirePlan();
    if (!('in_stage' in point.trigger)) return false;
    const s = point.trigger.in_stage;
    return plan.points.some((p) => p !== point && this.pointState.get(p.point_id) === 'unscheduled' && 'in_stage' in p.trigger && p.trigger.in_stage === s && this.isStageEndPoint(p));
  }

  private lastStage(): DiscussionStage | null {
    return this.order.at(-1)?.turn.discussion_stage ?? null;
  }

  async nextTurn(request: { turn_id: string; content_elapsed_ms: number; discussion_elapsed_ms: number }, signal: AbortSignal): Promise<DiscussionTurn> {
    const plan = this.requirePlan();
    const { item, index } = this.take(request.content_elapsed_ms, request.turn_id);
    this.pending.set(request.turn_id, { item, index, fallback_used: false });
    try {
      let turn: DiscussionTurn;
      if (item.kind === 'point') turn = this.pointTurn(request.turn_id, index, item);
      else {
        const gen = item.beat.live ? await this.generateBeatText(item, request.turn_id, signal) : null;
        if (!item.beat.live) {
          // 予備の筋書きの拍（凍結文）も two_ai.generation に拍を残す（AC8 の受けのターンの識別。統合 1）。
          const text = this.factState === 'corrected' ? item.beat.fallback_text_corrected : item.beat.fallback_text;
          this.emitContent(
            { event: 'two_ai.generation', turn_id: request.turn_id, beat_id: item.beat.beat_id, stage: 'fallback', prompt_version: TURN_PROMPT_VERSION, model: this.deps.config.generation.models.discussion_turn, latency_ms: absent('not generated'), chars: charCount(text), fed_interjection_ids: [], feed_turn: false, c_ban_lifted: this.feedsEffective, reason: 'fallback_outline: frozen beat text' },
            item.beat.speaker,
          );
        }
        const pending = this.pending.get(request.turn_id);
        if (pending?.fallback_used) {
          // fallbackTurn が先に返した：その文を使い続ける（gap_overrun は fallbackTurn が記録した）
          return this.issued.get(request.turn_id)!.turn;
        }
        turn = this.beatTurn(request.turn_id, index, item, gen);
      }
      this.record(turn, item, index);
      this.kickPrefetch(plan);
      return turn;
    } catch (error) {
      if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
        // 取り消された：同じ位置を次の nextTurn で返す
        if (!this.issued.has(request.turn_id)) this.reissue.unshift({ item, index });
        const e = new Error('aborted');
        e.name = 'AbortError';
        throw e;
      }
      throw error;
    } finally {
      this.pending.delete(request.turn_id);
    }
  }

  fallbackTurn(turn_id: string): DiscussionTurn {
    const existing = this.issued.get(turn_id);
    if (existing) return existing.turn;
    const pending = this.pending.get(turn_id);
    if (pending === undefined) throw new Error(`fallbackTurn: unknown turn ${turn_id}`);
    pending.fallback_used = true;
    const turn = pending.item.kind === 'point' ? this.pointTurn(turn_id, pending.index, pending.item) : this.beatTurn(turn_id, pending.index, pending.item, null);
    if (pending.item.kind !== 'point') {
      this.emitContent(
        { event: 'two_ai.generation', turn_id, beat_id: pending.item.beat.beat_id, stage: 'gap_overrun', prompt_version: TURN_PROMPT_VERSION, model: this.deps.config.generation.models.discussion_turn, latency_ms: absent('not ready in time'), chars: turn.text.length, fed_interjection_ids: [], feed_turn: this.feedsEffective && this.feedTarget !== null, c_ban_lifted: this.feedsEffective, reason: 'max_wait_for_ready_ms passed: frozen fallback' },
        turn.speaker,
      );
    }
    this.record(turn, pending.item, pending.index);
    return turn;
  }

  private gapFor(item: Item, index: number): number {
    const plan = this.requirePlan();
    const g = this.deps.config.gaps_ms;
    const dist = this.lastWasBlockEnd ? g.after_point : item.kind !== 'point' && item.beat.kind === 'react' ? g.react : g.default;
    return seededGap(`${plan.plan_id}:${index}`, dist);
  }

  private cardFor(stage: DiscussionStage | null, stage_last: boolean, turn_id: string): DiscussionTurn['board_card'] {
    if (!stage_last || stage === null) return null;
    const card = this.boardCards().find((c: BoardCard) => c.stage === stage);
    if (card === undefined) return null;
    const shownBy = this.cardsShown.get(card.card_id);
    if (shownBy !== undefined && shownBy !== turn_id) {
      const rec = this.issued.get(shownBy);
      if (rec && !rec.cancelled) return null;
    }
    this.cardsShown.set(card.card_id, turn_id);
    return cardView(card, this.variant);
  }

  private pointTurn(turn_id: string, index: number, item: Extract<Item, { kind: 'point' }>): DiscussionTurn {
    const { point, turn_idx } = item;
    const variant = this.variant;
    const ft = (variant === 'corrected' ? point.corrected_turns : point.turns)[turn_idx]!;
    if (point.kind === 'fact_slip' && turn_idx === 0 && variant === 'original' && this.factState === 'normal') this.factState = 'slipped';
    return {
      turn_id,
      index,
      speaker: ft.speaker,
      turn_kind: turn_idx === 0 ? 'point' : 'point_elaboration',
      text: ft.text,
      sentences: ft.sentences,
      text_origin: 'frozen',
      origin: { kind: 'point', point_id: point.point_id, turn_key: ft.turn_key },
      point_id: point.point_id,
      point_variant: variant,
      discussion_stage: item.stage,
      board_card: this.cardFor(item.stage, item.stage_last, turn_id),
      gap_hint_ms: this.gapFor(item, index),
      est_duration_ms: this.estMs(ft.text),
      fact_state: this.factState,
      repeat: null,
      fed_interjection_ids: [],
      feed_turn: false,
    };
  }

  private beatTurn(turn_id: string, index: number, item: Extract<Item, { kind: 'beat' | 'align' }>, gen: GenResult | null): DiscussionTurn {
    const beat = item.beat;
    const fallback = this.factState === 'corrected' ? beat.fallback_text_corrected : beat.fallback_text;
    const text = gen?.text ?? fallback;
    const stage_last = item.kind === 'beat' ? item.stage_last : false;
    return {
      turn_id,
      index,
      speaker: beat.speaker,
      turn_kind: 'discussion',
      text,
      sentences: splitSentences(text),
      text_origin: gen !== null ? 'llm' : 'fallback',
      origin: { kind: 'beat', beat_id: beat.beat_id, generated: gen !== null ? 'llm' : 'fallback' },
      point_id: null,
      point_variant: null,
      discussion_stage: beat.stage,
      board_card: this.cardFor(beat.stage, stage_last, turn_id),
      gap_hint_ms: this.gapFor(item, index),
      est_duration_ms: this.estMs(text),
      fact_state: this.factState,
      repeat: null,
      fed_interjection_ids: gen?.fed_ids ?? [],
      feed_turn: gen?.feed_turn ?? false,
    };
  }

  private record(turn: DiscussionTurn, item: Item, index: number): void {
    const rec: Issued = { turn, item, index, played: false, played_ms: 0, cancelled: false, resume_of: null };
    this.issued.set(turn.turn_id, rec);
    this.order.push(rec);
    this.lastSpeaker = turn.speaker;
    this.lastWasBlockEnd = item.kind === 'point' && item.block_last;
  }

  // ---- 生のターンの生成（d） -------------------------------------------------------

  private material(beat: Beat): string[] {
    const plan = this.requirePlan();
    const slip = plan.points.find((p) => p.kind === 'fact_slip')?.slip ?? null;
    const safe = safeLedger(this.ledger, this.deps.safety).ledger;
    const prior = this.deps.script?.prior.facts ?? [];
    const out: string[] = [];
    for (const id of beat.ledger_refs) {
      if (slip !== null && id === slip.fact_id) {
        if (this.factState === 'slipped') out.push(slip.slip_statement);
        else if (this.factState === 'corrected') out.push(slip.correct_statement);
        continue;
      }
      const item = [safe.core, ...safe.options, ...safe.dropped_options, ...safe.facts, ...safe.values].find((x) => x?.id === id);
      if (item) out.push(item.text);
      const p = prior.find((f) => f.fact_id === id);
      if (p) out.push(p.text);
    }
    return out;
  }

  private turnPromptFor(item: Extract<Item, { kind: 'beat' | 'align' }>, historyUpTo: Issued[]): { prompt: ReturnType<typeof buildTurnPrompt>; fed_ids: string[]; feed_turn: boolean; offered: OfferedLink[] } {
    const plan = this.requirePlan();
    const beat = item.beat;
    const self = plan.personas.find((p) => p.ai_id === beat.speaker)!;
    const peer = plan.personas.find((p) => p.ai_id !== beat.speaker)!;
    const slipPoint = plan.points.find((p) => p.kind === 'fact_slip') ?? null;
    const slipNotStarted = slipPoint !== null && this.pointState.get(slipPoint.point_id) === 'unscheduled';
    // 次の 2 拍の意図（拍の位置から数える。位置合わせの react は次の拍から）
    const at = plan.beats.findIndex((b) => b.beat_id === beat.beat_id);
    const from = at >= 0 ? at + 1 : this.beatIdx;
    const nextIntents = plan.beats.slice(from, from + 2).map((b) => b.intent).filter((x) => x !== '');
    const nameOf = (ai: AiId) => plan.personas.find((p) => p.ai_id === ai)!.display_name;
    const history = historyUpTo
      .filter((r) => !r.cancelled && r.resume_of === null)
      .slice(-this.deps.config.generation.history_turns)
      .map((r) => ({ speaker_name: nameOf(r.turn.speaker), text: r.turn.text }));
    const feedsOn = this.feedsEffective;
    const fed = feedsOn ? this.fed.slice(-this.deps.config.experience.feed.max_items) : [];
    const feed_turn = feedsOn && this.feedTarget !== null && (this.feedTarget.kind === 'next_live_turn' || this.activeBlock === null);
    const userItems = this.responsive ? this.userItems() : [];
    const offered = this.responsive ? this.offeredLinks(beat, userItems, fed) : [];
    return {
      prompt: buildTurnPrompt({
        self,
        peer,
        user_name: this.profile.user_name,
        beat,
        material: this.material(beat),
        next_intents: nextIntents,
        banned_c_phrases: feedsOn ? null : plan.points.flatMap((p) => p.c_terms),
        banned_facts: slipNotStarted && slipPoint?.slip ? [slipPoint.slip.correct_statement] : [],
        history,
        after_point: this.lastWasBlockEnd,
        fed_interjections: fed.map((f, i) => ({ label: `#${i + 1}`, text: f.text })),
        feed_turn,
        ...(userItems.length > 0 ? { user_items: userItems } : {}),
      }),
      fed_ids: fed.map((f) => f.interjection_id),
      feed_turn,
      offered,
    };
  }

  private prefetchKey(beat_id: string, lastTurnId: string | null): string {
    return [beat_id, this.factState, this.variant, lastTurnId ?? '-', this.fed.length, this.feedTarget?.kind ?? '-', this.responsive ? this.ledger.ledger_version : '-'].join('|');
  }

  /** 次の拍の文を先に作る（02 §3.3-2。履歴が変わったら使わない）。 */
  private kickPrefetch(plan: DiscussionPlan): void {
    if (this.reissue.length > 0 || this.activeBlock !== null) return;
    const nb = plan.beats[this.beatIdx];
    if (nb === undefined || !nb.live || plan.source === 'fallback_outline') return;
    // 段の拍がまだ埋まっていなければ先に作らない（埋まるのを待てる時間を残す）
    if (!this.stageReady(nb.stage)) return;
    // 次が点になりそうなら作らない（無駄な呼び出しを避ける。at_sec の点は見込みが要るので、ここでは数えない）
    if (this.triggeredPoint(nb, 0) !== null) return;
    const key = this.prefetchKey(nb.beat_id, this.order.at(-1)?.turn.turn_id ?? null);
    if (this.prefetch?.key === key) return;
    const item: Item = { kind: 'beat', beat: nb, stage_last: false };
    const controller = this.controller();
    const promise = this.runGeneration(item, `prefetch_${nb.beat_id}`, controller.signal, [...this.order]).finally(() => this.controllers.delete(controller));
    promise.catch(() => undefined);
    this.prefetch = { key, beat_id: nb.beat_id, promise };
  }

  private async generateBeatText(item: Extract<Item, { kind: 'beat' | 'align' }>, turn_id: string, signal: AbortSignal): Promise<GenResult | null> {
    const key = this.prefetchKey(item.beat.beat_id, this.order.at(-1)?.turn.turn_id ?? null);
    let gen: GenResult;
    if (this.prefetch !== null && this.prefetch.key === key && item.kind === 'beat') {
      const p = this.prefetch.promise;
      this.prefetch = null;
      gen = await abortable(p, signal);
    } else {
      gen = await this.runGeneration(item, turn_id, signal, [...this.order]);
    }
    if (signal.aborted) {
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    }
    // 記録は使ったときに出す（先行生成の結果を捨てたときは出さない）
    this.emitContent(
      { event: 'two_ai.generation', turn_id, beat_id: item.beat.beat_id, stage: gen.stage, prompt_version: gen.prompt_version, model: gen.model, latency_ms: gen.latency_ms === null ? absent(gen.reason) : present(gen.latency_ms), chars: gen.text === null ? 0 : charCount(gen.text), fed_interjection_ids: gen.fed_ids, feed_turn: gen.feed_turn, c_ban_lifted: this.feedsEffective, reason: gen.reason },
      item.beat.speaker,
    );
    for (const b of gen.blocked) {
      this.emitContent({ event: 'two_ai.safety_blocked', rule: b.rule, stage: 'turn', text: b.text, action: b.action }, item.beat.speaker);
    }
    if (gen.feed_turn) this.feedTarget = null;
    if (gen.text !== null && gen.offered.length > 0) this.emitReflection(turn_id, 'live_turn', gen.text, gen.offered, item.beat.speaker);
    return gen.text === null ? null : gen;
  }

  /** (d) を呼び、検査し、だめなら 1 回だけ作り直す。どちらもだめなら text: null（呼び手が fallback_text）。 */
  private async runGeneration(item: Extract<Item, { kind: 'beat' | 'align' }>, turn_id: string, signal: AbortSignal, historyUpTo: Issued[]): Promise<GenResult> {
    const beat = item.beat;
    const plan = this.requirePlan();
    const { prompt, fed_ids, feed_turn, offered } = this.turnPromptFor(item, historyUpTo);
    const slip = plan.points.find((p) => p.kind === 'fact_slip')?.slip ?? null;
    const slipTerms = slip === null ? [] : this.factState === 'corrected' ? [slip.slip_statement, slip.slip_value] : this.factState === 'normal' ? [slip.slip_value] : [];
    const ctx = { c_terms: plan.points.flatMap((p) => p.c_terms), c_ban: !this.feedsEffective, slip_terms: slipTerms };
    const names = plan.personas.map((p) => p.display_name);
    const blocked: GenResult['blocked'] = [];
    let reason = '';
    let latency: number | null = null;
    let model = this.deps.config.generation.models.discussion_turn;
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await callLlm(this.deps.llmFor('discussion_turn', beat.speaker), {
        request_id: this.requestId(`turn_${turn_id}`),
        purpose: 'discussion_turn',
        system: prompt.system,
        messages: prompt.messages,
        response_json_schema: null,
        timeout_ms: this.deps.config.generation.timeout_ms.discussion_turn,
        signal,
      });
      if (signal.aborted) return { text: null, stage: 'fallback', prompt_version: prompt.version, model, latency_ms: null, reason: 'aborted', fed_ids, feed_turn, blocked, offered };
      model = r.model;
      if (!r.ok) {
        reason = r.reason;
        continue;
      }
      latency = r.latency_ms;
      const safety = checkText(r.text, this.deps.safety, ctx, names);
      if (!safety.ok) {
        reason = `safety ${safety.rule}`;
        blocked.push({ rule: safety.rule!, text: safety.cleaned, action: attempt === 0 ? 'regenerate' : 'fallback' });
        continue;
      }
      let text = safety.cleaned;
      const [low, high] = beat.target_chars;
      if (charCount(text) > high) {
        const cut = cutAtSentence(text, high);
        if (cut === null) {
          reason = `too long without a sentence end (${charCount(text)})`;
          continue;
        }
        text = cut;
      }
      if (charCount(text) < Math.floor(low * SHORT_RATIO)) {
        reason = `too short (${charCount(text)})`;
        continue;
      }
      return { text, stage: attempt === 0 ? 'generated' : 'regenerated', prompt_version: prompt.version, model, latency_ms: latency, reason: attempt === 0 ? 'ok' : `regenerated: ${reason}`, fed_ids, feed_turn, blocked, offered };
    }
    return { text: null, stage: 'fallback', prompt_version: prompt.version, model, latency_ms: latency, reason: reason || 'failed', fed_ids, feed_turn, blocked, offered };
  }

  pendingPoints(view: { content_elapsed_ms: number }): PendingPointView[] {
    const plan = this.requirePlanLoose();
    if (plan === null) return [];
    const cps = this.deps.config.phases.discussion.chars_per_sec_estimate;
    const views: PendingPointView[] = plan.points.map((p) => {
      const row = plan.schedule_check.points.find((r) => r.point_id === p.point_id);
      const state = this.pointState.get(p.point_id) ?? 'unscheduled';
      const started = this.pointStartMs.get(p.point_id);
      const expected = started ?? (row ? Math.max(row.expected_start_sec * 1000, state === 'unscheduled' ? view.content_elapsed_ms : 0) : null);
      return {
        point_id: p.point_id,
        kind: p.kind,
        speaker: p.speaker,
        discussion_stage: 'in_stage' in p.trigger ? p.trigger.in_stage : (row?.discussion_stage ?? null),
        state,
        expected_start_ms: expected === null ? null : Math.round(expected),
        expected_block_ms: blockMs(p, cps),
      };
    });
    for (const u of plan.unavailable_points) {
      views.push({ point_id: u.point_id, kind: u.kind, speaker: u.speaker, discussion_stage: null, state: 'unavailable', expected_start_ms: null, expected_block_ms: 0 });
    }
    return views;
  }

  private requirePlanLoose(): DiscussionPlan | null {
    return this.plan;
  }

  forcePendingPoints(): void {
    this.forced = true;
    this.prefetch = null;
  }

  // ---- 割り込み ----------------------------------------------------------------

  planInterjection(input: { interrupted_turn_id: string | null; spoken_prefix: string; last_speaker: AiId; mode: 'after_ack' | 'false_onset' }): InterjectionPlan {
    const rec = input.interrupted_turn_id === null ? undefined : this.issued.get(input.interrupted_turn_id);
    if (rec === undefined) return { ack_speaker: input.last_speaker, resume: null, keep_queue: true };
    // 元のターンの座標で、声に出た文字数を求める
    const base = rec.resume_of?.base ?? rec;
    const spokenChars = charCount(input.spoken_prefix);
    const offset = rec.resume_of === null ? spokenChars : rec.resume_of.offset_chars + Math.max(0, spokenChars - rec.resume_of.bridge_chars);
    const sentences = base.turn.sentences;
    let acc = 0;
    let idx = 0;
    for (; idx < sentences.length; idx++) {
      const len = charCount(sentences[idx]!);
      if (offset < acc + len) break;
      acc += len;
    }
    if (idx >= sentences.length) {
      // 最後まで声に出ていた：言い直すものはない
      return { ack_speaker: rec.turn.speaker, resume: null, keep_queue: true };
    }
    const bridge = input.mode === 'after_ack' ? this.deps.config.fixed.bridge : '';
    const rest = sentences.slice(idx);
    const text = bridge + rest.join('');
    const bridge_chars = charCount(bridge);
    const restated_chars = Math.max(0, offset - acc);
    this.resumeCount += 1;
    const turn: DiscussionTurn = {
      ...base.turn,
      turn_id: `${base.turn.turn_id}.r${this.resumeCount}`,
      turn_kind: 'resume',
      text,
      sentences: bridge === '' ? rest : [bridge + rest[0]!, ...rest.slice(1)],
      board_card: null,
      gap_hint_ms: this.deps.config.gaps_ms.resume_gap_ms,
      est_duration_ms: this.estMs(text),
      repeat: { bridge_chars, restated_chars },
    };
    const resumeRec: Issued = { turn, item: base.item, index: base.index, played: false, played_ms: 0, cancelled: false, resume_of: { base, offset_chars: acc, bridge_chars, start_sentence: idx } };
    this.issued.set(turn.turn_id, resumeRec);
    this.order.push(resumeRec);
    return { ack_speaker: rec.turn.speaker, resume: turn, keep_queue: true };
  }

  onTurnPlayed(input: { turn_id: string; audio_playback_id: number; spoken_text: string; played_ms: number; completed: boolean }): void {
    const rec = this.issued.get(input.turn_id);
    if (rec === undefined) return;
    rec.played = true;
    rec.played_ms = input.played_ms;
    if (this.responsive && input.played_ms > 0 && input.spoken_text.trim() !== '') this.transcriptLog.push({ who: rec.turn.speaker, text: input.spoken_text, segment_id: null });
    const item = rec.item;
    if (item.kind === 'point' && input.played_ms > 0) {
      this.stance.onPointTurnPlayed(item.point.kind, item.turn_idx, item.point.turns.length - 1);
      if (item.point.kind === 'fact_slip' && item.turn_idx >= 1 && rec.turn.point_variant === 'original') this.spokenOriginalInference = true;
    }
  }

  onInterjectionClosed(input: { interjection_id: string; text: string; asr_segment_ids: number[]; classification: UtteranceClass; during_point_id: string | null }): { invalidate_turn_ids: string[]; feed_target: 'next_live_turn' | 'after_point_block' | null } {
    if (!this.feedsEffective) return { invalidate_turn_ids: [], feed_target: null };
    const target: 'next_live_turn' | 'after_point_block' = input.during_point_id !== null || this.activeBlock !== null ? 'after_point_block' : 'next_live_turn';
    const text = input.text.trim().slice(0, this.deps.config.experience.feed.max_chars);
    let excluded: string | null = null;
    if (input.classification === 'backchannel') excluded = 'backchannel';
    else if (text === '') excluded = 'empty';
    else {
      const s = checkText(text, this.deps.safety, { c_terms: [], c_ban: false, slip_terms: [] });
      if (!s.ok) {
        excluded = `safety_${s.rule}`;
        this.emitContent({ event: 'two_ai.safety_blocked', rule: s.rule!, stage: 'interjection_feed', text, action: 'excluded' });
      }
    }
    const invalidated: string[] = [];
    if (this.responsive) {
      const prev = this.interjections.get(input.interjection_id);
      this.interjections.set(input.interjection_id, { text, accepted: excluded === null, segment_ids: prev?.segment_ids ?? [], finals: prev?.finals ?? new Map() });
    }
    if (excluded === null) {
      this.fed.push({ interjection_id: input.interjection_id, text, asr_segment_ids: input.asr_segment_ids });
      this.stance.onFed();
      this.feedTarget = { kind: target, ids: [...(this.feedTarget?.ids ?? []), input.interjection_id] };
      this.prefetch = null;
      if (target === 'next_live_turn') {
        // 準備済みの次の生のターンを取り消して作り直す
        const next = this.order.find((r) => !r.played && !r.cancelled && r.resume_of === null && r.item.kind !== 'point');
        if (next !== undefined) {
          this.cancelAndReissue([next]);
          invalidated.push(next.turn.turn_id);
        }
      }
    }
    this.emitContent({
      event: 'two_ai.interjection_fed',
      interjection_id: input.interjection_id,
      asr_segment_ids: input.asr_segment_ids,
      chars: charCount(text),
      accepted: excluded === null,
      excluded_reason: excluded,
      invalidated_turn_ids: invalidated,
      target,
    });
    return { invalidate_turn_ids: invalidated, feed_target: excluded === null ? target : null };
  }

  /** 取り消して、同じ位置（同じ通し番号）で頼み直させる。 */
  private cancelAndReissue(records: Issued[]): void {
    const items = records.map((r) => {
      r.cancelled = true;
      for (const [card, by] of this.cardsShown) if (by === r.turn.turn_id) this.cardsShown.delete(card);
      return { item: r.item, index: r.index };
    });
    items.sort((a, b) => a.index - b.index);
    this.reissue = [...items, ...this.reissue].sort((a, b) => a.index - b.index);
    this.prefetch = null;
  }

  /** 準備済みで、まだ再生していないターン（resume を除く）。 */
  private unplayed(exceptTurnId: string | null): Issued[] {
    return this.order.filter((r) => !r.played && !r.cancelled && r.resume_of === null && r.turn.turn_id !== exceptTurnId);
  }

  abandonResume(interrupted_turn_id: string | null, reason: AbandonResumeReason): { credited_ms: number } {
    const plan = this.plan;
    if (plan === null) return { credited_ms: 0 };
    const interrupted = interrupted_turn_id === null ? undefined : this.issued.get(interrupted_turn_id);
    const base = interrupted?.resume_of?.base ?? interrupted;
    const fromRecord = base?.item.kind === 'point' && base.item.point.kind === 'fact_slip' ? base.item.point : null;
    const fromBlock = this.activeBlock?.point.kind === 'fact_slip' ? this.activeBlock.point : null;
    const waitingF = this.unplayed(null).find((r) => r.item.kind === 'point' && r.item.point.kind === 'fact_slip')?.item;
    const point = fromRecord ?? fromBlock ?? (waitingF?.kind === 'point' ? waitingF.point : null);
    if (point === null || this.variant === 'corrected') return { credited_ms: 0 };
    const dropped: string[] = [];
    let credited = 0;
    // 準備済みで未再生の F のターン（executor が取り消す）。中断したターン自身は数えない。
    for (const r of this.unplayed(base?.turn.turn_id ?? null)) {
      if (r.item.kind === 'point' && r.item.point.point_id === point.point_id) {
        r.cancelled = true;
        dropped.push(r.turn.origin.kind === 'point' ? r.turn.origin.turn_key : r.turn.turn_id);
        // 元の版の凍結文の見込み（間は足さない。content_port の credited_ms の定義）
        if (r.item.kind === 'point') credited += this.estMs(r.item.point.turns[r.item.turn_idx]!.text);
      }
    }
    // まだ出していない F のターン
    if (this.activeBlock?.point === point) {
      for (let i = this.activeBlock.next; i < point.turns.length; i++) {
        const t = point.turns[i]!;
        dropped.push(t.turn_key);
        credited += this.estMs(t.text);
        // 通し番号は進めて、② と同じ拍で後のターンが続くようにする
        this.nextIndex += 1;
      }
      this.activeBlock = null;
    }
    this.reissue = this.reissue.filter((x) => !(x.item.kind === 'point' && x.item.point === point));
    if (base !== undefined && !base.played) base.cancelled = true;
    this.pointState.set(point.point_id, 'done');
    this.lastWasBlockEnd = true;
    this.prefetch = null;
    this.lastAbandon = { point_id: point.point_id, reason, dropped_turn_keys: dropped, credited_ms: credited };
    return { credited_ms: credited };
  }

  /**
   * 最後の abandonResume で捨てた F のターンの見込み（decisions_round5 M2）。WP1 が content_ms に加算する（credited_ms）。
   * 見込みは「元の版の文字数 ÷ chars_per_sec_estimate」の和（abandonResume の戻り値と同じ）。試験と記録の確認用。
   */
  abandonedCredit(): { point_id: string; reason: AbandonResumeReason; dropped_turn_keys: string[]; credited_ms: number } | null {
    return this.lastAbandon;
  }

  applyCorrection(point_id: string, _trigger: 'woz_researcher' | 'auto_confirmed', _timing: 'in_window' | 'next_boundary', interrupted_turn_id: string | null): CorrectionResult {
    const plan = this.requirePlan();
    const point = plan.points.find((p) => p.point_id === point_id);
    if (point === undefined || point.kind !== 'fact_slip' || point.uptake === null) throw new Error(`applyCorrection: ${point_id} is not a fact_slip point with an uptake`);
    if (this.variant === 'corrected') throw new Error('applyCorrection: already corrected (the second correction is recorded only by 01)');
    const interrupted = interrupted_turn_id === null ? undefined : this.issued.get(interrupted_turn_id);
    const interruptedBase = interrupted?.resume_of?.base ?? interrupted;
    const drop_resume =
      interruptedBase !== undefined && interruptedBase.item.kind === 'point' && interruptedBase.item.point.point_id === point_id && interruptedBase.turn.point_variant === 'original';

    this.variant = 'corrected';
    this.factState = 'corrected';
    this.stance.onCorrected();
    this.prefetch = null;

    const replace: Issued[] = [];
    const invalidate: Issued[] = [];
    for (const r of this.unplayed(interruptedBase?.turn.turn_id ?? null)) {
      const item = r.item;
      if (item.kind === 'point') {
        const correctedText = item.point.corrected_turns[item.turn_idx]!.text;
        const cardChanges = r.turn.board_card !== null && r.turn.board_card.depends_on === 'fact_slip';
        if (correctedText !== r.turn.text || cardChanges) replace.push(r);
      } else if (r.turn.fact_state === 'slipped' || (r.turn.board_card !== null && r.turn.board_card.depends_on === 'fact_slip')) {
        invalidate.push(r);
      }
    }
    this.cancelAndReissue([...replace, ...invalidate]);
    if (drop_resume && interruptedBase) {
      // 中断した F のターンは言い直さない（uptake が戻りを兼ねる）
      this.reissue = this.reissue.filter((x) => x.index !== interruptedBase.index);
      if (!interruptedBase.played) interruptedBase.cancelled = true;
    }
    const uptake = point.uptake;
    const last = this.order.at(-1);
    const turn: DiscussionTurn = {
      turn_id: `${point_id}.uptake`,
      index: last?.index ?? 0,
      speaker: uptake.speaker,
      turn_kind: 'uptake',
      text: uptake.text,
      sentences: uptake.sentences,
      text_origin: 'frozen',
      origin: { kind: 'point', point_id, turn_key: uptake.turn_key },
      point_id,
      point_variant: 'corrected',
      discussion_stage: last?.turn.discussion_stage ?? null,
      board_card: null,
      gap_hint_ms: this.deps.config.gaps_ms.resume_gap_ms,
      est_duration_ms: this.estMs(uptake.text),
      fact_state: 'corrected',
      repeat: null,
      fed_interjection_ids: [],
      feed_turn: false,
    };
    return {
      uptake: turn,
      invalidate_turn_ids: invalidate.map((r) => r.turn.turn_id),
      replace_point_turn_ids: replace.map((r) => r.turn.turn_id),
      drop_resume,
    };
  }

  // ---- 定型と最後の段 -------------------------------------------------------------

  ackTemplates(): { template_id: string; text: string }[] {
    return fixed.ackTemplates(this.deps.config);
  }

  phaseLine(phase: TwoAiPhase, edge: 'open' | 'close'): { ai_id: AiId; line_id: string; text: string } | null {
    return fixed.phaseLine(this.deps.config, this.condition, phase, edge, this.slots);
  }

  planFiller(index: 0 | 1): { ai_id: AiId; line_id: string; text: string } | null {
    return fixed.planFiller(this.deps.config, index);
  }

  closingQuestion(): { ai_id: AiId; line_id: string; text: string } {
    return fixed.closingQuestion(this.deps.config);
  }

  responseLine(_kind: 'more'): { ai_id: AiId; line_id: string; text: string } {
    return fixed.responseMore(this.deps.config);
  }

  closingRebuild(): ClosingRebuild {
    const plan = this.plan;
    if (plan === null) throw new Error('closingRebuild without a plan');
    const base = this.nextIndex;
    const board = this.boardCards();
    const rebuildTurns = this.responsive && this.liveBoard !== null ? this.responsiveRebuildTurns(board) : plan.rebuild_turns;
    this.boardFrozen = true;
    const turns: DiscussionTurn[] = rebuildTurns.map((t, i) => ({
      turn_id: `rebuild_${i}`,
      index: base + i,
      speaker: t.speaker,
      turn_kind: 'rebuild',
      text: t.text,
      sentences: t.sentences,
      text_origin: 'frozen',
      origin: { kind: 'fixed', fixed_id: `rebuild.${t.turn_key}` },
      point_id: null,
      point_variant: null,
      discussion_stage: null,
      board_card: null,
      gap_hint_ms: this.deps.config.gaps_ms.default.median,
      est_duration_ms: this.estMs(t.text),
      fact_state: this.factState === 'normal' ? 'normal' : 'corrected',
      repeat: null,
      fed_interjection_ids: [],
      feed_turn: false,
    }));
    return { turns, board: [...board].sort((a, b) => a.order - b.order).map((c) => cardView(c, 'corrected')) };
  }

  pickLine(line: 'prompt' | 'confirm' | 'timeout'): { ai_id: AiId; line_id: string; text: string } {
    return fixed.pickLine(this.deps.config, line);
  }

  retractionScript(): RetractionScriptView {
    const plan = this.plan;
    const slipPoint = plan?.points.find((p) => p.kind === 'fact_slip') ?? null;
    const form: RetractionScriptView['inference_form'] = slipPoint === null || plan?.retraction == null ? 'none' : this.spokenOriginalInference ? 'spoken' : 'not_spoken';
    const process = plan?.retraction_process ?? (this.deps.script?.retraction ?? this.deps.config.retraction.template).process;
    const { lines, sha256 } = retractionLines({ spec: plan?.retraction ?? null, process, speaker: this.deps.config.retraction.speaker, form });
    this.stance.onRetracted();
    return { lines, point_ids: slipPoint ? [slipPoint.point_id] : [], inference_form: form, sha256 };
  }

  // ---- 本人の発話 ----------------------------------------------------------------

  onUserUtterance(entry: UserHistoryEntry, context: { phase: TwoAiPhase; interjection_id: string | null }): void {
    if (!entry.is_final || entry.text.trim() === '') return;
    if (context.phase === 'intake') {
      this.utterances.push({ segment_id: entry.segment_id, text: entry.text });
      this.tracker.onUserFinal(entry.segment_id);
      if (this.readbackReplyPending) {
        this.readbackReplyPending = false;
        if (this.ledger.core !== null) {
          if (isReadbackDenial(entry.text)) this.ledger = { ...this.ledger, core: { ...this.ledger.core, confirmed: false } };
          else this.ledger = { ...this.ledger, core: { ...this.ledger.core, confirmed: true } };
        }
      }
      this.scheduleLedger();
      return;
    }
    if (this.responsive && (context.phase === 'discussion' || context.phase === 'response')) this.captureUserUtterance(entry, context.phase, context.interjection_id);
    if (context.phase === 'discussion' && context.interjection_id !== null) this.maybeAssistCorrection(entry, context.interjection_id);
  }

  /** (e)：取り違えの点が始まった後、まだ訂正していないとき、割り込みの確定文ごとに走らせる。 */
  private maybeAssistCorrection(entry: UserHistoryEntry, _interjection_id: string): void {
    const plan = this.plan;
    if (plan === null || this.variant === 'corrected' || this.condition !== 'respond_on_spot') return;
    if (!this.deps.config.correction.assist && this.correctionMode !== 'auto') return;
    const point = plan.points.find((p) => p.kind === 'fact_slip');
    if (point?.slip == null || this.pointState.get(point.point_id) === 'unscheduled') return;
    const suggestion: CorrectionSuggestion = {
      suggestion_id: `cs_${++this.suggestionSeq}`,
      point_id: point.point_id,
      asr_segment_ids: [entry.segment_id],
      status: 'pending',
      corrects: null,
      evidence_span: '',
    };
    this.suggestions.push(suggestion);
    this.emitSuggestion(suggestion, null);
    const prompt = buildCorrectionPrompt({ slip_statement: point.slip.slip_statement, correct_statement: point.slip.correct_statement, utterance: entry.text });
    const controller = this.controller();
    void callLlm(this.deps.llmFor('correction_assist'), {
      request_id: this.requestId('correction'),
      purpose: 'correction_assist',
      system: prompt.system,
      messages: prompt.messages,
      response_json_schema: CORRECTION_JSON_SCHEMA,
      timeout_ms: this.deps.config.generation.timeout_ms.correction_assist,
      signal: controller.signal,
    }).then((r) => {
      this.controllers.delete(controller);
      if (this.disposed) return;
      const parsed = r.ok ? parseCorrectionOutput(parseJsonLoose(r.text), entry.text) : null;
      if (parsed === null) suggestion.status = 'failed';
      else {
        suggestion.status = 'done';
        suggestion.corrects = parsed.corrects;
        suggestion.evidence_span = parsed.evidence_span;
      }
      this.emitSuggestion(suggestion, r.latency_ms);
    });
  }

  /** 試験用：補助の判定が終わるまで待つ。 */
  async suggestionsIdle(): Promise<void> {
    for (let i = 0; i < 50 && this.suggestions.some((s) => s.status === 'pending'); i++) await new Promise((r) => setTimeout(r, 5));
  }

  classifyUserUtterance(input: { text: string; is_final: boolean; voiced_ms: number }): UtteranceClass {
    const c = this.deps.config.interjection.classify;
    const text = input.text.trim().replace(/[、。！？!?…ー〜\s]/gu, '');
    if (text === '') return input.voiced_ms > 0 && input.voiced_ms <= c.backchannel_max_voiced_ms ? 'backchannel' : 'unknown';
    const short = charCount(text) <= c.backchannel_max_chars;
    if (short && /^(うん|ううん|はい|ええ|へえ|へー|ほう|あー|あ|おー|そう|そうそう|そうですね|そっか|なるほど|たしかに|確かに|ふん|ふーん)+$/u.test(text)) return 'backchannel';
    if (short && !input.is_final) return 'unknown';
    return 'content';
  }

  correctionSuggestions(): CorrectionSuggestion[] {
    return this.suggestions.map((s) => ({ ...s }));
  }

  framingState(ai_id: AiId): { state: TwoAiAiState; version: string } {
    return this.stance.state(ai_id);
  }

  isDone(phase: 'intake' | 'discussion', view: { elapsed_ms: number; content_elapsed_ms: number }): boolean {
    if (phase === 'intake') {
      const i = this.deps.config.phases.intake;
      if (view.elapsed_ms >= i.max_sec * 1000) return true;
      const slotsFilled = missingSlots(this.tracker.view(this.ledger)).length === 0;
      return slotsFilled && view.elapsed_ms >= i.min_sec * 1000 && this.tracker.readback && this.tracker.repliedAfterReadback;
    }
    const plan = this.plan;
    if (plan === null || !this.started) return false;
    const pointsClosed = [...this.pointState.values()].every((s) => s === 'done' || s === 'unavailable');
    const queueEmpty = this.reissue.length === 0 && this.activeBlock === null && this.beatIdx >= plan.beats.length;
    const allPlayed = this.order.every((r) => r.played || r.cancelled || r.resume_of !== null);
    return pointsClosed && queueEmpty && allPlayed;
  }

  scriptVariant(): ScriptVariant {
    return this.variant;
  }

  dispose(): void {
    this.disposed = true;
    for (const c of this.controllers) c.abort(new Error('disposed'));
    this.controllers.clear();
  }

  // ---- 応答版（experience.mode: 'responsive'） --------------------------------------------

  /** 話し合いと応答の段の本人の確定文を台帳の入力に足す（two_ai.capture: received）。 */
  private captureUserUtterance(entry: UserHistoryEntry, phase: 'discussion' | 'response', interjection_id: string | null): void {
    const text = entry.text.trim();
    const seg = entry.segment_id;
    const prev = this.userSegs.get(seg);
    this.userSegs.set(seg, { phase, interjection_id, chars: charCount(text), text, reported: prev?.reported ?? false, captured: prev?.captured ?? false });
    if (interjection_id !== null) {
      const ij = this.interjections.get(interjection_id) ?? { text: '', accepted: true, segment_ids: [], finals: new Map<number, string>() };
      ij.finals.set(seg, text);
      if (!ij.segment_ids.includes(seg)) ij.segment_ids.push(seg);
      this.interjections.set(interjection_id, ij);
    }
    const u: Utterance = { segment_id: seg, text: entry.text, phase };
    const i = this.utterances.findIndex((x) => x.segment_id === seg);
    if (i >= 0) this.utterances[i] = u;
    else this.utterances.push(u);
    const j = this.transcriptLog.findIndex((x) => x.segment_id === seg);
    if (j >= 0) this.transcriptLog[j] = { who: 'user', text, segment_id: seg };
    else this.transcriptLog.push({ who: 'user', text, segment_id: seg });
    this.emitContent({ event: 'two_ai.capture', segment_id: seg, interjection_id, phase, stage: 'received', chars: charCount(text), ledger_version: null, item_ids: [], reason: 'stt_final' });
    this.scheduleLedger();
  }

  private allItems(ledger: ProblemLedger): LedgerItem[] {
    return [ledger.core, ...ledger.options, ...ledger.dropped_options, ...ledger.facts, ...ledger.values].filter((x): x is LedgerItem => x !== null);
  }

  /** 台帳の更新の後：本人の発話ごとの取得を記録し、まだ話していない段の拍と板を作り直す。 */
  private afterResponsiveLedger(utterances: readonly Utterance[], ledger: ProblemLedger): void {
    const items = this.allItems(ledger);
    for (const u of utterances) {
      if (u.phase === undefined) continue;
      const rec = this.userSegs.get(u.segment_id);
      if (rec === undefined || rec.captured) continue;
      const sensitive = ledger.sensitive.some((x) => x.evidence.segment_ids.includes(u.segment_id));
      const ids = sensitive ? [] : items.filter((x) => x.evidence.some((e) => e.segment_ids.includes(u.segment_id))).map((x) => x.id);
      const stage = sensitive ? 'excluded' : ids.length > 0 ? 'captured' : 'not_captured';
      if (stage === 'not_captured' && rec.reported) continue;
      rec.reported = true;
      if (stage !== 'not_captured') rec.captured = true;
      this.emitContent({
        event: 'two_ai.capture',
        segment_id: u.segment_id,
        interjection_id: rec.interjection_id,
        phase: rec.phase,
        stage,
        chars: rec.chars,
        ledger_version: ledger.ledger_version,
        item_ids: ids,
        reason: sensitive ? 'sensitive' : ids.length > 0 ? 'evidence' : 'no item cites this utterance',
      });
    }
    if (this.plan === null || !this.started) return;
    this.prefetch = null;
    this.refillStages();
    void this.kickBoard('ledger_update');
  }

  /** 本人が話し合いと応答の段で足した台帳の項目（新しい順に feed.max_items 件を、古い順に）。取り違えが正される前は事実の項目を外す。 */
  private userItems(): { id: string; text: string }[] {
    if (this.userSegs.size === 0) return [];
    const safe = safeLedger(this.ledger, this.deps.safety).ledger;
    const factIds = new Set(safe.facts.map((f) => f.id));
    const slipPending = this.factState === 'slipped';
    const latest = (x: LedgerItem) => Math.max(-1, ...x.evidence.flatMap((e) => e.segment_ids.filter((id) => this.userSegs.has(id))));
    return this.allItems(safe)
      .filter((x) => !(slipPending && factIds.has(x.id)))
      .map((x) => ({ x, at: latest(x) }))
      .filter((r) => r.at >= 0)
      .sort((a, b) => b.at - a.at)
      .slice(0, this.deps.config.experience.feed.max_items)
      .reverse()
      .map((r) => ({ id: r.x.id, text: r.x.text }));
  }

  /** プロンプトに入れた本人の発言（台帳の項目と、まだ台帳にない割り込み）。 */
  private offeredLinks(beat: Beat | null, userItems: readonly { id: string }[], fed: readonly { interjection_id: string; text: string }[]): OfferedLink[] {
    const safe = safeLedger(this.ledger, this.deps.safety).ledger;
    const all = this.allItems(safe);
    const links = new Map<string, OfferedLink>();
    const addItem = (id: string) => {
      const x = all.find((y) => y.id === id);
      if (x === undefined || links.has(id)) return;
      const segs = [...new Set(x.evidence.flatMap((e) => e.segment_ids))].filter((sid) => this.userSegs.has(sid)).sort((a, b) => a - b);
      if (segs.length === 0) return;
      links.set(id, { item_id: id, segment_ids: segs, texts: [x.text, ...x.evidence.map((e) => e.span)] });
    };
    for (const u of userItems) addItem(u.id);
    for (const id of beat?.ledger_refs ?? []) addItem(id);
    const out = [...links.values()];
    for (const f of fed) {
      const ij = this.interjections.get(f.interjection_id);
      out.push({ item_id: null, segment_ids: [...(ij?.segment_ids ?? [])].sort((a, b) => a - b), texts: [f.text, ...(ij ? [...ij.finals.values()] : [])] });
    }
    return out;
  }

  private emitReflection(turn_id: string, kind: 'live_turn' | 'reply', text: string, offered: readonly OfferedLink[], speaker: AiId): void {
    const n = this.deps.config.experience.responsive.reference_min_chars;
    this.emitContent(
      {
        event: 'two_ai.reflection',
        turn_id,
        turn_kind: kind,
        links: offered.map((l) => ({ item_id: l.item_id, segment_ids: l.segment_ids, offered: true, referenced: l.texts.some((t) => sharesSubstring(text, t, n)) })),
        method: referenceMethod(n),
      },
      speaker,
    );
  }

  /** まだ話していない段（埋め終えた段だけ）を、本人の発言を入れて作り直す（段ごとに stage_refill_max 回まで）。 */
  private refillStages(): void {
    const plan = this.plan;
    if (!this.responsive || plan === null || !this.started) return;
    const max = this.deps.config.experience.responsive.stage_refill_max;
    let any = false;
    for (const [stage, fill] of this.stageFill) {
      if (fill.state !== 'filled') continue;
      const first = plan.beats.findIndex((b) => b.stage === stage);
      if (first < 0 || first < this.beatIdx) continue;
      const n = this.stageRefills.get(stage) ?? 0;
      if (n >= max) continue;
      this.stageRefills.set(stage, n + 1);
      fill.state = 'pending';
      fill.refill = true;
      any = true;
    }
    if (any) this.stageChain = this.stageChain.then(() => this.runStageChain()).catch(() => undefined);
  }

  /** 板（応答版で生成した板があればそれ、なければ凍結の板）。 */
  private boardCards(): BoardCard[] {
    return this.responsive && this.liveBoard !== null ? this.liveBoard : (this.plan?.board ?? []);
  }

  private boardInput(): BoardGenInput {
    const plan = this.requirePlan();
    const safe = safeLedger(this.ledger, this.deps.safety).ledger;
    const slip = plan.points.find((p) => p.slip !== null)?.slip ?? null;
    return {
      version: BOARD_GEN_PROMPT_VERSION,
      user_name: this.profile.user_name,
      aspect: this.profile.aspect,
      personas: plan.personas.map((p) => ({ ai_id: p.ai_id, display_name: p.display_name, lens_summary: p.lens_summary })),
      items: boardItemsFromLedger(safe, (sid) => this.userSegs.get(sid)?.phase ?? 'intake'),
      transcript: this.transcriptLog.slice(-40).map((t) => ({ ...t })),
      draft: draftFromBoard(plan.board),
      fact: slip === null ? null : { slip_statement: slip.slip_statement, slip_value: slip.slip_value, correct_statement: slip.correct_statement, state: this.factState },
      c_terms: plan.points.flatMap((p) => p.c_terms),
      max_chars: this.deps.config.experience.responsive.board_card_max_chars,
    };
  }

  /** 板の生成を 1 回（走っていれば終わってからもう 1 回）。話し合いの間は board_regen_max 回まで、まだ出していないカードがあるときだけ。 */
  private kickBoard(trigger: 'ledger_update' | 'closing'): Promise<void> {
    if (this.plan === null || this.disposed || this.boardFrozen) return Promise.resolve();
    if (this.boardRunning !== null) {
      this.boardDirty = true;
      return this.boardRunning;
    }
    if (trigger === 'ledger_update') {
      if (this.boardRegens >= this.deps.config.experience.responsive.board_regen_max) return Promise.resolve();
      if (this.boardCards().every((c) => this.cardsShown.has(c.card_id))) return Promise.resolve();
      this.boardRegens += 1;
    }
    this.boardRunning = this.runBoard(trigger).finally(() => {
      this.boardRunning = null;
      if (this.boardDirty && !this.disposed) {
        this.boardDirty = false;
        void this.kickBoard('ledger_update');
      }
    });
    return this.boardRunning;
  }

  private async runBoard(trigger: 'ledger_update' | 'closing'): Promise<void> {
    const input = this.boardInput();
    const board_id = `board_${++this.boardSeq}`;
    const ledger_version = this.ledger.ledger_version;
    const base = { event: 'two_ai.board_generated' as const, board_id, trigger, ledger_version, prompt_version: BOARD_GEN_PROMPT_VERSION };
    this.emitContent({ ...base, stage: 'requested', input: null, cards: [], model: this.deps.config.generation.models.discussion_plan, latency_ms: absent('not finished'), reason: 'start' });
    const controller = this.controller();
    const run = await runBoardGeneration(this.deps.llmFor('discussion_plan'), input, this.deps.safety, {
      timeout_ms: this.deps.config.experience.responsive.board_timeout_ms,
      request_id: () => this.requestId('board'),
      signal: controller.signal,
    });
    this.controllers.delete(controller);
    if (this.disposed) return;
    const late = this.boardFrozen;
    const used = run.ok && !late;
    if (used) {
      this.liveBoard = run.cards;
      this.boardLedgerVersion = ledger_version;
    }
    for (const r of run.ok ? [] : run.reason.split('; ').filter((x) => x.includes('safety'))) {
      this.emitContent({ event: 'two_ai.safety_blocked', rule: r.replace(/^.*safety (\S+).*$/u, '$1') || 'board', stage: 'plan', text: r.slice(0, 300), action: 'fallback' });
    }
    this.emitContent({
      ...base,
      stage: used ? 'generated' : 'failed',
      input: used ? (input as unknown as JsonValue) : null,
      cards: run.cards.map((c) => ({ card_id: c.card_id, order: c.order, discussion_stage: c.stage, depends_on: c.depends_on, text: c.text, corrected_text: c.corrected_text, ledger_item_ids: c.ledger_item_ids, segment_ids: c.segment_ids })),
      model: run.model,
      latency_ms: run.latency_ms === null ? absent(run.reason.slice(0, 100) || 'failed') : present(run.latency_ms),
      reason: late && run.ok ? 'arrived after the rebuild: not used' : run.reason,
    });
  }

  /** 応答版の作り直しの読み上げ（生成した板の訂正後の文を、設定の文型に入れる）。 */
  private responsiveRebuildTurns(board: readonly BoardCard[]): FrozenTurn[] {
    const slots = Object.fromEntries([...board].map((c) => [`card_${c.order}`, c.corrected_text]));
    const [a, b] = this.deps.config.experience.responsive.rebuild_templates;
    return ([[a, 'A', 'R.0'], [b, 'B', 'R.1']] as const).map(([tpl, speaker, turn_key]) => {
      const text = fillTemplate(tpl, slots).text;
      return { turn_key, speaker, text, sentences: splitSentences(text), chars: charCount(text) };
    });
  }

  completeResume(input: { resume: DiscussionTurn; interjection_id: string; mode: 'after_ack' | 'false_onset' }, signal: AbortSignal): Promise<DiscussionTurn> | null {
    if (!this.responsive || input.mode === 'false_onset' || this.condition !== 'respond_on_spot' || this.plan === null) return null;
    return this.replyResume(input.resume, input.interjection_id, signal);
  }

  /** resume の頭に、本人の割り込みへの短い応答を入れる。作れなければ元の resume。 */
  private async replyResume(resume: DiscussionTurn, interjection_id: string, signal: AbortSignal): Promise<DiscussionTurn> {
    const ij = this.interjections.get(interjection_id);
    const finals = ij === undefined ? '' : [...ij.finals.entries()].sort((a, b) => a[0] - b[0]).map(([, t]) => t).join('');
    const said = (finals || ij?.text || '').trim().slice(0, this.deps.config.experience.feed.max_chars);
    if (ij === undefined || !ij.accepted || said === '' || !checkText(said, this.deps.safety, { c_terms: [], c_ban: false, slip_terms: [] }).ok) return resume;
    const plan = this.requirePlan();
    const cfg = this.deps.config.experience.responsive;
    const self = plan.personas.find((p) => p.ai_id === resume.speaker)!;
    const peer = plan.personas.find((p) => p.ai_id !== resume.speaker)!;
    const nameOf = (ai: AiId) => plan.personas.find((p) => p.ai_id === ai)!.display_name;
    const history = this.order
      .filter((r) => !r.cancelled && r.resume_of === null && r.turn.turn_id !== resume.turn_id)
      .slice(-4)
      .map((r) => ({ speaker_name: nameOf(r.turn.speaker), text: r.turn.text }));
    const userItems = this.userItems();
    const slip = plan.points.find((p) => p.kind === 'fact_slip')?.slip ?? null;
    const prompt = buildReplyPrompt({ self, peer, user_name: this.profile.user_name, said, history, material: userItems.map((x) => x.text), max_chars: cfg.reply_max_chars, fact_pending: slip !== null && this.factState === 'slipped' });
    const r = await callLlm(this.deps.llmFor('discussion_turn', resume.speaker), {
      request_id: this.requestId(`reply_${resume.turn_id}`),
      purpose: 'discussion_turn',
      system: prompt.system,
      messages: prompt.messages,
      response_json_schema: null,
      timeout_ms: Math.min(cfg.reply_timeout_ms, this.deps.config.generation.timeout_ms.discussion_turn),
      signal,
    });
    if (this.disposed || signal.aborted) return resume;
    let reply: string | null = null;
    let reason = r.ok ? '' : r.reason;
    if (r.ok) {
      const slipTerms = slip === null ? [] : this.factState === 'corrected' ? [slip.slip_statement, slip.slip_value] : this.factState === 'normal' ? [slip.slip_value] : [];
      const check = checkText(r.text, this.deps.safety, { c_terms: plan.points.flatMap((p) => p.c_terms), c_ban: false, slip_terms: slipTerms }, plan.personas.map((p) => p.display_name));
      if (!check.ok) {
        reason = `safety ${check.rule}`;
        this.emitContent({ event: 'two_ai.safety_blocked', rule: check.rule!, stage: 'turn', text: check.cleaned, action: 'fallback' }, resume.speaker);
      } else {
        const t = charCount(check.cleaned) > cfg.reply_max_chars ? cutAtSentence(check.cleaned, cfg.reply_max_chars) : check.cleaned.trim();
        if (t === null || t === '') reason = `too long without a sentence end (${charCount(check.cleaned)})`;
        else reply = t;
      }
    }
    this.emitContent(
      {
        event: 'two_ai.generation',
        turn_id: resume.turn_id,
        beat_id: null,
        stage: reply === null ? 'fallback' : 'generated',
        prompt_version: prompt.version,
        model: r.model,
        latency_ms: r.latency_ms === null ? absent(reason || 'failed') : present(r.latency_ms),
        chars: reply === null ? 0 : charCount(reply),
        fed_interjection_ids: [interjection_id],
        feed_turn: reply !== null,
        c_ban_lifted: true,
        reason: reply === null ? `interjection_reply: kept the plain resume: ${reason || 'failed'}`.slice(0, 300) : 'interjection_reply: ok',
      },
      resume.speaker,
    );
    if (reply === null) return resume;
    const text = reply + resume.text;
    const replyChars = charCount(reply);
    const turn: DiscussionTurn = {
      ...resume,
      text,
      sentences: [...splitSentences(reply), ...resume.sentences],
      est_duration_ms: this.estMs(text),
      repeat: { bridge_chars: (resume.repeat?.bridge_chars ?? 0) + replyChars, restated_chars: resume.repeat?.restated_chars ?? 0 },
      fed_interjection_ids: [interjection_id],
      feed_turn: true,
    };
    const rec = this.issued.get(resume.turn_id);
    if (rec !== undefined) {
      rec.turn = turn;
      if (rec.resume_of !== null) rec.resume_of = { ...rec.resume_of, bridge_chars: rec.resume_of.bridge_chars + replyChars };
    }
    const links = this.offeredLinks(null, userItems, [{ interjection_id, text: said }]);
    this.emitReflection(resume.turn_id, 'reply', reply, links, resume.speaker);
    return turn;
  }

  prepareClosing(signal: AbortSignal): Promise<void> | null {
    if (!this.responsive || this.plan === null) return null;
    const work = (async () => {
      await this.ledgerIdle();
      if (this.boardRunning !== null) await this.boardRunning;
      if (this.disposed || signal.aborted) return;
      if (this.liveBoard === null || this.boardLedgerVersion !== this.ledger.ledger_version) await this.kickBoard('closing');
    })();
    return raceTimeout(work, this.deps.config.experience.responsive.closing_board_wait_ms, signal);
  }

  /** 試験と probe 用：応答版の板の生成が終わるまで待つ。 */
  async boardIdle(): Promise<void> {
    while (this.boardRunning !== null) await this.boardRunning;
  }

  /** 試験と probe 用：応答版で生成した板（なければ null）。 */
  generatedBoard(): GeneratedCard[] | null {
    return this.liveBoard;
  }

  // ---- 記録 --------------------------------------------------------------------

  private controller(): AbortController {
    const c = new AbortController();
    this.controllers.add(c);
    return c;
  }

  private requestId(prefix: string): string {
    this.requestSeq += 1;
    return `two_ai_${prefix}_${this.requestSeq}`;
  }

  private emitContent(draft: ContentDraft, ai_id: AiId | null = null): void {
    this.deps.emitter.emit(draft as Parameters<EventEmitter['emit']>[0], { two_ai: { ai_id, point_id: null } });
  }

  private emitPlan(stage: 'requested' | 'frozen' | 'failed' | 'reused', trigger: 'early' | 'final' | 'regenerate' | 'fallback', plan: DiscussionPlan | null, latency: number | null, reason: string): void {
    this.emitContent({
      event: 'two_ai.plan',
      stage,
      trigger,
      plan_id: plan?.plan_id ?? null,
      plan_hash: plan?.plan_hash ?? null,
      source: plan?.source ?? null,
      plan: stage === 'frozen' && plan !== null ? planJson(plan) : null,
      fact_slip_source: plan?.fact_slip_source ?? null,
      schedule_check: plan === null ? null : { ok: plan.schedule_check.ok, latest_point_end_sec: Math.max(0, plan.schedule_check.latest_point_end_sec), close_at_sec: plan.close_at_sec },
      prompt_versions: plan?.prompt_versions ?? { plan: PLAN_PROMPT_VERSION },
      models: plan?.models ?? this.models(),
      latency_ms: latency === null ? absent(stage === 'requested' ? 'not finished' : 'no llm call') : present(latency),
      reason: reason || 'ok',
    });
  }

  private emitSuggestion(s: CorrectionSuggestion, latency: number | null): void {
    this.emitContent({
      event: 'two_ai.correction_suggested',
      suggestion_id: s.suggestion_id,
      point_id: s.point_id,
      asr_segment_ids: s.asr_segment_ids,
      status: s.status,
      corrects: s.corrects,
      evidence_span: s.evidence_span,
      method: `llm:${CORRECTION_PROMPT_VERSION}`,
      latency_ms: latency === null ? absent(s.status === 'pending' ? 'pending' : 'failed') : present(latency),
    });
  }
}

interface GenResult {
  text: string | null;
  stage: 'generated' | 'regenerated' | 'fallback';
  prompt_version: string;
  model: string;
  latency_ms: number | null;
  reason: string;
  fed_ids: string[];
  feed_turn: boolean;
  blocked: { rule: string; text: string; action: 'regenerate' | 'fallback' }[];
  /** 応答版：プロンプトに入れた本人の発言（統制版は空）。 */
  offered: OfferedLink[];
}

type ContentDraft = Extract<
  Parameters<EventEmitter['emit']>[0],
  {
    event:
      | 'two_ai.ledger'
      | 'two_ai.plan'
      | 'two_ai.generation'
      | 'two_ai.safety_blocked'
      | 'two_ai.correction_suggested'
      | 'two_ai.interjection_fed'
      | 'two_ai.capture'
      | 'two_ai.reflection'
      | 'two_ai.board_generated';
  }
>;

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    const e = new Error('aborted');
    e.name = 'AbortError';
    throw e;
  }
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      reject(e);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

/** work か ms か中止の早い方で解ける（work の失敗は飲む）。 */
async function raceTimeout(work: Promise<void>, ms: number, signal: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let onAbort: (() => void) | null = null;
  try {
    await Promise.race([
      work.catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
      new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        onAbort = () => resolve();
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
    if (onAbort !== null) signal.removeEventListener('abort', onAbort);
  }
}

export function createDiscussionContent(deps: DiscussionContentDeps): DiscussionGenerator {
  return new DiscussionGenerator(deps);
}
