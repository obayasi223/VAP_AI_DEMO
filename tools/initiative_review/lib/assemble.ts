/**
 * 読み手が写した記録（Collected）から、評価の単位（ReviewItem）を組み立てる。
 *  - candidate: 同じ candidate_id の判定（NEW → KEEP／REVISE → WITHDRAW など）を1つの系列にする。
 *  - none: 判定が NONE だった要求（1要求1件）。見逃しの印の起点になる。
 *  - dropped: 判定がコードに棄てられた要求（stale、ゲート、保留など）。適用されなかったので候補にならないが、見て評価できるようにする。
 */
import { conversationLabel, fieldsFrom, num, unwrapValue, type Collected, type DecisionRecord, type LlmRecord, type RawEvent, type SttRecord } from './readers';
import type { AfterCueEnding, AfterCueView, DecisionStep, Field, InhaleRecord, RateAxis, ReflectionView, ReviewItem, SpeechOutcome, SpeechRecord, StableSnapshot, TimelineRow, TranscriptLine, VocalCueView } from './model';

const FRAMES_PER_MS = 16;

export interface FrameMap {
  tAtFrame(frame: number): number | null;
  secondsAtT(t_ms: number): number | null;
  readonly available: boolean;
}

/**
 * t_monotonic_ms と音声枠の対応。記録の中の (t, frame) の組から最も近い組を使い、差分は 16 枠/ms で進める。
 * 組は VAP（vap.state）を基準にする。VAP が無いセッションでは発話の開始の組に落とす。
 */
export function frameMap(vapFrames: [number, number][], otherFrames: [number, number][]): FrameMap {
  const pairs = (vapFrames.length > 0 ? [...vapFrames] : [...otherFrames]).sort((a, b) => a[0] - b[0]);
  const nearest = (value: number, index: 0 | 1): [number, number] | null => {
    if (pairs.length === 0) return null;
    let lo = 0;
    let hi = pairs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((pairs[mid] as [number, number])[index] < value) lo = mid + 1;
      else hi = mid;
    }
    const after = pairs[lo] as [number, number];
    const before = pairs[Math.max(0, lo - 1)] as [number, number];
    return Math.abs(before[index] - value) <= Math.abs(after[index] - value) ? before : after;
  };
  return {
    available: pairs.length > 0,
    tAtFrame(frame) {
      const near = nearest(frame, 1);
      return near === null ? null : near[0] + (frame - near[1]) / FRAMES_PER_MS;
    },
    secondsAtT(t_ms) {
      const near = nearest(t_ms, 0);
      if (near === null) return null;
      const frame = near[1] + (t_ms - near[0]) * FRAMES_PER_MS;
      return Math.max(0, frame / 16000);
    },
  };
}

/** 判定の入力の時点（transcript_revision）までの、その会話区間の安定した文字を区間ごとに集める。 */
function stableAt(stt: SttRecord[], segmentId: number | null, revision: number | null): StableSnapshot {
  const empty: StableSnapshot = { transcript_revision: revision, segment_id: segmentId, segments: [], text: '' };
  if (segmentId === null || revision === null) return empty;
  const latest = new Map<number, SttRecord>();
  for (const record of stt) {
    if (record.segment_id !== segmentId || record.transcript_revision > revision) continue;
    const current = latest.get(record.asr_segment_id);
    if (current === undefined || record.transcript_revision >= current.transcript_revision) latest.set(record.asr_segment_id, record);
  }
  const segments = [...latest.values()]
    .sort((a, b) => a.asr_segment_id - b.asr_segment_id)
    .map((r) => ({ asr_segment_id: r.asr_segment_id, text: r.stable_text, unstable: r.unstable_text, final: r.final }));
  return { ...empty, segments, text: segments.map((s) => s.text).join('') };
}

/** 推定の値と基準を、画面に出す短い文にする（値の丸めは表示だけ）。 */
function estimateText(estimate: Record<string, unknown> | null): string | null {
  if (estimate === null) return null;
  const n = (key: string): string => (typeof estimate[key] === 'number' ? String(Math.round((estimate[key] as number) * 1000) / 1000) : '—');
  return `包含率 ${n('containment')}（基準 ${n('threshold')}、2-gram ${n('matched_bigrams')}/${n('material_bigrams')}、${String(estimate.basis ?? '—')}）`;
}

function buildLines(c: Collected, map: FrameMap): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  const bySegment = new Map<number, SttRecord>();
  for (const record of c.stt) {
    const current = bySegment.get(record.asr_segment_id);
    // final があれば final を、無ければ最後の interim を使う。
    if (current === undefined || record.final || (!current.final && record.transcript_revision >= current.transcript_revision)) {
      bySegment.set(record.asr_segment_id, record);
    }
  }
  for (const record of bySegment.values()) {
    if (record.text === '') continue;
    const start = record.frame_start === null ? null : map.tAtFrame(record.frame_start);
    const end = record.frame_end === null ? null : map.tAtFrame(record.frame_end);
    lines.push({
      id: `u${record.asr_segment_id}`,
      role: 'user',
      t_ms: start ?? record.t_ms,
      end_t_ms: end,
      text: record.text,
      final: record.final,
      origin: null,
      candidate_id: null,
      asr_segment_id: record.asr_segment_id,
      audio_sec: map.secondsAtT(start ?? record.t_ms),
    });
  }
  const started = new Map<number, (typeof c.speech)[number]>();
  const ended = new Map<number, (typeof c.speech)[number]>();
  for (const speech of c.speech) {
    if (speech.audio_playback_id === null) continue;
    (speech.event === 'speech.started' ? started : ended).set(speech.audio_playback_id, speech);
  }
  for (const [id, record] of [...started, ...[...ended].filter(([k]) => !started.has(k))]) {
    const end = ended.get(id);
    const text = end?.spoken_text ?? '（発話の記録の終わりがない）';
    if (text === '') continue;
    lines.push({
      id: `a${id}`,
      role: 'ai',
      t_ms: record.started_at ?? record.t_ms,
      end_t_ms: end?.ended_at ?? null,
      text,
      final: true,
      origin: record.origin,
      candidate_id: record.candidate_id,
      asr_segment_id: null,
      audio_sec: map.secondsAtT(record.started_at ?? record.t_ms),
    });
  }
  return lines.sort((a, b) => a.t_ms - b.t_ms);
}

function decisionStep(d: DecisionRecord, c: Collected): DecisionStep {
  const llm = c.llm.get(d.request_id);
  const parsed = llm?.parsed ? fieldsFrom(llm.parsed, { forceModel: true }) : null;
  const existing = new Set([...d.content, ...d.timing].map((f) => f.key));
  const fill = (fields: Field[] | undefined): Field[] => fields?.filter((f) => !existing.has(f.key)) ?? [];
  // タイミング段の出力は全部タイミングの側（内容の側へ混ぜない）。
  const isTimingStage = d.event === 'initiative.timing';
  return {
    event: d.event,
    request_id: d.request_id,
    decision: d.decision,
    t_ms: d.received_at,
    sent_at: d.sent_at,
    candidate_version: d.candidate_version,
    model_version: d.model_version,
    prompt_version: d.prompt_version ?? llm?.prompt_version ?? null,
    // 判定のイベントにない項目（resolution_outlook など）は llm.response の出力から補う。空の項目は足さない。
    content: isTimingStage ? [] : [...d.content, ...fill(parsed?.content)],
    timing: isTimingStage ? [...d.timing, ...fill(parsed?.content), ...fill(parsed?.timing)] : [...d.timing, ...fill(parsed?.timing)],
    stable: stableAt(c.stt, d.segment_id, d.transcript_revision),
    llm_input: llm?.input_text ?? null,
    llm_output: llm?.output_text ?? null,
  };
}

/** 判定のイベントが出なかった要求（棄てられた）を、記録の llm.request／response から1段にする。 */
function droppedStep(requestId: string | null, llm: LlmRecord | undefined, c: Collected, t_ms: number, inputRevision: number | null): DecisionStep {
  const fields = llm?.parsed ? fieldsFrom(llm.parsed, { forceModel: true }) : { content: [], timing: [] };
  const parsedLabel = llm?.parsed ? (llm.parsed.decision ?? llm.parsed.desire ?? llm.parsed.timing) : null;
  const decisionText = typeof parsedLabel === 'string' ? parsedLabel : null;
  const revision = llm?.transcript_revision ?? inputRevision;
  const segment = revision === null ? null : (c.stt.find((s) => s.transcript_revision === revision)?.segment_id ?? null);
  return {
    request_id: requestId ?? '不明',
    decision: decisionText ?? '（判定なし）',
    t_ms: llm?.received_at ?? t_ms,
    sent_at: llm?.sent_at ?? null,
    candidate_version: null,
    model_version: llm?.model_version ?? null,
    prompt_version: llm?.prompt_version ?? null,
    content: fields.content,
    timing: fields.timing,
    stable: stableAt(c.stt, segment, revision),
    llm_input: llm?.input_text ?? null,
    llm_output: llm?.output_text ?? null,
  };
}

function reflectionRow(r: Collected['reflections'][number]): TimelineRow {
  const verdict = r.estimated_reflected === null ? `推定なし（${r.estimate_reason ?? '理由なし'}）` : r.estimated_reflected ? '推定: 反映あり' : '推定: 反映なし';
  return { t_ms: r.t_ms, event: 'initiative.response_reflection', label: `通常応答の結果（${r.spoken_outcome}）: ${verdict}`, detail: r.spoken_text || null, provenance: 'code' };
}

function initiativeRequestAtRevision(c: Collected, revision: number | null): string | null {
  if (revision === null) return null;
  let found: string | null = null;
  for (const [id, record] of c.llm) {
    if (record.purpose === 'initiative' && record.transcript_revision === revision) found = id;
  }
  return found;
}

/** 判定の列の見出し。二段判定はタイミング段の同じ判定が続きやすいので、連続を ×n にまとめる（1段判定は今までどおり）。 */
function headlineOf(steps: DecisionStep[]): string {
  const tokens = steps.map((s) => s.decision);
  if (!steps.some((s) => s.event !== 'initiative.decision')) return tokens.join(' → ');
  const runs: [string, number][] = [];
  for (const token of tokens) {
    const last = runs.at(-1);
    if (last && last[0] === token) last[1] += 1;
    else runs.push([token, 1]);
  }
  return runs.map(([token, n]) => (n > 1 ? `${token} ×${n}` : token)).join(' → ');
}

const WITHDRAW_KIND_LABEL: Record<string, string> = {
  question_resolved: '疑問が解消した',
  premise_changed: '前提が変わった',
  topic_moved: '話題が移った',
  already_said: 'すでに話した',
};

const CODE_CAUSE_LABEL: Record<string, string> = {
  normal_response_started: '通常応答が先に始まった',
  expired: '期限切れ',
  evidence_lost: '根拠の発話が ASR の修正で消えた',
  stale_result: '判定が古くなった',
  audio_unavailable: '候補の音声を用意できなかった',
  speech_failed: '再生に失敗した',
  speech_no_audio: '音が出なかった',
  woz: '実験者の操作',
};

/** 影の合図（initiative_no_cue）の候補か。BREATH_* の状態は提示を意味しないので、ゲートの outcome で読む。 */
function isShadowCue(negotiations: Collected['negotiations'], candidate_id: string): boolean {
  return negotiations.some((n) => n.candidate_id === candidate_id && n.stage === 'signal_gate' && n.outcome === 'shadow_cue');
}

/** 候補の状態の列から、吸気の後の結末を読む。延期と内容の撤回を別の項目にする（延期の後に撤回されることもあるため）。 */
function afterCueOf(states: Collected['states'], vocalCues: Collected['vocalCues'], shadow: boolean): AfterCueView | null {
  const cue = states.find((s) => s.to === 'BREATH_INHALE');
  if (cue === undefined) return null;
  const deferredState = states.find((s) => s.to === 'DEFERRED');
  const last = states.at(-1) as Collected['states'][number];
  const revisions = cue.candidate_version !== null && last.candidate_version !== null ? Math.max(0, last.candidate_version - cue.candidate_version) : 0;
  const spoken = states.find((s) => s.to === 'SPOKEN');
  const withdrawn = states.find((s) => s.to === 'WITHDRAWN');
  let ending: AfterCueEnding = 'unresolved';
  let endingLabel = '結末の記録なし';
  if (spoken !== undefined) {
    ending = 'spoken';
    endingLabel = '発話';
  } else if (withdrawn !== undefined) {
    const kind = withdrawn.withdraw_kind;
    if (kind === 'already_said' || withdrawn.code_cause === 'already_said') {
      ending = 'already_said';
      endingLabel = '撤回（すでに話した内容）';
    } else if (withdrawn.code_cause === null) {
      ending = 'content_withdrawn';
      endingLabel = `内容の撤回（${kind === null ? '分類なし' : (WITHDRAW_KIND_LABEL[kind] ?? kind)}）`;
    } else {
      ending = 'not_spoken_other';
      endingLabel = `話さず終了・内容の撤回ではない（${CODE_CAUSE_LABEL[withdrawn.code_cause] ?? withdrawn.code_cause}）`;
    }
  }
  const end = spoken ?? withdrawn ?? null;
  const voiced = vocalCues[0] ?? null;
  const vocal_cue: VocalCueView | null =
    voiced === null
      ? null
      : {
          kind: voiced.kind,
          phrase: voiced.phrase,
          decided_at: voiced.decided_at,
          audio_started_at: voiced.audio_started_at,
          audio_ended_at: voiced.audio_ended_at,
          audio_outcome: voiced.audio_outcome,
          silence_ms: voiced.silence_ms,
          asr_quiet_ms: voiced.asr_quiet_ms,
          resumed_ms: voiced.resumed_ms,
          resume_null_reason: voiced.resume_null_reason,
          candidate_speech_started: voiced.candidate_speech_started,
          user_speaking_at_audio_end: voiced.user_speaking_at_audio_end,
          ended_by: voiced.ended_by,
        };
  return {
    cue_presented: !shadow,
    deferred: deferredState !== undefined,
    deferred_at: deferredState?.t_ms ?? null,
    revisions,
    ending,
    ending_at: end?.t_ms ?? null,
    withdraw_kind: withdrawn?.withdraw_kind ?? null,
    code_cause: withdrawn?.code_cause ?? null,
    vocal_cue,
    label: [shadow ? '吸気の期間（提示なし）' : '吸気', ...(deferredState ? ['延期'] : []), ...(voiced ? [`声「${voiced.phrase}」`] : []), ...(revisions > 0 ? [`内容の更新 ×${revisions}`] : []), endingLabel].join(' → '),
  };
}

interface ItemShell extends Omit<ReviewItem, 'context_before' | 'context_after' | 'audio_sec' | 'rate_axes' | 'after_cue'> {
  rate_axes?: RateAxis[];
}

const CONTEXT_BEFORE = 6;
const CONTEXT_AFTER = 4;

/** turn.outcome の本体から、評価画面の値を文字の項目へ（全部の項目は出さない）。契約が変わっても読めないものは「—」。 */
function speechOutcome(o: Collected['outcomes'][number]): SpeechOutcome {
  const raw = o.raw;
  const start = (raw.start ?? {}) as RawEvent;
  const observed = (raw.observed ?? {}) as RawEvent;
  const overlap = (observed.overlap ?? {}) as RawEvent;
  const continuation = (observed.continuation ?? {}) as RawEvent;
  const echo = (observed.echo ?? {}) as RawEvent;
  const text = (v: unknown, unit = ''): string => {
    const value = unwrapValue(v);
    if (value === null || value === undefined) return '—';
    if (typeof value === 'number') return `${Math.round(value * 1000) / 1000}${unit}`;
    if (typeof value === 'boolean') return value ? 'はい' : 'いいえ';
    return String(value);
  };
  return {
    labels: o.labels,
    null_reason: o.null_reason,
    fields: [
      { label: '開始の判断', value: `${text(start.decision_source)}（${text(start.reason)}）` },
      { label: 'VAP', value: `p_now=${text(start.p_now)} p_future=${text(start.p_future)} vad=${text(start.vad_user)} 鮮度=${text(start.vap_freshness)}` },
      { label: '話し終わりの推定', value: `completion_p=${text(start.completion_p)} 発話の終わりからの間=${text(start.gap_ms, 'ms')}` },
      { label: '開始の直前の人の声', value: `${text(observed.user_voice_gap_before_ms, 'ms')} 前まで（直前: ${text(observed.user_voiced_just_before)}）` },
      { label: '開始の後の続き', value: `${text(continuation.continued)}（文 ${text(continuation.chars)} 字）` },
      { label: '重なり', value: `${text(overlap.overlap_ms, 'ms')}（最初の重なりまで ${text(overlap.first_after_start_ms, 'ms')}、文 ${text(overlap.chars)} 字 ${text(overlap.text_kind)}）` },
      { label: '再生の長さ', value: `${text(raw.played_ms, 'ms')}（割り込み: ${text(raw.interrupted)}）` },
      { label: 'エコーの疑い', value: `${text(echo.suspected)}（類似度 ${text(echo.text_similarity)}、重なりの割合 ${text(echo.overlap_ratio)}）` },
    ],
  };
}

export interface AssembleContext {
  session_id: string;
  condition: string | null;
  conversation_type: string;
  default_prompt_version: string | null;
  /** 保存した音声の対応（session_audio_sync.jsonl）。あれば vap.state の組より優先する。 */
  audioMap?: FrameMap | null;
}

export function assemble(c: Collected, ctx: AssembleContext): { items: ReviewItem[]; lines: TranscriptLine[]; hasAudioMap: boolean } {
  const map = ctx.audioMap ?? frameMap(c.vapFrames, c.otherFrames);
  const lines = buildLines(c, map);
  const shells = new Map<string, ItemShell>();
  const requestToKey = new Map<string, string>();
  const candidateToKey = new Map<string, string>();

  const shell = (key: string, kind: ReviewItem['kind'], t_ms: number, anchor: number, candidateId: string | null): ItemShell => {
    let item = shells.get(key);
    if (item === undefined) {
      item = {
        key,
        kind,
        session_id: ctx.session_id,
        t_ms,
        anchor_t_ms: anchor,
        condition: ctx.condition,
        conversation_type: ctx.conversation_type,
        prompt_versions: [],
        headline: '',
        candidate_id: candidateId,
        final_state: null,
        decisions: [],
        timeline: [],
        inhale: [],
        speech: [],
        reflection: [],
      };
      shells.set(key, item);
    }
    return item;
  };

  for (const d of c.decisions) {
    const step = decisionStep(d, c);
    const t = step.t_ms;
    const anchor = step.sent_at ?? t;
    let item: ItemShell;
    if (d.candidate_id !== null) {
      item = shell(`c:${d.candidate_id}`, 'candidate', t, anchor, d.candidate_id);
      candidateToKey.set(d.candidate_id, item.key);
    } else if (d.decision === 'NONE') {
      item = shell(`n:${d.request_id}`, 'none', t, anchor, null);
    } else {
      item = shell(`x:${d.request_id}`, 'dropped', t, anchor, null);
    }
    item.decisions.push(step);
    requestToKey.set(d.request_id, item.key);
    // 判定のイベントに会話の種類があれば、その判定の種類で絞り込む（セッションの manifest より確か）。
    if (d.conversation_kind !== null) item.conversation_type = conversationLabel(d.conversation_kind);
    const stageName = d.event === 'initiative.desire' ? '生成段' : d.event === 'initiative.timing' ? 'タイミング段' : '判定';
    item.timeline.push({
      t_ms: t,
      event: d.event,
      label: `${stageName} ${d.decision}${d.candidate_version !== null ? `（版 ${d.candidate_version}）` : ''}`,
      detail: step.request_id,
      provenance: 'model_output',
    });
  }

  for (const drop of c.drops) {
    const reasonText = [drop.reason, ...drop.details].join(' ');
    const row: TimelineRow = {
      t_ms: drop.t_ms,
      event: drop.event,
      label: `棄却${drop.held ? '（保留）' : ''}: ${reasonText}`,
      detail: drop.request_id,
      provenance: 'code',
    };
    if (drop.candidate_id !== null && candidateToKey.has(drop.candidate_id)) {
      shells.get(candidateToKey.get(drop.candidate_id) as string)?.timeline.push(row);
      continue;
    }
    const requestId = drop.request_id ?? initiativeRequestAtRevision(c, drop.input_transcript_revision);
    const existing = requestId === null ? undefined : requestToKey.get(requestId);
    if (existing !== undefined) {
      shells.get(existing)?.timeline.push(row);
      continue;
    }
    const llm = requestId === null ? undefined : c.llm.get(requestId);
    const step = droppedStep(requestId, llm, c, drop.t_ms, drop.input_transcript_revision);
    const key = `x:${requestId ?? `rev${String(drop.input_transcript_revision)}_${Math.round(drop.t_ms)}`}`;
    const item = shell(key, 'dropped', step.t_ms, step.sent_at ?? step.t_ms, null);
    if (item.decisions.length === 0) item.decisions.push(step);
    if (requestId !== null) requestToKey.set(requestId, key);
    item.timeline.push(row);
  }

  const onCandidate = (candidateId: string): ItemShell | undefined => {
    const key = candidateToKey.get(candidateId);
    return key === undefined ? undefined : shells.get(key);
  };

  for (const s of c.states) {
    const item = onCandidate(s.candidate_id);
    if (item === undefined) continue;
    item.timeline.push({
      t_ms: s.t_ms,
      event: 'candidate.state_changed',
      label: `${s.from ?? '（登録）'} → ${s.to}${isShadowCue(c.negotiations, s.candidate_id) && s.to.startsWith('BREATH_') ? '（提示なし）' : ''}`,
      detail: s.cause,
      provenance: s.provenance,
    });
    item.final_state = s.to;
  }
  for (const n of c.negotiations) {
    onCandidate(n.candidate_id)?.timeline.push({
      t_ms: n.t_ms,
      event: 'negotiation.decision',
      label: `交渉 ${n.stage}: ${n.outcome}`,
      detail: n.reasons.join(', '),
      provenance: 'code',
    });
  }
  const signalsByCandidate = new Map<string, Map<string, InhaleRecord>>();
  for (const s of c.signals) {
    const item = onCandidate(s.candidate_id);
    if (item === undefined) continue;
    item.timeline.push({
      t_ms: s.t_ms,
      event: s.event,
      label: `合図 ${s.event.replace('signal.', '')}（${s.phase}）`,
      detail: s.visible === false ? '画面に描画されなかった' : null,
      provenance: 'code',
    });
    let phases = signalsByCandidate.get(s.candidate_id);
    if (phases === undefined) {
      phases = new Map();
      signalsByCandidate.set(s.candidate_id, phases);
    }
    let record = phases.get(s.phase);
    if (record === undefined) {
      record = { phase: s.phase, sent_at: null, started_at: null, visible: null, ended_at: null };
      phases.set(s.phase, record);
      item.inhale.push(record);
    }
    record.sent_at = record.sent_at ?? s.sent_at;
    record.started_at = record.started_at ?? s.started_at;
    record.ended_at = record.ended_at ?? s.ended_at;
    if (s.visible !== null) record.visible = s.visible;
  }
  for (const s of c.speech) {
    if (s.candidate_id === null) continue;
    const item = onCandidate(s.candidate_id);
    if (item === undefined) continue;
    item.timeline.push({
      t_ms: s.started_at ?? s.t_ms,
      event: s.event,
      label: s.event === 'speech.started' ? '発話の開始' : '発話の終了',
      detail: s.spoken_text,
      provenance: 'code',
    });
    let record: SpeechRecord | undefined = item.speech.find((r) => r.audio_playback_id === s.audio_playback_id);
    if (record === undefined) {
      record = { audio_playback_id: s.audio_playback_id, candidate_version: s.candidate_version, started_at: null, ended_at: null, spoken_text: null, outcome: null };
      item.speech.push(record);
    }
    record.started_at = record.started_at ?? s.started_at;
    if (s.event === 'speech.ended') {
      record.ended_at = s.ended_at;
      record.spoken_text = s.spoken_text;
    }
  }
  // その発話の結果（turn.outcome）を詳細へ。候補の発話の記録と audio_playback_id で対応づける。
  for (const outcome of c.outcomes) {
    for (const item of shells.values()) {
      const record = item.speech.find((r) => r.audio_playback_id === outcome.audio_playback_id);
      if (record === undefined) continue;
      record.outcome = speechOutcome(outcome);
      item.timeline.push({
        t_ms: num(outcome.raw.t_monotonic_ms) ?? record.ended_at ?? record.started_at ?? 0,
        event: 'turn.outcome',
        label: `発話の結果（観測に基づく推定）: ${outcome.labels === null ? `分類なし（${outcome.null_reason ?? '理由なし'}）` : outcome.labels.length === 0 ? 'ラベルなし' : outcome.labels.join('、')}`,
        detail: null,
        provenance: 'code',
      });
    }
  }
  // 通常応答の材料（渡した版）と、実際に話した文の比較。同じ候補・版・入力の組で結ぶ。
  const reflectionsByMaterial = new Map<string, Collected['reflections'][number]>();
  const materialKey = (m: { candidate_id: string; candidate_version: number | null; segment_id: number | null; transcript_revision: number | null }) =>
    `${m.candidate_id}|${String(m.candidate_version)}|${String(m.segment_id)}|${String(m.transcript_revision)}`;
  for (const r of c.reflections) reflectionsByMaterial.set(materialKey(r), r);
  for (const material of c.materials) {
    const item = onCandidate(material.candidate_id);
    if (item === undefined) continue;
    const key = materialKey(material);
    const r = reflectionsByMaterial.get(key);
    reflectionsByMaterial.delete(key);
    const view: ReflectionView = {
      t_ms: r?.t_ms ?? material.t_ms,
      candidate_version: material.candidate_version,
      given_text: material.proposed_utterance,
      prompt_version: material.prompt_version,
      given_at: material.t_ms,
      audio_playback_id: r?.audio_playback_id ?? null,
      spoken_text: r?.spoken_text ?? '',
      spoken_outcome: r?.spoken_outcome ?? null,
      interrupted: r?.interrupted ?? false,
      estimated_reflected: r?.estimated_reflected ?? null,
      estimate_reason: r?.estimate_reason ?? null,
      estimate_text: estimateText(r?.estimate ?? null),
    };
    item.reflection.push(view);
    item.timeline.push({ t_ms: material.t_ms, event: 'initiative.response_material', label: `通常応答の材料として渡した（版 ${material.candidate_version ?? '—'}）`, detail: material.proposed_utterance, provenance: 'model_output' });
    if (r) item.timeline.push(reflectionRow(r));
  }
  // 材料の記録なしの比較（古いログなど）も残す。
  for (const r of reflectionsByMaterial.values()) {
    const item = onCandidate(r.candidate_id);
    if (item === undefined) continue;
    item.reflection.push({ t_ms: r.t_ms, candidate_version: r.candidate_version, given_text: r.proposed_utterance, prompt_version: null, given_at: null, audio_playback_id: r.audio_playback_id, spoken_text: r.spoken_text, spoken_outcome: r.spoken_outcome, interrupted: r.interrupted, estimated_reflected: r.estimated_reflected, estimate_reason: r.estimate_reason, estimate_text: estimateText(r.estimate) });
    item.timeline.push(reflectionRow(r));
  }
  for (const said of c.alreadySaid) {
    onCandidate(said.candidate_id)?.timeline.push({
      t_ms: said.t_ms,
      event: 'initiative.already_said',
      label: `撤回: すでに話した内容（${said.stage === 'before_speech' ? '発話の直前' : 'AI の発話の後'}。類似度 ${said.similarity === null ? '—' : Math.round(said.similarity * 1000) / 1000}、基準 ${said.threshold ?? '—'}）`,
      detail: said.matched_text,
      provenance: 'code',
    });
  }
  for (const v of c.vocalCues) {
    onCandidate(v.candidate_id)?.timeline.push({
      t_ms: v.t_ms,
      event: 'initiative.vocal_cue',
      label: `吸気の後の声: 「${v.phrase}」（${v.kind}）`,
      detail: `切れ目 ${v.silence_ms ?? '—'}ms ／ ASR の間 ${v.asr_quiet_ms ?? '—'}ms ／ 結果 ${v.audio_outcome}`,
      provenance: 'code',
    });
  }
  for (const other of c.others) {
    const key = (other.candidate_id !== null ? candidateToKey.get(other.candidate_id) : undefined) ?? (other.request_id !== null ? requestToKey.get(other.request_id) : undefined);
    if (key === undefined) continue;
    shells.get(key)?.timeline.push({
      t_ms: other.t_ms,
      event: other.event,
      label: `（未対応のイベント）${other.event}`,
      detail: other.detail,
      provenance: 'code',
    });
  }

  const items: ReviewItem[] = [...shells.values()]
    .map((item) => {
      const before = lines.filter((l) => l.t_ms <= item.anchor_t_ms).slice(-CONTEXT_BEFORE);
      const after = lines.filter((l) => l.t_ms > item.anchor_t_ms).slice(0, CONTEXT_AFTER);
      const versions = [...new Set(item.decisions.map((d) => d.prompt_version ?? ctx.default_prompt_version ?? '（版の記録なし）'))];
      const lastDecision = item.decisions.at(-1)?.decision;
      const onlyContent = item.kind === 'none' || (item.kind === 'dropped' && lastDecision === 'NONE');
      return {
        ...item,
        prompt_versions: versions,
        headline: headlineOf(item.decisions) + (item.final_state === null ? '' : `（${item.final_state}）`),
        timeline: item.timeline.sort((a, b) => a.t_ms - b.t_ms),
        after_cue: item.candidate_id === null ? null : afterCueOf(c.states.filter((s) => s.candidate_id === item.candidate_id), c.vocalCues.filter((v) => v.candidate_id === item.candidate_id), isShadowCue(c.negotiations, item.candidate_id)),
        context_before: before.map((l) => l.id),
        context_after: after.map((l) => l.id),
        audio_sec: map.secondsAtT(item.anchor_t_ms),
        rate_axes: (onlyContent ? ['content'] : ['content', 'timing', 'wait_withdraw']) as RateAxis[],
      };
    })
    .sort((a, b) => a.t_ms - b.t_ms);
  return { items, lines, hasAudioMap: map.available };
}
