/**
 * H3 の符号化の書き出し（--coding。04 D、AC21。第 3 回 M3）。材料は events.jsonl だけ。
 * coding_utterances.csv（本人の発話と印）、coding_stages.csv（段の境界）、coding_texts.jsonl（本文）。
 * CSV に本文は入れない（text_ref で結ぶ）。--blind は条件の列を空にし、セッションの ID を符号にする。
 */
import { csv } from './csv';
import { frameToMonotonic, ofType, sha256, type Ev, type TwoAiSessionData } from './session';
import { contentClock, stageSpans, syncMarkTime, turnAt } from './timeline';

export const UTTERANCE_COLUMNS = [
  'session_id', 'condition', 'row_kind', 'row_id', 'phase', 'stage', 't_content_ms', 't_phase_ms', 't_wall_ms', 't_monotonic_ms', 't_source',
  'linked_marker_id', 'prev_ai_turn_id', 'overlap', 'prev_ai_id', 'prev_turn_kind', 'prev_point_id', 'prev_point_variant',
  'interjection_id', 'outcome', 'near_marker', 'correction', 'counted', 'duration_ms', 'chars', 'text_ref',
] as const;

export const STAGE_COLUMNS = [
  'session_id', 'condition', 'stage', 'heading', 'started_t_content_ms', 'ended_t_content_ms', 'started_wall_ms', 'ended_wall_ms',
  'started_monotonic_ms', 'ended_monotonic_ms', 'offset_in_audio_ms', 'first_turn_id', 'sync_flash_monotonic_ms', 'n_utterances', 'n_markers',
] as const;

export interface CodingOptions {
  blind?: boolean;
  /** 発話の始まりの前、この長さの中でいちばん近い印を結ぶ（既定 10000）。 */
  markerLinkMs?: number;
  /** 盲検の符号の塩（既定は固定の文字列。研究者が変えられる）。 */
  blindSalt?: string;
}

export interface CodingOutput {
  utterances: Record<string, unknown>[];
  stages: Record<string, unknown>[];
  texts: { text_ref: string; text: string }[];
  /** intake の発話の件数（符号化の対象外）。 */
  intake_utterances: number;
}

export function blindCode(session_id: string, salt = 'two_ai_blind_v1'): string {
  return `S${sha256(`${salt}:${session_id}`).slice(0, 8)}`;
}

function phaseGroup(phase: string | null): 'discussion' | 'response' | 'closing' | null {
  if (phase === 'discussion' || phase === 'response') return phase;
  if (phase === 'next_step' || phase === 'end') return 'closing';
  return null;
}

/** 本人の発話の始まりの orchestrator の時刻。 */
function utteranceStart(data: TwoAiSessionData, f: Ev<'stt.final'>): { t: number; source: string } {
  const fromAudio = frameToMonotonic(data, f.asr_segment_frame_start);
  if (fromAudio !== null) return { t: fromAudio, source: 'frame' };
  const sync = ofType(data.events, 'clock.sync').filter((c) => c.source === 'worker_audio_frame' && c.t_monotonic_ms <= f.t_monotonic_ms).at(-1);
  if (sync !== undefined) return { t: f.asr_segment_frame_start / 16 + sync.offset_ms, source: 'frame' };
  const interim = ofType(data.events, 'stt.interim').find((i) => i.asr_segment_id === f.asr_segment_id);
  if (interim !== undefined) return { t: interim.t_monotonic_ms, source: 'first_interim' };
  return { t: f.t_monotonic_ms - Math.max(0, (f.audio_frame_end - f.asr_segment_frame_start) / 16), source: 'final_minus_duration' };
}

export function buildCoding(data: TwoAiSessionData, options: CodingOptions = {}): CodingOutput {
  const blind = options.blind ?? false;
  const linkMs = options.markerLinkMs ?? 10_000;
  const sessionId = blind ? blindCode(data.session_id, options.blindSalt) : data.session_id;
  const cond = blind ? '' : (data.two_ai?.condition ?? data.events[0]?.condition ?? '');
  const clock = contentClock(data.events);
  const phases = ofType(data.events, 'two_ai.phase_changed');
  const phaseStart = (t: number) => phases.filter((p) => p.t_monotonic_ms <= t).at(-1)?.t_monotonic_ms ?? null;
  const wallAt = (t: number) => {
    const ref = data.events.find((e) => e.time_basis.source === 'orchestrator') ?? data.events[0];
    return ref ? Date.parse(ref.wall_clock) + (t - ref.t_monotonic_ms) : null;
  };
  const markers = ofType(data.events, 'two_ai.marker');
  const episodes = ofType(data.events, 'two_ai.interjection_episode');
  const scripts = ofType(data.events, 'two_ai.script');
  const finals = ofType(data.events, 'stt.final');
  const rows: (Record<string, unknown> & { _t: number })[] = [];
  const texts: { text_ref: string; text: string }[] = [];
  let intake = 0;
  for (const f of finals) {
    const group = phaseGroup(f.two_ai?.phase ?? null);
    if (group === null) {
      if (f.two_ai?.phase === 'intake') intake += 1;
      continue;
    }
    const start = utteranceStart(data, f);
    const prev = turnAt(data.events, start.t);
    const linked = markers.filter((m) => m.t_monotonic_ms <= start.t && start.t - m.t_monotonic_ms <= linkMs).at(-1) ?? null;
    const ep = episodes.find((e) => e.asr_segment_ids.includes(f.asr_segment_id)) ?? null;
    const sc = scripts.find((s) => s.asr_segment_ids.includes(f.asr_segment_id)) ?? null;
    // 盲検で複数のセッションを 1 つの表にまとめるので、符号を前に付ける
    const ref = blind ? `${sessionId}:stt:${f.asr_segment_id}` : `stt:${f.asr_segment_id}`;
    texts.push({ text_ref: ref, text: f.text });
    const ps = phaseStart(start.t);
    rows.push({
      _t: start.t,
      session_id: sessionId,
      condition: cond,
      row_kind: 'utterance',
      row_id: f.asr_segment_id,
      phase: group,
      stage: group === 'discussion' ? (f.two_ai?.discussion_stage ?? null) : null,
      t_content_ms: group === 'discussion' ? clock.at(start.t) : null,
      t_phase_ms: ps === null ? null : Math.round(start.t - ps),
      t_wall_ms: wallAt(start.t),
      t_monotonic_ms: Math.round(start.t),
      t_source: start.source,
      linked_marker_id: linked?.marker_id ?? null,
      prev_ai_turn_id: prev?.turn_id ?? null,
      overlap: prev?.overlap ?? null,
      prev_ai_id: prev?.ai_id ?? null,
      prev_turn_kind: prev?.turn_kind ?? null,
      prev_point_id: prev?.point_id ?? null,
      prev_point_variant: prev?.point_variant ?? null,
      interjection_id: ep?.interjection_id ?? null,
      outcome: ep?.outcome ?? null,
      near_marker: ep?.near_marker ?? null,
      correction: sc?.stage ?? null,
      counted: null,
      duration_ms: Math.round(Math.max(0, f.audio_frame_end - f.asr_segment_frame_start) / 16),
      chars: [...f.text].length,
      text_ref: ref,
    });
  }
  for (const m of markers) {
    const group = phaseGroup(m.two_ai?.phase ?? null);
    if (group === null) continue;
    const ps = phaseStart(m.t_monotonic_ms);
    rows.push({
      _t: m.t_monotonic_ms,
      session_id: sessionId,
      condition: cond,
      row_kind: 'marker',
      row_id: m.marker_id,
      phase: group,
      stage: group === 'discussion' ? (m.discussion_stage ?? m.two_ai?.discussion_stage ?? null) : null,
      t_content_ms: group === 'discussion' ? clock.at(m.t_monotonic_ms) : null,
      t_phase_ms: ps === null ? null : Math.round(m.t_monotonic_ms - ps),
      t_wall_ms: Date.parse(m.wall_clock),
      t_monotonic_ms: Math.round(m.t_monotonic_ms),
      t_source: m.time_basis.source === 'browser_rtt' ? 'browser_rtt' : 'orchestrator',
      linked_marker_id: null,
      prev_ai_turn_id: m.turn_id,
      overlap: m.turn_id !== null,
      prev_ai_id: m.ai_speaking,
      prev_turn_kind: m.turn_kind,
      prev_point_id: m.during_point_id,
      prev_point_variant: null,
      interjection_id: m.interjection_id,
      outcome: null,
      near_marker: null,
      correction: null,
      counted: m.counted,
      duration_ms: null,
      chars: null,
      text_ref: null,
    });
  }
  rows.sort((a, b) => a._t - b._t);
  const utterances = rows.map(({ _t: _drop, ...r }) => r);

  const stages = stageSpans(data).map((s) => {
    const inSpan = (t: number) => t >= s.started_at && (s.ended_at === null || t < s.ended_at);
    return {
      session_id: sessionId,
      condition: cond,
      stage: s.stage,
      heading: s.heading,
      started_t_content_ms: s.started_content_ms,
      ended_t_content_ms: s.ended_content_ms,
      started_wall_ms: s.started_wall ? Date.parse(s.started_wall) : null,
      ended_wall_ms: s.ended_wall ? Date.parse(s.ended_wall) : null,
      started_monotonic_ms: Math.round(s.started_at),
      ended_monotonic_ms: s.ended_at === null ? null : Math.round(s.ended_at),
      offset_in_audio_ms: data.audio === null ? null : Math.round(s.started_at - data.audio.first_t_monotonic_ms),
      first_turn_id: s.first_turn_id,
      sync_flash_monotonic_ms: syncMarkTime(data, s.sync_trigger),
      n_utterances: rows.filter((r) => r.row_kind === 'utterance' && inSpan(r._t)).length,
      n_markers: rows.filter((r) => r.row_kind === 'marker' && inSpan(r._t)).length,
    };
  });
  return { utterances, stages, texts, intake_utterances: intake };
}

export function codingFiles(out: CodingOutput): { 'coding_utterances.csv': string; 'coding_stages.csv': string; 'coding_texts.jsonl': string } {
  return {
    'coding_utterances.csv': csv(UTTERANCE_COLUMNS, out.utterances),
    'coding_stages.csv': csv(STAGE_COLUMNS, out.stages),
    'coding_texts.jsonl': out.texts.map((t) => JSON.stringify(t)).join('\n') + (out.texts.length > 0 ? '\n' : ''),
  };
}

