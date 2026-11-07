/**
 * 方策から制御の設定を取り出す。方策の形の違いはここで吸収する。
 * 準備の閾値は prepareThresholds() だけから読む（docs/known_gaps.md §1）。
 */
import { prepareThresholds, turnConstants, turnInterpretation } from '@llm-vap/contracts';
import type { Policy, PrepareThresholds, TurnConstants, TurnInterpretation } from '@llm-vap/contracts';
import { vapDirectionSettings } from './vap_direction';
import type { VapDirectionSettings } from './vap_direction';

/**
 * hri2025 の方策にない運用の値。Appendix A にない項目で、計画 §4.1 の【暫定】値に揃えた。
 * 原著の再現の根拠にはしない。
 */
const HRI2025_RUNTIME = { tick_ms: 20, vap_stale_ms: 500, vap_rewarm_ms: 10000 } as const;

/**
 * start_speech の後、再生の報告が届くまでを「話し始め」として扱う上限。【暫定】方策に項目がないのでコードで持つ。
 * 超えたら開始されなかったとみなす（SpeechGenerator が開始を拒否した場合など）。
 */
export const START_ACK_TIMEOUT_MS = 1000;

export interface YieldTimeout {
  threshold: number;
  timeout_ms: number;
}

export interface GazeSettings {
  pause_min_ms: number | null;
  signal: 'p_now' | 'p_future' | null;
  p_threshold: number | null;
}

export interface ControlOptions {
  /**
   * fallback_energy を無音とみなす上限。契約に単位と閾値の項目がないので、J が尺度を決めるまで外から渡す。
   * null の間は fallback_energy による開始と割り込みをしない（契約への要望に記載）。
   */
  fallback_energy_silence_threshold?: number | null;
}

export interface ControlSettings {
  policy_id: string;
  constants: TurnConstants;
  interpretation: TurnInterpretation;
  /** U 項目の補正を入れるか。 */
  corrected: boolean;
  prepare: PrepareThresholds;
  /** L88 の順（閾値の降順）。 */
  yield_timeouts: YieldTimeout[];
  direction: VapDirectionSettings;
  tick_ms: number;
  /** interrupt_speech.max_wait_ms。immediate は 0。 */
  stop_max_wait_ms: number;
  vap_stale_ms: number;
  vap_rewarm_ms: number;
  user_speaking_min_ms: number | null;
  fallback_silence_max_ms: number | null;
  fallback_interrupt_min_words: number | null;
  fallback_energy_silence_threshold: number | null;
  gaze: GazeSettings;
  /** 招待で発話を許可するか。招待は原著にないので hri2025 では検出して記録するだけ。 */
  invitation_grants_turn: boolean;
}

function sortedYieldTimeouts(constants: TurnConstants): YieldTimeout[] {
  return Object.entries(constants.YIELD_TIMEOUTS_MS)
    .map(([threshold, timeout_ms]) => ({ threshold: Number(threshold), timeout_ms }))
    .sort((a, b) => b.threshold - a.threshold);
}

export function controlSettings(policy: Policy, options: ControlOptions = {}): ControlSettings {
  const constants = turnConstants(policy);
  const interpretation = turnInterpretation(policy);
  const common = {
    policy_id: policy.policy_id,
    constants,
    interpretation,
    corrected: interpretation.apply_u_corrections,
    prepare: prepareThresholds(policy),
    yield_timeouts: sortedYieldTimeouts(constants),
    direction: vapDirectionSettings(policy),
    fallback_energy_silence_threshold: options.fallback_energy_silence_threshold ?? null,
  };
  if (policy.policy_id === 'hri2025') {
    return {
      ...common,
      ...HRI2025_RUNTIME,
      stop_max_wait_ms: 0,
      user_speaking_min_ms: null,
      fallback_silence_max_ms: null,
      fallback_interrupt_min_words: null,
      // 原著に数値がなく、方策に gaze の節もない（hri2025_mapping の V-D）。
      gaze: { pause_min_ms: null, signal: null, p_threshold: null },
      invitation_grants_turn: false,
    };
  }
  return {
    ...common,
    tick_ms: policy.turn.tick_ms,
    stop_max_wait_ms: interpretation.stop_point === 'immediate' ? 0 : policy.turn.stop_boundary_max_ms,
    vap_stale_ms: policy.turn.vap_stale_ms,
    vap_rewarm_ms: policy.turn.vap_rewarm_ms,
    user_speaking_min_ms: policy.turn.user_speaking_min_ms,
    fallback_silence_max_ms: policy.turn.fallback_silence_max_ms,
    fallback_interrupt_min_words: policy.turn.fallback_interrupt_min_words,
    gaze: policy.gaze,
    invitation_grants_turn: true,
  };
}
