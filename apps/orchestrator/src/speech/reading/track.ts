/**
 * 1本の発話の「元の文」「TTS へ送った文」「alignment の文字」の対応（SpeechGenerator が音声ごとに持つ）。
 *
 *  - 元の文（LLM の応答、候補の文）が正。履歴・字幕・spoken_text は元の文で返す。
 *  - TTS の読みの変換（mode が off 以外）では、句読点までためてから解析し、置き換えた文を TTS へ送る。
 *    置き換えた区間は1つのまとまりで、途中までは「話していない」側に倒す（元の文へ戻すとき、まとまりの頭へ寄せる）。
 *  - alignment の文字は TTS へ送った文の文字に、末尾の空白などが混じったもの。順に照合して TTS の文の位置へ写す。
 *  - 口形の読みは解析の断片から作る。alignment の語（Intl.Segmenter）と解析の語の境界がずれたら、
 *    断片の読みを文字数の比で分ける（推定）。読みの分からない文字（英字など）を含む語は読みなし。
 */
import type { ReadingAnalyzer } from './analyzer';
import { isAllKana, isAttachedKana, toKatakana } from './kana';
import { analyzePieces, replacesForTts, type ReadingPiece, type TtsReadingMode } from './pieces';

/** 解析の区切り。文末に加えて読点でも区切る（変換のときに TTS へ送るのを待たせすぎない）。 */
const ANALYSIS_BOUNDARY = /[。！？!?\n、，,]/u;
/** 読みを持たなくてよい文字（口形は無音のまま）。 */
const SILENT = /^[\s、。，．,.!?！？…‥・「」『』（）()〜~ー－―-]+$/u;

interface Span {
  o0: number;
  o1: number;
  t0: number;
  t1: number;
  replaced: boolean;
}

/** 口形の断片（TTS の文の位置）。 */
interface LipPiece {
  t0: number;
  t1: number;
  lip: string | null;
}

export interface ReadingTrackOptions {
  analyzer: ReadingAnalyzer | null;
  tts_mode: TtsReadingMode;
  /** 口形の読みを付けるか。 */
  lip: boolean;
}

export interface ReadingTrackStats {
  analyze_calls: number;
  analyze_ms_total: number;
  analyze_ms_max: number;
  /** alignment の文字が TTS の文と合わなかった数。 */
  alignment_mismatches: number;
}

export class SpeechTextTrack {
  /** 元の文（届いた全部）。 */
  original = '';
  /** TTS へ送った文。 */
  tts = '';
  private pending = '';
  private readonly spans: Span[] = [];
  private readonly lipPieces: LipPiece[] = [];
  /** 解析済みの TTS の文の長さ（off のとき、ここより先は未解析）。 */
  private analyzedTts = 0;
  /** alignment の文字の各 UTF-16 単位の後ろが、TTS の文のどこに当たるか。 */
  private readonly alignEnd: number[] = [];
  private ttsCursor = 0;
  readonly stats: ReadingTrackStats = { analyze_calls: 0, analyze_ms_total: 0, analyze_ms_max: 0, alignment_mismatches: 0 };
  private readonly now: () => number;

  constructor(
    private readonly options: ReadingTrackOptions,
    now: () => number = () => performance.now(),
  ) {
    this.now = now;
  }

  /** TTS の文が元の文と違いうる（変換が有効で、解析器がある）。 */
  get transforms(): boolean {
    return this.options.tts_mode !== 'off' && this.options.analyzer !== null;
  }

  private get analyzes(): boolean {
    return this.options.analyzer !== null && (this.options.lip || this.transforms);
  }

  /**
   * 元の文の続き。TTS へ今送る文を返す（変換のときは句読点までためるので空のことがある）。
   * 変換しないときは解析しない（TTS へ送るのを待たせない）。送った後に analyzeSent を呼ぶ。
   */
  push(text: string): string {
    if (text === '') return '';
    this.original += text;
    if (!this.transforms) {
      this.appendIdentity(text);
      if (this.analyzes) this.pending += text;
      return text;
    }
    this.pending += text;
    return this.convertCompleted(false);
  }

  /** 入力の終わり。ためていた分を返す。 */
  end(): string {
    if (!this.transforms) {
      if (this.analyzes && this.pending !== '') this.analyzeTail();
      return '';
    }
    return this.convertCompleted(true);
  }

  private appendIdentity(text: string): void {
    const o0 = this.original.length - text.length;
    const t0 = this.tts.length;
    this.tts += text;
    const last = this.spans.at(-1);
    if (last && !last.replaced && last.o1 === o0 && last.t1 === t0) {
      last.o1 += text.length;
      last.t1 += text.length;
    } else {
      this.spans.push({ o0, o1: o0 + text.length, t0, t1: t0 + text.length, replaced: false });
    }
  }

  private lastBoundary(text: string): number {
    for (let i = text.length - 1; i >= 0; i -= 1) if (ANALYSIS_BOUNDARY.test(text[i] as string)) return i + 1;
    return 0;
  }

  private analyze(text: string): ReadingPiece[] {
    const began = this.now();
    const pieces = analyzePieces(text, this.options.analyzer as ReadingAnalyzer);
    const ms = this.now() - began;
    this.stats.analyze_calls += 1;
    this.stats.analyze_ms_total += ms;
    this.stats.analyze_ms_max = Math.max(this.stats.analyze_ms_max, ms);
    return pieces;
  }

  /** 変換しないとき: 区切りまで届いた分を解析し、口形の断片だけ作る（TTS の文はそのまま）。TTS へ送った後に呼ぶ。 */
  analyzeSent(): void {
    if (!this.transforms && this.analyzes) this.analyzeCompleted();
  }

  private analyzeCompleted(): void {
    const cut = this.lastBoundary(this.pending);
    if (cut === 0) return;
    this.analyzeIdentity(this.pending.slice(0, cut));
    this.pending = this.pending.slice(cut);
  }

  private analyzeTail(): void {
    const text = this.pending;
    this.pending = '';
    this.analyzeIdentity(text);
  }

  private analyzeIdentity(text: string): void {
    const base = this.analyzedTts;
    for (const piece of this.analyze(text)) this.lipPieces.push({ t0: base + piece.start, t1: base + piece.end, lip: piece.lip });
    this.analyzedTts += text.length;
  }

  /** 変換: 区切りまで（final なら全部）を解析し、置き換えた文を TTS の文へ足して返す。 */
  private convertCompleted(final: boolean): string {
    const cut = final ? this.pending.length : this.lastBoundary(this.pending);
    if (cut === 0) return '';
    const text = this.pending.slice(0, cut);
    this.pending = this.pending.slice(cut);
    const oBase = this.original.length - this.pending.length - text.length;
    let out = '';
    for (const piece of this.analyze(text)) {
      const o0 = oBase + piece.start;
      const o1 = oBase + piece.end;
      const t0 = this.tts.length + out.length;
      const replaced = replacesForTts(piece, this.options.tts_mode);
      const sent = replaced ? (piece.kana as string) : text.slice(piece.start, piece.end);
      out += sent;
      this.spans.push({ o0, o1, t0, t1: t0 + sent.length, replaced });
      // 置き換えた区間は TTS の文がかなになる。口形はそのかなで足りるが、発音（は＝ワ）に合わせて解析の読みを使う。
      this.lipPieces.push({ t0, t1: t0 + sent.length, lip: piece.lip });
    }
    this.tts += out;
    this.analyzedTts = this.tts.length;
    return out;
  }

  // ---- alignment の文字 ---------------------------------------------------------

  /** TtsChunk.alignment.chars を届いた順に渡す。 */
  addAlignment(chars: readonly string[]): void {
    const text = chars.join('');
    for (const ch of text) {
      // 照合は符号位置ごと（サロゲートを割らない）。
      if (this.ttsCursor < this.tts.length && this.tts.startsWith(ch, this.ttsCursor)) {
        this.ttsCursor += ch.length;
      } else if (/\s/u.test(ch)) {
        // alignment にだけある空白（ElevenLabs は末尾に空白を付ける）。
      } else {
        while (this.ttsCursor < this.tts.length && /\s/u.test(this.tts[this.ttsCursor] as string)) this.ttsCursor += 1;
        if (this.tts.startsWith(ch, this.ttsCursor)) {
          this.ttsCursor += ch.length;
        } else {
          // 置き換えとみなして1字進める。
          this.stats.alignment_mismatches += 1;
          this.ttsCursor = Math.min(this.tts.length, this.ttsCursor + ch.length);
        }
      }
      for (let k = 0; k < ch.length; k += 1) this.alignEnd.push(this.ttsCursor);
    }
  }

  /** alignment の文字の先頭 n 単位が、TTS の文のどこまでか。 */
  ttsOffsetOfAlignment(n: number): number {
    if (n <= 0) return 0;
    return this.alignEnd[Math.min(n, this.alignEnd.length) - 1] ?? 0;
  }

  /** TTS の文の先頭 n 単位に対応する元の文。置き換えた区間の途中なら、その区間の前まで。 */
  originalForTtsPrefix(n: number): string {
    let o = 0;
    for (const span of this.spans) {
      if (n >= span.t1) {
        o = span.o1;
        continue;
      }
      if (n > span.t0 && !span.replaced) o = span.o0 + (n - span.t0);
      break;
    }
    return this.original.slice(0, o);
  }

  /** alignment の文字の先頭 n 単位に対応する元の文。 */
  originalForAlignmentPrefix(n: number): string {
    return this.originalForTtsPrefix(this.ttsOffsetOfAlignment(n));
  }

  /**
   * alignment の語（alignment の文字の [a0, a1)）の口形の読み（カタカナ）。分からなければ null。
   * 語の文字がかなだけで、読みが表記と同じなら null（ブラウザは表記で口形を作れる）。
   */
  readingForAlignment(a0: number, a1: number, wordText: string): string | null {
    if (!this.options.lip || this.options.analyzer === null) return null;
    let t0 = this.ttsOffsetOfAlignment(a0);
    const t1 = this.ttsOffsetOfAlignment(a1);
    if (t1 <= t0) return null;
    if (t1 > this.analyzedTts && this.pending !== '' && !this.transforms) this.analyzeTail();
    let reading = '';
    for (const piece of this.lipPieces) {
      if (piece.t1 <= t0) continue;
      if (piece.t0 >= t1) break;
      const from = Math.max(piece.t0, t0);
      const to = Math.min(piece.t1, t1);
      const text = this.tts.slice(from, to);
      if (piece.lip === null) {
        if (SILENT.test(text)) continue;
        return null;
      }
      reading += sliceReading(piece.lip, piece.t1 - piece.t0, from - piece.t0, to - piece.t0);
      t0 = to;
    }
    if (reading === '') return null;
    if (isAllKana(wordText) && toKatakana(wordText) === reading) return null;
    return reading;
  }
}

/**
 * 断片の読みの一部。断片の文字数と読みの長さが同じなら文字ごと、違えば比で分ける（推定）。
 * 分け目が小書きや長音の前に来たらずらす（キョ を キ｜ョ に割らない）。
 */
export function sliceReading(lip: string, length: number, from: number, to: number): string {
  if (from <= 0 && to >= length) return lip;
  const chars = [...lip];
  const cut = (at: number) => {
    if (at <= 0) return 0;
    if (at >= length) return chars.length;
    let k = chars.length === length ? at : Math.round((at / length) * chars.length);
    // 小書き・長音の前なら、その字が付く字の前まで戻す（トーキ｜ョー → トー｜キョー）。戻れなければ後ろへ。
    let back = k;
    while (back > 0 && back < chars.length && isAttachedKana(chars[back] as string)) back -= 1;
    if (back > 0) return back;
    while (k > 0 && k < chars.length && isAttachedKana(chars[k] as string)) k += 1;
    return k;
  };
  return chars.slice(cut(from), cut(to)).join('');
}
