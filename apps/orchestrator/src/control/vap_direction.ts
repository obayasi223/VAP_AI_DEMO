/**
 * p の向きの変換はこのファイルだけに置く（計画 §4.1）。他のファイルは p_now[...] を添字で読まない。
 *
 * R2 の最終報告で確定（docs/maai_validation.md §1）。根拠は次の実測（workers/maai/probes/results/、読むだけ）:
 *  - direction_jp_kyoto_normal-ver2_12.5hz_mc.json と direction_timeseries.png: ch1 のみの発話で p_now[0] が約 0.92〜0.96、
 *    ch2 のみの発話で p_now[1] が約 0.94〜0.97。話者を入れ替えても、素材の左右を反転しても添字はチャネルに従う。
 *    これは公式 sample から作った音声で、実対話の性能ではない。
 *  - 確認できるのは「添字 i はチャネル i の話者の予測」まで。AI を ch2 に置くのは契約（vap.ts の「ch1=mic, ch2=sys」）で、
 *    B と J の実物の配線はまだ確認していない。
 * この向きなら p_ai が高いほど AI が話すと予測され、Appendix A の L59（p<0.4 で割り込み）、L66（p>0.5 で譲渡）と合う。
 */
import type { Policy, Vap2chState } from '@llm-vap/contracts';

/** vap.ts の vad の順（ch1=mic, ch2=sys）。 */
const VAD_USER_INDEX = 0;

/** hri2025 の方策には vap の節がないので、向きをここで持つ。ja は policy.vap.p_ai_index を読む。 */
export const HRI2025_P_AI_INDEX = 1 as const;

export interface VapDirectionSettings {
  p_ai_index: 0 | 1;
  /** null は MaAI ワーカーが判定した user_speaking を使う（hri2025 に閾値の設定がないため）。 */
  speaking_threshold: number | null;
  direction_status: 'provisional' | 'measured';
}

export function vapDirectionSettings(policy: Policy): VapDirectionSettings {
  if (policy.policy_id === 'hri2025') {
    return { p_ai_index: HRI2025_P_AI_INDEX, speaking_threshold: null, direction_status: 'measured' };
  }
  return {
    p_ai_index: policy.vap.p_ai_index,
    speaking_threshold: policy.vap.speaking_threshold,
    direction_status: policy.vap.direction_status,
  };
}

/** TurnManager が使う VAP の値。すべて AI 側に揃えた後の値。 */
export interface VapView {
  /** Appendix A の p_now。高いほど AI が話すと予測。 */
  p_now_ai: number;
  /** Appendix A の p_fut。 */
  p_future_ai: number;
  /** Appendix A の user_is_speaking（生の値）。 */
  user_speaking: boolean;
}

/** vad の人の側（吸気の後の短い声の切れ目の判定）。添字はこのファイルだけ。 */
export function readVadUser(vap: Vap2chState): number {
  return vap.vad[VAD_USER_INDEX];
}

export function readVap(vap: Vap2chState, direction: VapDirectionSettings): VapView {
  return {
    p_now_ai: vap.p_now[direction.p_ai_index],
    p_future_ai: vap.p_future[direction.p_ai_index],
    user_speaking:
      direction.speaking_threshold === null
        ? vap.user_speaking
        : vap.vad[VAD_USER_INDEX] >= direction.speaking_threshold,
  };
}
