/**
 * 方策の上書き（POLICY_OVERRIDE_FILE、config/policy.ja.local.json）と、調整画面の項目の列挙。
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Policy, type PolicyJa } from '@llm-vap/contracts';
import { applyOverride, describeOverride, diffOverride, loadOverrideFile, mergeOverride, overrideKeys } from '../../src/dev/policy_override';
import { policyLeaves } from '../../src/dev/policy_schema';
import { productionJaPolicy } from '../session/helpers';

describe('上書きの重ね合わせ', () => {
  it('重ねると指定の葉だけ変わり、元は変えない', () => {
    const base = productionJaPolicy();
    const merged = mergeOverride(base, { turn: { constants: { VAP_PNOW_YIELD: 0.6 } } }) as PolicyJa;
    expect(merged.turn.constants.VAP_PNOW_YIELD).toBe(0.6);
    expect(merged.turn.constants.VAP_PFUT_YIELD).toBe(base.turn.constants.VAP_PFUT_YIELD);
    expect(base.turn.constants.VAP_PNOW_YIELD).toBe(0.5);
  });

  it('差分は重ねると元の編集に戻り、路は葉の名前になる', () => {
    const base = productionJaPolicy();
    const edited = structuredClone(base);
    edited.turn.constants.MIN_GAP_TIME_MS = 700;
    edited.gaze.p_threshold = 0.4;
    const diff = diffOverride(base, edited);
    expect(diff).toEqual({ turn: { constants: { MIN_GAP_TIME_MS: 700 } }, gaze: { p_threshold: 0.4 } });
    expect(mergeOverride(base, diff)).toEqual(edited);
    expect(overrideKeys(diff).sort()).toEqual(['gaze.p_threshold', 'turn.constants.MIN_GAP_TIME_MS']);
    expect(diffOverride(base, structuredClone(base))).toBeUndefined();
  });

  it('契約に合わない値、policy_id と immutable の変更は拒む', () => {
    const base = productionJaPolicy();
    expect(applyOverride(base, { turn: { constants: { VAP_PNOW_YIELD: 2 } } }).ok).toBe(false);
    expect(applyOverride(base, { policy_id: 'hri2025' }).ok).toBe(false);
    expect(applyOverride(base, { immutable: true }).ok).toBe(false);
    expect(applyOverride(base, { turn: { no_such_key: 1 } }).ok).toBe(false);
    expect(applyOverride(base, [1, 2]).ok).toBe(false);
    const ok = applyOverride(base, { turn: { start_guard: { min_gap_ms: 1200 } } });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.keys).toEqual(['turn.start_guard.min_gap_ms']);
      expect(Policy.parse(ok.policy)).toEqual(ok.policy);
    }
  });

  it('ファイルが読めない・壊れているときは例外（起動を止める）。読めれば起動ログの1行を作れる', () => {
    const base = productionJaPolicy();
    const dir = mkdtempSync(join(tmpdir(), 'policy-override-'));
    expect(() => loadOverrideFile(base, join(dir, 'missing.json'))).toThrow(/POLICY_OVERRIDE_FILE/);
    writeFileSync(join(dir, 'bad.json'), '{ not json');
    expect(() => loadOverrideFile(base, join(dir, 'bad.json'))).toThrow(/POLICY_OVERRIDE_FILE/);
    writeFileSync(join(dir, 'range.json'), JSON.stringify({ gaze: { p_threshold: -1 } }));
    expect(() => loadOverrideFile(base, join(dir, 'range.json'))).toThrow(/gaze/);
    writeFileSync(join(dir, 'ok.json'), JSON.stringify({ gaze: { p_threshold: 0.45 } }));
    const loaded = loadOverrideFile(base, join(dir, 'ok.json'));
    expect((loaded.policy as PolicyJa).gaze.p_threshold).toBe(0.45);
    expect(loaded.info.keys).toEqual(['gaze.p_threshold']);
    expect(describeOverride(loaded.info, loaded.policy)).toContain('gaze.p_threshold=0.45');
  });
});

describe('調整画面の項目（契約のスキーマから列挙）', () => {
  it('方策ファイルの数値の葉はすべて項目になる（項目が増えても自動で並ぶ）', () => {
    const policy = productionJaPolicy();
    const leaves = policyLeaves(policy);
    const paths = new Set(leaves.map((l) => l.path));
    const numeric = (value: unknown, prefix: string): string[] =>
      typeof value === 'number'
        ? [prefix]
        : typeof value === 'object' && value !== null && !Array.isArray(value)
          ? Object.entries(value).flatMap(([k, v]) => numeric(v, prefix === '' ? k : `${prefix}.${k}`))
          : [];
    // vap.p_ai_index は数値の定数の組（0 か 1）で、配線の向きなので調整の項目にしない（スキーマの literal は飛ばす）。
    for (const path of numeric(policy, '').filter((p) => p !== 'vap.p_ai_index')) expect(paths, path).toContain(path);
    expect(paths).toContain('turn.start_guard.min_gap_ms');
    expect(leaves.find((l) => l.path === 'turn.start_guard.min_gap_ms')?.optional_parent).toBe('turn.start_guard');
    expect(leaves.find((l) => l.path === 'gaze.signal')?.options).toEqual(expect.arrayContaining(['p_now', 'p_future']));
    expect(leaves.find((l) => l.path === 'turn.user_speaking_min_ms')?.nullable).toBe(true);
    expect(paths.has('policy_id')).toBe(false);
  });
});
