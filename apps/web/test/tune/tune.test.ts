// 調整画面（/tune）の部品。vitest の include は *.test.ts だけなので JSX を使わない。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { VALID_FIXTURES } from '../../../../packages/contracts/src/fixtures';
import { PolicyJa, type TuneMetricSet, type TunePolicyLeaf, type TurnDiagnosticBody } from '@llm-vap/contracts';
import { createFakeEventScript } from '../../src/research/fake_events';
import { allowedSpans, avertSpans, outcomeBand, quantile, voicedSpans } from '../../src/tune/chart_spec';
import { buildInitiativeFlow } from '../../src/tune/initiative_flow';
import { TuneLiveStore } from '../../src/tune/live_store';
import { parseOfflineLog } from '../../src/tune/offline_log';
import { changedPaths, deleteAt, getAt, replayEffect, setAt, sliderRange, thresholdLines } from '../../src/tune/policy_edit';
import { DiagnosticTable, FlowTable, MetricsTable } from '../../src/tune/TuneTables';

const repoRoot = join(import.meta.dirname, '..', '..', '..', '..');
const policy = (): PolicyJa => PolicyJa.parse(JSON.parse(readFileSync(join(repoRoot, 'config', 'policy.ja.json'), 'utf8')));

const leaf = (path: string, extra: Partial<TunePolicyLeaf> = {}): TunePolicyLeaf => ({
  path,
  kind: 'number',
  nullable: false,
  optional_parent: null,
  minimum: 0,
  maximum: null,
  options: null,
  description: null,
  ...extra,
});

const diag = (t: number): TurnDiagnosticBody => ({
  t_monotonic_ms: t,
  vap_freshness: 'fresh',
  ai_phase: 'silent',
  user_speaking: false,
  p_now_ai: 0.7,
  p_future_ai: 0.6,
  vad_user: 0.1,
  gap_ms: 950,
  since_turn_end_ms: 300,
  min_gap_ms: 900,
  completion_p: 0.4,
  completion_revision: 3,
  yield_timeout_ms: 500,
  completion_wait_ms: 1500,
  permitted_to_speak: false,
  want_to_speak: 'ready',
  invitation: { detected: false },
  branches: [
    { id: 'L64', label: 'VAP が譲渡を示す', holds: true, detail: 'p_now=0.70>0.5' },
    { id: 'L74', label: '完了の待ち', holds: false, detail: '950<1500' },
  ],
  last_turn_allowed_reason: 'no_yield_signal',
});

describe('方策の編集', () => {
  it('路で読み書きし、元は変えない。省略できる節を消せる', () => {
    const p = policy();
    const edited = setAt(p, 'turn.constants.VAP_PNOW_YIELD', 0.6);
    expect(getAt(edited, 'turn.constants.VAP_PNOW_YIELD')).toBe(0.6);
    expect(p.turn.constants.VAP_PNOW_YIELD).toBe(0.5);
    const leaves = [leaf('turn.constants.VAP_PNOW_YIELD'), leaf('gaze.p_threshold')];
    expect(changedPaths(leaves, p, edited)).toEqual(['turn.constants.VAP_PNOW_YIELD']);
    const removed = deleteAt(p, 'turn.start_guard');
    expect(getAt(removed, 'turn.start_guard')).toBeUndefined();
    expect(getAt(p, 'turn.start_guard')).toBeDefined();
  });

  it('再生に効く節の札と、スライダーの範囲', () => {
    expect(replayEffect('turn.start_guard.min_gap_ms')).toBe('turn');
    expect(replayEffect('gaze.p_threshold')).toBe('turn');
    expect(replayEffect('initiative.trigger.min_new_stable_chars')).toBe('initiative_trigger');
    expect(replayEffect('initiative.max_active_candidates')).toBe('none');
    expect(sliderRange(leaf('gaze.p_threshold', { maximum: 1 }), 0.5, 0.5)).toEqual({ min: 0, max: 1, step: 0.01 });
    const ms = sliderRange(leaf('turn.start_guard.min_gap_ms', { kind: 'integer' }), 900, 900);
    expect(ms.max).toBeGreaterThanOrEqual(2700);
    expect(ms.step).toBe(1);
  });

  it('方策から閾値の線を拾う（start_guard と視線を含む）', () => {
    const lines = thresholdLines(policy());
    expect(lines.p_now.map((l) => l.path)).toEqual(
      expect.arrayContaining(['turn.constants.VAP_PNOW_YIELD', 'turn.constants.VAP_PNOW_INTERRUPT', 'turn.start_guard.completion_timeout_min_p_ai', 'gaze.p_threshold']),
    );
    expect(lines.p_future.map((l) => l.path)).toEqual(expect.arrayContaining(['turn.constants.VAP_PFUT_YIELD']));
    expect(lines.vad.map((l) => l.path)).toEqual(['vap.speaking_threshold']);
  });
});

describe('ライブの中身', () => {
  it('方策と判断の材料を受け、契約に合わないものは数える。セッションが変われば作り直す', () => {
    const store = new TuneLiveStore();
    store.event({ type: 'research.policy', policy: policy(), policy_file: 'config/policy.ja.json', override: { file: 'config/policy.ja.local.json', keys: ['gaze.p_threshold'] } });
    store.event({ type: 'research.turn_diagnostic', session_id: 's1', ...diag(1000) });
    store.event({ type: 'research.turn_diagnostic', session_id: 's1', ...diag(1100), gap_ms: -5 });
    store.event({ type: 'research.unknown' });
    let snap = store.snapshot();
    expect(snap.policy?.override?.keys).toEqual(['gaze.p_threshold']);
    expect(snap.diagnostics).toHaveLength(1);
    expect(snap.invalid).toBe(2);
    expect(snap.origin_ms).toBe(1000);
    store.event({ type: 'research.turn_diagnostic', session_id: 's2', ...diag(50) });
    snap = store.snapshot();
    expect(snap.session_id).toBe('s2');
    expect(snap.diagnostics.map((d) => d.t_monotonic_ms)).toEqual([50]);
  });

  it('研究者画面の偽のイベントも受けられる（VAP、発話、発話希望）', () => {
    const store = new TuneLiveStore();
    for (const e of createFakeEventScript()) store.event(e);
    const snap = store.snapshot();
    // 偽の列には表示確認用の不正なイベントが 1 件入っている。
    expect(snap.invalid).toBe(1);
    expect(snap.vap.length).toBeGreaterThan(0);
    expect(snap.initiative.some((r) => r.kind === 'decision')).toBe(true);
  });
});

describe('発話希望の流れ', () => {
  it('LLM の出力は「LLM 生成」の欄に分け、数値の話したい度合いは出さない', () => {
    const rows = buildInitiativeFlow(createFakeEventScript() as never);
    expect(rows.some((r) => r.kind === 'decision')).toBe(true);
    const ts = rows.map((r) => r.t);
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
    const html = renderToStaticMarkup(createElement(FlowTable, { rows, origin: 0 }));
    expect(html).toContain('LLM 生成');
    expect(html).toContain('緊急度');
    expect(html).not.toMatch(/話したい度合い|desire/);
  });

  it('録音の再生では、表示に使う行だけを契約で検証して読む', () => {
    const lines = (createFakeEventScript() as unknown[]).map((e) => JSON.stringify(e));
    const log = parseOfflineLog([...lines, '{broken', JSON.stringify({ event: 'llm.request', nope: 1 })].join('\n'));
    expect(log.vap.length).toBeGreaterThan(0);
    expect(log.flow.length).toBeGreaterThan(0);
    // 壊れた行と、契約に合わない llm.request の 2 件。偽の列の不正な provider.status は表示に使わないので数えない。
    expect(log.invalid).toBe(2);
  });
});

describe('表と区間', () => {
  it('判断の材料の表は分岐ごとの成立と、正本が turn.allowed であることを出す', () => {
    const html = renderToStaticMarkup(createElement(DiagnosticTable, { diag: diag(2000), origin: 1000, title: '最新' }));
    expect(html).toContain('L64');
    expect(html).toContain('成立');
    expect(html).toContain('不成立');
    expect(html).toContain('no_yield_signal');
    expect(html).toContain('1.00s');
  });

  it('指標の表は記録と再計算を並べる', () => {
    const m: TuneMetricSet = { starts: 5, mid_utterance_starts: 1, mid_utterance_starts_vad: 1, delays_ms: [600, null, 900], consecutive_ai_starts: 1, gaze_averts: 1, gaze_avert_ms: [600], interrupts: 0 };
    const html = renderToStaticMarkup(createElement(MetricsTable, { recorded: m, replayed: { ...m, starts: 4 } }));
    expect(html).toContain('発話の途中での開始');
    expect(html).toContain('中央 750');
  });

  it('区間と分位', () => {
    const vap = [0, 80, 160, 240, 320].map((t, i) => ({ t, p_now: [0, 0] as const, p_future: [0, 0] as const, vad: [i === 1 || i === 2 ? 0.9 : 0.1, 0] as const }));
    expect(voicedSpans(vap, 0.5)).toEqual([{ start: 80, end: 240 }]);
    expect(allowedSpans([{ t: 10, allowed: true, source: 'vap' }, { t: 30, allowed: false, source: 'vap' }], 100)).toEqual([{ start: 10, end: 30, label: 'vap' }]);
    expect(avertSpans([{ t: 10, target: 'away' }, { t: 50, target: 'user' }, { t: 70, target: 'away' }], 100)).toEqual([
      { start: 10, end: 50 },
      { start: 70, end: 100 },
    ]);
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([], 0.5)).toBeNull();
  });

  it('発話希望の流れは二段判定（desire／timing）を読む。未知の項目は除いて読む（古いと新しいの混在で落とさない）', () => {
    const fixture = (name: string) => {
      const found = VALID_FIXTURES.events.find((f) => f.name === name);
      if (!found) throw new Error(name);
      return { ...(found.value as Record<string, unknown>), added_by_someone_else: 42 };
    };
    const desire = fixture('initiative.desire');
    const timing = fixture('initiative.timing/immediate');
    const log = parseOfflineLog([JSON.stringify(desire), JSON.stringify(timing)].join('\n'));
    const decisions = log.flow.filter((r) => r.kind === 'decision');
    expect(decisions.map((r) => (r.kind === 'decision' ? r.row.decision : ''))).toEqual(['NEW', 'OFFER_NOW']);
    expect(log.invalid).toBe(0);
  });

  it('ライブの結果の帯: ラベルの名前で読める（色だけで区別しない）', () => {
    const outcome = {
      event: 'turn.outcome' as const,
      kind: 'no_response' as const,
      labels: { value: ['no_response_after_user_yield'] as ('no_response_after_user_yield')[] },
      segment_id: 1,
      transcript_revision: { value: 1 },
      waited_ms: 4000,
      last_user_voice_at: { value: 1000 },
      asr_chars: 3,
      asr_is_final: true,
      wait_state: 'not_permitted' as const,
      vap_freshness: 'fresh' as const,
      p_now: { value: 0.2 },
      p_future: { value: 0.2 },
      completion_p: { value: 0.1 },
      decision_source: { value: 'vap' },
    };
    const band = outcomeBand('結果', [outcome], { flagged: 'r', clean: 'g', unsettled: 'y' });
    expect(band.spans[0]).toMatchObject({ start: 1000, end: 5000, color: 'r', label: 'no_response_after_user_yield' });
  });
});
