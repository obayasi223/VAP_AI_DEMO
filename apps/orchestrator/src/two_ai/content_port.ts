/**
 * 01（進行役）と 02（話し合いの中身）の境界（docs/design/two_ai/06_型の確定版.md §6）。型だけ。
 * WP0 が作る。WP0 の後は WP1 と WP2 の合意なしに変えない（変えるときは 06 §12 の手順）。
 *
 * 中身の時計 content_elapsed_ms（06 §6.0）：中身のターン（turn_kind が discussion、point、point_elaboration）の content_ms と、
 * その前の gap_hint_ms の和。受け止め、resume の戻りの句と言い直し、uptake、bridge（保留の時間切れのつなぎ）、本人の番、
 * 計画の待ち、つなぎ、段の台詞、待ちの超過は足さない。
 */
import type {
  AiId,
  BoardCardView,
  BoardDependency,
  DiscussionStage,
  PointKind,
  ScriptVariant,
  TwoAiAiState,
  TwoAiCondition,
  TwoAiPhase,
  TwoAiTextOrigin,
  TwoAiTurnKind,
  UserHistoryEntry,
  UtteranceClass,
} from '@llm-vap/contracts';
import type { ResponsePromptBuilder } from '../speech/response_prompt';

/** 01 に渡す 1 ターン。 */
export interface DiscussionTurn {
  /** 01 が採番して渡した ID をそのまま返す。 */
  turn_id: string;
  /** 話し合いの通し番号（点も数える）。 */
  index: number;
  speaker: AiId;
  turn_kind: TwoAiTurnKind;
  text: string;
  sentences: string[];
  text_origin: TwoAiTextOrigin;
  origin:
    | { kind: 'beat'; beat_id: string; generated: 'llm' | 'fallback' }
    | { kind: 'point'; point_id: string; turn_key: string }
    | { kind: 'fixed'; fixed_id: string };
  point_id: string | null;
  /** 点のターンで話す凍結の版（original／corrected）。点の外は null。 */
  point_variant: ScriptVariant | null;
  /** 話し合いの段。discussion の外のターン（段の台詞、最後の段など）は null。 */
  discussion_stage: DiscussionStage | null;
  /** このターンの start_turn の直後に板へ出すカード。なければ null。 */
  board_card: (BoardCardView & { depends_on: BoardDependency }) | null;
  /** このターンの前の間（種は plan_id。条件で変わらない）。 */
  gap_hint_ms: number;
  est_duration_ms: number;
  fact_state: 'normal' | 'slipped' | 'corrected';
  /**
   * resume だけ：先頭の戻りの句の文字数と、言い直した（既に声に出た）部分の文字数。接触秒数の「新しい部分」と中身の時計に使う。
   * 誤った停止の resume は bridge_chars = 0。
   */
  repeat: { bridge_chars: number; restated_chars: number } | null;
  /** 体験の旗：このターンが受けた本人の割り込み。旗が無効なら常に空。 */
  fed_interjection_ids: string[];
  /** 体験の旗：本人の発言に応じることを指示したターン。 */
  feed_turn: boolean;
}

export type PlanSource = 'prepared' | 'generated' | 'researcher_edited' | 'fallback_outline';

export type PlanResult =
  | {
      ok: true;
      plan_id: string;
      plan_hash: string;
      source: PlanSource;
      fact_slip: 'available' | 'unavailable';
      fact_slip_source: 'prior' | 'ledger' | 'none';
      control_inference: 'available' | 'unavailable';
      points_ok: boolean;
    }
  | { ok: false; reason: string };

export interface PlanStatus {
  state: 'none' | 'preparing_early' | 'early_ready' | 'finalizing' | 'ready' | 'failed';
  /** 台帳に core があり、早い計画を始めてよい。 */
  can_start_early: boolean;
  plan_id: string | null;
  source: PlanSource | null;
}

export interface PendingPointView {
  point_id: string;
  kind: PointKind;
  speaker: AiId;
  /** in_stage の点はその段。ほかは見込みの段。 */
  discussion_stage: DiscussionStage | null;
  state: 'unscheduled' | 'queued' | 'in_block' | 'done' | 'unavailable';
  /** 中身の時計での見込みの開始（ms）。決まらなければ null。 */
  expected_start_ms: number | null;
  /** 点のブロック全体の見込みの長さ（凍結文の文字数 ÷ chars_per_sec）。 */
  expected_block_ms: number;
}

export interface CorrectionSuggestion {
  suggestion_id: string;
  point_id: string;
  asr_segment_ids: number[];
  status: 'pending' | 'done' | 'failed';
  /** done のときだけ値。 */
  corrects: boolean | null;
  evidence_span: string;
}

export interface InterjectionPlan {
  /** 止められた AI。AI 同士の間なら直前に話した AI。誤った停止では受け止めをしないので使わない。 */
  ack_speaker: AiId;
  /**
   * after_ack：戻りの句＋中断した文の頭から（point_id は元のまま）。
   * false_onset：戻りの句なしで中断した文の頭から（repeat.bridge_chars = 0）。
   * AI 同士の間なら null（用意済みの次のターンをそのまま話す）。
   */
  resume: DiscussionTurn | null;
  keep_queue: true;
}

export interface CorrectionResult {
  uptake: DiscussionTurn;
  /** 準備済みの生のターンで、材料に取り違えた値を含むもの（取り消して頼み直す）。 */
  invalidate_turn_ids: string[];
  /** 準備済みの点のターンで、訂正後の版に替えるもの（01 が取り消し、次の nextTurn で訂正後の版が来る）。 */
  replace_point_turn_ids: string[];
  /** 中断したターンが fact_slip のブロックに属するなら true：その resume は出さず、uptake が戻りを兼ねる。 */
  drop_resume: boolean;
}

/** 最後の段の作り直し（両条件で同じ文と板）。 */
export interface ClosingRebuild {
  /** turn_kind 'rebuild'、text_origin 'frozen'。最初のターンの開始で板を出す。 */
  turns: DiscussionTurn[];
  /** 訂正後の板（4 枚）。 */
  board: (BoardCardView & { depends_on: BoardDependency })[];
}

export interface RetractionScriptView {
  /** 撤回の文（事実の名指し、推論の名指し、過程の説明）。end_of_session ではこの順に話す。 */
  lines: { ai_id: AiId; text: string }[];
  point_ids: string[];
  /**
   * 推論の文の形。spoken：元の版の F.1 か F.2 を 1 ms でも話した。not_spoken：元の推論を話していない。
   * none：fact_slip が unavailable（過程の説明だけ）。02 は onTurnPlayed の point_variant と played_ms から決める。
   */
  inference_form: 'spoken' | 'not_spoken' | 'none';
  sha256: string;
}

/**
 * 判定の保留をやめて resume しない理由（06 §6.2 の M2）。
 * correction_hold_timeout：保留の上限（hold_until）。correction_judgment_failed：補助の判定が failed（第 4 回の決定。wp0_notes.md の R4-1）。
 */
export type AbandonResumeReason = 'correction_hold_timeout' | 'correction_judgment_failed';

export interface DiscussionContent {
  // ---- 開始 ----
  init(input: {
    condition: TwoAiCondition;
    feeds_generation: boolean;
    self_run: boolean;
    correction_mode: 'researcher' | 'auto';
    retraction_timing: 'end_of_session' | 'after_measures';
  }): void;

  // ---- intake（既存の応答の経路で話す）----
  promptBuilder(phase: 'intake', ai_id: AiId): ResponsePromptBuilder;
  responder(phase: 'intake'): AiId;
  /** 核の読み上げの番か（intake の min_sec の後、台帳に core がある、まだ読み上げていない）。 */
  intakeReadbackDue(view: { elapsed_ms: number }): boolean;
  /** intake の定型（first_question は intake の始め、core_readback は上の時機）。 */
  intakeLine(line: 'first_question' | 'core_readback'): { ai_id: AiId; line_id: string; text: string };

  // ---- 計画 ----
  /** 01 が intake の plan_start_sec 以降、planStatus().can_start_early が真になった最初の tick で 1 回だけ呼ぶ。 */
  preparePlan(signal: AbortSignal): Promise<PlanResult>;
  /** 01 が intake の終わりで 1 回呼ぶ。 */
  finalizePlan(signal: AbortSignal): Promise<PlanResult>;
  /** 同期。計画の待ちの上限で 01 が呼ぶ。早い計画 → 台本の prepared → 予備の筋書き（fallback_outline）の順。 */
  fallbackPlan(reason: string): PlanResult;
  planStatus(): PlanStatus;

  // ---- 話し合い ----
  startDiscussion(): void;
  /** 4 つの見出し（台本の stages、なければ設定の fixed.stage_headings）。条件で変えない。 */
  stageHeadings(): [string, string, string, string];
  /** 次の 1 ターン（話者は 02 が決める）。LLM の失敗は内部で 1 回作り直し、だめなら凍結の fallback を返す。 */
  nextTurn(
    request: { turn_id: string; content_elapsed_ms: number; discussion_elapsed_ms: number },
    signal: AbortSignal,
  ): Promise<DiscussionTurn>;
  /** 同期。01 が max_wait_for_ready_ms で待ちを打ち切ったとき。その拍の凍結の fallback_text。 */
  fallbackTurn(turn_id: string): DiscussionTurn;
  pendingPoints(view: { content_elapsed_ms: number }): PendingPointView[];
  /** 段の上限に来たとき 01 が呼ぶ。以後の nextTurn は未開始の点のブロックを先に出す。 */
  forcePendingPoints(): void;
  planInterjection(input: {
    interrupted_turn_id: string | null;
    spoken_prefix: string;
    last_speaker: AiId;
    mode: 'after_ack' | 'false_onset';
  }): InterjectionPlan;
  onTurnPlayed(input: { turn_id: string; audio_playback_id: number; spoken_text: string; played_ms: number; completed: boolean }): void;
  /** ① の割り込みが分類されたら毎回呼ぶ（旗に関係なく。旗の判断は 02）。false_onset では呼ばない。 */
  onInterjectionClosed(input: {
    interjection_id: string;
    text: string;
    asr_segment_ids: number[];
    classification: UtteranceClass;
    during_point_id: string | null;
  }): { invalidate_turn_ids: string[]; feed_target: 'next_live_turn' | 'after_point_block' | null };
  /**
   * 判定の保留が resume なしで終わったとき（時間切れ、または補助の判定が failed）、01 が呼ぶ（進行役の行動 abandon_resume）。
   * 02 は中断したターンの残りを言い直さず、そのブロックの次のターンから続ける（訂正の後なら corrected_turns、そうでなければ中立の中身）。
   * AI 同士の間の割り込みなら interrupted_turn_id は null で、何もしない。
   * 戻り値の credited_ms：捨てた F.1、F.2（未再生のもの）の凍結文（元の版）の文字数 ÷ chars_per_sec_estimate の和（06 §6.0、§6.1。第 5 回 M2）。
   * executor は次の tick の DirectorInputs.content_credits で進行役へ渡し、進行役が中身の時計に 1 回だけ足す。
   */
  abandonResume(interrupted_turn_id: string | null, reason: AbandonResumeReason): { credited_ms: number };
  /** interrupted_turn_id は、訂正のきっかけの割り込みで止めたターン（next_boundary や間の割り込みなら null）。 */
  applyCorrection(
    point_id: string,
    trigger: 'woz_researcher' | 'auto_confirmed',
    timing: 'in_window' | 'next_boundary',
    interrupted_turn_id: string | null,
  ): CorrectionResult;

  // ---- 定型と最後の段 ----
  ackTemplates(): { template_id: string; text: string }[];
  /** 段の台詞（条件は init で受けた値を使う）。なければ null。intake の open は intakeLine('first_question') を使う。 */
  phaseLine(phase: TwoAiPhase, edge: 'open' | 'close'): { ai_id: AiId; line_id: string; text: string } | null;
  /** 計画の待ちのつなぎ（条件で変えない）。index 0 は待ちに入ったとき（話者 A）、1 は second_filler_after_ms（話者 B）。 */
  planFiller(index: 0 | 1): { ai_id: AiId; line_id: string; text: string } | null;
  /** 最後の段の some 型の問い（名前を含まない固定の文。受け止めと同じく開始時に合成して保持する）。 */
  closingQuestion(): { ai_id: AiId; line_id: string; text: string };
  responseLine(kind: 'more'): { ai_id: AiId; line_id: string; text: string };
  /** 最後の段の作り直し。台本どおりで、訂正の有無と条件で変えない。 */
  closingRebuild(): ClosingRebuild;
  /** next_step の案内（prompt：選んでもらう、confirm：選んだ後、timeout：時間切れ）。 */
  pickLine(line: 'prompt' | 'confirm' | 'timeout'): { ai_id: AiId; line_id: string; text: string };
  retractionScript(): RetractionScriptView;

  // ---- 本人の発話 ----
  onUserUtterance(entry: UserHistoryEntry, context: { phase: TwoAiPhase; interjection_id: string | null }): void;
  /** 確定文がなければ途中の文で、文がなければ voiced_ms だけで分類する。決まらなければ unknown。 */
  classifyUserUtterance(input: { text: string; is_final: boolean; voiced_ms: number }): UtteranceClass;
  /** 未解決と解決済みのすべて（01 が tick で読む）。 */
  correctionSuggestions(): CorrectionSuggestion[];
  framingState(ai_id: AiId): { state: TwoAiAiState; version: string };
  isDone(phase: 'intake' | 'discussion', view: { elapsed_ms: number; content_elapsed_ms: number }): boolean;
  scriptVariant(): ScriptVariant;
  dispose(): void;

  // ---- 応答版（設定 experience.mode: 'responsive'）。任意の口で、統制版では null を返す（呼び手は今の同期の経路のまま）----
  /**
   * request_resume の後（planInterjection の resume を受けて）：resume の頭に本人の割り込みへの短い応答を入れた turn を返す。
   * 応答が作れなければ（時間切れ、失敗、文がない）元の resume を返す。応答版でない、false_onset なら null。
   */
  completeResume?(input: { resume: DiscussionTurn; interjection_id: string; mode: 'after_ack' | 'false_onset' }, signal: AbortSignal): Promise<DiscussionTurn> | null;
  /** 最後の段の作り直し（closingRebuild）の前：板の生成を待つ（上限は設定）。応答版でなければ null。 */
  prepareClosing?(signal: AbortSignal): Promise<void> | null;
}

