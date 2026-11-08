/**
 * 保留中の発話希望の更新（内容の再評価とタイミングの再判定の分離）のコードの層の試験。LLM の返答は台本で、
 * モデルの判断は何も試していない（内容の撤回が妥当かどうかは、ここが緑でも言えない）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LlmRequest } from '@llm-vap/contracts';
import { parseConversationKindProfile } from '../conversation_kind';
import type { ConversationKindProfile } from '../conversation_kind';
import { CURRENT_DESIRE_PROMPT_VERSION, CURRENT_TIMING_PROMPT_VERSION, getDesirePrompt, getTimingPrompt } from '../staged_prompt';
import type { StagedOptions } from '../staged';
import { deferred, interim, makeMonitor } from './helpers';
import type { Responder } from './helpers';

const repoRoot = join(import.meta.dirname, '..', '..', '..', '..', '..', '..');
const raw = JSON.parse(readFileSync(join(repoRoot, 'config', 'conversation_kind.joint_thinking.ja.json'), 'utf8')) as Record<string, unknown>;
const JOINT: ConversationKindProfile = parseConversationKindProfile(raw);

const STABLE = '予定は来週の水曜に変えました';
const LATER = `${STABLE}。そのあと店長に確認してもらったので問題はなくなりました`;
const LATEST = `${LATER}。それから次は別の仕入れ先の話もしておきたいのです`;

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
    withdraw_kind: '',
    withdraw_reason: '',
    withdraw_evidence_span: '',
    withdraw_evidence_segment_ids: [],
    ...partial,
  });
}
const UTTERANCE = '来週の水曜で本当に大丈夫なのかを確認させてください';
const NEW_D = desire({ desire: 'NEW', reason: '言いたい', intent_type: 'QUESTION', proposed_utterance: UTTERANCE, evidence_span: '来週の水曜', evidence_segment_ids: [0] });
const REVISE = (utterance: string, partial: Record<string, unknown> = {}) =>
  desire({ desire: 'REVISE', target_candidate_id: 'c_0001', reason: '更新', intent_type: 'QUESTION', proposed_utterance: utterance, evidence_span: '来週の水曜', evidence_segment_ids: [0], ...partial });
const KEEP = desire({ desire: 'KEEP', target_candidate_id: 'c_0001', reason: '変わらない' });
const WITHDRAW = (partial: Record<string, unknown> = {}) =>
  desire({ desire: 'WITHDRAW', target_candidate_id: 'c_0001', withdraw_kind: 'question_resolved', withdraw_reason: '解消した', withdraw_evidence_span: '問題はなくなりました', withdraw_evidence_segment_ids: [0], ...partial });
const timing = (verdict: string, partial: Record<string, unknown> = {}) =>
  JSON.stringify({ reason: 'r', why_now: '', cost_of_waiting: '', timing: verdict, target_candidate_id: 'c_0001', withdraw_reason: '', withdraw_evidence_span: '', withdraw_evidence_segment_ids: [], ...partial });

const isTiming = (r: LlmRequest): boolean => r.request_id.endsWith('_timing');

function makeStaged(responder: Responder, staged: Partial<StagedOptions> = {}, ledger: Record<string, unknown> = {}) {
  const options: StagedOptions = {
    timing_strategy: 'llm',
    profile: JOINT,
    recent_context: { max_turns: 4, max_chars_per_turn: 200 },
    revise_min_utterance_similarity: 0.8,
    ...staged,
  };
  return makeMonitor(responder, { staged: options } as never, ledger);
}
/** 生成段の返答を順に返す（尽きたら NONE）。タイミング段は固定か順に返す。 */
function script(desires: string[], timings: string[] = [timing('WAIT_FOR_TURN_END')]): Responder {
  let d = 0;
  let t = 0;
  return (r) => {
    if (isTiming(r)) return timings[Math.min(t++, timings.length - 1)]!;
    return desires[d++] ?? desire();
  };
}
async function feed(monitor: { onStt: (e: never) => void; whenIdle: () => Promise<void> }, text: string): Promise<void> {
  monitor.onStt(interim(text) as never);
  await monitor.whenIdle();
}

/** AI の発話の後の、次の segment の人の発話。 */
const nextSegment = (text: string) => ({ ...interim(text, '', 1), segment_id: 1 });

describe('内容の再評価（生成段）', () => {
  it('KEEP は候補をそのまま残し、音声を作り直さず、版も変えない', async () => {
    const { monitor, ledger, sink, llm } = makeStaged(script([NEW_D, KEEP]));
    await feed(monitor, STABLE);
    await feed(monitor, LATER);
    expect(sink.ofType('initiative.desire').map((e) => e.outcome)).toEqual(['registered', 'kept']);
    expect(ledger.list()).toMatchObject([{ candidate_id: 'c_0001', candidate_version: 1, state: 'INTENT_READY' }]);
    // 維持でもタイミングは毎回判定する（内容の判定とは別）。
    expect(llm.requests.filter(isTiming)).toHaveLength(2);
  });

  it('未解決の希望があるときの NONE は維持として扱う', async () => {
    const { monitor, ledger, sink } = makeStaged(script([NEW_D, desire()]));
    await feed(monitor, STABLE);
    await feed(monitor, LATER);
    expect(sink.ofType('initiative.desire')[1]).toMatchObject({ desire: 'NONE', outcome: 'kept' });
    expect(ledger.list()).toMatchObject([{ candidate_version: 1 }]);
  });

  it('実質の違う REVISE は新しい版にし、前後の比較を記録する', async () => {
    const { monitor, ledger, sink } = makeStaged(script([NEW_D, REVISE('店長さんの確認はいつ取れたのですか')]));
    await feed(monitor, STABLE);
    await feed(monitor, LATER);
    const event = sink.ofType('initiative.desire')[1]!;
    expect(event.outcome).toBe('revised');
    if (event.outcome !== 'revised' || !event.revise_comparison) throw new Error('比較の記録がない');
    expect(event.revise_comparison.value).toMatchObject({ method: expect.stringContaining('2'), threshold: 0.8, same_intent_type: true });
    expect(event.revise_comparison.value.similarity).toBeLessThan(0.8);
    expect(ledger.list()).toMatchObject([{ candidate_version: 2 }]);
  });

  it('REVISE の根拠は保留中の入力の範囲で検証する（逐語で一致しなければ棄却して元の版を残す）', async () => {
    const { monitor, ledger, sink } = makeStaged(script([NEW_D, REVISE('別の言い方でお聞きします', { evidence_span: '入力にない語句です' })]));
    await feed(monitor, STABLE);
    await feed(monitor, LATER);
    expect(sink.ofType('initiative.desire')[1]).toMatchObject({ desire: 'REVISE', outcome: 'gate_rejected' });
    expect(sink.ofType('initiative.desire')[1]!.gate.value.reasons.join(',')).toContain('evidence');
    expect(ledger.list()).toMatchObject([{ candidate_version: 1 }]);
  });

  it.each(['question_resolved', 'premise_changed', 'topic_moved'])('WITHDRAW の分類 %s をイベントと遷移に残す', async (kind) => {
    const { monitor, ledger, sink } = makeStaged(script([NEW_D, WITHDRAW({ withdraw_kind: kind })]));
    await feed(monitor, STABLE);
    await feed(monitor, LATER);
    const event = sink.ofType('initiative.desire')[1]!;
    expect(event).toMatchObject({ desire: 'WITHDRAW', outcome: 'withdrawn', withdraw_kind: { value: kind } });
    expect(ledger.list()).toHaveLength(0);
    const change = sink.ofType('candidate.state_changed').at(-1)!;
    expect(change).toMatchObject({ to: 'WITHDRAWN', cause_source: 'model_decision', decision: 'WITHDRAW', withdraw_kind: { value: kind } });
  });

  it.each(['', 'nonsense'])('分類が不正（%j）の WITHDRAW は棄却して候補を残す', async (kind) => {
    const { monitor, ledger, sink } = makeStaged(script([NEW_D, WITHDRAW({ withdraw_kind: kind })]));
    await feed(monitor, STABLE);
    await feed(monitor, LATER);
    const event = sink.ofType('initiative.desire')[1]!;
    expect(event.outcome).toBe('gate_rejected');
    expect(event.gate.value.reasons).toContain('withdraw_kind_invalid');
    expect(ledger.list()).toHaveLength(1);
  });

  it('撤回の後はタイミング段を呼ばない（内容の撤回とタイミングの判定は別の経路）', async () => {
    const { monitor, llm, sink } = makeStaged(script([NEW_D, WITHDRAW()]));
    await feed(monitor, STABLE);
    await feed(monitor, LATER);
    expect(llm.requests.map((r) => r.request_id)).toEqual(['ini_0001', 'ini_0001_timing', 'ini_0002']);
    expect(sink.ofType('initiative.timing')).toHaveLength(1);
  });
});

describe('REVISE の抑制（内容が実質同じなら作り直さない）', () => {
  const NEAR = '来週の水曜で本当に大丈夫かどうかを確認させてください';

  it('同じ意図で類似度が基準以上なら維持として扱い、音声を作り直さず、基準と値を記録する', async () => {
    const { monitor, ledger, sink, speech } = makeStaged(script([NEW_D, REVISE(NEAR)]));
    await feed(monitor, STABLE);
    await feed(monitor, LATER);
    const event = sink.ofType('initiative.desire')[1]!;
    expect(event).toMatchObject({ desire: 'REVISE', outcome: 'revise_suppressed' });
    if (!event.revise_comparison) throw new Error('比較の記録がない');
    expect(event.revise_comparison.value.similarity).toBeGreaterThanOrEqual(0.8);
    expect(event.revise_comparison.value.threshold).toBe(0.8);
    expect(ledger.list()).toMatchObject([{ candidate_version: 1, proposed_utterance: UTTERANCE }]);
    expect(speech.discards).toHaveLength(0);
  });

  it('類似でも意図の種類が違えば抑制しない', async () => {
    const { monitor, ledger, sink } = makeStaged(script([NEW_D, REVISE(NEAR, { intent_type: 'CLARIFICATION' })]));
    await feed(monitor, STABLE);
    await feed(monitor, LATER);
    expect(sink.ofType('initiative.desire')[1]).toMatchObject({ outcome: 'revised' });
    expect(ledger.list()).toMatchObject([{ candidate_version: 2 }]);
  });

  it('基準が未設定なら抑制せず、比較も記録しない', async () => {
    const { monitor, sink } = makeStaged(script([NEW_D, REVISE(NEAR)]), { revise_min_utterance_similarity: undefined } as never);
    await feed(monitor, STABLE);
    await feed(monitor, LATER);
    const event = sink.ofType('initiative.desire')[1]!;
    expect(event).toMatchObject({ outcome: 'revised' });
    expect(event.revise_comparison).toBeUndefined();
  });
});

describe('タイミングの再判定（タイミング段）', () => {
  it('WAIT から OFFER_NOW へ変えられ、変化を時系列で残す', async () => {
    const { monitor, ledger, sink } = makeStaged(script([NEW_D, KEEP, KEEP], [timing('WAIT_FOR_TURN_END'), timing('OFFER_NOW'), timing('OFFER_NOW')]));
    await feed(monitor, STABLE);
    expect(monitor.latestTiming('c_0001', 1)).toMatchObject({ timing: 'WAIT_FOR_TURN_END' });
    await feed(monitor, LATER);
    await feed(monitor, LATEST);
    expect(monitor.latestTiming('c_0001', 1)).toMatchObject({ timing: 'OFFER_NOW' });
    expect(sink.ofType('initiative.timing').map((e) => [e.timing, e.previous_timing, e.timing_changed])).toEqual([
      ['WAIT_FOR_TURN_END', null, false],
      ['OFFER_NOW', 'WAIT_FOR_TURN_END', true],
      ['OFFER_NOW', 'OFFER_NOW', false],
    ]);
    // タイミングの変化で E2a の状態は動かない。
    expect(sink.ofType('candidate.state_changed').map((e) => e.to)).toEqual(['INTENT_READY']);
    expect(ledger.list()).toMatchObject([{ state: 'INTENT_READY', candidate_version: 1 }]);
  });

  it('WAIT の判定は候補を撤回しない（「今は言わない」と内容の撤回は別）', async () => {
    const { monitor, ledger, sink } = makeStaged(script([NEW_D, KEEP], [timing('WAIT_FOR_TURN_END')]));
    await feed(monitor, STABLE);
    await feed(monitor, LATER);
    expect(ledger.list()).toHaveLength(1);
    expect(sink.ofType('candidate.state_changed').some((e) => e.to === 'WITHDRAWN')).toBe(false);
  });

  it('タイミング段の出力に WITHDRAW があっても候補は撤回しない（出力の形として受け付けない）', async () => {
    const { monitor, ledger, sink } = makeStaged(script([NEW_D], [timing('WITHDRAW', { withdraw_reason: 'w', withdraw_evidence_span: '来週の水曜', withdraw_evidence_segment_ids: [0] })]));
    await feed(monitor, STABLE);
    expect(ledger.list()).toHaveLength(1);
    expect(sink.ofType('candidate.state_changed').map((e) => e.to)).toEqual(['INTENT_READY']);
    expect(monitor.latestTiming('c_0001', 1)).toBeNull();
    expect(sink.ofType('initiative.discarded').length).toBeGreaterThan(0);
  });

  it('判定の間に候補が解決していたら判定を残さない', async () => {
    const gate = deferred<string>();
    const { monitor, ledger, sink, time } = makeStaged((r) => (isTiming(r) ? gate.promise : NEW_D));
    monitor.onStt(interim(STABLE) as never);
    await new Promise((resolve) => setImmediate(resolve));
    ledger.onNormalResponseStarted(time.monotonicMs());
    gate.resolve(timing('OFFER_NOW'));
    await monitor.whenIdle();
    expect(sink.ofType('initiative.timing')[0]).toMatchObject({ outcome: 'rejected', ledger_reason: { value: 'candidate_no_longer_pending' } });
    expect(monitor.latestTiming('c_0001', 1)).toBeNull();
  });

  it('immediate はタイミング段の LLM を呼ばず OFFER_NOW 相当を残す（E2a は変えない）', async () => {
    const { monitor, llm, sink, ledger } = makeStaged(script([NEW_D]), { timing_strategy: 'immediate' });
    await feed(monitor, STABLE);
    expect(llm.requests.filter(isTiming)).toHaveLength(0);
    expect(sink.ofType('initiative.timing')[0]).toMatchObject({ timing_strategy: 'immediate', timing: 'OFFER_NOW', model_call: false });
    expect(ledger.list()).toMatchObject([{ state: 'INTENT_READY' }]);
  });
});

describe('WAIT の候補の持ち越し（通常応答の開始を越えて保留）', () => {
  async function carried(ledgerSettings: Record<string, unknown> = {}, desires: string[] = [NEW_D]) {
    const made = makeStaged(script(desires), {}, ledgerSettings);
    await feed(made.monitor, STABLE);
    const refs = made.ledger.onNormalResponseStarted(made.time.monotonicMs(), () => true);
    return { ...made, refs };
  }

  it('carry が真なら撤回せず持ち越しの印を付け、carry がなければ従来どおり撤回する', async () => {
    const { ledger, refs } = await carried();
    expect(refs).toEqual([{ candidate_id: 'c_0001', candidate_version: 1 }]);
    expect(ledger.list()[0]!.carried_over).toMatchObject({ from_segment_id: 0 });
    const plain = makeStaged(script([NEW_D]));
    await feed(plain.monitor, STABLE);
    plain.ledger.onNormalResponseStarted(plain.time.monotonicMs());
    expect(plain.ledger.list()).toHaveLength(0);
    expect(plain.sink.ofType('candidate.state_changed').at(-1)).toMatchObject({ to: 'WITHDRAWN', cause: 'normal_response_started' });
  });

  it('segment が変わっても持ち越しは消えない。持ち越していない候補は消える', async () => {
    const { ledger, time } = await carried({ candidate_expires_on_segment_change: true });
    ledger.onSegmentChanged(1, time.monotonicMs());
    expect(ledger.list()).toHaveLength(1);
    const plain = makeStaged(script([NEW_D]), {}, { candidate_expires_on_segment_change: true });
    await feed(plain.monitor, STABLE);
    plain.ledger.onSegmentChanged(1, plain.time.monotonicMs());
    expect(plain.ledger.list()).toHaveLength(0);
  });

  it('持ち越しの間も期限 candidate_expiry_ms は有効で、原因は expired', async () => {
    const { ledger, time, sink } = await carried({ candidate_expiry_ms: 1000 });
    time.advance(1000);
    ledger.tick(time.monotonicMs());
    expect(ledger.list()).toHaveLength(0);
    expect(sink.ofType('candidate.state_changed').at(-1)).toMatchObject({ to: 'WITHDRAWN', cause: 'expired' });
  });

  it('持ち越しの候補は次の発話で根拠が見えなくても KEEP で残り、REVISE で通常の候補へ戻る', async () => {
    const made = makeStaged(script([NEW_D, KEEP, REVISE('次の話題でも同じことを確かめたいです', { evidence_span: '別の話', evidence_segment_ids: [1] })]));
    await feed(made.monitor, STABLE);
    made.ledger.onNormalResponseStarted(made.time.monotonicMs(), () => true);
    made.ledger.onSegmentChanged(1, made.time.monotonicMs());
    made.monitor.onStt(nextSegment('今度は全然別の話をしていますよ') as never);
    await made.monitor.whenIdle();
    expect(made.sink.ofType('initiative.desire')[1]).toMatchObject({ outcome: 'kept' });
    expect(made.ledger.list()[0]!.carried_over).toBeDefined();
    made.monitor.onStt(nextSegment('今度は全然別の話をしていますよ。その別の話を続けて聞いてください') as never);
    await made.monitor.whenIdle();
    expect(made.sink.ofType('initiative.desire')[2]).toMatchObject({ outcome: 'revised' });
    expect(made.ledger.list()[0]).toMatchObject({ candidate_version: 2 });
    expect(made.ledger.list()[0]!.carried_over).toBeUndefined();
  });

  it('持ち越しの候補の内容の撤回は、根拠の位置（候補の根拠より後ろ）の検査を免除し、逐語の照合は保つ', async () => {
    const WITH = (span: string) => WITHDRAW({ withdraw_kind: 'topic_moved', withdraw_evidence_span: span, withdraw_evidence_segment_ids: [1] });
    const made = makeStaged(script([NEW_D, WITH('入力にない語句です'), WITH('全然別の話')]));
    await feed(made.monitor, STABLE);
    made.ledger.onNormalResponseStarted(made.time.monotonicMs(), () => true);
    made.ledger.onSegmentChanged(1, made.time.monotonicMs());
    made.monitor.onStt(nextSegment('今度は全然別の話をしていますよ') as never);
    await made.monitor.whenIdle();
    expect(made.sink.ofType('initiative.desire')[1]).toMatchObject({ outcome: 'gate_rejected' });
    expect(made.ledger.list()).toHaveLength(1);
    made.monitor.onStt(nextSegment('今度は全然別の話をしていますよ。その別の話を続けて聞いてください') as never);
    await made.monitor.whenIdle();
    expect(made.sink.ofType('initiative.desire')[2]).toMatchObject({ outcome: 'withdrawn', withdraw_kind: { value: 'topic_moved' } });
    expect(made.ledger.list()).toHaveLength(0);
  });
});

describe('会話の種類（設定ファイルで足す）', () => {
  const improv = (): ConversationKindProfile =>
    parseConversationKindProfile({
      ...raw,
      conversation_kind: 'improv_scene',
      desire_lens: { ...(raw.desire_lens as object), conditions: ['試験用の生成条件の文'] },
      timing_lens: { ...(raw.timing_lens as object), conditions: ['試験用のタイミング条件の文'] },
    });

  it('コードを変えずに新しい ID の設定を読めて、生成とタイミングの条件が別々にプロンプトへ入る', () => {
    const profile = improv();
    expect(profile.conversation_kind).toBe('improv_scene');
    const d = getDesirePrompt(CURRENT_DESIRE_PROMPT_VERSION).system(profile);
    const t = getTimingPrompt(CURRENT_TIMING_PROMPT_VERSION).system(profile);
    expect(d).toContain('試験用の生成条件の文');
    expect(d).not.toContain('試験用のタイミング条件の文');
    expect(t).toContain('試験用のタイミング条件の文');
    expect(t).not.toContain('試験用の生成条件の文');
  });

  it('条件の欠けた設定や、形式の不正な ID は読み込みで落ちる', () => {
    expect(() => parseConversationKindProfile({ ...raw, conversation_kind: 'Bad Kind' })).toThrow();
    expect(() => parseConversationKindProfile({ ...raw, timing_lens: { ...(raw.timing_lens as object), conditions: [] } })).toThrow();
    expect(() => parseConversationKindProfile({ ...raw, desire_lens: { ...(raw.desire_lens as object), conditions: undefined } })).toThrow();
  });

  it('既定の2種類のプロンプトは設定の条件を載せ、種類ごとの語を本体に埋めていない', () => {
    const d = getDesirePrompt(CURRENT_DESIRE_PROMPT_VERSION).system(JOINT);
    for (const line of JOINT.desire_lens.conditions) expect(d).toContain(line);
    const empty = parseConversationKindProfile({ ...raw, desire_lens: { ...(raw.desire_lens as object), conditions: ['X'] } });
    const body = getDesirePrompt(CURRENT_DESIRE_PROMPT_VERSION).system(empty);
    for (const line of JOINT.desire_lens.conditions) expect(body).not.toContain(line);
  });
});
