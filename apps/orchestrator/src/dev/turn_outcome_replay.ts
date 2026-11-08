/**
 * 録音（events.jsonl）から、AI の発話の結果（turn.outcome）を再生の結果と同じ形で作る。
 *  - 記録に turn.outcome があれば、それをそのまま使う。古いログには無いので、記録の VAP、STT、発話の区間から
 *    control/turn_outcome.ts の同じ関数で算出する（文は読むが出力には残さない）。
 *  - 再計算の側は再生の開始と再生の区間で同じ関数を通す。反実仮想の限界は replay.ts のまま。
 *
 * 開始の判断には何も書き戻さない。
 */
import { absent, present } from '@llm-vap/contracts';
import type { Maybe, ResearchEvent, TurnAllowedPayload, TurnOutcomeBody } from '@llm-vap/contracts';
import { buildTurnOutcome } from '../control/turn_outcome';
import type { OutcomeAiEnd, OutcomePlaybackInput, OutcomeSettings, OutcomeSttRow, OutcomeVapRow } from '../control/turn_outcome';
import type { PreparedLog } from './replay';

export interface OutcomeLogRows {
  vap: OutcomeVapRow[];
  stt: OutcomeSttRow[];
}

export function outcomeRows(log: Pick<PreparedLog, 'vap' | 'stt'>, keyOf: (e: PreparedLog['stt'][number]) => number): OutcomeLogRows {
  return {
    vap: log.vap.map((v) => ({ t: v.recv, frame: v.frame, vad_user: v.vadUser })),
    stt: log.stt.map((e) => ({ t: e.t_monotonic_ms, key: keyOf(e), audio_frame_end: e.audio_frame_end, text: e.text })),
  };
}

function stripEnvelope(e: Extract<ResearchEvent, { event: 'turn.outcome' }>): TurnOutcomeBody {
  const { schema_version: _s, t_monotonic_ms: _t, wall_clock: _w, session_id: _id, condition: _c, time_basis: _b, ...body } = e;
  return body as TurnOutcomeBody;
}

function vadAt(rows: PreparedLog['vap'], t: number): { vad: { user: number; ai: number }; age: number } | null {
  let found: PreparedLog['vap'][number] | null = null;
  for (const row of rows) {
    if (row.recv > t) break;
    found = row;
  }
  return found === null ? null : { vad: { user: found.state.vad[0], ai: found.state.vad[1] }, age: t - found.recv };
}

function conversationKind(events: readonly ResearchEvent[]): Maybe<string> {
  for (const e of events) if ((e.event === 'initiative.desire' || e.event === 'initiative.timing') && e.conversation_kind) return present(e.conversation_kind);
  return absent('no_staged_conversation_kind');
}

/** 記録の側。ログに turn.outcome があればそれ、なければ算出する。 */
export function recordedTurnOutcomes(log: PreparedLog, rows: OutcomeLogRows, settings: OutcomeSettings, frameAt: (t: number) => number): TurnOutcomeBody[] {
  const recorded = log.events.filter((e): e is Extract<ResearchEvent, { event: 'turn.outcome' }> => e.event === 'turn.outcome');
  if (recorded.length > 0) return recorded.map(stripEnvelope);
  const kind = conversationKind(log.events);
  let previous: OutcomeAiEnd | null = null;
  const out: TurnOutcomeBody[] = [];
  for (const speech of [...log.speechById.values()].sort((a, b) => a.started - b.started)) {
    let found: { t: number; payload: TurnAllowedPayload } | null = null;
    for (const row of log.recordedAllowedPayloads) {
      if (row.t > speech.started) break;
      if (row.payload.turn_allowed) found = row;
    }
    if (found === null) continue;
    const vad = vadAt(log.vap, found.t);
    const playback: OutcomePlaybackInput | null =
      speech.ended === null || speech.start_frame === null || speech.end_frame === null
        ? null
        : {
            started_at: speech.playback_started_at,
            start_frame: speech.start_frame,
            ended_at: speech.playback_ended_at,
            end_frame: speech.end_frame,
            interrupted: speech.interrupted,
            spoken_text: speech.spoken_text,
          };
    out.push(
      buildTurnOutcome(
        {
          start: {
            audio_playback_id: speech.id,
            segment_id: 0,
            origin: speech.origin,
            candidate_id: speech.candidate_id === null ? absent('normal_response') : present(speech.candidate_id),
            conversation_kind: kind,
            decided_at: found.t,
            audio_frame: Math.max(0, frameAt(found.t)),
            payload: found.payload,
            vad: vad?.vad ?? null,
            vap_age_ms: vad?.age ?? null,
          },
          playback,
          null_reason: speech.ended === null ? 'speech_end_not_recorded' : null,
          vap: rows.vap,
          stt: rows.stt,
          previous_ai_end: previous,
        },
        settings,
      ),
    );
    if (speech.ended !== null) previous = { at: speech.playback_ended_at };
  }
  return out;
}

export interface ReplayStartDetail {
  t: number;
  audio_playback_id: number;
  segment_id: number;
  origin: 'response';
  frame: number;
  payload: TurnAllowedPayload;
  vad: { user: number; ai: number } | null;
  vap_age_ms: number | null;
}

export interface ReplayPlaybackDetail {
  id: number;
  begin_at: number;
  end_at: number;
  interrupted: boolean;
  spoken_text: string | null;
}

/** 再計算の側。再生の開始ごとに同じ関数で分類する。 */
export function replayedTurnOutcomes(
  starts: readonly ReplayStartDetail[],
  playbacks: readonly ReplayPlaybackDetail[],
  rows: OutcomeLogRows,
  settings: OutcomeSettings,
  frameAt: (t: number) => number,
): TurnOutcomeBody[] {
  const byId = new Map(playbacks.map((p) => [p.id, p]));
  const out: TurnOutcomeBody[] = [];
  let previous: OutcomeAiEnd | null = null;
  for (const start of starts) {
    const play = byId.get(start.audio_playback_id) ?? null;
    const playback: OutcomePlaybackInput | null =
      play === null
        ? null
        : {
            started_at: play.begin_at,
            start_frame: Math.max(0, frameAt(play.begin_at)),
            ended_at: play.end_at,
            end_frame: Math.max(0, frameAt(play.end_at)),
            interrupted: play.interrupted,
            spoken_text: play.spoken_text,
          };
    out.push(
      buildTurnOutcome(
        {
          start: {
            audio_playback_id: start.audio_playback_id,
            segment_id: start.segment_id,
            origin: start.origin,
            candidate_id: absent('replay_is_response_only'),
            conversation_kind: absent('not_recomputed_in_replay'),
            decided_at: start.t,
            audio_frame: start.frame,
            payload: start.payload,
            vad: start.vad,
            vap_age_ms: start.vap_age_ms,
          },
          playback,
          null_reason: play === null ? 'replay_session_ended_during_speech' : null,
          vap: rows.vap,
          stt: rows.stt,
          previous_ai_end: previous,
        },
        settings,
      ),
    );
    if (play !== null) previous = { at: play.end_at };
  }
  return out;
}
