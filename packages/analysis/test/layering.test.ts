/**
 * 層の向き: packages は apps を import しない。研究者画面（web）とログ検証（tools/log_check）は
 * orchestrator の内部を相対 import せず、集計は @llm-vap/analysis として読む。
 * （tools/initiative_spike は orchestrator の内部を直接動かす検証用の道具なので対象外。）
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeForMatch as fromPackage } from '@llm-vap/analysis/text';
import { normalizeForMatch as fromInitiative } from '../../../apps/orchestrator/src/cognition/initiative/text';

const repoRoot = join(import.meta.dirname, '..', '..', '..');
const IMPORT = /(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name.startsWith('.')) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (/\.(ts|tsx|mts)$/.test(name)) out.push(path);
  }
  return out;
}

function importsOf(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  return [...text.matchAll(IMPORT)].map((m) => m[1] ?? m[2] ?? '');
}

function violations(dirs: string[], bad: RegExp): string[] {
  return dirs
    .flatMap((d) => sources(join(repoRoot, d)))
    .flatMap((f) => importsOf(f).filter((s) => bad.test(s)).map((s) => `${relative(repoRoot, f)}: ${s}`));
}

describe('層の向き', () => {
  it('packages/*/src は apps を import しない', () => {
    expect(violations(['packages/analysis/src', 'packages/contracts/src', 'packages/testkit/src'], /(^|\/)apps\/|@llm-vap\/(orchestrator|web)/)).toEqual([]);
  });
  it('web と tools/log_check は orchestrator の内部を import しない', () => {
    expect(violations(['apps/web/src', 'apps/web/app', 'tools/log_check'], /orchestrator\/src|@llm-vap\/orchestrator/)).toEqual([]);
  });
  it('InitiativeMonitor の正規化は analysis の正本と同じ関数', () => {
    expect(fromInitiative).toBe(fromPackage);
    expect(fromPackage('国が？ 100円。')).toBe('国が100円');
  });
});
