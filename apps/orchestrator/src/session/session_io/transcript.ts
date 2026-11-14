/**
 * STT の結果の取り込み（session.ts の onSttResult の前半から切り出し。docs/design/two_ai/06 §11、01 §1.3。WP1a）。
 */
import type { SttResult, TranscriptSnapshot } from '@llm-vap/contracts';
import { UserUtterances } from '../history';
import type { SessionHistory } from '../history';

export class TranscriptTracker {
  private readonly utterances = new UserUtterances();
  private snapshot: TranscriptSnapshot | null = null;

  /** 履歴の本人の segment を更新し、TurnManager に渡す写しを作って返す。 */
  onResult(result: SttResult, history: SessionHistory): TranscriptSnapshot {
    const text = this.utterances.update(result.segment_id, result.asr_segment_id, result.text);
    history.upsertUserSegment({
      text,
      segment_id: result.segment_id,
      transcript_revision: result.transcript_revision,
      is_final: result.kind === 'final',
      audio_frame_end: result.audio_frame_end,
    });
    const snapshot: TranscriptSnapshot = {
      segment_id: result.segment_id,
      asr_segment_id: result.asr_segment_id,
      asr_segment_frame_start: result.asr_segment_frame_start,
      transcript_revision: result.transcript_revision,
      text: result.text,
      stable_text: result.stable_text,
      unstable_text: result.unstable_text,
      is_final: result.kind === 'final',
      stability: result.stability,
      stability_source: result.stability_source,
      audio_frame_end: result.audio_frame_end,
      timing_precision: result.timing_precision,
      words: result.words,
      received_at: result.received_at,
    };
    this.snapshot = snapshot;
    return snapshot;
  }

  get latest(): TranscriptSnapshot | null {
    return this.snapshot;
  }
}
