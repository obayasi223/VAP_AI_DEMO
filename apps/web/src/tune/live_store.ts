/**
 * 調整画面のライブ表示の中身（/research の WS に ?tune=1 を付けて受ける）。React に依存しない。
 * イベント（ResearchEvent）と、調整画面だけに下る制御メッセージ（NodeToTune: research.policy、research.turn_diagnostic）を受ける。
 * 届いた値は契約で検証し、不合格は数える。セッションが変わったら作り直す。
 */
import { NodeToTune, ResearchEvent, type Policy, type PolicyOverrideInfo, type TurnDiagnosticBody } from '@llm-vap/contracts';
import type { FeedConnection, FeedSink } from '../research/feed';
import { InitiativeFlow, type FlowRow } from './initiative_flow';

export interface VapPoint {
  t: number;
  p_now: readonly [number, number];
  p_future: readonly [number, number];
  vad: readonly [number, number];
}

export interface LiveSpan {
  start: number;
  end: number | null;
  label: string;
}

export interface LiveSnapshot {
  connection: { state: FeedConnection; detail: string | null };
  session_id: string | null;
  accepted: number;
  invalid: number;
  last_invalid: string | null;
  now_ms: number | null;
  /** このセッションで最初に届いた時刻（目盛りの原点）。 */
  origin_ms: number | null;
  p_ai_index: 0 | 1;
  policy: { policy: Policy; file: string; override: PolicyOverrideInfo | null } | null;
  vap: VapPoint[];
  diagnostics: TurnDiagnosticBody[];
  latest_diagnostic: TurnDiagnosticBody | null;
  ai_speech: LiveSpan[];
  allowed: LiveSpan[];
  turn_changes: { t: number; allowed: boolean; source: string; reason: string }[];
  stt: { t: number; final: boolean }[];
  gaze: { t: number; target: string }[];
  initiative: FlowRow[];
}

export const LIVE_WINDOW_MS = 30_000;
const KEEP_MS = 90_000;

export class TuneLiveStore implements FeedSink {
  private connectionState: FeedConnection = 'idle';
  private connectionDetail: string | null = null;
  private sessionId: string | null = null;
  private accepted = 0;
  private invalid = 0;
  private lastInvalid: string | null = null;
  private latest: number | null = null;
  private origin: number | null = null;
  private pAiIndex: 0 | 1 = 1;
  private policy: LiveSnapshot['policy'] = null;
  private vap: VapPoint[] = [];
  private diagnostics: TurnDiagnosticBody[] = [];
  private aiSpeech: LiveSpan[] = [];
  private allowed: LiveSpan[] = [];
  private turnChanges: LiveSnapshot['turn_changes'] = [];
  private stt: LiveSnapshot['stt'] = [];
  private gaze: LiveSnapshot['gaze'] = [];
  private flow = new InitiativeFlow();

  connection(state: FeedConnection, detail: string | null): void {
    this.connectionState = state;
    this.connectionDetail = detail;
  }

  malformed(detail: string): void {
    this.invalid += 1;
    this.lastInvalid = `JSON として読めない: ${detail}`;
  }

  private resetFor(sessionId: string): void {
    this.sessionId = sessionId;
    this.vap = [];
    this.diagnostics = [];
    this.aiSpeech = [];
    this.allowed = [];
    this.turnChanges = [];
    this.stt = [];
    this.gaze = [];
    this.flow = new InitiativeFlow();
    this.latest = null;
    this.origin = null;
  }

  event(value: unknown): void {
    if (typeof value === 'object' && value !== null && 'type' in value && !('event' in value)) {
      const parsed = NodeToTune.safeParse(value);
      if (!parsed.success) {
        this.invalid += 1;
        this.lastInvalid = `制御メッセージが契約に合わない: ${String((value as { type: unknown }).type)}`;
        return;
      }
      const m = parsed.data;
      if (m.type === 'research.config') this.pAiIndex = m.p_ai_index;
      else if (m.type === 'research.policy') this.policy = { policy: m.policy, file: m.policy_file, override: m.override };
      else if (m.type === 'research.turn_diagnostic') {
        if (this.sessionId !== m.session_id) this.resetFor(m.session_id);
        const { type: _t, session_id: _s, ...body } = m;
        this.diagnostics.push(body);
        this.touch(body.t_monotonic_ms);
      }
      return;
    }
    const parsed = ResearchEvent.safeParse(value);
    if (!parsed.success) {
      this.invalid += 1;
      const name = (value as { event?: unknown } | null)?.event;
      this.lastInvalid = `${typeof name === 'string' ? name : '不明'}: 契約に合わない`;
      return;
    }
    this.apply(parsed.data);
  }

  private apply(e: ResearchEvent): void {
    this.accepted += 1;
    if (this.sessionId !== e.session_id) this.resetFor(e.session_id);
    const t = e.t_monotonic_ms;
    this.flow.add(e);
    switch (e.event) {
      case 'vap.state':
        if (e.channel_layout === '2ch') this.vap.push({ t, p_now: e.p_now, p_future: e.p_future, vad: e.vad });
        break;
      case 'turn.allowed': {
        this.turnChanges.push({ t, allowed: e.turn_allowed, source: e.decision_source, reason: e.reason });
        const open = this.allowed.at(-1);
        if (open && open.end === null) open.end = t;
        if (e.turn_allowed) this.allowed.push({ start: t, end: null, label: e.decision_source });
        break;
      }
      case 'speech.started':
        this.aiSpeech.push({ start: e.started_at, end: null, label: `#${e.audio_playback_id}` });
        break;
      case 'speech.ended':
      case 'speech.interrupted': {
        const span = this.aiSpeech.find((s) => s.label === `#${e.audio_playback_id}`);
        const end = e.event === 'speech.ended' ? e.ended_at : e.interrupted_at;
        if (span) {
          span.end = end;
          if (e.event === 'speech.interrupted') span.label += ' 割り込み';
        } else this.aiSpeech.push({ start: e.started_at, end, label: `#${e.audio_playback_id}` });
        break;
      }
      case 'stt.interim':
      case 'stt.final':
        this.stt.push({ t, final: e.event === 'stt.final' });
        break;
      case 'gaze.decision':
        this.gaze.push({ t, target: e.target });
        break;
      default:
        break;
    }
    this.touch(t);
  }

  private touch(t: number): void {
    if (this.origin === null || t < this.origin) this.origin = t;
    if (this.latest === null || t > this.latest) this.latest = t;
    const cutoff = (this.latest ?? 0) - KEEP_MS;
    const drop = <T extends { t: number }>(list: T[]) => {
      let n = 0;
      while (n < list.length && (list[n] as T).t < cutoff) n += 1;
      if (n > 0) list.splice(0, n);
    };
    drop(this.vap);
    drop(this.stt);
    drop(this.gaze);
    drop(this.turnChanges);
    let n = 0;
    while (n < this.diagnostics.length && (this.diagnostics[n] as TurnDiagnosticBody).t_monotonic_ms < cutoff) n += 1;
    if (n > 0) this.diagnostics.splice(0, n);
    for (const spans of [this.aiSpeech, this.allowed]) {
      while (spans.length > 1 && (spans[0] as LiveSpan).end !== null && ((spans[0] as LiveSpan).end as number) < cutoff) spans.shift();
    }
  }

  snapshot(): LiveSnapshot {
    return {
      connection: { state: this.connectionState, detail: this.connectionDetail },
      session_id: this.sessionId,
      accepted: this.accepted,
      invalid: this.invalid,
      last_invalid: this.lastInvalid,
      now_ms: this.latest,
      origin_ms: this.origin,
      p_ai_index: this.pAiIndex,
      policy: this.policy,
      vap: this.vap.slice(),
      diagnostics: this.diagnostics.slice(),
      latest_diagnostic: this.diagnostics.at(-1) ?? null,
      ai_speech: this.aiSpeech.map((s) => ({ ...s })),
      allowed: this.allowed.map((s) => ({ ...s })),
      turn_changes: this.turnChanges.slice(),
      stt: this.stt.slice(),
      gaze: this.gaze.slice(),
      initiative: this.flow.list(),
    };
  }
}
