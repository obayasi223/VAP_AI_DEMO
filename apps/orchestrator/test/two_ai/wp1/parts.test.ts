/** WP1 の小さな部品：研究画面の伏せ字、受け止めの保持、readVapUser、共有の再生の番号。 */
import { ScriptedTtsProvider } from '@llm-vap/testkit';
import type { ResearchEvent } from '@llm-vap/contracts';
import { describe, expect, it } from 'vitest';
import { readVapUser } from '../../../src/control/vap_direction';
import { SharedPlaybackCounters } from '../../../src/speech/shared_counters';
import { createAckBank } from '../../../src/two_ai/ack_bank';
import { redactForResearch } from '../../../src/two_ai/research_redaction';

const ev = (o: Record<string, unknown>) => o as unknown as ResearchEvent;
const on = { hide_point_texts: true };

describe('redactForResearch（06 §4.6）', () => {
  it('偽のときは何も変えない', () => {
    const e = ev({ event: 'two_ai.retraction', lines: [{ text: 'x' }] });
    expect(redactForResearch(e, { hide_point_texts: false })).toBe(e);
  });
  it('計画、撤回、未終了の板のカード、生成の LLM を伏せる', () => {
    expect(redactForResearch(ev({ event: 'two_ai.plan', plan: { a: 1 }, plan_hash: 'h' }), on)).toMatchObject({ plan: null, plan_hash: 'h' });
    expect(redactForResearch(ev({ event: 'two_ai.retraction', lines: [{ text: 'x' }], script_sha256: 's' }), on)).toMatchObject({ lines: [], script_sha256: 's' });
    const board = redactForResearch(ev({ event: 'two_ai.board', cards: [{ text: 'a', trigger_turn_ended: true }, { text: 'b', trigger_turn_ended: false }] }), on) as unknown as { cards: { text: string }[] };
    expect(board.cards.map((c) => c.text)).toEqual(['a', '']);
    expect(redactForResearch(ev({ event: 'llm.request', purpose: 'discussion_turn' }), on)).toBeNull();
    expect(redactForResearch(ev({ event: 'llm.request', purpose: 'intake' }), on)).not.toBeNull();
  });
  it('点の発話の文は再生の終わり（ended）まで出さない。点でない発話は伏せない', () => {
    const begin = { origin: 'two_ai_turn', point_id: 'fact1', turn_kind: 'point', spoken_text: '文' };
    expect(redactForResearch(ev({ event: 'speech.started', ...begin }), on)).toMatchObject({ spoken_text: '' });
    expect(redactForResearch(ev({ event: 'speech.ended', ...begin }), on)).toMatchObject({ spoken_text: '文' });
    expect(redactForResearch(ev({ event: 'speech.started', origin: 'two_ai_turn', point_id: null, turn_kind: 'discussion', spoken_text: '文' }), on)).toMatchObject({ spoken_text: '文' });
  });
});

describe('AckBank', () => {
  it('両方の声で合成して保持し、受け止めを順に回す。manifest には文のハッシュだけ', async () => {
    const tts = { A: new ScriptedTtsProvider({ ms_per_char: 100, chars_per_chunk: 2 }), B: new ScriptedTtsProvider({ ms_per_char: 100, chars_per_chunk: 2 }) };
    const conn = { A: await tts.A.open({ preferred_sample_rate_hz: 16000 }), B: await tts.B.open({ preferred_sample_rate_hz: 16000 }) };
    const pump = setInterval(() => {
      for (const p of [tts.A, tts.B]) for (const c of p.connections) for (const ctx of c.contexts) ctx.pumpAll();
    }, 1);
    const bank = createAckBank({ ack_ids: ['ack_1', 'ack_2'], selection: 'round_robin' } as never);
    try {
      await bank.synthesize(
        [
          { id: 'ack_1', text: 'はい。' },
          { id: 'ack_2', text: 'なるほど。' },
          { id: 'hold_bridge', text: '少しお待ちください。' },
        ],
        conn as never,
      );
    } finally {
      clearInterval(pump);
    }
    expect(bank.get('A', 'ack_2').text).toBe('なるほど。');
    expect(bank.get('B', 'hold_bridge').samples).toBeGreaterThan(0);
    const order = [bank.nextTemplateId('A'), bank.nextTemplateId('A'), bank.nextTemplateId('A')];
    expect(new Set(order)).toEqual(new Set(['ack_1', 'ack_2']));
    const entries = bank.manifestEntries();
    expect(entries.map((e) => e.id)).toEqual(expect.arrayContaining(['ack_1', 'ack_2']));
    expect(JSON.stringify(entries)).not.toContain('なるほど');
  });
});

describe('readVapUser と SharedPlaybackCounters', () => {
  it('readVapUser は AI でない側の p を読む', () => {
    const vap = { p_now: [0.1, 0.9], p_future: [0.2, 0.8], vad: [0.7, 0.3] } as never;
    expect(readVapUser(vap, { p_ai_index: 1 } as never)).toMatchObject({ p_now_user: 0.1, p_future_user: 0.2 });
    expect(readVapUser(vap, { p_ai_index: 0 } as never)).toMatchObject({ p_now_user: 0.9, p_future_user: 0.8 });
  });
  it('2 つのスロットで再生の番号と世代を共有する', () => {
    const c = new SharedPlaybackCounters(1);
    expect([c.nextPlaybackId(), c.nextPlaybackId()]).toEqual([1, 2]);
    const g = c.generation;
    c.bumpGeneration();
    expect(c.generation).toBe(g + 1);
  });
});
