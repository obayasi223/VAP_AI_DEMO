// 04 T1：設定の 3 ファイルとデモの台本（WP4 の値）。起動時と同じ検査（スキーマ、点の日程）を通ること。
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TwoAiPointTemplates, TwoAiScript, TwoAiSessionConfig, validatePointSchedule } from '@llm-vap/contracts';

const repo = resolve(import.meta.dirname, '../../../../..');
const read = (p: string) => JSON.parse(readFileSync(resolve(repo, p), 'utf8')) as unknown;
const configs = {
  main: TwoAiSessionConfig.parse(read('config/two_ai/session.ja.json')),
  demo: TwoAiSessionConfig.parse(read('config/two_ai/session.demo_short.ja.json')),
  self: TwoAiSessionConfig.parse(read('config/two_ai/session.self_run.ja.json')),
};
const script = TwoAiScript.parse(read('config/two_ai/scripts/demo_career.ja.json'));
const templatesPath = 'config/two_ai/point_templates.ja.json';
// 点の文型は WP2 の持ち物。prepared の点だけの検査には中身が要らないので、まだなければ空の形で代える。
const templates: TwoAiPointTemplates = existsSync(resolve(repo, templatesPath))
  ? TwoAiPointTemplates.parse(read(templatesPath))
  : ({ version: 1, points: [], board_cards: [], rebuild_templates: [] } as unknown as TwoAiPointTemplates);
const allTexts = () => [
  ...script.planned_points.flatMap((p) => [...(p.turns ?? []), ...(p.corrected_turns ?? []), ...(p.uptake ? [p.uptake] : [])].map((t) => t.text)),
  ...(script.board ?? []).flatMap((c) => [c.text, c.corrected_text]),
  ...(script.rebuild_turns ?? []).map((t) => t.text),
  ...Object.values(script.retraction ?? {}),
  ...(script.stages ?? []),
];

describe('設定の 3 ファイル（04 B）', () => {
  it('研究の本番に近い設定：researcher、after_measures、応答 120 秒', () => {
    const c = configs.main;
    expect(c.self_run).toBe(false);
    expect(c.correction.mode).toBe('researcher');
    expect(c.retraction.timing).toBe('after_measures');
    expect(c.phases.response.duration_sec).toBe(120);
    expect(c.phases.discussion).toMatchObject({ target_sec: 540, close_at_sec: 480, max_sec: 600 });
    expect(c.experience.interjection_feeds_generation).toBe(false);
    expect(Object.values(c.generation.models).every((m) => !m.includes('PLACEHOLDER'))).toBe(true);
  });

  it('短い設定と自己体験：self_run、auto、end_of_session、fallback_plan', () => {
    for (const c of [configs.demo, configs.self]) {
      expect(c.self_run).toBe(true);
      expect(c.correction.mode).toBe('auto');
      expect(c.retraction.timing).toBe('end_of_session');
      expect(c.phases.plan_wait.on_timeout).toBe('fallback_plan');
    }
    expect(configs.demo.phases.response.duration_sec).toBe(45);
    expect(configs.demo.phases.discussion.target_sec).toBe(180);
    expect(configs.self.phases.discussion).toEqual(configs.main.phases.discussion);
  });

  it('応答版の設定：mode と responsive だけが本番に近い設定と違う（統制版の 3 つは controlled）', () => {
    const rawMain = read('config/two_ai/session.ja.json') as Record<string, any>;
    const rawResp = read('config/two_ai/session.responsive.ja.json') as Record<string, any>;
    const resp = TwoAiSessionConfig.parse(rawResp);
    expect(resp.experience.mode).toBe('responsive');
    expect(resp.experience.interjection_feeds_generation).toBe(false);
    expect(resp.experience.responsive.rebuild_templates).toHaveLength(2);
    for (const c of Object.values(configs)) expect(c.experience.mode).toBe('controlled');
    const strip = (c: Record<string, any>) => ({ ...c, config_id: null, version: null, experience: { ...c.experience, mode: null, responsive: null } });
    expect(strip(rawResp)).toEqual(strip(rawMain));
    expect(validatePointSchedule(resp, script.planned_points, templates, null).ok).toBe(true);
  });

  it('受け止めは 1 通りで、許容は 150 ms（AC1）。見出しと問いは 3 つで同じ（条件で変わらない）', () => {
    for (const c of Object.values(configs)) {
      expect(c.acknowledgment.templates).toHaveLength(1);
      expect(c.acknowledgment.duration_tolerance_ms).toBe(150);
      expect(c.fixed.lines.closing_question).toBe(configs.main.fixed.lines.closing_question);
      expect(c.fixed.stage_headings).toEqual(configs.main.fixed.stage_headings);
      expect(c.correction.hold_max_ms).toBeGreaterThanOrEqual(c.correction.decision_window_ms);
    }
  });

  it('点の日程の検査を 3 つとも通る（短い設定も forced なしで C が収まる見込み。AC14(b)）', () => {
    for (const [name, c] of Object.entries(configs)) {
      const check = validatePointSchedule(c, script.planned_points, templates, null);
      expect(check.ok, `${name}: ${check.reason}`).toBe(true);
    }
  });
});

describe('デモの台本 demo_career.ja.json（06 §9.3、04 1-2）', () => {
  it('4 段、F・K・C の 3 点が prepared、板 4 枚、作り直し、撤回がある', () => {
    expect(script.kind).toBe('demo');
    expect(script.stages).toHaveLength(4);
    expect(script.planned_points.map((p) => [p.id, p.kind, p.source, p.trigger])).toEqual([
      ['fact1', 'fact_slip', 'prepared', { in_stage: 1, after_stage_turn: 1 }],
      ['ctl1', 'control_inference', 'prepared', { in_stage: 2, after_stage_turn: 2 }],
      ['C1', 'framing_C', 'prepared', { in_stage: 3, after_stage_turn: 0 }],
    ]);
    expect(script.board?.map((c) => c.depends_on)).toEqual(['fact_slip', 'none', 'framing_C', 'control_inference']);
    expect(script.rebuild_turns?.length).toBeGreaterThanOrEqual(1);
    expect(script.retraction).not.toBeNull();
    expect(script.prior.facts.map((f) => f.fact_id)).toEqual(['f_intern', 'f_seminar']);
  });

  it('訂正後の版は各ターンで元の ±15% の文字数（中身の時計をそろえる）', () => {
    for (const p of script.planned_points) {
      p.turns!.forEach((t, i) => {
        const a = [...t.text].length;
        const b = [...p.corrected_turns![i]!.text].length;
        expect(Math.abs(b - a) / a, `${p.id} ${t.turn_key}`).toBeLessThanOrEqual(0.15);
      });
    }
  });

  it('対照の推論は取り違えと同じ形：話者の並び、文字数の帯（±15%）、2 段、低い重さ', () => {
    const f = script.planned_points.find((p) => p.kind === 'fact_slip')!;
    const k = script.planned_points.find((p) => p.kind === 'control_inference')!;
    expect(k.turns!.map((t) => t.speaker)).toEqual(f.turns!.map((t) => t.speaker));
    f.turns!.forEach((t, i) => {
      const a = [...t.text].length;
      expect(Math.abs([...k.turns![i]!.text].length - a) / a).toBeLessThanOrEqual(0.15);
    });
    expect(f.inference!.stakes).toBe('low');
    expect(k.inference!.premise_fact_id).not.toBe(f.inference!.premise_fact_id);
  });

  it('取り違えの値は訂正後の文、訂正後の板、作り直しに出ず、撤回では名指しされる', () => {
    const f = script.planned_points.find((p) => p.kind === 'fact_slip')!;
    const after = [...f.corrected_turns!.slice(1), ...(f.uptake ? [f.uptake] : [])].map((t) => t.text).concat((script.board ?? []).map((c) => c.corrected_text), (script.rebuild_turns ?? []).map((t) => t.text));
    for (const t of after) expect(t).not.toContain(f.slip!.slip_value);
    expect(f.turns![0]!.text).toContain(f.slip!.slip_statement);
    expect(script.retraction!.fact).toContain(f.slip!.slip_value);
  });

  it('見出しに C の語と取り違えの値を含めない', () => {
    const f = script.planned_points.find((p) => p.kind === 'fact_slip')!;
    for (const h of script.stages!) {
      expect(h).not.toContain(f.slip!.slip_value);
      expect(h).not.toMatch(/才能|一日/);
    }
  });

  it('安全：禁止の語と、人物の語と評価の語の組を含まない（指導教員や家族の否定的な評価がない）', () => {
    const banned = existsSync(resolve(repo, 'config/two_ai/banned_terms.ja.txt'))
      ? readFileSync(resolve(repo, 'config/two_ai/banned_terms.ja.txt'), 'utf8').split('\n').map((l) => l.replace(/#.*/, '').trim()).filter((l) => l !== '')
      : ['病気', '健康', '不仲', '向いていない', '才能がない'];
    const pairsPath = resolve(repo, 'config/two_ai/person_evaluation_pairs.ja.json');
    const pairs = existsSync(pairsPath) ? (JSON.parse(readFileSync(pairsPath, 'utf8')) as { person_terms: string[]; evaluation_terms: string[] }) : { person_terms: ['指導教員', '親', '家族'], evaluation_terms: ['厳しい'] };
    for (const text of allTexts()) {
      for (const w of banned) expect(text, w).not.toContain(w);
      const person = pairs.person_terms.some((p) => text.includes(p));
      const evaluation = pairs.evaluation_terms.some((e) => text.includes(e));
      expect(person && evaluation, text).toBe(false);
    }
  });

  it('人格のファイルを指す（WP2 の personas.ja.json）', () => {
    expect(script.personas_file).toBe('config/two_ai/personas.ja.json');
  });
});
