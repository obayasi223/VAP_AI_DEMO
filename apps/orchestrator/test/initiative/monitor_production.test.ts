/**
 * 本実装の InitiativeMonitor（G）の試験: 全部の判定が E2a の CandidateLedger を通ること、実 Gemini プロバイダの形
 * （偽サーバー）との組み合わせで llm.* と cost.usage が二重にならないこと、判定の失敗の扱い。
 * LLM の返答は台本と偽サーバーで、モデルの判断は何も試していない。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ManualTimeSource, MemoryEventSink, createEventEmitter } from '@llm-vap/contracts';
import { FakeGeminiServer } from '@llm-vap/testkit';
import { InitiativeMonitor } from '../../src/cognition/initiative';
import type { InitiativeLedgerPort } from '../../src/cognition/initiative';
import { CandidateLedger } from '../../src/control/candidates';
import type { ModelDecision } from '../../src/control/candidates';
import { GeminiLlmProvider } from '../../src/providers/llm';
import { InitiativeWiring, NO_CANDIDATE_SPEECH } from '../../src/session/initiative_wiring';
import { LEDGER_SETTINGS, PERSONA, RecordingSpeech, interim, makeMonitor, output } from '../../src/cognition/initiative/__tests__/helpers';
import { productionJaPolicy } from '../session/helpers';
import { summarizeCost } from '@llm-vap/analysis';
import { INITIATIVE_GEMINI_STATUS } from '../../src/app/providers';

const STABLE = '予算は五十万円のままで進めます';
const LATER = `${STABLE}。部長に相談して追加で出してもらえることになりました`;
const NEW = output({ decision: 'NEW', evidence_span: '五十万円', evidence_segment_ids: [0], proposed_utterance: '確認です', reason: 'r' });

describe('全部の判定が E2a の CandidateLedger を通る', () => {
  it('NONE、NEW、KEEP、REVISE、WITHDRAW の順に applyModelDecision へ渡り、遷移の発行は E2a だけ', async () => {
    const script = [
      output({ decision: 'NONE', reason: 'まだ' }),
      NEW,
      output({ decision: 'KEEP', target_candidate_id: 'c_0001' }),
      output({ decision: 'REVISE', target_candidate_id: 'c_0001', evidence_span: '部長に相談', evidence_segment_ids: [0], proposed_utterance: '新しい案' }),
      output({ decision: 'WITHDRAW', target_candidate_id: 'c_0001', withdraw_reason: '解消', withdraw_evidence_span: '来週から準備', withdraw_evidence_segment_ids: [0] }),
    ];
    // monitor と E2a の発行先を分けて、monitor が遷移のイベントを出さないことを確かめる。
    const time = new ManualTimeSource();
    const monitorSink = new MemoryEventSink();
    const ledgerSink = new MemoryEventSink();
    const speech = new RecordingSpeech();
    let monitor: InitiativeMonitor | null = null;
    const ledger = new CandidateLedger({
      emitter: createEventEmitter({ time, session_id: 's', condition: () => 'reactive', sink: ledgerSink }),
      stable: () => monitor?.stableSnapshot() ?? [],
      speech,
      settings: LEDGER_SETTINGS,
    });
    const seen: ModelDecision['decision'][] = [];
    const port: InitiativeLedgerPort = {
      applyModelDecision: (d) => {
        seen.push(d.decision);
        return ledger.applyModelDecision(d);
      },
      list: () => ledger.list(),
      sweepEvidence: (at) => ledger.sweepEvidence(at),
    };
    const parts = makeMonitor((_r, i) => script[i] ?? output({}));
    monitor = new InitiativeMonitor({
      llm: parts.llm,
      ledger: port,
      emitter: createEventEmitter({ time, session_id: 's', condition: () => 'reactive', sink: monitorSink }),
      time,
      persona: PERSONA,
      limits: { ...productionJaPolicy().initiative },
      trigger: { min_new_stable_chars: 10, min_new_chars_at_boundary: 4 },
    });
    const t2 = `${STABLE}。あいうえおかきくけこ`;
    const t3 = `${t2}。部長に相談して追加で出してもらえることになりました`;
    const t4 = `${t3}。たちつてとなにぬねの`;
    const t5 = `${t4}。それで来週から準備を始めます`;
    for (const text of [STABLE, t2, t3, t4, t5]) {
      monitor.onStt(interim(text));
      await monitor.whenIdle();
    }
    expect(monitorSink.ofType('initiative.discarded').map((e) => e.reason)).toEqual([]);
    expect(seen).toEqual(['NONE', 'NEW', 'KEEP', 'REVISE', 'WITHDRAW']);
    expect(monitorSink.ofType('initiative.decision').map((e) => e.decision)).toEqual(['NONE', 'NEW', 'KEEP', 'REVISE', 'WITHDRAW']);
    expect(monitorSink.ofType('initiative.decision')[2]).toMatchObject({ evidence_valid: { value: true } });
    for (const type of ['candidate.state_changed', 'candidate.rejected', 'llm.request', 'llm.response', 'cost.usage'] as const) {
      expect(monitorSink.ofType(type)).toHaveLength(0);
    }
    expect(ledgerSink.ofType('candidate.state_changed').map((e) => [e.to, e.cause_source === 'model_decision' ? e.decision : e.cause])).toEqual([
      ['INTENT_READY', 'NEW'],
      ['INTENT_READY', 'REVISE'],
      ['WITHDRAWN', 'WITHDRAW'],
    ]);
    expect(speech.discards.map((d) => d.reason)).toEqual(['candidate_revised', 'candidate_withdrawn']);
    expect(ledger.get('c_0001')).toMatchObject({ state: 'WITHDRAWN', candidate_version: 2 });
  });

  it('KEEP の時点で根拠が E2a の安定テキストになければ E2a が撤回し、KEEP の evidence_valid は false', async () => {
    const time = new ManualTimeSource();
    const sink = new MemoryEventSink();
    const emitter = createEventEmitter({ time, session_id: 's', condition: () => 'reactive', sink });
    let monitor: InitiativeMonitor | null = null;
    let lose = false;
    const ledger = new CandidateLedger({
      emitter,
      // 根拠が消えた状況を E2a の側で作る（monitor の安定テキストの書き換えは sweep の試験で見ている）。
      stable: () => (lose ? [] : (monitor?.stableSnapshot() ?? [])),
      speech: new RecordingSpeech(),
      settings: LEDGER_SETTINGS,
    });
    const parts = makeMonitor((_r, i) => (i === 0 ? NEW : output({ decision: 'KEEP', target_candidate_id: 'c_0001' })));
    monitor = new InitiativeMonitor({
      llm: parts.llm,
      ledger,
      emitter,
      time,
      persona: PERSONA,
      limits: productionJaPolicy().initiative,
      trigger: { min_new_stable_chars: 10, min_new_chars_at_boundary: null },
    });
    monitor.onStt(interim(STABLE));
    await monitor.whenIdle();
    lose = true;
    monitor.onStt(interim(`${STABLE}。あいうえおかきくけこさしす`));
    await monitor.whenIdle();
    expect(sink.ofType('initiative.decision').at(-1)).toMatchObject({ decision: 'KEEP', evidence_valid: { value: false } });
    expect(ledger.get('c_0001')?.state).toBe('WITHDRAWN');
    expect(sink.ofType('candidate.state_changed').at(-1)).toMatchObject({ cause_source: 'code', cause: 'evidence_lost' });
  });
});

describe('実 Gemini プロバイダの形（偽サーバー）と組み合わせる', () => {
  let server: FakeGeminiServer;
  let port: number;
  let reply: () => string;

  beforeEach(async () => {
    reply = () => NEW;
    server = new FakeGeminiServer({ responder: () => reply(), chars_per_chunk: 40 });
    port = await server.start();
  });
  afterEach(async () => {
    await server.stop();
  });

  function rig(options: { timeout_ms?: number; status_name?: string } = {}) {
    const time = new ManualTimeSource();
    const sink = new MemoryEventSink();
    const emitter = createEventEmitter({ time, session_id: 's', condition: () => 'initiative_no_cue', sink });
    const llm = new GeminiLlmProvider({
      api_key: 'test-key-not-real',
      time,
      emitter,
      base_url: `http://127.0.0.1:${port}`,
      max_output_tokens: 4096,
      ...(options.timeout_ms ? { timeout_ms: options.timeout_ms } : {}),
      ...(options.status_name ? { status_name: options.status_name } : {}),
    });
    const policy = productionJaPolicy();
    const wiring = new InitiativeWiring({
      llm,
      persona: PERSONA,
      policy,
      emitter,
      time,
      speech: () => NO_CANDIDATE_SPEECH,
      trigger: { min_new_stable_chars: 10, min_new_chars_at_boundary: null },
    });
    return { time, sink, wiring, llm, emitter };
  }

  it('llm.request と llm.response は1要求に1件ずつ、cost.usage はプロバイダの単位だけ（二重計上しない）', async () => {
    const { sink, wiring } = rig();
    wiring.onStt(interim(STABLE));
    await wiring.monitor.whenIdle();
    expect(sink.ofType('llm.request')).toHaveLength(1);
    expect(sink.ofType('llm.response')).toHaveLength(1);
    expect(sink.ofType('llm.request')[0]).toMatchObject({ request_id: 'ini_0001', purpose: 'initiative' });
    const costs = sink.ofType('cost.usage');
    expect(costs.length).toBeGreaterThan(0);
    expect(costs.every((c) => c.provider === 'gemini' && c.unit !== 'tokens')).toBe(true);
    expect(sink.ofType('initiative.decision')).toMatchObject([{ decision: 'NEW', request_id: 'ini_0001', candidate_id: 'c_0001' }]);
    // 構造化出力の指定はプロバイダへ渡っている。
    expect(server.requests[0]?.body.generationConfig).toMatchObject({ responseMimeType: 'application/json', maxOutputTokens: 4096 });
  });

  it('判定用の Gemini は provider.status を別名で出し（応答用の行と混ぜない）、cost.usage は gemini のまま単価と照合できる', async () => {
    const { sink, wiring, time } = rig({ status_name: INITIATIVE_GEMINI_STATUS });
    server.failNext(429);
    wiring.onStt(interim(STABLE));
    await wiring.monitor.whenIdle();
    time.advance(2000);
    wiring.tick(time.monotonicMs(), true);
    await wiring.monitor.whenIdle();
    // 429 で degraded、次の成功で ok。どちらも判定用の名前の行。
    expect(sink.ofType('provider.status').map((e) => [e.provider, e.status])).toEqual([
      ['gemini:initiative', 'degraded'],
      ['gemini:initiative', 'ok'],
    ]);
    expect(sink.ofType('provider.status').some((e) => e.provider === 'gemini')).toBe(false);
    const costs = sink.ofType('cost.usage');
    expect(costs.length).toBeGreaterThan(0);
    expect(costs.every((c) => c.provider === 'gemini' && c.purpose === 'initiative')).toBe(true);
    const summary = summarizeCost(sink.events);
    expect(summary.by_provider.map((p) => p.provider)).toEqual(['gemini']);
    const priced = costs.filter((c) => c.estimated_cost_usd.value !== null).length;
    expect(summary.by_provider[0]?.evidenced_count).toBe(priced);
  });

  it('要求の上限の報告は判定用 LLM の行でなく initiative_monitor の行へ出す', async () => {
    const { sink, wiring, llm, time, emitter } = rig({ status_name: INITIATIVE_GEMINI_STATUS });
    const policy = productionJaPolicy();
    const limited = new InitiativeMonitor({
      llm,
      ledger: wiring.ledger,
      emitter,
      time,
      persona: PERSONA,
      limits: { ...policy.initiative, max_requests_per_session: 1 },
      trigger: { min_new_stable_chars: 10, min_new_chars_at_boundary: null },
    });
    limited.onStt(interim(STABLE));
    await limited.whenIdle();
    limited.onStt(interim(LATER));
    await limited.whenIdle();
    const limit = sink.ofType('provider.status').filter((e) => e.status === 'degraded');
    expect(limit).toMatchObject([{ provider: 'initiative_monitor', reason: { value: 'initiative_request_limit_reached' } }]);
  });

  it('429 は候補を作らず理由を残し、続く増分ですぐには再要求しない', async () => {
    const { sink, wiring, time } = rig();
    server.failNext(429);
    wiring.onStt(interim(STABLE));
    await wiring.monitor.whenIdle();
    expect(sink.ofType('initiative.discarded').map((e) => e.reason)[0]).toMatch(/^provider_error:rate_limited:.*;backoff_ms=2000$/);
    expect(wiring.ledger.list()).toHaveLength(0);
    wiring.onStt(interim(LATER));
    await wiring.monitor.whenIdle();
    expect(server.requests).toHaveLength(1);
    time.advance(2000);
    wiring.tick(time.monotonicMs(), true);
    await wiring.monitor.whenIdle();
    expect(server.requests).toHaveLength(2);
    expect(wiring.ledger.list()).toHaveLength(1);
  });

  it('時間切れは候補を作らず理由を残す', async () => {
    await server.stop();
    server = new FakeGeminiServer({ responder: () => NEW, first_chunk_delay_ms: 400 });
    port = await server.start();
    const { sink, wiring } = rig({ timeout_ms: 50 });
    wiring.onStt(interim(STABLE));
    await wiring.monitor.whenIdle();
    expect(sink.ofType('initiative.discarded').map((e) => e.reason)[0]).toMatch(/^provider_error:timeout:/);
    expect(sink.ofType('initiative.decision')).toHaveLength(0);
    expect(wiring.ledger.list()).toHaveLength(0);
  });

  it('不正な出力（JSON でない、列挙の外）は候補を作らず理由を残す', async () => {
    const { sink, wiring, time } = rig();
    reply = () => 'すみません、判定できません';
    wiring.onStt(interim(STABLE));
    await wiring.monitor.whenIdle();
    reply = () => JSON.stringify({ decision: 'CLARIFY' });
    time.advance(2000);
    wiring.onStt(interim(LATER));
    await wiring.monitor.whenIdle();
    expect(sink.ofType('initiative.discarded').map((e) => e.reason)).toEqual([
      'model_output_not_json;backoff_ms=2000',
      'model_output_unknown_decision;backoff_ms=4000',
    ]);
    expect(wiring.ledger.list()).toHaveLength(0);
  });
});

describe('InitiativeWiring の口', () => {
  it('候補の発話の終わりを E2a の finishSpeech へ渡す（波2では候補を話さないので、話していない候補は拒否される）', async () => {
    const time = new ManualTimeSource();
    const sink = new MemoryEventSink();
    const emitter = createEventEmitter({ time, session_id: 's', condition: () => 'reactive', sink });
    const parts = makeMonitor(() => NEW);
    const wiring = new InitiativeWiring({
      llm: parts.llm,
      persona: PERSONA,
      policy: productionJaPolicy(),
      emitter,
      time,
      speech: () => null,
      trigger: { min_new_stable_chars: 10, min_new_chars_at_boundary: null },
    });
    wiring.onStt(interim(STABLE));
    await wiring.monitor.whenIdle();
    wiring.onSpeechFinished({ audio_playback_id: 3, interrupted: false, origin: { kind: 'response' } }, 10);
    expect(sink.ofType('candidate.rejected')).toHaveLength(0);
    wiring.onSpeechFinished({ audio_playback_id: 3, interrupted: true, origin: { kind: 'candidate', candidate_id: 'c_0001' } }, 10);
    expect(sink.ofType('candidate.rejected')).toMatchObject([{ operation: 'transition', requested_state: 'SPOKEN', cause: 'speech_interrupted' }]);
  });

  it('閉じたら以後の STT で判定しない', async () => {
    const parts = makeMonitor(() => NEW);
    const time = new ManualTimeSource();
    const wiring = new InitiativeWiring({
      llm: parts.llm,
      persona: PERSONA,
      policy: productionJaPolicy(),
      emitter: createEventEmitter({ time, session_id: 's', condition: () => 'reactive', sink: new MemoryEventSink() }),
      time,
      speech: () => null,
    });
    wiring.close();
    wiring.onStt(interim(`${STABLE}あいうえおかきくけこ`));
    await wiring.monitor.whenIdle();
    expect(parts.llm.requests).toHaveLength(0);
  });
});
