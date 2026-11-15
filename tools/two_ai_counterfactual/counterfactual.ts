/**
 * 反実仮想の板の生成（RQ4：言われなかったことの帰結）。記録された 1 回のセッション（応答版）の板の生成の入力
 * （two_ai.board_generated の input）に、台帳の項目を 1 つ足すか除いて、同じ関数（board_gen.ts の runBoardGeneration）で
 * 板を N 回作り直し、元の板と比べる。LLM の呼び出しは呼び手が渡す（CLI は --yes のときだけ実の LLM を作る）。
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { LlmProvider } from '@llm-vap/contracts';
import { runBoardGeneration, type BoardGenInput, type BoardGenItem, type BoardGenItemKind } from '../../apps/orchestrator/src/cognition/discussion/board_gen';
import { sharesSubstring } from '../../apps/orchestrator/src/cognition/discussion/responsive';
import type { SafetyLists } from '../../apps/orchestrator/src/cognition/discussion/safety';

export type CounterfactualEdit =
  | { kind: 'add'; item: { id: string; kind: BoardGenItemKind; text: string; said_in: BoardGenItem['said_in'] } }
  | { kind: 'remove'; item_id: string; keep_transcript: boolean };

export interface RecordedCard {
  card_id: string;
  order: number;
  text: string;
  corrected_text: string;
  ledger_item_ids: string[];
}

export interface RecordedBoard {
  board_id: string;
  trigger: string;
  ledger_version: number;
  input: BoardGenInput;
  cards: RecordedCard[];
}

/** events.jsonl（またはセッションのディレクトリ）から、生成した板の記録を読む。board_id がなければ最後の generated（closing を優先）。 */
export function loadRecordedBoard(path: string, board_id: string | null = null): RecordedBoard {
  const file = statSync(path).isDirectory() ? join(path, 'events.jsonl') : path;
  const boards: RecordedBoard[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    const e = JSON.parse(line) as Record<string, unknown>;
    if (e.event !== 'two_ai.board_generated' || e.stage !== 'generated' || e.input === null) continue;
    boards.push({ board_id: e.board_id as string, trigger: e.trigger as string, ledger_version: e.ledger_version as number, input: e.input as BoardGenInput, cards: e.cards as RecordedCard[] });
  }
  if (boards.length === 0) throw new Error(`${file}: two_ai.board_generated（generated、input つき）がない。応答版のセッションか確かめる`);
  if (board_id !== null) {
    const b = boards.find((x) => x.board_id === board_id);
    if (b === undefined) throw new Error(`${board_id} がない（あるもの：${boards.map((x) => x.board_id).join(', ')}）`);
    return b;
  }
  return boards.filter((b) => b.trigger === 'closing').at(-1) ?? boards.at(-1)!;
}

const KINDS: readonly BoardGenItemKind[] = ['core', 'option', 'dropped_option', 'fact', 'value'];
const SAID: readonly BoardGenItem['said_in'][] = ['intake', 'discussion', 'response', 'prepared'];

/** CLI の --add kind:said_in:text（said_in は省けて既定 response）／--remove item_id を編集にする。足す項目の id は cf_add。 */
export function parseEdit(x: { add: string | null; remove: string | null; keep_transcript: boolean }): CounterfactualEdit {
  if (x.remove !== null) return { kind: 'remove', item_id: x.remove, keep_transcript: x.keep_transcript };
  const parts = (x.add ?? '').split(':');
  const kind = parts[0] as BoardGenItemKind;
  if (!KINDS.includes(kind)) throw new Error(`--add の kind は ${KINDS.join('|')}`);
  const hasSaid = parts.length >= 3 && SAID.includes(parts[1] as BoardGenItem['said_in']);
  const said_in = hasSaid ? (parts[1] as BoardGenItem['said_in']) : 'response';
  const text = parts.slice(hasSaid ? 2 : 1).join(':').trim();
  if (text === '') throw new Error('--add の文が空');
  return { kind: 'add', item: { id: 'cf_add', kind, text, said_in } };
}

/** 入力に編集を当てる（元の入力は変えない）。remove は既定で、その項目の根拠の本人の発話も話し合いの写しから除く。 */
export function applyEdit(input: BoardGenInput, edit: CounterfactualEdit): BoardGenInput {
  const copy = JSON.parse(JSON.stringify(input)) as BoardGenInput;
  if (edit.kind === 'add') {
    if (copy.items.some((i) => i.id === edit.item.id)) throw new Error(`足す項目の id ${edit.item.id} は既にある`);
    copy.items.push({ id: edit.item.id, kind: edit.item.kind, text: edit.item.text, segment_ids: [], said_in: edit.item.said_in });
    return copy;
  }
  const item = copy.items.find((i) => i.id === edit.item_id);
  if (item === undefined) throw new Error(`除く項目 ${edit.item_id} がない（あるもの：${copy.items.map((i) => i.id).join(', ')}）`);
  copy.items = copy.items.filter((i) => i.id !== edit.item_id);
  if (!edit.keep_transcript) {
    // 同じ発話を根拠にするほかの項目が残るなら、その発話は写しに残す
    const still = new Set(copy.items.flatMap((i) => i.segment_ids));
    const drop = new Set(item.segment_ids.filter((s) => !still.has(s)));
    copy.transcript = copy.transcript.filter((t) => t.segment_id === null || !drop.has(t.segment_id));
  }
  return copy;
}

/** 文字の 2-gram の Dice 係数（0〜1。同じ文は 1）。 */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const grams = (s: string) => {
    const c = [...s.replace(/\s/gu, '')];
    const m = new Map<string, number>();
    for (let i = 0; i + 1 < c.length; i++) m.set(c[i]! + c[i + 1]!, (m.get(c[i]! + c[i + 1]!) ?? 0) + 1);
    return m;
  };
  const x = grams(a);
  const y = grams(b);
  const nx = [...x.values()].reduce((p, q) => p + q, 0);
  const ny = [...y.values()].reduce((p, q) => p + q, 0);
  if (nx + ny === 0) return 0;
  let inter = 0;
  for (const [g, n] of x) inter += Math.min(n, y.get(g) ?? 0);
  return Math.round(((2 * inter) / (nx + ny)) * 1000) / 1000;
}

export interface RunRow {
  arm: 'edited' | 'baseline';
  run: number;
  ok: boolean;
  calls: number;
  reason: string;
  cards: { order: number; text: string; ledger_item_ids: string[]; similarity_to_original: number; grounded_on_edit: boolean | null; mentions_removed: boolean | null }[];
}

export interface CounterfactualReport {
  board_id: string;
  edit: CounterfactualEdit;
  n: number;
  /** 元の板（記録）。 */
  original: RecordedCard[];
  runs: RunRow[];
  summary: {
    arm: 'edited' | 'baseline';
    ok_runs: number;
    llm_calls: number;
    /** 4 枚の元の板との類似度の平均（ok の回だけ）。 */
    mean_similarity: number | null;
    /** 1 回あたり、元の板と文が変わったカードの数の平均。 */
    mean_changed_cards: number | null;
    /** add：足した項目を根拠に持つカードの割合。remove：除いた項目の文を含むカードの割合。 */
    edit_rate: number | null;
  }[];
}

const REFERENCE_MIN = 5;

function scoreRun(arm: RunRow['arm'], run: number, r: Awaited<ReturnType<typeof runBoardGeneration>>, original: RecordedCard[], edit: CounterfactualEdit, removedText: string | null): RunRow {
  return {
    arm,
    run,
    ok: r.ok,
    calls: r.calls,
    reason: r.reason,
    cards: r.cards.map((c) => {
      const o = original.find((x) => x.order === c.order);
      return {
        order: c.order,
        text: c.corrected_text,
        ledger_item_ids: c.ledger_item_ids,
        similarity_to_original: o === undefined ? 0 : similarity(c.corrected_text, o.corrected_text),
        grounded_on_edit: edit.kind === 'add' ? c.ledger_item_ids.includes(edit.item.id) : null,
        mentions_removed: removedText === null ? null : sharesSubstring(c.corrected_text, removedText, REFERENCE_MIN),
      };
    }),
  };
}

function summarize(arm: RunRow['arm'], rows: RunRow[], edit: CounterfactualEdit): CounterfactualReport['summary'][number] {
  const ok = rows.filter((r) => r.ok);
  const cards = ok.flatMap((r) => r.cards);
  const mean = (xs: number[]) => (xs.length === 0 ? null : Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 1000) / 1000);
  const flags = cards.map((c) => (edit.kind === 'add' ? c.grounded_on_edit : c.mentions_removed)).filter((x): x is boolean => x !== null);
  return {
    arm,
    ok_runs: ok.length,
    llm_calls: rows.reduce((a, r) => a + r.calls, 0),
    mean_similarity: mean(cards.map((c) => c.similarity_to_original)),
    mean_changed_cards: mean(ok.map((r) => r.cards.filter((c) => c.similarity_to_original < 1).length)),
    edit_rate: flags.length === 0 ? null : mean(flags.map((f) => (f ? 1 : 0))),
  };
}

/** LLM の呼び出しの見込み（1 回の作り直しは 1〜2 回の呼び出し）。 */
export function plannedCalls(n: number, withBaseline: boolean): { min: number; max: number } {
  const runs = n * (withBaseline ? 2 : 1);
  return { min: runs, max: runs * 2 };
}

export async function runCounterfactual(input: {
  recorded: RecordedBoard;
  edit: CounterfactualEdit;
  n: number;
  withBaseline: boolean;
  llm: LlmProvider;
  safety: SafetyLists;
  timeout_ms: number;
}): Promise<CounterfactualReport> {
  const { recorded, edit, n } = input;
  const edited = applyEdit(recorded.input, edit);
  const removedText = edit.kind === 'remove' ? (recorded.input.items.find((i) => i.id === edit.item_id)?.text ?? null) : null;
  const runs: RunRow[] = [];
  let seq = 0;
  const arms: { arm: RunRow['arm']; data: BoardGenInput }[] = [{ arm: 'edited', data: edited }, ...(input.withBaseline ? [{ arm: 'baseline' as const, data: recorded.input }] : [])];
  for (const { arm, data } of arms) {
    for (let i = 0; i < n; i++) {
      const r = await runBoardGeneration(input.llm, data, input.safety, { timeout_ms: input.timeout_ms, request_id: (a) => `cf_${recorded.board_id}_${arm}_${i}_${a}_${++seq}` });
      runs.push(scoreRun(arm, i, r, recorded.cards, edit, removedText));
    }
  }
  return {
    board_id: recorded.board_id,
    edit,
    n,
    original: recorded.cards,
    runs,
    summary: arms.map(({ arm }) => summarize(arm, runs.filter((r) => r.arm === arm), edit)),
  };
}

export function renderMarkdown(report: CounterfactualReport): string {
  const e = report.edit;
  const editLine = e.kind === 'add' ? `足す：[${e.item.id}]（${e.item.kind}、${e.item.said_in}）${e.item.text}` : `除く：[${e.item_id}]${e.keep_transcript ? '（話し合いの写しは残す）' : '（根拠の発話も写しから除く）'}`;
  const lines = [
    `# 反実仮想の板（${report.board_id}）`,
    '',
    '読み方：記録した板の生成の入力に編集を 1 つ当て、同じ生成で N 回作り直した。類似度は訂正後の文の文字 2-gram の Dice 係数（元の板と同じ文は 1）。',
    'edit_rate は、足したとき「足した項目を根拠に持つカードの割合」、除いたとき「除いた項目の文（5 字以上の共通部分）を含むカードの割合」。LLM の揺れの目安に baseline（編集なし）を並べる。',
    '',
    `- 編集：${editLine}`,
    `- N：${report.n}`,
    '',
    '## 要約',
    '',
    '| 腕 | ok の回 | LLM の呼び出し | 類似度の平均 | 変わったカードの平均 | edit_rate |',
    '|---|---|---|---|---|---|',
    ...report.summary.map((s) => `| ${s.arm} | ${s.ok_runs} | ${s.llm_calls} | ${s.mean_similarity ?? '—'} | ${s.mean_changed_cards ?? '—'} | ${s.edit_rate ?? '—'} |`),
    '',
    '## 元の板',
    '',
    '| order | 文（訂正後） | 根拠の項目 |',
    '|---|---|---|',
    ...report.original.map((c) => `| ${c.order} | ${c.corrected_text} | ${c.ledger_item_ids.join(', ')} |`),
    '',
    '## 回ごと',
    '',
    '| 腕 | 回 | order | 文（訂正後） | 根拠の項目 | 類似度 | edit |',
    '|---|---|---|---|---|---|---|',
    ...report.runs.flatMap((r) =>
      r.ok
        ? r.cards.map((c) => `| ${r.arm} | ${r.run} | ${c.order} | ${c.text} | ${c.ledger_item_ids.join(', ')} | ${c.similarity_to_original} | ${c.grounded_on_edit ?? c.mentions_removed ?? '—'} |`)
        : [`| ${r.arm} | ${r.run} | — | 失敗：${r.reason.replace(/\|/gu, '／').slice(0, 120)} | — | — | — |`],
    ),
    '',
  ];
  return lines.join('\n');
}
