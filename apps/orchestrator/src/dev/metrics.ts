/**
 * 調整画面の指標（記録と再計算の両方に同じ定義で当てる）。定義は docs/runbook.md の「調整画面」の節と同じ。
 *
 *  - starts: AI が話し始めた回数（TurnManager の start_speech）。
 *  - mid_utterance_starts: 開始の時刻 T から 1.5 秒以内に届いた利用者の STT 結果のうち、音声位置（audio_frame_end）が
 *    T より後で、同じ ASR 区間の文が伸びたもの（新しい区間なら文があるもの）が1件でもある開始。
 *    「利用者の同じ発話の続きが来た」の近似。STT は AI の開始で区間を切るので、区間の同一性ではなく音声位置で見る。
 *  - mid_utterance_starts_vad: 参考。同じ窓に VAP の vad[0] が閾値以上になった開始。
 *  - delays_ms: 開始ごとに、利用者の声（vad[0] が閾値以上の vap.state）の最後から T まで（30 秒以内になければ null）。
 *  - consecutive_ai_starts: 前の AI の発話が終わってから T まで、利用者の声（vad[0] が閾値以上）が一度もない開始。
 *  - gaze_averts／gaze_avert_ms: 視線を逸らした回数と、user へ戻るまでの長さ。
 *
 * 再計算では利用者の振る舞いが記録のままなので、AI の開始が変わった後の値は反実仮想の近似。
 */
import type { TuneGazeChange, TuneMetricSet, TuneSpan, TuneStart } from '@llm-vap/contracts';
import { continuationAfter } from '../control/turn_outcome';

export const MID_UTTERANCE_WINDOW_MS = 1500;
const DELAY_LOOKBACK_MS = 30_000;

export interface MetricInputs {
  starts: TuneStart[];
  ai_speech: TuneSpan[];
  gaze: TuneGazeChange[];
  interrupts: number;
  vap: { t: number; vad_user: number }[];
  stt: { t: number; key: number; audio_frame_end: number; text: string }[];
  frameAt: (t: number) => number;
  speaking_threshold: number;
  t_end: number;
}

function voicedBetween(vap: MetricInputs['vap'], from: number, to: number, threshold: number): boolean {
  return vap.some((v) => v.t > from && v.t <= to && v.vad_user >= threshold);
}

function lastVoicedBefore(vap: MetricInputs['vap'], t: number, threshold: number): number | null {
  let last: number | null = null;
  for (const v of vap) {
    if (v.t > t) break;
    if (v.vad_user >= threshold) last = v.t;
  }
  return last !== null && t - last <= DELAY_LOOKBACK_MS ? last : null;
}

export function midUtterance(input: Pick<MetricInputs, 'stt' | 'frameAt'>, t: number): boolean {
  return continuationAfter(input.stt, input.frameAt(t), t, MID_UTTERANCE_WINDOW_MS).continued;
}

export function computeMetrics(input: MetricInputs): TuneMetricSet {
  const thr = input.speaking_threshold;
  const vap = [...input.vap].sort((a, b) => a.t - b.t);
  const stt = [...input.stt].sort((a, b) => a.t - b.t);
  let mid = 0;
  let midVad = 0;
  let consecutive = 0;
  const delays: (number | null)[] = [];
  const speech = [...input.ai_speech].sort((a, b) => a.start - b.start);
  for (const start of input.starts) {
    const t = start.t;
    if (midUtterance({ stt, frameAt: input.frameAt }, t)) mid += 1;
    if (voicedBetween(vap, t, t + MID_UTTERANCE_WINDOW_MS, thr)) midVad += 1;
    const last = lastVoicedBefore(vap, t, thr);
    delays.push(last === null ? null : Math.round(t - last));
    const previous = speech.filter((s) => s.end <= t).at(-1);
    if (previous !== undefined && !voicedBetween(vap, previous.end, t, thr)) consecutive += 1;
  }
  let averts = 0;
  const avertMs: number[] = [];
  let awaySince: number | null = null;
  let target = 'user';
  for (const g of [...input.gaze].sort((a, b) => a.t - b.t)) {
    if (g.target === target) continue;
    if (g.target === 'away') {
      averts += 1;
      awaySince = g.t;
    } else if (awaySince !== null) {
      avertMs.push(Math.round(g.t - awaySince));
      awaySince = null;
    }
    target = g.target;
  }
  return {
    starts: input.starts.length,
    mid_utterance_starts: mid,
    mid_utterance_starts_vad: midVad,
    delays_ms: delays,
    consecutive_ai_starts: consecutive,
    gaze_averts: averts,
    gaze_avert_ms: avertMs,
    interrupts: input.interrupts,
  };
}
