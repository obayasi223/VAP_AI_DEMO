/**
 * 2 体の AI の話し合い（two_ai）のイベントの中身（docs/design/two_ai/06_型の確定版.md §4.3、§4.4）。
 *
 * ここには封筒を除いた項目（shape）だけを置く。封筒をかぶせた schema（TwoAiTurnEvent など）は events.ts が
 * eventSchema で作り、ResearchEvent の共用体と EVENT_NAMES に入れる。events.ts の封筒をここから読むと
 * 循環の import になる（events.ts → two_ai_events.ts → events.ts）ので、向きを 1 つにした（wp0_notes.md の D1）。
 */
import { z } from 'zod';
import {
  AiId,
  AsrSegmentId,
  AudioPlaybackId,
  BoardDependency,
  DiscussionStage,
  JsonValue,
  Maybe,
  MonotonicMs,
  NonEmptyString,
  NonNegativeInt,
  NonNegativeMs,
  PointKind,
  PointTrigger,
  Probability,
  ScriptVariant,
  TwoAiAiState,
  TwoAiPhase,
  TwoAiTextOrigin,
  TwoAiTurnKind,
  UtteranceClass,
} from './common';

// ---- 01 が出す --------------------------------------------------------------

export const TwoAiPhaseChangedShape = {
  /** session_start は null。 */
  from: TwoAiPhase.nullable(),
  to: TwoAiPhase,
  source: z.enum(['session_start', 'auto_timer', 'auto_content', 'woz', 'error']),
  reason: NonEmptyString,
  elapsed_in_from_ms: Maybe(NonNegativeMs),
  /** end は null（null_reason: 'no_limit'）。 */
  planned_duration_ms: Maybe(NonNegativeMs),
};

export const TwoAiTurnShape = {
  turn_id: NonEmptyString,
  /** セッションの通し番号（段をまたぐ）。 */
  turn_index: NonNegativeInt,
  turn_kind: TwoAiTurnKind,
  stage: z.enum(['requested', 'arrived', 'prepared', 'started', 'ended', 'failed', 'cancelled', 'skipped', 'late', 'fallback_substituted']),
  /** requested では 02 がまだ話者を返していないので null。 */
  speaker: AiId.nullable(),
  point_id: NonEmptyString.nullable(),
  audio_playback_id: Maybe(AudioPlaybackId),
  /** requested では null。 */
  text_origin: TwoAiTextOrigin.nullable(),
  /** started のとき。 */
  gap_ms: Maybe(NonNegativeMs),
  gap_hint_ms: Maybe(NonNegativeMs),
  /** started と late のとき。 */
  waited_for_ready_ms: Maybe(NonNegativeMs),
  /** ended のとき（samples_written ÷ 16）。 */
  played_ms: Maybe(NonNegativeMs),
  /** ended のとき、中身の時計に足した長さ（06 §6.0）。中身の時計に入らないターンは 0。 */
  content_ms: Maybe(NonNegativeMs),
  discussion_stage: DiscussionStage.nullable(),
  /** 点のターンで、凍結の 2 版のどちらを話したか。点の外は null。 */
  point_variant: ScriptVariant.nullable(),
  /** このターンの開始で板に出したカード。 */
  board_card_id: NonEmptyString.nullable(),
  interrupted: z.boolean(),
  /** 体験の旗の「本人の発言を受けるターン」（06 §6 の DiscussionTurn）。 */
  feed_turn: z.boolean(),
  reason: NonEmptyString,
};

export const TwoAiInterjectionShape = {
  interjection_id: NonEmptyString,
  stage: z.enum([
    'onset', 'ignored_by_condition', 'stop_requested', 'stopped', 'held_next_turn', 'user_ended', 'classified',
    'ack_started', 'ack_ended', 'correction_wait', 'resumed', 'abandoned',
    /** vad は上がったが onset の条件に届かなかった（枝 (1)）。 */
    'sub_threshold',
  ]),
  decision_source: z.enum(['vap', 'fallback', 'woz']),
  interrupted_ai: AiId.nullable(),
  during_point_id: NonEmptyString.nullable(),
  audio_playback_id: Maybe(AudioPlaybackId),
  p_now_user: Maybe(Probability),
  p_future_user: Maybe(Probability),
  vad_user: Maybe(Probability),
  mic_dbfs: Maybe(z.number()),
  first_voiced_at: Maybe(MonotonicMs),
  latency_ms: Maybe(NonNegativeMs),
  /** classified のときだけ値。 */
  classification: UtteranceClass.nullable(),
  /** 分類に使った文：final、interim（確定前）、none（文なし。voiced_ms だけ）。 */
  classification_basis: z.enum(['final', 'interim', 'none']).nullable(),
  reason: NonEmptyString,
};

/**
 * outcome の定義（06 §4.3 の M3）：
 * yielded：① で止めて（または AI 同士の間で次を待たせて）、本人が話し、受け止めをした。
 * backchannel：① で止めたが、分類が相づち。受け止めなしで resume（戻りの句あり）。
 * false_onset：① で止めたが、onset から false_onset_window_ms の間に声も文もなかった。
 * onset_no_speech：② で onset を記録したが、同じ窓の中で声も文もなかった。何も止めていない。
 * logged_only：② で onset を記録し、声か文があった。何も止めていない。
 * abandoned：段の終わり、中止、切断で閉じた。
 */
export const TwoAiInterjectionEpisodeShape = {
  interjection_id: NonEmptyString,
  outcome: z.enum(['yielded', 'backchannel', 'false_onset', 'onset_no_speech', 'logged_only', 'abandoned']),
  /** false_onset と onset_no_speech の判定に使った値（ほかは窓の中の値をそのまま残す）。 */
  false_onset_check: z.strictObject({ window_ms: NonNegativeMs, voiced_ms: NonNegativeMs, had_text: z.boolean() }),
  decision_source: z.enum(['vap', 'fallback', 'woz']),
  interrupted_ai: AiId.nullable(),
  during_point_id: NonEmptyString.nullable(),
  onset_at: MonotonicMs,
  user_voice_start_at: Maybe(MonotonicMs),
  stop_requested_at: Maybe(MonotonicMs),
  stopped_at: Maybe(MonotonicMs),
  /** user_voice_start_at → stopped_at。 */
  stop_latency_ms: Maybe(NonNegativeMs),
  gaze_to_user_at: z.strictObject({ A: Maybe(MonotonicMs), B: Maybe(MonotonicMs) }),
  user_speech_end_at: Maybe(MonotonicMs),
  ack: z
    .strictObject({
      ai_id: AiId,
      template_id: NonEmptyString,
      audio_playback_id: AudioPlaybackId,
      synthesized_ms: NonNegativeMs,
      played_ms: NonNegativeMs,
      truncated: z.boolean(),
    })
    .nullable(),
  reonsets_during_ack: NonNegativeInt,
  correction: z
    .strictObject({
      point_id: NonEmptyString,
      trigger: z.enum(['woz_researcher', 'auto_confirmed']),
      timing: z.enum(['in_window', 'next_boundary']),
    })
    .nullable(),
  /**
   * 訂正の判定の保留（06 §6.2 の M2）。対象外の割り込みは null。
   * ended_by：corrected 訂正が確定（resume なし）、not_correction auto の判定が否（ふつうの resume）、
   * timeout 上限か auto の判定の失敗（failed）（hold_bridge と abandon_resume。失敗かどうかは judgment_after_ms と two_ai.correction_suggested の status で分かる）、
   * woz_resume 研究者の WoZ resume（研究者の経路の「否」）、abandoned 段の終わりや中止。
   * 研究者の経路では、補助の判定（否も失敗も）は保留を終わらせない（06 §6.2。第 4 回 M1）。
   */
  correction_hold: z
    .strictObject({
      started_at: MonotonicMs,
      hold_until: MonotonicMs,
      ended_at: MonotonicMs,
      ended_by: z.enum(['corrected', 'not_correction', 'timeout', 'woz_resume', 'abandoned']),
      /** 本人の発話の終わりから、確定文と判定が届くまで（届かなければ null）。 */
      stt_final_after_ms: Maybe(NonNegativeMs),
      judgment_after_ms: Maybe(NonNegativeMs),
      /** 時間切れ（auto の failed を含む）で捨てた F.1、F.2 の見込みの長さ。中身の時計に 1 回足した値（06 §6.0。第 5 回 M2）。timeout 以外は null。 */
      credited_ms: Maybe(NonNegativeMs),
    })
    .nullable(),
  /** onset の前後 marker.near_window_ms に印があった（印のボタンの物音で止まった疑い）。② でも付ける。 */
  near_marker: z.boolean(),
  resumed_at: Maybe(MonotonicMs),
  asr_segment_ids: z.array(AsrSegmentId),
  /** 体験の旗で生成に入れたか（旗が無効なら常に false）。 */
  fed: z.boolean(),
};

export const TwoAiPointShape = {
  point_id: NonEmptyString,
  point_kind: PointKind,
  speaker: AiId,
  stage: z.enum(['scheduled', 'started', 'elaboration', 'turn_exposure', 'completed', 'missed', 'forced', 'unavailable', 'switched_to_corrected']),
  turn_id: NonEmptyString.nullable(),
  trigger: PointTrigger,
  discussion_stage: DiscussionStage.nullable(),
  /** at_sec／at_frac の目標（中身の時計）。in_stage と after_turn は null。 */
  planned_at: Maybe(MonotonicMs),
  /** started のときの中身の時計。 */
  content_elapsed_ms: Maybe(NonNegativeMs),
  /** started のとき。 */
  deviation_ms: Maybe(z.number()),
  /** turn_exposure、completed、missed のとき。 */
  exposure_new_ms: Maybe(NonNegativeMs),
  exposure_total_ms: Maybe(NonNegativeMs),
  elaborated_turns: NonNegativeInt,
  reason: NonEmptyString,
};

export const TwoAiPointExposureShape = {
  point_id: NonEmptyString,
  point_kind: PointKind,
  speaker: AiId,
  /** その点の point_id を持つ発話の samples_written の合計 ÷ 16。 */
  exposure_total_ms: NonNegativeMs,
  /** total から、戻りの句（bridge_ms）と言い直した部分（repeated_ms）を引いた「新しい部分」。AC2(d) はこれで比べる。 */
  exposure_new_ms: NonNegativeMs,
  bridge_ms: NonNegativeMs,
  repeated_ms: NonNegativeMs,
  repeated_ms_source: z.enum(['alignment', 'char_ratio', 'none']),
  planned_exposure_ms: Maybe(NonNegativeMs),
  segments: z.array(
    z.strictObject({
      audio_playback_id: AudioPlaybackId,
      turn_id: NonEmptyString,
      turn_kind: TwoAiTurnKind,
      played_ms: NonNegativeMs,
      new_ms: NonNegativeMs,
      cut: z.enum(['none', 'interjection', 'woz', 'session_end', 'correction']),
      variant: ScriptVariant,
    }),
  ),
  elaborations_done: NonNegativeInt,
  elaborations_planned: NonNegativeInt,
  /**
   * framing_C と control_inference：全ターンを話し終えたら true（割り込みでは打ち切らない。AC2）。
   * fact_slip：全ターンを話し終えたら true。訂正で残りを訂正後の版に替えたときも、替えた版を話し終えたら true（cut_by_correction: true）。
   */
  complete: z.boolean(),
  /** fact_slip で、訂正により元の版を途中で打ち切った。 */
  cut_by_correction: z.boolean(),
};

export const TwoAiScriptShape = {
  /** recorded_only：応答の段の訂正（記録だけ。uptake は言わない）。 */
  stage: z.enum(['switched', 'rejected', 'recorded_only']),
  /** 不明な point_id の rejected は null。 */
  point_id: NonEmptyString.nullable(),
  trigger: z.enum(['woz_researcher', 'auto_confirmed']),
  /** rejected：condition_respond_at_end、already_switched、point_not_started、phase、unknown_point、mode_not_auto。 */
  reason: NonEmptyString,
  decided_at: MonotonicMs,
  timing: z.enum(['in_window', 'next_boundary', 'response_phase']).nullable(),
  asr_segment_ids: z.array(AsrSegmentId),
  invalidated_turn_ids: z.array(NonEmptyString),
  /** 取り消した準備済みの点のターン（訂正後の版に作り直す。M2）。 */
  replaced_point_turn_ids: z.array(NonEmptyString),
  /** 中断した F のターンの言い直しをやめたか（uptake が戻りを兼ねる。M2）。 */
  resume_dropped: z.boolean(),
  uptake_turn_id: NonEmptyString.nullable(),
};

export const TwoAiAiStateShape = {
  speaker: AiId,
  turn_id: NonEmptyString.nullable(),
  state: TwoAiAiState,
  state_version: NonEmptyString,
};

export const TwoAiAnomalyShape = {
  kind: z.enum([
    'double_speech', 'turn_not_ready', 'tts_failed', 'llm_failed', 'report_timeout', 'slot_unavailable',
    'detector_degraded', 'ack_cache_missing', 'plan_wait_timeout', 'point_over_limit',
    /** 本人の番が user_floor_max_ms を超えた（研究画面に警告）。 */
    'user_floor_long',
    /** 段や板の版が合わない選択（参加者画面の不具合の印）。 */
    'board_pick_rejected',
  ]),
  speaker: AiId.nullable(),
  detail: NonEmptyString,
};

export const TwoAiPlanWaitShape = {
  stage: z.enum(['started', 'filler', 'ready', 'timeout', 'fallback_used', 'paused']),
  waited_ms: NonNegativeMs,
  plan_source: z.enum(['early', 'final', 'prepared', 'fallback_outline']).nullable(),
  reason: NonEmptyString,
};

/** 最後の段の前半（some 型の問い → 本人 → 受け止め）。長さは両条件で同じ（② に追加の時間はない）。 */
export const TwoAiResponseWindowShape = {
  planned_ms: NonNegativeMs,
  /** 問い（closing_question、保持した音声）の再生の長さ。両条件で同じ音声。 */
  question_played_ms: NonNegativeMs,
  /** 問いの再生の終わり。 */
  started_at: MonotonicMs,
  ended_at: MonotonicMs,
  ended_by: z.enum(['timer', 'woz', 'session_end']),
  overrun_ms: NonNegativeMs,
  user_speech_ms: NonNegativeMs,
  silence_prompts: NonNegativeInt,
  correction_recorded: z.boolean(),
  /** 時間切れの後の受け止めをしたか。応答の段で本人の声が確かめられたときだけ true。両条件で同じ規則。 */
  ack_given: z.boolean(),
};

/**
 * 段を閉じた理由（段の完了の記録）。next_stage：次の段の最初のターンが始まった。content_done：02 の中身が尽きた。
 * wall_max_sec：本人の参加の時間を引いた壁時計が discussion.max_sec に達した。absolute_limit：安全の上限（壁時計の絶対の上限）。
 * woz：研究者の操作。error：失敗で段を移した。
 */
export const TwoAiStageEndedBy = z.enum(['next_stage', 'content_done', 'wall_max_sec', 'absolute_limit', 'woz', 'error']);
export type TwoAiStageEndedBy = z.infer<typeof TwoAiStageEndedBy>;

/**
 * 段の中身が出たか（ended だけ。統合 2 の段の完了）。計画した点と板のカードが、その段で出たかを残す。
 * complete：計画した点がすべて completed（unavailable は数えない）で、計画したカードがすべて出た。
 * participation_ms：その段で、本人の参加にかかった壁時計（割り込み、受け止め、保留、言い直しの繰り返し、停止の遅れ、それに伴う間）。
 */
export const TwoAiStageCompletion = z.strictObject({
  complete: z.boolean(),
  ended_by: TwoAiStageEndedBy,
  /** その段で始めた中身のターン（discussion、point、point_elaboration、resume）の数。 */
  content_turns: NonNegativeInt,
  points_planned: z.array(NonEmptyString),
  points_completed: z.array(NonEmptyString),
  /** 計画のカード。計画が板を持たない（不明）なら null。 */
  cards_planned: z.array(NonEmptyString).nullable(),
  cards_shown: z.array(NonEmptyString),
  participation_ms: NonNegativeMs,
});
export type TwoAiStageCompletion = z.infer<typeof TwoAiStageCompletion>;

/** 話し合いの段の境界（刺激再生の頭出しに使う）。 */
export const TwoAiStageShape = {
  discussion_stage: DiscussionStage,
  edge: z.enum(['started', 'ended']),
  heading: NonEmptyString,
  /** started の最初のターン。ended は null。 */
  turn_id: NonEmptyString.nullable(),
  content_elapsed_ms: NonNegativeMs,
  /** 壁時計の経過（discussion_started_at から）。 */
  discussion_elapsed_ms: NonNegativeMs,
  /** ended だけ：段の中身が出たか（統合 2）。started は null。古いログにはない。 */
  completion: TwoAiStageCompletion.nullable().optional(),
};

/** 板の 1 枚（記録の版。参加者画面へ送る BoardCardView に depends_on と trigger_turn_ended を足したもの）。 */
export const TwoAiBoardCardRecord = z.strictObject({
  card_id: NonEmptyString,
  order: z.number().int().min(1).max(4),
  discussion_stage: DiscussionStage,
  variant: ScriptVariant,
  depends_on: BoardDependency,
  /**
   * カードの文。研究画面への配信の伏せ字（06 §4.6）では trigger_turn_ended が偽の間 '' になるので、空は
   * trigger_turn_ended: false のときだけ許す（refine。JSON Schema では空を許す形になる）。
   */
  text: z.string(),
  /** そのカードを出したターンの再生が終わったか。偽の間、研究画面へは text を伏せる（06 §4.6）。 */
  trigger_turn_ended: z.boolean(),
}).refine((c) => c.text.length > 0 || !c.trigger_turn_ended, {
  message: "board card text may be '' only while trigger_turn_ended is false (redacted, 06 §4.6)",
  path: ['text'],
});
export type TwoAiBoardCardRecord = z.infer<typeof TwoAiBoardCardRecord>;

/** 板の変化（参加者画面へ送った two_ai.board と同じ中身）。 */
export const TwoAiBoardShape = {
  board_version: NonNegativeInt,
  mode: z.enum(['building', 'rebuilt', 'pick', 'picked']),
  cards: z.array(TwoAiBoardCardRecord).max(4),
  trigger_turn_id: NonEmptyString.nullable(),
  /** shown：カードを出した、revealed：出したターンが終わった（研究画面へ文を出してよい）、ほかは mode の変化。 */
  reason: z.enum(['shown', 'revealed', 'rebuilt', 'pick_opened', 'picked', 'reattach']),
  picked_card_id: NonEmptyString.nullable(),
};

/** 印のボタン（両条件。記録だけ。AI は止めない）。時刻は client_t_ms を時計差で写す（time_basis.source: 'browser_rtt'）。 */
export const TwoAiMarkerShape = {
  marker_id: NonEmptyString,
  client_t_ms: NonNegativeMs,
  discussion_stage: DiscussionStage.nullable(),
  ai_speaking: AiId.nullable(),
  turn_id: NonEmptyString.nullable(),
  turn_kind: TwoAiTurnKind.nullable(),
  during_point_id: NonEmptyString.nullable(),
  played_ms_in_turn: Maybe(NonNegativeMs),
  content_elapsed_ms: Maybe(NonNegativeMs),
  user_speaking: z.boolean(),
  /** そのとき開いている割り込み（① の本人の番など）。 */
  interjection_id: NonEmptyString.nullable(),
  /** 間隔の下限（marker.min_interval_ms）より短い連打は記録するが印に数えない。 */
  counted: z.boolean(),
  handling: z.literal('recorded_only'),
};

/** next_step で板から 1 枚を選んだ（または時間切れ）。 */
export const TwoAiBoardPickedShape = {
  /** timeout は null。 */
  pick_id: NonEmptyString.nullable(),
  outcome: z.enum(['picked', 'timeout', 'rejected']),
  card_id: NonEmptyString.nullable(),
  card_variant: ScriptVariant.nullable(),
  card_depends_on: BoardDependency.nullable(),
  board_version: NonNegativeInt,
  /** pick の開始から。 */
  latency_ms: Maybe(NonNegativeMs),
  /** rejected：phase、unknown_card、stale_board、already_picked。 */
  reason: NonEmptyString,
};

/**
 * 当日の撤回。取り違えた事実と、その上の推論を名指しで取り消し、過程を説明する。
 * end_of_session：end の段で AI が話す（self_run とデモだけ）。after_measures：事後の測度の後に研究者が読む。
 */
export const TwoAiRetractionShape = {
  timing: z.enum(['end_of_session', 'after_measures']),
  trigger: z.enum(['end', 'aborted']),
  /** 撤回した fact_slip（なければ空。そのとき文は過程の説明だけ）。 */
  point_ids: z.array(NonEmptyString),
  /** after_measures は null。 */
  ai_id: AiId.nullable(),
  audio_playback_id: Maybe(AudioPlaybackId),
  played_ms: Maybe(NonNegativeMs),
  /** 撤回の文（06 §9.3 RetractionSpec を埋めたもの）のハッシュ。 */
  script_sha256: NonEmptyString,
  /**
   * 撤回の文そのもの（retractionScript().lines）。JSONL では 1 行以上（log_check、AC20）。
   * 研究画面への配信では伏せ字で [] になりうるので、スキーマは空を許す。
   */
  lines: z.array(z.strictObject({ ai_id: AiId, text: NonEmptyString })),
  inference_form: z.enum(['spoken', 'not_spoken', 'none']),
};

/**
 * 同期の印（06 §4.3、第 4 回 M4。時機の表は 06 §4.7）。参加者画面が白い四角を出すきっかけのメッセージを Node が送ったのと同じ tick に、
 * executor が 1 回出す。封筒の t_monotonic_ms は送った時刻。再接続の直後の送り直しでは出さない。
 */
export const TwoAiSyncMarkShape = {
  /** セッションの中の通し番号（1 から）。録画の印の n 番目と、この seq が n の行を合わせる。 */
  seq: z.number().int().min(1),
  /** きっかけ（06 §4.7 の表の行）。 */
  trigger: z.enum(['intake', 'stage_1', 'stage_2', 'stage_3', 'stage_4', 'response', 'next_step', 'end']),
  /** 送った時刻の壁時計（Date.now()、ms）。録画の時刻と合わせる参考に使う。 */
  t_wall_ms: NonNegativeInt,
};

// ---- 02 が出す --------------------------------------------------------------

export const TwoAiLedgerShape = {
  stage: z.enum(['updated', 'item_rejected', 'update_failed']),
  ledger_version: NonNegativeInt,
  item_ids: z.array(NonEmptyString),
  reason: NonEmptyString,
};

export const TwoAiPlanShape = {
  stage: z.enum(['requested', 'frozen', 'failed', 'reused']),
  trigger: z.enum(['early', 'final', 'regenerate', 'fallback']),
  plan_id: NonEmptyString.nullable(),
  plan_hash: NonEmptyString.nullable(),
  source: z.enum(['prepared', 'generated', 'researcher_edited', 'fallback_outline']).nullable(),
  /** 凍結した全文（JSON）。研究画面への配信では伏せる（06 §4.6）。 */
  plan: JsonValue.nullable(),
  fact_slip_source: z.enum(['prior', 'ledger', 'none']).nullable(),
  schedule_check: z
    .strictObject({
      ok: z.boolean(),
      latest_point_end_sec: z.number().min(0),
      close_at_sec: z.number().min(0),
    })
    .nullable(),
  prompt_versions: z.record(NonEmptyString, NonEmptyString),
  models: z.record(NonEmptyString, NonEmptyString),
  latency_ms: Maybe(NonNegativeMs),
  reason: NonEmptyString,
};

export const TwoAiGenerationShape = {
  turn_id: NonEmptyString,
  beat_id: NonEmptyString.nullable(),
  stage: z.enum(['generated', 'fallback', 'gap_overrun', 'compressed', 'regenerated']),
  prompt_version: NonEmptyString,
  model: NonEmptyString,
  latency_ms: Maybe(NonNegativeMs),
  chars: NonNegativeInt,
  fed_interjection_ids: z.array(NonEmptyString),
  feed_turn: z.boolean(),
  /** 旗で C の語の禁止を外したか（旗が無効なら常に false）。 */
  c_ban_lifted: z.boolean(),
  reason: NonEmptyString,
};

export const TwoAiSafetyBlockedShape = {
  rule: NonEmptyString,
  stage: z.enum(['plan', 'turn', 'interjection_feed']),
  /** 研究画面への配信では伏せる。 */
  text: z.string(),
  action: z.enum(['regenerate', 'fallback', 'excluded']),
};

export const TwoAiCorrectionSuggestedShape = {
  suggestion_id: NonEmptyString,
  point_id: NonEmptyString,
  asr_segment_ids: z.array(AsrSegmentId),
  status: z.enum(['pending', 'done', 'failed']),
  /** done のときだけ値。 */
  corrects: z.boolean().nullable(),
  evidence_span: z.string(),
  method: NonEmptyString,
  latency_ms: Maybe(NonNegativeMs),
};

export const TwoAiInterjectionFedShape = {
  interjection_id: NonEmptyString,
  asr_segment_ids: z.array(AsrSegmentId),
  chars: NonNegativeInt,
  accepted: z.boolean(),
  excluded_reason: NonEmptyString.nullable(),
  invalidated_turn_ids: z.array(NonEmptyString),
  /** 次の生のターンで受けるか、点のブロックの後の最初の生のターンで受けるか。 */
  target: z.enum(['next_live_turn', 'after_point_block']),
};

// ---- render.health（06 §4.4）------------------------------------------------

/** 時刻は client_t_ms を時計差で写し、time_basis.source: 'browser_rtt'（audio.report と同じ扱い）。 */
export const RenderHealthShape = {
  fps_p5: z.number().min(0),
  fps_median: z.number().min(0),
  frame_ms_p95: NonNegativeMs,
  long_tasks: NonNegativeInt,
  renderer: z.string().max(200),
  avatars: z.number().int().min(0).max(2),
  pixel_ratio: z.number().positive(),
};

/** 01 の進行役が emit の行動で出すイベントの名前（06 §4.5 の表の 1 行目。render.health を除く。06 §7.3 の TwoAiEventDraft の元）。 */
export const TWO_AI_DIRECTOR_EVENT_NAMES = [
  'two_ai.phase_changed',
  'two_ai.turn',
  'two_ai.interjection',
  'two_ai.interjection_episode',
  'two_ai.point',
  'two_ai.point_exposure',
  'two_ai.script',
  'two_ai.ai_state',
  'two_ai.anomaly',
  'two_ai.plan_wait',
  'two_ai.response_window',
  'two_ai.stage',
  'two_ai.board',
  'two_ai.marker',
  'two_ai.board_picked',
  'two_ai.retraction',
] as const;

/** executor が出すイベント（06 §4.5 の表の 2 行目。§4.7 の表のメッセージを送った tick に出す。進行役の emit は使わない）。 */
export const TWO_AI_EXECUTOR_EVENT_NAMES = ['two_ai.sync_mark'] as const;

/** 02 が出すイベントの名前（06 §4.5 の表の 3 行目）。 */
export const TWO_AI_CONTENT_EVENT_NAMES = [
  'two_ai.ledger',
  'two_ai.plan',
  'two_ai.generation',
  'two_ai.safety_blocked',
  'two_ai.correction_suggested',
  'two_ai.interjection_fed',
] as const;

/** 新しいイベントの名前すべて（23 種と render.health。06 §4.3）。 */
export const TWO_AI_EVENT_NAMES = [
  ...TWO_AI_DIRECTOR_EVENT_NAMES,
  ...TWO_AI_EXECUTOR_EVENT_NAMES,
  ...TWO_AI_CONTENT_EVENT_NAMES,
  'render.health',
] as const;
