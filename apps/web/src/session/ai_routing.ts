/**
 * 2 体のモードの振り分け（docs/design/two_ai/03 §2.5）。純粋な関数で、three に依存しない。
 *  - 再生の持ち主の表：playback.begin の ai_id を audio_playback_id で覚え、Worker の再生の報告（ai_id を持たない）を
 *    その AI のアバターへ渡す。
 *  - 口の音量：出力の RMS（AnalyserNode 1 つ）を、再生中の AI にだけ渡す。スケジューラは 1 本ずつ流すので再生中は 0 か 1 体。
 * ブラウザは判断しない：ai_id は Node が付ける。省略は 'A' として数える（gaze.command だけは「両方」。§4）。
 */
import type { AiId } from '@llm-vap/contracts/common';

export const AI_IDS: readonly AiId[] = ['A', 'B'];

/** 表に残す件数の上限。古い順に落とす。 */
export const PLAYBACK_OWNER_LIMIT = 64;

export function isAiId(value: unknown): value is AiId {
  return value === 'A' || value === 'B';
}

export class PlaybackOwnerTable {
  private readonly owners = new Map<number, AiId>();
  /** ai_id のない begin の数（'A' として扱った）。 */
  missingAiId = 0;
  /** 未知の ai_id の begin の数（捨てた）。 */
  unknownAiId = 0;

  constructor(private readonly fallback: AiId = 'A') {}

  /** playback.begin の ai_id を覚える。ai_id がなければ fallback を使って数える。未知の値は覚えずに null。 */
  noteBegin(message: { audio_playback_id: number; ai_id?: unknown }): AiId | null {
    let owner: AiId;
    if (message.ai_id === undefined) {
      owner = this.fallback;
      this.missingAiId += 1;
    } else if (isAiId(message.ai_id)) {
      owner = message.ai_id;
    } else {
      this.unknownAiId += 1;
      return null;
    }
    this.owners.delete(message.audio_playback_id);
    this.owners.set(message.audio_playback_id, owner);
    while (this.owners.size > PLAYBACK_OWNER_LIMIT) {
      const oldest = this.owners.keys().next().value as number;
      this.owners.delete(oldest);
    }
    return owner;
  }

  ownerOf(audio_playback_id: number): AiId | null {
    return this.owners.get(audio_playback_id) ?? null;
  }

  /** playback.ended で消す。 */
  forget(audio_playback_id: number): void {
    this.owners.delete(audio_playback_id);
  }

  get size(): number {
    return this.owners.size;
  }
}

/** 再生中の AI にだけ音量を渡す。再生中が 0 件なら両方 0（口を閉じる）。 */
export function routeMouthLevel(rms: number, playing: ReadonlySet<AiId>): Record<AiId, number> {
  return { A: playing.has('A') ? rms : 0, B: playing.has('B') ? rms : 0 };
}

/** gaze.command の宛先。ai_id がなければ両方、未知の値なら空（捨てて数える）。 */
export function gazeTargets(ai_id: unknown): AiId[] {
  if (ai_id === undefined) return [...AI_IDS];
  return isAiId(ai_id) ? [ai_id] : [];
}

/** 吸気などの指示の宛先。省略は 'A'（missing: true で数える）。未知の値は null。 */
export function commandTarget(ai_id: unknown): { ai_id: AiId; missing: boolean } | null {
  if (ai_id === undefined) return { ai_id: 'A', missing: true };
  return isAiId(ai_id) ? { ai_id, missing: false } : null;
}
