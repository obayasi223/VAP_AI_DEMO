/**
 * 条件の間の一致の試験（02 §5、この設計の要）。同じ計画で、② の通しと、① の通し（割り込みを乱数で 0〜6 回、点の中、
 * 誤った停止、AI 同士の間を含む）を進行役の模擬で走らせる。① の割り込みは偽の壁時計だけを進め、中身の時計は 06 §6.0 で数える。
 * (1) 訂正のない ① の列から resume を除くと ② の列と一致。(2) 点の開始の拍、段の境界、カードのターンが同じ。
 * (3) 点のブロックの文と文字数が同じ。(4) 訂正のある ① では、uptake の前までは同じ、後は訂正後の版（段の境界とカードの順は同じ）。
 * 旗 false だけで行う（02 §3.7）。
 */
import { describe, expect, it } from 'vitest';
import type { DiscussionTurn } from '../../../two_ai/content_port';
import { SLIP_STATEMENT, SLIP_VALUE, readyRig, runDiscussion, signature, testScript, type Interjection } from './helpers';

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

function randomInterjections(r: () => number, n: number): Interjection[] {
  const count = Math.floor(r() * 7);
  const out: Interjection[] = [];
  for (let i = 0; i < count; i++) {
    const at = Math.floor(r() * n);
    if (out.some((x) => x.at === at)) continue;
    out.push({ at, prefix_chars: r() < 0.2 ? 0 : 1 + Math.floor(r() * 40), mode: r() < 0.25 ? 'false_onset' : 'after_ack' });
  }
  return out;
}

const structure = (t: DiscussionTurn) => [t.speaker, t.turn_kind, t.point_id ?? '-', t.discussion_stage, t.board_card?.order ?? '-', t.index, t.gap_hint_ms].join('|');

describe('条件の間の一致（200 回）', () => {
  it('訂正のない ① の列から resume を除くと ② の列と一致する', async () => {
    const two = await runDiscussion((await readyRig({ condition: 'respond_at_end' })).gen);
    const expected = two.turns.map(signature);
    const r = rng(20261116);
    for (let run = 0; run < 200; run++) {
      const ij = randomInterjections(r, two.turns.length);
      const { gen } = await readyRig({ condition: 'respond_on_spot' });
      const one = await runDiscussion(gen, { interjections: ij });
      expect(one.turns.map(signature), `run ${run} ${JSON.stringify(ij)}`).toEqual(expected);
      // resume は割り込みの数を超えない（AI 同士の間と、最後まで声に出ていた回は resume なし）
      expect(one.resumes.length).toBeLessThanOrEqual(ij.length);
      expect(one.content_ms).toBe(two.content_ms);
    }
  }, 120_000);

  it('at_frac の台本でも、点の開始の拍が両条件で同じ（中身の時計で数える）', async () => {
    const script = testScript((s) => {
      s.planned_points = s.planned_points.map((p: any) => (p.kind === 'framing_C' ? { ...p, trigger: { at_frac: 0.45 } } : p.kind === 'control_inference' ? { ...p, trigger: { in_stage: 2, after_stage_turn: 2 } } : p));
    });
    const two = await runDiscussion((await readyRig({ script })).gen);
    const r = rng(7);
    for (let run = 0; run < 20; run++) {
      const one = await runDiscussion((await readyRig({ script, condition: 'respond_on_spot' })).gen, { interjections: randomInterjections(r, two.turns.length) });
      expect(one.turns.map(signature)).toEqual(two.turns.map(signature));
    }
  });

  it('訂正のある ①：uptake の前は同じ、後は訂正後の版。段の境界とカードの順は同じ', async () => {
    const two = await runDiscussion((await readyRig()).gen);
    const r = rng(99);
    for (let run = 0; run < 30; run++) {
      const fKeys = ['F.0', 'F.1', 'F.2'];
      const target = fKeys[Math.floor(r() * 3)]!;
      const prefix = 1 + Math.floor(r() * 10);
      let correctedAt = -1;
      let uptakeText = '';
      // 訂正の通しは手で回す（F のターンの途中で止めて訂正する）
      const { gen: g2 } = await readyRig({ condition: 'respond_on_spot' });
      const turns: DiscussionTurn[] = [];
      let content = 0;
      for (let i = 0; i < 500; i++) {
        if (g2.isDone('discussion', { elapsed_ms: 0, content_elapsed_ms: content })) break;
        const t = await g2.nextTurn({ turn_id: `c${i}`, content_elapsed_ms: content, discussion_elapsed_ms: content }, new AbortController().signal);
        turns.push(t);
        // 中身の時計（訂正後の版は ±15% の長さの差があるので、元の版の見込みで数えて ② にそろえる）
        content += t.gap_hint_ms + (two.turns[i]?.est_duration_ms ?? t.est_duration_ms);
        if (correctedAt < 0 && t.origin.kind === 'point' && t.origin.turn_key === target) {
          g2.onTurnPlayed({ turn_id: t.turn_id, audio_playback_id: i, spoken_text: [...t.text].slice(0, prefix).join(''), played_ms: 200, completed: false });
          const res = g2.applyCorrection('F1', 'woz_researcher', 'in_window', t.turn_id);
          expect(res.drop_resume).toBe(true);
          correctedAt = i;
          uptakeText = res.uptake.text;
          continue;
        }
        g2.onTurnPlayed({ turn_id: t.turn_id, audio_playback_id: i, spoken_text: t.text, played_ms: t.est_duration_ms, completed: true });
      }
      expect(uptakeText).not.toBe('');
      expect(turns.slice(0, correctedAt + 1).map(signature)).toEqual(two.turns.slice(0, correctedAt + 1).map(signature));
      expect(turns.map(structure)).toEqual(two.turns.map(structure));
      for (const t of turns.slice(correctedAt + 1)) {
        expect(t.text.includes(SLIP_STATEMENT) || t.text.includes(SLIP_VALUE)).toBe(false);
        if (t.point_id !== null) expect(t.point_variant).toBe('corrected');
      }
    }
  });

  it('点のブロックの文と文字数が条件で同じ', async () => {
    const a = await runDiscussion((await readyRig()).gen);
    const b = await runDiscussion((await readyRig({ condition: 'respond_on_spot' })).gen, { interjections: [{ at: 2, prefix_chars: 5, mode: 'after_ack' }] });
    const pts = (x: typeof a) => x.turns.filter((t) => t.point_id !== null).map((t) => `${t.point_id}:${t.text}:${[...t.text].length}`);
    expect(pts(b)).toEqual(pts(a));
  });
});
