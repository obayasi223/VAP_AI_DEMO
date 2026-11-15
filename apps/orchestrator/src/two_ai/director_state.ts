/**
 * 進行役の状態と入力の型（docs/design/two_ai/06 §7.1、§7.2）。契約の外（WP1 の持ち物）。
 *
 * 06 の形に足したもの（実装の都合。06 §12 の手順で 06 に写す候補。wp0_notes.md の「WP1 の実装の記録」）：
 * - DirectorState：queue（next より先に話す定型・resume・uptake・つなぎ・作り直し）、last_step_at、credited_interjection_ids、
 *   closing（段の終わりの台詞の状態）、response の ack と問いの長さ、end の撤回の番号、plan.fallback_used、user_floor_warned。
 * - PendingTurn：source（何として頼んだか）と late_logged。
 * - InterjectionTrack：onset の値、hold（保留）、correction（決まった訂正）、after_uptake（uptake の後に resume を頼むか）、
 *   seen_suggestion_ids、interrupted_completed、gaze_to_user_at、ack の記録、credited_ms、near_marker。
 * - PointProgress：trigger、planned_at_ms、expected_block_ms、started_est_ms、segments、switched。
 * - DirectorInputs：stage_headings、cancelled_turn_ids、turn_arrivals[].cached、board_picks[].card_known（executor が持つ事実）。
 */
import type {
  AiId,
  DiscussionStage,
  PointKind,
  PointTrigger,
  ScriptVariant,
  TimeBasis,
  TwoAiCondition,
  TwoAiPhase,
  TwoAiTurnKind,
  UtteranceClass,
} from '@llm-vap/contracts';
import type { GazeTarget } from '@llm-vap/contracts';
import type { CorrectionSuggestion, DiscussionTurn, PendingPointView, PlanStatus } from './content_port';
import type { ExposureSegment } from './exposure';
import type { AttemptStats, AttemptUpdate, InterjectionSignal } from './interjection';
import type { WozInputTwoAi } from './woz';

export type DirectorSub =
  | { kind: 'idle' }
  | { kind: 'phase_open'; turn_id: string }
  | { kind: 'waiting_plan'; since: number }
  | { kind: 'between_turns' }
  | { kind: 'ai_speaking' }
  | { kind: 'stopping_for_user'; interjection_id: string }
  | { kind: 'user_floor'; interjection_id: string; since: number }
  | { kind: 'acknowledging'; interjection_id: string }
  /**
   * until：窓の終わり。hold_until：判定を待つ上限（F のブロックの割り込みだけ。なければ null）。本人が話している間は延ばす。
   * hold_cap：保留の始まり ＋ hold_max_ms × 2 の壁時計の上限（第 5 回 m2）。
   */
  | { kind: 'correction_window'; interjection_id: string; until: number; hold_until: number | null; hold_cap: number | null }
  | { kind: 'resuming'; interjection_id: string }
  | { kind: 'user_turn' }
  | { kind: 'closing' }
  | { kind: 'closing_question' }
  | { kind: 'rebuilding'; next_index: number }
  | { kind: 'awaiting_pick'; since: number }
  | { kind: 'retraction' }
  | { kind: 'ended' };

export interface FloorHolder {
  ai_id: AiId;
  turn_id: string;
  turn_kind: TwoAiTurnKind;
  audio_playback_id: number;
  point_id: string | null;
  phase: 'starting' | 'playing' | 'stopping';
  started_at: number;
  /** 拡張：開始の時点の写し（終わりの記録に使う）。 */
  view: DiscussionTurnView;
  source: PendingSource;
  played_ms_hint: number;
}

export type PendingSource = 'next_turn' | 'fixed' | 'resume' | 'uptake' | 'rebuild' | 'cached_ack' | 'cached_question' | 'fallback';

export interface PendingTurn {
  turn_id: string;
  state: 'requested' | 'arrived' | 'ready' | 'failed';
  turn: DiscussionTurnView | null;
  audio_playback_id: number | null;
  requested_at: number;
  desired_start_at: number | null;
  fallback_used: boolean;
  /** 拡張。 */
  source: PendingSource;
  late_logged: boolean;
}

/** 進行役が見るターンの写し（文を除く）。 */
export type DiscussionTurnView = Pick<
  DiscussionTurn,
  'turn_id' | 'speaker' | 'turn_kind' | 'point_id' | 'point_variant' | 'discussion_stage' | 'gap_hint_ms' | 'est_duration_ms' | 'text_origin' | 'repeat' | 'feed_turn' | 'fed_interjection_ids'
> & { chars: number; board_card_id: string | null };

export interface InterjectionTrack {
  interjection_id: string;
  decision_source: 'vap' | 'fallback' | 'woz';
  interrupted: { ai_id: AiId; turn_id: string; audio_playback_id: number; point_id: string | null; point_variant: ScriptVariant | null } | null;
  /** AI 同士の間の割り込みで待たせた次のターン。 */
  held: { turn_id: string; point_id: string | null; point_variant: ScriptVariant | null } | null;
  ack_speaker: AiId;
  first_voiced_at: number | null;
  detected_at: number;
  false_onset_until: number;
  voiced_ms: number;
  had_text: boolean;
  speech_confirmed: boolean;
  stop_requested_at: number | null;
  stopped_at: number | null;
  user_ended_at: number | null;
  classification: UtteranceClass | null;
  classification_basis: 'final' | 'interim' | 'none' | null;
  ack_started_at: number | null;
  ack_ended_at: number | null;
  reonsets_during_ack: number;
  asr_segment_ids: number[];
  // ---- 拡張 ----
  /** ② の記録だけの割り込み。 */
  logged_only: boolean;
  onset: { p_now_user: number | null; p_future_user: number | null; vad_user: number | null; mic_dbfs: number | null; audio_playback_id: number | null };
  interrupted_completed: boolean;
  gaze_to_user_at: { A: number | null; B: number | null };
  ack: { ai_id: AiId; template_id: string; audio_playback_id: number; synthesized_ms: number; played_ms: number; truncated: boolean } | null;
  ack_offered: boolean;
  classified: boolean;
  /** 研究者か auto で決まった訂正（窓で in_window として出す）。 */
  correction_decided: { point_id: string; trigger: 'woz_researcher' | 'auto_confirmed' } | null;
  correction_applied: { point_id: string; trigger: 'woz_researcher' | 'auto_confirmed'; timing: 'in_window' | 'next_boundary' } | null;
  hold: { started_at: number; hold_until: number; ended_at: number | null; ended_by: 'corrected' | 'not_correction' | 'timeout' | 'woz_resume' | 'abandoned' | null; judgment_after_ms: number | null; stt_final_after_ms: number | null } | null;
  /** uptake の後に resume を頼むか（drop_resume でない窓の中の訂正）。 */
  after_uptake: 'resume' | 'continue' | null;
  resume_turn_id: string | null;
  seen_suggestion_ids: string[];
  credited_ms: number | null;
  near_marker: boolean;
  resumed_at: number | null;
  user_floor_warned: boolean;
  /** 閉じるときの episode の outcome（決まったら次の開始で episode を出す）。 */
  outcome: 'yielded' | 'backchannel' | 'false_onset' | 'abandoned' | null;
}

/**
 * 本人の話し始めの試み（two_ai.interjection_attempt の材料）。声が終わり（stats）、結びついた episode が閉じたら出して消す。
 */
export interface AttemptTrack {
  attempt_id: string;
  started_at: number;
  overlapped: { ai_id: AiId; turn_id: string; turn_kind: TwoAiTurnKind; audio_playback_id: number; point_id: string | null } | null;
  /** 重なっていたターンの終わり。 */
  ai_end: { at: number; reason: 'completed' | 'stopped' | 'other' } | null;
  interjection_id: string | null;
  /** 結びついた割り込みが AI の再生を止めに行った（stop_requested）。 */
  stop_requested: boolean;
  episode_outcome: 'yielded' | 'backchannel' | 'false_onset' | 'onset_no_speech' | 'logged_only' | 'abandoned' | null;
  stats: AttemptStats | null;
}

export interface PointProgress {
  point_id: string;
  kind: PointKind;
  state: 'pending' | 'in_progress' | 'completed' | 'missed' | 'unavailable';
  started_at: number | null;
  turns_spoken: number;
  elaborations_planned: number;
  exposure_total_ms: number;
  exposure_new_ms: number;
  // ---- 拡張 ----
  speaker: AiId;
  discussion_stage: DiscussionStage | null;
  trigger: PointTrigger;
  planned_at_ms: number | null;
  expected_block_ms: number;
  /** 始めたターンの見込みの長さの和（credited_ms の検算用）。 */
  started_est_ms: number;
  segments: ExposureSegment[];
  switched: boolean;
  /** 保留の時間切れで残りを捨てた（complete: false、segments.cut: interjection）。 */
  abandoned: boolean;
}

export interface DirectorState {
  condition: TwoAiCondition;
  correction_mode: 'researcher' | 'auto';
  feeds_generation: boolean;
  phase: TwoAiPhase;
  phase_started_at: number;
  discussion_started_at: number | null;
  content_elapsed_ms: number;
  discussion_stage: DiscussionStage | null;
  stage_started_at: number | null;
  board: { version: number; shown_card_ids: string[]; mode: 'building' | 'rebuilt' | 'pick' | 'picked'; picked_card_id: string | null };
  pick: { opened_at: number | null; done: boolean };
  marker: { last_counted_at: number | null; count: number };
  intake: { first_question_spoken: boolean; readback_spoken: boolean };
  script_variant: ScriptVariant;
  sub: DirectorSub;
  turn_seq: number;
  discussion_turns: number;
  floor: FloorHolder | null;
  next: PendingTurn | null;
  last_turn_ended_at: number | null;
  last_speaker: AiId | null;
  interjection: InterjectionTrack | null;
  interjection_count: number;
  /** 出す前の試み（声が続いているか、episode が閉じていない）。 */
  attempts: AttemptTrack[];
  attempt_count: number;
  gaze: Record<AiId, GazeTarget>;
  points: Record<string, PointProgress>;
  points_forced: boolean;
  plan: { early_requested: boolean; final_requested: boolean; wait_started_at: number | null; fillers_spoken: 0 | 1 | 2 };
  correction: { applied_point_ids: string[]; handled_suggestion_ids: string[] };
  response: { started_at: number | null; silence_prompts: number; last_user_voice_at: number | null; time_up_at: number | null; correction_recorded: boolean };
  ack_offer: { ai_id: AiId; audio_playback_id: number; interjection_id: string | null } | null;
  woz_paused: boolean;
  consecutive_failures: number;
  // ---- 拡張 ----
  queue: PendingTurn[];
  last_step_at: number | null;
  credited_interjection_ids: string[];
  plan_fallback_used: boolean;
  /** 段の終わりの台詞を頼んだ段（2 回頼まない）。 */
  closing_requested: TwoAiPhase | null;
  response_extra: { question_played_ms: number; user_speech_ms: number; voice_confirmed: boolean; ack_offered: boolean; ack_given: boolean; ended_by: 'timer' | 'woz' | 'session_end' | null };
  retraction: { trigger: 'end' | 'aborted'; speak: boolean; next_index: number; done: boolean };
  /** 2 回目の pick の記録（rejected）用。 */
  feed_wait: boolean;
  /** 訂正を当てた後、uptake が届くまで次のターンを始めない（01 §3.5.2：受け止め → uptake → 訂正後の F の残り）。上限を過ぎたら待たない。 */
  awaiting_uptake_until: number | null;
  /** discussion の壁時計の安全の上限で、段を移すと決めた。 */
  discussion_closing: boolean;
  /** 最近の印の時刻（near_marker の判定）。 */
  recent_marker_ats: number[];
  /** 絶対の上限（max_sec + points_overrun_max_sec）を扱った。 */
  wall_overrun_handled: boolean;
  /**
   * ① の割り込みに使った壁時計（本人の発話、受け止め、保留、つなぎ。割り込みの開始から言い直しの始まりまでと、bridge の再生）。
   * 話し合いの壁時計の上限をこの分だけ延ばす（上限 interjection_allowance_max_sec。U1：① で ② が受け取る中身を切らない）。
   */
  interjection_wall_ms: number;
  /** 段ごとの割り込みの数（両条件。研究者の確認用。U3）。 */
  interjections_by_stage: [number, number, number, number];
  /** 頼んだ定型の種類（turn_id → 行。話し終えたときの遷移に使う）。 */
  queue_lines: Record<string, import('./director').FixedLineRef>;
  /** 受け取った保持の受け止めの型と長さ（episode の ack）。 */
  ack_cache: { template_id: string; synthesized_ms: number } | null;
  /** discussion を閉じる理由（phase_changed の source）。 */
  discussion_closing_source: 'auto_timer' | 'auto_content' | 'woz' | 'error';
}

export interface SlotView {
  ready: { turn_id: string; audio_playback_id: number }[];
  failed: { turn_id: string; reason: string }[];
  active_playback: number | null;
  available: boolean;
}

export type PlaybackObservation =
  | { kind: 'started'; audio_playback_id: number; at: number }
  | {
      kind: 'ended';
      audio_playback_id: number;
      at: number;
      samples_written: number;
      played_ms: number;
      new_ms: number;
      bridge_ms: number;
      repeated_ms: number;
      repeated_source: 'alignment' | 'char_ratio' | 'none';
      content_ms: number;
      spoken_text_chars: number;
      reason: 'completed' | 'stopped' | 'discarded_before_start' | 'error' | 'report_timeout';
    };

export interface TurnArrival {
  turn: DiscussionTurnView;
  audio_playback_id: number;
  source: 'next_turn' | 'fallback' | 'uptake' | 'resume' | 'fixed' | 'cached_ack' | 'cached_question' | 'rebuild';
  /** 拡張：保持した音声の型と長さ（受け止めの記録）。 */
  cached?: { template_id: string; synthesized_ms: number };
}

export interface DirectorInputs {
  link_attached: boolean;
  slots: Record<AiId, SlotView>;
  playback_events: PlaybackObservation[];
  interjection: InterjectionSignal;
  /** 検出器の試みの始まりと終わり（拡張。無ければ試みを記録しない）。 */
  interjection_attempt?: AttemptUpdate | null;
  user: { speaking: boolean; permitted_to_speak: boolean; started_ack: number | null; voiced_ms_since_onset: number; last_voice_at: number | null };
  user_utterance: { segment_id: number; is_final: boolean; classification: UtteranceClass; basis: 'final' | 'interim' | 'none'; asr_segment_ids: number[] } | null;
  turn_arrivals: TurnArrival[];
  turn_failures: { turn_id: string; reason: string }[];
  plan: PlanStatus;
  points: PendingPointView[];
  correction_suggestions: CorrectionSuggestion[];
  content_done: { intake: boolean; discussion: boolean };
  intake_readback_due: boolean;
  markers: { marker_id: string; client_t_ms: number; at: number; time_basis: TimeBasis }[];
  board_picks: { pick_id: string; card_id: string; board_version: number; client_t_ms: number; at: number; time_basis: TimeBasis; card_known?: boolean }[];
  woz: WozInputTwoAi[];
  /** abandonResume が返した credited_ms（interjection_id ごとに 1 回だけ足す。第 5 回 M2）。 */
  content_credits: { interjection_id: string; credited_ms: number }[];
  // ---- 拡張 ----
  /** content.stageHeadings()（計画の後）。null は設定の fixed.stage_headings。 */
  stage_headings?: [string, string, string, string] | null;
  /** executor が 02 の結果（invalidate_turn_ids、replace_point_turn_ids）で取り消したターン。 */
  cancelled_turn_ids?: string[];
}

export function emptyInputs(): DirectorInputs {
  return {
    link_attached: true,
    slots: {
      A: { ready: [], failed: [], active_playback: null, available: true },
      B: { ready: [], failed: [], active_playback: null, available: true },
    },
    playback_events: [],
    interjection: { kind: 'none', voiced: false },
    user: { speaking: false, permitted_to_speak: false, started_ack: null, voiced_ms_since_onset: 0, last_voice_at: null },
    user_utterance: null,
    turn_arrivals: [],
    turn_failures: [],
    plan: { state: 'none', can_start_early: false, plan_id: null, source: null },
    points: [],
    correction_suggestions: [],
    content_done: { intake: false, discussion: false },
    intake_readback_due: false,
    markers: [],
    board_picks: [],
    woz: [],
    content_credits: [],
  };
}

export function initialDirectorState(init: { condition: TwoAiCondition; correction_mode: 'researcher' | 'auto'; feeds_generation: boolean }, now: number): DirectorState {
  return {
    condition: init.condition,
    correction_mode: init.correction_mode,
    feeds_generation: init.feeds_generation,
    phase: 'intake',
    phase_started_at: now,
    discussion_started_at: null,
    content_elapsed_ms: 0,
    discussion_stage: null,
    stage_started_at: null,
    board: { version: 0, shown_card_ids: [], mode: 'building', picked_card_id: null },
    pick: { opened_at: null, done: false },
    marker: { last_counted_at: null, count: 0 },
    intake: { first_question_spoken: false, readback_spoken: false },
    script_variant: 'original',
    sub: { kind: 'idle' },
    turn_seq: 0,
    discussion_turns: 0,
    floor: null,
    next: null,
    last_turn_ended_at: null,
    last_speaker: null,
    interjection: null,
    interjection_count: 0,
    attempts: [],
    attempt_count: 0,
    gaze: { A: 'user', B: 'user' },
    points: {},
    points_forced: false,
    plan: { early_requested: false, final_requested: false, wait_started_at: null, fillers_spoken: 0 },
    correction: { applied_point_ids: [], handled_suggestion_ids: [] },
    response: { started_at: null, silence_prompts: 0, last_user_voice_at: null, time_up_at: null, correction_recorded: false },
    ack_offer: null,
    woz_paused: false,
    consecutive_failures: 0,
    queue: [],
    last_step_at: null,
    credited_interjection_ids: [],
    plan_fallback_used: false,
    closing_requested: null,
    response_extra: { question_played_ms: 0, user_speech_ms: 0, voice_confirmed: false, ack_offered: false, ack_given: false, ended_by: null },
    retraction: { trigger: 'end', speak: false, next_index: 0, done: false },
    feed_wait: false,
    awaiting_uptake_until: null,
    discussion_closing: false,
    recent_marker_ats: [],
    wall_overrun_handled: false,
    interjection_wall_ms: 0,
    interjections_by_stage: [0, 0, 0, 0],
    queue_lines: {},
    ack_cache: null,
    discussion_closing_source: 'auto_content',
  };
}
