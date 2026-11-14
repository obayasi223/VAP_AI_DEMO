/**
 * 旗の比較（--compare-feeds。04 T4、05 §4、AC12(d)）。同じ本人の台本で、旗なしと旗ありの 2 本のログを並べる。
 * 各割り込みの後の最初の生のターン（旗ありでは feed_turn）の文、text_origin、c_ban_lifted、待った時間と、
 * 点のブロックの文と planned_exposure_ms が両方で同じか（AC12(d)）を feeds_compare.md に書く。
 */
import { mval, ofType, spokenText, twoAiSpeech, type TwoAiSessionData } from '../two_ai_report/session';

export interface FeedRow {
  interjection_id: string;
  turn_id: string | null;
  text: string | null;
  text_origin: string | null;
  feed_turn: boolean;
  c_ban_lifted: boolean;
  prompt_version: string | null;
  waited_ms: number | null;
}

export function feedRows(data: TwoAiSessionData): FeedRow[] {
  const turns = ofType(data.events, 'two_ai.turn');
  const gens = ofType(data.events, 'two_ai.generation');
  const speeches = twoAiSpeech(data.events, 'finished');
  return ofType(data.events, 'two_ai.interjection_episode')
    .filter((e) => e.two_ai?.phase === 'discussion')
    .map((ep) => {
      const after = ep.t_monotonic_ms;
      const started = turns.find((t) => t.stage === 'started' && t.turn_kind === 'discussion' && t.t_monotonic_ms >= Math.min(after, mval(ep.resumed_at) ?? after) && (t.feed_turn || !turns.some((x) => x.feed_turn)));
      const gen = started ? gens.find((g) => g.turn_id === started.turn_id) : undefined;
      const sp = started ? speeches.find((s) => s.turn_id === started.turn_id) : undefined;
      return {
        interjection_id: ep.interjection_id,
        turn_id: started?.turn_id ?? null,
        text: sp ? spokenText(sp) : null,
        text_origin: started?.text_origin ?? null,
        feed_turn: started?.feed_turn ?? false,
        c_ban_lifted: gen?.c_ban_lifted ?? false,
        prompt_version: gen?.prompt_version ?? null,
        waited_ms: started ? mval(started.waited_for_ready_ms) : null,
      };
    });
}

/** 点のブロックの文と計画の接触秒数（AC12(d)）。 */
export function pointBlock(data: TwoAiSessionData): Record<string, { texts: string[]; planned_exposure_ms: number | null }> {
  const out: Record<string, { texts: string[]; planned_exposure_ms: number | null }> = {};
  for (const pe of ofType(data.events, 'two_ai.point_exposure')) {
    const texts = twoAiSpeech(data.events, 'finished')
      .filter((s) => s.point_id === pe.point_id && (s.turn_kind === 'point' || s.turn_kind === 'point_elaboration') && s.event === 'speech.ended')
      .map(spokenText);
    out[pe.point_id] = { texts, planned_exposure_ms: mval(pe.planned_exposure_ms) };
  }
  return out;
}

export function compareFeeds(off: TwoAiSessionData, on: TwoAiSessionData): { markdown: string; points_identical: boolean; feed_section_ok: boolean } {
  const a = feedRows(off);
  const b = feedRows(on);
  const pa = pointBlock(off);
  const pb = pointBlock(on);
  const ids = [...new Set([...Object.keys(pa), ...Object.keys(pb)])];
  const identical = ids.every((id) => JSON.stringify(pa[id]) === JSON.stringify(pb[id]));
  // 偽の LLM で確かめられるのは「turn_v1_feed の節があり、本人の文が入っている」こと（04 T4）。
  const feedSectionOk = b.some((r) => r.feed_turn && (r.prompt_version ?? '').includes('feed'));
  const out = ['# 旗の比較（--compare-feeds）', '', `旗なし：${off.session_id}　旗あり：${on.session_id}`, '', '| 割り込み | 旗なしの次の生のターン | 旗ありの次の生のターン | 旗ありの text_origin | feed_turn | c_ban_lifted | 待った ms |', '|---|---|---|---|---|---|---|'];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i];
    const y = b[i];
    out.push(`| ${y?.interjection_id ?? x?.interjection_id ?? '—'} | ${x?.text ?? '—'} | ${y?.text ?? '—'} | ${y?.text_origin ?? '—'} | ${y?.feed_turn ?? '—'} | ${y?.c_ban_lifted ?? '—'} | ${y?.waited_ms ?? '—'} |`);
  }
  out.push('', `点のブロックの文と planned_exposure_ms が両方で同じ（AC12(d)）：${identical ? 'はい' : '**いいえ**'}`);
  out.push(`旗ありで turn_v1_feed の生成がある：${feedSectionOk ? 'はい' : '**いいえ**'}`, '');
  return { markdown: out.join('\n'), points_identical: identical, feed_section_ok: feedSectionOk };
}
