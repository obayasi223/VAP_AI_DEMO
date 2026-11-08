import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SessionAudioRecorder } from '../../../apps/orchestrator/src/logging/session_audio';
import { audioTimeline, buildMarks, readAudioSync, readWaveform, syncFrameMap } from '../lib/audio_timeline';
import { loadSession } from '../lib/session';
import { syntheticEvents, tempRoot, writeSession } from './synthetic';

const FRAME = 320;

async function record(dir: string, options: { base: number; jitter: (i: number) => number; frames: number }): Promise<void> {
  const r = new SessionAudioRecorder({ dir, session_id: 's', minFreeBytes: 0 });
  for (let i = 0; i < options.frames; i++) {
    const end = (i + 1) * FRAME;
    const mic = new Int16Array(FRAME).fill(i % 50 === 0 ? 20000 : 100);
    const sys = new Int16Array(FRAME).fill(i % 50 === 25 ? -20000 : 0);
    r.push(i * FRAME, mic, sys, options.base + end / 16 + options.jitter(i));
  }
  await r.close('done');
}

describe('音声の位置と時刻の対応（同期ファイル）', () => {
  it('受信の揺れと数百 ms の詰まりがあっても、時刻から音声の位置を数十 ms 以内で引ける', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'audio-sync-'));
    // 揺れ 0〜40ms。5 秒ごとに 300ms の詰まり（イベントループの停止など）。
    const jitter = (i: number) => ((i * 7) % 41) + (i % 250 < 15 ? 300 : 0);
    await record(dir, { base: 5000, jitter, frames: 1500 });
    const sync = readAudioSync(dir);
    expect(sync).not.toBeNull();
    const map = syncFrameMap(sync!);
    let worst = 0;
    for (let sec = 0.5; sec < 29.5; sec += 0.137) {
      const trueT = 5000 + sec * 1000;
      worst = Math.max(worst, Math.abs((map.secondsAtT(trueT) as number) - sec));
    }
    // vap.state の組（推論の遅れで数百 ms ずれる）より十分に小さい。
    expect(worst * 1000).toBeLessThan(60);
    const back = map.tAtFrame(16000 * 10) as number;
    expect(Math.abs(back - (5000 + 10000))).toBeLessThan(60);
  });

  it('長い欠落で区間が分かれると、欠落の中の時刻は欠落の手前の位置に留まる', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'audio-sync-'));
    const r = new SessionAudioRecorder({ dir, session_id: 's', minFreeBytes: 0, maxPadFrames: FRAME * 5, anchorEveryFrames: FRAME * 10 });
    // 95 枠（1.9 秒）。最後の窓の anchor は 1.78 秒の位置で、欠落の始まりより手前にある。
    for (let i = 0; i < 95; i++) r.push(i * FRAME, new Int16Array(FRAME), new Int16Array(FRAME), 1000 + (i + 1) * 20);
    const later = 95 * FRAME + 16000 * 30;
    for (let i = 0; i < 100; i++) r.push(later + i * FRAME, new Int16Array(FRAME), new Int16Array(FRAME), 1000 + 1900 + 30000 + (i + 1) * 20);
    await r.close('done');
    const map = syncFrameMap(readAudioSync(dir)!);
    expect(map.secondsAtT(1000 + 1900 + 15000)).toBeCloseTo(1.9, 1);
    // 欠落に入った直後も欠落の位置に留まる（anchor の間を線形につなぐと 1.78 秒の付近に戻る）。
    expect(map.secondsAtT(1000 + 1900 + 50)).toBeCloseTo(1.9, 1);
    // 後ろの区間は WAV の中で続きの位置になる。
    expect(map.secondsAtT(1000 + 1900 + 30000 + 1000) as number).toBeCloseTo(2.9, 1);
  });

  it('対応があるセッションの音声の秒位置は同期ファイルから求める（vap.state の組より優先）', async () => {
    const root = tempRoot();
    const dir = writeSession(root, 's_audio');
    // vap.state は t = frame/16 + 200。同期ファイルは t = frame/16 + 100（遅れの小さい実測）。
    const r = new SessionAudioRecorder({ dir, session_id: 's_audio', minFreeBytes: 0 });
    for (let i = 0; i < 1000; i++) r.push(i * FRAME, new Int16Array(FRAME), new Int16Array(FRAME), 100 + ((i + 1) * FRAME) / 16);
    await r.close('done');
    const session = loadSession(dir);
    const item = session.items.find((i) => i.key === 'c:c_0001');
    // anchor 2500ms → (2500 - 100) / 1000 = 2.4 秒。旧来の vap の組なら 2.3 秒。
    expect(item?.audio_sec).toBeCloseTo(2.4, 2);
    expect(session.meta.audio_files[0]).toBe('session_audio.wav');
    expect(session.has_audio_map).toBe(true);
  });

  it('同期ファイルがなければ今までの vap.state の組のまま（既定で壊れない）', () => {
    const root = tempRoot();
    const dir = writeSession(root, 's_old');
    writeFileSync(path.join(dir, 'other.wav'), Buffer.alloc(44));
    const session = loadSession(dir);
    expect(session.items.find((i) => i.key === 'c:c_0001')?.audio_sec).toBeCloseTo(2.3, 3);
    expect(readAudioSync(dir)).toBeNull();
    expect(audioTimeline(dir, { center_sec: 1, span_sec: 10, bins: 100 }).available).toBe(false);
  });
});

describe('波形', () => {
  it('2ch を別々に読み、窓に切る', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'audio-wave-'));
    await record(dir, { base: 0, jitter: () => 0, frames: 100 });
    const wave = readWaveform(path.join(dir, 'session_audio.wav'), 0, 2, 50);
    expect(wave).not.toBeNull();
    expect(wave!.duration_sec).toBeCloseTo(2, 3);
    expect(wave!.mic).toHaveLength(50);
    // mic は 0 番の枠が大きい、sys は 25 番の枠が負に大きい。
    expect(wave!.mic[0]![1]).toBeGreaterThan(0.5);
    expect(Math.min(...wave!.sys.map((b) => b[0]))).toBeLessThan(-0.5);
    expect(Math.max(...wave!.sys.map((b) => b[1]))).toBeLessThan(0.01);
  });

  it('ヘッダが更新されないまま止まったファイルも、実際にある分を読む', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'audio-wave-'));
    const header = Buffer.alloc(44);
    header.write('RIFF', 0, 'latin1');
    header.write('WAVE', 8, 'latin1');
    header.write('fmt ', 12, 'latin1');
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(2, 22);
    header.writeUInt32LE(16000, 24);
    header.writeUInt16LE(16, 34);
    header.write('data', 36, 'latin1');
    header.writeUInt32LE(0, 40);
    const body = Buffer.alloc(16000 * 4);
    writeFileSync(path.join(dir, 'x.wav'), Buffer.concat([header, body]));
    expect(readWaveform(path.join(dir, 'x.wav'), 0, 5, 10)?.duration_sec).toBeCloseTo(1, 3);
  });
});

describe('印', () => {
  const base = (t: number, extra: Record<string, unknown>) => ({ t_monotonic_ms: t, time_basis: { source: 'orchestrator', uncertainty_ms: { value: 0 } }, ...extra });

  it('合図の送信、描画の開始と終了、release の理由、発話、判定を並べ、ブラウザの時刻には誤差が付く', () => {
    const events = [
      base(100, { event: 'clock.sync', source: 'browser_rtt', offset_ms: -1, error_ms: 2.5 }),
      base(1000, { event: 'initiative.desire', request_id: 'r1', desire: 'NEW', outcome: 'accepted', received_at: 1000 }),
      base(1300, { event: 'initiative.timing', request_id: 'r1t', timing: 'OFFER_NOW', outcome: 'kept', received_at: 1300 }),
      base(1400, { event: 'signal.sent', candidate_id: 'c1', phase: 'inhale', parameters: {}, sent_at: 1400 }),
      { t_monotonic_ms: 1450, time_basis: { source: 'browser_rtt', uncertainty_ms: { value: 1.5 } }, event: 'signal.started', candidate_id: 'c1', phase: 'inhale', parameters: {}, visible: true, started_at: 1450 },
      base(1900, { event: 'signal.ended', candidate_id: 'c1', phase: 'inhale', parameters: {}, visible: true, ended_at: { value: 1880 } }),
      base(2000, { event: 'signal.sent', candidate_id: 'c1', phase: 'relax', parameters: { reason: 'deferred' }, sent_at: 2000 }),
      base(2100, { event: 'speech.started', audio_playback_id: 1, origin: 'candidate', started_at: 2100, candidate_id: 'c1' }),
      base(3000, { event: 'speech.ended', audio_playback_id: 1, origin: 'candidate', started_at: 2100, ended_at: 3000 }),
    ];
    const { marks, clock } = buildMarks(events as never);
    expect(marks.map((m) => [m.t_ms, m.lane])).toEqual([
      [1000, 'desire'],
      [1300, 'timing'],
      [1400, 'cue'],
      [1450, 'render'],
      [1880, 'render'],
      [2000, 'release'],
      [2100, 'speech'],
      [3000, 'speech'],
    ]);
    expect(marks.find((m) => m.t_ms === 2000)?.label).toBe('breath.release: deferred');
    // time_basis が browser_rtt ならその誤差、なければ直前の clock.sync の誤差。
    expect(marks.find((m) => m.t_ms === 1450)).toMatchObject({ clock: 'browser', clock_error_ms: 1.5 });
    expect(marks.find((m) => m.t_ms === 1880)).toMatchObject({ clock: 'browser', clock_error_ms: 2.5 });
    expect(marks.find((m) => m.t_ms === 1400)).toMatchObject({ clock: 'orchestrator', clock_error_ms: 0 });
    expect(clock).toMatchObject({ browser_samples: 1, browser_error_ms_max: 2.5 });
  });

  it('signal.ended が無くても、描画されない報告でも壊れない', () => {
    const events = [
      base(1000, { event: 'signal.sent', candidate_id: 'c1', phase: 'inhale', parameters: {}, sent_at: 1000 }),
      base(1500, { event: 'signal.started', candidate_id: 'c1', phase: 'inhale', parameters: {}, visible: false, started_at: null, null_reason: 'tab_hidden' }),
    ];
    const { marks, clock } = buildMarks(events as never);
    expect(marks).toHaveLength(2);
    expect(marks[1]?.label).toContain('描画されなかった');
    expect(clock.browser_samples).toBe(0);
  });

  it('二段判定では同じ request の initiative.decision を重ねて出さない', () => {
    const events = [
      base(1000, { event: 'initiative.decision', request_id: 'r1', decision: 'NEW', received_at: 1000 }),
      base(1000, { event: 'initiative.desire', request_id: 'r1', desire: 'NEW', outcome: 'accepted', received_at: 1000 }),
      base(2000, { event: 'initiative.decision', request_id: 'r2', decision: 'NONE', received_at: 2000 }),
    ];
    expect(buildMarks(events as never).marks.map((m) => m.label)).toEqual(['生成段: NEW（accepted）', '判定: NONE']);
  });

  it('詳細画面の口: 窓の中の印に音声の位置が付き、対応と時計の精度が返る', async () => {
    const root = tempRoot();
    const events = [
      ...syntheticEvents(),
      { t_monotonic_ms: 150, time_basis: { source: 'orchestrator', uncertainty_ms: { value: 0 } }, event: 'clock.sync', source: 'browser_rtt', offset_ms: 0, error_ms: 3 },
      { t_monotonic_ms: 1200, time_basis: { source: 'orchestrator', uncertainty_ms: { value: 0 } }, event: 'signal.sent', candidate_id: 'c_0001', phase: 'inhale', parameters: {}, sent_at: 1200 },
    ];
    const dir = writeSession(root, 's_tl', { events });
    await record(dir, { base: 100, jitter: () => 0, frames: 500 });
    const timeline = audioTimeline(dir, { center_sec: 1.1, span_sec: 2, bins: 100 });
    expect(timeline.available).toBe(true);
    expect(timeline.waveform?.mic).toHaveLength(100);
    const mark = timeline.marks?.find((m) => m.t_ms === 1200);
    expect(mark?.lane).toBe('cue');
    expect(mark?.sec).toBeCloseTo(1.1, 2);
    expect(timeline.clock?.browser_error_ms_max).toBe(3);
    expect(timeline.sync?.anchors).toBeGreaterThan(0);
    expect(timeline.sync?.ended).toBe(true);
    // 範囲外は返さない。
    const far = audioTimeline(dir, { center_sec: 8, span_sec: 2, bins: 100 });
    expect(far.marks?.some((m) => m.t_ms === 1200)).toBe(false);
  });
});
