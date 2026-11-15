/**
 * 2 体のモードの合成のセッションログ（04 T1 の「手で作った小さな JSONL」の元。WP4）。
 *
 * - 内容はすべて架空（デモの台本 demo_career.ja.json と短い設定の文から作る）。sessions/ の実会話は使わない。
 * - 偽の TTS と同じく、発話の長さは文字数 ÷ 7 文字毎秒で決める。
 * - log_check の 2 体の規則（apps/orchestrator/test/logging/log_check_two_ai.test.ts）と要約（tools/two_ai_report/test）の
 *   試験が同じ物を使う。WP1 の TwoAiSession がまだないので、ここで 06 §4 の形のとおりにイベントを組み立てる。
 *   統合の後は、試走（tools/two_ai_dryrun）の出力が同じ検査を通ることを確かめる（05 §7 の 6）。
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TwoAiScript,
  TwoAiSessionConfig,
  type AiId,
  type TwoAiCondition,
  type TwoAiPhase,
  type TwoAiTurnKind,
  type TwoAiTextOrigin,
  type ScriptVariant,
} from '@llm-vap/contracts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');

export const CHARS_PER_SEC = 7;
export const SAMPLES_PER_MS = 16;
const WALL_BASE = Date.parse('2026-11-20T01:00:00.000Z');

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function speechMs(text: string): number {
  return Math.round(([...text].length * 1000) / CHARS_PER_SEC);
}

export function loadDemoScript(): TwoAiScript {
  return TwoAiScript.parse(JSON.parse(readFileSync(join(repoRoot, 'config/two_ai/scripts/demo_career.ja.json'), 'utf8')));
}

export function loadConfig(name: 'session.ja' | 'session.demo_short.ja' | 'session.self_run.ja'): TwoAiSessionConfig {
  return TwoAiSessionConfig.parse(JSON.parse(readFileSync(join(repoRoot, `config/two_ai/${name}.json`), 'utf8')));
}

type Raw = Record<string, unknown> & { event: string; t_monotonic_ms: number };

const present = <T>(value: T) => ({ value });
const absent = (null_reason: string) => ({ value: null, null_reason });
const ORCH = { source: 'orchestrator', uncertainty_ms: { value: 0 } } as const;
const BROWSER = { source: 'browser_rtt', uncertainty_ms: { value: 3 } } as const;

interface EmitOpts {
  at?: number;
  ai_id?: AiId | null;
  point_id?: string | null;
  basis?: typeof ORCH | typeof BROWSER;
}

export interface TurnSpec {
  speaker: AiId;
  kind: TwoAiTurnKind;
  text: string;
  origin?: TwoAiTextOrigin;
  point_id?: string | null;
  point_variant?: ScriptVariant | null;
  gap?: number;
  card?: { card_id: string; order: number; stage: number; variant: ScriptVariant; depends_on: string; text: string };
  /** この長さで止める（① の割り込みか WoZ）。 */
  cut?: { after_ms: number; source: 'vap' | 'fallback' | 'woz' };
  /** resume の戻りの句と言い直しの長さ（point_exposure の new_ms の計算）。 */
  bridge_ms?: number;
  repeated_ms?: number;
  feed_turn?: boolean;
  /** ② の発話：記録だけ。 */
  userDuring?: { after_ms: number; text: string; dur_ms: number };
  segmentCut?: 'none' | 'interjection' | 'woz' | 'session_end' | 'correction';
}

export interface TurnResult {
  turn_id: string;
  pb: number;
  started_at: number;
  ended_at: number;
  played_ms: number;
  full_ms: number;
  interjection_id: string | null;
  user_seg: number | null;
}

const CONTENT_KINDS = new Set<TwoAiTurnKind>(['discussion', 'point', 'point_elaboration']);

/** イベントを時刻つきで集め、最後に時刻の順に並べる。 */
export class TwoAiLogBuilder {
  t = 1000;
  phase: TwoAiPhase = 'intake';
  stage: number | null = null;
  variant: ScriptVariant = 'original';
  contentMs = 0;
  discussionStartedAt = 0;
  private events: Raw[] = [];
  private seq = 0;
  private turnIndex = 0;
  private pb = 100;
  private asr = 0;
  private ij = 0;
  private mk = 0;
  private syncSeq = 0;
  private boardVersion = 0;
  readonly board: Record<string, unknown>[] = [];
  readonly segments = new Map<string, Record<string, unknown>[]>();
  readonly pointTurns = new Map<string, number>();

  constructor(readonly session_id: string, readonly condition: TwoAiCondition) {}

  emit(event: string, payload: Record<string, unknown>, opts: EmitOpts = {}): Raw {
    const at = opts.at ?? this.t;
    const raw: Raw = {
      schema_version: 1,
      t_monotonic_ms: at,
      wall_clock: new Date(WALL_BASE + Math.round(at)).toISOString(),
      session_id: this.session_id,
      condition: this.condition,
      time_basis: opts.basis ?? ORCH,
      two_ai: {
        phase: this.phase,
        discussion_stage: this.phase === 'discussion' ? this.stage : null,
        ai_id: opts.ai_id ?? null,
        point_id: opts.point_id ?? null,
        script_variant: this.variant,
      },
      event,
      ...payload,
    };
    (raw as { _seq?: number })._seq = this.seq++;
    this.events.push(raw);
    return raw;
  }

  build(): Record<string, unknown>[] {
    return [...this.events]
      .sort((a, b) => a.t_monotonic_ms - b.t_monotonic_ms || (a._seq as number) - (b._seq as number))
      .map(({ _seq: _drop, ...rest }) => rest);
  }

  advance(ms: number): void {
    this.t += ms;
  }

  syncMark(trigger: string): void {
    this.syncSeq += 1;
    this.emit('two_ai.sync_mark', { seq: this.syncSeq, trigger, t_wall_ms: WALL_BASE + Math.round(this.t) });
  }

  setPhase(to: TwoAiPhase, source: 'session_start' | 'auto_timer' | 'auto_content' | 'woz', reason: string, planned_ms: number | null): void {
    const from = this.events.length === 0 ? null : this.phase;
    if (to !== 'discussion' && this.phase === 'discussion' && this.stage !== null) this.endStage();
    this.phase = to;
    this.stage = null;
    if (to === 'discussion') this.discussionStartedAt = this.t;
    this.emit('two_ai.phase_changed', {
      from,
      to,
      source,
      reason,
      elapsed_in_from_ms: from === null ? absent('session_start') : present(1000),
      planned_duration_ms: planned_ms === null ? absent('no_limit') : present(planned_ms),
    });
    if (to !== 'discussion') this.syncMark(to);
  }

  startStage(n: number, heading: string, first_turn_id: string, at: number): void {
    if (this.stage !== null) this.endStage(at);
    this.stage = n;
    this.emit('two_ai.stage', {
      discussion_stage: n,
      edge: 'started',
      heading,
      turn_id: first_turn_id,
      content_elapsed_ms: Math.round(this.contentMs),
      discussion_elapsed_ms: Math.round(at - this.discussionStartedAt),
    }, { at });
    this.syncSeq += 1;
    this.emit('two_ai.sync_mark', { seq: this.syncSeq, trigger: `stage_${n}`, t_wall_ms: WALL_BASE + Math.round(at) }, { at });
  }

  private headings = new Map<number, string>();
  setHeadings(h: readonly string[]): void {
    h.forEach((x, i) => this.headings.set(i + 1, x));
  }

  endStage(at = this.t, ended_by: 'next_stage' | 'content_done' = 'next_stage'): void {
    if (this.stage === null) return;
    const stage = this.stage;
    const cards = this.board.filter((c) => c.discussion_stage === stage).map((c) => c.card_id);
    this.emit('two_ai.stage', {
      discussion_stage: stage,
      edge: 'ended',
      heading: this.headings.get(stage) ?? `段 ${stage}`,
      turn_id: null,
      content_elapsed_ms: Math.round(this.contentMs),
      discussion_elapsed_ms: Math.round(at - this.discussionStartedAt),
      // 合成のログ：点の内訳は持たないので空、カードは出したものを計画とする（報告の列の確認用）。
      completion: { complete: true, ended_by, content_turns: 0, points_planned: [], points_completed: [], cards_planned: cards, cards_shown: cards, participation_ms: 0 },
    }, { at });
    this.stage = null;
  }

  nextTurnId(): string {
    return `t_${String(this.turnIndex + 1).padStart(4, '0')}`;
  }

  /** 1 ターン。requested → prepared → started → (speech) → ended。 */
  turn(spec: TurnSpec, beforeStart?: (turn_id: string, startAt: number) => void): TurnResult {
    this.turnIndex += 1;
    const turn_id = `t_${String(this.turnIndex).padStart(4, '0')}`;
    const pb = ++this.pb;
    const point_id = spec.point_id ?? null;
    const gap = spec.gap ?? (CONTENT_KINDS.has(spec.kind) ? 600 : 300);
    const origin = spec.origin ?? (spec.kind === 'discussion' ? 'llm' : spec.kind === 'point' || spec.kind === 'point_elaboration' || spec.kind === 'rebuild' || spec.kind === 'uptake' ? 'frozen' : spec.kind === 'ack' || spec.kind === 'bridge' ? 'cached' : 'fixed');
    const base = {
      turn_id,
      turn_index: this.turnIndex,
      turn_kind: spec.kind,
      point_id,
      gap_hint_ms: present(gap),
      discussion_stage: this.phase === 'discussion' ? this.stage : null,
      point_variant: spec.point_variant ?? null,
      board_card_id: spec.card?.card_id ?? null,
      feed_turn: spec.feed_turn ?? false,
    };
    const tOpts = { ai_id: spec.speaker, point_id };
    this.emit('two_ai.turn', { ...base, stage: 'requested', speaker: null, audio_playback_id: absent('not_prepared'), text_origin: null, gap_ms: absent('not_started'), waited_for_ready_ms: absent('not_started'), played_ms: absent('not_ended'), content_ms: absent('not_ended'), interrupted: false, reason: 'request_next_turn' }, { point_id });
    this.emit('two_ai.turn', { ...base, stage: 'prepared', speaker: spec.speaker, audio_playback_id: present(pb), text_origin: origin, gap_ms: absent('not_started'), waited_for_ready_ms: absent('not_started'), played_ms: absent('not_ended'), content_ms: absent('not_ended'), interrupted: false, reason: 'tts_ready' }, tOpts);
    const startAt = this.t + gap;
    beforeStart?.(turn_id, startAt);
    if (CONTENT_KINDS.has(spec.kind)) this.contentMs += gap;
    base.discussion_stage = this.phase === 'discussion' ? this.stage : null;
    this.emit('two_ai.turn', { ...base, stage: 'started', speaker: spec.speaker, audio_playback_id: present(pb), text_origin: origin, gap_ms: present(gap), waited_for_ready_ms: present(0), played_ms: absent('not_ended'), content_ms: absent('not_ended'), interrupted: false, reason: 'gap_elapsed' }, { ...tOpts, at: startAt });
    if (spec.kind === 'point') {
      this.emit('two_ai.point', this.pointPayload(point_id!, spec.speaker, 'started', turn_id, 0, 'trigger_reached'), { ...tOpts, at: startAt });
    } else if (spec.kind === 'point_elaboration') {
      const n = (this.pointTurns.get(point_id!) ?? 0) + 1;
      this.pointTurns.set(point_id!, n);
      this.emit('two_ai.point', this.pointPayload(point_id!, spec.speaker, 'elaboration', turn_id, n, 'elaboration'), { ...tOpts, at: startAt });
    }
    const speechOrigin = { origin: 'two_ai_turn', ai_id: spec.speaker, turn_id, turn_kind: spec.kind, point_id };
    const common = { audio_playback_id: pb, audio_frame: Math.round(startAt * 16), started_at: startAt, first_pcm_written_at: startAt - 20, output_latency_ms: present(20) };
    this.emit('speech.started', { ...common, ...speechOrigin }, { ...tOpts, at: startAt, basis: BROWSER });
    if (spec.card) {
      this.board.push({ card_id: spec.card.card_id, order: spec.card.order, discussion_stage: spec.card.stage, variant: spec.card.variant, depends_on: spec.card.depends_on, text: spec.card.text, trigger_turn_ended: false });
      this.boardVersion += 1;
      this.emit('two_ai.board', { board_version: this.boardVersion, mode: 'building', cards: this.board.map((c) => ({ ...c })), trigger_turn_id: turn_id, reason: 'shown', picked_card_id: null }, { at: startAt });
    }
    const full = speechMs(spec.text);
    let interjection_id: string | null = null;
    let user_seg: number | null = null;
    let played = full;
    if (spec.cut) {
      played = spec.cut.after_ms;
      if (spec.cut.source !== 'woz') {
        interjection_id = this.onset(spec.speaker, point_id, pb, startAt + played - 250, 'stop');
      }
    }
    if (spec.userDuring) {
      const at = startAt + spec.userDuring.after_ms;
      const id = this.onset(spec.speaker, point_id, pb, at, 'ignore');
      const sttAt = at + spec.userDuring.dur_ms + 400;
      const seg = this.sttFinal(spec.userDuring.text, at, sttAt);
      user_seg = seg;
      this.episode({
        interjection_id: id,
        outcome: 'logged_only',
        decision_source: 'vap',
        interrupted_ai: null,
        during_point_id: point_id,
        onset_at: at,
        user_voice_start_at: at - 100,
        stop_requested_at: null,
        stopped_at: null,
        user_speech_end_at: at + spec.userDuring.dur_ms,
        ack: null,
        correction_hold: null,
        resumed_at: null,
        asr_segment_ids: [seg],
        at: sttAt,
        voiced_ms: spec.userDuring.dur_ms,
      });
    }
    const endAt = startAt + played;
    const chars = [...spec.text];
    const spoken = spec.cut ? chars.slice(0, Math.max(1, Math.round((chars.length * played) / full))).join('') : spec.text;
    const finish = { ...common, spoken_text: spoken, spoken_text_precision: 'alignment_char', samples_written: Math.round(played * SAMPLES_PER_MS) };
    if (spec.cut) {
      this.emit('speech.interrupted', { ...finish, ...speechOrigin, interrupted_at: endAt, stop_point: 'word_boundary', decision_source: spec.cut.source }, { ...tOpts, at: endAt, basis: BROWSER });
      if (interjection_id !== null) {
        this.emit('two_ai.interjection', this.ijPayload(interjection_id, 'stopped', spec.speaker, point_id, pb, null), { at: endAt });
      }
    } else {
      this.emit('speech.ended', { ...finish, ...speechOrigin, ended_at: endAt }, { ...tOpts, at: endAt, basis: BROWSER });
    }
    const contentMs = CONTENT_KINDS.has(spec.kind) ? played : 0;
    this.contentMs += contentMs;
    this.emit('two_ai.turn', { ...base, stage: 'ended', speaker: spec.speaker, audio_playback_id: present(pb), text_origin: origin, gap_ms: absent('ended_stage'), waited_for_ready_ms: absent('ended_stage'), played_ms: present(played), content_ms: present(contentMs), interrupted: spec.cut !== undefined, reason: spec.cut ? 'interrupted' : 'completed' }, { ...tOpts, at: endAt });
    if (spec.card) {
      const card = this.board.find((c) => c.card_id === spec.card!.card_id)!;
      card.trigger_turn_ended = true;
      this.boardVersion += 1;
      this.emit('two_ai.board', { board_version: this.boardVersion, mode: 'building', cards: this.board.map((c) => ({ ...c })), trigger_turn_id: turn_id, reason: 'revealed', picked_card_id: null }, { at: endAt });
    }
    if (point_id !== null && spec.kind !== 'ack' && spec.kind !== 'uptake' && spec.kind !== 'bridge') {
      const list = this.segments.get(point_id) ?? [];
      const bridge = spec.bridge_ms ?? 0;
      const repeated = spec.repeated_ms ?? 0;
      list.push({
        audio_playback_id: pb,
        turn_id,
        turn_kind: spec.kind,
        played_ms: played,
        new_ms: Math.max(0, played - bridge - repeated),
        cut: spec.cut ? (spec.segmentCut ?? 'interjection') : 'none',
        variant: spec.point_variant ?? this.variant,
        _bridge: bridge,
        _repeated: repeated,
      });
      this.segments.set(point_id, list);
    }
    this.t = endAt;
    return { turn_id, pb, started_at: startAt, ended_at: endAt, played_ms: played, full_ms: full, interjection_id, user_seg };
  }

  private pointKinds = new Map<string, { kind: string; trigger: unknown; stage: number | null }>();
  registerPoint(id: string, kind: string, trigger: unknown, stage: number | null): void {
    this.pointKinds.set(id, { kind, trigger, stage });
  }

  private pointPayload(point_id: string, speaker: AiId, stage: string, turn_id: string | null, elaborated: number, reason: string): Record<string, unknown> {
    const p = this.pointKinds.get(point_id)!;
    return {
      point_id,
      point_kind: p.kind,
      speaker,
      stage,
      turn_id,
      trigger: p.trigger,
      discussion_stage: p.stage,
      planned_at: absent('in_stage_trigger'),
      content_elapsed_ms: stage === 'started' ? present(Math.round(this.contentMs)) : absent('not_started_stage'),
      deviation_ms: absent('in_stage_trigger'),
      exposure_new_ms: absent('not_measured'),
      exposure_total_ms: absent('not_measured'),
      elaborated_turns: elaborated,
      reason,
    };
  }

  unavailablePoint(point_id: string, speaker: AiId, reason: string): void {
    this.emit('two_ai.point', this.pointPayload(point_id, speaker, 'unavailable', null, 0, reason));
  }

  closePoint(point_id: string, speaker: AiId, opts: { planned_exposure_ms: number; elaborations_planned: number; cut_by_correction?: boolean; complete?: boolean }): { total: number; new_ms: number } {
    const p = this.pointKinds.get(point_id)!;
    const segs = this.segments.get(point_id) ?? [];
    const total = segs.reduce((s, x) => s + (x.played_ms as number), 0);
    const bridge = segs.reduce((s, x) => s + (x._bridge as number), 0);
    const repeated = segs.reduce((s, x) => s + (x._repeated as number), 0);
    const new_ms = total - bridge - repeated;
    const done = this.pointTurns.get(point_id) ?? 0;
    this.emit('two_ai.point', { ...this.pointPayload(point_id, speaker, 'completed', null, done, 'block_done'), exposure_new_ms: present(new_ms), exposure_total_ms: present(total) });
    this.emit('two_ai.point_exposure', {
      point_id,
      point_kind: p.kind,
      speaker,
      exposure_total_ms: total,
      exposure_new_ms: new_ms,
      bridge_ms: bridge,
      repeated_ms: repeated,
      repeated_ms_source: repeated > 0 ? 'char_ratio' : 'none',
      planned_exposure_ms: present(opts.planned_exposure_ms),
      segments: segs.map(({ _bridge: _b, _repeated: _r, ...s }) => s),
      elaborations_done: done,
      elaborations_planned: opts.elaborations_planned,
      complete: opts.complete ?? true,
      cut_by_correction: opts.cut_by_correction ?? false,
    }, { point_id });
    return { total, new_ms };
  }

  private ijPayload(id: string, stage: string, ai: AiId | null, point: string | null, pb: number | null, classification: string | null): Record<string, unknown> {
    return {
      interjection_id: id,
      stage,
      decision_source: 'vap',
      interrupted_ai: ai,
      during_point_id: point,
      audio_playback_id: pb === null ? absent('between_turns') : present(pb),
      p_now_user: present(0.7),
      p_future_user: present(0.65),
      vad_user: present(0.9),
      mic_dbfs: present(-28),
      first_voiced_at: absent('not_measured'),
      latency_ms: absent('not_measured'),
      classification,
      classification_basis: classification === null ? null : 'final',
      reason: stage,
    };
  }

  /** onset。stop は ① の止める経路、ignore は ② の記録だけ。 */
  onset(ai: AiId, point: string | null, pb: number, at: number, mode: 'stop' | 'ignore'): string {
    this.ij += 1;
    const id = `ij_${String(this.ij).padStart(4, '0')}`;
    this.emit('two_ai.interjection', this.ijPayload(id, 'onset', mode === 'stop' ? ai : null, point, pb, null), { at });
    if (mode === 'stop') this.emit('two_ai.interjection', this.ijPayload(id, 'stop_requested', ai, point, pb, null), { at: at + 10 });
    else this.emit('two_ai.interjection', this.ijPayload(id, 'ignored_by_condition', null, point, pb, null), { at: at + 10 });
    return id;
  }

  sttFinal(text: string, startAt: number, at: number): number {
    this.asr += 1;
    this.emit('stt.final', {
      text,
      stable_text: text,
      unstable_text: '',
      parts: [{ text, stability: absent('final_has_none') }],
      segment_id: this.asr,
      asr_segment_id: this.asr,
      asr_segment_frame_start: Math.round(startAt * 16),
      transcript_revision: this.asr * 3,
      stability: absent('final_has_none'),
      stability_source: 'provider',
      audio_frame_end: Math.round((at - 300) * 16),
      timing_precision: 'result_end_offset',
      words: absent('interim_words_unavailable'),
      stream_id: 'stream_1',
      provider: 'scripted_stt',
      model_version: 'test_double',
    }, { at });
    return this.asr;
  }

  /** ① の本人の番：話して、確定文が届き、分類まで。 */
  userTurn(id: string, ai: AiId, point: string | null, text: string, dur_ms: number, classification = 'content'): { seg: number; end: number } {
    const start = this.t + 200;
    const end = start + dur_ms;
    const seg = this.sttFinal(text, start, end + 500);
    this.emit('two_ai.interjection', this.ijPayload(id, 'user_ended', ai, point, null, null), { at: end + 600 });
    this.emit('two_ai.interjection', this.ijPayload(id, 'classified', ai, point, null, classification), { at: end + 600 });
    this.t = end + 600;
    return { seg, end };
  }

  episode(e: {
    interjection_id: string;
    outcome: string;
    decision_source: string;
    interrupted_ai: AiId | null;
    during_point_id: string | null;
    onset_at: number;
    user_voice_start_at: number | null;
    stop_requested_at: number | null;
    stopped_at: number | null;
    user_speech_end_at: number | null;
    ack: Record<string, unknown> | null;
    correction?: Record<string, unknown> | null;
    correction_hold: Record<string, unknown> | null;
    resumed_at: number | null;
    asr_segment_ids: number[];
    at?: number;
    voiced_ms?: number;
    near_marker?: boolean;
    fed?: boolean;
  }): void {
    const m = (v: number | null, r: string) => (v === null ? absent(r) : present(v));
    this.emit('two_ai.interjection_episode', {
      interjection_id: e.interjection_id,
      outcome: e.outcome,
      false_onset_check: { window_ms: 1500, voiced_ms: e.voiced_ms ?? 1200, had_text: e.asr_segment_ids.length > 0 },
      decision_source: e.decision_source,
      interrupted_ai: e.interrupted_ai,
      during_point_id: e.during_point_id,
      onset_at: e.onset_at,
      user_voice_start_at: m(e.user_voice_start_at, 'no_voice'),
      stop_requested_at: m(e.stop_requested_at, 'not_stopped'),
      stopped_at: m(e.stopped_at, 'not_stopped'),
      stop_latency_ms: e.stopped_at !== null && e.user_voice_start_at !== null ? present(e.stopped_at - e.user_voice_start_at) : absent('not_stopped'),
      gaze_to_user_at: e.stop_requested_at === null ? { A: absent('not_stopped'), B: absent('not_stopped') } : { A: present(e.stop_requested_at), B: present(e.stop_requested_at) },
      user_speech_end_at: m(e.user_speech_end_at, 'no_voice'),
      ack: e.ack,
      reonsets_during_ack: 0,
      correction: e.correction ?? null,
      correction_hold: e.correction_hold,
      near_marker: e.near_marker ?? false,
      resumed_at: m(e.resumed_at, 'no_resume'),
      asr_segment_ids: e.asr_segment_ids,
      fed: e.fed ?? false,
    }, { at: e.at ?? this.t });
  }

  marker(at: number, counted = true, extra: Record<string, unknown> = {}): string {
    this.mk += 1;
    const id = `mk_${String(this.mk).padStart(4, '0')}`;
    this.emit('two_ai.marker', {
      marker_id: id,
      client_t_ms: at - 500,
      discussion_stage: this.phase === 'discussion' ? this.stage : null,
      ai_speaking: null,
      turn_id: null,
      turn_kind: null,
      during_point_id: null,
      played_ms_in_turn: absent('not_speaking'),
      content_elapsed_ms: absent('not_measured'),
      user_speaking: false,
      interjection_id: null,
      counted,
      handling: 'recorded_only',
      ...extra,
    }, { at, basis: BROWSER });
    return id;
  }

  boardEvent(mode: string, reason: string, cards: Record<string, unknown>[], trigger_turn_id: string | null, picked: string | null, at = this.t): number {
    this.boardVersion += 1;
    this.emit('two_ai.board', { board_version: this.boardVersion, mode, cards, trigger_turn_id, reason, picked_card_id: picked }, { at });
    return this.boardVersion;
  }
}

// ---- 筋書き ----------------------------------------------------------------------

export interface SyntheticOptions {
  condition: TwoAiCondition;
  session_id?: string;
  /** true（既定）は end_of_session の撤回と auto の訂正。false は研究のセッション（after_measures、研究者の訂正）。 */
  self_run?: boolean;
  /** ① の訂正の仕方。mid_f0：F.0 の途中で訂正（既定）。hold_timeout：F.0 の途中だが判定が届かず保留が時間切れ。none：訂正なし。 */
  correction?: 'mid_f0' | 'hold_timeout' | 'none';
  /** ① で C.1 の途中に反論する（既定 true）。 */
  rebuttal_on_c?: boolean;
  /** 本人が話す（② は記録だけ）。false は黙る試走（AC5(d)）。 */
  user_speaks?: boolean;
  /** 応答の段で本人が話す（既定 true）。 */
  response_speech?: boolean;
  /** 体験の旗が有効（① だけ）。 */
  feeds?: boolean;
  /** 板のカード 1 を切り替えの前に出す（取り違えの値を含む文にする。AC3(h) の対象外の確認）。 */
  card1_before_switch_with_slip?: boolean;
}

export interface SyntheticSession {
  events: Record<string, unknown>[];
  manifest: Record<string, unknown>;
  script: TwoAiScript;
  config: TwoAiSessionConfig;
}

export function buildSyntheticSession(options: SyntheticOptions): SyntheticSession {
  const script = loadDemoScript();
  const selfRun = options.self_run ?? true;
  const config = loadConfig(selfRun ? 'session.demo_short.ja' : 'session.ja');
  const onSpot = options.condition === 'respond_on_spot';
  const speaks = options.user_speaks ?? true;
  const correction = onSpot && speaks ? (options.correction ?? 'mid_f0') : 'none';
  const rebuttal = onSpot && speaks && (options.rebuttal_on_c ?? true);
  const feeds = onSpot && (options.feeds ?? false);
  const session_id = options.session_id ?? `synthetic_${options.condition}`;
  const b = new TwoAiLogBuilder(session_id, options.condition);
  const headings = script.stages ?? config.fixed.stage_headings;
  b.setHeadings(headings);
  const point = (id: string) => script.planned_points.find((p) => p.id === id)!;
  const F = point('fact1');
  const K = point('ctl1');
  const C = point('C1');
  for (const p of [F, K, C]) b.registerPoint(p.id, p.kind, p.trigger, 'in_stage' in p.trigger ? p.trigger.in_stage : null);
  const card = (order: number, variant: ScriptVariant) => {
    const c = script.board!.find((x) => x.order === order)!;
    return { card_id: c.card_id, order: c.order, stage: c.discussion_stage, variant, depends_on: c.depends_on, text: variant === 'corrected' ? c.corrected_text : c.text };
  };
  const ackText = config.acknowledgment.templates[0]!.text;
  const ackMs = speechMs(ackText);
  const blockMs = (turns: { text: string }[]) => turns.reduce((s, t) => s + speechMs(t.text), 0);

  // ---- intake
  b.setPhase('intake', 'session_start', 'session_start', config.phases.intake.max_sec * 1000);
  b.emit('clock.sync', { source: 'browser_rtt', offset_ms: 12, error_ms: 2, rtt_ms: present(4) });
  for (const provider of ['scripted_llm', 'scripted_stt', 'scripted_tts']) {
    b.emit('provider.status', { provider, provider_class: 'test_double', status: 'ok', reason: absent('healthy'), retry_attempt: 0, next_retry_ms: absent('no') });
  }
  b.emit('llm.request', { request_id: 'r_ledger_1', purpose: 'ledger', input: { text: 'x' }, transcript_revision: 1, sent_at: b.t, model_version: 'test_double' });
  b.turn({ speaker: 'A', kind: 'facilitation', text: config.fixed.lines.intake_first_question });
  b.sttFinal('博士課程に進むか、インターンに応募するかで迷っています。', b.t + 300, b.t + 4000);
  b.advance(4500);
  b.emit('two_ai.plan', { stage: 'requested', trigger: 'early', plan_id: null, plan_hash: null, source: null, plan: null, fact_slip_source: null, schedule_check: null, prompt_versions: {}, models: {}, latency_ms: absent('requested'), reason: 'plan_start_sec' });
  b.turn({ speaker: 'A', kind: 'facilitation', text: config.fixed.lines.core_readback.replace('{core}', script.prior.core!) });
  b.emit('two_ai.plan', { stage: 'frozen', trigger: 'early', plan_id: 'plan_0001', plan_hash: 'sha256_plan_demo', source: 'prepared', plan: { script_id: script.script_id, points: script.planned_points.map((p) => ({ id: p.id, slip: p.slip })) }, fact_slip_source: 'prior', schedule_check: { ok: true, latest_point_end_sec: 124.4, close_at_sec: config.phases.discussion.close_at_sec }, prompt_versions: {}, models: {}, latency_ms: present(10), reason: 'prepared_script' });
  b.advance(2000);

  // ---- discussion
  b.setPhase('discussion', 'auto_timer', 'intake_max_sec', config.phases.discussion.target_sec * 1000);
  b.turn({ speaker: 'A', kind: 'phase_line', text: config.fixed.lines.opening_two });
  b.turn({ speaker: 'B', kind: 'phase_line', text: config.fixed.lines.opening_cond[options.condition] });

  const discussion = (speaker: AiId, text: string, extra: Partial<TurnSpec> = {}, beforeStart?: (id: string, at: number) => void) =>
    b.turn({ speaker, kind: 'discussion', text, ...extra }, beforeStart);
  const stageStart = (n: number) => (id: string, at: number) => b.startStage(n, headings[n - 1]!, id, at);

  // 段 1
  discussion('A', '中村さんのお話を整理すると、博士課程と長期インターンのどちらに進むかで迷っているんですね。', options.card1_before_switch_with_slip ? { card: { ...card(1, 'original'), text: '締切の 12 月末に合わせて、説明会は録画で済ませる' } } : {}, stageStart(1));
  let switched = false;
  if (onSpot && correction !== 'none') {
    const f0 = b.turn({ speaker: 'A', kind: 'point', text: F.turns![0]!.text, point_id: 'fact1', point_variant: 'original', cut: { after_ms: 2500, source: 'vap' }, segmentCut: correction === 'mid_f0' ? 'correction' : 'interjection' });
    const onsetAt = f0.ended_at - 250;
    const user = b.userTurn(f0.interjection_id!, 'A', 'fact1', 'いや、締切は 2 月末です。', 2000);
    const ack = b.turn({ speaker: 'A', kind: 'ack', text: ackText, gap: 300 });
    const trigger = selfRun ? 'auto_confirmed' : 'woz_researcher';
    if (correction === 'mid_f0') {
      const decidedAt = b.t + 200;
      if (selfRun) {
        b.emit('two_ai.correction_suggested', { suggestion_id: 'sg_0001', point_id: 'fact1', asr_segment_ids: [user.seg], status: 'done', corrects: true, evidence_span: '2 月末です', method: 'scripted_judge', latency_ms: present(900) }, { at: decidedAt - 50 });
      } else {
        b.emit('woz.override', { action: 'correction', operator: 'researcher', detail: { woz_id: 'wz_0001', status: 'applied', reason: 'researcher_confirmed', phase: 'discussion', ai_speaking: null, point_id: 'fact1', condition_note: null } }, { at: decidedAt - 50 });
      }
      b.advance(200);
      b.variant = 'corrected';
      switched = true;
      b.emit('two_ai.script', { stage: 'switched', point_id: 'fact1', trigger, reason: 'confirmed', decided_at: decidedAt, timing: 'in_window', asr_segment_ids: [user.seg], invalidated_turn_ids: [], replaced_point_turn_ids: [], resume_dropped: true, uptake_turn_id: b.nextTurnId() });
      b.turn({ speaker: 'A', kind: 'uptake', text: F.uptake!.text, gap: 300 });
      b.episode({ interjection_id: f0.interjection_id!, outcome: 'yielded', decision_source: 'vap', interrupted_ai: 'A', during_point_id: 'fact1', onset_at: onsetAt, user_voice_start_at: onsetAt - 100, stop_requested_at: onsetAt + 10, stopped_at: f0.ended_at, user_speech_end_at: user.end, ack: { ai_id: 'A', template_id: 'ack_1', audio_playback_id: ack.pb, synthesized_ms: ackMs, played_ms: ack.played_ms, truncated: false }, correction: { point_id: 'fact1', trigger, timing: 'in_window' }, correction_hold: { started_at: ack.ended_at, hold_until: user.end + config.correction.hold_max_ms, ended_at: decidedAt, ended_by: 'corrected', stt_final_after_ms: present(500), judgment_after_ms: selfRun ? present(1400) : absent('researcher_path'), credited_ms: absent('not_timeout') }, resumed_at: null, asr_segment_ids: [user.seg] });
      b.turn({ speaker: 'B', kind: 'point_elaboration', text: F.corrected_turns![1]!.text, point_id: 'fact1', point_variant: 'corrected' });
      b.turn({ speaker: 'A', kind: 'point_elaboration', text: F.corrected_turns![2]!.text, point_id: 'fact1', point_variant: 'corrected' });
      b.closePoint('fact1', 'A', { planned_exposure_ms: blockMs(F.turns!), elaborations_planned: 2, cut_by_correction: true });
    } else {
      // 判定が届かず保留が時間切れ（auto の failed も同じ）
      b.emit('two_ai.correction_suggested', { suggestion_id: 'sg_0001', point_id: 'fact1', asr_segment_ids: [user.seg], status: 'failed', corrects: null, evidence_span: '', method: 'scripted_judge', latency_ms: absent('judge_failed') }, { at: user.end + 1500 });
      const holdUntil = user.end + config.correction.hold_max_ms;
      b.t = Math.max(b.t, holdUntil);
      const bridge = b.turn({ speaker: 'A', kind: 'bridge', text: config.fixed.hold_bridge, gap: 0 });
      const credited = Math.round((([...F.turns![1]!.text].length + [...F.turns![2]!.text].length) / config.phases.discussion.chars_per_sec_estimate) * 1000);
      b.episode({ interjection_id: f0.interjection_id!, outcome: 'yielded', decision_source: 'vap', interrupted_ai: 'A', during_point_id: 'fact1', onset_at: onsetAt, user_voice_start_at: onsetAt - 100, stop_requested_at: onsetAt + 10, stopped_at: f0.ended_at, user_speech_end_at: user.end, ack: { ai_id: 'A', template_id: 'ack_1', audio_playback_id: ack.pb, synthesized_ms: ackMs, played_ms: ack.played_ms, truncated: false }, correction: null, correction_hold: { started_at: ack.ended_at, hold_until: holdUntil, ended_at: bridge.started_at, ended_by: 'timeout', stt_final_after_ms: present(500), judgment_after_ms: absent('judge_failed'), credited_ms: present(credited) }, resumed_at: null, asr_segment_ids: [user.seg] });
      // F の残り（F.1、F.2）は話さない。見込みの長さを中身の時計に足す（第 5 回 M2）
      b.contentMs += credited;
      b.closePoint('fact1', 'A', { planned_exposure_ms: blockMs(F.turns!), elaborations_planned: 2, complete: false });
    }
  } else {
    const userDuring = !onSpot && speaks ? { after_ms: 2500, text: 'いや、締切は 2 月末です。', dur_ms: 2000 } : undefined;
    const f0 = b.turn({ speaker: 'A', kind: 'point', text: F.turns![0]!.text, point_id: 'fact1', point_variant: 'original', ...(userDuring ? { userDuring } : {}) });
    if (userDuring) {
      b.emit('woz.override', { action: 'correction', operator: 'researcher', detail: { woz_id: 'wz_0001', status: 'rejected', reason: 'condition_respond_at_end', phase: 'discussion', ai_speaking: 'B', point_id: 'fact1', condition_note: null } }, { at: f0.ended_at + 500 });
      b.emit('two_ai.script', { stage: 'rejected', point_id: 'fact1', trigger: 'woz_researcher', reason: 'condition_respond_at_end', decided_at: f0.ended_at + 500, timing: null, asr_segment_ids: [f0.user_seg!], invalidated_turn_ids: [], replaced_point_turn_ids: [], resume_dropped: false, uptake_turn_id: null }, { at: f0.ended_at + 500 });
    }
    b.turn({ speaker: 'B', kind: 'point_elaboration', text: F.turns![1]!.text, point_id: 'fact1', point_variant: 'original' });
    b.turn({ speaker: 'A', kind: 'point_elaboration', text: F.turns![2]!.text, point_id: 'fact1', point_variant: 'original' });
    b.closePoint('fact1', 'A', { planned_exposure_ms: blockMs(F.turns!), elaborations_planned: 2 });
  }
  const s1b = discussion('B', 'まずは、日程の見通しを、一枚の候補にしておきましょう。', options.card1_before_switch_with_slip ? {} : { card: card(1, switched ? 'corrected' : 'original') });
  b.marker(s1b.started_at + 800);

  // 段 2
  discussion('A', 'ここからは、二人の見方を並べてみます。わたしは、収入と時期の現実が気になります。', {}, stageStart(2));
  discussion('B', 'わたしは、毎日どんなふうに過ごしていたいかのほうが、気になっています。');
  b.turn({ speaker: 'A', kind: 'point', text: K.turns![0]!.text, point_id: 'ctl1', point_variant: b.variant });
  b.turn({ speaker: 'B', kind: 'point_elaboration', text: K.turns![1]!.text, point_id: 'ctl1', point_variant: b.variant });
  b.turn({ speaker: 'A', kind: 'point_elaboration', text: K.turns![2]!.text, point_id: 'ctl1', point_variant: b.variant });
  b.closePoint('ctl1', 'A', { planned_exposure_ms: blockMs(K.turns!), elaborations_planned: 2 });
  discussion('B', '奨学金の条件も、一度書き出しておくと、比べやすくなりそうです。', { card: card(2, b.variant) });

  // 段 3
  b.turn({ speaker: 'B', kind: 'point', text: C.turns![0]!.text, point_id: 'C1', point_variant: b.variant }, stageStart(3));
  let rebuttalId: string | null = null;
  if (rebuttal) {
    const c1 = b.turn({ speaker: 'A', kind: 'point_elaboration', text: C.turns![1]!.text, point_id: 'C1', point_variant: b.variant, cut: { after_ms: 2000, source: 'vap' } });
    rebuttalId = c1.interjection_id;
    const onsetAt = c1.ended_at - 250;
    const user = b.userTurn(c1.interjection_id!, 'A', 'C1', '才能の話じゃなくて、締切の話なんです。', 2500);
    const ack = b.turn({ speaker: 'A', kind: 'ack', text: ackText, gap: 300 });
    const bridgeMs = speechMs(config.fixed.bridge);
    const resume = b.turn({ speaker: 'A', kind: 'resume', text: config.fixed.bridge + C.turns![1]!.text, point_id: 'C1', point_variant: b.variant, gap: config.gaps_ms.resume_gap_ms, bridge_ms: bridgeMs, repeated_ms: 2000 });
    b.episode({ interjection_id: c1.interjection_id!, outcome: 'yielded', decision_source: 'vap', interrupted_ai: 'A', during_point_id: 'C1', onset_at: onsetAt, user_voice_start_at: onsetAt - 100, stop_requested_at: onsetAt + 10, stopped_at: c1.ended_at, user_speech_end_at: user.end, ack: { ai_id: 'A', template_id: 'ack_1', audio_playback_id: ack.pb, synthesized_ms: ackMs, played_ms: ack.played_ms, truncated: false }, correction: null, correction_hold: null, resumed_at: resume.started_at, asr_segment_ids: [user.seg], fed: feeds, at: resume.started_at });
    if (feeds) {
      b.emit('two_ai.interjection_fed', { interjection_id: c1.interjection_id!, asr_segment_ids: [user.seg], chars: 18, accepted: true, excluded_reason: null, invalidated_turn_ids: [], target: 'after_point_block' }, { at: resume.started_at });
    }
  } else {
    const userDuring = !onSpot && speaks ? { after_ms: 2000, text: '才能の話じゃなくて、締切の話なんです。', dur_ms: 2500 } : undefined;
    b.turn({ speaker: 'A', kind: 'point_elaboration', text: C.turns![1]!.text, point_id: 'C1', point_variant: b.variant, ...(userDuring ? { userDuring } : {}) });
  }
  b.turn({ speaker: 'B', kind: 'point_elaboration', text: C.turns![2]!.text, point_id: 'C1', point_variant: b.variant });
  b.closePoint('C1', 'B', { planned_exposure_ms: blockMs(C.turns!), elaborations_planned: 2 });
  const s3 = discussion('A', feeds ? '締切の話だというご指摘を受けると、平日の過ごし方も、締切までの数か月で考えられそうです。' : '平日の過ごし方を書き出すのは、今週からでも始められそうですね。', {
    card: card(3, b.variant),
    ...(feeds ? { feed_turn: true } : {}),
  });
  if (feeds) {
    b.emit('two_ai.generation', { turn_id: s3.turn_id, beat_id: 'b_s3_1', stage: 'generated', prompt_version: 'turn_v1_feed', model: 'test_double', latency_ms: present(10), chars: 40, fed_interjection_ids: [rebuttalId!], feed_turn: true, c_ban_lifted: true, reason: 'ok' }, { at: s3.started_at - 100 });
  } else {
    b.emit('two_ai.generation', { turn_id: s3.turn_id, beat_id: 'b_s3_1', stage: 'generated', prompt_version: 'turn_v1', model: 'test_double', latency_ms: present(10), chars: 30, fed_interjection_ids: [], feed_turn: false, c_ban_lifted: false, reason: 'ok' }, { at: s3.started_at - 100 });
  }
  b.marker(s3.started_at + 1500);

  // 段 4
  discussion('B', '次の一歩の候補を、もう一つ考えてみます。', {}, stageStart(4));
  discussion('A', '説明会の前に、先輩に話を聞いておくのもよさそうです。', { card: card(4, b.variant) });
  b.endStage(b.t, 'content_done');
  b.turn({ speaker: 'A', kind: 'phase_line', text: config.fixed.lines.closing_two });

  // ---- 最後の段（両条件で同一）
  b.setPhase('response', 'auto_content', 'discussion_closed', config.phases.response.duration_sec * 1000);
  const q = b.turn({ speaker: config.speakers.closing, kind: 'phase_line', text: config.fixed.lines.closing_question, origin: 'cached', gap: 0 });
  const plannedMs = config.phases.response.duration_sec * 1000;
  const respSpeaks = speaks && (options.response_speech ?? true);
  let userSpeechMs = 0;
  if (respSpeaks) {
    userSpeechMs = 6000;
    b.sttFinal('締切の日付は、2 月末で合っています。', q.ended_at + 2000, q.ended_at + 8500);
  }
  const windowEnd = q.ended_at + plannedMs;
  b.t = windowEnd;
  b.emit('two_ai.response_window', { planned_ms: plannedMs, question_played_ms: q.played_ms, started_at: q.ended_at, ended_at: windowEnd, ended_by: 'timer', overrun_ms: 0, user_speech_ms: userSpeechMs, silence_prompts: respSpeaks ? 0 : 2, correction_recorded: false, ack_given: respSpeaks });
  if (respSpeaks) b.turn({ speaker: config.speakers.closing, kind: 'ack', text: ackText, gap: 300 });
  const rebuiltCards = script.board!.map((c) => ({ card_id: c.card_id, order: c.order, discussion_stage: c.discussion_stage, variant: 'corrected', depends_on: c.depends_on, text: c.corrected_text, trigger_turn_ended: false }));
  const r0 = b.turn({ speaker: script.rebuild_turns![0]!.speaker, kind: 'rebuild', text: script.rebuild_turns![0]!.text }, (id, at) => {
    b.boardEvent('rebuilt', 'rebuilt', rebuiltCards, id, null, at);
  });
  const r1 = b.turn({ speaker: script.rebuild_turns![1]!.speaker, kind: 'rebuild', text: script.rebuild_turns![1]!.text });
  const revealed = rebuiltCards.map((c) => ({ ...c, trigger_turn_ended: true }));
  const boardVersion = b.boardEvent('rebuilt', 'revealed', revealed, r0.turn_id, null, r1.ended_at);

  b.setPhase('next_step', 'auto_content', 'rebuild_done', config.phases.next_step.pick_max_sec * 1000);
  const pick = b.turn({ speaker: config.speakers.next_step, kind: 'phase_line', text: config.fixed.lines.pick_prompt, origin: 'cached', gap: 0 });
  const pickVersion = b.boardEvent('pick', 'pick_opened', revealed, null, null, pick.ended_at);
  void boardVersion;
  const pickedAt = pick.ended_at + 4000;
  b.emit('two_ai.board_picked', { pick_id: 'pk_0001', outcome: 'picked', card_id: 'card_3', card_variant: 'corrected', card_depends_on: 'framing_C', board_version: pickVersion, latency_ms: present(4000), reason: 'first_valid_pick' }, { at: pickedAt, basis: { source: 'browser_rtt', uncertainty_ms: { value: 3 } } });
  b.t = pickedAt;
  b.boardEvent('picked', 'picked', revealed, null, 'card_3', pickedAt + 1);
  b.turn({ speaker: config.speakers.next_step, kind: 'phase_line', text: config.fixed.lines.pick_confirm, gap: 300 });

  // ---- end
  b.setPhase('end', 'auto_content', 'picked', null);
  const R = script.retraction!;
  const originalInferencePlayed = (b.segments.get('fact1') ?? []).some((s) => s.turn_kind === 'point_elaboration' && s.variant === 'original' && (s.played_ms as number) > 0);
  const inferenceForm = originalInferencePlayed ? 'spoken' : 'not_spoken';
  const lines = [R.fact, inferenceForm === 'spoken' ? R.inference : R.inference_unspoken, R.process].map((text) => ({ ai_id: config.retraction.speaker, text }));
  const retractionSha = sha256(lines.map((l) => l.text).join('\n'));
  if (config.retraction.timing === 'end_of_session') {
    let played = 0;
    let firstPb: number | null = null;
    for (const line of lines) {
      const r = b.turn({ speaker: line.ai_id, kind: 'retraction', text: line.text, origin: 'fixed' });
      played += r.played_ms;
      firstPb ??= r.pb;
    }
    b.emit('two_ai.retraction', { timing: 'end_of_session', trigger: 'end', point_ids: ['fact1'], ai_id: config.retraction.speaker, audio_playback_id: present(firstPb!), played_ms: present(played), script_sha256: retractionSha, lines, inference_form: inferenceForm });
  } else {
    b.emit('two_ai.retraction', { timing: 'after_measures', trigger: 'end', point_ids: ['fact1'], ai_id: null, audio_playback_id: absent('after_measures'), played_ms: absent('after_measures'), script_sha256: retractionSha, lines, inference_form: inferenceForm });
  }

  const events = b.build();
  const exploratory = feeds;
  const notes: string[] = [];
  if (exploratory) notes.push('exploratory');
  const twoAi = {
    config_file: selfRun ? 'config/two_ai/session.demo_short.ja.json' : 'config/two_ai/session.ja.json',
    config_sha256: sha256(JSON.stringify(config)),
    config_id: config.config_id,
    config_version: config.version,
    script_file: 'config/two_ai/scripts/demo_career.ja.json',
    script_sha256: sha256(JSON.stringify(script)),
    script_id: script.script_id,
    script_kind: script.kind,
    condition: options.condition,
    condition_source: 'research_screen',
    arm_id: 'arm_0001',
    self_run: config.self_run,
    correction_mode: config.correction.mode,
    personas: {
      A: { persona_id: 'aoi', version: 1, voice_env: 'TWO_AI_VOICE_A', voice_provider: 'elevenlabs' },
      B: { persona_id: 'haru', version: 1, voice_env: 'TWO_AI_VOICE_B', voice_provider: 'elevenlabs' },
    },
    planned_points: script.planned_points.map((p) => ({ id: p.id, kind: p.kind, speaker: p.speaker, trigger: p.trigger, elaborate_turns: p.elaborate_turns, source: p.source, text_sha256: sha256(JSON.stringify(p.turns)) })),
    point_schedule: { ok: true, latest_point_end_sec: 124.4, limit_sec: 135 },
    ack_templates: config.acknowledgment.templates.map((t) => ({ id: t.id, text_sha256: sha256(t.text), synthesized_ms: { A: speechMs(t.text), B: speechMs(t.text) } })),
    response_duration_sec: config.phases.response.duration_sec,
    experience: { interjection_feeds_generation: { requested: options.feeds ?? false, effective: feeds, source: 'config' }, response_mode: 'fixed' },
    exploratory,
    plan_hash: 'sha256_plan_demo',
    plan_source: 'prepared',
    plan_wait_ms: 0,
    fact_slip: 'available',
    fact_slip_source: 'prior',
    control_inference: 'available',
    stage_headings_sha256: sha256(headings.join('\n')),
    board_sha256: sha256(JSON.stringify(script.board)),
    rebuild_sha256: sha256(JSON.stringify(script.rebuild_turns)),
    retraction: { timing: config.retraction.timing, script_sha256: retractionSha, inference_form: inferenceForm },
    marker_enabled: true,
    order: { session_index: options.condition === 'respond_on_spot' ? 1 : 2, counterbalance_label: 'AB' },
    evidence_ok_for_comparison: !exploratory,
    evidence_notes: notes,
  };
  const manifest = {
    manifest_version: 1,
    session_id,
    event_schema_version: 1,
    started_wall_clock: '2026-11-20T01:00:00.000Z',
    closed: true,
    closed_wall_clock: '2026-11-20T01:30:00.000Z',
    close_error: null,
    condition: options.condition,
    policy_id: 'ja',
    providers: {
      llm: { provider: 'scripted_llm', provider_class: 'test_double', reason: 'synthetic' },
      stt: { provider: 'scripted_stt', provider_class: 'test_double', reason: 'synthetic' },
      tts: { provider: 'scripted_tts', provider_class: 'test_double', reason: 'synthetic' },
    },
    mode: 'two_ai',
    two_ai: twoAi,
    stats: { written: events.length, accepted: events.length },
  };
  return { events, manifest, script, config };
}

/** events.jsonl、quarantine.jsonl、manifest.json を書く（試験用）。 */
export async function writeSyntheticSession(dir: string, session: { events: Record<string, unknown>[]; manifest: Record<string, unknown> }): Promise<string> {
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'events.jsonl'), session.events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  await writeFile(join(dir, 'quarantine.jsonl'), '');
  await writeFile(join(dir, 'manifest.json'), `${JSON.stringify({ ...session.manifest, stats: { written: session.events.length, accepted: session.events.length } }, null, 2)}\n`);
  return dir;
}
