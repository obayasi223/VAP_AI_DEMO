/**
 * InitiativeMonitor（計画 §4.5）。
 *
 * - 増分で起動する。ターン完了確率にも固定周期にも依存しない。
 * - 実行中の要求は最後まで走らせ、完了後に新しい増分があれば最新の入力で1回実行する。
 * - モデルの出力は gate.ts を通ったものだけを候補ストアへ渡す。
 * - NEW は合図の許可ではない。合図のゲートと発話の許可は E が持つ。
 *
 * 暫定の範囲（S。波2で G へ移管）: candidate.state_changed の発行は本来 E。
 * E2a が入るまではストアの double に発行の機能がないので、ここから出している。
 * 活動中の候補があるときの NEW の棄却も、E2 の合図のゲートが入るまでの代役。
 */
import { CandidateConflictError, absent, modelOutput, modelOutputAbsent, present, verified } from '@llm-vap/contracts';
import type {
  CandidateCause,
  CandidateRecord,
  CandidateStore,
  EventEmitter,
  InitiativeTrigger,
  LlmProvider,
  LlmResult,
  PreparedSpeech,
  SpeechGenerator,
  TimeSource,
} from '@llm-vap/contracts';
import { checkEvidence, checkFreshness, checkTarget, checkWithdrawEvidence } from './gate';
import { INITIATIVE_JSON_SCHEMA, parseModelOutput } from './model_output';
import type { InitiativeModelOutput } from './model_output';
import type { InitiativePersona } from './persona';
import { CURRENT_PROMPT_VERSION, getPrompt } from './prompt';
import { normalizeForMatch } from './text';
import { StableTranscriptView } from './transcript_view';
import type { AsrSegmentSnapshot, StableMode, SttEvent } from './transcript_view';

/** policy.ja.json の initiative 節のうち、ここで読む値。null（未校正）のまま起動しない。 */
export interface InitiativeLimits {
  max_new_stable_chars_since_input: number | null;
  max_result_age_ms: number | null;
  min_stability: number | null;
  max_active_candidates: number;
  max_requests_per_session: number | null;
  /** 起動の条件。値は【未検証の暫定値】。 */
  trigger?: InitiativeTrigger;
}

export type TriggerOptions = InitiativeTrigger;

export type CandidateSpeechPort = Pick<SpeechGenerator, 'prepare' | 'cancel'>;

export interface InitiativeMonitorDeps {
  llm: LlmProvider;
  store: CandidateStore;
  emitter: EventEmitter;
  time: TimeSource;
  persona: InitiativePersona;
  limits: InitiativeLimits;
  /** limits.trigger（policy）より優先する。試験とスパイクの比較用。 */
  trigger?: TriggerOptions;
  prompt_version?: string;
  stable_mode?: StableMode;
  /** 候補の先行音声。撤回と改訂で未再生の音声を破棄する（計画 §4.6）。本体は D と E。 */
  speech?: CandidateSpeechPort;
  /** 入力に載せる直近の区間の文字数の上限。長い話で要求が際限なく大きくならないように。 */
  max_input_chars?: number;
}

interface RunInput {
  request_id: string;
  segments: AsrSegmentSnapshot[];
  candidates: CandidateRecord[];
  stable_chars: number;
  transcript_revision: number;
  segment_id: number;
  sent_at: number;
}

function required(value: number | null, name: string): number {
  if (value === null) throw new Error(`policy.initiative.${name} is uncalibrated (null)`);
  return value;
}

export class InitiativeMonitor {
  private readonly view: StableTranscriptView;
  private readonly trigger: TriggerOptions;
  private readonly promptVersion: string;
  private readonly maxNewChars: number;
  private readonly maxAgeMs: number;
  private readonly maxRequests: number;
  private readonly maxInputChars: number;
  private readonly speechByCandidate = new Map<string, PreparedSpeech>();

  private running: Promise<void> | null = null;
  private forceRerun = false;
  private boundaryPending = false;
  private lastInputChars = 0;
  private lastInputBoundaries = 0;
  private requestSeq = 0;
  private limitReported = false;

  constructor(private readonly deps: InitiativeMonitorDeps) {
    const { limits } = deps;
    this.view = new StableTranscriptView({
      min_stability: required(limits.min_stability, 'min_stability'),
      mode: deps.stable_mode ?? 'high_water',
    });
    this.maxNewChars = required(limits.max_new_stable_chars_since_input, 'max_new_stable_chars_since_input');
    this.maxAgeMs = required(limits.max_result_age_ms, 'max_result_age_ms');
    this.maxRequests = required(limits.max_requests_per_session, 'max_requests_per_session');
    const trigger = deps.trigger ?? limits.trigger;
    if (!trigger) throw new Error('policy.initiative.trigger is not set');
    this.trigger = trigger;
    this.promptVersion = deps.prompt_version ?? CURRENT_PROMPT_VERSION;
    this.maxInputChars = deps.max_input_chars ?? 2000;
    getPrompt(this.promptVersion);
  }

  get prompt_version(): string {
    return this.promptVersion;
  }

  requestCount(): number {
    return this.requestSeq;
  }

  stableSnapshot(): AsrSegmentSnapshot[] {
    return this.view.snapshot();
  }

  onStt(event: SttEvent): void {
    const applied = this.view.apply(event);
    if (event.event === 'stt.final') this.boundaryPending = true;
    if (applied.rewrote_stable) this.sweepLostEvidence();
    this.maybeStart();
  }

  /** 実行中の要求と、それに続く1回が終わるまで待つ。 */
  async whenIdle(): Promise<void> {
    while (this.running) await this.running;
  }

  /** 入力の終わり。増分が残っていれば最後に1回判定する（撤回の機会を失わないため）。 */
  async finishInput(): Promise<void> {
    await this.whenIdle();
    if (this.view.totalStableChars() > this.lastInputChars) {
      this.forceRerun = true;
      this.maybeStart();
    }
    await this.whenIdle();
  }

  private shouldRun(): boolean {
    const newChars = this.view.totalStableChars() - this.lastInputChars;
    if (newChars <= 0) return false;
    if (this.forceRerun) return true;
    if (newChars >= this.trigger.min_new_stable_chars) return true;
    const atBoundary = this.trigger.min_new_chars_at_boundary;
    if (atBoundary === null) return this.boundaryPending;
    const interior = this.view.interiorSentenceBoundaries() > this.lastInputBoundaries;
    return (this.boundaryPending || interior) && newChars >= atBoundary;
  }

  private maybeStart(): void {
    if (this.running || !this.shouldRun()) return;
    if (this.requestSeq >= this.maxRequests) {
      if (!this.limitReported) {
        this.limitReported = true;
        this.deps.emitter.emit({
          event: 'provider.status',
          provider: this.deps.llm.provider,
          provider_class: this.deps.llm.provider_class,
          status: 'degraded',
          reason: present('initiative_request_limit_reached'),
          retry_attempt: 0,
          next_retry_ms: absent('limit_is_per_session'),
        });
      }
      return;
    }
    this.running = this.runOnce().finally(() => {
      this.running = null;
      this.maybeStart();
    });
  }

  private buildInput(): RunInput {
    let segments = this.view.snapshot();
    let total = segments.reduce((sum, s) => sum + s.stable_text.length, 0);
    while (segments.length > 1 && total > this.maxInputChars) {
      total -= segments[0]!.stable_text.length;
      segments = segments.slice(1);
    }
    this.requestSeq += 1;
    return {
      request_id: `ini_${String(this.requestSeq).padStart(4, '0')}`,
      segments,
      candidates: [...this.deps.store.list()],
      stable_chars: this.view.totalStableChars(),
      transcript_revision: this.view.revision(),
      segment_id: this.view.segmentId(),
      sent_at: this.deps.time.monotonicMs(),
    };
  }

  private async runOnce(): Promise<void> {
    const input = this.buildInput();
    this.lastInputChars = input.stable_chars;
    this.lastInputBoundaries = this.view.interiorSentenceBoundaries();
    this.boundaryPending = false;
    this.forceRerun = false;

    const prompt = getPrompt(this.promptVersion);
    const system = prompt.system(this.deps.persona);
    const messages = prompt.messages({ segments: input.segments, candidates: input.candidates });
    const { emitter, llm } = this.deps;
    emitter.emit({
      event: 'llm.request',
      request_id: input.request_id,
      purpose: 'initiative',
      input: {
        prompt_version: this.promptVersion,
        persona_id: this.deps.persona.persona_id,
        persona_version: this.deps.persona.version,
        segments: input.segments.map((s) => ({ ...s })),
        candidates: input.candidates.map((c) => ({
          candidate_id: c.candidate_id,
          candidate_version: c.candidate_version,
          evidence_span: c.evidence_span,
          proposed_utterance: c.proposed_utterance,
        })),
      },
      transcript_revision: input.transcript_revision,
      sent_at: input.sent_at,
      model_version: llm.model_version,
    });

    let result: LlmResult;
    try {
      result = await llm.generate({
        request_id: input.request_id,
        purpose: 'initiative',
        system,
        messages,
        response_json_schema: INITIATIVE_JSON_SCHEMA,
        transcript_revision: input.transcript_revision,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emitter.emit({
        event: 'llm.response',
        request_id: input.request_id,
        purpose: 'initiative',
        output: modelOutputAbsent(`provider_error: ${message.slice(0, 200)}`),
        transcript_revision: input.transcript_revision,
        sent_at: input.sent_at,
        received_at: this.deps.time.monotonicMs(),
        model_version: llm.model_version,
      });
      this.discard(input, null, 'provider_error');
      return;
    }

    const parsed = parseModelOutput(result.text);
    const received_at = this.deps.time.monotonicMs();
    emitter.emit({
      event: 'llm.response',
      request_id: input.request_id,
      purpose: 'initiative',
      output: parsed.ok
        ? modelOutput(JSON.parse(JSON.stringify(parsed.output)))
        : modelOutput({ unparsed_text: result.text }),
      transcript_revision: input.transcript_revision,
      sent_at: input.sent_at,
      received_at,
      model_version: result.model_version,
    });
    emitter.emit({
      event: 'cost.usage',
      provider: llm.provider,
      purpose: 'initiative',
      quantity: (result.usage.input_tokens.value ?? 0) + (result.usage.output_tokens.value ?? 0),
      unit: 'tokens',
      estimated_cost_usd: absent('price_not_applied_in_spike'),
    });
    if (!parsed.ok) {
      this.discard(input, null, parsed.reason);
      return;
    }
    this.applyDecision(input, parsed.output, result, received_at);
  }

  private applyDecision(input: RunInput, output: InitiativeModelOutput, result: LlmResult, received_at: number): void {
    switch (output.decision) {
      case 'NONE':
        this.deps.emitter.emit({
          event: 'initiative.decision',
          decision: 'NONE',
          ...this.base(input, result, received_at),
          reason: output.reason ? modelOutput(output.reason) : modelOutputAbsent('model_left_empty'),
        });
        return;
      case 'NEW':
        this.applyNew(input, output, result, received_at);
        return;
      case 'KEEP':
        this.applyKeep(input, output, result, received_at);
        return;
      case 'REVISE':
        this.applyRevise(input, output, result, received_at);
        return;
      case 'WITHDRAW':
        this.applyWithdraw(input, output, result, received_at);
        return;
    }
  }

  private base(input: RunInput, result: LlmResult, received_at: number) {
    return {
      segment_id: input.segment_id,
      transcript_revision: input.transcript_revision,
      request_id: input.request_id,
      sent_at: input.sent_at,
      received_at,
      model_version: result.model_version,
    };
  }

  /** 候補の内容を持つ判定に共通の検証。NEW と REVISE で使う。 */
  private checkContent(input: RunInput, output: InitiativeModelOutput) {
    const reasons: string[] = [];
    const evidence = checkEvidence({
      span: output.evidence_span,
      segment_ids: output.evidence_segment_ids,
      input: input.segments,
      latest: this.view.snapshot(),
    });
    if (!evidence.ok) reasons.push(...evidence.reasons);
    const freshness = checkFreshness({
      new_stable_chars_since_input: Math.max(0, this.view.totalStableChars() - input.stable_chars),
      age_ms: this.deps.time.monotonicMs() - input.sent_at,
      max_new_stable_chars_since_input: this.maxNewChars,
      max_result_age_ms: this.maxAgeMs,
    });
    if (!freshness.ok) {
      reasons.push(...freshness.reasons);
      // 超えた結果は合図せず、最新の入力で再判定する（計画 §4.5）。
      this.forceRerun = true;
    }
    if (normalizeForMatch(output.proposed_utterance).length === 0) reasons.push('proposed_utterance_empty');
    return { reasons, segment_ids: evidence.ok ? evidence.segment_ids : [] };
  }

  private applyNew(input: RunInput, output: InitiativeModelOutput, result: LlmResult, received_at: number): void {
    const { reasons, segment_ids } = this.checkContent(input, output);
    if (this.deps.store.list().length >= this.deps.limits.max_active_candidates) {
      reasons.push('active_candidate_exists');
    }
    if (reasons.length > 0) {
      this.discard(input, null, reasons.join(';'));
      return;
    }
    const decided_at = this.deps.time.monotonicMs();
    const ref = this.deps.store.register({
      segment_id: input.segment_id,
      transcript_revision: input.transcript_revision,
      intent_type: output.intent_type || 'UNSPECIFIED',
      evidence_span: output.evidence_span,
      proposed_utterance: output.proposed_utterance,
      expiry_policy: output.expiry_policy || 'RECHECK_ON_NEW_INFORMATION',
      urgency: output.urgency || 'NORMAL',
      evidence_segment_ids: segment_ids,
      decided_at,
    });
    // initiative.decision の NEW は採番の後に emit する（candidates.ts の約束）。
    this.deps.emitter.emit({
      event: 'initiative.decision',
      decision: 'NEW',
      decided_at,
      ...this.base(input, result, received_at),
      ...this.candidateBody(ref, output, segment_ids),
    });
    this.prepareSpeech(ref, input, output);
  }

  private candidateBody(
    ref: { candidate_id: string; candidate_version: number },
    output: InitiativeModelOutput,
    segment_ids: number[],
  ) {
    return {
      candidate_id: ref.candidate_id,
      candidate_version: ref.candidate_version,
      intent_type: modelOutput(output.intent_type || 'UNSPECIFIED'),
      evidence_span: modelOutput(output.evidence_span),
      reason: modelOutput(output.reason),
      why_now: output.why_now ? modelOutput(output.why_now) : modelOutputAbsent('model_left_empty'),
      cost_of_waiting: output.cost_of_waiting
        ? modelOutput(output.cost_of_waiting)
        : modelOutputAbsent('model_left_empty'),
      proposed_utterance: modelOutput(output.proposed_utterance),
      expiry_policy: modelOutput(output.expiry_policy || 'RECHECK_ON_NEW_INFORMATION'),
      urgency: modelOutput(output.urgency || 'NORMAL'),
      evidence_valid: verified(true, 'normalized_substring_of_stable_text'),
      evidence_segment_ids: verified(segment_ids, 'listed_segments_contain_span'),
    };
  }

  private applyKeep(input: RunInput, output: InitiativeModelOutput, result: LlmResult, received_at: number): void {
    const target = this.resolveTarget(input, output);
    if (!target.ok) return;
    const current = target.record;
    const stillThere = this.evidenceStillStable(current.evidence_span);
    this.deps.emitter.emit({
      event: 'initiative.decision',
      decision: 'KEEP',
      updated_at: this.deps.time.monotonicMs(),
      ...this.base(input, result, received_at),
      candidate_id: current.candidate_id,
      candidate_version: current.candidate_version,
      reason: output.reason ? modelOutput(output.reason) : modelOutputAbsent('model_left_empty'),
      evidence_valid: verified(stillThere, 'normalized_substring_of_stable_text'),
    });
  }

  private applyRevise(input: RunInput, output: InitiativeModelOutput, result: LlmResult, received_at: number): void {
    const target = this.resolveTarget(input, output);
    if (!target.ok) return;
    const { reasons, segment_ids } = this.checkContent(input, output);
    if (reasons.length > 0) {
      this.discard(input, target.record.candidate_id, reasons.join(';'));
      return;
    }
    const updated_at = this.deps.time.monotonicMs();
    let ref;
    try {
      ref = this.deps.store.update(
        target.record.candidate_id,
        target.record.candidate_version,
        {
          transcript_revision: input.transcript_revision,
          intent_type: output.intent_type || target.record.intent_type,
          evidence_span: output.evidence_span,
          proposed_utterance: output.proposed_utterance,
          expiry_policy: output.expiry_policy || target.record.expiry_policy,
          urgency: output.urgency || target.record.urgency,
          evidence_segment_ids: segment_ids,
        },
        updated_at,
      );
    } catch (error) {
      if (!(error instanceof CandidateConflictError)) throw error;
      this.discard(input, target.record.candidate_id, 'candidate_version_conflict');
      return;
    }
    this.deps.emitter.emit({
      event: 'initiative.decision',
      decision: 'REVISE',
      updated_at,
      ...this.base(input, result, received_at),
      ...this.candidateBody(ref, output, segment_ids),
    });
    // 文字の更新と音声の更新を一対一にする（仕様 §5）。
    this.cancelSpeech(ref.candidate_id, 'candidate_revised');
    this.prepareSpeech(ref, input, output);
  }

  private applyWithdraw(input: RunInput, output: InitiativeModelOutput, result: LlmResult, received_at: number): void {
    const target = this.resolveTarget(input, output);
    if (!target.ok) return;
    const check = checkWithdrawEvidence({
      span: output.withdraw_evidence_span,
      segment_ids: output.withdraw_evidence_segment_ids,
      input: input.segments,
      latest: this.view.snapshot(),
      candidate_evidence_span: target.record.evidence_span,
    });
    if (!check.ok) {
      this.discard(input, target.record.candidate_id, `withdraw_rejected:${check.reasons.join(';')}`);
      return;
    }
    const withdrawn_at = this.deps.time.monotonicMs();
    this.deps.store.setState(target.record.candidate_id, 'WITHDRAWN', withdrawn_at);
    this.deps.emitter.emit({
      event: 'initiative.decision',
      decision: 'WITHDRAW',
      withdrawn_at,
      ...this.base(input, result, received_at),
      candidate_id: target.record.candidate_id,
      candidate_version: target.record.candidate_version,
      withdraw_reason: modelOutput(output.withdraw_reason || output.reason),
      withdraw_evidence_segment_ids: verified(check.segment_ids, 'listed_segments_contain_span_after_candidate'),
    });
    this.deps.emitter.emit({
      event: 'candidate.state_changed',
      candidate_id: target.record.candidate_id,
      candidate_version: target.record.candidate_version,
      from: target.record.state,
      to: 'WITHDRAWN',
      cause_source: 'model_decision',
      decision: 'WITHDRAW',
      request_id: input.request_id,
    });
    this.cancelSpeech(target.record.candidate_id, 'candidate_withdrawn');
  }

  private resolveTarget(
    input: RunInput,
    output: InitiativeModelOutput,
  ): { ok: true; record: CandidateRecord } | { ok: false } {
    const stored = this.deps.store.get(output.target_candidate_id);
    const current = stored && stored.state !== 'WITHDRAWN' && stored.state !== 'SPOKEN' ? stored : null;
    const check = checkTarget(output.target_candidate_id, input.candidates, current);
    if (!check.ok) {
      this.discard(input, current?.candidate_id ?? null, `${output.decision}:${check.reasons.join(';')}`);
      return { ok: false };
    }
    return { ok: true, record: current as CandidateRecord };
  }

  private evidenceStillStable(span: string): boolean {
    const stable = this.view
      .snapshot()
      .map((s) => normalizeForMatch(s.stable_text))
      .join('');
    return stable.includes(normalizeForMatch(span));
  }

  /** ASR が書き換わって根拠が消えた候補を、モデルを待たずに撤回する（コード由来）。 */
  private sweepLostEvidence(): void {
    for (const candidate of this.deps.store.list()) {
      if (this.evidenceStillStable(candidate.evidence_span)) continue;
      this.withdrawByCode(candidate, 'evidence_lost');
    }
  }

  private withdrawByCode(candidate: CandidateRecord, cause: CandidateCause): void {
    this.deps.store.setState(candidate.candidate_id, 'WITHDRAWN', this.deps.time.monotonicMs());
    this.deps.emitter.emit({
      event: 'candidate.state_changed',
      candidate_id: candidate.candidate_id,
      candidate_version: candidate.candidate_version,
      from: candidate.state,
      to: 'WITHDRAWN',
      cause_source: 'code',
      cause,
    });
    this.cancelSpeech(candidate.candidate_id, cause);
  }

  private discard(input: RunInput, candidate_id: string | null, reason: string): void {
    const latest = this.view.revision();
    this.deps.emitter.emit({
      event: 'initiative.discarded',
      candidate_id: candidate_id ? present(candidate_id) : absent('not_numbered_yet'),
      reason,
      input_transcript_revision: input.transcript_revision,
      latest_transcript_revision: latest,
      revision_gap: Math.max(0, latest - input.transcript_revision),
    });
  }

  private prepareSpeech(
    ref: { candidate_id: string; candidate_version: number },
    input: RunInput,
    output: InitiativeModelOutput,
  ): void {
    if (!this.deps.speech) return;
    this.speechByCandidate.set(
      ref.candidate_id,
      this.deps.speech.prepare({
        segment_id: input.segment_id,
        transcript_revision: input.transcript_revision,
        text: output.proposed_utterance,
        origin: { kind: 'candidate', candidate_id: ref.candidate_id, candidate_version: ref.candidate_version },
      }),
    );
  }

  private cancelSpeech(candidate_id: string, reason: string): void {
    const prepared = this.speechByCandidate.get(candidate_id);
    if (!prepared || !this.deps.speech) return;
    this.deps.speech.cancel(prepared.audio_playback_id, reason);
    this.speechByCandidate.delete(candidate_id);
  }
}
