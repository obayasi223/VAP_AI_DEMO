/**
 * 吸気の局面の遷移（BreathLayer.onPhase、rAF 時刻つき）を signal.report の形へ翻訳する。three と VRM に依存しない。
 * 目的は音声・イベントログ・吸気の実際の時刻を JSONL で照合する自己実験の記録（制御には使わない）。
 *
 * 局面の対応: inhale（吸気）／ready（保持）／pre_speech（短い準備と発話の戻り）／relax（deferred・withdrawn・保持の上限の脱力）。
 * Node から指示された動きの started は participant.ts が受理の rAF で既に返している（avatar_did_not_apply を含めて）。
 * ここで started を出すのは、指示なしで始まる動き（ready、短い準備、保持の上限の脱力）だけ。
 * ended は局面が実際に終わったフレーム（途中で別の局面に移ったときはそのフレーム）。
 */
import type { SignalPhase } from '@llm-vap/contracts';
import type { BreathPhaseEvent } from './breath';

export interface BreathSignalEvent {
  candidate_id: string;
  phase: SignalPhase;
  state: 'started' | 'ended';
  /** その遷移のフレームの rAF 時刻。 */
  client_t_ms: number;
}

export class BreathSignalReporter {
  private open: { phase: SignalPhase; candidateId: string } | null = null;

  constructor(
    /** cue_id → candidate_id。短い準備は cue_id が無いことがある（null を受ける）。 */
    private readonly candidateFor: (cueId: string | null) => string | null,
    private readonly emit: (event: BreathSignalEvent) => void,
  ) {}

  onPhase(event: BreathPhaseEvent): void {
    const { phase, kind, cause, nowMs } = event;
    switch (phase) {
      case 'inhale':
        this.close(nowMs);
        if (kind === 'short') this.begin('pre_speech', event, true);
        else this.begin('inhale', event, false);
        return;
      case 'hold':
        // 短い準備の後の保持は pre_speech のまま（再吸気しない）。準備吸気の保持は ready。
        if (kind === 'short') return;
        this.close(nowMs);
        this.begin('ready', event, true);
        return;
      case 'release':
        if (cause === 'speech_started') {
          if (this.open?.phase === 'pre_speech') return;
          this.close(nowMs);
          this.begin('pre_speech', event, false);
        } else {
          // 保持の上限による脱力は Node の指示が無く、誰も started を出していない。
          this.close(nowMs);
          this.begin('relax', event, cause === 'hold_timeout');
        }
        return;
      case 'idle':
        this.close(nowMs);
        return;
    }
  }

  private begin(phase: SignalPhase, event: BreathPhaseEvent, emitStarted: boolean): void {
    const candidateId = this.candidateFor(event.cueId);
    if (candidateId === null) return;
    this.open = { phase, candidateId };
    if (emitStarted) this.emit({ candidate_id: candidateId, phase, state: 'started', client_t_ms: event.nowMs });
  }

  private close(nowMs: number): void {
    if (this.open === null) return;
    this.emit({ candidate_id: this.open.candidateId, phase: this.open.phase, state: 'ended', client_t_ms: nowMs });
    this.open = null;
  }
}
