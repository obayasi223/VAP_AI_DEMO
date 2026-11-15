/**
 * 2 体の AI の話し合いモードのセッション（docs/design/two_ai/01 §1.1、§3、06 §10）。配線の本体（executor）。
 *
 *   Browser ─AUDIO 枠→ UplinkAudio → STT、MaAI（session_io。1 対 1 と同じ部品）
 *   20ms の tick：報告の期限切れの代行 → stepInterjection（readVapUser）→ TurnManager.step（intake の応答と受け止めの時機）
 *     → 02 の読み出し → directorStep（純粋関数）→ 行動の実行（表 3.3）
 *   2 つの AiSlot（声の違う TTS と SpeechGeneratorImpl。再生 ID と世代は SharedPlaybackCounters で共有）
 *   02（DiscussionContent）の非同期の結果（届いたターン、失敗、見込み）は次の tick の進行役の入力に入れる。
 *
 * 進行役が出さず executor が出すもの（director.ts の冒頭の注記）：two_ai.phase_changed(session_start)、two_ai.retraction（文とハッシュ）、
 * two_ai.ai_state（02 の framingState）、two_ai.board（板の中身）、two_ai.script（訂正の切り替え）、two_ai.sync_mark、render.health、
 * resume の spoken_text（SpeechFinished の発話済みの文）。
 */
import { SAMPLE_RATE_HZ, TwoAiManifest, absent, present } from '@llm-vap/contracts';
import type {
  AiId,
  BoardCardView,
  BoardDependency,
  BrowserToNode,
  ClientHello,
  EventDraft,
  EventEmitter,
  GazeTarget,
  NodeToBrowser,
  Policy,
  ResearchWoz,
  ResearchWozAck,
  SttResult,
  SttSession,
  TimeBasis,
  TimeSource,
  TurnDecision,
  TurnInputs,
  TwoAiCondition,
  TwoAiEmitContext,
  TwoAiPhase,
  TwoAiTurnOrigin,
  Unsubscribe,
  UtteranceClass,
} from '@llm-vap/contracts';
import { createTurnManager, noteExternalStart } from '../control';
import type { TurnState } from '../control';
import { readVapUser, vapDirectionSettings } from '../control/vap_direction';
import { isReadyBufferMs } from '../app/maai_setup';
import { readSessionAudioConfig } from '../app/config';
import type { BaseProviders, TwoAiProviders } from '../app/providers';
import { TWO_AI_VOICE_ENV } from '../app/providers';
import { createDiscussionContent, loadDiscussionAssets } from '../cognition/discussion';
import type { SessionLog, SessionManifestDetails } from '../logging';
import { WorkerClockRecorder, sessionAudioOffManifest } from '../logging';
import type { SessionAudioManifest, SessionAudioRecorder } from '../logging';
import type { MaaiWorkerClient } from '../maai';
import { SharedPlaybackCounters } from '../speech/shared_counters';
import type { SpeechFinished } from '../speech/speech_generator';
import { PlaybackTracker } from '../session/audio_state';
import { SessionHistory } from '../session/history';
import type { ParticipantSession } from '../session/participant_session';
import type { BrowserLink, SessionCounters, SessionStatusView } from '../session/session';
import {
  BrowserReports,
  CompletionTracker,
  MaaiSessionWiring,
  ManifestWriter,
  TranscriptTracker,
  UplinkAudio,
  buildTurnInputs,
  recordBaseProviders,
  startSessionAudio,
} from '../session/session_io';
import type { SessionAudioSetting } from '../session/session_io';
import { createAckBank, sha256 } from './ack_bank';
import type { AckBank } from './ack_bank';
import { AiSlot } from './ai_slot';
import type { CorrectionResult, DiscussionContent, DiscussionTurn, PlanResult, RetractionScriptView } from './content_port';
import { CONTENT_EXHAUSTED, createDirector, fixedTurnKind } from './director';
import type { Director, DirectorAction, FixedLineRef } from './director';
import { emptyInputs } from './director_state';
import type { DirectorInputs, DirectorState, DiscussionTurnView, PlaybackObservation, TurnArrival } from './director_state';
import { contentMsOf, playedMsOf, repeatShare } from './exposure';
import { initialInterjectionState, stepInterjection } from './interjection';
import type { InterjectionSettings, InterjectionState } from './interjection';
import type { LoadedScript, TwoAiSettings } from './settings';
import { scopedEmitter } from './scoped_emitter';
import { admitWoz, resolveCorrectionPoint } from './woz';
import type { WozInputTwoAi, WozView } from './woz';

const AI_IDS = ['A', 'B'] as const;

export interface TwoAiSessionOptions {
  session_id: string;
  condition: TwoAiCondition;
  condition_source: 'research_screen' | 'env';
  /** 研究画面の arm（なければ null）。 */
  arm: { arm_id: string; interjection_feeds_generation: boolean | null; session_index: 1 | 2 | null; counterbalance_label: string | null } | null;
  policy: Policy;
  time: TimeSource;
  /** two_ai_context を返す関数を bindEmitContext で受け取る emitter（研究画面への配信を含む）。 */
  emitter: EventEmitter;
  /** emitter の封筒の two_ai をこのセッションの状態に結ぶ（server が openSessionLogging に渡した関数の中身を差し替える）。 */
  bindEmitContext?: (context: () => TwoAiEmitContext | null) => void;
  log: SessionLog;
  settings: TwoAiSettings;
  script: LoadedScript;
  providers: Extract<TwoAiProviders, { ok: true }>;
  maai: MaaiWorkerClient | null;
  maaiUnavailableReason?: string;
  onStatusChange?: (status: SessionStatusView) => void;
  /** false なら tick のタイマーを動かさない（試験が tick() を直接呼ぶ）。 */
  tickTimer?: boolean;
  sessionAudio?: SessionAudioSetting;
  /** 02 の実装（試験は偽物を渡す）。省略は cognition/discussion の createDiscussionContent。 */
  content?: (deps: { history: SessionHistory; emitter: EventEmitter }) => DiscussionContent;
}

/** 進行役に渡した発話の記録（turn_id は進行役の ID）。 */
interface TurnRec {
  turn_id: string;
  /** 02 の ID（resume は 02 が別の ID を付ける）。02 に onTurnPlayed を返すときに使う。 */
  content_turn_id: string | null;
  ai: AiId;
  audio: number;
  source: TurnArrival['source'];
  view: DiscussionTurnView;
  text: string;
  board_card: (BoardCardView & { depends_on: BoardDependency }) | null;
  fixed_line: FixedLineRef | null;
}

interface BoardCardState {
  card: BoardCardView & { depends_on: BoardDependency };
  trigger_turn_id: string | null;
  trigger_turn_ended: boolean;
}

export class TwoAiSession implements ParticipantSession {
  readonly session_id: string;
  readonly condition: TwoAiCondition;
  readonly history = new SessionHistory();
  readonly counters: SessionCounters & { director_actions: Record<string, number>; two_ai_dropped_decisions: number } = {
    uplink_frames: 0,
    bad_uplink_frames: 0,
    start_refused: {},
    audio_reports_before_clock: 0,
    gaze_reports_before_clock: 0,
    signal_reports_ignored: 0,
    decisions: {},
    tick_errors: 0,
    playback_ended_synthesized: 0,
    start_rolled_back: 0,
    director_actions: {},
    two_ai_dropped_decisions: 0,
  };
  turnState: TurnState;
  /** 進行役の状態（試験と研究画面向けの読み出し）。 */
  get directorState(): DirectorState {
    return this.dstate;
  }

  private link: BrowserLink | null = null;
  private readonly time: TimeSource;
  private readonly emitter: EventEmitter;
  private readonly turnManager: ReturnType<typeof createTurnManager>;
  private readonly tracker = new PlaybackTracker();
  private readonly uplink: UplinkAudio;
  private readonly reports: BrowserReports;
  private readonly maaiWiring: MaaiSessionWiring;
  private readonly transcriptTracker = new TranscriptTracker();
  private readonly completion: CompletionTracker;
  private readonly manifestWriter: ManifestWriter;
  private readonly sharedCounters = new SharedPlaybackCounters(1);
  private readonly slots: Record<AiId, AiSlot>;
  private readonly director: Director;
  private dstate: DirectorState;
  private content: DiscussionContent | null = null;
  private ackBank: AckBank | null = null;
  private stt: SttSession | null = null;
  private audioRecorder: SessionAudioRecorder | null = null;
  private manifestDetails: SessionManifestDetails | null = null;
  private avatarManifest: Record<string, unknown> | null = null;
  private readonly unsubscribe: Unsubscribe[] = [];
  private tickTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private degradedReason: string | null = 'starting';
  private readonly fixedReasons: string[] = [];
  private lastStatusKey = '';

  // ---- 進行役への入力の溜め ----
  private readonly pendingArrivals: TurnArrival[] = [];
  private readonly pendingFailures: { turn_id: string; reason: string }[] = [];
  private readonly pendingCredits: { interjection_id: string; credited_ms: number }[] = [];
  private readonly pendingCancelled: string[] = [];
  private readonly pendingPlayback: PlaybackObservation[] = [];
  private readonly pendingWoz: WozInputTwoAi[] = [];
  private readonly pendingMarkers: DirectorInputs['markers'] = [];
  private readonly pendingPicks: DirectorInputs['board_picks'] = [];
  private pendingUtterance: DirectorInputs['user_utterance'] = null;
  private startedAckThisTick: number | null = null;

  // ---- 発話の記録 ----
  private readonly turns = new Map<string, TurnRec>();
  private readonly turnByAudio = new Map<number, string>();
  private readonly aiByAudio = new Map<number, AiId>();
  private readonly inflight = new Map<string, AbortController>();
  private readonly spokenByTurn = new Map<string, string>();
  private readonly samplesByAudio = new Map<number, number>();
  private readonly endReasonByAudio = new Map<number, PlaybackObservation & { kind: 'ended' } extends infer _T ? 'completed' | 'stopped' | 'discarded_before_start' | 'error' | 'report_timeout' : never>();
  private readonly startedInSegment = new Map<number, number>();

  // ---- 受け止めと intake の担当 ----
  private ackOffer: { ai: AiId; audio: number } | null = null;
  private fixedOffer: { ai: AiId; audio: number } | null = null;
  private responder: AiId | null = null;
  private interjectionState: InterjectionState = initialInterjectionState();
  private readonly interjectionSettings: InterjectionSettings;
  private readonly stopMaxWaitMs: number;
  private onsetAt: number | null = null;
  private voicedSinceOnsetMs = 0;
  private lastVoiceAt: number | null = null;
  /** 割り込みごとの本人の発話（notify_interjection_closed で 02 へ渡す）。 */
  private readonly interjectionText = new Map<string, { text: Map<number, string>; asr_segment_ids: Set<number> }>();

  // ---- 板、段、同期の印、撤回 ----
  private readonly board = new Map<string, BoardCardState>();
  private rebuildBoard: (BoardCardView & { depends_on: BoardDependency })[] | null = null;
  private syncSeq = 0;
  private headings: [string, string, string, string];
  private currentStage: number | null = null;
  private retraction: RetractionScriptView | null = null;
  private retractionEmitted = false;
  private readonly retractionPlayed: { audio: number | null; played_ms: number; ai: AiId | null } = { audio: null, played_ms: 0, ai: null };
  private readonly aiStateVersion: Record<AiId, string | null> = { A: null, B: null };

  // ---- 計画と manifest ----
  private plan: PlanResult | null = null;
  private planWaitMs: number | null = null;
  private readonly feeds: { requested: boolean; effective: boolean; source: 'config' | 'research_screen' };
  private readonly evidenceFlags = { forced_or_missed: false };
  private readonly planAborts: AbortController[] = [];
  /**
   * 進行役の行動を順に実行している間の封筒（06 §4.1）。step の後の状態ではなく、行動の順に段階・段・版を進める。
   * 同じ tick で段階が変わるとき、変わる前の行動（前の段階のターンの終わりなど）が新しい段階の封筒を持たないように。
   */
  private actionCtx: TwoAiEmitContext | null = null;

  constructor(private readonly options: TwoAiSessionOptions) {
    this.session_id = options.session_id;
    this.condition = options.condition;
    this.time = options.time;
    this.emitter = options.emitter;
    const config = options.settings.config;
    this.turnManager = createTurnManager(options.policy, {
      fallback_energy_silence_threshold: options.policy.policy_id === 'ja' ? (options.policy.turn.fallback_energy_silence_dbfs ?? null) : null,
    });
    this.turnState = this.turnManager.initialState();
    this.uplink = new UplinkAudio({ counters: this.counters, tracker: this.tracker, time: this.time });
    this.reports = new BrowserReports({ emitter: this.emitter, time: this.time, counters: this.counters });
    this.maaiWiring = new MaaiSessionWiring({
      maai: options.maai,
      unavailableReason: options.maaiUnavailableReason ?? null,
      emitter: this.emitter,
      workerClock: new WorkerClockRecorder(this.emitter),
      session_id: options.session_id,
    });
    this.completion = new CompletionTracker({ estimator: options.providers.base.completion });
    this.manifestWriter = new ManifestWriter({ log: options.log });
    const requested = options.arm?.interjection_feeds_generation ?? config.experience.interjection_feeds_generation;
    this.feeds = {
      requested,
      effective: requested && options.condition === 'respond_on_spot',
      source: options.arm?.interjection_feeds_generation !== null && options.arm?.interjection_feeds_generation !== undefined ? 'research_screen' : 'config',
    };
    const policyVapThreshold = options.policy.policy_id === 'ja' ? options.policy.vap.speaking_threshold : 0.5;
    const det = config.interjection.detector;
    this.interjectionSettings = {
      vad_threshold: det.vad_threshold ?? policyVapThreshold,
      p_now_user_min: det.p_now_user_min ?? 0.5,
      p_future_user_min: det.p_future_user_min ?? 0.5,
      p_combine: det.p_combine,
      onset_min_ms: det.onset_min_ms,
      refractory_ms: det.refractory_ms,
      fallback_dbfs: det.fallback_dbfs,
      fallback_onset_min_ms: det.fallback_onset_min_ms,
      sub_threshold_min_ms: det.sub_threshold_min_ms,
    };
    this.stopMaxWaitMs = config.interjection.stop_max_wait_ms ?? (options.policy.policy_id === 'ja' ? options.policy.turn.stop_boundary_max_ms : 200);
    this.headings = options.script.script.stages ?? config.fixed.stage_headings;
    const points = new Map(options.script.script.planned_points.map((p) => [p.id, p]));
    this.director = createDirector(config, {
      condition: options.condition,
      correction_mode: config.correction.mode,
      // 応答版は旗に関係なく ① の割り込みを生のターンに入れる（受けるターンの待ちを feed_turn_max_wait_ms にする）
      feeds_generation: this.feeds.effective || (config.experience.mode === 'responsive' && options.condition === 'respond_on_spot'),
      stop_max_wait_ms: this.stopMaxWaitMs,
      point_meta: (id) => {
        const p = points.get(id);
        if (p === undefined) return null;
        const planned = 'at_sec' in p.trigger ? p.trigger.at_sec * 1000 : 'at_frac' in p.trigger ? p.trigger.at_frac * config.phases.discussion.target_sec * 1000 : null;
        return { trigger: p.trigger, elaborations_planned: p.elaborate_turns, planned_at_ms: planned };
      },
    });
    this.dstate = this.director.initialState(this.time.monotonicMs());
    const send = (m: NodeToBrowser) => this.send(m);
    const sendBinary = (d: Uint8Array) => this.link?.sendBinary(d);
    const make = (ai: AiId) =>
      new AiSlot({
        ai_id: ai,
        tts: options.providers.slotTts[ai],
        counters: this.sharedCounters,
        intakeLlm: () => options.providers.llmFor('intake', ai),
        prompt: (request) => {
          if (this.dstate.phase !== 'intake' || this.content === null) throw new Error(`two_ai: response prompt outside intake (${this.dstate.phase})`);
          return this.content.promptBuilder('intake', ai)(request);
        },
        send,
        sendBinary,
        time: this.time,
        emitter: this.emitter,
        is_ready_buffer_ms: isReadyBufferMs(options.policy),
      });
    this.slots = { A: make('A'), B: make('B') };
    options.bindEmitContext?.(() => this.actionCtx ?? { phase: this.dstate.phase, discussion_stage: this.dstate.discussion_stage, script_variant: this.dstate.script_variant });
  }

  get attached(): boolean {
    return this.link !== null;
  }

  private get config() {
    return this.options.settings.config;
  }

  private get script() {
    return this.options.script.script;
  }

  // ---- 開始 ------------------------------------------------------------------

  async start(link: BrowserLink, hello: ClientHello): Promise<void> {
    this.link = link;
    this.recordClient(hello, 'new_session');
    const setting: SessionAudioSetting = this.options.sessionAudio ?? readSessionAudioConfig(process.env);
    this.audioRecorder = startSessionAudio(setting, { session_id: this.session_id, dir: this.options.log.paths?.dir ?? '', emitter: this.emitter });
    const base = this.options.providers.base;
    for (const [kind, cls] of Object.entries(base.classes)) {
      if (cls === 'test_double') this.fixedReasons.push(`test_double:${kind}:${base.names[kind as 'stt']}`);
    }
    if (base.stt.ok) {
      try {
        this.stt = await base.stt.value.open({ language_code: 'ja-JP', sample_rate_hz: SAMPLE_RATE_HZ, interim_results: true, start_audio_frame: 0 });
        this.unsubscribe.push(this.stt.onResult((result) => this.onSttResult(result)));
      } catch (error) {
        this.fixedReasons.push(`stt_unavailable:${String(error instanceof Error ? error.message : error).slice(0, 160)}`);
      }
    } else {
      this.fixedReasons.push(`stt_unavailable:${base.stt.reason}`);
    }
    for (const ai of AI_IDS) {
      await this.slots[ai].open();
      const slot = this.slots[ai];
      if (slot.unavailableReason !== null) this.fixedReasons.push(slot.unavailableReason);
      if (slot.speech !== null) {
        this.unsubscribe.push(slot.speech.onFinished((f) => this.onSpeechFinished(ai, f)));
        this.unsubscribe.push(
          slot.speech.onStateChange((change) => {
            if (change.state === 'failed') this.onSpeechFailed(change.audio_playback_id, change.reason ?? 'failed');
            if (change.state === 'finished') this.endReasonByAudio.set(change.audio_playback_id, normalizeEndReason(change.reason));
          }),
        );
      }
    }
    if (base.completion_error !== null) this.fixedReasons.push(`completion_unavailable:${base.completion_error}`);
    // 02 の中身。
    const contentEmitter = scopedEmitter(this.emitter, { ai_id: null });
    this.content = this.options.content
      ? this.options.content({ history: this.history, emitter: contentEmitter })
      : this.buildContent(contentEmitter);
    this.content.init({
      condition: this.condition,
      feeds_generation: this.feeds.effective,
      self_run: this.config.self_run,
      correction_mode: this.config.correction.mode,
      retraction_timing: this.config.retraction.timing,
    });
    // 保持する音声（受け止め、保留のつなぎ、最後の段の問い）。どちらかのスロットがなければ合成しない。
    const acks = this.content.ackTemplates();
    this.ackBank = createAckBank({ ack_ids: acks.map((a) => a.template_id), selection: this.config.acknowledgment.selection });
    const ttsA = this.slots.A.tts;
    const ttsB = this.slots.B.tts;
    if (ttsA === null || ttsB === null) throw new Error('two_ai: slot tts unavailable');
    await this.ackBank.synthesize(
      [
        ...acks.map((a) => ({ id: a.template_id, text: a.text })),
        { id: 'hold_bridge', text: this.config.fixed.hold_bridge },
        { id: 'closing_question', text: this.content.closingQuestion().text },
      ],
      { A: ttsA, B: ttsB },
    );
    this.attachMaai();
    this.recordProviders();
    if (this.options.tickTimer !== false) this.tickTimer = setInterval(() => this.tick(), this.turnManager.settings.tick_ms);
    this.sendHello();
    this.sendPhase('intake');
    this.syncMark('intake');
    this.emitter.emit(
      {
        event: 'two_ai.phase_changed',
        from: null,
        to: 'intake',
        source: 'session_start',
        reason: 'session_start',
        elapsed_in_from_ms: absent('session_start'),
        planned_duration_ms: present(Math.round(this.config.phases.intake.max_sec * 1000)),
      } as EventDraft,
      { two_ai: { ai_id: null, point_id: null } },
    );
    this.pushStatus(true);
  }

  private buildContent(emitter: EventEmitter): DiscussionContent {
    const assets = loadDiscussionAssets(this.options.settings.root, this.config, this.script.personas_file);
    return createDiscussionContent({
      config: this.config,
      script: this.script,
      personas: assets.personas,
      templates: assets.templates,
      outline: assets.outline,
      safety: assets.safety,
      llmFor: this.options.providers.llmFor,
      emitter,
      time: this.time,
      history: this.history,
    });
  }

  private personas() {
    return loadDiscussionAssets(this.options.settings.root, this.config, this.script.personas_file).personas;
  }

  private sendHello(): void {
    const personas = this.personas().personas;
    this.send({
      type: 'server.hello',
      protocol_version: 1,
      mode: 'two_ai',
      session_id: this.session_id,
      condition: null,
      is_fake: this.isFake(),
      two_ai: {
        ai_ids: ['A', 'B'],
        avatar_keys: { A: personas[0].avatar_key, B: personas[1].avatar_key },
        labels: { A: personas[0].display_name, B: personas[1].display_name },
        phase: this.dstate.phase,
      },
    } as NodeToBrowser);
  }

  private isFake(): boolean {
    return Object.values(this.options.providers.base.classes).some((c) => c === 'test_double');
  }

  private recordClient(hello: ClientHello, connection: 'new_session' | 'reattached'): void {
    this.emitter.emit({
      event: 'session.client',
      protocol_version: hello.protocol_version,
      audio_context_sample_rate_hz: hello.audio_context_sample_rate_hz,
      frame_samples: hello.frame_samples,
      user_agent: hello.user_agent,
      track_settings: hello.track_settings,
      latency: hello.latency,
      connection,
    });
  }

  private attachMaai(): void {
    const attached = this.maaiWiring.attach(() => undefined);
    if (attached.fixedReason !== null) this.fixedReasons.push(attached.fixedReason);
    this.unsubscribe.push(...attached.unsubscribe);
  }

  // ---- manifest ----------------------------------------------------------------

  private recordProviders(): void {
    const base: BaseProviders = this.options.providers.base;
    const recorded = recordBaseProviders(this.emitter, base, this.fixedReasons, { client: this.options.maai, unavailableReason: this.options.maaiUnavailableReason ?? null });
    const providers = recorded.providers;
    for (const ai of AI_IDS) {
      const slotTts = this.options.providers.slotTts[ai];
      const reason = this.slots[ai].unavailableReason;
      providers[`tts:${ai}`] = { provider: slotTts.provider, provider_class: reason === null ? slotTts.provider_class : 'unavailable', reason };
    }
    providers.vap = recorded.vap;
    this.manifestDetails = {
      condition: this.condition,
      policy_id: this.options.policy.policy_id,
      providers,
      tts_settings: this.options.providers.slotTts.A.describeSettings?.() ?? null,
      mode: 'two_ai',
      two_ai: this.buildTwoAiManifest(),
    };
    void this.describe();
  }

  private describe(audio?: SessionAudioManifest): Promise<boolean> {
    if (this.manifestDetails !== null) this.manifestDetails.two_ai = this.buildTwoAiManifest();
    return this.manifestWriter.describe(
      () => this.manifestDetails,
      () => audio ?? this.audioRecorder?.manifest() ?? sessionAudioOffManifest('SAVE_SESSION_AUDIO_not_set'),
      () => this.avatarManifest,
    );
  }

  private buildTwoAiManifest(): TwoAiManifest {
    const s = this.options.settings;
    const script = this.options.script;
    const personas = this.personas().personas;
    const voice_provider = this.options.providers.voice_provider;
    const plan = this.plan !== null && this.plan.ok ? this.plan : null;
    const exploratory = this.feeds.effective;
    const notes: string[] = [];
    if (exploratory) notes.push('exploratory:interjection_feeds_generation');
    // 応答版は内容をそろえた比較（統制版）に使わない（RQ1、RQ4 の観察用）
    if (s.config.experience.mode === 'responsive') notes.push('mode:responsive');
    if (plan?.source === 'fallback_outline') notes.push('plan_source:fallback_outline');
    if (plan !== null && plan.fact_slip !== 'available') notes.push('fact_slip:unavailable');
    if (plan !== null && plan.control_inference !== 'available') notes.push('control_inference:unavailable');
    if (this.evidenceFlags.forced_or_missed) notes.push('points:forced_or_missed');
    if (this.isFake()) notes.push('providers:test_double');
    const manifest = {
      config_file: s.config_file,
      config_sha256: s.config_sha256,
      config_id: s.config.config_id,
      config_version: s.config.version,
      script_file: script.file,
      script_sha256: script.sha256,
      script_id: script.script.script_id,
      script_kind: script.script.kind,
      condition: this.condition,
      condition_source: this.options.condition_source,
      arm_id: this.options.arm?.arm_id ?? null,
      self_run: s.config.self_run,
      correction_mode: s.config.correction.mode,
      personas: {
        A: { persona_id: personas[0].persona_id, version: personas[0].version, voice_env: TWO_AI_VOICE_ENV.A, voice_provider },
        B: { persona_id: personas[1].persona_id, version: personas[1].version, voice_env: TWO_AI_VOICE_ENV.B, voice_provider },
      },
      planned_points: script.script.planned_points.map((p) => ({
        id: p.id,
        kind: p.kind,
        speaker: p.speaker,
        trigger: p.trigger,
        elaborate_turns: p.elaborate_turns,
        source: p.source,
        text_sha256: p.turns === null ? null : sha256(JSON.stringify({ turns: p.turns, corrected_turns: p.corrected_turns, uptake: p.uptake })),
      })),
      point_schedule: { ok: script.schedule.ok, latest_point_end_sec: script.schedule.latest_point_end_sec, limit_sec: script.schedule.limit_sec },
      ack_templates: this.ackBank?.manifestEntries() ?? [],
      response_duration_sec: s.config.phases.response.duration_sec,
      experience: {
        interjection_feeds_generation: this.feeds,
        response_mode: s.config.experience.response_mode,
        ...(s.config.experience.mode === 'responsive' ? { mode: 'responsive' as const } : {}),
      },
      exploratory,
      plan_hash: plan?.plan_hash ?? null,
      plan_source: plan?.source ?? null,
      plan_wait_ms: this.planWaitMs,
      fact_slip: plan?.fact_slip ?? null,
      fact_slip_source: plan?.fact_slip_source ?? null,
      control_inference: plan?.control_inference ?? null,
      stage_headings_sha256: sha256(JSON.stringify(this.headings)),
      board_sha256: script.script.board === null ? null : sha256(JSON.stringify(script.script.board)),
      rebuild_sha256: script.script.rebuild_turns === null ? null : sha256(JSON.stringify(script.script.rebuild_turns)),
      retraction: {
        timing: s.config.retraction.timing,
        script_sha256: this.retractionEmitted ? (this.retraction?.sha256 ?? null) : null,
        inference_form: this.retractionEmitted ? (this.retraction?.inference_form ?? null) : null,
      },
      marker_enabled: s.config.marker.enabled,
      order: { session_index: this.options.arm?.session_index ?? null, counterbalance_label: this.options.arm?.counterbalance_label ?? null },
      evidence_ok_for_comparison: notes.filter((n) => n !== 'providers:test_double').length === 0 && plan !== null,
      evidence_notes: notes,
      discussion_wall: {
        interjection_wall_ms: Math.round(this.dstate.interjection_wall_ms),
        interjection_allowance_max_ms: s.config.phases.discussion.interjection_allowance_max_sec * 1000,
        interjections_by_stage: [...this.dstate.interjections_by_stage] as [number, number, number, number],
      },
    };
    const parsed = TwoAiManifest.safeParse(manifest);
    if (!parsed.success) console.error(`[two_ai ${this.session_id}] manifest violates contract: ${parsed.error.message.slice(0, 300)}`);
    return manifest as TwoAiManifest;
  }

  // ---- 接続 --------------------------------------------------------------------

  reattach(link: BrowserLink, hello: ClientHello): void {
    this.link = link;
    this.recordClient(hello, 'reattached');
    for (const ai of AI_IDS) this.slots[ai].speech?.rearmReportDeadlines();
    this.emitter.emit({
      event: 'provider.status',
      provider: 'browser_link',
      provider_class: 'production',
      status: 'ok',
      reason: absent('reattached'),
      retry_attempt: 0,
      next_retry_ms: absent('not_retrying'),
    });
    this.sendHello();
    // 送り直し（同期の印は出さない。06 §4.7）。
    this.sendPhase(this.dstate.phase);
    this.sendStage(this.currentStage, this.dstate.phase === 'discussion' ? 'current' : this.dstate.phase === 'response' ? 'all' : 'none', false);
    this.sendBoard('reattach', null);
    this.pushStatus(true);
  }

  detach(reason: string): void {
    if (this.link === null) return;
    this.link = null;
    this.emitter.emit({
      event: 'provider.status',
      provider: 'browser_link',
      provider_class: 'production',
      status: 'down',
      reason: present(reason),
      retry_attempt: 0,
      next_retry_ms: absent('browser_reconnects_by_itself'),
    });
  }

  // ---- 上り ----------------------------------------------------------------------

  handleBinary(data: Uint8Array): void {
    if (this.closed) return;
    this.uplink.handle(data, { recorder: this.audioRecorder, stt: this.stt, maai: this.maaiWiring });
  }

  handleJson(message: BrowserToNode): void {
    if (this.closed) return;
    const gazeEmitter = (m: BrowserToNode) => {
      const ai = (m as { ai_id?: AiId }).ai_id;
      return ai === undefined ? this.emitter : this.slots[ai].emitter;
    };
    if (this.reports.handle(message, (m) => this.send(m), gazeEmitter)) return;
    switch (message.type) {
      case 'client.hello':
        return;
      case 'avatar.report': {
        const { type: _type, ...record } = message;
        const ai = (record as { ai_id?: AiId }).ai_id ?? 'A';
        this.avatarManifest = { ...(this.avatarManifest ?? {}), [ai]: record };
        void this.describe();
        return;
      }
      case 'playback.started': {
        const t = this.toServer(message.client_t_ms);
        this.tracker.started(message.audio_playback_id, message.generation, message.audio_frame, t);
        this.slotOf(message.audio_playback_id)?.speech?.handlePlaybackStarted(message, t);
        if (this.turnByAudio.has(message.audio_playback_id)) this.pendingPlayback.push({ kind: 'started', audio_playback_id: message.audio_playback_id, at: t });
        return;
      }
      case 'playback.position': {
        const t = this.toServer(message.client_t_ms);
        this.tracker.position(message.audio_playback_id, message.samples_written, t);
        this.samplesByAudio.set(message.audio_playback_id, message.samples_written);
        this.slotOf(message.audio_playback_id)?.speech?.handlePlaybackPosition(message, t);
        return;
      }
      case 'playback.ended': {
        const t = this.toServer(message.client_t_ms);
        this.samplesByAudio.set(message.audio_playback_id, message.samples_written);
        this.endReasonByAudio.set(message.audio_playback_id, normalizeEndReason(message.reason));
        this.slotOf(message.audio_playback_id)?.speech?.handlePlaybackEnded(message, t);
        this.tracker.ended(message.audio_playback_id);
        return;
      }
      case 'render.health': {
        const { type: _t, client_t_ms, ...rest } = message;
        this.emitter.emit({ event: 'render.health', ...rest } as EventDraft, { ...this.browserAt(client_t_ms), two_ai: { ai_id: null, point_id: null } });
        return;
      }
      case 'two_ai.marker': {
        const at = this.browserAt(message.client_t_ms);
        this.pendingMarkers.push({ marker_id: message.marker_id, client_t_ms: message.client_t_ms, at: at.at.t_monotonic_ms, time_basis: at.at.time_basis });
        return;
      }
      case 'two_ai.board_pick': {
        const at = this.browserAt(message.client_t_ms);
        this.pendingPicks.push({
          pick_id: message.pick_id,
          card_id: message.card_id,
          board_version: message.board_version,
          client_t_ms: message.client_t_ms,
          at: at.at.t_monotonic_ms,
          time_basis: at.at.time_basis,
          card_known: this.board.has(message.card_id) || (this.rebuildBoard?.some((c) => c.card_id === message.card_id) ?? false),
        });
        return;
      }
      default:
        this.counters.signal_reports_ignored += 1;
        return;
    }
  }

  /** 時計差で写した時刻。時計差がなければ受信の時刻（time_basis: orchestrator、誤差 null）。 */
  private browserAt(client_t_ms: number): { at: { t_monotonic_ms: number; time_basis: TimeBasis } } {
    const mapping = this.reports.browserClock.mapping();
    if (mapping === null) return { at: { t_monotonic_ms: this.time.monotonicMs(), time_basis: { source: 'orchestrator', uncertainty_ms: absent('no_browser_clock_yet') } } };
    return { at: { t_monotonic_ms: Math.max(0, mapping.toServerMs(client_t_ms)), time_basis: mapping.basis } };
  }

  private toServer(clientMs: number): number {
    return this.reports.toServer(clientMs);
  }

  private slotOf(audio: number): AiSlot | null {
    const ai = this.aiByAudio.get(audio);
    if (ai !== undefined) return this.slots[ai];
    for (const a of AI_IDS) if (this.slots[a].speech?.stateOf(audio) != null) return this.slots[a];
    return null;
  }

  // ---- WoZ（研究画面）-------------------------------------------------------------

  handleWoz(cmd: ResearchWoz): ResearchWozAck {
    if (this.closed) return { type: 'research.woz.ack', woz_id: cmd.woz_id, status: 'no_session', detail: 'session_closed', phase: null };
    const s = this.dstate;
    const known = new Map<string, { kind: LoadedScript['script']['planned_points'][number]['kind']; started: boolean; switched: boolean }>();
    for (const p of this.script.planned_points) {
      const prog = s.points[p.id];
      known.set(p.id, { kind: p.kind, started: prog !== undefined && prog.state !== 'pending', switched: prog?.switched ?? false });
    }
    const sub = s.sub;
    const view: WozView = {
      condition: this.condition,
      phase: s.phase,
      floor: s.floor,
      woz_paused: s.woz_paused,
      user_floor: sub.kind === 'user_floor',
      correction_hold: sub.kind === 'correction_window' && sub.hold_until !== null && s.interjection !== null ? { interjection_id: s.interjection.interjection_id, hold_until: sub.hold_until } : null,
      known_points: known,
    };
    const input: WozInputTwoAi = { woz_id: cmd.woz_id, action: cmd.action, point_id: cmd.point_id, operator: cmd.operator, received_at: this.time.monotonicMs() };
    const admission = admitWoz(input, view);
    this.emitter.emit(
      {
        event: 'woz.override',
        action: cmd.action,
        operator: cmd.operator,
        detail: {
          woz_id: cmd.woz_id,
          status: admission.status,
          reason: admission.reason,
          phase: s.phase,
          ai_speaking: s.floor?.ai_id ?? null,
          point_id: cmd.point_id,
          condition_note: admission.condition_note,
        },
      },
      { two_ai: { ai_id: null, point_id: cmd.point_id } },
    );
    if (admission.status !== 'rejected') this.pendingWoz.push(input);
    else if (cmd.action === 'correction' && s.phase === 'discussion') {
      // 断った訂正も two_ai.script(rejected) に残す（01 §3.5.2、05 §2.2 の表、AC3(d)）。
      const point_id = admission.reason === 'unknown_point' ? null : resolveCorrectionPoint(cmd.point_id, known);
      this.emitDirector(
        {
          event: 'two_ai.script',
          stage: 'rejected',
          point_id,
          trigger: 'woz_researcher',
          reason: admission.reason,
          decided_at: input.received_at,
          timing: null,
          asr_segment_ids: [],
          invalidated_turn_ids: [],
          replaced_point_turn_ids: [],
          resume_dropped: false,
          uptake_turn_id: null,
        } as EventDraft,
        null,
        point_id,
      );
    }
    return { type: 'research.woz.ack', woz_id: cmd.woz_id, status: admission.status, detail: admission.reason, phase: s.phase };
  }

  // ---- STT -----------------------------------------------------------------------

  private onSttResult(result: SttResult): void {
    const snapshot = this.transcriptTracker.onResult(result, this.history);
    this.completion.request(snapshot, this.turnState, this.history, () => this.closed);
    const content = this.content;
    if (content === null) return;
    const classification: UtteranceClass = content.classifyUserUtterance({ text: result.text, is_final: result.kind === 'final', voiced_ms: this.voicedSinceOnsetMs });
    this.pendingUtterance = {
      segment_id: result.segment_id,
      is_final: result.kind === 'final',
      classification,
      basis: result.text === '' ? 'none' : result.kind === 'final' ? 'final' : 'interim',
      asr_segment_ids: [result.asr_segment_id],
    };
    const track = this.dstate.interjection;
    if (track !== null && result.text !== '') {
      const acc = this.interjectionText.get(track.interjection_id) ?? { text: new Map<number, string>(), asr_segment_ids: new Set<number>() };
      acc.text.set(result.asr_segment_id, result.text);
      acc.asr_segment_ids.add(result.asr_segment_id);
      this.interjectionText.set(track.interjection_id, acc);
    }
    if (result.kind === 'final') {
      const entry = this.history.snapshot().find((e) => e.role === 'user' && e.segment_id === result.segment_id);
      if (entry !== undefined && entry.role === 'user') content.onUserUtterance(entry, { phase: this.dstate.phase, interjection_id: track?.interjection_id ?? null });
    }
  }

  // ---- tick ----------------------------------------------------------------------

  tick(): void {
    if (this.closed) return;
    try {
      const now = this.time.monotonicMs();
      if (this.link !== null) {
        for (const ai of AI_IDS) {
          const speech = this.slots[ai].speech;
          if (speech === null) continue;
          const before = new Map([...this.turnByAudio.keys()].map((id) => [id, this.samplesByAudio.get(id)]));
          void before;
          for (const id of speech.expireOverdueReports(this.uplink.receivedAudioFrame)) {
            this.counters.playback_ended_synthesized += 1;
            this.tracker.ended(id);
          }
        }
      }
      // 本人の話し始めの検出（VAP が fresh なら人の側、そうでなければ mic の dBFS）。
      const vap = this.maaiWiring.vap;
      const fresh = this.turnState.vap_freshness === 'fresh' && vap !== null;
      const ai_playing = this.slots.A.activePlayback() !== null || this.slots.B.activePlayback() !== null;
      const det = stepInterjection(
        this.interjectionState,
        {
          vap: fresh ? readVapUser(vap, vapDirectionSettings(this.options.policy)) : null,
          vap_freshness: this.turnState.vap_freshness,
          mic_dbfs: this.uplink.lastMicDbfs,
          ai_playing,
        },
        now,
        this.interjectionSettings,
      );
      this.interjectionState = det.state;
      const voiced = det.signal.kind === 'onset' || (det.signal.kind === 'none' && det.signal.voiced);
      if (det.signal.kind === 'onset') {
        this.onsetAt = now;
        this.voicedSinceOnsetMs = 0;
      }
      if (voiced) {
        this.lastVoiceAt = now;
        if (this.onsetAt !== null) this.voicedSinceOnsetMs += this.turnManager.settings.tick_ms;
      }
      // TurnManager（intake の応答、受け止めと定型の開始の時機）。
      const previous = this.turnState;
      const inputs = this.turnInputs();
      let { state, decisions } = this.turnManager.step(previous, inputs, now);
      this.turnState = state;
      const start = decisions.find((d) => d.kind === 'start_speech');
      this.startedAckThisTick = null;
      if (start !== undefined) {
        const refused = this.startFromTurnManager(start.audio_playback_id);
        if (refused !== null) {
          this.counters.start_rolled_back += 1;
          ({ state, decisions } = this.turnManager.step(previous, { ...inputs, start_blocked_reason: `start_refused:${refused}` }, now));
          this.turnState = state;
        }
      }
      for (const decision of decisions) this.dispatchTurn(decision, now);
      // 進行役。
      const dInputs = this.directorInputs(det.signal, now);
      const before = this.dstate;
      this.actionCtx = { phase: before.phase, discussion_stage: before.discussion_stage, script_variant: before.script_variant };
      const result = this.director.step(this.dstate, dInputs, now);
      this.dstate = result.state;
      try {
        for (const action of result.actions) this.execute(action, now);
      } finally {
        this.actionCtx = null;
      }
      this.pushStatus(false);
    } catch (error) {
      this.counters.tick_errors += 1;
      if (this.counters.tick_errors <= 5) console.error(`[two_ai ${this.session_id}] tick failed:`, error);
    }
  }

  private turnInputs(): TurnInputs {
    const t = this.transcriptTracker.latest;
    const prefetch = this.prefetchInput();
    return buildTurnInputs({
      maai: this.maaiWiring,
      maaiEnabled: this.options.maai !== null,
      uplink: this.uplink,
      transcript: t,
      completion: this.completion,
      start_blocked_reason: this.startBlockedReason(),
      similarity: absent('two_ai_no_similarity'),
      prefetch,
      playback: this.tracker.input(),
    });
  }

  /** TurnManager の準備済みの位置（受け止め、intake の定型、intake の担当スロットの準備）。 */
  private prefetchInput(): TurnInputs['prefetch'] {
    const ready = (offer: { ai: AiId; audio: number }): TurnInputs['prefetch'] => {
      const isReady = this.slots[offer.ai].speech?.isReady(offer.audio) ?? false;
      return {
        state: isReady ? 'ready' : 'preparing',
        audio_playback_id: offer.audio,
        segment_id: this.turnState.segment_id,
        transcript_revision: this.transcriptTracker.latest?.transcript_revision ?? 0,
        started_at: this.time.monotonicMs(),
      };
    };
    if (this.ackOffer !== null) return ready(this.ackOffer);
    if (this.fixedOffer !== null) return ready(this.fixedOffer);
    if (this.dstate.phase === 'intake' && this.responder !== null) return this.slots[this.responder].prefetch?.input() ?? { state: 'idle' };
    return { state: 'idle' };
  }

  private startBlockedReason(): string | null {
    if (this.link === null) return 'browser_detached';
    for (const ai of AI_IDS) {
      const active = this.slots[ai].activePlayback();
      if (active !== null) return `another_playback_active:${active}`;
    }
    if (this.ackOffer !== null || this.fixedOffer !== null) return null;
    if (this.dstate.phase === 'intake' && this.responder !== null && this.dstate.floor === null && this.dstate.queue.length === 0) return null;
    return 'two_ai_director_owns_floor';
  }

  /** TurnManager の start_speech（受け止め、intake の定型、intake の応答）。拒否なら理由。 */
  private startFromTurnManager(audio: number): string | null {
    const ai = this.ackOffer?.audio === audio ? this.ackOffer.ai : this.fixedOffer?.audio === audio ? this.fixedOffer.ai : this.responder;
    if (ai === null) return 'no_slot';
    const speech = this.slots[ai].speech;
    if (speech === null) return 'speech_unavailable';
    const other = this.slots[ai === 'A' ? 'B' : 'A'].activePlayback();
    if (other !== null) return 'another_slot_active';
    const result = speech.startChecked(audio);
    if (!result.ok) {
      this.counters.start_refused[result.reason] = (this.counters.start_refused[result.reason] ?? 0) + 1;
      return result.reason;
    }
    this.aiByAudio.set(audio, ai);
    this.startedInSegment.set(audio, this.turnState.segment_id);
    if (this.ackOffer?.audio === audio) {
      this.startedAckThisTick = audio;
      this.ackOffer = null;
    } else if (this.fixedOffer?.audio === audio) {
      this.fixedOffer = null;
    }
    return null;
  }

  private dispatchTurn(decision: TurnDecision, now: number): void {
    this.counters.decisions[decision.kind] = (this.counters.decisions[decision.kind] ?? 0) + 1;
    const intakeResponder = this.dstate.phase === 'intake' && this.responder !== null ? this.slots[this.responder] : null;
    switch (decision.kind) {
      case 'prepare':
      case 'cancel_prepare':
        if (intakeResponder !== null && this.fixedOffer === null) intakeResponder.prefetch?.execute(decision);
        else this.counters.two_ai_dropped_decisions += 1;
        return;
      case 'start_speech':
        return;
      case 'interrupt_speech':
        // 止める権限は進行役だけ（intake の応答だけは 1 対 1 と同じ割り込み）。
        if (intakeResponder !== null && this.dstate.floor === null) {
          intakeResponder.speech?.stop(decision.audio_playback_id, decision.reason, { stop_point: decision.stop_point, max_wait_ms: decision.max_wait_ms, decision_source: decision.decision_source });
        } else {
          this.counters.two_ai_dropped_decisions += 1;
        }
        return;
      case 'advance_segment':
        this.stt?.advanceSegment(decision.new_segment_id, decision.at_audio_frame);
        return;
      case 'turn_allowed':
        this.emitter.emit({ event: 'turn.allowed', ...decision.payload }, { two_ai: { ai_id: null, point_id: null } });
        return;
      case 'gaze':
        if (intakeResponder !== null) {
          intakeResponder.emitter.emit({ event: 'gaze.decision', ...decision.payload });
          this.send({ type: 'gaze.command', target: decision.payload.target, ai_id: intakeResponder.ai_id });
        } else {
          this.counters.two_ai_dropped_decisions += 1;
        }
        return;
      case 'set_degraded':
        this.degradedReason = decision.degraded ? decision.reason : null;
        void now;
        return;
    }
  }

  private directorInputs(signal: ReturnType<typeof stepInterjection>['signal'], now: number): DirectorInputs {
    const inputs = emptyInputs();
    inputs.link_attached = this.link !== null;
    for (const ai of AI_IDS) {
      const slot = this.slots[ai];
      inputs.slots[ai] = { ready: [], failed: [], active_playback: slot.activePlayback(), available: slot.available };
    }
    inputs.turn_arrivals = this.pendingArrivals.splice(0);
    for (const a of inputs.turn_arrivals) {
      if (this.slots[a.turn.speaker].speech?.isReady(a.audio_playback_id)) inputs.slots[a.turn.speaker].ready.push({ turn_id: a.turn.turn_id, audio_playback_id: a.audio_playback_id });
    }
    for (const q of [this.dstate.next, ...this.dstate.queue]) {
      if (q === null || q.audio_playback_id === null || q.turn === null) continue;
      if (this.slots[q.turn.speaker].speech?.isReady(q.audio_playback_id)) inputs.slots[q.turn.speaker].ready.push({ turn_id: q.turn_id, audio_playback_id: q.audio_playback_id });
    }
    inputs.turn_failures = this.pendingFailures.splice(0);
    inputs.content_credits = this.pendingCredits.splice(0);
    inputs.cancelled_turn_ids = this.pendingCancelled.splice(0);
    inputs.playback_events = this.pendingPlayback.splice(0);
    inputs.interjection = signal;
    inputs.user = {
      speaking: this.turnState.user_speaking,
      permitted_to_speak: this.turnState.permitted_to_speak,
      started_ack: this.startedAckThisTick,
      voiced_ms_since_onset: this.voicedSinceOnsetMs,
      last_voice_at: this.lastVoiceAt,
    };
    inputs.user_utterance = this.pendingUtterance;
    this.pendingUtterance = null;
    const content = this.content;
    if (content !== null) {
      inputs.plan = content.planStatus();
      inputs.points = content.pendingPoints({ content_elapsed_ms: this.dstate.content_elapsed_ms });
      inputs.correction_suggestions = content.correctionSuggestions();
      const elapsed = now - this.dstate.phase_started_at;
      inputs.content_done = {
        intake: this.dstate.phase === 'intake' && content.isDone('intake', { elapsed_ms: elapsed, content_elapsed_ms: this.dstate.content_elapsed_ms }),
        discussion: this.dstate.phase === 'discussion' && content.isDone('discussion', { elapsed_ms: elapsed, content_elapsed_ms: this.dstate.content_elapsed_ms }),
      };
      inputs.intake_readback_due = this.dstate.phase === 'intake' && content.intakeReadbackDue({ elapsed_ms: elapsed });
      if (this.dstate.phase === 'discussion' && inputs.plan.state === 'ready') {
        try {
          inputs.stage_headings = content.stageHeadings();
          this.headings = inputs.stage_headings;
          inputs.planned_cards = content.plannedBoard?.() ?? null;
        } catch {
          inputs.stage_headings = null;
        }
      }
    }
    inputs.woz = this.pendingWoz.splice(0);
    inputs.markers = this.pendingMarkers.splice(0);
    inputs.board_picks = this.pendingPicks.splice(0);
    return inputs;
  }

  // ---- 進行役の行動の実行（01 表 3.3）----------------------------------------------

  private execute(a: DirectorAction, now: number): void {
    this.counters.director_actions[a.kind] = (this.counters.director_actions[a.kind] ?? 0) + 1;
    const content = this.content;
    if (content === null) return;
    switch (a.kind) {
      case 'start_discussion':
        content.startDiscussion();
        return;
      case 'request_next_turn':
        this.requestNextTurn(content, a.turn_id, now);
        return;
      case 'substitute_fallback': {
        this.inflight.get(a.turn_id)?.abort();
        this.inflight.delete(a.turn_id);
        try {
          this.prepareTurn(content.fallbackTurn(a.turn_id), 'fallback', a.turn_id);
        } catch (error) {
          this.pendingFailures.push({ turn_id: a.turn_id, reason: `fallback_failed:${errorText(error)}` });
        }
        return;
      }
      case 'request_fixed':
        this.requestFixed(content, a.turn_id, a.line);
        return;
      case 'request_resume': {
        const ctx = a.resume;
        if (ctx === null) return;
        try {
          const plan = content.planInterjection({
            interrupted_turn_id: this.turns.get(ctx.interrupted_turn_id)?.content_turn_id ?? ctx.interrupted_turn_id,
            spoken_prefix: this.spokenByTurn.get(ctx.interrupted_turn_id) ?? ctx.spoken_text,
            last_speaker: a.last_speaker,
            mode: a.mode,
          });
          if (plan.resume === null) this.pendingFailures.push({ turn_id: a.turn_id, reason: 'no_resume' });
          else {
            // 応答版：resume の頭に割り込みへの短い応答を入れてから準備する（統制版は null で今の同期の経路）
            const resume = plan.resume;
            const abort = new AbortController();
            const pending = a.mode === 'after_ack' ? (content.completeResume?.({ resume, interjection_id: ctx.interjection_id, mode: a.mode }, abort.signal) ?? null) : null;
            if (pending === null) this.prepareTurn(resume, 'resume', a.turn_id);
            else {
              this.planAborts.push(abort);
              pending.then(
                (turn) => {
                  if (!this.closed) this.prepareTurn(turn, 'resume', a.turn_id);
                },
                () => {
                  if (!this.closed) this.prepareTurn(resume, 'resume', a.turn_id);
                },
              );
            }
          }
        } catch (error) {
          this.pendingFailures.push({ turn_id: a.turn_id, reason: `resume_failed:${errorText(error)}` });
        }
        return;
      }
      case 'apply_correction': {
        if (this.actionCtx !== null) this.actionCtx.script_variant = 'corrected';
        let result: CorrectionResult;
        try {
          result = content.applyCorrection(a.point_id, a.trigger, a.timing, a.interrupted_turn_id === null ? null : (this.turns.get(a.interrupted_turn_id)?.content_turn_id ?? a.interrupted_turn_id));
        } catch (error) {
          this.emitDirector({ event: 'two_ai.anomaly', kind: 'llm_failed', speaker: null, detail: `apply_correction:${errorText(error)}`.slice(0, 200) } as EventDraft);
          return;
        }
        this.prepareTurn(result.uptake, 'uptake', result.uptake.turn_id);
        const cancelled = this.cancelByContentIds([...result.invalidate_turn_ids, ...result.replace_point_turn_ids], 'correction_switched');
        this.emitDirector(
          {
            event: 'two_ai.script',
            stage: 'switched',
            point_id: a.point_id,
            trigger: a.trigger,
            reason: a.trigger,
            decided_at: now,
            timing: a.timing,
            asr_segment_ids: [],
            invalidated_turn_ids: result.invalidate_turn_ids,
            replaced_point_turn_ids: result.replace_point_turn_ids,
            resume_dropped: result.drop_resume,
            uptake_turn_id: result.uptake.turn_id,
          } as EventDraft,
          null,
          a.point_id,
        );
        this.pendingCancelled.push(...cancelled);
        return;
      }
      case 'record_correction_only':
        try {
          content.applyCorrection(a.point_id, a.trigger, 'next_boundary', null);
        } catch {
          // 応答の段は記録だけ（作り直しと撤回は 02 が同じに行う）。
        }
        this.emitDirector(
          {
            event: 'two_ai.script',
            stage: 'recorded_only',
            point_id: a.point_id,
            trigger: a.trigger,
            reason: 'response_phase',
            decided_at: now,
            timing: 'response_phase',
            asr_segment_ids: [],
            invalidated_turn_ids: [],
            replaced_point_turn_ids: [],
            resume_dropped: false,
            uptake_turn_id: null,
          } as EventDraft,
          null,
          a.point_id,
        );
        return;
      case 'request_rebuild': {
        const rebuild = () => {
          try {
            const rb = content.closingRebuild();
            this.rebuildBoard = rb.board;
            for (const t of rb.turns) this.prepareTurn(t, 'rebuild', t.turn_id);
          } catch (error) {
            this.pendingFailures.push({ turn_id: 'rebuild', reason: `rebuild_failed:${errorText(error)}` });
          }
        };
        // 応答版：板の生成（本人の応答を入れた台帳から）を上限まで待ってから作り直す（統制版は null で今の同期の経路）
        const abort = new AbortController();
        const waiting = content.prepareClosing?.(abort.signal) ?? null;
        if (waiting === null) rebuild();
        else {
          this.planAborts.push(abort);
          waiting.then(
            () => {
              if (!this.closed) rebuild();
            },
            () => {
              if (!this.closed) rebuild();
            },
          );
        }
        return;
      }
      case 'abandon_resume': {
        try {
          const r = content.abandonResume(a.interrupted_turn_id === null ? null : (this.turns.get(a.interrupted_turn_id)?.content_turn_id ?? a.interrupted_turn_id), a.reason);
          this.pendingCredits.push({ interjection_id: a.interjection_id, credited_ms: Math.max(0, Math.round(r.credited_ms)) });
        } catch (error) {
          this.pendingCredits.push({ interjection_id: a.interjection_id, credited_ms: 0 });
          console.error(`[two_ai ${this.session_id}] abandonResume failed: ${errorText(error)}`);
        }
        return;
      }
      case 'offer_fixed': {
        const line = this.fixedText(content, a.line);
        if (line === null) return;
        const prepared = this.slots[a.ai_id].prepareText(this.origin(a.ai_id, `fixed_${a.line.kind}`, fixedTurnKind(a.line), null), line.text, this.link_());
        if (prepared === null) return;
        // その番の担当スロットの LLM の準備は取り消す（01 §3.10.5）。
        const current = this.slots[a.ai_id].prefetch?.input();
        if (current !== undefined && current.state !== 'idle') this.slots[a.ai_id].speech?.cancel(current.audio_playback_id, 'offer_fixed');
        this.aiByAudio.set(prepared.audio_playback_id, a.ai_id);
        this.fixedOffer = { ai: a.ai_id, audio: prepared.audio_playback_id };
        return;
      }
      case 'start_turn': {
        const rec = this.turns.get(a.turn_id);
        const slot = this.slots[a.ai_id];
        const other = this.slots[a.ai_id === 'A' ? 'B' : 'A'];
        if (this.link === null) {
          this.pendingFailures.push({ turn_id: a.turn_id, reason: 'browser_detached' });
          return;
        }
        if (slot.activePlayback() !== null || other.activePlayback() !== null) {
          this.pendingFailures.push({ turn_id: a.turn_id, reason: 'another_slot_active' });
          return;
        }
        const result = slot.speech?.startChecked(a.audio_playback_id) ?? { ok: false as const, reason: 'speech_unavailable' };
        if (!result.ok) {
          this.counters.start_refused[result.reason] = (this.counters.start_refused[result.reason] ?? 0) + 1;
          this.pendingFailures.push({ turn_id: a.turn_id, reason: `start_refused:${result.reason}` });
          return;
        }
        const noted = noteExternalStart(this.turnState, { audio_playback_id: a.audio_playback_id, now, received_audio_frame: this.uplink.receivedAudioFrame }, { corrected: this.turnManager.settings.corrected });
        this.turnState = noted.state;
        for (const d of noted.decisions) this.dispatchTurn(d, now);
        this.startedInSegment.set(a.audio_playback_id, this.turnState.segment_id);
        void rec;
        return;
      }
      case 'stop_turn':
        this.slots[a.ai_id].speech?.stop(a.audio_playback_id, a.reason, { stop_point: a.stop_point, max_wait_ms: a.max_wait_ms, decision_source: a.decision_source });
        return;
      case 'cancel_turn': {
        this.inflight.get(a.turn_id)?.abort();
        this.inflight.delete(a.turn_id);
        const audio = a.audio_playback_id ?? this.turns.get(a.turn_id)?.audio ?? null;
        if (audio !== null) this.slotOf(audio)?.speech?.cancel(audio, a.reason);
        return;
      }
      case 'gaze':
        this.sendGaze(a.ai_id, a.target, a.reason);
        return;
      case 'offer_ack': {
        const bank = this.ackBank;
        if (bank === null) return;
        const template_id = bank.nextTemplateId(a.ai_id);
        const audio = bank.get(a.ai_id, template_id);
        const turn_id = `ack_${a.interjection_id ?? 'response'}_${template_id}`;
        const prepared = this.slots[a.ai_id].prepareCached(this.origin(a.ai_id, turn_id, 'ack', null), audio, this.link_());
        if (prepared === null) return;
        this.withdrawAck('superseded');
        this.aiByAudio.set(prepared.audio_playback_id, a.ai_id);
        this.ackOffer = { ai: a.ai_id, audio: prepared.audio_playback_id };
        this.pendingArrivals.push({
          turn: this.viewOf(turn_id, a.ai_id, 'ack', null, 'cached', audio.synthesized_ms, 0),
          audio_playback_id: prepared.audio_playback_id,
          source: 'cached_ack',
          cached: { template_id, synthesized_ms: audio.synthesized_ms },
        });
        return;
      }
      case 'withdraw_ack':
        this.withdrawAck(a.reason);
        return;
      case 'route_user_turns':
        this.responder = a.responder;
        return;
      case 'start_plan': {
        const abort = new AbortController();
        this.planAborts.push(abort);
        const started = now;
        const promise = a.trigger === 'early' ? content.preparePlan(abort.signal) : content.finalizePlan(abort.signal);
        promise.then(
          (r) => {
            if (this.closed) return;
            if (r.ok) {
              this.plan = r;
              this.planWaitMs = Math.max(0, Math.round(this.time.monotonicMs() - started));
              void this.describe();
            }
          },
          (error: unknown) => console.error(`[two_ai ${this.session_id}] plan failed: ${errorText(error)}`),
        );
        return;
      }
      case 'use_fallback_plan': {
        const r = content.fallbackPlan(a.reason);
        if (r.ok) this.plan = r;
        void this.describe();
        return;
      }
      case 'force_points':
        content.forcePendingPoints();
        this.evidenceFlags.forced_or_missed = true;
        return;
      case 'notify_interjection_closed': {
        const track = this.dstate.interjection;
        const acc = this.interjectionText.get(a.interjection_id);
        const text = acc === undefined ? '' : [...acc.text.values()].join('');
        const r = content.onInterjectionClosed({
          interjection_id: a.interjection_id,
          text,
          asr_segment_ids: acc === undefined ? [] : [...acc.asr_segment_ids],
          classification: track?.interjection_id === a.interjection_id ? (track.classification ?? 'unknown') : 'unknown',
          during_point_id: track?.interjection_id === a.interjection_id ? (track.interrupted?.point_id ?? null) : null,
        });
        // 点、resume、uptake は対象外（02 が生のターンだけを返す）。
        this.pendingCancelled.push(...this.cancelByContentIds(r.invalidate_turn_ids, 'interjection_invalidated', true));
        return;
      }
      case 'send_board':
        this.sendBoard(a.reason, a.trigger_turn_id);
        return;
      case 'send_stage':
        this.sendStage(a.current, a.show, true);
        return;
      case 'set_phase':
        this.onSetPhase(a.to);
        return;
      case 'pause':
        this.emitDirector({ event: 'two_ai.anomaly', kind: 'tts_failed', speaker: null, detail: `paused:${a.reason}`.slice(0, 200) } as EventDraft);
        return;
      case 'emit': {
        const draft = a.draft as EventDraft;
        this.advanceActionCtx(draft);
        if (draft.event === 'two_ai.point' && ((draft as { stage?: string }).stage === 'forced' || (draft as { stage?: string }).stage === 'missed')) this.evidenceFlags.forced_or_missed = true;
        if (draft.event === 'two_ai.turn') this.onTurnDropped(draft as { stage?: string; turn_id?: string });
        this.emitter.emit(draft, { ...(a.at ? { at: a.at } : {}), two_ai: { ai_id: a.ai_id ?? null, point_id: a.point_id ?? (draft as { point_id?: string | null }).point_id ?? null } });
        return;
      }
      case 'degraded':
        this.degradedReason = a.reason;
        return;
    }
  }

  /**
   * 話さずに終わったターン（skipped／failed）を 02 に 0 ms で返す。返さないと 02 の isDone が
   * 「全部話した」にならず、話し合いが終わらない（点の TTS の失敗で止まった。統合 1）。
   */
  private onTurnDropped(d: { stage?: string; turn_id?: string }): void {
    if ((d.stage !== 'skipped' && d.stage !== 'failed') || d.turn_id === undefined || this.content === null) return;
    const rec = this.turns.get(d.turn_id);
    if (rec === undefined || rec.content_turn_id === null) return;
    try {
      this.content.onTurnPlayed({ turn_id: rec.content_turn_id, audio_playback_id: rec.audio, spoken_text: '', played_ms: 0, completed: false });
    } catch (error) {
      console.error(`[two_ai ${this.session_id}] onTurnPlayed(dropped) failed: ${errorText(error)}`);
    }
  }

  /** 行動の順の封筒を進める（段階の変化、段の始まり）。 */
  private advanceActionCtx(draft: EventDraft): void {
    const ctx = this.actionCtx;
    if (ctx === null) return;
    const d = draft as { event: string; to?: TwoAiPhase; edge?: string; discussion_stage?: number };
    if (d.event === 'two_ai.phase_changed' && d.to !== undefined) {
      ctx.phase = d.to;
      if (d.to !== 'discussion') ctx.discussion_stage = null;
    } else if (d.event === 'two_ai.stage' && d.edge === 'started' && d.discussion_stage !== undefined) {
      ctx.discussion_stage = d.discussion_stage as TwoAiEmitContext['discussion_stage'];
    }
  }

  private link_(): { segment_id: number; transcript_revision: number } {
    return { segment_id: this.turnState.segment_id, transcript_revision: this.transcriptTracker.latest?.transcript_revision ?? 0 };
  }

  private origin(ai: AiId, turn_id: string, turn_kind: TwoAiTurnOrigin['turn_kind'], point_id: string | null): TwoAiTurnOrigin {
    return { kind: 'two_ai_turn', ai_id: ai, turn_id, turn_kind, point_id };
  }

  private emitDirector(draft: EventDraft, ai_id: AiId | null = null, point_id: string | null = null): void {
    this.emitter.emit(draft, { two_ai: { ai_id, point_id } });
  }

  private requestNextTurn(content: DiscussionContent, turn_id: string, now: number): void {
    const abort = new AbortController();
    this.inflight.set(turn_id, abort);
    const started = this.dstate.discussion_started_at;
    content
      .nextTurn({ turn_id, content_elapsed_ms: Math.round(this.dstate.content_elapsed_ms), discussion_elapsed_ms: started === null ? 0 : Math.max(0, Math.round(now - started)) }, abort.signal)
      .then(
        (turn) => {
          if (this.closed || abort.signal.aborted) return;
          this.inflight.delete(turn_id);
          this.prepareTurn(turn, 'next_turn', turn_id);
        },
        (error: unknown) => {
          if (this.closed || abort.signal.aborted) return;
          this.inflight.delete(turn_id);
          if (error instanceof Error && error.name === 'ContentExhausted') {
            this.pendingFailures.push({ turn_id, reason: CONTENT_EXHAUSTED });
            return;
          }
          this.pendingFailures.push({ turn_id, reason: `next_turn_failed:${errorText(error)}`.slice(0, 200) });
        },
      );
  }

  /** 02 のターンを話者のスロットで準備し、次の tick の到着に入れる。turn_id は進行役の ID。 */
  private prepareTurn(turn: DiscussionTurn, source: TurnArrival['source'], turn_id: string): void {
    const slot = this.slots[turn.speaker];
    const prepared = slot.prepareText(this.origin(turn.speaker, turn_id, turn.turn_kind, turn.point_id), turn.text, this.link_());
    if (prepared === null) {
      this.pendingFailures.push({ turn_id, reason: `slot_unavailable:${turn.speaker}` });
      return;
    }
    const view: DiscussionTurnView = {
      turn_id,
      speaker: turn.speaker,
      turn_kind: turn.turn_kind,
      point_id: turn.point_id,
      point_variant: turn.point_variant,
      discussion_stage: turn.discussion_stage,
      gap_hint_ms: turn.gap_hint_ms,
      est_duration_ms: turn.est_duration_ms,
      text_origin: turn.text_origin,
      repeat: turn.repeat,
      feed_turn: turn.feed_turn,
      fed_interjection_ids: turn.fed_interjection_ids,
      chars: [...turn.text].length,
      board_card_id: turn.board_card?.card_id ?? null,
    };
    this.register({ turn_id, content_turn_id: turn.turn_id, ai: turn.speaker, audio: prepared.audio_playback_id, source, view, text: turn.text, board_card: turn.board_card, fixed_line: null });
    this.pendingArrivals.push({ turn: view, audio_playback_id: prepared.audio_playback_id, source });
  }

  private register(rec: TurnRec): void {
    this.turns.set(rec.turn_id, rec);
    this.turnByAudio.set(rec.audio, rec.turn_id);
    this.aiByAudio.set(rec.audio, rec.ai);
  }

  private viewOf(turn_id: string, ai: AiId, kind: TwoAiTurnOrigin['turn_kind'], stage: number | null, origin: 'fixed' | 'cached', est_ms: number, chars: number): DiscussionTurnView {
    return {
      turn_id,
      speaker: ai,
      turn_kind: kind,
      point_id: null,
      point_variant: null,
      discussion_stage: stage,
      gap_hint_ms: 0,
      est_duration_ms: Math.round(est_ms),
      text_origin: origin,
      repeat: null,
      feed_turn: false,
      fed_interjection_ids: [],
      chars,
      board_card_id: null,
    };
  }

  private fixedText(content: DiscussionContent, line: FixedLineRef): { ai_id: AiId; text: string } | null {
    switch (line.kind) {
      case 'phase_line':
        return content.phaseLine(line.phase, line.edge);
      case 'plan_filler':
        return content.planFiller(line.index);
      case 'intake_line':
        return content.intakeLine(line.line);
      case 'response_line':
        return content.responseLine(line.line);
      case 'pick_line':
        return content.pickLine(line.line);
      case 'retraction': {
        this.retraction ??= content.retractionScript();
        return this.retraction.lines[line.index] ?? null;
      }
      case 'hold_bridge':
        return { ai_id: line.ai_id, text: this.config.fixed.hold_bridge };
      case 'closing_question':
        return content.closingQuestion();
    }
  }

  private requestFixed(content: DiscussionContent, turn_id: string, line: FixedLineRef): void {
    const kind = fixedTurnKind(line);
    const stage = this.dstate.phase === 'discussion' ? this.dstate.discussion_stage : null;
    if (line.kind === 'hold_bridge' || line.kind === 'closing_question') {
      const bank = this.ackBank;
      const ai = line.kind === 'hold_bridge' ? line.ai_id : this.config.speakers.closing;
      const key = line.kind === 'hold_bridge' ? 'hold_bridge' : 'closing_question';
      if (bank === null) {
        this.pendingFailures.push({ turn_id, reason: 'no_ack_bank' });
        return;
      }
      const audio = bank.get(ai, key);
      const prepared = this.slots[ai].prepareCached(this.origin(ai, turn_id, kind, null), audio, this.link_());
      if (prepared === null) {
        this.pendingFailures.push({ turn_id, reason: `slot_unavailable:${ai}` });
        return;
      }
      const view = this.viewOf(turn_id, ai, kind, stage, 'cached', audio.synthesized_ms, [...audio.text].length);
      this.register({ turn_id, content_turn_id: null, ai, audio: prepared.audio_playback_id, source: line.kind === 'closing_question' ? 'cached_question' : 'fixed', view, text: audio.text, board_card: null, fixed_line: line });
      this.pendingArrivals.push({ turn: view, audio_playback_id: prepared.audio_playback_id, source: line.kind === 'closing_question' ? 'cached_question' : 'fixed' });
      return;
    }
    let text: { ai_id: AiId; text: string } | null;
    try {
      text = this.fixedText(content, line);
    } catch (error) {
      this.pendingFailures.push({ turn_id, reason: `fixed_failed:${errorText(error)}` });
      return;
    }
    if (text === null) {
      if (line.kind === 'retraction') this.emitRetraction('end');
      this.pendingFailures.push({ turn_id, reason: 'no_line' });
      return;
    }
    const prepared = this.slots[text.ai_id].prepareText(this.origin(text.ai_id, turn_id, kind, null), text.text, this.link_());
    if (prepared === null) {
      this.pendingFailures.push({ turn_id, reason: `slot_unavailable:${text.ai_id}` });
      return;
    }
    const chars = [...text.text].length;
    const view = this.viewOf(turn_id, text.ai_id, kind, stage, 'fixed', (chars / this.config.phases.discussion.chars_per_sec_estimate) * 1000, chars);
    this.register({ turn_id, content_turn_id: null, ai: text.ai_id, audio: prepared.audio_playback_id, source: 'fixed', view, text: text.text, board_card: null, fixed_line: line });
    this.pendingArrivals.push({ turn: view, audio_playback_id: prepared.audio_playback_id, source: 'fixed' });
  }

  /** 02 の turn_id で準備済みのターンを取り消す。取り消した進行役の turn_id を返す。liveOnly は生のターンだけ（点、resume、uptake は除く）。 */
  private cancelByContentIds(ids: readonly string[], reason: string, liveOnly = false): string[] {
    const want = new Set(ids);
    const cancelled: string[] = [];
    for (const rec of this.turns.values()) {
      if (rec.content_turn_id === null || !want.has(rec.content_turn_id)) continue;
      if (liveOnly && (rec.view.point_id !== null || rec.source === 'resume' || rec.source === 'uptake')) continue;
      const speech = this.slots[rec.ai].speech;
      const state = speech?.stateOf(rec.audio) ?? null;
      if (state === 'preparing' || state === 'ready') {
        speech?.cancel(rec.audio, reason);
        cancelled.push(rec.turn_id);
      }
    }
    for (const id of ids) {
      const abort = this.inflight.get(id);
      if (abort !== undefined) {
        abort.abort();
        this.inflight.delete(id);
        cancelled.push(id);
      }
    }
    return cancelled;
  }

  private withdrawAck(reason: string): void {
    const offer = this.ackOffer;
    if (offer === null) return;
    this.ackOffer = null;
    this.slots[offer.ai].speech?.cancel(offer.audio, reason);
  }

  private sendGaze(ai: AiId, target: GazeTarget, reason: string): void {
    const vap = this.maaiWiring.vap;
    this.slots[ai].emitter.emit({
      event: 'gaze.decision',
      target,
      reason: reason.slice(0, 200) || 'director',
      p_now: absent('two_ai_director'),
      p_future: absent('two_ai_director'),
      in_speech_pause: false,
      vap_freshness: vap === null ? 'down' : this.turnState.vap_freshness,
    } as EventDraft);
    this.send({ type: 'gaze.command', target, ai_id: ai });
  }

  // ---- 発話の終わり -----------------------------------------------------------------

  private onSpeechFinished(ai: AiId, finished: SpeechFinished): void {
    const audio = finished.audio_playback_id;
    const turn_id = this.turnByAudio.get(audio) ?? null;
    const rec = turn_id === null ? null : (this.turns.get(turn_id) ?? null);
    const segment = this.startedInSegment.get(audio);
    this.startedInSegment.delete(audio);
    const origin = finished.origin;
    if (origin.kind === 'response' || origin.kind === 'candidate' || origin.kind === 'two_ai_turn') {
      this.history.commitAssistantSpoken(
        {
          text: finished.spoken_text,
          audio_playback_id: audio,
          spoken_text_precision: finished.spoken_text_precision,
          interrupted: finished.interrupted,
          origin,
          ai_id: ai,
        },
        segment,
      );
    }
    const samples = this.samplesByAudio.get(audio) ?? 0;
    this.samplesByAudio.delete(audio);
    const reason = this.endReasonByAudio.get(audio) ?? 'report_timeout';
    this.endReasonByAudio.delete(audio);
    const played_ms = playedMsOf(samples);
    const ackAudio = this.dstate.floor?.audio_playback_id === audio && this.dstate.floor.turn_kind === 'ack';
    if (rec === null && !ackAudio) {
      // intake の応答（TurnManager が始めた）。進行役の床ではない。
      return;
    }
    const view = rec?.view ?? null;
    const share = repeatShare({ played_ms, repeat: view?.repeat ?? null, total_chars: view?.chars ?? [...finished.spoken_text].length, alignment_end_ms: null });
    const kind = view?.turn_kind ?? 'ack';
    this.pendingPlayback.push({
      kind: 'ended',
      audio_playback_id: audio,
      at: this.time.monotonicMs(),
      samples_written: samples,
      played_ms,
      new_ms: share.new_ms,
      bridge_ms: share.bridge_ms,
      repeated_ms: share.repeated_ms,
      repeated_source: share.source,
      content_ms: contentMsOf(kind, played_ms, share.new_ms),
      spoken_text_chars: [...finished.spoken_text].length,
      reason,
    });
    if (rec === null) return;
    this.spokenByTurn.set(rec.turn_id, finished.spoken_text);
    if (rec.content_turn_id !== null && this.content !== null) {
      try {
        this.content.onTurnPlayed({ turn_id: rec.content_turn_id, audio_playback_id: audio, spoken_text: finished.spoken_text, played_ms, completed: reason === 'completed' });
      } catch (error) {
        console.error(`[two_ai ${this.session_id}] onTurnPlayed failed: ${errorText(error)}`);
      }
    }
    if (rec.view.turn_kind === 'retraction') {
      this.retractionPlayed.audio ??= audio;
      this.retractionPlayed.ai ??= ai;
      this.retractionPlayed.played_ms += played_ms;
    }
    // 板：カードを出したターンの終わりの後は研究画面へ文を出してよい（revealed は進行役の send_board）。
    for (const card of this.board.values()) if (card.trigger_turn_id === rec.turn_id) card.trigger_turn_ended = true;
    if (rec.source === 'rebuild') this.rebuildEnded = true;
    // 捉え方の状態（02 の framingState）。変わったときだけ出す。
    this.emitAiState(ai, rec.turn_id);
  }

  private rebuildEnded = false;

  private emitAiState(ai: AiId, turn_id: string | null): void {
    const content = this.content;
    if (content === null) return;
    let fs: ReturnType<DiscussionContent['framingState']>;
    try {
      fs = content.framingState(ai);
    } catch {
      return;
    }
    if (this.aiStateVersion[ai] === fs.version) return;
    this.aiStateVersion[ai] = fs.version;
    this.emitter.emit({ event: 'two_ai.ai_state', speaker: ai, turn_id, state: fs.state, state_version: fs.version } as EventDraft, { two_ai: { ai_id: ai, point_id: null } });
  }

  private onSpeechFailed(audio: number, reason: string): void {
    const turn_id = this.turnByAudio.get(audio);
    if (turn_id === undefined) return;
    const ai = this.aiByAudio.get(audio);
    if (ai !== undefined) this.pendingFailures.push({ turn_id, reason: `tts_failed:${reason}`.slice(0, 200) });
  }

  // ---- 段、板、同期の印、撤回 ----------------------------------------------------------

  private onSetPhase(to: TwoAiPhase): void {
    this.sendPhase(to);
    if (to === 'response' || to === 'next_step' || to === 'end' || to === 'intake') this.syncMark(to);
    if (to === 'end' && this.config.retraction.timing === 'after_measures' && this.dstate.retraction.trigger !== 'aborted') this.emitRetraction('end');
    if (to !== 'discussion') this.currentStage = null;
    void this.describe();
  }

  private sendPhase(phase: TwoAiPhase): void {
    const keys = this.config.fixed.instruction_keys;
    const instruction_key = phase === 'discussion' ? keys.discussion[this.condition] : keys[phase];
    const personas = this.personas().personas;
    this.send({
      type: 'two_ai.phase',
      phase,
      instruction_key,
      labels: phase === 'intake' || phase === 'discussion' || phase === 'response' || phase === 'next_step' ? { A: personas[0].display_name, B: personas[1].display_name } : null,
    } as NodeToBrowser);
  }

  private sendStage(current: number | null, show: 'current' | 'all' | 'none', mark: boolean): void {
    const changed = current !== null && current !== this.currentStage;
    this.currentStage = current;
    this.send({ type: 'two_ai.stage', current, headings: this.headings, show } as NodeToBrowser);
    if (mark && changed) this.syncMark(`stage_${current}` as 'stage_1');
  }

  private syncMark(trigger: 'intake' | 'stage_1' | 'stage_2' | 'stage_3' | 'stage_4' | 'response' | 'next_step' | 'end'): void {
    this.syncSeq += 1;
    this.emitter.emit({ event: 'two_ai.sync_mark', seq: this.syncSeq, trigger, t_wall_ms: Date.now() } as EventDraft, { two_ai: { ai_id: null, point_id: null } });
  }

  private boardCards(): { cards: (BoardCardView & { depends_on: BoardDependency; trigger_turn_ended: boolean })[]; mode: 'building' | 'rebuilt' | 'pick' | 'picked' } {
    const d = this.dstate.board;
    if (this.rebuildBoard !== null && d.mode !== 'building') {
      const started = d.mode === 'rebuilt' || d.mode === 'pick' || d.mode === 'picked';
      return { cards: started ? this.rebuildBoard.map((c) => ({ ...c, trigger_turn_ended: this.rebuildEnded || d.mode !== 'rebuilt' })) : [], mode: d.mode };
    }
    const cards = [...this.board.values()].map((c) => ({ ...c.card, trigger_turn_ended: c.trigger_turn_ended }));
    return { cards: cards.sort((a, b) => a.order - b.order), mode: d.mode };
  }

  private sendBoard(reason: 'shown' | 'revealed' | 'rebuilt' | 'pick_opened' | 'picked' | 'reattach', trigger_turn_id: string | null): void {
    if (reason === 'shown' && trigger_turn_id !== null) {
      const rec = this.turns.get(trigger_turn_id);
      if (rec?.board_card) this.board.set(rec.board_card.card_id, { card: rec.board_card, trigger_turn_id, trigger_turn_ended: false });
    }
    if (reason === 'revealed' && trigger_turn_id !== null) {
      for (const card of this.board.values()) if (card.trigger_turn_id === trigger_turn_id) card.trigger_turn_ended = true;
    }
    const { cards, mode } = this.boardCards();
    const picked = this.dstate.board.picked_card_id;
    this.send({
      type: 'two_ai.board',
      board_version: this.dstate.board.version,
      mode,
      cards: cards.map((c) => ({ card_id: c.card_id, order: c.order, discussion_stage: c.discussion_stage, text: c.text, variant: c.variant })),
      picked_card_id: picked,
    } as NodeToBrowser);
    this.emitter.emit(
      {
        event: 'two_ai.board',
        board_version: this.dstate.board.version,
        mode,
        cards: cards.map((c) => ({ card_id: c.card_id, order: c.order, discussion_stage: c.discussion_stage, variant: c.variant, depends_on: c.depends_on, text: c.text, trigger_turn_ended: c.trigger_turn_ended })),
        trigger_turn_id,
        reason,
        picked_card_id: picked,
      } as EventDraft,
      { two_ai: { ai_id: null, point_id: null } },
    );
  }

  /** two_ai.retraction（文とハッシュ）。end_of_session は文を話し終えた後、after_measures は end に入ったとき（話さない）。1 回だけ。 */
  private emitRetraction(trigger: 'end' | 'aborted'): void {
    if (this.retractionEmitted || this.content === null) return;
    this.retraction ??= this.content.retractionScript();
    const r = this.retraction;
    const spoke = this.retractionPlayed.audio !== null;
    this.retractionEmitted = true;
    this.emitter.emit(
      {
        event: 'two_ai.retraction',
        timing: this.config.retraction.timing,
        trigger: this.dstate.retraction.trigger === 'aborted' ? 'aborted' : trigger,
        point_ids: r.point_ids,
        ai_id: spoke ? this.retractionPlayed.ai : null,
        audio_playback_id: spoke ? present(this.retractionPlayed.audio as number) : absent('not_spoken'),
        played_ms: spoke ? present(Math.round(this.retractionPlayed.played_ms)) : absent('not_spoken'),
        script_sha256: r.sha256,
        lines: r.lines,
        inference_form: r.inference_form,
      } as EventDraft,
      { two_ai: { ai_id: spoke ? this.retractionPlayed.ai : null, point_id: null } },
    );
    void this.describe();
  }

  // ---- 状態と送信 --------------------------------------------------------------------

  private send(message: NodeToBrowser): boolean {
    if (this.link === null) return false;
    return this.link.sendJson(message) !== false;
  }

  status(): SessionStatusView {
    const reasons = [...this.fixedReasons];
    if (this.degradedReason !== null && this.degradedReason !== 'starting') reasons.push(this.degradedReason);
    for (const ai of AI_IDS) if (!this.slots[ai].available) reasons.push(`two_ai_slot_unavailable:${ai}`);
    if (this.dstate.woz_paused) reasons.push('two_ai_paused');
    return { degraded: reasons.length > 0, reasons };
  }

  private pushStatus(force: boolean): void {
    const status = this.status();
    const key = JSON.stringify(status);
    if (!force && key === this.lastStatusKey) return;
    this.lastStatusKey = key;
    this.send({ type: 'session.status', degraded: status.degraded, reasons: status.reasons } as NodeToBrowser);
    this.options.onStatusChange?.(status);
  }

  // ---- 終わり（01 §1.3 の close の順）---------------------------------------------------

  async close(reason: string): Promise<void> {
    if (this.closed) return;
    // ① 両スロットの再生中の発話の終わりを代行。
    for (const ai of AI_IDS) {
      for (const id of this.slots[ai].speech?.endActiveOnBehalf(reason, this.uplink.receivedAudioFrame) ?? []) {
        this.counters.playback_ended_synthesized += 1;
        this.tracker.ended(id);
      }
    }
    if (this.dstate.phase === 'end' || this.dstate.retraction.trigger === 'aborted') this.emitRetraction(this.dstate.retraction.trigger);
    // ② tick の停止。
    this.closed = true;
    if (this.tickTimer !== null) clearInterval(this.tickTimer);
    this.tickTimer = null;
    // ③ 02 の dispose（計画と生成の AbortController）。
    for (const abort of this.planAborts) abort.abort();
    for (const abort of this.inflight.values()) abort.abort();
    this.inflight.clear();
    try {
      this.content?.dispose();
    } catch {
      // 02 の後始末の失敗で閉じる手順を止めない。
    }
    // ④ リンクと購読。
    this.link = null;
    for (const unsubscribe of this.unsubscribe) unsubscribe();
    this.unsubscribe.length = 0;
    // ⑤ スロット。
    for (const ai of AI_IDS) this.slots[ai].dispose();
    // ⑥ STT と 2 本の TTS。
    await Promise.allSettled([this.stt?.close(), ...AI_IDS.map((ai) => this.slots[ai].close())]);
    // ⑦ 音声の保存と manifest。
    const audio = (await this.audioRecorder?.close(reason)) ?? undefined;
    await this.describe(audio);
    // ⑧ ログ。
    await this.options.log.close();
  }
}

function normalizeEndReason(reason: string | null): 'completed' | 'stopped' | 'discarded_before_start' | 'error' | 'report_timeout' {
  if (reason === 'completed' || reason === 'stopped' || reason === 'discarded_before_start' || reason === 'error') return reason;
  return 'report_timeout';
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 160);
}
