import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { absent, ManualTimeSource, ResearchEvent, type EventDraft } from '@llm-vap/contracts';
import {
  InvalidSessionIdError,
  installShutdownFlush,
  openSessionLogging,
  SessionLog,
  SESSION_LOG_PROVIDER,
  type LogProblem,
  type SessionLogOptions,
} from '../../src/logging';
import { FakeLogFs, SESSION, statusEvent } from './helpers';

const quiet = () => undefined;

function fakeOptions(fs: FakeLogFs, extra: Partial<SessionLogOptions> = {}): SessionLogOptions {
  return {
    dir: 'logs',
    session_id: SESSION,
    fs,
    time: new ManualTimeSource(10),
    reporter: quiet,
    retryMs: 5,
    flushTimeoutMs: 200,
    closeTimeoutMs: 100,
    ...extra,
  };
}

function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise((done, fail) => {
    const start = Date.now();
    const poll = () => {
      if (predicate()) done();
      else if (Date.now() - start > timeoutMs) fail(new Error('condition not met'));
      else setTimeout(poll, 2);
    };
    poll();
  });
}

describe('SessionLog: 実ファイル', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'session-log-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('合格イベントを 1 行ずつ書き、読み戻してスキーマに合格する', async () => {
    const log = await SessionLog.open({ dir, session_id: SESSION, reporter: quiet });
    log.write(statusEvent(1));
    log.write(statusEvent(2));
    const report = await log.close();
    expect(report.ok).toBe(true);
    expect(report.lost_events).toBe(0);
    const lines = (await readFile(report.paths.events, 'utf8')).trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(ResearchEvent.safeParse(JSON.parse(line)).success).toBe(true);
    const manifest = JSON.parse(await readFile(report.paths.manifest, 'utf8'));
    expect(manifest.closed).toBe(true);
    expect(manifest.stats.written).toBe(2);
  });

  it('開いた直後の manifest は closed=false（異常終了を検出できる）', async () => {
    const log = await SessionLog.open({ dir, session_id: SESSION, reporter: quiet });
    const manifest = JSON.parse(await readFile(log.paths.manifest, 'utf8'));
    expect(manifest.closed).toBe(false);
    await log.close();
  });

  it('既存のセッションのログを上書きしない', async () => {
    const first = await SessionLog.open({ dir, session_id: SESSION, reporter: quiet });
    first.write(statusEvent(1));
    const { paths } = await first.close();
    const before = await readFile(paths.events, 'utf8');
    await expect(SessionLog.open({ dir, session_id: SESSION, reporter: quiet })).rejects.toThrow(/EEXIST/);
    expect(await readFile(paths.events, 'utf8')).toBe(before);
  });

  it('ディレクトリを作れないときは open が reject する（黙って続けない）', async () => {
    const blocker = join(dir, 'file');
    await writeFile(blocker, 'x');
    await expect(SessionLog.open({ dir: blocker, session_id: SESSION, reporter: quiet })).rejects.toThrow();
  });

  it('session_id でディレクトリの外へ出られない', async () => {
    for (const id of ['../evil', 'a/b', '..', '', '.hidden', 'a\\b']) {
      await expect(SessionLog.open({ dir, session_id: id, reporter: quiet })).rejects.toBeInstanceOf(
        InvalidSessionIdError,
      );
    }
  });

  it('SIGTERM で flush して閉じる（別プロセスで確認）', async () => {
    const script = join(dir, 'child.mts');
    const logging = resolve(import.meta.dirname, '../../src/logging/index.ts');
    await writeFile(
      script,
      `import { installShutdownFlush, SessionLog } from ${JSON.stringify(logging)};
       const log = await SessionLog.open({ dir: ${JSON.stringify(dir)}, session_id: 'child', reporter: () => {} });
       installShutdownFlush(log);
       const event = ${JSON.stringify(statusEvent(1))};
       for (let i = 0; i < 2000; i++) log.write({ ...event, session_id: 'child' });
       process.stdout.write('ready\\n');
       setInterval(() => {}, 1000);`,
    );
    const child = spawn(process.execPath, ['--import', 'tsx', script], {
      cwd: resolve(import.meta.dirname, '../../../..'),
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    await new Promise<void>((done, fail) => {
      child.stdout.once('data', () => done());
      child.once('exit', (code) => fail(new Error(`child exited early: ${code}`)));
    });
    child.kill('SIGTERM');
    const signal = await new Promise<NodeJS.Signals | null>((done) => child.once('exit', (_c, s) => done(s)));
    expect(signal).toBe('SIGTERM');
    const lines = (await readFile(join(dir, 'child', 'events.jsonl'), 'utf8')).trimEnd().split('\n');
    expect(lines).toHaveLength(2000);
    const manifest = JSON.parse(await readFile(join(dir, 'child', 'manifest.json'), 'utf8'));
    expect(manifest.closed).toBe(true);
  }, 30000);
});

describe('SessionLog: 検証と隔離', () => {
  it('不合格のイベントは events に入れず、理由と元の値を隔離して数える', async () => {
    const fs = new FakeLogFs();
    const problems: LogProblem[] = [];
    const log = await SessionLog.open(fakeOptions(fs, { onProblem: (p) => problems.push(p) }));
    log.write(statusEvent(1));
    log.writeUnknown({ event: 'provider.status', session_id: SESSION, broken: true });
    log.writeUnknown('not an object');
    const report = await log.close();
    expect(fs.eventsFile().lines()).toHaveLength(1);
    const quarantined = fs.quarantineFile().lines().map((l) => JSON.parse(l));
    expect(quarantined).toHaveLength(2);
    expect(quarantined[0].reason).toBe('schema_invalid');
    expect(quarantined[0].raw.broken).toBe(true);
    expect(quarantined[0].issues.length).toBeGreaterThan(0);
    expect(report.stats.quarantined).toBe(2);
    expect(report.stats.quarantined_by_reason.schema_invalid).toBe(2);
    expect(report.stats.quarantine_written).toBe(2);
    expect(problems.filter((p) => p.kind === 'invalid_event')).toHaveLength(2);
  });

  it('別のセッションのイベントを混ぜない', async () => {
    const fs = new FakeLogFs();
    const log = await SessionLog.open(fakeOptions(fs));
    log.write({ ...statusEvent(1), session_id: 'other' });
    const report = await log.close();
    expect(fs.eventsFile().lines()).toHaveLength(0);
    expect(report.stats.quarantined_by_reason.session_mismatch).toBe(1);
  });

  it('循環参照の値でも例外を出さず隔離する', async () => {
    const fs = new FakeLogFs();
    const log = await SessionLog.open(fakeOptions(fs));
    const circular: Record<string, unknown> = { event: 'x' };
    circular.self = circular;
    expect(() => log.writeUnknown(circular)).not.toThrow();
    await log.close();
    const [record] = fs.quarantineFile().lines().map((l) => JSON.parse(l));
    expect(record.raw.unserializable).toBe(true);
  });

  it('close のあとのイベントは数えて報告する', async () => {
    const fs = new FakeLogFs();
    const messages: string[] = [];
    const log = await SessionLog.open(fakeOptions(fs, { reporter: (m) => messages.push(m) }));
    await log.close();
    log.write(statusEvent(1));
    expect(log.stats().after_close).toBe(1);
    expect(messages.join('\n')).toMatch(/after close/);
    expect(fs.eventsFile().lines()).toHaveLength(0);
  });
});

describe('SessionLog: 詰まりで止めない', () => {
  it('書き込みが詰まっていても write はすぐ戻り、解消後に全件が順に書かれる', async () => {
    const fs = new FakeLogFs();
    const log = await SessionLog.open(fakeOptions(fs));
    const file = fs.eventsFile();
    file.stall = true;
    const event = statusEvent(1);
    const begin = performance.now();
    for (let i = 0; i < 1000; i++) log.write({ ...event, t_monotonic_ms: i });
    expect(performance.now() - begin).toBeLessThan(500);
    await waitFor(() => file.writeCalls > 0);
    expect(log.stats().written).toBe(0);
    // イベントループも止まっていない
    await new Promise((done) => setTimeout(done, 5));
    file.release();
    const result = await log.flush();
    expect(result.ok).toBe(true);
    const times = file.lines().map((l) => (JSON.parse(l) as { t_monotonic_ms: number }).t_monotonic_ms);
    expect(times).toEqual(Array.from({ length: 1000 }, (_, i) => i));
    await log.close();
  });

  it('詰まりが続くと上限を超えた分を捨てて種類ごとに数え、報告する', async () => {
    const fs = new FakeLogFs();
    const problems: LogProblem[] = [];
    const log = await SessionLog.open(
      fakeOptions(fs, { maxQueueBytes: 2000, onProblem: (p) => problems.push(p) }),
    );
    fs.eventsFile().stall = true;
    for (let i = 0; i < 100; i++) log.write(statusEvent(i));
    const stats = log.stats();
    expect(stats.dropped_overflow).toBeGreaterThan(0);
    expect(stats.dropped_by_event['provider.status']).toBe(stats.dropped_overflow);
    expect(stats.accepted + stats.dropped_overflow).toBe(100);
    expect(stats.queue_bytes).toBeLessThanOrEqual(2000);
    expect(problems.filter((p) => p.kind === 'queue_overflow')).toHaveLength(1);
    fs.eventsFile().release();
    const report = await log.close();
    expect(report.ok).toBe(false);
    expect(report.lost_events).toBe(stats.dropped_overflow);
    expect(fs.manifest().stats.dropped_overflow).toBe(stats.dropped_overflow);
  });

  it('flush は詰まりで止まり続けず、期限で ok: false を返す', async () => {
    const fs = new FakeLogFs();
    const log = await SessionLog.open(fakeOptions(fs));
    fs.eventsFile().stall = true;
    log.write(statusEvent(1));
    const result = await log.flush(20);
    expect(result.ok).toBe(false);
    expect(result.pending_lines).toBe(1);
    expect(result.error).toMatch(/timed out/);
    fs.eventsFile().release();
    await log.close();
  });

  it('close は詰まりで止まり続けず、失った件数を返す', async () => {
    const fs = new FakeLogFs();
    const log = await SessionLog.open(fakeOptions(fs, { closeTimeoutMs: 20 }));
    fs.eventsFile().stall = true;
    log.write(statusEvent(1));
    const report = await log.close();
    expect(report.ok).toBe(false);
    expect(report.lost_events).toBe(1);
    expect(fs.manifest().closed).toBe(true);
    expect(fs.manifest().close_error).toMatch(/timed out/);
    fs.eventsFile().release();
  });
});

describe('SessionLog: 書き込み失敗を隠さない', () => {
  it('失敗を報告し、再試行で回復すると欠落も重複もない', async () => {
    const fs = new FakeLogFs();
    const problems: LogProblem[] = [];
    const messages: string[] = [];
    const log = await SessionLog.open(
      fakeOptions(fs, { onProblem: (p) => problems.push(p), reporter: (m) => messages.push(m) }),
    );
    const file = fs.eventsFile();
    file.failNext = 2;
    log.write(statusEvent(1));
    log.write(statusEvent(2));
    await waitFor(() => log.stats().written === 2);
    expect(problems.map((p) => p.kind)).toEqual(['write_failed', 'write_failed', 'write_recovered']);
    expect(messages.join('\n')).toMatch(/EIO/);
    expect(log.stats().write_errors).toBe(2);
    expect(log.stats().failing).toBe(false);
    expect(file.lines()).toHaveLength(2);
    const report = await log.close();
    expect(report.ok).toBe(true);
    expect(fs.manifest().stats.write_errors).toBe(2);
  });

  it('部分書き込みは続きから書く（行が壊れない）', async () => {
    const fs = new FakeLogFs();
    const log = await SessionLog.open(fakeOptions(fs));
    const file = fs.eventsFile();
    file.partialBytes = 7;
    log.write(statusEvent(1));
    log.write(statusEvent(2));
    await log.close();
    const lines = file.lines();
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(ResearchEvent.safeParse(JSON.parse(line)).success).toBe(true);
  });

  it('部分書き込みの途中で失敗しても、再試行で行が壊れない', async () => {
    const fs = new FakeLogFs();
    const log = await SessionLog.open(fakeOptions(fs));
    const file = fs.eventsFile();
    file.partialBytes = 7;
    log.write(statusEvent(1));
    await waitFor(() => file.writeCalls >= 1);
    file.failNext = 1;
    await log.close();
    expect(JSON.parse(file.lines()[0] as string).event).toBe('provider.status');
  });

  it('失敗が続けば flush と close は ok: false で、失った件数と原因を manifest に残す', async () => {
    const fs = new FakeLogFs();
    const messages: string[] = [];
    const log = await SessionLog.open(fakeOptions(fs, { closeTimeoutMs: 30, reporter: (m) => messages.push(m) }));
    fs.eventsFile().failAlways = true;
    log.write(statusEvent(1));
    const flushed = await log.flush();
    expect(flushed.ok).toBe(false);
    expect(flushed.error).toMatch(/ENOSPC/);
    expect(log.stats().failing).toBe(true);
    const report = await log.close();
    expect(report.ok).toBe(false);
    expect(report.lost_events).toBe(1);
    expect(report.error).toMatch(/ENOSPC/);
    expect(fs.manifest().close_error).toMatch(/ENOSPC/);
    expect(messages.join('\n')).toMatch(/closed with problems/);
  });

  it('fsync の失敗を成功と報告しない', async () => {
    const fs = new FakeLogFs();
    const log = await SessionLog.open(fakeOptions(fs));
    fs.eventsFile().syncFails = true;
    log.write(statusEvent(1));
    const result = await log.flush();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/fsync/);
    await log.close();
  });

  it('manifest を書けないことも close の結果に出す', async () => {
    const fs = new FakeLogFs();
    const messages: string[] = [];
    const log = await SessionLog.open(fakeOptions(fs, { reporter: (m) => messages.push(m) }));
    fs.manifestFails = true;
    const report = await log.close();
    expect(report.manifest_written).toBe(false);
    expect(report.ok).toBe(false);
    expect(messages.join('\n')).toMatch(/manifest not written/);
  });

  it('onProblem と reporter が例外を出しても write は止まらない', async () => {
    const fs = new FakeLogFs();
    const log = await SessionLog.open(
      fakeOptions(fs, {
        onProblem: () => {
          throw new Error('handler bug');
        },
        reporter: () => {
          throw new Error('reporter bug');
        },
      }),
    );
    expect(() => log.writeUnknown({ broken: true })).not.toThrow();
    log.write(statusEvent(1));
    const report = await log.close();
    expect(report.stats.written).toBe(1);
  });
});

describe('SessionLog: flush', () => {
  it('flush は書き終えて fsync してから解決する', async () => {
    const fs = new FakeLogFs();
    const log = await SessionLog.open(fakeOptions(fs));
    log.write(statusEvent(1));
    expect(fs.eventsFile().lines()).toHaveLength(0);
    const result = await log.flush();
    expect(result).toEqual({ ok: true, pending_lines: 0, error: null });
    expect(fs.eventsFile().lines()).toHaveLength(1);
    expect(fs.eventsFile().syncCount).toBe(1);
    await log.close();
  });

  it('close は何度呼んでも同じ結果で、ファイルを閉じる', async () => {
    const fs = new FakeLogFs();
    const log = await SessionLog.open(fakeOptions(fs));
    log.write(statusEvent(1));
    const [a, b] = await Promise.all([log.close(), log.close()]);
    expect(a).toBe(b);
    expect(fs.eventsFile().closed).toBe(true);
    expect(fs.eventsFile().lines()).toHaveLength(1);
  });

  it('installShutdownFlush はシグナルで close してから送り直す', async () => {
    const closes: string[] = [];
    const listeners = new Map<string, () => void>();
    const kills: string[] = [];
    const dispose = installShutdownFlush(
      {
        close: async () => {
          closes.push('close');
          return {} as never;
        },
      },
      {
        pid: 1,
        once: (s, l) => listeners.set(s, l),
        off: (s) => listeners.delete(s),
        kill: (_p, s) => kills.push(s),
      },
    );
    expect([...listeners.keys()].sort()).toEqual(['SIGINT', 'SIGTERM', 'beforeExit']);
    listeners.get('SIGTERM')?.();
    await new Promise((done) => setTimeout(done, 0));
    expect(closes).toEqual(['close']);
    expect(kills).toEqual(['SIGTERM']);
    expect(listeners.size).toBe(0);
    dispose();
  });
});

describe('openSessionLogging', () => {
  const baseDraft: EventDraft = {
    event: 'cost.usage',
    provider: 'x',
    purpose: 'y',
    quantity: 1,
    unit: 'u',
    estimated_cost_usd: absent('no'),
  };

  it('契約に合わない emit は例外にせず隔離へ入れる', async () => {
    const fs = new FakeLogFs();
    const { log, emitter } = await openSessionLogging({ ...fakeOptions(fs), condition: () => 'reactive' });
    emitter.emit(baseDraft);
    expect(() => emitter.emit({ ...baseDraft, quantity: -1 })).not.toThrow();
    const report = await log.close();
    expect(report.stats.quarantined_by_reason.draft_invalid).toBe(1);
    const events = fs.eventsFile().lines().map((l) => JSON.parse(l));
    expect(events.map((e) => e.event)).toEqual(['provider.status', 'cost.usage']);
    expect(events[1].t_monotonic_ms).toBe(10);
    expect(events[1].time_basis.source).toBe('orchestrator');
  });

  it('書き込みの失敗と回復を provider.status としてログに残す', async () => {
    const fs = new FakeLogFs();
    const { log, emitter } = await openSessionLogging({ ...fakeOptions(fs), condition: () => 'reactive' });
    await log.flush();
    fs.eventsFile().failNext = 2;
    emitter.emit(baseDraft);
    await waitFor(() => log.stats().failing === false && log.stats().write_errors === 2);
    await log.close();
    const statuses = fs
      .eventsFile()
      .lines()
      .map((l) => JSON.parse(l))
      .filter((e) => e.event === 'provider.status' && e.provider === SESSION_LOG_PROVIDER);
    expect(statuses.map((e) => e.status)).toEqual(['ok', 'down', 'ok']);
    expect(statuses[1].reason.value).toMatch(/EIO/);
    expect(statuses[1].retry_attempt).toBe(1);
  });

  it('本物のディレクトリでも実時刻で書ける', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'session-logging-'));
    try {
      await mkdir(join(dir, 'nested'));
      const { log, emitter, time } = await openSessionLogging({
        dir: join(dir, 'nested'),
        session_id: SESSION,
        condition: () => 'initiative_inhale',
        reporter: quiet,
      });
      emitter.emit(baseDraft);
      expect(time.monotonicMs()).toBeGreaterThanOrEqual(0);
      const report = await log.close();
      expect(report.ok).toBe(true);
      const lines = (await readFile(report.paths.events, 'utf8')).trimEnd().split('\n');
      expect(JSON.parse(lines[1] as string).condition).toBe('initiative_inhale');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
