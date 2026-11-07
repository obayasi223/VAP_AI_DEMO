/**
 * 候補イベントのライブ表示の中身（I2）。initiative.decision と candidate.state_changed を表の行にする。
 * 規則: モデル出力（ModelOutput）と、実測の時刻・コードの検証結果（Verified）を別の欄に分ける。
 * 画面はモデル出力の欄に「LLM 生成」と必ず書く（判定に使っていない文で、事実ではない）。
 */
import type { EventOf, ResearchEvent } from '@llm-vap/contracts';

type Decision = EventOf<'initiative.decision'>;
type StateChange = EventOf<'candidate.state_changed'>;

/** モデル出力の 1 項目。値がなければ理由。 */
export interface ModelText {
  label: string;
  value: string | null;
  null_reason: string | null;
}

export interface DecisionRow {
  key: string;
  decision: Decision['decision'];
  candidate_id: string | null;
  candidate_version: number | null;
  request_id: string;
  segment_id: number;
  transcript_revision: number;
  /** 実測（orchestrator の時計）。 */
  measured: {
    sent_at: number;
    received_at: number;
    llm_ms: number;
    /** decided_at／updated_at／withdrawn_at。NONE は持たない。 */
    decision_time: { name: string; t_ms: number } | null;
  };
  /** コードの検証結果。 */
  verified: { label: string; value: string; method: string }[];
  /** LLM 生成。 */
  model: ModelText[];
  model_version: string;
}

export interface StateChangeRow {
  key: string;
  t_ms: number;
  candidate_id: string;
  candidate_version: number;
  from: string | null;
  to: string;
  /** コード由来の cause か、モデルの判断（decision と request_id）か。 */
  cause: { source: 'code'; cause: string } | { source: 'model_decision'; decision: string; request_id: string };
}

export interface CandidateNow {
  candidate_id: string;
  candidate_version: number;
  state: string;
  since_ms: number;
}

export interface CandidateSummary {
  decisions: DecisionRow[];
  state_changes: StateChangeRow[];
  current: CandidateNow[];
  counts: Record<string, number>;
  discarded: number;
  aborted: number;
}

const MAX_ROWS = 40;

function modelText(label: string, value: { value: string | null; null_reason?: string }): ModelText {
  return { label, value: value.value, null_reason: value.value === null ? (value.null_reason ?? '理由なし') : null };
}

export function decisionRow(event: Decision, index: number): DecisionRow {
  const base = {
    key: `${event.request_id}/${event.decision}/${index}`,
    decision: event.decision,
    request_id: event.request_id,
    segment_id: event.segment_id,
    transcript_revision: event.transcript_revision,
    model_version: event.model_version,
  };
  const measured = (decision_time: DecisionRow['measured']['decision_time']) => ({
    sent_at: event.sent_at,
    received_at: event.received_at,
    llm_ms: event.received_at - event.sent_at,
    decision_time,
  });
  switch (event.decision) {
    case 'NONE':
      return {
        ...base,
        candidate_id: null,
        candidate_version: null,
        measured: measured(null),
        verified: [],
        model: [modelText('理由', event.reason)],
      };
    case 'KEEP':
      return {
        ...base,
        candidate_id: event.candidate_id,
        candidate_version: event.candidate_version,
        measured: measured({ name: 'updated_at', t_ms: event.updated_at }),
        verified: [{ label: '根拠の検証', value: event.evidence_valid.value ? '合格' : '不合格', method: event.evidence_valid.method }],
        model: [modelText('理由', event.reason)],
      };
    case 'WITHDRAW':
      return {
        ...base,
        candidate_id: event.candidate_id,
        candidate_version: event.candidate_version,
        measured: measured({ name: 'withdrawn_at', t_ms: event.withdrawn_at }),
        verified: [
          {
            label: '撤回の根拠の区間',
            value: event.withdraw_evidence_segment_ids.value.join(', '),
            method: event.withdraw_evidence_segment_ids.method,
          },
        ],
        model: [modelText('撤回の理由', event.withdraw_reason)],
      };
    case 'NEW':
    case 'REVISE':
      return {
        ...base,
        candidate_id: event.candidate_id,
        candidate_version: event.candidate_version,
        measured: measured(
          event.decision === 'NEW'
            ? { name: 'decided_at', t_ms: event.decided_at }
            : { name: 'updated_at', t_ms: event.updated_at },
        ),
        verified: [
          { label: '根拠の検証', value: event.evidence_valid.value ? '合格' : '不合格', method: event.evidence_valid.method },
          { label: '根拠の区間', value: event.evidence_segment_ids.value.join(', ') || 'なし', method: event.evidence_segment_ids.method },
        ],
        model: [
          modelText('根拠の断片', event.evidence_span),
          modelText('理由', event.reason),
          modelText('なぜ今', event.why_now),
          modelText('待つ損失', event.cost_of_waiting),
          modelText('発話案', event.proposed_utterance),
          modelText('意図の種類', event.intent_type),
          modelText('緊急度（判定に使わない）', event.urgency),
          modelText('期限の方針', event.expiry_policy),
        ],
      };
  }
}

export class CandidateTracker {
  private readonly decisions: DecisionRow[] = [];
  private readonly changes: StateChangeRow[] = [];
  private readonly current = new Map<string, CandidateNow>();
  private readonly counts: Record<string, number> = {};
  private discarded = 0;
  private aborted = 0;
  private seq = 0;

  add(event: ResearchEvent): void {
    switch (event.event) {
      case 'initiative.decision':
        this.counts[event.decision] = (this.counts[event.decision] ?? 0) + 1;
        this.decisions.unshift(decisionRow(event, this.seq++));
        if (this.decisions.length > MAX_ROWS) this.decisions.length = MAX_ROWS;
        break;
      case 'candidate.state_changed':
        this.addChange(event);
        break;
      case 'initiative.discarded':
        this.discarded += 1;
        break;
      case 'initiative.aborted':
        this.aborted += 1;
        break;
      default:
        break;
    }
  }

  private addChange(event: StateChange): void {
    this.changes.unshift({
      key: `${event.candidate_id}/${event.candidate_version}/${this.seq++}`,
      t_ms: event.t_monotonic_ms,
      candidate_id: event.candidate_id,
      candidate_version: event.candidate_version,
      from: event.from,
      to: event.to,
      cause:
        event.cause_source === 'code'
          ? { source: 'code', cause: event.cause }
          : { source: 'model_decision', decision: event.decision, request_id: event.request_id },
    });
    if (this.changes.length > MAX_ROWS) this.changes.length = MAX_ROWS;
    this.current.set(event.candidate_id, {
      candidate_id: event.candidate_id,
      candidate_version: event.candidate_version,
      state: event.to,
      since_ms: event.t_monotonic_ms,
    });
  }

  summary(): CandidateSummary {
    return {
      decisions: this.decisions.slice(),
      state_changes: this.changes.slice(),
      // 終わった候補（SPOKEN、WITHDRAWN）は「いま」の欄に出さない。履歴は state_changes にある。
      current: [...this.current.values()].filter((c) => c.state !== 'SPOKEN' && c.state !== 'WITHDRAWN'),
      counts: { ...this.counts },
      discarded: this.discarded,
      aborted: this.aborted,
    };
  }
}
