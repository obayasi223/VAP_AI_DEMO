/**
 * 視線の判断（原著 V-D、計画 §4.2）。発話権の移行の予測で判定し、人の意図の推定とは扱わない（I-6）。
 *
 * 向き（逆にしない）:
 *   VAP が「うっかり譲渡」しうると予測するポーズ（p が AI 側を支持しない）で視線を逸らす。
 *   譲渡されないと予測するポーズ（p が AI 側を支持する）では逸らさない。
 *
 * 原著に数値の閾値はなく、p_now と p_future のどちらで見るかも書かれていない。設定が null なら逸らさない。
 * 発話開始前に視線を逸らす動作は入れない（理由は docs/known_gaps.md）。吸気とは別の機能。
 */
import type { GazeTarget, VapFreshness } from '@llm-vap/contracts';
import type { GazeSettings } from './settings';
import type { VapView } from './vap_direction';

export interface GazeJudgement {
  target: GazeTarget;
  reason: string;
  /** AI 発話中のポーズ（system チャネルの無音）か。 */
  in_speech_pause: boolean;
  /** 閾値と比べたポーズか。譲渡なしの判定も1回ログへ残すのに使う。 */
  evaluated: boolean;
}

export function judgeGaze(args: {
  settings: GazeSettings;
  ai_playing: boolean;
  interrupted: boolean;
  system_silence_ms: number;
  freshness: VapFreshness;
  view: VapView | null;
  user_speaking: boolean;
  previous_target: GazeTarget;
}): GazeJudgement {
  const in_speech_pause = args.ai_playing && args.system_silence_ms > 0;
  const user = (reason: string, evaluated = false): GazeJudgement => ({
    target: 'user',
    reason,
    in_speech_pause,
    evaluated,
  });
  if (!args.ai_playing) return user('ai_not_speaking');
  if (args.interrupted) return user('ai_interrupted');
  if (!in_speech_pause) return user('not_in_speech_pause');
  // 鮮度切れでは既定の注視へ戻す（計画 §4.1 の表）。
  if (args.freshness !== 'fresh' || args.view === null) return user(`vap_${args.freshness}_default_gaze`);
  const { pause_min_ms, signal, p_threshold } = args.settings;
  if (pause_min_ms === null || signal === null || p_threshold === null) return user('gaze_uncalibrated');
  if (args.system_silence_ms < pause_min_ms) return user('pause_shorter_than_min');
  if (args.user_speaking) return user('user_speaking_in_pause');
  // 同じポーズの中で p が戻っても向きを行き来させない。
  if (args.previous_target === 'away') {
    return { target: 'away', reason: 'pause_held_away', in_speech_pause, evaluated: true };
  }
  const p = signal === 'p_now' ? args.view.p_now_ai : args.view.p_future_ai;
  return p < p_threshold
    ? { target: 'away', reason: `pause_predicted_handover:${signal}<${p_threshold}`, in_speech_pause, evaluated: true }
    : user(`pause_no_handover_predicted:${signal}>=${p_threshold}`, true);
}
