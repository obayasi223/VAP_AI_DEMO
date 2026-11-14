/**
 * AI スロット（docs/design/two_ai/01 §1.1、§2.1、§3.2.1）。スロットごとに TTS の接続（声が違う）と SpeechGeneratorImpl を持ち、
 * 再生 ID と世代の数え（SharedPlaybackCounters）は 2 スロットで共有する。
 *  - 2 体の発話（origin two_ai_turn）は LLM を呼ばず文をそのまま TTS へ。保持した音声は prepareCached。
 *  - intake の本人への応答は ResponsePrefetch と応答の経路（llmFor で intake の LLM、プロンプトは 02 の promptBuilder）。
 *  - speech.* は範囲つき emitter で ai_id と point_id を封筒に入れる。playback.begin と playback.alignment には ai_id を付ける。
 */
import { encodePcmFrame } from '@llm-vap/contracts';
import type { AiId, EventEmitter, LlmProvider, LlmPurpose, NodeToBrowser, PrepareRequest, PreparedSpeech, TimeSource, TtsConnection, TtsProvider, TwoAiTurnOrigin } from '@llm-vap/contracts';
import { ResponsePrefetch } from '../cognition/prefetch';
import type { ResponsePromptBuilder } from '../speech/response_prompt';
import { SpeechGeneratorImpl } from '../speech/speech_generator';
import type { CachedSpeechAudio } from '../speech/speech_generator';
import type { SharedPlaybackCounters } from '../speech/shared_counters';
import { scopedEmitter } from './scoped_emitter';

const TTS_SAMPLE_RATE_HZ = 24000;

export interface AiSlotDeps {
  ai_id: AiId;
  tts: TtsProvider;
  counters: SharedPlaybackCounters;
  /** intake の応答の LLM（llmFor('intake')）。 */
  intakeLlm: () => LlmProvider;
  /** 段を読んでプロンプトを切り替える包み（intake 以外で呼ばれたら例外）。 */
  prompt: ResponsePromptBuilder;
  send: (message: NodeToBrowser) => boolean;
  sendBinary: (data: Uint8Array) => void;
  time: TimeSource;
  emitter: EventEmitter;
  is_ready_buffer_ms: number;
}

export class AiSlot {
  readonly ai_id: AiId;
  readonly emitter: EventEmitter;
  /** 開けなかったときは null（available: false）。 */
  speech: SpeechGeneratorImpl | null = null;
  prefetch: ResponsePrefetch | null = null;
  tts: TtsConnection | null = null;
  unavailableReason: string | null = null;

  constructor(private readonly deps: AiSlotDeps) {
    this.ai_id = deps.ai_id;
    const pointByAudio = this.pointByAudio;
    this.emitter = scopedEmitter(deps.emitter, { ai_id: deps.ai_id, point_id: () => pointByAudio.current });
  }

  /** speech.* 以外の範囲（llm.* など）の point_id。発話の point_id は origin から入る。 */
  private readonly pointByAudio: { current: string | null } = { current: null };

  get available(): boolean {
    return this.speech !== null;
  }

  async open(): Promise<void> {
    try {
      this.tts = await this.deps.tts.open({ preferred_sample_rate_hz: TTS_SAMPLE_RATE_HZ });
    } catch (error) {
      this.unavailableReason = `tts_unavailable:${this.ai_id}:${String(error instanceof Error ? error.message : error).slice(0, 160)}`;
      return;
    }
    const ai_id = this.ai_id;
    const { send, sendBinary } = this.deps;
    this.speech = new SpeechGeneratorImpl({
      tts: this.tts,
      llm: this.deps.intakeLlm(),
      prompt: this.deps.prompt,
      sink: {
        begin: (m) => send({ type: 'playback.begin', ...m, ai_id }),
        pcm: (frame) => sendBinary(encodePcmFrame(frame)),
        alignment: (m) => send({ type: 'playback.alignment', ...m, ai_id } as NodeToBrowser),
        stop: (m) => send({ type: 'playback.stop', ...m }),
      },
      time: this.deps.time,
      emitter: this.emitter,
      is_ready_buffer_ms: this.deps.is_ready_buffer_ms,
      counters: this.deps.counters,
      llmFor: (request: PrepareRequest): { llm: LlmProvider; purpose: LlmPurpose } => {
        if (request.origin.kind === 'response') return { llm: this.deps.intakeLlm(), purpose: 'intake' };
        return { llm: this.deps.intakeLlm(), purpose: 'prefetch' };
      },
    });
    this.prefetch = new ResponsePrefetch({ speech: this.speech, time: this.deps.time, emitter: this.emitter });
  }

  /** 2 体の発話の文を TTS へ（LLM は呼ばない）。 */
  prepareText(origin: TwoAiTurnOrigin, text: string, link: { segment_id: number; transcript_revision: number }): PreparedSpeech | null {
    if (this.speech === null) return null;
    return this.speech.prepare({ segment_id: link.segment_id, transcript_revision: link.transcript_revision, text, origin });
  }

  prepareCached(origin: TwoAiTurnOrigin, audio: CachedSpeechAudio, link: { segment_id: number; transcript_revision: number }): PreparedSpeech | null {
    if (this.speech === null) return null;
    return this.speech.prepareCached(origin, audio, link);
  }

  activePlayback(): number | null {
    return this.speech?.activePlayback() ?? null;
  }

  dispose(): void {
    this.prefetch?.dispose();
    this.speech?.dispose();
  }

  async close(): Promise<void> {
    await this.tts?.close();
  }
}
