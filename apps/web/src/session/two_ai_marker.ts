/**
 * 印のボタン（docs/design/two_ai/03 §2.4、§3.2、06 §2.2）。React に依存しない。
 *  - discussion の間だけ押せる（両条件で同じ）。押すと two_ai.marker を 1 件送る。AI は止まらない（記録だけ）。
 *  - client_t_ms は既存の時計（performance.now。Node が時計差で写す）。
 *  - 連打は送る（間隔の下限は Node が counted で決める）。画面の反応（短く光る）は毎回同じ。
 *  - 内容は書かせない（外部化を避ける）。
 */
import type { TwoAiMarker } from '@llm-vap/contracts/browser_rpc';

/** 押したときに光る長さ（両条件で同じ）。 */
export const MARKER_FLASH_MS = 250;

export interface MarkerOptions {
  now?: () => number;
  newId?: () => string;
}

let markerCounter = 0;
function defaultMarkerId(): string {
  markerCounter += 1;
  return `mk_${Date.now().toString(36)}_${markerCounter}_${Math.random().toString(36).slice(2, 6)}`;
}

export class MarkerButton {
  private enabled = false;
  private flashUntil = -Infinity;
  /** 押した回数（送った数）。 */
  presses = 0;

  constructor(private readonly options: MarkerOptions = {}) {}

  private now(): number {
    return (this.options.now ?? (() => performance.now()))();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** 押した。discussion の外は null（送らない）。 */
  press(): TwoAiMarker | null {
    if (!this.enabled) return null;
    const now = this.now();
    this.flashUntil = now + MARKER_FLASH_MS;
    this.presses += 1;
    return { type: 'two_ai.marker', marker_id: (this.options.newId ?? defaultMarkerId)(), client_t_ms: Math.max(0, now) };
  }

  /** 光っているか。 */
  flashing(at: number = this.now()): boolean {
    return at < this.flashUntil;
  }
}
