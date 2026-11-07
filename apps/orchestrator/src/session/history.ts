/**
 * 会話履歴の本体（レーン J。契約は packages/contracts/src/history.ts）。
 * AI の発話は SpeechGenerator が「声として出た」と報告した部分だけを入れる（仕様§2-4、§5）。
 * 予定していた全文を入れる口はない。
 */
import type {
  AssistantHistoryEntry,
  ConversationHistory,
  HistoryEntry,
  Unsubscribe,
  UserHistoryEntry,
} from '@llm-vap/contracts';

export class SessionHistory implements ConversationHistory {
  private readonly entries: HistoryEntry[] = [];
  private readonly listeners = new Set<(version: number) => void>();
  private currentVersion = 0;
  /** 同じ audio_playback_id の2回目の確定。不具合の印なので数えて残す。 */
  duplicateAssistantCommits = 0;

  snapshot(): readonly HistoryEntry[] {
    return this.entries.map((entry) => ({ ...entry }));
  }

  version(): number {
    return this.currentVersion;
  }

  onChange(listener: (version: number) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  upsertUserSegment(entry: Omit<UserHistoryEntry, 'role'>): void {
    const index = this.entries.findIndex((e) => e.role === 'user' && e.segment_id === entry.segment_id);
    const next: UserHistoryEntry = { role: 'user', ...entry };
    if (index >= 0) {
      const current = this.entries[index] as UserHistoryEntry;
      if (entry.transcript_revision < current.transcript_revision) return;
      if (current.text === next.text && current.is_final === next.is_final) return;
      this.entries[index] = next;
    } else {
      if (entry.text === '') return;
      this.entries.push(next);
    }
    this.bump();
  }

  commitAssistantSpoken(entry: Omit<AssistantHistoryEntry, 'role'>): void {
    if (this.entries.some((e) => e.role === 'assistant' && e.audio_playback_id === entry.audio_playback_id)) {
      this.duplicateAssistantCommits += 1;
      return;
    }
    // 1文字も声にならなかった発話は履歴に入れない（相手に聞こえていない）。
    if (entry.text === '') return;
    this.entries.push({ role: 'assistant', ...entry });
    this.bump();
  }

  private bump(): void {
    this.currentVersion += 1;
    for (const listener of this.listeners) listener(this.currentVersion);
  }
}

/**
 * 利用者の発話を segment 単位の1文にする。STT の text は ASR 区間（final）ごとなので、
 * 同じ segment の区間を asr_segment_id の順に連結する。
 */
export class UserUtterances {
  private readonly segments = new Map<number, Map<number, string>>();

  /** 結果を取り込み、その segment の全文を返す。 */
  update(segment_id: number, asr_segment_id: number, text: string): string {
    let parts = this.segments.get(segment_id);
    if (!parts) {
      parts = new Map();
      this.segments.set(segment_id, parts);
    }
    parts.set(asr_segment_id, text);
    return [...parts.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, value]) => value)
      .join('');
  }
}
