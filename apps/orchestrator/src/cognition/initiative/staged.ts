/**
 * 発話希望の二段判定（docs/initiative_v3_design.md）。InitiativeMonitor の増分の起動から呼ばれる。
 *
 *   生成段（desire）: 言いたいことが生じたか、その内容だけを判定する。「今言うべきか」は判定しない。
 *   タイミング段（timing）: 未解決の希望を「話の途中で申し出る／話し終わりまで待つ／取り下げる」に分ける。
 *     方式は llm（希望があるときだけ2回目の呼び出し）、immediate（比較用、LLM を呼ばず次の機会に申し出る）。
 *     v2（既存の1段判定）はここを通らない。
 *
 * - 2つの段はプロンプト、出力の形、ログのイベント（initiative.desire、initiative.timing）を分ける。
 * - E2a（CandidateLedger）の入口は既存の applyModelDecision のまま。NEW と REVISE は生成段、WITHDRAW と KEEP はタイミング段が渡す。
 *   KEEP は「判定が古くない」の基準（last_request_id）を進めるためにも要る。
 * - タイミング段の判定は候補に結びついた値として持ち、合図の許可でも発声の許可でもない（第2段階で negotiator が読む）。
 * - LLM が書いた理由は ModelOutput で包み、ゲートは読まない。
 * - 根拠の範囲: evidence_span は今話している側の安定テキストだけに照合する（E2a の照合と同じ）。
 *   過去のターンは prior_turn_evidence_span で文脈として示せるが、単独では根拠にならず、照合に失敗したら棄却する。
 */
import { absent, modelOutput, modelOutputAbsent, present, verified } from '@llm-vap/contracts';
import type {
  CandidateRecord,
  CandidateRef,
  ConversationHistoryReader,
  EventEmitter,
  LlmProvider,
  LlmResult,
  MaybeModelOutput,
  TimeSource,
  TimingStrategy,
  TimingVerdict,
} from '@llm-vap/contracts';
import type { CandidateContent, CandidateModelNotes, DecisionMeta, DecisionResult, ModelDecision } from '../../control/candidates/types';
import type { ConversationKindProfile } from './conversation_kind';
import { failureReason } from './failure';
import { checkEvidence, checkFreshness, checkPriorTurnEvidence, checkWithdrawEvidence } from './gate';
import { recentTurnsFromHistory } from './recent_turns';
import type { RecentContextLimits, RecentTurn } from './recent_turns';
import { DESIRE_JSON_SCHEMA, TIMING_JSON_SCHEMA, parseDesireOutput, parseTimingOutput } from './staged_output';
import type { DesireOutput, TimingOutput } from './staged_output';
import { CURRENT_DESIRE_PROMPT_VERSION, CURRENT_TIMING_PROMPT_VERSION, getDesirePrompt, getTimingPrompt } from './staged_prompt';
import type { StagedPromptVersion } from './staged_prompt';
import { normalizeForMatch } from './text';
import type { AsrSegmentSnapshot } from './transcript_view';

export interface StagedOptions {
  timing_strategy: TimingStrategy;
  profile: ConversationKindProfile;
  recent_context: RecentContextLimits;
  /** 省略は現在の版。 */
  desire_prompt_version?: string;
  timing_prompt_version?: string;
  /** タイミング段の LLM。省略は生成段と同じ。 */
  timing_llm?: LlmProvider;
  /** 直近の会話の取り出し元。省略は直近の会話を渡さない（履歴を配線するまでの状態）。 */
  history?: Pick<ConversationHistoryReader, 'snapshot' | 'version'>;
}

/** 1回の判定の入力（段ごとに作り直す）。 */
export interface StagedInput {
  request_id: string;
  segments: AsrSegmentSnapshot[];
  candidates: readonly CandidateRecord[];
  stable_chars: number;
  transcript_revision: number;
  segment_id: number;
  sent_at: number;
}

/** InitiativeMonitor が持つ部分（起動、失敗の待ち、回数の上限）。 */
export interface StagedHost<I extends StagedInput> {
  isStopped(): boolean;
  snapshot(): AsrSegmentSnapshot[];
  totalStableChars(): number;
  limits: { max_new_stable_chars_since_input: number; max_result_age_ms: number };
  clearFailures(): void;
  onDesireFailure(input: I, reason: string): void;
  onTimingFailure(input: I, reason: string, candidate_id: string): void;
  /** 鮮度の上限を超えた結果を棄てたので、最新の入力で再判定する。 */
  markStale(): void;
  /** 回数の上限に達していたら null（上限の報告は監視が1回出す）。 */
  newTimingInput(desire_request_id: string): I | null;
  prepareSpeech(ref: CandidateRef, input: I, utterance: string): void;
}

export interface StagedDeps {
  llm: LlmProvider;
  ledger: {
    applyModelDecision(d: ModelDecision): DecisionResult;
    list(): readonly CandidateRecord[];
  };
  emitter: EventEmitter;
  time: TimeSource;
  options: StagedOptions;
}

/** 候補の最新のタイミング段の判定。第2段階で negotiator が読む。 */
export interface LatestTiming {
  timing: Exclude<TimingVerdict, 'WITHDRAW'>;
  strategy: Exclude<TimingStrategy, 'v2'>;
  candidate_version: number;
  request_id: string;
  decided_at: number;
}

interface StageContext {
  turns: readonly RecentTurn[];
  history_version: { value: number } | { value: null; null_reason: string };
}

/** タイミング段が判定する対象。発話中の候補は判定しない。 */
function judgeableCandidate(list: readonly CandidateRecord[]): CandidateRecord | null {
  const judgeable = list.filter((c) => c.state !== 'SPEAKING');
  return judgeable.length > 0 ? judgeable[judgeable.length - 1]! : null;
}

function maybeText(value: string): MaybeModelOutput<string> {
  return value ? modelOutput(value) : modelOutputAbsent('model_left_empty');
}

const NOT_JUDGED_HERE = 'judged_by_timing_stage';
const ACCEPTED = absent('accepted');

export class StagedPipeline<I extends StagedInput> {
  private readonly desirePrompt: StagedPromptVersion;
  private readonly timingPrompt: StagedPromptVersion;
  private readonly strategy: Exclude<TimingStrategy, 'v2'>;
  private readonly timingLlm: LlmProvider;
  private readonly verdicts = new Map<string, LatestTiming>();
  private held: { input: I; output: DesireOutput; result: LlmResult; received_at: number; context: StageContext } | null = null;

  constructor(
    private readonly deps: StagedDeps,
    private readonly host: StagedHost<I>,
  ) {
    const options = deps.options;
    if (options.timing_strategy === 'v2') throw new Error('timing_strategy=v2 does not use the staged pipeline');
    this.strategy = options.timing_strategy;
    this.desirePrompt = getDesirePrompt(options.desire_prompt_version ?? CURRENT_DESIRE_PROMPT_VERSION);
    this.timingPrompt = getTimingPrompt(options.timing_prompt_version ?? CURRENT_TIMING_PROMPT_VERSION);
    this.timingLlm = options.timing_llm ?? deps.llm;
  }

  latestTiming(candidate_id: string, candidate_version: number): LatestTiming | null {
    const verdict = this.verdicts.get(candidate_id);
    return verdict && verdict.candidate_version === candidate_version ? verdict : null;
  }

  /** 増分の起動の1回。生成段のあと、未解決の希望があればタイミング段を実行する。 */
  async run(input: I, signal: AbortSignal): Promise<void> {
    const context = this.context(input);
    const profile = this.deps.options.profile;
    let result: LlmResult;
    try {
      result = await this.deps.llm.generate({
        signal,
        request_id: input.request_id,
        purpose: 'initiative',
        system: this.desirePrompt.system(profile),
        messages: this.desirePrompt.messages({ segments: input.segments, candidates: input.candidates, recent_turns: context.turns }),
        response_json_schema: DESIRE_JSON_SCHEMA,
        transcript_revision: input.transcript_revision,
      });
    } catch (error) {
      if (this.host.isStopped()) return;
      this.host.onDesireFailure(input, `desire:${failureReason(error)}`);
      return;
    }
    if (this.host.isStopped()) return;
    const parsed = parseDesireOutput(result.text);
    if (!parsed.ok) {
      this.host.onDesireFailure(input, parsed.reason);
      return;
    }
    this.host.clearFailures();
    const stale = this.applyDesire(input, parsed.output, result, this.deps.time.monotonicMs(), context);
    // 鮮度の上限を超えた生成段の結果は棄てて再判定する。そのときタイミング段は呼ばない（1回の増分で重ねない）。
    if (stale) return;
    await this.runTiming(input, signal);
  }

  private context(input: StagedInput): StageContext {
    const history = this.deps.options.history;
    if (!history) return { turns: [], history_version: absent('history_not_wired') };
    return {
      turns: recentTurnsFromHistory(history.snapshot(), input.segment_id, this.deps.options.recent_context),
      history_version: present(history.version()),
    };
  }

  private meta(input: StagedInput, received_at: number): DecisionMeta {
    return {
      request_id: input.request_id,
      transcript_revision: input.transcript_revision,
      segment_id: input.segment_id,
      received_at,
      input_segments: input.segments,
    };
  }

  private stageMeta(input: StagedInput, result: LlmResult, received_at: number, context: StageContext, prompt: StagedPromptVersion) {
    return {
      segment_id: input.segment_id,
      transcript_revision: input.transcript_revision,
      request_id: input.request_id,
      sent_at: input.sent_at,
      received_at,
      latency_ms: Math.max(0, received_at - input.sent_at),
      model_version: result.model_version,
      prompt_version: prompt.id,
      conversation_kind: this.deps.options.profile.conversation_kind,
      profile_version: this.deps.options.profile.profile_version,
      history_version: context.history_version,
      input_segment_ids: input.segments.map((s) => s.asr_segment_id),
      recent_turn_count: context.turns.length,
    };
  }

  // ---- 生成段 --------------------------------------------------------------

  private freshnessReasons(input: StagedInput): string[] {
    const check = checkFreshness({
      new_stable_chars_since_input: Math.max(0, this.host.totalStableChars() - input.stable_chars),
      age_ms: this.deps.time.monotonicMs() - input.sent_at,
      max_new_stable_chars_since_input: this.host.limits.max_new_stable_chars_since_input,
      max_result_age_ms: this.host.limits.max_result_age_ms,
    });
    return check.ok ? [] : check.reasons;
  }

  /** 戻り値は「鮮度の上限を超えて棄てた」か。 */
  private applyDesire(input: I, output: DesireOutput, result: LlmResult, received_at: number, context: StageContext): boolean {
    if (output.desire === 'NONE') {
      const applied = this.deps.ledger.applyModelDecision({ decision: 'NONE', ...this.meta(input, received_at) });
      this.emitDesire(input, output, result, received_at, context, {
        ref: null,
        evidence_segment_ids: null,
        prior_found: null,
        gate_reasons: [],
        outcome: applied.ok ? 'none' : 'rejected',
        ledger_reason: applied.ok ? ACCEPTED : present(applied.reason),
      });
      return false;
    }

    const reasons: string[] = [];
    const evidence = checkEvidence({
      span: output.evidence_span,
      segment_ids: output.evidence_segment_ids,
      input: input.segments,
      latest: this.host.snapshot(),
    });
    if (!evidence.ok) reasons.push(...evidence.reasons);
    const prior = checkPriorTurnEvidence({ span: output.prior_turn_evidence_span, turns: context.turns, current: input.segments });
    if (!prior.ok) reasons.push(...prior.reasons);
    if (normalizeForMatch(output.proposed_utterance).length === 0) reasons.push('proposed_utterance_empty');
    const target = output.desire === 'REVISE' ? input.candidates.find((c) => c.candidate_id === output.target_candidate_id) : undefined;
    if (output.desire === 'REVISE' && !target) reasons.push('target_candidate_not_in_input');
    const stale = this.freshnessReasons(input);
    reasons.push(...stale);
    if (stale.length > 0) this.host.markStale();
    if (reasons.length > 0) {
      this.emitDesire(input, output, result, received_at, context, {
        ref: null,
        evidence_segment_ids: null,
        prior_found: null,
        gate_reasons: reasons,
        outcome: 'gate_rejected',
        ledger_reason: absent('gate_rejected'),
      });
      return stale.length > 0;
    }

    const priorFound = prior.ok ? prior.found : null;
    const content = this.content(output, target);
    const notes = this.notes(output);
    const applied =
      output.desire === 'NEW'
        ? this.deps.ledger.applyModelDecision({ decision: 'NEW', ...this.meta(input, received_at), content, notes })
        : this.deps.ledger.applyModelDecision({
            decision: 'REVISE',
            ...this.meta(input, received_at),
            target: { candidate_id: target!.candidate_id, candidate_version: target!.candidate_version },
            content,
            notes,
          });
    if (!applied.ok) {
      if (applied.held) this.held = { input, output, result, received_at, context };
      this.emitDesire(input, output, result, received_at, context, {
        ref: applied.ref,
        evidence_segment_ids: null,
        prior_found: priorFound,
        gate_reasons: [],
        outcome: applied.held ? 'held' : 'rejected',
        ledger_reason: present(applied.reason),
      });
      return false;
    }
    const ref = applied.ref as CandidateRef;
    this.emitDesire(input, output, result, received_at, context, {
      ref,
      evidence_segment_ids: applied.evidence_segment_ids,
      prior_found: priorFound,
      gate_reasons: [],
      outcome: output.desire === 'NEW' ? 'registered' : 'revised',
      ledger_reason: ACCEPTED,
    });
    this.host.prepareSpeech(ref, input, output.proposed_utterance);
    return false;
  }

  /** E2a が保留を解いた結果。保留の理由は受け取った時点で initiative.desire に残してある。 */
  onHeldPromoted(promotion: { request_id: string; result: DecisionResult }, _at: number): void {
    const held = this.held;
    this.held = null;
    if (!held || held.input.request_id !== promotion.request_id) return;
    const applied = promotion.result;
    if (!applied.ok) {
      this.emitDesire(held.input, held.output, held.result, held.received_at, held.context, {
        ref: applied.ref,
        evidence_segment_ids: null,
        prior_found: null,
        gate_reasons: [],
        outcome: 'rejected',
        ledger_reason: present(`held_promotion:${applied.reason}`),
      });
      return;
    }
    const ref = applied.ref as CandidateRef;
    this.emitDesire(held.input, held.output, held.result, held.received_at, held.context, {
      ref,
      evidence_segment_ids: applied.evidence_segment_ids,
      prior_found: null,
      gate_reasons: [],
      outcome: 'held_promoted',
      ledger_reason: ACCEPTED,
    });
    this.host.prepareSpeech(ref, held.input, held.output.proposed_utterance);
  }

  private content(output: DesireOutput, fallback?: CandidateRecord): CandidateContent {
    return {
      intent_type: output.intent_type || fallback?.intent_type || 'UNSPECIFIED',
      evidence_span: output.evidence_span,
      evidence_segment_ids: output.evidence_segment_ids,
      proposed_utterance: output.proposed_utterance,
      // 生成段は期限と緊急度を判定しない（数値の度合いも足さない）。候補の項目を埋めるコードの固定値。
      expiry_policy: 'RECHECK_ON_NEW_INFORMATION',
      urgency: 'NORMAL',
    };
  }

  private notes(output: DesireOutput): CandidateModelNotes {
    return {
      reason: maybeText(output.reason),
      why_now: modelOutputAbsent(NOT_JUDGED_HERE),
      cost_of_waiting: modelOutputAbsent(NOT_JUDGED_HERE),
    };
  }

  private emitDesire(
    input: I,
    output: DesireOutput,
    result: LlmResult,
    received_at: number,
    context: StageContext,
    fields: {
      ref: CandidateRef | null;
      evidence_segment_ids: { source: 'verified'; value: number[]; method: string } | null;
      prior_found: { turn_index: number; role: RecentTurn['role'] } | null;
      gate_reasons: string[];
      outcome: 'none' | 'registered' | 'revised' | 'gate_rejected' | 'held' | 'held_promoted' | 'rejected';
      ledger_reason: { value: string } | { value: null; null_reason: string };
    },
  ): void {
    const ref = fields.ref;
    this.deps.emitter.emit({
      event: 'initiative.desire',
      ...this.stageMeta(input, result, received_at, context, this.desirePrompt),
      desire: output.desire,
      candidate_id: ref ? present(ref.candidate_id) : absent('not_numbered'),
      candidate_version: ref ? present(ref.candidate_version) : absent('not_numbered'),
      intent_type: maybeText(output.intent_type),
      proposed_utterance: maybeText(output.proposed_utterance),
      evidence_span: maybeText(output.evidence_span),
      reason: maybeText(output.reason),
      evidence_segment_ids: fields.evidence_segment_ids ? present(fields.evidence_segment_ids) : absent('not_applied'),
      prior_turn_evidence_span: maybeText(output.prior_turn_evidence_span),
      prior_turn_evidence: fields.prior_found
        ? present(verified(fields.prior_found, 'normalized_substring_of_shown_turn'))
        : absent('no_prior_turn_evidence'),
      gate: verified({ passed: fields.gate_reasons.length === 0, reasons: fields.gate_reasons }, 'stage_gate'),
      outcome: fields.outcome,
      ledger_reason: fields.ledger_reason,
    });
  }

  // ---- タイミング段 --------------------------------------------------------

  private async runTiming(desire: I, signal: AbortSignal): Promise<void> {
    const target = judgeableCandidate(this.deps.ledger.list());
    if (!target) return;
    if (this.strategy === 'immediate') {
      this.applyImmediate(desire, target);
      return;
    }
    const input = this.host.newTimingInput(desire.request_id);
    if (!input) return;
    const context = this.context(input);
    let result: LlmResult;
    try {
      result = await this.timingLlm.generate({
        signal,
        request_id: input.request_id,
        purpose: 'initiative',
        system: this.timingPrompt.system(this.deps.options.profile),
        messages: this.timingPrompt.messages({ segments: input.segments, candidates: [target], recent_turns: context.turns }),
        response_json_schema: TIMING_JSON_SCHEMA,
        transcript_revision: input.transcript_revision,
      });
    } catch (error) {
      if (this.host.isStopped()) return;
      this.host.onTimingFailure(input, `timing:${failureReason(error)}`, target.candidate_id);
      return;
    }
    if (this.host.isStopped()) return;
    const parsed = parseTimingOutput(result.text);
    if (!parsed.ok) {
      this.host.onTimingFailure(input, parsed.reason, target.candidate_id);
      return;
    }
    this.host.clearFailures();
    this.applyTiming(desire, input, target, parsed.output, result, this.deps.time.monotonicMs(), context);
  }

  /** immediate: LLM を呼ばず、希望が残っている間は次の機会に申し出る。比較用。 */
  private applyImmediate(desire: I, target: CandidateRecord): void {
    const now = this.deps.time.monotonicMs();
    const ref = { candidate_id: target.candidate_id, candidate_version: target.candidate_version };
    // 判定の鮮度の基準（last_request_id）を進め、根拠の消失を E2a に確かめさせるために KEEP を渡す。
    const applied = this.deps.ledger.applyModelDecision({ decision: 'KEEP', ...this.meta(desire, now), target: ref });
    const withdrawn = applied.ok && applied.to === 'WITHDRAWN';
    this.deps.emitter.emit({
      event: 'initiative.timing',
      timing_strategy: 'immediate',
      timing: 'OFFER_NOW',
      candidate_id: target.candidate_id,
      candidate_version: target.candidate_version,
      desire_request_id: desire.request_id,
      segment_id: desire.segment_id,
      transcript_revision: desire.transcript_revision,
      conversation_kind: this.deps.options.profile.conversation_kind,
      profile_version: this.deps.options.profile.profile_version,
      decided_at: now,
      model_call: false,
      outcome: !applied.ok ? 'rejected' : withdrawn ? 'withdrawn' : 'kept',
      ledger_reason: applied.ok ? ACCEPTED : present(applied.reason),
    });
    if (applied.ok && !withdrawn) {
      this.remember(target, 'OFFER_NOW', desire.request_id, now);
    }
  }

  private applyTiming(
    desire: I,
    input: I,
    target: CandidateRecord,
    output: TimingOutput,
    result: LlmResult,
    received_at: number,
    context: StageContext,
  ): void {
    const ref = { candidate_id: target.candidate_id, candidate_version: target.candidate_version };
    const reasons: string[] = [];
    if (output.target_candidate_id !== target.candidate_id) reasons.push('target_candidate_not_in_input');
    if (output.timing === 'WITHDRAW') {
      // WITHDRAW は鮮度で棄却しない（安全側の判定なので。計画 §4.5 と同じ）。
      const withdrawCheck = checkWithdrawEvidence({
        span: output.withdraw_evidence_span,
        segment_ids: output.withdraw_evidence_segment_ids,
        input: input.segments,
        latest: this.host.snapshot(),
        candidate_evidence_span: target.evidence_span,
      });
      if (!withdrawCheck.ok) reasons.push(...withdrawCheck.reasons.map((r) => `withdraw_rejected:${r}`));
    } else {
      const staleReasons = this.freshnessReasons(input);
      reasons.push(...staleReasons);
      if (staleReasons.length > 0) this.host.markStale();
    }
    const base = {
      ...this.stageMeta(input, result, received_at, context, this.timingPrompt),
      timing_strategy: 'llm' as const,
      timing: output.timing,
      candidate_id: target.candidate_id,
      candidate_version: target.candidate_version,
      desire_request_id: desire.request_id,
      reason: maybeText(output.reason),
      why_now: maybeText(output.why_now),
      cost_of_waiting: maybeText(output.cost_of_waiting),
      withdraw_reason: maybeText(output.withdraw_reason),
    };
    if (reasons.length > 0) {
      this.deps.emitter.emit({
        event: 'initiative.timing',
        ...base,
        withdraw_evidence_segment_ids: absent('gate_rejected'),
        gate: verified({ passed: false, reasons }, 'stage_gate'),
        outcome: 'gate_rejected',
        ledger_reason: absent('gate_rejected'),
      });
      return;
    }

    if (output.timing === 'WITHDRAW') {
      const applied = this.deps.ledger.applyModelDecision({
        decision: 'WITHDRAW',
        ...this.meta(input, received_at),
        target: ref,
        withdraw_evidence_span: output.withdraw_evidence_span,
        withdraw_evidence_segment_ids: output.withdraw_evidence_segment_ids,
        withdraw_reason: maybeText(output.withdraw_reason),
      });
      this.deps.emitter.emit({
        event: 'initiative.timing',
        ...base,
        withdraw_evidence_segment_ids:
          applied.ok && applied.withdraw_evidence_segment_ids ? present(applied.withdraw_evidence_segment_ids) : absent('not_applied'),
        gate: verified({ passed: true, reasons: [] }, 'stage_gate'),
        outcome: applied.ok ? 'withdrawn' : 'rejected',
        ledger_reason: applied.ok ? ACCEPTED : present(applied.reason),
      });
      if (applied.ok) this.verdicts.delete(target.candidate_id);
      return;
    }

    // OFFER_NOW と WAIT_FOR_TURN_END は候補の内容を変えない。判定の鮮度の基準を進めるために KEEP を渡す。
    const applied = this.deps.ledger.applyModelDecision({ decision: 'KEEP', ...this.meta(input, received_at), target: ref });
    const withdrawn = applied.ok && applied.to === 'WITHDRAWN';
    this.deps.emitter.emit({
      event: 'initiative.timing',
      ...base,
      withdraw_evidence_segment_ids: absent('not_withdraw'),
      gate: verified({ passed: true, reasons: [] }, 'stage_gate'),
      outcome: !applied.ok ? 'rejected' : withdrawn ? 'withdrawn' : 'kept',
      ledger_reason: applied.ok ? ACCEPTED : present(applied.reason),
    });
    if (applied.ok && !withdrawn) this.remember(target, output.timing, input.request_id, received_at);
  }

  private remember(target: CandidateRecord, timing: LatestTiming['timing'], request_id: string, decided_at: number): void {
    this.verdicts.set(target.candidate_id, {
      timing,
      strategy: this.strategy,
      candidate_version: target.candidate_version,
      request_id,
      decided_at,
    });
  }
}
