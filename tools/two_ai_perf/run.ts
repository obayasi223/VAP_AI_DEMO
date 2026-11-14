// perf:two_ai（docs/design/two_ai/04 §性能の「測り方」2）。2 体のセッションのログから、予算の表の全行を集計して合否を出す。
//   npm run perf:two_ai -- --steps                                   本測定の手順（WSL のヘッドレスと Windows の Chrome の 2 通り）
//   npm run perf:two_ai -- <label>=<session_dir|events.jsonl> ... [--json]
// 例：npm run perf:two_ai -- one=sessions/<1 体> two=sessions/<2 体>
//
// 本測定の状態（2026-11-16）：実 MaAI に 2ch の素材を実時間で 5 分流しながら /two_ai を開く駆動は【保留】
// （WP1 の統合と e2e two_ai_run.ts の後。研究者が手順どおりに回し、ここで集計する）。WP3c の quick_rtf.ts は早い確認用で、これは本測定の集計。
// 合成のログ（provider_class: test_double）の値は性能の証拠ではない（結果に注記する）。
// 終了コード：0 計測のある行がすべて予算内、1 予算外がある、2 使い方の誤りか読めない。
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RTF_P95_BUDGET, summarizeQuickRtf, type QuickRtfSummary } from './quick_rtf';

type Raw = Record<string, unknown>;

export const BUDGET = {
  rtf_p95_lt: RTF_P95_BUDGET,
  backlog_p95_lt_frames: 5, // queue_depth は 20 ms の送信単位の数。100 ms ÷ 20 ms
  stop_latency: { median_lt: 600, p90_lt: 1000 },
  fps_p5_ge: 30,
  long_tasks_per_min_le: 5,
  gap: { median_min: 300, median_max: 800, p90_lt: 1500 },
  audio_drops: 0,
} as const;

export interface PerfRow {
  item: string;
  value: string;
  budget: string;
  ok: boolean | null;
}

export interface PerfSummary {
  label: string;
  test_double: boolean;
  quick: QuickRtfSummary;
  rtf_p99: number | null;
  backlog_p95_frames: number | null;
  audio_drops: number | null;
  stop_latency_ms: { n: number; median: number | null; p90: number | null };
  gap_ms: { n: number; median: number | null; p90: number | null };
  long_tasks_per_min: number | null;
  rows: PerfRow[];
}

export function quantile(values: number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] as number;
}

function present(v: unknown): number | null {
  if (v !== null && typeof v === 'object' && 'value' in v) {
    const x = (v as { value: unknown }).value;
    return typeof x === 'number' ? x : null;
  }
  return null;
}

const fmt = (v: number | null, d = 0) => (v === null ? '未計測' : v.toFixed(d));

export function summarizePerf(label: string, events: readonly Raw[]): PerfSummary {
  const quick = summarizeQuickRtf(label, events);
  const health = events.filter((e) => e.event === 'audio.health' && e.reporter === 'worker');
  const rtfs = health.map((e) => present(e.rtf)).filter((v): v is number => v !== null);
  const queue = health.map((e) => e.queue_depth).filter((v): v is number => typeof v === 'number');
  const drops = health.length === 0 ? null : health.reduce((s, e) => s + Number(e.frames_dropped_network ?? 0) + Number(e.frames_dropped_overload ?? 0), 0);
  const stops = events.filter((e) => e.event === 'two_ai.interjection_episode' && e.outcome === 'yielded').map((e) => present(e.stop_latency_ms)).filter((v): v is number => v !== null);
  const gaps = events.filter((e) => e.event === 'two_ai.turn' && e.stage === 'started').map((e) => present(e.gap_ms)).filter((v): v is number => v !== null);
  const render = events.filter((e) => e.event === 'render.health');
  const times = render.map((e) => e.t_monotonic_ms).filter((v): v is number => typeof v === 'number');
  // 5 秒ごとの報告なので、最初の報告の前の 1 区間を足して長さとする
  const spanMin = times.length === 0 ? 0 : (Math.max(...times) - Math.min(...times) + 5000) / 60_000;
  const longPerMin = spanMin > 0 ? quick.render.long_tasks / spanMin : null;
  const test_double = events.some((e) => e.event === 'provider.status' && e.provider_class === 'test_double');

  const s = {
    stop_latency_ms: { n: stops.length, median: quantile(stops, 0.5), p90: quantile(stops, 0.9) },
    gap_ms: { n: gaps.length, median: quantile(gaps, 0.5), p90: quantile(gaps, 0.9) },
  };
  const both = (a: boolean | null, b: boolean | null) => (a === null || b === null ? null : a && b);
  const lt = (v: number | null, x: number) => (v === null ? null : v < x);
  const rows: PerfRow[] = [
    { item: 'VAP の RTF p95', value: `${fmt(quick.rtf.p95, 3)}（p50 ${fmt(quick.rtf.p50, 3)}、p99 ${fmt(quantile(rtfs, 0.99), 3)}、n=${quick.rtf.n}）`, budget: `< ${BUDGET.rtf_p95_lt}`, ok: lt(quick.rtf.p95, BUDGET.rtf_p95_lt) },
    { item: 'VAP の backlog p95（queue_depth）', value: fmt(quantile(queue, 0.95)), budget: `< ${BUDGET.backlog_p95_lt_frames}（100 ms）`, ok: lt(quantile(queue, 0.95), BUDGET.backlog_p95_lt_frames) },
    { item: '話し始め → AI の音が止まる', value: `中央値 ${fmt(s.stop_latency_ms.median)} ms、p90 ${fmt(s.stop_latency_ms.p90)} ms（n=${stops.length}）`, budget: `中央値 < ${BUDGET.stop_latency.median_lt}、p90 < ${BUDGET.stop_latency.p90_lt}`, ok: both(lt(s.stop_latency_ms.median, BUDGET.stop_latency.median_lt), lt(s.stop_latency_ms.p90, BUDGET.stop_latency.p90_lt)) },
    { item: '描画の fps p5（最小）', value: `${fmt(quick.render.fps_p5_min, 1)}（体数 ${quick.render.avatars.join(',') || '-'}）`, budget: `≥ ${BUDGET.fps_p5_ge}`, ok: quick.render.fps_p5_min === null ? null : quick.render.fps_p5_min >= BUDGET.fps_p5_ge },
    { item: '長いタスク（1 分あたり）', value: fmt(longPerMin, 1), budget: `≤ ${BUDGET.long_tasks_per_min_le}`, ok: longPerMin === null ? null : longPerMin <= BUDGET.long_tasks_per_min_le },
    { item: 'AI 同士の間（gap_ms）', value: `中央値 ${fmt(s.gap_ms.median)} ms、p90 ${fmt(s.gap_ms.p90)} ms（n=${gaps.length}）`, budget: `中央値 ${BUDGET.gap.median_min}〜${BUDGET.gap.median_max}、p90 < ${BUDGET.gap.p90_lt}`, ok: s.gap_ms.median === null ? null : s.gap_ms.median >= BUDGET.gap.median_min && s.gap_ms.median <= BUDGET.gap.median_max && (s.gap_ms.p90 ?? 0) < BUDGET.gap.p90_lt },
    { item: 'ブラウザから Node への音声の欠落', value: fmt(drops), budget: '0', ok: drops === null ? null : drops === BUDGET.audio_drops },
  ];
  return { label, test_double, quick, rtf_p99: quantile(rtfs, 0.99), backlog_p95_frames: quantile(queue, 0.95), audio_drops: drops, ...s, long_tasks_per_min: longPerMin, rows };
}

export function renderPerfMarkdown(summaries: PerfSummary[]): string {
  const out = ['# 2 体の性能（perf:two_ai）', '', '予算は 04 §性能の【暫定】。null（未計測）は合否に数えない。'];
  for (const s of summaries) {
    out.push('', `## ${s.label}`, '');
    if (s.test_double) out.push('> test_double のプロバイダのログ。性能の証拠ではない。', '');
    if (s.quick.render.software_renderer) out.push('> ソフトウェア描画（SwiftShader）の値。実機の GPU の値ではない。', '');
    out.push('| 項目 | 値 | 予算 | 合否 |', '|---|---|---|---|');
    for (const r of s.rows) out.push(`| ${r.item} | ${r.value} | ${r.budget} | ${r.ok === null ? '—' : r.ok ? '合格' : '**予算外**'} |`);
  }
  if (summaries.some((s) => s.rows.some((r) => r.ok === false))) out.push('', '予算外：04 §性能の「予算を外れたときの代替」F1〜F8 を軽い順に試し、各段で測り直す。');
  return `${out.join('\n')}\n`;
}

export const STEPS = [
  '本測定の手順（04 §性能の「測り方」。maai_validation.md §6 を 2 体に広げる）：',
  '1. orchestrator を SESSION_MODE=two_ai で、実 MaAI（既定の重み）で起動する。ポートは研究者の通常の値。',
  '2. 既存の 2ch の素材を実時間で 5 分流す（Worker の audio.health に rtf と queue_depth が出る）。',
  '3. 同時に参加者画面 /two_ai を、(a) 1 体（?avatars=1、dev ページ）と (b) 2 体で開く。各 5 分。',
  '   WSL のヘッドレス Chromium（ソフトウェア描画、最悪の場合）と、Windows の Chrome（実機の GPU、研究者が手で開く）の 2 通り。',
  '4. npm run perf:two_ai -- one=sessions/<1 体> two=sessions/<2 体> で集計する。',
  '5. 予算外なら F1〜F8 を軽い順に試し、各段で測り直す。',
  '【保留】手順 2 と 3 の自動の駆動（e2e two_ai_run.ts と統合の後）。',
];

function readEvents(target: string): Raw[] {
  const path = existsSync(target) && statSync(target).isDirectory() ? join(target, 'events.jsonl') : target;
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as Raw];
      } catch {
        return [];
      }
    });
}

function main(argv: string[]): number {
  if (argv.includes('--steps')) {
    console.log(STEPS.join('\n'));
    return 0;
  }
  const pairs = argv.filter((a) => !a.startsWith('--'));
  if (pairs.length === 0 || pairs.some((p) => !p.includes('='))) {
    console.error('使い方: perf:two_ai -- --steps | <label>=<session_dir|events.jsonl> ... [--json]');
    return 2;
  }
  const summaries = pairs.map((p) => {
    const [label, target] = [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)];
    return summarizePerf(label, readEvents(target));
  });
  console.log(argv.includes('--json') ? JSON.stringify(summaries, null, 2) : renderPerfMarkdown(summaries));
  return summaries.some((s) => s.rows.some((r) => r.ok === false)) ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`読めません: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
