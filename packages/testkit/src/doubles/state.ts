import { CandidateConflictError } from '@llm-vap/contracts';
import type {
  AssistantHistoryEntry,
  CandidateContentPatch,
  CandidateRecord,
  CandidateRef,
  CandidateRegistration,
  CandidateState,
  CandidateStore,
  ConversationHistory,
  HistoryEntry,
  Unsubscribe,
  UserHistoryEntry,
} from '@llm-vap/contracts';
import { Listeners } from '../listeners';

/** 会話履歴の test double。規則は契約のとおりで、保存はしない（本体は J）。 */
export class InMemoryConversationHistory implements ConversationHistory {
  private readonly entries: HistoryEntry[] = [];
  private readonly changes = new Listeners<number>();
  private currentVersion = 0;

  snapshot(): readonly HistoryEntry[] {
    return this.entries.map((e) => ({ ...e }));
  }

  version(): number {
    return this.currentVersion;
  }

  onChange(listener: (version: number) => void): Unsubscribe {
    return this.changes.add(listener);
  }

  upsertUserSegment(entry: Omit<UserHistoryEntry, 'role'>): void {
    const index = this.entries.findIndex(
      (e) => e.role === 'user' && e.segment_id === entry.segment_id,
    );
    const next: UserHistoryEntry = { role: 'user', ...entry };
    if (index >= 0) {
      const current = this.entries[index] as UserHistoryEntry;
      if (entry.transcript_revision < current.transcript_revision) return;
      this.entries[index] = next;
    } else {
      this.entries.push(next);
    }
    this.bump();
  }

  commitAssistantSpoken(entry: Omit<AssistantHistoryEntry, 'role'>): void {
    const duplicate = this.entries.some(
      (e) => e.role === 'assistant' && e.audio_playback_id === entry.audio_playback_id,
    );
    if (duplicate) throw new Error(`playback ${entry.audio_playback_id} is already committed`);
    this.entries.push({ role: 'assistant', ...entry });
    this.bump();
  }

  private bump(): void {
    this.currentVersion += 1;
    this.changes.emit(this.currentVersion);
  }
}

const RESOLVED: readonly CandidateState[] = ['SPOKEN', 'WITHDRAWN'];

/** 候補ストアの test double。本体は E2a。状態遷移の妥当性は判定しない。 */
export class InMemoryCandidateStore implements CandidateStore {
  private readonly records = new Map<string, CandidateRecord>();
  private counter = 0;

  register(input: CandidateRegistration): CandidateRef {
    this.counter += 1;
    const candidate_id = `c_${String(this.counter).padStart(4, '0')}`;
    this.records.set(candidate_id, {
      ...input,
      candidate_id,
      candidate_version: 1,
      state: 'INTENT_READY',
      updated_at: input.decided_at,
    });
    return { candidate_id, candidate_version: 1 };
  }

  get(candidate_id: string): CandidateRecord | null {
    const record = this.records.get(candidate_id);
    return record ? { ...record } : null;
  }

  list(options?: { include_resolved?: boolean }): readonly CandidateRecord[] {
    const all = [...this.records.values()].map((r) => ({ ...r }));
    return options?.include_resolved ? all : all.filter((r) => !RESOLVED.includes(r.state));
  }

  update(
    candidate_id: string,
    expected_version: number,
    patch: CandidateContentPatch,
    updated_at: number,
  ): CandidateRef {
    const record = this.require(candidate_id);
    if (record.candidate_version !== expected_version) {
      throw new CandidateConflictError(
        `${candidate_id}: expected version ${expected_version}, current ${record.candidate_version}`,
      );
    }
    const candidate_version = record.candidate_version + 1;
    this.records.set(candidate_id, { ...record, ...patch, candidate_version, updated_at });
    return { candidate_id, candidate_version };
  }

  setState(candidate_id: string, state: CandidateState, updated_at: number): CandidateRecord {
    const record = this.require(candidate_id);
    const next = { ...record, state, updated_at };
    this.records.set(candidate_id, next);
    return { ...next };
  }

  private require(candidate_id: string): CandidateRecord {
    const record = this.records.get(candidate_id);
    if (!record) throw new Error(`unknown candidate ${candidate_id}`);
    return record;
  }
}
