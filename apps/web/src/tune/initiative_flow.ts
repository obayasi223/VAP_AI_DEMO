/**
 * 発話希望の流れ（/tune）。起動（initiative の llm.request）→ LLM の判定 → 候補の状態、撤回、保留を時刻の順に並べる。
 * 規則は研究者画面（candidates_view.ts）と同じ: LLM の出力（reason、why_now、cost_of_waiting、urgency など）は
 * 「LLM 生成」の欄に分け、実測の時刻とコードの検証結果とは混ぜない。数値の「話したい度合い」はない（判定の種類だけ）。
 */
import type { EventOf, ResearchEvent } from '@llm-vap/contracts';
import { decisionRow, type DecisionRow } from '../research/candidates_view';

export type FlowRow =
  | {
      kind: 'request';
      key: string;
      t: number;
      request_id: string;
      transcript_revision: number;
      /** 起動の契機の推定（直前の STT が final か）。monitor の内部状態ではない。 */
      trigger_guess: string;
    }
  | { kind: 'decision'; key: string; t: number; row: DecisionRow }
  | { kind: 'state'; key: string; t: number; candidate_id: string; version: number; from: string | null; to: string; cause: string }
  | { kind: 'drop'; key: string; t: number; source: string; reason: string; held: boolean; candidate_id: string | null };

type Stt = EventOf<'stt.interim'> | EventOf<'stt.final'>;

export class InitiativeFlow {
  private readonly rows: FlowRow[] = [];
  private readonly sttByRevision = new Map<number, Stt>();
  private seq = 0;

  constructor(private readonly maxRows = 300) {}

  add(event: ResearchEvent): void {
    const t = event.t_monotonic_ms;
    switch (event.event) {
      case 'stt.interim':
      case 'stt.final':
        this.sttByRevision.set(event.transcript_revision, event);
        if (this.sttByRevision.size > 2000) this.sttByRevision.delete(this.sttByRevision.keys().next().value as number);
        return;
      case 'llm.request':
        if (event.purpose !== 'initiative') return;
        {
          const stt = this.sttByRevision.get(event.transcript_revision);
          const guess = stt === undefined ? '不明（STT が届く前）' : stt.event === 'stt.final' ? '確定（final）の後' : '安定文字の増分（interim）';
          this.push({ kind: 'request', key: `q${this.seq++}`, t: event.sent_at, request_id: event.request_id, transcript_revision: event.transcript_revision, trigger_guess: guess });
        }
        return;
      case 'initiative.decision':
        this.push({ kind: 'decision', key: `d${this.seq++}`, t: event.received_at, row: decisionRow(event, this.seq) });
        return;
      case 'candidate.state_changed':
        this.push({
          kind: 'state',
          key: `s${this.seq++}`,
          t,
          candidate_id: event.candidate_id,
          version: event.candidate_version,
          from: event.from,
          to: event.to,
          cause: event.cause_source === 'code' ? `コード: ${event.cause}` : `LLM の判定 ${event.decision}（${event.request_id}）`,
        });
        return;
      case 'initiative.discarded':
        this.push({ kind: 'drop', key: `x${this.seq++}`, t, source: 'G', reason: event.reason, held: event.reason.includes('post_turn_new_held'), candidate_id: event.candidate_id.value });
        return;
      case 'candidate.rejected':
        this.push({ kind: 'drop', key: `r${this.seq++}`, t, source: 'E2a', reason: [event.reason, ...event.details].join(' '), held: event.held, candidate_id: event.candidate_id.value });
        return;
      default:
        return;
    }
  }

  private push(row: FlowRow): void {
    this.rows.push(row);
    if (this.rows.length > this.maxRows) this.rows.shift();
  }

  /** 時刻の順（同時刻は届いた順）。 */
  list(): FlowRow[] {
    return [...this.rows].sort((a, b) => a.t - b.t);
  }
}

export function buildInitiativeFlow(events: ResearchEvent[]): FlowRow[] {
  const flow = new InitiativeFlow(5000);
  for (const e of events) flow.add(e);
  return flow.list();
}
