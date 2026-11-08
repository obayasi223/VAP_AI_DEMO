/**
 * 一連の動作の再生の台本（/dev/breath と browser_check/motion_series.ts が使う）。時刻は吸気の開始からの ms で、すべて暫定。
 * 録画や連続画像で比較するためのもの（自然さの判断は利用者が録画で行う）。
 * 発声は模擬の音量／口形で、音は鳴らさない。
 */
import type { BreathController } from './breath';

/** 短い準備の長さ（参加者画面の DEFERRED_SPEECH_PREP_MS と同じ値、暫定）。 */
export const SEQUENCE_SHORT_PREP_MS = 150;

export type MotionStep =
  | { atMs: number; do: 'inhale'; durationMs: number }
  | { atMs: number; do: 'speech_started' | 'deferred' | 'withdrawn' }
  | { atMs: number; do: 'prepare_short'; durationMs: number }
  /** 模擬の発声の開始／停止（再生の開始と停止に相当）。 */
  | { atMs: number; do: 'speak_start' | 'speak_stop' };

export interface MotionSequence {
  id: string;
  label: string;
  /** 動作の説明（画面に出す）。 */
  note: string;
  steps: MotionStep[];
  /** 全体の長さ（ms）。これ以降は idle に戻っている想定。 */
  totalMs: number;
}

const INHALE_MS = 700;

export const MOTION_SEQUENCES: readonly MotionSequence[] = [
  {
    id: 'speak',
    label: '吸気→保持→発声',
    note: '吸気のあと 300ms の保持を経て発声する（保持を挟む経路は文献の裏づけ外）',
    steps: [
      { atMs: 0, do: 'inhale', durationMs: INHALE_MS },
      { atMs: 1000, do: 'speech_started' },
      { atMs: 1000, do: 'speak_start' },
      { atMs: 3500, do: 'speak_stop' },
    ],
    totalMs: 4500,
  },
  {
    id: 'defer_speak',
    label: '吸気→延期→短い準備→発声',
    note: '延期の脱力の途中で許可が出て、再吸気せず短い準備だけで発声する',
    steps: [
      { atMs: 0, do: 'inhale', durationMs: INHALE_MS },
      { atMs: 900, do: 'deferred' },
      { atMs: 2400, do: 'prepare_short', durationMs: SEQUENCE_SHORT_PREP_MS },
      { atMs: 2550, do: 'speech_started' },
      { atMs: 2550, do: 'speak_start' },
      { atMs: 4500, do: 'speak_stop' },
    ],
    totalMs: 7000,
  },
  {
    id: 'defer_withdraw',
    label: '吸気→延期→撤回',
    note: '延期の途中で撤回する（残した準備を捨てて聞き手に戻る）',
    steps: [
      { atMs: 0, do: 'inhale', durationMs: INHALE_MS },
      { atMs: 900, do: 'deferred' },
      { atMs: 2200, do: 'withdrawn' },
    ],
    totalMs: 4200,
  },
  {
    id: 'withdraw_mid_inhale',
    label: '吸気の途中で撤回',
    note: '吸気の途中で撤回する（今の姿勢から聞き手に戻る）',
    steps: [
      { atMs: 0, do: 'inhale', durationMs: INHALE_MS },
      { atMs: 300, do: 'withdrawn' },
    ],
    totalMs: 2200,
  },
  {
    id: 'fail_no_audio',
    label: '発声の失敗（音声が来ない）',
    note: '発話開始を受けたが音声が来ない。Node の撤回で聞き手に戻る',
    steps: [
      { atMs: 0, do: 'inhale', durationMs: INHALE_MS },
      { atMs: 1000, do: 'speech_started' },
      { atMs: 1700, do: 'withdrawn' },
    ],
    totalMs: 4000,
  },
  {
    id: 'fail_midway',
    label: '発声の失敗（途中で止まる）',
    note: '発声が途中で止まり、Node の撤回で聞き手に戻る',
    steps: [
      { atMs: 0, do: 'inhale', durationMs: INHALE_MS },
      { atMs: 1000, do: 'speech_started' },
      { atMs: 1000, do: 'speak_start' },
      { atMs: 1800, do: 'speak_stop' },
      { atMs: 2000, do: 'withdrawn' },
    ],
    totalMs: 4500,
  },
];

export interface SequenceTarget {
  breath: BreathController;
  /** 模擬の発声の開始と停止。 */
  speak(active: boolean): void;
}

let sequenceCueCounter = 0;

/** 台本の1手を当てる。 */
export function applyMotionStep(target: SequenceTarget, step: MotionStep): void {
  switch (step.do) {
    case 'inhale':
      sequenceCueCounter += 1;
      target.breath.startInhale({ cue_id: `seq-${sequenceCueCounter}`, duration_ms: step.durationMs });
      return;
    case 'prepare_short':
      target.breath.prepareShort?.(step.durationMs);
      return;
    case 'speech_started':
    case 'deferred':
    case 'withdrawn':
      target.breath.release(step.do);
      return;
    case 'speak_start':
      target.speak(true);
      return;
    case 'speak_stop':
      target.speak(false);
      return;
  }
}
