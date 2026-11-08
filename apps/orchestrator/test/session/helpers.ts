/**
 * Session を偽のブラウザと台本のプロバイダで直接動かす軽い結合試験の道具（レーン J）。
 * tick のタイマーは止め、試験が時刻を進めて tick() を呼ぶ。音声認識・合成・VAP の性能は表さない。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ManualTimeSource,
  MemoryEventSink,
  PolicyJa,
  absent,
  createEventEmitter,
  encodeAudioFrame,
  present,
} from '@llm-vap/contracts';
import type { BrowserToNode, ClientHello, Condition, LlmRequest, NodeToBrowser, Policy } from '@llm-vap/contracts';
import { ScriptedLlmProvider, ScriptedSttProvider, ScriptedTtsProvider } from '@llm-vap/testkit';
import type { ScriptedSttSession, ScriptedTtsConnection } from '@llm-vap/testkit';
import { NullTurnCompletionEstimator } from '../../src/cognition/completion';
import { conversationKindFile } from '../../src/app/providers';
import type { InitiativeSetup, SessionProviders } from '../../src/app/providers';
import { CURRENT_PROMPT_VERSION, parseConversationKindProfile } from '../../src/cognition/initiative';
import type { SessionLog, SessionManifestDetails } from '../../src/logging';
import type { MaaiClientListeners, MaaiWorkerClient } from '../../src/maai';
import { Session } from '../../src/session/session';
import type { SessionOptions } from '../../src/session/session';

export const repoRoot = join(import.meta.dirname, '..', '..', '..', '..');
export const productionJaPolicy = (): PolicyJa =>
  PolicyJa.parse(JSON.parse(readFileSync(join(repoRoot, 'config', 'policy.ja.json'), 'utf8')));

export const FRAME = 320; // 20ms
export const TICK_MS = 20;

export class FakeLink {
  readonly json: NodeToBrowser[] = [];
  binary = 0;
  sendJson = (message: NodeToBrowser): void => void this.json.push(message);
  sendBinary = (): void => {
    this.binary += 1;
  };
  of<T extends NodeToBrowser['type']>(type: T): Extract<NodeToBrowser, { type: T }>[] {
    return this.json.filter((m): m is Extract<NodeToBrowser, { type: T }> => m.type === type);
  }
}

/** MaAI クライアントの代わり。onReady を持つ listener（セッションと event_bridge）へ届ける。 */
export class FakeMaai {
  private readonly listeners = new Set<MaaiClientListeners>();
  readonly providerClass = 'test_double' as const;
  sent = 0;
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
    this.sent += 1;
    return true;
  }
  private session(): MaaiClientListeners[] {
    return [...this.listeners].filter((l) => l.onReady !== undefined);
  }
  ready(at: number): void {
    for (const l of this.session()) l.onReady?.({} as never, at);
  }
  error(code: string, at: number): void {
    for (const l of this.session()) l.onError?.({ type: 'ERROR', code, message: 'test', fatal: false } as never, at);
  }
  unavailable(): void {
    for (const l of this.session()) {
      l.onAvailability?.({ state: 'down', vap_available: false, reason: 'test', restart_attempt: 0, next_retry_ms: null, gave_up: false } as never);
    }
  }
  vap(at: number, audio_frame: number, pNowAi: number, pFutAi: number, userSpeaking: boolean): void {
    for (const l of this.session()) {
      l.onVapState?.(
        {
          type: 'VAP_STATE',
          t: at,
          audio_frame,
          model_variant: 'test_values_not_maai',
          inference_ms: 1,
          raw: {},
          channel_layout: '2ch',
          p_now: [1 - pNowAi, pNowAi],
          p_future: [1 - pFutAi, pFutAi],
          vad: [userSpeaking ? 0.9 : 0.1, 0.1],
          user_speaking: userSpeaking,
          system_speaking: false,
        } as never,
        at,
      );
    }
  }
}

export function hello(session_id: string | null = null): ClientHello {
  return {
    type: 'client.hello',
    protocol_version: 1,
    session_id: session_id === null ? absent('new_session') : present(session_id),
    audio_context_sample_rate_hz: 48000,
    frame_samples: FRAME,
    track_settings: {
      echoCancellation: present(false),
      noiseSuppression: present(false),
      autoGainControl: present(false),
      sampleRate: present(48000),
      channelCount: present(1),
      deviceId: present('default'),
    },
    latency: {
      base_latency_ms: present(5),
      output_latency_ms: present(0),
      output_timestamp_context_ms: absent('test'),
      output_timestamp_performance_ms: absent('test'),
    },
    user_agent: 'test',
  };
}

export const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
};

export interface Rig {
  session: Session;
  time: ManualTimeSource;
  events: MemoryEventSink;
  link: FakeLink;
  maai: FakeMaai | null;
  stt: () => ScriptedSttSession;
  tts: () => ScriptedTtsConnection;
  described: SessionManifestDetails[];
  /** 送った音声の先頭。 */
  frame: number;
  /** true の間は TTS の chunk を送らない（候補の音声が間に合わない状況を作る。試験用）。 */
  pauseTts: boolean;
  /** 1 tick 進める: 時刻、上りの音声枠（mic の振幅）、VAP（fake のとき）、tick、非同期の処理と TTS の生成。 */
  step(options?: { loud?: boolean; p?: [number, number, boolean] }): Promise<void>;
  steps(n: number, options?: { loud?: boolean; p?: [number, number, boolean] }): Promise<void>;
  /** ブラウザの再生の報告。 */
  browser(message: BrowserToNode): void;
  /** 発話希望の判定に渡した LLM（options.initiative を渡したときだけ）。 */
  initiativeLlm: ScriptedLlmProvider | null;
}

export const TEST_PERSONA = {
  persona_id: 'test_persona',
  version: 1,
  role: '試験用の役割',
  interests: ['試験'],
  conversation_purpose: '試験',
  not_of_interest: ['無関係な話'],
};

export interface RigInitiative {
  /** false は条件で止めた場合（setup.enabled=false）。 */
  enabled?: boolean;
  responder?: (request: LlmRequest) => string | Promise<string>;
  reason?: string;
  /** 二段判定で動かす（会話の種類の設定は config の joint_thinking）。省略は1段判定（v2）。 */
  staged?: { timing_strategy: 'llm' | 'immediate'; vocal_cue?: 'none' | 'pre_beginning' | 'backchannel' };
}

function stagedSetup(timing_strategy: 'llm' | 'immediate', vocal_cue?: 'none' | 'pre_beginning' | 'backchannel'): Pick<InitiativeSetup, 'staged' | 'choice'> {
  const profile = parseConversationKindProfile(JSON.parse(readFileSync(conversationKindFile('joint_thinking'), 'utf8')));
  return {
    staged: {
      timing_strategy,
      conversation_kind: 'joint_thinking',
      profile,
      desire_prompt_version: 'initiative-desire-ja-v1',
      timing_prompt_version: 'initiative-timing-ja-v1',
      recent_context: { max_turns: 6, max_chars_per_turn: 300 },
    },
    choice: {
      conversation_kind: 'joint_thinking',
      conversation_kind_source: 'client',
      timing_strategy,
      timing_strategy_source: 'default',
      ...(vocal_cue === undefined ? {} : { vocal_cue, vocal_cue_source: 'client' as const }),
    },
  };
}

export async function createRig(
  options: { policy?: Policy; maai?: boolean; reply?: string; initiative?: RigInitiative; condition?: Condition; sessionAudio?: SessionOptions['sessionAudio']; ttsSettings?: Record<string, unknown> } = {},
): Promise<Rig> {
  const time = new ManualTimeSource(1000);
  const events = new MemoryEventSink();
  const emitter = createEventEmitter({ time, session_id: 's_test', condition: () => 'reactive', sink: events });
  const sttProvider = new ScriptedSttProvider(() => time.monotonicMs());
  const ttsProvider = new ScriptedTtsProvider({ ms_per_char: 100, chars_per_chunk: 4 });
  if (options.ttsSettings) Object.assign(ttsProvider, { describeSettings: () => options.ttsSettings });
  const llm = new ScriptedLlmProvider({ responder: () => options.reply ?? '三時からです。', chars_per_delta: 3 });
  const initiativeLlm = options.initiative
    ? new ScriptedLlmProvider({
        responder: options.initiative.responder ?? (() => '{"decision":"NONE"}'),
        now: () => time.monotonicMs(),
        chars_per_delta: 100_000,
      })
    : null;
  const initiative: InitiativeSetup | undefined = options.initiative
    ? options.initiative.enabled === false
      ? {
          enabled: false,
          reason: options.initiative.reason ?? 'disabled_for_condition:reactive',
          llm: null,
          persona: null,
          prompt_version: CURRENT_PROMPT_VERSION,
          model: 'test_double',
        }
      : {
          enabled: true,
          reason: null,
          llm: initiativeLlm,
          persona: TEST_PERSONA,
          prompt_version: CURRENT_PROMPT_VERSION,
          model: 'test_double',
          ...(options.initiative.staged ? stagedSetup(options.initiative.staged.timing_strategy, options.initiative.staged.vocal_cue) : {}),
        }
    : undefined;
  const providers: SessionProviders = {
    stt: { ok: true, value: sttProvider },
    tts: { ok: true, value: ttsProvider },
    llm: { ok: true, value: llm },
    completion: new NullTurnCompletionEstimator(),
    classes: { stt: 'test_double', tts: 'test_double', llm: 'test_double' },
    names: { stt: sttProvider.provider, tts: ttsProvider.provider, llm: llm.provider },
    requested: { stt: 'test_double', tts: 'test_double', llm: 'test_double' },
    completion_name: 'none',
    completion_error: null,
    ...(initiative ? { initiative } : {}),
  };
  const described: SessionManifestDetails[] = [];
  const log = {
    describe: async (details: SessionManifestDetails) => {
      described.push(details);
      return true;
    },
    close: async () => ({ ok: true }),
  } as unknown as SessionLog;
  const maai = options.maai === false ? null : new FakeMaai();
  const session = new Session({
    session_id: 's_test',
    condition: options.condition ?? 'reactive',
    policy: options.policy ?? productionJaPolicy(),
    time,
    emitter,
    log,
    providers,
    maai: maai as unknown as MaaiWorkerClient | null,
    ...(maai === null ? { maaiUnavailableReason: 'maai_disabled_in_test' } : {}),
    ...(options.sessionAudio ? { sessionAudio: options.sessionAudio } : {}),
    tickTimer: false,
  });
  const link = new FakeLink();
  await session.start(link, hello());
  const loud = new Int16Array(FRAME).map((_, i) => (i % 2 === 0 ? 6000 : -6000));
  const quiet = new Int16Array(FRAME);
  const rig: Rig = {
    session,
    time,
    events,
    link,
    maai,
    stt: () => sttProvider.sessions.at(-1) as ScriptedSttSession,
    tts: () => ttsProvider.connections.at(-1) as ScriptedTtsConnection,
    described,
    frame: 0,
    pauseTts: false,
    async step(o = {}) {
      time.advance(TICK_MS);
      session.handleBinary(encodeAudioFrame({ audio_frame: rig.frame, mic: o.loud ? loud : quiet, sys: quiet }));
      rig.frame += FRAME;
      if (maai !== null) {
        const [pn, pf, speaking] = o.p ?? [0.9, 0.9, false];
        maai.vap(time.monotonicMs(), rig.frame, pn, pf, speaking);
      }
      session.tick();
      await flush();
      if (!rig.pauseTts) for (const context of rig.tts().contexts) context.pumpAll();
    },
    async steps(n, o = {}) {
      for (let i = 0; i < n; i++) await rig.step(o);
    },
    browser(message) {
      session.handleJson(message);
    },
    initiativeLlm,
  };
  return rig;
}

/** VAP を助走の後まで進める（fake の MaAI のとき）。 */
export async function warmUp(rig: Rig): Promise<void> {
  rig.maai?.ready(rig.time.monotonicMs());
  await rig.steps(Math.ceil(10_000 / TICK_MS) + 1);
}

export const started = (begin: { audio_playback_id: number; generation: number }, audio_frame = 0): BrowserToNode => ({
  type: 'playback.started',
  audio_playback_id: begin.audio_playback_id,
  generation: begin.generation,
  audio_frame,
  client_t_ms: 0,
  output_latency_ms: present(0),
});

export const ended = (
  target: { audio_playback_id: number; generation: number },
  reason: 'completed' | 'stopped' | 'error',
  samples_written: number,
): BrowserToNode => ({
  type: 'playback.ended',
  audio_playback_id: target.audio_playback_id,
  generation: target.generation,
  reason,
  samples_written,
  samples_discarded: 0,
  audio_frame: 0,
  client_t_ms: 0,
  output_latency_ms: present(0),
});

export const position = (target: { audio_playback_id: number; generation: number }, samples_written: number): BrowserToNode => ({
  type: 'playback.position',
  audio_playback_id: target.audio_playback_id,
  generation: target.generation,
  samples_written,
  samples_buffered: 0,
  audio_frame: 0,
  client_t_ms: 0,
  output_latency_ms: present(0),
  system_ch_source: 'written',
});

/** 利用者の発話を STT から流し、準備から許可まで進めて AI の再生の開始（playback.begin）を待つ。 */
export async function userTurnUntilBegin(rig: Rig, text: string, maxTicks = 200): Promise<{ audio_playback_id: number; generation: number }> {
  const before = rig.link.of('playback.begin').length;
  rig.stt().deliver({ kind: 'final', text, audio_frame_end: rig.frame });
  for (let i = 0; i < maxTicks; i++) {
    await rig.step();
    const begins = rig.link.of('playback.begin');
    if (begins.length > before) return begins.at(-1) as { audio_playback_id: number; generation: number };
  }
  throw new Error(`AI did not start within ${maxTicks} ticks (refused=${JSON.stringify(rig.session.counters.start_refused)})`);
}
