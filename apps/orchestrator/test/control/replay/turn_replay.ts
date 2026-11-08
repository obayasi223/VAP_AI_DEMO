/**
 * 実セッションの抜き出し（fixtures/turn_replay/、tools/turn_replay/extract_fixture.ts）を TurnManager に再生する。
 * docs/known_gaps.md §10 の前後比較と、after_ai_speech／start_guard の回帰試験に使う。
 *
 * 再生の前提と限界:
 *  - 区間（Episode）ごとに初期状態から回す。区間の始めは直前の AI の発話の終わり（またはセッションの始め）。
 *  - 実際の AI の発話が始まった時刻（contaminated_from_ms）より後は、VAP の ch2 に実際の AI の声が入っている。
 *    再生の方策がまだ話していない場合に合わないので、それ以後は p_now_ai と p_future_ai をその直前の値で止め、
 *    vad[1] を 0 にする。vad[0]（利用者のマイク、ヘッドセット）は実測のまま使う。利用者が実際の AI の声に
 *    反応して黙った（または話した）ことは再現できない。
 *  - honored_ai の区間は、実際の AI の発話をそのまま再生中として渡す（AI の発話の終わりの扱いを見るため）。
 *  - 準備（LLM と TTS）は呼ばない。prepare から ready までは、実際に同じ revision で準備したときの遅れ、
 *    なければ実測の中央値。文を持たないので類似度（L47）は計算できない。実際に準備した revision では 0、
 *    それ以外では 1（止める）を渡し、準備の起動を実際に合わせる（その segment の最初の準備は U-5 で常に通る）。
 *  - 文は持たない（利用者の発話を fixtures に置かない）。ASR 区間ごとの正規化後の文字数だけを、位置ごとに
 *    違う意味のない文字で埋めて渡す。前の revision の接頭部になる関係は保つが、書き直し（語の入れ替え）は
 *    再現しない。招待の語句の検出もしない（このセッションでは招待は検出されていない）。
 *  - ターン完了の p は抜き出しのときに実際の文で ja_rules_v1 を計算した値（revision ごと）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TurnInputs, absent, present } from '@llm-vap/contracts';
import type { Policy, TranscriptSnapshot, Vap2chState } from '@llm-vap/contracts';
import { createTurnManager } from '../../../src/control';
import type { TurnState } from '../../../src/control';
import { repoRoot } from '../helpers';

export interface FixtureStt {
  t_ms: number;
  is_final: boolean;
  segment_id: number;
  asr_segment_id: number;
  transcript_revision: number;
  audio_frame_end: number;
  chars: number;
  completion_p: number | null;
}

export interface Fixture {
  session_id: string;
  /** [t_ms, audio_frame, vad0, vad1, p_now_ai, p_future_ai] */
  vap: [number, number, number, number, number, number][];
  stt: FixtureStt[];
  speech: { audio_playback_id: number; started_ms: number; ended_ms: number | null; audio_frame_start: number }[];
  prefetch_latency_ms: { median: number; values: number[] };
  /** 実際に準備を起動した revision と、その準備の遅れ（ready が来なければ null）。 */
  prepares: { segment_id: number; transcript_revision: number; started_ms: number; latency_ms: number | null }[];
}

export function loadFixture(sessionId: string): Fixture {
  return JSON.parse(readFileSync(join(repoRoot, 'fixtures', 'turn_replay', `${sessionId}.json`), 'utf8')) as Fixture;
}

export interface Episode {
  name: string;
  from_ms: number;
  /** この時刻以降は VAP の p を止める（実際の AI の発話の始まり）。 */
  contaminated_from_ms: number;
  until_ms: number;
  /** 実際の AI の発話をそのまま再生中として渡す区間。 */
  honored_ai?: { from_ms: number; to_ms: number };
  /** 再生に入れる STT の segment（実際の番号）。next は contaminated_from_ms 以降だけ入れる。 */
  segment: number;
  next_segment: number;
}

export interface ReplayResult {
  episode: string;
  /** 再生の方策が話し始めた時刻。区間の中で始めなければ null。 */
  start_ms: number | null;
  start_reason: string | null;
  /** 開始の前に利用者の声（vad[0] ≥ 0.5）が最後にあった時刻。 */
  last_voiced_ms: number | null;
  delay_ms: number | null;
  /** 開始後 1.5 秒以内に利用者の発話の続き（新しい文字、開始より後の音声）が来たか。 */
  mid_utterance: boolean;
  /** 開始までに許可（turn_allowed）が出た回数と、そのうち 1.5 秒以内に続きが来た回数。 */
  allowed_windows: number;
  allowed_mid_utterance: number;
}

const CONTINUATION_WINDOW_MS = 1500;
const TICK_MS = 20;
const WORKER_STARTED_AT = 200;

/** 位置ごとに違う意味のない文字（ASR 区間ごとにずらす）。 */
function placeholder(asrSegmentId: number, chars: number): string {
  let out = '';
  for (let i = 0; i < chars; i++) out += String.fromCodePoint(0x4e00 + ((asrSegmentId * 400 + i) % 20000));
  return out;
}

function streamOf(fixture: Fixture, ep: Episode): FixtureStt[] {
  return fixture.stt.filter(
    (s) =>
      s.t_ms >= ep.from_ms - 0 &&
      (s.segment_id === ep.segment || (s.segment_id === ep.next_segment && s.t_ms >= ep.contaminated_from_ms)),
  );
}

/** 時刻 t までに届いた文の総文字数（ASR 区間ごとの最新の和）。 */
function charsAt(stream: FixtureStt[], t: number): number {
  const latest = new Map<number, number>();
  for (const s of stream) if (s.t_ms <= t) latest.set(s.asr_segment_id, s.chars);
  return [...latest.values()].reduce((a, b) => a + b, 0);
}

function frameAt(fixture: Fixture, t: number): number {
  let frame = 0;
  for (const v of fixture.vap) if (v[0] <= t) frame = v[1];
  return frame;
}

/** 開始（または許可）の時刻 t の後に、利用者の発話の続きが来たか。 */
export function continuedAfter(fixture: Fixture, stream: FixtureStt[], t: number): boolean {
  const base = charsAt(stream, t);
  const frame = frameAt(fixture, t);
  return stream.some(
    (s) => s.t_ms > t && s.t_ms <= t + CONTINUATION_WINDOW_MS && s.audio_frame_end > frame && charsAt(stream, s.t_ms) > base,
  );
}

function lastVoiced(fixture: Fixture, t: number): number | null {
  let last: number | null = null;
  for (const v of fixture.vap) if (v[0] <= t && v[2] >= 0.5) last = v[0];
  return last;
}

function vapState(row: Fixture['vap'][number], frozen: Fixture['vap'][number] | null): Vap2chState {
  const [, audio_frame, vad0, vad1, pNow, pFut] = row;
  const p = frozen === null ? { pNow, pFut, vad1 } : { pNow: frozen[4], pFut: frozen[5], vad1: 0 };
  return {
    t: 0,
    audio_frame,
    model_variant: 'replay_of_logged_maai_values',
    inference_ms: 0,
    raw: {},
    channel_layout: '2ch',
    p_now: [1 - p.pNow, p.pNow],
    p_future: [1 - p.pFut, p.pFut],
    vad: [vad0, p.vad1],
    user_speaking: vad0 >= 0.5,
    system_speaking: p.vad1 >= 0.5,
  };
}

type Prefetch =
  | { state: 'idle' }
  | { state: 'preparing'; id: number; segment_id: number; revision: number; started_at: number; ready_at: number };

export function replayEpisode(fixture: Fixture, ep: Episode, policy: Policy): ReplayResult {
  const manager = createTurnManager(policy);
  let state: TurnState = manager.initialState();
  const stream = streamOf(fixture, ep);
  const latency = fixture.prefetch_latency_ms.median;
  const realPrepares = new Set(fixture.prepares.map((p) => p.transcript_revision));
  const frozen = [...fixture.vap].reverse().find((v) => v[0] < ep.contaminated_from_ms) ?? null;
  let prefetch: Prefetch = { state: 'idle' };
  let lastPrepared: { text: string; segment_id: number } | null = null;
  let nextId = 1000;
  let start: { at: number; reason: string } | null = null;
  let lastReason = '';
  let wasPermitted = false;
  const allowedAt: number[] = [];

  for (let now = ep.from_ms; now <= ep.until_ms && start === null; now += TICK_MS) {
    const row = [...fixture.vap].reverse().find((v) => v[0] <= now) ?? null;
    const stt = [...stream].reverse().find((s) => s.t_ms <= now) ?? null;
    const transcript: TranscriptSnapshot | null =
      stt === null
        ? null
        : {
            segment_id: 0,
            asr_segment_id: stt.asr_segment_id,
            asr_segment_frame_start: 0,
            transcript_revision: stt.transcript_revision,
            text: placeholder(stt.asr_segment_id, stt.chars),
            stable_text: '',
            unstable_text: '',
            is_final: stt.is_final,
            stability: absent('replay'),
            stability_source: 'derived',
            audio_frame_end: stt.audio_frame_end,
            timing_precision: 'result_end_offset',
            words: absent('replay'),
            received_at: stt.t_ms,
          };
    const honored = ep.honored_ai !== undefined && now >= ep.honored_ai.from_ms && now < ep.honored_ai.to_ms;
    const ready = prefetch.state === 'preparing' && now >= prefetch.ready_at;
    const inputs = TurnInputs.parse({
      vap: row === null ? absent('no_vap_state_since_ready') : present(vapState(row, now >= ep.contaminated_from_ms ? frozen : null)),
      vap_received_at: row === null ? absent('no_vap_state_since_ready') : present(row[0]),
      received_audio_frame: row?.[1] ?? 0,
      vap_worker_started_at: present(WORKER_STARTED_AT),
      fallback_energy: absent('replay_has_no_energy'),
      transcript: transcript === null ? absent('no_transcript_yet') : present(transcript),
      completion_p: stt?.completion_p == null ? absent('no_estimate_yet') : present(stt.completion_p),
      completion_revision: stt?.completion_p == null ? absent('no_estimate_yet') : present(stt.transcript_revision),
      similarity_to_prepared:
        transcript === null || lastPrepared === null
          ? absent('no_previous_prepare')
          : lastPrepared.segment_id !== state.segment_id
            ? absent('previous_prepare_in_other_segment')
            : present(realPrepares.has(transcript.transcript_revision) ? 0 : 1),
      prefetch:
        prefetch.state === 'idle'
          ? { state: 'idle' }
          : {
              state: ready ? 'ready' : 'preparing',
              audio_playback_id: prefetch.id,
              segment_id: prefetch.segment_id,
              transcript_revision: prefetch.revision,
              started_at: prefetch.started_at,
            },
      playback: honored
        ? { state: 'playing', audio_playback_id: 1, samples_written: 0, system_silence_ms: 0 }
        : { state: 'idle' },
      woz: [],
    });
    const out = manager.step(state, inputs, now);
    state = out.state;
    for (const d of out.decisions) {
      if (d.kind === 'turn_allowed') lastReason = d.payload.reason;
      if (d.kind === 'prepare') {
        const real = fixture.prepares.find((x) => x.transcript_revision === d.transcript_revision);
        const wait = real?.latency_ms ?? latency;
        prefetch = { state: 'preparing', id: nextId++, segment_id: d.segment_id, revision: d.transcript_revision, started_at: now, ready_at: now + wait };
        lastPrepared = { text: d.text, segment_id: d.segment_id };
      }
      if (d.kind === 'cancel_prepare' && prefetch.state !== 'idle' && prefetch.id === d.audio_playback_id) prefetch = { state: 'idle' };
      if (d.kind === 'start_speech') start = { at: now, reason: lastReason };
    }
    if (state.permitted_to_speak && !wasPermitted && start === null) allowedAt.push(now);
    wasPermitted = state.permitted_to_speak;
  }

  const startMs = start?.at ?? null;
  const voiced = startMs === null ? null : lastVoiced(fixture, startMs);
  return {
    episode: ep.name,
    start_ms: startMs,
    start_reason: start?.reason ?? null,
    last_voiced_ms: voiced,
    delay_ms: startMs === null || voiced === null ? null : Math.round(startMs - voiced),
    mid_utterance: startMs !== null && continuedAfter(fixture, stream, startMs),
    allowed_windows: allowedAt.length,
    allowed_mid_utterance: allowedAt.filter((t) => continuedAfter(fixture, stream, t)).length,
  };
}

/** 実際のセッションでの開始（比較の基準）。 */
export function realStart(fixture: Fixture, ep: Episode): Pick<ReplayResult, 'start_ms' | 'last_voiced_ms' | 'delay_ms' | 'mid_utterance'> {
  const s = fixture.speech.find((x) => x.started_ms >= ep.from_ms && x.started_ms <= ep.until_ms && (ep.honored_ai === undefined || x.started_ms >= ep.honored_ai.to_ms));
  if (s === undefined) return { start_ms: null, last_voiced_ms: null, delay_ms: null, mid_utterance: false };
  const voiced = lastVoiced(fixture, s.started_ms);
  return {
    start_ms: s.started_ms,
    last_voiced_ms: voiced,
    delay_ms: voiced === null ? null : Math.round(s.started_ms - voiced),
    mid_utterance: continuedAfter(fixture, streamOf(fixture, ep), s.started_ms),
  };
}

/** s20261108T045055-ca6e12 の区間（ヘッドセットあり、利用者の確認済み）。 */
export const SESSION_2_EPISODES: Episode[] = [
  { name: 'E1 挨拶と研究の紹介', from_ms: 0, contaminated_from_ms: 11134, until_ms: 16271, segment: 0, next_segment: 1 },
  { name: 'E2 研究の焦点（3つの ASR 区間）', from_ms: 16271, contaminated_from_ms: 33092, until_ms: 40375, segment: 1, next_segment: 2 },
  { name: 'E3 オンラインの利点（直後に「で」）', from_ms: 40375, contaminated_from_ms: 50285, until_ms: 57400, segment: 2, next_segment: 3 },
  {
    name: 'E4 AI の発話中の「で」と AI の発話の終わり',
    from_ms: 50285,
    honored_ai: { from_ms: 50285, to_ms: 57401 },
    contaminated_from_ms: 58081,
    until_ms: 65000,
    segment: 3,
    next_segment: 4,
  },
  { name: 'E5 「はい、そうですね」', from_ms: 63255, contaminated_from_ms: 67602, until_ms: 72080, segment: 4, next_segment: 5 },
];
