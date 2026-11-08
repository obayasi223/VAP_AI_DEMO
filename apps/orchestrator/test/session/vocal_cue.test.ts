/**
 * 吸気の後の短い声（別モード）を、Session、ledger、negotiator、ブラウザへのメッセージ、イベントの全部を通して固定する。
 * LLM、TTS、STT は台本、VAP は偽の値。短い声の自然さ、実音声での切れ目の妥当性は何も試していない。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { LlmRequest, NodeToBrowser, VocalCueMode } from '@llm-vap/contracts';
import { TIMING_JSON_SCHEMA } from '../../src/cognition/initiative';
import { judgeVocalCue, vocalCueSettings } from '../../src/control/vocal_cue';
import type { VocalCueGateInputs } from '../../src/control/vocal_cue';
import type { Rig } from './helpers';
import { createRig, ended, productionJaPolicy, started, warmUp } from './helpers';

let rig: Rig | null = null;
afterEach(async () => {
  if (rig) {
    expect(rig.session.counters.tick_errors).toBe(0);
    await rig.session.close('test_done');
  }
  rig = null;
});

const STABLE = '来月の展示会の予算は五十万円のままで進めようと思っています';
const MORE = `${STABLE}。でも来週は中止になりました`;
const UTTERANCE = '確認させてください';
const REPLY = 'はい、承知しました。';
const A = 'あ、';
const UN = 'うん';

type Step = { p: [number, number, boolean]; loud?: boolean };
const SPEAKING: Step = { p: [0.1, 0.1, true], loud: true };
const YIELD: Step = { p: [0.9, 0.9, false] };
/** 人が黙るが、VAP は AI 側を支持しない（許可が出ない切れ目）。 */
const PAUSE: Step = { p: [0.3, 0.3, false] };

type Say = 'NEW' | 'WITHDRAW';
const desireReply = (say: Say | undefined): string => {
  const base = {
    reason: 'r',
    desire: 'NONE',
    target_candidate_id: '',
    intent_type: '',
    proposed_utterance: '',
    evidence_span: '',
    evidence_segment_ids: [] as number[],
    prior_turn_evidence_span: '',
    withdraw_kind: '',
    withdraw_reason: '',
    withdraw_evidence_span: '',
    withdraw_evidence_segment_ids: [] as number[],
  };
  if (say === 'NEW') return JSON.stringify({ ...base, desire: 'NEW', intent_type: 'CLARIFICATION', proposed_utterance: UTTERANCE, evidence_span: '五十万円', evidence_segment_ids: [0] });
  if (say === 'WITHDRAW') return JSON.stringify({ ...base, desire: 'WITHDRAW', target_candidate_id: 'c_0001', withdraw_kind: 'premise_changed', withdraw_reason: '前提が変わった', withdraw_evidence_span: '来週は中止', withdraw_evidence_segment_ids: [0] });
  return JSON.stringify(base);
};
const timingReply = JSON.stringify({ reason: 'r', why_now: '', cost_of_waiting: '', timing: 'OFFER_NOW', target_candidate_id: 'c_0001', withdraw_reason: '', withdraw_evidence_span: '', withdraw_evidence_segment_ids: [] });
const isTiming = (request: LlmRequest) => request.response_json_schema === TIMING_JSON_SCHEMA;

async function setup(mode: 'llm' | 'immediate', says: Say[], vocal_cue?: VocalCueMode): Promise<Rig> {
  let n = 0;
  const r = await createRig({
    condition: 'initiative_inhale',
    policy: productionJaPolicy(),
    reply: REPLY,
    initiative: {
      staged: { timing_strategy: mode, ...(vocal_cue === undefined ? {} : { vocal_cue }) },
      responder: (request) => (isTiming(request) ? timingReply : desireReply(says[n++])),
    },
  });
  await warmUp(r);
  return r;
}

async function speak(r: Rig, text = STABLE): Promise<void> {
  r.stt().deliver({ kind: 'interim', text, stable_text: text, audio_frame_end: r.frame });
  await r.steps(3, SPEAKING);
}

const msgs = <T extends NodeToBrowser['type']>(r: Rig, type: T) => r.link.of(type);
const stateOf = (r: Rig) => r.session.candidates?.list({ include_resolved: true })[0]?.state ?? null;
const states = (r: Rig) => r.events.ofType('candidate.state_changed').map((e) => `${e.from ?? 'null'}->${e.to}:${e.cause_source === 'code' ? e.cause : e.decision}`);
const beginsOf = (r: Rig, text: string) => {
  const ids = new Set(r.tts().contexts.filter((c) => c.sent.join('') === text).map((c) => c.audio_playback_id));
  return msgs(r, 'playback.begin').filter((b) => ids.has(b.audio_playback_id));
};
async function until(r: Rig, condition: () => boolean, step: Step = YIELD, max = 400): Promise<boolean> {
  for (let i = 0; i < max && !condition(); i++) await r.step(step);
  return condition();
}
const cueEvents = (r: Rig) => r.events.ofType('initiative.vocal_cue');

async function toDeferred(r: Rig): Promise<void> {
  await speak(r);
  expect(await until(r, () => stateOf(r) === 'DEFERRED', SPEAKING)).toBe(true);
  await r.steps(5, SPEAKING);
}

/** 延期の後の切れ目で声が始まるまで進める。 */
async function toCue(r: Rig, text: string): Promise<{ audio_playback_id: number; generation: number }> {
  expect(await until(r, () => beginsOf(r, text).length > 0, PAUSE, 100)).toBe(true);
  return beginsOf(r, text)[0]!;
}

describe.each(['llm', 'immediate'] as const)('吸気の後の短い声（%s）', (mode) => {
  describe('none（既定）', () => {
    it.each([[undefined], ['none']] as const)('vocal_cue=%s は声を作らず、記録も持たない', async (value) => {
      rig = await setup(mode, ['NEW'], value);
      await toDeferred(rig);
      await rig.steps(40, PAUSE);
      expect(rig.tts().contexts.filter((c) => [A, UN].includes(c.sent.join('')))).toEqual([]);
      expect(cueEvents(rig)).toEqual([]);
      expect(rig.events.ofType('speech.started').filter((e) => e.origin === 'vocal_cue')).toEqual([]);
    });

    it('指定なしと none で、延期から発話までの遷移と開始の時刻が同じ', async () => {
      const run = async (value?: VocalCueMode) => {
        const r = await setup(mode, ['NEW'], value);
        await toDeferred(r);
        expect(await until(r, () => beginsOf(r, UTTERANCE).length > 0)).toBe(true);
        const result = { states: states(r), at: r.time.monotonicMs(), begins: msgs(r, 'playback.begin').length, prepare: msgs(r, 'breath.prepare') };
        await r.session.close('test_done');
        return result;
      };
      expect(await run('none')).toEqual(await run());
    });
  });

  describe('pre_beginning', () => {
    it('切れ目で「あ、」を鳴らし、譲られたら再吸気せずに候補を話す。声は履歴に入らない', async () => {
      rig = await setup(mode, ['NEW'], 'pre_beginning');
      await toDeferred(rig);
      expect(msgs(rig, 'playback.begin')).toEqual([]);
      const begin = await toCue(rig, A);
      expect(stateOf(rig)).toBe('DEFERRED');
      rig.browser(started(begin));
      await rig.steps(5, YIELD);
      rig.browser(ended(begin, 'completed', 4000));
      await rig.steps(2, YIELD);
      expect(stateOf(rig)).toBe('DEFERRED');
      expect(await until(rig, () => beginsOf(rig!, UTTERANCE).length > 0)).toBe(true);
      expect(states(rig).slice(-2)).toEqual(['BREATH_HOLD_OR_READY->DEFERRED:user_continued', 'DEFERRED->SPEAKING:turn_allowed']);
      expect(msgs(rig, 'breath.cue')).toHaveLength(1);
      expect(msgs(rig, 'breath.prepare')).toEqual([{ type: 'breath.prepare', candidate_id: 'c_0001' }]);
      await rig.steps(2, YIELD);
      expect(cueEvents(rig)).toHaveLength(1);
      const cue = cueEvents(rig)[0]!;
      expect(cue).toMatchObject({ vocal_cue_kind: 'pre_beginning', phrase: A, candidate_id: 'c_0001', candidate_version: 1, cue_id: 'cue_0001', audio_outcome: 'played', spoken_text: A });
      expect(cue.audio_started_at.value).not.toBeNull();
      expect(cue.audio_ended_at.value).not.toBeNull();
      expect(cue.gap.user_silence_ms).toBeGreaterThanOrEqual(cue.gap.min_user_silence_ms as number);
      expect(cue.observation).toMatchObject({ ended_by: 'ai_speech_started', candidate_speech_started: true, user_speaking_at_audio_end: false });
      expect(JSON.stringify(cue)).not.toMatch(/yield|gave_way|accepted/);
      // 音声は通常の経路で、origin で分かれる。履歴と重複の照合は汚さない。
      expect(rig.events.ofType('speech.started').filter((e) => e.origin === 'vocal_cue')).toHaveLength(1);
      expect(rig.session.history.snapshot().filter((e) => e.role === 'assistant')).toEqual([]);
      expect(rig.events.ofType('initiative.already_said')).toEqual([]);
      const candidateBegin = beginsOf(rig, UTTERANCE)[0]!;
      rig.browser(started(candidateBegin));
      await rig.steps(3, YIELD);
      rig.browser(ended(candidateBegin, 'completed', 16000));
      await rig.steps(3, YIELD);
      expect(stateOf(rig)).toBe('SPOKEN');
      expect(rig.session.history.snapshot().filter((e) => e.role === 'assistant')).toMatchObject([{ origin: { kind: 'candidate', candidate_id: 'c_0001' } }]);
      expect(rig.events.ofType('initiative.already_said')).toEqual([]);
      expect(await until(rig, () => rig!.events.ofType('turn.outcome').length >= 2, YIELD, 300)).toBe(true);
      expect(rig.events.ofType('turn.outcome').filter((e) => e.kind === 'ai_utterance' && e.origin === 'vocal_cue')).toHaveLength(1);
    });

    it('声の後に人が話し続けたら、そこで止まり延期のまま。再開の時間だけを観測する', async () => {
      rig = await setup(mode, ['NEW'], 'pre_beginning');
      await toDeferred(rig);
      const begin = await toCue(rig, A);
      rig.browser(started(begin));
      await rig.steps(2, PAUSE);
      rig.browser(ended(begin, 'completed', 4000));
      await rig.steps(5, PAUSE);
      expect(await until(rig, () => cueEvents(rig!).length > 0, SPEAKING, 200)).toBe(true);
      expect(stateOf(rig)).toBe('DEFERRED');
      expect(beginsOf(rig, UTTERANCE)).toEqual([]);
      const cue = cueEvents(rig)[0]!;
      expect(cue.observation).toMatchObject({ ended_by: 'window', candidate_speech_started: false, user_speaking_at_audio_end: false });
      expect(cue.observation.time_to_user_resume_ms.value).toBeGreaterThan(0);
      expect(cue.observation.candidate_states).toEqual(['DEFERRED']);
    });

    it('声の途中に人が話し始めたら既存の割り込みで止まる。候補は延期のまま', async () => {
      rig = await setup(mode, ['NEW'], 'pre_beginning');
      await toDeferred(rig);
      const begin = await toCue(rig, A);
      rig.browser(started(begin));
      await rig.steps(2, PAUSE);
      expect(await until(rig, () => msgs(rig!, 'playback.stop').length > 0, SPEAKING, 100)).toBe(true);
      expect(msgs(rig, 'playback.stop')[0]).toMatchObject({ audio_playback_id: begin.audio_playback_id });
      rig.browser(ended(begin, 'stopped', 800));
      await rig.steps(3, SPEAKING);
      expect(stateOf(rig)).toBe('DEFERRED');
      expect(rig.events.ofType('speech.interrupted').filter((e) => e.origin === 'vocal_cue')).toHaveLength(1);
      expect(await until(rig, () => cueEvents(rig!).length > 0, SPEAKING, 200)).toBe(true);
      expect(cueEvents(rig)[0]).toMatchObject({ audio_outcome: 'interrupted' });
      expect(rig.session.history.snapshot().filter((e) => e.role === 'assistant')).toEqual([]);
    });

    it('1 候補につき 1 回だけ（次の切れ目では鳴らさない）', async () => {
      rig = await setup(mode, ['NEW'], 'pre_beginning');
      await toDeferred(rig);
      const begin = await toCue(rig, A);
      rig.browser(started(begin));
      await rig.steps(2, PAUSE);
      rig.browser(ended(begin, 'completed', 4000));
      await rig.steps(20, SPEAKING);
      await rig.steps(30, PAUSE);
      expect(beginsOf(rig, A)).toHaveLength(1);
    });

    it('候補を撤回した後の切れ目では鳴らさない。遷移は壊さない', async () => {
      rig = await setup(mode, ['NEW', 'WITHDRAW'], 'pre_beginning');
      await speak(rig);
      expect(await until(rig, () => stateOf(rig!) === 'DEFERRED', SPEAKING)).toBe(true);
      await speak(rig, MORE);
      expect(await until(rig, () => stateOf(rig!) === 'WITHDRAWN', SPEAKING, 100)).toBe(true);
      await rig.steps(30, PAUSE);
      expect(beginsOf(rig, A)).toEqual([]);
      expect(cueEvents(rig)).toEqual([]);
    });

    it('人が話している間は鳴らさない', async () => {
      rig = await setup(mode, ['NEW'], 'pre_beginning');
      await toDeferred(rig);
      await rig.steps(60, SPEAKING);
      expect(beginsOf(rig, A)).toEqual([]);
    });

    it('manifest に値と出どころを残す', async () => {
      rig = await setup(mode, ['NEW'], 'pre_beginning');
      expect(rig.described.at(-1)?.initiative).toMatchObject({ vocal_cue: 'pre_beginning', vocal_cue_requested: 'pre_beginning', vocal_cue_source: 'client', vocal_cue_reason: null });
    });
  });

  describe('backchannel', () => {
    it('「うん」だけを鳴らし、候補は延期のまま（発言権を取らない）', async () => {
      rig = await setup(mode, ['NEW'], 'backchannel');
      await toDeferred(rig);
      const begin = await toCue(rig, UN);
      expect(beginsOf(rig, A)).toEqual([]);
      expect(stateOf(rig)).toBe('DEFERRED');
      rig.browser(started(begin));
      await rig.steps(2, PAUSE);
      rig.browser(ended(begin, 'completed', 3000));
      await rig.steps(3, PAUSE);
      expect(stateOf(rig)).toBe('DEFERRED');
      expect(await until(rig, () => cueEvents(rig!).length > 0, SPEAKING, 200)).toBe(true);
      expect(cueEvents(rig)[0]).toMatchObject({ vocal_cue_kind: 'backchannel', phrase: UN, audio_outcome: 'played' });
      expect(rig.described.at(-1)?.initiative).toMatchObject({ vocal_cue: 'backchannel', vocal_cue_source: 'client' });
      expect(rig.session.history.snapshot().filter((e) => e.role === 'assistant')).toEqual([]);
    });
  });
});

describe('条件の外では効かない', () => {
  it('initiative_inhale 以外の条件は設定を作らず理由を返す', () => {
    const policy = productionJaPolicy();
    const built = vocalCueSettings(policy, 'pre_beginning', 'initiative_no_inhale' as never);
    expect(built.settings).toBeNull();
    expect(built.reason).not.toBeNull();
  });

  it('none は設定を作らない', () => {
    expect(vocalCueSettings(productionJaPolicy(), 'none', 'initiative_inhale').settings).toBeNull();
  });
});

describe('judgeVocalCue（止める条件）', () => {
  const built = vocalCueSettings(productionJaPolicy(), 'pre_beginning', 'initiative_inhale');
  const settings = built.settings!;
  const base: VocalCueGateInputs = {
    candidate: { candidate_id: 'c_0001', candidate_version: 1, state: 'DEFERRED', audio: 'ready', new_chars_since_judgement: 0 } as VocalCueGateInputs['candidate'],
    already_voiced: false,
    ai_speaking: false,
    permitted: false,
    user_speaking: false,
    link_attached: true,
    vap_fresh: true,
    user_silence_ms: 400,
    asr_quiet_ms: 300,
    vad_user: 0.1,
    invitation: { detected: false } as VocalCueGateInputs['invitation'],
    user_text: null,
    phrase_ready: true,
  };

  it('すべて満たせば鳴らす', () => {
    expect(judgeVocalCue(settings, base)).toEqual({ fire: true, reasons: [] });
  });

  it.each([
    ['AI の発話中', { ai_speaking: true }, 'ai_speaking'],
    ['許可が出ている', { permitted: true }, 'permitted'],
    ['人が話している', { user_speaking: true }, 'user_speaking'],
    ['同じ候補で鳴らした', { already_voiced: true }, 'already_voiced'],
    ['VAP が古い', { vap_fresh: false }, 'vap_not_fresh'],
    ['語の音声がない', { phrase_ready: false }, 'phrase_not_ready'],
    ['切れ目が短い', { user_silence_ms: 100 }, 'silence_short:100ms'],
    ['ASR が直近', { asr_quiet_ms: 50 }, 'asr_recent:50ms'],
    ['VAD が高い', { vad_user: 0.8 }, 'vad_user=0.8'],
  ] as const)('%s は鳴らさない', (_name, patch, reason) => {
    const decision = judgeVocalCue(settings, { ...base, ...patch });
    expect(decision.fire).toBe(false);
    expect(decision.reasons).toContain(reason);
  });

  it('延期以外の候補は対象にしない', () => {
    expect(judgeVocalCue(settings, { ...base, candidate: { ...base.candidate, state: 'WITHDRAWN' } }).reasons).toContain('state:WITHDRAWN');
  });

  it('pre_beginning は候補の音声がなければ鳴らさないが、backchannel は関係しない', () => {
    const candidate = { ...base.candidate, audio: 'preparing' } as VocalCueGateInputs['candidate'];
    expect(judgeVocalCue(settings, { ...base, candidate }).fire).toBe(false);
    const back = vocalCueSettings(productionJaPolicy(), 'backchannel', 'initiative_inhale').settings!;
    expect(judgeVocalCue(back, { ...base, candidate }).fire).toBe(true);
  });
});
