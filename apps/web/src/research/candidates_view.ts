/**
 * 候補イベントのライブ表示の中身（I2）。initiative.decision（1段判定）、initiative.desire と initiative.timing（二段判定）と
 * candidate.state_changed を表の行にする。
 * 棄てた判定（initiative.discarded は G のゲート、candidate.rejected は E2a）は理由つきで別の表にする（波2で追加）。
 * 規則: モデル出力（ModelOutput）と、実測の時刻・コードの検証結果（Verified）を別の欄に分ける。
 * 画面はモデル出力の欄に「LLM 生成」と必ず書く（判定に使っていない文で、事実ではない）。
 */
import type { EventOf, ResearchEvent } from '@llm-vap/contracts';

type Decision = EventOf<'initiative.decision'>;
type Desire = EventOf<'initiative.desire'>;
type Timing = EventOf<'initiative.timing'>;
type StateChange = EventOf<'candidate.state_changed'>;
type Discarded = EventOf<'initiative.discarded'>;
type Rejected = EventOf<'candidate.rejected'>;

/** モデル出力の 1 項目。値がなければ理由。 */
export interface ModelText {
  label: string;
  value: string | null;
  null_reason: string | null;
}

export interface DecisionRow {
  key: string;
  /** initiative.decision の5値、生成段の NONE／NEW／REVISE、タイミング段の OFFER_NOW／WAIT_FOR_TURN_END／WITHDRAW。 */
  decision: string;
  /** どの判定の行か。 */
  stage: 'v2' | 'desire' | 'timing';
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
  /** false は LLM を呼ばない判定（immediate）。実測の LLM の時間はなく、model は空。 */
  model_call: boolean;
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

/** 棄てた判定の1行。理由はコードの値で、モデルの説明文ではない。 */
export interface DropRow {
  key: string;
  t_ms: number;
  /** initiative.discarded（G のゲート、判定の失敗、E2a の拒否の写し）か candidate.rejected（E2a）か。 */
  source: 'initiative.discarded' | 'candidate.rejected';
  reason: string;
  candidate_id: string | null;
  /** candidate.rejected の operation（NEW、KEEP、transition など）。 */
  operation: string | null;
  details: string[];
  /** 棄てずに保留した（話の後の NEW）。 */
  held: boolean;
}

/** 候補に関する、状態の遷移にならない出来事（持ち越し、材料、反映の推定、すでに話した内容の撤回、合図への反応、発話の選択）。 */
export interface CandidateNoteRow {
  key: string;
  t_ms: number;
  /** どの出来事か（表示用の語）。 */
  kind: string;
  /** コードの実測・検証の値。 */
  detail: string;
  /** LLM が書いた文があるとき。画面で「LLM 生成」と明示する。 */
  model_text: string | null;
  candidate_id: string | null;
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
  /** E2a の拒否の件数（candidate.rejected と、それを出さない active_candidate_exists）。 */
  /* discarded は G の棄却だけ（E2a の拒否の写し e2a_rejected: は数えない）。 */
  rejected: number;
  /** 新しい順。 */
  drops: DropRow[];
  /** 候補の周辺の出来事（新しい順）。 */
  notes: CandidateNoteRow[];
}

const MAX_ROWS = 40;

function modelText(label: string, value: { value: string | null; null_reason?: string }): ModelText {
  return { label, value: value.value, null_reason: value.value === null ? (value.null_reason ?? '理由なし') : null };
}

function gateVerified(gate: Desire['gate']): DecisionRow['verified'][number] {
  return { label: 'ゲート', value: gate.value.passed ? '合格' : `不合格（${gate.value.reasons.join(', ')}）`, method: gate.method };
}

function outcomeVerified(outcome: string, ledger_reason: { value: string | null }): DecisionRow['verified'][number] {
  return { label: '結果', value: ledger_reason.value === null ? outcome : `${outcome}（${ledger_reason.value}）`, method: 'candidate_ledger' };
}

export function desireRow(event: Desire, index: number): DecisionRow {
  const segments = event.evidence_segment_ids.value;
  return {
    key: `${event.request_id}/${event.desire}/${index}`,
    decision: event.desire,
    stage: 'desire',
    candidate_id: event.candidate_id.value,
    candidate_version: event.candidate_version.value,
    request_id: event.request_id,
    segment_id: event.segment_id,
    transcript_revision: event.transcript_revision,
    model_version: event.model_version,
    model_call: true,
    measured: { sent_at: event.sent_at, received_at: event.received_at, llm_ms: event.latency_ms, decision_time: null },
    verified: [
      gateVerified(event.gate),
      outcomeVerified(event.outcome, event.ledger_reason),
      ...(segments === null ? [] : [{ label: '根拠の区間', value: segments.value.join(', ') || 'なし', method: segments.method }]),
    ],
    model: [
      modelText('理由', event.reason),
      modelText('発話案', event.proposed_utterance),
      modelText('根拠の断片', event.evidence_span),
      modelText('過去のターンの根拠', event.prior_turn_evidence_span),
      modelText('意図の種類', event.intent_type),
    ],
  };
}

export function timingRow(event: Timing, index: number): DecisionRow {
  const common = {
    decision: event.timing,
    stage: 'timing' as const,
    candidate_id: event.candidate_id,
    candidate_version: event.candidate_version,
    segment_id: event.segment_id,
    transcript_revision: event.transcript_revision,
  };
  if (event.timing_strategy === 'immediate') {
    return {
      ...common,
      key: `${event.desire_request_id}/immediate/${index}`,
      request_id: event.desire_request_id,
      model_version: 'コードの判定（LLM なし）',
      model_call: false,
      measured: { sent_at: event.decided_at, received_at: event.decided_at, llm_ms: 0, decision_time: { name: 'decided_at', t_ms: event.decided_at } },
      verified: [outcomeVerified(event.outcome, event.ledger_reason)],
      model: [],
    };
  }
  return {
    ...common,
    key: `${event.request_id}/${event.timing}/${index}`,
    request_id: event.request_id,
    model_version: event.model_version,
    model_call: true,
    measured: { sent_at: event.sent_at, received_at: event.received_at, llm_ms: event.latency_ms, decision_time: null },
    verified: [gateVerified(event.gate), outcomeVerified(event.outcome, event.ledger_reason)],
    model: [
      modelText('理由', event.reason),
      modelText('なぜ今', event.why_now),
      modelText('待つ損失', event.cost_of_waiting),
      modelText('撤回の理由', event.withdraw_reason),
    ],
  };
}

export function decisionRow(event: Decision, index: number): DecisionRow {
  const base = {
    stage: 'v2' as const,
    model_call: true,
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
        model: [modelText('撤回の理由', event.withdraw_reason), modelText('理由', event.reason)],
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

function reflectionDetail(event: EventOf<'initiative.response_reflection'>): string {
  const estimate = event.estimate.value;
  const parts = [`話した: ${event.spoken_outcome}`];
  if (event.estimated_reflected.value !== null) parts.push(`推定 ${event.estimated_reflected.value ? '一致あり' : '一致なし'}`);
  if (estimate !== null) parts.push(`包含率 ${estimate.containment.toFixed(2)}／基準 ${estimate.threshold}`);
  return parts.join('、');
}

function cueReactionDetail(event: EventOf<'negotiation.cue_reaction'>): string {
  const stop = event.time_to_user_stop_ms.value;
  const start = event.time_to_user_start_ms.value;
  return [
    `終わり: ${event.ended_by}`,
    `人の発話 tick ${event.user_speaking_ticks}/${event.ticks}`,
    `合図時に話していた: ${event.user_speaking_at_cue ? 'はい' : 'いいえ'}`,
    stop !== null ? `止まるまで ${Math.round(stop)}ms` : null,
    start !== null ? `話し始めるまで ${Math.round(start)}ms` : null,
  ]
    .filter((x) => x !== null)
    .join('、');
}

/** G が E2a の拒否を initiative.discarded へ写すときの頭（monitor.ts の rejected）。 */
const E2A_COPY_PREFIX = 'e2a_rejected:';

export class CandidateTracker {
  private readonly decisions: DecisionRow[] = [];
  private readonly changes: StateChangeRow[] = [];
  private readonly current = new Map<string, CandidateNow>();
  private readonly counts: Record<string, number> = {};
  private discarded = 0;
  private aborted = 0;
  private rejected = 0;
  private readonly drops: DropRow[] = [];
  private readonly notes: CandidateNoteRow[] = [];
  private seq = 0;

  add(event: ResearchEvent): void {
    switch (event.event) {
      case 'initiative.decision':
        this.counts[event.decision] = (this.counts[event.decision] ?? 0) + 1;
        this.decisions.unshift(decisionRow(event, this.seq++));
        if (this.decisions.length > MAX_ROWS) this.decisions.length = MAX_ROWS;
        break;
      case 'initiative.desire':
        this.addStage(event.desire, desireRow(event, this.seq++));
        break;
      case 'initiative.timing':
        this.addStage(event.timing_strategy === 'immediate' ? `${event.timing}（immediate）` : event.timing, timingRow(event, this.seq++));
        break;
      case 'candidate.state_changed':
        this.addChange(event);
        break;
      case 'initiative.discarded':
        // E2a の拒否の写し（e2a_rejected:）は candidate.rejected と同じものなので数えず、表にも重ねない。
        // ただし active_candidate_exists は E2a が candidate.rejected を出さない（state_changed に残る）ので、
        // E2a の拒否として1回だけ数える。
        if (event.reason.startsWith(E2A_COPY_PREFIX)) {
          if (event.reason.startsWith(`${E2A_COPY_PREFIX}active_candidate_exists`)) {
            this.rejected += 1;
            this.addDiscarded(event);
          }
          break;
        }
        this.discarded += 1;
        this.addDiscarded(event);
        break;
      case 'candidate.rejected':
        this.rejected += 1;
        this.addRejected(event);
        break;
      case 'initiative.aborted':
        this.aborted += 1;
        break;
      case 'initiative.not_offered':
        this.addNote(event, '今は申し出ない（通常応答の後へ持ち越し）', `理由 ${event.reason}`, null, event.candidate_id);
        break;
      case 'initiative.response_material':
        this.addNote(event, '通常応答に材料を渡した', `渡しただけ（使われたかは不明）${event.prompt_version}`, event.proposed_utterance.value, event.candidate_id);
        break;
      case 'initiative.response_reflection':
        this.addNote(event, '材料の反映（推定）', reflectionDetail(event), event.proposed_utterance.value, event.candidate_id);
        break;
      case 'initiative.already_said': {
        const c = event.comparison.value;
        this.addNote(event, `すでに話した内容で撤回（${event.stage}）`, `類似度 ${c.similarity.toFixed(2)}／基準 ${c.threshold}（${c.method}）、一致 ${event.matched_origin} #${event.matched_audio_playback_id}`, event.proposed_utterance.value, event.candidate_id);
        break;
      }
      case 'negotiation.cue_reaction':
        this.addNote(event, event.cue_presented ? '合図への反応（観測値）' : '提示なしの時点の人の様子（観測値）', cueReactionDetail(event), null, event.candidate_id);
        break;
      case 'negotiation.decision':
        if (event.stage === 'signal_gate' && (event.outcome === 'shadow_cue' || event.outcome === 'shadow_release')) {
          this.addNote(event, event.outcome === 'shadow_cue' ? '影の合図（提示なし）' : '影の合図の解除（提示なし）', event.reasons.join('、'), null, event.candidate_id.value);
        } else if (event.stage === 'speech_selection' || event.stage === 'candidate_audio') {
          this.addNote(event, `発話の${event.stage === 'speech_selection' ? '選択' : '音声'}: ${event.outcome}`, event.reasons.join('、'), null, event.candidate_id.value);
        }
        break;
      default:
        break;
    }
  }

  private addStage(count: string, row: DecisionRow): void {
    this.counts[count] = (this.counts[count] ?? 0) + 1;
    this.decisions.unshift(row);
    if (this.decisions.length > MAX_ROWS) this.decisions.length = MAX_ROWS;
  }

  private addDrop(row: DropRow): void {
    this.drops.unshift(row);
    if (this.drops.length > MAX_ROWS) this.drops.length = MAX_ROWS;
  }

  private addNote(event: ResearchEvent, kind: string, detail: string, model_text: string | null, candidate_id: string | null): void {
    this.notes.unshift({ key: `n/${this.seq++}`, t_ms: event.t_monotonic_ms, kind, detail, model_text, candidate_id });
    if (this.notes.length > MAX_ROWS) this.notes.length = MAX_ROWS;
  }

  private addDiscarded(event: Discarded): void {
    this.addDrop({
      key: `d/${this.seq++}`,
      t_ms: event.t_monotonic_ms,
      source: 'initiative.discarded',
      reason: event.reason,
      candidate_id: event.candidate_id.value,
      operation: null,
      details: [],
      held: event.reason.includes('post_turn_new_held'),
    });
  }

  private addRejected(event: Rejected): void {
    this.addDrop({
      key: `r/${this.seq++}`,
      t_ms: event.t_monotonic_ms,
      source: 'candidate.rejected',
      reason: event.reason,
      candidate_id: event.candidate_id.value,
      operation: event.operation,
      details: event.details,
      held: event.held,
    });
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
      rejected: this.rejected,
      drops: this.drops.slice(),
      notes: this.notes.slice(),
    };
  }
}
