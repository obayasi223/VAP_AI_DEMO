/**
 * 研究者画面（apps/web/app/research）と Node の /research の WS の制御メッセージ（I2 で追加）。
 * イベント（ResearchEvent）は従来どおり 1 テキスト枠に 1 件で下る。ここの制御メッセージは `type` を持ち、
 * `event` を持たないので、受け手は `type` の有無で区別する。
 *
 *  - 下り research.config: 接続の直後に 1 回。p の添字（policy.vap.p_ai_index）を画面へ伝える。
 *  - 上り research.note: 研究者のメモ。Node は今のセッションのログへ research.note イベントとして書く。
 *  - 下り research.note.ack: メモを書けたか。書けなければ理由（セッションがない、契約に合わない）。
 *
 * どちらの端も TypeScript なので JSON Schema は生成しない（Python は読まない）。
 */
import { z } from 'zod';
import { MonotonicMs, NonEmptyString, NonNegativeMs, Probability, TranscriptRevision, WallClock } from './common';
import { Policy } from './policy';
import { Invitation, VapFreshness } from './turn';

/** メモの本文の上限（文字数）。ログの 1 行が大きくなりすぎないように。 */
export const RESEARCH_NOTE_MAX_CHARS = 4000;

export const ResearchNoteText = z.string().trim().min(1).max(RESEARCH_NOTE_MAX_CHARS);

export const ResearchNoteMessage = z.strictObject({
  type: z.literal('research.note'),
  /** 画面が採番する。ack と JSONL の行を結ぶ。 */
  note_id: NonEmptyString,
  text: ResearchNoteText,
  /** 研究者のブラウザの壁時計（未補正）。ログの時刻は Node の受信時刻で、こちらは参考。 */
  client_wall_clock: WallClock,
});
export type ResearchNoteMessage = z.infer<typeof ResearchNoteMessage>;

export const ResearchToNode = z.discriminatedUnion('type', [ResearchNoteMessage]);
export type ResearchToNode = z.infer<typeof ResearchToNode>;

export const ResearchConfigMessage = z.strictObject({
  type: z.literal('research.config'),
  policy_id: NonEmptyString,
  /** p_now[p_ai_index] が AI。vad は契約どおり常に ch1=mic（利用者）、ch2=sys（AI）。 */
  p_ai_index: z.union([z.literal(0), z.literal(1)]),
  direction_status: z.enum(['provisional', 'measured']),
  condition: NonEmptyString,
});
export type ResearchConfigMessage = z.infer<typeof ResearchConfigMessage>;

export const ResearchNoteAck = z.discriminatedUnion('status', [
  z.strictObject({
    type: z.literal('research.note.ack'),
    note_id: NonEmptyString,
    status: z.literal('logged'),
    session_id: NonEmptyString,
  }),
  z.strictObject({
    type: z.literal('research.note.ack'),
    /** 読めなかったメッセージでは null。 */
    note_id: NonEmptyString.nullable(),
    status: z.enum(['no_session', 'invalid']),
    detail: NonEmptyString,
  }),
]);
export type ResearchNoteAck = z.infer<typeof ResearchNoteAck>;

export const NodeToResearch = z.union([ResearchConfigMessage, ResearchNoteAck]);
export type NodeToResearch = z.infer<typeof NodeToResearch>;

// ---- 開発用の調整画面（/tune、追加のみ） ------------------------------------------
//
// /research の WS に `?tune=1` を付けて接続したときだけ、Node は次の 2 つも下す（/research の画面には送らない）。
//  - research.policy: 接続の直後に 1 回。orchestrator が実際に使っている方策（上書きを含む）。閾値の線に使う。
//  - research.turn_diagnostic: 約 100ms ごとと turn.allowed のたび。TurnManager の state から作った判断の材料の読み出しで、
//    判断そのものではない（判断の正本は turn.allowed）。分岐の成立は state と最新の vap.state から計算し直した値。

/** 判断の材料の1行（Appendix A の分岐など）。holds が null は評価していない（VAP が使えない、など）。 */
export const TurnBranchDiagnostic = z.strictObject({
  /** 例: L56、L59、L64、L67、L74、invitation、U1、ready、fragment、degraded。 */
  id: NonEmptyString,
  label: NonEmptyString,
  holds: z.boolean().nullable(),
  /** 値と閾値（例: `p_now=0.62>0.5`）。 */
  detail: z.string(),
});
export type TurnBranchDiagnostic = z.infer<typeof TurnBranchDiagnostic>;

/** TurnManager の state から作った読み出し（調整画面向け）。session_id は今のセッション。 */
export const TurnDiagnosticBody = z.strictObject({
  t_monotonic_ms: MonotonicMs,
  vap_freshness: VapFreshness,
  ai_phase: z.enum(['silent', 'starting', 'playing', 'stopping']),
  /** 制御が使う利用者の発話中（デバウンス後）。 */
  user_speaking: z.boolean(),
  /** AI 側に揃えた値。VAP が fresh でなければ null。 */
  p_now_ai: Probability.nullable(),
  p_future_ai: Probability.nullable(),
  /** vad[0]（利用者）。 */
  vad_user: Probability.nullable(),
  /** 利用者の発話の終わり（L57 の user_speak_end_time）からの経過。未初期化は null。 */
  gap_ms: NonNegativeMs.nullable(),
  /** L67 の user_turn_end_time からの経過。 */
  since_turn_end_ms: NonNegativeMs.nullable(),
  /** L67、L74、招待で使う最小の間（MIN_GAP_TIME と start_guard の大きい方）。 */
  min_gap_ms: NonNegativeMs,
  /** 制御が使っている completion の値（turngpt_output。値がなければ 0）。 */
  completion_p: Probability,
  completion_revision: TranscriptRevision.nullable(),
  /** turnGptTimeout(completion_p)。 */
  yield_timeout_ms: NonNegativeMs,
  /** L74 の実際の待ち（start_guard を含む）。 */
  completion_wait_ms: NonNegativeMs,
  permitted_to_speak: z.boolean(),
  /** 準備済みの応答があるか（want_to_speak の種類）。 */
  want_to_speak: NonEmptyString,
  invitation: Invitation,
  branches: z.array(TurnBranchDiagnostic),
  /** 最後の turn.allowed の reason（TurnManager が書いた正本）。 */
  last_turn_allowed_reason: z.string().nullable(),
});
export type TurnDiagnosticBody = z.infer<typeof TurnDiagnosticBody>;

export const ResearchTurnDiagnosticMessage = TurnDiagnosticBody.extend({
  type: z.literal('research.turn_diagnostic'),
  session_id: NonEmptyString,
});
export type ResearchTurnDiagnosticMessage = z.infer<typeof ResearchTurnDiagnosticMessage>;

/** 方策の上書き（config/policy.ja.local.json など）の記録。keys は上書きした葉の路（例 turn.start_guard.min_gap_ms）。 */
export const PolicyOverrideInfo = z.strictObject({
  file: NonEmptyString,
  keys: z.array(NonEmptyString),
});
export type PolicyOverrideInfo = z.infer<typeof PolicyOverrideInfo>;

export const ResearchPolicyMessage = z.strictObject({
  type: z.literal('research.policy'),
  policy: Policy,
  policy_file: NonEmptyString,
  override: PolicyOverrideInfo.nullable(),
});
export type ResearchPolicyMessage = z.infer<typeof ResearchPolicyMessage>;

/** `?tune=1` の接続にだけ下る制御メッセージ。/research の画面は受けない。 */
export const NodeToTune = z.union([ResearchConfigMessage, ResearchNoteAck, ResearchPolicyMessage, ResearchTurnDiagnosticMessage]);
export type NodeToTune = z.infer<typeof NodeToTune>;

// ---- 開発用の HTTP の口（apps/orchestrator/src/dev、/tune の録音の再生）の応答の形 ------------------
// どちらの端も TypeScript なので型だけを置く（検証は Node 側でする）。

/** 方策の葉（スキーマから動的に列挙した値の項目）。 */
export interface TunePolicyLeaf {
  /** 例 turn.constants.VAP_PNOW_YIELD。 */
  path: string;
  kind: 'number' | 'integer' | 'boolean' | 'enum' | 'string' | 'string_array';
  nullable: boolean;
  /** 親（または自分）が省略できる節か。省略できる節の路（例 turn.start_guard）。 */
  optional_parent: string | null;
  minimum: number | null;
  maximum: number | null;
  options: string[] | null;
  description: string | null;
}

export interface TuneSessionSummary {
  session_id: string;
  started_wall_clock: string | null;
  closed: boolean | null;
  condition: string | null;
  policy_id: string | null;
  provider_classes: Record<string, string>;
  events_bytes: number;
  /** manifest の policy_override（あれば）。 */
  policy_override: PolicyOverrideInfo | null;
}

export interface TuneStart {
  t: number;
  audio_playback_id: number;
  decision_source: string;
  reason: string;
  gap_ms: number | null;
  p_now: number | null;
  completion_p: number | null;
}

export interface TuneSpan {
  start: number;
  end: number;
  label: string;
}

export interface TuneTurnChange {
  t: number;
  allowed: boolean;
  source: string;
  reason: string;
}

export interface TuneGazeChange {
  t: number;
  target: string;
  reason: string;
}

export interface TuneMetricSet {
  starts: number;
  /** 開始後 1.5 秒以内に、開始より後の音声で利用者の認識文が伸びた開始の数。 */
  mid_utterance_starts: number;
  /** 同じ窓に VAP の vad[0] が閾値以上になった開始の数（参考）。 */
  mid_utterance_starts_vad: number;
  /** 利用者の声（vad[0]）の最後から開始までの遅れ（ms）。開始ごと。 */
  delays_ms: (number | null)[];
  /** 前の AI の発話の終わりから利用者の声がないまま始めた開始の数。 */
  consecutive_ai_starts: number;
  gaze_averts: number;
  /** 逸らした長さ（ms）。終わらずにセッションが終わったものは含めない。 */
  gaze_avert_ms: number[];
  interrupts: number;
}

export interface TuneDivergence {
  t: number;
  kind: string;
  detail: string;
}

export interface TuneDiagnosticSample extends TurnDiagnosticBody {}

export interface TuneInitiativeCount {
  /** 記録の initiative の llm.request の数。 */
  recorded_requests: number;
  /** 記録の起動条件で数え直した数（決定性の確認）。 */
  recount_with_recorded_trigger: number | null;
  /** 画面の起動条件で数え直した数。 */
  recount_with_edited_trigger: number | null;
  recorded_trigger: unknown;
  edited_trigger: unknown;
  /** 数え直しの前提。LLM の判定の結果は分からない（NONE を返す代役で数える）。 */
  assumptions: string[];
  error: string | null;
}

export interface TuneReplayResult {
  session_id: string;
  policy_id: string;
  tick_ms: number;
  t_start: number;
  t_end: number;
  recorded: {
    starts: TuneStart[];
    ai_speech: TuneSpan[];
    turn_changes: TuneTurnChange[];
    gaze: TuneGazeChange[];
    metrics: TuneMetricSet;
  };
  replayed: {
    starts: TuneStart[];
    ai_speech: TuneSpan[];
    turn_changes: TuneTurnChange[];
    gaze: TuneGazeChange[];
    prepares: { t: number; trigger: string; matched_recorded: boolean }[];
    metrics: TuneMetricSet;
    /** 約 100ms ごとの判断の材料（再計算側）。 */
    diagnostics: TuneDiagnosticSample[];
  };
  /** 記録の開始と再計算の開始の対応（決定性の確認）。 */
  start_match: { matched: number; recorded_only: number; replayed_only: number; max_abs_shift_ms: number | null };
  divergences: TuneDivergence[];
  /** 再生で置いた仮定（画面に明記する）。 */
  assumptions: string[];
  initiative: TuneInitiativeCount;
  warnings: string[];
}
