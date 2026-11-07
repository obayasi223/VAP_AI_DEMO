/**
 * 視線の判断（原著 V-D、計画 §4.2）。発話権の移行の予測で判定し、人の意図の推定とは扱わない（I-6）。
 *
 * 向き（逆にしない）:
 *   VAP が「うっかり譲渡」しうると予測するポーズ（p が AI 側を支持しない）で視線を逸らす。
 *   譲渡されないと予測するポーズ（p が AI 側を支持する）では逸らさない。
 *
 * 原著に数値の閾値はなく、p_now と p_future のどちらで見るかも書かれていない。設定が null なら逸らさない。
 * 発話開始前に視線を逸らす動作は入れない（理由は docs/known_gaps.md）。吸気とは別の機能。
 *
 * 保持時間（原著にない、ちらつきの防止。docs/known_gaps.md §7）:
 *   - 逸らした後 hold_away_min_ms までは user へ戻さない（ポーズが短く終わって AI が話し続けた場合など）。
 *     ただし人が話している、割り込み中、AI の発話が終わった、VAP の鮮度切れ（既定の注視）のときは待たずに戻す。
 *     相手の発話や発話権の受け渡しへの反応を遅らせないため。
 *     保持は逸らしたポーズ（とその後の AI の発話）にだけ効かせる。保持中に次のポーズが始まったら、そのポーズの
 *     予測で判定し直し、移行が予測されなければ保持時間の途中でも user へ戻す（前のポーズの判断を持ち越さない）。
 *   - user へ戻した後 re_avert_min_ms までは再び逸らさない。戻す側に例外はないので、逸らす側にも例外を置かない。
 *   どちらも null なら保持しない（hri2025 は常に null で原著どおり）。
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

interface GazeArgs {
  settings: GazeSettings;
  ai_playing: boolean;
  interrupted: boolean;
  system_silence_ms: number;
  freshness: VapFreshness;
  view: VapView | null;
  user_speaking: boolean;
  previous_target: GazeTarget;
  now: number;
  /** previous_target になった時刻。null は初期状態から変わっていない。 */
  changed_at: number | null;
  /** 今のポーズで閾値との比較を既にしたか（TurnState.gaze_pause_logged）。偽で逸れていれば、逸らしたのは前のポーズ。 */
  pause_evaluated: boolean;
}

export function judgeGaze(args: GazeArgs): GazeJudgement {
  return applyHold(judgeByPrediction(args), args);
}

/** 保持時間を待たずに user へ戻す場合。 */
function returnsImmediately(args: GazeArgs): string | null {
  if (!args.ai_playing) return 'ai_not_speaking';
  if (args.interrupted) return 'ai_interrupted';
  if (args.user_speaking) return 'user_speaking';
  if (args.freshness !== 'fresh' || args.view === null) return `vap_${args.freshness}`;
  return null;
}

function applyHold(judgement: GazeJudgement, args: GazeArgs): GazeJudgement {
  if (judgement.target === args.previous_target || args.changed_at === null) return judgement;
  const elapsed = args.now - args.changed_at;
  if (judgement.target === 'user') {
    const min = args.settings.hold_away_min_ms;
    if (min === null || elapsed >= min) return judgement;
    // 新しいポーズで予測し直した結果は保持しない（保持は逸らしたポーズにだけ効かせる）。
    if (judgement.evaluated && !args.pause_evaluated) return judgement;
    const immediate = returnsImmediately(args);
    if (immediate !== null) {
      // 保持時間より優先した理由をログで分かるようにする（判定の理由が既にそれなら重ねない）。
      return judgement.reason.startsWith(immediate) ? judgement : { ...judgement, reason: `${immediate}:${judgement.reason}` };
    }
    return { ...judgement, target: 'away', reason: `hold_away_min_ms<${min}:${judgement.reason}` };
  }
  const min = args.settings.re_avert_min_ms;
  if (min === null || elapsed >= min) return judgement;
  return { ...judgement, target: 'user', reason: `re_avert_min_ms<${min}:${judgement.reason}` };
}

/** VAP の予測による判定（V-D）。保持時間は見ない。 */
function judgeByPrediction(args: GazeArgs): GazeJudgement {
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
  // 同じポーズの中で p が戻っても向きを行き来させない。前のポーズで逸らしたまま（保持中）なら予測し直す。
  if (args.previous_target === 'away' && args.pause_evaluated) {
    return { target: 'away', reason: 'pause_held_away', in_speech_pause, evaluated: true };
  }
  const p = signal === 'p_now' ? args.view.p_now_ai : args.view.p_future_ai;
  return p < p_threshold
    ? { target: 'away', reason: `pause_predicted_handover:${signal}<${p_threshold}`, in_speech_pause, evaluated: true }
    : user(`pause_no_handover_predicted:${signal}>=${p_threshold}`, true);
}
