// 2 体のセッションの要約と書き出し（docs/design/two_ai/04 D）。orchestrator は呼ばない。研究者がセッションの後に回す。
//   npm run report:two_ai -- sessions/<id>                       two_ai_summary.json と .md をセッションのディレクトリに書く
//   npm run report:two_ai -- sessions/<①> sessions/<②> --pair   ① と ② を並べた two_ai_pair.md（1 本目のディレクトリ）
//   npm run report:two_ai -- sessions/<id> --recall              recall_points.csv（刺激再生の頭出し、同期の印）
//   npm run report:two_ai -- sessions/<id> --post                post_items.md と retraction.md
//   npm run report:two_ai -- sessions/<id> --coding              coding/ に coding_utterances.csv、coding_stages.csv、coding_texts.jsonl（応答版は＋coding_uptake.csv：取得と反映）
//   npm run report:two_ai -- sessions/<①> sessions/<②> --coding --blind [--out <dir>]   盲検の符号化用（条件を空、ID を符号に）
// 任意：--marker-link-ms <ms>（既定 10000）、--json（要約を標準出力にも）、--config／--script（manifest のパスの代わり）。
// 終了コード：0 受け入れ基準の自動の列がすべて合格（null は数えない）、1 不合格がある、2 使い方の誤りか読めない。
import { mkdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { TwoAiScript, TwoAiSessionConfig } from '@llm-vap/contracts';
import { blindCode, buildCoding, codingFiles, type CodingOutput } from './coding';
import { recallCsv } from './recall';
import { buildSummary, renderPairMarkdown, renderSummaryMarkdown } from './report';
import { buildPostItems, buildRetraction } from './retraction';
import { loadTwoAiSession, sha256, type LoadOptions, type TwoAiSessionData } from './session';
import { csv } from './csv';
import { STAGE_COLUMNS, UTTERANCE_COLUMNS } from './coding';
import { buildUptake, UPTAKE_COLUMNS } from './uptake';

export interface ReportCliOptions {
  pair?: boolean;
  recall?: boolean;
  post?: boolean;
  coding?: boolean;
  blind?: boolean;
  out?: string;
  markerLinkMs?: number;
  load?: LoadOptions;
}

/** 試走と T2 の試験からも呼ぶ。書いたファイルのパスと、受け入れの合否を返す。 */
export async function runReport(inputs: string[], options: ReportCliOptions = {}): Promise<{ ok: boolean; written: string[]; sessions: TwoAiSessionData[] }> {
  const sessions: TwoAiSessionData[] = [];
  for (const input of inputs) sessions.push(await loadTwoAiSession(input, options.load ?? {}));
  const written: string[] = [];
  const put = async (path: string, text: string) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
    written.push(path);
  };
  let ok = true;
  for (const data of sessions) {
    const dir = data.dir ?? '.';
    const summary = buildSummary(data);
    if (summary.acceptance.some((r) => r.ok === false)) ok = false;
    await put(join(dir, 'two_ai_summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    await put(join(dir, 'two_ai_summary.md'), renderSummaryMarkdown(summary));
    if (options.recall) await put(join(dir, 'recall_points.csv'), recallCsv(data));
    if (options.post) {
      await put(join(dir, 'post_items.md'), buildPostItems(data));
      const r = buildRetraction(data);
      if (r.hash_ok === false) ok = false;
      await put(join(dir, 'retraction.md'), r.markdown);
    }
    if (options.coding && !options.blind) {
      const files = codingFiles(buildCoding(data, { markerLinkMs: options.markerLinkMs }));
      for (const [name, text] of Object.entries(files)) await put(join(dir, 'coding', name), text);
      // 応答版だけ：取得と反映（two_ai.capture があるとき）
      const uptake = buildUptake(data);
      if (uptake.length > 0) await put(join(dir, 'coding', 'coding_uptake.csv'), csv(UPTAKE_COLUMNS, uptake));
    }
  }
  if (options.pair) {
    if (sessions.length !== 2) throw new Error('--pair は 2 つのセッションを取る');
    const { markdown, rows } = renderPairMarkdown(sessions[0]!, sessions[1]!);
    if (rows.some((r) => r.ok === false)) ok = false;
    await put(join(sessions[0]!.dir ?? '.', 'two_ai_pair.md'), markdown);
  }
  if (options.coding && options.blind) {
    // 盲検：セッションの順は符号の順（条件の順を手がかりにしない）。符号は ID と塩から決まるので、研究者は後で照合できる。
    const outs: CodingOutput[] = [...sessions]
      .sort((a, b) => blindCode(a.session_id).localeCompare(blindCode(b.session_id)))
      .map((d) => buildCoding(d, { blind: true, markerLinkMs: options.markerLinkMs }));
    const outDir = options.out ?? join(dirname(sessions[0]?.dir ?? '.'), `coding_blind_${sha256(sessions.map((s) => s.session_id).sort().join(',')).slice(0, 8)}`);
    await put(join(outDir, 'coding_utterances.csv'), csv(UTTERANCE_COLUMNS, outs.flatMap((o) => o.utterances)));
    await put(join(outDir, 'coding_stages.csv'), csv(STAGE_COLUMNS, outs.flatMap((o) => o.stages)));
    const texts = outs.flatMap((o) => o.texts);
    await put(join(outDir, 'coding_texts.jsonl'), texts.map((t) => JSON.stringify(t)).join('\n') + (texts.length ? '\n' : ''));
    const uptake = [...sessions].sort((a, b) => blindCode(a.session_id).localeCompare(blindCode(b.session_id))).flatMap((d) => buildUptake(d, { blind: true }));
    if (uptake.length > 0) await put(join(outDir, 'coding_uptake.csv'), csv(UPTAKE_COLUMNS, uptake));
  }
  return { ok, written, sessions };
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      pair: { type: 'boolean', default: false },
      recall: { type: 'boolean', default: false },
      post: { type: 'boolean', default: false },
      coding: { type: 'boolean', default: false },
      blind: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      out: { type: 'string' },
      'marker-link-ms': { type: 'string' },
      config: { type: 'string' },
      script: { type: 'string' },
    },
  });
  if (positionals.length === 0 || (values.blind && !values.coding)) {
    console.error('使い方: report:two_ai -- <session_dir>... [--pair] [--recall] [--post] [--coding [--blind] [--out <dir>]] [--marker-link-ms <ms>] [--json]');
    process.exit(2);
  }
  const load: LoadOptions = {};
  if (values.config) load.config = TwoAiSessionConfig.parse(JSON.parse(readFileSync(values.config, 'utf8')));
  if (values.script) load.script = TwoAiScript.parse(JSON.parse(readFileSync(values.script, 'utf8')));
  const result = await runReport(positionals, {
    pair: values.pair,
    recall: values.recall,
    post: values.post,
    coding: values.coding,
    blind: values.blind,
    out: values.out,
    markerLinkMs: values['marker-link-ms'] === undefined ? undefined : Number(values['marker-link-ms']),
    load,
  });
  for (const path of result.written) console.log(`書いた: ${path}`);
  if (values.json) for (const s of result.sessions) console.log(JSON.stringify(buildSummary(s), null, 2));
  console.log(`受け入れ基準の自動の列: ${result.ok ? '合格' : '不合格がある（two_ai_summary.md の 1.）'}`);
  process.exitCode = result.ok ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(`読めません: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  });
}
