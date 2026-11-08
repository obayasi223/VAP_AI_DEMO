/**
 * 発話希望を実際の振る舞いにつなぐ配線（波3: E2 の合図、E3 の選択。計画 §4.6）。判断は control/negotiator.ts の
 * 純粋関数で、ここは値を集めて渡し、結果を E2a（CandidateLedger）、D（SpeechGenerator）、ブラウザへ届けるだけ。
 *
 *   tick の始め（TurnManager の step の前）: beforeStep
 *     候補の先行音声の準備（条件 reactive では作らない）→ negotiate（合図、吸気の完了、DEFERRED、合図の解除）
 *     → 吸気中なら通常の応答を含めて開始を保留する理由を返す（TurnInputs.start_blocked_reason へ）
 *   step の後: select（許可が出ていれば候補と通常の応答のどちらを話すか）
 *   候補の発話を始めたら: startCandidate（E2a の startSpeech が D の版と PCM の一致を確かめる）
 *
 * 候補の発話の文は候補の proposed_utterance をそのまま TTS に渡す（作り直す LLM の呼び出しはしない）。
 * 撤回と改訂のときの未再生の PCM の破棄は E2a（ledger の discardCandidate）が行う。
 * 吸気の長さは orchestrator が決め、完了は orchestrator の時計で判定する（ブラウザの報告は記録だけ）。
 */
import { absent, present } from '@llm-vap/contracts';
import type {
  Condition,
  EventEmitter,
  NodeToBrowser,
  PolicyJa,
  SignalReport,
  TimeMapping,
} from '@llm-vap/contracts';
import { atFromBrowser } from '@llm-vap/contracts';
import {
  initialNegotiatorState,
  negotiate,
  reasonKey,
  releaseForSpeech,
  selectSpeech,
} from '../control/negotiator';
import type {
  CandidateAudio,
  CandidateView,
  GateResult,
  NegotiatorAction,
  NegotiatorSettings,
  NegotiatorState,
  Selection,
} from '../control/negotiator';
import type { TurnState } from '../control';
import type { SpeechGeneratorImpl, SpeechStateChange } from '../speech';
import type { InitiativeWiring } from './initiative_wiring';

/** 方策と条件から交渉の設定を作る。negotiation の節がなければ null（候補を記録するだけ、波2の振る舞い）。 */
export function negotiatorSettings(policy: PolicyJa, condition: Condition): NegotiatorSettings | null {
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
  };
}

type SpeechPort = Pick<SpeechGeneratorImpl, 'prepare' | 'stateOf'>;

export interface NegotiationWiringOptions {
  settings: NegotiatorSettings;
  initiative: InitiativeWiring;
  emitter: EventEmitter;
  /** D。後から作られるので関数で渡す。null なら候補の音声は作れない（候補は話さない）。 */
  speech: () => SpeechPort | null;
  send: (message: NodeToBrowser) => void;
}

export interface BeforeStepContext {
  now: number;
  ai_speaking: boolean;
  avatar_available: boolean;
  user_speaking: boolean;
}

export interface CandidateChoice extends Selection {
  candidate: CandidateView | null;
  /** 候補を話すときの音声（D の audio_playback_id）と、E2a の記録の transcript_revision。 */
  audio_playback_id: number | null;
  transcript_revision: number | null;
}

interface PreparedAudio {
  candidate_version: number;
  audio_playback_id: number;
}

interface SentCue {
  cue_id: string;
  candidate_id: string;
  parameters: Record<string, number | string | boolean>;
  started_reported: boolean;
}

export class NegotiationWiring {
  readonly settings: NegotiatorSettings;
  private state: NegotiatorState = initialNegotiatorState();
  private readonly audio = new Map<string, PreparedAudio>();
  private readonly cues = new Map<string, SentCue>();
  private lastGateKey = '';
  private lastSelectionKey = '';
  /** 棄てた候補の未再生の音声（撤回、改訂、期限）。D の状態の通知から。試験と研究者向け（JSONL には専用の項目がない）。 */
  readonly discardedAudio: { candidate_id: string; candidate_version: number; reason: string; chunks: number; samples: number }[] = [];
  /** 試験と研究者向けの数。 */
  readonly counters = { cues: 0, deferred: 0, candidate_speech_started: 0, candidate_speech_refused: 0, signal_reports_unmatched: 0 };

  constructor(private readonly options: NegotiationWiringOptions) {
    this.settings = options.settings;
  }

  negotiatorState(): NegotiatorState {
    return structuredClone(this.state);
  }

  /** tick の始め。吸気中なら開始を保留する理由を返す。 */
  beforeStep(ctx: BeforeStepContext): string | null {
    this.prepareAudio();
    const views = this.views(ctx.now);
    const step = negotiate(this.settings, this.state, {
      now: ctx.now,
      candidates: views,
      ai_speaking: ctx.ai_speaking,
      avatar_available: ctx.avatar_available,
      user_speaking: ctx.user_speaking,
    });
    this.state = step.state;
    for (const action of step.actions) this.apply(action, ctx.now);
    if (step.gate !== null) this.logGate(step.gate);
    return step.hold_start === null || this.state.cue === null ? null : step.hold_start;
  }

  /** 未解決の候補があるか（選択の前の計算を省くため）。 */
  hasCandidate(): boolean {
    return this.options.initiative.ledger.list().length > 0;
  }

  /** step の後。許可が出ていれば、候補と通常の応答のどちらを話すかを決め、判断が変わったら記録する。 */
  select(now: number, turn: TurnState): CandidateChoice {
    const view = this.views(now)[0] ?? null;
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
    };
    // 許可がない間と、候補のない通常の応答は記録しない（tick ごとに出さない）。
    if (selection.choice !== 'none' && view !== null) this.logSelection(choice, false);
    return choice;
  }

  /** 選んだ候補を話せなかった（TurnManager が開始しなかった、など）。理由を記録する。 */
  noteSelectionNotStarted(choice: CandidateChoice, reason: string): void {
    this.logSelection({ ...choice, choice: 'wait', reasons: [...choice.reasons, `not_started:${reason}`] }, true);
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
    this.audio.delete(view.candidate_id);
    this.logSelection(choice, true);
    const released = releaseForSpeech(this.state, view.candidate_id);
    this.state = released.state;
    if (released.action) this.apply(released.action, now);
    // DEFERRED からの発話は再吸気せず、短い準備動作だけを行う（計画 §4.6）。
    else if (view.state === 'DEFERRED') this.options.send({ type: 'breath.prepare', candidate_id: view.candidate_id });
    return null;
  }

  /** D の状態の通知。候補の音声を取り消した（未再生の PCM を棄てた）ものを記録する。 */
  onSpeechState(change: SpeechStateChange): void {
    const origin = change.request.origin;
    if (origin.kind !== 'candidate' || change.state !== 'cancelled') return;
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
    const cue = [...this.cues.values()].find((c) => c.candidate_id === report.candidate_id && this.phaseMatches(c, report.phase));
    if (cue === undefined || mapping === null) {
      this.counters.signal_reports_unmatched += 1;
      return false;
    }
    const parameters = { ...cue.parameters, reported_phase: report.phase };
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
        if (report.phase === 'inhale') this.options.initiative.ledger.noteCueStarted(report.candidate_id, started_at);
      } else {
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

  private phaseMatches(cue: SentCue, phase: SignalReport['phase']): boolean {
    return phase === cue.parameters.phase_sent;
  }

  // ---- 内部 ----------------------------------------------------------------------

  /** 候補の先行音声。候補の文（proposed_utterance）をそのまま TTS へ。条件 reactive では作らない（話さないので費用だけかかる）。 */
  private prepareAudio(): void {
    if (this.settings.condition === 'reactive') return;
    const speech = this.options.speech();
    if (speech === null) return;
    const ledger = this.options.initiative.ledger;
    const live = new Set<string>();
    for (const record of ledger.list()) {
      live.add(record.candidate_id);
      if (record.state === 'SPEAKING') continue;
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

  private views(now: number): CandidateView[] {
    void now;
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
      };
    });
  }

  private apply(action: NegotiatorAction, now: number): void {
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
        const parameters = { cue_id: action.cue_id, duration_ms: action.duration_ms, inhale_completion: 'orchestrator_clock', phase_sent: 'inhale' };
        this.cues.set(`${action.cue_id}:inhale`, { cue_id: action.cue_id, candidate_id: action.candidate_id, parameters, started_reported: false });
        this.options.send({ type: 'breath.cue', cue_id: action.cue_id, candidate_id: action.candidate_id, duration_ms: action.duration_ms });
        this.options.emitter.emit({ event: 'signal.sent', candidate_id: action.candidate_id, phase: 'inhale', parameters, sent_at: now });
        return;
      }
      case 'inhale_completed':
        ledger.transition(action.candidate_id, 'BREATH_HOLD_OR_READY', 'inhale_completed', now);
        return;
      case 'defer':
        this.counters.deferred += 1;
        ledger.transition(action.candidate_id, 'DEFERRED', 'user_continued', now);
        return;
      case 'release': {
        const phase = action.reason === 'speech_started' ? 'pre_speech' : 'relax';
        const parameters = { cue_id: action.cue_id, reason: action.reason, phase_sent: phase };
        this.cues.set(`${action.cue_id}:release`, { cue_id: action.cue_id, candidate_id: action.candidate_id, parameters, started_reported: false });
        this.options.send({ type: 'breath.release', cue_id: action.cue_id, candidate_id: action.candidate_id, reason: action.reason });
        this.options.emitter.emit({ event: 'signal.sent', candidate_id: action.candidate_id, phase, parameters, sent_at: now });
        // 覚えておく合図は直近のものだけ（報告の照合用）。
        while (this.cues.size > 16) this.cues.delete(this.cues.keys().next().value as string);
        return;
      }
    }
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
