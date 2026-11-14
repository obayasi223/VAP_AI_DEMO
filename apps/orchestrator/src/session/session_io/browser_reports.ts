/**
 * 時計と報告の写し（session.ts の handleJson の clock.ping／clock.report／audio.report／gaze.report の枝と toServer から切り出し。
 * docs/design/two_ai/06 §11、01 §1.3。WP1a）。
 */
import { atFromBrowser, draftFromAudioReport, draftFromGazeReport } from '@llm-vap/contracts';
import type { BrowserToNode, EventEmitter, NodeToBrowser, TimeSource } from '@llm-vap/contracts';
import { BrowserClockRecorder } from '../../logging';

export interface BrowserReportCounters {
  audio_reports_before_clock: number;
  gaze_reports_before_clock: number;
}

export class BrowserReports {
  readonly browserClock: BrowserClockRecorder;

  constructor(private readonly deps: { emitter: EventEmitter; time: TimeSource; counters: BrowserReportCounters }) {
    this.browserClock = new BrowserClockRecorder(deps.emitter);
  }

  /**
   * clock.ping（pong を send で返す）、clock.report、audio.report、gaze.report を扱えば true。
   * emitOf は gaze.report を出す emitter を選ぶ（2 体は ai_id の範囲つき emitter。省略は deps.emitter）。
   */
  handle(message: BrowserToNode, send: (m: NodeToBrowser) => boolean, emitOf?: (message: BrowserToNode) => EventEmitter): boolean {
    switch (message.type) {
      case 'clock.ping':
        send({
          type: 'clock.pong',
          seq: message.seq,
          client_t_ms: message.client_t_ms,
          server_t_ms: this.deps.time.monotonicMs(),
        });
        return true;
      case 'clock.report':
        this.browserClock.record({
          offset_ms: message.offset_ms,
          rtt_ms: message.rtt_ms,
          uncertainty_ms: message.uncertainty_ms,
        });
        return true;
      case 'audio.report': {
        const mapping = this.browserClock.mapping();
        if (mapping === null) {
          this.deps.counters.audio_reports_before_clock += 1;
          return true;
        }
        this.deps.emitter.emit(draftFromAudioReport(message), atFromBrowser(message.client_t_ms, mapping));
        return true;
      }
      case 'gaze.report': {
        // 時計差の推定がないと描画の時刻（rendered_at）を orchestrator の基準へ写せない。受信時刻で代えない。
        const mapping = this.browserClock.mapping();
        if (mapping === null) {
          this.deps.counters.gaze_reports_before_clock += 1;
          return true;
        }
        const draft = draftFromGazeReport(message, mapping);
        const at = message.client_t_ms.value !== null ? atFromBrowser(message.client_t_ms.value, mapping) : undefined;
        (emitOf?.(message) ?? this.deps.emitter).emit(draft, at);
        return true;
      }
      default:
        return false;
    }
  }

  /** client_t_ms を orchestrator の時刻へ。時計差がなければ受信の時刻。 */
  toServer(clientMs: number): number {
    const mapping = this.browserClock.mapping();
    return mapping === null ? this.deps.time.monotonicMs() : Math.max(0, mapping.toServerMs(clientMs));
  }
}
