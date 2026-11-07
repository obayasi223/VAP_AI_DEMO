/**
 * 会話履歴の参照・更新インターフェース（保存の本体は J）。
 * AI の発話は実際に声として出た箇所だけを入れる（仕様§2-4、§5）。予定していた全文を入れる口は用意しない。
 */
import type { SpokenTextPrecision } from './common';
import type { Unsubscribe } from './providers';

export interface UserHistoryEntry {
  role: 'user';
  text: string;
  segment_id: number;
  transcript_revision: number;
  is_final: boolean;
  audio_frame_end: number;
}

export interface AssistantHistoryEntry {
  role: 'assistant';
  /** spoken_text と同じ内容。参照側が role を問わず読めるようにする。 */
  text: string;
  audio_playback_id: number;
  spoken_text_precision: SpokenTextPrecision;
  interrupted: boolean;
  origin:
    | { kind: 'response' }
    | { kind: 'candidate'; candidate_id: string; candidate_version: number };
}

export type HistoryEntry = UserHistoryEntry | AssistantHistoryEntry;

/** 参照側（LLM の入力の組み立てなど）。 */
export interface ConversationHistoryReader {
  /** 古い順の不変の写し。 */
  snapshot(): readonly HistoryEntry[];
  /** 更新のたびに増える版番号。 */
  version(): number;
  onChange(listener: (version: number) => void): Unsubscribe;
}

/** 更新側（配線は J）。 */
export interface ConversationHistoryWriter {
  /** 同じ segment_id は置き換える（interim の更新と final の確定）。revision が古ければ無視する。 */
  upsertUserSegment(entry: Omit<UserHistoryEntry, 'role'>): void;
  /** 発話済みの部分だけを確定する。同じ audio_playback_id は1回だけ。 */
  commitAssistantSpoken(entry: Omit<AssistantHistoryEntry, 'role'>): void;
}

export type ConversationHistory = ConversationHistoryReader & ConversationHistoryWriter;
