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
import { NonEmptyString, WallClock } from './common';

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
