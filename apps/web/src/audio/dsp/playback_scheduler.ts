/**
 * 再生の状態機械（計画 §3.2）。Worklet の中で動く最終の判定役。依存なし。
 * サンプルはすべてコンテキストのレートへ変換済み（ジッタバッファ）。
 *
 * - 同じ世代の再生は begin の順に1本ずつ流す（混ぜない）。
 * - 再生は prebuffer 分がたまるか終端が来てから始める。データが尽きたらアンダーランとして数え、
 *   再びたまるまで無音を書く。無音は written に数えないので、位置は常に声のサンプル数になる。
 * - 世代が進むと、古い再生は棄てる。ただし停止命令を実行中のもの（fade、at_sample）は実行し切る。
 * - 停止命令を受けた再生には以後データが来ない（古い世代の PCM は棄てられる）ので、尽きたら終わる。
 */
import type { PlaybackStopMode } from '@llm-vap/contracts/browser_rpc';

export type PlaybackEndReason = 'completed' | 'stopped' | 'discarded_before_start' | 'error';

export type SchedulerEvent =
  | { kind: 'started'; id: number; gen: number; renderFrame: number }
  | {
      kind: 'ended';
      id: number;
      gen: number;
      reason: PlaybackEndReason;
      writtenFrames: number;
      discardedFrames: number;
      renderFrame: number;
    };

interface Playback {
  id: number;
  gen: number;
  state: 'buffering' | 'playing' | 'underrun';
  chunks: Float32Array[];
  chunkOffset: number;
  buffered: number;
  written: number;
  eos: boolean;
  truncated: boolean;
  stopRequested: boolean;
  /** at_sample の待ち。 */
  stopAtFrames: number | null;
  stopDeadlineFrame: number | null;
  fadeFrames: number;
  /** 0 より大きければ減衰中。 */
  fadeLeft: number;
  fadeTotal: number;
}

export interface PlaybackPositionSnapshot {
  id: number;
  gen: number;
  writtenFrames: number;
  bufferedFrames: number;
}

export interface SchedulerOptions {
  contextRate: number;
  prebufferFrames: number;
  onEvent: (event: SchedulerEvent) => void;
}

export class PlaybackScheduler {
  private readonly queue: Playback[] = [];
  private generation = 0;
  private renderEnd = 0;
  private readonly rate: number;
  private readonly prebufferFrames: number;
  private readonly onEvent: (event: SchedulerEvent) => void;

  underrunCount = 0;
  underrunFrames = 0;
  /** 世代が古くて棄てた PCM チャンク数。 */
  staleChunks = 0;
  /** 世代が古くて無視した begin と stop の数。 */
  staleControl = 0;
  /** begin がない、または終わった再生へ届いた PCM チャンク数。 */
  orphanChunks = 0;

  constructor(options: SchedulerOptions) {
    this.rate = options.contextRate;
    this.prebufferFrames = options.prebufferFrames;
    this.onEvent = options.onEvent;
  }

  get currentGeneration(): number {
    return this.generation;
  }

  begin(id: number, gen: number): void {
    if (gen < this.generation) {
      this.staleControl++;
      return;
    }
    this.advance(gen);
    this.queue.push({
      id,
      gen,
      state: 'buffering',
      chunks: [],
      chunkOffset: 0,
      buffered: 0,
      written: 0,
      eos: false,
      truncated: false,
      stopRequested: false,
      stopAtFrames: null,
      stopDeadlineFrame: null,
      fadeFrames: 0,
      fadeLeft: 0,
      fadeTotal: 0,
    });
  }

  pcm(id: number, gen: number, frames: Float32Array, eos: boolean): void {
    if (gen < this.generation) {
      this.staleChunks++;
      return;
    }
    this.advance(gen);
    const p = this.queue.find((q) => q.id === id && q.gen === gen && !q.stopRequested);
    if (!p || p.eos) {
      this.orphanChunks++;
      return;
    }
    if (frames.length > 0) {
      p.chunks.push(frames);
      p.buffered += frames.length;
    }
    if (eos) p.eos = true;
  }

  stop(id: number, gen: number, mode: PlaybackStopMode): void {
    if (gen < this.generation) {
      this.staleControl++;
      return;
    }
    this.generation = gen;
    for (const p of [...this.queue]) {
      const isHead = p === this.queue[0];
      const isTarget = p.id === id;
      if (isTarget && isHead && p.written > 0 && mode.mode !== 'immediate') {
        this.applyGentleStop(p, mode);
      } else if (isTarget || p.gen < gen) {
        this.discard(p, 'stopped');
      }
    }
  }

  /** WS が切れた。届いている分を流したら error で終わる。 */
  inputLost(): void {
    for (const p of this.queue) {
      if (!p.eos) {
        p.eos = true;
        p.truncated = true;
      }
    }
  }

  /** セッションが変わった。すべて棄てて世代を初期化する。 */
  reset(): void {
    for (const p of [...this.queue]) this.discard(p, 'error');
    this.generation = 0;
  }

  /** いま声を流している再生の位置。まだ始まっていなければ null。 */
  position(): PlaybackPositionSnapshot | null {
    const p = this.queue[0];
    if (!p || p.written === 0) return null;
    return { id: p.id, gen: p.gen, writtenFrames: p.written, bufferedFrames: p.buffered };
  }

  render(out: Float32Array, n: number, renderFrame: number): void {
    this.renderEnd = renderFrame + n;
    let i = 0;
    while (i < n) {
      const p = this.queue[0];
      if (!p) {
        out.fill(0, i, n);
        return;
      }
      if (p.state !== 'playing') {
        if (p.buffered >= this.prebufferFrames || p.eos) {
          p.state = 'playing';
        } else {
          if (p.state === 'underrun') this.underrunFrames += n - i;
          out.fill(0, i, n);
          return;
        }
      }
      const now = renderFrame + i;
      if (
        p.fadeLeft === 0 &&
        ((p.stopAtFrames !== null && p.written >= p.stopAtFrames) ||
          (p.stopDeadlineFrame !== null && now >= p.stopDeadlineFrame))
      ) {
        p.stopAtFrames = null;
        p.stopDeadlineFrame = null;
        if (p.fadeFrames === 0) {
          this.finish(p, now);
          continue;
        }
        p.fadeTotal = p.fadeFrames;
        p.fadeLeft = p.fadeFrames;
      }
      if (p.buffered === 0) {
        if (p.eos) {
          this.finish(p, now);
        } else {
          p.state = 'underrun';
          this.underrunCount++;
        }
        continue;
      }
      i += this.copy(p, out, i, n, now);
      if (p.fadeTotal > 0 && p.fadeLeft === 0) this.finish(p, renderFrame + i);
    }
  }

  private copy(p: Playback, out: Float32Array, at: number, n: number, now: number): number {
    const chunk = p.chunks[0] as Float32Array;
    let count = Math.min(n - at, chunk.length - p.chunkOffset);
    if (p.fadeLeft > 0) count = Math.min(count, p.fadeLeft);
    if (p.stopAtFrames !== null) count = Math.min(count, p.stopAtFrames - p.written);
    if (p.stopDeadlineFrame !== null) count = Math.min(count, p.stopDeadlineFrame - now);
    const offset = p.chunkOffset;
    if (p.fadeLeft > 0) {
      for (let k = 0; k < count; k++) {
        out[at + k] = (chunk[offset + k] as number) * ((p.fadeLeft - k) / p.fadeTotal);
      }
      p.fadeLeft -= count;
    } else {
      for (let k = 0; k < count; k++) out[at + k] = chunk[offset + k] as number;
    }
    if (p.written === 0 && count > 0) {
      this.onEvent({ kind: 'started', id: p.id, gen: p.gen, renderFrame: now });
    }
    p.written += count;
    p.buffered -= count;
    p.chunkOffset += count;
    if (p.chunkOffset === chunk.length) {
      p.chunks.shift();
      p.chunkOffset = 0;
    }
    return count;
  }

  private advance(gen: number): void {
    if (gen <= this.generation) return;
    this.generation = gen;
    for (const p of [...this.queue]) {
      if (p.gen < gen && !p.stopRequested) this.discard(p, 'stopped');
    }
  }

  private applyGentleStop(p: Playback, mode: PlaybackStopMode): void {
    if (mode.mode === 'immediate') return;
    if (p.fadeLeft > 0) return; // 既に減衰中
    p.stopRequested = true;
    p.eos = true;
    const fade = Math.round((mode.fade_ms * this.rate) / 1000);
    p.fadeFrames = fade;
    if (mode.mode === 'fade') {
      p.stopAtFrames = 0;
      p.stopDeadlineFrame = null;
    } else {
      p.stopAtFrames = Math.ceil((mode.stop_at_sample * this.rate) / 16000);
      p.stopDeadlineFrame = this.renderEnd + Math.round((mode.deadline_ms * this.rate) / 1000);
    }
  }

  private finish(p: Playback, renderFrame: number): void {
    const index = this.queue.indexOf(p);
    if (index >= 0) this.queue.splice(index, 1);
    let reason: PlaybackEndReason = 'completed';
    if (p.stopRequested) reason = 'stopped';
    else if (p.truncated) reason = 'error';
    this.onEvent({
      kind: 'ended',
      id: p.id,
      gen: p.gen,
      reason,
      writtenFrames: p.written,
      discardedFrames: p.buffered,
      renderFrame,
    });
  }

  private discard(p: Playback, reason: 'stopped' | 'error'): void {
    const index = this.queue.indexOf(p);
    if (index >= 0) this.queue.splice(index, 1);
    this.onEvent({
      kind: 'ended',
      id: p.id,
      gen: p.gen,
      reason: reason === 'stopped' && p.written === 0 ? 'discarded_before_start' : reason,
      writtenFrames: p.written,
      discardedFrames: p.buffered,
      renderFrame: this.renderEnd,
    });
  }
}
