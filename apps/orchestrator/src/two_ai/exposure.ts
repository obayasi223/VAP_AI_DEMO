/**
 * 点の接触秒数と、発話ごとの「新しい部分」（docs/design/two_ai/01 §3.9、06 §6.0、§4.3 の point_exposure）。純粋関数。
 *
 * - 総量：samples_written ÷ 16（16kHz）。
 * - 新しい部分：総量から、resume の先頭の戻りの句（bridge_chars）と言い直した部分（restated_chars）の再生時間を引く。
 *   時間は alignment（文字ごとの終わりの時刻）で、なければ文字数の比 × played_ms。再生が届かなかった分は届いた所まで。
 * - 中身の時計に足す長さ（content_ms）：中身のターン（discussion、point、point_elaboration）は played_ms、resume は new_ms、ほかは 0（bridge も 0）。
 */
import type { TwoAiTurnKind } from '@llm-vap/contracts';

export const SAMPLES_PER_MS = 16;

export const CONTENT_TURN_KINDS: ReadonlySet<TwoAiTurnKind> = new Set(['discussion', 'point', 'point_elaboration']);

export function playedMsOf(samples_written: number): number {
  return Math.max(0, Math.round(samples_written / SAMPLES_PER_MS));
}

export interface RepeatShare {
  bridge_ms: number;
  repeated_ms: number;
  new_ms: number;
  source: 'alignment' | 'char_ratio' | 'none';
}

/**
 * alignment_end_ms：文字 i（0 始まり）の終わりの時刻（再生の先頭から ms）。届いた所までの配列でよい。
 * total_chars：その発話の文字数（文字数の比の分母）。
 */
export function repeatShare(input: {
  played_ms: number;
  repeat: { bridge_chars: number; restated_chars: number } | null;
  total_chars: number;
  alignment_end_ms: readonly number[] | null;
}): RepeatShare {
  const { played_ms, repeat } = input;
  if (repeat === null || repeat.bridge_chars + repeat.restated_chars === 0) {
    return { bridge_ms: 0, repeated_ms: 0, new_ms: played_ms, source: 'none' };
  }
  const bridgeEnd = repeat.bridge_chars;
  const restEnd = repeat.bridge_chars + repeat.restated_chars;
  const at = (chars: number): { ms: number; source: 'alignment' | 'char_ratio' } => {
    if (chars <= 0) return { ms: 0, source: 'alignment' };
    const a = input.alignment_end_ms;
    if (a !== null && a.length >= chars) return { ms: Math.min(played_ms, a[chars - 1] as number), source: 'alignment' };
    if (a !== null && a.length > 0 && a.length < chars) {
      // 語の時刻は届いた所まで。その先まで再生していなければ played_ms で切る。
      const last = a[a.length - 1] as number;
      if (last >= played_ms) return { ms: played_ms, source: 'alignment' };
    }
    const total = Math.max(1, input.total_chars);
    return { ms: Math.min(played_ms, (chars / total) * played_ms), source: 'char_ratio' };
  };
  const b = at(bridgeEnd);
  const r = at(restEnd);
  const bridge_ms = Math.round(b.ms);
  const repeated_ms = Math.max(0, Math.round(r.ms) - bridge_ms);
  const source = b.source === 'char_ratio' || r.source === 'char_ratio' ? 'char_ratio' : 'alignment';
  return { bridge_ms, repeated_ms, new_ms: Math.max(0, played_ms - bridge_ms - repeated_ms), source };
}

/** 中身の時計に足す長さ（06 §6.0）。gap_hint_ms は進行役が足す。 */
export function contentMsOf(turn_kind: TwoAiTurnKind, played_ms: number, new_ms: number): number {
  if (CONTENT_TURN_KINDS.has(turn_kind)) return played_ms;
  if (turn_kind === 'resume') return new_ms;
  return 0;
}

/** 点に数える発話か（受け止め、uptake、段の台詞、作り直し、撤回、bridge は数えない）。 */
export function countsForPoint(turn_kind: TwoAiTurnKind, point_id: string | null): boolean {
  return point_id !== null && (turn_kind === 'point' || turn_kind === 'point_elaboration' || turn_kind === 'resume');
}

export interface ExposureSegment {
  audio_playback_id: number;
  turn_id: string;
  turn_kind: TwoAiTurnKind;
  played_ms: number;
  new_ms: number;
  bridge_ms: number;
  repeated_ms: number;
  repeated_source: 'alignment' | 'char_ratio' | 'none';
  cut: 'none' | 'interjection' | 'woz' | 'session_end' | 'correction';
  variant: 'original' | 'corrected';
}

/** 点の集計（two_ai.point_exposure の数の部分）。 */
export function summarizeExposure(segments: readonly ExposureSegment[]): {
  exposure_total_ms: number;
  exposure_new_ms: number;
  bridge_ms: number;
  repeated_ms: number;
  repeated_ms_source: 'alignment' | 'char_ratio' | 'none';
} {
  let total = 0;
  let fresh = 0;
  let bridge = 0;
  let repeated = 0;
  let source: 'alignment' | 'char_ratio' | 'none' = 'none';
  for (const s of segments) {
    total += s.played_ms;
    fresh += s.new_ms;
    bridge += s.bridge_ms;
    repeated += s.repeated_ms;
    if (s.repeated_source === 'char_ratio') source = 'char_ratio';
    else if (s.repeated_source === 'alignment' && source === 'none') source = 'alignment';
  }
  return { exposure_total_ms: total, exposure_new_ms: fresh, bridge_ms: bridge, repeated_ms: repeated, repeated_ms_source: source };
}
