import { describe, expect, it } from 'vitest';
import { PlaybackScheduler, type SchedulerEvent } from '../../src/audio/dsp/playback_scheduler';

const RATE = 48000;
const Q = 128;

function setup(prebufferFrames = 480) {
  const events: SchedulerEvent[] = [];
  const s = new PlaybackScheduler({
    contextRate: RATE,
    prebufferFrames,
    onEvent: (e) => events.push(e),
  });
  let frame = 0;
  const out = new Float32Array(Q);
  const collected: number[] = [];
  const render = (quanta = 1) => {
    for (let i = 0; i < quanta; i++) {
      s.render(out, Q, frame);
      frame += Q;
      collected.push(...out);
    }
  };
  return { s, events, render, collected, frame: () => frame };
}

function chunk(n: number, value = 1): Float32Array {
  return new Float32Array(n).fill(value);
}

function ended(events: SchedulerEvent[]) {
  return events.filter((e) => e.kind === 'ended') as Extract<SchedulerEvent, { kind: 'ended' }>[];
}

describe('PlaybackScheduler', () => {
  it('prebuffer がたまるまで無音で、たまったら始まる。アンダーランに数えない', () => {
    const { s, events, render, collected } = setup(480);
    s.begin(1, 0);
    s.pcm(1, 0, chunk(100), false);
    render(2);
    expect(collected.every((v) => v === 0)).toBe(true);
    expect(events).toHaveLength(0);
    s.pcm(1, 0, chunk(400), false);
    render(1);
    expect(events[0]).toMatchObject({ kind: 'started', id: 1, renderFrame: 2 * Q });
    expect(s.underrunCount).toBe(0);
    expect(s.position()?.writtenFrames).toBe(Q);
  });

  it('終端が来れば prebuffer 未満でも流し、completed で終わる', () => {
    const { s, events, render } = setup(4800);
    s.begin(1, 0);
    s.pcm(1, 0, chunk(200), true);
    render(3);
    const end = ended(events)[0];
    expect(end).toMatchObject({ reason: 'completed', writtenFrames: 200, discardedFrames: 0 });
    expect(end?.renderFrame).toBe(200);
  });

  it('データ切れはアンダーラン。回数と長さを数え、無音は written に入らない', () => {
    const { s, render } = setup(100);
    s.begin(1, 0);
    s.pcm(1, 0, chunk(200), false);
    render(2); // 200 書いて尽きる
    expect(s.underrunCount).toBe(1);
    expect(s.position()?.writtenFrames).toBe(200);
    expect(s.underrunFrames).toBe(2 * Q - 200);
    const before = s.underrunFrames;
    render(10);
    expect(s.underrunCount).toBe(1);
    expect(s.underrunFrames).toBe(before + 10 * Q);
    s.pcm(1, 0, chunk(100), false);
    render(1);
    expect(s.position()?.writtenFrames).toBe(300);
    expect(s.underrunCount).toBe(2); // 100 を流して再び尽きた
  });

  it('古い世代の begin と PCM は棄てて数える', () => {
    const { s, events, render, collected } = setup(0);
    s.stop(99, 5, { mode: 'immediate' });
    s.begin(1, 3);
    s.pcm(1, 3, chunk(1000), false);
    render(5);
    expect(s.staleChunks).toBe(1);
    expect(s.staleControl).toBe(1);
    expect(events).toHaveLength(0);
    expect(collected.every((v) => v === 0)).toBe(true);
  });

  it('immediate: 未再生を次の量子から棄てる。written と discarded が返る', () => {
    const { s, events, render, collected } = setup(0);
    s.begin(1, 0);
    s.pcm(1, 0, chunk(10_000), false);
    render(2);
    s.stop(1, 1, { mode: 'immediate' });
    const mark = collected.length;
    render(2);
    expect(collected.slice(mark).every((v) => v === 0)).toBe(true);
    expect(ended(events)[0]).toMatchObject({
      reason: 'stopped',
      writtenFrames: 2 * Q,
      discardedFrames: 10_000 - 2 * Q,
    });
  });

  it('始まる前の停止は discarded_before_start', () => {
    const { s, events } = setup(480);
    s.begin(1, 0);
    s.pcm(1, 0, chunk(100), false);
    s.stop(1, 1, { mode: 'fade', fade_ms: 50 });
    expect(ended(events)[0]).toMatchObject({ reason: 'discarded_before_start', writtenFrames: 0 });
  });

  it('fade: 指定の長さで単調に減衰して止まる', () => {
    const { s, events, render, collected } = setup(0);
    s.begin(1, 0);
    s.pcm(1, 0, chunk(48_000), false);
    render(1);
    s.stop(1, 1, { mode: 'fade', fade_ms: 10 });
    const mark = collected.length;
    render(10);
    const after = collected.slice(mark);
    expect(after[0]).toBeCloseTo(1, 5);
    for (let i = 1; i < 480; i++) expect(after[i] as number).toBeLessThanOrEqual(after[i - 1] as number);
    expect(after.slice(480).every((v) => v === 0)).toBe(true);
    expect(ended(events)[0]).toMatchObject({ reason: 'stopped', writtenFrames: Q + 480 });
  });

  it('at_sample: 16kHz の位置で fade を始める', () => {
    const { s, events, render } = setup(0);
    s.begin(1, 0);
    s.pcm(1, 0, chunk(48_000), false);
    render(1);
    s.stop(1, 1, { mode: 'at_sample', stop_at_sample: 1600, fade_ms: 5, deadline_ms: 10_000 });
    render(100);
    expect(ended(events)[0]).toMatchObject({ reason: 'stopped', writtenFrames: 4800 + 240 });
  });

  it('at_sample: deadline を過ぎたらその時点で fade する', () => {
    const { s, events, render } = setup(0);
    s.begin(1, 0);
    s.pcm(1, 0, chunk(480_000), false);
    render(1);
    s.stop(1, 1, { mode: 'at_sample', stop_at_sample: 160_000, fade_ms: 5, deadline_ms: 100 });
    render(100);
    expect(ended(events)[0]).toMatchObject({ reason: 'stopped', writtenFrames: Q + 4800 + 240 });
  });

  it('at_sample: 位置に届く前に尽きたら、尽きたところで stopped で終わる', () => {
    const { s, events, render } = setup(0);
    s.begin(1, 0);
    s.pcm(1, 0, chunk(1000), false);
    render(1);
    s.stop(1, 1, { mode: 'at_sample', stop_at_sample: 160_000, fade_ms: 5, deadline_ms: 10_000 });
    render(20);
    expect(ended(events)[0]).toMatchObject({ reason: 'stopped', writtenFrames: 1000 });
    expect(s.underrunCount).toBe(0);
  });

  it('停止中の再生へ来た古い PCM は混ざらず、新しい世代は停止の後に流れる', () => {
    const { s, events, render } = setup(0);
    s.begin(1, 0);
    s.pcm(1, 0, chunk(48_000), false);
    render(1);
    s.stop(1, 1, { mode: 'fade', fade_ms: 10 });
    s.pcm(1, 0, chunk(100), false);
    expect(s.staleChunks).toBe(1);
    s.begin(2, 1);
    s.pcm(2, 1, chunk(500, 0.25), true);
    render(20);
    const es = ended(events);
    expect(es.map((e) => [e.id, e.reason])).toEqual([
      [1, 'stopped'],
      [2, 'completed'],
    ]);
    expect(es[1]?.writtenFrames).toBe(500);
  });

  it('同じ世代の再生は begin の順に流す', () => {
    const { s, events, render } = setup(0);
    s.begin(1, 0);
    s.begin(2, 0);
    s.pcm(2, 0, chunk(100), true);
    s.pcm(1, 0, chunk(100), true);
    render(3);
    expect(events.map((e) => [e.kind, e.id])).toEqual([
      ['started', 1],
      ['ended', 1],
      ['started', 2],
      ['ended', 2],
    ]);
  });

  it('begin で世代が進むと古い再生を棄てる', () => {
    const { s, events, render } = setup(0);
    s.begin(1, 0);
    s.pcm(1, 0, chunk(10_000), false);
    render(1);
    s.begin(2, 3);
    expect(ended(events)[0]).toMatchObject({ id: 1, reason: 'stopped' });
    expect(s.currentGeneration).toBe(3);
  });

  it('begin のない PCM、終わった再生への PCM は orphan に数える', () => {
    const { s, render } = setup(0);
    s.pcm(1, 0, chunk(10), false);
    expect(s.orphanChunks).toBe(1);
    s.begin(2, 0);
    s.pcm(2, 0, chunk(10), true);
    render(1);
    s.pcm(2, 0, chunk(10), false);
    expect(s.orphanChunks).toBe(2);
  });

  it('入力が切れたら残りを流して error で終わる', () => {
    const { s, events, render } = setup(0);
    s.begin(1, 0);
    s.pcm(1, 0, chunk(200), false);
    s.inputLost();
    render(3);
    expect(ended(events)[0]).toMatchObject({ reason: 'error', writtenFrames: 200 });
    expect(s.underrunCount).toBe(0);
  });

  it('reset で全部棄てて世代が 0 に戻る', () => {
    const { s, events } = setup(0);
    s.begin(1, 4);
    s.pcm(1, 4, chunk(200), false);
    s.reset();
    expect(ended(events)[0]).toMatchObject({ id: 1, reason: 'error' });
    expect(s.currentGeneration).toBe(0);
  });
});
