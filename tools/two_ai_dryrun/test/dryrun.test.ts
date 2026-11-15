// 試走の道具（04 T4）：本人の台本、偽の VAP、旗の比較、--synthetic の流れ、統合の試走（integrated.ts）。
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSyntheticSession } from '../../../fixtures/two_ai/synthetic_session';
import { runReport } from '../../two_ai_report/cli';
import { sessionFromValues } from '../../two_ai_report/session';
import { runDryrun, type DryrunOptions } from '../cli';
import { compareFeeds } from '../compare_feeds';
import { FakeVapFromScript } from '../fake_vap';
import { loadUserScript, resolveUserTimeline } from '../user_script';

const repo = resolve(import.meta.dirname, '../../..');
const fixtures = readdirSync(join(repo, 'fixtures/two_ai')).filter((f) => f.startsWith('dryrun_user.'));

describe('本人の台本', () => {
  it('fixtures/two_ai の 4 つが読める', () => {
    expect(fixtures.sort()).toEqual(['dryrun_user.feeds_compare.json', 'dryrun_user.respond_at_end.json', 'dryrun_user.respond_on_spot.json', 'dryrun_user.silent.json']);
    for (const f of fixtures) expect(() => loadUserScript(join(repo, 'fixtures/two_ai', f))).not.toThrow();
  });

  it('点と段階の開始から絶対時刻に直す。基準がまだない行動は保留として数える', () => {
    const script = loadUserScript(join(repo, 'fixtures/two_ai/dryrun_user.respond_on_spot.json'));
    const partial = resolveUserTimeline(script, { session_start_ms: 0, phase_started_ms: { intake: 1000, discussion: 60000 }, point_started_ms: { fact1: 80000 }, stage_started_ms: {} });
    expect(partial.actions.filter((a) => a.kind === 'voice').map((a) => a.at_ms)).toEqual([4000, 15000, 27000, 82500]);
    expect(partial.pending).toBe(6);
    const full = resolveUserTimeline(script, { session_start_ms: 0, phase_started_ms: { intake: 1000, discussion: 60000, response: 200000, next_step: 260000 }, point_started_ms: { fact1: 80000, ctl1: 110000, C1: 140000 }, stage_started_ms: {} });
    expect(full.pending).toBe(0);
    expect(full.actions.map((a) => a.kind)).toEqual(['voice', 'voice', 'voice', 'voice', 'marker', 'onset_only', 'voice', 'marker', 'voice', 'pick']);
    expect(full.actions.at(-1)).toMatchObject({ kind: 'pick', order: 3, at_ms: 266000 });
  });

  it('② の台本には研究者の訂正の押下がある（② で拒否されることを見る）', () => {
    const script = loadUserScript(join(repo, 'fixtures/two_ai/dryrun_user.respond_at_end.json'));
    expect(script.utterances.some((u) => 'woz' in u && u.woz === 'correction')).toBe(true);
  });
});

describe('FakeVapFromScript', () => {
  const vap = new FakeVapFromScript([
    { kind: 'voice', at_ms: 1000, duration_ms: 1000, text: 'x', woz: null, source: 's' },
    { kind: 'onset_only', at_ms: 5000, ramp_ms: 300, source: 's' },
  ]);
  it('声の区間で本人の vad と p が上がり、AI の再生で sys の vad が上がる', () => {
    expect(vap.frame(500, false).vad[0]).toBeLessThan(0.1);
    expect(vap.frame(1500, false).vad[0]).toBeGreaterThan(0.8);
    expect(vap.frame(1500, false).p_now[0]).toBeGreaterThan(0.5);
    expect(vap.frame(900, false).p_future[0]).toBeGreaterThan(0.5); // 声の前に先の見込みが上がる
    expect(vap.frame(1500, true).vad[1]).toBeGreaterThan(0.8);
    expect(vap.frame(3000, false).vad[0]).toBeLessThan(0.1);
  });
  it('兆しだけは短く弱く上がって消える（声にならない）', () => {
    const peak = Math.max(...vap.frames(5000, 5400, () => false, 10).map((f) => f.vad[0]));
    expect(peak).toBeGreaterThan(0.3);
    expect(peak).toBeLessThan(0.7);
    expect(vap.frame(5400, false).vad[0]).toBeLessThan(0.1);
    expect(vap.voicedSegments()).toEqual([{ start_ms: 1000, end_ms: 2000, text: 'x' }]);
  });
});

describe('旗の比較', () => {
  it('旗ありでだけ feed_turn と turn_v1_feed、点のブロックは同じ（AC12(d)）', () => {
    const load = (feeds: boolean) => {
      const s = buildSyntheticSession({ condition: 'respond_on_spot', feeds, session_id: `f_${feeds}` });
      return sessionFromValues(s.events, s.manifest, { config: s.config, script: s.script });
    };
    const cmp = compareFeeds(load(false), load(true));
    expect(cmp.points_identical).toBe(true);
    expect(cmp.feed_section_ok).toBe(true);
    expect(cmp.markdown).toContain('締切の話だというご指摘');
  });
});

describe('runDryrun', () => {
  let dir: string;
  const base = (over: Partial<DryrunOptions>): DryrunOptions => ({
    condition: 'respond_on_spot', both: false, compareFeeds: false, synthetic: false, feeds: false, providers: 'fake',
    config: 'config/two_ai/session.demo_short.ja.json', script: 'config/two_ai/scripts/demo_career.ja.json', user: null, out: dir, ...over,
  });
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'two-ai-dryrun-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('統合の試走（① の 1 本、偽のプロバイダ）が log_check と要約に合格し、設定と台本の検査を先に行う', async () => {
    const r = await runDryrun(base({}));
    expect(r.messages.filter((m) => m.includes('不合格'))).toEqual([]);
    expect(r.exit_code).toBe(0);
    expect(r.sessions).toHaveLength(1);
    await expect(runDryrun(base({ config: 'config/two_ai/scripts/demo_career.ja.json' }))).rejects.toThrow();
  }, 120_000);

  it('応答版（--mode responsive --both）：log_check と要約に合格し、本人の発話が台帳と板の根拠に入る', async () => {
    const r = await runDryrun(base({ both: true, mode: 'responsive' }));
    expect(r.messages.filter((m) => m.includes('不合格'))).toEqual([]);
    expect(r.exit_code).toBe(0);
    expect(r.sessions).toHaveLength(2);
    for (const s of r.sessions) {
      expect(s).toContain('_responsive');
      const events = (await readFile(join(s, 'events.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
      const captured = events.filter((e) => e.event === 'two_ai.capture' && e.stage === 'captured').flatMap((e) => e.item_ids as string[]);
      expect(captured.length).toBeGreaterThan(0);
      const boards = events.filter((e) => e.event === 'two_ai.board_generated' && e.stage === 'generated');
      const closing = boards.filter((b) => b.trigger === 'closing').at(-1)!;
      expect(closing).toBeDefined();
      const grounds = (closing.cards as { ledger_item_ids: string[] }[]).flatMap((c) => c.ledger_item_ids);
      expect(grounds.some((id) => captured.includes(id))).toBe(true);
    }
    // --coding の取得と反映：発話ごとに台帳の項目と板のカードが結ばれる（本文は入らない）
    await runReport(r.sessions, { coding: true });
    for (const s of r.sessions) {
      const rows = (await readFile(join(s, 'coding', 'coding_uptake.csv'), 'utf8')).trim().split('\n');
      expect(rows[0]).toContain('capture_stage');
      expect(rows.slice(1).some((l) => l.includes('captured') && /,c[^,]*;?[^,]*,\d+,stt:/u.test(l))).toBe(true);
    }
  }, 180_000);

  it('--synthetic --both --compare-feeds：書き出し、log_check、並べ、旗の比較が通る', async () => {
    const r = await runDryrun(base({ synthetic: true, both: true, compareFeeds: true }));
    expect(r.messages.filter((m) => m.includes('不合格'))).toEqual([]);
    expect(r.exit_code).toBe(0);
    expect(await readFile(join(dir, 'dryrun_respond_on_spot', 'two_ai_pair.md'), 'utf8')).toContain('並べて見る基準');
    expect(await readFile(join(dir, 'feeds_compare.md'), 'utf8')).toContain('AC12(d)');
  });
});
