/**
 * 進行役の純粋関数を、偽の executor と偽の 02（台本の DiscussionContent の振る舞い）で回す試験の道具（01 §6.1）。
 * TTS、再生、TurnManager の受け止めの開始は、ここで決まった規則で模擬する（性能は表さない）。
 *
 * - 再生：start_turn の次の tick に started、est_duration_ms の後に ended(completed)。stop_turn から stop_after_ms で ended(stopped)。
 * - 02：discussion の台本を順に返す。fact_slip の点のブロックは abandonResume で残りを捨て、捨てた分の見込みを credited_ms で返す。
 *   applyCorrection は uptake を返し、F の残りを訂正後の版に替える（準備済みの F は cancelled_turn_ids）。
 * - TurnManager：offer_ack の音声は、本人が話していないときに started_ack として 1 回始まる。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TwoAiSessionConfig } from '@llm-vap/contracts';
import type { AiId, TwoAiCondition, TwoAiTurnKind } from '@llm-vap/contracts';
import type { CorrectionSuggestion, PendingPointView } from '../../../src/two_ai/content_port';
import { directorStep } from '../../../src/two_ai/director';
import type { DirectorAction, DirectorInit, FixedLineRef } from '../../../src/two_ai/director';
import { emptyInputs, initialDirectorState } from '../../../src/two_ai/director_state';
import type { DirectorInputs, DirectorState, DiscussionTurnView, PlaybackObservation, TurnArrival } from '../../../src/two_ai/director_state';

export const repoRoot = join(import.meta.dirname, '..', '..', '..', '..', '..');
export const TICK = 20;

/** 試験の値（WP4 の設定の値に依らないよう、効く値はここで固定する）。 */
export function testConfig(over: (c: Record<string, any>) => void = () => undefined): TwoAiSessionConfig {
  const c = JSON.parse(readFileSync(join(repoRoot, 'config', 'two_ai', 'session.ja.json'), 'utf8')) as Record<string, any>;
  c.self_run = true;
  c.phases.intake = { min_sec: 1, soft_sec: 2, max_sec: 10, plan_start_sec: 2 };
  c.phases.plan_wait = { filler_after_ms: 0, second_filler_after_ms: 12000, max_wait_ms: 25000, on_timeout: 'fallback_plan' };
  c.phases.discussion = { ...c.phases.discussion, target_sec: 540, close_at_sec: 480, max_sec: 600, points_overrun_max_sec: 60, avg_turn_sec_estimate: 9, chars_per_sec_estimate: 10 };
  c.phases.response = { duration_sec: 10, overrun_max_sec: 5, silence_prompt_sec: 4, max_silence_prompts: 2 };
  c.phases.next_step = { pick_max_sec: 10 };
  c.gaps_ms = { ...c.gaps_ms, default: { median: 500, min: 300, max: 900 }, resume_gap_ms: 300, max_wait_for_ready_ms: 1500, feed_turn_max_wait_ms: 4000 };
  c.interjection = { ...c.interjection, user_floor_max_ms: 60000, false_onset_window_ms: 1500, classify: { backchannel_max_voiced_ms: 700, backchannel_max_chars: 6 } };
  c.marker = { enabled: true, min_interval_ms: 1000, near_window_ms: 500 };
  c.correction = { assist: true, mode: 'researcher', decision_window_ms: 2500, hold_max_ms: 6000 };
  c.retraction.timing = 'after_measures';
  over(c);
  return TwoAiSessionConfig.parse(c);
}

export interface ScriptTurn {
  key: string;
  speaker: AiId;
  kind: TwoAiTurnKind;
  point_id: string | null;
  stage: 1 | 2 | 3 | 4;
  ms: number;
  gap: number;
  board_card_id?: string;
}

/** 4 段の台本。段 1 に F（fact_slip、3 ターン）、段 2 に K（control_inference）、段 3 に C（framing_C）。 */
export function defaultScript(): ScriptTurn[] {
  const t: ScriptTurn[] = [];
  const d = (key: string, speaker: AiId, stage: 1 | 2 | 3 | 4, ms = 3000, gap = 500): ScriptTurn => ({ key, speaker, kind: 'discussion', point_id: null, stage, ms, gap });
  const p = (key: string, speaker: AiId, point: string, kind: TwoAiTurnKind, stage: 1 | 2 | 3 | 4, ms = 4000): ScriptTurn => ({ key, speaker, kind, point_id: point, stage, ms, gap: 500 });
  t.push(d('d1', 'A', 1), d('d2', 'B', 1));
  t.push(p('F.0', 'A', 'f1', 'point', 1), p('F.1', 'B', 'f1', 'point_elaboration', 1), p('F.2', 'A', 'f1', 'point_elaboration', 1));
  t.push({ ...d('d3', 'B', 1), board_card_id: 'card_1' });
  t.push(d('d4', 'A', 2), p('K.0', 'B', 'k1', 'point', 2), p('K.1', 'A', 'k1', 'point_elaboration', 2), d('d5', 'B', 2));
  t.push(d('d6', 'A', 3), p('C.0', 'B', 'c1', 'point', 3), p('C.1', 'A', 'c1', 'point_elaboration', 3), p('C.2', 'B', 'c1', 'point_elaboration', 3));
  t.push(d('d7', 'A', 4), d('d8', 'B', 4));
  return t;
}

const POINT_KIND: Record<string, 'fact_slip' | 'control_inference' | 'framing_C'> = { f1: 'fact_slip', k1: 'control_inference', c1: 'framing_C' };

interface Playing {
  ai: AiId;
  audio: number;
  turn_id: string;
  view: DiscussionTurnView;
  started_at: number;
  ends_at: number;
  stopped_at: number | null;
}

export class Sim {
  state: DirectorState;
  now = 1000;
  readonly actions: DirectorAction[] = [];
  readonly log: { now: number; actions: DirectorAction[] }[] = [];
  private nextAudio = 1;
  private readonly pendingArrivals: TurnArrival[] = [];
  private readonly pendingFailures: { turn_id: string; reason: string }[] = [];
  private readonly pendingCredits: { interjection_id: string; credited_ms: number }[] = [];
  private readonly pendingCancelled: string[] = [];
  private readonly pendingEvents: PlaybackObservation[] = [];
  private playing: Playing | null = null;
  private ackOffer: { audio: number; ai: AiId } | null = null;
  private ackStartedThisTick: number | null = null;
  private cursor = 0;
  /** 進行役に渡した 02 のターン（turn_id → 台本）。 */
  readonly delivered = new Map<string, ScriptTurn>();
  readonly played: { turn_id: string; key: string; kind: TwoAiTurnKind; speaker: AiId; ms: number; reason: string; started_at: number }[] = [];
  readonly pointDone = new Set<string>();
  readonly abandonedPoints = new Set<string>();
  corrected = false;
  user = { speaking: false, voiced_ms: 0 };
  utterance: DirectorInputs['user_utterance'] = null;
  suggestions: CorrectionSuggestion[] = [];
  woz: DirectorInputs['woz'] = [];
  markers: DirectorInputs['markers'] = [];
  board_picks: DirectorInputs['board_picks'] = [];
  planState: DirectorInputs['plan']['state'] = 'ready';
  contentDone = { intake: true, discussion: false };
  readbackDue = false;
  stopAfterMs = 200;
  /** 遅らせる文（turn の key → 届くまでの tick 数）。 */
  arrivalDelayTicks = 1;
  /** request_next_turn に答えない（文が届かない状況）。 */
  withholdNext = false;
  onsetNext: { first_voiced_at?: number } | null = null;

  constructor(
    readonly config: TwoAiSessionConfig,
    readonly init: DirectorInit,
    readonly script: ScriptTurn[] = defaultScript(),
  ) {
    this.state = initialDirectorState(init, this.now);
  }

  static create(condition: TwoAiCondition, opts: { config?: TwoAiSessionConfig; correction_mode?: 'researcher' | 'auto'; script?: ScriptTurn[]; feeds?: boolean } = {}): Sim {
    const config = opts.config ?? testConfig();
    return new Sim(config, { condition, correction_mode: opts.correction_mode ?? 'researcher', feeds_generation: opts.feeds ?? false, stop_max_wait_ms: 200 }, opts.script);
  }

  private points(): PendingPointView[] {
    const ids = [...new Set(this.script.filter((t) => t.point_id !== null).map((t) => t.point_id as string))];
    return ids.map((id) => {
      const turns = this.script.filter((t) => t.point_id === id);
      return {
        point_id: id,
        kind: POINT_KIND[id] ?? 'framing_C',
        speaker: turns[0]!.speaker,
        discussion_stage: turns[0]!.stage,
        state: this.pointDone.has(id) ? 'done' : 'queued',
        expected_start_ms: null,
        expected_block_ms: turns.reduce((a, t) => a + t.ms, 0),
      };
    });
  }

  private view(turn_id: string, t: { speaker: AiId; kind: TwoAiTurnKind; point_id: string | null; stage: number | null; ms: number; gap: number; board_card_id?: string; variant?: 'original' | 'corrected' | null; repeat?: { bridge_chars: number; restated_chars: number } | null }): DiscussionTurnView {
    return {
      turn_id,
      speaker: t.speaker,
      turn_kind: t.kind,
      point_id: t.point_id,
      point_variant: t.point_id === null ? null : (t.variant ?? (this.corrected ? 'corrected' : 'original')),
      discussion_stage: t.stage,
      gap_hint_ms: t.gap,
      est_duration_ms: t.ms,
      text_origin: 'frozen',
      repeat: t.repeat ?? null,
      feed_turn: false,
      fed_interjection_ids: [],
      chars: Math.round(t.ms / 100),
      board_card_id: t.board_card_id ?? null,
    };
  }

  private arrive(view: DiscussionTurnView, source: TurnArrival['source'], cached?: TurnArrival['cached']): void {
    this.pendingArrivals.push({ turn: view, audio_playback_id: this.nextAudio++, source, ...(cached ? { cached } : {}) });
  }

  private fixedView(turn_id: string, line: FixedLineRef): DiscussionTurnView {
    const kind: TwoAiTurnKind =
      line.kind === 'hold_bridge' ? 'bridge' : line.kind === 'plan_filler' ? 'filler' : line.kind === 'retraction' ? 'retraction' : line.kind === 'intake_line' ? 'facilitation' : 'phase_line';
    const speaker: AiId = line.kind === 'hold_bridge' ? line.ai_id : line.kind === 'plan_filler' ? (line.index === 0 ? 'A' : 'B') : 'A';
    return this.view(turn_id, { speaker, kind, point_id: null, stage: null, ms: 1500, gap: 0 });
  }

  /** 次の点の外の台本（訂正の後の F は corrected、捨てた F は飛ばす）。 */
  private takeNext(): ScriptTurn | null {
    while (this.cursor < this.script.length) {
      const t = this.script[this.cursor++]!;
      if (t.point_id !== null && this.abandonedPoints.has(t.point_id)) continue;
      return t;
    }
    return null;
  }

  private execute(a: DirectorAction): void {
    switch (a.kind) {
      case 'request_next_turn': {
        if (this.withholdNext) return;
        const t = this.takeNext();
        if (t === null) {
          this.contentDone.discussion = true;
          this.pendingFailures.push({ turn_id: a.turn_id, reason: 'script_done' });
          return;
        }
        this.delivered.set(a.turn_id, t);
        this.arrive(this.view(a.turn_id, { ...t, stage: t.stage }), 'next_turn');
        return;
      }
      case 'substitute_fallback':
        this.arrive(this.view(a.turn_id, { speaker: 'A', kind: 'discussion', point_id: null, stage: this.state.discussion_stage, ms: 2000, gap: 500 }), 'fallback');
        return;
      case 'request_fixed': {
        if (a.line.kind === 'retraction' && a.line.index >= 2) {
          this.pendingFailures.push({ turn_id: a.turn_id, reason: 'no_line' });
          return;
        }
        const view = this.fixedView(a.turn_id, a.line);
        this.arrive(view, a.line.kind === 'closing_question' ? 'cached_question' : 'fixed');
        return;
      }
      case 'request_resume': {
        const ctx = a.resume;
        const orig = ctx !== null ? this.delivered.get(ctx.interrupted_turn_id) : undefined;
        if (orig === undefined) {
          this.pendingFailures.push({ turn_id: a.turn_id, reason: 'no_resume' });
          return;
        }
        const bridge = a.mode === 'false_onset' ? 0 : 6;
        // 文の頭から言い直す：言い直した部分は止まるまでに声に出た長さ（1 文字 100ms の模擬）。
        const spoken = this.played.find((x) => x.turn_id === ctx!.interrupted_turn_id)?.ms ?? 0;
        const restated = Math.round(spoken / 100);
        const view = this.view(a.turn_id, { speaker: orig.speaker, kind: 'resume', point_id: orig.point_id, stage: orig.stage, ms: orig.ms + bridge * 100, gap: 0, repeat: { bridge_chars: bridge, restated_chars: restated } });
        this.delivered.set(a.turn_id, { ...orig, kind: 'resume' });
        this.arrive(view, 'resume');
        return;
      }
      case 'apply_correction': {
        this.corrected = true;
        const uptakeId = `up_${a.point_id}`;
        this.arrive(this.view(uptakeId, { speaker: 'A', kind: 'uptake', point_id: null, stage: this.state.discussion_stage, ms: 2000, gap: 0 }), 'uptake');
        // 準備済みの F（元の版）は替える。
        const next = this.state.next;
        if (next !== null && next.turn?.point_id === a.point_id) this.pendingCancelled.push(next.turn_id);
        if (next !== null && next.turn?.point_id === a.point_id) this.cursor = Math.max(0, this.cursor - 1);
        return;
      }
      case 'abandon_resume': {
        // 02：F の未再生のターンを捨て、見込みを credited_ms で返す。
        const slip = this.script.filter((t) => t.point_id === 'f1');
        const playedKeys = new Set(this.played.map((p) => p.key));
        const interrupted = a.interrupted_turn_id !== null ? this.delivered.get(a.interrupted_turn_id)?.key : undefined;
        const discarded = slip.filter((t) => !playedKeys.has(t.key) && t.key !== interrupted);
        this.abandonedPoints.add('f1');
        this.pointDone.add('f1');
        this.pendingCredits.push({ interjection_id: a.interjection_id, credited_ms: discarded.reduce((s, t) => s + t.ms, 0) });
        return;
      }
      case 'cancel_turn': {
        const t = this.delivered.get(a.turn_id);
        if (t !== undefined && t.point_id !== null && this.abandonedPoints.has(t.point_id)) return;
        if (t !== undefined && a.reason !== 'not_arrived_in_time') {
          // 取り消した生のターンは台本に戻す（次の nextTurn で同じ文が来る）。
          this.cursor = Math.min(this.cursor, this.script.indexOf(t));
        }
        return;
      }
      case 'start_turn': {
        const arrival = this.lastArrival.get(a.audio_playback_id);
        if (arrival === undefined) throw new Error(`start of unknown audio ${a.audio_playback_id}`);
        if (this.playing !== null) throw new Error('double speech');
        this.playing = { ai: a.ai_id, audio: a.audio_playback_id, turn_id: a.turn_id, view: arrival, started_at: this.now, ends_at: this.now + TICK + arrival.est_duration_ms, stopped_at: null };
        return;
      }
      case 'stop_turn':
        if (this.playing !== null && this.playing.audio === a.audio_playback_id && this.playing.stopped_at === null) this.playing.stopped_at = this.now + this.stopAfterMs;
        return;
      case 'offer_ack':
        this.ackOffer = { audio: this.nextAudio, ai: a.ai_id };
        this.arrive(this.view(`ack_offer_${this.nextAudio}`, { speaker: a.ai_id, kind: 'ack', point_id: null, stage: null, ms: 1200, gap: 0 }), 'cached_ack', { template_id: 'ack_1', synthesized_ms: 1200 });
        return;
      case 'withdraw_ack':
        this.ackOffer = null;
        return;
      case 'request_rebuild':
        for (let i = 0; i < 2; i++) this.arrive(this.view(`rb${i}`, { speaker: i === 0 ? 'A' : 'B', kind: 'rebuild', point_id: null, stage: null, ms: 2000, gap: 0 }), 'rebuild');
        return;
      default:
        return;
    }
  }

  private readonly lastArrival = new Map<number, DiscussionTurnView>();

  /** 1 tick 進める。 */
  tick(): DirectorAction[] {
    this.now += TICK;
    const inputs = emptyInputs();
    // 再生の模擬。
    const p = this.playing;
    if (p !== null) {
      if (this.now - p.started_at === TICK) this.pendingEvents.push({ kind: 'started', audio_playback_id: p.audio, at: this.now });
      const endAt = p.stopped_at !== null ? Math.min(p.stopped_at, p.ends_at) : p.ends_at;
      if (this.now >= endAt) {
        const played = Math.max(0, Math.min(p.view.est_duration_ms, endAt - p.started_at - TICK));
        const repeat = p.view.repeat;
        const bridge_ms = repeat ? repeat.bridge_chars * 100 : 0;
        const repeated_ms = repeat ? repeat.restated_chars * 100 : 0;
        const new_ms = Math.max(0, played - bridge_ms - repeated_ms);
        const reason = p.stopped_at !== null && p.stopped_at < p.ends_at ? 'stopped' : 'completed';
        const content_ms = ['discussion', 'point', 'point_elaboration'].includes(p.view.turn_kind) ? played : p.view.turn_kind === 'resume' ? new_ms : 0;
        this.pendingEvents.push({ kind: 'ended', audio_playback_id: p.audio, at: this.now, samples_written: played * 16, played_ms: played, new_ms, bridge_ms, repeated_ms, repeated_source: repeat ? 'char_ratio' : 'none', content_ms, spoken_text_chars: 0, reason });
        const key = this.delivered.get(p.turn_id)?.key ?? p.turn_id;
        this.played.push({ turn_id: p.turn_id, key, kind: p.view.turn_kind, speaker: p.ai, ms: played, reason, started_at: p.started_at });
        // 点のブロックの最後のターンを話し終えたら done。
        const st = this.delivered.get(p.turn_id);
        if (st !== undefined && st.point_id !== null && reason === 'completed') {
          const block = this.script.filter((t) => t.point_id === st.point_id);
          if (block[block.length - 1]!.key === st.key) this.pointDone.add(st.point_id);
        }
        this.playing = null;
      }
    }
    // TurnManager の受け止めの開始の模擬：本人が話していなければ、用意した音声を始める。
    this.ackStartedThisTick = null;
    if (this.ackOffer !== null && this.state.ack_offer !== null && this.state.ack_offer.audio_playback_id === this.ackOffer.audio && !this.user.speaking && this.playing === null) {
      this.ackStartedThisTick = this.ackOffer.audio;
      const view = this.lastArrival.get(this.ackOffer.audio)!;
      this.playing = { ai: this.ackOffer.ai, audio: this.ackOffer.audio, turn_id: `ack_${this.ackOffer.audio}`, view, started_at: this.now, ends_at: this.now + TICK + view.est_duration_ms, stopped_at: null };
      this.ackOffer = null;
    }
    for (const a of this.pendingArrivals.splice(0)) {
      this.lastArrival.set(a.audio_playback_id, a.turn);
      inputs.turn_arrivals.push(a);
      inputs.slots[a.turn.speaker].ready.push({ turn_id: a.turn.turn_id, audio_playback_id: a.audio_playback_id });
    }
    inputs.turn_failures = this.pendingFailures.splice(0);
    inputs.content_credits = this.pendingCredits.splice(0);
    inputs.cancelled_turn_ids = this.pendingCancelled.splice(0);
    inputs.playback_events = this.pendingEvents.splice(0);
    // 準備済みのものは毎 tick ready に出す。
    for (const q of [this.state.next, ...this.state.queue]) {
      if (q !== null && q.audio_playback_id !== null && q.turn !== null) inputs.slots[q.turn.speaker].ready.push({ turn_id: q.turn_id, audio_playback_id: q.audio_playback_id });
    }
    inputs.plan = { state: this.planState, can_start_early: true, plan_id: 'plan_1', source: 'prepared' };
    inputs.points = this.points();
    inputs.content_done = { ...this.contentDone };
    inputs.intake_readback_due = this.readbackDue;
    inputs.correction_suggestions = this.suggestions.map((s) => ({ ...s }));
    inputs.woz = this.woz.splice(0);
    inputs.markers = this.markers.splice(0);
    inputs.board_picks = this.board_picks.splice(0);
    if (this.user.speaking) this.user.voiced_ms += TICK;
    inputs.user = { speaking: this.user.speaking, permitted_to_speak: false, started_ack: this.ackStartedThisTick, voiced_ms_since_onset: this.user.voiced_ms, last_voice_at: this.user.speaking ? this.now : null };
    inputs.user_utterance = this.utterance;
    this.utterance = null;
    if (this.onsetNext !== null) {
      inputs.interjection = { kind: 'onset', source: 'vap', first_voiced_at: this.onsetNext.first_voiced_at ?? this.now - 200, detected_at: this.now, p_now_user: 0.8, p_future_user: 0.8, vad_user: 0.9, mic_dbfs: -20 };
      this.onsetNext = null;
    } else {
      inputs.interjection = { kind: 'none', voiced: this.user.speaking };
    }
    const result = directorStep(this.config, this.init, this.state, inputs, this.now);
    this.state = result.state;
    this.actions.push(...result.actions);
    this.log.push({ now: this.now, actions: result.actions });
    for (const a of result.actions) this.execute(a);
    return result.actions;
  }

  run(ms: number): void {
    const end = this.now + ms;
    while (this.now < end) this.tick();
  }

  runUntil(pred: (sim: Sim) => boolean, maxMs = 600_000): void {
    const end = this.now + maxMs;
    while (!pred(this)) {
      if (this.now >= end) throw new Error(`condition not reached within ${maxMs}ms (phase=${this.state.phase}, sub=${this.state.sub.kind})`);
      this.tick();
    }
  }

  /** 本人が話し始めて（onset）、ms だけ話す。 */
  interject(): void {
    this.user = { speaking: true, voiced_ms: 0 };
    this.onsetNext = {};
  }

  stopTalking(): void {
    this.user.speaking = false;
  }

  /** 発話中の台本の key。 */
  playingKey(): string | null {
    if (this.playing === null) return null;
    return this.delivered.get(this.playing.turn_id)?.key ?? null;
  }

  emitted<E extends string>(event: E): Extract<Extract<DirectorAction, { kind: 'emit' }>['draft'], { event: E }>[] {
    return this.actions.filter((a): a is Extract<DirectorAction, { kind: 'emit' }> => a.kind === 'emit' && a.draft.event === event).map((a) => a.draft) as never;
  }

  of<K extends DirectorAction['kind']>(kind: K): Extract<DirectorAction, { kind: K }>[] {
    return this.actions.filter((a): a is Extract<DirectorAction, { kind: K }> => a.kind === kind);
  }

  /** discussion を始めた状態にする（intake を最短で抜け、始めの台詞を話す）。 */
  toDiscussion(): void {
    this.runUntil((s) => s.state.phase === 'discussion' && s.state.discussion_started_at !== null);
  }
}
