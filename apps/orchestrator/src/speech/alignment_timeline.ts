/**
 * 文字単位の alignment を1回の再生の時間軸へ累積し、語境界を作る（計画 §4.3、provider_matrix §6.5）。
 *  - alignment はチャンク相対なので、それまでの PCM の長さを足す。
 *  - 語境界は Intl.Segmenter。末尾の語は次のチャンクで伸びうるので、合成が終わるまで確定しない。
 *  - 文字時刻そのものの精度は未検証（alignment_char の区分で記録する）。
 */
import type { Maybe, TtsCharAlignment } from '@llm-vap/contracts';

export interface TimedChar {
  text: string;
  start_ms: number;
  end_ms: number;
}

export interface TimedSegment {
  text: string;
  start_ms: number;
  end_ms: number;
}

const segmenter = new Intl.Segmenter('ja', { granularity: 'word' });

export class AlignmentTimeline {
  private readonly chars: TimedChar[] = [];
  private readonly confirmed: TimedSegment[] = [];
  private confirmedChars = 0;
  private pcmMs = 0;
  /** alignment のない音声が混じると、時刻と文字の対応が保てない。 */
  private gap = false;

  get duration_ms(): number {
    return this.pcmMs;
  }

  /** 全音声に alignment がある（発話済みを alignment から求めてよい）。 */
  get alignment_complete(): boolean {
    return !this.gap && this.chars.length > 0;
  }

  addChunk(chunk: { sample_rate_hz: number; samples: number; alignment: Maybe<TtsCharAlignment> }): void {
    const offset = this.pcmMs;
    this.pcmMs += (chunk.samples / chunk.sample_rate_hz) * 1000;
    const alignment = chunk.alignment.value;
    if (alignment === null) {
      if (chunk.samples > 0) this.gap = true;
      return;
    }
    const { chars, char_start_ms, char_duration_ms } = alignment;
    if (chars.length !== char_start_ms.length || chars.length !== char_duration_ms.length) {
      this.gap = true;
      return;
    }
    chars.forEach((text, i) => {
      const previous = this.chars.at(-1);
      const start_ms = Math.max(offset + (char_start_ms[i] as number), previous?.start_ms ?? 0);
      this.chars.push({ text, start_ms, end_ms: start_ms + Math.max(0, char_duration_ms[i] as number) });
    });
  }

  private segmentsFrom(fromChar: number): { segment: TimedSegment; endChar: number }[] {
    const text = this.chars.slice(fromChar).map((c) => c.text).join('');
    const out: { segment: TimedSegment; endChar: number }[] = [];
    let charIndex = fromChar;
    let consumed = 0;
    for (const { segment } of segmenter.segment(text)) {
      const startChar = charIndex;
      const target = consumed + segment.length;
      // chars の1要素が複数の符号単位を持ちうるので、要素の境界へ寄せる。
      while (consumed < target && charIndex < this.chars.length) {
        consumed += (this.chars[charIndex] as TimedChar).text.length;
        charIndex += 1;
      }
      if (charIndex === startChar) continue;
      const pieces = this.chars.slice(startChar, charIndex);
      out.push({
        segment: {
          text: pieces.map((c) => c.text).join(''),
          start_ms: (pieces[0] as TimedChar).start_ms,
          end_ms: (pieces.at(-1) as TimedChar).end_ms,
        },
        endChar: charIndex,
      });
    }
    return out;
  }

  /**
   * 語を確定し、今回新しく確定した分を返す。final でなければ末尾の語を残す。
   * 確定済みの語は後から変えない（ブラウザへ差分で送るため）。
   */
  confirm(final: boolean): TimedSegment[] {
    const pieces = this.segmentsFrom(this.confirmedChars);
    const take = final ? pieces : pieces.slice(0, -1);
    const added = take.map((p) => p.segment);
    this.confirmed.push(...added);
    const last = take.at(-1);
    if (last) this.confirmedChars = last.endChar;
    return added;
  }

  /** ms 以上で最初の確定済みの語境界。なければ null。 */
  nextBoundaryMs(ms: number): number | null {
    for (const word of this.confirmed) if (word.end_ms >= ms) return word.end_ms;
    return null;
  }

  /** ms までに終わった語までの文字列。語の途中なら直前の語境界まで（provider_matrix §6.5）。 */
  textUntil(ms: number): string {
    let text = '';
    for (const word of [...this.confirmed, ...this.segmentsFrom(this.confirmedChars).map((p) => p.segment)]) {
      if (word.end_ms > ms) break;
      text += word.text;
    }
    return text;
  }

  fullText(): string {
    return this.chars.map((c) => c.text).join('');
  }
}

/** alignment が使えないときの比例配分（精度は time_proportional と明記する）。 */
export function proportionalText(text: string, heard_ms: number, total_ms: number): string {
  if (total_ms <= 0) return '';
  const chars = [...text];
  const ratio = Math.min(1, Math.max(0, heard_ms / total_ms));
  return chars.slice(0, Math.floor(chars.length * ratio)).join('');
}
