/**
 * セッションの JSONL の検証と集計（関門 G1 の「JSONL のスキーマ検証」）。
 * 入力は <session>/ か events.jsonl。同じ場所の quarantine.jsonl と manifest.json も読む。
 *
 * 失敗（failures）: 不合格の行、隔離の記録、session_id の混在、捨てた／書けなかったイベント、manifest との不一致、0 件。
 * 警告（warnings）: 正常に閉じていない、補正なしの時刻、test double を含む、など。--strict では失敗に格上げする。
 */
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { EVENT_ROUTES, EVENT_NAMES, ResearchEvent, type ResearchEventName } from '@llm-vap/contracts';
import { computeLatencyReport, summarizeCost, type CostSummary, type LatencyReport } from '@llm-vap/analysis';

export interface InvalidLine {
  line: number;
  event_name: string;
  issues: string[];
}

export interface ClockSyncSummary {
  source: string;
  n: number;
  offset_ms_min: number;
  offset_ms_max: number;
  offset_ms_last: number;
  error_ms_max: number;
  error_ms_last: number;
}

export interface LogCheckReport {
  ok: boolean;
  path: string;
  failures: string[];
  warnings: string[];
  total_lines: number;
  valid_events: number;
  invalid_lines: InvalidLine[];
  invalid_line_count: number;
  quarantine_records: number;
  quarantine_by_reason: Record<string, number>;
  session_ids: string[];
  conditions: string[];
  counts_by_event: Partial<Record<ResearchEventName, number>>;
  /** このログに 1 件もないイベント名。欠けてよいかは段階による。 */
  absent_events: ResearchEventName[];
  t_monotonic_ms_range: { min: number; max: number } | null;
  wall_clock_range: { first: string; last: string } | null;
  manifest: {
    found: boolean;
    closed: boolean | null;
    stats: Record<string, unknown> | null;
    condition: string | null;
    policy_id: string | null;
    providers: Record<string, { provider?: string; provider_class?: string; reason?: string | null }> | null;
  };
  /** production 以外のプロバイダがあるか、プロバイダの状態がなければ受け入れの証拠に数えない（計画 §4.8）。 */
  acceptance_evidence: { eligible: boolean; reasons: string[] };
  providers: { provider: string; provider_class: string; last_status: string }[];
  clock_sync: ClockSyncSummary[];
  cost: CostSummary;
  latency: LatencyReport;
}

export interface CheckOptions {
  /** 警告も失敗として扱う。 */
  strict?: boolean;
  maxListedInvalid?: number;
}

const INCOMPLETE_LINE = 'unterminated_last_line';

async function resolvePaths(input: string): Promise<{ events: string; quarantine: string; manifest: string }> {
  const info = await stat(input);
  const dir = info.isDirectory() ? input : dirname(input);
  const events = info.isDirectory() ? join(dir, 'events.jsonl') : input;
  return { events, quarantine: join(dir, 'quarantine.jsonl'), manifest: join(dir, 'manifest.json') };
}

async function* readLines(path: string): AsyncGenerator<{ text: string; number: number }> {
  const reader = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity });
  let number = 0;
  for await (const text of reader) {
    number += 1;
    yield { text, number };
  }
}

/** 最後の行に改行がないのは書き込みの途中で落ちた印。 */
async function endsWithNewline(path: string): Promise<boolean> {
  const content = await readFile(path);
  return content.length === 0 || content[content.length - 1] === 0x0a;
}

async function readJsonIfExists(path: string): Promise<{ found: boolean; value: unknown; error: string | null }> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { found: false, value: null, error: null };
    throw error;
  }
  try {
    return { found: true, value: JSON.parse(text), error: null };
  } catch (error) {
    return { found: true, value: null, error: String(error) };
  }
}

async function countQuarantine(path: string): Promise<{ total: number; byReason: Record<string, number> } | null> {
  try {
    await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const byReason: Record<string, number> = {};
  let total = 0;
  for await (const { text } of readLines(path)) {
    if (text.trim() === '') continue;
    total += 1;
    let reason = 'unparsable_quarantine_record';
    try {
      const parsed = JSON.parse(text) as { reason?: unknown };
      if (typeof parsed.reason === 'string') reason = parsed.reason;
    } catch {
      // 数えるだけ。
    }
    byReason[reason] = (byReason[reason] ?? 0) + 1;
  }
  return { total, byReason };
}

export async function checkLog(input: string, options: CheckOptions = {}): Promise<LogCheckReport> {
  const paths = await resolvePaths(input);
  const maxListed = options.maxListedInvalid ?? 20;
  const failures: string[] = [];
  const warnings: string[] = [];

  const events: ResearchEvent[] = [];
  const invalid: InvalidLine[] = [];
  let invalidCount = 0;
  let totalLines = 0;
  const sessionIds = new Set<string>();
  const conditions = new Set<string>();
  const counts: Partial<Record<ResearchEventName, number>> = {};
  let orchestratorRegressions = 0;
  let lastOrchestratorT = Number.NEGATIVE_INFINITY;
  let uncorrected = 0;

  const addInvalid = (line: number, event_name: string, issues: string[]) => {
    invalidCount += 1;
    if (invalid.length < maxListed) invalid.push({ line, event_name, issues });
  };

  for await (const { text, number } of readLines(paths.events)) {
    totalLines += 1;
    if (text.trim() === '') {
      addInvalid(number, 'unknown', ['empty_line']);
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      addInvalid(number, 'unknown', [`not_json: ${(error as Error).message}`]);
      continue;
    }
    const parsed = ResearchEvent.safeParse(raw);
    if (!parsed.success) {
      const name = (raw as { event?: unknown } | null)?.event;
      addInvalid(
        number,
        typeof name === 'string' ? name : 'unknown',
        parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
      );
      continue;
    }
    const event = parsed.data;
    events.push(event);
    sessionIds.add(event.session_id);
    conditions.add(event.condition);
    counts[event.event] = (counts[event.event] ?? 0) + 1;
    if (event.time_basis.source === 'orchestrator') {
      if (event.t_monotonic_ms < lastOrchestratorT) orchestratorRegressions += 1;
      lastOrchestratorT = Math.max(lastOrchestratorT, event.t_monotonic_ms);
    }
    // 別プロセス由来なのに補正の記録がないものは、payload の時刻を比較に使えない（追補2）。
    if (EVENT_ROUTES[event.event].origin !== 'node' && event.time_basis.source === 'orchestrator') {
      uncorrected += 1;
    }
  }
  if (!(await endsWithNewline(paths.events))) failures.push(`${INCOMPLETE_LINE}: 最後の行が途中で切れている`);

  if (invalidCount > 0) failures.push(`スキーマ不合格または壊れた行: ${invalidCount} 件`);
  if (events.length === 0) failures.push('有効なイベントが 0 件');
  if (sessionIds.size > 1) failures.push(`session_id が混在: ${[...sessionIds].join(', ')}`);
  if (orchestratorRegressions > 0) {
    warnings.push(`orchestrator の時計で t_monotonic_ms が逆行: ${orchestratorRegressions} 件`);
  }

  const quarantine = await countQuarantine(paths.quarantine);
  if (quarantine === null) warnings.push('quarantine.jsonl がない（SessionLog 以外で書かれた可能性）');
  else if (quarantine.total > 0) failures.push(`隔離されたイベント: ${quarantine.total} 件`);

  // manifest との照合
  const manifestFile = await readJsonIfExists(paths.manifest);
  const manifest = manifestFile.value as {
    closed?: boolean;
    close_error?: string | null;
    stats?: Record<string, unknown>;
    condition?: string;
    policy_id?: string;
    providers?: Record<string, { provider?: string; provider_class?: string; reason?: string | null }>;
  } | null;
  if (!manifestFile.found) warnings.push('manifest.json がない');
  else if (manifestFile.error !== null) failures.push(`manifest.json が読めない: ${manifestFile.error}`);
  else if (manifest !== null) {
    if (manifest.closed !== true) warnings.push('manifest の closed が false: 正常に終了していない（異常終了か process.exit）');
    else {
      const stats = manifest.stats ?? {};
      const written = stats.written;
      if (typeof written === 'number' && written !== totalLines) {
        failures.push(`manifest の written=${written} とファイルの行数 ${totalLines} が一致しない`);
      }
      const accepted = stats.accepted;
      if (typeof accepted === 'number' && typeof written === 'number' && accepted !== written) {
        failures.push(`書けなかったイベント: ${accepted - written} 件`);
      }
      if (typeof manifest.close_error === 'string') failures.push(`終了時のエラー: ${manifest.close_error}`);
    }
    const stats = manifest.stats ?? {};
    if (typeof stats.dropped_overflow === 'number' && stats.dropped_overflow > 0) {
      failures.push(`キューの上限で捨てたイベント: ${stats.dropped_overflow} 件`);
    }
    if (typeof stats.write_errors === 'number' && stats.write_errors > 0) {
      warnings.push(`書き込みエラーが発生（再試行で回復した可能性あり）: ${stats.write_errors} 回`);
    }
    if (typeof stats.after_close === 'number' && stats.after_close > 0) {
      warnings.push(`close のあとに届いて記録されなかったイベント: ${stats.after_close} 件`);
    }
  }

  if (uncorrected > 0) {
    warnings.push(`別プロセス由来だが time_basis が orchestrator のイベント: ${uncorrected} 件（遅延の区間から除外）`);
  }

  // プロバイダ
  const providers = new Map<string, { provider: string; provider_class: string; last_status: string }>();
  for (const event of events) {
    if (event.event === 'provider.status') {
      providers.set(event.provider, {
        provider: event.provider,
        provider_class: event.provider_class,
        last_status: event.status,
      });
    }
  }
  const evidenceReasons: string[] = [];
  if (providers.size === 0) evidenceReasons.push('provider.status がない');
  // manifest のプロバイダの区分は必ず見る（台本のプロバイダは自分で provider.status を出さないことがある）。
  const manifestProviders = manifest?.providers;
  if (manifest === null || manifestProviders === undefined || Object.keys(manifestProviders).length === 0) {
    evidenceReasons.push('manifest にプロバイダの区分がない');
  } else {
    for (const [kind, row] of Object.entries(manifestProviders)) {
      if (row.provider_class !== 'production') {
        evidenceReasons.push(`manifest の ${kind}（${row.provider ?? '?'}）は ${row.provider_class ?? '不明'}${row.reason ? `: ${row.reason}` : ''}`);
      }
      if (row.provider_class === 'production' && row.provider !== undefined && kind !== 'completion' && !providers.has(row.provider)) {
        evidenceReasons.push(`manifest の ${kind}（${row.provider}）の provider.status がない`);
      }
    }
  }
  if (manifest !== null && manifest.condition === undefined) evidenceReasons.push('manifest に条件がない');
  for (const row of providers.values()) {
    if (row.provider_class !== 'production') evidenceReasons.push(`${row.provider} は ${row.provider_class}`);
  }
  for (const event of events) {
    if (event.event === 'vap.state' && event.model_variant === 'FAKE_NOT_MAAI') {
      evidenceReasons.push('vap.state が偽サーバー（FAKE_NOT_MAAI）');
      break;
    }
  }
  if (evidenceReasons.length > 0) warnings.push(`受け入れの証拠に数えない: ${evidenceReasons.join('、')}`);

  // 時計差
  const clockBySource = new Map<string, ClockSyncSummary>();
  for (const event of events) {
    if (event.event !== 'clock.sync') continue;
    const row = clockBySource.get(event.source);
    if (row === undefined) {
      clockBySource.set(event.source, {
        source: event.source,
        n: 1,
        offset_ms_min: event.offset_ms,
        offset_ms_max: event.offset_ms,
        offset_ms_last: event.offset_ms,
        error_ms_max: event.error_ms,
        error_ms_last: event.error_ms,
      });
    } else {
      row.n += 1;
      row.offset_ms_min = Math.min(row.offset_ms_min, event.offset_ms);
      row.offset_ms_max = Math.max(row.offset_ms_max, event.offset_ms);
      row.offset_ms_last = event.offset_ms;
      row.error_ms_max = Math.max(row.error_ms_max, event.error_ms);
      row.error_ms_last = event.error_ms;
    }
  }
  const hasBrowserEvent = events.some((e) => EVENT_ROUTES[e.event].origin === 'browser');
  if (hasBrowserEvent && !clockBySource.has('browser_rtt')) {
    warnings.push('ブラウザ由来のイベントがあるのに clock.sync(browser_rtt) がない');
  }
  const hasVap = events.some((e) => e.event === 'vap.state');
  if (hasVap && !clockBySource.has('worker_audio_frame')) {
    warnings.push('vap.state があるのに clock.sync(worker_audio_frame) がない');
  }

  const times = events.map((e) => e.t_monotonic_ms);
  const first = events[0];
  const last = events[events.length - 1];

  const failed = options.strict ? [...failures, ...warnings] : failures;
  return {
    ok: failed.length === 0,
    path: paths.events,
    failures,
    warnings,
    total_lines: totalLines,
    valid_events: events.length,
    invalid_lines: invalid,
    invalid_line_count: invalidCount,
    quarantine_records: quarantine?.total ?? 0,
    quarantine_by_reason: quarantine?.byReason ?? {},
    session_ids: [...sessionIds],
    conditions: [...conditions],
    counts_by_event: counts,
    absent_events: EVENT_NAMES.filter((name) => counts[name] === undefined),
    t_monotonic_ms_range: times.length === 0 ? null : { min: Math.min(...times), max: Math.max(...times) },
    wall_clock_range: first && last ? { first: first.wall_clock, last: last.wall_clock } : null,
    manifest: {
      found: manifestFile.found,
      closed: manifest?.closed ?? null,
      stats: manifest?.stats ?? null,
      condition: manifest?.condition ?? null,
      policy_id: manifest?.policy_id ?? null,
      providers: manifest?.providers ?? null,
    },
    acceptance_evidence: { eligible: evidenceReasons.length === 0, reasons: evidenceReasons },
    providers: [...providers.values()],
    clock_sync: [...clockBySource.values()],
    cost: summarizeCost(events),
    latency: computeLatencyReport(events),
  };
}

function ms(value: number): string {
  return `${value.toFixed(1)}ms`;
}

/** 人が読む形。未計測は値を出さず「未計測」と書く。推定は推定と書く。 */
export function formatReport(report: LogCheckReport): string {
  const out: string[] = [];
  out.push(`ログ: ${report.path}`);
  out.push(`判定: ${report.ok ? '合格' : '不合格'}`);
  for (const failure of report.failures) out.push(`  失敗: ${failure}`);
  for (const warning of report.warnings) out.push(`  警告: ${warning}`);
  out.push(`行数 ${report.total_lines}、有効 ${report.valid_events}、不合格 ${report.invalid_line_count}、隔離 ${report.quarantine_records}`);
  for (const row of report.invalid_lines) out.push(`  ${row.line} 行目 (${row.event_name}): ${row.issues.join(' / ')}`);
  out.push(`セッション: ${report.session_ids.join(', ') || 'なし'}、条件: ${report.conditions.join(', ') || 'なし'}`);
  if (report.wall_clock_range) out.push(`時刻: ${report.wall_clock_range.first} 〜 ${report.wall_clock_range.last}`);
  out.push(`受け入れの証拠: ${report.acceptance_evidence.eligible ? '対象' : `対象外（${report.acceptance_evidence.reasons.join('、')}）`}`);

  out.push('イベント数:');
  for (const [name, count] of Object.entries(report.counts_by_event).sort()) out.push(`  ${name}: ${count}`);
  if (report.absent_events.length > 0) out.push(`  0 件: ${report.absent_events.join(', ')}`);

  out.push('プロバイダ:');
  if (report.providers.length === 0) out.push('  なし');
  for (const p of report.providers) out.push(`  ${p.provider} [${p.provider_class}] 最後の状態 ${p.last_status}`);

  out.push('時計差補正:');
  if (report.clock_sync.length === 0) out.push('  記録なし');
  for (const c of report.clock_sync) {
    out.push(
      `  ${c.source}: n=${c.n} offset 最後 ${ms(c.offset_ms_last)}（範囲 ${ms(c.offset_ms_min)}〜${ms(c.offset_ms_max)}）誤差 最後 ${ms(c.error_ms_last)}、最大 ${ms(c.error_ms_max)}`,
    );
  }

  const cost = report.cost;
  out.push('費用（定価からの推定。請求額ではない）:');
  if (cost.status === 'no_usage') out.push('  未計測（cost.usage なし）');
  else {
    const total = cost.estimated_usd === null ? '不明' : `推定 $${cost.estimated_usd.toFixed(4)}`;
    out.push(
      `  合計 ${total}${cost.status === 'partial' ? `（不明 ${cost.unknown_count} 件を含まない下限）` : ''}、${cost.event_count} 件`,
    );
    for (const p of cost.by_provider) {
      const usd = p.estimated_usd === null ? '不明' : `推定 $${p.estimated_usd.toFixed(4)}`;
      const quantities = p.quantities.map((q) => `${q.quantity} ${q.unit}`).join('、');
      const unknown = Object.entries(p.unknown_reasons)
        .map(([reason, n]) => `${reason}×${n}`)
        .join('、');
      out.push(`  ${p.provider}: ${usd}（${quantities}）${unknown ? ` 不明: ${unknown}` : ''}`);
    }
  }

  out.push('遅延（p50 / p90 / p95、n）:');
  for (const row of report.latency.rows) {
    const label = `${row.from} → ${row.to}${row.breakdown ? ` [${row.breakdown}]` : ''}`;
    const stat = row.stat;
    if (stat.status === 'unmeasured') out.push(`  ${label}: 未計測（${stat.reason}）`);
    else {
      const uncertainty = stat.uncertainty_ms_max === null ? '誤差不明' : `誤差≤${ms(stat.uncertainty_ms_max)}`;
      const negative = stat.negative_count > 0 ? `、負 ${stat.negative_count} 件` : '';
      out.push(`  ${label}: ${ms(stat.p50)} / ${ms(stat.p90)} / ${ms(stat.p95)}、n=${stat.n}、${uncertainty}${negative}`);
    }
    const excluded = Object.entries(stat.excluded);
    if (stat.status === 'measured' && excluded.length > 0) {
      out.push(`    除外: ${excluded.map(([reason, n]) => `${reason}×${n}`).join('、')}`);
    }
  }
  return `${out.join('\n')}\n`;
}
