import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TwoAiSessionConfig } from '@llm-vap/contracts';
import { loadDiscussionAssets } from '../../../apps/orchestrator/src/cognition/discussion/assets';
import { ProbeMockLlm } from '../lib/mock_llm';
import { formatReport, runProbe, syntheticLedger } from '../lib/run';
import { holdMaxMs, latencyStats, percentile, planWaitProposal } from '../lib/stats';
import { correctionCases, DEFAULT_SLIP } from '../lib/synthetic';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const config = TwoAiSessionConfig.parse(JSON.parse(readFileSync(path.join(ROOT, 'config/two_ai/session.ja.json'), 'utf8')));

describe('two_ai_probe の集計', () => {
  it('中央値と p95（最近順位法）', () => {
    const v = Array.from({ length: 20 }, (_, i) => (i + 1) * 100);
    expect(percentile(v, 50)).toBe(1000);
    expect(percentile(v, 95)).toBe(1900);
    expect(latencyStats([])).toEqual({ n: 0, median_ms: null, p95_ms: null, max_ms: null });
    expect(latencyStats([300, 100, 200]).median_ms).toBe(200);
  });

  it('hold_max_ms は STT と (e) の p95 の和 ＋ 1500 と 6000 の大きい方（STT 未計測は 1500 と仮に置く）', () => {
    expect(holdMaxMs(null, 1000)).toBe(6000);
    expect(holdMaxMs(null, 4000)).toBe(7000);
    expect(holdMaxMs(2500, 3000)).toBe(7000);
    expect(holdMaxMs(null, null)).toBeNull();
  });

  it('計画の待ちの提案：余裕 1.5 倍の切り上げ、plan_start_sec は min_sec を下回らない', () => {
    expect(planWaitProposal(12300, { min_sec: 180, soft_sec: 240 })).toEqual({ max_wait_ms: 19000, plan_start_sec: 227 });
    expect(planWaitProposal(90000, { min_sec: 180, soft_sec: 240 })?.plan_start_sec).toBe(180);
    expect(planWaitProposal(null, { min_sec: 180, soft_sec: 240 })).toBeNull();
  });

  it('訂正の発話は訂正と反論が半々で、反論に正しい値を含まない', () => {
    const cases = correctionCases(DEFAULT_SLIP, 30);
    expect(cases).toHaveLength(30);
    expect(cases.filter((c) => c.corrects)).toHaveLength(15);
    for (const c of cases) if (!c.corrects) expect(c.utterance).not.toContain(DEFAULT_SLIP.correct_value);
  });

  it('合成の台帳は逐語の検査を通り、取り違えに使える事実を 2 つ持つ', () => {
    const ledger = syntheticLedger();
    expect(ledger.facts.filter((f) => f.slip_eligible)).toHaveLength(2);
    expect(ledger.core?.text).toBeTruthy();
  });
});

describe('two_ai_probe の偽の LLM での実行', () => {
  it('計画、ターン、訂正の判定を回して提案を出す（本文は出さない）', async () => {
    const assets = loadDiscussionAssets(ROOT, config);
    const plan = new ProbeMockLlm();
    const turn = new ProbeMockLlm();
    const correction = new ProbeMockLlm();
    const report = await runProbe({ config, assets, llms: { plan, turn, correction }, options: { turns: 4, corrections: 6, stt_p95_ms: null } });
    expect(plan.calls).toHaveLength(4); // 段 1 と点・板、段 2〜4
    expect(report.stages.map((s) => s.ok)).toEqual([true, true, true]);
    expect(turn.calls).toHaveLength(4);
    expect(correction.calls).toHaveLength(6);
    expect(report.plan.ok).toBe(true);
    expect(report.plan.source).toBe('generated');
    expect(report.turns.stats.n).toBe(4);
    expect(report.correction.stats.n).toBe(6);
    expect(report.stt.measured).toBe(false);
    expect(report.proposal.hold_max_ms).toBeGreaterThanOrEqual(6000);
    expect(report.proposal.plan_wait?.max_wait_ms).toBeGreaterThan(0);
    const text = formatReport(report, 'mock');
    expect(text).toContain('仮の値');
    for (const u of ['面接は来月の10日', 'タナカ']) expect(text).not.toContain(u);
  });
});
