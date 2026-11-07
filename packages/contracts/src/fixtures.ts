/**
 * 契約の固定サンプル。TS の試験と、Python 側の JSON Schema 試験の両方が同じものを使う。
 * 値はスキーマの確認用の作り物で、実測値ではない。
 */
import { encodeAudioFrame, encodePcmFrame } from './binary';
import { absent, modelOutput, modelOutputAbsent, present, verified } from './common';
import type { SchemaName } from './schema_registry';

const envelope = {
  schema_version: 1,
  t_monotonic_ms: 1234.5,
  wall_clock: '2026-11-08T03:00:00.000Z',
  session_id: 's_0001',
  condition: 'initiative_inhale',
  time_basis: { source: 'orchestrator', uncertainty_ms: present(0) },
};

const stt = {
  ...envelope,
  text: '月額料金の話なんですけど',
  stable_text: '月額料金の話',
  unstable_text: 'なんですけど',
  parts: [
    { text: '月額料金の話', stability: present(0.9) },
    { text: 'なんですけど', stability: present(0.01) },
  ],
  segment_id: 3,
  asr_segment_id: 7,
  asr_segment_frame_start: 16000,
  transcript_revision: 42,
  stability: present(0.8),
  stability_source: 'provider',
  audio_frame_end: 48000,
  timing_precision: 'result_end_offset',
  words: absent('interim_words_unavailable'),
  stream_id: 'stream_1',
  provider: 'google_stt_v2',
  model_version: 'chirp_3',
};

const llmBase = {
  ...envelope,
  request_id: 'r_1',
  purpose: 'initiative',
  transcript_revision: 42,
  sent_at: 1000,
  model_version: 'gemini-3.5-flash-lite',
};

const vap2ch = {
  t: 5000,
  audio_frame: 48000,
  model_variant: 'jp_kyoto/normal-ver2/vap_mc',
  inference_ms: 30,
  raw: { p_now: [0.4, 0.6], p_future: [0.45, 0.55], vad: [0.9, 0.01] },
  channel_layout: '2ch',
  p_now: [0.4, 0.6],
  p_future: [0.45, 0.55],
  vad: [0.9, 0.01],
  user_speaking: true,
  system_speaking: false,
};

const vap1ch = {
  t: 5000,
  audio_frame: 48000,
  model_variant: 'jp/normal/vap_mono',
  inference_ms: 20,
  raw: {},
  channel_layout: '1ch',
  p_now: 0.7,
  p_future: 0.6,
  vad: 0.9,
  user_speaking: true,
  system_speaking: absent('not_observable_with_1ch'),
};

const prefetch = {
  ...envelope,
  segment_id: 3,
  transcript_revision: 42,
  audio_playback_id: 11,
  similarity: absent('first_prepare_of_segment'),
  similarity_method: 'char_ngram_cosine',
  model_version: 'gemini-3.5-flash-lite',
};

const initiativeBase = {
  ...envelope,
  event: 'initiative.decision',
  segment_id: 3,
  transcript_revision: 42,
  request_id: 'r_2',
  sent_at: 1000,
  received_at: 1200,
  model_version: 'gemini-3.5-flash-lite',
};

const initiativeBody = {
  candidate_id: 'c_0007',
  candidate_version: 1,
  intent_type: modelOutput('CLARIFICATION'),
  evidence_span: modelOutput('月額料金の話'),
  reason: modelOutput('料金の範囲を確認したい'),
  why_now: modelOutput('以後の説明の理解に関わるため'),
  cost_of_waiting: modelOutputAbsent('model_did_not_return_field'),
  proposed_utterance: modelOutput('それは月額料金にも含まれていますか？'),
  expiry_policy: modelOutput('RECHECK_ON_NEW_INFORMATION'),
  urgency: modelOutput('NORMAL'),
  evidence_valid: verified(true, 'exact_substring_of_stable_text'),
  evidence_segment_ids: verified([7], 'asr_segment_lookup'),
};

const signal = { ...envelope, candidate_id: 'c_0007', phase: 'inhale', parameters: { depth: 0.6 } };

const candidateChange = {
  ...envelope,
  event: 'candidate.state_changed',
  candidate_id: 'c_0007',
  candidate_version: 1,
};

const dropped = {
  ...envelope,
  candidate_id: absent('new_result_discarded_before_numbering'),
  reason: 'evidence_span_not_found',
  input_transcript_revision: 40,
  latest_transcript_revision: 42,
  revision_gap: 2,
};

const speech = {
  ...envelope,
  audio_playback_id: 11,
  audio_frame: 64000,
  started_at: 2000,
  first_pcm_written_at: 1980,
  output_latency_ms: present(20),
};
const speechFinish = {
  ...speech,
  spoken_text: 'それは月額',
  spoken_text_precision: 'alignment_char',
  samples_written: 12800,
};
const interrupted = {
  ...speechFinish,
  interrupted_at: 2800,
  stop_point: 'word_boundary',
  decision_source: 'vap',
};
const candidateRef = { origin: 'candidate', candidate_id: 'c_0007', candidate_version: 2 };

const latency = {
  base_latency_ms: present(5),
  output_latency_ms: absent('not_supported_by_browser'),
  output_timestamp_context_ms: present(100),
  output_timestamp_performance_ms: present(120),
};

const trackSettings = {
  echoCancellation: present(false),
  noiseSuppression: present(false),
  autoGainControl: present(false),
  sampleRate: present(48000),
  channelCount: present(1),
  deviceId: absent('not_exposed'),
};

const turnAllowed = {
  turn_allowed: false,
  invitation: { detected: false },
  user_speaking: true,
  p_now: present(0.3),
  p_future: present(0.4),
  completion_p: absent('no_estimator'),
  completion_revision: absent('no_estimator'),
  gap_ms: absent('user_still_speaking'),
  priority: absent('no_candidate'),
  policy_id: 'ja',
  decision_source: 'vap',
  vap_freshness: 'fresh',
  fallback_energy: absent('vap_is_fresh'),
  reason: 'user_speaking',
};

const gaze = {
  target: 'away',
  reason: 'pause_with_predicted_handover',
  p_now: present(0.7),
  p_future: present(0.7),
  in_speech_pause: true,
  vap_freshness: 'fresh',
};

const turnInputs = {
  vap: present(vap2ch),
  vap_received_at: present(1200),
  received_audio_frame: 48320,
  vap_worker_started_at: present(0),
  fallback_energy: absent('vap_is_fresh'),
  transcript: present({
    segment_id: 3,
    asr_segment_id: 7,
    asr_segment_frame_start: 16000,
    transcript_revision: 42,
    text: '月額料金の話',
    stable_text: '',
    unstable_text: '月額料金の話',
    is_final: false,
    stability: absent('model_has_no_stability'),
    stability_source: 'derived',
    audio_frame_end: 48000,
    timing_precision: 'result_end_offset',
    words: absent('interim_words_unavailable'),
    received_at: 1180,
  }),
  completion_p: absent('no_estimator'),
  completion_revision: absent('no_estimator'),
  similarity_to_prepared: present(0.5),
  prefetch: { state: 'idle' },
  playback: { state: 'idle' },
  woz: [],
};

/** スキーマごとの正しい例。各例の最上位の項目をひとつ消すと必ず不合格になる（省略可能な項目を作らない規則）。 */
export const VALID_FIXTURES: Record<SchemaName, { name: string; value: unknown }[]> = {
  events: [
    { name: 'stt.interim', value: { ...stt, event: 'stt.interim' } },
    {
      name: 'stt.interim/derived',
      value: {
        ...stt,
        event: 'stt.interim',
        stability: absent('derived_from_stable_prefix'),
        stability_source: 'derived',
        parts: [{ text: '月額料金の話なんですけど', stability: absent('model_has_no_stability') }],
      },
    },
    {
      name: 'stt.final',
      value: {
        ...stt,
        event: 'stt.final',
        stable_text: '月額料金の話なんですけど',
        unstable_text: '',
        parts: [{ text: '月額料金の話なんですけど', stability: absent('final_has_none') }],
        stability: absent('final_has_none'),
      },
    },
    { name: 'llm.request', value: { ...llmBase, event: 'llm.request', input: { text: 'x' } } },
    {
      name: 'llm.response',
      value: { ...llmBase, event: 'llm.response', output: modelOutput('{}'), received_at: 1100 },
    },
    {
      name: 'llm.response/failed',
      value: {
        ...llmBase,
        event: 'llm.response',
        output: modelOutputAbsent('http_429'),
        received_at: 1100,
      },
    },
    { name: 'vap.state/2ch', value: { ...envelope, ...vap2ch, event: 'vap.state' } },
    { name: 'vap.state/1ch', value: { ...envelope, ...vap1ch, event: 'vap.state' } },
    { name: 'prefetch.started', value: { ...prefetch, event: 'prefetch.started' } },
    {
      name: 'prefetch.cancelled',
      value: { ...prefetch, event: 'prefetch.cancelled', cancel_reason: 'similarity_below_threshold' },
    },
    { name: 'prefetch.ready', value: { ...prefetch, event: 'prefetch.ready', similarity: present(0.9) } },
    {
      name: 'initiative.decision/NONE',
      value: { ...initiativeBase, decision: 'NONE', reason: modelOutput('具体的な価値がない') },
    },
    {
      name: 'initiative.decision/NEW',
      value: { ...initiativeBase, ...initiativeBody, decision: 'NEW', decided_at: 1205 },
    },
    {
      name: 'initiative.decision/KEEP',
      value: {
        ...initiativeBase,
        candidate_id: 'c_0007',
        candidate_version: 1,
        decision: 'KEEP',
        updated_at: 1300,
        reason: modelOutputAbsent('model_did_not_return_field'),
        evidence_valid: verified(true, 'exact_substring_of_stable_text'),
      },
    },
    {
      name: 'initiative.decision/REVISE',
      value: {
        ...initiativeBase,
        ...initiativeBody,
        candidate_version: 2,
        decision: 'REVISE',
        updated_at: 1400,
      },
    },
    {
      name: 'initiative.decision/WITHDRAW',
      value: {
        ...initiativeBase,
        candidate_id: 'c_0007',
        candidate_version: 2,
        decision: 'WITHDRAW',
        withdrawn_at: 1500,
        withdraw_reason: modelOutput('本人が直後に説明した'),
        withdraw_evidence_segment_ids: verified([8], 'asr_segment_lookup'),
      },
    },
    { name: 'initiative.discarded', value: { ...dropped, event: 'initiative.discarded' } },
    {
      name: 'initiative.aborted',
      value: { ...dropped, event: 'initiative.aborted', candidate_id: present('c_0007') },
    },
    {
      name: 'candidate.state_changed/code',
      value: {
        ...candidateChange,
        from: 'DEFERRED',
        to: 'WITHDRAWN',
        cause_source: 'code',
        cause: 'expired',
      },
    },
    {
      name: 'candidate.state_changed/model',
      value: {
        ...candidateChange,
        from: 'BREATH_HOLD_OR_READY',
        to: 'WITHDRAWN',
        cause_source: 'model_decision',
        decision: 'WITHDRAW',
        request_id: 'r_3',
      },
    },
    {
      name: 'candidate.state_changed/rejected_new',
      value: {
        ...candidateChange,
        from: null,
        to: 'WITHDRAWN',
        cause_source: 'code',
        cause: 'active_candidate_exists',
      },
    },
    { name: 'signal.sent', value: { ...signal, event: 'signal.sent', sent_at: 1210 } },
    {
      name: 'signal.started/visible',
      value: { ...signal, event: 'signal.started', visible: true, started_at: 1230 },
    },
    {
      name: 'signal.started/hidden',
      value: {
        ...signal,
        event: 'signal.started',
        visible: false,
        started_at: null,
        null_reason: 'tab_hidden_no_raf',
      },
    },
    {
      name: 'signal.ended',
      value: { ...signal, event: 'signal.ended', visible: true, ended_at: present(1800) },
    },
    { name: 'turn.allowed', value: { ...envelope, ...turnAllowed, event: 'turn.allowed' } },
    { name: 'speech.started/response', value: { ...speech, event: 'speech.started', origin: 'response' } },
    { name: 'speech.started/candidate', value: { ...speech, event: 'speech.started', ...candidateRef } },
    {
      name: 'speech.ended/response',
      value: { ...speechFinish, event: 'speech.ended', origin: 'response', ended_at: 3000 },
    },
    {
      name: 'speech.ended/candidate',
      value: { ...speechFinish, event: 'speech.ended', ...candidateRef, ended_at: 3000 },
    },
    {
      name: 'speech.interrupted/response',
      value: { ...interrupted, event: 'speech.interrupted', origin: 'response' },
    },
    {
      name: 'speech.interrupted/candidate',
      value: { ...interrupted, event: 'speech.interrupted', ...candidateRef },
    },
    { name: 'gaze.decision', value: { ...envelope, ...gaze, event: 'gaze.decision' } },
    {
      name: 'audio.health/browser',
      value: {
        ...envelope,
        event: 'audio.health',
        reporter: 'browser',
        audio_frame: 48000,
        frames_lost: 0,
        underrun_count: 1,
        underrun_total_ms: 20,
        stale_pcm_frames_dropped: 0,
        latency,
        track_settings: trackSettings,
        system_ch_source: 'written',
        audio_context_state: 'running',
        visibility: 'visible',
      },
    },
    {
      name: 'audio.health/worker',
      value: {
        ...envelope,
        event: 'audio.health',
        reporter: 'worker',
        audio_frame: 48000,
        frames_dropped_network: 0,
        frames_dropped_overload: 0,
        queue_depth: 1,
        rtf: present(0.4),
        system_ch_source: 'written',
      },
    },
    {
      name: 'provider.status',
      value: {
        ...envelope,
        event: 'provider.status',
        provider: 'elevenlabs',
        provider_class: 'test_double',
        status: 'degraded',
        reason: present('reconnecting'),
        retry_attempt: 1,
        next_retry_ms: present(500),
      },
    },
    {
      name: 'cost.usage',
      value: {
        ...envelope,
        event: 'cost.usage',
        provider: 'gemini',
        purpose: 'initiative',
        quantity: 120,
        unit: 'input_tokens',
        estimated_cost_usd: absent('price_unconfirmed'),
      },
    },
    {
      name: 'woz.override',
      value: {
        ...envelope,
        event: 'woz.override',
        action: 'allow_turn',
        operator: 'researcher_1',
        detail: { note: 'x' },
      },
    },
    {
      name: 'clock.sync',
      value: {
        ...envelope,
        event: 'clock.sync',
        source: 'browser_rtt',
        offset_ms: -12.5,
        error_ms: 2,
        rtt_ms: present(4),
      },
    },
  ],
  vap_state: [
    { name: '2ch', value: vap2ch },
    { name: '1ch', value: vap1ch },
  ],
  'maai_rpc.node_to_worker': [
    {
      name: 'CONFIGURE',
      value: {
        type: 'CONFIGURE',
        protocol_version: 1,
        session_id: 's_0001',
        lang: 'jp_kyoto',
        model_type: 'normal-ver2',
        channel_layout: '2ch',
        frame_rate_hz: 12.5,
        sample_rate_hz: 16000,
        frame_samples: 320,
        device: 'cpu',
        speaking_threshold: 0.5,
      },
    },
    { name: 'SHUTDOWN', value: { type: 'SHUTDOWN', reason: 'session_end' } },
    { name: 'PING', value: { type: 'PING', seq: 1, t_ms: 100 } },
  ],
  'maai_rpc.worker_to_node': [
    {
      name: 'READY',
      value: {
        type: 'READY',
        protocol_version: 1,
        maai_version: '0.2.25',
        checkpoint: 'vap_mc',
        lang: 'jp_kyoto',
        model_type: 'normal-ver2',
        channel_layout: '2ch',
        frame_rate_hz: 12.5,
        device: 'cpu',
        is_fake: false,
      },
    },
    { name: 'VAP_STATE/2ch', value: { ...vap2ch, type: 'VAP_STATE' } },
    { name: 'VAP_STATE/1ch', value: { ...vap1ch, type: 'VAP_STATE' } },
    {
      name: 'FRAMES_DROPPED',
      value: {
        type: 'FRAMES_DROPPED',
        from_audio_frame: 3200,
        sample_count: 320,
        cause: 'overload',
        zero_filled: false,
        channels: 'both',
      },
    },
    {
      name: 'WORKER_STATUS',
      value: {
        type: 'WORKER_STATUS',
        status: 'ok',
        reason: absent('healthy'),
        audio_frame: 48000,
        frames_dropped_network: 0,
        frames_dropped_overload: 0,
        queue_depth: 0,
        rtf: present(0.4),
      },
    },
    { name: 'PONG', value: { type: 'PONG', seq: 1, t_ms: 100, worker_t_ms: 5000 } },
    { name: 'ERROR', value: { type: 'ERROR', code: 'model_load', message: 'x', fatal: true } },
  ],
  'browser_rpc.browser_to_node': [
    {
      name: 'client.hello',
      value: {
        type: 'client.hello',
        protocol_version: 1,
        session_id: absent('new_session'),
        audio_context_sample_rate_hz: 48000,
        frame_samples: 320,
        track_settings: trackSettings,
        latency,
        user_agent: 'test',
      },
    },
    { name: 'clock.ping', value: { type: 'clock.ping', seq: 1, client_t_ms: 100 } },
    {
      name: 'playback.started',
      value: {
        type: 'playback.started',
        audio_playback_id: 11,
        generation: 3,
        audio_frame: 64000,
        client_t_ms: 200,
        output_latency_ms: present(20),
      },
    },
    {
      name: 'playback.position',
      value: {
        type: 'playback.position',
        audio_playback_id: 11,
        generation: 3,
        samples_written: 3200,
        samples_buffered: 1600,
        audio_frame: 67200,
        client_t_ms: 400,
        output_latency_ms: present(20),
        system_ch_source: 'written',
      },
    },
    {
      name: 'playback.ended',
      value: {
        type: 'playback.ended',
        audio_playback_id: 11,
        generation: 4,
        reason: 'stopped',
        samples_written: 6400,
        samples_discarded: 8000,
        audio_frame: 70400,
        client_t_ms: 600,
        output_latency_ms: present(20),
      },
    },
    {
      name: 'audio.report',
      value: {
        type: 'audio.report',
        client_t_ms: 700,
        audio_frame: 72000,
        frames_lost: 0,
        underrun_count: 0,
        underrun_total_ms: 0,
        stale_pcm_frames_dropped: 2,
        latency,
        track_settings: trackSettings,
        system_ch_source: 'written',
        audio_context_state: 'running',
        visibility: 'visible',
      },
    },
    {
      name: 'signal.report',
      value: {
        type: 'signal.report',
        candidate_id: 'c_0007',
        phase: 'inhale',
        state: 'started',
        visible: true,
        client_t_ms: present(800),
      },
    },
    {
      name: 'gaze.report',
      value: { type: 'gaze.report', target: 'away', visible: true, client_t_ms: present(820) },
    },
  ],
  'browser_rpc.node_to_browser': [
    {
      name: 'server.hello',
      value: {
        type: 'server.hello',
        protocol_version: 1,
        session_id: 's_0001',
        condition: 'reactive',
        is_fake: true,
      },
    },
    { name: 'clock.pong', value: { type: 'clock.pong', seq: 1, client_t_ms: 100, server_t_ms: 1200 } },
    {
      name: 'playback.begin',
      value: { type: 'playback.begin', audio_playback_id: 11, generation: 3, sample_rate_hz: 16000 },
    },
    {
      name: 'playback.stop/immediate',
      value: {
        type: 'playback.stop',
        audio_playback_id: 11,
        generation: 4,
        stop: { mode: 'immediate' },
        reason: 'candidate_withdrawn',
      },
    },
    {
      name: 'playback.stop/at_sample',
      value: {
        type: 'playback.stop',
        audio_playback_id: 11,
        generation: 4,
        stop: { mode: 'at_sample', stop_at_sample: 6400, fade_ms: 10, deadline_ms: 200 },
        reason: 'user_interrupted',
      },
    },
    {
      name: 'playback.alignment',
      value: {
        type: 'playback.alignment',
        audio_playback_id: 11,
        generation: 3,
        items: [{ text: 'それは', start_ms: 0, end_ms: 300, granularity: 'word' }],
      },
    },
    {
      name: 'signal.command',
      value: { type: 'signal.command', candidate_id: 'c_0007', phase: 'inhale', parameters: { depth: 0.6 } },
    },
    { name: 'gaze.command', value: { type: 'gaze.command', target: 'away' } },
    {
      name: 'session.status',
      value: { type: 'session.status', degraded: true, reasons: ['vap_stale'] },
    },
  ],
  'turn.inputs': [{ name: 'tick', value: turnInputs }],
  'turn.step_output': [
    {
      name: 'all_decisions',
      value: {
        state: {
          mode: 'listening',
          segment_id: 3,
          user_speaking: true,
          user_turn_end_time: null,
          last_prepare_at: 900,
          gaze_target: 'user',
          e1_extension: { any: 1 },
        },
        decisions: [
          {
            kind: 'prepare',
            segment_id: 3,
            transcript_revision: 42,
            text: 'x',
            trigger: 'asr_timeout',
            similarity: absent('first_prepare_of_segment'),
          },
          { kind: 'cancel_prepare', audio_playback_id: 10, reason: 'superseded' },
          { kind: 'start_speech', audio_playback_id: 11 },
          {
            kind: 'interrupt_speech',
            audio_playback_id: 11,
            stop_point: 'word_boundary',
            max_wait_ms: 200,
            decision_source: 'fallback',
            reason: 'fallback_energy_with_new_interim',
          },
          { kind: 'advance_segment', new_segment_id: 4, at_audio_frame: 64000 },
          { kind: 'turn_allowed', payload: turnAllowed },
          { kind: 'gaze', payload: gaze },
          { kind: 'set_degraded', degraded: true, reason: 'vap_stale' },
        ],
      },
    },
  ],
  'policy.hri2025': [],
  'policy.ja': [],
};

/** 契約に違反する例。どの言語の検証でも不合格でなければならない。 */
export const INVALID_FIXTURES: Record<string, { schema: SchemaName; value: unknown }> = {
  'NONE must not carry candidate_id': {
    schema: 'events',
    value: {
      ...initiativeBase,
      decision: 'NONE',
      reason: modelOutput('x'),
      candidate_id: 'c_0001',
    },
  },
  'unknown decision NO_INTENT (追補2)': {
    schema: 'events',
    value: { ...initiativeBase, decision: 'NO_INTENT', reason: modelOutput('x') },
  },
  'reason must be wrapped as model output': {
    schema: 'events',
    value: { ...initiativeBase, ...initiativeBody, decision: 'NEW', decided_at: 1, reason: 'bare' },
  },
  'model output cannot pose as verification': {
    schema: 'events',
    value: {
      ...initiativeBase,
      ...initiativeBody,
      decision: 'NEW',
      decided_at: 1,
      evidence_valid: modelOutput(true),
    },
  },
  'null without reason': {
    schema: 'events',
    value: { ...stt, event: 'stt.interim', stability: { value: null } },
  },
  'stability 0.0 is the unset marker, not a value': {
    schema: 'events',
    value: { ...stt, event: 'stt.interim', stability: present(0) },
  },
  'stability 0.0 in a part': {
    schema: 'events',
    value: { ...stt, event: 'stt.interim', parts: [{ text: 'x', stability: present(0) }] },
  },
  'unknown stability source': {
    schema: 'events',
    value: { ...stt, event: 'stt.interim', stability_source: 'guess' },
  },
  'bare null for maybe field': {
    schema: 'events',
    value: { ...stt, event: 'stt.interim', stability: null },
  },
  'withdraw needs later segment ids': {
    schema: 'events',
    value: {
      ...initiativeBase,
      candidate_id: 'c_0007',
      candidate_version: 2,
      decision: 'WITHDRAW',
      withdrawn_at: 1500,
      withdraw_reason: modelOutput('x'),
      withdraw_evidence_segment_ids: verified([], 'asr_segment_lookup'),
    },
  },
  'response speech must not carry candidate_id': {
    schema: 'events',
    value: { ...speech, event: 'speech.started', origin: 'response', candidate_id: 'c_0007' },
  },
  'visible signal needs started_at': {
    schema: 'events',
    value: { ...signal, event: 'signal.started', visible: true, started_at: null },
  },
  'code cause cannot carry a model reason': {
    schema: 'events',
    value: {
      ...candidateChange,
      from: 'DEFERRED',
      to: 'WITHDRAWN',
      cause_source: 'code',
      cause: 'expired',
      withdraw_reason: modelOutput('x'),
    },
  },
  'unknown event': { schema: 'events', value: { ...envelope, event: 'unknown.event' } },
  '1ch scalar cannot be sent as 2ch': {
    schema: 'vap_state',
    value: { ...vap1ch, channel_layout: '2ch' },
  },
  '2ch pair cannot be sent as 1ch': {
    schema: 'vap_state',
    value: { ...vap2ch, channel_layout: '1ch' },
  },
  'probability above 1': {
    schema: 'vap_state',
    value: { ...vap2ch, p_now: [1.5, 0.5] },
  },
  'turn inputs reject 1ch vap': {
    schema: 'turn.inputs',
    value: { ...turnInputs, vap: present(vap1ch) },
  },
  'turn inputs need fallback_energy': {
    schema: 'turn.inputs',
    value: Object.fromEntries(Object.entries(turnInputs).filter(([k]) => k !== 'fallback_energy')),
  },
  'drop must be on both channels': {
    schema: 'maai_rpc.worker_to_node',
    value: {
      type: 'FRAMES_DROPPED',
      from_audio_frame: 3200,
      sample_count: 320,
      cause: 'overload',
      zero_filled: false,
      channels: 'ch1',
    },
  },
  'hri2025 value cannot change': {
    schema: 'policy.hri2025',
    value: {
      policy_id: 'hri2025',
      immutable: true,
      source: 'Skantze & Irfan, HRI 2025, Appendix A',
      note: 'English/Furhat pilot values kept for comparison. Not claimed to be optimal for Japanese.',
      constants: {
        TURNGPT_PREPARE_THRESHOLD: 0.3,
        ASR_PREPARE_TIMEOUT_MS: 200,
        SIMILARITY_PREPARE_THRESHOLD: 0.8,
        VAP_PNOW_INTERRUPT: 0.4,
        VAP_PFUT_INTERRUPT: 0.4,
        VAP_PNOW_YIELD: 0.5,
        VAP_PFUT_YIELD: 0.5,
        MIN_GAP_TIME_MS: 500,
        YIELD_TIMEOUTS_MS: { '0.3': 500, '0.2': 1000, '0.1': 2000, '0.0': 3000 },
      },
      interpretation: {
        user_turn_end_updates_during_speech: false,
        stop_point: 'immediate',
        apply_u_corrections: false,
      },
    },
  },
};

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** バイナリ枠の固定値。TS と Python で同じバイト列になることを確認する。 */
export const BINARY_FIXTURES = {
  audio: {
    audio_frame: 3200,
    mic: [0, 1, -1, 32767, -32768],
    sys: [10, 20, -30, 0, 123],
    hex: hex(
      encodeAudioFrame({
        audio_frame: 3200,
        mic: Int16Array.from([0, 1, -1, 32767, -32768]),
        sys: Int16Array.from([10, 20, -30, 0, 123]),
      }),
    ),
  },
  pcm: {
    audio_playback_id: 11,
    generation: 3,
    seq: 7,
    sample_rate_hz: 24000,
    end_of_stream: false,
    pcm: [100, -100, 32767],
    hex: hex(
      encodePcmFrame({
        audio_playback_id: 11,
        generation: 3,
        seq: 7,
        sample_rate_hz: 24000,
        pcm: Int16Array.from([100, -100, 32767]),
      }),
    ),
  },
  pcm_end: {
    audio_playback_id: 11,
    generation: 3,
    seq: 8,
    sample_rate_hz: 24000,
    end_of_stream: true,
    pcm: [] as number[],
    hex: hex(
      encodePcmFrame({
        audio_playback_id: 11,
        generation: 3,
        seq: 8,
        sample_rate_hz: 24000,
        pcm: new Int16Array(0),
        end_of_stream: true,
      }),
    ),
  },
};
