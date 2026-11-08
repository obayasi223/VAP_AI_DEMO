/**
 * 二段判定（生成段とタイミング段）のコードの層の試験。LLM の返答は台本で、モデルの判断は何も試していない。
 * ここが緑でも「発話希望の内容や時点が妥当」とは言えない（計画 §4.5a）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { HistoryEntry, LlmRequest } from '@llm-vap/contracts';
import { ScriptedLlmProvider } from '@llm-vap/testkit';
import { parseConversationKindProfile } from '../conversation_kind';
import type { ConversationKindProfile } from '../conversation_kind';
import { DESIRE_JSON_SCHEMA, TIMING_JSON_SCHEMA } from '../staged_output';
import { CURRENT_DESIRE_PROMPT_VERSION, CURRENT_TIMING_PROMPT_VERSION, getDesirePrompt, getTimingPrompt } from '../staged_prompt';
import type { StagedOptions } from '../staged';
import type { TriggerOptions } from '../monitor';
import { final, interim, makeMonitor } from './helpers';
import type { Responder } from './helpers';

const repoRoot = join(import.meta.dirname, '..', '..', '..', '..', '..', '..');
const loadProfile = (name: string): ConversationKindProfile =>
  parseConversationKindProfile(JSON.parse(readFileSync(join(repoRoot, 'config', name), 'utf8')));
const JOINT = loadProfile('conversation_kind.joint_thinking.ja.json');
const COMPANION = loadProfile('conversation_kind.companion.ja.json');

const STABLE = '予定は来週の水曜に変えました';
const LATER = `${STABLE}。そのあと店長に確認してもらったので問題はなくなりました`;

function desire(partial: Record<string, unknown> = {}): string {
  return JSON.stringify({
    reason: '',
    desire: 'NONE',
    target_candidate_id: '',
    intent_type: '',
    proposed_utterance: '',
    evidence_span: '',
    evidence_segment_ids: [],
    prior_turn_evidence_span: '',
    ...partial,
  });
}
const NEW_DESIRE = (partial: Record<string, unknown> = {}) =>
  desire({ desire: 'NEW', reason: '言いたい', intent_type: 'QUESTION', proposed_utterance: '水曜で大丈夫ですか', evidence_span: '来週の水曜', evidence_segment_ids: [0], ...partial });

function timing(partial: Record<string, unknown> = {}): string {
  return JSON.stringify({
    reason: 'r',
    why_now: '',
    cost_of_waiting: '',
    timing: 'WAIT_FOR_TURN_END',
    target_candidate_id: 'c_0001',
    withdraw_reason: '',
    withdraw_evidence_span: '',
    withdraw_evidence_segment_ids: [],
    ...partial,
  });
}

/** 内容の撤回（生成段）。分類は既定で question_resolved、根拠は LATER の後半。 */
const WITHDRAW_DESIRE = (partial: Record<string, unknown> = {}) =>
  desire({ desire: 'WITHDRAW', target_candidate_id: 'c_0001', withdraw_kind: 'question_resolved', withdraw_reason: '解消した', withdraw_evidence_span: '問題はなくなりました', withdraw_evidence_segment_ids: [0], ...partial });

const isTiming = (r: LlmRequest): boolean => r.request_id.endsWith('_timing');

function makeStaged(responder: Responder, staged: Partial<StagedOptions> = {}, extra: Record<string, unknown> = {}) {
  const options: StagedOptions = {
    timing_strategy: 'llm',
    profile: JOINT,
    recent_context: { max_turns: 4, max_chars_per_turn: 200 },
    ...staged,
  };
  return makeMonitor(responder, { staged: options, ...extra } as never);
}

async function feed(monitor: { onStt: (e: never) => void; whenIdle: () => Promise<void> }, text: string): Promise<void> {
  monitor.onStt(interim(text) as never);
  await monitor.whenIdle();
}

describe('段の分離', () => {
  it('希望が生じたら生成段とタイミング段を別の要求で呼び、別のイベントに残す', async () => {
    const { monitor, llm, sink, ledger } = makeStaged((r) => (isTiming(r) ? timing({ timing: 'OFFER_NOW', why_now: '今' }) : NEW_DESIRE()));
    await feed(monitor, STABLE);
    await monitor.whenIdle();
    expect(llm.requests.map((r) => r.request_id)).toEqual(['ini_0001', 'ini_0001_timing']);
    const [first, second] = llm.requests;
    expect(first!.system).not.toBe(second!.system);
    expect(first!.response_json_schema).toBe(DESIRE_JSON_SCHEMA);
    expect(second!.response_json_schema).toBe(TIMING_JSON_SCHEMA);
    expect(sink.ofType('initiative.desire')).toHaveLength(1);
    expect(sink.ofType('initiative.timing')).toHaveLength(1);
    expect(sink.ofType('initiative.decision')).toHaveLength(0);
    expect(ledger.list()).toHaveLength(1);
  });

  it('生成段のプロンプトは「今言うべきか」を判定させず、タイミング段は内容を判定しない', () => {
    const d = getDesirePrompt(CURRENT_DESIRE_PROMPT_VERSION).system(JOINT);
    expect(d).toContain('今言うべきか、話の途中かどうかは別の段が決める');
    expect(d).not.toContain('(a)');
    const t = getTimingPrompt(CURRENT_TIMING_PROMPT_VERSION).system(JOINT);
    expect(t).toContain('OFFER_NOW');
    expect(t).toContain('内容の良し悪しや書き換え');
    expect(JSON.stringify(TIMING_JSON_SCHEMA)).not.toContain('proposed_utterance');
    expect(JSON.stringify(DESIRE_JSON_SCHEMA)).not.toContain('why_now');
    expect(JSON.stringify(DESIRE_JSON_SCHEMA)).not.toContain('WAIT_FOR_TURN_END');
  });

  it('生成段が NONE で未解決の希望がなければ、タイミング段を呼ばない', async () => {
    const { monitor, llm, sink } = makeStaged(() => desire());
    await feed(monitor, STABLE);
    expect(llm.requests).toHaveLength(1);
    expect(sink.ofType('initiative.desire')[0]).toMatchObject({ desire: 'NONE', outcome: 'none' });
    expect(sink.ofType('initiative.timing')).toHaveLength(0);
  });

  it('未解決の希望があれば、生成段が NONE でもタイミング段を呼ぶ', async () => {
    let n = 0;
    const { monitor, llm } = makeStaged((r) => {
      if (isTiming(r)) return timing();
      n += 1;
      return n === 1 ? NEW_DESIRE() : desire();
    });
    await feed(monitor, STABLE);
    await feed(monitor, LATER);
    expect(llm.requests.filter(isTiming)).toHaveLength(2);
  });
});

describe('方式の切替', () => {
  it('immediate は LLM を呼ばず、次の機会に申し出る記録だけを残す', async () => {
    const { monitor, llm, sink } = makeStaged(() => NEW_DESIRE(), { timing_strategy: 'immediate' });
    await feed(monitor, STABLE);
    expect(llm.requests).toHaveLength(1);
    const events = sink.ofType('initiative.timing');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ timing_strategy: 'immediate', timing: 'OFFER_NOW', model_call: false, candidate_id: 'c_0001' });
    expect(monitor.latestTiming('c_0001', 1)).toMatchObject({ timing: 'OFFER_NOW', strategy: 'immediate' });
  });

  it('v2 は既存の1段判定を通り、新しいイベントを出さない', async () => {
    const { monitor, llm, sink } = makeStaged(
      () =>
        JSON.stringify({ decision: 'NONE', reason: '', why_now: '', cost_of_waiting: '', resolution_outlook: '', target_candidate_id: '', intent_type: '', evidence_span: '', evidence_segment_ids: [], proposed_utterance: '', expiry_policy: '', urgency: '', withdraw_reason: '', withdraw_evidence_span: '', withdraw_evidence_segment_ids: [] }),
      { timing_strategy: 'v2' },
    );
    await feed(monitor, STABLE);
    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0]!.request_id).toBe('ini_0001');
    expect(llm.requests[0]!.system).toContain('発話希望の判定器');
    expect(sink.ofType('initiative.decision')).toHaveLength(1);
    expect(sink.ofType('initiative.desire')).toHaveLength(0);
    expect(sink.ofType('initiative.timing')).toHaveLength(0);
  });

  it('staged を渡さなければ既存の経路のまま', async () => {
    const { monitor, llm } = makeMonitor(() => JSON.stringify({ decision: 'NONE' }));
    monitor.onStt(interim(STABLE));
    await monitor.whenIdle();
    expect(llm.requests[0]!.system).toContain('発話希望の判定器');
  });

  it('タイミング段に別のモデルを使える。モデル名は段ごとに記録する', async () => {
    const base = new ScriptedLlmProvider({ responder: () => timing(), chars_per_delta: 100_000 });
    const timingLlm = {
      provider: 'other',
      provider_class: 'test_double' as const,
      model_version: 'other-model',
      requests: base.requests,
      generate: async (r: LlmRequest) => ({ ...(await base.generate(r)), model_version: 'other-model' }),
      stream: (r: LlmRequest) => base.stream(r),
    };
    const { monitor, llm, sink } = makeStaged(() => NEW_DESIRE(), { timing_llm: timingLlm });
    await feed(monitor, STABLE);
    expect(timingLlm.requests).toHaveLength(1);
    expect(llm.requests).toHaveLength(1);
    expect(sink.ofType('initiative.timing')[0]!.timing_strategy).toBe('llm');
    const event = sink.ofType('initiative.timing')[0]!;
    if (event.timing_strategy !== 'llm') throw new Error('unexpected');
    expect(event.model_version).toBe('other-model');
    expect(sink.ofType('initiative.desire')[0]!.model_version).not.toBe('other-model');
  });
});

const history = (entries: HistoryEntry[], v = 7) => ({ snapshot: () => entries, version: () => v });
const USER = (text: string, segment_id: number): HistoryEntry => ({ role: 'user', text, segment_id, transcript_revision: 1, is_final: true, audio_frame_end: 0 });
const AI = (text: string, interrupted = false): HistoryEntry => ({
  role: 'assistant',
  text,
  audio_playback_id: 1,
  spoken_text_precision: 'alignment_char',
  interrupted,
  origin: { kind: 'response' },
});
const inSegment = (text: string, segment_id: number, asr = 0) => ({ ...interim(text, '', asr), segment_id });

describe('入力の範囲', () => {
  const entries: HistoryEntry[] = [
    USER('古い一言', 0),
    AI('前の応答です'),
    USER('その前の話です', 1),
    AI('途中まで話した応答', true),
    USER('今話している内容（履歴）', 2),
  ];

  it('直近の会話（AI の発話と人の発話）を、生成段とタイミング段の両方に渡す。今の発話は履歴から除く', async () => {
    const { monitor, llm, sink } = makeStaged((r) => (isTiming(r) ? timing() : NEW_DESIRE({ evidence_segment_ids: [0] })), {
      history: history(entries),
    });
    monitor.onStt(inSegment(STABLE, 2));
    await monitor.whenIdle();
    for (const r of llm.requests) {
      const text = r.messages[0]!.text;
      expect(text).toContain('AI: 途中まで話した応答（AI の発話はここで途中で切れた）');
      expect(text).toContain('人: その前の話です');
      expect(text).toContain('人: 古い一言');
      expect(text).not.toContain('今話している内容（履歴）');
      expect(text).toContain(STABLE);
    }
    expect(sink.ofType('initiative.desire')[0]).toMatchObject({ recent_turn_count: 4, history_version: { value: 7 } });
  });

  it('ターン数の上限を超えた古いターンは渡さず、長いターンは後ろを残す', async () => {
    const long = `あ${'い'.repeat(300)}う`;
    const { monitor, llm } = makeStaged(() => desire(), {
      history: history([USER('古い一言', 0), AI(long), USER('新しい一言', 1)]),
      recent_context: { max_turns: 2, max_chars_per_turn: 30 },
    });
    monitor.onStt(inSegment(STABLE, 2));
    await monitor.whenIdle();
    const text = llm.requests[0]!.messages[0]!.text;
    expect(text).not.toContain('古い一言');
    expect(text).toContain('人: 新しい一言');
    expect(text).toContain(`…${'い'.repeat(29)}う`);
  });

  it('履歴を配線していなければ、直近の会話なしで動き、その旨を記録する', async () => {
    const { monitor, llm, sink } = makeStaged(() => desire());
    await feed(monitor, STABLE);
    expect(llm.requests[0]!.messages[0]!.text).toContain('# 直近の会話\nなし');
    expect(sink.ofType('initiative.desire')[0]).toMatchObject({ recent_turn_count: 0, history_version: { value: null, null_reason: 'history_not_wired' } });
  });

  it('タイミング段の入力は生成段のあとの最新の安定テキストから作り直す', async () => {
    const seen: string[] = [];
    let monitorRef: { onStt: (e: never) => void } | null = null;
    const { monitor } = makeStaged((r) => {
      seen.push(r.messages[0]!.text);
      if (isTiming(r)) return timing();
      monitorRef!.onStt(interim(`${STABLE}さらに続きの話です`) as never);
      return NEW_DESIRE();
    });
    monitorRef = monitor as never;
    await feed(monitor, STABLE);
    expect(seen[0]).not.toContain('さらに続きの話です');
    expect(seen[1]).toContain('さらに続きの話です');
  });
});

describe('ゲート（根拠の範囲）', () => {
  it('今の発話にない根拠は棄却し、候補を作らずタイミング段も呼ばない', async () => {
    const { monitor, llm, sink, ledger } = makeStaged(() => NEW_DESIRE({ evidence_span: '入力にない語句' }));
    await feed(monitor, STABLE);
    expect(ledger.list()).toHaveLength(0);
    expect(llm.requests).toHaveLength(1);
    expect(sink.ofType('initiative.desire')[0]).toMatchObject({
      outcome: 'gate_rejected',
      gate: { source: 'verified', value: { passed: false } },
    });
    expect(sink.ofType('initiative.desire')[0]!.gate.value.reasons).toContain('evidence_not_in_input_stable_text');
  });

  it('過去のターンの語を evidence_span にしても通らない（根拠は今話している側の入力）', async () => {
    const { monitor, ledger, sink } = makeStaged(() => NEW_DESIRE({ evidence_span: '前の応答です' }), {
      history: history([AI('前の応答です')]),
    });
    await feed(monitor, STABLE);
    expect(ledger.list()).toHaveLength(0);
    expect(sink.ofType('initiative.desire')[0]).toMatchObject({ outcome: 'gate_rejected' });
  });

  it('過去のターンの根拠は、見せたターンにそのまま在れば受け入れ、位置を記録する', async () => {
    const { monitor, ledger, sink } = makeStaged((r) => (isTiming(r) ? timing() : NEW_DESIRE({ prior_turn_evidence_span: '前の応答です' })), {
      history: history([USER('はい', 0), AI('前の応答です')]),
    });
    monitor.onStt({ ...inSegment(STABLE, 2) } as never);
    await monitor.whenIdle();
    expect(ledger.list()).toHaveLength(1);
    expect(sink.ofType('initiative.desire')[0]!.prior_turn_evidence).toEqual({
      value: { source: 'verified', value: { turn_index: 1, role: 'ai' }, method: 'normalized_substring_of_shown_turn' },
    });
  });

  it('今の発話の前半を prior_turn_evidence_span に書いても棄却せず、過去のターンとしても数えない', async () => {
    const { monitor, ledger, sink } = makeStaged((r) => (isTiming(r) ? timing() : NEW_DESIRE({ prior_turn_evidence_span: '来週の水曜' })));
    await feed(monitor, STABLE);
    expect(ledger.list()).toHaveLength(1);
    expect(sink.ofType('initiative.desire')[0]).toMatchObject({ outcome: 'registered', prior_turn_evidence: { value: null } });
  });

  it('見せたターンにない過去の根拠は棄却する', async () => {
    const { monitor, ledger, sink } = makeStaged(() => NEW_DESIRE({ prior_turn_evidence_span: '見せていない語句です' }), {
      history: history([AI('前の応答です')]),
    });
    await feed(monitor, STABLE);
    expect(ledger.list()).toHaveLength(0);
    expect(sink.ofType('initiative.desire')[0]!.gate.value.reasons).toContain('prior_turn_evidence_not_in_shown_turns');
  });

  it('生成段の WITHDRAW は、候補の根拠より後ろの発話に根拠がなければ棄却し、候補を残す', async () => {
    const script: Responder = (r, i) => {
      if (isTiming(r)) return timing();
      return i === 0 ? NEW_DESIRE() : WITHDRAW_DESIRE({ withdraw_evidence_span: '来週の水曜' });
    };
    const { monitor, sink, ledger } = makeStaged(script);
    await feed(monitor, STABLE);
    await feed(monitor, LATER);
    const event = sink.ofType('initiative.desire')[1]!;
    expect(event).toMatchObject({ desire: 'WITHDRAW', outcome: 'gate_rejected' });
    expect(event.gate.value.reasons.join(',')).toContain('withdraw_rejected');
    expect(ledger.list()[0]!.state).toBe('INTENT_READY');
  });

  it('生成段の WITHDRAW は根拠が通れば候補を取り下げる。タイミング段の対象違いは棄却する', async () => {
    const script: Responder = (r, i) => {
      if (isTiming(r)) return timing({ target_candidate_id: 'c_9999' });
      return i === 0 ? NEW_DESIRE() : WITHDRAW_DESIRE();
    };
    const { monitor, sink, ledger } = makeStaged(script);
    await feed(monitor, STABLE);
    expect(sink.ofType('initiative.timing')[0]).toMatchObject({ outcome: 'gate_rejected' });
    expect(monitor.latestTiming('c_0001', 1)).toBeNull();
    await feed(monitor, LATER);
    expect(sink.ofType('initiative.desire')[1]).toMatchObject({ desire: 'WITHDRAW', outcome: 'withdrawn' });
    expect(ledger.list()).toHaveLength(0);
    expect(sink.ofType('candidate.state_changed').some((e) => e.to === 'WITHDRAWN')).toBe(true);
  });

  it('REVISE の対象が入力の候補でなければ棄却する', async () => {
    const { monitor, sink } = makeStaged((r) => (isTiming(r) ? timing() : NEW_DESIRE({ desire: 'REVISE', target_candidate_id: 'c_0042' })));
    await feed(monitor, STABLE);
    expect(sink.ofType('initiative.desire')[0]!.gate.value.reasons).toContain('target_candidate_not_in_input');
  });

  it('鮮度の上限を超えた生成段の結果は棄てて再判定し、その起動ではタイミング段を呼ばない', async () => {
    let monitorRef: { onStt: (e: never) => void } | null = null;
    let desireCalls = 0;
    const { monitor, llm, sink } = makeStaged((r) => {
      if (isTiming(r)) return timing();
      desireCalls += 1;
      if (desireCalls === 1) return NEW_DESIRE();
      // 2回目の要求の応答を待つ間に話が大きく進む（鮮度の上限を超える）。
      if (desireCalls === 2) {
        monitorRef!.onStt(interim(`${LATER}${'あ'.repeat(80)}`) as never);
        return NEW_DESIRE({ desire: 'REVISE', target_candidate_id: 'c_0001' });
      }
      return desire();
    });
    monitorRef = monitor as never;
    await feed(monitor, STABLE);
    await feed(monitor, LATER);
    await monitor.whenIdle();
    expect(sink.ofType('initiative.desire')[1]!.gate.value.reasons).toContain('stale_too_many_new_stable_chars');
    expect(llm.requests.map((r) => r.request_id)).toEqual(['ini_0001', 'ini_0001_timing', 'ini_0002', 'ini_0003', 'ini_0003_timing']);
  });
});

describe('評価できる記録', () => {
  it('段ごとに版、モデル、会話の種類、遅延、LLM 生成の印が残る', async () => {
    const { monitor, sink, time } = makeStaged((r) => {
      time.advance(120);
      return isTiming(r) ? timing({ timing: 'OFFER_NOW', why_now: '今', cost_of_waiting: '待つと' }) : NEW_DESIRE({ reason: '言いたい理由' });
    }, { profile: COMPANION });
    await feed(monitor, STABLE);
    const d = sink.ofType('initiative.desire')[0]!;
    expect(d).toMatchObject({
      prompt_version: CURRENT_DESIRE_PROMPT_VERSION,
      conversation_kind: 'companion',
      profile_version: COMPANION.profile_version,
      latency_ms: 120,
      outcome: 'registered',
    });
    expect(d.reason).toEqual({ source: 'model_output', value: '言いたい理由' });
    const t = sink.ofType('initiative.timing')[0]!;
    if (t.timing_strategy !== 'llm') throw new Error('unexpected');
    expect(t).toMatchObject({ prompt_version: CURRENT_TIMING_PROMPT_VERSION, conversation_kind: 'companion', latency_ms: 120, desire_request_id: 'ini_0001' });
    expect(t.why_now).toEqual({ source: 'model_output', value: '今' });
    expect(t.cost_of_waiting).toEqual({ source: 'model_output', value: '待つと' });
  });

  it('タイミング段の判定は候補に結びつくが E2a の基準は動かさない。版が変われば前の判定は読めない', async () => {
    const { monitor, ledger } = makeStaged((r) => (isTiming(r) ? timing({ timing: 'OFFER_NOW' }) : NEW_DESIRE()));
    await feed(monitor, STABLE);
    expect(monitor.latestTiming('c_0001', 1)).toMatchObject({ timing: 'OFFER_NOW', strategy: 'llm' });
    expect(ledger.list()[0]!.state).toBe('INTENT_READY');
    expect(monitor.latestTiming('c_0001', 2)).toBeNull();
    const request_id = ledger.getRecord('c_0001')!.last_request_id;
    expect(request_id).toBe('ini_0001');
    expect(monitor.stableCharsSinceInput(request_id)).toBe(0);
  });

  it('OFFER_NOW でも候補の状態（合図や発声）は変わらない', async () => {
    const { monitor, ledger, sink } = makeStaged((r) => (isTiming(r) ? timing({ timing: 'OFFER_NOW' }) : NEW_DESIRE()));
    await feed(monitor, STABLE);
    expect(ledger.list()[0]!.state).toBe('INTENT_READY');
    expect(sink.ofType('candidate.state_changed').map((e) => e.to)).toEqual(['INTENT_READY']);
  });

  it('タイミング段の失敗は候補を残し、理由を残して次の起動を待たせ、判定済みの生成段を戻さない', async () => {
    const { monitor, llm, sink, ledger } = makeStaged((r) => {
      if (isTiming(r)) throw new Error('boom');
      return NEW_DESIRE();
    }, {}, { failure_backoff: { base_ms: 1000, max_ms: 1000 } });
    await feed(monitor, STABLE);
    expect(ledger.list()).toHaveLength(1);
    const reasons = sink.ofType('initiative.discarded').map((e) => e.reason);
    expect(reasons[0]).toMatch(/^timing:provider_error/);
    expect(reasons[0]).toContain('backoff_ms=');
    expect(monitor.retryAfterMs()).not.toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    expect(llm.requests.filter((r) => !isTiming(r))).toHaveLength(1);
  });

  it('呼び出しの上限はタイミング段も含めて数え、超えたら止めて報告する', async () => {
    const { monitor, llm, sink } = makeStaged((r) => (isTiming(r) ? timing() : NEW_DESIRE()), {}, {
      limits: { max_new_stable_chars_since_input: 60, max_result_age_ms: 6000, min_stability: 0.8, max_active_candidates: 1, max_requests_per_session: 2 },
    });
    await feed(monitor, STABLE);
    expect(llm.requests.map((r) => r.request_id)).toEqual(['ini_0001', 'ini_0001_timing']);
    await feed(monitor, `${STABLE}そのあとさらに続きの発話がありました`);
    expect(llm.requests).toHaveLength(2);
    expect(sink.ofType('provider.status').some((e) => e.provider === 'initiative_monitor' && e.status === 'degraded')).toBe(true);
  });

  it('話の後に届いた NEW は held で残り、再開で held_promoted を出す', async () => {
    const { monitor, ledger, sink, time } = makeStaged((r) => (isTiming(r) ? timing() : NEW_DESIRE()), {}, {});
    time.advance(1000);
    ledger.observeUserFloor(false, 0);
    await feed(monitor, STABLE);
    expect(sink.ofType('initiative.desire')[0]).toMatchObject({ outcome: 'held', ledger_reason: { value: 'post_turn_new_held' } });
    const promoted = ledger.observeUserFloor(true, time.monotonicMs());
    expect(promoted).not.toBeNull();
    monitor.onHeldPromoted(promoted!, time.monotonicMs());
    const events = sink.ofType('initiative.desire');
    expect(events[events.length - 1]).toMatchObject({ outcome: 'held_promoted' });
    expect(ledger.list()).toHaveLength(1);
  });

  it('final でも増分の起動のたびに段を動かす（既存の起動の規則のまま）', async () => {
    const trigger: TriggerOptions = { min_new_stable_chars: 500, min_new_chars_at_boundary: null };
    const { monitor, llm } = makeStaged(() => desire(), {}, { trigger });
    monitor.onStt(final(STABLE) as never);
    await monitor.whenIdle();
    expect(llm.requests).toHaveLength(1);
  });
});

describe('会話の種類（設定ファイル）', () => {
  const FILES = ['conversation_kind.joint_thinking.ja.json', 'conversation_kind.companion.ja.json'];

  it.each(FILES)('%s は読み込めて、暫定と明記され、特定の議題の語を含まない', (name) => {
    const profile = loadProfile(name);
    expect(profile.provisional_note).toContain('暫定');
    const text = JSON.stringify(profile);
    for (const word of ['展示会', '予算', '見積', 'ブース', '納期', '店長']) expect(text).not.toContain(word);
  });

  it('2種類はプロンプトの観点が違い、生成段のプロンプトにそれぞれ入る', () => {
    expect(JOINT.conversation_kind).toBe('joint_thinking');
    expect(COMPANION.conversation_kind).toBe('companion');
    const d = (p: ConversationKindProfile) => getDesirePrompt(CURRENT_DESIRE_PROMPT_VERSION).system(p);
    expect(d(JOINT)).toContain(JOINT.desire_lens.viewpoints[0]);
    expect(d(COMPANION)).toContain(COMPANION.desire_lens.viewpoints[0]);
    expect(d(JOINT)).not.toContain(COMPANION.desire_lens.viewpoints[0]);
  });

  it('不足のある設定は読み込みで落ちる', () => {
    expect(() => parseConversationKindProfile({ ...JOINT, desire_lens: { viewpoints: [], intent_type_examples: ['X'] } })).toThrow();
    expect(() => parseConversationKindProfile({ ...JOINT, conversation_kind: 'Bad Kind' })).toThrow();
  });
});
