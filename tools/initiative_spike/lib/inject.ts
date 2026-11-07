/**
 * 逐次 ASR へ誤認を人工的に入れる（C3 用）。実音声で都合よく誤認が起きるとは限らないので、
 * 実 ASR の時刻と形を保ったまま、該当の語だけを別の語にする。注入したことは出力の provider に残す。
 *  - unstable: 誤った語は未安定の部分にしか現れない。
 *  - stable: 誤った語が一度 0.9 になる。hold_ms の後の結果と final で正しい語に戻る。
 */
import { splitInterimParts } from '@llm-vap/contracts';
import type { SttPart } from '@llm-vap/contracts';
import type { SttEvent } from '../../../apps/orchestrator/src/cognition/initiative/transcript_view';
import type { InjectSpec } from './project';

/** 安定の範囲が誤った語を含まないよう、その語の前で切る。 */
function demoteFrom(parts: readonly SttPart[], word: string): SttPart[] {
  const low = { value: 0.01 };
  const out: SttPart[] = [];
  let demoted = false;
  for (const part of parts) {
    if (demoted) {
      out.push({ text: part.text, stability: low });
      continue;
    }
    const at = part.text.indexOf(word);
    if (at < 0) {
      out.push(part);
      continue;
    }
    demoted = true;
    if (at > 0) out.push({ text: part.text.slice(0, at), stability: part.stability });
    out.push({ text: part.text.slice(at), stability: low });
  }
  return out;
}

export function injectMisrecognition(events: readonly SttEvent[], spec: InjectSpec, min_stability: number): SttEvent[] {
  const firstAt = events.find((e) => e.event === 'stt.interim' && e.text.includes(spec.correct))?.t_monotonic_ms;
  if (firstAt === undefined) {
    throw new Error(`「${spec.correct}」が interim に見つかりません。実際の認識結果の表記を --correct に指定してください。`);
  }
  return events.map((event) => {
    if (event.event !== 'stt.interim') return { ...event, provider: `${event.provider}+injected_misrecognition` };
    const inWindow = event.t_monotonic_ms >= firstAt && event.t_monotonic_ms < firstAt + spec.hold_ms;
    let parts: SttPart[] = event.parts;
    if (inWindow) {
      parts = parts.map((p) => ({ ...p, text: p.text.split(spec.correct).join(spec.wrong) }));
      if (spec.stage === 'unstable') parts = demoteFrom(parts, spec.wrong);
    }
    const split = splitInterimParts(parts, min_stability);
    return {
      ...event,
      provider: `${event.provider}+injected_misrecognition`,
      parts,
      text: split.text,
      stable_text: split.stable_text,
      unstable_text: split.unstable_text,
      stability: split.stability,
    };
  });
}
