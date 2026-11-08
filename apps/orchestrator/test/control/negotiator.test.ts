/**
 * 発話希望の交渉（control/negotiator.ts）の表の試験。E2 の合図のゲート、吸気〜DEFERRED の流れ、E3 の選択の全経路。
 * 純粋関数だけを試す（LLM、TTS、VAP は使わない）。モデルの判断の良し悪しは何も試していない。
 */
import { describe, expect, it } from 'vitest';
import type { CandidateState, Condition, Invitation } from '@llm-vap/contracts';
import {
  detectDirectQuestion,
  initialNegotiatorState,
  negotiate,
  reasonKey,
  releaseForSpeech,
  selectSpeech,
  signalGate,
} from '../../src/control/negotiator';
import type { CandidateView, NegotiatorSettings, NegotiatorState, NegotiatorTickInputs } from '../../src/control/negotiator';

const settings = (condition: Condition, patch: Partial<NegotiatorSettings> = {}): NegotiatorSettings => ({
  condition,
  inhale_ms: 450,
  hold_max_ms: 1000,
  signal_cooldown_ms: 4000,
  max_active_candidates: 1,
  max_new_stable_chars_since_judgement: 60,
  cue_max_judgement_age_ms: 8000,
  ...patch,
});

const view = (patch: Partial<CandidateView> = {}): CandidateView => ({
  candidate_id: 'c_0001',
  candidate_version: 1,
  state: 'INTENT_READY',
  judged_at: 1000,
  new_chars_since_judgement: 0,
  audio: 'ready',
  ...patch,
});

const tick = (patch: Partial<NegotiatorTickInputs> = {}): NegotiatorTickInputs => ({
  now: 1100,
  candidates: [view()],
  ai_speaking: false,
  avatar_available: true,
  user_speaking: true,
  ...patch,
});

const NO_INVITATION: Invitation = { detected: false };
const invitation = (kind: 'go_ahead' | 'direct_question' | 'other', phrase: string): Invitation => ({
  detected: true,
  kind,
  phrase,
  segment_id: 0,
  transcript_revision: 1,
});

describe('E2 合図のゲート（signalGate）', () => {
  const cases: { name: string; condition: Condition; state?: Partial<NegotiatorState>; inputs?: Partial<NegotiatorTickInputs>; candidate?: Partial<CandidateView>; patch?: Partial<NegotiatorSettings>; outcome: string; reasons: string[] }[] = [
    { name: '全部満たせば合図する', condition: 'initiative_inhale', outcome: 'cue', reasons: ['judgement_fresh', 'ai_silent', 'avatar_available', 'cooldown_passed', 'single_active_candidate', 'candidate_audio_ready'] },
    { name: 'reactive は合図しない（記録だけ）', condition: 'reactive', outcome: 'no_cue_condition', reasons: ['condition:reactive'] },
    { name: 'initiative_no_cue は合図しない（吸気を経ない）', condition: 'initiative_no_cue', outcome: 'no_cue_condition', reasons: ['condition:initiative_no_cue'] },
    { name: 'AI が話している', condition: 'initiative_inhale', inputs: { ai_speaking: true }, outcome: 'blocked', reasons: ['ai_speaking'] },
    { name: 'アバターを描けない（切断中）', condition: 'initiative_inhale', inputs: { avatar_available: false }, outcome: 'blocked', reasons: ['avatar_unavailable'] },
    { name: '冷却時間の中', condition: 'initiative_inhale', state: { last_cue_at: 0 }, outcome: 'blocked', reasons: ['cooldown_remaining_ms=2900'] },
    { name: '冷却時間ちょうどで超過', condition: 'initiative_inhale', state: { last_cue_at: -2900 }, outcome: 'cue', reasons: ['judgement_fresh', 'ai_silent', 'avatar_available', 'cooldown_passed', 'single_active_candidate', 'candidate_audio_ready'] },
    { name: '冷却時間が未校正（null）', condition: 'initiative_inhale', patch: { signal_cooldown_ms: null }, outcome: 'blocked', reasons: ['signal_cooldown_uncalibrated'] },
    { name: '判定の後に安定文字が増えすぎた（古い）', condition: 'initiative_inhale', candidate: { new_chars_since_judgement: 61 }, outcome: 'blocked', reasons: ['judgement_stale:chars=61'] },
    { name: '判定の入力が分からない', condition: 'initiative_inhale', candidate: { new_chars_since_judgement: null }, outcome: 'blocked', reasons: ['judgement_input_unknown'] },
    { name: '判定から時間が経ちすぎた', condition: 'initiative_inhale', inputs: { now: 9001 }, outcome: 'blocked', reasons: ['judgement_old:age_ms=8001'] },
    { name: '候補の音声がまだ', condition: 'initiative_inhale', candidate: { audio: 'preparing' }, outcome: 'blocked', reasons: ['candidate_audio_preparing'] },
    { name: '候補の音声を作れなかった', condition: 'initiative_inhale', candidate: { audio: 'failed' }, outcome: 'blocked', reasons: ['candidate_audio_failed'] },
    {
      name: '活動中の候補が2つ',
      condition: 'initiative_inhale',
      inputs: { candidates: [view(), view({ candidate_id: 'c_0002', state: 'DEFERRED' })] },
      outcome: 'blocked',
      reasons: ['active_candidates=2'],
    },
    { name: '別の合図の途中', condition: 'initiative_inhale', state: { cue: { cue_id: 'cue_0009', candidate_id: 'c_0009', candidate_version: 1, started_at: 0, inhale_ends_at: 450, hold_started_at: null } }, outcome: 'blocked', reasons: ['cue_in_progress'] },
  ];
  it.each(cases)('$name', ({ condition, state, inputs, candidate, patch, outcome, reasons }) => {
    const s = { ...initialNegotiatorState(), ...state };
    const i = tick({ ...inputs, ...(candidate ? { candidates: [view(candidate)] } : {}) });
    const gate = signalGate(settings(condition, patch), s, i, i.candidates[0] as CandidateView);
    expect(gate.outcome).toBe(outcome);
    expect(gate.reasons).toEqual(reasons);
  });
});

/** 状態を受け取った候補の状態で tick を回す（E2a の遷移は呼び手の役。ここでは結果を写す）。 */
function run(
  condition: Condition,
  frames: { now: number; state: CandidateState | null; user_speaking?: boolean; ai_speaking?: boolean }[],
) {
  let state = initialNegotiatorState();
  const log: { now: number; actions: string[]; hold: string | null; gate: string | null }[] = [];
  for (const f of frames) {
    const candidates = f.state === null ? [] : [view({ state: f.state, judged_at: f.now - 100 })];
    const step = negotiate(settings(condition), state, tick({ now: f.now, candidates, user_speaking: f.user_speaking ?? true, ai_speaking: f.ai_speaking ?? false }));
    state = step.state;
    log.push({
      now: f.now,
      actions: step.actions.map((a) => (a.kind === 'release' ? `release:${a.reason}` : a.kind)),
      hold: step.hold_start,
      gate: step.gate?.outcome ?? null,
    });
  }
  return { state, log };
}

describe('E2 吸気から DEFERRED まで（negotiate）', () => {
  it('initiative_inhale: 合図 → 吸気中は開始を保留 → 吸気の完了（orchestrator の時計）→ 人が話し続けたら DEFERRED と脱力', () => {
    const { log, state } = run('initiative_inhale', [
      { now: 1000, state: 'INTENT_READY' },
      { now: 1200, state: 'BREATH_INHALE' },
      { now: 1450, state: 'BREATH_INHALE' },
      { now: 1460, state: 'BREATH_HOLD_OR_READY' },
      { now: 2449, state: 'BREATH_HOLD_OR_READY' },
      { now: 2450, state: 'BREATH_HOLD_OR_READY' },
      { now: 2470, state: 'DEFERRED' },
    ]);
    expect(log.map((l) => l.actions)).toEqual([['cue'], [], ['inhale_completed'], [], [], ['defer', 'release:deferred'], []]);
    expect(log.map((l) => l.hold !== null)).toEqual([true, true, false, false, false, false, false]);
    expect(state.cue).toBeNull();
    expect(state.last_cue_at).toBe(1000);
  });

  it('準備姿勢の間に人が黙っていれば DEFERRED にせず、許可を待つ（話し始めたらその時点で DEFERRED）', () => {
    const { log } = run('initiative_inhale', [
      { now: 1000, state: 'INTENT_READY', user_speaking: false },
      { now: 1450, state: 'BREATH_INHALE', user_speaking: false },
      { now: 3000, state: 'BREATH_HOLD_OR_READY', user_speaking: false },
      { now: 3020, state: 'BREATH_HOLD_OR_READY', user_speaking: true },
    ]);
    expect(log.map((l) => l.actions)).toEqual([['cue'], ['inhale_completed'], [], ['defer', 'release:deferred']]);
  });

  it('吸気は候補につき1回。DEFERRED から再吸気しない', () => {
    const { log } = run('initiative_inhale', [
      { now: 1000, state: 'INTENT_READY' },
      { now: 1450, state: 'BREATH_INHALE' },
      { now: 2450, state: 'BREATH_HOLD_OR_READY' },
      { now: 9000, state: 'DEFERRED' },
      { now: 20000, state: 'DEFERRED' },
    ]);
    expect(log.flatMap((l) => l.actions).filter((a) => a === 'cue')).toHaveLength(1);
  });

  it('吸気中に撤回されたら脱力（withdrawn）し、保留を解く。AI が話し始めていたら speech_started', () => {
    const withdrawn = run('initiative_inhale', [
      { now: 1000, state: 'INTENT_READY' },
      { now: 1100, state: null },
    ]);
    expect(withdrawn.log[1]).toMatchObject({ actions: ['release:withdrawn'], hold: null });
    const byNormal = run('initiative_inhale', [
      { now: 1000, state: 'INTENT_READY' },
      { now: 1450, state: 'BREATH_INHALE' },
      { now: 1600, state: null, ai_speaking: true },
    ]);
    expect(byNormal.log[2]?.actions).toEqual(['release:speech_started']);
  });

  it('合図の後の次の候補は冷却時間を待つ', () => {
    const { log } = run('initiative_inhale', [
      { now: 1000, state: 'INTENT_READY' },
      { now: 1100, state: null },
      { now: 2000, state: 'INTENT_READY' },
      { now: 5000, state: 'INTENT_READY' },
    ]);
    expect(log.map((l) => l.gate)).toEqual(['cue', null, 'blocked', 'cue']);
  });

  it.each(['reactive', 'initiative_no_cue'] as const)('%s は合図せず、開始も保留しない', (condition) => {
    const { log } = run(condition, [
      { now: 1000, state: 'INTENT_READY' },
      { now: 3000, state: 'INTENT_READY' },
    ]);
    expect(log.flatMap((l) => l.actions)).toEqual([]);
    expect(log.every((l) => l.hold === null && l.gate === 'no_cue_condition')).toBe(true);
  });

  it('候補の発話を始めたら合図を解く（speech_started）', () => {
    const { state } = run('initiative_inhale', [
      { now: 1000, state: 'INTENT_READY' },
      { now: 1450, state: 'BREATH_INHALE' },
    ]);
    const released = releaseForSpeech(state, 'c_0001');
    expect(released.action).toMatchObject({ kind: 'release', reason: 'speech_started', cue_id: 'cue_0001' });
    expect(released.state.cue).toBeNull();
    expect(releaseForSpeech(state, 'c_9999').action).toBeNull();
  });
});

describe('E3 発話の選択（selectSpeech）', () => {
  const cases: {
    name: string;
    condition: Condition;
    candidate: Partial<CandidateView> | null;
    permitted?: boolean;
    invitation?: Invitation;
    text?: string | null;
    choice: string;
    reasons: string[];
    cause?: string | null;
  }[] = [
    { name: '許可がなければ何もしない', condition: 'initiative_inhale', candidate: {}, permitted: false, choice: 'none', reasons: ['not_permitted'] },
    { name: 'reactive は候補があっても通常応答', condition: 'reactive', candidate: { state: 'INTENT_READY' }, choice: 'response', reasons: ['condition:reactive'] },
    { name: '候補なし', condition: 'initiative_inhale', candidate: null, choice: 'response', reasons: ['no_active_candidate'] },
    // initiative_inhale
    { name: 'inhale: 保持中に許可 → 候補', condition: 'initiative_inhale', candidate: { state: 'BREATH_HOLD_OR_READY' }, choice: 'candidate', reasons: ['natural_yield', 'from:BREATH_HOLD_OR_READY'], cause: 'turn_allowed' },
    { name: 'inhale: DEFERRED から許可 → 候補（再吸気しない）', condition: 'initiative_inhale', candidate: { state: 'DEFERRED' }, choice: 'candidate', reasons: ['natural_yield', 'from:DEFERRED'], cause: 'turn_allowed' },
    { name: 'inhale: 吸気中に許可 → 待つ（吸気を終えてから）', condition: 'initiative_inhale', candidate: { state: 'BREATH_INHALE' }, choice: 'wait', reasons: ['inhale_in_progress'] },
    { name: 'inhale: 合図していない候補は話さない', condition: 'initiative_inhale', candidate: { state: 'INTENT_READY' }, choice: 'response', reasons: ['not_cued'] },
    { name: 'inhale: 「どうぞ」なら候補（原因は invitation）', condition: 'initiative_inhale', candidate: { state: 'DEFERRED' }, invitation: invitation('go_ahead', 'どうぞ'), choice: 'candidate', reasons: ['invitation:どうぞ', 'from:DEFERRED'], cause: 'invitation' },
    // initiative_no_cue
    { name: 'no_cue: INTENT_READY のまま許可 → 候補', condition: 'initiative_no_cue', candidate: { state: 'INTENT_READY' }, choice: 'candidate', reasons: ['natural_yield', 'from:INTENT_READY'], cause: 'turn_allowed' },
    { name: 'no_cue: 吸気の状態は話さない（来ないはずの状態）', condition: 'initiative_no_cue', candidate: { state: 'DEFERRED' }, choice: 'response', reasons: ['state_not_speakable:DEFERRED'] },
    // 共通の除外
    { name: '直前が直接の質問（招待の検出）→ 通常応答', condition: 'initiative_inhale', candidate: { state: 'DEFERRED' }, invitation: invitation('direct_question', 'どう思いますか'), choice: 'response', reasons: ['direct_question:invitation:どう思いますか'] },
    { name: '直前が直接の質問（文末の規則）→ 通常応答', condition: 'initiative_no_cue', candidate: { state: 'INTENT_READY' }, text: '明日は晴れるんですか', choice: 'response', reasons: ['direct_question:rule:desuka'] },
    { name: '判定が古い → 通常応答', condition: 'initiative_no_cue', candidate: { new_chars_since_judgement: 61 }, choice: 'response', reasons: ['judgement_stale:chars=61'] },
    { name: '判定の入力が分からない → 通常応答', condition: 'initiative_no_cue', candidate: { new_chars_since_judgement: null }, choice: 'response', reasons: ['judgement_input_unknown'] },
    { name: '音声がまだ → 通常応答', condition: 'initiative_inhale', candidate: { state: 'DEFERRED', audio: 'preparing' }, choice: 'response', reasons: ['candidate_audio_preparing'] },
    { name: '候補を話している最中', condition: 'initiative_inhale', candidate: { state: 'SPEAKING' }, choice: 'wait', reasons: ['candidate_speaking'] },
  ];
  it.each(cases)('$name', ({ condition, candidate, permitted, invitation: inv, text, choice, reasons, cause }) => {
    const result = selectSpeech(settings(condition), {
      candidate: candidate === null ? null : view(candidate),
      permitted: permitted ?? true,
      invitation: inv ?? NO_INVITATION,
      user_text: text ?? '今日は少し長めに話します',
    });
    expect(result.choice).toBe(choice);
    expect(result.reasons).toEqual(reasons);
    if (cause !== undefined) expect(result.cause).toBe(cause);
  });
});

describe('直接の質問の簡単な規則', () => {
  it.each([
    ['明日は晴れるんですか', 'rule:desuka'],
    ['それって本当にいいのかな', 'rule:kana'],
    ['それってなんですか。', 'rule:desuka'],
    ['どうして', 'rule:dou'],
    ['昨日は雨でした', null],
    ['そうなんです', null],
  ])('%s → %s', (text, expected) => {
    expect(detectDirectQuestion(NO_INVITATION, text)).toBe(expected);
  });
  it('理由の鍵は数値を除く（tick ごとに同じ判断を記録しない）', () => {
    expect(reasonKey(['cooldown_remaining_ms=10', 'judgement_stale:chars=70'])).toBe(reasonKey(['cooldown_remaining_ms=20', 'judgement_stale:chars=80']));
  });
});
