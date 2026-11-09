import { spawnSync } from 'node:child_process';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VALID_FIXTURES } from '../../../../packages/contracts/src/fixtures';
import { EVENT_NAMES } from '@llm-vap/contracts';
import { checkLog, formatReport } from '../../../../tools/log_check/check';
import { SessionLog } from '../../src/logging';
import { BROWSER, costEvent, envelope, SESSION, statusEvent } from './helpers';

const repo = resolve(import.meta.dirname, '../../../..');
const quiet = () => undefined;

describe('checkLog', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'log-check-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const PRODUCTION_MANIFEST = {
    condition: 'reactive' as const,
    policy_id: 'ja',
    providers: { stt: { provider: 'p', provider_class: 'production' as const, reason: null } },
  };

  async function session(
    events = [statusEvent(1), costEvent('elevenlabs', 'characters', 1000, 0.04, 'x', 2)],
    details: Parameters<SessionLog['describe']>[0] | null = PRODUCTION_MANIFEST,
  ) {
    const log = await SessionLog.open({ dir, session_id: SESSION, reporter: quiet });
    if (details !== null) await log.describe(details);
    for (const event of events) log.write(event);
    const report = await log.close();
    return report.paths;
  }

  it('SessionLog が書いたログは合格し、集計が出る', async () => {
    const paths = await session();
    const report = await checkLog(paths.dir);
    expect(report.failures).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.valid_events).toBe(2);
    expect(report.counts_by_event).toEqual({ 'provider.status': 1, 'cost.usage': 1 });
    expect(report.absent_events).toContain('vap.state');
    expect(report.session_ids).toEqual([SESSION]);
    expect(report.acceptance_evidence.eligible).toBe(true);
    expect(report.cost.estimated_usd).toBeCloseTo(0.04, 10);
    expect(report.manifest).toMatchObject({ found: true, closed: true });
    expect(report.latency.rows.every((r) => r.stat.status === 'unmeasured')).toBe(true);
  });

  it('契約の全イベント種の例が書けて、読み戻して合格する', async () => {
    const log = await SessionLog.open({ dir, session_id: SESSION, reporter: quiet });
    const fixtures = VALID_FIXTURES.events;
    for (const { value } of fixtures) log.writeUnknown({ ...(value as object), session_id: SESSION });
    const { paths, stats } = await log.close();
    expect(stats.quarantined).toBe(0);
    expect(stats.written).toBe(fixtures.length);
    const report = await checkLog(paths.dir);
    expect(report.failures).toEqual([]);
    expect(report.invalid_line_count).toBe(0);
    expect(report.absent_events).toEqual([]);
    expect(Object.keys(report.counts_by_event).sort()).toEqual([...EVENT_NAMES].sort());
  });

  it('events.jsonl のパスでも読める', async () => {
    const paths = await session();
    expect((await checkLog(paths.events)).ok).toBe(true);
  });

  it('壊れた行、JSON でない行、スキーマ不合格を行番号つきで報告して不合格', async () => {
    const paths = await session();
    await appendFile(paths.events, 'not json\n');
    await appendFile(paths.events, `${JSON.stringify({ event: 'provider.status', extra: 1 })}\n`);
    await appendFile(paths.events, '\n');
    const report = await checkLog(paths.dir);
    expect(report.ok).toBe(false);
    expect(report.invalid_line_count).toBe(3);
    expect(report.invalid_lines.map((l) => l.line)).toEqual([3, 4, 5]);
    expect(report.invalid_lines[0]?.issues[0]).toMatch(/not_json/);
    expect(report.invalid_lines[1]?.event_name).toBe('provider.status');
    expect(report.valid_events).toBe(2);
  });

  it('途中で切れた最後の行を検出する', async () => {
    const paths = await session();
    await appendFile(paths.events, '{"event":"provider.st');
    const report = await checkLog(paths.dir);
    expect(report.ok).toBe(false);
    expect(report.failures.join('\n')).toMatch(/途中で切れている/);
  });

  it('manifest の行数と一致しなければ不合格（行が消えた、増えた）', async () => {
    const paths = await session();
    const text = await readFile(paths.events, 'utf8');
    await writeFile(paths.events, `${text.split('\n')[0]}\n`);
    const report = await checkLog(paths.dir);
    expect(report.ok).toBe(false);
    expect(report.failures.join('\n')).toMatch(/一致しない/);
  });

  it('隔離の記録があれば不合格で、理由別に数える', async () => {
    const log = await SessionLog.open({ dir, session_id: SESSION, reporter: quiet });
    log.write(statusEvent(1));
    log.writeUnknown({ broken: true });
    const { paths } = await log.close();
    const report = await checkLog(paths.dir);
    expect(report.ok).toBe(false);
    expect(report.quarantine_records).toBe(1);
    expect(report.quarantine_by_reason).toEqual({ schema_invalid: 1 });
  });

  it('捨てたイベントが manifest にあれば不合格', async () => {
    const log = await SessionLog.open({ dir, session_id: SESSION, reporter: quiet, maxQueueBytes: 400 });
    for (let i = 0; i < 20; i++) log.write(statusEvent(i));
    const { paths, stats } = await log.close();
    expect(stats.dropped_overflow).toBeGreaterThan(0);
    const report = await checkLog(paths.dir);
    expect(report.ok).toBe(false);
    expect(report.failures.join('\n')).toMatch(/捨てたイベント/);
  });

  it('正常に閉じていないログは警告で、--strict なら不合格', async () => {
    const paths = await session();
    const manifest = JSON.parse(await readFile(paths.manifest, 'utf8'));
    await writeFile(paths.manifest, JSON.stringify({ ...manifest, closed: false }));
    const report = await checkLog(paths.dir);
    expect(report.ok).toBe(true);
    expect(report.warnings.join('\n')).toMatch(/正常に終了していない/);
    expect((await checkLog(paths.dir, { strict: true })).ok).toBe(false);
  });

  it('manifest がなくても読めて、警告を出す', async () => {
    const paths = await session();
    await rm(paths.manifest);
    const report = await checkLog(paths.dir);
    expect(report.manifest.found).toBe(false);
    expect(report.warnings.join('\n')).toMatch(/manifest.json がない/);
  });

  it('0 件は不合格', async () => {
    const paths = await session([]);
    expect((await checkLog(paths.dir)).failures.join('\n')).toMatch(/0 件/);
  });

  it('test double を含むセッションは受け入れの証拠に数えない', async () => {
    const paths = await session([statusEvent(1, 'scripted_stt', 'test_double')], {
      ...PRODUCTION_MANIFEST,
      providers: { stt: { provider: 'scripted_stt', provider_class: 'test_double', reason: null } },
    });
    const report = await checkLog(paths.dir);
    expect(report.acceptance_evidence).toEqual({
      eligible: false,
      reasons: ['manifest の stt（scripted_stt）は test_double', 'scripted_stt は test_double'],
    });
  });

  describe('提案条件で交渉が動かなかったセッション', () => {
    const initiative = (candidates_used_for: string, reason: string | null = null) => ({
      running: reason === null,
      reason,
      prompt_version: null,
      model: null,
      persona_id: null,
      persona_version: null,
      candidates_used_for,
    });

    it('condition が initiative_inhale でも交渉が動いていなければ証拠に数えない', async () => {
      const paths = await session(undefined, {
        ...PRODUCTION_MANIFEST,
        condition: 'initiative_inhale',
        initiative: initiative('log_and_research_view_only', 'persona_not_loaded'),
      });
      const report = await checkLog(paths.dir);
      expect(report.acceptance_evidence.eligible).toBe(false);
      expect(report.acceptance_evidence.reasons).toEqual(['条件 initiative_inhale で交渉が動いていない（log_and_research_view_only: persona_not_loaded）']);
    });

    it('manifest に交渉の記録がなければ提案条件は証拠に数えない', async () => {
      const paths = await session(undefined, { ...PRODUCTION_MANIFEST, condition: 'initiative_no_cue' });
      expect((await checkLog(paths.dir)).acceptance_evidence.reasons).toEqual(['条件 initiative_no_cue で交渉が動いていない（manifest に記録なし）']);
    });

    it('initiative_no_cue に signal.* があれば失敗にする（影の合図は提示しない）', async () => {
      const signal = envelope({ event: 'signal.sent', candidate_id: 'c_0001', phase: 'inhale', parameters: {}, sent_at: 100 }, 100);
      const paths = await session([statusEvent(1), signal], { ...PRODUCTION_MANIFEST, condition: 'initiative_no_cue', initiative: initiative('negotiation:initiative_no_cue') });
      const report = await checkLog(paths.dir);
      expect(report.failures.some((f) => f.includes('initiative_no_cue なのに合図の提示の記録がある'))).toBe(true);
    });

    it('交渉が動いていれば証拠に数える。reactive は交渉の有無を問わない', async () => {
      const paths = await session(undefined, { ...PRODUCTION_MANIFEST, condition: 'initiative_inhale', initiative: initiative('negotiation:initiative_inhale') });
      expect((await checkLog(paths.dir)).acceptance_evidence.eligible).toBe(true);
    });
  });

  it('manifest にプロバイダの区分がなければ、provider.status が production でも証拠に数えない', async () => {
    const paths = await session(undefined, null);
    const report = await checkLog(paths.dir);
    expect(report.acceptance_evidence).toEqual({
      eligible: false,
      reasons: ['manifest にプロバイダの区分がない', 'manifest に条件がない'],
    });
  });

  it('台本のプロバイダが provider.status を出さなくても、manifest の区分で証拠から外す', async () => {
    const paths = await session([statusEvent(1, 'session_log', 'production')], {
      ...PRODUCTION_MANIFEST,
      providers: {
        stt: { provider: 'scripted_stt_energy', provider_class: 'test_double', reason: null },
        tts: { provider: 'tts_unavailable', provider_class: 'unavailable', reason: 'tts_unavailable:no key' },
      },
    });
    const report = await checkLog(paths.dir);
    expect(report.acceptance_evidence.eligible).toBe(false);
    expect(report.acceptance_evidence.reasons).toEqual([
      'manifest の stt（scripted_stt_energy）は test_double',
      'manifest の tts（tts_unavailable）は unavailable: tts_unavailable:no key',
    ]);
    expect(report.manifest).toMatchObject({ condition: 'reactive', policy_id: 'ja' });
  });

  it('provider.status がなければ証拠に数えない', async () => {
    const paths = await session([costEvent('x', 'y', 1, null)]);
    expect((await checkLog(paths.dir)).acceptance_evidence.eligible).toBe(false);
  });

  it('時計差補正の値を集計し、補正なしのブラウザ由来イベントを警告する', async () => {
    const sync = (offset: number, error: number, t: number) =>
      envelope({ event: 'clock.sync', source: 'browser_rtt', offset_ms: offset, error_ms: error, rtt_ms: { value: error * 2 } }, t);
    const speech = (basis?: typeof BROWSER) =>
      envelope(
        {
          event: 'speech.started',
          origin: 'response',
          audio_playback_id: 1,
          audio_frame: 0,
          started_at: 5,
          first_pcm_written_at: 5,
          output_latency_ms: { value: 1 },
        },
        5,
        basis,
      );
    const paths = await session([statusEvent(1), sync(10, 1, 2), sync(12, 3, 3), speech(BROWSER), speech()]);
    const report = await checkLog(paths.dir);
    expect(report.clock_sync).toEqual([
      {
        source: 'browser_rtt',
        n: 2,
        offset_ms_min: 10,
        offset_ms_max: 12,
        offset_ms_last: 12,
        error_ms_max: 3,
        error_ms_last: 3,
      },
    ]);
    expect(report.warnings.join('\n')).toMatch(/time_basis が orchestrator のイベント: 1 件/);
  });

  it('ブラウザ由来のイベントがあるのに clock.sync がなければ警告する', async () => {
    const paths = await session([
      envelope(
        {
          event: 'signal.started',
          candidate_id: 'c',
          phase: 'inhale',
          parameters: {},
          visible: true,
          started_at: 1,
        },
        1,
        BROWSER,
      ),
    ]);
    expect((await checkLog(paths.dir)).warnings.join('\n')).toMatch(/clock.sync\(browser_rtt\) がない/);
  });

  it('session_id の混在を検出する', async () => {
    const paths = await session();
    await appendFile(paths.events, `${JSON.stringify({ ...statusEvent(3), session_id: 'other' })}\n`);
    expect((await checkLog(paths.dir)).failures.join('\n')).toMatch(/混在/);
  });

  it('人が読む形は未計測を 0 と書かず、費用を推定と書く', async () => {
    const paths = await session();
    const text = formatReport(await checkLog(paths.dir));
    expect(text).toMatch(/判定: 合格/);
    expect(text).toMatch(/未計測/);
    expect(text).toMatch(/推定 \$0\.0400/);
    expect(text).toMatch(/請求額ではない/);
    expect(text).not.toMatch(/0\.0ms \/ 0\.0ms/);
  });

  describe('CLI', () => {
    const tsx = join(repo, 'node_modules/.bin/tsx');
    const run = (...args: string[]) =>
      spawnSync(tsx, [join(repo, 'tools/log_check/cli.ts'), ...args], { encoding: 'utf8', cwd: repo });

    it('合格で 0、不合格で 1、読めなければ 2 を返す', async () => {
      const paths = await session();
      const passed = run(paths.dir);
      expect(passed.stdout).toMatch(/判定: 合格/);
      expect(passed.status).toBe(0);
      const json = run(paths.dir, '--json');
      expect(JSON.parse(json.stdout).valid_events).toBe(2);

      await appendFile(paths.events, 'broken\n');
      const failed = run(paths.dir);
      expect(failed.status).toBe(1);
      expect(failed.stdout).toMatch(/判定: 不合格/);

      expect(run(join(dir, 'missing')).status).toBe(2);
      expect(run().status).toBe(2);
    }, 60000);
  });
});
