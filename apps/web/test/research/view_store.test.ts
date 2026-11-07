import { describe, expect, it } from 'vitest';
import { ResearchEvent } from '@llm-vap/contracts';
import { createFakeEventScript, FAKE_SESSION_ID } from '../../src/research/fake_events';
import { ResearchViewStore } from '../../src/research/view_store';

const FEED = { kind: 'ws', label: 'test', synthetic: false } as const;

function statusEvent(provider: string, provider_class: string, status = 'ok', t = 1) {
  return {
    schema_version: 1,
    t_monotonic_ms: t,
    wall_clock: '2026-11-08T00:00:00.000Z',
    session_id: 's',
    condition: 'reactive',
    time_basis: { source: 'orchestrator', uncertainty_ms: { value: 0 } },
    event: 'provider.status',
    provider,
    provider_class,
    status,
    reason: { value: null, null_reason: 'healthy' },
    retry_attempt: 0,
    next_retry_ms: { value: null, null_reason: 'no' },
  };
}

describe('ResearchViewStore', () => {
  it('何も届いていなければ 0 ではなく未受信と未計測の状態', () => {
    const snapshot = new ResearchViewStore(FEED).snapshot();
    expect(snapshot.accepted).toBe(0);
    expect(snapshot.current.vap).toBeNull();
    expect(snapshot.cost.status).toBe('no_usage');
    expect(snapshot.cost.estimated_usd).toBeNull();
    expect(snapshot.latency.rows.every((r) => r.stat.status === 'unmeasured')).toBe(true);
  });

  it('不合格の値を適用せず数える', () => {
    const store = new ResearchViewStore(FEED);
    store.event({ event: 'provider.status', provider: 'x' });
    store.malformed('Unexpected token');
    const snapshot = store.snapshot();
    expect(snapshot.invalid).toBe(2);
    expect(snapshot.accepted).toBe(0);
    expect(snapshot.providers).toEqual([]);
    expect(snapshot.last_invalid).toMatch(/JSON/);
  });

  it('プロバイダは最新の状態で 1 行', () => {
    const store = new ResearchViewStore(FEED);
    store.event(statusEvent('a', 'production', 'ok', 1));
    store.event(statusEvent('a', 'production', 'down', 2));
    const snapshot = store.snapshot();
    expect(snapshot.providers).toHaveLength(1);
    expect(snapshot.providers[0]?.status).toBe('down');
  });

  it('実データの口でも test double を含めば証拠に数えない理由を出す', () => {
    const store = new ResearchViewStore(FEED);
    store.event(statusEvent('a', 'production'));
    expect(store.snapshot().not_evidence_reasons).toEqual([]);
    store.event(statusEvent('b', 'test_double'));
    expect(store.snapshot().not_evidence_reasons).toEqual(['b は test_double']);
  });

  it('接続の状態を保持する', () => {
    const store = new ResearchViewStore(FEED);
    store.connection('error', 'failed');
    expect(store.snapshot().connection).toEqual({ state: 'error', detail: 'failed' });
  });
});

describe('偽のイベント列', () => {
  it('1 件だけわざと不正で、他はすべて契約に合格し、偽物と分かる', () => {
    const script = createFakeEventScript();
    const invalid = script.filter((e) => !ResearchEvent.safeParse(e).success);
    expect(invalid).toHaveLength(1);
    for (const event of script) {
      expect((event as { session_id: string }).session_id).toBe(FAKE_SESSION_ID);
    }
    const providers = script
      .map((e) => ResearchEvent.safeParse(e))
      .flatMap((r) => (r.success && r.data.event === 'provider.status' ? [r.data.provider_class] : []));
    expect(new Set(providers)).toEqual(new Set(['test_double']));
  });

  it('流すと全項目が表示内容に入る', () => {
    const store = new ResearchViewStore({ kind: 'fake', label: 'fake', synthetic: true });
    for (const event of createFakeEventScript()) store.event(event);
    const snapshot = store.snapshot();
    expect(snapshot.invalid).toBe(1);
    expect(snapshot.clocks.map((c) => c.source).sort()).toEqual(['browser_rtt', 'worker_audio_frame']);
    expect(snapshot.current.vap?.model_variant).toBe('FAKE_NOT_MAAI');
    expect(snapshot.current.turn?.allowed).toBe(true);
    expect(snapshot.current.speech?.state).toBe('speaking');
    expect(snapshot.current.gaze?.target).toBe('user');
    expect(snapshot.current.audio?.context).toBe('running');
    expect(snapshot.cost.status).toBe('partial');
    expect(snapshot.cost.by_provider.find((p) => p.provider === 'gemini_tts')?.estimated_usd).toBeNull();
    const measured = snapshot.latency.rows.filter((r) => r.stat.status === 'measured').map((r) => r.id);
    expect(measured).toContain('decision_to_breath');
    expect(measured).toContain('breath_to_speech');
    expect(measured).toContain('llm_roundtrip');
    const official = snapshot.latency.rows.find((r) => r.breakdown === 'official:posthoc_alignment');
    expect(official?.stat.status).toBe('unmeasured');
  });
});
