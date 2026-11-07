/**
 * InitiativeMonitor（計画 §4.5、レーン G）。
 *
 * - 増分で起動する。ターン完了確率にも固定周期にも依存しない。
 * - 実行中の要求は最後まで走らせ、完了後に新しい増分があれば最新の入力で1回実行する（stop() でだけ中断する）。
 * - final（ターンの終わりの候補）を受けたら、増分が起動の文字数に満たなくても1回判定する。リプレイの
 *   finishInput も同じ規則（入力の終わりを final とみなす）で、セッションとリプレイの振る舞いを揃える。
 * - 失敗した要求の入力は判定済みとして扱わない。待ちが明けたら poll（J の tick）で同じ入力から判定し直す。
 * - モデルの出力は gate.ts（G の決定的なゲート）を通ったものだけを E2a の CandidateLedger へ渡す。
 *   候補の状態の正本、採番、candidate.state_changed と candidate.rejected の発行は E2a。ここは
 *   initiative.decision と initiative.discarded だけを出す。
 * - NEW は合図の許可でも発声の許可でもない（want_to_speak ≠ permitted_to_speak ≠ speaking）。
 * - llm.request、llm.response、cost.usage はプロバイダが出す（providers/llm/gemini.ts）。ここで重ねて出さない。
 * - 判定の失敗（プロバイダの失敗、不正な出力）は候補を作らず理由を initiative.discarded に残す。
 *   続けて失敗したら次の起動を待たせる（再試行で連打しない）。
 */
import { absent, modelOutput, modelOutputAbsent, present, verified } from '@llm-vap/contracts';
import type {
  CandidateRecord,
  CandidateRef,
  EventEmitter,
  InitiativeTrigger,
  LlmProvider,
  LlmResult,
  SpeechGenerator,
  TimeSource,
} from '@llm-vap/contracts';
import type {
  CandidateContent,
  CandidateModelNotes,
  DecisionMeta,
  DecisionResult,
  ModelDecision,
} from '../../control/candidates/types';
import { checkEvidence, checkFreshness, checkWithdrawEvidence } from './gate';
import { INITIATIVE_JSON_SCHEMA, parseModelOutput } from './model_output';
import type { InitiativeModelOutput } from './model_output';
import type { InitiativePersona } from './persona';
import { CURRENT_PROMPT_VERSION, getPrompt } from './prompt';
import { normalizeForMatch } from './text';
import { StableTranscriptView } from './transcript_view';
import type { AsrSegmentSnapshot, StableMode, SttEvent, SttInput } from './transcript_view';

/** policy.ja.json の initiative 節のうち、ここで読む値。null（未校正）のまま起動しない。 */
export interface InitiativeLimits {
  max_new_stable_chars_since_input: number | null;
  max_result_age_ms: number | null;
  min_stability: number | null;
  max_requests_per_session: number | null;
  /** 起動の条件。値は【未検証の暫定値】。 */
  trigger?: InitiativeTrigger;
}

export type TriggerOptions = InitiativeTrigger;

/** E2a の CandidateLedger のうち G が使う口。 */
export interface InitiativeLedgerPort {
  applyModelDecision(d: ModelDecision): DecisionResult;
  list(): readonly CandidateRecord[];
  sweepEvidence(at: number): void;
}

/** 候補の先行音声の準備（任意）。破棄は E2a が D の discardCandidate で行うので、ここは準備だけ。 */
export type CandidateSpeechPreparePort = Pick<SpeechGenerator, 'prepare'>;

/** 失敗の後に次の起動を待たせる長さ。値は【未検証の暫定値】（policy の initiative 節は strict なのでコードに置く）。 */
export interface FailureBackoff {
  base_ms: number;
  max_ms: number;
}
export const DEFAULT_FAILURE_BACKOFF: FailureBackoff = { base_ms: 2000, max_ms: 30_000 };

export interface InitiativeMonitorDeps {
  llm: LlmProvider;
  ledger: InitiativeLedgerPort;
  emitter: EventEmitter;
  time: TimeSource;
  persona: InitiativePersona;
  limits: InitiativeLimits;
  /** limits.trigger（policy）より優先する。試験とスパイクの比較用。 */
  trigger?: TriggerOptions;
  prompt_version?: string;
  stable_mode?: StableMode;
  /** 候補の先行音声。波2のセッションでは渡さない（候補は話さないので TTS を作らない）。 */
  speech?: CandidateSpeechPreparePort;
  /** 入力に載せる直近の区間の文字数の上限。長い話で要求が際限なく大きくならないように。 */
  max_input_chars?: number;
  failure_backoff?: FailureBackoff;
}

interface RunInput {
  request_id: string;
  /** 要求の前の「判定済み」の印。失敗したらここへ戻す（失敗した入力を判定済みにしない）。 */
  previous: InputMark;
  segments: AsrSegmentSnapshot[];
  candidates: CandidateRecord[];
  stable_chars: number;
  transcript_revision: number;
  segment_id: number;
  sent_at: number;
}

interface InputMark {
  chars: number;
  boundaries: number;
  segment: number;
  boundary_pending: boolean;
}

/** 話の後に届いて E2a が保留した NEW（人が再開したら E2a が照合し直して候補にする）。 */
interface HeldContext {
  input: RunInput;
  output: InitiativeModelOutput;
  result: LlmResult;
  received_at: number;
}

/** E2a が保留を解いた結果（InitiativeWiring が ledger.observeUserFloor から受けて渡す）。 */
export interface HeldPromotion {
  request_id: string;
  result: DecisionResult;
}

/** 監視が判定の名義で出す provider.status の名前（応答用の LLM の行と混ぜない）。 */
export const INITIATIVE_MONITOR_STATUS = 'initiative_monitor';

function required(value: number | null, name: string): number {
  if (value === null) throw new Error(`policy.initiative.${name} is uncalibrated (null)`);
  return value;
}

/** 例外から理由の文字列を作る。GeminiProviderError は kind を持つ。キーはプロバイダ側で伏せてある。 */
function failureReason(error: unknown): string {
  if (error && typeof error === 'object' && 'kind' in error && typeof (error as { kind: unknown }).kind === 'string') {
    const message = error instanceof Error ? error.message : '';
    return `provider_error:${(error as { kind: string }).kind}:${message.slice(0, 160)}`;
  }
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return `provider_error:${message.slice(0, 160)}`;
}

export class InitiativeMonitor {
  private readonly view: StableTranscriptView;
  private readonly trigger: TriggerOptions;
  private readonly promptVersion: string;
  private readonly maxNewChars: number;
  private readonly maxAgeMs: number;
  private readonly maxRequests: number;
  private readonly maxInputChars: number;
  private readonly backoff: FailureBackoff;

  private running: Promise<void> | null = null;
  private abort: AbortController | null = null;
  private current: RunInput | null = null;
  private held: HeldContext | null = null;
  private forceRerun = false;
  private boundaryPending = false;
  private lastInputChars = 0;
  private lastInputBoundaries = 0;
  private lastInputSegment = 0;
  private requestSeq = 0;
  private limitReported = false;
  private consecutiveFailures = 0;
  private retryAfter: number | null = null;
  private stopped = false;

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
    this.backoff = deps.failure_backoff ?? DEFAULT_FAILURE_BACKOFF;
    getPrompt(this.promptVersion);
  }

  get prompt_version(): string {
    return this.promptVersion;
  }

  requestCount(): number {
    return this.requestSeq;
  }

  /** E2a の stable に渡す（根拠の照合と sweep が同じ安定テキストを見る）。 */
  stableSnapshot(): AsrSegmentSnapshot[] {
    return this.view.snapshot();
  }

  /** 失敗の後の待ちの終わり。待っていなければ null。 */
  retryAfterMs(): number | null {
    return this.retryAfter;
  }

  onStt(event: SttInput | SttEvent): void {
    if (this.stopped) return;
    const applied = this.view.apply(event);
    // final は増分が小さくても1回判定する（ターンの終わりの判定を抜かさない）。増分がなければ立てない。
    if (event.event === 'stt.final') this.boundaryPending = this.newStableChars() > 0;
    // ASR が書き換わって根拠が消えた候補は、モデルを待たずに E2a がコード由来で撤回する。
    if (applied.rewrote_stable) this.deps.ledger.sweepEvidence(this.deps.time.monotonicMs());
    this.maybeStart();
  }

  /**
   * 失敗の後の待ちが明けたかを確かめる（J の tick から呼ぶ）。起動の条件は増分のままで、固定周期では起動しない。
   * 待っていなければ何もしない。
   */
  poll(): void {
    if (this.retryAfter !== null) this.maybeStart();
  }

  /** 以後は起動せず、実行中の要求は中断し、結果も適用しない（セッションの終わり）。 */
  stop(): void {
    this.stopped = true;
    this.held = null;
    this.abort?.abort();
  }

  /** 実行中の要求と、それに続く1回が終わるまで待つ。 */
  async whenIdle(): Promise<void> {
    while (this.running) await this.running;
  }

  /**
   * 入力の終わり（リプレイ）。final と同じ規則で、増分が残っていれば最後に1回判定する（撤回の機会を失わないため）。
   * セッションでは STT の final がこの役をする。
   */
  async finishInput(): Promise<void> {
    await this.whenIdle();
    if (this.newStableChars() > 0) {
      this.boundaryPending = true;
      this.maybeStart();
    }
    await this.whenIdle();
  }

  /**
   * E2a が保留した NEW を人の再開で候補にした（または照合で棄てた）。採番の後に initiative.decision を出す。
   * 保留の理由（post_turn_new_held）は受け取った時点で initiative.discarded に残してある。
   */
  onHeldPromoted(promotion: HeldPromotion, at: number): void {
    const held = this.held;
    this.held = null;
    if (this.stopped || !held || held.input.request_id !== promotion.request_id) return;
    const applied = promotion.result;
    if (!applied.ok) {
      this.discard(held.input, applied.ref?.candidate_id ?? null, `e2a_rejected:${applied.reason};held_promotion`);
      return;
    }
    const ref = applied.ref as CandidateRef;
    this.deps.emitter.emit({
      event: 'initiative.decision',
      decision: 'NEW',
      decided_at: at,
      ...this.base(held.input, held.result, held.received_at),
      ...this.candidateBody(ref, held.output, this.content(held.output), applied),
    });
    this.prepareSpeech(ref, held.input, held.output);
  }


  /** 前の入力からの新規安定文字数。segment が変わったら新しい segment の全部を新規と数える。 */
  private newStableChars(): number {
    const base = this.view.segmentId() === this.lastInputSegment ? this.lastInputChars : 0;
    return this.view.totalStableChars() - base;
  }

  private newBoundaries(): boolean {
    const base = this.view.segmentId() === this.lastInputSegment ? this.lastInputBoundaries : 0;
    return this.view.interiorSentenceBoundaries() > base;
  }

  private shouldRun(): boolean {
    const newChars = this.newStableChars();
    if (newChars <= 0) return false;
    if (this.forceRerun) return true;
    if (newChars >= this.trigger.min_new_stable_chars) return true;
    // final（とリプレイの入力の終わり）は増分が小さくても判定する。
    if (this.boundaryPending) return true;
    const atBoundary = this.trigger.min_new_chars_at_boundary;
    if (atBoundary === null) return false;
    return this.newBoundaries() && newChars >= atBoundary;
  }

  private maybeStart(): void {
    if (this.stopped || this.running || !this.shouldRun()) return;
    if (this.retryAfter !== null) {
      if (this.deps.time.monotonicMs() < this.retryAfter) return;
      this.retryAfter = null;
    }
    if (this.requestSeq >= this.maxRequests) {
      if (!this.limitReported) {
        this.limitReported = true;
        this.deps.emitter.emit({
          event: 'provider.status',
          // 判定用の LLM の行（応答用と同じ名前）ではなく、監視の行へ出す。
          provider: INITIATIVE_MONITOR_STATUS,
          provider_class: this.deps.llm.provider_class,
          status: 'degraded',
          reason: present('initiative_request_limit_reached'),
          retry_attempt: 0,
          next_retry_ms: absent('limit_is_per_session'),
        });
      }
      return;
    }
    this.running = this.runOnce()
      .catch((error: unknown) => this.internalError(error))
      .finally(() => {
        this.running = null;
        this.current = null;
        this.abort = null;
        this.maybeStart();
      });
  }

  /** 判定の外で起きた例外（E2a、emit の検証など）。止めずに理由を残す。 */
  private internalError(error: unknown): void {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    console.error('[initiative] internal error:', message);
    if (this.stopped) return;
    const latest = this.view.revision();
    const input = this.current?.transcript_revision ?? latest;
    try {
      this.deps.emitter.emit({
        event: 'initiative.discarded',
        candidate_id: absent('internal_error'),
        reason: `internal_error:${message.slice(0, 200)}`,
        input_transcript_revision: input,
        latest_transcript_revision: latest,
        revision_gap: Math.max(0, latest - input),
      });
    } catch (emitError) {
      console.error('[initiative] could not record the internal error:', emitError);
    }
  }

  /**
   * LLM に渡す区間。長い話では古い区間から落とすが、未解決の候補の根拠の区間は落とさない
   * （撤回の根拠が候補の根拠より後ろかを確かめられなくなるため）。
   */
  private buildInput(previous: InputMark): RunInput {
    let segments = this.view.snapshot();
    const keep = new Set(this.deps.ledger.list().flatMap((c) => c.evidence_segment_ids));
    let total = segments.reduce((sum, s) => sum + s.stable_text.length, 0);
    while (segments.length > 1 && total > this.maxInputChars) {
      const drop = segments.findIndex((s, i) => i < segments.length - 1 && !keep.has(s.asr_segment_id));
      if (drop < 0) break;
      total -= segments[drop]!.stable_text.length;
      segments = segments.filter((_, i) => i !== drop);
    }
    this.requestSeq += 1;
    return {
      request_id: `ini_${String(this.requestSeq).padStart(4, '0')}`,
      previous,
      segments,
      candidates: [...this.deps.ledger.list()],
      stable_chars: this.view.totalStableChars(),
      transcript_revision: this.view.revision(),
      segment_id: this.view.segmentId(),
      sent_at: this.deps.time.monotonicMs(),
    };
  }

  private async runOnce(): Promise<void> {
    const previous: InputMark = {
      chars: this.lastInputChars,
      boundaries: this.lastInputBoundaries,
      segment: this.lastInputSegment,
      boundary_pending: this.boundaryPending,
    };
    const input = this.buildInput(previous);
    this.current = input;
    this.lastInputChars = input.stable_chars;
    this.lastInputBoundaries = this.view.interiorSentenceBoundaries();
    this.lastInputSegment = input.segment_id;
    this.boundaryPending = false;
    this.forceRerun = false;

    const prompt = getPrompt(this.promptVersion);
    const abort = new AbortController();
    this.abort = abort;
    let result: LlmResult;
    try {
      result = await this.deps.llm.generate({
        signal: abort.signal,
        request_id: input.request_id,
        purpose: 'initiative',
        system: prompt.system(this.deps.persona),
        messages: prompt.messages({ segments: input.segments, candidates: input.candidates }),
        response_json_schema: INITIATIVE_JSON_SCHEMA,
        transcript_revision: input.transcript_revision,
      });
    } catch (error) {
      if (this.stopped) return;
      this.fail(input, failureReason(error));
      return;
    }
    if (this.stopped) return;
    const parsed = parseModelOutput(result.text);
    if (!parsed.ok) {
      this.fail(input, parsed.reason);
      return;
    }
    this.consecutiveFailures = 0;
    this.applyDecision(input, parsed.output, result, this.deps.time.monotonicMs());
  }

  /**
   * 候補を作らず理由を残し、次の起動を待たせる（連続した失敗ほど長く）。
   * 失敗した入力は判定済みにしない。印を要求の前へ戻し、待ちが明けたら poll で同じ入力から判定し直す。
   */
  private fail(input: RunInput, reason: string): void {
    // 実行中の要求は1つだけなので、要求の後に印を動かしたのはこの要求だけ。そのまま戻す。
    this.lastInputChars = input.previous.chars;
    this.lastInputBoundaries = input.previous.boundaries;
    this.lastInputSegment = input.previous.segment;
    this.boundaryPending = this.boundaryPending || input.previous.boundary_pending;
    this.forceRerun = true;
    this.consecutiveFailures += 1;
    const wait = Math.min(this.backoff.max_ms, this.backoff.base_ms * 2 ** (this.consecutiveFailures - 1));
    this.retryAfter = this.deps.time.monotonicMs() + wait;
    this.discard(input, null, `${reason};backoff_ms=${wait}`);
  }

  private applyDecision(input: RunInput, output: InitiativeModelOutput, result: LlmResult, received_at: number): void {
    switch (output.decision) {
      case 'NONE':
        this.applyNone(input, output, result, received_at);
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

  private meta(input: RunInput, received_at: number): DecisionMeta {
    return {
      request_id: input.request_id,
      transcript_revision: input.transcript_revision,
      segment_id: input.segment_id,
      received_at,
      input_segments: input.segments,
    };
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

  private applyNone(input: RunInput, output: InitiativeModelOutput, result: LlmResult, received_at: number): void {
    // NONE も E2a へ渡す（判定の順序の基準になる）。
    const applied = this.deps.ledger.applyModelDecision({ decision: 'NONE', ...this.meta(input, received_at) });
    if (!applied.ok) {
      this.rejected(input, applied, null);
      return;
    }
    this.deps.emitter.emit({
      event: 'initiative.decision',
      decision: 'NONE',
      ...this.base(input, result, received_at),
      reason: output.reason ? modelOutput(output.reason) : modelOutputAbsent('model_left_empty'),
    });
  }

  /** 候補の内容を持つ判定（NEW と REVISE）に共通の G のゲート。 */
  private checkContent(input: RunInput, output: InitiativeModelOutput): { reasons: string[] } {
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
    return { reasons };
  }

  private content(output: InitiativeModelOutput, fallback?: CandidateRecord): CandidateContent {
    return {
      intent_type: output.intent_type || fallback?.intent_type || 'UNSPECIFIED',
      evidence_span: output.evidence_span,
      evidence_segment_ids: output.evidence_segment_ids,
      proposed_utterance: output.proposed_utterance,
      expiry_policy: output.expiry_policy || fallback?.expiry_policy || 'RECHECK_ON_NEW_INFORMATION',
      urgency: output.urgency || fallback?.urgency || 'NORMAL',
    };
  }

  private notes(output: InitiativeModelOutput): CandidateModelNotes {
    return {
      reason: output.reason ? modelOutput(output.reason) : modelOutputAbsent('model_left_empty'),
      why_now: output.why_now ? modelOutput(output.why_now) : modelOutputAbsent('model_left_empty'),
      cost_of_waiting: output.cost_of_waiting ? modelOutput(output.cost_of_waiting) : modelOutputAbsent('model_left_empty'),
    };
  }

  private applyNew(input: RunInput, output: InitiativeModelOutput, result: LlmResult, received_at: number): void {
    const { reasons } = this.checkContent(input, output);
    if (reasons.length > 0) {
      this.discard(input, null, reasons.join(';'));
      return;
    }
    const content = this.content(output);
    const applied = this.deps.ledger.applyModelDecision({
      decision: 'NEW',
      ...this.meta(input, received_at),
      content,
      notes: this.notes(output),
    });
    if (!applied.ok) {
      // 話の後に届いた NEW は E2a が保留する。人が再開したら E2a が照合し直して候補にする（onHeldPromoted）。
      if (applied.held) this.held = { input, output, result, received_at };
      this.rejected(input, applied, null);
      return;
    }
    const ref = applied.ref as CandidateRef;
    // initiative.decision の NEW は E2a の採番の後に出す（candidates.ts の約束）。
    this.deps.emitter.emit({
      event: 'initiative.decision',
      decision: 'NEW',
      decided_at: received_at,
      ...this.base(input, result, received_at),
      ...this.candidateBody(ref, output, content, applied),
    });
    this.prepareSpeech(ref, input, output);
  }

  private candidateBody(
    ref: CandidateRef,
    output: InitiativeModelOutput,
    content: CandidateContent,
    applied: Extract<DecisionResult, { ok: true }>,
  ) {
    const notes = this.notes(output);
    return {
      candidate_id: ref.candidate_id,
      candidate_version: ref.candidate_version,
      intent_type: modelOutput(content.intent_type),
      evidence_span: modelOutput(output.evidence_span),
      reason: notes.reason,
      why_now: notes.why_now,
      cost_of_waiting: notes.cost_of_waiting,
      proposed_utterance: modelOutput(output.proposed_utterance),
      expiry_policy: modelOutput(content.expiry_policy),
      urgency: modelOutput(content.urgency),
      evidence_valid: verified(true, 'g_gate_and_e2a_normalized_substring_of_stable_text'),
      evidence_segment_ids:
        applied.evidence_segment_ids ?? verified([...output.evidence_segment_ids], 'listed_segments_contain_span'),
    };
  }

  /** KEEP／REVISE／WITHDRAW の対象を、入力で示した候補の ID と版で指す。LLM が作った ID は入力にないので落ちる。 */
  private targetOf(input: RunInput, output: InitiativeModelOutput): CandidateRef | null {
    const shown = input.candidates.find((c) => c.candidate_id === output.target_candidate_id);
    if (!shown) {
      this.discard(input, null, `${output.decision}:target_candidate_not_in_input`);
      return null;
    }
    return { candidate_id: shown.candidate_id, candidate_version: shown.candidate_version };
  }

  private applyKeep(input: RunInput, output: InitiativeModelOutput, result: LlmResult, received_at: number): void {
    const target = this.targetOf(input, output);
    if (!target) return;
    const applied = this.deps.ledger.applyModelDecision({ decision: 'KEEP', ...this.meta(input, received_at), target });
    if (!applied.ok) {
      this.rejected(input, applied, target.candidate_id);
      return;
    }
    this.deps.emitter.emit({
      event: 'initiative.decision',
      decision: 'KEEP',
      updated_at: received_at,
      ...this.base(input, result, received_at),
      candidate_id: target.candidate_id,
      candidate_version: target.candidate_version,
      reason: output.reason ? modelOutput(output.reason) : modelOutputAbsent('model_left_empty'),
      // KEEP でも根拠の残存は E2a がコードで確かめ、消えていれば撤回している。
      evidence_valid: verified(applied.to !== 'WITHDRAWN', 'e2a_evidence_still_in_latest_stable_text'),
    });
  }

  private applyRevise(input: RunInput, output: InitiativeModelOutput, result: LlmResult, received_at: number): void {
    const target = this.targetOf(input, output);
    if (!target) return;
    const { reasons } = this.checkContent(input, output);
    if (reasons.length > 0) {
      this.discard(input, target.candidate_id, reasons.join(';'));
      return;
    }
    const current = input.candidates.find((c) => c.candidate_id === target.candidate_id);
    const content = this.content(output, current);
    const applied = this.deps.ledger.applyModelDecision({
      decision: 'REVISE',
      ...this.meta(input, received_at),
      target,
      content,
      notes: this.notes(output),
    });
    if (!applied.ok) {
      this.rejected(input, applied, target.candidate_id);
      return;
    }
    const ref = applied.ref as CandidateRef;
    this.deps.emitter.emit({
      event: 'initiative.decision',
      decision: 'REVISE',
      updated_at: received_at,
      ...this.base(input, result, received_at),
      ...this.candidateBody(ref, output, content, applied),
    });
    // 旧い版の未再生の PCM は E2a が D の discardCandidate で棄てた。新しい版の準備だけをする。
    this.prepareSpeech(ref, input, output);
  }

  private applyWithdraw(input: RunInput, output: InitiativeModelOutput, result: LlmResult, received_at: number): void {
    const target = this.targetOf(input, output);
    if (!target) return;
    const record = input.candidates.find((c) => c.candidate_id === target.candidate_id) as CandidateRecord;
    const check = checkWithdrawEvidence({
      span: output.withdraw_evidence_span,
      segment_ids: output.withdraw_evidence_segment_ids,
      input: input.segments,
      latest: this.view.snapshot(),
      candidate_evidence_span: record.evidence_span,
    });
    if (!check.ok) {
      this.discard(input, target.candidate_id, `withdraw_rejected:${check.reasons.join(';')}`);
      return;
    }
    const applied = this.deps.ledger.applyModelDecision({
      decision: 'WITHDRAW',
      ...this.meta(input, received_at),
      target,
      withdraw_evidence_span: output.withdraw_evidence_span,
      withdraw_evidence_segment_ids: output.withdraw_evidence_segment_ids,
      withdraw_reason: this.withdrawReason(output),
    });
    if (!applied.ok) {
      this.rejected(input, applied, target.candidate_id);
      return;
    }
    this.deps.emitter.emit({
      event: 'initiative.decision',
      decision: 'WITHDRAW',
      withdrawn_at: received_at,
      ...this.base(input, result, received_at),
      candidate_id: target.candidate_id,
      candidate_version: target.candidate_version,
      // 空の withdraw_reason を reason やコードの値で埋めない（モデル出力とコードの値を混ぜない。追補2）。
      withdraw_reason: this.withdrawReason(output),
      reason: output.reason ? modelOutput(output.reason) : modelOutputAbsent('model_left_empty'),
      withdraw_evidence_segment_ids:
        applied.withdraw_evidence_segment_ids ?? verified(check.segment_ids, 'listed_segments_contain_span_after_candidate'),
    });
  }

  private withdrawReason(output: InitiativeModelOutput) {
    return output.withdraw_reason ? modelOutput(output.withdraw_reason) : modelOutputAbsent('model_left_empty');
  }

  /**
   * E2a が受け付けなかった判定。candidate.rejected（または active_candidate_exists の candidate.state_changed）は
   * E2a が出したので、ここは initiative.discarded に e2a_rejected:<reason> を残す。
   */
  private rejected(input: RunInput, rejection: Extract<DecisionResult, { ok: false }>, target: string | null): void {
    const candidate_id = rejection.ref?.candidate_id ?? target;
    this.discard(input, candidate_id, `e2a_rejected:${rejection.reason}`);
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

  private prepareSpeech(ref: CandidateRef, input: RunInput, output: InitiativeModelOutput): void {
    if (!this.deps.speech) return;
    this.deps.speech.prepare({
      segment_id: input.segment_id,
      transcript_revision: input.transcript_revision,
      text: output.proposed_utterance,
      origin: { kind: 'candidate', candidate_id: ref.candidate_id, candidate_version: ref.candidate_version },
    });
  }
}
