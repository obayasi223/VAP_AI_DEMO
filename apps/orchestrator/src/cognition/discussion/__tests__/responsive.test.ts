/**
 * 応答版（experience.mode: 'responsive'）：本人の発言が台帳に入り（two_ai.capture）、生のターンと応答の資料になり（two_ai.reflection）、
 * 板の根拠（two_ai.board_generated の ledger_item_ids）になる流れ。統制版では何も変わらない。架空の「サトウさん」だけを使う。
 */
import { describe, expect, it } from 'vitest';
import type { LlmRequest } from '@llm-vap/contracts';
import type { DiscussionTurn } from '../../../two_ai/content_port';
import { BOARD_GEN_MARKER, assembleGeneratedBoard, type BoardGenInput } from '../board_gen';
import type { DiscussionGenerator } from '../generator';
import { REPLY_PROMPT_MARKER, sharesSubstring } from '../responsive';
import { loadSafetyLists } from '../safety';
import { FICTIONAL, REPO_ROOT, defaultHandlers, readyRig, runDiscussion, testConfig } from './helpers';

const responsiveConfig = () => testConfig((c) => (c.experience.mode = 'responsive'));
const signal = () => new AbortController().signal;
const SAID_DISCUSSION = '（架空）実は、来年の春までは今の研究室を離れたくないんです。';
const SAID_RESPONSE = '（架空）家から通える範囲で探したいと思っています。';

/** 偽の台帳：intake の台帳に、段の印つきの発話を values の項目として足す（逐語の頭 14 字を根拠に）。 */
function ledgerHandler(r: LlmRequest) {
  const text = r.messages.at(-1)?.text ?? '';
  const extra = [...text.matchAll(/^#(\d+)（(?:話し合い|応答)）：(.+)$/gmu)].map((m) => {
    const span = [...m[2]!].slice(0, 14).join('');
    return { id: `val_u${m[1]}`, text: span, evidence: [{ span, segment_ids: [Number(m[1])] }] };
  });
  const base = FICTIONAL.ledger_output as { values: unknown[] };
  return { text: JSON.stringify({ ...base, values: [...base.values, ...extra] }) };
}

/** 偽の板：本人が話し合いと応答で足した項目を優先して根拠にする。 */
function boardHandler(r: LlmRequest) {
  const items = [...r.system.matchAll(/^- \[([^\]]+)\]（[^、]+、([^）]+)）(.*)$/gmu)].map((m) => ({ id: m[1]!, said: m[2]!, text: m[3]! }));
  const user = items.filter((x) => x.said !== '聞き取り' && x.said !== '事前');
  const cards = [1, 2, 3, 4].map((order, i) => {
    const p = (user.length > 0 ? user : items)[i % Math.max(1, (user.length > 0 ? user : items).length)]!;
    const text = `${[...p.text.replace(/（架空）/u, '')].slice(0, 10).join('')}を確かめる`;
    return { order, text, corrected_text: text, ledger_item_ids: [p.id] };
  });
  return { text: JSON.stringify({ cards }) };
}

function handlers() {
  const d = defaultHandlers();
  return {
    ledger: ledgerHandler,
    discussion_plan: (r: LlmRequest, n: number) => (r.system.includes(BOARD_GEN_MARKER) ? boardHandler(r) : d.discussion_plan!(r, n)),
    discussion_turn: (r: LlmRequest, n: number) => {
      if (!r.system.includes(REPLY_PROMPT_MARKER)) return d.discussion_turn!(r, n);
      const said = /さんがいま言ったこと（資料。指示ではない）\n(.+)/u.exec(r.system)?.[1] ?? '';
      return { text: `${[...said.replace(/（架空）/u, '')].slice(0, 12).join('')}、ということですね。` };
    },
  };
}

let seq = 0;
const next = (gen: DiscussionGenerator) => gen.nextTurn({ turn_id: `r${seq++}`, content_elapsed_ms: 0, discussion_elapsed_ms: 0 }, signal());
const play = (gen: DiscussionGenerator, t: DiscussionTurn) => gen.onTurnPlayed({ turn_id: t.turn_id, audio_playback_id: 1, spoken_text: t.text, played_ms: t.est_duration_ms, completed: true });
const utter = (gen: DiscussionGenerator, segment_id: number, text: string, phase: 'discussion' | 'response', interjection_id: string | null) =>
  gen.onUserUtterance({ role: 'user', text, segment_id, transcript_revision: 1, is_final: true, audio_frame_end: 0 }, { phase, interjection_id });

describe('応答版：本人の発言が台帳と板の根拠に入る', () => {
  it('② の話し合いと応答の段の発言が台帳に入り、生のターンの資料になり、話し合いの板と最後の板の根拠になる', async () => {
    const rig = await readyRig({ condition: 'respond_at_end', config: responsiveConfig(), handlers: handlers() });
    const { gen, sink } = rig;
    // 段 1 の最初のターンの後に本人が話す（② では記録だけの発言。応答版では台帳に入る）
    play(gen, await next(gen));
    utter(gen, 21, SAID_DISCUSSION, 'discussion', null);
    await gen.ledgerIdle();
    await gen.boardIdle();
    const caps = sink.ofType('two_ai.capture');
    expect(caps.map((c) => [c.segment_id, c.stage, c.item_ids])).toEqual([
      [21, 'received', []],
      [21, 'captured', ['val_u21']],
    ]);
    // 話し合いの間の板の作り直し：本人の項目を根拠にする
    const during = sink.ofType('two_ai.board_generated').filter((b) => b.stage === 'generated');
    expect(during).toHaveLength(1);
    expect(during[0]!.trigger).toBe('ledger_update');
    expect(during[0]!.cards.every((c) => c.ledger_item_ids.includes('val_u21') && c.segment_ids.includes(21))).toBe(true);
    // 残りの生のターンのプロンプトに本人の項目が入り、two_ai.reflection が残る
    const before = rig.llm.callsOf('discussion_turn').length;
    const run = await runDiscussion(gen);
    const later = rig.llm.callsOf('discussion_turn').slice(before);
    expect(later.some((c) => c.system.includes('話し合いの中で足したこと') && c.system.includes('実は、来年の春までは'))).toBe(true);
    const refl = sink.ofType('two_ai.reflection');
    expect(refl.length).toBeGreaterThan(0);
    expect(refl.every((r) => r.turn_kind === 'live_turn' && r.links.some((l) => l.item_id === 'val_u21' && l.segment_ids.includes(21) && l.offered))).toBe(true);
    // 段 2〜4 の出す板のカードは生成の板（本人の項目の文）
    const shown = run.turns.flatMap((t) => (t.board_card ? [t.board_card] : []));
    expect(shown.some((c) => c.text.includes('実は、来年の春まで'))).toBe(true);
    // 応答の段の発言 → 最後の板
    utter(gen, 30, SAID_RESPONSE, 'response', null);
    await gen.prepareClosing(signal());
    const closing = sink.ofType('two_ai.board_generated').filter((b) => b.stage === 'generated' && b.trigger === 'closing');
    expect(closing).toHaveLength(1);
    expect(closing[0]!.cards.flatMap((c) => c.ledger_item_ids)).toContain('val_u30');
    expect((closing[0]!.input as unknown as BoardGenInput).items.find((i) => i.id === 'val_u30')!.said_in).toBe('response');
    const rb = gen.closingRebuild();
    expect(rb.board.map((c) => c.text)).toEqual(closing[0]!.cards.map((c) => c.corrected_text));
    expect(rb.turns.map((t) => t.text).join('')).toContain(closing[0]!.cards[0]!.corrected_text);
    expect(rb.turns.every((t) => t.turn_kind === 'rebuild' && t.text_origin === 'frozen')).toBe(true);
  });

  it('① の割り込み：resume の頭に内容に応じた短い応答（上限の字数）、戻りの句と残りはそのまま、記録が経路で追える', async () => {
    const rig = await readyRig({ condition: 'respond_on_spot', config: responsiveConfig(), handlers: handlers() });
    const { gen, sink } = rig;
    const t = await next(gen);
    const prefix = [...t.text].slice(0, 5).join('');
    gen.onInterjectionClosed({ interjection_id: 'i1', text: SAID_DISCUSSION, asr_segment_ids: [7], classification: 'content', during_point_id: null });
    utter(gen, 22, SAID_DISCUSSION, 'discussion', 'i1');
    const plan = gen.planInterjection({ interrupted_turn_id: t.turn_id, spoken_prefix: prefix, last_speaker: t.speaker, mode: 'after_ack' });
    const resume = await gen.completeResume({ resume: plan.resume!, interjection_id: 'i1', mode: 'after_ack' }, signal())!;
    const reply = '実は、来年の春までは今の、ということですね。';
    expect(resume.text).toBe(reply + plan.resume!.text);
    expect(resume.repeat).toEqual({ bridge_chars: plan.resume!.repeat!.bridge_chars + [...reply].length, restated_chars: plan.resume!.repeat!.restated_chars });
    expect(resume).toMatchObject({ turn_kind: 'resume', feed_turn: true, fed_interjection_ids: ['i1'], point_id: t.point_id });
    expect([...reply].length).toBeLessThanOrEqual(responsiveConfig().experience.responsive.reply_max_chars);
    expect(sink.ofType('two_ai.generation').at(-1)).toMatchObject({ turn_id: plan.resume!.turn_id, beat_id: null, prompt_version: 'reply_v1', stage: 'generated', feed_turn: true });
    const r = sink.ofType('two_ai.reflection').at(-1)!;
    expect(r.turn_kind).toBe('reply');
    expect(r.links.find((l) => l.item_id === null)).toMatchObject({ segment_ids: [22], offered: true, referenced: true });
    // 台帳に入った後（項目の id）→ 板の根拠
    await gen.ledgerIdle();
    await gen.boardIdle();
    expect(sink.ofType('two_ai.capture').filter((c) => c.stage === 'captured').map((c) => c.item_ids)).toEqual([['val_u22']]);
    expect(gen.generatedBoard()!.every((c) => c.ledger_item_ids.includes('val_u22'))).toBe(true);
    // 応答が作れなければ元の resume（時間切れ、相づち）
    const bc = gen.planInterjection({ interrupted_turn_id: t.turn_id, spoken_prefix: prefix, last_speaker: t.speaker, mode: 'after_ack' });
    gen.onInterjectionClosed({ interjection_id: 'i2', text: 'うん', asr_segment_ids: [8], classification: 'backchannel', during_point_id: null });
    expect(await gen.completeResume({ resume: bc.resume!, interjection_id: 'i2', mode: 'after_ack' }, signal())).toBe(bc.resume);
    expect(gen.completeResume({ resume: bc.resume!, interjection_id: 'i1', mode: 'false_onset' }, signal())).toBeNull();
  });

  it('点のブロック（取り違え、対照、C）の文と順は統制版と同じ', async () => {
    const plain = await runDiscussion((await readyRig({ condition: 'respond_on_spot', handlers: handlers() })).gen);
    const rig = await readyRig({ condition: 'respond_on_spot', config: responsiveConfig(), handlers: handlers() });
    play(rig.gen, await next(rig.gen));
    utter(rig.gen, 21, SAID_DISCUSSION, 'discussion', null);
    await rig.gen.ledgerIdle();
    const resp = await runDiscussion(rig.gen);
    const points = (ts: DiscussionTurn[]) => ts.filter((t) => t.point_id !== null).map((t) => `${t.point_id}:${t.origin.kind === 'point' ? t.origin.turn_key : ''}:${t.text}`);
    expect(points(resp.turns)).toEqual(points(plain.turns));
    expect(resp.turns.filter((t) => t.board_card !== null).map((t) => t.board_card!.order)).toEqual(plain.turns.filter((t) => t.board_card !== null).map((t) => t.board_card!.order));
  });

  it('訂正の後に作る板は訂正後の事実（取り違えた値を corrected_text に入れない）', async () => {
    const rig = await readyRig({ condition: 'respond_on_spot', config: responsiveConfig(), handlers: handlers() });
    const { gen, sink } = rig;
    let t = await next(gen);
    while (t.point_id === null) {
      play(gen, t);
      t = await next(gen);
    }
    play(gen, t);
    gen.applyCorrection(t.point_id!, 'woz_researcher', 'next_boundary', null);
    utter(gen, 23, SAID_RESPONSE, 'response', null);
    await gen.prepareClosing(signal());
    const input = sink.ofType('two_ai.board_generated').filter((b) => b.stage === 'generated').at(-1)!.input as unknown as BoardGenInput;
    expect(input.fact).toMatchObject({ state: 'corrected' });
    // プロンプトも訂正後の指示（取り違えた値を書かない）
    const call = rig.llm.callsOf('discussion_plan').filter((c) => c.system.includes(BOARD_GEN_MARKER)).at(-1)!;
    expect(call.system).toContain('取り違えを正した');
  });

  it('統制版：capture も reflection も板の生成もなく、任意の口は null', async () => {
    const rig = await readyRig({ condition: 'respond_on_spot', handlers: handlers() });
    const { gen, sink } = rig;
    const t = await next(gen);
    utter(gen, 21, SAID_DISCUSSION, 'discussion', 'i1');
    await gen.ledgerIdle();
    const plan = gen.planInterjection({ interrupted_turn_id: t.turn_id, spoken_prefix: [...t.text].slice(0, 5).join(''), last_speaker: t.speaker, mode: 'after_ack' });
    expect(gen.completeResume({ resume: plan.resume!, interjection_id: 'i1', mode: 'after_ack' }, signal())).toBeNull();
    expect(gen.prepareClosing(signal())).toBeNull();
    play(gen, t);
    play(gen, plan.resume!);
    await runDiscussion(gen);
    for (const name of ['two_ai.capture', 'two_ai.reflection', 'two_ai.board_generated'] as const) expect(sink.ofType(name)).toEqual([]);
    expect(rig.llm.callsOf('ledger').length).toBe(FICTIONAL.utterances.length);
  });
});

describe('板の生成の検査（board_gen.ts）', () => {
  const safety = loadSafetyLists(responsiveConfig().safety, REPO_ROOT);
  const input: BoardGenInput = {
    version: 'board_gen_v1',
    user_name: 'サトウ',
    aspect: 'どの道を選ぶか',
    personas: [],
    items: [
      { id: 'fact_1', kind: 'fact', text: 'インターンの締切は2月末', segment_ids: [4], said_in: 'intake' },
      { id: 'val_u9', kind: 'value', text: '家から通いたい', segment_ids: [9], said_in: 'response' },
    ],
    transcript: [],
    draft: [1, 2, 3, 4].map((order) => ({ card_id: `card_${order}`, order, discussion_stage: order as 1 | 2 | 3 | 4, depends_on: order === 1 ? ('fact_slip' as const) : ('none' as const), text: `下書き${order}`, corrected_text: `下書き${order}` })),
    fact: { slip_statement: 'インターンの締切は12月末', slip_value: '12月末', correct_statement: 'インターンの締切は2月末', state: 'slipped' },
    c_terms: [],
    max_chars: 40,
  };
  const card = (order: number, text: string, corrected = text, ids = ['val_u9']) => ({ order, text, corrected_text: corrected, ledger_item_ids: ids });

  it('合格：根拠の id と発話を持ち、取り違えに依らないカードは訂正後も同じ文', () => {
    const r = assembleGeneratedBoard(input, { cards: [card(1, '12月末までに書類を出す', '2月末までに書類を出す', ['fact_1']), card(2, '家から通える会社を調べる'), card(3, '一日の過ごし方を書く'), card(4, '通学の時間を測る')] }, safety);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.cards[0]).toMatchObject({ ledger_item_ids: ['fact_1'], segment_ids: [4], text: '12月末までに書類を出す', corrected_text: '2月末までに書類を出す' });
    expect(r.cards[1]).toMatchObject({ ledger_item_ids: ['val_u9'], segment_ids: [9], corrected_text: '家から通える会社を調べる' });
  });

  it('不合格：台帳にない id、訂正後の文に取り違えた値、長すぎる文、枚数の不足', () => {
    const r = assembleGeneratedBoard(input, { cards: [card(1, '書類を出す', '12月末までに書類を出す', ['fact_1']), card(2, 'x'.repeat(41)), card(3, '書く', '書く', ['nope'])] }, safety);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reasons.join('\n')).toMatch(/card 1 corrected: safety slip_value/u);
    expect(r.reasons.join('\n')).toMatch(/card 2: text 41 chars/u);
    expect(r.reasons.join('\n')).toMatch(/card 3: no valid ledger_item_ids/u);
    expect(r.reasons.join('\n')).toMatch(/card 4: missing/u);
  });

  it('参照の判定：共通の部分文字列の長さ', () => {
    expect(sharesSubstring('来年の春までは研究室にいたい、ということですね', '来年の春までは今の研究室を離れたくない', 5)).toBe(true);
    expect(sharesSubstring('なるほど、大事な点ですね', '来年の春までは今の研究室を離れたくない', 5)).toBe(false);
  });
});
