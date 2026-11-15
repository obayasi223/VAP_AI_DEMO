/**
 * 研究画面への配信の伏せ字（docs/design/two_ai/06 §4.6）。研究画面の WS とその backlog に流す前に呼ぶ。JSONL には元のまま書く。
 * hide_point_texts（台本の hide_points_on_research_screen）が真のとき：
 *  - two_ai.plan の plan は null（plan_hash と schedule_check は残す）。two_ai.safety_blocked の text は ''。
 *  - llm.request／llm.response で用途が discussion_plan・discussion_turn・correction_assist のものは配信しない。
 *  - speech.* の two_ai_turn で point_id を持つもの、turn_kind が rebuild・retraction のものの spoken_text は再生の後（ended／interrupted）だけ。
 *  - two_ai.board の各カードは trigger_turn_ended: false の間 text を ''。
 *  - two_ai.retraction の lines は []（script_sha256 は残す）。
 *  - two_ai.board_generated（応答版）の input は null、各カードの text と corrected_text は ''（板は two_ai.board で再生の後に出る）。
 *  - two_ai.stage は伏せない。偽のときは何も変えない。参加者画面へ送る two_ai.board には使わない。
 */
import type { ResearchEvent } from '@llm-vap/contracts';

export interface RedactionPolicy {
  hide_point_texts: boolean;
}

const HIDDEN_LLM_PURPOSES = new Set(['discussion_plan', 'discussion_turn', 'correction_assist']);
const SPEECH_TEXT_EVENTS = new Set(['speech.started', 'speech.ended', 'speech.interrupted']);
const AFTER_PLAYBACK = new Set(['speech.ended', 'speech.interrupted']);

type Loose = Record<string, unknown>;

export function redactForResearch(event: ResearchEvent, policy: RedactionPolicy): ResearchEvent | null {
  if (!policy.hide_point_texts) return event;
  const e = event as unknown as Loose;
  const name = e.event as string;
  if (name === 'llm.request' || name === 'llm.response') {
    return HIDDEN_LLM_PURPOSES.has(String(e.purpose)) ? null : event;
  }
  if (name === 'two_ai.plan') return { ...e, plan: null } as unknown as ResearchEvent;
  if (name === 'two_ai.safety_blocked') return { ...e, text: '' } as unknown as ResearchEvent;
  if (name === 'two_ai.retraction') return { ...e, lines: [] } as unknown as ResearchEvent;
  if (name === 'two_ai.board_generated') {
    const cards = (e.cards as Loose[] | undefined) ?? [];
    return { ...e, input: null, cards: cards.map((c) => ({ ...c, text: '', corrected_text: '' })) } as unknown as ResearchEvent;
  }
  if (name === 'two_ai.board') {
    const cards = (e.cards as Loose[] | undefined) ?? [];
    return { ...e, cards: cards.map((c) => (c.trigger_turn_ended === true ? c : { ...c, text: '' })) } as unknown as ResearchEvent;
  }
  if (SPEECH_TEXT_EVENTS.has(name) && e.origin === 'two_ai_turn') {
    const hidden = e.point_id !== null && e.point_id !== undefined ? true : e.turn_kind === 'rebuild' || e.turn_kind === 'retraction';
    // 再生の終わりの後（ended／interrupted）は文を出す。started は文を持たない。
    if (hidden && !AFTER_PLAYBACK.has(name) && 'spoken_text' in e) return { ...e, spoken_text: '' } as unknown as ResearchEvent;
    return event;
  }
  return event;
}
