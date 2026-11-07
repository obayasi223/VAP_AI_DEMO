/**
 * InitiativeMonitor が見る「安定テキスト」を STT のイベントから作る。
 *
 * 安定テキストは stability ≥ min_stability の部分（実測では 0.9）だけから作る。
 * ただし実測（`long`、asia-northeast1。tools/provider_probe/out/ の2本）では 0.9 の範囲が
 * revision ごとに伸び縮みする（文字数 0→10→9→0→24→0→28→35→34→28→42→28）。文字は変わっていない。
 * 最新の revision の 0.9 の部分だけを見ると、ついさっき安定だった根拠が毎秒のように消えてしまう。
 *
 * そこで既定の high_water では、一度 0.9 になった範囲を、最新の全文がその接頭部を保っている間は
 * 安定のまま扱う。全文が書き換わったら共通接頭部まで縮める（rewrites を数える）。
 * 0.01 の部分は決して安定に入らない。literal は最新の revision の値だけを使う比較用。
 */
import { splitInterimParts } from '@llm-vap/contracts';
import type { EventOf } from '@llm-vap/contracts';
import { commonPrefixLength, normalizeForMatch, rawPrefixForNormalized } from './text';

export type SttEvent = EventOf<'stt.interim'> | EventOf<'stt.final'>;
/**
 * 安定テキストを作るのに読む項目だけ。記録の stt.* イベント（リプレイ）と、セッションの SttResult から
 * 作った値（session/initiative_wiring.ts の sttInputFromResult）のどちらも渡せる。
 */
export type SttInput = Pick<
  SttEvent,
  | 'event'
  | 'transcript_revision'
  | 'segment_id'
  | 'asr_segment_id'
  | 'text'
  | 'stable_text'
  | 'stability_source'
  | 'parts'
  | 'audio_frame_end'
>;
export type StableMode = 'high_water' | 'literal';

export interface AsrSegmentSnapshot {
  asr_segment_id: number;
  segment_id: number;
  stable_text: string;
  is_final: boolean;
  audio_frame_end: number;
}

export interface ApplyResult {
  /** 全体の安定文字数の増減（正規化後）。 */
  stable_chars_delta: number;
  /** すでに安定と扱っていた文字が書き換わった。 */
  rewrote_stable: boolean;
}

interface SegmentState extends AsrSegmentSnapshot {
  normalized_length: number;
  rewrites: number;
}

export class StableTranscriptView {
  private readonly bySegment = new Map<number, SegmentState>();
  private latestRevision = 0;
  private latestSegmentId = 0;

  constructor(
    private readonly options: { min_stability: number; mode?: StableMode },
  ) {}

  apply(event: SttInput | SttEvent): ApplyResult {
    this.latestRevision = Math.max(this.latestRevision, event.transcript_revision);
    this.latestSegmentId = Math.max(this.latestSegmentId, event.segment_id);
    const before = this.bySegment.get(event.asr_segment_id);
    const previousStable = before ? normalizeForMatch(before.stable_text) : '';
    const fullText = normalizeForMatch(event.text);

    const isFinal = event.event === 'stt.final';
    const literal = isFinal ? event.text : this.literalStable(event);
    const literalLength = normalizeForMatch(literal).length;

    const kept = commonPrefixLength(previousStable, fullText);
    const rewrote = kept < previousStable.length;
    let stable_text: string;
    if (isFinal) stable_text = event.text;
    else if ((this.options.mode ?? 'high_water') === 'literal') stable_text = literal;
    else stable_text = rawPrefixForNormalized(event.text, Math.max(kept, literalLength));

    const normalized_length = normalizeForMatch(stable_text).length;
    this.bySegment.set(event.asr_segment_id, {
      asr_segment_id: event.asr_segment_id,
      segment_id: event.segment_id,
      stable_text,
      is_final: isFinal,
      audio_frame_end: event.audio_frame_end,
      normalized_length,
      rewrites: (before?.rewrites ?? 0) + (rewrote ? 1 : 0),
    });
    return {
      stable_chars_delta: normalized_length - previousStable.length,
      rewrote_stable: rewrote,
    };
  }

  /** derived の経路は C が stable_text を決める。provider の経路は閾値を変えて再現できるよう parts から求める。 */
  private literalStable(event: SttInput): string {
    if (event.stability_source === 'derived') return event.stable_text;
    return splitInterimParts(event.parts, this.options.min_stability).stable_text;
  }

  /** 現在の会話区間の、番号順の安定テキスト。空の区間は除く。 */
  snapshot(): AsrSegmentSnapshot[] {
    return [...this.bySegment.values()]
      .filter((s) => s.segment_id === this.latestSegmentId && s.stable_text.length > 0)
      .sort((a, b) => a.asr_segment_id - b.asr_segment_id)
      .map(({ asr_segment_id, segment_id, stable_text, is_final, audio_frame_end }) => ({
        asr_segment_id,
        segment_id,
        stable_text,
        is_final,
        audio_frame_end,
      }));
  }

  totalStableChars(): number {
    let total = 0;
    for (const s of this.bySegment.values()) {
      if (s.segment_id === this.latestSegmentId) total += s.normalized_length;
    }
    return total;
  }

  /** 安定テキストの中で、後に文字が続く文末記号の数。interim の末尾の「。」は仮なので数えない。 */
  interiorSentenceBoundaries(): number {
    let count = 0;
    for (const s of this.snapshot()) {
      count += (s.stable_text.replace(/[。？！?!]+\s*$/u, '').match(/[。？！?!]/gu) ?? []).length;
    }
    return count;
  }

  revision(): number {
    return this.latestRevision;
  }

  segmentId(): number {
    return this.latestSegmentId;
  }

  totalRewrites(): number {
    let total = 0;
    for (const s of this.bySegment.values()) total += s.rewrites;
    return total;
  }
}
