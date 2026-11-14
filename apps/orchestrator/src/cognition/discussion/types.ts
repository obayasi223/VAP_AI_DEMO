/**
 * 02（話し合いの生成）の内部の型（docs/design/two_ai/02_話し合いの生成.md §2.1）。
 * 01 との境界の型（DiscussionTurn など）は apps/orchestrator/src/two_ai/content_port.ts（06 §6）が正本で、ここには写さない。
 * AiId と条件は契約から import する（局所の Condition は作らない。第 4 回 m-7）。
 */
import type {
  AiId,
  BoardDependency,
  DiscussionStage,
  PointKind,
  PointScheduleCheck,
  PointTrigger,
  RetractionSpec,
  TwoAiPersona,
} from '@llm-vap/contracts';

/** 発言の根拠。span は本人の発話（ASR の確定文）からの逐語の抜き出し。照合に通らない項目は捨てる。 */
export interface Evidence {
  span: string;
  segment_ids: number[];
}

export interface LedgerItem {
  /** 'opt_1' など。台帳の版をまたいで保つ。 */
  id: string;
  text: string;
  evidence: Evidence[];
  confirmed: boolean;
}

export interface LedgerFact extends LedgerItem {
  kind: 'date' | 'number' | 'status' | 'place' | 'other';
  /** 取り違えに使ってよいか。中立で、本人の能力・健康・家族・指導教員・人間関係に触れない事実だけ true。 */
  slip_eligible: boolean;
}

export interface DroppedOption extends LedgerItem {
  reason: string;
}

export type SensitiveKind =
  | 'health'
  | 'family_conflict'
  | 'person_evaluation'
  | 'relationship'
  | 'finance_private'
  | 'self_harm'
  | 'other';

export interface ProblemLedger {
  ledger_version: number;
  aspect: string;
  user_name: string;
  user_name_reading: string;
  core: LedgerItem | null;
  options: LedgerItem[];
  dropped_options: DroppedOption[];
  facts: LedgerFact[];
  values: LedgerItem[];
  /** 触れない話題。該当する項目は話し合いの入力から外す。 */
  sensitive: { kind: SensitiveKind; evidence: Evidence }[];
  source: 'intake' | 'prepared' | 'intake+prepared';
}

/** 人格は契約の TwoAiPersona（06 §9.4）。 */
export type Persona = TwoAiPersona;

export type BeatKind = 'open' | 'develop' | 'react' | 'question' | 'contrast' | 'close';

export interface Beat {
  beat_id: string;
  stage: DiscussionStage;
  speaker: AiId;
  kind: BeatKind;
  intent: string;
  ledger_refs: string[];
  target_chars: [number, number];
  /** 時間に合わせて飛ばしてよい（段 4 だけ）。 */
  optional: boolean;
  fallback_text: string;
  /** 訂正後の fallback_text。取り違えた事実に触れない拍は fallback_text と同じ。 */
  fallback_text_corrected: string;
  /** 予備の筋書きの拍は LLM を使わない（text_origin: fallback）。 */
  live: boolean;
}

export interface FrozenTurn {
  /** 'C.0'、'F.1'、'K.2'、'F.uptake' など。 */
  turn_key: string;
  speaker: AiId;
  text: string;
  /** 文の区切り（割り込み後の言い直しの単位）。 */
  sentences: string[];
  chars: number;
}

export interface InferenceBlock {
  premise_fact_id: string;
  premise_statement: string;
  steps: [string, string];
  conclusion: string;
  target_option: string;
  stakes: 'low';
}

export interface PointBlock {
  point_id: string;
  kind: PointKind;
  speaker: AiId;
  trigger: PointTrigger;
  turns: FrozenTurn[];
  /** 訂正後の版（同じ本数、同じ turn_key と話者）。取り違えに依らない点は turns と同じ文。 */
  corrected_turns: FrozenTurn[];
  /** fact_slip だけ。訂正後の台本で、受け止めの後に入れる 1 ターン。 */
  uptake: FrozenTurn | null;
  inference: InferenceBlock | null;
  /** fact_slip だけ。検査に使う（取り違えた文と値、正しい文）。 */
  slip: { fact_id: string; slip_statement: string; slip_value: string; correct_statement: string } | null;
  /** C の語（framing_C だけ）。生のターンで禁止し、安全の検査で照らす。 */
  c_terms: string[];
  slots: Record<string, string>;
  source: 'prepared' | 'generated' | 'researcher_edited';
  distance_rating: { value: number; by: 'rater' | 'llm_self' } | null;
}

/** 作れなかった点（06 §9.5）。 */
export interface UnavailablePoint {
  point_id: string;
  kind: PointKind;
  speaker: AiId;
  reason: 'no_neutral_fact' | 'no_second_fact' | 'fallback_outline';
}

export interface BoardCard {
  card_id: string;
  order: 1 | 2 | 3 | 4;
  stage: DiscussionStage;
  depends_on: BoardDependency;
  text: string;
  corrected_text: string;
}

export interface DiscussionPlan {
  plan_id: string;
  plan_hash: string;
  ledger_version: number;
  source: 'prepared' | 'generated' | 'researcher_edited' | 'fallback_outline';
  personas: [Persona, Persona];
  beats: Beat[];
  points: PointBlock[];
  unavailable_points: UnavailablePoint[];
  stage_headings: [string, string, string, string];
  board: BoardCard[];
  rebuild_turns: FrozenTurn[];
  /** 穴を埋めた撤回の文（inference と inference_unspoken の両方を持ち、end で一方を選ぶ）。fact_slip がなければ null。 */
  retraction: RetractionSpec | null;
  /** 撤回の過程の説明（fact_slip がないときもこれだけは言う）。 */
  retraction_process: string;
  target_duration_sec: number;
  close_at_sec: number;
  fact_slip_source: 'prior' | 'ledger' | 'none';
  schedule_check: PointScheduleCheck;
  prompt_versions: Record<string, string>;
  models: Record<string, string>;
  /** 計画の時点の台帳の核と取り違えの事実（早い計画を再使用できるかの判定）。 */
  basis: { core: string | null; slip_fact_id: string | null; control_fact_id: string | null };
  /** C の候補と離れ具合（研究画面の表示用。generated のときだけ）。 */
  c_candidates: { text: string; distance: number }[];
  /**
   * 段ごとの計画（02 §2.5.1）で、凍結の時点ではコードの定型の拍が入っていて、話し合いの間に後から埋める段。
   * 1 回で作った計画と予備の筋書きでは空。plan_id と plan_hash は最初の凍結のもの（埋めた拍は two_ai.plan の記録に残る）。
   */
  staged_stages: DiscussionStage[];
}

/** 取り違えと対照に使う事実（06 §9.5 の順で選ぶ）。 */
export interface ChosenFact {
  fact_id: string;
  kind: 'date' | 'number' | 'status' | 'place' | 'other';
  text: string;
  slip_hint: string | null;
}
