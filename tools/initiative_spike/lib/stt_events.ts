/** STT の結果を §3.5 の stt.* へ写す。実 ASR の経路と手書きの経路で同じ形にする。 */
import { absent, present, splitInterimParts, stabilityFromProvider } from '@llm-vap/contracts';
import type { Maybe, SttPart, TimedWord, TimingPrecision } from '@llm-vap/contracts';
import type { SttEvent } from '../../../apps/orchestrator/src/cognition/initiative/transcript_view';

export interface SttEventContext {
  session_id: string;
  provider: string;
  model_version: string;
  stream_id: string;
  min_stability: number;
  /** wall_clock の基準（UTC の ISO 8601）。 */
  wall_origin_ms: number;
}

export interface BuildArgs {
  kind: 'interim' | 'final';
  t_ms: number;
  parts: SttPart[];
  revision: number;
  asr_segment_id: number;
  frame_start: number;
  frame_end: number;
  precision: TimingPrecision;
  words: Maybe<TimedWord[]>;
}

export function buildSttEvent(ctx: SttEventContext, a: BuildArgs): SttEvent {
  const split = splitInterimParts(a.parts, ctx.min_stability);
  const isFinal = a.kind === 'final';
  const common = {
    schema_version: 1 as const,
    t_monotonic_ms: a.t_ms,
    wall_clock: new Date(ctx.wall_origin_ms + a.t_ms).toISOString(),
    session_id: ctx.session_id,
    condition: 'initiative_no_cue' as const,
    time_basis: { source: 'orchestrator' as const, uncertainty_ms: { value: 0 } },
    text: split.text,
    stable_text: isFinal ? split.text : split.stable_text,
    unstable_text: isFinal ? '' : split.unstable_text,
    parts: a.parts,
    segment_id: 0,
    asr_segment_id: a.asr_segment_id,
    asr_segment_frame_start: a.frame_start,
    transcript_revision: a.revision,
    stability: split.stability,
    stability_source: 'provider' as const,
    audio_frame_end: a.frame_end,
    timing_precision: a.precision,
    words: a.words,
    stream_id: ctx.stream_id,
    provider: ctx.provider,
    model_version: ctx.model_version,
  };
  return isFinal ? { ...common, event: 'stt.final' } : { ...common, event: 'stt.interim' };
}

/** lib/stt.mjs の normalizeResponse の形。 */
export interface NormalizedResult {
  text: string;
  is_final: boolean;
  stability: number | null;
  end_ms: number | null;
  words: { word: string; start_ms: number | null; end_ms: number | null }[];
}

const FRAMES_PER_MS = 16;

/** Google の応答を順に受け取り、asr_segment_id と revision を振る。final ごとに区間が進む。 */
export class GoogleResponseMapper {
  private revision = 0;
  private asrSegmentId = 0;
  private frameStart = 0;

  constructor(private readonly ctx: SttEventContext) {}

  map(results: readonly NormalizedResult[], t_ms: number, audio_sent_ms: number): SttEvent[] {
    const out: SttEvent[] = [];
    const interims = results.filter((r) => !r.is_final);
    if (interims.length > 0) {
      const ends = interims.map((r) => r.end_ms).filter((x): x is number => x !== null && x > 0);
      out.push(this.emit('interim', interims, ends, t_ms, audio_sent_ms, absent('interim_words_unavailable')));
    }
    for (const final of results.filter((r) => r.is_final)) {
      const words: TimedWord[] = final.words
        .filter((w) => w.start_ms !== null && w.end_ms !== null)
        .map((w) => ({
          text: w.word,
          audio_frame_start: Math.round((w.start_ms as number) * FRAMES_PER_MS),
          audio_frame_end: Math.round((w.end_ms as number) * FRAMES_PER_MS),
        }));
      const ends = final.end_ms !== null && final.end_ms > 0 ? [final.end_ms] : [];
      const event = this.emit('final', [final], ends, t_ms, audio_sent_ms, words.length > 0 ? present(words) : absent('no_word_offsets'));
      out.push(event);
      this.asrSegmentId += 1;
      this.frameStart = event.audio_frame_end;
    }
    return out;
  }

  private emit(
    kind: 'interim' | 'final',
    results: readonly NormalizedResult[],
    ends: number[],
    t_ms: number,
    audio_sent_ms: number,
    words: Maybe<TimedWord[]>,
  ): SttEvent {
    this.revision += 1;
    const end = ends.length > 0 ? Math.max(...ends) : audio_sent_ms;
    return buildSttEvent(this.ctx, {
      kind,
      t_ms,
      parts: results.map((r) => ({ text: r.text, stability: stabilityFromProvider(r.stability) })),
      revision: this.revision,
      asr_segment_id: this.asrSegmentId,
      frame_start: this.frameStart,
      frame_end: Math.round(end * FRAMES_PER_MS),
      precision: ends.length > 0 ? 'result_end_offset' : 'arrival_minus_rtt',
      words,
    });
  }
}
