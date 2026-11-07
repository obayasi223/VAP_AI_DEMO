/**
 * 試験用: 全ストリームが同じ音声の時間軸を聞く偽のトランスポート。
 * testkit の FakeGoogleSttTransport は台本が全ストリーム累計で1本なので、2本が同じ音声を重ねて聞く状況を表せない。
 * ここでは「いつ、どの文字が話されたか」の表から、ストリームごとに結果を計算する。
 *  - 各ストリームは自分の offset（自分の先頭から）で報告する。実 API の実測と同じ。
 *  - pause の後で final、half-close で残りを final にして閉じる（実 API の実測と同じ）。
 */
import type {
  GoogleSttResponse,
  GoogleSttStream,
  GoogleSttStreamError,
  GoogleSttTransport,
} from '@llm-vap/contracts';

export interface TimelineChar {
  ch: string;
  /** 全体の音声位置（ms）。 */
  at_ms: number;
}

/** 文字を一定の速さで並べる。'|' は pause_ms の無音。 */
export function makeTimeline(text: string, msPerChar = 150, pauseMs = 1000, startMs = 100): TimelineChar[] {
  const out: TimelineChar[] = [];
  let t = startMs;
  for (const ch of text) {
    if (ch === '|') t += pauseMs;
    else {
      out.push({ ch, at_ms: t });
      t += msPerChar;
    }
  }
  return out;
}

export interface TimelineOptions {
  lag_ms?: number;
  interim_ms?: number;
  /** 無音がこの長さ続いたら final。 */
  endpoint_ms?: number;
  /** half-close の final が届くまでの遅れ。0 は同期。 */
  close_delay_ms?: number;
  stable_tail?: number;
  /** n 本目（1始まり）に最初の n 文字を誤認させる（途中から聞くと頭が崩れる状況）。 */
  garble?: { stream: number; chars: number };
}

class TimelineStream implements GoogleSttStream {
  private readonly responses = new Set<(r: GoogleSttResponse) => void>();
  private readonly errors = new Set<(e: GoogleSttStreamError) => void>();
  private readonly ends = new Set<() => void>();
  private sentMs = 0;
  private lastInterimAt = 0;
  /** 次に認識する文字の添字。 */
  private cursor: number;
  private readonly startCursor: number;
  ended = false;

  constructor(
    private readonly owner: TimelineSttTransport,
    readonly no: number,
    readonly startMs: number,
  ) {
    this.cursor = owner.timeline.findIndex((c) => c.at_ms >= startMs);
    if (this.cursor < 0) this.cursor = owner.timeline.length;
    this.startCursor = this.cursor;
  }

  private charsUpTo(ms: number): number {
    let i = this.cursor;
    while (i < this.owner.timeline.length && (this.owner.timeline[i]?.at_ms ?? Infinity) <= ms) i += 1;
    return i;
  }

  private text(from: number, to: number): string {
    const g = this.owner.options.garble;
    return this.owner.timeline
      .slice(from, to)
      .map((c, n) => (g && g.stream === this.no && from + n - this.startCursor < g.chars ? '誤' : c.ch))
      .join('');
  }

  write(linear16: Int16Array): void {
    if (this.ended) throw new Error('write after end');
    this.sentMs += linear16.length / 16;
    const { lag_ms = 300, interim_ms = 200, endpoint_ms = 600, stable_tail = 2 } = this.owner.options;
    const heard = this.startMs + this.sentMs - lag_ms;
    if (this.sentMs - this.lastInterimAt < interim_ms) return;
    this.lastInterimAt = this.sentMs;
    const to = this.charsUpTo(heard);
    if (to === this.cursor) return;
    const offset = heard - this.startMs;
    const lastCharAt = this.owner.timeline[to - 1]?.at_ms ?? 0;
    const nextAt = this.owner.timeline[to]?.at_ms ?? Infinity;
    if (heard - lastCharAt >= endpoint_ms && nextAt > heard) {
      const transcript = this.text(this.cursor, to);
      this.cursor = to;
      this.deliver({ results: [{ transcript, is_final: true, stability: 0, result_end_offset_ms: offset }] });
      return;
    }
    const whole = this.text(this.cursor, to);
    const cut = Math.max(0, whole.length - stable_tail);
    const results = [];
    if (cut > 0) results.push({ transcript: whole.slice(0, cut), is_final: false, stability: 0.9, result_end_offset_ms: offset });
    results.push({ transcript: whole.slice(cut), is_final: false, stability: 0.01, result_end_offset_ms: offset });
    this.deliver({ results });
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.owner.log.push(`end:${this.no}@${this.sentMs}`);
    const finish = () => {
      const heardAll = this.startMs + this.sentMs;
      const to = this.charsUpTo(heardAll);
      if (to > this.cursor) {
        const transcript = this.text(this.cursor, to);
        this.cursor = to;
        for (const l of this.responses) l({ results: [{ transcript, is_final: true, stability: 0, result_end_offset_ms: this.sentMs }] });
      }
      for (const l of this.ends) l();
    };
    const delay = this.owner.options.close_delay_ms ?? 0;
    if (delay > 0) setTimeout(finish, delay);
    else finish();
  }

  fail(code: string): void {
    this.ended = true;
    for (const l of this.errors) l({ code, message: 'injected' });
  }

  private deliver(response: GoogleSttResponse): void {
    for (const l of this.responses) l(response);
  }

  onResponse(listener: (response: GoogleSttResponse) => void) {
    this.responses.add(listener);
    return () => this.responses.delete(listener);
  }

  onError(listener: (error: GoogleSttStreamError) => void) {
    this.errors.add(listener);
    return () => this.errors.delete(listener);
  }

  onEnd(listener: () => void) {
    this.ends.add(listener);
    return () => this.ends.delete(listener);
  }
}

export class TimelineSttTransport implements GoogleSttTransport {
  readonly streams: TimelineStream[] = [];
  readonly log: string[] = [];
  /** 試験が pushAudio の前に進める全体の音声位置。 */
  nowMs = 0;

  constructor(
    readonly timeline: TimelineChar[],
    readonly options: TimelineOptions = {},
  ) {}

  openStream(): GoogleSttStream {
    const stream = new TimelineStream(this, this.streams.length + 1, this.nowMs);
    this.streams.push(stream);
    return stream;
  }
}
