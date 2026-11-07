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

// ---- I2 の時系列の確認用（7 秒以降）。値は作り物で、会話の実測ではない。 ----------------

/** 利用者の発話区間と AI の発話区間（ms）。AI の 3 番目は利用者の発話で割り込まれて止まる。 */
const USER_SPANS: readonly [number, number][] = [[11000, 16000], [24000, 30500], [33800, 36500], [38000, 41000]];
const AI_SPANS: readonly [number, number][] = [[6100, 9500], [17000, 22000], [31500, 34200], [42000, 46000]];
const TAIL_END_MS = 47000;
const VAP_PERIOD_MS = 80;

const within = (t: number, spans: readonly [number, number][]) => spans.some(([a, b]) => t >= a && t < b);
/** 決まった形の揺らぎ（乱数を使わないので毎回同じ図になる）。 */
const wobble = (t: number) => 0.05 * Math.sin(t / 370) + 0.03 * Math.sin(t / 113);
const clamp01 = (v: number) => Math.min(0.99, Math.max(0.01, v));

function vapAt(t: number): EventDraft {
  const user = within(t, USER_SPANS);
  const ai = within(t, AI_SPANS);
  // ch2（添字 1）が AI。p_now は 2 者の配分なので和が 1。
  const aiNow = clamp01((ai ? 0.85 : user ? 0.12 : 0.55) + wobble(t));
  const aiFuture = clamp01((ai ? 0.7 : user ? 0.3 : 0.6) + wobble(t + 900));
  return {
    event: 'vap.state',
    t,
    audio_frame: Math.round(t * 16),
    model_variant: FAKE_MODEL_VARIANT,
    inference_ms: 30,
    raw: {},
    channel_layout: '2ch',
    p_now: [1 - aiNow, aiNow],
    p_future: [1 - aiFuture, aiFuture],
    vad: [clamp01((user ? 0.9 : 0.05) + wobble(t) / 2), clamp01((ai ? 0.9 : 0.05) + wobble(t + 400) / 2)],
    user_speaking: user,
    system_speaking: ai,
  };
}

function prefetch(kind: 'prefetch.started' | 'prefetch.ready' | 'prefetch.cancelled', id: number, cancel_reason?: string): EventDraft {
  return {
    event: kind,
    segment_id: id,
    transcript_revision: id * 10,
    audio_playback_id: id,
    similarity: absent('fake'),
    similarity_method: 'FAKE',
    model_version: 'FAKE_model',
    ...(kind === 'prefetch.started' ? { trigger: 'final_transcript' as const } : {}),
    ...(cancel_reason === undefined ? {} : { cancel_reason }),
  } as EventDraft;
}

function speech(kind: 'speech.started' | 'speech.ended' | 'speech.interrupted', id: number, start: number, end: number): EventDraft {
  const base = {
    audio_playback_id: id,
    audio_frame: Math.round(start * 16),
    started_at: start,
    first_pcm_written_at: start - 30,
    output_latency_ms: present(30),
    origin: 'response' as const,
  };
  if (kind === 'speech.started') return { event: kind, ...base };
  const finish = { ...base, spoken_text: '偽の応答', spoken_text_precision: 'time_proportional' as const, samples_written: Math.round((end - start) * 16) };
  if (kind === 'speech.ended') return { event: kind, ...finish, ended_at: end };
  return { event: kind, ...finish, interrupted_at: end, stop_point: 'word_boundary', decision_source: 'vap' };
}

function turnAllowed(allowed: boolean, reason: string): EventDraft {
  return { event: 'turn.allowed', turn_allowed: allowed, invitation: { detected: false }, user_speaking: !allowed, p_now: present(0.6), p_future: present(0.6), completion_p: absent('fake'), completion_revision: absent('fake'), gap_ms: present(600), priority: absent('fake'), policy_id: 'FAKE_policy', decision_source: 'vap', vap_freshness: 'fresh', fallback_energy: absent('fake'), reason };
}

function gaze(target: 'user' | 'away', pause: boolean): EventDraft {
  return { event: 'gaze.decision', target, reason: '偽の視線の理由', p_now: present(0.6), p_future: present(0.6), in_speech_pause: pause, vap_freshness: 'fresh' };
}

const CANDIDATE_2 = 'fake_candidate_2';
const llmMeasured = (request_id: string, sent_at: number, received_at: number) => ({
  segment_id: 2,
  transcript_revision: 22,
  request_id,
  sent_at,
  received_at,
  model_version: 'FAKE_model',
});

function candidateChange(id: string, version: number, from: string | null, to: string, cause: string): EventDraft {
  return { event: 'candidate.state_changed', candidate_id: id, candidate_version: version, from, to, cause_source: 'code', cause } as EventDraft;
}
function candidateByModel(id: string, version: number, from: string | null, to: string, decision: 'NEW' | 'REVISE' | 'WITHDRAW', request_id: string): EventDraft {
  return { event: 'candidate.state_changed', candidate_id: id, candidate_version: version, from, to, cause_source: 'model_decision', decision, request_id } as EventDraft;
}

const TAIL_STEPS: readonly Step[] = [
  [3660, candidateByModel(CANDIDATE, 1, null, 'INTENT_READY', 'NEW', 'fake_r1')],
  [3700, candidateChange(CANDIDATE, 1, 'INTENT_READY', 'BREATH_INHALE', 'signal_gate_allowed')],
  [6100, candidateChange(CANDIDATE, 1, 'BREATH_INHALE', 'SPEAKING', 'turn_allowed')],
  [9500, { event: 'speech.ended', ...speechBase, spoken_text: '偽の発話', spoken_text_precision: 'time_proportional', samples_written: 54400, ended_at: 9500 }, BROWSER],
  [9500, candidateChange(CANDIDATE, 1, 'SPEAKING', 'SPOKEN', 'speech_finished')],
  [9600, turnAllowed(false, '偽: AI の発話の後')],
  [13000, { event: 'initiative.decision', decision: 'NONE', ...llmMeasured('fake_r2', 12200, 13000), reason: modelOutput('偽: 発話する理由がない') }],
  [15500, prefetch('prefetch.started', 2)],
  [16200, prefetch('prefetch.ready', 2)],
  [16500, turnAllowed(true, '偽: 利用者の発話の終わり')],
  [17000, speech('speech.started', 2, 17000, 22000), BROWSER],
  [19000, gaze('away', true)],
  [19800, gaze('user', false)],
  [22000, speech('speech.ended', 2, 17000, 22000), BROWSER],
  [22000, turnAllowed(false, '偽: AI の発話の後')],
  [26000, {
    event: 'initiative.decision', decision: 'NEW', ...llmMeasured('fake_r3', 25100, 25950),
    candidate_id: CANDIDATE_2, candidate_version: 1,
    intent_type: modelOutput('FAKE_question'), evidence_span: modelOutput('偽の断片その二'),
    reason: modelOutput('偽: LLM が書いた理由の例'), why_now: modelOutput('偽: 話題が切り替わる前に'),
    cost_of_waiting: modelOutput('偽: 話題が流れる'), proposed_utterance: modelOutput('偽: それはいつのことですか'),
    expiry_policy: modelOutput('FAKE'), urgency: modelOutput('FAKE'),
    evidence_valid: verified(false, 'fake'), evidence_segment_ids: verified([2], 'fake'), decided_at: 26000,
  }],
  [26010, candidateByModel(CANDIDATE_2, 1, null, 'INTENT_READY', 'NEW', 'fake_r3')],
  [28000, {
    event: 'initiative.decision', decision: 'REVISE', ...llmMeasured('fake_r4', 27200, 27950),
    candidate_id: CANDIDATE_2, candidate_version: 2,
    intent_type: modelOutput('FAKE_question'), evidence_span: modelOutput('偽の断片その二の続き'),
    reason: modelOutput('偽: 理由を書き直した例'), why_now: modelOutputAbsent('fake'),
    cost_of_waiting: modelOutputAbsent('fake'), proposed_utterance: modelOutput('偽: それは先週ですか'),
    expiry_policy: modelOutput('FAKE'), urgency: modelOutput('FAKE'),
    evidence_valid: verified(true, 'fake'), evidence_segment_ids: verified([2, 3], 'fake'), updated_at: 28000,
  }],
  [28010, candidateByModel(CANDIDATE_2, 2, 'INTENT_READY', 'INTENT_READY', 'REVISE', 'fake_r4')],
  [29000, prefetch('prefetch.started', 3)],
  [29800, prefetch('prefetch.ready', 3)],
  [31000, turnAllowed(true, '偽: 利用者の発話の終わり')],
  [31500, speech('speech.started', 3, 31500, 34200), BROWSER],
  [34000, turnAllowed(false, '偽: 利用者が話し始めた')],
  [34200, speech('speech.interrupted', 3, 31500, 34200), BROWSER],
  [36000, {
    event: 'initiative.decision', decision: 'WITHDRAW', ...llmMeasured('fake_r5', 35300, 35980),
    candidate_id: CANDIDATE_2, candidate_version: 2, withdrawn_at: 36000,
    withdraw_reason: modelOutput('偽: 利用者が自分で答えた'), reason: modelOutput('偽: 本人が説明した'), withdraw_evidence_segment_ids: verified([4], 'fake'),
  }],
  [36010, candidateByModel(CANDIDATE_2, 2, 'INTENT_READY', 'WITHDRAWN', 'WITHDRAW', 'fake_r5')],
  [37000, prefetch('prefetch.started', 4)],
  [37600, prefetch('prefetch.ready', 4)],
  [39000, prefetch('prefetch.cancelled', 4, 'superseded')],
  [40000, prefetch('prefetch.started', 5)],
  [40800, prefetch('prefetch.ready', 5)],
  [41500, turnAllowed(true, '偽: 利用者の発話の終わり')],
  [42000, speech('speech.started', 5, 42000, 46000), BROWSER],
  [44000, gaze('away', true)],
  [44600, gaze('user', false)],
  [46000, speech('speech.ended', 5, 42000, 46000), BROWSER],
  [46000, turnAllowed(false, '偽: AI の発話の後')],
  [46500, prefetch('prefetch.started', 6)],
  [46800, prefetch('prefetch.cancelled', 6, 'user_resumed')],
];

function vapSteps(): Step[] {
  const steps: Step[] = [];
  for (let t = 7000; t <= TAIL_END_MS; t += VAP_PERIOD_MS) steps.push([t, vapAt(t), WORKER]);
  return steps;
}

/** 不正なイベントを 1 件含む（time_basis がない）。 */
const BROKEN_EVENT = {
  schema_version: 1,
  event: 'provider.status',
  session_id: FAKE_SESSION_ID,
  note: '偽データ: 不正なイベントの表示確認',
};

export function createFakeEventScript(): unknown[] {
  // 時刻順に並べる（同じ時刻は元の順を保つ）。
  const steps = [...STEPS, ...TAIL_STEPS, ...vapSteps()]
    .map((step, i) => ({ step, i }))
    .sort((a, b) => a.step[0] - b.step[0] || a.i - b.i)
    .map(({ step }) => step);
  const events: unknown[] = steps.map(([t_ms, draft, basis]) => ({
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

/** 偽の口が接続の直後に流す research.config。向きは実測（i=1 が AI）と同じにしてある。 */
export const FAKE_RESEARCH_CONFIG = {
  type: 'research.config',
  policy_id: 'FAKE_policy',
  p_ai_index: 1,
  direction_status: 'measured',
  condition: 'initiative_inhale',
} as const;
