/**
 * 研究者画面の確認用の偽のイベント列。数値はすべて作り物で、実測ではない。
 * session_id と provider_class（test_double）で偽物と分かるようにしてある。
 * 表示の不合格の経路を見るため、不正なイベントを 1 件わざと混ぜている。
 */
import {
  absent,
  FAKE_MODEL_VARIANT,
  modelOutput,
  modelOutputAbsent,
  present,
  verified,
  type EventDraft,
  type TimeBasis,
} from '@llm-vap/contracts';

export const FAKE_SESSION_ID = 'FAKE_SESSION_not_real_data';
const WALL_ORIGIN = Date.parse('2000-01-01T00:00:00.000Z');
const ORCHESTRATOR: TimeBasis = { source: 'orchestrator', uncertainty_ms: present(0) };
const BROWSER: TimeBasis = { source: 'browser_rtt', uncertainty_ms: present(1.5) };
const WORKER: TimeBasis = { source: 'worker_audio_frame', uncertainty_ms: present(3) };

const trackSettings = {
  echoCancellation: present(false),
  noiseSuppression: present(false),
  autoGainControl: present(false),
  sampleRate: present(48000),
  channelCount: present(1),
  deviceId: absent('fake'),
};

function audioHealth(frame: number): EventDraft {
  return {
    event: 'audio.health',
    reporter: 'browser',
    audio_frame: frame,
    frames_lost: 0,
    underrun_count: 0,
    underrun_total_ms: 0,
    stale_pcm_frames_dropped: 0,
    latency: {
      base_latency_ms: present(5),
      output_latency_ms: present(30),
      output_timestamp_context_ms: absent('fake'),
      output_timestamp_performance_ms: absent('fake'),
    },
    track_settings: trackSettings,
    system_ch_source: 'written',
    audio_context_state: 'running',
    visibility: 'visible',
  };
}

function providerStatus(provider: string, status: 'ok' | 'degraded' | 'down', reason: string | null): EventDraft {
  return {
    event: 'provider.status',
    provider,
    provider_class: 'test_double',
    status,
    reason: reason === null ? absent('healthy') : present(reason),
    retry_attempt: status === 'ok' ? 0 : 2,
    next_retry_ms: status === 'ok' ? absent('not_retrying') : present(1000),
  };
}

function stt(event: 'stt.interim' | 'stt.final', text: string, revision: number, frame: number): EventDraft {
  return {
    event,
    text,
    stable_text: text,
    unstable_text: '',
    parts: [{ text, stability: present(0.9) }],
    segment_id: 1,
    asr_segment_id: 1,
    asr_segment_frame_start: 16000,
    transcript_revision: revision,
    stability: present(0.9),
    stability_source: 'provider',
    audio_frame_end: frame,
    timing_precision: 'result_end_offset',
    words: absent('fake'),
    stream_id: 'fake_stream',
    provider: 'FAKE_stt',
    model_version: 'FAKE_model',
  };
}

function vap(frame: number, user: boolean, system: boolean): EventDraft {
  return {
    event: 'vap.state',
    t: frame / 16,
    audio_frame: frame,
    model_variant: FAKE_MODEL_VARIANT,
    inference_ms: 30,
    raw: {},
    channel_layout: '2ch',
    p_now: [0.7, 0.3],
    p_future: [0.6, 0.4],
    vad: [user ? 0.9 : 0.1, system ? 0.9 : 0.1],
    user_speaking: user,
    system_speaking: system,
  };
}

const CANDIDATE = 'fake_candidate_1';
const span = '偽の根拠の文';
const signal = { candidate_id: CANDIDATE, phase: 'inhale' as const, parameters: {} };
const speechBase = {
  audio_playback_id: 1,
  audio_frame: 96000,
  started_at: 6100,
  first_pcm_written_at: 6070,
  output_latency_ms: present(30),
  origin: 'candidate' as const,
  candidate_id: CANDIDATE,
  candidate_version: 1,
};

type Step = [t_ms: number, draft: EventDraft, basis?: TimeBasis];

const STEPS: readonly Step[] = [
  [0, providerStatus('session_log', 'ok', null)],
  [0, providerStatus('google_stt_v2', 'ok', null)],
  [0, providerStatus('gemini', 'ok', null)],
  [0, providerStatus('elevenlabs', 'degraded', '偽の障害の表示確認')],
  [0, providerStatus('maai_worker', 'down', '偽の障害の表示確認')],
  [100, { event: 'clock.sync', source: 'browser_rtt', offset_ms: 123.4, error_ms: 1.5, rtt_ms: present(3) }],
  [120, { event: 'clock.sync', source: 'worker_audio_frame', offset_ms: -45.6, error_ms: 3, rtt_ms: absent('worker_clock_is_one_way') }],
  [1000, audioHealth(16000), BROWSER],
  [1100, vap(17600, true, false), WORKER],
  [1400, stt('stt.interim', '偽の', 1, 20000)],
  [1800, stt('stt.interim', '偽の根拠の文', 2, 26000)],
  [2000, audioHealth(32000), BROWSER],
  [2200, stt('stt.interim', '偽の根拠の文です', 3, 33000)],
  [2600, stt('stt.final', '偽の根拠の文です。', 4, 40000)],
  [2800, { event: 'llm.request', request_id: 'fake_r1', purpose: 'initiative', input: { fake: true }, transcript_revision: 2, sent_at: 2800, model_version: 'FAKE_model' }],
  [3600, { event: 'llm.response', request_id: 'fake_r1', purpose: 'initiative', output: modelOutput({ fake: true }), transcript_revision: 2, sent_at: 2800, received_at: 3600, model_version: 'FAKE_model' }],
  [3600, { event: 'cost.usage', provider: 'gemini', purpose: 'initiative', quantity: 1000, unit: 'input_tokens', estimated_cost_usd: present(1000 * 0.3 / 1_000_000) }],
  [3600, { event: 'cost.usage', provider: 'gemini', purpose: 'initiative', quantity: 1, unit: 'aborted_request', estimated_cost_usd: absent('aborted_request_may_still_bill_usage_unknown') }],
  [3650, {
    event: 'initiative.decision',
    decision: 'NEW',
    segment_id: 1,
    transcript_revision: 2,
    request_id: 'fake_r1',
    sent_at: 2800,
    received_at: 3600,
    model_version: 'FAKE_model',
    candidate_id: CANDIDATE,
    candidate_version: 1,
    intent_type: modelOutput('FAKE'),
    evidence_span: modelOutput(span),
    reason: modelOutput('偽の理由'),
    why_now: modelOutput('偽の理由'),
    cost_of_waiting: modelOutputAbsent('fake'),
    proposed_utterance: modelOutput('偽の発話'),
    expiry_policy: modelOutput('FAKE'),
    urgency: modelOutput('FAKE'),
    evidence_valid: verified(true, 'fake'),
    evidence_segment_ids: verified([1], 'fake'),
    decided_at: 3650,
  }],
  [3700, { event: 'signal.sent', ...signal, sent_at: 3700 }],
  [3900, { event: 'signal.started', ...signal, visible: true, started_at: 3780 }, BROWSER],
  [4000, audioHealth(64000), BROWSER],
  [5000, { event: 'turn.allowed', turn_allowed: true, invitation: { detected: false }, user_speaking: false, p_now: present(0.6), p_future: present(0.6), completion_p: absent('fake'), completion_revision: absent('fake'), gap_ms: present(700), priority: absent('fake'), policy_id: 'FAKE_policy', decision_source: 'vap', vap_freshness: 'fresh', fallback_energy: absent('fake'), reason: '偽の判定理由' }],
  [5200, { event: 'gaze.decision', target: 'user', reason: '偽の視線の理由', p_now: present(0.6), p_future: present(0.6), in_speech_pause: false, vap_freshness: 'fresh' }],
  [6100, { event: 'speech.started', ...speechBase }, BROWSER],
  [6200, vap(99200, false, true), WORKER],
  [6300, { event: 'cost.usage', provider: 'google_stt_v2', purpose: 'stt_stream', quantity: 60, unit: 'audio_seconds', estimated_cost_usd: present(0.016) }],
  [6300, { event: 'cost.usage', provider: 'elevenlabs', purpose: 'tts_context', quantity: 100, unit: 'characters', estimated_cost_usd: present(0.004) }],
  [6400, { event: 'cost.usage', provider: 'gemini_tts', purpose: 'tts_request', quantity: 3, unit: 'audio_seconds', estimated_cost_usd: present(0.000675) }],
];

/** 不正なイベントを 1 件含む（time_basis がない）。 */
const BROKEN_EVENT = {
  schema_version: 1,
  event: 'provider.status',
  session_id: FAKE_SESSION_ID,
  note: '偽データ: 不正なイベントの表示確認',
};

export function createFakeEventScript(): unknown[] {
  const events: unknown[] = STEPS.map(([t_ms, draft, basis]) => ({
    ...draft,
    schema_version: 1,
    t_monotonic_ms: t_ms,
    wall_clock: new Date(WALL_ORIGIN + t_ms).toISOString(),
    session_id: FAKE_SESSION_ID,
    condition: 'initiative_inhale',
    time_basis: basis ?? ORCHESTRATOR,
  }));
  events.splice(5, 0, BROKEN_EVENT);
  return events;
}
