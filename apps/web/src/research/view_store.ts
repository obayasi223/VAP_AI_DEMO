/**
 * イベント列から研究者画面の表示内容を作る。React に依存しない。
 * 届いた値は必ずスキーマで検証し、不合格は数えて表示する（捨てても黙らない）。
 */
import {
  FAKE_MODEL_VARIANT,
  NodeToResearch,
  ResearchEvent,
  type EventOf,
  type ResearchNoteMessage,
} from '@llm-vap/contracts';
import {
  computeLatencyReport,
  isLatencyRelevant,
  summarizeCost,
  type CostSummary,
  type LatencyReport,
} from '@llm-vap/analysis';
import { CandidateTracker, type CandidateSummary } from './candidates_view';
import type { FeedConnection, FeedSink, ResearchFeed } from './feed';
import { OutcomeTracker, type InterruptStats, type PrepareStats } from './rates';
import { TimelineBuffer, type AiIndex, type TimelineView } from './timeline';

export interface ProviderRow {
  provider: string;
  provider_class: string;
  status: string;
  reason: string | null;
  retry_attempt: number;
  at_ms: number;
}

export interface ClockRow {
  source: string;
  offset_ms: number;
  error_ms: number;
  rtt_ms: number | null;
  at_ms: number;
}

export interface CurrentState {
  vap: {
    user_speaking: boolean;
    system_speaking: boolean | null;
    audio_frame: number;
    model_variant: string;
    channel_layout: string;
    at_ms: number;
  } | null;
  turn: { allowed: boolean; source: string; reason: string; freshness: string; at_ms: number } | null;
  speech: { state: 'speaking' | 'ended' | 'interrupted'; playback_id: number; origin: string; at_ms: number } | null;
  gaze: { target: string; reason: string; at_ms: number } | null;
  audio: {
    context: string;
    visibility: string;
    frames_lost: number;
    underrun_count: number;
    echo_cancellation: boolean | null;
    noise_suppression: boolean | null;
    auto_gain_control: boolean | null;
    output_latency_ms: number | null;
    at_ms: number;
  } | null;
}

/** p の向き。orchestrator の research.config が正本。届くまでは仮定であることを画面に出す。 */
export interface DirectionInfo {
  p_ai_index: AiIndex;
  source: 'orchestrator' | 'fake' | 'assumed';
  policy_id: string | null;
  direction_status: string | null;
}

/** 計画 §5 の G0 判定で実測した向き（i=1 が ch2=AI）。research.config が届くまでの仮定。 */
export const ASSUMED_P_AI_INDEX: AiIndex = 1;

export interface NoteRow {
  note_id: string;
  text: string;
  client_wall_clock: string;
  /** logged はログに書かれた（ack か research.note イベントを受けた）。 */
  status: 'sending' | 'logged' | 'no_session' | 'invalid' | 'not_sent';
  detail: string | null;
  session_id: string | null;
  /** research.note イベントの t_monotonic_ms（Node の受信時刻）。 */
  logged_at_ms: number | null;
}

/** I2 の表示。セッションが変わったら作り直す（前のセッションの値を混ぜない）。 */
export interface LiveSnapshot {
  session_id: string | null;
  timeline: TimelineView;
  prepare: PrepareStats;
  interrupts: InterruptStats;
  candidates: CandidateSummary;
}

export interface ResearchSnapshot {
  feed: { kind: ResearchFeed['kind']; label: string; synthetic: boolean };
  connection: { state: FeedConnection; detail: string | null };
  accepted: number;
  invalid: number;
  last_invalid: string | null;
  session_ids: string[];
  condition: string | null;
  last_at_ms: number | null;
  last_wall_clock: string | null;
  providers: ProviderRow[];
  clocks: ClockRow[];
  current: CurrentState;
  cost: CostSummary;
  latency: LatencyReport;
  /** 実データの口でも test double などが混ざっていれば理由を出す（計画 §4.8）。 */
  not_evidence_reasons: string[];
  direction: DirectionInfo;
  live: LiveSnapshot;
  notes: NoteRow[];
  /** 研究者のメモを送れる口か（WS のときだけ）。 */
  can_send_notes: boolean;
}

class LiveState {
  readonly timeline = new TimelineBuffer();
  readonly outcomes = new OutcomeTracker();
  readonly candidates = new CandidateTracker();
  constructor(readonly session_id: string | null) {}
  add(event: ResearchEvent): void {
    this.timeline.add(event);
    this.outcomes.add(event);
    this.candidates.add(event);
  }
  snapshot(): LiveSnapshot {
    return {
      session_id: this.session_id,
      timeline: this.timeline.view(),
      prepare: this.outcomes.prepareStats(),
      interrupts: this.outcomes.interruptStats(),
      candidates: this.candidates.summary(),
    };
  }
}

type VapEvent = EventOf<'vap.state'>;

export class ResearchViewStore implements FeedSink {
  private accepted = 0;
  private invalid = 0;
  private lastInvalid: string | null = null;
  private readonly sessionIds = new Set<string>();
  private condition: string | null = null;
  private lastAt: number | null = null;
  private lastWallClock: string | null = null;
  private readonly providers = new Map<string, ProviderRow>();
  private readonly clocks = new Map<string, ClockRow>();
  private readonly current: CurrentState = { vap: null, turn: null, speech: null, gaze: null, audio: null };
  private readonly costEvents: ResearchEvent[] = [];
  private readonly latencyEvents: ResearchEvent[] = [];
  private fakeVap = false;
  private connectionState: FeedConnection = 'idle';
  private connectionDetail: string | null = null;
  private live = new LiveState(null);
  private direction: DirectionInfo;
  private readonly notes = new Map<string, NoteRow>();

  constructor(private readonly feed: Pick<ResearchFeed, 'kind' | 'label' | 'synthetic'> & { send?: unknown }) {
    this.direction = {
      p_ai_index: ASSUMED_P_AI_INDEX,
      source: 'assumed',
      policy_id: null,
      direction_status: null,
    };
  }

  /** 画面から送ったメモ。sent=false は送れなかった（未接続）。 */
  noteSubmitted(message: ResearchNoteMessage, sent: boolean): void {
    this.notes.set(message.note_id, {
      note_id: message.note_id,
      text: message.text,
      client_wall_clock: message.client_wall_clock,
      status: sent ? 'sending' : 'not_sent',
      detail: sent ? null : 'WS が接続されていません',
      session_id: null,
      logged_at_ms: null,
    });
  }

  private control(message: NodeToResearch): void {
    if (message.type === 'research.config') {
      this.direction = {
        p_ai_index: message.p_ai_index,
        source: this.feed.synthetic ? 'fake' : 'orchestrator',
        policy_id: message.policy_id,
        direction_status: message.direction_status,
      };
      return;
    }
    if (message.note_id === null) {
      this.lastInvalid = `メモの送信が契約に合わない: ${message.status === 'logged' ? '' : message.detail}`;
      return;
    }
    const row = this.notes.get(message.note_id);
    if (row === undefined || row.status === 'logged') return;
    if (message.status === 'logged') {
      row.status = 'logged';
      row.session_id = message.session_id;
      row.detail = null;
    } else {
      row.status = message.status;
      row.detail = message.detail;
    }
  }

  connection(state: FeedConnection, detail: string | null): void {
    this.connectionState = state;
    this.connectionDetail = detail;
  }

  malformed(detail: string): void {
    this.invalid += 1;
    this.lastInvalid = `JSON として読めない: ${detail}`;
  }

  event(value: unknown): void {
    if (typeof value === 'object' && value !== null && 'type' in value && !('event' in value)) {
      const control = NodeToResearch.safeParse(value);
      if (control.success) this.control(control.data);
      else {
        this.invalid += 1;
        this.lastInvalid = `制御メッセージが契約に合わない: ${String((value as { type: unknown }).type)}`;
      }
      return;
    }
    const parsed = ResearchEvent.safeParse(value);
    if (!parsed.success) {
      this.invalid += 1;
      const name = (value as { event?: unknown } | null)?.event;
      const first = parsed.error.issues[0];
      this.lastInvalid = `${typeof name === 'string' ? name : '不明'}: ${first ? `${first.path.join('.')} ${first.message}` : '不合格'}`;
      return;
    }
    this.apply(parsed.data);
  }

  private apply(event: ResearchEvent): void {
    this.accepted += 1;
    this.sessionIds.add(event.session_id);
    this.condition = event.condition;
    this.lastAt = event.t_monotonic_ms;
    this.lastWallClock = event.wall_clock;
    if (event.event === 'cost.usage') this.costEvents.push(event);
    if (isLatencyRelevant(event)) this.latencyEvents.push(event);
    const at_ms = event.t_monotonic_ms;
    if (this.live.session_id !== event.session_id) this.live = new LiveState(event.session_id);
    this.live.add(event);
    switch (event.event) {
      case 'research.note': {
        const row = this.notes.get(event.note_id);
        this.notes.set(event.note_id, {
          note_id: event.note_id,
          text: event.text,
          client_wall_clock: event.client_wall_clock,
          status: 'logged',
          detail: row === undefined ? '別の画面から' : null,
          session_id: event.session_id,
          logged_at_ms: at_ms,
        });
        break;
      }
      case 'provider.status':
        this.providers.set(event.provider, {
          provider: event.provider,
          provider_class: event.provider_class,
          status: event.status,
          reason: event.reason.value,
          retry_attempt: event.retry_attempt,
          at_ms,
        });
        break;
      case 'clock.sync':
        this.clocks.set(event.source, {
          source: event.source,
          offset_ms: event.offset_ms,
          error_ms: event.error_ms,
          rtt_ms: event.rtt_ms.value,
          at_ms,
        });
        break;
      case 'vap.state':
        this.current.vap = vapRow(event);
        if (event.model_variant === FAKE_MODEL_VARIANT) this.fakeVap = true;
        break;
      case 'turn.allowed':
        this.current.turn = {
          allowed: event.turn_allowed,
          source: event.decision_source,
          reason: event.reason,
          freshness: event.vap_freshness,
          at_ms,
        };
        break;
      case 'speech.started':
        this.current.speech = { state: 'speaking', playback_id: event.audio_playback_id, origin: event.origin, at_ms };
        break;
      case 'speech.ended':
        this.current.speech = { state: 'ended', playback_id: event.audio_playback_id, origin: event.origin, at_ms };
        break;
      case 'speech.interrupted':
        this.current.speech = { state: 'interrupted', playback_id: event.audio_playback_id, origin: event.origin, at_ms };
        break;
      case 'gaze.decision':
        this.current.gaze = { target: event.target, reason: event.reason, at_ms };
        break;
      case 'audio.health':
        if (event.reporter === 'browser') {
          this.current.audio = {
            context: event.audio_context_state,
            visibility: event.visibility,
            frames_lost: event.frames_lost,
            underrun_count: event.underrun_count,
            echo_cancellation: event.track_settings.echoCancellation.value,
            noise_suppression: event.track_settings.noiseSuppression.value,
            auto_gain_control: event.track_settings.autoGainControl.value,
            output_latency_ms: event.latency.output_latency_ms.value,
            at_ms,
          };
        }
        break;
      default:
        break;
    }
  }

  snapshot(): ResearchSnapshot {
    const providers = [...this.providers.values()].sort((a, b) => a.provider.localeCompare(b.provider));
    const reasons: string[] = [];
    for (const row of providers) {
      if (row.provider_class !== 'production') reasons.push(`${row.provider} は ${row.provider_class}`);
    }
    if (this.fakeVap) reasons.push(`vap.state が ${FAKE_MODEL_VARIANT}`);
    return {
      feed: { kind: this.feed.kind, label: this.feed.label, synthetic: this.feed.synthetic },
      connection: { state: this.connectionState, detail: this.connectionDetail },
      accepted: this.accepted,
      invalid: this.invalid,
      last_invalid: this.lastInvalid,
      session_ids: [...this.sessionIds],
      condition: this.condition,
      last_at_ms: this.lastAt,
      last_wall_clock: this.lastWallClock,
      providers,
      clocks: [...this.clocks.values()],
      current: structuredClone(this.current),
      cost: summarizeCost(this.costEvents),
      latency: computeLatencyReport(this.latencyEvents),
      not_evidence_reasons: reasons,
      direction: { ...this.direction },
      live: this.live.snapshot(),
      notes: [...this.notes.values()].reverse().map((n) => ({ ...n })),
      can_send_notes: typeof this.feed.send === 'function',
    };
  }
}

function vapRow(event: VapEvent): NonNullable<CurrentState['vap']> {
  return {
    user_speaking: event.user_speaking,
    system_speaking:
      event.channel_layout === '2ch' ? event.system_speaking : event.system_speaking.value,
    audio_frame: event.audio_frame,
    model_variant: event.model_variant,
    channel_layout: event.channel_layout,
    at_ms: event.t_monotonic_ms,
  };
}
