import { absent, present, type ResearchEvent, type TimeBasis } from '@llm-vap/contracts';
import type { LogFile, LogFileSystem } from '../../src/logging';

export const SESSION = 'session_test';
const ORCHESTRATOR: TimeBasis = { source: 'orchestrator', uncertainty_ms: present(0) };
export const BROWSER: TimeBasis = { source: 'browser_rtt', uncertainty_ms: present(2) };

type Draft = Record<string, unknown> & { event: string };

/** 共通項目を埋める。型の検査は緩くし、スキーマの検証は本体に任せる。 */
export function envelope(draft: Draft, t = 0, basis: TimeBasis = ORCHESTRATOR): ResearchEvent {
  return {
    schema_version: 1,
    t_monotonic_ms: t,
    wall_clock: new Date(Date.parse('2026-11-08T00:00:00.000Z') + t).toISOString(),
    session_id: SESSION,
    condition: 'reactive',
    time_basis: basis,
    ...draft,
  } as unknown as ResearchEvent;
}

export function statusEvent(t = 0, provider = 'p', provider_class = 'production'): ResearchEvent {
  return envelope(
    {
      event: 'provider.status',
      provider,
      provider_class,
      status: 'ok',
      reason: absent('healthy'),
      retry_attempt: 0,
      next_retry_ms: absent('no'),
    },
    t,
  );
}

export function costEvent(
  provider: string,
  unit: string,
  quantity: number,
  usd: number | null,
  reason = 'no_price',
  t = 0,
): ResearchEvent {
  return envelope(
    {
      event: 'cost.usage',
      provider,
      purpose: 'x',
      quantity,
      unit,
      estimated_cost_usd: usd === null ? absent(reason) : present(usd),
    },
    t,
  );
}

/** メモリ上のファイル。失敗、詰まり、部分書き込みを注入する。 */
export class FakeLogFile implements LogFile {
  chunks: Uint8Array[] = [];
  syncCount = 0;
  closed = false;
  failNext = 0;
  failAlways = false;
  syncFails = false;
  /** 1 回に書けるバイト数の上限。 */
  partialBytes: number | null = null;
  private stalled: (() => void)[] = [];
  stall = false;
  writeCalls = 0;

  text(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
  lines(): string[] {
    return this.text().split('\n').filter((l) => l !== '');
  }
  release(): void {
    this.stall = false;
    for (const resume of this.stalled.splice(0)) resume();
  }
  async write(data: Uint8Array): Promise<number> {
    this.writeCalls += 1;
    if (this.stall) await new Promise<void>((resolve) => this.stalled.push(resolve));
    if (this.failAlways) throw new Error('ENOSPC: no space left on device');
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error('EIO: i/o error');
    }
    const n = this.partialBytes === null ? data.length : Math.min(this.partialBytes, data.length);
    this.chunks.push(data.slice(0, n));
    return n;
  }
  async sync(): Promise<void> {
    if (this.stall) await new Promise<void>((resolve) => this.stalled.push(resolve));
    if (this.syncFails) throw new Error('EIO: fsync failed');
    this.syncCount += 1;
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

export class FakeLogFs implements LogFileSystem {
  readonly files = new Map<string, FakeLogFile>();
  readonly written = new Map<string, string>();
  manifestFails = false;
  async mkdirp(): Promise<void> {}
  async createExclusive(path: string): Promise<LogFile> {
    if (this.files.has(path)) throw new Error(`EEXIST: ${path}`);
    const file = new FakeLogFile();
    this.files.set(path, file);
    return file;
  }
  async writeAtomic(path: string, text: string): Promise<void> {
    if (this.manifestFails) throw new Error('EROFS: read-only');
    this.written.set(path, text);
  }
  eventsFile(): FakeLogFile {
    return [...this.files.entries()].find(([p]) => p.endsWith('events.jsonl'))![1];
  }
  quarantineFile(): FakeLogFile {
    return [...this.files.entries()].find(([p]) => p.endsWith('quarantine.jsonl'))![1];
  }
  manifest(): { closed: boolean; close_error: string | null; stats: Record<string, number> } {
    const entry = [...this.written.entries()].find(([p]) => p.endsWith('manifest.json'))!;
    return JSON.parse(entry[1]);
  }
}
