import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PROMPTS } from '../prompt';
import { PERSONA } from './helpers';

const here = new URL('../../../../../../fixtures/initiative/scenarios.ja.json', import.meta.url);

describe('プロンプト', () => {
  it('反例や検証用の台本の文言を含まない（過剰適合の防止）', () => {
    const { scenarios } = JSON.parse(readFileSync(here, 'utf8')) as { scenarios: { text?: string }[] };
    const sentences = scenarios
      .flatMap((s) => (s.text ?? '').split(/[。、\n]/u))
      .filter((t) => t.length >= 8);
    for (const prompt of Object.values(PROMPTS)) {
      const system = prompt.system(PERSONA);
      for (const sentence of sentences) expect(system).not.toContain(sentence);
      expect(system).not.toMatch(/展示会|パンフレット|倫理審査/u);
    }
  });
  it('NO_INTENT や CLARIFY を案内しない', () => {
    for (const prompt of Object.values(PROMPTS)) expect(prompt.system(PERSONA)).not.toMatch(/NO_INTENT|CLARIFY\b/u);
  });
});
