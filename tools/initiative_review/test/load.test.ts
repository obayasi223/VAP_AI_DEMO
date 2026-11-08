import { describe, expect, it } from 'vitest';
import { filterItems, filterOptions, itemMatches, loadSession, sessionMatches, vocalCueOptions } from '../lib/session';
import { collect, parseJsonl, wrap } from '../lib/readers';
import { stagedEvents, syntheticEvents, tempRoot, writeSession } from './synthetic';
import type { Field, ReviewItem, ReviewSession } from '../lib/model';

function load(options?: Parameters<typeof writeSession>[2], id = 's_synthetic'): ReviewSession {
  return loadSession(writeSession(tempRoot(), id, options));
}

function field(fields: Field[], key: string): Field {
  const found = fields.find((f) => f.key === key);
  if (found === undefined) throw new Error(`no field ${key}`);
  return found;
}

function candidate(session: ReviewSession): ReviewItem {
  const item = session.items.find((i) => i.key === 'c:c_0001');
  if (item === undefined) throw new Error('no candidate item');
  return item;
}

describe('読み込み', () => {
  it('同じ candidate_id の判定を1系列にまとめ、順に並べる', () => {
    const item = candidate(load());
    expect(item.kind).toBe('candidate');
    expect(item.decisions.map((d) => d.decision)).toEqual(['NEW', 'REVISE', 'WITHDRAW']);
    expect(item.headline).toBe('NEW → REVISE → WITHDRAW（WITHDRAWN）');
    expect(item.final_state).toBe('WITHDRAWN');
    expect(item.t_ms).toBe(3000);
    expect(item.anchor_t_ms).toBe(2500);
  });

  it('LLM の書いた項目は model_output、コードの検証は verified として出る', () => {
    const [first] = candidate(load()).decisions;
    expect(first).toBeDefined();
    expect(field(first!.content, 'proposed_utterance')).toMatchObject({ value: '大きい方というのは前の箱のことですか？', provenance: 'model_output', label: '発話希望の内容' });
    expect(field(first!.content, 'evidence_span').provenance).toBe('model_output');
    expect(field(first!.content, 'evidence_valid')).toMatchObject({ value: 'はい', provenance: 'verified', method: 'exact_substring_of_stable_text' });
    expect(field(first!.timing, 'why_now').provenance).toBe('model_output');
    // モデルが書かなかった項目は、値なしと理由のまま。
    expect(field(first!.timing, 'cost_of_waiting')).toMatchObject({ value: null, null_reason: 'model_left_empty' });
    // 判定のイベントに無い項目は llm.response の出力から補う。
    expect(field(first!.timing, 'resolution_outlook')).toMatchObject({ value: '本人が直しそうにない', provenance: 'model_output' });
    expect(first!.llm_input).toBe('入力 ini_0001');
  });

  it('安定した ASR は判定の入力の改訂の時点まで（後の改訂を含めない）', () => {
    const [first, second] = candidate(load()).decisions;
    expect(first!.stable.transcript_revision).toBe(4);
    expect(first!.stable.text).toBe('箱の話まず大きい方の箱を十個');
    expect(first!.stable.segments.map((s) => s.final)).toEqual([true, false]);
    expect(second!.stable.transcript_revision).toBe(5);
    expect(second!.stable.text).toBe('箱の話まず大きい方の箱を十個と言いました');
  });

  it('状態の遷移、交渉、合図、未対応のイベントが系列の遷移に時刻の順で入る', () => {
    const { timeline } = candidate(load());
    const events = timeline.map((r) => r.event);
    expect(events).toContain('candidate.state_changed');
    expect(events).toContain('negotiation.decision');
    expect(events).toContain('signal.sent');
    // 読み手のないイベントも、candidate_id があれば生のまま1行出る。
    const other = timeline.find((r) => r.event === 'initiative.timing_note');
    expect(other?.label).toContain('未対応');
    expect(other?.detail).toContain('新しい段の試し');
    expect([...timeline].sort((a, b) => a.t_ms - b.t_ms)).toEqual(timeline);
  });

  it('吸気の合図の時刻を実測として拾う', () => {
    const item = candidate(load());
    expect(item.inhale).toEqual([{ phase: 'inhale', sent_at: 3100, started_at: 3150, visible: true, ended_at: null }]);
    expect(item.speech).toEqual([]);
  });

  it('NONE は1判定1件で、評価軸は内容だけ', () => {
    const none = load().items.find((i) => i.key === 'n:ini_0004');
    expect(none?.kind).toBe('none');
    expect(none?.rate_axes).toEqual(['content']);
    expect(field(none!.decisions[0]!.content, 'reason').value).toBe('言う価値がない');
    // llm.response の空の項目（why_now: ''）は足さない。
    expect(none!.decisions[0]!.timing).toEqual([]);
  });

  it('棄てられた要求は rejected と discarded を1件にまとめ、LLM の出力を出す', () => {
    const session = load();
    const dropped = session.items.filter((i) => i.kind === 'dropped');
    expect(dropped.map((i) => i.key)).toEqual(['x:ini_0005']);
    const item = dropped[0]!;
    expect(item.timeline.map((r) => r.event)).toEqual(['candidate.rejected', 'initiative.discarded']);
    expect(item.decisions[0]!.decision).toBe('NEW');
    expect(field(item.decisions[0]!.content, 'proposed_utterance')).toMatchObject({ value: '棄てられる一言', provenance: 'model_output' });
    expect(item.rate_axes).toEqual(['content', 'timing', 'wait_withdraw']);
  });

  it('会話は人の ASR（確定を優先）と AI の発話を時刻の順に並べる', () => {
    const { lines } = load();
    expect(lines.map((l) => [l.id, l.role])).toEqual([
      ['u0', 'user'],
      ['u1', 'user'],
      ['u2', 'user'],
      ['a7', 'ai'],
    ]);
    expect(lines[1]!.text).toBe('まず大きい方の箱を十個と言いました');
    expect(lines[3]!.text).toBe('こちらは応答の例です');
    expect(lines[3]!.origin).toBe('response');
  });

  it('前後の会話の範囲と、音声の秒位置を vap.state の対応から求める', () => {
    const session = load();
    const item = candidate(session);
    expect(item.context_before).toEqual(['u0', 'u1']);
    expect(item.context_after).toEqual(['u2', 'a7']);
    // vap は t = frame/16 + 200 の合成。anchor 2500ms → frame = 36800 → 2.3 秒。
    expect(item.audio_sec).toBeCloseTo(2.3, 3);
  });

  it('壊れた行は読み飛ばして警告に残す。音声と vap が無くても読める', () => {
    const session = load({ extraLines: ['{ broken'], events: syntheticEvents().filter((e) => (e as { event: string }).event !== 'vap.state') });
    expect(session.warnings.join(' ')).toContain('1 行');
    expect(session.meta.audio_files).toEqual([]);
    expect(session.items.length).toBeGreaterThan(0);
  });

  it('wrap は Maybe／ModelOutput／素の値を区別する', () => {
    expect(wrap({ value: null, null_reason: 'x' })).toEqual({ value: null, null_reason: 'x', provenance: 'code' });
    expect(wrap({ source: 'model_output', value: 'a' }).provenance).toBe('model_output');
    expect(wrap('素の値').provenance).toBe('code');
  });

  it('読み手のないイベントで candidate_id も request_id も無ければ捨てる', () => {
    const { events } = parseJsonl('{"event":"something.else","x":1}\n');
    expect(collect(events).others).toEqual([]);
  });

  it('判定の知らない項目でも ModelOutput なら LLM 生成の項目として拾う', () => {
    const decision = syntheticEvents().map((e) => {
      const ev = e as Record<string, unknown>;
      if (ev.event === 'initiative.decision' && ev.decision === 'NONE') return { ...ev, timing_judgement: { source: 'model_output', value: '今はまだ早い' } };
      return ev;
    });
    const none = load({ events: decision }).items.find((i) => i.kind === 'none');
    expect(field(none!.decisions[0]!.timing, 'timing_judgement')).toMatchObject({ value: '今はまだ早い', provenance: 'model_output' });
  });
});

describe('絞り込み', () => {
  const session = (id: string, conversation_type: string, prompt_version: string): ReviewSession =>
    load({ manifest: { conversation_type, initiative: { prompt_version, persona_id: 'p' } } }, id);

  it('会話の種類とプロンプトの版で判定を絞り込む', () => {
    const a = session('s_a', 'co_thinking', 'v1');
    expect(a.meta.conversation_type).toBe('共同思考');
    expect(filterItems(a.items, { conversation_type: '共同思考' })).toEqual(a.items);
    expect(filterItems(a.items, { conversation_type: 'コンパニオン' })).toEqual([]);
    expect(filterItems(a.items, { prompt_version: 'v1' })).toEqual(a.items);
    expect(filterItems(a.items, { prompt_version: 'v2' })).toEqual([]);
    expect(itemMatches(a.items[0]!, { conversation_type: '共同思考', prompt_version: 'v2' })).toBe(false);
  });

  it('判定に版が記録されていれば manifest より判定の版で絞る', () => {
    const events = syntheticEvents().map((e) => {
      const ev = e as Record<string, unknown>;
      return ev.event === 'initiative.decision' && ev.request_id === 'ini_0004' ? { ...ev, prompt_version: 'v9' } : ev;
    });
    const s = load({ events, manifest: { initiative: { prompt_version: 'v1', persona_id: 'p' } } });
    expect(filterItems(s.items, { prompt_version: 'v9' }).map((i) => i.key)).toEqual(['n:ini_0004']);
    expect(s.meta.prompt_versions).toEqual(expect.arrayContaining(['v1', 'v9']));
  });

  it('セッションの一覧の絞り込みと選択肢', () => {
    const a = session('s_a', 'co_thinking', 'v1').meta;
    const b = session('s_b', 'companion', 'v2').meta;
    expect(filterOptions([a, b])).toEqual({ conversation_types: ['コンパニオン', '共同思考'].sort(), prompt_versions: ['v1', 'v2'] });
    expect(sessionMatches(a, { conversation_type: 'コンパニオン' })).toBe(false);
    expect(sessionMatches(b, { conversation_type: 'コンパニオン', prompt_version: 'v2' })).toBe(true);
  });

  it('manifest に会話の種類がなければ persona を代わりに出す（推測で割り当てない）', () => {
    const s = load();
    expect(s.meta.conversation_type).toBe('persona: persona_a');
    expect(load({ manifest: { initiative: { prompt_version: 'v1' } } }).meta.conversation_type).toBe('（記録なし）');
    expect(load({ manifest: { initiative: { prompt_version: 'v1', conversation_kind: 'joint_thinking' } } }).meta.conversation_type).toBe('共同思考');
  });
});

describe('二段判定（initiative.desire と initiative.timing）', () => {
  const load2 = (kind = 'companion') => load({ events: stagedEvents(kind), manifest: { initiative: { prompt_version: null, persona_id: 'p' } } });

  it('生成段とタイミング段を同じ候補の系列にして、順に並べ、続く同じ判定はまとめる', () => {
    const item = load2().items.find((i) => i.key === 'c:c_0002');
    expect(item?.decisions.map((d) => d.decision)).toEqual(['NEW', 'WAIT_FOR_TURN_END', 'WAIT_FOR_TURN_END', 'OFFER_NOW']);
    expect(item?.headline).toBe('NEW → WAIT_FOR_TURN_END ×2 → OFFER_NOW');
    expect(item?.timeline.map((r) => r.event)).toContain('initiative.timing');
    expect(item?.timeline.find((r) => r.event === 'initiative.desire')?.label).toBe('生成段 NEW（版 1）');
  });

  it('タイミング段の項目は全部タイミングの側で、LLM 生成とコードの結果を区別する', () => {
    const item = load2().items.find((i) => i.key === 'c:c_0002')!;
    const [desire, timing] = item.decisions;
    expect(field(desire!.content, 'proposed_utterance')).toMatchObject({ value: '確認の一言', provenance: 'model_output' });
    expect(field(desire!.content, 'evidence_segment_ids')).toMatchObject({ value: '1', provenance: 'verified' });
    expect(field(desire!.content, 'gate')).toMatchObject({ value: '合格', provenance: 'verified' });
    expect(timing!.content).toEqual([]);
    expect(field(timing!.timing, 'reason')).toMatchObject({ value: 'まだ話している', provenance: 'model_output' });
    expect(field(timing!.timing, 'outcome')).toMatchObject({ value: 'kept', provenance: 'code' });
  });

  it('immediate は LLM を呼ばない行として読み、要求の番号は生成段から作る', () => {
    const session = load({ events: stagedEvents('companion', true), manifest: {} });
    const step = session.items.find((i) => i.key === 'c:c_0002')!.decisions.at(-1)!;
    expect(step).toMatchObject({ request_id: 'ini_0011_immediate', decision: 'OFFER_NOW', sent_at: null, t_ms: 3005 });
    expect(field(step.timing, 'timing_strategy').value).toContain('immediate');
  });

  it('判定イベントの会話の種類で絞り込み、セッションの種類にも使う', () => {
    const session = load2();
    expect(session.meta.conversation_type).toBe('コンパニオン');
    expect(filterItems(session.items, { conversation_type: 'コンパニオン' }).map((i) => i.key)).toContain('c:c_0002');
    expect(filterItems(session.items, { conversation_type: '共同思考' })).toEqual([]);
    expect(session.meta.prompt_versions).toEqual(expect.arrayContaining(['desire-v', 'timing-v']));
  });

  it('1つのセッションに種類が混ざっても、判定ごとの種類で絞り込む（セッションの表示は manifest のまま、警告を残す）', () => {
    const other = stagedEvents('joint_thinking').map((e) => {
      const ev = e as Record<string, unknown>;
      const id = (s: unknown): unknown => (typeof s === 'string' ? s.replace(/ini_001/, 'ini_002') : s);
      return ev.event === 'initiative.desire'
        ? { ...ev, request_id: id(ev.request_id), candidate_id: { value: 'c_0003' } }
        : { ...ev, request_id: id(ev.request_id), desire_request_id: id(ev.desire_request_id), candidate_id: 'c_0003' };
    });
    const session = load({ events: [...stagedEvents('companion'), ...other], manifest: { initiative: { conversation_kind: 'joint_thinking', persona_id: 'p' } } });
    expect(session.warnings.join(' ')).toContain('複数の会話の種類');
    expect(session.meta.conversation_type).toBe('共同思考');
    expect(filterItems(session.items, { conversation_type: 'コンパニオン' }).map((i) => i.key)).toEqual(['c:c_0002']);
    expect(filterItems(session.items, { conversation_type: '共同思考' }).map((i) => i.key)).toEqual(['c:c_0003']);
  });

  it('タイミング段の llm.response だけにある項目もタイミングの側へ補う（内容の側へ混ぜない）', () => {
    const extra = {
      ...stagedEvents()[0] as object,
      event: 'llm.response',
      request_id: 'ini_0011_timing',
      purpose: 'initiative',
      output: { source: 'model_output', value: { text: JSON.stringify({ timing: 'WAIT_FOR_TURN_END', extra_note: 'モデルの補足' }), finish_reason: 'STOP' } },
    };
    const session = load({ events: [extra, ...stagedEvents()], manifest: {} });
    const timing = session.items.find((i) => i.key === 'c:c_0002')!.decisions[1]!;
    expect(timing.content).toEqual([]);
    expect(field(timing.timing, 'extra_note')).toMatchObject({ value: 'モデルの補足', provenance: 'model_output' });
  });

  it('manifest と判定の種類が違えば警告し、判定の記録を使う', () => {
    const session = load({ events: stagedEvents('companion'), manifest: { initiative: { conversation_kind: 'joint_thinking', persona_id: 'p' } } });
    expect(session.meta.conversation_type).toBe('コンパニオン');
    expect(session.warnings.join(' ')).toContain('違います');
  });

  it('通常応答に渡した材料、実際に話した文、推定の一致を判定の詳細に出す（反映は推定として）', () => {
    const material = (segment: number, revision: number, text: string, at: number) => ({
      schema_version: 1, t_monotonic_ms: at, wall_clock: '2026-01-01T00:00:00.000Z', session_id: 's_synthetic', condition: 'initiative_inhale',
      time_basis: { source: 'orchestrator', uncertainty_ms: { value: 0 } },
      event: 'initiative.response_material', candidate_id: 'c_0002', candidate_version: 1, segment_id: segment, transcript_revision: revision,
      prompt_version: 'response_prompt_v1+pending_material_v1', proposed_utterance: { source: 'model_output', value: text }, at,
    });
    const events = [
      ...stagedEvents(),
      material(2, 8, '渡した文その一', 6000),
      { ...material(2, 8, '渡した文その一', 7000), event: 'initiative.response_reflection', audio_playback_id: { value: 11 }, spoken_text: '話した文', spoken_text_precision: { value: 'alignment_char' }, interrupted: false, spoken_outcome: 'spoken', estimated_reflected: { value: true }, estimate: { value: { method: 'char_bigram_containment:v1', basis: 'content_bigrams', containment: 0.8, cosine: 0.4, threshold: 0.5, material_bigrams: 10, matched_bigrams: 8 } }, at: 7000 },
      material(3, 9, '渡した文その二', 8000),
      { ...material(3, 9, '', 8100), event: 'initiative.already_said', stage: 'after_ai_speech', candidate_state: 'INTENT_READY', comparison: { source: 'verified', value: { method: 'm', similarity: 0.9, threshold: 0.8, matched_text: '話した一文' }, method: 'x' }, matched_audio_playback_id: 11, matched_origin: 'response', at: 8100 },
    ];
    const session = load({ events }, 's_reflect');
    const item = session.items.find((i) => i.candidate_id === 'c_0002')!;
    expect(item.reflection).toMatchObject([
      { given_text: '渡した文その一', spoken_text: '話した文', spoken_outcome: 'spoken', estimated_reflected: true },
      { given_text: '渡した文その二', spoken_outcome: null, estimated_reflected: null },
    ]);
    expect(item.reflection[0]!.estimate_text).toContain('包含率 0.8');
    const rows = item.timeline.map((r) => r.label);
    expect(rows.some((l) => l.startsWith('通常応答の結果（spoken）: 推定: 反映あり'))).toBe(true);
    expect(rows.some((l) => l.startsWith('撤回: すでに話した内容（AI の発話の後。類似度 0.9'))).toBe(true);
    expect(rows.some((l) => l.includes('未対応'))).toBe(false);
  });

  it('その発話の結果（turn.outcome）を候補の発話の詳細に載せる', () => {
    const outcomeEvent = {
      schema_version: 1,
      t_monotonic_ms: 9000,
      wall_clock: 'x',
      session_id: 's',
      condition: 'initiative_inhale',
      time_basis: { source: 'orchestrator', uncertainty_ms: { value: 0 } },
      event: 'turn.outcome',
      kind: 'ai_utterance',
      audio_playback_id: 9,
      segment_id: 4,
      origin: 'candidate',
      candidate_id: { value: 'c_0001' },
      conversation_kind: { value: null, null_reason: 'none' },
      labels: { value: ['user_overlap'] },
      start: { decided_at: 7000, decision_source: 'vap', reason: 'L67_vap_yield', p_now: { value: 0.7 }, p_future: { value: 0.6 }, vad_user: { value: 0.1 }, vap_freshness: 'fresh', completion_p: { value: 0.5 }, gap_ms: { value: 900 } },
      speech_started_at: { value: 7040 },
      speech_ended_at: { value: 8040 },
      played_ms: { value: 1000 },
      interrupted: false,
      observed: {
        user_voice_gap_before_ms: { value: 950 },
        user_voiced_just_before: true,
        continuation: { continued: false, chars: 0 },
        overlap: { overlap_ms: { value: 320 }, first_after_start_ms: { value: 100 }, chars: 4, text_kind: 'content' },
        echo: { suspected: false, text_similarity: { value: 0.2 }, overlap_ratio: { value: 0.3 } },
      },
    };
    const start = { schema_version: 1, t_monotonic_ms: 7030, wall_clock: 'x', session_id: 's', condition: 'initiative_inhale', time_basis: { source: 'orchestrator', uncertainty_ms: { value: 0 } }, event: 'speech.started', audio_playback_id: 9, audio_frame: 1000, started_at: 7040, origin: 'candidate', candidate_id: 'c_0001', candidate_version: 1 };
    const session = load({ extraLines: [JSON.stringify(start), JSON.stringify(outcomeEvent)] });
    const item = candidate(session);
    expect(item.speech.find((r) => r.audio_playback_id === 9)?.outcome?.labels).toEqual(['user_overlap']);
    expect(item.timeline.some((r) => r.event === 'turn.outcome')).toBe(true);
  });
});

describe('吸気の後の結末（延期と内容の撤回の区別）', () => {
  type Ev = Record<string, unknown>;
  const isState = (e: Ev) => e.event === 'candidate.state_changed';
  const all = syntheticEvents() as Ev[];
  const cue = all.find((e) => isState(e) && e.to === 'BREATH_INHALE') as Ev;
  /** 吸気より後の遷移を除いた合成ログに、指定の遷移を足す。 */
  const withStates = (...steps: Array<[string, string, Ev, number?]>): ReviewItem => {
    const head = all.filter((e) => !(isState(e) && e.to === 'WITHDRAWN'));
    const extra = steps.map(([from, to, cause, version], i) => {
      const { cause: _cause, ...envelope } = cue;
      return { ...envelope, t_monotonic_ms: 6000 + i * 100, from, to, ...cause, candidate_version: { value: version ?? 1 } };
    });
    return candidate(load({ events: [...head, ...extra] }));
  };
  const code = (cause: string): Ev => ({ cause_source: 'code', cause });
  const model = (kind?: string): Ev => ({ cause_source: 'model_decision', decision: 'WITHDRAW', request_id: 'ini_0003', ...(kind ? { withdraw_kind: { source: 'model_output', value: kind } } : {}) });
  const DEFER: [string, string, Ev] = ['BREATH_HOLD_OR_READY', 'DEFERRED', code('user_continued')];

  it('延期の後に話した: 延期あり、結末は発話', () => {
    const view = withStates(DEFER, ['DEFERRED', 'SPEAKING', code('turn_allowed')], ['SPEAKING', 'SPOKEN', code('speech_finished')]).after_cue;
    expect(view).toMatchObject({ deferred: true, ending: 'spoken', withdraw_kind: null });
    expect(view?.label).toBe('吸気 → 延期 → 発話');
  });

  it('延期の後に内容で撤回した: 延期と内容の撤回を両方残す', () => {
    const view = withStates(DEFER, ['DEFERRED', 'WITHDRAWN', model('premise_changed')]).after_cue;
    expect(view).toMatchObject({ deferred: true, ending: 'content_withdrawn', withdraw_kind: 'premise_changed', code_cause: null });
    expect(view?.label).toBe('吸気 → 延期 → 内容の撤回（前提が変わった）');
  });

  it.each(['normal_response_started', 'expired', 'audio_unavailable'])('延期の後の %s は内容の撤回にしない', (cause) => {
    const view = withStates(DEFER, ['DEFERRED', 'WITHDRAWN', code(cause)]).after_cue;
    expect(view).toMatchObject({ deferred: true, ending: 'not_spoken_other', code_cause: cause, withdraw_kind: null });
    expect(view?.label).toContain('内容の撤回ではない');
  });

  it('延期せずに内容で撤回した: 延期なし', () => {
    expect(withStates(['BREATH_INHALE', 'WITHDRAWN', model('question_resolved')]).after_cue).toMatchObject({ deferred: false, deferred_at: null, ending: 'content_withdrawn' });
  });

  it('発言済みはコードの照合でも生成段の分類でも already_said', () => {
    expect(withStates(DEFER, ['DEFERRED', 'WITHDRAWN', code('already_said')]).after_cue?.ending).toBe('already_said');
    expect(withStates(DEFER, ['DEFERRED', 'WITHDRAWN', model('already_said')]).after_cue?.ending).toBe('already_said');
  });

  it('延期の後に内容を更新して話した: 更新の回数を残す', () => {
    const view = withStates(DEFER, ['DEFERRED', 'SPEAKING', code('turn_allowed'), 2], ['SPEAKING', 'SPOKEN', code('speech_finished'), 2]).after_cue;
    expect(view).toMatchObject({ deferred: true, revisions: 1, ending: 'spoken' });
    expect(view?.label).toBe('吸気 → 延期 → 内容の更新 ×1 → 発話');
  });

  it('再生に失敗したら発話にしない。延期中で記録が終われば未解決', () => {
    expect(withStates(['BREATH_HOLD_OR_READY', 'SPEAKING', code('turn_allowed')], ['SPEAKING', 'WITHDRAWN', code('speech_failed')]).after_cue?.ending).toBe('not_spoken_other');
    expect(withStates(DEFER).after_cue).toMatchObject({ ending: 'unresolved', ending_at: null, deferred: true });
  });

  it('吸気のない候補と、候補でない判定は null', () => {
    const noCue = all.filter((e) => !(isState(e) && (e.to === 'BREATH_INHALE' || e.to === 'WITHDRAWN')));
    expect(candidate(load({ events: noCue })).after_cue).toBeNull();
    expect(load().items.filter((i) => i.candidate_id === null).every((i) => i.after_cue === null)).toBe(true);
  });

  describe('吸気の後の短い声（別モード）', () => {
    const cid = cue.candidate_id;
    const vocalEvent = (over: Ev = {}): Ev => {
      const { from: _f, to: _t, cause: _c, cause_source: _s, ...envelope } = cue;
      return {
        ...envelope,
        event: 'initiative.vocal_cue',
        t_monotonic_ms: 6050,
        vocal_cue_kind: 'pre_beginning',
        phrase: 'あ、',
        candidate_id: cid,
        candidate_version: 1,
        audio_playback_id: 77,
        decided_at: 6050,
        gap: { user_silence_ms: 420, asr_quiet_ms: 300 },
        audio_started_at: { value: 6060 },
        audio_ended_at: { value: 6300 },
        audio_outcome: 'played',
        observation: { ended_by: 'window', candidate_speech_started: false, user_speaking_at_audio_end: false, time_to_user_resume_ms: { value: 180 } },
        ...over,
      };
    };
    const head = all.filter((e) => !(isState(e) && e.to === 'WITHDRAWN'));
    const { cause: _cause, ...envelope } = cue;
    const deferred: Ev = { ...envelope, t_monotonic_ms: 6000, from: 'BREATH_HOLD_OR_READY', to: 'DEFERRED', cause_source: 'code', cause: 'user_continued', candidate_version: { value: 1 } };

    it('声を出した候補は、種類、語、時刻、観測の値を結末に載せ、流れの行に声を入れる', () => {
      const view = candidate(load({ events: [...head, deferred, vocalEvent()] })).after_cue;
      expect(view?.vocal_cue).toMatchObject({ kind: 'pre_beginning', phrase: 'あ、', decided_at: 6050, audio_started_at: 6060, audio_ended_at: 6300, audio_outcome: 'played', resumed_ms: 180 });
      expect(view?.label).toContain('吸気 → 延期 → 声「あ、」');
    });

    it('声のイベントは時系列にも出る。声のない候補は null で、結末の行は従来のまま', () => {
      const item = candidate(load({ events: [...head, deferred, vocalEvent()] }));
      expect(item.timeline.some((r) => r.event === 'initiative.vocal_cue' && r.label.includes('あ、'))).toBe(true);
      const plain = candidate(load({ events: [...head, deferred] })).after_cue;
      expect(plain?.vocal_cue).toBeNull();
      expect(plain?.label).not.toContain('声');
    });

    it('声の種類で、研究条件とは別に絞り込める', () => {
      const session = load({ events: [...head, deferred, vocalEvent({ vocal_cue_kind: 'backchannel', phrase: 'うん' })] });
      expect(session.meta.vocal_cue_kinds).toEqual(['backchannel']);
      expect(filterItems(session.items, { vocal_cue: 'backchannel' }).map((i) => i.candidate_id)).toEqual([candidate(session).candidate_id]);
      expect(filterItems(session.items, { vocal_cue: 'pre_beginning' })).toEqual([]);
      expect(sessionMatches(session.meta, { vocal_cue: 'pre_beginning' })).toBe(false);
      expect(sessionMatches(session.meta, { vocal_cue: 'backchannel' })).toBe(true);
      expect(vocalCueOptions([session.meta])).toEqual(['none', 'backchannel']);
    });

    it('記録がない古いセッションは声なしとして読める', () => {
      const session = load({ events: head });
      expect(session.meta.vocal_cue_kinds).toEqual([]);
      expect(session.meta.vocal_cue_mode).toBeNull();
      expect(filterItems(session.items, { vocal_cue: 'none' }).length).toBe(session.items.length);
    });
  });
});
