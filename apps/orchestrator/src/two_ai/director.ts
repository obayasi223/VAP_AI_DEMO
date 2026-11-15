/**
 * 進行役（docs/design/two_ai/06 §7.3、01 §3）。純粋関数 directorStep(state, inputs, now) → { state, actions }。
 *
 * 進行役は「いつ」を決める（段階、開始の時刻、停止、割り込み、視線、床は常に 1 つ）。「何を、誰が」は 02（DiscussionContent）。
 * executor（two_ai_session.ts）が 02 を呼び、結果を prepare して次の tick の入力（turn_arrivals など）に入れる。
 * 進行役は文を見ない（DiscussionTurnView）。時刻はすべて now（orchestrator の monotonicMs）で、偽の時刻で試験できる。
 *
 * 06 と違う書き方（wp0_notes.md「WP1 の実装の記録」）：
 * - two_ai.phase_changed は進行役が emit で出す（経過と見込みの長さを進行役が持つため）。executor は set_phase で送るだけ。
 * - two_ai.retraction（文とハッシュ）と two_ai.ai_state（02 の framingState）は executor が出す（文を進行役が持たないため）。
 * - request_resume の resume.spoken_text は空で出す。executor が SpeechFinished.spoken_text で埋める。
 */
import { TWO_AI_DIRECTOR_EVENT_NAMES, absent, present } from '@llm-vap/contracts';
import type {
  AiId,
  DiscussionStage,
  EventDraft,
  GazeTarget,
  PointTrigger,
  TimeBasis,
  TwoAiCondition,
  TwoAiPhase,
  TwoAiSessionConfig,
  TwoAiTurnKind,
} from '@llm-vap/contracts';
import type { AbandonResumeReason, CorrectionSuggestion } from './content_port';
import type {
  AttemptTrack,
  DirectorInputs,
  DirectorState,
  DiscussionTurnView,
  FloorHolder,
  InterjectionTrack,
  PendingSource,
  PendingTurn,
  PlaybackObservation,
  PointProgress,
} from './director_state';
import { initialDirectorState } from './director_state';
import { CONTENT_TURN_KINDS, contentMsOf, countsForPoint, summarizeExposure } from './exposure';
import { resolveCorrectionPoint } from './woz';

export type FixedLineRef =
  | { kind: 'phase_line'; phase: TwoAiPhase; edge: 'open' | 'close' }
  | { kind: 'plan_filler'; index: 0 | 1 }
  | { kind: 'intake_line'; line: 'first_question' | 'core_readback' }
  | { kind: 'response_line'; line: 'more' }
  | { kind: 'pick_line'; line: 'prompt' | 'confirm' | 'timeout' }
  | { kind: 'retraction'; index: number }
  /** 判定の保留の時間切れか auto の判定の失敗のつなぎ（06 §6.2）。音声は AckBank の保持（鍵 hold_bridge）。turn_kind 'bridge'。 */
  | { kind: 'hold_bridge'; ai_id: AiId }
  /** 最後の段の some 型の問い（01 §3.10.4）。音声は AckBank の保持（鍵 closing_question、話者は speakers.closing）。 */
  | { kind: 'closing_question' };

export interface ResumeContext {
  interjection_id: string;
  interrupted_turn_id: string;
  interrupted_ai: AiId;
  /** 進行役は空で出す。executor が SpeechFinished.spoken_text で埋める。 */
  spoken_text: string;
  point_id: string | null;
}

export type TwoAiEventDraft = Extract<EventDraft, { event: (typeof TWO_AI_DIRECTOR_EVENT_NAMES)[number] }>;

export type DirectorAction =
  | { kind: 'request_next_turn'; turn_id: string }
  /** 計画が凍結して話し合いの中身を始める（executor は 02 の startDiscussion を呼ぶ。最初の request_next_turn より前）。 */
  | { kind: 'start_discussion' }
  | { kind: 'substitute_fallback'; turn_id: string; reason: 'not_arrived_in_time' | 'generation_failed' }
  | { kind: 'request_fixed'; turn_id: string; line: FixedLineRef }
  | { kind: 'request_resume'; turn_id: string; resume: ResumeContext | null; last_speaker: AiId; mode: 'after_ack' | 'false_onset' }
  | { kind: 'apply_correction'; point_id: string; trigger: 'woz_researcher' | 'auto_confirmed'; timing: 'in_window' | 'next_boundary'; interrupted_turn_id: string | null }
  | { kind: 'request_rebuild' }
  | { kind: 'offer_fixed'; ai_id: AiId; line: FixedLineRef }
  | { kind: 'record_correction_only'; point_id: string; trigger: 'woz_researcher' | 'auto_confirmed' }
  /**
   * 判定の保留を、時間切れか auto の判定の失敗で終えた（06 §6.2 (3)）。同じ tick の request_fixed(hold_bridge) と組で出す。
   * executor は content.abandonResume を呼び、戻り値の credited_ms を次の tick の content_credits で返す（第 5 回 M2）。
   * 準備済みの F のブロックのターンは、進行役が同じ step の cancel_turn で取り消す（第 5 回 m1）。
   */
  | { kind: 'abandon_resume'; interrupted_turn_id: string | null; interjection_id: string; reason: AbandonResumeReason }
  | { kind: 'start_turn'; ai_id: AiId; turn_id: string; audio_playback_id: number }
  | { kind: 'stop_turn'; ai_id: AiId; audio_playback_id: number; stop_point: 'word_boundary' | 'immediate'; max_wait_ms: number; decision_source: 'vap' | 'fallback' | 'woz'; reason: string }
  | { kind: 'cancel_turn'; ai_id: AiId | null; turn_id: string; audio_playback_id: number | null; reason: string }
  | { kind: 'gaze'; ai_id: AiId; target: GazeTarget; reason: string }
  | { kind: 'offer_ack'; ai_id: AiId; interjection_id: string | null }
  | { kind: 'withdraw_ack'; reason: string }
  | { kind: 'route_user_turns'; responder: AiId | null }
  | { kind: 'start_plan'; trigger: 'early' | 'final' }
  | { kind: 'use_fallback_plan'; reason: string }
  | { kind: 'force_points'; reason: string }
  | { kind: 'notify_interjection_closed'; interjection_id: string }
  | { kind: 'send_board'; reason: 'shown' | 'revealed' | 'rebuilt' | 'pick_opened' | 'picked' | 'reattach'; trigger_turn_id: string | null }
  | { kind: 'send_stage'; current: DiscussionStage | null; show: 'current' | 'all' | 'none' }
  | { kind: 'set_phase'; to: TwoAiPhase; source: 'auto_timer' | 'auto_content' | 'woz' | 'error'; reason: string }
  | { kind: 'pause'; reason: string }
  | { kind: 'emit'; draft: TwoAiEventDraft; at?: { t_monotonic_ms: number; time_basis: TimeBasis }; ai_id?: AiId | null; point_id?: string | null }
  | { kind: 'degraded'; reason: string | null };

export interface DirectorInit {
  condition: TwoAiCondition;
  correction_mode: 'researcher' | 'auto';
  feeds_generation: boolean;
  stop_max_wait_ms: number;
  /** 点の引き金と見込み（台本と計画から）。null は不明（in_stage の段だけ書く）。 */
  point_meta?: (point_id: string) => { trigger: PointTrigger; elaborations_planned: number; planned_at_ms: number | null } | null;
}

export interface Director {
  initialState(now: number): DirectorState;
  step(state: DirectorState, inputs: DirectorInputs, now: number): { state: DirectorState; actions: DirectorAction[] };
}

export function createDirector(config: TwoAiSessionConfig, init: DirectorInit): Director {
  return {
    initialState: (now) => initialDirectorState(init, now),
    step: (state, inputs, now) => directorStep(config, init, state, inputs, now),
  };
}

/** 先読みに 02 の拍が残っていない（失敗ではない。U2）。 */
export const CONTENT_EXHAUSTED = 'content_exhausted';

const OTHER: Record<AiId, AiId> = { A: 'B', B: 'A' };
const TURN_INDEX = /(\d+)$/;

export function directorStep(
  config: TwoAiSessionConfig,
  init: DirectorInit,
  state: DirectorState,
  inputs: DirectorInputs,
  now: number,
): { state: DirectorState; actions: DirectorAction[] } {
  const step = new Step(config, init, structuredClone(state), inputs, now);
  step.run();
  return { state: step.s, actions: step.actions };
}

class Step {
  readonly actions: DirectorAction[] = [];
  private readonly dt: number;

  constructor(
    private readonly cfg: TwoAiSessionConfig,
    private readonly init: DirectorInit,
    readonly s: DirectorState,
    private readonly inp: DirectorInputs,
    private readonly now: number,
  ) {
    this.dt = s.last_step_at === null ? 0 : Math.max(0, now - s.last_step_at);
    s.last_step_at = now;
  }

  run(): void {
    if (this.s.sub.kind === 'ended') {
      this.handleMarkers();
      this.rejectPicksOutside();
      return;
    }
    this.applyCredits();
    this.applyCancelled();
    this.applyArrivals();
    this.applyFailures();
    this.markReady();
    this.syncPoints();
    for (const obs of this.inp.playback_events) this.onPlayback(obs);
    this.onAckStarted();
    this.handleMarkers();
    this.trackUtterance();
    this.onAttemptStarted();
    this.onInterjectionSignal();
    this.onAttemptEnded();
    this.handleWoz();
    this.handleSuggestions();
    switch (this.s.phase) {
      case 'intake':
        this.progressIntake();
        break;
      case 'discussion':
        this.progressInterjection();
        this.progressDiscussion();
        break;
      case 'response':
        this.progressResponse();
        break;
      case 'next_step':
        this.progressNextStep();
        break;
      case 'end':
        break;
    }
    this.rejectPicksOutside();
    this.checkFallback();
    this.tryStart();
    this.flushAttempts();
  }

  // ---- 共通の道具 --------------------------------------------------------------

  private act(a: DirectorAction): void {
    this.actions.push(a);
  }

  private emit(draft: TwoAiEventDraft, scope: { ai_id?: AiId | null; point_id?: string | null } = {}, at?: { t_monotonic_ms: number; time_basis: TimeBasis }): void {
    this.act({ kind: 'emit', draft, ...(at ? { at } : {}), ...(scope.ai_id !== undefined ? { ai_id: scope.ai_id } : {}), ...(scope.point_id !== undefined ? { point_id: scope.point_id } : {}) });
  }

  private newTurnId(): string {
    this.s.turn_seq += 1;
    return `t${this.s.turn_seq}`;
  }

  private gaze(ai: AiId, target: GazeTarget, reason: string): void {
    if (this.s.gaze[ai] === target) return;
    this.s.gaze[ai] = target;
    this.act({ kind: 'gaze', ai_id: ai, target, reason });
  }

  private gazeBoth(target: GazeTarget, reason: string): void {
    this.gaze('A', target, reason);
    this.gaze('B', target, reason);
  }

  private get onSpot(): boolean {
    return this.s.condition === 'respond_on_spot';
  }

  private requestFixed(line: FixedLineRef, front = false): string {
    const turn_id = this.newTurnId();
    const item = this.pending(turn_id, line.kind === 'closing_question' ? 'cached_question' : 'fixed');
    if (front) this.s.queue.unshift(item);
    else this.s.queue.push(item);
    this.act({ kind: 'request_fixed', turn_id, line });
    this.s.queue_lines[turn_id] = line;
    this.turnEvent('requested', { turn_id, turn_kind: fixedTurnKind(line), speaker: null, reason: `fixed:${line.kind}` });
    return turn_id;
  }


  private pending(turn_id: string, source: PendingSource): PendingTurn {
    return { turn_id, state: 'requested', turn: null, audio_playback_id: null, requested_at: this.now, desired_start_at: null, fallback_used: false, source, late_logged: false };
  }

  private requestNext(reason: string): void {
    if (this.s.next !== null) return;
    const turn_id = this.newTurnId();
    this.s.next = this.pending(turn_id, 'next_turn');
    this.act({ kind: 'request_next_turn', turn_id });
    this.turnEvent('requested', { turn_id, turn_kind: 'discussion', speaker: null, reason });
  }

  private lineOf(turn_id: string): FixedLineRef | null {
    return this.s.queue_lines[turn_id] ?? null;
  }

  private turnEvent(
    stage: 'requested' | 'arrived' | 'prepared' | 'started' | 'ended' | 'failed' | 'cancelled' | 'skipped' | 'late' | 'fallback_substituted',
    o: {
      turn_id: string;
      turn_kind: TwoAiTurnKind;
      speaker: AiId | null;
      view?: DiscussionTurnView | null;
      audio_playback_id?: number | null;
      gap_ms?: number;
      waited_for_ready_ms?: number;
      played_ms?: number;
      content_ms?: number;
      interrupted?: boolean;
      reason: string;
    },
  ): void {
    const v = o.view ?? null;
    const m = TURN_INDEX.exec(o.turn_id);
    this.emit(
      {
        event: 'two_ai.turn',
        turn_id: o.turn_id,
        turn_index: m ? Number(m[1]) : 0,
        turn_kind: v?.turn_kind ?? o.turn_kind,
        stage,
        speaker: v?.speaker ?? o.speaker,
        point_id: v?.point_id ?? null,
        audio_playback_id: o.audio_playback_id != null ? present(o.audio_playback_id) : absent('not_prepared'),
        text_origin: v?.text_origin ?? null,
        gap_ms: o.gap_ms !== undefined ? present(Math.max(0, Math.round(o.gap_ms))) : absent(`not_${stage}`),
        gap_hint_ms: v !== null ? present(Math.max(0, Math.round(v.gap_hint_ms))) : absent('not_arrived'),
        waited_for_ready_ms: o.waited_for_ready_ms !== undefined ? present(Math.max(0, Math.round(o.waited_for_ready_ms))) : absent(`not_${stage}`),
        played_ms: o.played_ms !== undefined ? present(Math.max(0, Math.round(o.played_ms))) : absent(`not_${stage}`),
        content_ms: o.content_ms !== undefined ? present(Math.max(0, Math.round(o.content_ms))) : absent(`not_${stage}`),
        discussion_stage: v?.discussion_stage ?? null,
        point_variant: v?.point_variant ?? null,
        board_card_id: v?.board_card_id ?? null,
        interrupted: o.interrupted ?? false,
        feed_turn: v?.feed_turn ?? false,
        reason: o.reason,
      },
      { ai_id: v?.speaker ?? o.speaker ?? null, point_id: v?.point_id ?? null },
    );
  }

  // ---- 入力の取り込み -----------------------------------------------------------

  private applyCredits(): void {
    for (const c of this.inp.content_credits) {
      if (this.s.credited_interjection_ids.includes(c.interjection_id)) continue;
      this.s.credited_interjection_ids.push(c.interjection_id);
      const ms = Math.max(0, Math.round(c.credited_ms));
      this.s.content_elapsed_ms += ms;
      if (this.s.interjection?.interjection_id === c.interjection_id) this.s.interjection.credited_ms = ms;
    }
  }

  private applyCancelled(): void {
    for (const id of this.inp.cancelled_turn_ids ?? []) {
      if (this.s.next?.turn_id === id) {
        this.turnEvent('cancelled', { turn_id: id, turn_kind: this.s.next.turn?.turn_kind ?? 'discussion', speaker: this.s.next.turn?.speaker ?? null, view: this.s.next.turn, reason: 'cancelled_by_content' });
        this.s.next = null;
      }
      const i = this.s.queue.findIndex((q) => q.turn_id === id);
      if (i >= 0) this.s.queue.splice(i, 1);
    }
  }

  private findPending(turn_id: string): PendingTurn | null {
    if (this.s.next?.turn_id === turn_id) return this.s.next;
    return this.s.queue.find((q) => q.turn_id === turn_id) ?? null;
  }

  private applyArrivals(): void {
    for (const a of this.inp.turn_arrivals) {
      if (a.source === 'cached_ack') {
        this.s.ack_offer = { ai_id: a.turn.speaker, audio_playback_id: a.audio_playback_id, interjection_id: this.s.interjection?.interjection_id ?? null };
        this.s.ack_cache = a.cached ?? null;
        continue;
      }
      let p = this.findPending(a.turn.turn_id);
      if (p === null && (a.source === 'uptake' || a.source === 'rebuild')) {
        p = this.pending(a.turn.turn_id, a.source);
        if (a.source === 'uptake') {
          this.s.queue.unshift(p);
          this.s.awaiting_uptake_until = null;
        } else this.s.queue.push(p);
      }
      if (p === null) continue;
      p.turn = a.turn;
      p.audio_playback_id = a.audio_playback_id;
      p.state = 'arrived';
      if (a.source === 'fallback') p.fallback_used = true;
      this.turnEvent('arrived', { turn_id: a.turn.turn_id, turn_kind: a.turn.turn_kind, speaker: a.turn.speaker, view: a.turn, audio_playback_id: a.audio_playback_id, reason: a.source });
    }
  }

  private applyFailures(): void {
    const failures = [...this.inp.turn_failures, ...this.inp.slots.A.failed, ...this.inp.slots.B.failed];
    for (const f of failures) {
      if (this.s.next?.turn_id === f.turn_id && f.reason === CONTENT_EXHAUSTED) {
        // 最後の拍の再生中の先読み：02 にもう拍がない。失敗ではないので代わりの文も skipped も数えず取り下げる（U2）。
        this.turnEvent('cancelled', { turn_id: f.turn_id, turn_kind: 'discussion', speaker: null, reason: CONTENT_EXHAUSTED });
        this.s.next = null;
        continue;
      }
      if (this.s.next?.turn_id === f.turn_id) {
        const next = this.s.next;
        this.s.consecutive_failures += 1;
        if (!next.fallback_used) {
          next.fallback_used = true;
          next.state = 'requested';
          next.turn = null;
          next.audio_playback_id = null;
          this.act({ kind: 'substitute_fallback', turn_id: f.turn_id, reason: 'generation_failed' });
          this.turnEvent('fallback_substituted', { turn_id: f.turn_id, turn_kind: 'discussion', speaker: null, reason: f.reason.slice(0, 200) || 'failed' });
        } else {
          this.turnEvent('skipped', { turn_id: f.turn_id, turn_kind: 'discussion', speaker: null, reason: f.reason.slice(0, 200) || 'failed' });
          this.s.next = null;
        }
        if (this.s.consecutive_failures >= 3 && !this.s.woz_paused) {
          this.s.woz_paused = true;
          this.act({ kind: 'pause', reason: 'consecutive_failures' });
          this.emit({ event: 'two_ai.anomaly', kind: 'tts_failed', speaker: null, detail: 'consecutive_failures>=3' });
        }
        continue;
      }
      const i = this.s.queue.findIndex((q) => q.turn_id === f.turn_id);
      if (i >= 0) {
        const item = this.s.queue[i] as PendingTurn;
        this.s.queue.splice(i, 1);
        this.turnEvent('failed', { turn_id: f.turn_id, turn_kind: item.turn?.turn_kind ?? 'phase_line', speaker: item.turn?.speaker ?? null, reason: f.reason.slice(0, 200) || 'failed' });
        // 文がない定型（phaseLine が null など）は、話し終えたものとして先へ進める。
        this.afterTurnDone({ source: item.source, line: this.lineOf(f.turn_id), turn_kind: item.turn?.turn_kind ?? null, played_ms: 0, failed: true, turn_id: f.turn_id });
      } else if (f.turn_id === 'rebuild' && this.s.sub.kind === 'rebuilding') {
        this.enterPhase('next_step', 'error', 'rebuild_unavailable');
      }
    }
  }

  private markReady(): void {
    const isReady = (p: PendingTurn): boolean =>
      p.audio_playback_id !== null && p.turn !== null && (this.inp.slots[p.turn.speaker]?.ready ?? []).some((r) => r.audio_playback_id === p.audio_playback_id);
    for (const p of [this.s.next, ...this.s.queue]) {
      if (p !== null && p.state === 'arrived' && isReady(p)) p.state = 'ready';
    }
  }

  private syncPoints(): void {
    for (const v of this.inp.points) {
      let p = this.s.points[v.point_id];
      if (p === undefined) {
        const meta = this.init.point_meta?.(v.point_id) ?? null;
        p = {
          point_id: v.point_id,
          kind: v.kind,
          state: v.state === 'unavailable' ? 'unavailable' : 'pending',
          started_at: null,
          turns_spoken: 0,
          elaborations_planned: meta?.elaborations_planned ?? 0,
          exposure_total_ms: 0,
          exposure_new_ms: 0,
          speaker: v.speaker,
          discussion_stage: v.discussion_stage,
          trigger: meta?.trigger ?? { in_stage: v.discussion_stage ?? 1, after_stage_turn: 0 },
          planned_at_ms: meta?.planned_at_ms ?? null,
          expected_block_ms: v.expected_block_ms,
          started_est_ms: 0,
          segments: [],
          switched: false,
          abandoned: false,
        };
        this.s.points[v.point_id] = p;
        if (p.state === 'unavailable') this.pointEvent(p, 'unavailable', null, 'unavailable_in_plan');
        continue;
      }
      p.expected_block_ms = v.expected_block_ms;
      if (v.state === 'done' && p.state === 'in_progress' && this.s.floor?.point_id !== v.point_id && !this.queuedForPoint(v.point_id)) {
        this.completePoint(p, 'block_done');
      }
    }
  }

  /**
   * その点のターンがまだ控えている（次の 1 本か列にある）。02 の done はブロックの文を全部渡した時点なので、
   * 渡したが話していないターン（F.2、C.2、resume）があるうちは閉じない。到着前（turn: null）のものは中身が分からないので待つ。
   */
  private queuedForPoint(point_id: string): boolean {
    // 点のターンを切った割り込みが開いている間は、言い直し（resume）がまだ列に来ていなくても閉じない
    // （ブロックの最後のターンを切ったとき、受け止めの後の resume の前に completed になった。e2e。統合 1）。
    const ij = this.s.interjection;
    if (ij !== null && !ij.logged_only && (ij.interrupted?.point_id === point_id || ij.held?.point_id === point_id)) return true;
    return [this.s.next, ...this.s.queue].some((q) => q !== null && (q.turn === null || q.turn.point_id === point_id));
  }

  private pointEvent(p: PointProgress, stage: 'scheduled' | 'started' | 'elaboration' | 'turn_exposure' | 'completed' | 'missed' | 'forced' | 'unavailable' | 'switched_to_corrected', turn_id: string | null, reason: string): void {
    const started = stage === 'started';
    const withExposure = stage === 'turn_exposure' || stage === 'completed' || stage === 'missed';
    this.emit(
      {
        event: 'two_ai.point',
        point_id: p.point_id,
        point_kind: p.kind,
        speaker: p.speaker,
        stage,
        turn_id,
        trigger: p.trigger,
        discussion_stage: p.discussion_stage,
        planned_at: p.planned_at_ms !== null ? present(p.planned_at_ms) : absent('trigger_by_beats'),
        content_elapsed_ms: started ? present(Math.round(this.s.content_elapsed_ms)) : absent('not_started_stage'),
        deviation_ms: started && p.planned_at_ms !== null ? present(Math.round(this.s.content_elapsed_ms - p.planned_at_ms)) : absent(started ? 'trigger_by_beats' : 'not_started_stage'),
        exposure_new_ms: withExposure ? present(Math.round(p.exposure_new_ms)) : absent('not_exposure_stage'),
        exposure_total_ms: withExposure ? present(Math.round(p.exposure_total_ms)) : absent('not_exposure_stage'),
        elaborated_turns: p.segments.filter((x) => x.turn_kind === 'point_elaboration').length,
        reason,
      },
      { ai_id: p.speaker, point_id: p.point_id },
    );
  }

  private completePoint(p: PointProgress, reason: string): void {
    p.state = 'completed';
    this.pointEvent(p, 'completed', null, reason);
    this.emitPointExposure(p);
  }

  private emitPointExposure(p: PointProgress): void {
    const sum = summarizeExposure(p.segments);
    const cutByCorrection = p.segments.some((x) => x.cut === 'correction');
    // 展開の数：最後まで話した展開のターンと、割り込みで切れた展開のターンを resume で話し終えたもの（AC2(b)）。
    const done = new Set<string>();
    let cutElaboration: string | null = null;
    for (const x of p.segments) {
      if (x.turn_kind === 'point_elaboration') {
        if (x.cut === 'none') done.add(x.turn_id);
        else cutElaboration = x.turn_id;
      } else if (x.turn_kind === 'resume' && x.cut === 'none' && cutElaboration !== null) {
        done.add(cutElaboration);
        cutElaboration = null;
      }
    }
    const elaborations = done.size;
    this.emit(
      {
        event: 'two_ai.point_exposure',
        point_id: p.point_id,
        point_kind: p.kind,
        speaker: p.speaker,
        exposure_total_ms: Math.round(sum.exposure_total_ms),
        exposure_new_ms: Math.round(sum.exposure_new_ms),
        bridge_ms: Math.round(sum.bridge_ms),
        repeated_ms: Math.round(sum.repeated_ms),
        repeated_ms_source: sum.repeated_ms_source,
        planned_exposure_ms: p.expected_block_ms > 0 ? present(Math.round(p.expected_block_ms)) : absent('no_estimate'),
        segments: p.segments.map((x) => ({ audio_playback_id: x.audio_playback_id, turn_id: x.turn_id, turn_kind: x.turn_kind, played_ms: Math.round(x.played_ms), new_ms: Math.round(x.new_ms), cut: x.cut, variant: x.variant })),
        elaborations_done: elaborations,
        elaborations_planned: p.elaborations_planned,
        // 展開を飛ばした回（TTS の失敗で skipped）は全ターンを話していないので complete ではない（06 の complete の定義。統合 1）。
        complete: p.state === 'completed' && !p.abandoned && elaborations >= p.elaborations_planned,
        cut_by_correction: cutByCorrection,
      },
      { ai_id: p.speaker, point_id: p.point_id },
    );
  }

  // ---- 再生の報告 --------------------------------------------------------------

  private onPlayback(obs: PlaybackObservation): void {
    const f = this.s.floor;
    if (f === null || f.audio_playback_id !== obs.audio_playback_id) return;
    if (obs.kind === 'started') {
      if (f.phase === 'starting') f.phase = 'playing';
      // 話している発話の playback.started の時点で次の 1 本を頼む（01 §3.4）。
      if (this.s.phase === 'discussion' && this.s.discussion_started_at !== null && !this.s.discussion_closing && CONTENT_TURN_KINDS.has(f.turn_kind)) {
        this.requestNext('prefetch_on_started');
      }
      return;
    }
    this.onEnded(f, obs);
  }

  private onEnded(f: FloorHolder, obs: Extract<PlaybackObservation, { kind: 'ended' }>): void {
    for (const a of this.s.attempts) {
      if (a.overlapped?.audio_playback_id === f.audio_playback_id && a.ai_end === null) {
        a.ai_end = { at: this.now, reason: obs.reason === 'completed' ? 'completed' : obs.reason === 'stopped' ? 'stopped' : 'other' };
      }
    }
    this.s.floor = null;
    this.s.last_turn_ended_at = this.now;
    this.s.last_speaker = f.ai_id;
    const kind = f.turn_kind;
    const contentMs = contentMsOf(kind, obs.played_ms, obs.new_ms);
    const gap = CONTENT_TURN_KINDS.has(kind) ? f.view.gap_hint_ms : 0;
    if (this.s.phase === 'discussion') this.s.content_elapsed_ms += contentMs + gap;
    const interrupted = obs.reason === 'stopped';
    this.turnEvent('ended', { turn_id: f.turn_id, turn_kind: kind, speaker: f.ai_id, view: f.view, audio_playback_id: f.audio_playback_id, played_ms: obs.played_ms, content_ms: this.s.phase === 'discussion' ? contentMs : 0, interrupted, reason: obs.reason });
    if (obs.reason === 'completed') this.s.consecutive_failures = 0;
    if (kind === 'discussion') this.s.discussion_turns += 1;
    // 点の接触（総量と新しい部分）。
    if (countsForPoint(kind, f.point_id) && f.point_id !== null) {
      const p = this.s.points[f.point_id];
      if (p !== undefined) {
        const track = this.s.interjection;
        const cut: 'none' | 'interjection' | 'woz' | 'correction' = !interrupted
          ? 'none'
          : track?.correction_applied
            ? 'correction'
            : track?.decision_source === 'woz'
              ? 'woz'
              : 'interjection';
        p.segments.push({
          audio_playback_id: f.audio_playback_id,
          turn_id: f.turn_id,
          turn_kind: kind,
          played_ms: obs.played_ms,
          new_ms: obs.new_ms,
          bridge_ms: obs.bridge_ms,
          repeated_ms: obs.repeated_ms,
          repeated_source: obs.repeated_source,
          cut,
          variant: f.view.point_variant ?? 'original',
        });
        p.turns_spoken += 1;
        p.exposure_total_ms += obs.played_ms;
        p.exposure_new_ms += obs.new_ms;
        this.pointEvent(p, 'turn_exposure', f.turn_id, obs.reason);
      }
    }
    if (f.view.board_card_id !== null) this.act({ kind: 'send_board', reason: 'revealed', trigger_turn_id: f.turn_id });

    // 割り込みの流れ。
    const sub = this.s.sub;
    const track = this.s.interjection;
    if (sub.kind === 'stopping_for_user' && track !== null && track.interrupted?.audio_playback_id === f.audio_playback_id) {
      track.stopped_at = this.now;
      track.interrupted_completed = obs.reason === 'completed';
      this.interjectionEvent(track, 'stopped', 'playback_ended');
      this.s.sub = { kind: 'user_floor', interjection_id: track.interjection_id, since: this.now };
      return;
    }
    if (kind === 'ack' && track !== null && sub.kind === 'acknowledging') {
      track.ack_ended_at = this.now;
      if (track.ack !== null) {
        track.ack.played_ms = Math.round(obs.played_ms);
        track.ack.truncated = obs.reason !== 'completed';
      }
      this.interjectionEvent(track, 'ack_ended', obs.reason);
      if (this.inp.user.speaking) {
        // 受け止めの最中に再び話し始めて、まだ話している（受け止めは重ねない。m7）。
        this.s.sub = { kind: 'user_floor', interjection_id: track.interjection_id, since: this.now };
      } else {
        this.afterAck(track);
      }
      return;
    }
    this.afterTurnDone({ source: f.source, line: this.lineOf(f.turn_id), turn_kind: kind, played_ms: obs.played_ms, failed: false, turn_id: f.turn_id });
  }

  /** 話し終えた（または文がなかった）発話の後の遷移。 */
  private afterTurnDone(done: { source: PendingSource; line: FixedLineRef | null; turn_kind: TwoAiTurnKind | null; played_ms: number; failed: boolean; turn_id: string }): void {
    delete this.s.queue_lines[done.turn_id];
    const { line } = done;
    const sub = this.s.sub;
    switch (this.s.phase) {
      case 'intake':
        if (line?.kind === 'intake_line' && line.line === 'first_question') this.s.sub = { kind: 'user_turn' };
        return;
      case 'discussion':
        if (sub.kind === 'phase_open' && sub.turn_id === done.turn_id) {
          this.afterOpening();
          return;
        }
        if (line?.kind === 'phase_line' && line.edge === 'close') {
          this.enterPhase('response', this.s.discussion_closing_source, 'discussion_closed');
          return;
        }
        if (done.source === 'uptake') {
          const track = this.s.interjection;
          if (track !== null && track.after_uptake === 'resume') {
            track.after_uptake = null;
            this.requestResume(track, 'after_ack');
          } else if (sub.kind === 'resuming' || sub.kind === 'ai_speaking') {
            this.s.sub = { kind: 'between_turns' };
          }
          return;
        }
        if (sub.kind === 'ai_speaking' || sub.kind === 'resuming') this.s.sub = { kind: 'between_turns' };
        return;
      case 'response':
        if (sub.kind === 'closing_question' && line?.kind === 'closing_question') {
          this.s.response_extra.question_played_ms = Math.round(done.played_ms);
          this.s.response.started_at = this.now;
          this.s.response.last_user_voice_at = this.now;
          this.s.sub = { kind: 'user_turn' };
          return;
        }
        if (done.turn_kind === 'ack' && sub.kind === 'user_turn') {
          this.s.response_extra.ack_given = true;
          this.finishResponse();
          return;
        }
        if (sub.kind === 'rebuilding' && done.source === 'rebuild') {
          sub.next_index += 1;
          if (!this.s.queue.some((q) => q.source === 'rebuild')) this.enterPhase('next_step', 'auto_content', 'rebuild_done');
        }
        return;
      case 'next_step':
        if (line?.kind === 'pick_line' && (line.line === 'confirm' || line.line === 'timeout')) this.enterPhase('end', 'auto_content', `pick_${line.line}`);
        return;
      case 'end':
        if (line?.kind === 'retraction') {
          if (done.failed) {
            this.s.retraction.done = true;
            this.requestFixed({ kind: 'phase_line', phase: 'end', edge: 'open' });
            return;
          }
          this.s.retraction.next_index += 1;
          this.requestFixed({ kind: 'retraction', index: this.s.retraction.next_index });
          return;
        }
        if (line?.kind === 'phase_line' && line.phase === 'end') this.s.sub = { kind: 'ended' };
        return;
    }
  }

  // ---- 受け止めの開始（TurnManager が始めた） --------------------------------------

  private onAckStarted(): void {
    const offer = this.s.ack_offer;
    const startedAck = this.inp.user.started_ack;
    if (offer === null || startedAck === null || startedAck !== offer.audio_playback_id) return;
    this.s.ack_offer = null;
    const view: DiscussionTurnView = {
      turn_id: `ack_${offer.audio_playback_id}`,
      speaker: offer.ai_id,
      turn_kind: 'ack',
      point_id: null,
      point_variant: null,
      discussion_stage: this.s.discussion_stage,
      gap_hint_ms: 0,
      est_duration_ms: this.s.ack_cache?.synthesized_ms ?? 0,
      text_origin: 'cached',
      repeat: null,
      feed_turn: false,
      fed_interjection_ids: [],
      chars: 0,
      board_card_id: null,
    };
    this.s.floor = { ai_id: offer.ai_id, turn_id: view.turn_id, turn_kind: 'ack', audio_playback_id: offer.audio_playback_id, point_id: null, phase: 'starting', started_at: this.now, view, source: 'cached_ack', played_ms_hint: 0 };
    this.turnEvent('started', { turn_id: view.turn_id, turn_kind: 'ack', speaker: offer.ai_id, view, audio_playback_id: offer.audio_playback_id, reason: 'turn_manager_start' });
    const track = this.s.interjection;
    if (this.s.phase === 'discussion' && track !== null && offer.interjection_id === track.interjection_id) {
      track.user_ended_at = track.user_ended_at ?? this.now;
      track.ack_started_at = this.now;
      track.ack = { ai_id: offer.ai_id, template_id: this.s.ack_cache?.template_id ?? 'ack', audio_playback_id: offer.audio_playback_id, synthesized_ms: Math.round(this.s.ack_cache?.synthesized_ms ?? 0), played_ms: 0, truncated: false };
      if (!track.classified) this.classify(track, track.classification ?? 'unknown', track.classification_basis ?? 'none');
      this.interjectionEvent(track, 'user_ended', 'turn_manager_start');
      this.interjectionEvent(track, 'ack_started', 'turn_manager_start');
      this.s.sub = { kind: 'acknowledging', interjection_id: track.interjection_id };
    }
  }

  private classify(track: InterjectionTrack, classification: 'content' | 'backchannel' | 'unknown', basis: 'final' | 'interim' | 'none'): void {
    track.classification = classification;
    track.classification_basis = basis;
    track.classified = true;
    this.interjectionEvent(track, 'classified', basis);
    // 分類のたびに 1 回（旗の判断は 02）。誤った停止では呼ばない。
    this.act({ kind: 'notify_interjection_closed', interjection_id: track.interjection_id });
    if (this.s.feeds_generation) this.s.feed_wait = true;
  }

  // ---- 印 ------------------------------------------------------------------------

  private handleMarkers(): void {
    for (const m of this.inp.markers) {
      const counted = this.s.marker.last_counted_at === null || m.at - this.s.marker.last_counted_at >= this.cfg.marker.min_interval_ms;
      if (counted) {
        this.s.marker.last_counted_at = m.at;
        this.s.marker.count += 1;
      }
      this.s.recent_marker_ats.push(m.at);
      if (this.s.recent_marker_ats.length > 16) this.s.recent_marker_ats.shift();
      // 印の後 near_window_ms の中の onset（開いている割り込み）にも near_marker を付ける。
      const track = this.s.interjection;
      if (track !== null && Math.abs(m.at - track.detected_at) <= this.cfg.marker.near_window_ms) track.near_marker = true;
      const f = this.s.floor;
      this.emit(
        {
          event: 'two_ai.marker',
          marker_id: m.marker_id,
          client_t_ms: Math.max(0, Math.round(m.client_t_ms)),
          discussion_stage: this.s.phase === 'discussion' ? this.s.discussion_stage : null,
          ai_speaking: f?.ai_id ?? null,
          turn_id: f?.turn_id ?? null,
          turn_kind: f?.turn_kind ?? null,
          during_point_id: f?.point_id ?? null,
          played_ms_in_turn: f !== null ? present(Math.max(0, Math.round(m.at - f.started_at))) : absent('no_ai_speaking'),
          content_elapsed_ms: this.s.phase === 'discussion' ? present(Math.round(this.s.content_elapsed_ms)) : absent('outside_discussion'),
          user_speaking: this.inp.user.speaking,
          interjection_id: track !== null && !track.logged_only ? track.interjection_id : null,
          counted,
          handling: 'recorded_only',
        },
        { ai_id: null },
        { t_monotonic_ms: m.at, time_basis: m.time_basis },
      );
    }
  }

  // ---- 本人の発話と割り込み ------------------------------------------------------

  private trackUtterance(): void {
    const u = this.inp.user_utterance;
    if (this.s.phase === 'response' && (u !== null || this.inp.user.speaking)) {
      this.s.response_extra.voice_confirmed = true;
    }
    const track = this.s.interjection;
    if (track === null) return;
    track.voiced_ms = Math.max(track.voiced_ms, this.inp.user.voiced_ms_since_onset);
    if (u !== null) {
      track.had_text = true;
      for (const id of u.asr_segment_ids) if (!track.asr_segment_ids.includes(id)) track.asr_segment_ids.push(id);
      if (!track.classified) {
        track.classification = u.classification;
        track.classification_basis = u.basis;
      }
      if (u.is_final && track.hold !== null && track.hold.stt_final_after_ms === null && track.user_ended_at !== null) {
        track.hold.stt_final_after_ms = Math.max(0, this.now - track.user_ended_at);
      }
    }
    if (track.voiced_ms >= this.cfg.interjection.classify.backchannel_max_voiced_ms || track.had_text) track.speech_confirmed = true;
  }

  private onInterjectionSignal(): void {
    const sig = this.inp.interjection;
    if (sig.kind === 'sub_threshold') {
      if (this.s.phase === 'discussion') {
        this.emit({
          event: 'two_ai.interjection',
          interjection_id: `sub_${Math.round(sig.first_voiced_at)}`,
          stage: 'sub_threshold',
          decision_source: 'vap',
          interrupted_ai: this.s.floor?.ai_id ?? null,
          during_point_id: this.s.floor?.point_id ?? null,
          audio_playback_id: this.s.floor ? present(this.s.floor.audio_playback_id) : absent('no_ai_speaking'),
          p_now_user: absent('sub_threshold'),
          p_future_user: absent('sub_threshold'),
          vad_user: absent('sub_threshold'),
          mic_dbfs: absent('sub_threshold'),
          first_voiced_at: present(sig.first_voiced_at),
          latency_ms: absent('sub_threshold'),
          classification: null,
          classification_basis: null,
          reason: 'below_onset_conditions',
        });
      }
      return;
    }
    if (sig.kind !== 'onset' || this.s.phase !== 'discussion') return;
    const before = this.s.interjection;
    this.startInterjection({ source: sig.source, first_voiced_at: sig.first_voiced_at, detected_at: sig.detected_at, p_now_user: sig.p_now_user, p_future_user: sig.p_future_user, vad_user: sig.vad_user, mic_dbfs: sig.mic_dbfs });
    const opened = this.s.interjection;
    if (before === null && opened !== null) {
      const a = this.s.attempts.filter((x) => x.stats === null && x.interjection_id === null).at(-1);
      if (a !== undefined) {
        a.interjection_id = opened.interjection_id;
        a.stop_requested = opened.stop_requested_at !== null;
      }
    }
  }

  // ---- 試み（two_ai.interjection_attempt）---------------------------------------

  /** 話し合いの段で、開いている割り込みが無いときに始まった声を試みにする（開いている割り込みの中の声はその一部）。 */
  private onAttemptStarted(): void {
    const u = this.inp.interjection_attempt;
    if (u === undefined || u === null || u.kind !== 'started') return;
    if (this.s.phase !== 'discussion' || this.s.interjection !== null) return;
    const f = this.s.floor;
    this.s.attempt_count += 1;
    this.s.attempts.push({
      attempt_id: `at${this.s.attempt_count}`,
      started_at: u.started_at,
      overlapped: f !== null ? { ai_id: f.ai_id, turn_id: f.turn_id, turn_kind: f.turn_kind, audio_playback_id: f.audio_playback_id, point_id: f.point_id } : null,
      ai_end: null,
      interjection_id: null,
      stop_requested: false,
      episode_outcome: null,
      stats: null,
    });
  }

  private onAttemptEnded(): void {
    const u = this.inp.interjection_attempt;
    if (u === undefined || u === null || u.kind !== 'ended') return;
    const a = this.s.attempts.find((x) => x.stats === null && x.started_at === u.stats.started_at);
    if (a !== undefined) a.stats = u.stats;
  }

  /** 声が終わり、結びついた episode が閉じた試みを出す。 */
  private flushAttempts(): void {
    if (this.s.attempts.length === 0) return;
    const keep: AttemptTrack[] = [];
    for (const a of this.s.attempts) {
      const st = a.stats;
      const waiting = a.interjection_id !== null && a.episode_outcome === null && this.s.interjection?.interjection_id === a.interjection_id;
      if (st === null || waiting) {
        keep.push(a);
        continue;
      }
      if (st.onset === null && a.interjection_id === null && st.voiced_ms < this.cfg.interjection.detector.sub_threshold_min_ms) continue;
      this.emitAttempt(a, st);
    }
    this.s.attempts = keep;
  }

  private emitAttempt(a: AttemptTrack, st: NonNullable<AttemptTrack['stats']>): void {
    const window = this.cfg.interjection.attempt.self_finish_window_ms;
    const aiEnd = a.ai_end;
    const selfFinished = a.overlapped !== null && aiEnd !== null && aiEnd.reason === 'completed' && (aiEnd.at - a.started_at <= window || a.stop_requested);
    const outcome: Extract<TwoAiEventDraft, { event: 'two_ai.interjection_attempt' }>['outcome'] = selfFinished
      ? 'ai_finished_self'
      : st.onset === null && a.interjection_id === null
        ? 'sub_threshold'
        : a.interjection_id === null
          ? 'abandoned'
          : a.episode_outcome === 'yielded'
            ? a.stop_requested
              ? 'stopped'
              : 'held'
            : a.episode_outcome === 'backchannel'
              ? 'backchannel'
              : a.episode_outcome === 'false_onset' || a.episode_outcome === 'onset_no_speech'
                ? 'non_speech'
                : a.episode_outcome === 'logged_only'
                  ? 'logged_only'
                  : 'abandoned';
    const p = (v: number | null, reason: string) => (v !== null ? present(v) : absent(reason));
    const onsetAt = st.onset?.at ?? null;
    this.emit(
      {
        event: 'two_ai.interjection_attempt',
        attempt_id: a.attempt_id,
        outcome,
        started_at: st.started_at,
        ended_at: st.ended_at,
        voiced_ms: st.voiced_ms,
        overlap_ms: st.overlap_ms,
        overlapped: a.overlapped,
        ai_end_after_ms: a.overlapped === null ? absent('no_ai_speaking') : aiEnd === null ? absent('not_ended_in_attempt') : present(Math.round(aiEnd.at - a.started_at)),
        ai_end_reason: aiEnd?.reason ?? null,
        p_now_user_max: p(st.p_now_user_max, 'vap_not_fresh'),
        p_future_user_max: p(st.p_future_user_max, 'vap_not_fresh'),
        vad_user_max: p(st.vad_user_max, 'vap_not_fresh'),
        mic_dbfs_max: p(st.mic_dbfs_max, 'no_mic_level'),
        onset_rule: st.onset?.rule ?? null,
        onset_at: p(onsetAt, 'no_onset'),
        detect_latency_ms: onsetAt !== null ? present(Math.max(0, Math.round(onsetAt - st.started_at))) : absent('no_onset'),
        interjection_id: a.interjection_id,
        episode_outcome: a.episode_outcome,
        self_finish_window_ms: window,
      },
      { ai_id: a.overlapped?.ai_id ?? null, point_id: a.overlapped?.point_id ?? null },
    );
  }

  private startInterjection(o: { source: 'vap' | 'fallback' | 'woz'; first_voiced_at: number | null; detected_at: number; p_now_user: number | null; p_future_user: number | null; vad_user: number | null; mic_dbfs: number | null }): void {
    const existing = this.s.interjection;
    if (existing !== null) {
      // 開いている割り込みの続き（保留の間に話すのも同じ割り込み。第 5 回 m2）。
      if (this.s.sub.kind === 'acknowledging') existing.reonsets_during_ack += 1;
      return;
    }
    const sub = this.s.sub.kind;
    const f = this.s.floor;
    const allowed = sub === 'ai_speaking' || sub === 'between_turns' || sub === 'resuming';
    if (!allowed && this.onSpot) return;
    this.s.interjection_count += 1;
    const interjection_id = `ij${this.s.interjection_count}`;
    const nearMarker = this.s.recent_marker_ats.some((t) => Math.abs(t - o.detected_at) <= this.cfg.marker.near_window_ms);
    const contentFloor = f !== null && f.turn_kind !== 'ack';
    const track: InterjectionTrack = {
      interjection_id,
      decision_source: o.source,
      interrupted: contentFloor && f !== null ? { ai_id: f.ai_id, turn_id: f.turn_id, audio_playback_id: f.audio_playback_id, point_id: f.point_id, point_variant: f.view.point_variant } : null,
      held: null,
      ack_speaker: f?.ai_id ?? this.s.last_speaker ?? 'A',
      first_voiced_at: o.first_voiced_at,
      detected_at: o.detected_at,
      false_onset_until: o.detected_at + this.cfg.interjection.false_onset_window_ms,
      voiced_ms: 0,
      had_text: false,
      speech_confirmed: o.source === 'woz',
      stop_requested_at: null,
      stopped_at: null,
      user_ended_at: null,
      classification: null,
      classification_basis: null,
      ack_started_at: null,
      ack_ended_at: null,
      reonsets_during_ack: 0,
      asr_segment_ids: [],
      logged_only: !this.onSpot,
      onset: { p_now_user: o.p_now_user, p_future_user: o.p_future_user, vad_user: o.vad_user, mic_dbfs: o.mic_dbfs, audio_playback_id: f?.audio_playback_id ?? null },
      interrupted_completed: false,
      gaze_to_user_at: { A: null, B: null },
      ack: null,
      ack_offered: false,
      classified: false,
      correction_decided: null,
      correction_applied: null,
      hold: null,
      after_uptake: null,
      resume_turn_id: null,
      seen_suggestion_ids: this.inp.correction_suggestions.map((x) => x.suggestion_id),
      credited_ms: null,
      near_marker: nearMarker,
      resumed_at: null,
      user_floor_warned: false,
      outcome: null,
    };
    this.s.interjection = track;
    if (this.s.phase === 'discussion' && this.s.discussion_stage !== null) {
      const i = this.s.discussion_stage - 1;
      this.s.interjections_by_stage[i] = (this.s.interjections_by_stage[i] ?? 0) + 1;
    }
    this.interjectionEvent(track, 'onset', o.source);
    if (!this.onSpot) {
      // ②：記録だけ。止めない、視線を変えない、次の発話も待たせない。
      this.interjectionEvent(track, 'ignored_by_condition', 'respond_at_end');
      return;
    }
    if (track.interrupted !== null && f !== null) {
      track.stop_requested_at = this.now;
      f.phase = 'stopping';
      this.act({ kind: 'stop_turn', ai_id: f.ai_id, audio_playback_id: f.audio_playback_id, stop_point: 'word_boundary', max_wait_ms: this.init.stop_max_wait_ms, decision_source: o.source, reason: 'user_interjection' });
      this.interjectionEvent(track, 'stop_requested', 'user_interjection');
      this.s.sub = { kind: 'stopping_for_user', interjection_id };
    } else {
      const held = this.s.next;
      track.held = held !== null ? { turn_id: held.turn_id, point_id: held.turn?.point_id ?? null, point_variant: held.turn?.point_variant ?? null } : null;
      this.interjectionEvent(track, 'held_next_turn', 'between_turns');
      this.s.sub = { kind: 'user_floor', interjection_id, since: this.now };
    }
    this.gazeBoth('user', 'user_interjection');
    track.gaze_to_user_at = { A: this.now, B: this.now };
  }

  private interjectionEvent(track: InterjectionTrack, stage: Extract<TwoAiEventDraft, { event: 'two_ai.interjection' }>['stage'], reason: string): void {
    const onset = stage === 'onset';
    this.emit(
      {
        event: 'two_ai.interjection',
        interjection_id: track.interjection_id,
        stage,
        decision_source: track.decision_source,
        interrupted_ai: track.interrupted?.ai_id ?? null,
        during_point_id: track.interrupted?.point_id ?? track.held?.point_id ?? null,
        audio_playback_id: track.onset.audio_playback_id !== null ? present(track.onset.audio_playback_id) : absent('no_ai_speaking'),
        p_now_user: onset && track.onset.p_now_user !== null ? present(track.onset.p_now_user) : absent(onset ? `source_${track.decision_source}` : 'onset_only'),
        p_future_user: onset && track.onset.p_future_user !== null ? present(track.onset.p_future_user) : absent(onset ? `source_${track.decision_source}` : 'onset_only'),
        vad_user: onset && track.onset.vad_user !== null ? present(track.onset.vad_user) : absent(onset ? `source_${track.decision_source}` : 'onset_only'),
        mic_dbfs: onset && track.onset.mic_dbfs !== null ? present(track.onset.mic_dbfs) : absent(onset ? 'no_mic_level' : 'onset_only'),
        first_voiced_at: track.first_voiced_at !== null ? present(track.first_voiced_at) : absent('woz'),
        latency_ms: onset && track.first_voiced_at !== null ? present(Math.max(0, Math.round(track.detected_at - track.first_voiced_at))) : absent(onset ? 'woz' : 'onset_only'),
        classification: stage === 'classified' ? track.classification : null,
        classification_basis: stage === 'classified' ? track.classification_basis : null,
        reason: reason || stage,
      },
      { ai_id: track.interrupted?.ai_id ?? null, point_id: track.interrupted?.point_id ?? null },
    );
  }

  /** 割り込みの episode を閉じる（出したら track を消す）。 */
  private closeEpisode(track: InterjectionTrack, outcome: Extract<TwoAiEventDraft, { event: 'two_ai.interjection_episode' }>['outcome'], resumed: boolean): void {
    const ms = (v: number | null, reason: string) => (v !== null ? present(Math.round(v)) : absent(reason));
    const h = track.hold;
    this.emit(
      {
        event: 'two_ai.interjection_episode',
        interjection_id: track.interjection_id,
        outcome,
        false_onset_check: { window_ms: this.cfg.interjection.false_onset_window_ms, voiced_ms: Math.round(track.voiced_ms), had_text: track.had_text },
        decision_source: track.decision_source,
        interrupted_ai: track.interrupted?.ai_id ?? null,
        during_point_id: track.interrupted?.point_id ?? track.held?.point_id ?? null,
        onset_at: track.detected_at,
        user_voice_start_at: ms(track.first_voiced_at, 'woz'),
        stop_requested_at: ms(track.stop_requested_at, 'not_stopped'),
        stopped_at: ms(track.stopped_at, 'not_stopped'),
        stop_latency_ms: track.stopped_at !== null && track.first_voiced_at !== null ? present(Math.max(0, Math.round(track.stopped_at - track.first_voiced_at))) : absent('not_stopped'),
        gaze_to_user_at: { A: ms(track.gaze_to_user_at.A, 'not_turned'), B: ms(track.gaze_to_user_at.B, 'not_turned') },
        user_speech_end_at: ms(track.user_ended_at, 'not_observed'),
        ack: track.ack,
        reonsets_during_ack: track.reonsets_during_ack,
        correction: track.correction_applied,
        correction_hold:
          h === null
            ? null
            : {
                started_at: Math.round(h.started_at),
                hold_until: Math.round(h.hold_until),
                ended_at: Math.round(h.ended_at ?? this.now),
                ended_by: h.ended_by ?? 'abandoned',
                stt_final_after_ms: ms(h.stt_final_after_ms, 'no_final'),
                judgment_after_ms: ms(h.judgment_after_ms, 'no_judgment'),
                credited_ms: h.ended_by === 'timeout' ? ms(track.credited_ms, 'credit_not_received') : absent('not_timeout'),
              },
        near_marker: track.near_marker,
        resumed_at: resumed ? present(this.now) : absent(outcome === 'onset_no_speech' || outcome === 'logged_only' ? 'not_stopped' : 'no_resume'),
        asr_segment_ids: track.asr_segment_ids,
        fed: false,
      },
      { ai_id: track.interrupted?.ai_id ?? null, point_id: track.interrupted?.point_id ?? null },
    );
    if (resumed) this.interjectionEvent(track, 'resumed', outcome);
    for (const a of this.s.attempts) {
      if (a.interjection_id === track.interjection_id) {
        a.episode_outcome = outcome;
        a.stop_requested = track.stop_requested_at !== null;
      }
    }
    this.s.interjection = null;
  }

  /** ① の割り込みの進行（tick ごと）。 */
  private progressInterjection(): void {
    const track = this.s.interjection;
    if (track === null) return;
    if (track.logged_only) {
      if (this.now >= track.false_onset_until) this.closeEpisode(track, track.speech_confirmed ? 'logged_only' : 'onset_no_speech', false);
      return;
    }
    const sub = this.s.sub;
    if (sub.kind === 'user_floor') {
      if (!track.user_floor_warned && this.now - sub.since >= this.cfg.interjection.user_floor_max_ms) {
        track.user_floor_warned = true;
        this.emit({ event: 'two_ai.anomaly', kind: 'user_floor_long', speaker: null, detail: `user_floor>=${this.cfg.interjection.user_floor_max_ms}ms` });
      }
      if (track.ack_ended_at !== null) {
        // 受け止めの後の再度の話し始め：話し終えたら受け止めなしで先へ（m7）。
        if (!this.inp.user.speaking) this.afterAck(track);
        return;
      }
      if (!track.speech_confirmed && this.now >= track.false_onset_until) {
        // 誤った停止（M3）：受け止めなし、戻りの句なし。notify はしない。
        track.outcome = 'false_onset';
        this.emit({ event: 'two_ai.anomaly', kind: 'detector_degraded', speaker: null, detail: `false_onset:${track.interjection_id}` });
        this.requestResume(track, 'false_onset');
        return;
      }
      if (track.speech_confirmed && !this.inp.user.speaking && track.classification === 'backchannel' && (track.classification_basis === 'final' || track.classification_basis === 'interim')) {
        if (this.s.ack_offer !== null || track.ack_offered) this.act({ kind: 'withdraw_ack', reason: 'backchannel' });
        this.s.ack_offer = null;
        track.user_ended_at = this.now;
        this.interjectionEvent(track, 'user_ended', 'backchannel');
        this.classify(track, 'backchannel', track.classification_basis);
        track.outcome = 'backchannel';
        this.requestResume(track, 'after_ack');
        return;
      }
      if (track.speech_confirmed && !track.ack_offered) {
        track.ack_offered = true;
        this.act({ kind: 'offer_ack', ai_id: track.ack_speaker, interjection_id: track.interjection_id });
      }
      return;
    }
    if (sub.kind === 'correction_window') this.progressCorrectionWindow(track, sub);
  }

  private factSlipStarted(): PointProgress | null {
    return Object.values(this.s.points).find((p) => p.kind === 'fact_slip' && (p.state === 'in_progress' || p.state === 'completed') && !p.switched) ?? null;
  }

  /** 止めたターン（間なら待たせた次のターン）が F のブロック（元の版）に属するか。 */
  private inFBlock(track: InterjectionTrack): boolean {
    const ref = track.interrupted ?? track.held;
    if (ref === null || ref.point_id === null) return false;
    const p = this.s.points[ref.point_id];
    return p !== undefined && p.kind === 'fact_slip' && !p.switched && (ref.point_variant ?? 'original') === 'original';
  }

  private afterAck(track: InterjectionTrack): void {
    track.outcome = track.outcome ?? 'yielded';
    const slip = this.factSlipStarted();
    if (this.onSpot && slip !== null) {
      const userEnd = track.user_ended_at ?? this.now;
      const until = Math.max(userEnd + this.cfg.correction.decision_window_ms, track.ack_ended_at ?? this.now);
      const hold = this.inFBlock(track) && (track.classification === 'content' || track.classification === 'unknown');
      const hold_until = hold ? userEnd + this.cfg.correction.hold_max_ms : null;
      const hold_cap = hold ? userEnd + this.cfg.correction.hold_max_ms * 2 : null;
      if (hold) track.hold = { started_at: userEnd, hold_until: hold_until as number, ended_at: null, ended_by: null, judgment_after_ms: null, stt_final_after_ms: track.hold?.stt_final_after_ms ?? null };
      this.interjectionEvent(track, 'correction_wait', hold ? 'hold' : 'window');
      this.s.sub = { kind: 'correction_window', interjection_id: track.interjection_id, until, hold_until, hold_cap };
      this.progressCorrectionWindow(track, this.s.sub);
      return;
    }
    this.requestResume(track, 'after_ack');
  }

  private progressCorrectionWindow(track: InterjectionTrack, sub: Extract<DirectorState['sub'], { kind: 'correction_window' }>): void {
    if (track.correction_decided !== null) {
      this.applyInWindow(track);
      return;
    }
    if (sub.hold_until === null) {
      if (this.now >= sub.until) this.requestResume(track, 'after_ack');
      return;
    }
    // 保留：本人が話している間は保留の時計を止める。上限は hold_cap（第 5 回 m2）。
    if (this.inp.user.speaking && this.dt > 0) {
      sub.hold_until = Math.min(sub.hold_cap ?? Number.POSITIVE_INFINITY, sub.hold_until + this.dt);
      if (track.hold !== null) track.hold.hold_until = sub.hold_until;
    }
    if (this.s.correction_mode === 'auto') {
      const s = this.suggestionFor(track);
      if (s !== null && s.status === 'done' && s.corrects === false) {
        this.s.correction.handled_suggestion_ids.push(s.suggestion_id);
        this.endHold(track, 'not_correction');
        this.requestResume(track, 'after_ack');
        return;
      }
      if (s !== null && s.status === 'failed') {
        this.s.correction.handled_suggestion_ids.push(s.suggestion_id);
        this.abandonHold(track, 'correction_judgment_failed');
        return;
      }
    }
    if (this.now >= sub.hold_until || (sub.hold_cap !== null && this.now >= sub.hold_cap)) this.abandonHold(track, 'correction_hold_timeout');
  }

  /** この割り込みの確定文の提案（asr の区間が重なるもの。なければ onset の後に現れた提案）。 */
  private suggestionFor(track: InterjectionTrack): CorrectionSuggestion | null {
    const fresh = this.inp.correction_suggestions.filter((x) => !track.seen_suggestion_ids.includes(x.suggestion_id) && !this.s.correction.handled_suggestion_ids.includes(x.suggestion_id));
    const overlap = fresh.find((x) => x.asr_segment_ids.some((id) => track.asr_segment_ids.includes(id)));
    const s = overlap ?? fresh[0] ?? null;
    if (s !== null && s.status !== 'pending' && track.hold !== null && track.hold.judgment_after_ms === null && track.user_ended_at !== null) {
      track.hold.judgment_after_ms = Math.max(0, this.now - track.user_ended_at);
    }
    return s;
  }

  private endHold(track: InterjectionTrack, by: 'corrected' | 'not_correction' | 'timeout' | 'woz_resume' | 'abandoned'): void {
    if (track.hold === null || track.hold.ended_by !== null) return;
    track.hold.ended_at = this.now;
    track.hold.ended_by = by;
  }

  /** 時間切れか auto の failed（06 §6.2 (3)）：hold_bridge と abandon_resume。F の残りは話さない。 */
  private abandonHold(track: InterjectionTrack, reason: AbandonResumeReason): void {
    this.endHold(track, 'timeout');
    this.requestFixed({ kind: 'hold_bridge', ai_id: track.ack_speaker }, true);
    this.act({ kind: 'abandon_resume', interrupted_turn_id: track.interrupted?.turn_id ?? null, interjection_id: track.interjection_id, reason });
    this.interjectionEvent(track, 'abandoned', reason);
    // 準備済みの F のブロックのターン（next を含む）を捨てる（第 5 回 m1）。fallback も出さない。
    const slipIds = new Set(Object.values(this.s.points).filter((p) => p.kind === 'fact_slip').map((p) => p.point_id));
    for (const p of Object.values(this.s.points)) if (slipIds.has(p.point_id)) p.abandoned = true;
    const next = this.s.next;
    if (next !== null && (next.turn === null ? track.held?.turn_id === next.turn_id : next.turn.point_id !== null && slipIds.has(next.turn.point_id))) {
      this.act({ kind: 'cancel_turn', ai_id: next.turn?.speaker ?? null, turn_id: next.turn_id, audio_playback_id: next.audio_playback_id, reason: 'abandon_resume' });
      this.turnEvent('cancelled', { turn_id: next.turn_id, turn_kind: next.turn?.turn_kind ?? 'point_elaboration', speaker: next.turn?.speaker ?? null, view: next.turn, reason: 'abandon_resume' });
      this.s.next = null;
    }
    track.outcome = track.outcome ?? 'yielded';
    this.s.sub = { kind: 'between_turns' };
  }

  private applyInWindow(track: InterjectionTrack): void {
    const decided = track.correction_decided;
    if (decided === null) return;
    track.correction_decided = null;
    const drop = this.inFBlock(track);
    this.applyCorrection(decided.point_id, decided.trigger, 'in_window', track.interrupted?.turn_id ?? null);
    track.correction_applied = { point_id: decided.point_id, trigger: decided.trigger, timing: 'in_window' };
    this.endHold(track, 'corrected');
    track.after_uptake = drop ? 'continue' : 'resume';
    this.s.sub = { kind: 'resuming', interjection_id: track.interjection_id };
  }

  private applyCorrection(point_id: string, trigger: 'woz_researcher' | 'auto_confirmed', timing: 'in_window' | 'next_boundary', interrupted_turn_id: string | null): void {
    const p = this.s.points[point_id];
    if (p !== undefined) {
      p.switched = true;
      this.pointEvent(p, 'switched_to_corrected', null, `${trigger}:${timing}`);
    }
    this.s.correction.applied_point_ids.push(point_id);
    this.s.script_variant = 'corrected';
    this.act({ kind: 'apply_correction', point_id, trigger, timing, interrupted_turn_id });
    this.s.awaiting_uptake_until = this.now + this.cfg.gaps_ms.max_wait_for_ready_ms;
  }

  private requestResume(track: InterjectionTrack, mode: 'after_ack' | 'false_onset'): void {
    const ref = track.interrupted;
    if (ref !== null && !track.interrupted_completed) {
      const turn_id = this.newTurnId();
      track.resume_turn_id = turn_id;
      this.s.queue.unshift(this.pending(turn_id, 'resume'));
      this.act({
        kind: 'request_resume',
        turn_id,
        resume: { interjection_id: track.interjection_id, interrupted_turn_id: ref.turn_id, interrupted_ai: ref.ai_id, spoken_text: '', point_id: ref.point_id },
        last_speaker: ref.ai_id,
        mode,
      });
      this.s.sub = { kind: 'resuming', interjection_id: track.interjection_id };
    } else {
      // AI 同士の間（または止める前に話し終えた）：用意済みの次のターンをそのまま話す。
      this.s.sub = { kind: 'between_turns' };
    }
  }

  // ---- WoZ と訂正の提案 ---------------------------------------------------------

  private handleWoz(): void {
    for (const w of this.inp.woz) {
      switch (w.action) {
        case 'stop': {
          const f = this.s.floor;
          if (f !== null) this.act({ kind: 'stop_turn', ai_id: f.ai_id, audio_playback_id: f.audio_playback_id, stop_point: 'word_boundary', max_wait_ms: this.init.stop_max_wait_ms, decision_source: 'woz', reason: 'woz_stop' });
          this.s.woz_paused = true;
          this.act({ kind: 'pause', reason: 'woz_stop' });
          break;
        }
        case 'face_user':
          this.gazeBoth('user', 'woz_face_user');
          break;
        case 'yield':
          if (this.s.phase === 'discussion' && this.onSpot) this.startInterjection({ source: 'woz', first_voiced_at: null, detected_at: this.now, p_now_user: null, p_future_user: null, vad_user: null, mic_dbfs: null });
          break;
        case 'resume':
          this.wozResume();
          break;
        case 'correction':
          this.wozCorrection(w.point_id);
          break;
        case 'advance_phase':
          this.stopFloor('woz_advance_phase');
          this.advancePhase('woz', 'woz_advance_phase');
          break;
        case 'abort':
          this.stopFloor('woz_abort');
          this.s.retraction.trigger = 'aborted';
          this.enterPhase('end', 'woz', 'woz_abort');
          break;
      }
    }
  }

  private stopFloor(reason: string): void {
    const f = this.s.floor;
    if (f === null || f.phase === 'stopping') return;
    f.phase = 'stopping';
    this.act({ kind: 'stop_turn', ai_id: f.ai_id, audio_playback_id: f.audio_playback_id, stop_point: 'word_boundary', max_wait_ms: this.init.stop_max_wait_ms, decision_source: 'woz', reason });
  }

  private wozResume(): void {
    const track = this.s.interjection;
    const sub = this.s.sub;
    if (track !== null && sub.kind === 'correction_window' && sub.hold_until !== null) {
      // 研究者の「訂正でない」（第 5 回 M1）：保留を woz_resume で終え、F.1 から予定どおり話す（取り違えの文は言い直さない）。
      this.endHold(track, 'woz_resume');
      track.outcome = track.outcome ?? 'yielded';
      this.s.sub = { kind: 'between_turns' };
      return;
    }
    if (this.s.woz_paused) {
      this.s.woz_paused = false;
      this.s.consecutive_failures = 0;
      if (this.s.sub.kind === 'waiting_plan') this.useFallbackPlan('woz_resume');
      return;
    }
    if (track !== null && !track.logged_only && (sub.kind === 'user_floor' || sub.kind === 'acknowledging')) {
      if (this.s.ack_offer !== null) this.act({ kind: 'withdraw_ack', reason: 'woz_resume' });
      this.s.ack_offer = null;
      track.outcome = track.outcome ?? (track.ack !== null ? 'yielded' : 'abandoned');
      this.requestResume(track, 'after_ack');
    }
  }

  private wozCorrection(point_id: string | null): void {
    const known = new Map(Object.values(this.s.points).map((p) => [p.point_id, { kind: p.kind, started: p.state !== 'pending', switched: p.switched }] as const));
    const id = resolveCorrectionPoint(point_id, known);
    if (id === null) return;
    if (this.s.phase === 'response') {
      this.act({ kind: 'record_correction_only', point_id: id, trigger: 'woz_researcher' });
      this.s.response.correction_recorded = true;
      return;
    }
    if (this.s.phase !== 'discussion' || !this.onSpot) return;
    this.decideCorrection(id, 'woz_researcher');
  }

  private decideCorrection(point_id: string, trigger: 'woz_researcher' | 'auto_confirmed'): void {
    const p = this.s.points[point_id];
    if (p === undefined || p.switched) return;
    const track = this.s.interjection;
    const sub = this.s.sub.kind;
    const inInterjection = track !== null && !track.logged_only && (sub === 'user_floor' || sub === 'acknowledging' || sub === 'stopping_for_user' || sub === 'correction_window');
    if (inInterjection && track !== null) {
      // 窓の中（保留の間を含む。06 §6.2 (1)）は in_window。受け止めの後に出す。
      track.correction_decided = { point_id, trigger };
      if (this.s.sub.kind === 'correction_window') this.applyInWindow(track);
      return;
    }
    // 窓の外：次の境界で uptake（話している発話は止めない）。
    this.applyCorrection(point_id, trigger, 'next_boundary', null);
  }

  private handleSuggestions(): void {
    if (this.s.correction_mode !== 'auto') return;
    for (const s of this.inp.correction_suggestions) {
      if (s.status !== 'done' || s.corrects !== true) continue;
      if (this.s.correction.handled_suggestion_ids.includes(s.suggestion_id)) continue;
      this.s.correction.handled_suggestion_ids.push(s.suggestion_id);
      const track = this.s.interjection;
      if (track !== null && track.hold !== null && track.hold.judgment_after_ms === null && track.user_ended_at !== null) {
        track.hold.judgment_after_ms = Math.max(0, this.now - track.user_ended_at);
      }
      if (this.s.phase === 'response') {
        this.act({ kind: 'record_correction_only', point_id: s.point_id, trigger: 'auto_confirmed' });
        this.s.response.correction_recorded = true;
      } else if (this.s.phase === 'discussion' && this.onSpot) {
        this.decideCorrection(s.point_id, 'auto_confirmed');
      }
    }
  }

  // ---- 段階 ----------------------------------------------------------------------

  private plannedDurationMs(phase: TwoAiPhase): number | null {
    const p = this.cfg.phases;
    switch (phase) {
      case 'intake':
        return p.intake.max_sec * 1000;
      case 'discussion':
        return p.discussion.max_sec * 1000;
      case 'response':
        return p.response.duration_sec * 1000;
      case 'next_step':
        return p.next_step.pick_max_sec * 1000;
      case 'end':
        return null;
    }
  }

  private advancePhase(source: 'auto_timer' | 'auto_content' | 'woz' | 'error', reason: string): void {
    const order: TwoAiPhase[] = ['intake', 'discussion', 'response', 'next_step', 'end'];
    const i = order.indexOf(this.s.phase);
    const to = order[i + 1];
    if (to === undefined) return;
    if (this.s.phase === 'response') {
      // 作り直しは飛ばさない（図 1）。
      this.s.response_extra.ended_by = source === 'woz' ? 'woz' : 'timer';
      if (this.s.sub.kind !== 'rebuilding') this.finishResponse();
      return;
    }
    this.enterPhase(to, source, reason);
  }

  enterPhase(to: TwoAiPhase, source: 'auto_timer' | 'auto_content' | 'woz' | 'error', reason: string): void {
    const from = this.s.phase;
    if (from === to) return;
    if (from === 'discussion') this.leaveDiscussion();
    const planned = this.plannedDurationMs(to);
    this.emit({
      event: 'two_ai.phase_changed',
      from,
      to,
      source,
      reason,
      elapsed_in_from_ms: present(Math.max(0, Math.round(this.now - this.s.phase_started_at))),
      planned_duration_ms: planned === null ? absent('no_limit') : present(planned),
    });
    this.act({ kind: 'set_phase', to, source, reason });
    this.s.phase = to;
    this.s.phase_started_at = this.now;
    this.s.sub = { kind: 'idle' };
    // 前の段の準備済みの次のターンは使わない。
    if (this.s.next !== null) {
      this.act({ kind: 'cancel_turn', ai_id: this.s.next.turn?.speaker ?? null, turn_id: this.s.next.turn_id, audio_playback_id: this.s.next.audio_playback_id, reason: `phase_${to}` });
      this.s.next = null;
    }
    this.s.queue = this.s.queue.filter((q) => q.source === 'uptake' && to === 'discussion');
    if (this.s.ack_offer !== null) {
      this.act({ kind: 'withdraw_ack', reason: `phase_${to}` });
      this.s.ack_offer = null;
    }
    switch (to) {
      case 'discussion': {
        this.act({ kind: 'route_user_turns', responder: null });
        if (!this.s.plan.final_requested) {
          this.s.plan.final_requested = true;
          this.act({ kind: 'start_plan', trigger: 'final' });
        }
        const turn_id = this.requestFixed({ kind: 'phase_line', phase: 'discussion', edge: 'open' });
        this.s.sub = { kind: 'phase_open', turn_id };
        break;
      }
      case 'response':
        this.act({ kind: 'route_user_turns', responder: null });
        this.act({ kind: 'send_stage', current: null, show: 'all' });
        this.gazeBoth('user', 'response');
        this.requestFixed({ kind: 'closing_question' });
        this.s.sub = { kind: 'closing_question' };
        break;
      case 'next_step':
        this.s.board.mode = 'pick';
        this.s.pick.opened_at = this.now;
        this.act({ kind: 'send_board', reason: 'pick_opened', trigger_turn_id: null });
        this.requestFixed({ kind: 'pick_line', line: 'prompt' });
        this.s.sub = { kind: 'awaiting_pick', since: this.now };
        this.gazeBoth('user', 'next_step');
        break;
      case 'end': {
        this.act({ kind: 'route_user_turns', responder: null });
        this.gazeBoth('user', 'end');
        if (from === 'response' && this.s.response.started_at !== null && this.s.response_extra.ended_by === null) {
          this.s.response_extra.ended_by = 'woz';
          this.emitResponseWindow();
        }
        const speak = this.cfg.retraction.timing === 'end_of_session' || this.s.retraction.trigger === 'aborted';
        this.s.retraction.speak = speak;
        if (speak) {
          this.s.sub = { kind: 'retraction' };
          this.requestFixed({ kind: 'retraction', index: 0 });
        } else {
          this.s.retraction.done = true;
          this.requestFixed({ kind: 'phase_line', phase: 'end', edge: 'open' });
        }
        break;
      }
      case 'intake':
        break;
    }
  }

  private leaveDiscussion(): void {
    const track = this.s.interjection;
    if (track !== null) {
      this.endHold(track, 'abandoned');
      this.closeEpisode(track, track.logged_only ? (track.speech_confirmed ? 'logged_only' : 'onset_no_speech') : 'abandoned', false);
    }
    if (this.s.discussion_stage !== null) this.stageEvent(this.s.discussion_stage, 'ended', null);
    for (const p of Object.values(this.s.points)) {
      if (p.state === 'pending' || p.state === 'in_progress') {
        p.state = 'missed';
        this.pointEvent(p, 'missed', null, 'discussion_ended');
        this.emitPointExposure(p);
      }
    }
  }

  private headingOf(stage: DiscussionStage): string {
    const headings = this.inp.stage_headings ?? this.cfg.fixed.stage_headings;
    return headings[stage - 1] ?? `stage_${stage}`;
  }

  private stageEvent(stage: DiscussionStage, edge: 'started' | 'ended', turn_id: string | null): void {
    this.emit({
      event: 'two_ai.stage',
      discussion_stage: stage,
      edge,
      heading: this.headingOf(stage),
      turn_id,
      content_elapsed_ms: Math.round(this.s.content_elapsed_ms),
      discussion_elapsed_ms: Math.max(0, Math.round(this.now - (this.s.discussion_started_at ?? this.now))),
    });
  }

  // ---- intake --------------------------------------------------------------------

  private progressIntake(): void {
    const s = this.s;
    const cfg = this.cfg.phases.intake;
    if (!s.intake.first_question_spoken) {
      s.intake.first_question_spoken = true;
      this.act({ kind: 'route_user_turns', responder: this.cfg.speakers.intake });
      this.gazeBoth('user', 'intake');
      this.requestFixed({ kind: 'intake_line', line: 'first_question' });
      return;
    }
    if (this.inp.intake_readback_due && !s.intake.readback_spoken) {
      s.intake.readback_spoken = true;
      this.act({ kind: 'offer_fixed', ai_id: this.cfg.speakers.intake, line: { kind: 'intake_line', line: 'core_readback' } });
    }
    const elapsed = this.now - s.phase_started_at;
    if (!s.plan.early_requested && elapsed >= cfg.plan_start_sec * 1000 && this.inp.plan.can_start_early) {
      s.plan.early_requested = true;
      this.act({ kind: 'start_plan', trigger: 'early' });
    }
    if (s.sub.kind !== 'user_turn') return;
    const quiet = !this.inp.user.speaking && s.floor === null && s.queue.length === 0 && this.inp.slots.A.active_playback === null && this.inp.slots.B.active_playback === null;
    if (!quiet) return;
    if (elapsed >= cfg.min_sec * 1000 && this.inp.content_done.intake) this.enterPhase('discussion', 'auto_content', 'intake_done');
    else if (elapsed >= cfg.max_sec * 1000) this.enterPhase('discussion', 'auto_timer', 'intake_max');
  }

  // ---- discussion ----------------------------------------------------------------

  private afterOpening(): void {
    if (this.planReady()) {
      this.beginDiscussion();
      return;
    }
    this.s.plan.wait_started_at = this.now;
    this.s.sub = { kind: 'waiting_plan', since: this.now };
    this.gazeBoth('peer', 'waiting_plan');
    this.planWaitEvent('started', 0, null, 'plan_not_ready');
  }

  private planReady(): boolean {
    return this.inp.plan.state === 'ready' || this.s.plan_fallback_used;
  }

  private planWaitEvent(stage: 'started' | 'filler' | 'ready' | 'timeout' | 'fallback_used' | 'paused', waited: number, source: 'early' | 'final' | 'prepared' | 'fallback_outline' | null, reason: string): void {
    this.emit({ event: 'two_ai.plan_wait', stage, waited_ms: Math.max(0, Math.round(waited)), plan_source: source, reason });
  }

  private beginDiscussion(): void {
    if (this.s.plan.wait_started_at !== null) {
      const src = this.s.plan_fallback_used ? 'fallback_outline' : this.inp.plan.source === 'prepared' ? 'prepared' : this.inp.plan.source === 'fallback_outline' ? 'fallback_outline' : 'final';
      this.planWaitEvent('ready', this.now - this.s.plan.wait_started_at, src, 'plan_ready');
    }
    this.s.discussion_started_at = this.now;
    this.s.sub = { kind: 'between_turns' };
    this.act({ kind: 'start_discussion' });
    this.gazeBoth('peer', 'discussion');
    this.requestNext('discussion_start');
  }

  private useFallbackPlan(reason: string): void {
    this.act({ kind: 'use_fallback_plan', reason });
    this.s.plan_fallback_used = true;
    this.planWaitEvent('fallback_used', this.now - (this.s.plan.wait_started_at ?? this.now), 'fallback_outline', reason);
    this.beginDiscussion();
  }

  private progressDiscussion(): void {
    const s = this.s;
    const sub = s.sub;
    const pw = this.cfg.phases.plan_wait;
    if (sub.kind === 'waiting_plan') {
      if (this.planReady()) {
        this.beginDiscussion();
        return;
      }
      if (s.woz_paused) return;
      const waited = this.now - sub.since;
      if (s.plan.fillers_spoken === 0 && waited >= pw.filler_after_ms) {
        s.plan.fillers_spoken = 1;
        this.requestFixed({ kind: 'plan_filler', index: 0 });
        this.planWaitEvent('filler', waited, null, 'filler_0');
      } else if (s.plan.fillers_spoken === 1 && pw.second_filler_after_ms !== null && waited >= pw.second_filler_after_ms) {
        s.plan.fillers_spoken = 2;
        this.requestFixed({ kind: 'plan_filler', index: 1 });
        this.planWaitEvent('filler', waited, null, 'filler_1');
      }
      if (waited >= pw.max_wait_ms) {
        this.planWaitEvent('timeout', waited, null, pw.on_timeout);
        this.emit({ event: 'two_ai.anomaly', kind: 'plan_wait_timeout', speaker: null, detail: `waited ${Math.round(waited)}ms` });
        if (pw.on_timeout === 'fallback_plan') {
          this.useFallbackPlan('plan_wait_timeout');
        } else {
          s.woz_paused = true;
          this.act({ kind: 'pause', reason: 'plan_wait_timeout' });
          this.planWaitEvent('paused', waited, null, 'pause_for_woz');
        }
      }
      return;
    }
    if (s.discussion_started_at === null) return;
    const d = this.cfg.phases.discussion;
    // ① の割り込みの時間（開いている割り込み、保留の時間切れのつなぎの再生）は上限の壁時計から引く（U1。上限 interjection_allowance_max_sec）。
    const ij = s.interjection;
    if ((ij !== null && !ij.logged_only) || s.floor?.turn_kind === 'bridge') s.interjection_wall_ms += this.dt;
    const allowance = Math.min(s.interjection_wall_ms, d.interjection_allowance_max_sec * 1000);
    const wall = this.now - s.discussion_started_at - allowance;
    const points = Object.values(s.points);
    const open = points.filter((p) => p.state === 'pending' || p.state === 'in_progress');
    // 点と段の上限（01 §3.3.3）。
    if (wall >= d.max_sec * 1000 && !s.points_forced && open.some((p) => p.state === 'pending')) {
      s.points_forced = true;
      this.act({ kind: 'force_points', reason: 'discussion_max_sec' });
      for (const p of open.filter((x) => x.state === 'pending')) this.pointEvent(p, 'forced', null, 'discussion_max_sec');
    }
    if (wall >= (d.max_sec + d.points_overrun_max_sec) * 1000 && !s.wall_overrun_handled) {
      s.wall_overrun_handled = true;
      if (open.length > 0) this.emit({ event: 'two_ai.anomaly', kind: 'point_over_limit', speaker: null, detail: open.map((p) => p.point_id).join(',').slice(0, 200) || 'points' });
      for (const p of open) {
        p.state = 'missed';
        this.pointEvent(p, 'missed', null, 'absolute_limit');
        this.emitPointExposure(p);
      }
      s.discussion_closing = true;
      s.discussion_closing_source = 'auto_timer';
      // 受け止めは切らない（AC1。WoZ の中止だけが例外）。受け止めの終わりを待って close へ進む。
      if (s.floor !== null && s.floor.turn_kind !== 'ack') {
        const f = s.floor;
        if (f.phase !== 'stopping') {
          f.phase = 'stopping';
          this.act({ kind: 'stop_turn', ai_id: f.ai_id, audio_playback_id: f.audio_playback_id, stop_point: 'word_boundary', max_wait_ms: this.init.stop_max_wait_ms, decision_source: 'vap', reason: 'discussion_absolute_limit' });
        }
      }
    }
    const allClosed = Object.values(s.points).every((p) => p.state === 'completed' || p.state === 'unavailable' || p.state === 'missed');
    const wantsEnd = this.inp.content_done.discussion || wall >= d.max_sec * 1000;
    if (!s.discussion_closing && wantsEnd && allClosed && s.interjection === null) {
      s.discussion_closing = true;
      s.discussion_closing_source = this.inp.content_done.discussion ? 'auto_content' : 'auto_timer';
    }
    if (s.discussion_closing) {
      if (s.closing_requested !== 'discussion' && s.floor === null && s.interjection === null && (sub.kind === 'between_turns' || sub.kind === 'ai_speaking' || sub.kind === 'resuming')) {
        s.closing_requested = 'discussion';
        if (s.next !== null) {
          this.act({ kind: 'cancel_turn', ai_id: s.next.turn?.speaker ?? null, turn_id: s.next.turn_id, audio_playback_id: s.next.audio_playback_id, reason: 'discussion_closing' });
          s.next = null;
        }
        s.queue = s.queue.filter((q) => q.source === 'uptake');
        this.requestFixed({ kind: 'phase_line', phase: 'discussion', edge: 'close' });
        s.sub = { kind: 'closing' };
      }
      return;
    }
    // 止めている間（WoZ の pause、続けての失敗）は次を頼まない（研究者の resume で再開する）。
    if (s.woz_paused) return;
    if ((sub.kind === 'between_turns' || (sub.kind === 'resuming' && s.queue.length === 0)) && s.next === null && s.floor === null) this.requestNext('between_turns');
  }

  // ---- response ------------------------------------------------------------------

  private progressResponse(): void {
    const s = this.s;
    const r = this.cfg.phases.response;
    if (s.sub.kind !== 'user_turn' || s.response.started_at === null) return;
    if (this.inp.user.speaking) {
      s.response_extra.user_speech_ms += this.dt;
      s.response.last_user_voice_at = this.now;
      s.response_extra.voice_confirmed = true;
    }
    const due = s.response.started_at + r.duration_sec * 1000;
    if (this.now < due) {
      const silentFor = this.now - (s.response.last_user_voice_at ?? s.response.started_at);
      if (!this.inp.user.speaking && s.floor === null && s.queue.length === 0 && s.response.silence_prompts < r.max_silence_prompts && silentFor >= r.silence_prompt_sec * 1000) {
        s.response.silence_prompts += 1;
        s.response.last_user_voice_at = this.now;
        this.requestFixed({ kind: 'response_line', line: 'more' });
      }
      return;
    }
    if (s.response.time_up_at === null) s.response.time_up_at = this.now;
    const overrunEnd = s.response.time_up_at + r.overrun_max_sec * 1000;
    if (s.floor !== null) return;
    if (!s.response_extra.voice_confirmed) {
      // 黙っていた本人には受け止めをしない（第 3 回 m3）。
      if (!this.inp.user.speaking || this.now >= overrunEnd) this.finishResponse();
      return;
    }
    if (!s.response_extra.ack_offered) {
      s.response_extra.ack_offered = true;
      this.act({ kind: 'offer_ack', ai_id: this.cfg.speakers.closing, interjection_id: null });
      return;
    }
    if (this.now >= overrunEnd && s.ack_offer !== null) {
      this.act({ kind: 'withdraw_ack', reason: 'response_overrun' });
      s.ack_offer = null;
      this.finishResponse();
    }
  }

  private emitResponseWindow(): void {
    const s = this.s;
    const started = s.response.started_at ?? this.now;
    const planned = this.cfg.phases.response.duration_sec * 1000;
    this.emit({
      event: 'two_ai.response_window',
      planned_ms: Math.round(planned),
      question_played_ms: Math.round(s.response_extra.question_played_ms),
      started_at: Math.round(started),
      ended_at: Math.round(this.now),
      ended_by: s.response_extra.ended_by ?? 'timer',
      overrun_ms: Math.max(0, Math.round(this.now - (started + planned))),
      user_speech_ms: Math.round(s.response_extra.user_speech_ms),
      silence_prompts: s.response.silence_prompts,
      correction_recorded: s.response.correction_recorded,
      ack_given: s.response_extra.ack_given,
    });
  }

  private finishResponse(): void {
    if (this.s.sub.kind === 'rebuilding') return;
    if (this.s.response.started_at !== null) {
      this.s.response_extra.ended_by = this.s.response_extra.ended_by ?? 'timer';
      this.emitResponseWindow();
    }
    this.s.queue = this.s.queue.filter((q) => q.source === 'rebuild');
    this.act({ kind: 'request_rebuild' });
    this.s.sub = { kind: 'rebuilding', next_index: 0 };
  }

  // ---- next_step -----------------------------------------------------------------

  private progressNextStep(): void {
    const s = this.s;
    const sub = s.sub;
    for (const pick of this.inp.board_picks) {
      const latency = s.pick.opened_at !== null ? present(Math.max(0, Math.round(pick.at - s.pick.opened_at))) : absent('pick_not_opened');
      const base = { pick_id: pick.pick_id, card_id: pick.card_id, card_variant: null, card_depends_on: null, board_version: pick.board_version, latency_ms: latency };
      let reason: string | null = null;
      if (sub.kind !== 'awaiting_pick') reason = 'phase';
      else if (s.pick.done) reason = 'already_picked';
      else if (pick.board_version !== s.board.version) reason = 'stale_board';
      else if (pick.card_known === false) reason = 'unknown_card';
      const at = { t_monotonic_ms: pick.at, time_basis: pick.time_basis };
      if (reason !== null) {
        this.emit({ event: 'two_ai.board_picked', ...base, outcome: 'rejected', reason }, { ai_id: null }, at);
        this.emit({ event: 'two_ai.anomaly', kind: 'board_pick_rejected', speaker: null, detail: reason });
        continue;
      }
      s.pick.done = true;
      s.board.mode = 'picked';
      s.board.picked_card_id = pick.card_id;
      this.emit({ event: 'two_ai.board_picked', ...base, outcome: 'picked', reason: 'picked' }, { ai_id: null }, at);
      this.act({ kind: 'send_board', reason: 'picked', trigger_turn_id: null });
      this.requestFixed({ kind: 'pick_line', line: 'confirm' });
    }
    if (sub.kind === 'awaiting_pick' && !s.pick.done && this.now - sub.since >= this.cfg.phases.next_step.pick_max_sec * 1000) {
      s.pick.done = true;
      this.emit({
        event: 'two_ai.board_picked',
        pick_id: null,
        outcome: 'timeout',
        card_id: null,
        card_variant: null,
        card_depends_on: null,
        board_version: s.board.version,
        latency_ms: absent('timeout'),
        reason: 'pick_max_sec',
      });
      this.requestFixed({ kind: 'pick_line', line: 'timeout' });
    }
  }

  private rejectPicksOutside(): void {
    if (this.s.phase === 'next_step') return;
    for (const pick of this.inp.board_picks) {
      this.emit(
        { event: 'two_ai.board_picked', pick_id: pick.pick_id, outcome: 'rejected', card_id: pick.card_id, card_variant: null, card_depends_on: null, board_version: pick.board_version, latency_ms: absent('phase'), reason: 'phase' },
        { ai_id: null },
        { t_monotonic_ms: pick.at, time_basis: pick.time_basis },
      );
      this.emit({ event: 'two_ai.anomaly', kind: 'board_pick_rejected', speaker: null, detail: 'phase' });
    }
  }

  // ---- 準備が間に合わない ---------------------------------------------------------

  private checkFallback(): void {
    const s = this.s;
    const next = s.next;
    if (s.phase !== 'discussion' || next === null || s.floor !== null || s.sub.kind !== 'between_turns' || s.queue.length > 0) return;
    const g = this.cfg.gaps_ms;
    if (next.state === 'requested' && !next.fallback_used) {
      const base = s.last_turn_ended_at ?? next.requested_at;
      const wait = s.feed_wait ? g.feed_turn_max_wait_ms : g.max_wait_for_ready_ms;
      if (this.now >= Math.max(base + g.default.median, next.requested_at) + wait) {
        next.fallback_used = true;
        this.act({ kind: 'cancel_turn', ai_id: null, turn_id: next.turn_id, audio_playback_id: null, reason: 'not_arrived_in_time' });
        this.act({ kind: 'substitute_fallback', turn_id: next.turn_id, reason: 'not_arrived_in_time' });
        this.turnEvent('fallback_substituted', { turn_id: next.turn_id, turn_kind: 'discussion', speaker: null, reason: 'not_arrived_in_time' });
      }
    } else if (next.state === 'arrived' && !next.late_logged && next.turn !== null) {
      const desired = this.desiredStart(next);
      if (this.now >= desired) {
        next.late_logged = true;
        this.turnEvent('late', { turn_id: next.turn_id, turn_kind: next.turn.turn_kind, speaker: next.turn.speaker, view: next.turn, audio_playback_id: next.audio_playback_id, waited_for_ready_ms: this.now - desired, reason: 'tts_not_ready' });
      }
    }
  }

  // ---- 開始 ----------------------------------------------------------------------

  private desiredStart(p: PendingTurn): number {
    const last = this.s.last_turn_ended_at ?? this.now;
    if (p.source === 'resume') return last + this.cfg.gaps_ms.resume_gap_ms;
    if (p.source === 'next_turn' || p.source === 'fallback') return last + (p.turn?.gap_hint_ms ?? 0);
    return last;
  }

  private tryStart(): void {
    const s = this.s;
    if (s.floor !== null || !this.inp.link_attached || s.woz_paused) return;
    if (this.inp.slots.A.active_playback !== null || this.inp.slots.B.active_playback !== null) return;
    const blocked = ['stopping_for_user', 'user_floor', 'acknowledging', 'correction_window', 'ended'];
    if (blocked.includes(s.sub.kind)) return;
    if (s.phase === 'discussion' && this.onSpot && s.interjection !== null && !s.interjection.logged_only && this.inp.user.speaking) return;
    let candidate: PendingTurn | null = s.queue[0] ?? null;
    let fromQueue = true;
    if (candidate === null) {
      fromQueue = false;
      // uptake を待つ間は用意済みの次のターン（訂正前の版かもしれない）を始めない。
      if (s.awaiting_uptake_until !== null) {
        if (this.now < s.awaiting_uptake_until) return;
        s.awaiting_uptake_until = null;
      }
      const contentOk = s.phase === 'discussion' && s.discussion_started_at !== null && !s.discussion_closing && (s.sub.kind === 'between_turns' || s.sub.kind === 'resuming');
      candidate = contentOk ? s.next : null;
    }
    if (candidate === null || candidate.state !== 'ready' || candidate.turn === null || candidate.audio_playback_id === null) return;
    // 音声の重なりの二重の確かめ（01 §3.7）。
    const desired = this.desiredStart(candidate);
    candidate.desired_start_at = desired;
    if (this.now < desired) return;
    if (fromQueue) s.queue.shift();
    else s.next = null;
    this.start(candidate, desired);
  }

  private start(p: PendingTurn, desired: number): void {
    const s = this.s;
    const v = p.turn as DiscussionTurnView;
    const id = p.audio_playback_id as number;
    this.act({ kind: 'start_turn', ai_id: v.speaker, turn_id: p.turn_id, audio_playback_id: id });
    s.floor = { ai_id: v.speaker, turn_id: p.turn_id, turn_kind: v.turn_kind, audio_playback_id: id, point_id: v.point_id, phase: 'starting', started_at: this.now, view: v, source: p.source, played_ms_hint: 0 };
    s.feed_wait = false;
    // 段（01 §3.10.1）。段の境界のイベントはそのターンの started より前に出す（封筒の discussion_stage と two_ai.stage の列を合わせる。AC15(d)）。
    if (s.phase === 'discussion' && v.discussion_stage !== null && v.discussion_stage !== s.discussion_stage) {
      if (s.discussion_stage !== null) this.stageEvent(s.discussion_stage, 'ended', null);
      s.discussion_stage = v.discussion_stage;
      s.stage_started_at = this.now;
      this.stageEvent(v.discussion_stage, 'started', p.turn_id);
      this.act({ kind: 'send_stage', current: v.discussion_stage, show: 'current' });
    }
    this.turnEvent('started', {
      turn_id: p.turn_id,
      turn_kind: v.turn_kind,
      speaker: v.speaker,
      view: v,
      audio_playback_id: id,
      gap_ms: s.last_turn_ended_at === null ? 0 : this.now - s.last_turn_ended_at,
      waited_for_ready_ms: Math.max(0, this.now - desired),
      reason: p.source,
    });
    // 割り込みの episode を閉じる（resume、bridge、uptake、用意済みの次のターン）。
    const track = s.interjection;
    if (track !== null && !track.logged_only && s.phase === 'discussion' && track.outcome !== null) {
      const resumed = p.source === 'resume' || p.source === 'next_turn' || p.source === 'fallback';
      if (!(p.source === 'uptake' && track.after_uptake === 'resume')) this.closeEpisode(track, track.outcome, resumed);
    }
    // 板（01 §3.10.2）。
    if (v.board_card_id !== null) {
      s.board.version += 1;
      s.board.shown_card_ids.push(v.board_card_id);
      this.act({ kind: 'send_board', reason: 'shown', trigger_turn_id: p.turn_id });
    }
    if (p.source === 'rebuild' && s.board.mode !== 'rebuilt') {
      s.board.mode = 'rebuilt';
      s.board.version += 1;
      this.act({ kind: 'send_board', reason: 'rebuilt', trigger_turn_id: p.turn_id });
    }
    // 点の開始。
    if (v.point_id !== null) {
      const pt = s.points[v.point_id];
      if (pt !== undefined) {
        if (pt.state === 'pending') {
          pt.state = 'in_progress';
          pt.started_at = this.now;
          this.pointEvent(pt, 'started', p.turn_id, p.source);
        } else if (v.turn_kind === 'point_elaboration') {
          this.pointEvent(pt, 'elaboration', p.turn_id, p.source);
        }
        if (v.turn_kind === 'point' || v.turn_kind === 'point_elaboration') pt.started_est_ms += v.est_duration_ms;
      }
    }
    // 視線（01 §3.8）。
    if (s.phase === 'discussion') {
      if (s.sub.kind === 'phase_open' || s.sub.kind === 'closing') {
        this.gaze(v.speaker, 'user', 'phase_line');
        this.gaze(OTHER[v.speaker], 'peer', 'phase_line');
      } else {
        this.gazeBoth('peer', 'discussion');
      }
      if (s.sub.kind === 'between_turns' || s.sub.kind === 'resuming') s.sub = { kind: 'ai_speaking' };
    }
  }
}

export function fixedTurnKind(line: FixedLineRef): TwoAiTurnKind {
  switch (line.kind) {
    case 'plan_filler':
      return 'filler';
    case 'intake_line':
      return 'facilitation';
    case 'retraction':
      return 'retraction';
    case 'hold_bridge':
      return 'bridge';
    default:
      return 'phase_line';
  }
}
