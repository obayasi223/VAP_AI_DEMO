/**
 * 候補の状態の正本と ID・版の採番（計画 §4.5 の責任の分離、§5 E2a）。
 *
 * - want_to_speak の正本だけを持つ。permitted_to_speak（E1 の turn_allowed）と speaking（D の再生）は持たず、
 *   SPEAKING へ入る原因は呼び手が判断した結果として受け取る。
 * - candidate_id と版はここで振る。LLM には生成させない。
 * - 不正な遷移、遅れて届いた判定、照合できない根拠は拒否し、candidate.rejected に理由を残す。
 * - segment_id が変わっただけでは判定を捨てない。NONE は記録して何もしない。内容を持つ判定は、AI が話し始めたか
 *   （details の先頭 ai_started_speaking）と入力以降の新規の安定文字数（too_many_new_stable_chars）を確かめて判断する
 *   （経過時間の上限は G のゲートが先に確かめている）。
 * - 版が変わったら、前の版の未再生の PCM を D の discardCandidate で棄てる。再生の開始は D の startChecked で
 *   版と PCM の一致を確かめる。
 * - モデルの説明文は記録するだけで判定に使わない（追補1）。
 */
import { absent, modelOutput, present, verified } from '@llm-vap/contracts';
import type {
  CandidateCause,
  CandidateRecord,
  CandidateRef,
  CandidateState,
  ContentWithdrawKind,
  EventEmitter,
  SpeechGenerator,
  WithdrawEvidenceSource,
} from '@llm-vap/contracts';
import { normalizeForMatch } from '../../cognition/initiative/text';
import { evidenceStillStable, verifyAiWithdrawEvidence, verifyEvidence, verifyWithdrawEvidence } from './evidence';
import {
  DEFAULT_TRANSITION_OPTIONS,
  MODEL_APPLICABLE_STATES,
  TERMINAL_STATES,
  WITHDRAWABLE_STATES,
  checkTransition,
  transitionTable,
} from './transitions';
import type { TransitionOptions } from './transitions';
import type {
  AsrSegmentSnapshot,
  CandidateContent,
  CandidateModelNotes,
  CandidateWant,
  DecisionResult,
  HeldDecision,
  LedgerRecord,
  ModelDecision,
  Rejection,
  RejectionReason,
  SpeechStartResult,
  TransitionResult,
} from './types';

/** D の SpeechGeneratorImpl のうち E2a が使う2つ。どちらも契約では省略可能なので、ここで必須にする。 */
export type CandidateSpeechPort = Required<Pick<SpeechGenerator, 'startChecked' | 'discardCandidate'>>;

export interface CandidateLedgerSettings {
  /** policy.initiative.max_active_candidates。 */
  max_active_candidates: number;
  /** policy.initiative.candidate_expiry_ms。null（未校正）は時間での期限なし。 */
  candidate_expiry_ms: number | null;
  /**
   * policy.initiative.candidate_expires_on_segment_change。
   * null（未校正）は true として扱う（安全側。AI が話し始めた後に前のターンの候補を残さない）。
   */
  candidate_expires_on_segment_change: boolean | null;
  /** 人が話し終えたとみなす無音の長さ。J は turn の MIN_GAP_TIME_MS を渡す（AI がそれより前に話し始めないため）。 */
  post_turn_silence_ms: number;
  /** DEFERRED からの再合図。既定は無効（計画 §4.6）。 */
  allow_recue?: boolean;
  /**
   * policy.initiative.max_new_stable_chars_since_input。区間をまたいで届いた判定の古さの上限。
   * 区間内の判定は G のゲートが同じ値で確かめている。省略と null（未校正）は数えない。
   */
  max_new_stable_chars_since_input?: number | null;
}

export interface CandidateLedgerDeps {
  emitter: EventEmitter;
  /** 最新の安定テキスト。G の StableTranscriptView.snapshot() を渡す。 */
  stable: () => readonly AsrSegmentSnapshot[];
  speech: CandidateSpeechPort;
  settings: CandidateLedgerSettings;
}

const CODE = 'code_transition';

export class CandidateLedger {
  private readonly records = new Map<string, LedgerRecord>();
  private readonly transitionOptions: TransitionOptions;
  private counter = 0;
  private appliedRevision: number | null = null;
  private currentSegment = 0;
  /** 最後に AI が話し始めた（onSegmentChanged）segment と時刻。入力の segment がこれより前なら AI が話し始めた後の結果。 */
  private lastAiStart: { segment_id: number; at: number } | null = null;
  private floor: { user_speaking: boolean; since: number } | null = null;
  private held: HeldDecision | null = null;

  constructor(private readonly deps: CandidateLedgerDeps) {
    this.transitionOptions = { ...DEFAULT_TRANSITION_OPTIONS, allow_recue: deps.settings.allow_recue ?? false };
    if (deps.settings.max_active_candidates < 1) throw new Error('max_active_candidates must be >= 1');
  }

  // ---- 読み出し --------------------------------------------------------------

  get(candidate_id: string): CandidateRecord | null {
    const record = this.records.get(candidate_id);
    return record ? toContract(record) : null;
  }

  /** 記録の全体（説明文と時刻を含む）。研究者画面とログの確認用。 */
  getRecord(candidate_id: string): LedgerRecord | null {
    const record = this.records.get(candidate_id);
    return record ? structuredClone(record) : null;
  }

  /** 既定は未解決（SPOKEN、WITHDRAWN 以外）のみ。保留中の NEW は入らない。 */
  list(options?: { include_resolved?: boolean }): readonly CandidateRecord[] {
    return [...this.records.values()]
      .filter((r) => options?.include_resolved || !TERMINAL_STATES.includes(r.state))
      .map(toContract);
  }

  /** want_to_speak。最も早く決まった未解決の候補。 */
  want(): CandidateWant {
    const active = [...this.records.values()]
      .filter((r) => !TERMINAL_STATES.includes(r.state))
      .sort((a, b) => a.timeline.decided_at - b.timeline.decided_at)[0];
    if (!active) return { kind: 'none' };
    return {
      kind: 'candidate',
      candidate_id: active.candidate_id,
      candidate_version: active.candidate_version,
      state: active.state,
    };
  }

  heldPostTurn(): HeldDecision | null {
    return this.held ? structuredClone(this.held) : null;
  }

  appliedTranscriptRevision(): number | null {
    return this.appliedRevision;
  }

  segmentId(): number {
    return this.currentSegment;
  }

  /** 遷移表の全経路（設定の allow_recue を反映）。 */
  transitions() {
    return transitionTable(this.transitionOptions);
  }

  // ---- モデルの判定（G から） ------------------------------------------------

  /**
   * G の判定を適用する。NONE も渡す（判定の順序の基準になる）。
   * NEW は成功すると採番した ref を返す。G は initiative.decision をこの戻り値で emit する（採番の後）。
   */
  applyModelDecision(d: ModelDecision): DecisionResult {
    const crossedSegment = d.segment_id < this.currentSegment;
    if (d.segment_id > this.currentSegment) this.advanceSegment(d.segment_id, d.received_at);
    // NONE は候補を変えないので棄却しない。何も適用せず、順序の基準だけを進める（markApplied は最大値を取る）。
    if (d.decision === 'NONE') {
      this.markApplied(d.transcript_revision);
      return okResult('NONE', null, null, null);
    }
    if (this.appliedRevision !== null && d.transcript_revision < this.appliedRevision) {
      return this.rejectModel(d, 'stale_transcript_revision', []);
    }
    // WITHDRAW は候補を減らすだけなので、区間をまたいでも適用する（根拠と対象の確かめは applyWithdraw）。
    // 持ち越しの候補への KEEP は内容を変えないので、AI の発話の開始をまたいでも適用する（持ち越しの候補の判定が古いままにならないように）。
    if (crossedSegment && d.decision !== 'WITHDRAW' && !this.isKeepOfCarried(d)) {
      const crossed = this.rejectAcrossSegment(d);
      if (crossed !== null) return crossed;
    }
    switch (d.decision) {
      case 'NEW':
        return this.applyNew(d, false);
      case 'KEEP':
        return this.applyKeep(d);
      case 'REVISE':
        return this.applyRevise(d);
      case 'WITHDRAW':
        return this.applyWithdraw(d);
    }
  }

  private applyNew(d: Extract<ModelDecision, { decision: 'NEW' }>, promoted: boolean): DecisionResult {
    const content = this.verifyContent(d, d.content);
    if (!content.ok) return content.rejection;

    const active = [...this.records.values()].filter((r) => !TERMINAL_STATES.includes(r.state));
    if (active.length >= this.deps.settings.max_active_candidates) {
      // 登録と同時に棄却する。番号は振り、candidate.state_changed（from=null）に残す（契約の取り決め）。
      const record = this.createRecord(d, content.segment_ids, 'WITHDRAWN');
      record.withdraw = { source: 'code', cause: 'active_candidate_exists' };
      record.timeline.resolved_at = d.received_at;
      this.emitCodeChange(record, null, 'active_candidate_exists');
      return {
        ok: false,
        reason: 'active_candidate_exists',
        details: active.map((r) => r.candidate_id),
        held: false,
        ref: refOf(record),
      };
    }

    if (!promoted && this.isPostTurn(d.received_at)) {
      if (this.held) this.dropHeld(d.received_at, 'replaced_by_newer');
      this.held = { decision: structuredClone(d), held_at: d.received_at, evidence_segment_ids: content.segment_ids };
      return this.rejectModel(d, 'post_turn_new_held', [`silent_since=${this.floor?.since}`], { held: true });
    }

    const record = this.createRecord(d, content.segment_ids, 'INTENT_READY');
    this.markApplied(d.transcript_revision);
    this.emitModelChange(record, null, 'NEW', d.request_id);
    return okResult('NEW', record, null, 'INTENT_READY', verified(content.segment_ids, EVIDENCE_METHOD));
  }

  private applyKeep(d: Extract<ModelDecision, { decision: 'KEEP' }>): DecisionResult {
    const target = this.resolveTarget(d, d.target);
    if (!target.ok) return target.rejection;
    const record = target.record;
    this.markApplied(d.transcript_revision);
    record.last_request_id = d.request_id;
    record.last_model_revision = d.transcript_revision;
    record.received_at = d.received_at;
    const from = record.state;
    // KEEP でも根拠が今も安定テキストにあるかはコードで確かめる。消えていればコード由来で撤回する。
    // 持ち越した候補は元の根拠が前の segment にあり、今の安定テキストには無いので見ない。
    if (!record.carried_over && !evidenceStillStable(record.evidence_span, this.deps.stable())) {
      this.withdrawByCode(record, 'evidence_lost', d.received_at);
      return okResult('KEEP', record, from, 'WITHDRAWN');
    }
    return okResult('KEEP', record, from, from);
  }

  private applyRevise(d: Extract<ModelDecision, { decision: 'REVISE' }>): DecisionResult {
    const target = this.resolveTarget(d, d.target);
    if (!target.ok) return target.rejection;
    const content = this.verifyContent(d, d.content, target.record);
    if (!content.ok) return content.rejection;
    const record = target.record;
    const from = record.state;
    record.candidate_version += 1;
    record.transcript_revision = d.transcript_revision;
    record.intent_type = d.content.intent_type;
    record.evidence_span = d.content.evidence_span;
    record.proposed_utterance = d.content.proposed_utterance;
    record.expiry_policy = d.content.expiry_policy;
    record.urgency = d.content.urgency;
    record.evidence_segment_ids = content.segment_ids;
    record.notes = structuredClone(d.notes);
    record.last_request_id = d.request_id;
    record.last_model_revision = d.transcript_revision;
    record.received_at = d.received_at;
    record.updated_at = d.received_at;
    // 持ち越した候補の REVISE は根拠が今の segment に移る。以後は通常の規則に戻す。
    if (record.carried_over) {
      delete record.carried_over;
      record.segment_id = d.segment_id;
    }
    this.markApplied(d.transcript_revision);
    // REVISE は状態を変えない（再吸気しない、計画 §4.6）。版だけが進む。
    this.emitModelChange(record, from, 'REVISE', d.request_id);
    // 文字の更新と音声の更新を一対一にする（仕様 §5）。新しい版の PCM は G が準備する。
    this.deps.speech.discardCandidate(record.candidate_id, 'candidate_revised', record.candidate_version);
    return okResult('REVISE', record, from, from, verified(content.segment_ids, EVIDENCE_METHOD));
  }

  private applyWithdraw(d: Extract<ModelDecision, { decision: 'WITHDRAW' }>): DecisionResult {
    const target = this.resolveTarget(d, d.target);
    if (!target.ok) return target.rejection;
    const record = target.record;
    const fromAiTurn = d.withdraw_evidence_ai_turns !== undefined;
    const check = fromAiTurn
      ? verifyAiWithdrawEvidence({ span: d.withdraw_evidence_span, ai_turn_texts: d.withdraw_evidence_ai_turns ?? [] })
      : verifyWithdrawEvidence({
          span: d.withdraw_evidence_span,
          segment_ids: d.withdraw_evidence_segment_ids,
          input_segments: d.input_segments,
          latest: this.deps.stable(),
          candidate_evidence_span: record.evidence_span,
          ...(record.carried_over ? { candidate_carried: true } : {}),
        });
    if (!check.ok) return this.rejectModel(d, 'withdraw_evidence_invalid', check.details, { record });
    const from = record.state;
    const evidence_source: WithdrawEvidenceSource = fromAiTurn ? 'ai_utterance' : 'user_utterance';
    const segment_ids = verified(check.segment_ids, fromAiTurn ? WITHDRAW_AI_EVIDENCE_METHOD : WITHDRAW_EVIDENCE_METHOD);
    record.state = 'WITHDRAWN';
    record.updated_at = d.received_at;
    record.last_request_id = d.request_id;
    record.last_model_revision = d.transcript_revision;
    record.received_at = d.received_at;
    record.timeline.resolved_at = d.received_at;
    record.withdraw = {
      source: 'model_decision',
      request_id: d.request_id,
      withdraw_reason: structuredClone(d.withdraw_reason),
      evidence_segment_ids: segment_ids,
      evidence_source,
      ...(d.withdraw_kind ? { withdraw_kind: d.withdraw_kind } : {}),
    };
    this.markApplied(d.transcript_revision);
    this.emitModelChange(record, from, 'WITHDRAW', d.request_id, d.withdraw_kind, evidence_source);
    this.deps.speech.discardCandidate(record.candidate_id, 'candidate_withdrawn');
    return { ...okResult('WITHDRAW', record, from, 'WITHDRAWN'), withdraw_evidence_segment_ids: fromAiTurn ? null : segment_ids };
  }

  // ---- 保留した NEW（E3 で調停） ---------------------------------------------

  /**
   * 保留した NEW を候補にする。根拠と順序は今の時点でもう一度確かめ、通らなければ棄てて candidate.rejected に
   * 理由を残す（details の先頭が 'promote'）。話の後かどうかの判定だけは省く。
   * 呼ぶのは observeUserFloor（人が話を再開した＝話の途中の間だった）と、将来の E3 の調停。
   */
  promoteHeld(at: number): DecisionResult | null {
    const held = this.held;
    if (!held) return null;
    this.held = null;
    const d = { ...held.decision, received_at: at };
    if (d.segment_id < this.currentSegment) return this.rejectModel(d, 'stale_segment', ['promote']);
    if (this.appliedRevision !== null && d.transcript_revision < this.appliedRevision) {
      return this.rejectModel(d, 'stale_transcript_revision', ['promote']);
    }
    return this.applyNew(d, true);
  }

  // ---- コードの遷移（E2、E3、J から） ------------------------------------------

  /** SPEAKING 以外への遷移。SPEAKING は startSpeech を使う（D の版の照合を通すため）。 */
  transition(
    candidate_id: string,
    to: CandidateState,
    cause: CandidateCause,
    at: number,
    expected_version?: number,
  ): TransitionResult {
    const record = this.records.get(candidate_id);
    if (!record) return this.rejectCode(null, candidate_id, 'transition', to, cause, 'unknown_candidate', []);
    if (expected_version !== undefined && expected_version !== record.candidate_version) {
      return this.rejectCode(record, candidate_id, 'transition', to, cause, 'version_mismatch', [
        `expected=${expected_version}`,
        `current=${record.candidate_version}`,
      ]);
    }
    if (to === 'SPEAKING') {
      return this.rejectCode(record, candidate_id, 'transition', to, cause, 'invalid_transition', ['use_startSpeech']);
    }
    const check = checkTransition(record.state, to, cause, this.transitionOptions);
    if (!check.ok) return this.rejectCode(record, candidate_id, 'transition', to, cause, check.reason, check.details);
    const from = record.state;
    if (to === 'WITHDRAWN') this.withdrawByCode(record, cause, at);
    else {
      record.state = to;
      record.updated_at = at;
      if (to === 'SPOKEN') record.timeline.resolved_at = at;
      this.emitCodeChange(record, from, cause);
    }
    return { ok: true, record: toContract(record), from, to };
  }

  /**
   * 候補の発話を始める。原因（turn_allowed など）の判断は呼び手のもの。ここは遷移表と D の版の照合だけを見る。
   * D が拒否したら状態を変えない。candidate_mismatch では D が旧い PCM を棄てている。
   */
  startSpeech(
    candidate_id: string,
    expected_version: number,
    audio_playback_id: number,
    cause: CandidateCause,
    at: number,
  ): SpeechStartResult {
    const record = this.records.get(candidate_id);
    const refused = (r: Rejection): SpeechStartResult => ({ ...r, speech_refusal: null });
    if (!record) {
      return refused(this.rejectCode(null, candidate_id, 'speech_start', 'SPEAKING', cause, 'unknown_candidate', []));
    }
    if (expected_version !== record.candidate_version) {
      return refused(
        this.rejectCode(record, candidate_id, 'speech_start', 'SPEAKING', cause, 'version_mismatch', [
          `expected=${expected_version}`,
          `current=${record.candidate_version}`,
        ]),
      );
    }
    const check = checkTransition(record.state, 'SPEAKING', cause, this.transitionOptions);
    if (!check.ok) {
      return refused(this.rejectCode(record, candidate_id, 'speech_start', 'SPEAKING', cause, check.reason, check.details));
    }
    const started = this.deps.speech.startChecked(audio_playback_id, {
      candidate_id: record.candidate_id,
      candidate_version: record.candidate_version,
    });
    if (!started.ok) {
      return {
        ...this.rejectCode(record, candidate_id, 'speech_start', 'SPEAKING', cause, 'speech_start_refused', [
          started.reason,
          `audio_playback_id=${audio_playback_id}`,
        ]),
        speech_refusal: started.reason,
      };
    }
    const from = record.state;
    record.state = 'SPEAKING';
    record.updated_at = at;
    record.audio_playback_id = audio_playback_id;
    this.emitCodeChange(record, from, cause);
    return { ok: true, record: toContract(record), generation: started.generation };
  }

  /**
   * 発話の終わり。再生 ID が違えば（別の世代の報告）拒否する。
   * 再生の失敗（speech_failed）と 1 音も出なかった終わり（speech_no_audio）は SPOKEN にせず WITHDRAWN で閉じる。
   */
  finishSpeech(
    candidate_id: string,
    audio_playback_id: number,
    cause: 'speech_finished' | 'speech_interrupted' | 'speech_failed' | 'speech_no_audio',
    at: number,
  ): TransitionResult {
    const record = this.records.get(candidate_id);
    const to: CandidateState = cause === 'speech_failed' || cause === 'speech_no_audio' ? 'WITHDRAWN' : 'SPOKEN';
    if (record && record.state === 'SPEAKING' && record.audio_playback_id !== audio_playback_id) {
      return this.rejectCode(record, candidate_id, 'transition', to, cause, 'invalid_transition', [
        'playback_mismatch',
        `audio_playback_id=${audio_playback_id}`,
        `speaking=${record.audio_playback_id}`,
      ]);
    }
    return this.transition(candidate_id, to, cause, at);
  }

  /** 追補2の cue_at（signal.started_at）。最初の合図だけを残す。 */
  noteCueStarted(candidate_id: string, started_at: number): void {
    const record = this.records.get(candidate_id);
    if (record && record.timeline.cue_at === null) record.timeline.cue_at = started_at;
  }

  // ---- 外の状況（J から） ------------------------------------------------------

  /**
   * 人が話しているか（E1 の TurnState.user_speaking）。話の後の NEW の判定に使う。
   * 「話の後」は user_speaking 偽が post_turn_silence_ms 続いたことだけで決めているので、話の途中の長い間も
   * 含みうる。保留中に人が再開したら、その間は話の途中だったとみなし、保留した NEW を棄てずに照合し直して
   * 候補にする（promoteHeld）。照合に通らなければ棄てて理由を残す。結果は呼び手（G）へ返す。
   */
  observeUserFloor(user_speaking: boolean, at: number): { request_id: string; result: DecisionResult } | null {
    if (this.floor && this.floor.user_speaking === user_speaking) return null;
    this.floor = { user_speaking, since: at };
    if (!user_speaking || !this.held) return null;
    const request_id = this.held.decision.request_id;
    const result = this.promoteHeld(at);
    return result ? { request_id, result } : null;
  }

  /**
   * segment_id の変更（AI の発話開始、§4.1 の ASR.reset）。TurnManager は話し始める tick でだけ segment を進めるので、
   * ここへ来たら AI が話し始めたとして覚える（入力の segment がこれより前の判定は rejectAcrossSegment が見る）。
   */
  onSegmentChanged(segment_id: number, at: number): void {
    if (segment_id >= this.currentSegment) this.lastAiStart = { segment_id, at };
    this.advanceSegment(segment_id, at);
  }

  private advanceSegment(segment_id: number, at: number): void {
    if (segment_id <= this.currentSegment) return;
    this.currentSegment = segment_id;
    if (this.held) this.dropHeld(at, 'segment_changed');
    if (this.deps.settings.candidate_expires_on_segment_change === false) return;
    // 持ち越した保留の希望は segment をまたいで残す（期限 candidate_expiry_ms は有効）。
    for (const record of this.withdrawable()) if (!record.carried_over) this.withdrawByCode(record, 'expired', at);
  }

  /**
   * 通常の応答を話し始めた（計画 §4.6「残っている候補は撤回」）。carry が真を返す候補（タイミング段が WAIT_FOR_TURN_END と判定した
   * 希望）は撤回せず、持ち越して保留を続ける（戻り値）。後続の会話で内容を再評価し、期限 candidate_expiry_ms は有効のまま。
   */
  onNormalResponseStarted(at: number, carry?: (record: LedgerRecord) => boolean): CandidateRef[] {
    if (this.held) this.dropHeld(at, 'normal_response_started');
    const carried: CandidateRef[] = [];
    for (const record of this.withdrawable()) {
      if (carry?.(record)) {
        record.carried_over ??= { from_segment_id: this.currentSegment, at };
        carried.push(refOf(record));
      } else {
        this.withdrawByCode(record, 'normal_response_started', at);
      }
    }
    return carried;
  }

  /** 安定テキストが書き換わったとき（transcript_view の rewrote_stable）。根拠の消えた候補を撤回する。 */
  sweepEvidence(at: number): void {
    const latest = this.deps.stable();
    for (const record of this.withdrawable()) {
      if (!record.carried_over && !evidenceStillStable(record.evidence_span, latest)) this.withdrawByCode(record, 'evidence_lost', at);
    }
    if (this.held && !evidenceStillStable(this.held.decision.content.evidence_span, latest)) {
      this.dropHeld(at, 'evidence_lost');
    }
  }

  /** 期限（policy.initiative.candidate_expiry_ms、決定の時刻から）。J の固定周期の tick から呼ぶ。 */
  tick(now: number): void {
    const expiry = this.deps.settings.candidate_expiry_ms;
    if (expiry === null) return;
    for (const record of this.withdrawable()) {
      if (now - record.timeline.decided_at >= expiry) this.withdrawByCode(record, 'expired', now);
    }
    if (this.held && now - this.held.held_at >= expiry) this.dropHeld(now, 'expired');
  }

  // ---- 内部 --------------------------------------------------------------------

  private withdrawable(): LedgerRecord[] {
    return [...this.records.values()].filter((r) => WITHDRAWABLE_STATES.includes(r.state));
  }

  /**
   * segment_id が今より前の入力から出た判定（NEW／KEEP／REVISE）の有効性。無効なら理由を残して棄却する。
   * 根拠の残存は verifyContent（KEEP は applyKeep）、経過時間は G のゲートが見る。ここは「AI が話し始めたか」と
   * 「入力より後の新規の安定文字数」だけを足す（G の数え方は segment をまたぐと少なく出る）。
   * 実際のセッションでは segment が変わるのは AI が話し始めたときだけなので、前者で必ず棄却される。
   * 後者を通るのは segment が判定から進んだ経路（リプレイ）だけ。
   */
  private isKeepOfCarried(d: ModelDecision): boolean {
    return d.decision === 'KEEP' && this.records.get(d.target.candidate_id)?.carried_over !== undefined;
  }

  private rejectAcrossSegment(d: ModelDecision): Rejection | null {
    const where = [`input_segment=${d.segment_id}`, `current=${this.currentSegment}`];
    const start = this.lastAiStart;
    if (start !== null && d.segment_id < start.segment_id) {
      return this.rejectModel(d, 'stale_segment', ['ai_started_speaking', ...where, `ai_started_at=${start.at}`]);
    }
    const limit = this.deps.settings.max_new_stable_chars_since_input ?? null;
    if (limit !== null) {
      const chars = this.newStableCharsSince(d.input_segments);
      if (chars > limit) return this.rejectModel(d, 'stale_segment', ['too_many_new_stable_chars', ...where, `chars=${chars}`, `limit=${limit}`]);
    }
    return null;
  }

  /** 入力より後の新規の安定文字数（正規化後）。入力になかった ASR 区間は全部を新規と数える。 */
  private newStableCharsSince(input: readonly AsrSegmentSnapshot[]): number {
    const before = new Map(input.map((s) => [s.asr_segment_id, normalizeForMatch(s.stable_text).length]));
    let added = 0;
    for (const s of this.deps.stable()) added += Math.max(0, normalizeForMatch(s.stable_text).length - (before.get(s.asr_segment_id) ?? 0));
    return added;
  }

  private isPostTurn(at: number): boolean {
    if (!this.floor || this.floor.user_speaking) return false;
    return at - this.floor.since >= this.deps.settings.post_turn_silence_ms;
  }

  private markApplied(revision: number): void {
    this.appliedRevision = this.appliedRevision === null ? revision : Math.max(this.appliedRevision, revision);
  }

  private verifyContent(
    d: ModelDecision,
    content: CandidateContent,
    record?: LedgerRecord,
  ): { ok: true; segment_ids: number[] } | { ok: false; rejection: Rejection } {
    const evidence = verifyEvidence({
      span: content.evidence_span,
      segment_ids: content.evidence_segment_ids,
      input_segments: d.input_segments,
      latest: this.deps.stable(),
    });
    if (!evidence.ok) return { ok: false, rejection: this.rejectModel(d, 'evidence_invalid', evidence.details, { record }) };
    if (content.proposed_utterance.trim().length === 0) {
      return { ok: false, rejection: this.rejectModel(d, 'proposed_utterance_empty', [], { record }) };
    }
    return { ok: true, segment_ids: evidence.segment_ids };
  }

  private resolveTarget(
    d: ModelDecision,
    target: CandidateRef,
  ): { ok: true; record: LedgerRecord } | { ok: false; rejection: Rejection } {
    const record = this.records.get(target.candidate_id);
    if (!record) {
      return {
        ok: false,
        rejection: this.rejectModel(d, 'unknown_candidate', [`target=${target.candidate_id}`], {
          candidate_id: target.candidate_id,
        }),
      };
    }
    if (!MODEL_APPLICABLE_STATES.includes(record.state)) {
      return { ok: false, rejection: this.rejectModel(d, 'state_not_applicable', [record.state], { record }) };
    }
    if (record.candidate_version !== target.candidate_version) {
      return {
        ok: false,
        rejection: this.rejectModel(
          d,
          'version_mismatch',
          [`expected=${target.candidate_version}`, `current=${record.candidate_version}`],
          { record },
        ),
      };
    }
    return { ok: true, record };
  }

  private createRecord(
    d: Extract<ModelDecision, { decision: 'NEW' }>,
    segment_ids: number[],
    state: CandidateState,
  ): LedgerRecord {
    return this.newRecord(d, d.content, d.notes, segment_ids, state, d.received_at);
  }

  private newRecord(
    meta: { request_id: string; transcript_revision: number; segment_id: number; received_at: number },
    content: CandidateContent,
    notes: CandidateModelNotes,
    segment_ids: number[],
    state: CandidateState,
    decided_at: number,
  ): LedgerRecord {
    this.counter += 1;
    const candidate_id = `c_${String(this.counter).padStart(4, '0')}`;
    const record: LedgerRecord = {
      candidate_id,
      candidate_version: 1,
      state,
      segment_id: meta.segment_id,
      transcript_revision: meta.transcript_revision,
      intent_type: content.intent_type,
      evidence_span: content.evidence_span,
      proposed_utterance: content.proposed_utterance,
      expiry_policy: content.expiry_policy,
      urgency: content.urgency,
      evidence_segment_ids: segment_ids,
      decided_at,
      updated_at: decided_at,
      last_request_id: meta.request_id,
      last_model_revision: meta.transcript_revision,
      received_at: meta.received_at,
      notes: structuredClone(notes),
      timeline: { decided_at, cue_at: null, speech_at: null, resolved_at: null },
      withdraw: null,
      audio_playback_id: null,
    };
    this.records.set(candidate_id, record);
    return record;
  }

  private withdrawByCode(record: LedgerRecord, cause: CandidateCause, at: number): void {
    const from = record.state;
    record.state = 'WITHDRAWN';
    record.updated_at = at;
    record.timeline.resolved_at = at;
    record.withdraw = { source: 'code', cause };
    this.emitCodeChange(record, from, cause);
    this.deps.speech.discardCandidate(record.candidate_id, cause);
  }

  private dropHeld(at: number, why: string): void {
    const held = this.held;
    if (!held) return;
    this.held = null;
    this.emitRejected({
      candidate_id: null,
      candidate_version: null,
      source: 'code',
      operation: 'held',
      current_state: null,
      requested_state: null,
      cause: null,
      request_id: held.decision.request_id,
      reason: 'held_dropped',
      details: [why, `held_at=${held.held_at}`, `dropped_at=${at}`],
      held: false,
      input_transcript_revision: held.decision.transcript_revision,
    });
  }

  private rejectModel(
    d: ModelDecision,
    reason: RejectionReason & string,
    details: string[],
    extra: { held?: boolean; record?: LedgerRecord; candidate_id?: string } = {},
  ): Rejection {
    const record = extra.record ?? null;
    const operation = d.decision;
    if (reason !== 'active_candidate_exists') {
      this.emitRejected({
        candidate_id: record?.candidate_id ?? extra.candidate_id ?? null,
        candidate_version: record?.candidate_version ?? null,
        source: 'model_decision',
        operation,
        current_state: record?.state ?? null,
        requested_state: d.decision === 'WITHDRAW' ? 'WITHDRAWN' : d.decision === 'NEW' ? 'INTENT_READY' : null,
        cause: null,
        request_id: d.request_id,
        reason,
        details,
        held: extra.held ?? false,
        input_transcript_revision: d.transcript_revision,
      });
    }
    return { ok: false, reason, details, held: extra.held ?? false, ref: record ? refOf(record) : null };
  }

  private rejectCode(
    record: LedgerRecord | null,
    candidate_id: string,
    operation: 'transition' | 'speech_start',
    to: CandidateState,
    cause: CandidateCause,
    reason: Exclude<RejectionReason, 'active_candidate_exists'>,
    details: string[],
  ): Rejection {
    this.emitRejected({
      candidate_id,
      candidate_version: record?.candidate_version ?? null,
      source: 'code',
      operation,
      current_state: record?.state ?? null,
      requested_state: to,
      cause,
      request_id: null,
      reason,
      details,
      held: false,
      input_transcript_revision: null,
    });
    return { ok: false, reason, details, held: false, ref: record ? refOf(record) : null };
  }

  private emitRejected(e: {
    candidate_id: string | null;
    candidate_version: number | null;
    source: 'model_decision' | 'code';
    operation: 'NONE' | 'NEW' | 'KEEP' | 'REVISE' | 'WITHDRAW' | 'transition' | 'speech_start' | 'held';
    current_state: CandidateState | null;
    requested_state: CandidateState | null;
    cause: CandidateCause | null;
    request_id: string | null;
    reason: Exclude<RejectionReason, 'active_candidate_exists'>;
    details: string[];
    held: boolean;
    input_transcript_revision: number | null;
  }): void {
    this.deps.emitter.emit({
      event: 'candidate.rejected',
      candidate_id: e.candidate_id !== null ? present(e.candidate_id) : absent('not_numbered'),
      candidate_version: e.candidate_version !== null ? present(e.candidate_version) : absent('not_numbered'),
      source: e.source,
      operation: e.operation,
      current_state: e.current_state,
      requested_state: e.requested_state,
      cause: e.cause,
      request_id: e.request_id !== null ? present(e.request_id) : absent(CODE),
      reason: e.reason,
      details: e.details.filter((s) => s.length > 0),
      held: e.held,
      input_transcript_revision:
        e.input_transcript_revision !== null ? present(e.input_transcript_revision) : absent(CODE),
      applied_transcript_revision:
        this.appliedRevision !== null ? present(this.appliedRevision) : absent('no_decision_applied_yet'),
    });
  }

  private emitCodeChange(record: LedgerRecord, from: CandidateState | null, cause: CandidateCause): void {
    this.deps.emitter.emit({
      event: 'candidate.state_changed',
      candidate_id: record.candidate_id,
      candidate_version: record.candidate_version,
      from,
      to: record.state,
      cause_source: 'code',
      cause,
    });
  }

  private emitModelChange(
    record: LedgerRecord,
    from: CandidateState | null,
    decision: 'NEW' | 'REVISE' | 'WITHDRAW',
    request_id: string,
    withdraw_kind?: ContentWithdrawKind,
    evidence_source?: WithdrawEvidenceSource,
  ): void {
    this.deps.emitter.emit({
      event: 'candidate.state_changed',
      candidate_id: record.candidate_id,
      candidate_version: record.candidate_version,
      from,
      to: record.state,
      cause_source: 'model_decision',
      decision,
      request_id,
      ...(withdraw_kind ? { withdraw_kind: modelOutput(withdraw_kind) } : {}),
      ...(evidence_source ? { withdraw_evidence_source: verified(evidence_source, EVIDENCE_SOURCE_METHOD) } : {}),
    });
  }
}

const EVIDENCE_METHOD = 'e2a_listed_segments_contain_span_and_exist_in_latest';
const WITHDRAW_EVIDENCE_METHOD = 'e2a_listed_segments_contain_span_after_candidate';
const WITHDRAW_AI_EVIDENCE_METHOD = 'e2a_span_in_shown_ai_turn';
const EVIDENCE_SOURCE_METHOD = 'e2a_withdraw_evidence_matched_verbatim';

function refOf(record: LedgerRecord): CandidateRef {
  return { candidate_id: record.candidate_id, candidate_version: record.candidate_version };
}

function toContract(record: LedgerRecord): CandidateRecord {
  return {
    candidate_id: record.candidate_id,
    candidate_version: record.candidate_version,
    state: record.state,
    segment_id: record.segment_id,
    transcript_revision: record.transcript_revision,
    intent_type: record.intent_type,
    evidence_span: record.evidence_span,
    proposed_utterance: record.proposed_utterance,
    expiry_policy: record.expiry_policy,
    urgency: record.urgency,
    evidence_segment_ids: [...record.evidence_segment_ids],
    decided_at: record.decided_at,
    updated_at: record.updated_at,
    ...(record.carried_over ? { carried_over: { ...record.carried_over } } : {}),
  };
}

function okResult(
  decision: ModelDecision['decision'],
  record: LedgerRecord | null,
  from: CandidateState | null,
  to: CandidateState | null,
  evidence_segment_ids: ReturnType<typeof verified<number[]>> | null = null,
): Extract<DecisionResult, { ok: true }> {
  return {
    ok: true,
    decision,
    ref: record ? refOf(record) : null,
    from,
    to,
    evidence_segment_ids,
    withdraw_evidence_segment_ids: null,
  };
}
