/**
 * 発話希望を実際の振る舞いにつなぐ配線（波3: E2 の合図、E3 の選択。計画 §4.6）。判断は control/negotiator.ts の
 * 純粋関数で、ここは値を集めて渡し、結果を E2a（CandidateLedger）、D（SpeechGenerator）、ブラウザへ届けるだけ。
 *
 *   tick の始め（TurnManager の step の前）: beforeStep
 *     候補の先行音声の準備（条件 reactive では作らない）→ negotiate（合図、吸気の完了、DEFERRED、合図の解除）
 *     合図と音声の準備は同じ tick で始める（音声の完成を待たない。known_gaps §11）
 *     → 吸気中と吸気の後に音声を待つ間は、通常の応答を含めて開始を保留する理由を返す（TurnInputs.start_blocked_reason へ）
 *   step の後: select（許可が出ていれば候補と通常の応答のどちらを話すか）
 *   候補の発話を始めたら: startCandidate（E2a の startSpeech が D の版と PCM の一致を確かめる）
 *
 * 候補の発話の文は候補の proposed_utterance をそのまま TTS に渡す（作り直す LLM の呼び出しはしない）。
 * 撤回と改訂のときの未再生の PCM の破棄は E2a（ledger の discardCandidate）が行う。
 * 吸気の長さは orchestrator が決め、完了は orchestrator の時計で判定する（ブラウザの報告は記録だけ）。
 *
 * 重複発言の防止（docs/initiative_v3_design.md §9）。候補を話す直前（select）と AI の発話の後（onAiSpeechFinished）に、
 * AI がすでに話した文（履歴の発話済みの部分）と候補を比べる。すでに話した内容なら話さず撤回し、聞き手へ戻す。
 * どちらもコードの比較だけで、通常応答の開始も準備も待たせない。通常応答に渡した材料の反映の推定も発話の後に出す。
 */
import { absent, modelOutput, present, verified } from '@llm-vap/contracts';
import type {
  Condition,
  ConversationHistoryReader,
  EventEmitter,
  NodeToBrowser,
  PrepareRequest,
  PolicyJa,
  SignalReport,
  TimeMapping,
} from '@llm-vap/contracts';
import { atFromBrowser } from '@llm-vap/contracts';
import {
  initialNegotiatorState,
  negotiate,
  observeCueReaction,
  reasonKey,
  releaseForSpeech,
  releaseForWithdrawal,
  selectSpeech,
  startCueReaction,
} from '../control/negotiator';
import type {
  CandidateAudio,
  CandidateView,
  CueReaction,
  GateResult,
  NegotiatorAction,
  NegotiatorSettings,
  NegotiatorState,
  Selection,
} from '../control/negotiator';
import type { TurnState } from '../control';
import { estimateReflection, findAlreadySaid, matchSpoken } from '../cognition/initiative/already_said';
import type { AlreadySaidMatch } from '../cognition/initiative/already_said';
import type { SpeechFinished, SpeechGeneratorImpl, SpeechStateChange } from '../speech';
import type { PendingResponseMaterial } from '../speech/response_prompt';
import { PENDING_MATERIAL_PROMPT_VERSION, RESPONSE_PROMPT_VERSION } from '../speech/response_prompt';
import type { InitiativeWiring } from './initiative_wiring';

/** 方策と条件から交渉の設定を作る。negotiation の節がなければ null（候補を記録するだけ、波2の振る舞い）。 */
export function negotiatorSettings(policy: PolicyJa, condition: Condition, options: { timing_gate?: boolean } = {}): NegotiatorSettings | null {
  const n = policy.initiative.negotiation;
  if (!n) return null;
  const maxChars = n.max_new_stable_chars_since_judgement ?? policy.initiative.max_new_stable_chars_since_input;
  const maxAge = n.cue_max_judgement_age_ms ?? policy.initiative.max_result_age_ms;
  if (maxChars === null || maxAge === null) return null;
  return {
    condition,
    inhale_ms: n.inhale_ms,
    hold_max_ms: n.hold_max_ms,
    signal_cooldown_ms: policy.initiative.signal_cooldown_ms,
    max_active_candidates: policy.initiative.max_active_candidates,
    max_new_stable_chars_since_judgement: maxChars,
    cue_max_judgement_age_ms: maxAge,
    ...(options.timing_gate ? { timing_gate: true } : {}),
    ...(n.cue_reaction_window_ms !== undefined ? { cue_reaction_window_ms: n.cue_reaction_window_ms } : {}),
  };
}

type SpeechPort = Pick<SpeechGeneratorImpl, 'prepare' | 'stateOf'>;

export interface NegotiationWiringOptions {
  settings: NegotiatorSettings;
  initiative: InitiativeWiring;
  emitter: EventEmitter;
  /** D。後から作られるので関数で渡す。null なら候補の音声は作れない（候補は話さない）。 */
  speech: () => SpeechPort | null;
  /** ブラウザへ送る。送れなかったら false（送れなかった合図は signal.sent に残さない）。 */
  send: (message: NodeToBrowser) => boolean;
  /** 時刻（D の状態の通知の時点の記録に使う）。 */
  now: () => number;
  /** AI の発話の履歴（実際に話した部分）。発話の直前のガードが読む。省略は比べない。 */
  history?: Pick<ConversationHistoryReader, 'snapshot'>;
  /** 重複発言の防止と反映の推定の基準（policy.initiative.staged の暫定値）。省略はそれぞれ行わない。 */
  repeat_guard?: { already_said_min_similarity?: number; reflection_min_containment?: number };
}

/** 通常応答に渡した材料（initiative.response_material）。その応答の再生の結果と結ぶ。 */
interface GivenMaterial {
  candidate_id: string;
  candidate_version: number;
  segment_id: number;
  transcript_revision: number;
  proposed_utterance: string;
  played: boolean;
}

export interface BeforeStepContext {
  now: number;
  ai_speaking: boolean;
  avatar_available: boolean;
  user_speaking: boolean;
  /** 前の tick の許可（TurnManager の permitted_to_speak）。 */
  permitted?: boolean;
  /** VAP の AI 側の p_now（合図の後の反応の観測）。使えないときは null。 */
  p_now_ai?: number | null;
  /** TurnManager の招待の検出（前の tick の値。申し出の状況の観測）。省略は検出なし。 */
  invitation_detected?: boolean;
}

export interface CandidateChoice extends Selection {
  candidate: CandidateView | null;
  /** 候補を話すときの音声（D の audio_playback_id）と、E2a の記録の transcript_revision。user_text は人の発話（失敗の復帰用）。 */
  audio_playback_id: number | null;
  transcript_revision: number | null;
  user_text: string | null;
}

interface PreparedAudio {
  candidate_version: number;
  audio_playback_id: number;
}

interface SentCue {
  cue_id: string;
  candidate_id: string;
  parameters: Record<string, number | string | boolean>;
}

export class NegotiationWiring {
  readonly settings: NegotiatorSettings;
  private state: NegotiatorState = initialNegotiatorState();
  private readonly audio = new Map<string, PreparedAudio>();
  private readonly cues = new Map<string, SentCue>();
  private lastGateKey = '';
  private lastSelectionKey = '';
  /** 開始できなかった理由の最後（同じ理由を tick ごとに記録しない。lastSelectionKey とは別に持つ）。 */
  private lastNotStartedKey = '';
  /** 観測中の合図の後の反応（合図ごと。窓の満了か AI の発話の開始か候補の解決で閉じる）。 */
  private readonly reactions = new Map<string, CueReaction>();
  /** 材料を渡した応答の準備の要求。D の状態の通知（同じ要求のオブジェクト）で再生の番号と結ぶ。 */
  private readonly givenMaterials = new WeakMap<PrepareRequest, GivenMaterial>();
  private readonly materialByPlayback = new Map<number, GivenMaterial>();
  /** 棄てた候補の未再生の音声（撤回、改訂、期限）。D の状態の通知から。試験と研究者向け（JSONL には専用の項目がない）。 */
  readonly discardedAudio: { candidate_id: string; candidate_version: number; reason: string; chunks: number; samples: number }[] = [];
  /** 試験と研究者向けの数。 */
  readonly counters = { cues: 0, deferred: 0, candidate_speech_started: 0, candidate_speech_refused: 0, signal_reports_unmatched: 0, signals_not_sent: 0 };

  constructor(private readonly options: NegotiationWiringOptions) {
    this.settings = options.settings;
  }

  negotiatorState(): NegotiatorState {
    return structuredClone(this.state);
  }

  /** tick の始め。吸気中なら開始を保留する理由を返す。 */
  beforeStep(ctx: BeforeStepContext): string | null {
    this.prepareAudio();
    const views = this.views();
    const step = negotiate(this.settings, this.state, {
      now: ctx.now,
      candidates: views,
      ai_speaking: ctx.ai_speaking,
      avatar_available: ctx.avatar_available,
      user_speaking: ctx.user_speaking,
      permitted: ctx.permitted ?? false,
    });
    this.state = step.state;
    for (const action of step.actions) this.apply(action, ctx.now, ctx);
    if (step.gate !== null) this.logGate(step.gate);
    this.observeReactions(ctx);
    this.options.initiative.offers.observe({
      now: ctx.now,
      user_speaking: ctx.user_speaking,
      ai_speaking: ctx.ai_speaking,
      invitation_detected: ctx.invitation_detected ?? false,
      live_candidate_ids: new Set(this.options.initiative.ledger.list().map((c) => c.candidate_id)),
    });
    // 合図を E2a が拒否した（apply で cue を消した）なら吸気の保留は要らない。延期中の音声待ちは cue を持たない。
    return step.state.cue !== null && this.state.cue === null ? null : step.hold_start;
  }

  /** 未解決の候補があるか（選択の前の計算を省くため）。 */
  hasCandidate(): boolean {
    return this.options.initiative.ledger.list().length > 0;
  }

  /** step の後。許可が出ていれば、候補と通常の応答のどちらを話すかを決め、判断が変わったら記録する。 */
  select(now: number, turn: TurnState): CandidateChoice {
    const view = this.views()[0] ?? null;
    const selection = selectSpeech(this.settings, {
      candidate: view,
      permitted: turn.permitted_to_speak,
      invitation: turn.invitation,
      user_text: turn.asr_result,
    });
    const record = view ? this.options.initiative.ledger.get(view.candidate_id) : null;
    const audio = view ? this.audio.get(view.candidate_id) : undefined;
    const choice: CandidateChoice = {
      ...selection,
      candidate: view,
      audio_playback_id: audio && view && audio.candidate_version === view.candidate_version ? audio.audio_playback_id : null,
      transcript_revision: record?.transcript_revision ?? null,
      user_text: turn.asr_result,
    };
    // 候補を話す直前のガード（コードの比較だけ）。すでに話した内容なら話さず撤回して、通常応答の経路へ渡す。
    if (selection.choice === 'candidate' && record !== null) {
      const said = this.findAlreadySaid(record.proposed_utterance);
      if (said !== null) {
        this.withdrawAlreadySaid(record.candidate_id, record.candidate_version, record.proposed_utterance, said, 'before_speech', now);
        const withdrawn: CandidateChoice = { ...choice, choice: 'response', reasons: [`already_said:similarity=${said.similarity.toFixed(3)}`], cause: null };
        this.emitSelection(withdrawn);
        return withdrawn;
      }
    }
    // 許可がない間と、候補のない通常の応答は記録しない（tick ごとに出さない）。
    if (selection.choice === 'none') this.lastNotStartedKey = '';
    else if (view !== null) this.logSelection(choice, false);
    return choice;
  }

  /** 選んだ候補を話せなかった（TurnManager が開始しなかった、など）。同じ理由が続く間は1回だけ記録する。 */
  noteSelectionNotStarted(choice: CandidateChoice, reason: string): void {
    // reason の頭2語（start_blocked:another_playback_active など）が理由の種類。残りは ID や数値。
    const key = `${choice.candidate?.candidate_id ?? '-'}@${choice.candidate?.candidate_version ?? '-'}|${reason.split(':').slice(0, 2).join(':')}`;
    if (key === this.lastNotStartedKey) return;
    this.lastNotStartedKey = key;
    this.emitSelection({ ...choice, choice: 'wait', reasons: [...choice.reasons, `not_started:${reason}`] });
  }

  /**
   * 候補の発話を始める。E2a の startSpeech が遷移表と D の版・PCM の照合を通す。拒否なら理由を返す（呼び手が開始を戻す）。
   */
  startCandidate(choice: CandidateChoice, audio_playback_id: number, now: number): string | null {
    const view = choice.candidate;
    if (view === null || choice.cause === null) return 'no_candidate_selected';
    const result = this.options.initiative.ledger.startSpeech(
      view.candidate_id,
      view.candidate_version,
      audio_playback_id,
      choice.cause,
      now,
    );
    if (!result.ok) {
      this.counters.candidate_speech_refused += 1;
      this.logSelection({ ...choice, choice: 'wait', reasons: [...choice.reasons, `start_refused:${result.reason}`] }, true);
      return result.speech_refusal ?? result.reason;
    }
    this.counters.candidate_speech_started += 1;
    this.lastNotStartedKey = '';
    this.audio.delete(view.candidate_id);
    this.logSelection(choice, true);
    const released = releaseForSpeech(this.state, view.candidate_id);
    this.state = released.state;
    if (released.action) this.apply(released.action, now);
    // DEFERRED からの発話は再吸気せず、短い準備動作だけを行う（計画 §4.6）。
    else if (view.state === 'DEFERRED') this.options.send({ type: 'breath.prepare', candidate_id: view.candidate_id });
    return null;
  }

  /** D の状態の通知。候補の音声を取り消した（未再生の PCM を棄てた）ものを記録する。材料を渡した応答の取り消しも記録する。 */
  onSpeechState(change: SpeechStateChange): void {
    const origin = change.request.origin;
    if (origin.kind !== 'candidate') {
      this.noteResponseState(change);
      return;
    }
    if (change.state === 'ready' || change.state === 'failed') {
      this.emitAudio(origin.candidate_id, origin.candidate_version, change.state, change.audio_playback_id, change.reason);
      return;
    }
    if (change.state !== 'cancelled') return;
    this.discardedAudio.push({
      candidate_id: origin.candidate_id,
      candidate_version: origin.candidate_version,
      reason: change.reason ?? 'cancelled',
      chunks: change.discarded?.chunks ?? 0,
      samples: change.discarded?.samples ?? 0,
    });
    if (this.discardedAudio.length > 64) this.discardedAudio.shift();
  }

  /** ブラウザの描画の報告（記録だけ。吸気の完了の判定には使わない）。 */
  onSignalReport(report: SignalReport, mapping: TimeMapping | null): boolean {
    // Node の指示なしで始まる局面（保持 ready、短い準備、保持の上限の脱力）は同じ phase の合図がないので、その候補の最新の合図へ結びつける。
    const ofCandidate = [...this.cues.values()].filter((c) => c.candidate_id === report.candidate_id);
    const exact = ofCandidate.find((c) => this.phaseMatches(c, report.phase));
    const cue = exact ?? ofCandidate.at(-1);
    if (cue === undefined || mapping === null) {
      this.counters.signal_reports_unmatched += 1;
      return false;
    }
    const parameters = { ...cue.parameters, reported_phase: report.phase, ...(exact ? {} : { report_origin: 'browser_without_command' }) };
    const client = report.client_t_ms.value;
    const nullReason = report.client_t_ms.value === null ? report.client_t_ms.null_reason : 'not_visible';
    if (report.state === 'started') {
      if (report.visible && client !== null) {
        const at = atFromBrowser(client, mapping);
        const started_at = Math.max(0, mapping.toServerMs(client));
        this.options.emitter.emit(
          { event: 'signal.started', candidate_id: report.candidate_id, phase: report.phase, parameters, visible: true, started_at },
          at,
        );
        if (report.phase === 'inhale') {
          this.options.initiative.ledger.noteCueStarted(report.candidate_id, started_at);
          this.options.initiative.offers.noteReport(report.candidate_id, cue.cue_id, { visible: true, started_at });
        }
      } else {
        if (report.phase === 'inhale') this.options.initiative.offers.noteReport(report.candidate_id, cue.cue_id, { visible: false });
        this.options.emitter.emit({
          event: 'signal.started',
          candidate_id: report.candidate_id,
          phase: report.phase,
          parameters,
          visible: false,
          started_at: null,
          null_reason: nullReason,
        });
      }
    } else {
      this.options.emitter.emit({
        event: 'signal.ended',
        candidate_id: report.candidate_id,
        phase: report.phase,
        parameters,
        visible: report.visible,
        ended_at: client !== null ? present(Math.max(0, mapping.toServerMs(client))) : absent(nullReason),
      });
    }
    return true;
  }

  /** 保留の希望（WAIT の候補）の持ち越しつきで、通常応答の開始を E2a へ伝える。吸気あり以外は従来どおり全部撤回。 */
  onNormalResponseStarted(now: number): void {
    const { ledger, monitor } = this.options.initiative;
    const carries = this.settings.condition === 'initiative_inhale' && this.settings.timing_gate === true;
    const carried = ledger.onNormalResponseStarted(
      now,
      carries ? (record) => record.state === 'INTENT_READY' && monitor.latestTiming(record.candidate_id, record.candidate_version)?.timing === 'WAIT_FOR_TURN_END' : undefined,
    );
    for (const ref of carried) {
      const record = ledger.get(ref.candidate_id);
      if (!record?.carried_over) continue;
      this.options.emitter.emit({
        event: 'initiative.not_offered',
        candidate_id: ref.candidate_id,
        candidate_version: ref.candidate_version,
        segment_id: record.carried_over.from_segment_id,
        at: now,
        reason: 'wait_for_turn_end',
      });
    }
  }

  /** 通常応答の準備の時点で、保留中の希望（WAIT の候補）があれば材料として渡す。記録は「渡した」事実だけ（使われたかは分からない）。 */
  responseMaterial(request: PrepareRequest, now: number): PendingResponseMaterial | null {
    if (request.origin.kind !== 'response') return null;
    if (this.settings.condition !== 'initiative_inhale' || this.settings.timing_gate !== true) return null;
    const { ledger, monitor } = this.options.initiative;
    for (const record of ledger.list()) {
      if (record.state !== 'INTENT_READY') continue;
      if (monitor.latestTiming(record.candidate_id, record.candidate_version)?.timing !== 'WAIT_FOR_TURN_END') continue;
      this.options.emitter.emit({
        event: 'initiative.response_material',
        candidate_id: record.candidate_id,
        candidate_version: record.candidate_version,
        segment_id: request.segment_id,
        transcript_revision: request.transcript_revision,
        prompt_version: `${RESPONSE_PROMPT_VERSION}+${PENDING_MATERIAL_PROMPT_VERSION}`,
        proposed_utterance: modelOutput(record.proposed_utterance),
        at: now,
      });
      this.givenMaterials.set(request, {
        candidate_id: record.candidate_id,
        candidate_version: record.candidate_version,
        segment_id: request.segment_id,
        transcript_revision: request.transcript_revision,
        proposed_utterance: record.proposed_utterance,
        played: false,
      });
      return { intent_type: record.intent_type, proposed_utterance: record.proposed_utterance };
    }
    return null;
  }

  /** AI の発話の終わり（履歴へ確定した後）。反映の推定を記録し、すでに話した内容になった保留中の候補を撤回する。通常応答を待たせない。 */
  onAiSpeechFinished(finished: SpeechFinished, now: number): void {
    this.emitReflection(finished, now);
    this.reconcilePending(finished, now);
  }

  /** セッションの終わりで、観測中の反応を閉じる。 */
  finishReactions(now: number): void {
    for (const [cue_id, reaction] of [...this.reactions]) this.closeReaction(cue_id, reaction, now, 'session_ended');
  }

  // ---- 重複発言の防止と反映の推定（コードの比較） ------------------------------------------

  /** すでに AI が話した内容か（履歴の発話済みの部分と比べる）。基準か履歴がなければ比べない。 */
  private findAlreadySaid(utterance: string): AlreadySaidMatch | null {
    const threshold = this.options.repeat_guard?.already_said_min_similarity;
    const history = this.options.history;
    if (threshold === undefined || !history) return null;
    return findAlreadySaid(utterance, history.snapshot(), threshold);
  }

  /** すでに話した内容なので撤回する。音声は E2a が棄て、合図は解く（聞き手に戻す）。 */
  private withdrawAlreadySaid(candidate_id: string, candidate_version: number, utterance: string, said: AlreadySaidMatch, stage: 'before_speech' | 'after_ai_speech', now: number): void {
    const moved = this.options.initiative.ledger.transition(candidate_id, 'WITHDRAWN', 'already_said', now, candidate_version);
    if (!moved.ok) return;
    this.options.emitter.emit({
      event: 'initiative.already_said',
      candidate_id,
      candidate_version,
      stage,
      candidate_state: moved.from,
      proposed_utterance: modelOutput(utterance),
      comparison: verified({ method: said.method, similarity: said.similarity, threshold: said.threshold, matched_text: said.matched_text }, 'negotiation_already_said_comparison'),
      matched_audio_playback_id: said.audio_playback_id,
      matched_origin: said.origin,
      at: now,
    });
    const released = releaseForWithdrawal(this.state, candidate_id);
    this.state = released.state;
    for (const action of released.actions) this.apply(action, now);
  }

  /** AI の発話の後の照合。保留中の候補と、この発話で話した部分を比べる。話していない発話（1 音も出ない）は見ない。 */
  private reconcilePending(finished: SpeechFinished, now: number): void {
    const threshold = this.options.repeat_guard?.already_said_min_similarity;
    // 吸気の後の短い声は already_said の照合の対象にしない（session からは呼ばないが、型の上でも除く）。
    if (threshold === undefined || finished.no_audio || finished.spoken_text === '' || finished.origin.kind === 'vocal_cue') return;
    const ledger = this.options.initiative.ledger;
    for (const record of ledger.list()) {
      if (record.state === 'SPEAKING') continue;
      const match = matchSpoken(record.proposed_utterance, finished.spoken_text, { threshold, audio_playback_id: finished.audio_playback_id, origin: finished.origin.kind });
      if (match !== null) this.withdrawAlreadySaid(record.candidate_id, record.candidate_version, record.proposed_utterance, match, 'after_ai_speech', now);
    }
  }

  /** 通常応答の D の状態。材料を渡した応答を再生の番号と結び、再生しないまま取り消されたら not_spoken を記録する。 */
  private noteResponseState(change: SpeechStateChange): void {
    const material = this.givenMaterials.get(change.request);
    if (material === undefined) return;
    this.materialByPlayback.set(change.audio_playback_id, material);
    while (this.materialByPlayback.size > 64) this.materialByPlayback.delete(this.materialByPlayback.keys().next().value as number);
    if (change.state === 'playing') material.played = true;
    if (change.state !== 'cancelled' && !(change.state === 'failed' && !material.played)) return;
    this.materialByPlayback.delete(change.audio_playback_id);
    this.givenMaterials.delete(change.request);
    this.emitReflectionEvent(material, change.audio_playback_id, null, this.options.now());
  }

  /** 発話の終わりで、材料の応答の結果を記録する。割り込みは話した部分だけで比べる。 */
  private emitReflection(finished: SpeechFinished, now: number): void {
    const material = this.materialByPlayback.get(finished.audio_playback_id);
    if (material === undefined) return;
    this.materialByPlayback.delete(finished.audio_playback_id);
    this.emitReflectionEvent(material, finished.audio_playback_id, finished, now);
  }

  private emitReflectionEvent(material: GivenMaterial, audio_playback_id: number, finished: SpeechFinished | null, now: number): void {
    const threshold = this.options.repeat_guard?.reflection_min_containment;
    const spokenText = finished !== null && !finished.no_audio ? finished.spoken_text : '';
    const spoken = spokenText !== '';
    const outcome = !spoken ? ('not_spoken' as const) : finished?.interrupted ? ('partly_spoken' as const) : ('spoken' as const);
    const result = spoken && threshold !== undefined ? estimateReflection(material.proposed_utterance, spokenText, threshold) : null;
    const missing = !spoken ? 'not_spoken' : 'reflection_threshold_unset';
    this.options.emitter.emit({
      event: 'initiative.response_reflection',
      candidate_id: material.candidate_id,
      candidate_version: material.candidate_version,
      segment_id: material.segment_id,
      transcript_revision: material.transcript_revision,
      audio_playback_id: finished === null && !material.played ? absent('not_played') : present(audio_playback_id),
      proposed_utterance: modelOutput(material.proposed_utterance),
      spoken_text: spokenText,
      spoken_text_precision: finished !== null && spoken ? present(finished.spoken_text_precision) : absent(missing),
      interrupted: finished?.interrupted ?? false,
      spoken_outcome: outcome,
      estimated_reflected: result ? present(result.estimated_reflected) : absent(missing),
      estimate: result ? present(result.estimate) : absent(missing),
      at: now,
    });
  }

  private phaseMatches(cue: SentCue, phase: SignalReport['phase']): boolean {
    return phase === cue.parameters.phase_sent;
  }

  // ---- 内部 ----------------------------------------------------------------------

  /** 観測中の合図を tick ごとに更新し、窓の満了、AI の発話の開始、候補の解決で閉じる。 */
  private observeReactions(ctx: BeforeStepContext): void {
    const ledger = this.options.initiative.ledger;
    for (const [cue_id, reaction] of [...this.reactions]) {
      // 合図を出した tick は startCueReaction が数えた（同じ tick を二重に数えない）。
      if (ctx.now === reaction.cue_sent_at) continue;
      const record = ledger.get(reaction.candidate_id);
      const state = record?.state ?? null;
      const next = observeCueReaction(reaction, ctx.now, { user_speaking: ctx.user_speaking, p_now_ai: ctx.p_now_ai ?? null, candidate_state: state });
      const resolved = state === null || state === 'WITHDRAWN' || state === 'SPOKEN';
      if (ctx.ai_speaking) this.closeReaction(cue_id, next, ctx.now, 'ai_speech_started');
      else if (resolved) this.closeReaction(cue_id, next, ctx.now, 'candidate_withdrawn');
      else if (ctx.now - next.cue_sent_at >= next.window_ms) this.closeReaction(cue_id, next, ctx.now, 'window');
      else this.reactions.set(cue_id, next);
    }
  }

  private closeReaction(cue_id: string, reaction: CueReaction, now: number, ended_by: 'window' | 'ai_speech_started' | 'candidate_withdrawn' | 'session_ended'): void {
    this.reactions.delete(cue_id);
    const speakingAtCue = reaction.user_speaking_at_cue;
    const vap = (value: number | null) => (value === null ? absent('vap_unavailable') : present(value));
    this.options.emitter.emit({
      event: 'negotiation.cue_reaction',
      cue_id,
      candidate_id: reaction.candidate_id,
      candidate_version: reaction.candidate_version,
      cue_sent_at: reaction.cue_sent_at,
      ended_at: now,
      window_ms: reaction.window_ms,
      ended_by,
      observed_ms: Math.max(0, now - reaction.cue_sent_at),
      ticks: reaction.ticks,
      user_speaking_ticks: reaction.user_speaking_ticks,
      user_speaking_at_cue: speakingAtCue,
      user_speaking_at_end: reaction.last_user_speaking,
      time_to_user_stop_ms: !speakingAtCue
        ? absent('user_not_speaking_at_cue')
        : reaction.user_stopped_at === null
          ? absent('user_did_not_stop_in_window')
          : present(Math.max(0, reaction.user_stopped_at - reaction.cue_sent_at)),
      time_to_user_start_ms: speakingAtCue
        ? absent('user_speaking_at_cue')
        : reaction.user_started_at === null
          ? absent('user_did_not_start_in_window')
          : present(Math.max(0, reaction.user_started_at - reaction.cue_sent_at)),
      p_now_ai_at_cue: vap(reaction.p_at_cue),
      p_now_ai_at_end: vap(reaction.p_last),
      p_now_ai_min: vap(reaction.p_min),
      p_now_ai_max: vap(reaction.p_max),
      candidate_states: reaction.states,
    });
  }

  /** 候補の先行音声。候補の文（proposed_utterance）をそのまま TTS へ。条件 reactive では作らない（話さないので費用だけかかる）。 */
  private prepareAudio(): void {
    if (this.settings.condition === 'reactive') return;
    const { monitor } = this.options.initiative;
    const speech = this.options.speech();
    if (speech === null) return;
    const ledger = this.options.initiative.ledger;
    const live = new Set<string>();
    for (const record of ledger.list()) {
      live.add(record.candidate_id);
      if (record.state === 'SPEAKING') continue;
      // 吸気ありの WAIT_FOR_TURN_END は話さないので作らない（OFFER_NOW に変わったらこの tick で作る）。
      if (this.settings.condition === 'initiative_inhale' && record.state === 'INTENT_READY' && monitor.latestTiming(record.candidate_id, record.candidate_version)?.timing === 'WAIT_FOR_TURN_END') continue;
      const prepared = this.audio.get(record.candidate_id);
      if (prepared && prepared.candidate_version === record.candidate_version) continue;
      // 古い版の PCM は E2a が REVISE のときに棄てている（discardCandidate）。
      const { audio_playback_id } = speech.prepare({
        segment_id: record.segment_id,
        transcript_revision: record.transcript_revision,
        text: record.proposed_utterance,
        origin: { kind: 'candidate', candidate_id: record.candidate_id, candidate_version: record.candidate_version },
      });
      this.audio.set(record.candidate_id, { candidate_version: record.candidate_version, audio_playback_id });
      this.emitAudio(record.candidate_id, record.candidate_version, 'preparing', audio_playback_id, null);
    }
    for (const id of [...this.audio.keys()]) if (!live.has(id)) this.audio.delete(id);
  }

  private audioOf(candidate_id: string, version: number): CandidateAudio {
    const prepared = this.audio.get(candidate_id);
    if (!prepared || prepared.candidate_version !== version) return 'none';
    const state = this.options.speech()?.stateOf(prepared.audio_playback_id) ?? null;
    if (state === 'preparing') return 'preparing';
    if (state === 'ready') return 'ready';
    return 'failed';
  }

  /** 未解決の候補の今の値（吸気の後の短い声の判定が読む）。 */
  candidateViews(): CandidateView[] {
    return this.views();
  }

  private views(): CandidateView[] {
    const { ledger, monitor } = this.options.initiative;
    return ledger.list().map((c) => {
      const record = ledger.getRecord(c.candidate_id);
      return {
        candidate_id: c.candidate_id,
        candidate_version: c.candidate_version,
        state: c.state,
        judged_at: record?.received_at ?? c.decided_at,
        new_chars_since_judgement: record ? monitor.stableCharsSinceInput(record.last_request_id) : null,
        audio: this.audioOf(c.candidate_id, c.candidate_version),
        timing: monitor.latestTiming(c.candidate_id, c.candidate_version)?.timing ?? null,
      };
    });
  }

  private apply(action: NegotiatorAction, now: number, ctx?: BeforeStepContext): void {
    const ledger = this.options.initiative.ledger;
    switch (action.kind) {
      case 'cue': {
        const moved = ledger.transition(action.candidate_id, 'BREATH_INHALE', 'signal_gate_allowed', now, action.candidate_version);
        if (!moved.ok) {
          // E2a が拒否した（理由は candidate.rejected）。合図は出さない。冷却時間は進めたまま（連続を防ぐ側）。
          this.state = { ...this.state, cue: null };
          return;
        }
        this.counters.cues += 1;
        if (ctx && this.settings.cue_reaction_window_ms !== undefined) {
          this.reactions.set(
            action.cue_id,
            startCueReaction(
              { cue_id: action.cue_id, candidate_id: action.candidate_id, candidate_version: action.candidate_version, at: now, window_ms: this.settings.cue_reaction_window_ms },
              { user_speaking: ctx.user_speaking, p_now_ai: ctx.p_now_ai ?? null, candidate_state: moved.to },
            ),
          );
        }
        const parameters = { cue_id: action.cue_id, duration_ms: action.duration_ms, inhale_completion: 'orchestrator_clock', phase_sent: 'inhale' };
        this.cues.set(`${action.cue_id}:inhale`, { cue_id: action.cue_id, candidate_id: action.candidate_id, parameters });
        if (this.options.send({ type: 'breath.cue', cue_id: action.cue_id, candidate_id: action.candidate_id, duration_ms: action.duration_ms })) {
          this.options.emitter.emit({ event: 'signal.sent', candidate_id: action.candidate_id, phase: 'inhale', parameters, sent_at: now });
          this.options.initiative.offers.noteSent({ cue_id: action.cue_id, candidate_id: action.candidate_id, at: now, invitation_detected: ctx?.invitation_detected ?? false });
        } else {
          this.noteSignalNotSent(action.candidate_id, action.cue_id, 'inhale');
        }
        return;
      }
      case 'inhale_completed':
        ledger.transition(action.candidate_id, 'BREATH_HOLD_OR_READY', 'inhale_completed', now);
        return;
      case 'audio_abandoned': {
        const record = ledger.transition(action.candidate_id, 'WITHDRAWN', 'audio_unavailable', now, action.candidate_version);
        this.options.emitter.emit({
          event: 'negotiation.decision',
          stage: 'candidate_audio',
          candidate_id: present(action.candidate_id),
          candidate_version: present(action.candidate_version),
          candidate_state: record.ok ? record.to : null,
          outcome: 'audio_abandoned',
          reasons: action.reasons,
        });
        return;
      }
      case 'defer':
        this.counters.deferred += 1;
        ledger.transition(action.candidate_id, 'DEFERRED', 'user_continued', now);
        return;
      case 'release': {
        const phase = action.reason === 'speech_started' ? 'pre_speech' : 'relax';
        const parameters = { cue_id: action.cue_id, reason: action.reason, phase_sent: phase };
        this.cues.set(`${action.cue_id}:release`, { cue_id: action.cue_id, candidate_id: action.candidate_id, parameters });
        if (this.options.send({ type: 'breath.release', cue_id: action.cue_id, candidate_id: action.candidate_id, reason: action.reason })) {
          this.options.emitter.emit({ event: 'signal.sent', candidate_id: action.candidate_id, phase, parameters, sent_at: now });
        } else {
          this.noteSignalNotSent(action.candidate_id, action.cue_id, phase);
        }
        // 覚えておく合図は直近のものだけ（報告の照合用）。
        while (this.cues.size > 16) this.cues.delete(this.cues.keys().next().value as string);
        return;
      }
    }
  }

  /** 合図を送れなかった（切断など）。signal.sent には残さず、送れなかったことを別に記録する。候補の状態は変えない。 */
  private noteSignalNotSent(candidate_id: string, cue_id: string, phase: string): void {
    this.counters.signals_not_sent += 1;
    const record = this.options.initiative.ledger.get(candidate_id);
    this.options.emitter.emit({
      event: 'negotiation.decision',
      stage: 'signal_gate',
      candidate_id: present(candidate_id),
      candidate_version: record ? present(record.candidate_version) : absent('candidate_not_found'),
      candidate_state: record?.state ?? null,
      outcome: 'signal_not_sent',
      reasons: [`phase:${phase}`, `cue_id:${cue_id}`],
    });
  }

  /** 候補の先行音声の段階（準備の開始、完成、失敗）。合図と TTS の遅れの測定に使う（JSONL で確かめられるように）。 */
  private emitAudio(candidate_id: string, candidate_version: number, state: 'preparing' | 'ready' | 'failed', audio_playback_id: number, reason: string | null): void {
    this.options.emitter.emit({
      event: 'negotiation.decision',
      stage: 'candidate_audio',
      candidate_id: present(candidate_id),
      candidate_version: present(candidate_version),
      candidate_state: this.options.initiative.ledger.get(candidate_id)?.state ?? null,
      outcome: `audio_${state}`,
      reasons: [`audio_playback_id=${audio_playback_id}`, ...(reason !== null ? [`reason:${reason}`] : [])],
    });
  }

  private logGate(gate: GateResult): void {
    const key = `${gate.candidate_id}@${gate.candidate_version}|${gate.outcome}|${reasonKey(gate.reasons)}`;
    if (key === this.lastGateKey) return;
    this.lastGateKey = key;
    this.options.emitter.emit({
      event: 'negotiation.decision',
      stage: 'signal_gate',
      candidate_id: present(gate.candidate_id),
      candidate_version: present(gate.candidate_version),
      candidate_state: gate.candidate_state,
      outcome: gate.outcome,
      reasons: gate.reasons,
    });
  }

  private logSelection(choice: CandidateChoice, force: boolean): void {
    const c = choice.candidate;
    const key = `${c?.candidate_id ?? '-'}@${c?.candidate_version ?? '-'}|${choice.choice}|${reasonKey(choice.reasons)}`;
    if (!force && key === this.lastSelectionKey) return;
    this.lastSelectionKey = key;
    this.emitSelection(choice);
  }

  private emitSelection(choice: CandidateChoice): void {
    const c = choice.candidate;
    this.options.emitter.emit({
      event: 'negotiation.decision',
      stage: 'speech_selection',
      candidate_id: c ? present(c.candidate_id) : absent('no_active_candidate'),
      candidate_version: c ? present(c.candidate_version) : absent('no_active_candidate'),
      candidate_state: c?.state ?? null,
      outcome: choice.choice,
      reasons: choice.reasons,
    });
  }
}
