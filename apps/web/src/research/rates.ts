/**
 * 準備（応答の先行生成）の取消率・空振り率と、割り込みの回数（I2）。純粋な集計で、受信した分だけを数える。
 *
 * 定義（計画 §3.6 の「取消率・空振り率」を、ログにある事実だけで決める）:
 *  - 決着: prefetch.started のうち、prefetch.cancelled が来たもの、または同じ audio_playback_id の
 *    speech.started（origin=response）が来たもの。どちらもまだなら「進行中」で分母に入れない。
 *  - 取消率 = 取り消した準備 / 決着した準備。
 *  - 空振り率 = 合成を終えた（prefetch.ready が来た）のに使わず取り消した準備 / 合成を終えて決着した準備。
 *    「準備したが使われなかった」を、費用をかけ終えた分に限って数える。
 * 分母が 0 なら 0% と書かず未計測と理由を返す。
 */
import type { ResearchEvent } from '@llm-vap/contracts';

export type Rate =
  | { status: 'measured'; numerator: number; denominator: number; rate: number }
  | { status: 'unmeasured'; reason: string };

export function rate(numerator: number, denominator: number, emptyReason: string): Rate {
  if (denominator <= 0) return { status: 'unmeasured', reason: emptyReason };
  return { status: 'measured', numerator, denominator, rate: numerator / denominator };
}

export interface PrepareStats {
  started: number;
  ready: number;
  cancelled: number;
  used: number;
  in_progress: number;
  /** 開始を受けていない準備の取消や再生（画面を途中で開いた）。率には入れない。 */
  unmatched: number;
  cancel_rate: Rate;
  miss_rate: Rate;
  cancel_reasons: Record<string, number>;
}

export interface InterruptStats {
  ai_speech_started: number;
  interrupted: number;
  by_decision_source: Record<string, number>;
  /** 開始を受けた AI の発話のうち割り込みで止まった割合。発話がひとつもなければ未計測。 */
  interrupt_rate: Rate;
}

interface PrepareRecord {
  ready: boolean;
  cancelled: boolean;
  used: boolean;
}

export class OutcomeTracker {
  private readonly prepares = new Map<number, PrepareRecord>();
  private readonly cancelReasons: Record<string, number> = {};
  private unmatched = 0;
  private readonly speechStarted = new Set<number>();
  private interrupted = 0;
  /** 開始を受けた発話の割り込み（率の分子）。 */
  private interruptedMatched = 0;
  private readonly bySource: Record<string, number> = {};

  add(event: ResearchEvent): void {
    switch (event.event) {
      case 'prefetch.started':
        if (!this.prepares.has(event.audio_playback_id)) {
          this.prepares.set(event.audio_playback_id, { ready: false, cancelled: false, used: false });
        }
        break;
      case 'prefetch.ready': {
        const record = this.prepares.get(event.audio_playback_id);
        if (record) record.ready = true;
        else this.unmatched += 1;
        break;
      }
      case 'prefetch.cancelled': {
        const record = this.prepares.get(event.audio_playback_id);
        if (record === undefined) {
          this.unmatched += 1;
          break;
        }
        if (!record.cancelled && !record.used) {
          record.cancelled = true;
          this.cancelReasons[event.cancel_reason] = (this.cancelReasons[event.cancel_reason] ?? 0) + 1;
        }
        break;
      }
      case 'speech.started': {
        this.speechStarted.add(event.audio_playback_id);
        if (event.origin === 'response') {
          const record = this.prepares.get(event.audio_playback_id);
          if (record && !record.cancelled) record.used = true;
        }
        break;
      }
      case 'speech.interrupted':
        this.interrupted += 1;
        if (this.speechStarted.has(event.audio_playback_id)) this.interruptedMatched += 1;
        this.bySource[event.decision_source] = (this.bySource[event.decision_source] ?? 0) + 1;
        break;
      default:
        break;
    }
  }

  prepareStats(): PrepareStats {
    let ready = 0;
    let cancelled = 0;
    let used = 0;
    let inProgress = 0;
    let readySettled = 0;
    let readyCancelled = 0;
    for (const r of this.prepares.values()) {
      if (r.ready) ready += 1;
      if (r.cancelled) cancelled += 1;
      if (r.used) used += 1;
      const settled = r.cancelled || r.used;
      if (!settled) inProgress += 1;
      if (r.ready && settled) readySettled += 1;
      if (r.ready && r.cancelled) readyCancelled += 1;
    }
    return {
      started: this.prepares.size,
      ready,
      cancelled,
      used,
      in_progress: inProgress,
      unmatched: this.unmatched,
      cancel_rate: rate(cancelled, cancelled + used, this.prepares.size === 0 ? 'no_prefetch' : 'no_settled_prefetch'),
      miss_rate: rate(readyCancelled, readySettled, ready === 0 ? 'no_ready_prefetch' : 'no_settled_ready_prefetch'),
      cancel_reasons: { ...this.cancelReasons },
    };
  }

  interruptStats(): InterruptStats {
    const started = this.speechStarted.size;
    return {
      ai_speech_started: started,
      interrupted: this.interrupted,
      by_decision_source: { ...this.bySource },
      interrupt_rate: rate(this.interruptedMatched, started, 'no_ai_speech'),
    };
  }
}
