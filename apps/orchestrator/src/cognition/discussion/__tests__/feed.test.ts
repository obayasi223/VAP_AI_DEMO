/** 体験の旗 interjection_feeds_generation（02 §3.7）。 */
import { describe, expect, it } from 'vitest';
import type { DiscussionTurn } from '../../../two_ai/content_port';
import type { DiscussionGenerator } from '../generator';
import { C_CORE_SHORT, readyRig, runDiscussion } from './helpers';

const signal = () => new AbortController().signal;
let seq = 0;
const next = (gen: DiscussionGenerator) => gen.nextTurn({ turn_id: `f${seq++}`, content_elapsed_ms: 0, discussion_elapsed_ms: 0 }, signal());
const play = (gen: DiscussionGenerator, t: DiscussionTurn) => gen.onTurnPlayed({ turn_id: t.turn_id, audio_playback_id: 1, spoken_text: t.text, played_ms: t.est_duration_ms, completed: true });
const SAID = '（架空）才能の話じゃなくて、締切の話なんです。';

describe('体験の旗（02 §3.7）', () => {
  it('旗 false：何も変えず、記録もしない', async () => {
    const rig = await readyRig({ condition: 'respond_on_spot', feeds: false });
    expect(rig.gen.onInterjectionClosed({ interjection_id: 'i1', text: SAID, asr_segment_ids: [1], classification: 'content', during_point_id: null })).toEqual({ invalidate_turn_ids: [], feed_target: null });
    expect(rig.sink.ofType('two_ai.interjection_fed')).toEqual([]);
    await runDiscussion(rig.gen);
    expect(rig.llm.callsOf('discussion_turn').some((c) => c.system.includes(SAID))).toBe(false);
    expect(rig.sink.ofType('two_ai.generation').every((e) => !e.feed_turn && !e.c_ban_lifted && e.fed_interjection_ids.length === 0)).toBe(true);
  });

  it('② では旗が true でも入らない', async () => {
    const rig = await readyRig({ condition: 'respond_at_end', feeds: true });
    expect(rig.gen.onInterjectionClosed({ interjection_id: 'i1', text: SAID, asr_segment_ids: [1], classification: 'content', during_point_id: null }).feed_target).toBeNull();
  });

  it('点の外：準備済みの次の生のターンを取り消し、同じ位置で turn_v1_feed の feed_turn として作り直す。割り込みの前の (d) に本人の発言はない', async () => {
    const rig = await readyRig({ condition: 'respond_on_spot', feeds: true });
    const t0 = await next(rig.gen);
    play(rig.gen, t0);
    // F のブロック（点）を進める
    let t = await next(rig.gen);
    while (t.point_id !== null) {
      play(rig.gen, t);
      t = await next(rig.gen);
    }
    const before = rig.llm.callsOf('discussion_turn').length;
    expect(rig.llm.callsOf('discussion_turn').some((c) => c.system.includes(SAID))).toBe(false);
    const r = rig.gen.onInterjectionClosed({ interjection_id: 'i1', text: SAID, asr_segment_ids: [3], classification: 'content', during_point_id: null });
    expect(r).toEqual({ invalidate_turn_ids: [t.turn_id], feed_target: 'next_live_turn' });
    const again = await next(rig.gen);
    expect(again).toMatchObject({ index: t.index, feed_turn: true, fed_interjection_ids: ['i1'] });
    const call = rig.llm.callsOf('discussion_turn').slice(before).find((c) => c.system.includes('# このターンでは'))!;
    expect(call.system).toContain('# このターンでは');
    expect(call.system).toContain(SAID);
    expect(call.system).not.toContain('次の見方を持ち出す');
    expect(rig.sink.ofType('two_ai.generation').at(-1)).toMatchObject({ prompt_version: 'turn_v1_feed', feed_turn: true, c_ban_lifted: true });
    expect(rig.gen.framingState('A').state.fed_interjections).toBe(1);
  });

  it('C のブロックの途中：C の文と文字数は旗 false と同じで、ブロックの後の最初の生のターンが feed_turn', async () => {
    const plain = await runDiscussion((await readyRig({ condition: 'respond_on_spot' })).gen);
    const rig = await readyRig({ condition: 'respond_on_spot', feeds: true });
    const turns: DiscussionTurn[] = [];
    for (;;) {
      const t = await next(rig.gen);
      turns.push(t);
      if (t.origin.kind === 'point' && t.origin.turn_key === 'C.1') {
        const r = rig.gen.onInterjectionClosed({ interjection_id: 'i9', text: SAID, asr_segment_ids: [9], classification: 'content', during_point_id: 'C1' });
        expect(r).toEqual({ invalidate_turn_ids: [], feed_target: 'after_point_block' });
      }
      play(rig.gen, t);
      if (t.point_id === null && turns.some((x) => x.origin.kind === 'point' && x.origin.turn_key === 'C.2')) break;
    }
    const cTexts = (ts: DiscussionTurn[]) => ts.filter((t) => t.point_id === 'C1').map((t) => t.text);
    expect(cTexts(turns)).toEqual(cTexts(plain.turns));
    expect(turns.at(-1)!.feed_turn).toBe(true);
    expect(turns.filter((t) => t.feed_turn).length).toBe(1);
  });

  it('相づちと安全に当たる発言は入れず、理由を記録する', async () => {
    const rig = await readyRig({ condition: 'respond_on_spot', feeds: true });
    rig.gen.onInterjectionClosed({ interjection_id: 'i1', text: 'うん', asr_segment_ids: [1], classification: 'backchannel', during_point_id: null });
    rig.gen.onInterjectionClosed({ interjection_id: 'i2', text: '最近は体調がよくなくて。', asr_segment_ids: [2], classification: 'content', during_point_id: null });
    const fed = rig.sink.ofType('two_ai.interjection_fed');
    expect(fed.map((e) => [e.accepted, e.excluded_reason])).toEqual([
      [false, 'backchannel'],
      [false, 'safety_banned_term'],
    ]);
  });

  it('旗 true：C の語を含む生成文は安全の検査で止まらない', async () => {
    const text = `${C_CORE_SHORT}の話も、締切の話と分けて考えたいです。二人で順番に考えてみたいと思います。`;
    const rig = await readyRig({ condition: 'respond_on_spot', feeds: true, handlers: { discussion_turn: () => ({ text }) } });
    const t = await next(rig.gen);
    expect(t.text_origin).toBe('llm');
    const off = await readyRig({ condition: 'respond_on_spot', feeds: false, handlers: { discussion_turn: () => ({ text }) } });
    expect((await next(off.gen)).text_origin).toBe('fallback');
  });
});
