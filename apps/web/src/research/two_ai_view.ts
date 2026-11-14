/**
 * 2 体の AI の話し合い（two_ai）の研究画面の集計（docs/design/two_ai/03 §3.5、decisions_round5 の M1）。React に依存しない。
 *
 * 規則:
 *  - 表示は研究画面へ配信されたイベント（Node が redactForResearch で伏せ字にしたもの、06 §4.6）と研究の制御メッセージだけから作る。
 *    WS でも JSONL でも同じ行なので同じ表示になる。
 *  - 接触秒数などの値は Node が記録した値をそのまま出す（ここで計算し直さない）。推定の値には「推定」と書く。
 *  - 文面を出すのは板のカード（配信された時点の文。伏せ字なら空）と段の見出しだけ。計画の本文、LLM の出力、発話の文は持たない。
 */
import type {
  ResearchConfigMessage,
  ResearchEvent,
  ResearchTwoAiArm,
  ResearchTwoAiArmAck,
  ResearchWoz,
  ResearchWozAck,
  TwoAiCondition,
  TwoAiPhase,
  WozAction,
} from '@llm-vap/contracts';

/** 判定の保留の上限の既定（06 §6.2 の暫定 6000ms）。設定の値が届かないので画面では推定に使う。 */
export const DEFAULT_HOLD_MAX_MS = 6000;
/**
 * 伏せ字のカード（06 §4.6 は text を '' にする）の代わりの印。契約の TwoAiBoardCardRecord.text は NonEmptyString なので
 * '' のままでは検証に落ちる（WP0 へ報告済みの食い違い）。view_store は伏せ字のカードだけをこの印に置き換えて検証し、
 * ここで '' に戻す。
 */
export const REDACTED_CARD_TEXT = '\u0000redacted';

/** 伏せ字のカード（trigger_turn_ended: false で text が空）を印に置き換える。置き換えがなければ null。 */
export function substituteRedactedCards(value: unknown): unknown | null {
  if (typeof value !== 'object' || value === null || (value as { event?: unknown }).event !== 'two_ai.board') return null;
  const cards = (value as { cards?: unknown }).cards;
  if (!Array.isArray(cards)) return null;
  let changed = false;
  const next = cards.map((card: unknown) => {
    if (typeof card === 'object' && card !== null && (card as { text?: unknown }).text === '' && (card as { trigger_turn_ended?: unknown }).trigger_turn_ended === false) {
      changed = true;
      return { ...card, text: REDACTED_CARD_TEXT };
    }
    return card;
  });
  return changed ? { ...value, cards: next } : null;
}
/** WoZ の ack を待つ時間（03 §4）。過ぎたら「応答なし」。再送はしない。 */
export const WOZ_ACK_TIMEOUT_MS = 3000;

const TWO_AI_CONDITIONS: readonly string[] = ['respond_on_spot', 'respond_at_end'];

export const CONDITION_LABEL: Record<TwoAiCondition, string> = {
  respond_on_spot: '①（その場で応答）',
  respond_at_end: '②（後でまとめて）',
};

export interface ArmedInfo {
  arm_id: string;
  condition: TwoAiCondition;
  script_id: string;
  interjection_feeds_generation: boolean | null;
  source: 'config' | 'ack';
}

export type WozStatus = 'sending' | 'not_sent' | 'no_response' | ResearchWozAck['status'];

export interface WozRow {
  woz_id: string;
  action: WozAction;
  point_id: string | null;
  client_wall_clock: string;
  sent_at_ms: number;
  status: WozStatus;
  detail: string | null;
  phase: TwoAiPhase | null;
}

export interface ArmRow {
  arm_id: string;
  condition: TwoAiCondition;
  script_id: string;
  status: 'sending' | 'not_sent' | ResearchTwoAiArmAck['status'];
  detail: string | null;
}

export type PointStateLabel = '予定' | '話し中' | '展開中' | '済み' | '訂正後の台本へ切り替え' | '取りこぼし' | '強制' | '作れなかった';

export interface PointRow {
  point_id: string;
  point_kind: string;
  speaker: string;
  trigger: string;
  stage: string;
  state: PointStateLabel;
  elaborated_turns: number;
  /** Node が記録した値（ms）。届いていなければ null。 */
  exposure_total_ms: number | null;
  exposure_new_ms: number | null;
  complete: boolean | null;
  /** two_ai.script の記録（switched／rejected／recorded_only）。 */
  correction: string | null;
  switched: boolean;
}

export interface InterjectionRow {
  interjection_id: string;
  at_ms: number;
  phase: TwoAiPhase | null;
  interrupted_ai: string | null;
  decision_source: string;
  last_stage: string;
  stop_latency_ms: number | null;
  outcome: string | null;
  ack_done: boolean | null;
  resumed_at_ms: number | null;
  /** ② の行（止めない）。 */
  logged_only: boolean;
}

export interface StageRow {
  discussion_stage: number;
  heading: string;
  started_at_ms: number | null;
  ended_at_ms: number | null;
  content_start_ms: number | null;
  content_end_ms: number | null;
}

export interface BoardCardRow {
  card_id: string;
  order: number;
  variant: string;
  depends_on: string;
  /** 伏せ字（trigger_turn_ended: false の間）は ''。 */
  text: string;
  redacted: boolean;
}

export interface BoardState {
  version: number;
  mode: string;
  reason: string;
  at_ms: number;
  cards: BoardCardRow[];
  rebuilt: boolean;
  picked: { outcome: string; card_id: string | null; latency_ms: number | null; at_ms: number } | null;
}

export interface MarkerRow {
  marker_id: string;
  at_ms: number;
  discussion_stage: number | null;
  ai_speaking: string | null;
  during_point_id: string | null;
  counted: boolean;
}

export type AssistJudgment = 'yes' | 'no' | 'failed' | 'pending';

/** 判定の保留の行（decisions_round5 の M1）。 */
export interface HoldRow {
  interjection_id: string;
  point_id: string | null;
  started_at_ms: number;
  /** 推定（最新のイベントの時刻と hold_max_ms から。本人が話している間の時計の停止は反映しない）。 */
  remaining_ms: number;
  assist: AssistJudgment;
}

export interface TwoAiViewState {
  session_id: string | null;
  condition_used: TwoAiCondition | null;
  armed: ArmedInfo | null;
  arms: ArmRow[];
  warnings: string[];
  phase: TwoAiPhase | null;
  phase_started_at_ms: number | null;
  phase_elapsed_ms: number | null;
  session_running: boolean;
  plan_wait: { stage: string; waited_ms: number; at_ms: number } | null;
  /** 計画の待ちで止まっている（pause_for_woz）。「再開」を押せる。 */
  plan_wait_paused: boolean;
  points: PointRow[];
  interjections: InterjectionRow[];
  counts: { stopped: number; yielded: number; logged_only: number };
  stages: StageRow[];
  board: BoardState | null;
  markers: { total: number; counted: number; by_stage: Record<string, number>; rows: MarkerRow[] };
  retraction: { timing: string; at_ms: number; played_ms: number | null; lines: number; point_ids: string[] } | null;
  render: { fps_median: number; fps_p5: number; frame_ms_p95: number; long_tasks: number; avatars: number; renderer: string; at_ms: number } | null;
  anomalies: { kind: string; speaker: string | null; detail: string; at_ms: number }[];
  hold: HoldRow | null;
  woz: WozRow[];
  last_at_ms: number | null;
  sync_marks: number;
}

type Ev<Name extends ResearchEvent['event']> = Extract<ResearchEvent, { event: Name }>;

function maybe(value: { value: number | null } | undefined): number | null {
  return value === undefined ? null : value.value;
}

function isTwoAiCondition(value: string): value is TwoAiCondition {
  return TWO_AI_CONDITIONS.includes(value);
}

/** イベントが 2 体のセッションのものか（封筒の two_ai か、条件の値で見る）。 */
export function isTwoAiEvent(event: ResearchEvent): boolean {
  return event.two_ai !== undefined || isTwoAiCondition(event.condition) || event.event.startsWith('two_ai.');
}

function triggerText(trigger: Ev<'two_ai.point'>['trigger']): string {
  if ('in_stage' in trigger) return `段 ${trigger.in_stage} の ${trigger.after_stage_turn} 拍目の後`;
  if ('after_turn' in trigger) return `${trigger.after_turn} 拍目の後`;
  if ('at_sec' in trigger) return `中身の時計 ${trigger.at_sec} 秒`;
  return `目標の ${Math.round(trigger.at_frac * 100)}%`;
}

const POINT_STATE: Record<Ev<'two_ai.point'>['stage'], PointStateLabel> = {
  scheduled: '予定',
  started: '話し中',
  elaboration: '展開中',
  turn_exposure: '展開中',
  completed: '済み',
  missed: '取りこぼし',
  forced: '強制',
  unavailable: '作れなかった',
  switched_to_corrected: '訂正後の台本へ切り替え',
};

/** セッションごとに作り直す部分。 */
class SessionPart {
  condition: TwoAiCondition | null = null;
  phase: TwoAiPhase | null = null;
  phaseAt: number | null = null;
  lastAt: number | null = null;
  planWait: TwoAiViewState['plan_wait'] = null;
  readonly points = new Map<string, PointRow>();
  readonly interjections = new Map<string, InterjectionRow>();
  readonly stages = new Map<number, StageRow>();
  board: BoardState | null = null;
  readonly markers: MarkerRow[] = [];
  retraction: TwoAiViewState['retraction'] = null;
  render: TwoAiViewState['render'] = null;
  readonly anomalies: TwoAiViewState['anomalies'] = [];
  /** 開いている訂正の窓（interjection_id → 始まりと点）。 */
  readonly holds = new Map<string, { point_id: string | null; started_at: number }>();
  /** 補助の判定（point_id → 時刻つきの最新）。 */
  readonly suggestions = new Map<string, { at: number; status: string; corrects: boolean | null }>();
  syncMarks = 0;
  constructor(readonly session_id: string) {}
}

export class TwoAiViewBuilder {
  private configMode: string | null = null;
  private seenTwoAiEvent = false;
  private armed: ArmedInfo | null = null;
  private readonly arms = new Map<string, ArmRow>();
  private readonly woz = new Map<string, WozRow>();
  private session: SessionPart | null = null;

  constructor(
    private readonly options: { holdMaxMs?: number; now?: () => number } = {},
  ) {}

  /** two_ai の表示を出すか。 */
  get active(): boolean {
    return this.configMode === 'two_ai' || this.seenTwoAiEvent;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  control(message: ResearchConfigMessage | ResearchTwoAiArmAck | ResearchWozAck): void {
    if (message.type === 'research.config') {
      if (message.mode !== undefined) this.configMode = message.mode;
      if (message.two_ai_armed !== undefined) {
        this.armed = message.two_ai_armed === null ? null : { ...message.two_ai_armed, source: 'config' };
      }
      return;
    }
    if (message.type === 'research.two_ai.arm.ack') {
      if (message.arm_id === null) return;
      const row = this.arms.get(message.arm_id);
      if (row === undefined) return;
      row.status = message.status;
      row.detail = message.detail;
      if (message.status === 'armed') {
        this.armed = { arm_id: row.arm_id, condition: row.condition, script_id: row.script_id, interjection_feeds_generation: this.armFlags.get(row.arm_id) ?? null, source: 'ack' };
      }
      return;
    }
    if (message.woz_id === null) return;
    const row = this.woz.get(message.woz_id);
    if (row === undefined) return;
    row.status = message.status;
    row.detail = message.detail;
    row.phase = message.phase;
  }

  private readonly armFlags = new Map<string, boolean | null>();

  armSubmitted(message: ResearchTwoAiArm, sent: boolean): void {
    this.armFlags.set(message.arm_id, message.interjection_feeds_generation);
    this.arms.set(message.arm_id, {
      arm_id: message.arm_id,
      condition: message.condition,
      script_id: message.script_id,
      status: sent ? 'sending' : 'not_sent',
      detail: sent ? null : 'WS が接続されていません',
    });
  }

  wozSubmitted(message: ResearchWoz, sent: boolean): void {
    this.woz.set(message.woz_id, {
      woz_id: message.woz_id,
      action: message.action,
      point_id: message.point_id,
      client_wall_clock: message.client_wall_clock,
      sent_at_ms: this.now(),
      status: sent ? 'sending' : 'not_sent',
      detail: sent ? null : 'WS が接続されていません',
      phase: null,
    });
  }

  event(event: ResearchEvent): void {
    if (!isTwoAiEvent(event)) return;
    this.seenTwoAiEvent = true;
    if (this.session === null || this.session.session_id !== event.session_id) this.session = new SessionPart(event.session_id);
    const s = this.session;
    const at = event.t_monotonic_ms;
    s.lastAt = s.lastAt === null ? at : Math.max(s.lastAt, at);
    if (isTwoAiCondition(event.condition)) s.condition = event.condition;
    if (event.two_ai !== undefined && s.phase === null) {
      s.phase = event.two_ai.phase;
      s.phaseAt = at;
    }
    switch (event.event) {
      case 'two_ai.phase_changed':
        s.phase = event.to;
        s.phaseAt = at;
        if (event.to !== 'discussion') s.holds.clear();
        break;
      case 'two_ai.plan_wait':
        s.planWait = { stage: event.stage, waited_ms: event.waited_ms, at_ms: at };
        break;
      case 'two_ai.point':
        this.point(s, event);
        break;
      case 'two_ai.point_exposure': {
        const row = this.pointRow(s, event.point_id, event.point_kind, event.speaker);
        row.exposure_total_ms = event.exposure_total_ms;
        row.exposure_new_ms = event.exposure_new_ms;
        row.complete = event.complete;
        break;
      }
      case 'two_ai.script': {
        if (event.point_id !== null) {
          const row = s.points.get(event.point_id);
          if (row !== undefined) {
            row.correction = event.stage === 'rejected' ? `拒否（${event.reason}）` : event.stage === 'switched' ? `切り替え（${event.timing ?? '時機不明'}）` : '記録だけ（応答の段）';
            if (event.stage === 'switched') {
              row.switched = true;
              row.state = '訂正後の台本へ切り替え';
            }
          }
          if (event.stage === 'switched') {
            for (const [id, hold] of s.holds) if (hold.point_id === event.point_id) s.holds.delete(id);
          }
        }
        break;
      }
      case 'two_ai.interjection':
        this.interjection(s, event, at);
        break;
      case 'two_ai.interjection_episode': {
        const row = this.interjectionRow(s, event.interjection_id, at, event);
        row.outcome = event.outcome;
        row.stop_latency_ms = maybe(event.stop_latency_ms);
        row.ack_done = event.ack !== null;
        row.resumed_at_ms = maybe(event.resumed_at);
        row.logged_only = row.logged_only || event.outcome === 'logged_only' || event.outcome === 'onset_no_speech';
        s.holds.delete(event.interjection_id);
        break;
      }
      case 'two_ai.correction_suggested':
        s.suggestions.set(event.point_id, { at, status: event.status, corrects: event.corrects });
        break;
      case 'two_ai.stage': {
        const row = s.stages.get(event.discussion_stage) ?? {
          discussion_stage: event.discussion_stage,
          heading: event.heading,
          started_at_ms: null,
          ended_at_ms: null,
          content_start_ms: null,
          content_end_ms: null,
        };
        row.heading = event.heading;
        if (event.edge === 'started') {
          row.started_at_ms = at;
          row.content_start_ms = event.content_elapsed_ms;
        } else {
          row.ended_at_ms = at;
          row.content_end_ms = event.content_elapsed_ms;
        }
        s.stages.set(event.discussion_stage, row);
        break;
      }
      case 'two_ai.board':
        s.board = {
          version: event.board_version,
          mode: event.mode,
          reason: event.reason,
          at_ms: at,
          cards: event.cards.map((c) => ({
            card_id: c.card_id,
            order: c.order,
            variant: c.variant,
            depends_on: c.depends_on,
            text: c.text === REDACTED_CARD_TEXT ? '' : c.text,
            redacted: !c.trigger_turn_ended && (c.text === '' || c.text === REDACTED_CARD_TEXT),
          })),
          rebuilt: (s.board?.rebuilt ?? false) || event.mode === 'rebuilt',
          picked: s.board?.picked ?? null,
        };
        break;
      case 'two_ai.board_picked':
        if (s.board !== null) s.board.picked = { outcome: event.outcome, card_id: event.card_id, latency_ms: maybe(event.latency_ms), at_ms: at };
        else
          s.board = {
            version: event.board_version,
            mode: 'picked',
            reason: 'picked',
            at_ms: at,
            cards: [],
            rebuilt: false,
            picked: { outcome: event.outcome, card_id: event.card_id, latency_ms: maybe(event.latency_ms), at_ms: at },
          };
        break;
      case 'two_ai.marker':
        s.markers.push({
          marker_id: event.marker_id,
          at_ms: at,
          discussion_stage: event.discussion_stage,
          ai_speaking: event.ai_speaking,
          during_point_id: event.during_point_id,
          counted: event.counted,
        });
        break;
      case 'two_ai.retraction':
        s.retraction = { timing: event.timing, at_ms: at, played_ms: maybe(event.played_ms), lines: event.lines.length, point_ids: [...event.point_ids] };
        break;
      case 'render.health':
        s.render = {
          fps_median: event.fps_median,
          fps_p5: event.fps_p5,
          frame_ms_p95: event.frame_ms_p95,
          long_tasks: event.long_tasks,
          avatars: event.avatars,
          renderer: event.renderer,
          at_ms: at,
        };
        break;
      case 'two_ai.anomaly':
        s.anomalies.push({ kind: event.kind, speaker: event.speaker, detail: event.detail, at_ms: at });
        break;
      case 'two_ai.sync_mark':
        s.syncMarks += 1;
        break;
      default:
        break;
    }
  }

  private pointRow(s: SessionPart, point_id: string, kind: string, speaker: string): PointRow {
    let row = s.points.get(point_id);
    if (row === undefined) {
      row = {
        point_id,
        point_kind: kind,
        speaker,
        trigger: '不明',
        stage: 'scheduled',
        state: '予定',
        elaborated_turns: 0,
        exposure_total_ms: null,
        exposure_new_ms: null,
        complete: null,
        correction: null,
        switched: false,
      };
      s.points.set(point_id, row);
    }
    return row;
  }

  private point(s: SessionPart, event: Ev<'two_ai.point'>): void {
    const row = this.pointRow(s, event.point_id, event.point_kind, event.speaker);
    row.trigger = triggerText(event.trigger);
    row.stage = event.stage;
    row.elaborated_turns = event.elaborated_turns;
    if (!row.switched || event.stage === 'switched_to_corrected') row.state = POINT_STATE[event.stage];
    if (event.stage === 'switched_to_corrected') row.switched = true;
    const total = maybe(event.exposure_total_ms);
    const fresh = maybe(event.exposure_new_ms);
    if (total !== null) row.exposure_total_ms = total;
    if (fresh !== null) row.exposure_new_ms = fresh;
  }

  private interjectionRow(s: SessionPart, id: string, at: number, event: { decision_source: string; interrupted_ai: string | null; two_ai?: ResearchEvent['two_ai'] }): InterjectionRow {
    let row = s.interjections.get(id);
    if (row === undefined) {
      row = {
        interjection_id: id,
        at_ms: at,
        phase: event.two_ai?.phase ?? s.phase,
        interrupted_ai: event.interrupted_ai,
        decision_source: event.decision_source,
        last_stage: '',
        stop_latency_ms: null,
        outcome: null,
        ack_done: null,
        resumed_at_ms: null,
        logged_only: s.condition === 'respond_at_end',
      };
      s.interjections.set(id, row);
    }
    return row;
  }

  private interjection(s: SessionPart, event: Ev<'two_ai.interjection'>, at: number): void {
    const row = this.interjectionRow(s, event.interjection_id, at, event);
    row.last_stage = event.stage;
    if (event.interrupted_ai !== null) row.interrupted_ai = event.interrupted_ai;
    if (event.stage === 'ignored_by_condition') row.logged_only = true;
    if (event.stage === 'ack_ended') row.ack_done = true;
    if (event.stage === 'correction_wait') s.holds.set(event.interjection_id, { point_id: event.during_point_id, started_at: at });
    if (event.stage === 'resumed' || event.stage === 'abandoned') {
      s.holds.delete(event.interjection_id);
      if (event.stage === 'resumed') row.resumed_at_ms = at;
    }
    if (event.stage === 'stopped' && row.stop_latency_ms === null) row.stop_latency_ms = maybe(event.latency_ms);
  }

  snapshot(): TwoAiViewState | null {
    if (!this.active) return null;
    const s = this.session;
    const holdMax = this.options.holdMaxMs ?? DEFAULT_HOLD_MAX_MS;
    const now = this.now();
    const interjections = s === null ? [] : [...s.interjections.values()];
    const warnings: string[] = [];
    const used = s?.condition ?? null;
    if (this.armed !== null && used !== null && this.armed.condition !== used) {
      warnings.push(`設定済みの条件（${CONDITION_LABEL[this.armed.condition]}）と、このセッションで使った条件（${CONDITION_LABEL[used]}）が違います`);
    }
    if (s !== null) {
      for (const a of s.anomalies) if (a.kind === 'user_floor_long' || a.kind === 'board_pick_rejected' || a.kind === 'detector_degraded') warnings.push(`異常: ${a.kind}（${a.detail}）`);
      if (s.render !== null && s.render.avatars < 2) warnings.push(`描画できているアバターが ${s.render.avatars} 体です（条件間で刺激が揃いません）`);
    }
    let hold: HoldRow | null = null;
    if (s !== null && s.holds.size > 0) {
      const [id, h] = [...s.holds.entries()].at(-1)!;
      const latest = s.lastAt ?? h.started_at;
      const sug = h.point_id === null ? undefined : s.suggestions.get(h.point_id);
      // この割り込みの始まりより前の提案は前の割り込みのもの。
      const onsetAt = s.interjections.get(id)?.at_ms ?? h.started_at;
      const assist: AssistJudgment =
        sug === undefined || sug.at < onsetAt || sug.status === 'pending'
          ? 'pending'
          : sug.status === 'failed'
            ? 'failed'
            : sug.corrects
              ? 'yes'
              : 'no';
      hold = { interjection_id: id, point_id: h.point_id, started_at_ms: h.started_at, remaining_ms: Math.max(0, h.started_at + holdMax - latest), assist };
    }
    const markers = s?.markers ?? [];
    const byStage: Record<string, number> = {};
    for (const m of markers) {
      if (!m.counted) continue;
      const key = m.discussion_stage === null ? '段の外' : `段 ${m.discussion_stage}`;
      byStage[key] = (byStage[key] ?? 0) + 1;
    }
    const woz = [...this.woz.values()].map((row) =>
      row.status === 'sending' && now - row.sent_at_ms > WOZ_ACK_TIMEOUT_MS ? { ...row, status: 'no_response' as const, detail: '3 秒以内に応答がありません（再送しません）' } : { ...row },
    );
    return {
      session_id: s?.session_id ?? null,
      condition_used: used,
      armed: this.armed === null ? null : { ...this.armed },
      arms: [...this.arms.values()].reverse().map((r) => ({ ...r })),
      warnings,
      phase: s?.phase ?? null,
      phase_started_at_ms: s?.phaseAt ?? null,
      phase_elapsed_ms: s === null || s.phaseAt === null || s.lastAt === null ? null : s.lastAt - s.phaseAt,
      session_running: s !== null && s.phase !== null && s.phase !== 'end',
      plan_wait: s?.planWait ?? null,
      plan_wait_paused: s?.planWait?.stage === 'paused',
      points: s === null ? [] : [...s.points.values()].map((p) => ({ ...p })),
      interjections: interjections.map((r) => ({ ...r })).reverse(),
      counts: {
        stopped: interjections.filter((r) => !r.logged_only && (r.stop_latency_ms !== null || r.last_stage === 'stopped' || r.outcome === 'yielded' || r.outcome === 'backchannel' || r.outcome === 'false_onset')).length,
        yielded: interjections.filter((r) => r.outcome === 'yielded').length,
        logged_only: interjections.filter((r) => r.logged_only).length,
      },
      stages: s === null ? [] : [...s.stages.values()].sort((a, b) => a.discussion_stage - b.discussion_stage).map((r) => ({ ...r })),
      board: s?.board === null || s?.board === undefined ? null : { ...s.board, cards: s.board.cards.map((c) => ({ ...c })), picked: s.board.picked === null ? null : { ...s.board.picked } },
      markers: { total: markers.length, counted: markers.filter((m) => m.counted).length, by_stage: byStage, rows: markers.map((m) => ({ ...m })) },
      retraction: s?.retraction ?? null,
      render: s?.render ?? null,
      anomalies: s === null ? [] : s.anomalies.map((a) => ({ ...a })),
      hold,
      woz: woz.reverse(),
      last_at_ms: s?.lastAt ?? null,
      sync_marks: s?.syncMarks ?? 0,
    };
  }
}
