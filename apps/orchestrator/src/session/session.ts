/**
 * 1人の参加者との1回のセッションの配線（レーン J、計画 §3、§5.1 J）。
 *
 *   Browser ─AUDIO 枠→ mic → STT、mic+sys → MaAI、エネルギー → fallback_energy、sys → AI 発話中のポーズ
 *   STT 結果 → 履歴（segment 単位）、推定器、TurnInputs.transcript（ASR 区間ごとの文のまま）
 *   MaAI の VAP_STATE → TurnInputs.vap（2ch のみ）
 *   20ms の tick → TurnManager.step → decisions を振り分け:
 *     prepare／cancel_prepare → ResponsePrefetch、start_speech／interrupt_speech → SpeechGenerator、
 *     advance_segment → STT、turn_allowed／gaze → イベントと gaze.command、set_degraded → 画面の状態
 *   SpeechGenerator の下り → PCM 枠と playback.*、ブラウザの playback.* → SpeechGenerator（時刻を補正）
 *   SpeechGenerator の onFinished → 履歴（発話済みの部分のみ）
 *
 *   STT 結果 → 発話希望（initiative_wiring.ts: InitiativeMonitor → CandidateLedger）。tick → 期限と人の発話の有無、
 *   advance_segment → 候補の期限、通常応答の開始 → 残っている候補の撤回、候補の発話の終わり → finishSpeech
 *
 * want_to_speak（準備済みの応答）、permitted_to_speak（TurnManager の許可）、speaking（再生の報告）は
 * 別々に持つ。ここでは混ぜない。波2の範囲では発話希望の候補を作って記録と研究者画面に出すだけで、
 * TurnManager にも D にも渡さない（候補を話さず、吸気もしない。吸気と合図のゲートは波3）。
 */
import {
  SAMPLE_RATE_HZ,
  absent,
  atFromBrowser,
  decodeAudioFrame,
  draftFromAudioReport,
  draftFromGazeReport,
  encodePcmFrame,
  present,
} from '@llm-vap/contracts';
import type {
  BrowserToNode,
  ClientHello,
  Condition,
  EventEmitter,
  LlmProvider,
  Maybe,
  NodeToBrowser,
  Policy,
  SttResult,
  SttSession,
  TimeSource,
  TranscriptSnapshot,
  TtsConnection,
  TurnDecision,
  TurnInputs,
  Unsubscribe,
  Vap2chState,
} from '@llm-vap/contracts';
import { ResponsePrefetch } from '../cognition/prefetch';
import { createTurnManager, userTextFor } from '../control';
import type { TurnState } from '../control';
import type { SessionLog, SessionManifestDetails } from '../logging';
import { BrowserClockRecorder, WorkerClockRecorder } from '../logging';
import { attachMaaiEventBridge } from '../maai';
import type { MaaiWorkerClient } from '../maai';
import { SpeechGeneratorImpl, createResponsePromptBuilder } from '../speech';
import type { SessionProviders } from '../app/providers';
import { isReadyBufferMs } from '../app/maai_setup';
import { FALLBACK_ENERGY_FLOOR_DBFS, PlaybackTracker, rmsDbfs } from './audio_state';
import { SessionHistory, UserUtterances } from './history';
import { InitiativeWiring } from './initiative_wiring';

export interface BrowserLink {
  sendJson(message: NodeToBrowser): void;
  sendBinary(data: Uint8Array): void;
}

export interface SessionOptions {
  session_id: string;
  condition: Condition;
  policy: Policy;
  time: TimeSource;
  /** 研究者画面への配信を含む emitter（ログは invalid: 'report'）。 */
  emitter: EventEmitter;
  log: SessionLog;
  providers: SessionProviders;
  maai: MaaiWorkerClient | null;
  maaiUnavailableReason?: string;
  /** 画面の状態が変わったとき。 */
  onStatusChange?: (status: SessionStatusView) => void;
  /** false なら tick のタイマーを動かさない（試験が tick() を直接呼ぶ）。既定は true。 */
  tickTimer?: boolean;
}

export interface SessionStatusView {
  degraded: boolean;
  reasons: string[];
}

export interface SessionCounters {
  uplink_frames: number;
  bad_uplink_frames: number;
  start_refused: Record<string, number>;
  audio_reports_before_clock: number;
  /** 時計差の推定の前に届いて記録しなかった gaze.report。 */
  gaze_reports_before_clock: number;
  signal_reports_ignored: number;
  decisions: Record<string, number>;
  tick_errors: number;
  /** ブラウザの代わりに playback.ended を作った回数（猶予切れ、終了、報告の期限切れ）。 */
  playback_ended_synthesized: number;
  /** start_speech の後に開始を取り消した回数（拒否されたので segment の前進を戻した）。 */
  start_rolled_back: number;
}

const TTS_SAMPLE_RATE_HZ = 24000;

function stripType<T extends { type: unknown }>(message: T): Omit<T, 'type'> {
  const { type: _type, ...rest } = message;
  return rest;
}

export class Session {
  readonly session_id: string;
  readonly history = new SessionHistory();
  readonly counters: SessionCounters = {
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
  };
  /** E2E と研究者画面向け。TurnManager の最新の状態。 */
  turnState: TurnState;

  private link: BrowserLink | null = null;
  private readonly time: TimeSource;
  private readonly emitter: EventEmitter;
  private readonly turnManager: ReturnType<typeof createTurnManager>;
  private readonly utterances = new UserUtterances();
  private readonly tracker = new PlaybackTracker();
  private readonly browserClock: BrowserClockRecorder;
  private readonly workerClock: WorkerClockRecorder;
  private stt: SttSession | null = null;
  private tts: TtsConnection | null = null;
  private speech: SpeechGeneratorImpl | null = null;
  private prefetch: ResponsePrefetch | null = null;
  /** 発話希望の判定と候補。無効（条件、方策）か作れなければ null。 */
  private initiative: InitiativeWiring | null = null;
  private initiativeReason: string | null = null;
  private readonly unsubscribe: Unsubscribe[] = [];
  private tickTimer: NodeJS.Timeout | null = null;
  private closed = false;

  private receivedAudioFrame = 0;
  private lastMicDbfs: number | null = null;
  private vap: Vap2chState | null = null;
  private vapReceivedAt: number | null = null;
  private workerReadyAt: number | null = null;
  private transcript: TranscriptSnapshot | null = null;
  private completion: { p: Maybe<number>; revision: number | null } = {
    p: absent('no_estimate_yet'),
    revision: null,
  };
  private completionRequested = -1;
  private degradedReason: string | null = 'starting';
  private readonly fixedReasons: string[] = [];
  private lastStatusKey = '';
  /** 再生を始めた segment（履歴の並び）。 */
  private readonly startedInSegment = new Map<number, number>();

  constructor(private readonly options: SessionOptions) {
    this.session_id = options.session_id;
    this.time = options.time;
    this.emitter = options.emitter;
    // fallback_energy は mic の RMS（dBFS）。尺度を決めているのは session なので閾値もここから渡す（settings.ts）。
    this.turnManager = createTurnManager(options.policy, {
      fallback_energy_silence_threshold:
        options.policy.policy_id === 'ja' ? (options.policy.turn.fallback_energy_silence_dbfs ?? null) : null,
    });
    this.turnState = this.turnManager.initialState();
    this.browserClock = new BrowserClockRecorder(this.emitter);
    this.workerClock = new WorkerClockRecorder(this.emitter);
  }

  /** 最初の接続で呼ぶ。プロバイダを開き、MaAI を新しいセッションへ設定し直し、server.hello を返す。 */
  async start(link: BrowserLink, hello: ClientHello): Promise<void> {
    this.link = link;
    this.recordClient(hello, 'new_session');
    const { providers } = this.options;
    for (const [kind, cls] of Object.entries(providers.classes)) {
      if (cls === 'test_double') this.fixedReasons.push(`test_double:${kind}:${providers.names[kind as 'stt']}`);
    }
    // STT の結果より先に作る（最初の発話から判定する）。D の音声は後から作られるので関数で渡す。
    this.buildInitiative();

    if (providers.stt.ok) {
      try {
        this.stt = await providers.stt.value.open({
          language_code: 'ja-JP',
          sample_rate_hz: SAMPLE_RATE_HZ,
          interim_results: true,
          start_audio_frame: 0,
        });
        this.unsubscribe.push(this.stt.onResult((result) => this.onSttResult(result)));
      } catch (error) {
        this.fixedReasons.push(`stt_unavailable:${String(error instanceof Error ? error.message : error).slice(0, 160)}`);
      }
    } else {
      this.fixedReasons.push(`stt_unavailable:${providers.stt.reason}`);
    }

    if (providers.tts.ok && providers.llm.ok) {
      try {
        this.tts = await providers.tts.value.open({ preferred_sample_rate_hz: TTS_SAMPLE_RATE_HZ });
        this.buildSpeech(this.tts, providers.llm.value);
      } catch (error) {
        this.fixedReasons.push(`tts_unavailable:${String(error instanceof Error ? error.message : error).slice(0, 160)}`);
      }
    } else {
      if (!providers.tts.ok) this.fixedReasons.push(`tts_unavailable:${providers.tts.reason}`);
      if (!providers.llm.ok) this.fixedReasons.push(`llm_unavailable:${providers.llm.reason}`);
    }

    if (providers.completion_error !== null) this.fixedReasons.push(`completion_unavailable:${providers.completion_error}`);

    this.attachMaai();
    this.recordProviders();
    if (this.options.tickTimer !== false) {
      this.tickTimer = setInterval(() => this.tick(), this.turnManager.settings.tick_ms);
    }
    this.send({
      type: 'server.hello',
      protocol_version: 1,
      session_id: this.session_id,
      condition: this.options.condition,
      is_fake: this.isFake(),
    });
    this.pushStatus(true);
  }

  /** 台本のプロバイダを使っている（受け入れの証拠に数えない）。開けなかったプロバイダは別の理由で出す。 */
  private isFake(): boolean {
    return Object.values(this.options.providers.classes).some((c) => c === 'test_double');
  }

  /**
   * 各プロバイダの区分と可否を provider.status と manifest に残す（log_check が受け入れの証拠かを判定する）。
   * 台本のプロバイダは自分では provider.status を出さないので、ここで必ず出す。
   */
  private recordProviders(): void {
    const { providers } = this.options;
    const manifest: SessionManifestDetails['providers'] = {};
    for (const kind of ['stt', 'tts', 'llm'] as const) {
      const cls = providers.classes[kind];
      const reason = this.fixedReasons.find((r) => r.startsWith(`${kind}_unavailable:`)) ?? null;
      const provider = providers.names[kind] === 'unavailable' ? `${kind}_unavailable` : providers.names[kind];
      manifest[kind] = { provider, provider_class: reason === null ? cls : 'unavailable', reason };
      this.emitter.emit({
        event: 'provider.status',
        provider,
        provider_class: cls === 'unavailable' ? providers.requested[kind] : cls,
        status: reason === null ? 'ok' : 'down',
        reason: reason === null ? absent('opened_at_session_start') : present(reason.slice(0, 300)),
        retry_attempt: 0,
        next_retry_ms: absent(reason === null ? 'not_retrying' : 'not_retried_in_this_session'),
      });
    }
    const completion = providers.completion_name;
    manifest.completion = {
      provider: completion,
      provider_class: providers.completion_error === null ? 'production' : 'unavailable',
      reason: providers.completion_error,
    };
    this.emitter.emit({
      event: 'provider.status',
      provider: `completion:${completion}`,
      provider_class: providers.classes.llm === 'test_double' && completion === 'llm_completion_v1' ? 'test_double' : 'production',
      status: providers.completion_error === null ? 'ok' : 'down',
      reason: providers.completion_error === null ? absent('created_at_session_start') : present(providers.completion_error.slice(0, 300)),
      retry_attempt: 0,
      next_retry_ms: absent('not_retrying'),
    });
    const initiative = providers.initiative;
    if (initiative?.enabled) {
      const llm = initiative.llm;
      manifest.initiative =
        this.initiative !== null && llm !== null
          ? { provider: llm.provider, provider_class: llm.provider_class, reason: null }
          : { provider: 'initiative_unavailable', provider_class: 'unavailable', reason: this.initiativeReason };
    }
    this.emitter.emit({
      event: 'provider.status',
      provider: 'initiative_monitor',
      provider_class: initiative?.llm?.provider_class ?? 'production',
      status: this.initiative !== null ? 'ok' : initiative?.enabled ? 'down' : 'degraded',
      reason: this.initiative !== null ? absent('created_at_session_start') : present((this.initiativeReason ?? 'off').slice(0, 300)),
      retry_attempt: 0,
      next_retry_ms: absent('not_retrying'),
    });
    const maai = this.options.maai;
    manifest.vap = {
      provider: 'maai_worker',
      provider_class: maai === null ? 'unavailable' : maai.providerClass,
      reason: maai === null ? (this.options.maaiUnavailableReason ?? 'maai_disabled') : null,
    };
    void this.options.log.describe({
      condition: this.options.condition,
      policy_id: this.options.policy.policy_id,
      providers: manifest,
      initiative: {
        running: this.initiative !== null,
        reason: this.initiativeReason,
        prompt_version: initiative?.prompt_version ?? null,
        model: this.initiative !== null ? (initiative?.llm?.model_version ?? null) : null,
        persona_id: initiative?.persona?.persona_id ?? null,
        persona_version: initiative?.persona?.version ?? null,
        // 波2: 候補は作るだけで、発声（D）にも吸気（H2）にも渡さない。
        candidates_used_for: 'log_and_research_view_only',
      },
    });
  }

  /** 切断後に同じセッションへ戻ってきた。 */
  reattach(link: BrowserLink, hello: ClientHello): void {
    this.link = link;
    this.recordClient(hello, 'reattached');
    // 切断の間はブラウザが報告できなかった。ここから数え直す（届いた PCM を流し切った後に ended が来る）。
    this.speech?.rearmReportDeadlines();
    this.emitter.emit({
      event: 'provider.status',
      provider: 'browser_link',
      provider_class: 'production',
      status: 'ok',
      reason: absent('reattached'),
      retry_attempt: 0,
      next_retry_ms: absent('not_retrying'),
    });
    this.send({
      type: 'server.hello',
      protocol_version: 1,
      session_id: this.session_id,
      condition: this.options.condition,
      is_fake: this.isFake(),
    });
    this.pushStatus(true);
  }

  get attached(): boolean {
    return this.link !== null;
  }

  /**
   * ブラウザとの接続が切れた。再生中の音声の終わりはここでは代行しない。ブラウザは受け取った PCM を
   * 流し続け、再接続後に本物の playback.ended を送る（その報告を正とする）。代行するのは猶予が切れて
   * セッションを閉じるとき（close）と、接続中に報告の期限を過ぎたときだけ。
   */
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

  private endPlaybackOnBehalf(reason: string): void {
    for (const id of this.speech?.endActiveOnBehalf(reason, this.receivedAudioFrame) ?? []) {
      this.counters.playback_ended_synthesized += 1;
      this.tracker.ended(id);
    }
  }

  // ---- 組み立て ----------------------------------------------------------------

  private buildSpeech(tts: TtsConnection, llm: LlmProvider): void {
    const policy = this.options.policy;
    const speech = new SpeechGeneratorImpl({
      tts,
      llm,
      prompt: createResponsePromptBuilder({ history: this.history }),
      sink: {
        begin: (m) => this.send({ type: 'playback.begin', ...m }),
        pcm: (frame) => this.link?.sendBinary(encodePcmFrame(frame)),
        alignment: (m) => this.send({ type: 'playback.alignment', ...m }),
        stop: (m) => this.send({ type: 'playback.stop', ...m }),
      },
      time: this.time,
      emitter: this.emitter,
      is_ready_buffer_ms: isReadyBufferMs(policy),
    });
    this.speech = speech;
    this.prefetch = new ResponsePrefetch({ speech, time: this.time, emitter: this.emitter });
    this.unsubscribe.push(
      speech.onFinished((finished) => {
        this.initiative?.onSpeechFinished(finished, this.time.monotonicMs());
        const segment = this.startedInSegment.get(finished.audio_playback_id);
        this.startedInSegment.delete(finished.audio_playback_id);
        this.history.commitAssistantSpoken(
          {
            text: finished.spoken_text,
            audio_playback_id: finished.audio_playback_id,
            spoken_text_precision: finished.spoken_text_precision,
            interrupted: finished.interrupted,
            origin: finished.origin,
          },
          segment,
        );
      }),
    );
  }

  private buildInitiative(): void {
    const setup = this.options.providers.initiative;
    const policy = this.options.policy;
    if (!setup) {
      this.initiativeReason = 'initiative_not_configured';
      return;
    }
    if (!setup.enabled || setup.llm === null || setup.persona === null || policy.policy_id !== 'ja') {
      this.initiativeReason = setup.reason ?? 'initiative_unavailable';
      return;
    }
    try {
      this.initiative = new InitiativeWiring({
        llm: setup.llm,
        persona: setup.persona,
        policy,
        emitter: this.emitter,
        time: this.time,
        speech: () => this.speech,
        prompt_version: setup.prompt_version,
      });
    } catch (error) {
      // policy の未校正（null）など。音声の経路は止めない。
      this.initiativeReason = `initiative_unavailable:${String(error instanceof Error ? error.message : error).slice(0, 200)}`;
    }
  }

  /** 候補の状態の正本（E2a）。読み出し専用に使う（試験と研究者向け）。判定が動いていなければ null。 */
  get candidates(): InitiativeWiring['ledger'] | null {
    return this.initiative?.ledger ?? null;
  }

  /** 発話希望の判定が動いているか（研究者画面と試験向け）。止めた・作れなかったときは理由。 */
  initiativeStatus(): { running: boolean; reason: string | null } {
    return { running: this.initiative !== null, reason: this.initiativeReason };
  }

  private attachMaai(): void {
    const maai = this.options.maai;
    if (maai === null) {
      this.fixedReasons.push(`vap_unavailable:${this.options.maaiUnavailableReason ?? 'maai_disabled'}`);
      return;
    }
    this.unsubscribe.push(
      attachMaaiEventBridge(maai, { emitter: this.emitter, clock: this.workerClock, systemChannelSource: 'written' }),
    );
    this.unsubscribe.push(
      maai.subscribe({
        onReady: (_ready, at) => {
          this.workerReadyAt = at;
        },
        onVapState: (message, at) => {
          // 設定し直す前の結果（前のセッションの番号）は使わない。
          if (this.workerReadyAt === null || message.channel_layout !== '2ch') return;
          this.vap = stripType(message) as Vap2chState;
          this.vapReceivedAt = at;
        },
        onAvailability: (availability) => {
          if (!availability.vap_available) {
            this.workerReadyAt = null;
            this.vap = null;
            this.vapReceivedAt = null;
          }
        },
      }),
    );
    // 前のセッションの番号と結果を混ぜないよう、ワーカーにも新しい CONFIGURE を送る。
    // ブラウザの audio_frame は同じページの中では 0 に戻らない（猶予切れの後に同じタブから来た場合など）。
    void maai.reconfigure(this.session_id);
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

  // ---- 上り --------------------------------------------------------------------

  handleBinary(data: Uint8Array): void {
    if (this.closed) return;
    let frame: ReturnType<typeof decodeAudioFrame>;
    try {
      frame = decodeAudioFrame(data);
    } catch {
      this.counters.bad_uplink_frames += 1;
      return;
    }
    this.counters.uplink_frames += 1;
    const end = frame.audio_frame + frame.sample_count;
    this.receivedAudioFrame = Math.max(this.receivedAudioFrame, end);
    this.lastMicDbfs = Math.max(FALLBACK_ENERGY_FLOOR_DBFS, rmsDbfs(frame.mic));
    this.tracker.observeFrame(end, rmsDbfs(frame.sys));
    this.stt?.pushAudio(frame.audio_frame, frame.mic);
    if (this.workerReadyAt !== null) this.options.maai?.sendEncodedAudio(data, frame.sample_count);
  }

  handleJson(message: BrowserToNode): void {
    if (this.closed) return;
    switch (message.type) {
      case 'client.hello':
        return; // 接続の層で扱う
      case 'clock.ping':
        this.send({
          type: 'clock.pong',
          seq: message.seq,
          client_t_ms: message.client_t_ms,
          server_t_ms: this.time.monotonicMs(),
        });
        return;
      case 'clock.report':
        this.browserClock.record({
          offset_ms: message.offset_ms,
          rtt_ms: message.rtt_ms,
          uncertainty_ms: message.uncertainty_ms,
        });
        return;
      case 'playback.started': {
        const t = this.toServer(message.client_t_ms);
        this.tracker.started(message.audio_playback_id, message.generation, message.audio_frame, t);
        this.speech?.handlePlaybackStarted(message, t);
        return;
      }
      case 'playback.position': {
        const t = this.toServer(message.client_t_ms);
        this.tracker.position(message.audio_playback_id, message.samples_written, t);
        this.speech?.handlePlaybackPosition(message, t);
        return;
      }
      case 'playback.ended': {
        const t = this.toServer(message.client_t_ms);
        this.speech?.handlePlaybackEnded(message, t);
        this.tracker.ended(message.audio_playback_id);
        return;
      }
      case 'audio.report': {
        const mapping = this.browserClock.mapping();
        if (mapping === null) {
          this.counters.audio_reports_before_clock += 1;
          return;
        }
        this.emitter.emit(draftFromAudioReport(message), atFromBrowser(message.client_t_ms, mapping));
        return;
      }
      case 'gaze.report': {
        // 時計差の推定がないと描画の時刻（rendered_at）を orchestrator の基準へ写せない。受信時刻で代えない。
        const mapping = this.browserClock.mapping();
        if (mapping === null) {
          this.counters.gaze_reports_before_clock += 1;
          return;
        }
        const draft = draftFromGazeReport(message, mapping);
        const at = message.client_t_ms.value !== null ? atFromBrowser(message.client_t_ms.value, mapping) : undefined;
        this.emitter.emit(draft, at);
        return;
      }
      case 'signal.report':
        // 吸気は波3。波1では合図を出さないので、届いても記録しない（数だけ残す）。
        this.counters.signal_reports_ignored += 1;
        return;
    }
  }

  private toServer(clientMs: number): number {
    const mapping = this.browserClock.mapping();
    return mapping === null ? this.time.monotonicMs() : Math.max(0, mapping.toServerMs(clientMs));
  }

  // ---- STT ---------------------------------------------------------------------

  private onSttResult(result: SttResult): void {
    const text = this.utterances.update(result.segment_id, result.asr_segment_id, result.text);
    this.history.upsertUserSegment({
      text,
      segment_id: result.segment_id,
      transcript_revision: result.transcript_revision,
      is_final: result.kind === 'final',
      audio_frame_end: result.audio_frame_end,
    });
    const snapshot: TranscriptSnapshot = {
      segment_id: result.segment_id,
      asr_segment_id: result.asr_segment_id,
      asr_segment_frame_start: result.asr_segment_frame_start,
      transcript_revision: result.transcript_revision,
      text: result.text,
      stable_text: result.stable_text,
      unstable_text: result.unstable_text,
      is_final: result.kind === 'final',
      stability: result.stability,
      stability_source: result.stability_source,
      audio_frame_end: result.audio_frame_end,
      timing_precision: result.timing_precision,
      words: result.words,
      received_at: result.received_at,
    };
    this.transcript = snapshot;
    this.requestCompletion(snapshot);
    // 判定は非同期（LLM を待たない）。増分で起動し、ターン完了の推定とは条件を共有しない（計画 §4.5）。
    this.initiative?.onSttResult(result);
  }

  /** 推定は非同期。新しい revision の結果だけを残す（E1 が segment の境界で古い値を読まない）。 */
  private requestCompletion(snapshot: TranscriptSnapshot): void {
    if (snapshot.segment_id < this.turnState.segment_id) return;
    const revision = snapshot.transcript_revision;
    this.completionRequested = revision;
    const partial = userTextFor(this.turnState, snapshot);
    const history = this.history.snapshot().filter((e) => !(e.role === 'user' && e.segment_id === snapshot.segment_id));
    this.options.providers.completion
      .estimate(history, partial, { transcript_revision: revision })
      .then((estimate) => {
        if (this.closed || revision < (this.completion.revision ?? -1)) return;
        this.completion = { p: estimate.p, revision };
      })
      .catch(() => undefined);
  }

  // ---- tick --------------------------------------------------------------------

  private inputs(): TurnInputs {
    const t = this.transcript;
    return {
      vap: this.vap === null ? absent('no_vap_state_since_ready') : present(this.vap),
      vap_received_at: this.vapReceivedAt === null ? absent('no_vap_state_since_ready') : present(this.vapReceivedAt),
      start_blocked_reason: this.startBlockedReason(),
      received_audio_frame: this.receivedAudioFrame,
      vap_worker_started_at:
        this.workerReadyAt === null ? absent(this.options.maai === null ? 'maai_disabled' : 'worker_not_ready') : present(this.workerReadyAt),
      // 単位は mic の RMS の dBFS（Node が計算）。VAP ではない。
      fallback_energy: this.lastMicDbfs === null ? absent('no_uplink_audio_yet') : present(this.lastMicDbfs),
      transcript: t === null ? absent('no_transcript_yet') : present(t),
      completion_p: this.completion.p,
      completion_revision:
        this.completion.revision === null ? absent('no_estimate_yet') : present(this.completion.revision),
      similarity_to_prepared:
        t === null || this.prefetch === null
          ? absent('no_transcript_yet')
          : this.prefetch.similarityToPrepared(userTextFor(this.turnState, t), this.turnState.segment_id),
      prefetch: this.prefetch?.input() ?? { state: 'idle' },
      playback: this.tracker.input(),
      woz: [],
    };
  }

  /** 再生を今は始められない理由。TurnManager は許可が出ても segment を進めない。 */
  private startBlockedReason(): string | null {
    if (this.speech === null) return 'speech_unavailable';
    // 切断中は再生できない（ブラウザが音を出せず、発話済みを測れない）。
    if (this.link === null) return 'browser_detached';
    const active = this.speech.activePlayback();
    if (active !== null) return `another_playback_active:${active}`;
    return null;
  }

  /** 固定周期の1回。試験（tickTimer: false）は直接呼ぶ。 */
  tick(): void {
    if (this.closed) return;
    try {
      const now = this.time.monotonicMs();
      if (this.link !== null && this.speech !== null) {
        // 接続中に報告の期限を過ぎた音声（begin が届かなかった、ended が失われた）の終わりを代行する。
        for (const id of this.speech.expireOverdueReports(this.receivedAudioFrame)) {
          this.counters.playback_ended_synthesized += 1;
          this.tracker.ended(id);
        }
      }
      const previous = this.turnState;
      const inputs = this.inputs();
      let { state, decisions } = this.turnManager.step(previous, inputs, now);
      this.turnState = state;
      // 再生の開始は、他の決定を実行する前に試す。入力で止められなかった拒否なら、その理由を start_blocked_reason に
      // 入れて同じ tick を前の状態から計算し直す（TurnManager は純粋関数）。segment も STT も進めず（応答を失わない）、
      // 同じ tick の他の決定（準備、turn.allowed、視線、鮮度）は開始しなかった前提の1組だけを実行する。
      const start = decisions.find((d) => d.kind === 'start_speech');
      if (start !== undefined) {
        const refused = this.startSpeech(start.audio_playback_id);
        if (refused !== null) {
          this.counters.start_rolled_back += 1;
          ({ state, decisions } = this.turnManager.step(previous, { ...inputs, start_blocked_reason: `start_refused:${refused}` }, now));
          this.turnState = state;
        }
      }
      for (const decision of decisions) this.dispatch(decision, now);
      // 期限と人の発話の有無だけを同期で進める。LLM の結果は待たない。
      this.initiative?.tick(now, this.turnState.user_speaking);
    } catch (error) {
      this.counters.tick_errors += 1;
      if (this.counters.tick_errors <= 5) console.error(`[session ${this.session_id}] tick failed:`, error);
    }
  }

  private dispatch(decision: TurnDecision, now: number): void {
    this.counters.decisions[decision.kind] = (this.counters.decisions[decision.kind] ?? 0) + 1;
    switch (decision.kind) {
      case 'prepare':
      case 'cancel_prepare':
        this.prefetch?.execute(decision);
        return;
      case 'start_speech':
        // 波2では TurnManager が始めるのは通常の応答だけ。残っている候補は撤回する（計画 §4.6）。
        this.initiative?.onNormalResponseStarted(now);
        return; // 再生の開始は tick の中で startSpeech が扱う
      case 'interrupt_speech':
        this.speech?.stop(decision.audio_playback_id, decision.reason, {
          stop_point: decision.stop_point,
          max_wait_ms: decision.max_wait_ms,
          decision_source: decision.decision_source,
        });
        return;
      case 'advance_segment':
        this.stt?.advanceSegment(decision.new_segment_id, decision.at_audio_frame);
        this.initiative?.onSegmentChanged(decision.new_segment_id, now);
        return;
      case 'turn_allowed':
        this.emitter.emit({ event: 'turn.allowed', ...decision.payload });
        return;
      case 'gaze':
        this.emitter.emit({ event: 'gaze.decision', ...decision.payload });
        this.send({ type: 'gaze.command', target: decision.payload.target });
        return;
      case 'set_degraded':
        this.degradedReason = decision.degraded ? decision.reason : null;
        this.recordVapFreshness(decision.degraded, decision.reason);
        this.pushStatus(false);
        return;
    }
  }

  /** start_speech の実行。拒否されたら理由（数える）、始めたら null。 */
  private startSpeech(audio_playback_id: number): string | null {
    if (this.speech === null) return 'speech_unavailable';
    const result =
      this.link === null ? { ok: false as const, reason: 'browser_detached' } : this.speech.startChecked(audio_playback_id);
    if (!result.ok) {
      this.counters.start_refused[result.reason] = (this.counters.start_refused[result.reason] ?? 0) + 1;
      return result.reason;
    }
    // TurnManager は start と同じ tick で segment を進めている。その値が AI の発話の segment。
    this.startedInSegment.set(audio_playback_id, this.turnState.segment_id);
    return null;
  }

  /** VAP の鮮度の切替をログへ（画面だけでなく記録に残す）。VAP ではなく TurnManager の判断。 */
  private recordVapFreshness(degraded: boolean, reason: string): void {
    const freshness = this.turnState.vap_freshness;
    this.emitter.emit({
      event: 'provider.status',
      provider: 'vap_freshness',
      provider_class: this.options.maai?.providerClass ?? 'production',
      status: !degraded ? 'ok' : freshness === 'down' ? 'down' : 'degraded',
      reason: degraded ? present(reason.slice(0, 300)) : absent('fresh'),
      retry_attempt: 0,
      next_retry_ms: absent('not_retrying'),
    });
  }

  // ---- 状態 --------------------------------------------------------------------

  status(): SessionStatusView {
    const reasons = [...this.fixedReasons];
    if (this.degradedReason !== null) reasons.push(`vap:${this.degradedReason}`);
    return { degraded: reasons.length > 0, reasons };
  }

  private pushStatus(force: boolean): void {
    const status = this.status();
    // 理由の数値（助走の残り ms など）で毎回送らないよう、種類だけで比べる。
    const key = `${status.degraded}|${status.reasons.map((r) => r.split(':').slice(0, 2).join(':')).join(',')}`;
    if (!force && key === this.lastStatusKey) return;
    this.lastStatusKey = key;
    this.send({ type: 'session.status', degraded: status.degraded, reasons: status.reasons.map((r) => r.slice(0, 200)) });
    this.options.onStatusChange?.(status);
  }

  private send(message: NodeToBrowser): void {
    this.link?.sendJson(message);
  }

  // ---- 終了 --------------------------------------------------------------------

  async close(reason: string): Promise<void> {
    if (this.closed) return;
    this.endPlaybackOnBehalf(`session_closed:${reason}`);
    this.closed = true;
    if (this.tickTimer !== null) clearInterval(this.tickTimer);
    this.initiative?.close();
    this.link = null;
    for (const unsubscribe of this.unsubscribe.splice(0)) unsubscribe();
    this.prefetch?.dispose();
    this.speech?.dispose();
    await Promise.allSettled([this.stt?.close(), this.tts?.close()]);
    await this.options.log.close();
  }
}
