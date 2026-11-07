/** 各レーンの実装報告から足した項目の、スキーマだけでは見えない規則。 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AudioReport,
  BrowserToNode,
  ManualTimeSource,
  MemoryEventSink,
  Policy,
  PolicyJa,
  ResearchEvent,
  TrackSettings,
  absent,
  createEventEmitter,
  draftFromAudioReport,
  draftFromClockReport,
  prepareThresholds,
  present,
} from '../src/index';
import { BrowserToNode as BrowserToNodeSubpath } from '@llm-vap/contracts/browser_rpc';
import { absent as absentSubpath } from '@llm-vap/contracts/common';
import { OPTIONAL_FIXTURES, VALID_FIXTURES } from '../src/fixtures';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const readPolicy = (name: string): unknown => JSON.parse(readFileSync(join(repo, 'config', name), 'utf8'));

function emitted() {
  const sink = new MemoryEventSink();
  const emitter = createEventEmitter({
    time: new ManualTimeSource(10),
    session_id: 's',
    condition: () => 'reactive',
    sink,
  });
  return { sink, emitter };
}

describe('clock.report から clock.sync へ', () => {
  it('browser_rtt の clock.sync になり、スキーマに通る', () => {
    const { sink, emitter } = emitted();
    emitter.emit(
      draftFromClockReport({
        type: 'clock.report',
        offset_ms: -812.5,
        rtt_ms: 4,
        uncertainty_ms: 2,
        samples: 8,
        client_t_ms: 900,
      }),
    );
    expect(sink.ofType('clock.sync')[0]).toMatchObject({
      source: 'browser_rtt',
      offset_ms: -812.5,
      error_ms: 2,
      rtt_ms: { value: 4 },
    });
  });
});

describe('audio.report の任意の項目', () => {
  const base = OPTIONAL_FIXTURES.find((f) => f.name === 'audio.report/counters')?.value as AudioReport;

  it('渡された項目を audio.health へ運ぶ', () => {
    const { sink, emitter } = emitted();
    emitter.emit(draftFromAudioReport(base));
    expect(sink.ofType('audio.health')[0]).toMatchObject({
      reconnects: 1,
      orphan_pcm_frames: 2,
      pcm_seq_gaps: 3,
      render_lag_ms: 1.5,
    });
  });

  it('古い送信側の報告は項目を足さずに通す', () => {
    const { reconnects: _a, orphan_pcm_frames: _b, pcm_seq_gaps: _c, render_lag_ms: _d, ...old } = base;
    const { sink, emitter } = emitted();
    emitter.emit(draftFromAudioReport(old));
    expect(sink.ofType('audio.health')[0]).not.toHaveProperty('reconnects');
    expect(Object.keys(sink.events[0] as object)).not.toContain('render_lag_ms');
  });

  it('render_lag_ms は負になりうる（基準より早く届いた）', () => {
    expect(BrowserToNode.safeParse({ ...base, render_lag_ms: -0.5 }).success).toBe(true);
  });
});

describe('TrackSettings.latency', () => {
  const settings = {
    echoCancellation: present(false),
    noiseSuppression: present(false),
    autoGainControl: present(false),
    sampleRate: present(48000),
    channelCount: present(1),
    deviceId: absent('not_reported'),
  };

  it('省略でき、値か理由を持てる', () => {
    expect(TrackSettings.safeParse(settings).success).toBe(true);
    expect(TrackSettings.safeParse({ ...settings, latency: present(0.01) }).success).toBe(true);
    expect(TrackSettings.safeParse({ ...settings, latency: absent('browser_did_not_report') }).success).toBe(true);
    expect(TrackSettings.safeParse({ ...settings, latency: present(-1) }).success).toBe(false);
    expect(TrackSettings.safeParse({ ...settings, latency: 0.01 }).success).toBe(false);
  });
});

describe('準備の閾値の正本', () => {
  it('hri2025 は Appendix A の値のまま', () => {
    expect(prepareThresholds(Policy.parse(readPolicy('policy.hri2025.json')))).toEqual({
      completion_prepare_threshold: 0.2,
      similarity_prepare_threshold: 0.8,
    });
  });

  it('ja は completion と similarity の節を読み、turn.constants を読まない', () => {
    const ja = PolicyJa.parse(readPolicy('policy.ja.json'));
    expect(prepareThresholds(ja)).toEqual({
      completion_prepare_threshold: ja.completion.thresholds['ja_rules_v1']?.prepare_threshold,
      // similarity の節の値をそのまま読む。原著の 0.8 へ置き換えない。
      similarity_prepare_threshold: ja.similarity.threshold,
    });
    const moved = {
      ...ja,
      turn: {
        ...ja.turn,
        constants: { ...ja.turn.constants, TURNGPT_PREPARE_THRESHOLD: 0.99, SIMILARITY_PREPARE_THRESHOLD: 0.99 },
      },
    };
    expect(prepareThresholds(moved)).toEqual(prepareThresholds(ja));
  });

  it('推定器なしと表にない推定器は null', () => {
    const ja = PolicyJa.parse(readPolicy('policy.ja.json'));
    const none = { ...ja, completion: { ...ja.completion, estimator: null } };
    expect(prepareThresholds(none).completion_prepare_threshold).toBeNull();
    const unknown = { ...ja, completion: { ...ja.completion, estimator: 'other' } };
    expect(prepareThresholds(unknown).completion_prepare_threshold).toBeNull();
  });
});

describe('policy の起動の条件', () => {
  it('policy.ja.json に S の暫定値がある', () => {
    expect(PolicyJa.parse(readPolicy('policy.ja.json')).initiative.trigger).toEqual({
      min_new_stable_chars: 24,
      min_new_chars_at_boundary: 12,
    });
  });

  it('省略でき、不正な値は落ちる', () => {
    const ja = readPolicy('policy.ja.json') as { initiative: Record<string, unknown> };
    const { trigger: _trigger, ...initiative } = ja.initiative;
    expect(PolicyJa.safeParse({ ...ja, initiative }).success).toBe(true);
    const bad = { min_new_stable_chars: 0, min_new_chars_at_boundary: null };
    expect(PolicyJa.safeParse({ ...ja, initiative: { ...initiative, trigger: bad } }).success).toBe(false);
  });
});

describe('stt.handover の固定サンプル', () => {
  it('ResearchEvent に通る', () => {
    const fixture = VALID_FIXTURES.events.find((f) => f.name === 'stt.handover');
    expect(ResearchEvent.safeParse(fixture?.value).success).toBe(true);
  });
});

describe('小さく束ねるための入口', () => {
  it('browser_rpc と common を単独で読める', () => {
    expect(BrowserToNodeSubpath).toBe(BrowserToNode);
    expect(absentSubpath('x')).toEqual({ value: null, null_reason: 'x' });
  });
});
