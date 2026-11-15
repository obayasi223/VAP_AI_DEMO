/**
 * 取得と反映（応答版。--coding の coding_uptake.csv）。本人の発話 1 つに 1 行：台帳に入ったか（two_ai.capture）、
 * どのターンの資料になり参照されたか（two_ai.reflection）、最後に生成した板のどのカードの根拠か（two_ai.board_generated）。
 * 材料は events.jsonl だけ。本文は入れない（text_ref は coding_utterances.csv と同じ stt:<asr_segment_id>）。統制版では行がない。
 */
import { blindCode } from './coding';
import { ofType, type TwoAiSessionData } from './session';

export const UPTAKE_COLUMNS = [
  'session_id', 'condition', 'segment_id', 'asr_segment_id', 'phase', 'interjection_id', 'capture_stage', 'capture_reason', 'ledger_version', 'item_ids',
  'n_turns_offered', 'n_turns_referenced', 'offered_turn_ids', 'referenced_turn_ids', 'board_id', 'board_trigger', 'board_card_ids', 'chars', 'text_ref',
] as const;

export function buildUptake(data: TwoAiSessionData, options: { blind?: boolean; blindSalt?: string } = {}): Record<string, unknown>[] {
  const captures = ofType(data.events, 'two_ai.capture');
  if (captures.length === 0) return [];
  const blind = options.blind ?? false;
  const sessionId = blind ? blindCode(data.session_id, options.blindSalt) : data.session_id;
  const cond = blind ? '' : (data.two_ai?.condition ?? data.events[0]?.condition ?? '');
  const finals = ofType(data.events, 'stt.final');
  const reflections = ofType(data.events, 'two_ai.reflection');
  const board = ofType(data.events, 'two_ai.board_generated').filter((b) => b.stage === 'generated').at(-1) ?? null;
  const segs = [...new Set(captures.map((c) => c.segment_id))];
  return segs.map((seg) => {
    const mine = captures.filter((c) => c.segment_id === seg);
    // 受け取りのあとの最後の判定（なければ受け取りのまま）
    const last = mine.filter((c) => c.stage !== 'received').at(-1) ?? mine.at(-1)!;
    const items = last.item_ids;
    const touches = (l: { item_id: string | null; segment_ids: number[] }) => l.segment_ids.includes(seg) || (l.item_id !== null && items.includes(l.item_id));
    const offered = reflections.filter((r) => r.links.some((l) => l.offered && touches(l))).map((r) => r.turn_id);
    const referenced = reflections.filter((r) => r.links.some((l) => l.referenced && touches(l))).map((r) => r.turn_id);
    const cards = board === null ? [] : board.cards.filter((c) => c.segment_ids.includes(seg) || c.ledger_item_ids.some((id) => items.includes(id))).map((c) => c.card_id);
    const f = finals.find((x) => x.segment_id === seg) ?? null;
    const ref = f === null ? null : blind ? `${sessionId}:stt:${f.asr_segment_id}` : `stt:${f.asr_segment_id}`;
    return {
      session_id: sessionId,
      condition: cond,
      segment_id: seg,
      asr_segment_id: f?.asr_segment_id ?? null,
      phase: last.phase,
      interjection_id: mine.map((c) => c.interjection_id).find((x) => x !== null) ?? null,
      capture_stage: last.stage,
      capture_reason: last.reason,
      ledger_version: last.ledger_version,
      item_ids: items.join(';'),
      n_turns_offered: offered.length,
      n_turns_referenced: referenced.length,
      offered_turn_ids: offered.join(';'),
      referenced_turn_ids: referenced.join(';'),
      board_id: board?.board_id ?? null,
      board_trigger: board?.trigger ?? null,
      board_card_ids: cards.join(';'),
      chars: last.chars,
      text_ref: ref,
    };
  });
}
