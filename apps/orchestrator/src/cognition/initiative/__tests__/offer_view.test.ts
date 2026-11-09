/**
 * 申し出の状況の試験。観測のコードと、プロンプトへの載せ方と、ゲートだけを試す。LLM は台本で、モデルの判断は何も試していない。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { absent, present } from '@llm-vap/contracts';
import type { OfferView } from '@llm-vap/contracts';
import { parseConversationKindProfile } from '../conversation_kind';
import { OfferObservations } from '../offer_view';
import type { PromptCandidate } from '../prompt';
import {
  CURRENT_DESIRE_PROMPT_VERSION,
  CURRENT_TIMING_PROMPT_VERSION,
  DESIRE_PROMPTS,
  TIMING_PROMPTS,
  getDesirePrompt,
  offerStatusText,
} from '../staged_prompt';
import type { StagedOptions } from '../staged';
import { interim, makeMonitor } from './helpers';
import type { Responder } from './helpers';

const repoRoot = join(import.meta.dirname, '..', '..', '..', '..', '..', '..');
const PROFILE = parseConversationKindProfile(JSON.parse(readFileSync(join(repoRoot, 'config', 'conversation_kind.joint_thinking.ja.json'), 'utf8')));

const view = (presentation: OfferView['presentation'], follow_up: OfferView['follow_up'], elapsed = 1.25): OfferView => ({
  presentation,
  cue_id: presentation === 'not_presented' ? absent('no_cue_sent') : present('cue_0001'),
  elapsed_s: presentation === 'not_presented' ? absent('no_cue_sent') : present(elapsed),
  follow_up,
});

const candidate = (offer?: OfferView): PromptCandidate => ({
  candidate_id: 'c_0001',
  candidate_version: 1,
  intent_type: 'QUESTION',
  evidence_span: '来週の水曜',
  proposed_utterance: '水曜で大丈夫ですか',
  ...(offer ? { offer } : {}),
});

const userText = (version: string, offer?: OfferView): string =>
  getDesirePrompt(version).messages({ segments: [], candidates: [candidate(offer)], recent_turns: [] })[0]!.text;

const tick = (now: number, partial: { user_speaking?: boolean; ai_speaking?: boolean; invitation_detected?: boolean } = {}) => ({
  now,
  user_speaking: false,
  ai_speaking: false,
  invitation_detected: false,
  live_candidate_ids: new Set(['c_0001']),
  ...partial,
});

const sent = (offers: OfferObservations, invitation_detected = false) =>
  offers.noteSent({ cue_id: 'cue_0001', candidate_id: 'c_0001', at: 1000, invitation_detected });

describe('申し出の欄', () => {
  it.each([
    [view('presented', 'kept_talking'), '吸気の合図を見せた（1.3 秒前）、その後: 人は話している'],
    [view('presented', 'stopped'), '吸気の合図を見せた（1.3 秒前）、その後: 人は今話していない'],
    [view('presented', 'invited'), '吸気の合図を見せた（1.3 秒前）、その後: 人が AI に話を促す語句を言った'],
    [view('presented', 'unknown'), '吸気の合図を見せた（1.3 秒前）、その後: まだ分からない'],
    [view('sent_unconfirmed', 'unknown'), '吸気の合図を送った（表示の報告はまだない）（1.3 秒前）、その後: まだ分からない'],
  ])('状況ごとの文（%#）', (offer, expected) => {
    expect(offerStatusText(offer)).toBe(expected);
    expect(userText('initiative-desire-ja-v4', offer)).toContain(`／申し出: ${expected}`);
  });

  it('合図を見せていないときは、見せていないとだけ書く（経過時間も振る舞いも書かない）', () => {
    const text = userText('initiative-desire-ja-v4', new OfferObservations().view('c_0001', 5000));
    expect(text).toContain('／申し出: 合図は見せていない');
    expect(text).not.toContain('秒前');
    expect(text).not.toContain('その後');
  });
});

describe('観測（送信の経路の事実だけ）', () => {
  it('送っていない候補は not_presented（initiative_no_cue と reactive はここを通らない）', () => {
    expect(new OfferObservations().view('c_0001', 5000)).toMatchObject({ presentation: 'not_presented', follow_up: 'unknown', elapsed_s: { value: null } });
  });

  it('送っただけなら presented にしない。描いた報告で presented になり、描かれた時刻から数える', () => {
    const offers = new OfferObservations();
    sent(offers);
    expect(offers.view('c_0001', 1500)).toMatchObject({ presentation: 'sent_unconfirmed', elapsed_s: { value: 0.5 } });
    offers.noteReport('c_0001', 'cue_0001', { visible: true, started_at: 1200 });
    expect(offers.view('c_0001', 3200)).toMatchObject({ presentation: 'presented', elapsed_s: { value: 2 } });
  });

  it('描かれなかった報告は not_presented。別の合図の報告は無視する', () => {
    const offers = new OfferObservations();
    sent(offers);
    offers.noteReport('c_0001', 'cue_0009', { visible: true, started_at: 1200 });
    expect(offers.view('c_0001', 1500).presentation).toBe('sent_unconfirmed');
    offers.noteReport('c_0001', 'cue_0001', { visible: false });
    expect(offers.view('c_0001', 1500)).toMatchObject({ presentation: 'not_presented', follow_up: 'unknown', cue_id: { value: 'cue_0001' }, elapsed_s: { value: null } });
  });

  it('振る舞いは合図より後の tick の最新の値。描かれる前の振る舞いは数えない', () => {
    const offers = new OfferObservations();
    sent(offers);
    offers.observe(tick(1000, { user_speaking: true }));
    expect(offers.view('c_0001', 1000).follow_up).toBe('unknown');
    offers.observe(tick(1040, { user_speaking: true }));
    expect(offers.view('c_0001', 1040).follow_up).toBe('kept_talking');
    offers.noteReport('c_0001', 'cue_0001', { visible: true, started_at: 1100 });
    expect(offers.view('c_0001', 1100).follow_up).toBe('unknown');
    offers.observe(tick(1100, { user_speaking: true }));
    expect(offers.view('c_0001', 1100).follow_up).toBe('unknown');
    offers.observe(tick(1200, { user_speaking: true }));
    expect(offers.view('c_0001', 1200).follow_up).toBe('kept_talking');
    offers.observe(tick(1300));
    expect(offers.view('c_0001', 1300).follow_up).toBe('stopped');
    offers.observe(tick(1400, { user_speaking: true }));
    expect(offers.view('c_0001', 1400).follow_up).toBe('kept_talking');
  });

  it('招待は合図の後に現れたものだけを invited にする', () => {
    const before = new OfferObservations();
    sent(before, true);
    before.observe(tick(1100, { invitation_detected: true }));
    expect(before.view('c_0001', 1100).follow_up).toBe('stopped');
    before.observe(tick(1200));
    before.observe(tick(1300, { invitation_detected: true }));
    expect(before.view('c_0001', 1300).follow_up).toBe('invited');

    const after = new OfferObservations();
    sent(after);
    after.observe(tick(1100, { invitation_detected: true, user_speaking: true }));
    expect(after.view('c_0001', 1100).follow_up).toBe('invited');
  });

  it('AI の発話中は振る舞いを更新しない。解決した候補の記録は捨てる', () => {
    const offers = new OfferObservations();
    sent(offers);
    offers.observe(tick(1100));
    offers.observe(tick(1200, { user_speaking: true, ai_speaking: true }));
    expect(offers.view('c_0001', 1200).follow_up).toBe('stopped');
    offers.observe({ ...tick(1300), live_candidate_ids: new Set() });
    expect(offers.view('c_0001', 1300).presentation).toBe('not_presented');
  });
});

describe('プロンプトの版', () => {
  it('現在の版は v4。古い版は選べて、申し出の状況を載せない', () => {
    expect(CURRENT_DESIRE_PROMPT_VERSION).toBe('initiative-desire-ja-v4');
    expect(CURRENT_TIMING_PROMPT_VERSION).toBe('initiative-timing-ja-v2');
    expect(Object.keys(DESIRE_PROMPTS)).toEqual(['initiative-desire-ja-v1', 'initiative-desire-ja-v2', 'initiative-desire-ja-v3', 'initiative-desire-ja-v4']);
    for (const version of ['initiative-desire-ja-v1', 'initiative-desire-ja-v2', 'initiative-desire-ja-v3']) {
      expect(getDesirePrompt(version).shows_offer).toBe(false);
      expect(getDesirePrompt(version).system(PROFILE)).not.toContain('申し出の状況');
      expect(userText(version, view('presented', 'kept_talking'))).not.toContain('申し出:');
    }
    for (const prompt of Object.values(TIMING_PROMPTS)) expect(prompt.shows_offer).toBe(false);
  });

  it('v4 は読み方の規則だけを足す（それ以外は v3 と同じ。NEW の説明も変えない）', () => {
    const v3 = getDesirePrompt('initiative-desire-ja-v3').system(PROFILE);
    const v4 = getDesirePrompt('initiative-desire-ja-v4').system(PROFILE);
    const section = v4.slice(v4.indexOf('\n\n# 申し出の状況'), v4.indexOf('\n\n# 書き方の決まり'));
    expect(v4.replace(section, '')).toBe(v3);
    expect(section).toContain('人が話し続けていることは、拒否でも関心のなさでもない。人は合図を見ていないかもしれず、合図に応える義務もない。');
    expect(section).toContain('KEEP／REVISE／WITHDRAW は、人が実際に話した内容に基づいて選ぶ。合図の有無や人の振る舞いだけを理由に REVISE や WITHDRAW を選ばない。');
    expect(section).not.toContain('NEW');
  });
});

const STABLE = '予定は来週の水曜に変えました';
const LATER = `${STABLE}。そのあと店長に確認してもらいました`;

function desire(partial: Record<string, unknown>): string {
  return JSON.stringify({ reason: '', desire: 'NONE', target_candidate_id: '', intent_type: '', proposed_utterance: '', evidence_span: '', evidence_segment_ids: [], prior_turn_evidence_span: '', ...partial });
}
const NEW = desire({ desire: 'NEW', reason: 'r', intent_type: 'QUESTION', proposed_utterance: '水曜で大丈夫ですか', evidence_span: '来週の水曜', evidence_segment_ids: [0] });
const TIMING = JSON.stringify({ reason: 'r', why_now: '', cost_of_waiting: '', timing: 'WAIT_FOR_TURN_END', target_candidate_id: 'c_0001', withdraw_reason: '', withdraw_evidence_span: '', withdraw_evidence_segment_ids: [] });

function run(second: string, staged: Partial<StagedOptions> = {}) {
  const offers = new OfferObservations();
  sent(offers);
  offers.noteReport('c_0001', 'cue_0001', { visible: true, started_at: 1000 });
  offers.observe(tick(1100, { user_speaking: true }));
  const script: Responder = (r, i) => (r.request_id.endsWith('_timing') ? TIMING : i === 0 ? NEW : second);
  const options: StagedOptions = { timing_strategy: 'llm', profile: PROFILE, recent_context: { max_turns: 4, max_chars_per_turn: 200 }, offers, ...staged };
  return makeMonitor(script, { staged: options } as never);
}

async function feedTwice(rig: ReturnType<typeof run>): Promise<void> {
  rig.monitor.onStt(interim(STABLE) as never);
  await rig.monitor.whenIdle();
  rig.monitor.onStt(interim(LATER) as never);
  await rig.monitor.whenIdle();
}

describe('ゲート', () => {
  it.each([
    ['振る舞いの文を根拠として書いた', '人は話している', [0]],
    ['合図の欄の文を根拠として書いた', '吸気の合図を見せた', [0]],
    ['根拠が空', '', []],
  ])('反応だけの WITHDRAW は棄却され、候補は残る（%s）', async (_name, span, ids) => {
    const rig = run(desire({ desire: 'WITHDRAW', target_candidate_id: 'c_0001', withdraw_kind: 'topic_moved', withdraw_reason: '人が話し続けている', withdraw_evidence_span: span, withdraw_evidence_segment_ids: ids }));
    await feedTwice(rig);
    const event = rig.sink.ofType('initiative.desire')[1]!;
    expect(event).toMatchObject({ desire: 'WITHDRAW', outcome: 'gate_rejected' });
    expect(rig.ledger.list()).toHaveLength(1);
    expect(rig.ledger.list()[0]!.state).toBe('INTENT_READY');
    expect(rig.llm.requests[2]!.messages[0]!.text).toContain('／申し出: 吸気の合図を見せた');
  });

  it('判定に渡した申し出の状況を initiative.desire に残す', async () => {
    const rig = run(desire({ desire: 'KEEP', target_candidate_id: 'c_0001' }));
    await feedTwice(rig);
    const [first, second] = rig.sink.ofType('initiative.desire');
    expect(first!.offer_views).toEqual({ value: [] });
    expect(second!.offer_views).toMatchObject({ value: [{ candidate_id: 'c_0001', candidate_version: 1, presentation: 'presented', follow_up: 'kept_talking', cue_id: { value: 'cue_0001' } }] });
  });

  it('載せない版は null と理由を残す', async () => {
    const rig = run(desire({ desire: 'KEEP', target_candidate_id: 'c_0001' }), { desire_prompt_version: 'initiative-desire-ja-v3' });
    await feedTwice(rig);
    expect(rig.sink.ofType('initiative.desire')[1]!.offer_views).toEqual({ value: null, null_reason: 'prompt_version_does_not_show_offer' });
    expect(rig.llm.requests[2]!.messages[0]!.text).not.toContain('申し出:');
  });
});
