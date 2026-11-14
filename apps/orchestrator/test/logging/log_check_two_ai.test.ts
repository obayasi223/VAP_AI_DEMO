// log_check の 2 体の規則（docs/design/two_ai/04 A、受け入れ基準の自動の列、T1。第 3 回 m8）。
// 合成のログ（fixtures/two_ai/synthetic_session.ts。架空の内容）を手で壊して検査する。既存の log_check.test.ts は変えない。
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkLog } from '../../../../tools/log_check/check';
import { buildSyntheticSession, writeSyntheticSession, type SyntheticOptions } from '../../../../fixtures/two_ai/synthetic_session';
import { SessionLog } from '../../src/logging';
import { SESSION, statusEvent } from './helpers';

type Raw = Record<string, unknown> & { event: string };

describe('log_check の 2 体の規則', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'log-check-two-ai-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function check(options: SyntheticOptions, mutate?: (events: Raw[], manifest: Record<string, unknown>) => Raw[] | void) {
    const session = buildSyntheticSession(options);
    const events = session.events as Raw[];
    const replaced = mutate?.(events, session.manifest) ?? events;
    const path = await writeSyntheticSession(join(dir, `s_${Math.random().toString(36).slice(2)}`), { events: replaced, manifest: session.manifest });
    return checkLog(path);
  }
  const failuresOf = (report: Awaited<ReturnType<typeof checkLog>>) => report.failures.filter((f) => f.startsWith('two_ai '));
  const rowOf = (report: Awaited<ReturnType<typeof checkLog>>, id: string) => report.two_ai?.rows.find((r) => r.id === id);

  it('① の self_run の通し（F.0 の途中の訂正、C への反論、end の撤回だけに slip がある）が合格する', async () => {
    const report = await check({ condition: 'respond_on_spot' });
    expect(report.failures).toEqual([]);
    expect(report.two_ai).not.toBeNull();
    expect(rowOf(report, 'AC3')).toMatchObject({ ok: true });
    expect(rowOf(report, 'AC3')!.detail).toContain('(h) 検査済み');
    expect(rowOf(report, 'AC20')).toMatchObject({ ok: true });
    // 撤回の発話に取り違えの文がある（AC3(h) の対象外）
    const session = buildSyntheticSession({ condition: 'respond_on_spot' });
    const retraction = session.events.filter((e) => e.event === 'speech.ended' && e.turn_kind === 'retraction').map((e) => e.spoken_text as string);
    expect(retraction.some((t) => t.includes('12 月末'))).toBe(true);
  });

  it('② の通し、② の黙る通し、研究のセッション（after_measures、保留の時間切れ）が合格する', async () => {
    for (const options of [
      { condition: 'respond_at_end' },
      { condition: 'respond_at_end', user_speaks: false },
      { condition: 'respond_on_spot', self_run: false, correction: 'hold_timeout' },
    ] as SyntheticOptions[]) {
      const report = await check(options);
      expect(report.failures, JSON.stringify(options)).toEqual([]);
    }
  });

  it('切り替えの前に出たカード 1 の元の文に slip の値があっても合格する（第 3 回 m1）', async () => {
    const report = await check({ condition: 'respond_on_spot', card1_before_switch_with_slip: true });
    expect(failuresOf(report)).toEqual([]);
  });

  it('null の llm.*（ledger、discussion_plan）と両方への gaze.decision を許す（第 4 回 M5）', async () => {
    const report = await check({ condition: 'respond_on_spot' }, (events) => {
      const ledger = events.find((e) => e.event === 'llm.request')!;
      const t = ledger.t_monotonic_ms as number;
      events.splice(events.indexOf(ledger) + 1, 0,
        { ...ledger, request_id: 'r_plan_1', purpose: 'discussion_plan', t_monotonic_ms: t },
        { ...ledger, event: 'gaze.decision', request_id: undefined, purpose: undefined, input: undefined, transcript_revision: undefined, sent_at: undefined, model_version: undefined, target: 'user', reason: 'face_both', p_now: { value: null, null_reason: 'x' }, p_future: { value: null, null_reason: 'x' }, in_speech_pause: false, vap_freshness: 'fresh' } as unknown as Raw,
      );
      for (const e of events) for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
    });
    expect(report.invalid_line_count).toBe(0);
    expect(failuresOf(report)).toEqual([]);
  });

  it('discussion_turn の llm.* で ai_id が null なら不合格', async () => {
    const report = await check({ condition: 'respond_on_spot' }, (events) => {
      const ledger = events.find((e) => e.event === 'llm.request')!;
      ledger.purpose = 'discussion_turn';
    });
    expect(failuresOf(report).join()).toContain('envelope');
  });

  it('受け止めの長さが合成と違うと AC1 で不合格', async () => {
    const report = await check({ condition: 'respond_on_spot' }, (events) => {
      const ep = events.find((e) => e.event === 'two_ai.interjection_episode' && e.ack !== null)!;
      (ep.ack as { played_ms: number }).played_ms += 400;
    });
    expect(rowOf(report, 'AC1')?.ok).toBe(false);
  });

  it('② の discussion で vap の停止があると AC5 で不合格', async () => {
    const report = await check({ condition: 'respond_at_end' }, (events) => {
      const i = events.findIndex((e) => e.event === 'speech.ended' && e.turn_kind === 'point_elaboration');
      const e = events[i]!;
      const { ended_at, ...rest } = e as Raw & { ended_at: number };
      events[i] = { ...rest, event: 'speech.interrupted', interrupted_at: ended_at, stop_point: 'word_boundary', decision_source: 'vap' };
    });
    expect(rowOf(report, 'AC5')?.ok).toBe(false);
    expect(rowOf(report, 'AC9')?.ok).toBe(false);
  });

  it('点の point_exposure が欠けると AC4 で不合格', async () => {
    const report = await check({ condition: 'respond_on_spot' }, (events) => events.filter((e) => !(e.event === 'two_ai.point_exposure' && e.point_id === 'C1')));
    expect(rowOf(report, 'AC4')?.ok).toBe(false);
  });

  it('接触秒数が発話の samples_written の和と合わないと AC4 で不合格', async () => {
    const report = await check({ condition: 'respond_at_end' }, (events) => {
      const e = events.find((x) => x.event === 'two_ai.point_exposure' && x.point_id === 'ctl1')!;
      e.exposure_total_ms = (e.exposure_total_ms as number) + 50;
      e.exposure_new_ms = (e.exposure_new_ms as number) + 50;
    });
    expect(rowOf(report, 'AC4')?.ok).toBe(false);
  });

  it('切替の重複は AC3(a) で不合格', async () => {
    const report = await check({ condition: 'respond_on_spot' }, (events) => {
      const sw = events.find((e) => e.event === 'two_ai.script' && e.stage === 'switched')!;
      events.splice(events.indexOf(sw) + 1, 0, { ...sw });
    });
    expect(rowOf(report, 'AC3')?.detail).toContain('(a)');
  });

  it('uptake の後の discussion の発話に slip があると AC3(h) で不合格', async () => {
    const report = await check({ condition: 'respond_on_spot' }, (events) => {
      const e = events.find((x) => x.event === 'speech.ended' && x.turn_kind === 'point_elaboration' && x.point_id === 'fact1')!;
      e.spoken_text = 'インターンの締切は 12 月末なので、説明会は録画で済ませましょう。';
    });
    expect(rowOf(report, 'AC3')?.ok).toBe(false);
    expect(rowOf(report, 'AC3')?.detail).toContain('(h)');
  });

  it('保留が corrected なのに resume があると AC3(j) で不合格', async () => {
    const report = await check({ condition: 'respond_on_spot' }, (events) => {
      const t = events.find((x) => x.event === 'two_ai.turn' && x.stage === 'started' && x.turn_kind === 'uptake')!;
      t.turn_kind = 'resume';
    });
    expect(rowOf(report, 'AC3')?.ok).toBe(false);
    expect(rowOf(report, 'AC3')?.detail).toMatch(/\(j\)|\(i\)/);
  });

  it('時間切れの保留で bridge が 2 回あると AC3(j) で不合格', async () => {
    const report = await check({ condition: 'respond_on_spot', self_run: false, correction: 'hold_timeout' }, (events) => {
      const t = events.find((x) => x.event === 'two_ai.turn' && x.stage === 'started' && x.turn_kind === 'bridge')!;
      events.splice(events.indexOf(t) + 1, 0, { ...t, turn_id: 't_9999' });
    });
    expect(rowOf(report, 'AC3')?.detail).toContain('bridge が 2 回');
  });

  it('旗が無効なのに interjection_fed があると AC12 で不合格', async () => {
    const report = await check({ condition: 'respond_on_spot' }, (events) => {
      const ep = events.find((e) => e.event === 'two_ai.interjection_episode')!;
      events.push({ ...ep, event: 'two_ai.interjection_fed', outcome: undefined } as unknown as Raw);
      const fed = events.at(-1)!;
      for (const k of Object.keys(fed)) if (!['schema_version', 't_monotonic_ms', 'wall_clock', 'session_id', 'condition', 'time_basis', 'two_ai', 'event', 'interjection_id', 'asr_segment_ids'].includes(k)) delete fed[k];
      Object.assign(fed, { chars: 10, accepted: true, excluded_reason: null, invalidated_turn_ids: [], target: 'next_live_turn' });
    });
    expect(rowOf(report, 'AC12')?.ok).toBe(false);
  });

  it('旗が有効なセッションは探索として区別される（AC12）', async () => {
    const report = await check({ condition: 'respond_on_spot', feeds: true });
    expect(failuresOf(report)).toEqual([]);
    expect(rowOf(report, 'AC12')?.detail).toContain('探索');
  });

  it('同期の印が欠けると AC19、撤回のハッシュが合わないと AC20 で不合格', async () => {
    const r1 = await check({ condition: 'respond_at_end' }, (events) => events.filter((e) => !(e.event === 'two_ai.sync_mark' && e.trigger === 'stage_3')));
    expect(rowOf(r1, 'AC19')?.ok).toBe(false);
    const r2 = await check({ condition: 'respond_at_end' }, (events) => {
      const r = events.find((e) => e.event === 'two_ai.retraction')!;
      r.script_sha256 = 'deadbeef';
    });
    expect(rowOf(r2, 'AC20')?.ok).toBe(false);
  });

  it('研究のセッション（self_run: false）で end_of_session の撤回は AC20(b) で不合格', async () => {
    const report = await check({ condition: 'respond_at_end', self_run: false }, (events) => {
      const r = events.find((e) => e.event === 'two_ai.retraction')!;
      r.timing = 'end_of_session';
    });
    expect(rowOf(report, 'AC20')?.ok).toBe(false);
  });

  it('1 対 1 のログには 2 体の規則を掛けない（AC10）', async () => {
    const log = await SessionLog.open({ dir, session_id: SESSION, reporter: () => undefined });
    await log.describe({ condition: 'reactive', policy_id: 'ja', providers: { stt: { provider: 'p', provider_class: 'production', reason: null } } });
    log.write(statusEvent(1));
    const { paths } = await log.close();
    const report = await checkLog(paths.dir);
    expect(report.ok).toBe(true);
    expect(report.two_ai).toBeNull();
  });
});
