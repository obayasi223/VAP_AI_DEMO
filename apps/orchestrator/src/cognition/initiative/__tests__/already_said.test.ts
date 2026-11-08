/**
 * 重複発言の防止（コードの層）と反映の推定の試験。LLM の返答は台本、文は手書き。
 * モデルの判断の妥当性、閾値の妥当性は何も試していない（どちらも未校正の暫定値）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { HistoryEntry, LlmRequest } from '@llm-vap/contracts';
import { alreadySaidScore, estimateReflection, findAlreadySaid, matchSpoken } from '../already_said';
import { parseConversationKindProfile } from '../conversation_kind';
import type { StagedOptions } from '../staged';
import { deferred, interim, makeMonitor } from './helpers';
import type { Responder } from './helpers';

const repoRoot = join(import.meta.dirname, '..', '..', '..', '..', '..', '..');
const JOINT = parseConversationKindProfile(JSON.parse(readFileSync(join(repoRoot, 'config', 'conversation_kind.joint_thinking.ja.json'), 'utf8')));

const STABLE = '予定は来週の水曜に変えました';
const UTTERANCE = '来週の水曜で本当に大丈夫なのかを確認させてください';
const NEAR_UTTERANCE = '来週の水曜で本当に大丈夫なのか確認させてください。';

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
const NEW_D = (utterance = UTTERANCE) => desire({ desire: 'NEW', intent_type: 'QUESTION', proposed_utterance: utterance, evidence_span: '来週の水曜', evidence_segment_ids: [0] });
const KEEP = desire({ desire: 'KEEP', target_candidate_id: 'c_0001' });
const timing = (verdict = 'WAIT_FOR_TURN_END') => JSON.stringify({ reason: 'r', why_now: '', cost_of_waiting: '', timing: verdict, target_candidate_id: 'c_0001' });
const isTiming = (r: LlmRequest): boolean => r.request_id.endsWith('_timing');

function script(desires: string[]): Responder {
  let d = 0;
  return (r) => (isTiming(r) ? timing() : (desires[d++] ?? desire()));
}

const ai = (text: string, audio_playback_id = 1, origin: Extract<HistoryEntry, { role: 'assistant' }>['origin'] = { kind: 'response' }): HistoryEntry => ({
  role: 'assistant',
  text,
  audio_playback_id,
  spoken_text_precision: 'alignment_char',
  interrupted: false,
  origin,
});

function makeStaged(responder: Responder, entries: HistoryEntry[] = [], staged: Partial<StagedOptions> = {}) {
  const history = { snapshot: () => entries, version: () => entries.length };
  const options: StagedOptions = {
    timing_strategy: 'llm',
    profile: JOINT,
    recent_context: { max_turns: 4, max_chars_per_turn: 200 },
    history,
    already_said_min_similarity: 0.8,
    ...staged,
  };
  return { ...makeMonitor(responder, { staged: options } as never), entries };
}
async function feed(monitor: { onStt: (e: never) => void; whenIdle: () => Promise<void> }, text: string, segment = 0, asr = 0): Promise<void> {
  monitor.onStt({ ...interim(text, '', asr), segment_id: segment } as never);
  await monitor.whenIdle();
}

describe('すでに話した内容との比較（文字 2-gram のコサイン）', () => {
  it('全体と文ごとの大きい方を返し、値と根拠の文を残す', () => {
    const score = alreadySaidScore(UTTERANCE, `なるほど、それは大事ですね。${NEAR_UTTERANCE}今日はここまでにしましょう。`);
    expect(score.matched_text).toBe('来週の水曜で本当に大丈夫なのか確認させてください');
    expect(score.similarity).toBeGreaterThanOrEqual(0.8);
    expect(score.method).toContain('n=2');
    expect(alreadySaidScore(UTTERANCE, '')).toMatchObject({ similarity: 0, matched_text: '' });
  });

  it('言い換えや別の内容は基準（0.8）を超えない', () => {
    expect(alreadySaidScore(UTTERANCE, '水曜日で問題がないか、一度確かめてもいいですか。').similarity).toBeLessThan(0.8);
    expect(alreadySaidScore(UTTERANCE, '猫の名前を教えてください。').similarity).toBeLessThan(0.8);
  });

  it('途中で切れた発話は（文が短いので）言い終わったとはみなさない', () => {
    const interrupted = '来週の水曜で';
    expect(matchSpoken(UTTERANCE, interrupted, { threshold: 0.8, audio_playback_id: 3, origin: 'response' })).toBeNull();
  });

  it('履歴の AI の発話だけを見て、新しいものから探す', () => {
    const entries: HistoryEntry[] = [
      { role: 'user', text: UTTERANCE, segment_id: 0, transcript_revision: 1, is_final: true, audio_frame_end: 0 },
      ai('関係のない話です', 1),
      ai(UTTERANCE, 2, { kind: 'candidate', candidate_id: 'c_0009', candidate_version: 1 }),
    ];
    expect(findAlreadySaid(UTTERANCE, entries, 0.8)).toMatchObject({ audio_playback_id: 2, origin: 'candidate', threshold: 0.8 });
    expect(findAlreadySaid('まったく別の内容の文です', entries, 0.8)).toBeNull();
  });
});

describe('反映の推定（文字 2-gram の包含率）', () => {
  it('話した文に材料の内容の 2-gram が含まれれば estimated_reflected。値と基準を返す', () => {
    const { estimated_reflected, estimate } = estimateReflection(UTTERANCE, 'はい。来週の水曜で大丈夫なのか、確認させてください。', 0.5);
    expect(estimated_reflected).toBe(true);
    expect(estimate).toMatchObject({ basis: 'content_bigrams', threshold: 0.5 });
    expect(estimate.containment).toBeGreaterThanOrEqual(0.5);
    expect(estimate.matched_bigrams).toBeLessThanOrEqual(estimate.material_bigrams);
    expect(estimate.method).toContain('containment');
  });

  it('ひらがなの定型句だけの一致では反映としない', () => {
    expect(estimateReflection(UTTERANCE, 'はい、そうなのですね。どうぞつづけてください。', 0.5).estimated_reflected).toBe(false);
  });

  it('短い文やひらがなだけの材料は全部の 2-gram で測る', () => {
    expect(estimateReflection('そうですね', 'そうですね', 0.5)).toMatchObject({ estimated_reflected: true, estimate: { basis: 'all_bigrams' } });
  });
});

describe('同じ内容の新しい希望（NEW）の棄却', () => {
  it('AI がすでに話した内容の NEW はコードで棄却し、理由と比較を記録する（E2a に渡さない）', async () => {
    const { monitor, sink, ledger } = makeStaged(script([NEW_D()]), [ai(NEAR_UTTERANCE)]);
    await feed(monitor, STABLE);
    const event = sink.ofType('initiative.desire')[0]!;
    expect(event).toMatchObject({ desire: 'NEW', outcome: 'gate_rejected' });
    expect(event.gate.value.reasons).toContain('already_said');
    expect(event.already_said_comparison?.value).toMatchObject({ threshold: 0.8, matched_text: NEAR_UTTERANCE });
    expect(ledger.list()).toHaveLength(0);
    expect(sink.ofType('candidate.state_changed')).toHaveLength(0);
  });

  it('AI が話していなければ（前の候補を撤回しただけなら）同じ内容でも NEW を受け付ける。人の発話の変化を潰さない', async () => {
    const WITHDRAW = desire({ desire: 'WITHDRAW', target_candidate_id: 'c_0001', withdraw_kind: 'question_resolved', withdraw_reason: 'r', withdraw_evidence_span: 'もう解決しました', withdraw_evidence_segment_ids: [0] });
    const { monitor, sink, ledger } = makeStaged(script([NEW_D(), WITHDRAW, NEW_D()]));
    await feed(monitor, STABLE);
    await feed(monitor, `${STABLE}。もう解決しました`);
    expect(ledger.list()).toHaveLength(0);
    await feed(monitor, `${STABLE}。もう解決しました。やっぱり来週の水曜は難しいです`);
    expect(sink.ofType('initiative.desire').map((e) => e.outcome)).toEqual(['registered', 'withdrawn', 'registered']);
  });

  it('AI の発話が途中で切れた部分しかなければ棄却しない（言い終わっていない）', async () => {
    const { monitor, sink } = makeStaged(script([NEW_D()]), [ai('来週の水曜で')]);
    await feed(monitor, STABLE);
    expect(sink.ofType('initiative.desire')[0]).toMatchObject({ outcome: 'registered' });
  });

  it('基準が未設定なら比較しない', async () => {
    const { monitor, sink } = makeStaged(script([NEW_D()]), [ai(UTTERANCE)], { already_said_min_similarity: undefined } as never);
    await feed(monitor, STABLE);
    expect(sink.ofType('initiative.desire')[0]).toMatchObject({ outcome: 'registered' });
  });
});

describe('AI の発話を根拠にした撤回', () => {
  const WITHDRAW_AI = (partial: Record<string, unknown> = {}) =>
    desire({ desire: 'WITHDRAW', target_candidate_id: 'c_0001', withdraw_kind: 'already_said', withdraw_reason: 'AI が言った', withdraw_evidence_span: '本当に大丈夫なのか', withdraw_evidence_segment_ids: [], ...partial });

  it('直近の会話の AI の発話に逐語であれば撤回し、どちらの発話を根拠にしたかを記録する', async () => {
    const entries = [ai('来週の水曜で本当に大丈夫なのか、少し気になっています')];
    const { monitor, sink, ledger } = makeStaged(script([NEW_D('水曜でいいのか確かめたいのですが'), WITHDRAW_AI()]), entries);
    await feed(monitor, STABLE);
    await feed(monitor, `${STABLE}。その点は以上です`);
    const event = sink.ofType('initiative.desire')[1]!;
    expect(event).toMatchObject({ desire: 'WITHDRAW', outcome: 'withdrawn', withdraw_kind: { value: 'already_said' }, withdraw_evidence_source: { value: 'ai_utterance' } });
    expect(event.withdraw_evidence_segment_ids).toMatchObject({ value: null, null_reason: 'ai_utterance_evidence' });
    expect(ledger.list()).toHaveLength(0);
    const change = sink.ofType('candidate.state_changed').at(-1)!;
    expect(change).toMatchObject({ to: 'WITHDRAWN', cause_source: 'model_decision', decision: 'WITHDRAW', withdraw_kind: { value: 'already_said' }, withdraw_evidence_source: { value: 'ai_utterance' } });
    expect(ledger.getRecord('c_0001')?.withdraw).toMatchObject({ source: 'model_decision', evidence_source: 'ai_utterance' });
  });

  it('人の発話の逐語を根拠にしたときは user_utterance と記録する（従来どおり）', async () => {
    const { monitor, sink } = makeStaged(script([NEW_D('水曜でいいのか確かめたいのですが'), desire({ desire: 'WITHDRAW', target_candidate_id: 'c_0001', withdraw_kind: 'question_resolved', withdraw_reason: 'r', withdraw_evidence_span: 'もう解決しました', withdraw_evidence_segment_ids: [0] })]));
    await feed(monitor, STABLE);
    await feed(monitor, `${STABLE}。もう解決しました`);
    expect(sink.ofType('initiative.desire')[1]).toMatchObject({ outcome: 'withdrawn', withdraw_evidence_source: { value: 'user_utterance' } });
  });

  it('人の発話にも AI の発話にも逐語でなければ棄却して候補を残す', async () => {
    const { monitor, sink, ledger } = makeStaged(script([NEW_D('水曜でいいのか確かめたいのですが'), WITHDRAW_AI({ withdraw_evidence_span: '存在しない語句です' })]), [ai('別の話をしています')]);
    await feed(monitor, STABLE);
    await feed(monitor, `${STABLE}。その点は以上です`);
    const event = sink.ofType('initiative.desire')[1]!;
    expect(event.outcome).toBe('gate_rejected');
    expect(event.gate.value.reasons).toContain('withdraw_rejected:withdraw_evidence_not_in_ai_turns');
    expect(ledger.list()).toHaveLength(1);
  });

  it('LLM の申告に頼らず、E2a も AI の発話で照合し直す（G を通っても AI の発話になければ棄却）', async () => {
    const { monitor, ledger, sink, time } = makeStaged(script([NEW_D('水曜でいいのか確かめたいのですが')]));
    await feed(monitor, STABLE);
    const decide = (ai_turn_texts: string[]) =>
      ledger.applyModelDecision({
        decision: 'WITHDRAW',
        target: { candidate_id: 'c_0001', candidate_version: 1 },
        withdraw_evidence_span: '来週の水曜',
        withdraw_evidence_segment_ids: [],
        withdraw_reason: { source: 'model_output', value: 'r' },
        withdraw_kind: 'already_said',
        withdraw_evidence_ai_turns: ai_turn_texts,
        request_id: 'r',
        transcript_revision: 99,
        segment_id: 0,
        received_at: time.monotonicMs(),
        input_segments: [],
      });
    expect(decide(['別の話です'])).toMatchObject({ ok: false, reason: 'withdraw_evidence_invalid' });
    expect(sink.ofType('candidate.rejected').at(-1)).toMatchObject({ reason: 'withdraw_evidence_invalid', details: ['withdraw_evidence_not_in_ai_turns'] });
    expect(ledger.list()).toHaveLength(1);
    expect(decide(['来週の水曜の話でした'])).toMatchObject({ ok: true, to: 'WITHDRAWN', withdraw_evidence_segment_ids: null });
  });
});

describe('持ち越しの候補への KEEP（AI の発話の開始をまたぐ）', () => {
  it('持ち越しの候補への KEEP は AI の開始をまたいでも適用する（stale_segment にしない）', async () => {
    const gate = deferred<string>();
    let d = 0;
    const responder: Responder = (r) => (isTiming(r) ? timing() : d++ === 0 ? NEW_D() : gate.promise);
    const { monitor, ledger, sink, time } = makeStaged(responder);
    await feed(monitor, STABLE);
    ledger.onNormalResponseStarted(time.monotonicMs(), () => true);
    expect(ledger.list()[0]!.carried_over).toBeDefined();
    monitor.onStt(interim(`${STABLE}。それから別の点も気になっています`) as never);
    await new Promise((resolve) => setImmediate(resolve));
    ledger.onSegmentChanged(1, time.monotonicMs());
    gate.resolve(KEEP);
    await monitor.whenIdle();
    expect(sink.ofType('candidate.rejected').filter((e) => e.reason === 'stale_segment')).toHaveLength(0);
    expect(sink.ofType('initiative.desire')[1]).toMatchObject({ desire: 'KEEP', outcome: 'kept' });
    expect(ledger.getRecord('c_0001')?.last_request_id).toBe('ini_0002');
  });

  it('持ち越していない候補への KEEP は従来どおり AI の開始をまたぐと棄却する', async () => {
    const gate = deferred<string>();
    let d = 0;
    const responder: Responder = (r) => (isTiming(r) ? timing() : d++ === 0 ? NEW_D() : gate.promise);
    const { monitor, ledger, sink, time } = makeStaged(responder);
    await feed(monitor, STABLE);
    monitor.onStt(interim(`${STABLE}。それから別の点も気になっています`) as never);
    await new Promise((resolve) => setImmediate(resolve));
    ledger.onSegmentChanged(1, time.monotonicMs());
    gate.resolve(KEEP);
    await monitor.whenIdle();
    expect(sink.ofType('initiative.desire').at(-1)).toMatchObject({ desire: 'KEEP', outcome: 'rejected' });
  });
});
