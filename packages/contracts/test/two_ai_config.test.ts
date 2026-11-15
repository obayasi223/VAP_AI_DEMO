/** two_ai の設定、台本、人格、点の日程の検査（06 §9）。 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  TwoAiManifest,
  TwoAiPersonas,
  TwoAiPointTemplates,
  TwoAiScript,
  TwoAiSessionConfig,
  validatePointSchedule,
  type PlannedPointSpec,
} from '../src/index';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const raw = JSON.parse(readFileSync(join(repo, 'config', 'two_ai', 'session.ja.json'), 'utf8')) as Record<string, any>;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** 04 B の session.demo_short.ja.json の値【暫定】（値の正本は WP4）。 */
function demoShort() {
  const c = clone(raw);
  c.config_id = 'demo_short';
  c.self_run = true;
  c.correction.mode = 'auto';
  c.retraction.timing = 'end_of_session';
  c.phases.intake = { min_sec: 30, soft_sec: 40, max_sec: 60, plan_start_sec: 40 };
  Object.assign(c.phases.discussion, { target_sec: 180, close_at_sec: 150, max_sec: 200 });
  c.phases.response.duration_sec = 45;
  return TwoAiSessionConfig.parse(c);
}

const turn = (key: string, speaker: 'A' | 'B', n: number) => ({ turn_key: key, speaker, text: 'あ'.repeat(n) });
const templates = TwoAiPointTemplates.parse({
  version: 1,
  points: (['fact_slip', 'control_inference', 'framing_C'] as const).map((kind) => ({
    kind,
    default_speaker: 'B',
    default_trigger: { in_stage: kind === 'fact_slip' ? 1 : kind === 'control_inference' ? 2 : 3, after_stage_turn: 1 },
    elaborate_turns: 2,
    turns: ['0', '1', '2'].map((k) => ({ turn_key: k, role: 'speaker', template: 't', corrected_template: 't', target_chars: [30, 50] })),
    uptake_template: kind === 'fact_slip' ? 'u' : null,
  })),
  board_cards: [1, 2, 3, 4].map((order) => ({
    order,
    discussion_stage: order,
    depends_on: order === 1 ? 'fact_slip' : order === 3 ? 'framing_C' : 'none',
    template: 't',
    corrected_template: 't',
    target_chars: [10, 20],
  })),
  rebuild_templates: [{ turn_key: 'r0', role: 'closing_speaker', template: 't' }],
});
const generated = (id: string, kind: PlannedPointSpec['kind'], trigger: PlannedPointSpec['trigger']): PlannedPointSpec => ({
  id,
  kind,
  speaker: 'B',
  trigger,
  elaborate_turns: 2,
  source: 'generated',
  turns: null,
  corrected_turns: null,
  uptake: null,
  slip: null,
  inference: null,
});

describe('TwoAiSessionConfig', () => {
  it('骨組みの session.ja.json が通り、旗の既定は false', () => {
    const parsed = TwoAiSessionConfig.parse(raw);
    expect(parsed.experience.interjection_feeds_generation).toBe(false);
    const c = clone(raw);
    delete c.experience.interjection_feeds_generation;
    delete c.experience.response_mode;
    const d = TwoAiSessionConfig.parse(c);
    expect(d.experience.interjection_feeds_generation).toBe(false);
    expect(d.experience.response_mode).toBe('fixed');
    // 版の既定は統制版。応答版の値は既定が入る
    expect(d.experience.mode).toBe('controlled');
    expect(d.experience.responsive).toMatchObject({ reply_max_chars: 50, board_regen_max: 3, reference_min_chars: 5 });
    expect(d.experience.responsive.rebuild_templates.join('')).toContain('{card_4}');
    const r = clone(raw);
    r.experience.mode = 'responsive';
    r.experience.responsive = { ...d.experience.responsive, reply_max_chars: 30 };
    expect(TwoAiSessionConfig.safeParse({ ...r, experience: { ...r.experience, responsive: { reply_max_chars: 30 } } }).success).toBe(false);
    const e = TwoAiSessionConfig.parse(r);
    expect(e.experience.mode).toBe('responsive');
    expect(e.experience.responsive.reply_max_chars).toBe(30);
    r.experience.mode = 'other';
    expect(TwoAiSessionConfig.safeParse(r).success).toBe(false);
  });

  it('response.duration_sec は条件ごとに持てない', () => {
    const c = clone(raw);
    c.phases.response.duration_sec = { respond_on_spot: 120, respond_at_end: 150 };
    expect(TwoAiSessionConfig.safeParse(c).success).toBe(false);
    const d = clone(raw);
    d.phases.response.duration_sec_respond_at_end = 150;
    expect(TwoAiSessionConfig.safeParse(d).success).toBe(false);
  });

  it("correction.mode: 'auto' は self_run: false で不合格", () => {
    const c = clone(raw);
    c.correction.mode = 'auto';
    expect(TwoAiSessionConfig.safeParse(c).success).toBe(false);
    c.self_run = true;
    expect(TwoAiSessionConfig.safeParse(c).success).toBe(true);
  });

  it('superRefine の規則', () => {
    const cases: [string, (c: any) => void][] = [
      ['intake order', (c) => (c.phases.intake.plan_start_sec = 10)],
      ['discussion order', (c) => (c.phases.discussion.close_at_sec = 590)],
      ['second filler', (c) => (c.phases.plan_wait.second_filler_after_ms = c.phases.plan_wait.max_wait_ms)],
      ['ack ids', (c) => c.acknowledgment.templates.push({ id: 'ack_1', text: 'x' })],
      ['stage_fracs', (c) => (c.phases.discussion.stage_fracs = [0.5, 0.25, 0.25, 0.25])],
      ['retraction timing', (c) => (c.retraction.timing = 'end_of_session')],
      ['false onset window', (c) => (c.interjection.false_onset_window_ms = 100)],
      ['hold_max_ms', (c) => (c.correction.hold_max_ms = 1000)],
    ];
    for (const [name, mutate] of cases) {
      const c = clone(raw);
      mutate(c);
      expect(TwoAiSessionConfig.safeParse(c).success, name).toBe(false);
    }
  });
});

describe('validatePointSchedule', () => {
  it('demo_short の値で、既定の in_stage の点の C の見込みを出し、合格する', () => {
    const config = demoShort();
    const points = [
      generated('f1', 'fact_slip', { in_stage: 1, after_stage_turn: 1 }),
      generated('k1', 'control_inference', { in_stage: 2, after_stage_turn: 2 }),
      generated('c1', 'framing_C', { in_stage: 3, after_stage_turn: 0 }),
    ];
    const check = validatePointSchedule(config, points, templates, [2, 3, 1, 1]);
    expect(check.reason).toBeNull();
    expect(check.ok).toBe(true);
    const c = check.points.find((p) => p.point_id === 'c1')!;
    expect(c.discussion_stage).toBe(3);
    // 段 1：2 拍＋F、段 2：3 拍＋K、段 3 の最初に C
    const block = 150 / 7;
    expect(c.expected_start_sec).toBeCloseTo(5 * 9 + 2 * block);
    expect(c.expected_block_sec).toBeCloseTo(block);
    expect(check.limit_sec).toBe(120);
    expect(check.stages).toHaveLength(4);
    expect(check.latest_point_end_sec).toBeCloseTo(Math.max(...check.points.map((p) => p.expected_end_sec)));
  });

  it('届かない設定は不合格（at_sec 240 の点を 180 秒の設定で）', () => {
    const check = validatePointSchedule(demoShort(), [generated('c1', 'framing_C', { at_sec: 240 })], templates, null);
    expect(check.ok).toBe(false);
    expect(check.reason).toContain('c1');
  });

  it('段の拍を超える k と、配置の違反は不合格', () => {
    const config = TwoAiSessionConfig.parse(raw);
    expect(validatePointSchedule(config, [generated('f1', 'fact_slip', { in_stage: 1, after_stage_turn: 5 })], templates, [2, 2, 2, 2]).ok).toBe(false);
    expect(validatePointSchedule(config, [generated('f1', 'fact_slip', { in_stage: 2, after_stage_turn: 0 })], templates, [2, 2, 2, 2]).ok).toBe(false);
    expect(validatePointSchedule(config, [generated('k1', 'control_inference', { in_stage: 4, after_stage_turn: 0 })], templates, [2, 2, 2, 2]).ok).toBe(true);
  });

  it('凍結文があれば 2 版の長い方の文字数で長さを見込む', () => {
    const config = TwoAiSessionConfig.parse(raw);
    const p: PlannedPointSpec = {
      ...generated('c1', 'framing_C', { at_frac: 0.5 }),
      elaborate_turns: 0,
      source: 'prepared',
      turns: [turn('C0', 'A', 70)],
      corrected_turns: [turn('C0', 'A', 140)],
    };
    const check = validatePointSchedule(config, [p], templates, null);
    expect(check.points[0]!.expected_start_sec).toBe(270);
    expect(check.points[0]!.expected_block_sec).toBeCloseTo(20);
  });
});

describe('TwoAiScript', () => {
  const inference = (premise: string) => ({
    premise_fact_id: premise,
    premise_statement: 'p',
    steps: ['s1', 's2'],
    conclusion: 'c',
    target_option: 'o',
    stakes: 'low',
  });
  const script = () => ({
    script_id: 'demo',
    version: 1,
    kind: 'demo',
    topic: 't',
    aspect: 'a',
    user_name: 'u',
    user_name_reading: 'u',
    sample_persona: null,
    prior: { core: null, confidence_0_100: null, facts: [] },
    personas_file: 'config/two_ai/personas.ja.json',
    stages: null,
    planned_points: [
      {
        id: 'f1',
        kind: 'fact_slip',
        speaker: 'B',
        trigger: { in_stage: 1, after_stage_turn: 1 },
        elaborate_turns: 2,
        source: 'prepared',
        turns: [turn('F0', 'B', 20), turn('F1', 'A', 20), turn('F2', 'B', 20)],
        corrected_turns: [turn('F0', 'B', 20), turn('F1', 'A', 20), turn('F2', 'B', 20)],
        uptake: turn('U', 'B', 10),
        slip: { fact_id: 'f', correct_statement: '2 月末', slip_statement: '締切は 12 月末', slip_value: '12 月末' },
        inference: inference('f'),
      },
      {
        id: 'k1',
        kind: 'control_inference',
        speaker: 'B',
        trigger: { in_stage: 2, after_stage_turn: 2 },
        elaborate_turns: 2,
        source: 'prepared',
        turns: [turn('K0', 'B', 20), turn('K1', 'A', 20), turn('K2', 'B', 20)],
        corrected_turns: [turn('K0', 'B', 20), turn('K1', 'A', 20), turn('K2', 'B', 20)],
        uptake: null,
        slip: null,
        inference: inference('g'),
      },
    ],
    board: [1, 2, 3, 4].map((order) => ({
      card_id: `card_${order}`,
      order,
      discussion_stage: order,
      depends_on: order === 1 ? 'fact_slip' : order === 3 ? 'framing_C' : 'none',
      text: 't',
      corrected_text: 't',
    })),
    rebuild_turns: null,
    retraction: null,
    intake_source: 'live',
    scripted_intake: null,
    hide_points_on_research_screen: true,
  });

  it('合格例が通る', () => {
    expect(TwoAiScript.safeParse(script()).success).toBe(true);
  });

  it('superRefine の規則', () => {
    const cases: [string, (s: any) => void][] = [
      ['slip in corrected', (s) => (s.planned_points[0].corrected_turns[1].text = '12 月末なので')],
      ['slip in board', (s) => (s.board[0].corrected_text = '12 月末に出す')],
      ['card 1 dependency', (s) => (s.board[0].depends_on = 'none')],
      ['card 3 dependency', (s) => (s.board[2].depends_on = 'none')],
      ['K speaker', (s) => (s.planned_points[1].speaker = 'A')],
      ['K turn speakers', (s) => (s.planned_points[1].turns[1].speaker = 'B') && (s.planned_points[1].corrected_turns[1].speaker = 'B')],
      ['mirror', (s) => (s.planned_points[0].corrected_turns[2].turn_key = 'X')],
      ['uptake only fact_slip', (s) => (s.planned_points[1].uptake = turn('U', 'B', 1))],
      ['scripted intake', (s) => (s.intake_source = 'scripted')],
      ['duplicate ids', (s) => (s.planned_points[1].id = 'f1')],
      ['generated with turns', (s) => (s.planned_points[1].source = 'generated')],
    ];
    for (const [name, mutate] of cases) {
      const s = script();
      mutate(s);
      expect(TwoAiScript.safeParse(s).success, name).toBe(false);
    }
  });
});

describe('人格と manifest', () => {
  const persona = (ai_id: 'A' | 'B', voice_env: string) => ({
    ai_id,
    persona_id: `p_${ai_id}`,
    version: 1,
    display_name: ai_id,
    lens_id: 'l',
    lens_summary: 's',
    interests: [],
    questions_it_asks: [],
    speech_style: 's',
    not_to_do: [],
    voice_env,
    avatar_key: 'k',
  });
  it('人格は [A, B] で声の変数が違う', () => {
    expect(TwoAiPersonas.safeParse({ version: 1, personas: [persona('A', 'TWO_AI_VOICE_A'), persona('B', 'TWO_AI_VOICE_B')] }).success).toBe(true);
    expect(TwoAiPersonas.safeParse({ version: 1, personas: [persona('B', 'TWO_AI_VOICE_A'), persona('A', 'TWO_AI_VOICE_B')] }).success).toBe(false);
    expect(TwoAiPersonas.safeParse({ version: 1, personas: [persona('A', 'TWO_AI_VOICE_A'), persona('B', 'TWO_AI_VOICE_A')] }).success).toBe(false);
  });

  it('manifest の合格例', () => {
    const m = {
      config_file: 'config/two_ai/session.ja.json',
      config_sha256: 'h',
      config_id: 'c',
      config_version: 1,
      script_file: 's.json',
      script_sha256: 'h',
      script_id: 's',
      script_kind: 'demo',
      condition: 'respond_on_spot',
      condition_source: 'research_screen',
      arm_id: 'arm_1',
      self_run: false,
      correction_mode: 'researcher',
      personas: {
        A: { persona_id: 'a', version: 1, voice_env: 'TWO_AI_VOICE_A', voice_provider: 'elevenlabs' },
        B: { persona_id: 'b', version: 1, voice_env: 'TWO_AI_VOICE_B', voice_provider: 'elevenlabs' },
      },
      planned_points: [{ id: 'f1', kind: 'fact_slip', speaker: 'B', trigger: { in_stage: 1, after_stage_turn: 1 }, elaborate_turns: 2, source: 'prepared', text_sha256: 'h' }],
      point_schedule: { ok: true, latest_point_end_sec: 300, limit_sec: 450 },
      ack_templates: [{ id: 'ack_1', text_sha256: 'h', synthesized_ms: { A: 1100, B: 1150 } }],
      response_duration_sec: 120,
      experience: { interjection_feeds_generation: { requested: false, effective: false, source: 'config' }, response_mode: 'fixed' },
      exploratory: false,
      plan_hash: null,
      plan_source: null,
      plan_wait_ms: null,
      fact_slip: null,
      fact_slip_source: null,
      control_inference: null,
      stage_headings_sha256: 'h',
      board_sha256: null,
      rebuild_sha256: null,
      retraction: { timing: 'after_measures', script_sha256: null, inference_form: null },
      marker_enabled: true,
      order: { session_index: 1, counterbalance_label: 'AB' },
      evidence_ok_for_comparison: true,
      evidence_notes: [],
    };
    expect(TwoAiManifest.parse(m)).toEqual(m);
    expect(TwoAiManifest.safeParse({ ...m, condition: 'reactive' }).success).toBe(false);
    // 版は省ける（統制版の記録は変わらない）。応答版は mode を持つ
    const withMode = { ...m, experience: { ...m.experience, mode: 'responsive' } };
    expect(TwoAiManifest.parse(withMode)).toEqual(withMode);
    expect(TwoAiManifest.safeParse({ ...m, experience: { ...m.experience, mode: 'x' } }).success).toBe(false);
  });
});
