/** turn.outcome の一覧と中央値。値は手で作ったもので、実際のセッションの値ではない。 */
import { describe, expect, it } from 'vitest';
import { summarizeTurnOutcomes, turnOutcomeRows } from '../src/turn_outcome';
import type { TurnOutcomeBody } from '@llm-vap/contracts';

const utterance = (over: { id: number; labels: { value: string[] } | { value: null; null_reason: string }; t: number; overlap: number | null; gap: number; played: number }): TurnOutcomeBody => ({
  event: 'turn.outcome',
  kind: 'ai_utterance',
  labels: over.labels as never,
  audio_playback_id: over.id,
  segment_id: 1,
  origin: 'response',
  candidate_id: { value: null, null_reason: 'normal_response' },
  conversation_kind: { value: null, null_reason: 'none' },
  start: {
    decided_at: over.t,
    audio_frame: 0,
    decision_source: 'vap',
    reason: 'L67_vap_yield',
    policy_id: 'ja',
    p_now: { value: 0.7 },
    p_future: { value: 0.7 },
    vad_user: { value: 0.1 },
    vad_ai: { value: 0.1 },
    vap_freshness: 'fresh',
    vap_age_ms: { value: 20 },
    completion_p: { value: 0.5 },
    completion_revision: { value: 1 },
    gap_ms: { value: over.gap },
    user_speaking: false,
  },
  speech_started_at: { value: over.t + 40 },
  speech_ended_at: { value: over.t + 40 + over.played },
  played_ms: { value: over.played },
  interrupted: false,
  observed: {
    user_voice_gap_before_ms: { value: over.gap + 50 },
    user_voiced_just_before: true,
    previous_ai_end_gap_ms: { value: null, null_reason: 'first_ai_utterance' },
    user_voice_since_previous_ai: { value: null, null_reason: 'first_ai_utterance' },
    continuation: { continued: false, first_result_after_start_ms: { value: null, null_reason: 'no_continuation' }, first_audio_offset_ms: { value: null, null_reason: 'no_continuation' }, chars: 0, text_kind: 'none' },
    overlap: {
      overlap_ms: over.overlap === null ? { value: null, null_reason: 'no_vap_during_speech' } : { value: over.overlap },
      first_after_start_ms: { value: null, null_reason: 'no_overlap' },
      longest_run_ms: over.overlap === null ? { value: null, null_reason: 'no_vap_during_speech' } : { value: over.overlap },
      chars: 0,
      text_kind: 'none',
    },
    echo: { suspected: false, text_similarity: { value: null, null_reason: 'no_user_text_during_speech' }, overlap_ratio: { value: 0.1 } },
  },
});

const noResponse: TurnOutcomeBody = {
  event: 'turn.outcome',
  kind: 'no_response',
  labels: { value: ['no_response_after_user_yield'] },
  segment_id: 2,
  transcript_revision: { value: 5 },
  waited_ms: 4100,
  last_user_voice_at: { value: 5000 },
  asr_chars: 10,
  asr_is_final: true,
  wait_state: 'not_permitted',
  vap_freshness: 'fresh',
  p_now: { value: 0.2 },
  p_future: { value: 0.2 },
  completion_p: { value: 0.1 },
  decision_source: { value: 'vap' },
};

describe('turnOutcomeRows と summarizeTurnOutcomes', () => {
  it('発話を開始の時刻の順に1件ずつ並べ、未確定は理由で数える', () => {
    const rows = turnOutcomeRows([
      utterance({ id: 2, labels: { value: ['user_overlap'] }, t: 2000, overlap: 400, gap: 800, played: 3000 }),
      utterance({ id: 1, labels: { value: null, null_reason: 'echo_suspected' }, t: 1000, overlap: 2000, gap: 600, played: 2500 }),
      utterance({ id: 3, labels: { value: [] }, t: 3000, overlap: null, gap: 1000, played: 1000 }),
      noResponse,
    ]);
    expect(rows.map((r) => r.audio_playback_id)).toEqual([1, 2, 3, null]);
    const summary = summarizeTurnOutcomes(rows);
    expect(summary).toMatchObject({ rows: 4, ai_utterances: 3, unsettled: 1 });
    expect(summary.by_label).toEqual({ user_overlap: 1, no_response_after_user_yield: 1 });
    expect(summary.by_null_reason).toEqual({ echo_suspected: 1 });
    expect(summary.medians.gap_ms).toEqual({ n: 3, median: 800 });
    expect(summary.medians.overlap_ms).toEqual({ n: 2, median: 1200 }); // null は数えない
  });
});
