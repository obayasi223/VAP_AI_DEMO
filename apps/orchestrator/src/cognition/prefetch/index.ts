/**
 * ResponsePrefetch（計画 §4.1、§4.3）。TurnManager の decisions の prepare と cancel_prepare を実行するだけで、
 * 準備の判断はしない（E1）。start_speech と interrupt_speech は J が SpeechGenerator へ直接渡す。
 *
 * InitiativeMonitor とは別のモジュールで、起動条件を共有しない（仕様、計画 §4.5）。
 */
import { absent, present } from '@llm-vap/contracts';
import type {
  EventDraft,
  EventEmitter,
  Maybe,
  PrefetchInput,
  TimeSource,
  TurnDecision,
  Unsubscribe,
} from '@llm-vap/contracts';
import { SIMILARITY_METHOD, charNgramCosine } from '../similarity';
import type { SpeechGeneratorImpl, SpeechStateChange } from '../../speech/speech_generator';

type PrepareDecision = Extract<TurnDecision, { kind: 'prepare' }>;
type CancelDecision = Extract<TurnDecision, { kind: 'cancel_prepare' }>;

interface Current {
  audio_playback_id: number;
  segment_id: number;
  transcript_revision: number;
  started_at: number;
  ready: boolean;
  similarity: Maybe<number>;
}

export interface ResponsePrefetchOptions {
  speech: SpeechGeneratorImpl;
  time: TimeSource;
  emitter: EventEmitter;
}

export class ResponsePrefetch {
  private current: Current | null = null;
  /** Appendix A の last_sent_asr_result。取消や再生の後も比較の基準として残す（L47）。 */
  private lastSent: { text: string; segment_id: number } | null = null;
  private readonly unsubscribe: Unsubscribe;

  constructor(private readonly options: ResponsePrefetchOptions) {
    this.unsubscribe = options.speech.onStateChange((change) => this.handleSpeechState(change));
  }

  /** decisions を順に渡す。prepare と cancel_prepare 以外は無視する。 */
  execute(decision: TurnDecision): void {
    if (decision.kind === 'prepare') this.prepare(decision);
    else if (decision.kind === 'cancel_prepare') this.cancel(decision);
  }

  private prepare(decision: PrepareDecision): void {
    if (this.current) {
      // L48: 新しい準備の前に古い準備を取り消す。再生に入ったものは current から外れている。
      this.options.speech.cancel(this.current.audio_playback_id, 'superseded');
    }
    const prepared = this.options.speech.prepare({
      segment_id: decision.segment_id,
      transcript_revision: decision.transcript_revision,
      text: decision.text,
      origin: { kind: 'response' },
    });
    this.current = {
      audio_playback_id: prepared.audio_playback_id,
      segment_id: decision.segment_id,
      transcript_revision: decision.transcript_revision,
      started_at: this.options.time.monotonicMs(),
      ready: false,
      similarity: decision.similarity,
    };
    this.lastSent = { text: decision.text, segment_id: decision.segment_id };
    this.emit('prefetch.started', this.current);
  }

  private cancel(decision: CancelDecision): void {
    if (this.current?.audio_playback_id !== decision.audio_playback_id) return;
    this.options.speech.cancel(decision.audio_playback_id, decision.reason);
  }

  private handleSpeechState(change: SpeechStateChange): void {
    const current = this.current;
    if (!current || current.audio_playback_id !== change.audio_playback_id) return;
    switch (change.state) {
      case 'ready':
        current.ready = true;
        this.emit('prefetch.ready', current);
        break;
      case 'playing':
        this.current = null;
        break;
      case 'cancelled':
      case 'failed':
        this.emit('prefetch.cancelled', current, change.reason ?? change.state);
        this.current = null;
        // 失敗した準備は送れていないので、同じ入力での再試行を類似度で止めない。
        if (change.state === 'failed') this.lastSent = null;
        break;
      default:
        break;
    }
  }

  private emit(
    event: 'prefetch.started' | 'prefetch.ready' | 'prefetch.cancelled',
    current: Current,
    cancel_reason?: string,
  ): void {
    this.options.emitter.emit({
      event,
      segment_id: current.segment_id,
      transcript_revision: current.transcript_revision,
      audio_playback_id: current.audio_playback_id,
      similarity: current.similarity,
      similarity_method: SIMILARITY_METHOD,
      model_version: this.options.speech.model_version,
      ...(cancel_reason === undefined ? {} : { cancel_reason }),
    } as EventDraft);
  }

  /** TurnInputs.prefetch */
  input(): PrefetchInput {
    const current = this.current;
    if (!current) return { state: 'idle' };
    return {
      state: current.ready ? 'ready' : 'preparing',
      audio_playback_id: current.audio_playback_id,
      segment_id: current.segment_id,
      transcript_revision: current.transcript_revision,
      started_at: current.started_at,
    };
  }

  /**
   * TurnInputs.similarity_to_prepared。比較対象がないときは null と理由で、E は 0 として扱う（U-5）。
   * segment が変わると前の入力とは比べない（U-4）。
   */
  similarityToPrepared(text: string, segment_id: number): Maybe<number> {
    if (!this.lastSent) return absent('no_previous_prepare');
    if (this.lastSent.segment_id !== segment_id) return absent('previous_prepare_in_other_segment');
    return present(charNgramCosine(text, this.lastSent.text));
  }

  dispose(): void {
    this.unsubscribe();
  }
}
