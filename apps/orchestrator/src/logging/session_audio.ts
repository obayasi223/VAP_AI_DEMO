/**
 * 会話の音声の保存（SAVE_SESSION_AUDIO=1 のときだけ。既定では作られない）。研究者本人の自己実験用。
 * 他者の音声を保存する前に、同意の手順が要る（docs/known_gaps.md §13）。
 *
 * <dir>/<session_id>/
 *   session_audio.wav          2ch、16kHz、PCM 16bit。ch1 = mic、ch2 = sys（AI の再生音声）。上りの AUDIO 枠（MaAI に渡すものと同じ）
 *   session_audio_sync.jsonl   音声の位置と t_monotonic_ms の対応（評価画面が読む）
 *
 * 対応の取り方: AUDIO 枠を受け取った時刻（JSONL と同じ時計）と、その枠の末尾の audio_frame を組にする。
 * 受信の遅れは常に 0 以上なので、1 秒の窓の中で「最も遅れの小さい枠」を anchor として残す（下側包絡）。
 * vap.state の組（推論の遅れを含む）より、数百 ms 小さい誤差で引ける。
 *
 * 実時間の経路を止めないために:
 *  - push() は同期で、並べ替えて積むだけ。入出力は裏で進め、ここから例外は出さない。
 *  - キューには上限があり、超えた分は音声の代わりに無音（0）を置く。WAV の位置は実時間のまま進み、欠落は gap として残る。
 * 壊れたファイルを残さないために:
 *  - WAV のヘッダは書き込みの途中でも定期的に更新する（異常終了でも最後の数秒以外は読める）。終了とエラーの時に閉じる。
 *  - 空きが少ないときは始めない・途中で止める（セッションは止めない）。理由は manifest と provider.status に残す。
 */
import { open, statfs } from 'node:fs/promises';
import { join } from 'node:path';

export const SESSION_AUDIO_FILE = 'session_audio.wav';
export const SESSION_AUDIO_SYNC_FILE = 'session_audio_sync.jsonl';
export const SESSION_AUDIO_RATE_HZ = 16000;
const CHANNELS = 2;
const BLOCK_ALIGN = CHANNELS * 2;
const WAV_HEADER_BYTES = 44;
const FRAMES_PER_MS = SESSION_AUDIO_RATE_HZ / 1000;
/** 1 回の書き込みの上限。 */
const MAX_WRITE_BYTES = 256 * 1024;
/** WAV の 32bit の長さに収まる上限。超えると止める（約 18 時間）。 */
const WAV_DATA_LIMIT_BYTES = 0xffffffff - WAV_HEADER_BYTES - MAX_WRITE_BYTES;

// ---- ファイル操作（試験で失敗と詰まりを注入する） ----------------------------

export interface SessionAudioFile {
  /** 末尾へ追記して、書けたバイト数を返す。 */
  write(data: Uint8Array): Promise<number>;
  /** 位置を指定して上書きする（WAV のヘッダ）。 */
  writeAt(position: number, data: Uint8Array): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface SessionAudioFileSystem {
  /** 既にあれば失敗する。 */
  createExclusive(path: string): Promise<SessionAudioFile>;
  /** 使える空きバイト数。分からなければ null。 */
  freeBytes(path: string): Promise<number | null>;
}

export const nodeSessionAudioFileSystem: SessionAudioFileSystem = {
  async createExclusive(path) {
    const handle = await open(path, 'wx');
    return {
      async write(data) {
        const { bytesWritten } = await handle.write(data);
        return bytesWritten;
      },
      async writeAt(position, data) {
        await handle.write(data, 0, data.length, position);
      },
      sync: () => handle.sync(),
      close: () => handle.close(),
    };
  },
  async freeBytes(path) {
    const info = await statfs(path);
    return Number(info.bavail) * Number(info.bsize);
  },
};

// ---- 公開の型 --------------------------------------------------------------

export type SessionAudioStatus = 'waiting_for_audio' | 'recording' | 'stopped' | 'closed';
export type SessionAudioStopReason =
  | 'disk_low_at_start'
  | 'disk_low'
  | 'disk_full'
  | 'write_failed'
  | 'open_failed'
  | 'wav_size_limit';
export type SessionAudioGapReason = 'client_gap' | 'queue_overflow';

export interface SessionAudioGap {
  reason: SessionAudioGapReason;
  /** 欠けた最初の audio_frame。 */
  audio_frame: number;
  frames: number;
  /** WAV の中の位置（サンプル）。 */
  wav_sample: number;
  /** true なら無音で埋めた（WAV の時間は実時間のまま）。false は長すぎて埋めていない（WAV の位置が飛ぶ）。 */
  padded: boolean;
}

export interface SessionAudioManifest {
  enabled: boolean;
  saved: boolean;
  /** 保存していない理由、または問題。 */
  reason: string | null;
  status: SessionAudioStatus | 'off';
  file: string | null;
  sync_file: string | null;
  format: { container: 'wav'; encoding: 'pcm_s16le'; sample_rate_hz: number; channels: ['mic', 'sys'] } | null;
  /** WAV の先頭の audio_frame（0 とは限らない）。 */
  first_audio_frame: number | null;
  first_t_monotonic_ms: number | null;
  /** WAV のチャネルあたりのサンプル数（ファイルに書けたもの）。 */
  wav_samples: number;
  duration_sec: number;
  anchors: number;
  gap_count: number;
  gap_frames: number;
  /** 書き込みが追いつかず、無音に置き換えたサンプル数。 */
  overflow_frames: number;
  /** 重なって届き、捨てたサンプル数（欠落ではない）。 */
  overlap_frames: number;
  /** 止めた・閉じた後に届いた分と、止めたときに書けていなかった分（保存していないサンプル数）。 */
  frames_after_stop: number;
  stop_reason: SessionAudioStopReason | null;
  write_retries: number;
  sync_file_errors: number;
  /** close が期限内に書き切れなかった。 */
  close_timed_out: boolean;
  queue_peak_bytes: number;
  min_free_bytes: number;
  notice: string;
}

export interface SessionAudioProblem {
  kind: 'disk_low' | 'disk_full' | 'write_failed' | 'open_failed' | 'queue_overflow' | 'wav_size_limit' | 'sync_file';
  message: string;
}

export interface SessionAudioOptions {
  dir: string;
  session_id: string;
  fs?: SessionAudioFileSystem;
  /** 空きがこれを下回ると始めない・止める。既定 1GiB。 */
  minFreeBytes?: number;
  /** 書き込み待ちの上限。既定 64MiB（約 17 分）。 */
  maxQueueBytes?: number;
  /** anchor を残す間隔（枠）。既定 1 秒。 */
  anchorEveryFrames?: number;
  /** ブラウザ側の欠落を無音で埋める上限（枠）。既定 60 秒（SESSION_RESUME_GRACE_MS より長い）。 */
  maxPadFrames?: number;
  /** WAV のヘッダを更新する間隔（バイト）。既定 128KiB（約 2 秒）。 */
  headerEveryBytes?: number;
  /** 空きを調べる間隔（バイト）。既定 640KiB（約 10 秒）。 */
  diskCheckEveryBytes?: number;
  /** 書き込みの再試行の回数と間隔。 */
  writeRetries?: number;
  retryMs?: number;
  /** close の上限。既定 3 秒。 */
  closeTimeoutMs?: number;
  onProblem?: (problem: SessionAudioProblem) => void;
}

export const SESSION_AUDIO_NOTICE = '研究者本人の自己実験の音声のみ。他者の音声は同意の手順が決まるまで保存しない（docs/known_gaps.md §13）';

/** 保存しないときの manifest の項目。 */
export function sessionAudioOffManifest(reason: string): SessionAudioManifest {
  return {
    enabled: false,
    saved: false,
    reason,
    status: 'off',
    file: null,
    sync_file: null,
    format: null,
    first_audio_frame: null,
    first_t_monotonic_ms: null,
    wav_samples: 0,
    duration_sec: 0,
    anchors: 0,
    gap_count: 0,
    gap_frames: 0,
    overflow_frames: 0,
    overlap_frames: 0,
    frames_after_stop: 0,
    stop_reason: null,
    write_retries: 0,
    sync_file_errors: 0,
    close_timed_out: false,
    queue_peak_bytes: 0,
    min_free_bytes: 0,
    notice: SESSION_AUDIO_NOTICE,
  };
}

/** 44 バイトの標準の WAV ヘッダ（PCM 16bit、2ch）。 */
export function wavHeader(dataBytes: number): Uint8Array {
  const out = new Uint8Array(WAV_HEADER_BYTES);
  const view = new DataView(out.buffer);
  const tag = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) out[at + i] = text.charCodeAt(i);
  };
  tag(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, CHANNELS, true);
  view.setUint32(24, SESSION_AUDIO_RATE_HZ, true);
  view.setUint32(28, SESSION_AUDIO_RATE_HZ * BLOCK_ALIGN, true);
  view.setUint16(32, BLOCK_ALIGN, true);
  view.setUint16(34, 16, true);
  tag(36, 'data');
  view.setUint32(40, dataBytes, true);
  return out;
}

type Chunk =
  | { kind: 'pcm'; data: Uint8Array }
  | { kind: 'zeros'; bytes: number }
  | { kind: 'sync'; line: string };

interface WindowBest {
  audio_frame: number;
  wav_sample: number;
  t_ms: number;
  offset: number;
}

const encoder = new TextEncoder();

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}

class WriterStopped extends Error {}

export class SessionAudioRecorder {
  private readonly fs: SessionAudioFileSystem;
  private readonly minFreeBytes: number;
  private readonly maxQueueBytes: number;
  private readonly anchorEveryFrames: number;
  private readonly maxPadFrames: number;
  private readonly headerEveryBytes: number;
  private readonly diskCheckEveryBytes: number;
  private readonly writeRetries: number;
  private readonly retryMs: number;
  private readonly closeTimeoutMs: number;
  private readonly notify: (problem: SessionAudioProblem) => void;
  private readonly wavPath: string;
  private readonly syncPath: string;
  private readonly dirForDisk: string;

  private status: SessionAudioStatus = 'waiting_for_audio';
  private stopReason: SessionAudioStopReason | null = null;
  private stopDetail: string | null = null;
  private wav: SessionAudioFile | null = null;
  private syncFile: SessionAudioFile | null = null;
  private syncBroken = false;
  private finalized: Promise<void> | null = null;
  private closing: Promise<SessionAudioManifest> | null = null;
  private closeTimedOut = false;

  private chunks: Chunk[] = [];
  private queueBytes = 0;
  private queuePeak = 0;
  private pumping = false;
  private pumpIdle: Promise<void> = Promise.resolve();
  private resolveIdle: (() => void) | null = null;

  private firstAudioFrame: number | null = null;
  private firstT: number | null = null;
  private nextFrame = 0;
  /** push の時点の論理的な WAV の位置（無音も含む）。 */
  private wavSample = 0;
  private segment = 0;
  private anchors = 0;
  private window: { startFrame: number; best: WindowBest; maxOffset: number; frames: number } | null = null;

  private overflow: { audio_frame: number; wav_sample: number; frames: number } | null = null;
  private overflowFrames = 0;
  private overlapFrames = 0;
  private framesAfterStop = 0;
  private gapCount = 0;
  private gapFrames = 0;

  private dataBytes = 0;
  private bytesSinceHeader = 0;
  private bytesSinceDiskCheck = 0;
  private retriesUsed = 0;
  private syncErrors = 0;

  constructor(options: SessionAudioOptions) {
    this.fs = options.fs ?? nodeSessionAudioFileSystem;
    this.minFreeBytes = options.minFreeBytes ?? 1024 * 1024 * 1024;
    this.maxQueueBytes = options.maxQueueBytes ?? 64 * 1024 * 1024;
    this.anchorEveryFrames = options.anchorEveryFrames ?? SESSION_AUDIO_RATE_HZ;
    this.maxPadFrames = options.maxPadFrames ?? 60 * SESSION_AUDIO_RATE_HZ;
    this.headerEveryBytes = options.headerEveryBytes ?? 128 * 1024;
    this.diskCheckEveryBytes = options.diskCheckEveryBytes ?? 640 * 1024;
    this.writeRetries = options.writeRetries ?? 3;
    this.retryMs = options.retryMs ?? 200;
    this.closeTimeoutMs = options.closeTimeoutMs ?? 3000;
    this.notify = options.onProblem ?? (() => undefined);
    this.wavPath = join(options.dir, SESSION_AUDIO_FILE);
    this.syncPath = join(options.dir, SESSION_AUDIO_SYNC_FILE);
    this.dirForDisk = options.dir;
  }

  // ---- 実時間の経路から呼ぶ（同期、例外なし） ---------------------------------

  /** 上りの AUDIO 枠を1つ受ける。t_ms は受信の時刻（JSONL の t_monotonic_ms と同じ時計）。 */
  push(audio_frame: number, mic: Int16Array, sys: Int16Array, t_ms: number): void {
    try {
      this.pushFrame(audio_frame, mic, sys, t_ms);
    } catch (error) {
      // 音声の経路を止めない。保存だけ諦める。
      this.requestStop('write_failed', `push failed: ${errorMessage(error)}`);
    }
  }

  private pushFrame(audio_frame: number, mic: Int16Array, sys: Int16Array, t_ms: number): void {
    const count = Math.min(mic.length, sys.length);
    if (count === 0) return;
    if (this.stopReason !== null || this.closing !== null) {
      this.framesAfterStop += count;
      return;
    }
    if (this.firstAudioFrame === null) {
      this.firstAudioFrame = audio_frame;
      this.firstT = t_ms;
      this.nextFrame = audio_frame;
      this.enqueueSync({
        type: 'start',
        version: 1,
        sample_rate_hz: SESSION_AUDIO_RATE_HZ,
        channels: ['mic', 'sys'],
        first_audio_frame: audio_frame,
        first_t_monotonic_ms: round3(t_ms),
      });
    }
    let skip = 0;
    if (audio_frame < this.nextFrame) {
      skip = Math.min(count, this.nextFrame - audio_frame);
      this.overlapFrames += skip;
      if (skip === count) return;
    } else if (audio_frame > this.nextFrame) {
      this.recordClientGap(audio_frame);
    }
    const accepted = count - skip;
    const end = audio_frame + count;
    const bytes = accepted * BLOCK_ALIGN;
    if (this.queueBytes + bytes > this.maxQueueBytes) {
      this.noteOverflow(audio_frame + skip, accepted);
      this.enqueueZeros(bytes);
    } else {
      this.endOverflow();
      this.enqueuePcm(this.interleave(mic, sys, skip, count));
    }
    this.wavSample += accepted;
    this.nextFrame = end;
    this.observeAnchor(end, this.wavSample, t_ms);
    this.kick();
  }

  private recordClientGap(audio_frame: number): void {
    this.flushWindow();
    this.endOverflow();
    const frames = audio_frame - this.nextFrame;
    const padded = frames <= this.maxPadFrames;
    const gap: SessionAudioGap = { reason: 'client_gap', audio_frame: this.nextFrame, frames, wav_sample: this.wavSample, padded };
    this.noteGap(gap);
    if (padded) {
      this.enqueueZeros(frames * BLOCK_ALIGN);
      this.wavSample += frames;
    } else {
      // WAV の位置はここで audio_frame から離れる。対応は次の anchor から別の区間として読む。
      this.segment += 1;
    }
    this.nextFrame = audio_frame;
  }

  private noteGap(gap: SessionAudioGap): void {
    this.gapCount += 1;
    this.gapFrames += gap.frames;
    this.enqueueSync({ type: 'gap', ...gap });
  }

  private noteOverflow(audio_frame: number, frames: number): void {
    if (this.overflow === null) {
      this.overflow = { audio_frame, wav_sample: this.wavSample, frames: 0 };
      this.safeNotify({ kind: 'queue_overflow', message: 'write queue full; saving silence and recording a gap' });
    }
    this.overflow.frames += frames;
    this.overflowFrames += frames;
  }

  private endOverflow(): void {
    const run = this.overflow;
    if (run === null) return;
    this.overflow = null;
    this.noteGap({ reason: 'queue_overflow', audio_frame: run.audio_frame, frames: run.frames, wav_sample: run.wav_sample, padded: true });
  }

  /** ch1 = mic、ch2 = sys。ホストはリトルエンディアン前提（x86／arm の Node）。 */
  private interleave(mic: Int16Array, sys: Int16Array, skip: number, count: number): Uint8Array {
    const out = new Int16Array((count - skip) * CHANNELS);
    let at = 0;
    for (let i = skip; i < count; i++) {
      out[at++] = mic[i] as number;
      out[at++] = sys[i] as number;
    }
    return new Uint8Array(out.buffer);
  }

  private enqueuePcm(data: Uint8Array): void {
    this.chunks.push({ kind: 'pcm', data });
    this.queueBytes += data.length;
    this.queuePeak = Math.max(this.queuePeak, this.queueBytes);
  }

  private enqueueZeros(bytes: number): void {
    const last = this.chunks[this.chunks.length - 1];
    if (last?.kind === 'zeros') last.bytes += bytes;
    else this.chunks.push({ kind: 'zeros', bytes });
  }

  private enqueueSync(record: Record<string, unknown>): void {
    this.chunks.push({ kind: 'sync', line: `${JSON.stringify(record)}\n` });
  }

  /** 1 秒の窓の中で受信の遅れが最小の枠を anchor にする。受信の遅れは 0 未満にならない。 */
  private observeAnchor(end_frame: number, wav_sample: number, t_ms: number): void {
    const offset = t_ms - end_frame / FRAMES_PER_MS;
    const current = this.window;
    if (current === null) {
      this.window = { startFrame: end_frame, best: { audio_frame: end_frame, wav_sample, t_ms, offset }, maxOffset: offset, frames: 1 };
      return;
    }
    current.frames += 1;
    current.maxOffset = Math.max(current.maxOffset, offset);
    if (offset < current.best.offset) current.best = { audio_frame: end_frame, wav_sample, t_ms, offset };
    if (end_frame - current.startFrame >= this.anchorEveryFrames) this.flushWindow();
  }

  private writeAnchor(window: { best: WindowBest; maxOffset: number; frames: number }): void {
    this.anchors += 1;
    this.enqueueSync({
      type: 'anchor',
      seg: this.segment,
      audio_frame: window.best.audio_frame,
      wav_sample: window.best.wav_sample,
      t_monotonic_ms: round3(window.best.t_ms),
      // 窓の中の受信の遅れの幅。対応の精度の目安。
      spread_ms: round3(window.maxOffset - window.best.offset),
      frames: window.frames,
    });
  }

  private flushWindow(): void {
    const current = this.window;
    if (current === null) return;
    this.window = null;
    this.writeAnchor(current);
  }

  private kick(): void {
    if (this.pumping || this.stopReason !== null) return;
    this.pumping = true;
    this.pumpIdle = new Promise((resolve) => {
      this.resolveIdle = resolve;
    });
    setImmediate(() => void this.pump());
  }

  private safeNotify(problem: SessionAudioProblem): void {
    try {
      this.notify(problem);
    } catch {
      // 報告先の失敗で音声の経路を止めない。manifest には残る。
    }
  }

  // ---- 裏の書き込み ------------------------------------------------------------

  private async pump(): Promise<void> {
    try {
      if (this.wav === null && this.stopReason === null && !(await this.openFiles())) return;
      while (this.stopReason === null) {
        const chunk = this.chunks.shift();
        if (chunk === undefined) break;
        if (chunk.kind === 'sync') {
          await this.writeSync(chunk.line);
          continue;
        }
        await this.writeAudioChunk(chunk);
      }
    } catch (error) {
      if (!(error instanceof WriterStopped)) this.requestStop('write_failed', errorMessage(error));
    } finally {
      this.pumping = false;
      this.resolveIdle?.();
      this.resolveIdle = null;
      if (this.chunks.length > 0 && this.stopReason === null) this.kick();
    }
  }

  private async openFiles(): Promise<boolean> {
    const free = await this.freeBytes();
    if (free !== null && free < this.minFreeBytes) {
      this.requestStop('disk_low_at_start', `free space ${free} bytes is below the minimum ${this.minFreeBytes}`);
      return false;
    }
    try {
      const wav = await this.fs.createExclusive(this.wavPath);
      this.wav = wav;
      await this.writeFully(wav, wavHeader(0), false);
    } catch (error) {
      this.requestStop('open_failed', errorMessage(error));
      return false;
    }
    try {
      this.syncFile = await this.fs.createExclusive(this.syncPath);
    } catch (error) {
      this.noteSyncProblem(`sync file not created: ${errorMessage(error)}`);
    }
    this.status = 'recording';
    return true;
  }

  private async freeBytes(): Promise<number | null> {
    try {
      return await this.fs.freeBytes(this.dirForDisk);
    } catch {
      return null;
    }
  }

  private async writeAudioChunk(chunk: Exclude<Chunk, { kind: 'sync' }>): Promise<void> {
    if (chunk.kind === 'zeros') {
      let remaining = chunk.bytes;
      const zeros = new Uint8Array(Math.min(remaining, MAX_WRITE_BYTES));
      while (remaining > 0 && this.stopReason === null) {
        const size = Math.min(remaining, zeros.length);
        await this.appendAudio(zeros.subarray(0, size));
        remaining -= size;
      }
      return;
    }
    // 連続する pcm は 1 回の書き込みにまとめる。
    let total = chunk.data.length;
    const batch = [chunk.data];
    this.queueBytes -= chunk.data.length;
    while (this.chunks[0]?.kind === 'pcm' && total + this.chunks[0].data.length <= MAX_WRITE_BYTES) {
      const next = this.chunks.shift() as { kind: 'pcm'; data: Uint8Array };
      batch.push(next.data);
      total += next.data.length;
      this.queueBytes -= next.data.length;
    }
    const data = new Uint8Array(total);
    let at = 0;
    for (const part of batch) {
      data.set(part, at);
      at += part.length;
    }
    await this.appendAudio(data);
  }

  private async appendAudio(data: Uint8Array): Promise<void> {
    const wav = this.wav as SessionAudioFile;
    if (this.dataBytes + data.length > WAV_DATA_LIMIT_BYTES) {
      this.requestStop('wav_size_limit', 'the WAV reached its 32-bit size limit');
      throw new WriterStopped();
    }
    await this.writeFully(wav, data, true);
    this.bytesSinceHeader += data.length;
    this.bytesSinceDiskCheck += data.length;
    if (this.bytesSinceHeader >= this.headerEveryBytes) {
      this.bytesSinceHeader = 0;
      await this.patchHeader();
    }
    if (this.bytesSinceDiskCheck >= this.diskCheckEveryBytes) {
      this.bytesSinceDiskCheck = 0;
      const free = await this.freeBytes();
      if (free !== null && free < this.minFreeBytes) {
        this.requestStop('disk_low', `free space ${free} bytes is below the minimum ${this.minFreeBytes}`);
        throw new WriterStopped();
      }
    }
  }

  private async writeFully(file: SessionAudioFile, data: Uint8Array, countAsAudio: boolean): Promise<void> {
    let offset = 0;
    let failures = 0;
    while (offset < data.length) {
      try {
        const wrote = await file.write(data.subarray(offset));
        if (wrote <= 0) throw new Error('write returned no progress');
        offset += wrote;
        if (countAsAudio) this.dataBytes += wrote;
        failures = 0;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOSPC') {
          this.requestStop('disk_full', errorMessage(error));
          throw new WriterStopped();
        }
        failures += 1;
        this.retriesUsed += 1;
        if (failures > this.writeRetries) {
          this.requestStop('write_failed', errorMessage(error));
          throw new WriterStopped();
        }
        await delay(this.retryMs);
      }
    }
  }

  private async writeSync(line: string): Promise<void> {
    if (this.syncFile === null || this.syncBroken) return;
    try {
      await this.syncFile.write(encoder.encode(line));
    } catch (error) {
      this.syncBroken = true;
      this.noteSyncProblem(`sync file write failed: ${errorMessage(error)}`);
    }
  }

  private noteSyncProblem(message: string): void {
    this.syncErrors += 1;
    this.safeNotify({ kind: 'sync_file', message });
  }

  private async patchHeader(): Promise<void> {
    if (this.wav === null) return;
    // 部分書き込みで止まっても、ヘッダの長さはサンプルの境界に揃える。
    const data = this.dataBytes - (this.dataBytes % BLOCK_ALIGN);
    await this.wav.writeAt(0, wavHeader(data));
  }

  // ---- 止める・閉じる ----------------------------------------------------------

  private requestStop(reason: SessionAudioStopReason, detail: string): void {
    if (this.stopReason !== null) return;
    this.stopReason = reason;
    this.stopDetail = detail;
    this.status = 'stopped';
    // 残りは書けない。書けなかった量は manifest で論理的な位置との差として数える（書き込みの途中の分も入る）。
    this.chunks = [];
    this.queueBytes = 0;
    this.safeNotify({
      kind: reason === 'disk_low_at_start' || reason === 'disk_low' ? 'disk_low' : reason === 'disk_full' ? 'disk_full' : reason === 'open_failed' ? 'open_failed' : reason === 'wav_size_limit' ? 'wav_size_limit' : 'write_failed',
      message: detail,
    });
    void this.finalize(reason);
  }

  /** ヘッダを実際の長さに直して閉じる。何度呼んでも 1 回だけ。 */
  private finalize(reason: string): Promise<void> {
    this.finalized ??= this.doFinalize(reason);
    return this.finalized;
  }

  private async doFinalize(reason: string): Promise<void> {
    // pump の途中の書き込みを待つ（期限は close の側で切る）。
    await this.pumpIdle;
    await this.closeFiles(reason);
  }

  private async closeFiles(reason: string): Promise<void> {
    const wav = this.wav;
    this.wav = null;
    if (wav !== null) {
      try {
        const data = this.dataBytes - (this.dataBytes % BLOCK_ALIGN);
        await wav.writeAt(0, wavHeader(data));
        await wav.sync();
      } catch (error) {
        this.stopDetail ??= `header not finalized: ${errorMessage(error)}`;
      }
      await wav.close().catch(() => undefined);
    }
    const sync = this.syncFile;
    this.syncFile = null;
    if (sync !== null) {
      const end = {
        type: 'end',
        reason,
        wav_samples: Math.floor(this.dataBytes / BLOCK_ALIGN),
        stop_reason: this.stopReason,
      };
      if (!this.syncBroken) await sync.write(encoder.encode(`${JSON.stringify(end)}\n`)).catch(() => undefined);
      await sync.sync().catch(() => undefined);
      await sync.close().catch(() => undefined);
    }
  }

  /** セッションの終了で呼ぶ。何度呼んでも同じ結果。期限を過ぎても返す（制御の終了を止めない）。 */
  close(reason: string): Promise<SessionAudioManifest> {
    this.closing ??= this.doClose(reason);
    return this.closing;
  }

  private async doClose(reason: string): Promise<SessionAudioManifest> {
    this.flushWindow();
    this.endOverflow();
    if (this.chunks.length > 0) this.kick();
    const timeout = delay(this.closeTimeoutMs).then(() => 'timeout' as const);
    const outcome = await Promise.race([this.drain().then(() => 'done' as const), timeout]);
    if (outcome === 'timeout') {
      // 書き込みが返ってこない。待たずに、書けた分のヘッダを直して閉じる。
      this.closeTimedOut = true;
      void this.closeFiles(`${reason}:close_timed_out`);
      this.status = 'closed';
      return this.manifest();
    }
    await Promise.race([this.finalize(reason), delay(this.closeTimeoutMs)]);
    this.status = 'closed';
    return this.manifest();
  }

  /** キューが空になり、pump が止まるまで待つ。 */
  private async drain(): Promise<void> {
    while (this.pumping || (this.chunks.length > 0 && this.stopReason === null)) {
      await this.pumpIdle;
      if (this.chunks.length > 0 && this.stopReason === null && !this.pumping) this.kick();
    }
  }

  // ---- 記録 --------------------------------------------------------------------

  manifest(): SessionAudioManifest {
    const wav_samples = Math.floor(this.dataBytes / BLOCK_ALIGN);
    const opened = this.firstAudioFrame !== null && wav_samples + this.gapFrames > 0;
    const saved = opened && this.stopReason !== 'disk_low_at_start' && this.stopReason !== 'open_failed';
    const reason =
      this.stopReason !== null
        ? `${this.stopReason}${this.stopDetail ? `: ${this.stopDetail}`.slice(0, 200) : ''}`
        : saved
          ? null
          : this.closeTimedOut
            ? 'close_timed_out'
            : 'no_audio_frames';
    return {
      enabled: true,
      saved,
      reason,
      status: this.status,
      file: saved ? SESSION_AUDIO_FILE : null,
      sync_file: saved && this.syncErrors === 0 ? SESSION_AUDIO_SYNC_FILE : null,
      format: saved ? { container: 'wav', encoding: 'pcm_s16le', sample_rate_hz: SESSION_AUDIO_RATE_HZ, channels: ['mic', 'sys'] } : null,
      first_audio_frame: this.firstAudioFrame,
      first_t_monotonic_ms: this.firstT,
      wav_samples,
      duration_sec: wav_samples / SESSION_AUDIO_RATE_HZ,
      anchors: this.anchors,
      gap_count: this.gapCount,
      gap_frames: this.gapFrames,
      overflow_frames: this.overflowFrames,
      overlap_frames: this.overlapFrames,
      frames_after_stop: this.framesAfterStop + (this.stopReason !== null || this.closeTimedOut ? Math.max(0, this.wavSample - wav_samples) : 0),
      stop_reason: this.stopReason,
      write_retries: this.retriesUsed,
      sync_file_errors: this.syncErrors,
      close_timed_out: this.closeTimedOut,
      queue_peak_bytes: this.queuePeak,
      min_free_bytes: this.minFreeBytes,
      notice: SESSION_AUDIO_NOTICE,
    };
  }
}
