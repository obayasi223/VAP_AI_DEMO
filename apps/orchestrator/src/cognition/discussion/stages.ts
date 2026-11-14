/**
 * 4 段の見出しと拍の段への割り当て（02 §2.1、§3.3、06 §9.4）。
 * 段 1〜3 は optional を持たない（段の境界が拍の数で決まり、① と ② で同じ）。optional は段 4 だけ。
 */
import type { TwoAiScript, TwoAiSessionConfig } from '@llm-vap/contracts';
import type { Beat } from './types';

/** 段ごとの拍の数の目安（wp0_notes S1 と同じ式）。 */
export function beatsPerStage(config: TwoAiSessionConfig): [number, number, number, number] {
  const d = config.phases.discussion;
  return d.stage_fracs.map((f) => Math.max(1, Math.round((d.target_sec * f) / d.avg_turn_sec_estimate))) as [number, number, number, number];
}

export function stageBeatCounts(beats: readonly Beat[]): [number, number, number, number] {
  const counts: [number, number, number, number] = [0, 0, 0, 0];
  for (const b of beats) counts[b.stage - 1] = (counts[b.stage - 1] ?? 0) + 1;
  return counts;
}

export function stageHeadingsOf(script: TwoAiScript | null, config: TwoAiSessionConfig): [string, string, string, string] {
  return script?.stages ?? config.fixed.stage_headings;
}

/** 段の割り当ての検査。理由の配列（空なら合格）。 */
export function checkStages(beats: readonly Beat[]): string[] {
  const reasons: string[] = [];
  const counts = stageBeatCounts(beats);
  counts.forEach((n, i) => {
    if (n === 0) reasons.push(`stage ${i + 1} has no beat`);
  });
  for (let i = 1; i < beats.length; i++) {
    if (beats[i]!.stage < beats[i - 1]!.stage) reasons.push(`beat ${beats[i]!.beat_id}: stage goes back`);
  }
  for (const b of beats) if (b.optional && b.stage !== 4) reasons.push(`beat ${b.beat_id}: optional outside stage 4`);
  const last4 = beats.filter((b) => b.stage === 4).at(-1);
  if (last4 !== undefined && last4.optional) reasons.push('last beat of stage 4 must not be optional');
  return reasons;
}

/** 見出しに C の語と取り違えの値を含めない。 */
export function checkHeadings(headings: readonly string[], forbidden: readonly string[]): string[] {
  const reasons: string[] = [];
  for (const h of headings) for (const f of forbidden) if (f !== '' && h.includes(f)) reasons.push(`heading contains forbidden text: ${f}`);
  return reasons;
}
