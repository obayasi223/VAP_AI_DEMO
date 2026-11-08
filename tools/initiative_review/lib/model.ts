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
