import { describe, expect, it } from 'vitest';
import {
  atFromBrowser,
  computeClockSample,
  createEventEmitter,
  ManualTimeSource,
  MemoryEventSink,
} from '@llm-vap/contracts';
import { BrowserClockRecorder, WorkerClockRecorder } from '../../src/logging';

function setup() {
  const sink = new MemoryEventSink();
  const emitter = createEventEmitter({
    time: new ManualTimeSource(100),
    session_id: 's',
    condition: () => 'reactive',
    sink,
  });
  return { sink, emitter };
}

describe('BrowserClockRecorder', () => {
  it('補正の値と誤差を clock.sync に残し、同じ推定で写像を作る', () => {
    const { sink, emitter } = setup();
    const recorder = new BrowserClockRecorder(emitter);
    expect(recorder.mapping()).toBeNull();
    // クライアントが 1000 で送り、サーバー時刻 5005、クライアントが 1010 で受信
    recorder.record(computeClockSample(1000, 5005, 1010));
    const [event] = sink.ofType('clock.sync');
    expect(event).toMatchObject({ source: 'browser_rtt', offset_ms: 4000, error_ms: 5, rtt_ms: { value: 10 } });
    const mapping = recorder.mapping();
    expect(mapping?.toServerMs(2000)).toBe(6000);
    expect(mapping?.basis).toEqual({ source: 'browser_rtt', uncertainty_ms: { value: 5 } });
    const at = atFromBrowser(2000, mapping!);
    expect(at.at).toEqual({ t_monotonic_ms: 6000, time_basis: mapping!.basis });
  });

  it('写像は作った時点の推定に固定され、誤差と offset がずれない', () => {
    const { emitter } = setup();
    const recorder = new BrowserClockRecorder(emitter);
    recorder.record({ offset_ms: 10, rtt_ms: 2, uncertainty_ms: 1 });
    const old = recorder.mapping()!;
    recorder.record({ offset_ms: 20, rtt_ms: 4, uncertainty_ms: 2 });
    expect(old.toServerMs(0)).toBe(10);
    expect(recorder.mapping()!.toServerMs(0)).toBe(20);
  });
});

describe('WorkerClockRecorder', () => {
  it('受信時刻との差の下側包絡を offset に、窓内の幅を誤差にする', () => {
    const { sink, emitter } = setup();
    const recorder = new WorkerClockRecorder(emitter, { emitIntervalMs: 0 });
    recorder.observe(1000, 3005);
    recorder.observe(1080, 3082); // 差 2002 が最小
    recorder.observe(1160, 3170);
    const events = sink.ofType('clock.sync');
    expect(events.at(-1)).toMatchObject({
      source: 'worker_audio_frame',
      offset_ms: 2002,
      error_ms: 8,
      rtt_ms: { value: null },
    });
    const mapping = recorder.mapping()!;
    expect(mapping.toServerMs(1160)).toBe(3162);
    expect(mapping.basis).toEqual({ source: 'worker_audio_frame', uncertainty_ms: { value: 8 } });
  });

  it('clock.sync は間隔を空けて出す', () => {
    const { sink, emitter } = setup();
    const recorder = new WorkerClockRecorder(emitter, { emitIntervalMs: 1000 });
    for (let i = 0; i < 25; i++) recorder.observe(i * 80, i * 80 + 500);
    expect(sink.ofType('clock.sync')).toHaveLength(2);
  });

  it('ワーカーの再起動で古い基準を捨てる', () => {
    const { emitter } = setup();
    const recorder = new WorkerClockRecorder(emitter, { emitIntervalMs: 0 });
    recorder.observe(5000, 6000);
    recorder.reset();
    expect(recorder.mapping()).toBeNull();
    recorder.observe(10, 7000);
    expect(recorder.mapping()!.toServerMs(10)).toBe(7000);
  });
});
