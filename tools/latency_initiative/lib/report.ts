/** 候補ごとの遅延の表と中央値。実会話の本文は扱わない。 */
import type { CandidateLatency, Section } from './analyze';

export const SECTION_KEYS = [
  'audio_to_asr_est',
  'asr_to_desire_sent',
  'desire_llm',
  'timing_llm',
  'timing_redecision_wait',
  'decision_to_signal_sent',
  'signal_sent_to_render',
  'spoken_to_rendered_est',
] as const satisfies readonly (keyof CandidateLatency['sections'])[];

const SECTION_LABELS: Record<(typeof SECTION_KEYS)[number], string> = {
  audio_to_asr_est: '音声→ASR(推定)',
  asr_to_desire_sent: 'ASR→希望送信',
  desire_llm: '希望LLM',
  timing_llm: 'タイミングLLM',
  timing_redecision_wait: '再判定待ち',
  decision_to_signal_sent: '判定→signal.sent',
  signal_sent_to_render: 'sent→描画',
  spoken_to_rendered_est: '音声→描画(推定)',
};

export interface SectionSummary {
  median_ms: number | null;
  /** 中央値に入れた候補の数（値があり、時間軸の異常でないもの）。 */
  n: number;
  /** 値がない候補の理由と数。 */
  null_reasons: Record<string, number>;
}

export interface LatencySummary {
  n_candidates: number;
  n_render_suspect: number;
  sections: Record<(typeof SECTION_KEYS)[number], SectionSummary>;
  cue_landing: {
    n_mid_speech: number;
    n_known: number;
    /** 話し続けた時間の中央値（合図が話している最中に描画された候補のみ）。 */
    continued_median_ms: number | null;
    continued_n: number;
    brief_dips_median: number | null;
  };
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

function usable(section: Section): number | null {
  // null_reason があれば値があっても（時間軸の異常）集計に入れない。
  return section.value_ms !== null && section.null_reason === null ? section.value_ms : null;
}

export function summarize(rows: readonly CandidateLatency[]): LatencySummary {
  const sections = {} as LatencySummary['sections'];
  for (const key of SECTION_KEYS) {
    const values: number[] = [];
    const null_reasons: Record<string, number> = {};
    for (const row of rows) {
      const section = row.sections[key];
      const value = usable(section);
      if (value !== null) values.push(value);
      else {
        const reason = section.null_reason ?? 'unknown';
        null_reasons[reason] = (null_reasons[reason] ?? 0) + 1;
      }
    }
    sections[key] = { median_ms: median(values), n: values.length, null_reasons };
  }
  const known = rows.filter((r) => r.cue_landing.user_speaking !== null);
  const mid = known.filter((r) => r.cue_landing.user_speaking === true);
  const continued = mid.flatMap((r) => (r.cue_landing.continued_ms === null ? [] : [r.cue_landing.continued_ms]));
  return {
    n_candidates: rows.length,
    n_render_suspect: rows.filter((r) => r.render.suspect).length,
    sections,
    cue_landing: {
      n_mid_speech: mid.length,
      n_known: known.length,
      continued_median_ms: median(continued),
      continued_n: continued.length,
      brief_dips_median: median(mid.map((r) => r.cue_landing.brief_dips)),
    },
  };
}

function ms(value: number | null): string {
  return value === null ? '-' : String(Math.round(value));
}

function cell(section: Section): string {
  if (section.value_ms === null) return '-';
  return section.null_reason === null ? String(Math.round(section.value_ms)) : `(${Math.round(section.value_ms)})`;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function table(header: string[], lines: string[][]): string {
  const widths = header.map((h, i) => Math.max(h.length, ...lines.map((l) => (l[i] as string).length)));
  const render = (row: string[]) => row.map((c, i) => pad(c, widths[i] as number)).join('  ').trimEnd();
  return [render(header), ...lines.map(render)].join('\n');
}

export function formatReport(rows: readonly CandidateLatency[], summary: LatencySummary): string {
  const header = ['session', 'candidate', 'timing', ...SECTION_KEYS.map((k) => SECTION_LABELS[k]), '話中', '話続ms', '小dip', '終わり'];
  const lines = rows.map((r) => [
    r.session_id.slice(-6),
    r.candidate_id,
    r.timing_strategy,
    ...SECTION_KEYS.map((k) => cell(r.sections[k])),
    r.cue_landing.user_speaking === null ? '?' : r.cue_landing.user_speaking ? 'yes' : 'no',
    ms(r.cue_landing.continued_ms),
    String(r.cue_landing.brief_dips),
    r.cue_landing.ended_by ?? r.cue_landing.continued_null_reason ?? '-',
  ]);
  const summaryHeader = ['区間', 'median_ms', 'n', 'null の内訳'];
  const summaryLines = SECTION_KEYS.map((k) => {
    const s = summary.sections[k];
    const reasons = Object.entries(s.null_reasons)
      .map(([reason, count]) => `${reason}:${count}`)
      .join(', ');
    return [SECTION_LABELS[k], ms(s.median_ms), String(s.n), reasons || '-'];
  });
  const landing = summary.cue_landing;
  return [
    `候補（合図が送られたもの）: ${summary.n_candidates}、時間軸の異常の疑い: ${summary.n_render_suspect}`,
    '括弧つきの値は時間軸の異常の疑いがあり中央値に入れない。推定の区間は vap.state の時刻で写した音声の時刻を使う。',
    '',
    table(header, lines),
    '',
    table(summaryHeader, summaryLines),
    '',
    `話の途中に描画された候補: ${landing.n_mid_speech}/${landing.n_known}、話し続けた時間の中央値 ${ms(landing.continued_median_ms)}ms (n=${landing.continued_n})、短い無音の中央値 ${ms(landing.brief_dips_median)}`,
    '',
  ].join('\n');
}
