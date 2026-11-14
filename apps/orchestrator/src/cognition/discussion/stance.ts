/**
 * 各 AI の捉え方の状態（02 §3.3-6、06 §1 の TwoAiAiState）。再生の報告から更新する。
 * framing_C は C の話者の進み（introduced → elaborating → done）、fact_slip は取り違えの進み（said → corrected → retracted）。
 * 両方の AI に同じ点の進みを持たせる（話し合いは 1 つの場なので）。版は更新ごとに上がる。
 */
import type { AiId, TwoAiAiState } from '@llm-vap/contracts';
import type { Persona } from './types';

type C = TwoAiAiState['framing_C'];
type F = TwoAiAiState['fact_slip'];

export class StanceTracker {
  private framing: C = 'not_yet';
  private slip: F = 'not_yet';
  private fed = 0;
  private version = 0;

  constructor(private readonly personas: readonly [Persona, Persona]) {}

  setAvailability(input: { framing_C: boolean; fact_slip: boolean }): void {
    if (!input.framing_C) this.framing = 'unavailable';
    if (!input.fact_slip) this.slip = 'unavailable';
    this.version += 1;
  }

  /** 点のターンを話した（played_ms > 0）。 */
  onPointTurnPlayed(kind: 'framing_C' | 'fact_slip' | 'control_inference', turnIndex: number, lastIndex: number): void {
    if (kind === 'framing_C' && this.framing !== 'unavailable') {
      const next: C = turnIndex === 0 ? 'introduced' : turnIndex >= lastIndex ? 'done' : 'elaborating';
      if (next !== this.framing) {
        this.framing = next;
        this.version += 1;
      }
    }
    if (kind === 'fact_slip' && this.slip === 'not_yet' && turnIndex === 0) {
      this.slip = 'said';
      this.version += 1;
    }
  }

  onCorrected(): void {
    if (this.slip === 'not_yet' || this.slip === 'said') {
      this.slip = 'corrected';
      this.version += 1;
    }
  }

  onRetracted(): void {
    if (this.slip !== 'unavailable' && this.slip !== 'retracted') {
      this.slip = 'retracted';
      this.version += 1;
    }
  }

  onFed(): void {
    this.fed += 1;
    this.version += 1;
  }

  state(ai_id: AiId): { state: TwoAiAiState; version: string } {
    const persona = this.personas.find((p) => p.ai_id === ai_id)!;
    return {
      state: { stance_id: persona.persona_id, framing_C: this.framing, fact_slip: this.slip, fed_interjections: this.fed },
      version: `v${this.version}`,
    };
  }
}
