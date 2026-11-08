/** 1回のリプレイのイベントを集計する。LLM の良し悪しを断定せず、観測の値と設計上の仮説との一致だけを出す。 */
import type { Outcome } from './project';

export interface RawEvent {
  event: string;
  t_monotonic_ms: number;
  [key: string]: unknown;
}

export interface DecisionRow {
  request_id: string;
  /** v2 は1段判定、desire と timing は二段判定の段。 */
  stage: 'v2' | 'desire' | 'timing';
  t_ms: number;
  latency_ms: number | null;
  decision: string;
  gate: 'passed' | 'rejected' | 'not_applicable' | 'error';
  gate_reasons: string;
  candidate_id: string;
  after_speech_end: boolean;
  stable_input: string;
  output: Record<string, unknown>;
}

export interface RunSummary {
  rows: DecisionRow[];
  llm_requests: number;
  llm_errors: number;
  latency_ms: number[];
  counts: Record<string, number>;
  /** モデルが NEW を返した回数（ゲートの前）。 */
  model_new: number;
  gate_rejected_new: number;
  /** ゲートを通り、話している間に受け取った NEW。 */
  new_during_speech: number;
  new_after_speech: number;
  /** 話の後に届いて E2a が保留した NEW（候補にしていない。本実装の経路のみ）。 */
  new_held_post_turn: number;
  withdrawn_by_model: number;
  withdrawn_by_code: number;
  active_at_end: number;
  first_new_ms: number | null;
  hold: HoldRow[];
}

/** NEW の後に持続の確認を1段入れていたらどうなったかの事後計算。 */
export interface HoldRow {
  candidate_id: string;
  new_at_ms: number;
  next_decision: string | null;
  next_at_ms: number | null;
  /** 次の判定が KEEP／REVISE なら、その時刻まで合図が遅れる。 */
  added_delay_ms: number | null;
  /** 確認を入れていれば合図を出さずに済んだか。 */
  cue_avoided: boolean;
}

/**
 * llm.response の output からモデルの JSON を取り出す。スパイクの monitor は解釈済みの JSON を、
 * 本実装（Gemini プロバイダが発行）は { text, finish_reason } を、台本の LLM は本文の文字列を残すので、どれも読む。
 */
export function modelJsonOf(response: RawEvent | undefined): Record<string, unknown> {
  const value = (response?.output as { value?: unknown } | undefined)?.value;
  const parse = (text: string): Record<string, unknown> => {
    try {
      const parsed = JSON.parse(text) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : { unparsed_text: text };
    } catch {
      return { unparsed_text: text };
    }
  };
  // 台本の LLM（app/scripted.ts）は本文の文字列をそのまま残す。
  if (typeof value === 'string') return parse(value);
  if (!value || typeof value !== 'object') return {};
  const o = value as Record<string, unknown>;
  if (typeof o.text === 'string' && o.decision === undefined) return parse(o.text);
  return o;
}

/** モデルの出力の判定（1段の decision、生成段の desire、タイミング段の timing）。 */
function modelLabelOf(output: Record<string, unknown>): string | undefined {
  return (output.decision ?? output.desire ?? output.timing) as string | undefined;
}

const unwrapValue = (v: unknown): unknown => (v && typeof v === 'object' && 'value' in v ? (v as { value: unknown }).value : v);

/** 生成段とタイミング段のイベントを1段の行と同じ形（decision と candidate_id）に揃える。受け付けなかったものは null。 */
function acceptedStage(e: RawEvent): RawEvent | null {
  const accepted = e.event === 'initiative.desire' ? ['none', 'registered', 'revised', 'held_promoted'] : ['kept', 'withdrawn'];
  if (!accepted.includes(e.outcome as string)) return null;
  const candidate = unwrapValue(e.candidate_id);
  return { ...e, decision: (e.event === 'initiative.desire' ? e.desire : e.timing) as string, candidate_id: candidate ?? '' };
}

function stageRejectReason(e: RawEvent): string {
  const reasons = ((unwrapValue(e.gate) as { reasons?: string[] } | undefined)?.reasons ?? []).join(';');
  const ledger = unwrapValue(e.ledger_reason);
  return [e.outcome, reasons, typeof ledger === 'string' ? ledger : ''].filter((x) => x !== '').join(':');
}

/**
 * llm.request の入力の安定テキスト。スパイクは segments を、本実装はプロンプトの文（#番号（…）: 文）を残す。
 */
export function inputSegmentsOf(request: RawEvent): { asr_segment_id: number; stable_text: string }[] {
  const input = request.input as { segments?: { asr_segment_id: number; stable_text: string }[]; messages?: { text?: string }[] } | undefined;
  if (input?.segments) return input.segments;
  const text = input?.messages?.map((m) => m.text ?? '').join('\n') ?? '';
  const rows: { asr_segment_id: number; stable_text: string }[] = [];
  for (const line of text.split('\n')) {
    const m = /^#(\d+)（[^）]*）: (.*)$/u.exec(line);
    if (m) rows.push({ asr_segment_id: Number(m[1]), stable_text: m[2] as string });
  }
  return rows;
}

export function summarizeRun(events: readonly RawEvent[], speech_end_ms: number): RunSummary {
  const requests = new Map<string, RawEvent>();
  const responses = new Map<string, RawEvent>();
  const decisions = new Map<string, RawEvent>();
  const discards: RawEvent[] = [];
  /** 生成段とタイミング段の棄却の理由（request_id を持つので位置で対応づけない）。 */
  const stageRejected = new Map<string, string>();
  let withdrawn_by_code = 0;
  let withdrawn_by_model = 0;
  const open = new Set<string>();

  const order: string[] = [];
  for (const e of events) {
    if (e.event === 'llm.request' && (e.purpose === undefined || e.purpose === 'initiative')) {
      requests.set(e.request_id as string, e);
      order.push(e.request_id as string);
    } else if (e.event === 'llm.response') responses.set(e.request_id as string, e);
    else if (e.event === 'initiative.decision') {
      decisions.set(e.request_id as string, e);
      if (e.decision === 'NEW') open.add(e.candidate_id as string);
      if (e.decision === 'WITHDRAW') {
        open.delete(e.candidate_id as string);
        withdrawn_by_model += 1;
      }
    } else if (e.event === 'initiative.desire' || (e.event === 'initiative.timing' && e.timing_strategy === 'llm')) {
      const stage = acceptedStage(e);
      const request_id = e.request_id as string;
      if (stage === null) {
        stageRejected.set(request_id, stageRejectReason(e));
        continue;
      }
      decisions.set(request_id, stage);
      if (e.outcome === 'registered' || e.outcome === 'held_promoted') open.add(stage.candidate_id as string);
      if (e.outcome === 'withdrawn') {
        open.delete(stage.candidate_id as string);
        withdrawn_by_model += 1;
      }
    } else if (e.event === 'initiative.discarded') discards.push(e);
    else if (e.event === 'candidate.state_changed' && e.cause_source === 'code' && e.to === 'WITHDRAWN') {
      open.delete(e.candidate_id as string);
      withdrawn_by_code += 1;
    }
  }

  // 棄却のイベントは request_id を持たないので、応答の直後の位置で対応づける。
  const discardFor = new Map<string, RawEvent>();
  let current: string | null = null;
  for (const e of events) {
    if (e.event === 'llm.response') current = e.request_id as string;
    if (e.event === 'initiative.discarded' && current) discardFor.set(current, e);
    if (e.event === 'initiative.decision' || e.event === 'initiative.desire' || e.event === 'initiative.timing') current = null;
  }

  const rows: DecisionRow[] = order.map((id) => {
    const request = requests.get(id) as RawEvent;
    const response = responses.get(id);
    const decision = decisions.get(id);
    const discard = discardFor.get(id);
    const output = modelJsonOf(response);
    const segments = inputSegmentsOf(request);
    const received = (response?.received_at as number | undefined) ?? null;
    const sent = request.sent_at as number;
    const label = (decision?.decision as string) ?? modelLabelOf(output) ?? 'ERROR';
    const stage: DecisionRow['stage'] = decision?.event === 'initiative.timing' || id.endsWith('_timing') ? 'timing' : decision?.event === 'initiative.desire' || output.desire !== undefined ? 'desire' : 'v2';
    const isError = !response || (response.output as { value: unknown }).value === null;
    return {
      request_id: id,
      stage,
      t_ms: received ?? sent,
      latency_ms: received === null || isError ? null : received - sent,
      decision: label,
      gate: isError ? 'error' : decision ? (label === 'NONE' ? 'not_applicable' : 'passed') : 'rejected',
      gate_reasons: stageRejected.get(id) ?? (discard ? (discard.reason as string) : ''),
      candidate_id: (decision?.candidate_id as string) ?? '',
      after_speech_end: received !== null && received > speech_end_ms,
      stable_input: segments.map((s) => `#${s.asr_segment_id} ${s.stable_text}`).join(' / '),
      output,
    };
  });

  const counts: Record<string, number> = {};
  for (const row of rows) {
    const key = row.gate === 'rejected' ? `${row.decision}(棄却)` : row.decision;
    counts[key] = (counts[key] ?? 0) + 1;
  }

  const news = rows.filter((r) => r.decision === 'NEW' && r.gate === 'passed');
  const hold: HoldRow[] = news.map((row) => {
    const index = rows.indexOf(row);
    // タイミング段は同じ起動の別の問いなので、持続の確認の「次の判定」には数えない。
    const next = rows.slice(index + 1).find((r) => r.stage !== 'timing' && r.gate !== 'error' && (r.candidate_id === row.candidate_id || r.decision === 'NONE'));
    const codeWithdrawnAt = events.find(
      (e) => e.event === 'candidate.state_changed' && e.cause_source === 'code' && e.candidate_id === row.candidate_id,
    )?.t_monotonic_ms as number | undefined;
    const nextAt = next?.t_ms ?? null;
    const lostFirst = codeWithdrawnAt !== undefined && (nextAt === null || codeWithdrawnAt < nextAt);
    const avoided = lostFirst || next?.decision === 'WITHDRAW';
    return {
      candidate_id: row.candidate_id,
      new_at_ms: row.t_ms,
      next_decision: lostFirst ? 'evidence_lost' : (next?.decision ?? null),
      next_at_ms: lostFirst ? (codeWithdrawnAt as number) : nextAt,
      added_delay_ms: !avoided && nextAt !== null ? nextAt - row.t_ms : null,
      cue_avoided: avoided,
    };
  });

  return {
    rows,
    llm_requests: order.length,
    llm_errors: rows.filter((r) => r.gate === 'error').length,
    latency_ms: rows.map((r) => r.latency_ms).filter((x): x is number => x !== null),
    counts,
    model_new: rows.filter((r) => modelLabelOf(r.output) === 'NEW').length,
    gate_rejected_new: rows.filter((r) => modelLabelOf(r.output) === 'NEW' && r.gate === 'rejected').length,
    new_during_speech: news.filter((r) => !r.after_speech_end).length,
    new_after_speech: news.filter((r) => r.after_speech_end).length,
    new_held_post_turn: rows.filter((r) => modelLabelOf(r.output) === 'NEW' && r.gate_reasons.includes('post_turn_new_held')).length,
    withdrawn_by_model,
    withdrawn_by_code,
    active_at_end: open.size,
    first_new_ms: news[0]?.t_ms ?? null,
    hold,
  };
}

/** 設計上の仮説（scenarios.ja.json の expected）との一致。正解の判定ではない。 */
export function matchesHypothesis(outcome: Outcome, s: RunSummary): boolean | null {
  const anyNew = s.new_during_speech + s.new_after_speech;
  switch (outcome) {
    case 'no_candidate':
      return anyNew === 0;
    case 'no_candidate_or_withdrawn':
      return s.active_at_end === 0;
    case 'candidate_kept':
      return s.new_during_speech > 0 && s.active_at_end > 0;
    case 'candidate_any':
      return s.new_during_speech > 0;
    case 'not_applicable_until_g3':
      return null;
  }
}

const EVAL_COLUMNS = [
  '台本',
  '素材',
  'モデル',
  'プロンプト版',
  '要求ID',
  '段(v2/desire/timing)',
  '受信時刻(秒)',
  '話し終わった後か',
  '判定',
  'ゲート',
  'ゲートの理由',
  '根拠(モデル出力)',
  '発話案(モデル出力)',
  '理由(モデル出力)',
  '今申し出る理由(モデル出力)',
  '待つ不利益(モデル出力)',
  '撤回の理由(モデル出力)',
  'この判定に渡した安定テキスト',
  '話全体(確定テキスト)',
  '【評価】内容の妥当性',
  '【評価】今申し出る必要性',
  '【評価】待機・撤回の妥当性',
  '【評価】メモ',
] as const;

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

export interface EvalRunInput {
  scenario: string;
  asr_origin: string;
  model: string;
  prompt_version: string;
  summary: RunSummary;
  full_text: string;
}

/** 評価シート。3つの評価欄は必ず空で出す。Excel で文字化けしないよう BOM を付ける。 */
export function buildEvalCsv(runs: readonly EvalRunInput[]): string {
  const lines = [EVAL_COLUMNS.map(csvCell).join(',')];
  for (const run of runs) {
    for (const row of run.summary.rows) {
      const o = row.output;
      // タイミング段の行には同じ起動の生成段の内容を並べる（内容の評価は生成段の行で、時点の評価はタイミング段の行で）。
      const desire = row.stage === 'timing' ? run.summary.rows.find((r) => r.request_id === row.request_id.replace(/_timing$/, ''))?.output : undefined;
      lines.push(
        [
          run.scenario,
          run.asr_origin,
          run.model,
          run.prompt_version,
          row.request_id,
          row.stage,
          (row.t_ms / 1000).toFixed(1),
          row.after_speech_end ? 'はい' : 'いいえ',
          row.decision,
          row.gate,
          row.gate_reasons,
          o.evidence_span ?? desire?.evidence_span,
          o.proposed_utterance ?? desire?.proposed_utterance,
          o.reason,
          o.why_now,
          o.cost_of_waiting,
          o.withdraw_reason,
          row.stable_input,
          run.full_text,
          '',
          '',
          '',
          '',
        ]
          .map(csvCell)
          .join(','),
      );
    }
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}
