// 試走（docs/design/two_ai/04 T4、05 §7 の 6）。ブラウザなしで 1 セッションを最後まで通し、ログと要約と合否を出す。
//   npm run dryrun:two_ai -- --condition respond_on_spot \
//     --config config/two_ai/session.demo_short.ja.json --script config/two_ai/scripts/demo_career.ja.json \
//     --user fixtures/two_ai/dryrun_user.respond_on_spot.json [--providers fake|real-llm] [--out .dryrun/<name>] [--both]
//   npm run dryrun:two_ai -- --compare-feeds [--user fixtures/two_ai/dryrun_user.feeds_compare.json]
//   npm run dryrun:two_ai -- --both --mode responsive   応答版（experience.mode を上書き。本人の発言が台帳と板の根拠に入るか）
//   npm run dryrun:two_ai -- --synthetic [--both] [--compare-feeds]   WP1 の統合の前に、道具の流れ（書き出し、log_check、要約、並べ）だけを確かめる
//
// 統合 1（05 §5.2）の後：本物の TwoAiSession と DiscussionContent を、偽のプロバイダ（integrated.ts：偽の時計の台本の LLM、
// 台本の STT／TTS、FakeVapFromScript、偽のブラウザ）でつなぐ。--synthetic の出力は fixtures/two_ai/synthetic_session.ts の合成で、
// 試走の証拠ではない（provider_class: test_double。AC11）。試走の出力も test_double で、受け入れの証拠に数えない。
// 終了コード：0 受け入れ基準の自動の列がすべて合格、1 不合格、2 使い方の誤り。
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { TwoAiScript, TwoAiSessionConfig, type TwoAiCondition } from '@llm-vap/contracts';
import { buildSyntheticSession, writeSyntheticSession } from '../../fixtures/two_ai/synthetic_session';
import { checkLog } from '../log_check/check';
import { runReport } from '../two_ai_report/cli';
import { buildSummary } from '../two_ai_report/report';
import { loadTwoAiSession } from '../two_ai_report/session';
import { compareFeeds } from './compare_feeds';
import { runIntegratedSession } from './integrated';
import { loadUserScript } from './user_script';

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');

export interface DryrunOptions {
  condition: TwoAiCondition;
  both: boolean;
  compareFeeds: boolean;
  synthetic: boolean;
  feeds: boolean;
  /** 版の上書き（省略は設定のまま）。 */
  mode?: 'controlled' | 'responsive';
  providers: 'fake' | 'real-llm';
  config: string;
  script: string;
  user: string | null;
  out: string;
}

export interface DryrunResult {
  exit_code: 0 | 1;
  sessions: string[];
  messages: string[];
}

function defaultUser(condition: TwoAiCondition): string {
  return `fixtures/two_ai/dryrun_user.${condition}.json`;
}

/** 本物の TwoAiSession（WP1）と DiscussionContent（WP2）を偽のプロバイダで通す（05 §5.2 の統合 1。integrated.ts）。 */
async function runIntegrated(options: DryrunOptions): Promise<DryrunResult> {
  const messages: string[] = ['試走（TwoAiSession と DiscussionContent、偽のプロバイダと偽の時計）：配線と順序の確認で、性能や自然さの証拠ではない（AC11）。'];
  if (options.providers === 'real-llm') messages.push('real-llm：話し合いの文だけ実の LLM（課金。承認があるときだけ）。実時間で進む。');
  const sessions: string[] = [];
  let ok = true;
  const runOne = async (condition: TwoAiCondition, user: string, session_id: string, feeds: boolean | null) => {
    const r = await runIntegratedSession({
      condition,
      config: options.config,
      script: options.script,
      user: loadUserScript(resolve(repoRoot, user)),
      out: options.out,
      session_id,
      feeds,
      ...(options.mode !== undefined ? { mode: options.mode } : {}),
      ...(options.providers === 'real-llm' ? { realLlm: true, realtime: true } : {}),
    });
    const lc = await checkLog(r.dir);
    messages.push(`${r.dir}: 段階 ${r.phases.join('→')}、log_check ${lc.ok ? '合格' : `不合格（${lc.failures.join(' / ')}）`}${r.pending_actions > 0 ? `、時刻の決まらなかった本人の行動 ${r.pending_actions} 件` : ''}`);
    if (r.counters.tick_errors > 0) messages.push(`${r.dir}: tick の失敗 ${r.counters.tick_errors} 件`);
    ok = ok && lc.ok && r.counters.tick_errors === 0 && r.phases.at(-1) === 'end';
    sessions.push(r.dir);
    return r.dir;
  };
  if (options.compareFeeds) {
    const user = options.user ?? 'fixtures/two_ai/dryrun_user.feeds_compare.json';
    const offDir = await runOne('respond_on_spot', user, 'dryrun_feeds_off', false);
    const onDir = await runOne('respond_on_spot', user, 'dryrun_feeds_on', true);
    const cmp = compareFeeds(await loadTwoAiSession(offDir, { repoRoot }), await loadTwoAiSession(onDir, { repoRoot }));
    await writeFile(join(options.out, 'feeds_compare.md'), cmp.markdown);
    messages.push(`書いた: ${join(options.out, 'feeds_compare.md')}（点のブロックが同じ ${cmp.points_identical}、feed の生成 ${cmp.feed_section_ok}）`);
    ok = ok && cmp.points_identical && cmp.feed_section_ok;
    return { exit_code: ok ? 0 : 1, sessions, messages };
  }
  const conditions: TwoAiCondition[] = options.both ? ['respond_on_spot', 'respond_at_end'] : [options.condition];
  const run: string[] = [];
  for (const condition of conditions) {
    const user = options.both || options.user === null ? defaultUser(condition) : options.user;
    run.push(await runOne(condition, user, `dryrun_${condition}${options.feeds ? '_feeds' : ''}${options.mode === 'responsive' ? '_responsive' : ''}`, options.feeds ? true : null));
  }
  const report = await runReport(run, { pair: options.both, recall: true, post: true, coding: true, load: { repoRoot } });
  ok = ok && report.ok;
  for (const s of report.sessions) {
    const failed = buildSummary(s).acceptance.filter((r) => r.ok === false);
    if (failed.length > 0) messages.push(`${s.dir}: 要約の不合格 ${failed.map((r) => `${r.id}（${r.detail}）`).join(' / ')}`);
  }
  messages.push(...report.written.map((p) => `書いた: ${p}`));
  return { exit_code: ok ? 0 : 1, sessions, messages };
}

async function writeAndCheck(dir: string, session: ReturnType<typeof buildSyntheticSession>, messages: string[]): Promise<boolean> {
  await writeSyntheticSession(dir, session);
  const lc = await checkLog(dir);
  messages.push(`${dir}: log_check ${lc.ok ? '合格' : `不合格（${lc.failures.join(' / ')}）`}`);
  return lc.ok;
}

async function runSynthetic(options: DryrunOptions): Promise<DryrunResult> {
  const messages: string[] = ['合成のログ（--synthetic）：TwoAiSession の試走ではない。道具の流れの確認だけ。'];
  const sessions: string[] = [];
  let ok = true;
  const conditions: TwoAiCondition[] = options.both ? ['respond_on_spot', 'respond_at_end'] : [options.condition];
  for (const condition of conditions) {
    const s = buildSyntheticSession({ condition, session_id: `dryrun_${condition}`, feeds: options.feeds });
    const dir = join(options.out, `dryrun_${condition}`);
    ok = (await writeAndCheck(dir, s, messages)) && ok;
    sessions.push(dir);
  }
  const report = await runReport(sessions, { pair: options.both, recall: true, post: true, coding: true });
  ok = ok && report.ok;
  messages.push(...report.written.map((p) => `書いた: ${p}`));
  if (options.compareFeeds) {
    const off = buildSyntheticSession({ condition: 'respond_on_spot', session_id: 'dryrun_feeds_off', feeds: false });
    const on = buildSyntheticSession({ condition: 'respond_on_spot', session_id: 'dryrun_feeds_on', feeds: true });
    const offDir = join(options.out, 'dryrun_feeds_off');
    const onDir = join(options.out, 'dryrun_feeds_on');
    ok = (await writeAndCheck(offDir, off, messages)) && ok;
    ok = (await writeAndCheck(onDir, on, messages)) && ok;
    const cmp = compareFeeds(await loadTwoAiSession(offDir), await loadTwoAiSession(onDir));
    await writeFile(join(options.out, 'feeds_compare.md'), cmp.markdown);
    messages.push(`書いた: ${join(options.out, 'feeds_compare.md')}（点のブロックが同じ ${cmp.points_identical}、feed の生成 ${cmp.feed_section_ok}）`);
    ok = ok && cmp.points_identical && cmp.feed_section_ok;
    sessions.push(offDir, onDir);
  }
  return { exit_code: ok ? 0 : 1, sessions, messages };
}

export async function runDryrun(options: DryrunOptions): Promise<DryrunResult> {
  // 起動時と同じ検査（設定、台本、本人の台本）。不合格なら試走もしない。
  TwoAiSessionConfig.parse(JSON.parse(readFileSync(resolve(repoRoot, options.config), 'utf8')));
  TwoAiScript.parse(JSON.parse(readFileSync(resolve(repoRoot, options.script), 'utf8')));
  const users = options.compareFeeds ? [options.user ?? 'fixtures/two_ai/dryrun_user.feeds_compare.json'] : options.both ? ['respond_on_spot', 'respond_at_end'].map((c) => defaultUser(c as TwoAiCondition)) : [options.user ?? defaultUser(options.condition)];
  for (const u of users) loadUserScript(resolve(repoRoot, u));
  await mkdir(options.out, { recursive: true });
  return options.synthetic ? runSynthetic(options) : runIntegrated(options);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      condition: { type: 'string', default: 'respond_on_spot' },
      config: { type: 'string', default: 'config/two_ai/session.demo_short.ja.json' },
      script: { type: 'string', default: 'config/two_ai/scripts/demo_career.ja.json' },
      user: { type: 'string' },
      providers: { type: 'string', default: 'fake' },
      out: { type: 'string', default: '.dryrun/latest' },
      both: { type: 'boolean', default: false },
      'compare-feeds': { type: 'boolean', default: false },
      'feeds-generation': { type: 'boolean', default: false },
      mode: { type: 'string' },
      synthetic: { type: 'boolean', default: false },
    },
  });
  if (values.condition !== 'respond_on_spot' && values.condition !== 'respond_at_end') {
    console.error('--condition は respond_on_spot か respond_at_end');
    process.exit(2);
  }
  if (values.mode !== undefined && values.mode !== 'controlled' && values.mode !== 'responsive') {
    console.error('--mode は controlled か responsive');
    process.exit(2);
  }
  if (values.providers !== 'fake' && values.providers !== 'real-llm') {
    console.error('--providers は fake か real-llm（real-llm は課金。承認があるときだけ）');
    process.exit(2);
  }
  const result = await runDryrun({
    condition: values.condition,
    both: values.both,
    compareFeeds: values['compare-feeds'],
    synthetic: values.synthetic,
    feeds: values['feeds-generation'],
    ...(values.mode !== undefined ? { mode: values.mode as 'controlled' | 'responsive' } : {}),
    providers: values.providers,
    config: values.config,
    script: values.script,
    user: values.user ?? null,
    out: values.out,
  });
  for (const m of result.messages) console.log(m);
  process.exitCode = result.exit_code;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  });
}
