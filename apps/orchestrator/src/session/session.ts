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
 * want_to_speak（準備済みの応答）、permitted_to_speak（TurnManager の許可）、speaking（再生の報告）は
 * 別々に持つ。ここでは混ぜない。波1の範囲なので InitiativeMonitor と吸気は配線しない。
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
  PlaybackEnded,
  Policy,
  SttResult,
  SttSession,
  TimeMapping,
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
import type { SessionLog } from '../logging';
import { BrowserClockRecorder, WorkerClockRecorder } from '../logging';
import { attachMaaiEventBridge } from '../maai';
import type { MaaiWorkerClient } from '../maai';
import { SpeechGeneratorImpl, createResponsePromptBuilder } from '../speech';
import type { SessionProviders } from '../app/providers';
import { FALLBACK_ENERGY_FLOOR_DBFS, PlaybackTracker, rmsDbfs } from './audio_state';
import { SessionHistory, UserUtterances } from './history';

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
  signal_reports_ignored: number;
  decisions: Record<string, number>;
  tick_errors: number;
  playback_ended_synthesized: number;
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
    signal_reports_ignored: 0,
    decisions: {},
    tick_errors: 0,
    playback_ended_synthesized: 0,
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

  constructor(private readonly options: SessionOptions) {
    this.session_id = options.session_id;
    this.time = options.time;
    this.emitter = options.emitter;
    this.turnManager = createTurnManager(options.policy);
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

    this.attachMaai();
    this.tickTimer = setInterval(() => this.tick(), this.turnManager.settings.tick_ms);
    this.send({
      type: 'server.hello',
      protocol_version: 1,
      session_id: this.session_id,
      condition: this.options.condition,
      is_fake: Object.values(providers.classes).some((c) => c !== 'production'),
    });
    this.pushStatus(true);
  }

  /** 切断後に同じセッションへ戻ってきた。 */
  reattach(link: BrowserLink, hello: ClientHello): void {
    this.link = link;
    this.recordClient(hello, 'reattached');
    this.send({
      type: 'server.hello',
      protocol_version: 1,
      session_id: this.session_id,
      condition: this.options.condition,
      is_fake: Object.values(this.options.providers.classes).some((c) => c !== 'production'),
    });
    this.pushStatus(true);
  }

  get attached(): boolean {
    return this.link !== null;
  }

  /**
   * ブラウザとの接続が切れた。再生中の音声は届いた位置までで終わったものとして代行する
   * （ブラウザが playback.ended を返せないため。発話済みの部分だけが履歴に入る）。
   */
  detach(reason: string): void {
    if (this.link === null) return;
    this.link = null;
    this.endPlaybackOnBehalf(`browser_disconnected:${reason}`);
  }

  private endPlaybackOnBehalf(reason: string): void {
    const playing = this.tracker.current();
    if (playing !== null && this.speech) {
      const message: PlaybackEnded = {
        type: 'playback.ended',
        audio_playback_id: playing.audio_playback_id,
        generation: playing.generation,
        reason: 'error',
        samples_written: playing.samples_written,
        samples_discarded: 0,
        audio_frame: this.receivedAudioFrame,
        client_t_ms: 0,
        output_latency_ms: absent(reason),
      };
      this.counters.playback_ended_synthesized += 1;
      this.speech.handlePlaybackEnded(message, this.time.monotonicMs());
      this.tracker.ended(playing.audio_playback_id);
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
      is_ready_buffer_ms: policy.policy_id === 'ja' ? policy.speech.is_ready_buffer_ms : 200,
    });
    this.speech = speech;
    this.prefetch = new ResponsePrefetch({ speech, time: this.time, emitter: this.emitter });
    this.unsubscribe.push(
      speech.onFinished((finished) => {
        this.history.commitAssistantSpoken({
          text: finished.spoken_text,
          audio_playback_id: finished.audio_playback_id,
          spoken_text_precision: finished.spoken_text_precision,
          interrupted: finished.interrupted,
          origin: finished.origin,
        });
      }),
    );
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
    // ブラウザは audio_frame を 0 から振り直すので、ワーカーにも新しい CONFIGURE を送る。
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
        const mapping = this.browserClock.mapping();
        const fallback: TimeMapping = {
          toServerMs: () => this.time.monotonicMs(),
          basis: { source: 'orchestrator', uncertainty_ms: present(0) },
        };
        const use = mapping ?? fallback;
        const draft = draftFromGazeReport(message, use);
        const at =
          mapping !== null && message.client_t_ms.value !== null
            ? atFromBrowser(message.client_t_ms.value, mapping)
            : undefined;
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

  private tick(): void {
    if (this.closed) return;
    try {
      const now = this.time.monotonicMs();
      const { state, decisions } = this.turnManager.step(this.turnState, this.inputs(), now);
      this.turnState = state;
      for (const decision of decisions) this.dispatch(decision);
    } catch (error) {
      this.counters.tick_errors += 1;
      if (this.counters.tick_errors <= 5) console.error(`[session ${this.session_id}] tick failed:`, error);
    }
  }

  private dispatch(decision: TurnDecision): void {
    this.counters.decisions[decision.kind] = (this.counters.decisions[decision.kind] ?? 0) + 1;
    switch (decision.kind) {
      case 'prepare':
      case 'cancel_prepare':
        this.prefetch?.execute(decision);
        return;
      case 'start_speech': {
        if (this.speech === null) return;
        // 切断中は再生できない（ブラウザが音を出せず、発話済みを測れない）。
        const result = this.link === null ? { ok: false as const, reason: 'browser_detached' } : this.speech.startChecked(decision.audio_playback_id);
        if (!result.ok) this.counters.start_refused[result.reason] = (this.counters.start_refused[result.reason] ?? 0) + 1;
        return;
      }
      case 'interrupt_speech':
        this.speech?.stop(decision.audio_playback_id, decision.reason, {
          stop_point: decision.stop_point,
          max_wait_ms: decision.max_wait_ms,
          decision_source: decision.decision_source,
        });
        return;
      case 'advance_segment':
        this.stt?.advanceSegment(decision.new_segment_id, decision.at_audio_frame);
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
        this.pushStatus(false);
        return;
    }
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
    this.link = null;
    for (const unsubscribe of this.unsubscribe.splice(0)) unsubscribe();
    this.prefetch?.dispose();
    this.speech?.dispose();
    await Promise.allSettled([this.stt?.close(), this.tts?.close()]);
    await this.options.log.close();
  }
}
