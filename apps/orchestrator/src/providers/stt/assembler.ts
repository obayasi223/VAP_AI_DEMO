/**
 * プロバイダの結果を SttResult へ組み立てる。ストリームを意識しない層で、ここが次を一手に持つ。
 *  - transcript_revision: 出した順に 1 ずつ増やす。セッションで1本だけなのでストリームを切り替えても戻らない。
 *  - asr_segment_id: final で増やす。final までの interim は同じ ID（common.ts の AsrSegmentId）。
 *  - segment_id: 到着順でなく音声位置で決める（計画 §4.1、provider_matrix §6.3）。
 *  - 安定テキスト: splitInterimParts に「一度安定になった接頭部は書き直されない限り戻さない」を足す。
 *    実測では 0.9 の部分が 175 文字から 161 文字へ戻る。戻すと InitiativeMonitor の evidence_span が
 *    見かけ上消えるので、本文が同じである限り境界を保つ。
 *
 * AI の発話開始の境界をまたいだときの扱い:
 *  語時刻は final にしかないので、境界より前の最新の revision を基準に revision の精度で分ける。
 *  新しい文字が現れた時点で旧 segment を final として閉じ、差分を新 segment（次の ASR 区間）へ入れる。
 *  本物の final を待つと、人が話し続ける間（実測で最大 60 秒）旧 segment が閉じないため。
 *  閉じた後は同じ発話の接頭部を文字数で差し引く。final 済みの部分は次の interim に含まれないので、
 *  差し引きは未確定の部分にだけ適用し、final で 0 に戻す（計画 §4.1）。
 */
import { absent, present, splitInterimParts } from '@llm-vap/contracts';
import type { Maybe, StabilitySource, SttPart, SttResult, TimedWord, TimingPrecision } from '@llm-vap/contracts';
import {
  commonNormPrefix,
  joinParts,
  normalizeTranscript,
  rawIndexAfterNormChars,
  stripNormPrefix,
} from './transcript_text';

export interface AssemblerConfig {
  start_audio_frame: number;
  stability_threshold: number;
  derived: { revisions: number; min_age_ms: number };
  provider: string;
  model_version: string;
  now: () => number;
}

export interface AssemblerInput {
  kind: 'interim' | 'final';
  parts: SttPart[];
  end_frame: number;
  words: Maybe<TimedWord[]>;
  timing: TimingPrecision;
  stream_id: string;
}

export class TranscriptAssembler {
  private segmentId = 0;
  private revision = 0;
  private asrSegmentId = 0;
  private asrFrameStart: number;
  private lastEnd: number;
  private readonly boundaries: { frame: number; segment_id: number }[] = [];
  /** 未確定の本文のうち、今の segment に属する部分（直前に出した interim）。 */
  private pendingText = '';
  /** 同じ未確定の発話のうち、前の segment へ入れた正規化文字数。 */
  private consumedNorm = 0;
  private stableHigh = '';
  private derivedHistory: { at: number; norm: string }[] = [];

  constructor(private readonly config: AssemblerConfig) {
    this.asrFrameStart = config.start_audio_frame;
    this.lastEnd = config.start_audio_frame;
  }

  get currentSegmentId(): number {
    return this.segmentId;
  }

  get lastEndFrame(): number {
    return this.lastEnd;
  }

  get hasPending(): boolean {
    return this.pendingText !== '';
  }

  advanceSegment(new_segment_id: number, at_audio_frame: number): void {
    const last = this.boundaries.at(-1)?.segment_id ?? this.segmentId;
    if (new_segment_id <= last) {
      throw new Error(`segment_id must increase: ${new_segment_id} after ${last}`);
    }
    this.boundaries.push({ frame: at_audio_frame, segment_id: new_segment_id });
  }

  accept(input: AssemblerInput): SttResult[] {
    const out: SttResult[] = [];
    const end = Math.max(input.end_frame, this.lastEnd);
    let parts = stripNormPrefix(input.parts, this.consumedNorm);
    let words = input.words;

    for (;;) {
      const boundary = this.boundaries[0];
      if (!boundary || end <= boundary.frame) break;
      if (normalizeTranscript(this.pendingText) === '') {
        this.segmentId = boundary.segment_id;
        this.boundaries.shift();
        continue;
      }
      const text = joinParts(parts);
      const common = this.oldSegmentNormChars(this.pendingText, text, input.kind === 'final' ? words : absent('interim'), boundary.frame);
      if (normalizeTranscript(text).length <= common) {
        // 境界の後に新しい文字がない。今の本文はまだ旧 segment のもの。
        if (input.kind === 'interim') {
          out.push(this.makeInterim(input, parts, boundary.frame));
          return out;
        }
        out.push(this.makeFinal(input, parts, boundary.frame, words));
        this.segmentId = boundary.segment_id;
        this.boundaries.shift();
        return out;
      }
      const head = text.slice(0, rawIndexAfterNormChars(text, common));
      const split = splitWords(words, boundary.frame);
      const consumed = this.consumedNorm + common;
      out.push(
        this.makeFinal(
          { ...input, kind: 'final' },
          [{ text: head, stability: absent('segment_boundary_split') }],
          boundary.frame,
          input.kind === 'final' ? split.before : absent('segment_boundary_split'),
        ),
      );
      words = split.after;
      parts = stripNormPrefix(parts, common);
      this.consumedNorm = consumed;
      this.segmentId = boundary.segment_id;
      this.boundaries.shift();
    }

    if (input.kind === 'final') {
      const hasText = normalizeTranscript(joinParts(parts)) !== '';
      if (hasText || this.pendingText !== '') out.push(this.makeFinal(input, parts, end, words));
      this.resetUtterance();
      this.lastEnd = end;
    } else if (joinParts(parts) !== '') {
      out.push(this.makeInterim(input, parts, end));
    }
    return out;
  }

  /**
   * 境界をまたいだ本文のうち、旧 segment（境界より前の音声）に属する正規化文字数。
   *  - final の語時刻が本文と一致すれば、境界より前に終わった語の文字数（音声位置で決まる）。
   *  - それ以外は、境界より前の revision（pendingText）の長さまでを旧 segment とする。境界の後に届いた
   *    書き直し（「あいうえお」→「あいうかお」）は旧い音声の修正で、新しい発話ではない。共通接頭部で
   *    分けると書き直された語尾が新 segment の利用者発話になり、AI の発話の後にその断片へもう一度応答する。
   *    長さが伸びた分だけを新しい音声とみなす。語時刻のない場合の近似（docs/known_gaps.md §7）。
   */
  private oldSegmentNormChars(pending: string, text: string, words: Maybe<TimedWord[]>, frame: number): number {
    const textNorm = normalizeTranscript(text).length;
    if (words.value !== null && words.value.length > 0) {
      const all = normalizeTranscript(words.value.map((w) => w.text).join(''));
      if (all === normalizeTranscript(text)) {
        return normalizeTranscript(
          words.value
            .filter((w) => w.audio_frame_end <= frame)
            .map((w) => w.text)
            .join(''),
        ).length;
      }
    }
    const common = commonNormPrefix(pending, text);
    return Math.max(common, Math.min(normalizeTranscript(pending).length, textNorm));
  }

  private makeFinal(
    input: AssemblerInput,
    parts: SttPart[],
    end: number,
    words: Maybe<TimedWord[]>,
  ): SttResult {
    const text = joinParts(parts);
    const result = this.base(input, parts, end, {
      kind: 'final',
      text,
      stable_text: text,
      unstable_text: '',
      stability: parts[0]?.stability ?? absent('no_results'),
      stability_source: 'provider',
      words,
    });
    this.asrSegmentId += 1;
    this.asrFrameStart = end;
    this.resetUtterance();
    return result;
  }

  private makeInterim(input: AssemblerInput, parts: SttPart[], end: number): SttResult {
    const split = splitInterimParts(parts, this.config.stability_threshold);
    const fromProvider = parts.some((p) => p.stability.value !== null);
    const source: StabilitySource = fromProvider ? 'provider' : 'derived';
    let stableLength = fromProvider ? split.stable_text.length : this.derivedStableLength(split.text);
    const held = commonNormPrefix(this.stableHigh, split.text);
    if (held > 0) stableLength = Math.max(stableLength, rawIndexAfterNormChars(split.text, held));
    const stable_text = split.text.slice(0, stableLength);
    this.stableHigh = stable_text;
    this.pendingText = split.text;
    return this.base(input, parts, end, {
      kind: 'interim',
      text: split.text,
      stable_text,
      unstable_text: split.text.slice(stableLength),
      stability: split.stability,
      stability_source: source,
      words: absent('interim_has_no_word_times'),
    });
  }

  /** stability が返らないモデルの代替（provider_matrix §6.1）。N 個の revision と経過時間の両方を要求する。 */
  private derivedStableLength(text: string): number {
    const now = this.config.now();
    const norm = normalizeTranscript(text);
    this.derivedHistory.push({ at: now, norm });
    const { revisions, min_age_ms } = this.config.derived;
    // 条件を満たす最も新しい revision から今までの共通接頭部が、最も長い。
    let from = -1;
    for (let i = this.derivedHistory.length - revisions; i >= 0; i--) {
      if (now - (this.derivedHistory[i] as { at: number }).at >= min_age_ms) {
        from = i;
        break;
      }
    }
    if (from < 0) return 0;
    this.derivedHistory = this.derivedHistory.slice(from);
    let common = norm.length;
    for (const entry of this.derivedHistory) {
      let n = 0;
      while (n < common && entry.norm[n] === norm[n]) n += 1;
      common = n;
    }
    return common === 0 ? 0 : rawIndexAfterNormChars(text, common);
  }

  private base(
    input: AssemblerInput,
    parts: SttPart[],
    end: number,
    fields: Pick<
      SttResult,
      'kind' | 'text' | 'stable_text' | 'unstable_text' | 'stability' | 'stability_source' | 'words'
    >,
  ): SttResult {
    this.lastEnd = Math.max(this.lastEnd, end);
    this.revision += 1;
    return {
      ...fields,
      parts,
      segment_id: this.segmentId,
      asr_segment_id: this.asrSegmentId,
      asr_segment_frame_start: this.asrFrameStart,
      transcript_revision: this.revision,
      audio_frame_end: end,
      timing_precision: input.timing,
      stream_id: input.stream_id,
      provider: this.config.provider,
      model_version: this.config.model_version,
      received_at: this.config.now(),
    };
  }

  private resetUtterance(): void {
    this.pendingText = '';
    this.consumedNorm = 0;
    this.stableHigh = '';
    this.derivedHistory = [];
  }
}

function splitWords(
  words: Maybe<TimedWord[]>,
  frame: number,
): { before: Maybe<TimedWord[]>; after: Maybe<TimedWord[]> } {
  if (words.value === null) return { before: words, after: words };
  return {
    before: present(words.value.filter((w) => w.audio_frame_end <= frame)),
    after: present(words.value.filter((w) => w.audio_frame_end > frame)),
  };
}
