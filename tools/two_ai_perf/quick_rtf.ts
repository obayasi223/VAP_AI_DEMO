// WP3c 早い性能の確認（docs/design/two_ai/03 §6、05 §5.2、04 の表の quick_rtf.ts）。
// 研究者が Windows の Chrome で、描画なし／1 体／2 体の描画中の MaAI の RTF を測るための手順と集計。合否ではなく決定の材料。
//
//   npx tsx tools/two_ai_perf/quick_rtf.ts --steps
//       測り方の手順を出す。
//   npx tsx tools/two_ai_perf/quick_rtf.ts none=<events.jsonl|dir> one=<events.jsonl|dir> two=<events.jsonl|dir> [--json]
//       ラベルごとに、Worker の audio.health の rtf と、ブラウザの render.health（2 体のページのとき）を集計する。
//
// 集計の値：RTF の中央値と p95（予算 RTF p95 < 0.7 との差）、render.health の fps の中央値・p5、フレーム時間 p95、long task の合計。
// SwiftShader（ソフトウェア描画）の値は実機の GPU の値ではない（render.health の renderer に出る。結果に注記する）。
// 終了コード: 0 集計できた、2 使い方の誤りか読めない。
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** 既存の暫定基準（docs/maai_validation.md、03 §6 の予算）。 */
export const RTF_P95_BUDGET = 0.7;

export interface QuickRtfSummary {
  label: string;
  rtf: { n: number; p50: number | null; p95: number | null; over_budget_by: number | null };
  render: {
    n: number;
    fps_median: number | null;
    fps_p5_min: number | null;
    frame_ms_p95_max: number | null;
    long_tasks: number;
    renderers: string[];
    avatars: number[];
    software_renderer: boolean;
  };
}

function quantile(values: number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index] as number;
}

/** events.jsonl の行（検証はしない。古いログも読む）から集計する。 */
export function summarizeQuickRtf(label: string, events: readonly Record<string, unknown>[]): QuickRtfSummary {
  const rtfs: number[] = [];
  const fpsMedians: number[] = [];
  const fpsP5: number[] = [];
  const frameP95: number[] = [];
  const renderers = new Set<string>();
  const avatars = new Set<number>();
  let longTasks = 0;
  let renderN = 0;
  for (const event of events) {
    if (event.event === 'audio.health' && event.reporter === 'worker') {
      const value = (event.rtf as { value?: unknown } | undefined)?.value;
      if (typeof value === 'number' && Number.isFinite(value)) rtfs.push(value);
    } else if (event.event === 'render.health') {
      renderN += 1;
      if (typeof event.fps_median === 'number') fpsMedians.push(event.fps_median);
      if (typeof event.fps_p5 === 'number') fpsP5.push(event.fps_p5);
      if (typeof event.frame_ms_p95 === 'number') frameP95.push(event.frame_ms_p95);
      if (typeof event.long_tasks === 'number') longTasks += event.long_tasks;
      if (typeof event.renderer === 'string') renderers.add(event.renderer);
      if (typeof event.avatars === 'number') avatars.add(event.avatars);
    }
  }
  const p95 = quantile(rtfs, 0.95);
  return {
    label,
    rtf: { n: rtfs.length, p50: quantile(rtfs, 0.5), p95, over_budget_by: p95 === null ? null : p95 - RTF_P95_BUDGET },
    render: {
      n: renderN,
      fps_median: quantile(fpsMedians, 0.5),
      fps_p5_min: fpsP5.length === 0 ? null : Math.min(...fpsP5),
      frame_ms_p95_max: frameP95.length === 0 ? null : Math.max(...frameP95),
      long_tasks: longTasks,
      renderers: [...renderers],
      avatars: [...avatars].sort(),
      software_renderer: [...renderers].some((r) => /swiftshader|llvmpipe|software/i.test(r)),
    },
  };
}

export const STEPS = [
  '1. 研究者の Windows の PC（GPU あり）で、Node（orchestrator）と MaAI を通常どおり起動する。利用者の 3000／8787 をそのまま使ってよい（この道具はサーバーを起動しない）。',
  '2. MaAI に既存の 2ch の素材を流す（docs/maai_validation.md の G0 と同じ素材。sessions/ の録音は使わない）。',
  '3. 同じ条件で 3 回、各 2〜3 分：',
  '   none … /two_ai?avatar_a=none&avatar_b=none（描画なし）',
  '   one  … /two_ai?avatar_b=none（1 体）',
  '   two  … /two_ai（2 体、既定 30 fps の上限）',
  '   必要なら ?fps=24 も測る（03 §6 の段階 ①）。',
  '4. 各回の events.jsonl（セッションのディレクトリ）を控え、この道具に none=… one=… two=… で渡す。',
  '5. 出力の RTF p95 と予算 0.7 の差、fps、フレーム時間 p95、long task を 05 §9 の 1・8 の決定の材料にする（合否ではない）。',
];

function readEvents(target: string): Record<string, unknown>[] {
  const path = existsSync(target) && statSync(target).isDirectory() ? join(target, 'events.jsonl') : target;
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function format(summary: QuickRtfSummary): string {
  const f = (v: number | null, digits = 3) => (v === null ? '-' : v.toFixed(digits));
  const r = summary.render;
  const lines = [
    `[${summary.label}] RTF n=${summary.rtf.n} p50=${f(summary.rtf.p50)} p95=${f(summary.rtf.p95)}（予算 ${RTF_P95_BUDGET} との差 ${f(summary.rtf.over_budget_by)}）`,
    `  render.health n=${r.n} fps中央値=${f(r.fps_median, 1)} fps_p5最小=${f(r.fps_p5_min, 1)} フレームp95最大=${f(r.frame_ms_p95_max, 1)}ms long_task=${r.long_tasks} 体数=${r.avatars.join(',') || '-'}`,
  ];
  if (r.renderers.length > 0) lines.push(`  renderer: ${r.renderers.join(' | ')}`);
  if (r.software_renderer) lines.push('  注意: ソフトウェア描画（SwiftShader など）の値で、実機の GPU の値ではない。');
  return lines.join('\n');
}

function main(argv: string[]): number {
  if (argv.includes('--steps')) {
    console.log(STEPS.join('\n'));
    return 0;
  }
  const json = argv.includes('--json');
  const pairs = argv.filter((a) => a !== '--json');
  if (pairs.length === 0 || pairs.some((p) => !/^[a-z0-9_]+=.+/.test(p))) {
    console.error('使い方: quick_rtf --steps | quick_rtf <label>=<events.jsonl|dir> ... [--json]');
    return 2;
  }
  const summaries: QuickRtfSummary[] = [];
  for (const pair of pairs) {
    const at = pair.indexOf('=');
    const label = pair.slice(0, at);
    try {
      summaries.push(summarizeQuickRtf(label, readEvents(pair.slice(at + 1))));
    } catch (error) {
      console.error(`読めません（${label}）: ${error instanceof Error ? error.message : String(error)}`);
      return 2;
    }
  }
  console.log(json ? JSON.stringify(summaries, null, 2) : summaries.map(format).join('\n\n'));
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
