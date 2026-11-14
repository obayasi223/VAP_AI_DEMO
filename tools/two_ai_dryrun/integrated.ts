/**
 * 試走と T2 の結合の試験の本体（docs/design/two_ai/04 T2、T4、05 §5.2 の統合 1）。
 * 本物の TwoAiSession（WP1）と DiscussionContent（WP2）を、偽のプロバイダと偽のブラウザで、手で進める時計の上で最後まで通す。
 *
 *   - 時計：ManualTimeSource。20 ms ずつ進め、そのたびに session.tick() を呼ぶ（tick のタイマーは止める）。
 *   - LLM：台本の返答（app/scripted.ts の scriptedTwoAiReply）を、偽の時計の上の遅れで返す（実時間の setTimeout を使わない）。
 *          用途ごとの遅れ、失敗、届かない（中止まで待つ）を注入できる。
 *   - TTS：testkit の ScriptedTtsProvider（文字数 × ms_per_char の音）。tick ごとに全部出す。文で失敗を注入できる。
 *   - STT：本人の台本の声の区間の途中で interim、終わりの後に final を返す（stt.interim／stt.final も記録する）。
 *   - VAP：FakeVapFromScript（本人の台本の区間から p と vad を作る）を偽の MaAI として毎 tick 流す。
 *   - ブラウザ：playback.begin と PCM 枠を受け、20 ms ごとに 320 サンプル書いたとして started／position／ended を返す。
 *          playback.stop（immediate、fade、at_sample）、古い世代の枠の破棄を真似る。印と板の選択を送る。
 *   - 研究画面：本人の台本の woz（声の終わりの後に押す。遅れを注入できる）。
 * ログは本物の SessionLog（events.jsonl、manifest.json）で <out>/<session_id>/ に書く。
 * 結果は配線と順序の確認で、性能や自然さの証拠ではない（provider_class: test_double。AC11）。
 */
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ManualTimeSource,
  PolicyJa,
  SAMPLE_RATE_HZ,
  absent,
  decodePcmFrame,
  encodeAudioFrame,
  isStaleGeneration,
  modelOutput,
  modelOutputAbsent,
  present,
} from '@llm-vap/contracts';
import type {
  AiId,
  BrowserToNode,
  ClientHello,
  EmitOptions,
  EventDraft,
  EventEmitter,
  LlmProvider,
  LlmPurpose,
  LlmRequest,
  LlmResult,
  LlmStream,
  NodeToBrowser,
  ProviderStatusUpdate,
  ResearchWoz,
  SttProvider,
  SttResult,
  SttSession,
  SttSessionConfig,
  TtsConnection,
  TtsConnectionConfig,
  TtsContext,
  TtsProvider,
  TwoAiCondition,
  TwoAiEmitContext,
  Unsubscribe,
} from '@llm-vap/contracts';
import { ScriptedTtsProvider, toneSamples } from '@llm-vap/testkit';
import type { ScriptedTtsConnection } from '@llm-vap/testkit';
import { readConfig } from '../../apps/orchestrator/src/app/config';
import { createTwoAiProviders } from '../../apps/orchestrator/src/app/providers';
import { scriptedTwoAiReply } from '../../apps/orchestrator/src/app/scripted';
import { loadDiscussionAssets } from '../../apps/orchestrator/src/cognition/discussion';
import { openSessionLogging } from '../../apps/orchestrator/src/logging';
import type { MaaiClientListeners } from '../../apps/orchestrator/src/maai';
import { scopedEmitter } from '../../apps/orchestrator/src/two_ai/scoped_emitter';
import { TwoAiSession } from '../../apps/orchestrator/src/two_ai/two_ai_session';
import { loadTwoAiSettings } from '../../apps/orchestrator/src/two_ai/settings';
import { FakeVapFromScript } from './fake_vap';
import { resolveUserTimeline, type TimelineAnchors, type UserAction, type UserScript } from './user_script';

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const TICK_MS = 20;
const FRAME = 320;
/** 偽のブラウザの 1 tick の書き込み（16 kHz で 20 ms）。 */
const WRITE_PER_TICK = 320;

export interface LlmInjection {
  /** 用途ごとの遅れ（偽の時計の ms）。既定は DEFAULT_LLM_DELAY_MS。 */
  delay_ms?: Partial<Record<LlmPurpose, number>>;
  /** この要求の遅れ（null なら delay_ms）。 */
  delay_for?: (request: LlmRequest, n: number) => number | null;
  /** true の要求は失敗する（n は用途の中の通し番号、0 から）。 */
  fail?: (request: LlmRequest, n: number) => boolean;
  /** true の要求は中止まで返らない（判定が届かない回）。 */
  hang?: (request: LlmRequest, n: number) => boolean;
  /** 返答の差し替え（null なら台本の返答）。 */
  reply?: (request: LlmRequest, n: number) => string | null;
}

export const DEFAULT_LLM_DELAY_MS: Record<string, number> = {
  intake: 400,
  ledger: 600,
  discussion_plan: 2500,
  discussion_turn: 500,
  correction_assist: 700,
  next_step: 500,
  completion: 200,
  prefetch: 400,
};

export interface IntegratedOptions {
  condition: TwoAiCondition;
  /** リポジトリの根からの相対か絶対。 */
  config: string;
  script: string;
  user: UserScript;
  /** ログの親ディレクトリ。<out>/<session_id>/ に書く。 */
  out: string;
  session_id: string;
  /** 体験の旗（研究画面の arm の値として渡す。null は設定のまま）。 */
  feeds?: boolean | null;
  llm?: LlmInjection;
  /** true の文の TTS は失敗する（話者と通し番号）。 */
  tts_fail?: (text: string, ai: AiId, n: number) => boolean;
  /** 1 文字の音声の長さ（既定 1000 / 7 ≒ 143 ms。設定の chars_per_sec_estimate と同じ）。 */
  ms_per_char?: number;
  /** 研究者が声の終わりから WoZ を押すまで（既定 600 ms）。 */
  woz_delay_ms?: number;
  /** STT の確定文が声の終わりから届くまで（既定 300 ms）。 */
  stt_final_after_ms?: number;
  /** 研究者の WoZ を追加で押す（本人の台本の外。anchors から時刻を決める）。 */
  extra_woz?: { at: (anchors: TimelineAnchors) => number | undefined; action: ResearchWoz['action']; point_id?: string | null }[];
  /** セッションの上限（偽の時計の ms。既定 30 分）。 */
  max_ms?: number;
  /** 実時間で進める（real-llm のとき。1 tick ごとに 20 ms 待つ）。 */
  realtime?: boolean;
  /** 偽でない LLM（real-llm）。省略は偽の時計の台本の LLM。 */
  realLlm?: boolean;
}

export interface IntegratedResult {
  dir: string;
  session_id: string;
  events: Record<string, unknown>[];
  sent: NodeToBrowser[];
  phases: string[];
  woz_acks: { action: string; status: string; detail: string | null; at: number }[];
  counters: TwoAiSession['counters'];
  user_actions: UserAction[];
  /** 実行の後に残った、時刻の決まらなかった本人の行動の数。 */
  pending_actions: number;
  llm_requests: { purpose: LlmPurpose; at: number; outcome: 'ok' | 'failed' | 'aborted' | 'pending' }[];
}

// ---- 偽の時計の待ち ------------------------------------------------------------

class ManualTimers {
  private readonly waits: { due: number; resolve: () => void }[] = [];
  constructor(private readonly time: ManualTimeSource) {}
  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const entry = { due: this.time.monotonicMs() + Math.max(0, ms), resolve };
      this.waits.push(entry);
      signal?.addEventListener('abort', () => {
        const i = this.waits.indexOf(entry);
        if (i >= 0) this.waits.splice(i, 1);
        reject(abortError());
      });
    });
  }
  fire(): void {
    const now = this.time.monotonicMs();
    for (let i = this.waits.length - 1; i >= 0; i--) {
      const w = this.waits[i]!;
      if (w.due <= now) {
        this.waits.splice(i, 1);
        w.resolve();
      }
    }
  }
}

function abortError(): Error {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

// ---- LLM -----------------------------------------------------------------------

class ManualClockLlm implements LlmProvider {
  readonly provider = 'scripted_llm';
  readonly model_version = 'test_double';
  readonly provider_class = 'test_double' as const;
  constructor(
    private readonly deps: {
      time: ManualTimeSource;
      timers: ManualTimers;
      emitter: EventEmitter;
      injection: LlmInjection;
      log: IntegratedResult['llm_requests'];
      /** 用途ごとの通し番号（話者の違う LLM で共有）。 */
      counts: Map<LlmPurpose, number>;
    },
  ) {}

  async generate(request: LlmRequest): Promise<LlmResult> {
    const s = this.stream(request);
    for await (const _ of s.deltas) {
      // 全部受け取る
    }
    return s.result;
  }

  stream(request: LlmRequest): LlmStream {
    const { time, timers, emitter, injection, log } = this.deps;
    const n = this.deps.counts.get(request.purpose) ?? 0;
    this.deps.counts.set(request.purpose, n + 1);
    const sent_at = time.monotonicMs();
    const record = { purpose: request.purpose, at: sent_at, outcome: 'pending' as IntegratedResult['llm_requests'][number]['outcome'] };
    log.push(record);
    emitter.emit({
      event: 'llm.request',
      request_id: request.request_id,
      purpose: request.purpose,
      input: { system: request.system, messages: request.messages.map((m) => ({ role: m.role, text: m.text })), response_json_schema: request.response_json_schema },
      transcript_revision: request.transcript_revision,
      sent_at,
      model_version: this.model_version,
    } as EventDraft);
    const reply = injection.reply?.(request, n) ?? scriptedTwoAiReply(request) ?? 'なるほど、そうなんですね。';
    const delay = injection.delay_for?.(request, n) ?? injection.delay_ms?.[request.purpose] ?? DEFAULT_LLM_DELAY_MS[request.purpose] ?? 400;
    const fail = injection.fail?.(request, n) ?? false;
    const hang = injection.hang?.(request, n) ?? false;
    const respond = (output: string | null, reason: string) =>
      emitter.emit({
        event: 'llm.response',
        request_id: request.request_id,
        purpose: request.purpose,
        output: output === null ? modelOutputAbsent(reason) : modelOutput(output),
        transcript_revision: request.transcript_revision,
        sent_at,
        received_at: time.monotonicMs(),
        model_version: 'test_double',
        ...(output === null ? {} : { first_text_at: time.monotonicMs() }),
      } as EventDraft);
    let resolveResult!: (r: LlmResult) => void;
    let rejectResult!: (e: unknown) => void;
    const result = new Promise<LlmResult>((res, rej) => {
      resolveResult = res;
      rejectResult = rej;
    });
    result.catch(() => undefined);
    async function* deltas(): AsyncGenerator<string> {
      try {
        if (hang) await new Promise<void>((_, rej) => request.signal?.addEventListener('abort', () => rej(abortError())));
        await timers.sleep(delay, request.signal);
        if (request.signal?.aborted) throw abortError();
        if (fail) throw new Error('injected_llm_failure');
        yield reply;
        respond(reply, '');
        record.outcome = 'ok';
        resolveResult({
          request_id: request.request_id,
          purpose: request.purpose,
          text: reply,
          model_version: 'test_double',
          sent_at,
          received_at: time.monotonicMs(),
          first_text_at: time.monotonicMs(),
          finish_reason: present('STOP'),
          usage: { input_tokens: absent('test_double_does_not_count'), output_tokens: absent('test_double_does_not_count') },
        });
      } catch (error) {
        const aborted = error instanceof Error && error.name === 'AbortError';
        record.outcome = aborted ? 'aborted' : 'failed';
        respond(null, aborted ? 'aborted' : 'injected_failure');
        rejectResult(error);
        throw error;
      }
    }
    return { deltas: deltas(), result };
  }
}

// ---- STT -----------------------------------------------------------------------

class HarnessSttSession implements SttSession {
  private readonly results = new Set<(r: SttResult) => void>();
  private segmentId = 0;
  private asrSegmentId = 0;
  private asrFrameStart = 0;
  private revision = 0;
  constructor(private readonly deps: { time: ManualTimeSource; emitter: EventEmitter }) {}
  pushAudio(): void {}
  advanceSegment(new_segment_id: number): void {
    this.segmentId = new_segment_id;
  }
  onResult(listener: (r: SttResult) => void): Unsubscribe {
    this.results.add(listener);
    return () => this.results.delete(listener);
  }
  onStatus(_listener: (s: ProviderStatusUpdate) => void): Unsubscribe {
    return () => undefined;
  }
  async close(): Promise<void> {}
  deliver(kind: 'interim' | 'final', text: string, audio_frame_end: number): void {
    const stability = kind === 'final' ? absent('final_result') : absent('test_double_has_no_stability');
    const result: SttResult = {
      kind,
      text,
      stable_text: kind === 'final' ? text : '',
      unstable_text: kind === 'final' ? '' : text,
      parts: [{ text, stability }],
      segment_id: this.segmentId,
      asr_segment_id: this.asrSegmentId,
      asr_segment_frame_start: this.asrFrameStart,
      transcript_revision: ++this.revision,
      stability,
      stability_source: 'derived',
      audio_frame_end,
      timing_precision: 'result_end_offset',
      words: absent('test_double_has_no_word_times'),
      stream_id: 'dryrun_stream',
      provider: 'dryrun_stt',
      model_version: 'test_double',
      received_at: this.deps.time.monotonicMs(),
    };
    if (kind === 'final') {
      this.asrSegmentId += 1;
      this.asrFrameStart = audio_frame_end;
    }
    const { kind: _k, received_at: _r, ...fields } = result;
    this.deps.emitter.emit({ event: kind === 'final' ? 'stt.final' : 'stt.interim', ...fields } as EventDraft);
    for (const l of this.results) l(result);
  }
}

class HarnessSttProvider implements SttProvider {
  readonly provider = 'dryrun_stt';
  readonly model_version = 'test_double';
  readonly provider_class = 'test_double' as const;
  session: HarnessSttSession | null = null;
  constructor(private readonly deps: { time: ManualTimeSource; emitter: EventEmitter }) {}
  async open(_config: SttSessionConfig): Promise<HarnessSttSession> {
    this.session = new HarnessSttSession(this.deps);
    return this.session;
  }
}

// ---- TTS（失敗の注入） -----------------------------------------------------------

class FailingTtsProvider implements TtsProvider {
  readonly provider = 'scripted_tts';
  readonly model_version = 'test_double';
  readonly provider_class = 'test_double' as const;
  private n = 0;
  constructor(
    readonly inner: ScriptedTtsProvider,
    private readonly ai: AiId,
    private readonly fail: ((text: string, ai: AiId, n: number) => boolean) | null,
  ) {}
  async open(config: TtsConnectionConfig): Promise<TtsConnection> {
    const conn = await this.inner.open(config);
    if (this.fail === null) return conn;
    const fail = this.fail;
    const ai = this.ai;
    const self = this;
    return new Proxy(conn, {
      get(target, prop, receiver) {
        if (prop !== 'openContext') return Reflect.get(target, prop, receiver);
        return (t: { audio_playback_id: number; generation: number }): TtsContext => {
          const ctx = target.openContext(t);
          return new Proxy(ctx, {
            get(c, p, r) {
              if (p !== 'sendText') return Reflect.get(c, p, r);
              return (text: string) => {
                if (fail(text, ai, self.n++)) throw new Error('injected_tts_failure');
                c.sendText(text);
              };
            },
          });
        };
      },
    });
  }
}

// ---- MaAI（FakeVapFromScript） ---------------------------------------------------

class FakeMaaiClient {
  private readonly listeners = new Set<MaaiClientListeners>();
  readonly providerClass = 'test_double' as const;
  subscribe(listeners: MaaiClientListeners): () => void {
    this.listeners.add(listeners);
    return () => this.listeners.delete(listeners);
  }
  current() {
    return { state: 'ready', vap_available: true, reason: null, restart_attempt: 0, next_retry_ms: null, gave_up: false };
  }
  async reconfigure() {
    return this.current();
  }
  sendEncodedAudio(): boolean {
    return true;
  }
  ready(at: number): void {
    for (const l of this.listeners) l.onReady?.({} as never, at);
  }
  vap(at: number, audio_frame: number, f: { p_now: [number, number]; p_future: [number, number]; vad: [number, number] }): void {
    for (const l of this.listeners) {
      l.onVapState?.(
        {
          type: 'VAP_STATE',
          t: at,
          audio_frame,
          model_variant: 'fake_vap_from_script',
          inference_ms: 1,
          raw: {},
          channel_layout: '2ch',
          p_now: f.p_now,
          p_future: f.p_future,
          vad: f.vad,
          user_speaking: f.vad[0] > 0.5,
          system_speaking: f.vad[1] > 0.5,
        } as never,
        at,
      );
    }
  }
}

// ---- ブラウザ ---------------------------------------------------------------------

interface Play {
  id: number;
  generation: number;
  ai: AiId;
  rate: number;
  queued: number;
  written: number;
  eos: boolean;
  started: boolean;
  stop: { at_sample: number; deadline: number } | null;
  lastPosition: number;
}

class FakeBrowser {
  readonly sent: NodeToBrowser[] = [];
  private readonly plays = new Map<number, Play>();
  private generation = 0;
  private readonly out: BrowserToNode[] = [];
  boardVersion = 0;
  boardCards: { card_id: string; order: number }[] = [];
  boardMode = '';

  constructor(
    private readonly time: ManualTimeSource,
    private readonly frame: () => number,
  ) {}

  sendJson = (m: NodeToBrowser): boolean => {
    this.sent.push(m);
    const now = this.time.monotonicMs();
    switch (m.type) {
      case 'playback.begin':
        if (isStaleGeneration(m.generation, this.generation)) return true;
        this.generation = Math.max(this.generation, m.generation);
        this.plays.set(m.audio_playback_id, { id: m.audio_playback_id, generation: m.generation, ai: (m as { ai_id?: AiId }).ai_id ?? 'A', rate: m.sample_rate_hz, queued: 0, written: 0, eos: false, started: false, stop: null, lastPosition: now });
        return true;
      case 'playback.stop': {
        this.generation = Math.max(this.generation, m.generation);
        const p = this.plays.get(m.audio_playback_id);
        if (p === undefined) return true;
        if (m.stop.mode === 'at_sample') p.stop = { at_sample: m.stop.stop_at_sample, deadline: now + m.stop.deadline_ms };
        else p.stop = { at_sample: p.written + Math.round(((m.stop.mode === 'fade' ? m.stop.fade_ms : 0) * SAMPLE_RATE_HZ) / 1000), deadline: now };
        return true;
      }
      case 'two_ai.board':
        this.boardVersion = m.board_version;
        this.boardCards = m.cards.map((c) => ({ card_id: c.card_id, order: c.order }));
        this.boardMode = m.mode;
        return true;
      default:
        return true;
    }
  };

  sendBinary = (data: Uint8Array): void => {
    let f: ReturnType<typeof decodePcmFrame>;
    try {
      f = decodePcmFrame(data);
    } catch {
      return;
    }
    if (isStaleGeneration(f.generation, this.generation)) return;
    const p = this.plays.get(f.audio_playback_id);
    if (p === undefined || p.generation !== f.generation) return;
    p.queued += Math.round((f.sample_count * SAMPLE_RATE_HZ) / f.sample_rate_hz);
    if (f.end_of_stream) p.eos = true;
  };

  /** 1 tick の再生。報告を返す。 */
  step(): BrowserToNode[] {
    const now = this.time.monotonicMs();
    const frame = this.frame();
    const base = { audio_frame: frame, client_t_ms: now, output_latency_ms: present(0) };
    for (const p of [...this.plays.values()]) {
      if (!p.started) {
        if (p.stop !== null) {
          this.out.push({ type: 'playback.ended', audio_playback_id: p.id, generation: p.generation, reason: 'discarded_before_start', samples_written: 0, samples_discarded: p.queued, ...base } as BrowserToNode);
          this.plays.delete(p.id);
          continue;
        }
        if (p.queued === 0) continue;
        p.started = true;
        this.out.push({ type: 'playback.started', audio_playback_id: p.id, generation: p.generation, ...base } as BrowserToNode);
      }
      const limit = p.stop === null ? p.queued : Math.min(p.queued, p.stop.at_sample);
      p.written = Math.min(limit, p.written + WRITE_PER_TICK);
      if (now - p.lastPosition >= 100) {
        p.lastPosition = now;
        this.out.push({ type: 'playback.position', audio_playback_id: p.id, generation: p.generation, samples_written: p.written, samples_buffered: Math.max(0, p.queued - p.written), system_ch_source: 'written', ...base } as BrowserToNode);
      }
      if (p.stop !== null && (p.written >= p.stop.at_sample || now >= p.stop.deadline || (p.eos && p.written >= p.queued))) {
        const completed = p.eos && p.written >= p.queued;
        this.out.push({ type: 'playback.ended', audio_playback_id: p.id, generation: p.generation, reason: completed ? 'completed' : 'stopped', samples_written: p.written, samples_discarded: Math.max(0, p.queued - p.written), ...base } as BrowserToNode);
        this.plays.delete(p.id);
      } else if (p.stop === null && p.eos && p.written >= p.queued) {
        this.out.push({ type: 'playback.ended', audio_playback_id: p.id, generation: p.generation, reason: 'completed', samples_written: p.written, samples_discarded: 0, ...base } as BrowserToNode);
        this.plays.delete(p.id);
      }
    }
    return this.out.splice(0);
  }

  /** 再生中か（sys の vad）。 */
  playing(): boolean {
    for (const p of this.plays.values()) if (p.started) return true;
    return false;
  }
}

// ---- 本体 -----------------------------------------------------------------------

function helloMessage(): ClientHello {
  return {
    type: 'client.hello',
    protocol_version: 1,
    session_id: absent('new_session'),
    audio_context_sample_rate_hz: 48000,
    frame_samples: FRAME,
    track_settings: {
      echoCancellation: present(true),
      noiseSuppression: present(false),
      autoGainControl: present(false),
      sampleRate: present(48000),
      channelCount: present(1),
      deviceId: present('dryrun'),
    },
    latency: { base_latency_ms: present(5), output_latency_ms: present(0), output_timestamp_context_ms: absent('dryrun'), output_timestamp_performance_ms: absent('dryrun') },
    user_agent: 'two_ai_dryrun',
  } as ClientHello;
}

function anchorsFrom(events: Record<string, unknown>[], start: number): TimelineAnchors {
  const a: TimelineAnchors = { session_start_ms: start, phase_started_ms: {}, point_started_ms: {}, stage_started_ms: {} };
  for (const e of events) {
    const t = e.t_monotonic_ms as number;
    if (e.event === 'two_ai.phase_changed') {
      const to = e.to as keyof TimelineAnchors['phase_started_ms'];
      a.phase_started_ms[to] ??= t;
      if (to === 'discussion') a.discussion_started_ms ??= t;
    } else if (e.event === 'two_ai.point' && e.stage === 'started') {
      a.point_started_ms[e.point_id as string] ??= t;
    } else if (e.event === 'two_ai.stage' && e.edge === 'started') {
      a.stage_started_ms[e.discussion_stage as 1] ??= t;
    }
  }
  return a;
}

export async function runIntegratedSession(options: IntegratedOptions): Promise<IntegratedResult> {
  const time = new ManualTimeSource(1000);
  const timers = new ManualTimers(time);
  const loaded = loadTwoAiSettings({ root: repoRoot, config_path: resolve(repoRoot, options.config), script_path: resolve(repoRoot, options.script) });
  if (!loaded.ok) throw new Error(`two_ai settings: ${loaded.reason}`);
  const settings = loaded.settings;
  const script = settings.scripts.get(settings.default_script_id!)!;
  // セッションを作る前（ログの開始の provider.status）も 2 体の封筒を付ける（06 §4.1：2 体のセッションのすべてのイベント）。
  let context: () => TwoAiEmitContext | null = () => ({ phase: 'intake', discussion_stage: null, script_variant: 'original' });
  // 同じ名前の前の試走は消す（SessionLog は既にあるファイルに書かない）。
  await rm(join(resolve(repoRoot, options.out), options.session_id), { recursive: true, force: true });
  const logging = await openSessionLogging({
    dir: resolve(repoRoot, options.out),
    session_id: options.session_id,
    time,
    condition: () => options.condition,
    two_ai_context: () => context(),
    provider_class: 'test_double',
    reporter: () => undefined,
  });
  const events: Record<string, unknown>[] = [];
  const emitter: EventEmitter = {
    emit: (draft: EventDraft, emitOptions?: EmitOptions) => {
      const event = logging.emitter.emit(draft, emitOptions);
      events.push(event as unknown as Record<string, unknown>);
      return event;
    },
  };
  const config = readConfig({ STT_PROVIDER_CLASS: 'test_double', TTS_PROVIDER_CLASS: 'test_double', LLM_PROVIDER_CLASS: 'test_double', MAAI_ENABLED: '0' });
  const policy = PolicyJa.parse(JSON.parse(readFileSync(join(repoRoot, 'config', 'policy.ja.json'), 'utf8')));
  const personas = loadDiscussionAssets(settings.root, settings.config, script.script.personas_file).personas;
  const providers = await createTwoAiProviders({ config, twoAi: settings.config, personas, time, emitter, env: {} });
  if (!providers.ok) throw new Error(`two_ai providers: ${providers.reason}`);
  const llmLog: IntegratedResult['llm_requests'] = [];
  if (!options.realLlm) {
    const injection = options.llm ?? {};
    const llms = new Map<string, ManualClockLlm>();
    const counts = new Map<LlmPurpose, number>();
    providers.llmFor = (purpose: LlmPurpose, ai_id?: AiId) => {
      const key = ai_id ?? '';
      let llm = llms.get(key);
      if (llm === undefined) {
        llm = new ManualClockLlm({ time, timers, emitter: ai_id === undefined ? emitter : scopedEmitter(emitter, { ai_id }), injection, log: llmLog, counts });
        llms.set(key, llm);
      }
      void purpose;
      return llm;
    };
  }
  const stt = new HarnessSttProvider({ time, emitter });
  providers.base = { ...providers.base, stt: { ok: true, value: stt } } as typeof providers.base;
  const msPerChar = options.ms_per_char ?? Math.round(1000 / settings.config.phases.discussion.chars_per_sec_estimate);
  const inner = { A: new ScriptedTtsProvider({ ms_per_char: msPerChar, chars_per_chunk: 8 }), B: new ScriptedTtsProvider({ ms_per_char: msPerChar, chars_per_chunk: 8 }) };
  providers.slotTts = { A: new FailingTtsProvider(inner.A, 'A', options.tts_fail ?? null), B: new FailingTtsProvider(inner.B, 'B', options.tts_fail ?? null) };
  const pumpTts = () => {
    for (const p of [inner.A, inner.B]) for (const c of p.connections as ScriptedTtsConnection[]) for (const ctx of c.contexts) ctx.pumpAll();
  };
  const maai = new FakeMaaiClient();
  const session = new TwoAiSession({
    session_id: options.session_id,
    condition: options.condition,
    condition_source: 'env',
    arm: options.feeds === undefined || options.feeds === null ? null : { arm_id: `dryrun_${options.session_id}`, interjection_feeds_generation: options.feeds, session_index: null, counterbalance_label: null },
    policy,
    time,
    emitter,
    bindEmitContext: (c) => {
      context = c;
    },
    log: logging.log,
    settings,
    script,
    providers,
    maai: maai as never,
    tickTimer: false,
    sessionAudio: { enabled: false, reason: 'SAVE_SESSION_AUDIO_not_set' } as never,
  });
  let frame = 0;
  const browser = new FakeBrowser(time, () => frame);
  const pumping = setInterval(pumpTts, 1);
  try {
    await session.start({ sendJson: browser.sendJson, sendBinary: browser.sendBinary }, helloMessage());
  } finally {
    clearInterval(pumping);
  }
  session.handleJson({ type: 'clock.report', offset_ms: 0, rtt_ms: 2, uncertainty_ms: 1, samples: 5, client_t_ms: time.monotonicMs() } as BrowserToNode);
  maai.ready(time.monotonicMs());

  const start = time.monotonicMs();
  const done = new Set<string>();
  let actions: UserAction[] = [];
  let pending = 0;
  const vapActions: UserAction[] = [];
  let vap = new FakeVapFromScript(vapActions);
  const scheduled: { at: number; run: () => void; key: string }[] = [];
  const wozAcks: IntegratedResult['woz_acks'] = [];
  let wozSeq = 0;
  const woz = (action: ResearchWoz['action'], point_id: string | null) => {
    const ack = session.handleWoz({ type: 'research.woz', woz_id: `dryrun_w${++wozSeq}`, action, point_id, operator: 'dryrun', client_wall_clock: time.wallClock() } as ResearchWoz);
    wozAcks.push({ action, status: ack.status, detail: ack.detail ?? null, at: time.monotonicMs() });
  };
  const extraDone = new Set<number>();
  const slipPoint = script.script.planned_points.find((p) => p.kind === 'fact_slip')?.id ?? null;
  const loud = toneSamples(FRAME, SAMPLE_RATE_HZ);
  const quiet = new Int16Array(FRAME);
  const phases: string[] = [];
  const maxMs = options.max_ms ?? 30 * 60_000;
  let afterEnd = 0;
  let quietAfterEnd = 0;
  let markerSeq = 0;
  let pickSeq = 0;
  const finalAfter = options.stt_final_after_ms ?? 300;
  const wozDelay = options.woz_delay_ms ?? 600;

  const schedule = (a: UserAction) => {
    if (a.kind === 'voice') {
      vapActions.push(a);
      vap = new FakeVapFromScript(vapActions);
      const mid = a.at_ms + Math.round(a.duration_ms / 2);
      const end = a.at_ms + a.duration_ms;
      const chars = [...a.text];
      // 文のない声（咳など。試験だけが text: '' で作る）は STT が何も返さない。
      if (chars.length > 0) {
        scheduled.push({ at: mid, key: `${a.source}:interim`, run: () => stt.session?.deliver('interim', chars.slice(0, Math.max(1, Math.floor(chars.length / 2))).join(''), frame) });
        scheduled.push({ at: end + finalAfter, key: `${a.source}:final`, run: () => stt.session?.deliver('final', a.text, frame) });
      }
      if (a.woz !== null) {
        const action = a.woz;
        scheduled.push({ at: end + wozDelay, key: `${a.source}:woz`, run: () => woz(action, action === 'correction' ? slipPoint : null) });
      }
    } else if (a.kind === 'onset_only') {
      vapActions.push(a);
      vap = new FakeVapFromScript(vapActions);
    } else if (a.kind === 'marker') {
      scheduled.push({ at: a.at_ms, key: `${a.source}:marker`, run: () => session.handleJson({ type: 'two_ai.marker', marker_id: `dryrun_m${++markerSeq}`, client_t_ms: time.monotonicMs() } as BrowserToNode) });
    } else {
      const order = a.order;
      scheduled.push({
        at: a.at_ms,
        key: `${a.source}:pick`,
        run: () => {
          const card = browser.boardCards.find((c) => c.order === order);
          if (card === undefined) return;
          session.handleJson({ type: 'two_ai.board_pick', pick_id: `dryrun_p${++pickSeq}`, card_id: card.card_id, board_version: browser.boardVersion, client_t_ms: time.monotonicMs() } as BrowserToNode);
        },
      });
    }
  };

  const voicedAt = (t: number) => vapActions.some((a) => a.kind === 'voice' && t >= a.at_ms && t < a.at_ms + a.duration_ms);

  for (let elapsed = 0; elapsed < maxMs; elapsed += TICK_MS) {
    time.advance(TICK_MS);
    const now = time.monotonicMs();
    timers.fire();
    // 本人の台本：時刻の決まった行動を予定に入れる。
    const anchors = anchorsFrom(events, start);
    const r = resolveUserTimeline(options.user, anchors);
    pending = r.pending;
    for (const a of r.actions) {
      if (done.has(a.source)) continue;
      done.add(a.source);
      actions.push(a);
      schedule(a);
    }
    options.extra_woz?.forEach((w, i) => {
      if (extraDone.has(i)) return;
      const at = w.at(anchors);
      if (at === undefined || now < at) return;
      extraDone.add(i);
      woz(w.action, w.point_id ?? null);
    });
    for (let i = scheduled.length - 1; i >= 0; i--) {
      if (scheduled[i]!.at > now) continue;
      const [s] = scheduled.splice(i, 1);
      s!.run();
    }
    // 上りの音声と VAP。
    const voiced = voicedAt(now);
    session.handleBinary(encodeAudioFrame({ audio_frame: frame, mic: voiced ? loud : quiet, sys: quiet }));
    frame += FRAME;
    const f = vap.frame(now, browser.playing());
    maai.vap(now, frame, f);
    // ブラウザの再生の報告。
    for (const m of browser.step()) session.handleJson(m);
    session.tick();
    for (let k = 0; k < 4; k++) await new Promise((res) => setImmediate(res));
    pumpTts();
    if (options.realtime) await new Promise((res) => setTimeout(res, TICK_MS));
    const phase = session.directorState.phase;
    if (phases.at(-1) !== phase) phases.push(phase);
    if (phase === 'end') {
      // 撤回の記録が出て再生が終わったら、少し回して閉じる（end_of_session は撤回の文を話してから）。
      afterEnd += 1;
      const retracted = events.some((e) => e.event === 'two_ai.retraction');
      if (retracted && !browser.playing()) quietAfterEnd += 1;
      if (quietAfterEnd > 25 || afterEnd > 6000) break;
    }
  }
  await session.close(phases.at(-1) === 'end' ? 'dryrun_end' : 'dryrun_timeout');
  actions = actions.sort((a, b) => a.at_ms - b.at_ms);
  return {
    dir: join(resolve(repoRoot, options.out), options.session_id),
    session_id: options.session_id,
    events,
    sent: browser.sent,
    phases,
    woz_acks: wozAcks,
    counters: session.counters,
    user_actions: actions,
    pending_actions: pending,
    llm_requests: llmLog,
  };
}
