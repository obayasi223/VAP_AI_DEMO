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

/**
 * 履歴の並びの鍵。利用者の発話は segment_id、AI の発話はそれを始めた segment（AI の開始で増えた後の値）の直前。
 * AI の発話は再生の終わりに確定するので、話している間の利用者の発話（次の segment）より後に届くが、
 * 並びは「利用者 N → AI（N+1 の頭で開始）→ 利用者 N+1」にする。
 */
function orderKey(entry: { role: 'user' | 'assistant'; segment_id: number }): number {
  return entry.role === 'user' ? entry.segment_id * 2 : entry.segment_id * 2 - 1;
}

export class SessionHistory implements ConversationHistory {
  private readonly entries: HistoryEntry[] = [];
  /** entries と同じ並びの鍵（契約の型に segment を足さないため別に持つ）。 */
  private readonly keys: number[] = [];
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
      this.insert(next, orderKey({ role: 'user', segment_id: entry.segment_id }));
    }
    this.bump();
  }

  /**
   * started_in_segment は再生を始めた時点の segment_id（AI の開始で増えた後の値）。省略すると末尾へ置く。
   */
  commitAssistantSpoken(entry: Omit<AssistantHistoryEntry, 'role'>, started_in_segment?: number): void {
    if (this.entries.some((e) => e.role === 'assistant' && e.audio_playback_id === entry.audio_playback_id)) {
      this.duplicateAssistantCommits += 1;
      return;
    }
    // 1文字も声にならなかった発話は履歴に入れない（相手に聞こえていない）。
    if (entry.text === '') return;
    const key =
      started_in_segment === undefined
        ? Math.max(0, ...this.keys) + 1
        : orderKey({ role: 'assistant', segment_id: started_in_segment });
    this.insert({ role: 'assistant', ...entry }, key);
    this.bump();
  }

  /** 同じ鍵の中では届いた順。 */
  private insert(entry: HistoryEntry, key: number): void {
    let at = this.keys.length;
    while (at > 0 && (this.keys[at - 1] as number) > key) at -= 1;
    this.entries.splice(at, 0, entry);
    this.keys.splice(at, 0, key);
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
