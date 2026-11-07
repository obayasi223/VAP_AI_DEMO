import { describe, expect, it } from 'vitest';
import {
  absent,
  atFromBrowser,
  computeClockSample,
  createEventEmitter,
  draftFromAudioReport,
  draftFromSignalReport,
  draftFromVapMessage,
  draftFromWorkerStatus,
  InvalidEventError,
  ManualTimeSource,
  MemoryEventSink,
  present,
  ResearchEvent,
  SystemTimeSource,
  type AudioReport,
  type Condition,
  type EventDraft,
  type MaaiVapStateMessage,
  type TimeMapping,
} from '../src/index';
import { VALID_FIXTURES } from '../src/fixtures';

const providerDraft: EventDraft = {
  event: 'provider.status',
  provider: 'x',
  provider_class: 'test_double',
  status: 'ok',
  reason: absent('healthy'),
  retry_attempt: 0,
  next_retry_ms: absent('no_retry'),
};

function setup(condition: Condition = 'reactive') {
  const time = new ManualTimeSource(100);
  const sink = new MemoryEventSink();
  let current = condition;
  const emitter = createEventEmitter({
    time,
    session_id: 's_1',
    condition: () => current,
    sink,
  });
  return { time, sink, emitter, setCondition: (c: Condition) => (current = c) };
}

const mapping: TimeMapping = {
  toServerMs: (ms) => ms + 1000,
  basis: { source: 'browser_rtt', uncertainty_ms: present(3) },
};

describe('emit', () => {
  it('fills the envelope and writes a validated event', () => {
    const { emitter, sink, time, setCondition } = setup();
    const first = emitter.emit(providerDraft);
    expect(first).toMatchObject({
      t_monotonic_ms: 100,
      session_id: 's_1',
      condition: 'reactive',
      schema_version: 1,
      time_basis: { source: 'orchestrator' },
    });
    time.advance(50);
    setCondition('initiative_inhale');
    const second = emitter.emit(providerDraft);
    expect(second).toMatchObject({ t_monotonic_ms: 150, condition: 'initiative_inhale' });
    expect(sink.events).toHaveLength(2);
    expect(sink.ofType('provider.status')).toHaveLength(2);
    expect(ResearchEvent.safeParse(second).success).toBe(true);
  });

  it('throws on a contract violation and writes nothing', () => {
    const { emitter, sink } = setup();
    const broken = { ...providerDraft, status: undefined } as unknown as EventDraft;
    expect(() => emitter.emit(broken)).toThrow(InvalidEventError);
    expect(sink.events).toHaveLength(0);
  });

  it('report mode hands the violation to the callback', () => {
    const errors: unknown[] = [];
    const sink = new MemoryEventSink();
    const emitter = createEventEmitter({
      time: new ManualTimeSource(),
      session_id: 's_1',
      condition: () => 'reactive',
      sink,
      invalid: 'report',
      onInvalid: (e) => errors.push(e),
    });
    emitter.emit({ ...providerDraft, retry_attempt: -1 });
    expect(errors).toHaveLength(1);
    expect(sink.events).toHaveLength(0);
  });

  it('accepts a remapped time with its basis', () => {
    const { emitter } = setup();
    const e = emitter.emit(providerDraft, atFromBrowser(5, mapping));
    expect(e.t_monotonic_ms).toBe(1005);
    expect(e.time_basis.source).toBe('browser_rtt');
    expect(e.time_basis.uncertainty_ms).toEqual({ value: 3 });
  });
});

describe('time sources', () => {
  it('manual time never goes backwards', () => {
    const t = new ManualTimeSource(10);
    expect(t.advance(5)).toBe(15);
    expect(t.wallClock()).toBe('2026-01-01T00:00:00.015Z');
    expect(() => t.advance(-1)).toThrow();
    expect(() => t.set(1)).toThrow();
  });

  it('system time is monotonic from the session start', () => {
    const t = new SystemTimeSource();
    const a = t.monotonicMs();
    const b = t.monotonicMs();
    expect(a).toBeGreaterThanOrEqual(0);
    expect(b).toBeGreaterThanOrEqual(a);
    expect(Number.isNaN(Date.parse(t.wallClock()))).toBe(false);
  });

  it('computes the offset from a ping pong', () => {
    expect(computeClockSample(100, 1105, 110)).toEqual({ offset_ms: 1000, rtt_ms: 10, uncertainty_ms: 5 });
    expect(() => computeClockSample(10, 0, 5)).toThrow();
  });
});

describe('forwarding from Browser and Python to Node emit', () => {
  const browserFixture = (name: string) =>
    VALID_FIXTURES['browser_rpc.browser_to_node'].find((f) => f.name === name)!.value;
  const workerFixture = (name: string) =>
    VALID_FIXTURES['maai_rpc.worker_to_node'].find((f) => f.name === name)!.value;

  it('audio.report becomes audio.health', () => {
    const { emitter } = setup();
    const report = browserFixture('audio.report') as AudioReport;
    const e = emitter.emit(draftFromAudioReport(report), atFromBrowser(report.client_t_ms, mapping));
    expect(e).toMatchObject({ event: 'audio.health', reporter: 'browser', t_monotonic_ms: 1700 });
  });

  it('signal.report keeps the rAF time and the hidden case', () => {
    const { emitter } = setup();
    const visible = emitter.emit(
      draftFromSignalReport(
        { type: 'signal.report', candidate_id: 'c_1', phase: 'inhale', state: 'started', visible: true, client_t_ms: present(5) },
        { depth: 1 },
        mapping,
      ),
    );
    expect(visible).toMatchObject({ event: 'signal.started', visible: true, started_at: 1005 });
    const hidden = emitter.emit(
      draftFromSignalReport(
        { type: 'signal.report', candidate_id: 'c_1', phase: 'inhale', state: 'started', visible: false, client_t_ms: absent('no_raf') },
        {},
        mapping,
      ),
    );
    expect(hidden).toMatchObject({ visible: false, started_at: null, null_reason: 'no_raf' });
    const ended = emitter.emit(
      draftFromSignalReport(
        { type: 'signal.report', candidate_id: 'c_1', phase: 'relax', state: 'ended', visible: false, client_t_ms: absent('no_raf') },
        {},
        mapping,
      ),
    );
    expect(ended).toMatchObject({ event: 'signal.ended', ended_at: { value: null, null_reason: 'no_raf' } });
  });

  it('worker messages become events', () => {
    const { emitter } = setup();
    const vap = emitter.emit(draftFromVapMessage(workerFixture('VAP_STATE/2ch') as MaaiVapStateMessage));
    expect(vap).toMatchObject({ event: 'vap.state', channel_layout: '2ch' });
    expect('type' in vap).toBe(false);
    const status = emitter.emit(
      draftFromWorkerStatus(
        workerFixture('WORKER_STATUS') as Parameters<typeof draftFromWorkerStatus>[0],
        'written',
      ),
    );
    expect(status).toMatchObject({ event: 'audio.health', reporter: 'worker' });
  });
});
