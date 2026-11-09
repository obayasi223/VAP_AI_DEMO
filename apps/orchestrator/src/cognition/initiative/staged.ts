/**
 * 発話希望の二段判定（docs/initiative_v3_design.md）。InitiativeMonitor の増分の起動から呼ばれる。
 *
 *   生成段（desire）: 言いたいことが生じたか（NONE／NEW）と、未解決の希望の内容がどうなったか（KEEP／REVISE／WITHDRAW）を判定する。
 *     「今言うべきか」は判定しない。
 *   タイミング段（timing）: 未解決の希望を「話の途中で申し出る／話し終わりまで待つ」に分ける。希望を消さない。
 *     方式は llm（希望があるときだけ2回目の呼び出し）、immediate（比較用、LLM を呼ばず次の機会に申し出る）。
 *     v2（既存の1段判定）はここを通らない。
 *
 * - 2つの段はプロンプト、出力の形、ログのイベント（initiative.desire、initiative.timing）を分ける。
 * - E2a（CandidateLedger）の入口は既存の applyModelDecision のまま。NEW／KEEP／REVISE／WITHDRAW はすべて生成段が渡す。
 *   KEEP は「判定が古くない」の基準（last_request_id）を進めるためにも要る。タイミング段は E2a を変えない。
 * - REVISE でも内容が実質同じなら（revise_min_utterance_similarity）維持として扱い、音声を作り直さない。基準は記録する。
 * - タイミング段の判定は候補に結びついた値として持ち、合図の許可でも発声の許可でもない（negotiator が読む）。
 * - LLM が書いた理由は ModelOutput で包み、ゲートは読まない。
 * - 根拠の範囲: evidence_span は今話している側の安定テキストだけに照合する（E2a の照合と同じ）。
 *   過去のターンは prior_turn_evidence_span で文脈として示せるが、単独では根拠にならず、照合に失敗したら棄却する。
 * - 撤回の根拠は人の発話か、生成段に見せた AI の発話（実際に声に出た部分）の逐語。どちらで確かめたかを記録する（設計メモ §1）。
 * - NEW は AI がすでに話した内容と同じなら棄却して理由を残す（already_said）。AI の発話に限り、人の発話の変化は見ない。
 */
import { ContentWithdrawKind, absent, modelOutput, modelOutputAbsent, present, verified } from '@llm-vap/contracts';
import type {
  CandidateRecord,
  CandidateRef,
  ConversationHistoryReader,
  EventEmitter,
  InitiativeDesireOutcome,
  LlmProvider,
  LlmResult,
  MaybeModelOutput,
  OfferView,
  TimeSource,
  TimingStrategy,
  WithdrawEvidenceSource,
} from '@llm-vap/contracts';
import type { CandidateContent, CandidateModelNotes, DecisionMeta, DecisionResult, ModelDecision } from '../../control/candidates/types';
import type { ConversationKindProfile } from './conversation_kind';
import { findAlreadySaid } from './already_said';
import type { AlreadySaidMatch } from './already_said';
import type { OfferObservations } from './offer_view';
import { failureReason } from './failure';
import { SIMILARITY_METHOD, charNgramCosine } from '../similarity';
import { checkAiWithdrawEvidence, checkEvidence, checkFreshness, checkPriorTurnEvidence, checkWithdrawEvidence } from './gate';
import { recentTurnsFromHistory } from './recent_turns';
import type { RecentContextLimits, RecentTurn } from './recent_turns';
import { DESIRE_JSON_SCHEMA, TIMING_JSON_SCHEMA, parseDesireOutput, parseTimingOutput } from './staged_output';
import type { DesireOutput, TimingChoice, TimingOutput } from './staged_output';
import { CURRENT_DESIRE_PROMPT_VERSION, CURRENT_TIMING_PROMPT_VERSION, getDesirePrompt, getTimingPrompt } from './staged_prompt';
import type { StagedPromptVersion } from './staged_prompt';
import { normalizeForMatch } from './text';
import type { PromptCandidate } from './prompt';
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
  /** REVISE を維持として扱う proposed_utterance の類似度の下限（policy.initiative.staged の暫定値）。省略は比較しない。 */
  revise_min_utterance_similarity?: number;
  /** AI がすでに話した内容と同じ NEW を棄却する類似度の下限（policy.initiative.staged の暫定値）。省略は棄却しない。 */
  already_said_min_similarity?: number;
  /** 申し出の状況の読み出し（InitiativeWiring が渡す）。省略は載せない。 */
  offers?: Pick<OfferObservations, 'view'>;
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

/** 候補の最新のタイミング段の判定。negotiator が読む。 */
export interface LatestTiming {
  timing: TimingChoice;
  strategy: Exclude<TimingStrategy, 'v2'>;
  candidate_version: number;
  request_id: string;
  decided_at: number;
}

/** REVISE の前後の比較（コードの基準。記録するだけでなく、維持として扱うかの判断に使う）。 */
interface ReviseComparison {
  method: string;
  similarity: number;
  threshold: number;
  same_intent_type: boolean;
}

interface StageContext {
  turns: readonly RecentTurn[];
  history_version: { value: number } | { value: null; null_reason: string };
  /** この判定のプロンプトに載せた申し出の状況。要求を送る時点で作り、結果の記録まで同じ値を持つ。 */
  offers: { value: (OfferView & { candidate_id: string; candidate_version: number })[] } | { value: null; null_reason: string };
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
    const context = this.context(input, this.desirePrompt);
    const profile = this.deps.options.profile;
    let result: LlmResult;
    try {
      result = await this.deps.llm.generate({
        signal,
        request_id: input.request_id,
        purpose: 'initiative',
        system: this.desirePrompt.system(profile),
        messages: this.desirePrompt.messages({ segments: input.segments, candidates: this.withOffers(input.candidates, context), recent_turns: context.turns }),
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

  private context(input: StagedInput, prompt: StagedPromptVersion): StageContext {
    const history = this.deps.options.history;
    const offers = this.offerViews(input, prompt);
    if (!history) return { turns: [], history_version: absent('history_not_wired'), offers };
    return {
      turns: recentTurnsFromHistory(history.snapshot(), input.segment_id, this.deps.options.recent_context),
      history_version: present(history.version()),
      offers,
    };
  }

  private offerViews(input: StagedInput, prompt: StagedPromptVersion): StageContext['offers'] {
    if (!prompt.shows_offer) return absent('prompt_version_does_not_show_offer');
    const source = this.deps.options.offers;
    if (!source) return absent('offer_source_not_wired');
    return present(input.candidates.map((c) => ({ candidate_id: c.candidate_id, candidate_version: c.candidate_version, ...source.view(c.candidate_id, input.sent_at) })));
  }

  private withOffers(candidates: readonly CandidateRecord[], context: StageContext): PromptCandidate[] {
    return candidates.map((c) => {
      const entry = context.offers.value?.find((o) => o.candidate_id === c.candidate_id);
      if (!entry) return c;
      const { candidate_id: _id, candidate_version: _version, ...offer } = entry;
      return { ...c, offer };
    });
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
    // 未解決の希望があるときの NONE は「内容は変わらない」（プロンプトは KEEP を求めている）。維持として扱う。
    const implicitKeep = output.desire === 'NONE' ? judgeableCandidate(input.candidates) : null;
    if (output.desire === 'NONE' && implicitKeep === null) {
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
    if (output.desire === 'KEEP' || implicitKeep !== null) return this.applyContentKeep(input, output, result, received_at, context, implicitKeep);
    if (output.desire === 'WITHDRAW') {
      this.applyContentWithdraw(input, output, result, received_at, context);
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
    const alreadySaid = output.desire === 'NEW' ? this.findAlreadySaid(output.proposed_utterance) : null;
    if (alreadySaid) reasons.push('already_said');
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
        ...(alreadySaid ? { already_said: alreadySaid } : {}),
      });
      return stale.length > 0;
    }

    const priorFound = prior.ok ? prior.found : null;
    const comparison = target ? this.reviseComparison(output, target) : null;
    // REVISE でも内容が実質同じなら作り直さない（既知の問題: 小さな言い換えの繰り返しで音声を作り直していた）。根拠は通っている。
    if (target && comparison !== null && comparison.same_intent_type && comparison.similarity >= comparison.threshold) {
      const ref = { candidate_id: target.candidate_id, candidate_version: target.candidate_version };
      const kept = this.deps.ledger.applyModelDecision({ decision: 'KEEP', ...this.meta(input, received_at), target: ref });
      const lost = kept.ok && kept.to === 'WITHDRAWN';
      this.emitDesire(input, output, result, received_at, context, {
        ref: kept.ok ? ref : (kept.ref ?? ref),
        evidence_segment_ids: null,
        prior_found: priorFound,
        gate_reasons: [],
        outcome: !kept.ok ? 'rejected' : lost ? 'kept_evidence_lost' : 'revise_suppressed',
        ledger_reason: kept.ok ? ACCEPTED : present(kept.reason),
        revise_comparison: comparison,
      });
      return false;
    }
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
        ...(comparison !== null ? { revise_comparison: comparison } : {}),
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
      ...(comparison !== null ? { revise_comparison: comparison } : {}),
    });
    this.host.prepareSpeech(ref, input, output.proposed_utterance);
    return false;
  }

  /** AI がすでに話した内容か（NEW の棄却）。基準か履歴がなければ比較しない。 */
  private findAlreadySaid(utterance: string): AlreadySaidMatch | null {
    const threshold = this.deps.options.already_said_min_similarity;
    const history = this.deps.options.history;
    if (threshold === undefined || !history) return null;
    return findAlreadySaid(utterance, history.snapshot(), threshold);
  }

  /** REVISE の前後の比較（proposed_utterance の文字 2-gram のコサインと意図の種類）。基準が未設定なら null。 */
  private reviseComparison(output: DesireOutput, target: CandidateRecord): ReviseComparison | null {
    const threshold = this.deps.options.revise_min_utterance_similarity;
    if (threshold === undefined) return null;
    return {
      method: SIMILARITY_METHOD,
      similarity: Math.min(1, charNgramCosine(target.proposed_utterance, output.proposed_utterance)),
      threshold,
      same_intent_type: output.intent_type === '' || output.intent_type === target.intent_type,
    };
  }

  /** 内容の維持（KEEP）。鮮度を超えた結果は棄てて再判定する。E2a が根拠の残存を確かめる。 */
  private applyContentKeep(input: I, output: DesireOutput, result: LlmResult, received_at: number, context: StageContext, implicit: CandidateRecord | null): boolean {
    const target = implicit ?? input.candidates.find((c) => c.candidate_id === output.target_candidate_id);
    const stale = this.freshnessReasons(input);
    if (stale.length > 0) this.host.markStale();
    if (!target || stale.length > 0) {
      this.emitDesire(input, output, result, received_at, context, {
        ref: null,
        evidence_segment_ids: null,
        prior_found: null,
        gate_reasons: [...(target ? [] : ['target_candidate_not_in_input']), ...stale],
        outcome: 'gate_rejected',
        ledger_reason: absent('gate_rejected'),
      });
      return stale.length > 0;
    }
    const ref = { candidate_id: target.candidate_id, candidate_version: target.candidate_version };
    const kept = this.deps.ledger.applyModelDecision({ decision: 'KEEP', ...this.meta(input, received_at), target: ref });
    const lost = kept.ok && kept.to === 'WITHDRAWN';
    this.emitDesire(input, output, result, received_at, context, {
      ref: kept.ok ? ref : (kept.ref ?? ref),
      evidence_segment_ids: null,
      prior_found: null,
      gate_reasons: [],
      outcome: !kept.ok ? 'rejected' : lost ? 'kept_evidence_lost' : 'kept',
      ledger_reason: kept.ok ? ACCEPTED : present(kept.reason),
    });
    return false;
  }

  /** 内容の撤回（WITHDRAW、分類つき）。タイミングの「今は言わない」とは別の経路。鮮度では棄却しない（安全側の判定なので）。 */
  private applyContentWithdraw(input: I, output: DesireOutput, result: LlmResult, received_at: number, context: StageContext): void {
    const target = input.candidates.find((c) => c.candidate_id === output.target_candidate_id);
    const reasons: string[] = [];
    if (!target) reasons.push('target_candidate_not_in_input');
    const kind = ContentWithdrawKind.safeParse(output.withdraw_kind);
    if (!kind.success) reasons.push('withdraw_kind_invalid');
    let evidenceSource: WithdrawEvidenceSource = 'user_utterance';
    let aiTurns: string[] | undefined;
    if (target) {
      const check = checkWithdrawEvidence({
        span: output.withdraw_evidence_span,
        segment_ids: output.withdraw_evidence_segment_ids,
        input: input.segments,
        latest: this.host.snapshot(),
        candidate_evidence_span: target.evidence_span,
        ...(target.carried_over ? { candidate_carried: true } : {}),
      });
      if (!check.ok) {
        // 人の発話に根拠がなければ、見せた AI の発話で確かめる（逐語のみ）。どちらでもなければ棄却する。
        const ai = context.turns.filter((t) => t.role === 'ai').map((t) => t.text);
        const aiCheck = ai.length > 0 ? checkAiWithdrawEvidence({ span: output.withdraw_evidence_span, ai_turn_texts: ai }) : null;
        if (aiCheck?.ok) {
          evidenceSource = 'ai_utterance';
          aiTurns = ai;
        } else {
          reasons.push(...check.reasons.map((r) => `withdraw_rejected:${r}`), ...(aiCheck && !aiCheck.ok ? aiCheck.reasons.map((r) => `withdraw_rejected:${r}`) : []));
        }
      }
    }
    if (reasons.length > 0 || !target || !kind.success) {
      this.emitDesire(input, output, result, received_at, context, {
        ref: null,
        evidence_segment_ids: null,
        prior_found: null,
        gate_reasons: reasons,
        outcome: 'gate_rejected',
        ledger_reason: absent('gate_rejected'),
      });
      return;
    }
    const applied = this.deps.ledger.applyModelDecision({
      decision: 'WITHDRAW',
      ...this.meta(input, received_at),
      target: { candidate_id: target.candidate_id, candidate_version: target.candidate_version },
      withdraw_evidence_span: output.withdraw_evidence_span,
      withdraw_evidence_segment_ids: output.withdraw_evidence_segment_ids,
      withdraw_reason: maybeText(output.withdraw_reason),
      withdraw_kind: kind.data,
      ...(aiTurns ? { withdraw_evidence_ai_turns: aiTurns } : {}),
    });
    this.emitDesire(input, output, result, received_at, context, {
      ref: applied.ok ? (applied.ref as CandidateRef) : applied.ref,
      evidence_segment_ids: null,
      prior_found: null,
      gate_reasons: [],
      outcome: applied.ok ? 'withdrawn' : 'rejected',
      ledger_reason: applied.ok ? ACCEPTED : present(applied.reason),
      withdraw: { kind: kind.data, reason: output.withdraw_reason, span: output.withdraw_evidence_span, segment_ids: applied.ok ? (applied.withdraw_evidence_segment_ids ?? null) : null, source: applied.ok ? evidenceSource : null },
    });
    if (applied.ok) this.verdicts.delete(target.candidate_id);
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
      outcome: InitiativeDesireOutcome;
      ledger_reason: { value: string } | { value: null; null_reason: string };
      revise_comparison?: ReviseComparison;
      withdraw?: { kind: ContentWithdrawKind; reason: string; span: string; segment_ids: { source: 'verified'; value: number[]; method: string } | null; source: WithdrawEvidenceSource | null };
      already_said?: AlreadySaidMatch;
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
      offer_views: context.offers,
      ...(fields.revise_comparison ? { revise_comparison: verified(fields.revise_comparison, 'staged_revise_comparison') } : {}),
      ...(fields.already_said
        ? {
            already_said_comparison: verified(
              { method: fields.already_said.method, similarity: fields.already_said.similarity, threshold: fields.already_said.threshold, matched_text: fields.already_said.matched_text },
              'staged_already_said_comparison',
            ),
          }
        : {}),
      ...(output.desire === 'WITHDRAW'
        ? {
            withdraw_kind: fields.withdraw ? modelOutput(fields.withdraw.kind) : modelOutputAbsent('gate_or_ledger_rejected'),
            withdraw_reason: maybeText(output.withdraw_reason),
            withdraw_evidence_span: maybeText(output.withdraw_evidence_span),
            withdraw_evidence_segment_ids: fields.withdraw?.segment_ids ? present(fields.withdraw.segment_ids) : absent(fields.withdraw?.source === 'ai_utterance' ? 'ai_utterance_evidence' : 'not_applied'),
            ...(fields.withdraw?.source ? { withdraw_evidence_source: verified(fields.withdraw.source, 'staged_withdraw_evidence_matched_verbatim') } : {}),
          }
        : {}),
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
    const context = this.context(input, this.timingPrompt);
    let result: LlmResult;
    try {
      result = await this.timingLlm.generate({
        signal,
        request_id: input.request_id,
        purpose: 'initiative',
        system: this.timingPrompt.system(this.deps.options.profile),
        messages: this.timingPrompt.messages({ segments: input.segments, candidates: this.withOffers([target], context), recent_turns: context.turns }),
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

  /** immediate: LLM を呼ばず、希望が残っている間は次の機会に申し出る（吸気の合図のゲートへ。声は吸気の後）。E2a は変えない。 */
  private applyImmediate(desire: I, target: CandidateRecord): void {
    const now = this.deps.time.monotonicMs();
    const change = this.remember(target, 'OFFER_NOW', desire.request_id, now);
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
      outcome: 'kept',
      ledger_reason: ACCEPTED,
      ...change,
    });
  }

  /** タイミングの判定を記録する。内容（E2a）は変えない。「今は言わない」は希望を消さず、次の判定で OFFER_NOW に変わりうる。 */
  private applyTiming(
    desire: I,
    input: I,
    target: CandidateRecord,
    output: TimingOutput,
    result: LlmResult,
    received_at: number,
    context: StageContext,
  ): void {
    const reasons: string[] = [];
    if (output.target_candidate_id !== target.candidate_id) reasons.push('target_candidate_not_in_input');
    const staleReasons = this.freshnessReasons(input);
    reasons.push(...staleReasons);
    if (staleReasons.length > 0) this.host.markStale();
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
      withdraw_reason: modelOutputAbsent(NOT_JUDGED_HERE),
      withdraw_evidence_segment_ids: absent('timing_stage_does_not_withdraw'),
    };
    if (reasons.length > 0) {
      this.deps.emitter.emit({
        event: 'initiative.timing',
        ...base,
        gate: verified({ passed: false, reasons }, 'stage_gate'),
        outcome: 'gate_rejected',
        ledger_reason: absent('gate_rejected'),
      });
      return;
    }
    // 判定の間に候補が解決したか版が進んでいれば、判定を残さない（E2a を変えないので、ここで確かめる）。
    const current = this.deps.ledger.list().find((c) => c.candidate_id === target.candidate_id && c.candidate_version === target.candidate_version);
    if (!current) {
      this.deps.emitter.emit({
        event: 'initiative.timing',
        ...base,
        gate: verified({ passed: true, reasons: [] }, 'stage_gate'),
        outcome: 'rejected',
        ledger_reason: present('candidate_no_longer_pending'),
      });
      return;
    }
    const change = this.remember(target, output.timing, input.request_id, received_at);
    this.deps.emitter.emit({
      event: 'initiative.timing',
      ...base,
      gate: verified({ passed: true, reasons: [] }, 'stage_gate'),
      outcome: 'kept',
      ledger_reason: ACCEPTED,
      ...change,
    });
  }

  /** 候補の最新の判定を更新し、直前の判定との違いを返す（発話中のタイミングの扱いの時系列を initiative.timing に残す）。 */
  private remember(target: CandidateRecord, timing: LatestTiming['timing'], request_id: string, decided_at: number): { previous_timing: LatestTiming['timing'] | null; timing_changed: boolean } {
    const previous = this.verdicts.get(target.candidate_id)?.timing ?? null;
    this.verdicts.set(target.candidate_id, {
      timing,
      strategy: this.strategy,
      candidate_version: target.candidate_version,
      request_id,
      decided_at,
    });
    return { previous_timing: previous, timing_changed: previous !== null && previous !== timing };
  }
}
