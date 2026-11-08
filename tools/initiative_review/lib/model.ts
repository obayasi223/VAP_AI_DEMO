/**
 * 評価画面が扱う形（読み込みの層の出力）。events.jsonl の形とは切り離し、ここだけを画面と保存が見る。
 * イベントの形が変わっても、この形を保てば画面と保存は変えなくてよい。
 */

/** 値の出どころ。model_output は画面で必ず「LLM 生成」と出す。 */
export type Provenance = 'model_output' | 'verified' | 'code';

export interface Field {
  key: string;
  label: string;
  value: string | null;
  null_reason: string | null;
  provenance: Provenance;
  /** Verified のときの検証方法。 */
  method?: string;
}

/** その判定の入力に使われた時点の、安定した ASR の文字（stt の記録から再構成）。 */
export interface StableSnapshot {
  transcript_revision: number | null;
  segment_id: number | null;
  segments: { asr_segment_id: number; text: string; unstable: string; final: boolean }[];
  text: string;
}

export interface DecisionStep {
  /** イベントの名前（1段の判定か、生成段か、タイミング段か）。棄てられた要求は持たない。 */
  event?: 'initiative.decision' | 'initiative.desire' | 'initiative.timing';
  request_id: string;
  decision: string;
  /** 判定が届いた時刻（received_at）。実測。 */
  t_ms: number;
  /** LLM へ送った時刻（sent_at）。実測。 */
  sent_at: number | null;
  candidate_version: number | null;
  model_version: string | null;
  prompt_version: string | null;
  /** 内容の側（生成段）。 */
  content: Field[];
  /** タイミングの側（タイミング段）。 */
  timing: Field[];
  stable: StableSnapshot;
  /** LLM へ渡した入力の原文（llm.request）。 */
  llm_input: string | null;
  /** LLM の生の出力（llm.response）。 */
  llm_output: string | null;
}

export interface TimelineRow {
  t_ms: number;
  /** 元のイベント名。 */
  event: string;
  label: string;
  detail: string | null;
  provenance: Provenance;
}

export interface InhaleRecord {
  phase: string;
  sent_at: number | null;
  started_at: number | null;
  visible: boolean | null;
  ended_at: number | null;
}

export interface SpeechRecord {
  audio_playback_id: number | null;
  candidate_version: number | null;
  started_at: number | null;
  ended_at: number | null;
  spoken_text: string | null;
  /** その発話の turn.outcome（観測に基づく推定のラベルと主な値）。古いログには無い。 */
  outcome: SpeechOutcome | null;
}

/** 発話の結果（turn.outcome）の表示用の抜き出し。 */
export interface SpeechOutcome {
  labels: string[] | null;
  null_reason: string | null;
  fields: { label: string; value: string }[];
}

/** 通常応答の材料（渡した版）と実際に話した文の比較。話していない、記録がないときは spoken_outcome が null ／ not_spoken。 */
export interface ReflectionView {
  t_ms: number;
  candidate_version: number | null;
  given_text: string | null;
  prompt_version: string | null;
  given_at: number | null;
  audio_playback_id: number | null;
  /** 話した部分だけ（割り込みは途中まで）。話していなければ空。 */
  spoken_text: string;
  /** spoken ／ partly_spoken ／ not_spoken。応答の結果の記録がないときは null。 */
  spoken_outcome: string | null;
  interrupted: boolean;
  /** コードの文字の一致からの推定。判定できないときは null。 */
  estimated_reflected: boolean | null;
  estimate_reason: string | null;
  /** 推定の値と基準を文字にしたもの（例: 包含率 0.71 / 基準 0.5）。 */
  estimate_text: string | null;
}

/**
 * 吸気を見せた候補の結末。「延期（話す時点を先送りした）」と「内容の撤回（言う必要がなくなった）」を分けて出す。
 *  - content_withdrawn: 後続の発話を見た生成段の WITHDRAW（内容の撤回）。
 *  - already_said: AI がすでに話した内容だった（コードの照合か、生成段の分類）。
 *  - not_spoken_other: 内容は撤回していないが話せずに終わった（通常応答が先に始まった、期限切れ、音声の失敗など）。
 *  - unresolved: 記録の終わりまで結末がない。
 */
export type AfterCueEnding = 'spoken' | 'content_withdrawn' | 'already_said' | 'not_spoken_other' | 'unresolved';

export interface AfterCueView {
  /** 吸気の後に延期（DEFERRED）を通ったか。結末とは独立に見る。 */
  deferred: boolean;
  deferred_at: number | null;
  /** 吸気より後に内容を更新した回数（候補の版の差）。 */
  revisions: number;
  ending: AfterCueEnding;
  ending_at: number | null;
  /** 生成段の撤回の分類（LLM の出力）。 */
  withdraw_kind: string | null;
  /** コード由来の原因（CandidateCause）。 */
  code_cause: string | null;
  /** 画面に出す一行（例: 吸気 → 延期 → 内容の撤回（前提が変わった））。 */
  label: string;
}

export type ItemKind = 'candidate' | 'none' | 'dropped';
export type RateAxis = 'content' | 'timing' | 'wait_withdraw';

export interface ReviewItem {
  /** 評価の保存に使う鍵。セッション内で安定（candidate_id か request_id から作る）。 */
  key: string;
  kind: ItemKind;
  session_id: string;
  /** 一覧の並びと表示の時刻（最初の判定が届いた時刻）。 */
  t_ms: number;
  /** その判定の入力の時点（sent_at）。音声はここから再生する。 */
  anchor_t_ms: number;
  condition: string | null;
  conversation_type: string;
  prompt_versions: string[];
  headline: string;
  candidate_id: string | null;
  final_state: string | null;
  decisions: DecisionStep[];
  timeline: TimelineRow[];
  inhale: InhaleRecord[];
  speech: SpeechRecord[];
  /** 通常応答に渡した材料と、実際に話した文との比較（反映は推定で、確定ではない）。 */
  reflection: ReflectionView[];
  /** 吸気を見せた候補の結末。吸気のなかった候補と、候補でない判定は null。 */
  after_cue: AfterCueView | null;
  /** 表示する前後の会話（lines の id）。 */
  context_before: string[];
  context_after: string[];
  /** 音声の秒位置（0 秒＝音声枠 0）。対応が取れなければ null。 */
  audio_sec: number | null;
  rate_axes: RateAxis[];
}

export interface TranscriptLine {
  id: string;
  role: 'user' | 'ai';
  t_ms: number;
  end_t_ms: number | null;
  text: string;
  /** 利用者の ASR の確定（final）か。AI は常に true。 */
  final: boolean;
  /** AI の発話の種類（response／candidate）。 */
  origin: string | null;
  candidate_id: string | null;
  asr_segment_id: number | null;
  /** 音声の秒位置。対応が取れなければ null。 */
  audio_sec: number | null;
}

export interface SessionMeta {
  session_id: string;
  started_wall_clock: string | null;
  condition: string | null;
  conversation_type: string;
  persona_id: string | null;
  prompt_versions: string[];
  /** セッションのフォルダにある音声（ファイル名）。 */
  audio_files: string[];
}

export interface ReviewSession {
  meta: SessionMeta;
  items: ReviewItem[];
  lines: TranscriptLine[];
  /** 音声の時刻の対応（t_monotonic_ms → 秒）。無ければ null。 */
  has_audio_map: boolean;
  /** 読めなかった行やマニフェストの問題など。 */
  warnings: string[];
}

export interface ItemFilter {
  conversation_type?: string | undefined;
  prompt_version?: string | undefined;
}
