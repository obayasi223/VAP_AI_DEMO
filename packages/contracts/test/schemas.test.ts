import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  absent,
  EVENT_NAMES,
  EVENT_ROUTES,
  Policy,
  PolicyHri2025,
  PolicyJa,
  ResearchEvent,
  SCHEMAS,
  splitInterimParts,
  stabilityFromProvider,
  toJsonSchema,
  turnConstants,
  turnInterpretation,
  type EventOf,
  type SchemaName,
} from '../src/index';
import { BINARY_FIXTURES, INVALID_FIXTURES, OPTIONAL_FIXTURES, VALID_FIXTURES } from '../src/fixtures';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, '..');
const repo = join(pkg, '..', '..');
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));

const names = Object.keys(SCHEMAS) as SchemaName[];
const validCases = names.flatMap((schema) =>
  VALID_FIXTURES[schema].map((f) => ({ schema, name: f.name, value: f.value })),
);

describe('valid fixtures', () => {
  it.each(validCases)('$schema / $name round-trips through JSON', ({ schema, value }) => {
    const parsed = SCHEMAS[schema].parse(value);
    expect(SCHEMAS[schema].parse(JSON.parse(JSON.stringify(parsed)))).toEqual(value);
  });
});

describe('required fields', () => {
  // 省略可能な項目は OPTIONAL_FIXTURES へ分けるので、ここの最上位の項目はどれを消しても不合格になる。
  const removals = validCases.flatMap((c) =>
    Object.keys(c.value as object).map((key) => ({ ...c, key })),
  );
  it.each(removals)('$schema / $name fails without $key', ({ schema, value, key }) => {
    const copy = { ...(value as Record<string, unknown>) };
    delete copy[key];
    expect(SCHEMAS[schema].safeParse(copy).success).toBe(false);
  });

  it('checks a meaningful number of removals', () => {
    expect(removals.length).toBeGreaterThan(400);
  });
});

describe('optional fields added for backward compatibility', () => {
  it.each(OPTIONAL_FIXTURES)('$schema / $name passes with them', ({ schema, value }) => {
    const parsed = SCHEMAS[schema].parse(value);
    expect(SCHEMAS[schema].parse(JSON.parse(JSON.stringify(parsed)))).toEqual(value);
  });

  it.each(OPTIONAL_FIXTURES)('$schema / $name passes without them', ({ schema, value, optional_keys }) => {
    const copy = { ...(value as Record<string, unknown>) };
    for (const key of optional_keys) {
      expect(copy, key).toHaveProperty(key);
      delete copy[key];
    }
    expect(SCHEMAS[schema].safeParse(copy).success).toBe(true);
  });
});

describe('unknown fields', () => {
  const eventCases = VALID_FIXTURES.events;
  it.each(eventCases)('$name rejects an unknown field', ({ value }) => {
    expect(ResearchEvent.safeParse({ ...(value as object), typo_field: 1 }).success).toBe(false);
  });
});

describe('invalid fixtures', () => {
  it.each(Object.entries(INVALID_FIXTURES))('%s', (_name, { schema, value }) => {
    expect(SCHEMAS[schema].safeParse(value).success).toBe(false);
  });
});

describe('plan §3.5 table', () => {
  // 計画の表を手で写した一覧。fixtures から項目が抜けたら、ここで検出する。
  const table: Record<string, string[]> = {
    'stt.interim': ['text', 'stable_text', 'unstable_text', 'parts', 'segment_id', 'asr_segment_id', 'transcript_revision', 'stability', 'stability_source', 'audio_frame_end', 'provider', 'model_version'],
    'stt.final': ['text', 'stable_text', 'unstable_text', 'parts', 'segment_id', 'asr_segment_id', 'transcript_revision', 'stability', 'stability_source', 'audio_frame_end', 'provider', 'model_version'],
    'stt.handover': ['provider', 'from_stream', 'to_stream', 'cause', 'h_frame', 'a_age_ms', 'overlap_ms', 'drain_ms', 'a_final_synthesized', 'first_b_emit_ms'],
    'llm.request': ['purpose', 'input', 'transcript_revision', 'sent_at', 'model_version'],
    'llm.response': ['purpose', 'output', 'transcript_revision', 'sent_at', 'received_at', 'model_version'],
    'vap.state/2ch': ['t', 'audio_frame', 'p_now', 'p_future', 'user_speaking', 'system_speaking', 'model_variant', 'channel_layout', 'raw'],
    'vap.state/1ch': ['t', 'audio_frame', 'p_now', 'p_future', 'user_speaking', 'system_speaking', 'model_variant', 'channel_layout', 'raw'],
    'prefetch.started': ['segment_id', 'transcript_revision', 'audio_playback_id', 'similarity', 'similarity_method', 'model_version'],
    'prefetch.cancelled': ['segment_id', 'transcript_revision', 'audio_playback_id', 'similarity', 'similarity_method', 'model_version'],
    'prefetch.ready': ['segment_id', 'transcript_revision', 'audio_playback_id', 'similarity', 'similarity_method', 'model_version'],
    'initiative.decision/NEW': ['decided_at', 'candidate_id', 'candidate_version', 'segment_id', 'transcript_revision', 'intent_type', 'evidence_span', 'evidence_valid', 'evidence_segment_ids', 'reason', 'why_now', 'cost_of_waiting', 'proposed_utterance', 'expiry_policy', 'urgency', 'sent_at', 'received_at', 'model_version'],
    'initiative.decision/REVISE': ['updated_at', 'candidate_id', 'candidate_version', 'segment_id', 'transcript_revision', 'intent_type', 'evidence_span', 'evidence_valid', 'evidence_segment_ids', 'reason', 'why_now', 'cost_of_waiting', 'proposed_utterance', 'expiry_policy', 'urgency', 'sent_at', 'received_at', 'model_version'],
    'initiative.decision/WITHDRAW': ['withdrawn_at', 'candidate_id', 'candidate_version', 'withdraw_reason', 'withdraw_evidence_segment_ids'],
    'initiative.discarded': ['reason', 'revision_gap'],
    'initiative.aborted': ['reason', 'revision_gap'],
    'candidate.state_changed/code': ['candidate_id', 'from', 'to', 'cause'],
    'signal.sent': ['candidate_id', 'phase', 'parameters'],
    'signal.started/visible': ['candidate_id', 'phase', 'parameters', 'started_at', 'visible'],
    'signal.started/hidden': ['candidate_id', 'phase', 'parameters', 'started_at', 'visible'],
    'signal.ended': ['candidate_id', 'phase', 'parameters'],
    'turn.allowed': ['turn_allowed', 'invitation', 'user_speaking', 'p_now', 'p_future', 'completion_p', 'gap_ms', 'priority', 'policy_id', 'decision_source', 'fallback_energy'],
    'speech.started/candidate': ['started_at', 'audio_playback_id', 'candidate_id', 'candidate_version', 'audio_frame'],
    'speech.ended/candidate': ['started_at', 'audio_playback_id', 'candidate_id', 'candidate_version', 'audio_frame', 'spoken_text', 'spoken_text_precision'],
    'speech.interrupted/candidate': ['started_at', 'audio_playback_id', 'candidate_id', 'candidate_version', 'audio_frame', 'spoken_text', 'spoken_text_precision'],
    'gaze.decision': ['reason', 'p_now', 'p_future', 'in_speech_pause'],
    'audio.health/browser': ['frames_lost', 'underrun_count', 'latency', 'track_settings', 'system_ch_source'],
    'audio.health/worker': ['frames_dropped_network', 'frames_dropped_overload', 'system_ch_source'],
    'provider.status': ['provider', 'status', 'reason', 'retry_attempt'],
    'cost.usage': ['provider', 'quantity', 'estimated_cost_usd'],
    'woz.override': ['action', 'operator'],
    'clock.sync': ['offset_ms', 'error_ms', 'source'],
  };
  const envelope = ['t_monotonic_ms', 'wall_clock', 'session_id', 'condition', 'event'];

  it.each(Object.entries(table))('%s carries its required fields', (name, fields) => {
    const fixture = VALID_FIXTURES.events.find((f) => f.name === name);
    expect(fixture, name).toBeDefined();
    const keys = Object.keys(fixture!.value as object);
    for (const field of [...envelope, ...fields]) expect(keys, `${name}.${field}`).toContain(field);
  });

  it('every event name has a fixture and a route', () => {
    for (const name of EVENT_NAMES) {
      expect(
        VALID_FIXTURES.events.some((f) => (f.value as { event: string }).event === name),
        name,
      ).toBe(true);
      expect(EVENT_ROUTES[name]).toBeDefined();
    }
    expect(new Set(EVENT_NAMES).size).toBe(EVENT_NAMES.length);
  });
});

describe('model output vs measurement in the type system', () => {
  it('keeps model text out of plain string positions', () => {
    const typeOnly = (e: EventOf<'initiative.decision'> & { decision: 'NEW' }) => {
      // @ts-expect-error reason はモデル出力で、素の string ではない
      const reason: string = e.reason;
      // @ts-expect-error evidence_valid は検証結果で、素の boolean ではない
      const valid: boolean = e.evidence_valid;
      // 実測の時刻は素の number
      const decided: number = e.decided_at;
      return [reason, valid, decided];
    };
    expect(typeof typeOnly).toBe('function');
    expect(absent('x')).toEqual({ value: null, null_reason: 'x' });
  });
});

describe('generated artifacts are current', () => {
  it.each(names)('schemas/%s.schema.json', (name) => {
    expect(readJson(join(pkg, 'schemas', `${name}.schema.json`))).toEqual(
      JSON.parse(JSON.stringify(toJsonSchema(name))),
    );
  });

  it('fixtures/contract_fixtures.json', () => {
    const onDisk = readJson(join(pkg, 'fixtures', 'contract_fixtures.json')) as Record<string, unknown>;
    expect(onDisk.valid).toEqual(JSON.parse(JSON.stringify(VALID_FIXTURES)));
    expect(onDisk.optional).toEqual(JSON.parse(JSON.stringify(OPTIONAL_FIXTURES)));
    expect(onDisk.invalid).toEqual(JSON.parse(JSON.stringify(INVALID_FIXTURES)));
    expect(onDisk.binary).toEqual(JSON.parse(JSON.stringify(BINARY_FIXTURES)));
  });
});

describe('policy files', () => {
  const hri = readJson(join(repo, 'config', 'policy.hri2025.json'));
  const ja = readJson(join(repo, 'config', 'policy.ja.json'));

  it('hri2025 carries the Appendix A values of plan §4.1 exactly', () => {
    const parsed = PolicyHri2025.parse(hri);
    expect(parsed.constants).toEqual({
      TURNGPT_PREPARE_THRESHOLD: 0.2,
      ASR_PREPARE_TIMEOUT_MS: 200,
      SIMILARITY_PREPARE_THRESHOLD: 0.8,
      VAP_PNOW_INTERRUPT: 0.4,
      VAP_PFUT_INTERRUPT: 0.4,
      VAP_PNOW_YIELD: 0.5,
      VAP_PFUT_YIELD: 0.5,
      MIN_GAP_TIME_MS: 500,
      YIELD_TIMEOUTS_MS: { '0.3': 500, '0.2': 1000, '0.1': 2000, '0.0': 3000 },
    });
  });

  it('ja template validates and keeps its initiative section', () => {
    const parsed = PolicyJa.parse(ja);
    expect(parsed.status).toBe('template');
    expect(parsed.vap.direction_status).toBe('provisional');
    expect(Object.keys(parsed.initiative)).toEqual(
      expect.arrayContaining([
        'max_new_stable_chars_since_input',
        'max_result_age_ms',
        'stable_prefix_revisions',
        'candidate_expiry_ms',
      ]),
    );
  });

  it('both files read through the same accessors', () => {
    const a = Policy.parse(hri);
    const b = Policy.parse(ja);
    expect(turnConstants(a).MIN_GAP_TIME_MS).toBe(500);
    expect(turnInterpretation(a).stop_point).toBe('immediate');
    expect(turnInterpretation(b).stop_point).toBe('word_boundary');
    expect(turnInterpretation(b).user_turn_end_updates_during_speech).toBe(true);
  });
});

describe('stability from a provider', () => {
  it('treats 0.0 as unset, not as unstable', () => {
    expect(stabilityFromProvider(0)).toEqual({ value: null, null_reason: 'provider_unset_marker_0.0' });
    expect(stabilityFromProvider(0.9)).toEqual({ value: 0.9 });
    expect(stabilityFromProvider(undefined).value).toBeNull();
    expect(stabilityFromProvider(1.5).value).toBeNull();
  });
});

describe('stable and unstable text', () => {
  const part = (text: string, value: number | null) => ({
    text,
    stability: value === null ? absent('none') : { value },
  });

  it('splits the measured shape: 0.9 stable part and 0.01 tail', () => {
    expect(splitInterimParts([part('月額料金の', 0.9), part('話', 0.01)], 0.8)).toEqual({
      text: '月額料金の話',
      stable_text: '月額料金の',
      unstable_text: '話',
      stability: { value: 0.9 },
    });
  });

  it('stops at the first part below the threshold', () => {
    const split = splitInterimParts([part('a', 0.9), part('b', 0.1), part('c', 0.9)], 0.8);
    expect(split.stable_text).toBe('a');
    expect(split.unstable_text).toBe('bc');
  });

  it('never calls text without a stability value stable', () => {
    const split = splitInterimParts([part('a', null)], 0.8);
    expect(split.stable_text).toBe('');
    expect(split.unstable_text).toBe('a');
    expect(split.stability.value).toBeNull();
  });

  it('handles an empty response', () => {
    expect(splitInterimParts([], 0.8).text).toBe('');
    expect(splitInterimParts([], 0.8).stability).toEqual({ value: null, null_reason: 'no_results' });
  });
});
