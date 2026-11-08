/**
 * 会話の音声の保存（SAVE_SESSION_AUDIO）。音声はすべて合成。
 * WAV のヘッダ、ch の順序、時刻の対応、欠落、詰まり、エラーと空き不足の扱いを見る。
 */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SESSION_AUDIO_FILE,
  SESSION_AUDIO_SYNC_FILE,
  SessionAudioRecorder,
  nodeSessionAudioFileSystem,
  sessionAudioOffManifest,
} from '../../src/logging/session_audio';
import type { SessionAudioFile, SessionAudioFileSystem, SessionAudioOptions, SessionAudioProblem } from '../../src/logging/session_audio';
import { readSessionAudioConfig } from '../../src/app/config';

const FRAME = 320;

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'session-audio-'));
}

function frameOf(value: number, count = FRAME): Int16Array {
  return new Int16Array(count).fill(value);
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve));
};

function parseWav(file: string) {
  const data = readFileSync(file);
  return {
    riff: data.toString('latin1', 0, 4),
    riffSize: data.readUInt32LE(4),
    wave: data.toString('latin1', 8, 12),
    format: data.readUInt16LE(20),
    channels: data.readUInt16LE(22),
    rate: data.readUInt32LE(24),
    byteRate: data.readUInt32LE(28),
    blockAlign: data.readUInt16LE(32),
    bits: data.readUInt16LE(34),
    dataTag: data.toString('latin1', 36, 40),
    dataSize: data.readUInt32LE(40),
    fileSize: data.length,
    sample: (index: number, channel: 0 | 1) => data.readInt16LE(44 + index * 4 + channel * 2),
  };
}

function syncLines(dir: string): Record<string, unknown>[] {
  return readFileSync(join(dir, SESSION_AUDIO_SYNC_FILE), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function recorder(dir: string, options: Partial<SessionAudioOptions> = {}): SessionAudioRecorder {
  return new SessionAudioRecorder({ dir, session_id: 's', minFreeBytes: 0, ...options });
}

function pushRun(r: SessionAudioRecorder, frames: number, startFrame = 0, startT = 1000, value = 100): void {
  for (let i = 0; i < frames; i++) {
    const audioFrame = startFrame + i * FRAME;
    r.push(audioFrame, frameOf(value + i), frameOf(-value - i), startT + (i + 1) * 20);
  }
}

class MemoryFile implements SessionAudioFile {
  data = new Uint8Array(0);
  closed = false;
  syncs = 0;
  headerWrites = 0;
  constructor(private readonly fsRef: FakeFs) {}
  async write(data: Uint8Array): Promise<number> {
    await this.fsRef.beforeWrite();
    const take = Math.min(data.length, this.fsRef.maxPerWrite);
    const next = new Uint8Array(this.data.length + take);
    next.set(this.data);
    next.set(data.subarray(0, take), this.data.length);
    this.data = next;
    return take;
  }
  async writeAt(position: number, data: Uint8Array): Promise<void> {
    if (this.fsRef.stalled) await new Promise(() => undefined);
    this.headerWrites += 1;
    if (this.data.length < position + data.length) {
      const next = new Uint8Array(position + data.length);
      next.set(this.data);
      this.data = next;
    }
    this.data.set(data, position);
  }
  async sync(): Promise<void> {
    this.syncs += 1;
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

class FakeFs implements SessionAudioFileSystem {
  files = new Map<string, MemoryFile>();
  stalled = false;
  failAfterWrites: { after: number; code: string; persistent?: boolean } | null = null;
  writes = 0;
  /** 設定中は書き込みがこの Promise を待つ（遅いディスク）。 */
  gate: Promise<void> | null = null;
  maxPerWrite = Number.MAX_SAFE_INTEGER;
  free: number | null = 10 ** 12;
  async createExclusive(path: string): Promise<SessionAudioFile> {
    const file = new MemoryFile(this);
    this.files.set(path, file);
    return file;
  }
  async freeBytes(): Promise<number | null> {
    return this.free;
  }
  async beforeWrite(): Promise<void> {
    this.writes += 1;
    if (this.gate !== null) await this.gate;
    if (this.stalled) await new Promise(() => undefined);
    const fail = this.failAfterWrites;
    if (fail !== null && this.writes > fail.after) {
      if (!fail.persistent) this.failAfterWrites = null;
      throw Object.assign(new Error(fail.code), { code: fail.code });
    }
  }
  wav(): MemoryFile {
    const entry = [...this.files.entries()].find(([k]) => k.endsWith(SESSION_AUDIO_FILE));
    return entry?.[1] as MemoryFile;
  }
}

function headerDataSize(file: MemoryFile): number {
  return new DataView(file.data.buffer, file.data.byteOffset, file.data.byteLength).getUint32(40, true);
}

afterEach(() => {
  delete process.env.SAVE_SESSION_AUDIO;
});

describe('設定', () => {
  it('既定は保存しない。1 か true のときだけ保存する', () => {
    expect(readSessionAudioConfig({}).enabled).toBe(false);
    expect(readSessionAudioConfig({ SAVE_SESSION_AUDIO: '' }).enabled).toBe(false);
    expect(readSessionAudioConfig({ SAVE_SESSION_AUDIO: '0' }).enabled).toBe(false);
    expect(readSessionAudioConfig({ SAVE_SESSION_AUDIO: 'yes' }).enabled).toBe(false);
    expect(readSessionAudioConfig({ SAVE_SESSION_AUDIO: '1' }).enabled).toBe(true);
    expect(readSessionAudioConfig({ SAVE_SESSION_AUDIO: 'true' }).enabled).toBe(true);
  });

  it('空きの下限は既定 1024MB。不正な値は既定に戻す', () => {
    expect(readSessionAudioConfig({}).min_free_bytes).toBe(1024 * 1024 * 1024);
    expect(readSessionAudioConfig({ SAVE_SESSION_AUDIO_MIN_FREE_MB: '10' }).min_free_bytes).toBe(10 * 1024 * 1024);
    expect(readSessionAudioConfig({ SAVE_SESSION_AUDIO_MIN_FREE_MB: 'abc' }).min_free_bytes).toBe(1024 * 1024 * 1024);
    expect(readSessionAudioConfig({ SAVE_SESSION_AUDIO_MIN_FREE_MB: '-1' }).min_free_bytes).toBe(1024 * 1024 * 1024);
  });

  it('保存しないときの manifest の項目は saved=false で理由がある', () => {
    expect(sessionAudioOffManifest('x')).toMatchObject({ enabled: false, saved: false, reason: 'x', status: 'off', file: null });
  });
});

describe('WAV', () => {
  it('2ch、16kHz、16bit の正しいヘッダで、ch1 がマイク、ch2 が AI の音声', async () => {
    const dir = tempDir();
    const r = recorder(dir);
    pushRun(r, 50);
    const result = await r.close('done');
    const wav = parseWav(join(dir, SESSION_AUDIO_FILE));
    expect(wav).toMatchObject({ riff: 'RIFF', wave: 'WAVE', format: 1, channels: 2, rate: 16000, byteRate: 64000, blockAlign: 4, bits: 16, dataTag: 'data' });
    expect(wav.dataSize).toBe(50 * FRAME * 4);
    expect(wav.riffSize).toBe(36 + wav.dataSize);
    expect(wav.fileSize).toBe(44 + wav.dataSize);
    expect(wav.sample(0, 0)).toBe(100);
    expect(wav.sample(0, 1)).toBe(-100);
    expect(wav.sample(FRAME * 49, 0)).toBe(149);
    expect(wav.sample(FRAME * 49, 1)).toBe(-149);
    expect(result).toMatchObject({ enabled: true, saved: true, status: 'closed', file: SESSION_AUDIO_FILE, sync_file: SESSION_AUDIO_SYNC_FILE, wav_samples: 50 * FRAME, gap_count: 0, stop_reason: null });
    expect(result.duration_sec).toBeCloseTo(1, 5);
  });

  it('close は何度呼んでも同じ結果。閉じた後の枠は書かずに数える', async () => {
    const dir = tempDir();
    const r = recorder(dir);
    pushRun(r, 5);
    const first = await r.close('done');
    r.push(9999, frameOf(1), frameOf(1), 5000);
    const second = await r.close('again');
    expect(second).toBe(first);
    expect(r.manifest().frames_after_stop).toBe(FRAME);
    expect(parseWav(join(dir, SESSION_AUDIO_FILE)).dataSize).toBe(5 * FRAME * 4);
  });

  it('音声が1枠も来なければファイルを作らず saved=false', async () => {
    const dir = tempDir();
    const result = await recorder(dir).close('done');
    expect(existsSync(join(dir, SESSION_AUDIO_FILE))).toBe(false);
    expect(result).toMatchObject({ saved: false, reason: 'no_audio_frames', file: null });
  });

  it('途中でもヘッダを更新する（異常終了で閉じられなくても大部分が読める）', async () => {
    const fs = new FakeFs();
    const r = recorder('d', { fs, headerEveryBytes: 2 * FRAME * 4 });
    pushRun(r, 10);
    await flush();
    expect(fs.wav().headerWrites).toBeGreaterThan(0);
    const size = headerDataSize(fs.wav());
    expect(size).toBeGreaterThanOrEqual(8 * FRAME * 4);
    expect(size % 4).toBe(0);
    await r.close('done');
  });
});

describe('時刻の対応', () => {
  it('窓の中で受信の遅れが最小の枠を anchor にする', async () => {
    const dir = tempDir();
    const r = recorder(dir, { anchorEveryFrames: 16000 });
    // t = end/16 + 500 に、遅れを足す。1 窓の中に遅れ 0 の枠が 1 つだけある。
    for (let i = 0; i < 60; i++) {
      const end = (i + 1) * FRAME;
      r.push(i * FRAME, frameOf(1), frameOf(2), end / 16 + 500 + (i === 20 ? 0 : 30 + (i % 7)));
    }
    await r.close('done');
    const anchors = syncLines(dir).filter((l) => l.type === 'anchor');
    const windowAnchor = anchors.find((a) => a.audio_frame === 21 * FRAME);
    expect(windowAnchor).toBeDefined();
    expect(windowAnchor).toMatchObject({ wav_sample: 21 * FRAME, t_monotonic_ms: (21 * FRAME) / 16 + 500 });
    expect(windowAnchor?.spread_ms as number).toBeGreaterThan(30);
    const lines = syncLines(dir);
    expect(lines[0]).toMatchObject({ type: 'start', first_audio_frame: 0, sample_rate_hz: 16000, channels: ['mic', 'sys'] });
    expect(lines.at(-1)).toMatchObject({ type: 'end', wav_samples: 60 * FRAME });
  });

  it('audio_frame が 0 で始まらなくても WAV の先頭に対応が残る', async () => {
    const dir = tempDir();
    const r = recorder(dir);
    pushRun(r, 3, 160000);
    const result = await r.close('done');
    expect(result.first_audio_frame).toBe(160000);
    expect(syncLines(dir).find((l) => l.type === 'anchor')).toMatchObject({ audio_frame: 160000 + FRAME, wav_sample: FRAME });
  });
});

describe('欠落と重なり', () => {
  it('ブラウザの欠落は無音で埋めて WAV の位置を実時間に保ち、gap を残す', async () => {
    const dir = tempDir();
    const r = recorder(dir);
    r.push(0, frameOf(5), frameOf(6), 20);
    r.push(FRAME * 10, frameOf(7), frameOf(8), 220);
    const result = await r.close('done');
    const wav = parseWav(join(dir, SESSION_AUDIO_FILE));
    expect(wav.dataSize).toBe(11 * FRAME * 4);
    expect(wav.sample(FRAME, 0)).toBe(0);
    expect(wav.sample(FRAME * 10, 0)).toBe(7);
    expect(wav.sample(FRAME * 10, 1)).toBe(8);
    expect(result).toMatchObject({ gap_count: 1, gap_frames: 9 * FRAME });
    expect(syncLines(dir).find((l) => l.type === 'gap')).toMatchObject({ reason: 'client_gap', audio_frame: FRAME, frames: 9 * FRAME, wav_sample: FRAME, padded: true });
  });

  it('長すぎる欠落は埋めず、対応の区間を分ける', async () => {
    const dir = tempDir();
    const r = recorder(dir, { maxPadFrames: FRAME * 5 });
    r.push(0, frameOf(5), frameOf(6), 20);
    r.push(FRAME * 1000, frameOf(7), frameOf(8), 20000);
    const result = await r.close('done');
    expect(parseWav(join(dir, SESSION_AUDIO_FILE)).dataSize).toBe(2 * FRAME * 4);
    expect(result).toMatchObject({ gap_count: 1, gap_frames: 999 * FRAME });
    const lines = syncLines(dir);
    expect(lines.find((l) => l.type === 'gap')).toMatchObject({ padded: false });
    const anchors = lines.filter((l) => l.type === 'anchor');
    expect(anchors.at(-1)).toMatchObject({ seg: 1, wav_sample: 2 * FRAME });
  });

  it('重なって届いた分は重ねて書かない', async () => {
    const dir = tempDir();
    const r = recorder(dir);
    r.push(0, frameOf(1), frameOf(2), 20);
    r.push(FRAME / 2, frameOf(3), frameOf(4), 40);
    r.push(0, frameOf(9), frameOf(9), 60);
    const result = await r.close('done');
    const wav = parseWav(join(dir, SESSION_AUDIO_FILE));
    expect(wav.dataSize).toBe((FRAME + FRAME / 2) * 4);
    expect(wav.sample(FRAME - 1, 0)).toBe(1);
    expect(wav.sample(FRAME, 0)).toBe(3);
    expect(result.overlap_frames).toBe(FRAME / 2 + FRAME);
  });
});

describe('書き込みが遅い・詰まる', () => {
  it('詰まっても push は待たず、上限を超えた分は無音に置き換えて記録する', async () => {
    const fs = new FakeFs();
    const problems: SessionAudioProblem[] = [];
    const r = recorder('d', { fs, maxQueueBytes: FRAME * 4 * 10, closeTimeoutMs: 50, onProblem: (p) => problems.push(p) });
    pushRun(r, 2);
    await flush();
    fs.stalled = true;
    const before = performance.now();
    pushRun(r, 200, FRAME * 2);
    // 200 枠を積むだけ。実時間の 4 秒分より十分短い。
    expect(performance.now() - before).toBeLessThan(200);
    expect(problems.some((p) => p.kind === 'queue_overflow')).toBe(true);
    expect(r.manifest().overflow_frames).toBeGreaterThan(0);
    const result = await r.close('done');
    expect(result.close_timed_out).toBe(true);
    expect(result.status).toBe('closed');
    expect(result.gap_count).toBeGreaterThan(0);
  });

  it('遅いだけなら追いついた後に正しい長さの WAV になり、溢れた区間は無音で gap に残る', async () => {
    const fs = new FakeFs();
    const r = recorder('d', { fs, maxQueueBytes: FRAME * 4 * 5 });
    r.push(0, frameOf(1), frameOf(2), 20);
    await flush();
    let release: () => void = () => undefined;
    fs.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    for (let i = 1; i <= 20; i++) r.push(i * FRAME, frameOf(1000 + i), frameOf(2), 20 + i * 20);
    const overflowed = r.manifest().overflow_frames;
    expect(overflowed).toBeGreaterThan(0);
    release();
    fs.gate = null;
    // 溢れが終わった後の枠は普通に書かれる。
    await flush();
    r.push(21 * FRAME, frameOf(4242), frameOf(2), 460);
    const result = await r.close('done');
    expect(result.overflow_frames).toBe(overflowed);
    const wav = fs.wav();
    expect(headerDataSize(wav)).toBe(22 * FRAME * 4);
    expect(wav.data.length).toBe(44 + 22 * FRAME * 4);
    const view = new DataView(wav.data.buffer, wav.data.byteOffset, wav.data.byteLength);
    const micAt = (frame: number) => view.getInt16(44 + frame * FRAME * 4, true);
    // 溢れた区間（最後の方の枠）は無音、その後は実データ。WAV の位置は実時間のまま。
    expect(micAt(20)).toBe(0);
    expect(micAt(21)).toBe(4242);
    const sync = new TextDecoder().decode([...fs.files.entries()].find(([k]) => k.endsWith(SESSION_AUDIO_SYNC_FILE))?.[1].data);
    const gap = sync
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((l) => l.type === 'gap');
    expect(gap).toMatchObject({ reason: 'queue_overflow', frames: overflowed, padded: true });
  });
});

describe('エラーと空き', () => {
  it('ENOSPC では止めて、書けた分でヘッダを閉じる。以後は数えるだけ', async () => {
    const fs = new FakeFs();
    const problems: SessionAudioProblem[] = [];
    const r = recorder('d', { fs, onProblem: (p) => problems.push(p) });
    pushRun(r, 4);
    await flush();
    fs.failAfterWrites = { after: fs.writes, code: 'ENOSPC', persistent: true };
    pushRun(r, 4, FRAME * 4, 2000);
    await flush();
    pushRun(r, 3, FRAME * 8, 3000);
    const result = await r.close('done');
    expect(result).toMatchObject({ stop_reason: 'disk_full', status: 'closed', saved: true });
    expect(result.frames_after_stop).toBe(7 * FRAME);
    expect(problems.some((p) => p.kind === 'disk_full')).toBe(true);
    const wav = fs.wav();
    expect(wav.closed).toBe(true);
    expect(headerDataSize(wav)).toBe(wav.data.length - 44);
    expect(headerDataSize(wav) % 4).toBe(0);
  });

  it('その他の書き込みエラーは再試行し、回復すれば続ける', async () => {
    const fs = new FakeFs();
    const r = recorder('d', { fs, retryMs: 1 });
    pushRun(r, 2);
    await flush();
    fs.failAfterWrites = { after: fs.writes, code: 'EIO' };
    pushRun(r, 2, FRAME * 2, 2000);
    const result = await r.close('done');
    expect(result).toMatchObject({ stop_reason: null, wav_samples: 4 * FRAME });
    expect(result.write_retries).toBeGreaterThan(0);
  });

  it('再試行が尽きると write_failed で止める。エラーで例外を外へ出さない', async () => {
    const fs = new FakeFs();
    const r = recorder('d', { fs, retryMs: 1, writeRetries: 1 });
    pushRun(r, 2);
    await flush();
    fs.failAfterWrites = { after: fs.writes, code: 'EIO', persistent: true };
    expect(() => pushRun(r, 2, FRAME * 2, 2000)).not.toThrow();
    const result = await r.close('done');
    expect(result.stop_reason).toBe('write_failed');
    expect(fs.wav().closed).toBe(true);
  });

  it('部分書き込みでもヘッダはサンプルの境界に揃う', async () => {
    const fs = new FakeFs();
    fs.maxPerWrite = 7;
    const r = recorder('d', { fs });
    pushRun(r, 1);
    await flush();
    fs.failAfterWrites = { after: fs.writes, code: 'ENOSPC', persistent: true };
    pushRun(r, 2, FRAME, 2000);
    await r.close('done');
    expect(headerDataSize(fs.wav()) % 4).toBe(0);
  });

  it('始める時点で空きが足りなければ作らない', async () => {
    const fs = new FakeFs();
    fs.free = 100;
    const r = recorder('d', { fs, minFreeBytes: 1000 });
    pushRun(r, 3);
    await flush();
    const result = await r.close('done');
    expect(result).toMatchObject({ saved: false, stop_reason: 'disk_low_at_start', file: null });
    expect(fs.files.size).toBe(0);
  });

  it('途中で空きが足りなくなったら止めて閉じる', async () => {
    const fs = new FakeFs();
    const problems: SessionAudioProblem[] = [];
    const r = recorder('d', { fs, minFreeBytes: 1000, diskCheckEveryBytes: FRAME * 4 * 2, onProblem: (p) => problems.push(p) });
    pushRun(r, 3);
    await flush();
    fs.free = 100;
    pushRun(r, 5, FRAME * 3, 2000);
    await flush();
    const result = await r.close('done');
    expect(result).toMatchObject({ stop_reason: 'disk_low', saved: true });
    expect(problems.some((p) => p.kind === 'disk_low')).toBe(true);
    expect(fs.wav().closed).toBe(true);
    expect(headerDataSize(fs.wav())).toBe(fs.wav().data.length - 44);
  });

  it('既にファイルがあれば上書きしない（open_failed）', async () => {
    const dir = tempDir();
    const first = recorder(dir);
    pushRun(first, 1);
    await first.close('done');
    const original = readFileSync(join(dir, SESSION_AUDIO_FILE));
    const second = recorder(dir, { fs: nodeSessionAudioFileSystem });
    pushRun(second, 1);
    const result = await second.close('done');
    expect(result.stop_reason).toBe('open_failed');
    expect(readFileSync(join(dir, SESSION_AUDIO_FILE))).toEqual(original);
  });
});
