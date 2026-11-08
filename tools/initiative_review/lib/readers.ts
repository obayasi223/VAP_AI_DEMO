/**
 * events.jsonl の読み込みの層。イベント名ごとの読み手（EVENT_READERS）が生のイベントを記録（Collected）に写し、
 * assemble（assemble.ts）が記録から評価画面の単位（ReviewItem）を組み立てる。
 *
 * 新しいイベントの足し方:
 *  1. イベントが candidate_id か request_id を持つだけなら、何もしなくても該当の系列の「遷移」に生のまま1行出る
 *     （下の readOther）。まずこれで見える。
 *  2. 意味のある表示にするには EVENT_READERS に読み手を足し、Collected に写す。項目の値は wrap()／fieldsFrom() で
 *     読めば、{source: model_output} は自動で「LLM 生成」と扱う。
 *  判定の項目が増えただけのときは fieldsFrom が自動で拾うので変更は要らない（表示名を付けたければ CONTENT_KEYS／TIMING_KEYS へ）。
 *
 * 契約が作り変えられている最中なので、zod で検証しない。読めない項目は null にして先へ進む（1件のずれで全部を落とさない）。
 */
import type { Field, Provenance } from './model';

export type RawEvent = Record<string, unknown> & { event?: unknown };

const KNOWN_CONVERSATION_LABELS: Record<string, string> = {
  co_thinking: '共同思考',
  co_think: '共同思考',
  cothinking: '共同思考',
  joint_thinking: '共同思考',
  共同思考: '共同思考',
  companion: 'コンパニオン',
  コンパニオン: 'コンパニオン',
};

export function conversationLabel(raw: string): string {
  return KNOWN_CONVERSATION_LABELS[raw] ?? raw;
}

export function parseJsonl(text: string): { events: RawEvent[]; invalid: number } {
  const events: RawEvent[] = [];
  let invalid = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const value: unknown = JSON.parse(line);
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) events.push(value as RawEvent);
      else invalid += 1;
    } catch {
      invalid += 1;
    }
  }
  return { events, invalid };
}

export interface Unwrapped {
  value: unknown;
  null_reason: string | null;
  provenance: Provenance;
  method?: string;
}

/** ModelOutput／Verified／Maybe の包みを開く。包みがなければ素の値（コードの値）とする。 */
export function wrap(v: unknown): Unwrapped {
  if (typeof v === 'object' && v !== null && !Array.isArray(v) && 'value' in v) {
    const o = v as { value: unknown; source?: unknown; null_reason?: unknown; method?: unknown };
    const null_reason = typeof o.null_reason === 'string' ? o.null_reason : null;
    if (o.source === 'model_output') return { value: o.value, null_reason, provenance: 'model_output' };
    if (o.source === 'verified') {
      return {
        value: o.value,
        null_reason,
        provenance: 'verified',
        ...(typeof o.method === 'string' ? { method: o.method } : {}),
      };
    }
    return { value: o.value, null_reason, provenance: 'code' };
  }
  return { value: v, null_reason: null, provenance: 'code' };
}

export function unwrapValue(v: unknown): unknown {
  return wrap(v).value;
}

export function str(v: unknown): string | null {
  const u = unwrapValue(v);
  return typeof u === 'string' && u !== '' ? u : null;
}

export function num(v: unknown): number | null {
  const u = unwrapValue(v);
  return typeof u === 'number' && Number.isFinite(u) ? u : null;
}

function fieldText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value === '' ? null : value;
  if (typeof value === 'boolean') return value ? 'はい' : 'いいえ';
  if (Array.isArray(value)) return value.length === 0 ? null : value.map((x) => String(x)).join(', ');
  if (typeof value === 'number') return String(value);
  return JSON.stringify(value);
}

// ---- 判定の項目 ----------------------------------------------------------------

const CONTENT_KEYS: [string, string][] = [
  ['intent_type', '意図の種類'],
  ['proposed_utterance', '発話希望の内容'],
  ['evidence_span', '根拠の抜き出し'],
  ['evidence_valid', '根拠の検証'],
  ['evidence_segment_ids', '根拠の ASR 区間'],
  ['reason', '理由'],
  ['withdraw_reason', '撤回の理由'],
  ['withdraw_evidence_span', '撤回の根拠の抜き出し'],
  ['withdraw_evidence_segment_ids', '撤回の根拠の ASR 区間'],
];

const TIMING_KEYS: [string, string][] = [
  ['why_now', '今申し出る理由'],
  ['cost_of_waiting', '待つ損失'],
  ['urgency', '緊急度'],
  ['expiry_policy', '期限の扱い'],
  ['resolution_outlook', '本人が解消する見込み'],
];

/** 判定の中身ではない項目（共通の封筒と、実測の時刻と対応づけ）。 */
const NON_FIELD_KEYS = new Set([
  'schema_version',
  't_monotonic_ms',
  'wall_clock',
  'session_id',
  'condition',
  'time_basis',
  'event',
  'segment_id',
  'transcript_revision',
  'request_id',
  'sent_at',
  'received_at',
  'model_version',
  'prompt_version',
  'decision',
  'candidate_id',
  'candidate_version',
  'decided_at',
  'updated_at',
  'withdrawn_at',
  'target_candidate_id',
  // 二段判定の封筒と対応づけ（段の判定の値、起動の対応、会話の種類の版、実測、結果）。
  'desire',
  'timing',
  'timing_strategy',
  'desire_request_id',
  'latency_ms',
  'conversation_kind',
  'profile_version',
  'history_version',
  'input_segment_ids',
  'recent_turn_count',
  'gate',
  'outcome',
  'ledger_reason',
  'model_call',
]);

function toField(key: string, label: string, raw: unknown, forceModel: boolean): Field {
  const u = wrap(raw);
  return {
    key,
    label,
    value: fieldText(u.value),
    null_reason: u.null_reason,
    provenance: forceModel ? 'model_output' : u.provenance,
    ...(u.method !== undefined ? { method: u.method } : {}),
  };
}

/**
 * イベント（またはモデルの出力 JSON）から、内容の側とタイミングの側の項目を取り出す。
 * 知らない項目も、ModelOutput か Verified で包まれていれば（または forceModel なら）そのまま拾う。
 * タイミング段の項目は名前に timing／now／wait／urgen を含むものを timing の側へ入れる。
 */
export function fieldsFrom(raw: Record<string, unknown>, options: { forceModel?: boolean; keepEmpty?: boolean } = {}): { content: Field[]; timing: Field[] } {
  const forceModel = options.forceModel ?? false;
  const keep = (f: Field): boolean => options.keepEmpty === true || f.value !== null;
  const known = new Set<string>();
  const pick = (table: [string, string][]): Field[] => {
    const out: Field[] = [];
    for (const [key, label] of table) {
      known.add(key);
      if (!(key in raw)) continue;
      const f = toField(key, label, raw[key], forceModel);
      if (keep(f)) out.push(f);
    }
    return out;
  };
  const content = pick(CONTENT_KEYS);
  const timing = pick(TIMING_KEYS);
  for (const [key, value] of Object.entries(raw)) {
    if (known.has(key) || NON_FIELD_KEYS.has(key)) continue;
    const wrapped = wrap(value).provenance !== 'code';
    if (!wrapped && !forceModel) continue;
    const f = toField(key, key, value, forceModel);
    if (!keep(f)) continue;
    (/timing|now|wait|urgen/i.test(key) ? timing : content).push(f);
  }
  return { content, timing };
}

// ---- 読み手が埋める記録 --------------------------------------------------------

export interface DecisionRecord {
  /** イベントの名前（1段の判定か、生成段か、タイミング段か）。 */
  event: 'initiative.decision' | 'initiative.desire' | 'initiative.timing';
  /** イベントに記録された会話の種類（生の値）。1段の判定は null。 */
  conversation_kind: string | null;
  request_id: string;
  decision: string;
  segment_id: number | null;
  transcript_revision: number | null;
  sent_at: number | null;
  received_at: number;
  candidate_id: string | null;
  candidate_version: number | null;
  model_version: string | null;
  prompt_version: string | null;
  content: Field[];
  timing: Field[];
}

export interface StateRecord {
  t_ms: number;
  candidate_id: string;
  candidate_version: number | null;
  from: string | null;
  to: string;
  cause: string;
  provenance: Provenance;
}

export interface DropRecord {
  t_ms: number;
  event: string;
  reason: string;
  details: string[];
  held: boolean;
  candidate_id: string | null;
  request_id: string | null;
  input_transcript_revision: number | null;
}

export interface NegotiationRecord {
  t_ms: number;
  candidate_id: string;
  stage: string;
  outcome: string;
  reasons: string[];
}

export interface SignalRecord {
  t_ms: number;
  event: string;
  candidate_id: string;
  phase: string;
  sent_at: number | null;
  started_at: number | null;
  visible: boolean | null;
  ended_at: number | null;
}

export interface SpeechEventRecord {
  t_ms: number;
  event: 'speech.started' | 'speech.ended';
  audio_playback_id: number | null;
  audio_frame: number | null;
  started_at: number | null;
  ended_at: number | null;
  spoken_text: string | null;
  origin: string;
  candidate_id: string | null;
  candidate_version: number | null;
}

export interface LlmRecord {
  transcript_revision: number | null;
  purpose: string | null;
  input_text: string | null;
  output_text: string | null;
  parsed: Record<string, unknown> | null;
  sent_at: number | null;
  received_at: number | null;
  model_version: string | null;
  prompt_version: string | null;
}

export interface SttRecord {
  t_ms: number;
  segment_id: number;
  asr_segment_id: number;
  transcript_revision: number;
  stable_text: string;
  unstable_text: string;
  text: string;
  final: boolean;
  /** 発話の始まりの音声枠（語の情報があればその先頭、なければ区間の先頭）。 */
  frame_start: number | null;
  frame_end: number | null;
}

export interface OutcomeRecord {
  audio_playback_id: number;
  labels: string[] | null;
  null_reason: string | null;
  raw: RawEvent;
}

export interface OtherRecord {
  t_ms: number;
  event: string;
  candidate_id: string | null;
  request_id: string | null;
  detail: string;
}

export interface Collected {
  decisions: DecisionRecord[];
  states: StateRecord[];
  drops: DropRecord[];
  negotiations: NegotiationRecord[];
  signals: SignalRecord[];
  speech: SpeechEventRecord[];
  llm: Map<string, LlmRecord>;
  stt: SttRecord[];
  /** [t_monotonic_ms, audio_frame]。VAP が基準。無ければ speech の枠を使う。 */
  vapFrames: [number, number][];
  otherFrames: [number, number][];
  others: OtherRecord[];
  outcomes: OutcomeRecord[];
}

export function emptyCollected(): Collected {
  return {
    decisions: [],
    states: [],
    drops: [],
    negotiations: [],
    signals: [],
    speech: [],
    llm: new Map(),
    stt: [],
    vapFrames: [],
    otherFrames: [],
    others: [],
    outcomes: [],
  };
}

function eventTime(e: RawEvent): number {
  return num(e.t_monotonic_ms) ?? 0;
}

function llmRecord(c: Collected, requestId: string): LlmRecord {
  let record = c.llm.get(requestId);
  if (record === undefined) {
    record = {
      transcript_revision: null,
      purpose: null,
      input_text: null,
      output_text: null,
      parsed: null,
      sent_at: null,
      received_at: null,
      model_version: null,
      prompt_version: null,
    };
    c.llm.set(requestId, record);
  }
  return record;
}

export type EventReader = (e: RawEvent, c: Collected) => void;

function readDecision(e: RawEvent, c: Collected): void {
  const fields = fieldsFrom(e, { keepEmpty: true });
  c.decisions.push({
    event: 'initiative.decision',
    conversation_kind: null,
    request_id: str(e.request_id) ?? `no_request_${c.decisions.length}`,
    decision: str(e.decision) ?? '不明',
    segment_id: num(e.segment_id),
    transcript_revision: num(e.transcript_revision),
    sent_at: num(e.sent_at),
    received_at: num(e.received_at) ?? eventTime(e),
    candidate_id: str(e.candidate_id),
    candidate_version: num(e.candidate_version),
    model_version: str(e.model_version),
    prompt_version: str(e.prompt_version),
    content: fields.content,
    timing: fields.timing,
  });
}

/** Maybe(Verified(x)) の外側の Maybe を開く（fieldsFrom が Verified として読めるように）。値がなければ元の Maybe のまま。 */
function flattenMaybeVerified(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw;
  const inner = (raw as { value?: unknown }).value;
  return typeof inner === 'object' && inner !== null && 'source' in inner ? inner : raw;
}

/** 段のイベントのコードの結果（ゲートと E2a の受け付け）を、モデル出力と別の項目にする。 */
function stageResultFields(e: RawEvent): Field[] {
  const fields: Field[] = [];
  const gate = wrap(e.gate);
  const value = gate.value as { passed?: boolean; reasons?: string[] } | null | undefined;
  if (value && typeof value.passed === 'boolean') {
    fields.push({
      key: 'gate',
      label: 'コードのゲート',
      value: value.passed ? '合格' : `不合格（${(value.reasons ?? []).join(', ')}）`,
      null_reason: null,
      provenance: 'verified',
      ...(gate.method !== undefined ? { method: gate.method } : {}),
    });
  }
  const ledger = str(e.ledger_reason);
  fields.push({
    key: 'outcome',
    label: '結果',
    value: `${str(e.outcome) ?? '不明'}${ledger === null ? '' : `（${ledger}）`}`,
    null_reason: null,
    provenance: 'code',
  });
  return fields;
}

function readDesire(e: RawEvent, c: Collected): void {
  const fields = fieldsFrom(
    { ...e, evidence_segment_ids: flattenMaybeVerified(e.evidence_segment_ids), prior_turn_evidence: flattenMaybeVerified(e.prior_turn_evidence) },
    { keepEmpty: true },
  );
  c.decisions.push({
    event: 'initiative.desire',
    conversation_kind: str(e.conversation_kind),
    request_id: str(e.request_id) ?? `no_request_${c.decisions.length}`,
    decision: str(e.desire) ?? '不明',
    segment_id: num(e.segment_id),
    transcript_revision: num(e.transcript_revision),
    sent_at: num(e.sent_at),
    received_at: num(e.received_at) ?? eventTime(e),
    candidate_id: str(e.candidate_id),
    candidate_version: num(e.candidate_version),
    model_version: str(e.model_version),
    prompt_version: str(e.prompt_version),
    content: [...fields.content, ...stageResultFields(e)],
    timing: fields.timing,
  });
}

function readTiming(e: RawEvent, c: Collected): void {
  const immediate = e.timing_strategy === 'immediate';
  const fields = fieldsFrom({ ...e, withdraw_evidence_segment_ids: flattenMaybeVerified(e.withdraw_evidence_segment_ids) }, { keepEmpty: true });
  const desireRequest = str(e.desire_request_id);
  c.decisions.push({
    event: 'initiative.timing',
    conversation_kind: str(e.conversation_kind),
    // immediate は要求がないので、起動の生成段の番号から作る。
    request_id: str(e.request_id) ?? (desireRequest !== null ? `${desireRequest}_immediate` : `no_request_${c.decisions.length}`),
    decision: str(e.timing) ?? '不明',
    segment_id: num(e.segment_id),
    transcript_revision: num(e.transcript_revision),
    sent_at: num(e.sent_at),
    received_at: num(e.received_at) ?? num(e.decided_at) ?? eventTime(e),
    candidate_id: str(e.candidate_id),
    candidate_version: num(e.candidate_version),
    model_version: str(e.model_version),
    prompt_version: str(e.prompt_version),
    content: [],
    timing: [
      ...fields.content,
      ...fields.timing,
      {
        key: 'timing_strategy',
        label: '方式',
        value: immediate ? 'immediate（LLM なし、コードの判定）' : 'llm',
        null_reason: null,
        provenance: 'code',
      },
      ...stageResultFields(e),
    ],
  });
}

function readStateChanged(e: RawEvent, c: Collected): void {
  const candidate_id = str(e.candidate_id);
  if (candidate_id === null) return;
  const fromModel = e.cause_source === 'model_decision';
  c.states.push({
    t_ms: eventTime(e),
    candidate_id,
    candidate_version: num(e.candidate_version),
    from: str(e.from),
    to: str(e.to) ?? '不明',
    cause: fromModel ? `LLM の判定 ${String(e.decision)}（${String(e.request_id)}）` : `コード: ${String(e.cause)}`,
    provenance: fromModel ? 'model_output' : 'code',
  });
}

function readRejected(e: RawEvent, c: Collected): void {
  c.drops.push({
    t_ms: eventTime(e),
    event: 'candidate.rejected',
    reason: str(e.reason) ?? '不明',
    details: Array.isArray(e.details) ? e.details.map((d) => String(d)) : [],
    held: e.held === true,
    candidate_id: str(e.candidate_id),
    request_id: str(e.request_id),
    input_transcript_revision: num(e.input_transcript_revision),
  });
}

function readDropped(e: RawEvent, c: Collected): void {
  c.drops.push({
    t_ms: eventTime(e),
    event: String(e.event),
    reason: str(e.reason) ?? '不明',
    details: [],
    held: false,
    candidate_id: str(e.candidate_id),
    request_id: null,
    input_transcript_revision: num(e.input_transcript_revision),
  });
}

function readNegotiation(e: RawEvent, c: Collected): void {
  const candidate_id = str(e.candidate_id);
  if (candidate_id === null) return;
  c.negotiations.push({
    t_ms: eventTime(e),
    candidate_id,
    stage: str(e.stage) ?? '不明',
    outcome: str(e.outcome) ?? '不明',
    reasons: Array.isArray(e.reasons) ? e.reasons.map((r) => String(r)) : [],
  });
}

function readSignal(e: RawEvent, c: Collected): void {
  const candidate_id = str(e.candidate_id);
  if (candidate_id === null) return;
  c.signals.push({
    t_ms: eventTime(e),
    event: String(e.event),
    candidate_id,
    phase: str(e.phase) ?? '不明',
    sent_at: num(e.sent_at),
    started_at: num(e.started_at),
    visible: typeof e.visible === 'boolean' ? e.visible : null,
    ended_at: num(e.ended_at),
  });
}

function readSpeech(e: RawEvent, c: Collected): void {
  const frame = num(e.audio_frame);
  const started = num(e.started_at);
  if (frame !== null && started !== null) c.otherFrames.push([started, frame]);
  c.speech.push({
    t_ms: eventTime(e),
    event: e.event as SpeechEventRecord['event'],
    audio_playback_id: num(e.audio_playback_id),
    audio_frame: frame,
    started_at: started,
    ended_at: num(e.ended_at),
    spoken_text: typeof e.spoken_text === 'string' ? e.spoken_text : null,
    origin: str(e.origin) ?? 'response',
    candidate_id: str(e.candidate_id),
    candidate_version: num(e.candidate_version),
  });
}

/** turn.outcome の ai_utterance（文は持たない）。no_response は特定の発話に属さないので一覧の対象外。 */
function readOutcome(e: RawEvent, c: Collected): void {
  const id = num(e.audio_playback_id);
  if (e.kind !== 'ai_utterance' || id === null) return;
  const labels = (e.labels ?? {}) as { value?: unknown; null_reason?: unknown };
  c.outcomes.push({
    audio_playback_id: id,
    labels: Array.isArray(labels.value) ? labels.value.map(String) : null,
    null_reason: typeof labels.null_reason === 'string' ? labels.null_reason : null,
    raw: e,
  });
}

function readLlmRequest(e: RawEvent, c: Collected): void {
  const id = str(e.request_id);
  if (id === null) return;
  const record = llmRecord(c, id);
  record.transcript_revision = num(e.transcript_revision);
  record.purpose = str(e.purpose);
  record.sent_at = num(e.sent_at);
  record.model_version = str(e.model_version);
  record.prompt_version = str(e.prompt_version);
  const input = e.input as { messages?: { text?: unknown }[] } | undefined;
  if (Array.isArray(input?.messages)) {
    record.input_text = input.messages.map((m) => (typeof m.text === 'string' ? m.text : '')).join('\n');
  }
}

function readLlmResponse(e: RawEvent, c: Collected): void {
  const id = str(e.request_id);
  if (id === null) return;
  const record = llmRecord(c, id);
  record.received_at = num(e.received_at);
  const output = unwrapValue(e.output) as { text?: unknown } | null | undefined;
  if (typeof output?.text === 'string') {
    record.output_text = output.text;
    try {
      const parsed: unknown = JSON.parse(output.text);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) record.parsed = parsed as Record<string, unknown>;
    } catch {
      // 構造化していない出力（prefetch など）。原文だけ持つ。
    }
  }
}

function readStt(e: RawEvent, c: Collected): void {
  const segment_id = num(e.segment_id);
  const asr_segment_id = num(e.asr_segment_id);
  const transcript_revision = num(e.transcript_revision);
  if (segment_id === null || asr_segment_id === null || transcript_revision === null) return;
  const final = e.event === 'stt.final';
  const text = typeof e.text === 'string' ? e.text : '';
  const stable = typeof e.stable_text === 'string' ? e.stable_text : '';
  const words = unwrapValue(e.words);
  const firstWord = Array.isArray(words) ? num((words[0] as { audio_frame_start?: unknown } | undefined)?.audio_frame_start) : null;
  c.stt.push({
    t_ms: eventTime(e),
    segment_id,
    asr_segment_id,
    transcript_revision,
    stable_text: final ? text : stable,
    unstable_text: final ? '' : typeof e.unstable_text === 'string' ? e.unstable_text : '',
    text,
    final,
    frame_start: firstWord ?? num(e.asr_segment_frame_start),
    frame_end: num(e.audio_frame_end),
  });
}

function readVap(e: RawEvent, c: Collected): void {
  const frame = num(e.audio_frame);
  if (frame !== null) c.vapFrames.push([eventTime(e), frame]);
}

/** 読み手のないイベント。candidate_id か request_id があれば系列の遷移に生のまま残す。 */
function readOther(e: RawEvent, c: Collected): void {
  const candidate_id = str(e.candidate_id);
  const request_id = str(e.request_id);
  if (candidate_id === null && request_id === null) return;
  const detail = Object.entries(e)
    .filter(([key]) => !NON_FIELD_KEYS.has(key) || key === 'decision')
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(' ');
  c.others.push({ t_ms: eventTime(e), event: String(e.event), candidate_id, request_id, detail });
}

/** イベント名 → 読み手。新しいイベントはここへ足す（ファイル先頭の説明）。 */
export const EVENT_READERS: Record<string, EventReader> = {
  'initiative.decision': readDecision,
  'initiative.desire': readDesire,
  'initiative.timing': readTiming,
  'candidate.state_changed': readStateChanged,
  'candidate.rejected': readRejected,
  'initiative.discarded': readDropped,
  'initiative.aborted': readDropped,
  'negotiation.decision': readNegotiation,
  'signal.sent': readSignal,
  'signal.started': readSignal,
  'signal.ended': readSignal,
  'speech.started': readSpeech,
  'speech.ended': readSpeech,
  'llm.request': readLlmRequest,
  'llm.response': readLlmResponse,
  'stt.interim': readStt,
  'stt.final': readStt,
  'vap.state': readVap,
  'turn.outcome': readOutcome,
};

export function collect(events: RawEvent[]): Collected {
  const collected = emptyCollected();
  for (const e of events) {
    const reader = typeof e.event === 'string' ? EVENT_READERS[e.event] : undefined;
    (reader ?? readOther)(e, collected);
  }
  return collected;
}
