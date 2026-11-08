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
 *   波3の交渉（negotiation_wiring.ts、判断は control/negotiator.ts）。研究条件はセッションごと（options.condition）:
 *     tick の始め → 候補の先行音声の準備、合図のゲート（initiative_inhale のときだけ吸気の合図 breath.cue）、
 *       吸気の完了（orchestrator の時計）、DEFERRED、合図の解除。吸気中は通常の応答も含めて開始を保留する
 *       （TurnInputs.start_blocked_reason）。
 *     step の後 → 許可が出ていれば候補と通常の応答のどちらを話すか（E3）。候補なら、同じ tick を前の状態から
 *       候補の音声を準備済みの応答の位置に入れて計算し直し（TurnManager は純粋関数）、E2a の startSpeech で始める。
 *     reactive では候補を記録するだけで、合図も発話もしない（従来と同じ振る舞い）。
 *
 * want_to_speak（準備済みの応答と、E2a の候補）、permitted_to_speak（TurnManager の許可）、speaking（再生の報告）は
 * 別々に持つ。ここでは混ぜない。NEW は発話の許可ではない（許可は TurnManager のまま）。
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
import type { AvatarReport } from '@llm-vap/contracts';
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
import { BrowserClockRecorder, SessionAudioRecorder, WorkerClockRecorder, sessionAudioOffManifest } from '../logging';
import type { SessionAudioFileSystem, SessionAudioManifest, SessionAudioOptions } from '../logging';
import { attachMaaiEventBridge } from '../maai';
import type { MaaiWorkerClient } from '../maai';
import { SpeechGeneratorImpl, createResponsePromptBuilder } from '../speech';
import type { SessionProviders } from '../app/providers';
import { isReadyBufferMs } from '../app/maai_setup';
import { readSessionAudioConfig } from '../app/config';
import type { SessionAudioConfig } from '../app/config';
import { FALLBACK_ENERGY_FLOOR_DBFS, PlaybackTracker, rmsDbfs } from './audio_state';
import { SessionHistory, UserUtterances } from './history';
import { InitiativeWiring } from './initiative_wiring';
import { NegotiationWiring, negotiatorSettings } from './negotiation_wiring';
import { readVap, vapDirectionSettings } from '../control/vap_direction';
import { turnOutcomeSettings } from '../control/turn_outcome';
import { TurnOutcomeWiring } from './turn_outcome_wiring';
import type { CandidateChoice } from './negotiation_wiring';

export interface BrowserLink {
  /** false は送れなかった（ソケットが閉じているなど）。 */
  sendJson(message: NodeToBrowser): boolean | void;
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
  /** 会話の音声の保存の設定。省略時は環境変数（SAVE_SESSION_AUDIO。既定は保存しない）。試験が差し替える。 */
  sessionAudio?: SessionAudioConfig & { dir?: string; fs?: SessionAudioFileSystem; recorder?: Partial<SessionAudioOptions> };
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
/** vap.state の入力の窓（worker の1周期）。raw.worker_input がないときの代わり。 */
const ZERO_FILL_VAP_WINDOW_FRAMES = 1280;

function stripType<T extends { type: unknown }>(message: T): Omit<T, 'type'> {
  const { type: _type, ...rest } = message;
  return rest;
}

export class Session {
  readonly session_id: string;
  /** このセッションの研究条件（セッションごと。JSONL の condition と同じ値）。 */
  readonly condition: Condition;
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
  /** AI の発話の結果の記録（観測だけ）。方策に turn.outcome がなければ null。 */
  private readonly outcome: TurnOutcomeWiring | null;
  /** 発話希望の交渉（波3）。判定が動いていない、または方策に negotiation がなければ null。 */
  private negotiation: NegotiationWiring | null = null;
  /** 判定は動いているのに交渉だけ作れなかった理由（negotiatorSettings が null）。 */
  private negotiationReason: string | null = null;
  /** 会話の音声の保存。設定がなければ null（何も書かない）。 */
  private audioRecorder: SessionAudioRecorder | null = null;
  private manifestDetails: SessionManifestDetails | null = null;
  /** 画面が報告した使ったアバター（manifest の avatar）。未報告は null。 */
  private avatarManifest: Omit<AvatarReport, 'type'> | null = null;
  private manifestWrite: Promise<unknown> = Promise.resolve();
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
  /** ネットワーク欠損でゼロ埋めされた音声の範囲（FRAMES_DROPPED）。 */
  private readonly zeroFilledFrames: { from: number; to: number }[] = [];

  constructor(private readonly options: SessionOptions) {
    this.session_id = options.session_id;
    this.condition = options.condition;
    this.time = options.time;
    this.emitter = options.emitter;
    // fallback_energy は mic の RMS（dBFS）。尺度を決めているのは session なので閾値もここから渡す（settings.ts）。
    this.turnManager = createTurnManager(options.policy, {
      fallback_energy_silence_threshold:
        options.policy.policy_id === 'ja' ? (options.policy.turn.fallback_energy_silence_dbfs ?? null) : null,
    });
    this.turnState = this.turnManager.initialState();
    const outcomeSettings = turnOutcomeSettings(options.policy, this.turnManager.settings);
    this.outcome =
      outcomeSettings === null
        ? null
        : new TurnOutcomeWiring({
            settings: outcomeSettings,
            emitter: this.emitter,
            conversation_kind:
              options.providers.initiative?.staged?.conversation_kind != null
                ? present(options.providers.initiative.staged.conversation_kind)
                : absent('no_staged_conversation_kind'),
          });
    this.browserClock = new BrowserClockRecorder(this.emitter);
    this.workerClock = new WorkerClockRecorder(this.emitter);
  }

  /** 最初の接続で呼ぶ。プロバイダを開き、MaAI を新しいセッションへ設定し直し、server.hello を返す。 */
  async start(link: BrowserLink, hello: ClientHello): Promise<void> {
    this.link = link;
    this.recordClient(hello, 'new_session');
    this.startAudioRecording();
    const { providers } = this.options;
    for (const [kind, cls] of Object.entries(providers.classes)) {
      if (cls === 'test_double') this.fixedReasons.push(`test_double:${kind}:${providers.names[kind as 'stt']}`);
    }
    // STT の結果より先に作る（最初の発話から判定する）。D の音声は後から作られるので関数で渡す。
    this.buildInitiative();
    this.noteInactiveNegotiation();

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
    this.manifestDetails = {
      condition: this.options.condition,
      policy_id: this.options.policy.policy_id,
      providers: manifest,
      initiative: {
        running: this.initiative !== null,
        reason: this.initiativeReason,
        // 二段判定は desire_prompt_version と timing_prompt_version が正本（1段の版は使っていない）。
        prompt_version: this.initiative !== null && initiative?.staged ? null : (initiative?.prompt_version ?? null),
        model: this.initiative !== null ? (initiative?.llm?.model_version ?? null) : null,
        persona_id: initiative?.persona?.persona_id ?? null,
        persona_version: initiative?.persona?.version ?? null,
        timing_strategy: this.initiative !== null ? (initiative?.choice?.timing_strategy ?? 'v2') : null,
        conversation_kind: this.initiative !== null ? (initiative?.staged?.conversation_kind ?? null) : null,
        desire_prompt_version: this.initiative !== null ? (initiative?.staged?.desire_prompt_version ?? null) : null,
        timing_prompt_version: this.initiative !== null ? (initiative?.staged?.timing_prompt_version ?? null) : null,
        profile_version: this.initiative !== null ? (initiative?.staged?.profile.profile_version ?? null) : null,
        conversation_kind_source: initiative?.choice?.conversation_kind_source ?? null,
        timing_strategy_source: initiative?.choice?.timing_strategy_source ?? null,
        // 波3: reactive は記録だけ。initiative_no_cue は合図なしで発話、initiative_inhale は吸気の合図の後に発話。
        candidates_used_for:
          this.negotiation === null || this.options.condition === 'reactive'
            ? 'log_and_research_view_only'
            : `negotiation:${this.options.condition}`,
      },
    };
    void this.describeWithAudio();
  }

  /** manifest を書く。音声の保存の有無（session_audio）は必ず載せる。 */
  private describeWithAudio(audio?: SessionAudioManifest): Promise<boolean> {
    if (this.manifestDetails === null) return Promise.resolve(false);
    // 書き込みは同じ一時ファイルを使うので順番に。開始直後の avatar.report と重なると rename が失敗する。
    const write = this.manifestWrite.then(() => {
      if (this.manifestDetails === null) return false;
      const session_audio = audio ?? this.audioRecorder?.manifest() ?? sessionAudioOffManifest('SAVE_SESSION_AUDIO_not_set');
      const details: SessionManifestDetails & { session_audio: SessionAudioManifest } = { ...this.manifestDetails, session_audio, avatar: this.avatarManifest };
      return this.options.log.describe(details);
    });
    this.manifestWrite = write.catch(() => false);
    return write;
  }

  /** 設定があるときだけ音声の保存を始める。起動ログに保存の有無を必ず出す。 */
  private startAudioRecording(): void {
    const setting: NonNullable<SessionOptions['sessionAudio']> = this.options.sessionAudio ?? readSessionAudioConfig(process.env);
    if (!setting.enabled) {
      console.log(`[session ${this.session_id}] session audio: not saved (SAVE_SESSION_AUDIO is not set)`);
      return;
    }
    const dir = setting.dir ?? this.options.log.paths.dir;
    console.log(`[session ${this.session_id}] session audio: SAVING mic and AI audio to ${dir} (SAVE_SESSION_AUDIO=1; others' voices need a consent procedure first)`);
    this.audioRecorder = new SessionAudioRecorder({
      ...setting.recorder,
      dir,
      session_id: this.session_id,
      minFreeBytes: setting.min_free_bytes,
      ...(setting.fs ? { fs: setting.fs } : {}),
      onProblem: (problem) => {
        console.error(`[session ${this.session_id}] session audio: ${problem.kind}: ${problem.message}`);
        this.emitter.emit({
          event: 'provider.status',
          provider: 'session_audio',
          provider_class: 'production',
          status: 'degraded',
          reason: present(`${problem.kind}: ${problem.message}`.slice(0, 300)),
          retry_attempt: 0,
          next_retry_ms: absent('not_retrying'),
        });
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
      prompt: createResponsePromptBuilder({
        history: this.history,
        pending_material: (request) => this.negotiation?.responseMaterial(request, this.time.monotonicMs()) ?? null,
      }),
      sink: {
        begin: (m) => this.afterCandidateRelease(() => this.send({ type: 'playback.begin', ...m })),
        pcm: (frame) => this.afterCandidateRelease(() => this.link?.sendBinary(encodePcmFrame(frame))),
        alignment: (m) => this.afterCandidateRelease(() => this.send({ type: 'playback.alignment', ...m })),
        stop: (m) => this.afterCandidateRelease(() => this.send({ type: 'playback.stop', ...m })),
      },
      time: this.time,
      emitter: this.outcome?.tee(this.emitter) ?? this.emitter,
      is_ready_buffer_ms: isReadyBufferMs(policy),
    });
    this.speech = speech;
    this.prefetch = new ResponsePrefetch({ speech, time: this.time, emitter: this.emitter });
    this.unsubscribe.push(
      speech.onStateChange((change) => {
        this.negotiation?.onSpeechState(change);
        this.outcome?.onSpeechState(change);
        const origin = change.request.origin;
        if (change.state === 'failed' && origin.kind === 'candidate') {
          const wasSpeaking = this.initiative?.ledger.getRecord(origin.candidate_id)?.audio_playback_id === change.audio_playback_id;
          this.initiative?.onSpeechFailed(origin.candidate_id, change.audio_playback_id, this.time.monotonicMs());
          // 1 音も出ないまま再生に失敗した候補: 人の発話への応答を通常の経路へ戻す（再試行はしない）。
          if (wasSpeaking) this.queueCandidateRecovery(origin.candidate_id, 'speech_failed', change.audio_playback_id);
        }
      }),
    );
    this.unsubscribe.push(
      speech.onFinished((finished) => {
        this.initiative?.onSpeechFinished(finished, this.time.monotonicMs());
        if (finished.no_audio && finished.origin.kind === 'candidate') this.queueCandidateRecovery(finished.origin.candidate_id, 'speech_no_audio', finished.audio_playback_id);
        this.outcome?.onFinished(finished, this.time.monotonicMs());
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
        // 履歴へ確定した後。話した部分と保留中の候補を比べる（通常応答の開始や準備を待たせない）。
        this.negotiation?.onAiSpeechFinished(finished, this.time.monotonicMs());
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
        ...(setup.staged
          ? {
              staged: {
                timing_strategy: setup.staged.timing_strategy,
                profile: setup.staged.profile,
                recent_context: setup.staged.recent_context,
                desire_prompt_version: setup.staged.desire_prompt_version,
                timing_prompt_version: setup.staged.timing_prompt_version,
                history: this.history,
                ...(policy.initiative.staged?.revise_min_utterance_similarity !== undefined ? { revise_min_utterance_similarity: policy.initiative.staged.revise_min_utterance_similarity } : {}),
                ...(policy.initiative.staged?.already_said_min_similarity !== undefined ? { already_said_min_similarity: policy.initiative.staged.already_said_min_similarity } : {}),
              },
            }
          : {}),
      });
      const settings = negotiatorSettings(policy, this.options.condition, { timing_gate: setup.staged !== undefined });
      if (settings !== null) {
        this.negotiation = new NegotiationWiring({
          settings,
          initiative: this.initiative,
          emitter: this.emitter,
          speech: () => this.speech,
          send: (message) => this.send(message),
          now: () => this.time.monotonicMs(),
          ...(setup.staged
            ? {
                history: this.history,
                repeat_guard: {
                  ...(policy.initiative.staged?.already_said_min_similarity !== undefined ? { already_said_min_similarity: policy.initiative.staged.already_said_min_similarity } : {}),
                  ...(policy.initiative.staged?.reflection_min_containment !== undefined ? { reflection_min_containment: policy.initiative.staged.reflection_min_containment } : {}),
                },
              }
            : {}),
        });
      } else {
        this.negotiationReason = 'negotiation_settings_unavailable';
      }
    } catch (error) {
      // policy の未校正（null）など。音声の経路は止めない。
      this.initiativeReason = `initiative_unavailable:${String(error instanceof Error ? error.message : error).slice(0, 200)}`;
    }
  }

  /**
   * 提案条件（reactive 以外）なのに交渉が動かない（判定の設定なし、persona の読み込み失敗、INITIATIVE_CONDITIONS で無効、
   * 方策に negotiation がない、など）。そのまま続くと記録の condition と振る舞いが食い違うので、degraded にして理由を残す。
   */
  private noteInactiveNegotiation(): void {
    if (this.options.condition === 'reactive' || this.negotiation !== null) return;
    this.fixedReasons.push(`negotiation_unavailable:${this.negotiationReason ?? this.initiativeReason ?? 'unknown'}`);
  }

  /** 候補の状態の正本（E2a）。読み出し専用に使う（試験と研究者向け）。判定が動いていなければ null。 */
  get candidates(): InitiativeWiring['ledger'] | null {
    return this.initiative?.ledger ?? null;
  }

  /** 発話希望の交渉（波3）。試験と研究者向けの読み出し。 */
  get negotiationWiring(): NegotiationWiring | null {
    return this.negotiation;
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
        onError: (error, at) => {
          // 文脈を捨てて続行した（READY は来ない）。VAP の助走を数え直す。準備前のワーカーを「準備済み」にはしない。
          if (error.code === 'process_failed_reset' && this.workerReadyAt !== null) this.workerReadyAt = at;
        },
        onVapState: (message, at) => {
          // 設定し直す前の結果（前のセッションの番号）は使わない。
          if (this.workerReadyAt === null || message.channel_layout !== '2ch') return;
          // ゼロ埋めの音声で計算した値は VAP として使わない（docs/known_gaps.md §12）。入力を更新しなければ、続いたときだけ stale になる。
          if (this.overlapsZeroFill(message)) return;
          this.vap = stripType(message) as Vap2chState;
          this.vapReceivedAt = at;
          this.outcome?.onVap(at, message.audio_frame, message.vad);
        },
        onFramesDropped: (message) => {
          if (!message.zero_filled) return;
          this.zeroFilledFrames.push({ from: message.from_audio_frame, to: message.from_audio_frame + message.sample_count });
          if (this.zeroFilledFrames.length > 64) this.zeroFilledFrames.shift();
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

  /** vap.state の入力の窓（worker_input の from〜audio_frame）がゼロ埋めの範囲にかかっているか。 */
  private overlapsZeroFill(message: { audio_frame: number; raw: unknown }): boolean {
    if (this.zeroFilledFrames.length === 0) return false;
    const input = (message.raw as { worker_input?: { from_audio_frame?: unknown } } | null)?.worker_input;
    const from = typeof input?.from_audio_frame === 'number' ? input.from_audio_frame : message.audio_frame - ZERO_FILL_VAP_WINDOW_FRAMES;
    return this.zeroFilledFrames.some((z) => from < z.to && message.audio_frame > z.from);
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
    this.audioRecorder?.push(frame.audio_frame, frame.mic, frame.sys, this.time.monotonicMs());
    this.stt?.pushAudio(frame.audio_frame, frame.mic);
    if (this.workerReadyAt !== null) this.options.maai?.sendEncodedAudio(data, frame.sample_count);
  }

  handleJson(message: BrowserToNode): void {
    if (this.closed) return;
    switch (message.type) {
      case 'client.hello':
        return; // 接続の層で扱う
      case 'avatar.report': {
        const { type: _type, ...record } = message;
        this.avatarManifest = record;
        void this.describeWithAudio();
        return;
      }
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
        // 合図の描画の報告（記録だけ。吸気の完了は orchestrator の時計で判定する）。合図と対応しないものは数だけ残す。
        if (!this.negotiation?.onSignalReport(message, this.browserClock.mapping())) this.counters.signal_reports_ignored += 1;
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
    this.outcome?.onStt(result);
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

  private inputs(holdStart: string | null = null): TurnInputs {
    const t = this.transcript;
    return {
      vap: this.vap === null ? absent('no_vap_state_since_ready') : present(this.vap),
      vap_received_at: this.vapReceivedAt === null ? absent('no_vap_state_since_ready') : present(this.vapReceivedAt),
      start_blocked_reason: this.startBlockedReason() ?? holdStart,
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
      this.applyCandidateRecovery(now);
      const previous = this.turnState;
      // 交渉（合図、吸気の完了、DEFERRED）。吸気中は通常の応答も含めて開始を保留する。
      const holdStart =
        this.negotiation?.beforeStep({
          now,
          ai_speaking: previous.speaking.phase !== 'silent' || (this.speech?.activePlayback() ?? null) !== null,
          avatar_available: this.link !== null,
          user_speaking: previous.user_speaking,
          permitted: previous.permitted_to_speak,
          p_now_ai: this.vap === null ? null : readVap(this.vap, vapDirectionSettings(this.options.policy)).p_now_ai,
        }) ?? null;
      const inputs = this.inputs(holdStart);
      let { state, decisions } = this.turnManager.step(previous, inputs, now);
      this.turnState = state;
      // E3: 許可が出ていれば候補と通常の応答のどちらを話すか。候補なら、候補の音声を準備済みの応答の位置に入れて
      // 同じ tick を前の状態から計算し直す（TurnManager の許可の判定は prefetch を読まないので、許可は変わらない）。
      const candidate = this.chooseCandidate(previous, inputs, state, decisions, now);
      if (candidate !== null) {
        ({ state, decisions } = candidate.step);
        this.turnState = state;
      }
      // 再生の開始は、他の決定を実行する前に試す。入力で止められなかった拒否なら、その理由を start_blocked_reason に
      // 入れて同じ tick を前の状態から計算し直す（TurnManager は純粋関数）。segment も STT も進めず（応答を失わない）、
      // 同じ tick の他の決定（準備、turn.allowed、視線、鮮度）は開始しなかった前提の1組だけを実行する。
      const start = decisions.find((d) => d.kind === 'start_speech');
      this.startedCandidate = false;
      if (start !== undefined) {
        const refused =
          candidate !== null
            ? this.startCandidateSpeech(candidate.choice, start.audio_playback_id, now)
            : this.startSpeech(start.audio_playback_id);
        if (refused !== null) {
          this.counters.start_rolled_back += 1;
          ({ state, decisions } = this.turnManager.step(previous, { ...inputs, start_blocked_reason: `start_refused:${refused}` }, now));
          this.turnState = state;
        }
      }
      for (const decision of decisions) this.dispatch(decision, now);
      this.outcome?.afterStep({ now, decisions, state: this.turnState, inputs, candidate_id: this.startedCandidate ? (candidate?.choice.candidate?.candidate_id ?? null) : null });
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
        // 通常の応答を話し始めたら、残っている候補は撤回する（計画 §4.6）。候補を話し始めたときは撤回しない。
        if (!this.startedCandidate) {
          if (this.negotiation !== null) this.negotiation.onNormalResponseStarted(now);
          else this.initiative?.onNormalResponseStarted(now);
        }
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

  /** 候補の開始の間だけ、下りの音声の送信を止める（合図の解除を先に送るため）。 */
  private playbackHold: (() => void)[] | null = null;

  private afterCandidateRelease(send: () => void): void {
    if (this.playbackHold !== null) this.playbackHold.push(send);
    else send();
  }

  /** この tick で始めたのが候補の発話か（dispatch の start_speech で通常応答の撤回をしないため）。 */
  private startedCandidate = false;
  /** 候補の発話を始めたときの人の発話（1 音も出ないまま失敗したら、通常の応答の経路へ戻すための文）。 */
  private readonly candidateUserText = new Map<string, string>();
  private pendingCandidateRecovery: { candidate_id: string; cause: 'speech_failed' | 'speech_no_audio'; audio_playback_id: number } | null = null;

  /** 発声の失敗の後、次の tick の始めに通常の応答の経路へ戻す（tick の途中で状態を書き換えない）。 */
  private queueCandidateRecovery(candidate_id: string, cause: 'speech_failed' | 'speech_no_audio', audio_playback_id: number): void {
    this.pendingCandidateRecovery = { candidate_id, cause, audio_playback_id };
  }

  /**
   * 1 音も出なかった候補の発話の復帰（docs/initiative_v3_design.md §7）。TurnManager はこの発話の開始で segment を進め、asr_result を
   * 消している（U-4）。人が待っているなら、その発話の文を asr_result へ戻して L45 の準備を起こす。再試行はしない（候補は WITHDRAWN のまま）。
   */
  private applyCandidateRecovery(now: number): void {
    const pending = this.pendingCandidateRecovery;
    if (pending === null) return;
    this.pendingCandidateRecovery = null;
    const text = this.candidateUserText.get(pending.candidate_id);
    this.candidateUserText.delete(pending.candidate_id);
    // D は 1 音も書き込まずに失敗した音声の項目を消す（書き込み済みなら終わりの報告まで残る）。
    const noAudible = pending.cause === 'speech_no_audio' || this.speech?.stateOf(pending.audio_playback_id) === null;
    // TurnManager は開始の確認を START_ACK_TIMEOUT_MS まで待つ。1 音も出なかったこの発話の確認は来ないので、この場で待ちを解く。
    const stale = this.turnState.speaking;
    if (noAudible && stale.phase === 'starting' && stale.audio_playback_id === pending.audio_playback_id) {
      this.turnState = { ...this.turnState, speaking: { phase: 'silent' } };
    }
    const waiting = text !== undefined && noAudible && !this.turnState.user_speaking && this.turnState.asr_result === null && this.turnState.speaking.phase === 'silent';
    if (waiting) this.turnState = { ...this.turnState, asr_result: text, last_sent_asr_result: null };
    this.emitter.emit({
      event: 'negotiation.decision',
      stage: 'candidate_audio',
      candidate_id: present(pending.candidate_id),
      candidate_version: absent('recovery_after_speech_failure'),
      candidate_state: this.initiative?.ledger.get(pending.candidate_id)?.state ?? null,
      outcome: waiting ? 'normal_response_recovery' : 'no_recovery',
      reasons: [`cause:${pending.cause}`, `at:${Math.round(now)}`, ...(waiting ? [] : [text === undefined ? 'no_user_text' : !noAudible ? 'partly_spoken' : this.turnState.user_speaking ? 'user_speaking' : this.turnState.asr_result !== null ? 'new_user_text' : 'ai_speaking'])],
    });
  }

  /**
   * E3 の選択。候補を話すなら、候補の音声を準備済みの応答の位置に入れて計算し直した step を返す。それ以外は null
   * （1回目の step のまま。通常の応答が準備済みならそれが始まる）。
   */
  private chooseCandidate(
    previous: TurnState,
    inputs: TurnInputs,
    first: TurnState,
    decisions: TurnDecision[],
    now: number,
  ): { choice: CandidateChoice; step: { state: TurnState; decisions: TurnDecision[] } } | null {
    const negotiation = this.negotiation;
    if (negotiation === null || !negotiation.hasCandidate()) return null;
    // 1回目の step で通常の応答が始まっていると、状態の招待と発話文は開始で消えている（U-4）。選択には開始する前の
    // 値が要るので、開始だけを止めた step で見る（許可の判定は start_blocked_reason を読まないので同じ）。
    const view = decisions.some((d) => d.kind === 'start_speech')
      ? this.turnManager.step(previous, { ...inputs, start_blocked_reason: 'negotiation_selection_probe' }, now).state
      : first;
    const choice = negotiation.select(now, view);
    if (choice.choice !== 'candidate') return null;
    if (choice.audio_playback_id === null || choice.transcript_revision === null) {
      negotiation.noteSelectionNotStarted(choice, 'no_candidate_audio');
      return null;
    }
    // この tick で新しい準備を起動したなら TurnManager は話し始めない（L48）。候補の音声をそこへ入れると取り消されるので、
    // 次の tick で選び直す。
    if (decisions.some((d) => d.kind === 'prepare')) {
      negotiation.noteSelectionNotStarted(choice, 'new_prepare_this_tick');
      return null;
    }
    if (inputs.start_blocked_reason) {
      negotiation.noteSelectionNotStarted(choice, `start_blocked:${inputs.start_blocked_reason}`);
      return null;
    }
    const step = this.turnManager.step(
      previous,
      {
        ...inputs,
        prefetch: {
          state: 'ready',
          audio_playback_id: choice.audio_playback_id,
          segment_id: previous.segment_id,
          transcript_revision: choice.transcript_revision,
          started_at: now,
        },
      },
      now,
    );
    const start = step.decisions.find((d) => d.kind === 'start_speech');
    if (start === undefined || start.audio_playback_id !== choice.audio_playback_id) {
      negotiation.noteSelectionNotStarted(choice, 'turn_manager_did_not_start');
      return null;
    }
    return { choice, step };
  }

  /** 候補の発話の開始。E2a が D の版と PCM の一致を確かめる。拒否なら理由、始めたら null。 */
  private startCandidateSpeech(choice: CandidateChoice, audio_playback_id: number, now: number): string | null {
    if (this.speech === null || this.negotiation === null) return 'speech_unavailable';
    if (this.link === null) return 'browser_detached';
    // 合図の解除（breath.release／breath.prepare）を playback.begin より先に送る。音の開始より身体の合図を先に届ける。
    this.playbackHold = [];
    const refused = this.negotiation.startCandidate(choice, audio_playback_id, now);
    const held = this.playbackHold;
    this.playbackHold = null;
    for (const flush of held) flush();
    if (refused !== null) {
      this.counters.start_refused[refused] = (this.counters.start_refused[refused] ?? 0) + 1;
      return refused;
    }
    this.startedCandidate = true;
    if (choice.candidate !== null && choice.user_text !== null) this.candidateUserText.set(choice.candidate.candidate_id, choice.user_text);
    this.startedInSegment.set(audio_playback_id, this.turnState.segment_id);
    return null;
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

  private send(message: NodeToBrowser): boolean {
    if (this.link === null) return false;
    return this.link.sendJson(message) !== false;
  }

  // ---- 終了 --------------------------------------------------------------------

  async close(reason: string): Promise<void> {
    if (this.closed) return;
    this.endPlaybackOnBehalf(`session_closed:${reason}`);
    this.outcome?.close();
    this.closed = true;
    if (this.tickTimer !== null) clearInterval(this.tickTimer);
    this.negotiation?.finishReactions(this.time.monotonicMs());
    this.initiative?.close();
    this.link = null;
    for (const unsubscribe of this.unsubscribe.splice(0)) unsubscribe();
    this.prefetch?.dispose();
    this.speech?.dispose();
    await Promise.allSettled([this.stt?.close(), this.tts?.close()]);
    // 音声を閉じてから、結果を manifest に載せてログを閉じる（close は期限つきで、ここで止まらない）。
    if (this.audioRecorder !== null) await this.describeWithAudio(await this.audioRecorder.close(reason));
    await this.options.log.close();
  }
}
