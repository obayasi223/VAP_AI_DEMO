/**
 * emit() のインターフェースと仮実装（計画 §3.4）。
 * 全レーンはこの EventEmitter を通してイベントを出す。JSONL への書き出しの本体は I1 が EventSink として作る。
 * 仮実装は MemoryEventSink と ConsoleEventSink。
 */
import type { TimeSource } from './clock';
import type { Condition } from './common';
import {
  EVENT_SCHEMA_VERSION,
  ResearchEvent,
  type EnvelopeField,
  type TimeBasis,
} from './events';

export interface EventSink {
  write(event: ResearchEvent): void;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * emit に渡す下書き。共通項目は emitter が埋める。
 * 別プロセスの時刻を写したイベントは at で明示し、time_basis に由来と誤差を入れる。
 */
export type EventDraft = DistributiveOmit<ResearchEvent, EnvelopeField>;

export interface EmitOptions {
  /** 既定は時刻源の現在値。 */
  at?: { t_monotonic_ms: number; time_basis: TimeBasis };
}

export interface EventEmitter {
  emit(draft: EventDraft, options?: EmitOptions): ResearchEvent;
}

export class InvalidEventError extends Error {
  readonly issues: unknown;
  constructor(message: string, issues: unknown) {
    super(message);
    this.name = 'InvalidEventError';
    this.issues = issues;
  }
}

export interface EmitterConfig {
  time: TimeSource;
  session_id: string;
  /** 条件はセッションの途中で切り替わりうる（I2）ので関数で受ける。 */
  condition: () => Condition;
  sink: EventSink;
  /**
   * 契約に合わないイベントの扱い。既定は throw（欠落を隠さない）。
   * report は書き出さずに onInvalid へ渡す。本番の音声経路を落としたくない場面用。
   */
  invalid?: 'throw' | 'report';
  onInvalid?: (error: InvalidEventError, draft: EventDraft) => void;
}

const ORCHESTRATOR_BASIS: TimeBasis = { source: 'orchestrator', uncertainty_ms: { value: 0 } };

export function createEventEmitter(config: EmitterConfig): EventEmitter {
  return {
    emit(draft, options) {
      const candidate = {
        ...draft,
        schema_version: EVENT_SCHEMA_VERSION,
        t_monotonic_ms: options?.at?.t_monotonic_ms ?? config.time.monotonicMs(),
        wall_clock: config.time.wallClock(),
        session_id: config.session_id,
        condition: config.condition(),
        time_basis: options?.at?.time_basis ?? ORCHESTRATOR_BASIS,
      };
      const parsed = ResearchEvent.safeParse(candidate);
      if (!parsed.success) {
        const error = new InvalidEventError(
          `invalid event ${String((draft as { event?: unknown }).event)}: ${parsed.error.message}`,
          parsed.error.issues,
        );
        if (config.invalid === 'report') {
          config.onInvalid?.(error, draft);
          return candidate as ResearchEvent;
        }
        throw error;
      }
      config.sink.write(parsed.data);
      return parsed.data;
    },
  };
}

/** 仮実装: メモリに溜める。試験と I1 が入るまでの配線用。 */
export class MemoryEventSink implements EventSink {
  readonly events: ResearchEvent[] = [];
  write(event: ResearchEvent): void {
    this.events.push(event);
  }
  ofType<N extends ResearchEvent['event']>(name: N): Extract<ResearchEvent, { event: N }>[] {
    return this.events.filter(
      (e): e is Extract<ResearchEvent, { event: N }> => e.event === name,
    );
  }
}

/** 仮実装: 1行の JSON を標準出力へ。永続化ではない。 */
export class ConsoleEventSink implements EventSink {
  write(event: ResearchEvent): void {
    console.log(JSON.stringify(event));
  }
}
