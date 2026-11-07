/**
 * p の時系列のライブ図のためのバッファ（I2）。React と canvas に依存しない純粋なデータ構造。
 *
 * 時間軸はすべて t_monotonic_ms（orchestrator の基準。vap.state はワーカーの audio_frame から、
 * speech.* はブラウザの往復補正で写した値）。図の右端は受信した最新の時刻で、壁時計ではない
 * （JSONL や偽データでも同じに描くため）。
 *
 * p_now／p_future は生の組 [ch1, ch2] のまま保持し、どちらが AI かは描くときに p_ai_index で選ぶ
 * （向きの設定が後から届いても描き直せるように）。vad は契約どおり常に [mic=利用者, sys=AI]。
 */
import type { EventOf, ResearchEvent } from '@llm-vap/contracts';

export type AiIndex = 0 | 1;
export type Pair = readonly [number, number];

/** p の組から AI 側と利用者側を取り出す。添字の向きはここだけで扱う。 */
export function splitByAiIndex(pair: Pair, aiIndex: AiIndex): { ai: number; user: number } {
  return { ai: pair[aiIndex], user: pair[aiIndex === 0 ? 1 : 0] };
}

/** vad の順は p_ai_index に関係なく固定（vap.ts の「ch1=mic, ch2=sys」）。 */
export function splitVad(vad: Pair): { ai: number; user: number } {
  return { ai: vad[1], user: vad[0] };
}

export type VapSample =
  | { t: number; layout: '2ch'; p_now: Pair; p_future: Pair; vad: Pair; user_speaking: boolean }
  | { t: number; layout: '1ch'; p_now: number; p_future: number; vad: number; user_speaking: boolean };

export interface Span {
  start: number;
  /** null は継続中（図では右端まで）。 */
  end: number | null;
}

export interface AiSpeechSpan extends Span {
  audio_playback_id: number;
  origin: 'response' | 'candidate';
  outcome: 'speaking' | 'ended' | 'interrupted';
}

export interface TurnAllowedSpan extends Span {
  allowed: boolean;
  source: string;
}

export interface TimelineMark {
  t: number;
  kind: 'gaze' | 'interrupt' | 'initiative';
  label: string;
}

export interface TimelineView {
  window_ms: number;
  /** 図の右端。データがなければ null。 */
  now_ms: number | null;
  vap: VapSample[];
  ai_speech: AiSpeechSpan[];
  user_speech: Span[];
  turn_allowed: TurnAllowedSpan[];
  marks: TimelineMark[];
}

export const DEFAULT_WINDOW_MS = 60_000;
/** 窓より少し長く持つ（遅れて届く補正済みのイベントのため）。 */
const KEEP_FACTOR = 1.25;
/** 異常な量が来ても画面を止めないための上限。 */
const MAX_VAP = 4000;
const MAX_ITEMS = 2000;

function insertSorted<T extends { t: number }>(list: T[], item: T): void {
  const last = list[list.length - 1];
  if (last === undefined || last.t <= item.t) {
    list.push(item);
    return;
  }
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((list[mid] as T).t <= item.t) lo = mid + 1;
    else hi = mid;
  }
  list.splice(lo, 0, item);
}

type SpeechEvent = EventOf<'speech.started'> | EventOf<'speech.ended'> | EventOf<'speech.interrupted'>;

export class TimelineBuffer {
  private readonly vap: VapSample[] = [];
  private readonly aiSpeech: AiSpeechSpan[] = [];
  private readonly userSpeech: Span[] = [];
  private readonly turnAllowed: TurnAllowedSpan[] = [];
  private readonly marks: TimelineMark[] = [];
  private latest: number | null = null;

  constructor(readonly windowMs: number = DEFAULT_WINDOW_MS) {}

  add(event: ResearchEvent): void {
    switch (event.event) {
      case 'vap.state':
        this.addVap(event);
        break;
      case 'speech.started':
      case 'speech.ended':
      case 'speech.interrupted':
        this.addSpeech(event);
        break;
      case 'turn.allowed': {
        const t = event.t_monotonic_ms;
        const open = this.turnAllowed[this.turnAllowed.length - 1];
        if (open !== undefined && open.end === null) open.end = Math.max(open.start, t);
        this.turnAllowed.push({ start: t, end: null, allowed: event.turn_allowed, source: event.decision_source });
        break;
      }
      case 'gaze.decision':
        insertSorted(this.marks, {
          t: event.t_monotonic_ms,
          kind: 'gaze',
          label: `視線 ${event.target === 'user' ? '利用者へ' : 'そらす'}${event.in_speech_pause ? '（発話内ポーズ）' : ''}`,
        });
        break;
      case 'initiative.decision':
        if (event.decision !== 'NONE') {
          insertSorted(this.marks, {
            t: event.t_monotonic_ms,
            kind: 'initiative',
            label: `発話希望 ${event.decision} ${event.candidate_id}`,
          });
        }
        break;
      default:
        return;
    }
    this.touch(event.t_monotonic_ms);
  }

  private addVap(event: EventOf<'vap.state'>): void {
    const t = event.t_monotonic_ms;
    const sample: VapSample =
      event.channel_layout === '2ch'
        ? { t, layout: '2ch', p_now: event.p_now, p_future: event.p_future, vad: event.vad, user_speaking: event.user_speaking }
        : { t, layout: '1ch', p_now: event.p_now, p_future: event.p_future, vad: event.vad, user_speaking: event.user_speaking };
    insertSorted(this.vap, sample);
    // 利用者の発話区間は VAP の user_speaking の連続から作る（MaAI が判定した値）。
    const open = this.userSpeech[this.userSpeech.length - 1];
    const isOpen = open !== undefined && open.end === null;
    if (event.user_speaking && !isOpen) this.userSpeech.push({ start: t, end: null });
    else if (!event.user_speaking && isOpen) open.end = Math.max(open.start, t);
  }

  private addSpeech(event: SpeechEvent): void {
    const id = event.audio_playback_id;
    let span = this.aiSpeech.find((s) => s.audio_playback_id === id);
    if (event.event === 'speech.started') {
      if (span === undefined) {
        span = { start: event.started_at, end: null, audio_playback_id: id, origin: event.origin, outcome: 'speaking' };
        this.aiSpeech.push(span);
        this.aiSpeech.sort((a, b) => a.start - b.start);
      }
      return;
    }
    const end = event.event === 'speech.ended' ? event.ended_at : event.interrupted_at;
    if (span === undefined) {
      // 開始を受ける前の終わり（画面を途中で開いた）。開始時刻は終わりのイベントが持っている。
      span = { start: event.started_at, end, audio_playback_id: id, origin: event.origin, outcome: 'speaking' };
      this.aiSpeech.push(span);
      this.aiSpeech.sort((a, b) => a.start - b.start);
    }
    span.end = Math.max(span.start, end);
    span.outcome = event.event === 'speech.ended' ? 'ended' : 'interrupted';
    if (event.event === 'speech.interrupted') {
      insertSorted(this.marks, { t: end, kind: 'interrupt', label: `割り込みで停止（${event.decision_source}）` });
      this.touch(end);
    }
  }

  private touch(t: number): void {
    if (this.latest === null || t > this.latest) this.latest = t;
    this.prune();
  }

  private prune(): void {
    if (this.latest === null) return;
    const cutoff = this.latest - this.windowMs * KEEP_FACTOR;
    let drop = 0;
    while (drop < this.vap.length && (this.vap[drop] as VapSample).t < cutoff) drop += 1;
    drop = Math.max(drop, this.vap.length - MAX_VAP);
    if (drop > 0) this.vap.splice(0, drop);
    for (const list of [this.aiSpeech, this.userSpeech, this.turnAllowed] as Span[][]) {
      // 閉じていて窓より古い区間だけを捨てる。turn.allowed は最後の 1 つを残す（いまの状態）。
      let n = 0;
      while (n < list.length - 1 && (list[n] as Span).end !== null && ((list[n] as Span).end as number) < cutoff) n += 1;
      n = Math.max(n, list.length - MAX_ITEMS);
      if (n > 0) list.splice(0, n);
    }
    let m = 0;
    while (m < this.marks.length && (this.marks[m] as TimelineMark).t < cutoff) m += 1;
    m = Math.max(m, this.marks.length - MAX_ITEMS);
    if (m > 0) this.marks.splice(0, m);
  }

  /** 窓の中にかかるものだけを複製して返す。 */
  view(): TimelineView {
    const now = this.latest;
    if (now === null) {
      return { window_ms: this.windowMs, now_ms: null, vap: [], ai_speech: [], user_speech: [], turn_allowed: [], marks: [] };
    }
    const from = now - this.windowMs;
    const inWindow = <T extends Span>(s: T) => s.end === null || s.end >= from;
    return {
      window_ms: this.windowMs,
      now_ms: now,
      vap: this.vap.filter((s) => s.t >= from),
      ai_speech: this.aiSpeech.filter(inWindow).map((s) => ({ ...s })),
      user_speech: this.userSpeech.filter(inWindow).map((s) => ({ ...s })),
      turn_allowed: this.turnAllowed.filter(inWindow).map((s) => ({ ...s })),
      marks: this.marks.filter((m) => m.t >= from),
    };
  }
}
