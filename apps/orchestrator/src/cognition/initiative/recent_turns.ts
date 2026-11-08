/**
 * 生成段とタイミング段に渡す「直近の会話」（今話している人の発話より前の、人と AI の発話）。
 * 今の発話は StableTranscriptView の安定テキストが担うので、ここには入れない。
 * 根拠の扱いは docs/initiative_v3_design.md（過去のターンは文脈で、単独では根拠にならない）。
 */
import type { HistoryEntry } from '@llm-vap/contracts';

export interface RecentContextLimits {
  max_turns: number;
  max_chars_per_turn: number;
}

export interface RecentTurn {
  role: 'user' | 'ai';
  text: string;
  /** AI の発話が途中で切れた（人が割り込んだ）。 */
  interrupted: boolean;
}

/**
 * 履歴（古い順）から直近の会話を作る。今の segment の人の発話は除く。
 * AI の発話は実際に声として出た部分だけ（履歴の契約）。長いターンは後ろを残す（直前のつながりを優先する）。
 */
export function recentTurnsFromHistory(
  entries: readonly HistoryEntry[],
  current_segment_id: number,
  limits: RecentContextLimits,
): RecentTurn[] {
  const turns: RecentTurn[] = [];
  for (const entry of entries) {
    if (entry.role === 'user' && entry.segment_id >= current_segment_id) continue;
    const text = entry.text.trim();
    if (text.length === 0) continue;
    turns.push({
      role: entry.role === 'user' ? 'user' : 'ai',
      text: text.length > limits.max_chars_per_turn ? `…${text.slice(-limits.max_chars_per_turn)}` : text,
      interrupted: entry.role === 'assistant' && entry.interrupted,
    });
  }
  return limits.max_turns === 0 ? [] : turns.slice(-limits.max_turns);
}
