/**
 * 試験の土台：合成の設定・台本・台帳、偽の LLM、進行役の模擬（中身の時計を数えて nextTurn に渡す）。
 * 架空の「サトウさん」だけを使う（sessions/ は読まない）。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ManualTimeSource,
  MemoryEventSink,
  TwoAiScript,
  TwoAiSessionConfig,
  createEventEmitter,
  type AiId,
  type ConversationHistoryReader,
  type LlmPurpose,
  type LlmRequest,
  type TwoAiCondition,
} from '@llm-vap/contracts';
import type { DiscussionTurn } from '../../../two_ai/content_port';
import { loadDiscussionAssets } from '../assets';
import { DiscussionGenerator } from '../generator';
import { STAGE_PROMPT_MARKER } from '../stage_plan';
import { FakeDiscussionLlm, fakeTurnText, sentenceOfLength, type FakeHandler, type FakeOptions } from './fake_discussion_llm';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '../../../../../..');

export const FICTIONAL = JSON.parse(readFileSync(path.join(HERE, 'fixtures/ledger.fictional.json'), 'utf8')) as {
  utterances: { segment_id: number; text: string }[];
  ledger_output: Record<string, unknown>;
};

export function testConfig(patch: (c: Record<string, any>) => void = () => undefined): TwoAiSessionConfig {
  const raw = JSON.parse(readFileSync(path.join(HERE, 'fixtures/session.test.json'), 'utf8')) as Record<string, any>;
  patch(raw);
  return TwoAiSessionConfig.parse(raw);
}

export function testScript(patch: (s: Record<string, any>) => void = () => undefined): TwoAiScript {
  const s: Record<string, any> = {
    script_id: 'fictional_sato',
    version: 1,
    kind: 'demo',
    topic: '就職か大学院か（架空）',
    aspect: 'どの道を選ぶか',
    user_name: 'サトウ',
    user_name_reading: 'サトウ',
    sample_persona: null,
    prior: {
      core: null,
      confidence_0_100: null,
      facts: [
        { fact_id: 'prior_deadline', kind: 'date', text: 'インターンの締切は2月末', slip_hint: '12月末' },
        { fact_id: 'prior_info', kind: 'date', text: '説明会は毎月第2土曜', slip_hint: null },
      ],
    },
    personas_file: 'config/two_ai/personas.ja.json',
    stages: null,
    planned_points: [
      { id: 'F1', kind: 'fact_slip', speaker: 'B', trigger: { in_stage: 1, after_stage_turn: 1 }, elaborate_turns: 2, source: 'generated', turns: null, corrected_turns: null, uptake: null, slip: null, inference: null },
      { id: 'K1', kind: 'control_inference', speaker: 'B', trigger: { in_stage: 2, after_stage_turn: 2 }, elaborate_turns: 2, source: 'generated', turns: null, corrected_turns: null, uptake: null, slip: null, inference: null },
      { id: 'C1', kind: 'framing_C', speaker: 'A', trigger: { in_stage: 3, after_stage_turn: 0 }, elaborate_turns: 2, source: 'generated', turns: null, corrected_turns: null, uptake: null, slip: null, inference: null },
    ],
    board: null,
    rebuild_turns: null,
    retraction: null,
    intake_source: 'live',
    scripted_intake: null,
    hide_points_on_research_screen: false,
  };
  patch(s);
  return TwoAiScript.parse(s);
}

export const C_CORE = 'まわりの期待との距離';
export const C_CORE_SHORT = '期待との距離';
export const SLIP_VALUE = '12月末';
export const SLIP_STATEMENT = 'インターンの締切は12月末';

/** 偽の計画の出力（段ごとの拍の数はプロンプトから読む）。 */
export function fakePlanOutput(request: LlmRequest, patch: (o: Record<string, any>) => void = () => undefined): string {
  const counts = /段ごとの拍の数は \[(\d+), (\d+), (\d+), (\d+)\]/u.exec(request.system)?.slice(1).map(Number) ?? [3, 3, 3, 3];
  const total = counts.reduce((a, b) => a + b, 0);
  const beats: Record<string, unknown>[] = [];
  const cycle = ['develop', 'react', 'question'];
  const lengths: Record<string, number> = { open: 80, develop: 70, react: 22, question: 35, close: 60 };
  counts.forEach((n, s) => {
    for (let i = 0; i < n; i++) {
      const k = beats.length;
      const kind = k === 0 ? 'open' : k === total - 1 ? 'close' : cycle[k % 3]!;
      const id = `b${String(k + 1).padStart(2, '0')}`;
      const text = sentenceOfLength(`拍${id}の凍結文です。`, lengths[kind]!);
      beats.push({
        stage: s + 1,
        speaker: k % 2 === 0 ? 'A' : 'B',
        kind,
        intent: `拍${id}の意図`,
        ledger_refs: k === 0 ? ['core_1', 'opt_1'] : ['val_1'],
        optional: s === 3 && i === 1 && n > 2,
        fallback_text: text,
        fallback_text_corrected: text,
      });
    }
  });
  const out: Record<string, any> = {
    beats,
    board: [
      { order: 1, text: '12月末までにインターンの書類を出す', corrected_text: '2月末までにインターンの書類を出す' },
      { order: 2, text: '二つの道の一日を書き比べてみる', corrected_text: '二つの道の一日を書き比べてみる' },
      { order: 3, text: '期待と自分の希望を分けて書き出す', corrected_text: '期待と自分の希望を分けて書き出す' },
      { order: 4, text: '指導教員に相談する日を今週中に決める', corrected_text: '指導教員に相談する日を今週中に決める' },
    ],
  };
  if (request.system.includes('- framing_C：')) {
    out.framing_C = {
      candidates: [
        { c_core: '研究の楽しさの守り方', distance: 2 },
        { c_core: C_CORE, distance: 3 },
        { c_core: '住む場所の選び方', distance: 5 },
      ],
      c_core: C_CORE,
      c_core_short: C_CORE_SHORT,
      core_short: 'どちらを選んでも後悔しそう',
      c_reason: '選ぶ理由が、まわりに向いているように聞こえました。',
      c_elab: 'そこを分けると、見え方が変わるかもしれません。',
      quote: '早く自分で稼ぎたい',
    };
  }
  if (request.system.includes('- fact_slip：')) {
    out.fact_slip = {
      slip_statement: SLIP_STATEMENT,
      slip_value: SLIP_VALUE,
      correct_statement: 'インターンの締切は2月末',
      inference_step_1: '冬の説明会には、申し込みがもう間に合わないですね',
      inference_step_2: '春のオンラインの回だけ見ておけば足りそうです',
      conclusion: '春のオンラインの回だけ見る',
      target_option: '説明会の回',
      corrected_step_1: '冬の説明会にも、申し込みがまだ十分に間に合いますね',
      corrected_step_2: '冬の会場の回にも行けるので、両方見ておけそうです',
      corrected_conclusion: '冬と春の両方の回を見る',
    };
  }
  if (request.system.includes('- control_inference：')) {
    out.control_inference = {
      control_statement: '説明会は毎月第2土曜にある',
      control_step_1: '毎月どこかの土曜には、予定を空けておけそうですね',
      control_step_2: '来月の第2土曜に一度行ってみればよさそうです',
      conclusion: '来月の第2土曜に説明会へ行く',
      target_option: '説明会の日',
    };
  }
  patch(out);
  return JSON.stringify(out);
}

/** 段ごとの計画の段の呼び出し（02 §2.5.1）への偽の返答：決まった拍の数だけ、帯の中ほどの長さの文。 */
export function fakeStageOutput(request: LlmRequest): string {
  const slots = [...request.system.matchAll(/^- (b\d+)：話者 [AB]（.*?）、kind (\w+)（(\d+)〜(\d+) 字）/gmu)];
  const beats = slots.map((m) => {
    const id = m[1]!;
    const text = sentenceOfLength(`段の拍${id}の凍結文です。`, Math.round((Number(m[3]) + Number(m[4])) / 2));
    return { beat_id: id, intent: `段の拍${id}の意図`, ledger_refs: ['val_1'], fallback_text: text, fallback_text_corrected: text };
  });
  return JSON.stringify({ beats });
}

export function isStageRequest(request: LlmRequest): boolean {
  return request.system.includes(STAGE_PROMPT_MARKER);
}

export function defaultHandlers(): Partial<Record<LlmPurpose, FakeHandler>> {
  return {
    intake: () => ({ text: 'なるほど。ほかに考えている道はありますか。' }),
    ledger: () => ({ text: JSON.stringify(FICTIONAL.ledger_output) }),
    discussion_plan: (r) => ({ text: isStageRequest(r) ? fakeStageOutput(r) : fakePlanOutput(r) }),
    discussion_turn: (r) => ({ text: fakeTurnText(r) }),
    correction_assist: (r) => {
      const u = r.messages.at(-1)?.text ?? '';
      const corrects = /2月末/u.test(u);
      return { text: JSON.stringify({ corrects, evidence_span: corrects ? '2月末' : '', reason: 'fake' }) };
    },
  };
}

const EMPTY_HISTORY: ConversationHistoryReader = { snapshot: () => [] } as unknown as ConversationHistoryReader;

export interface Rig {
  gen: DiscussionGenerator;
  llm: FakeDiscussionLlm;
  sink: MemoryEventSink;
  time: ManualTimeSource;
}

export function makeRig(options: {
  condition?: TwoAiCondition;
  feeds?: boolean;
  handlers?: Partial<Record<LlmPurpose, FakeHandler>>;
  fake?: FakeOptions;
  config?: TwoAiSessionConfig;
  script?: TwoAiScript | null;
} = {}): Rig {
  const config = options.config ?? testConfig();
  const script = options.script === undefined ? testScript() : options.script;
  const assets = loadDiscussionAssets(REPO_ROOT, config);
  const llm = new FakeDiscussionLlm({ ...defaultHandlers(), ...options.handlers }, options.fake);
  const time = new ManualTimeSource(0);
  const sink = new MemoryEventSink();
  const emitter = createEventEmitter({
    time,
    session_id: 'test_session',
    condition: () => options.condition ?? 'respond_at_end',
    two_ai_context: () => ({ phase: 'discussion', discussion_stage: null, script_variant: 'original' }),
    sink,
  });
  const gen = new DiscussionGenerator({
    config,
    script,
    ...assets,
    llmFor: () => llm,
    emitter,
    time,
    history: EMPTY_HISTORY,
    profile: { aspect: 'どの道を選ぶか', user_name: 'サトウ', user_name_reading: 'サトウ' },
  });
  gen.init({ condition: options.condition ?? 'respond_at_end', feeds_generation: options.feeds ?? false, self_run: false, correction_mode: 'researcher', retraction_timing: 'after_measures' });
  return { gen, llm, sink, time };
}

/** intake の発話を流して台帳を作る。 */
export async function feedIntake(gen: DiscussionGenerator): Promise<void> {
  for (const u of FICTIONAL.utterances) {
    gen.onUserUtterance({ role: 'user', text: u.text, segment_id: u.segment_id, transcript_revision: 1, is_final: true, audio_frame_end: 0 }, { phase: 'intake', interjection_id: null });
    await gen.ledgerIdle();
  }
}

export async function readyRig(options: Parameters<typeof makeRig>[0] = {}): Promise<Rig> {
  const rig = makeRig(options);
  await feedIntake(rig.gen);
  const r = await rig.gen.finalizePlan(new AbortController().signal);
  if (!r.ok) throw new Error(`plan failed: ${r.reason}; events: ${JSON.stringify(rig.sink.ofType('two_ai.plan').map((e) => e.reason))}`);
  rig.gen.startDiscussion();
  return rig;
}

export interface Interjection {
  /** 何本目のターン（0 始まり）の途中か。 */
  at: number;
  /** 声に出た文字数（0 なら AI 同士の間の割り込み：前のターンの後）。 */
  prefix_chars: number;
  mode: 'after_ack' | 'false_onset';
}

export interface RunResult {
  turns: DiscussionTurn[];
  resumes: DiscussionTurn[];
  content_ms: number;
}

/**
 * 進行役の模擬：nextTurn → 再生 → onTurnPlayed を繰り返す。中身の時計は 01 の定義（06 §6.0）で数える
 * （中身のターンの長さと前の間。受け止め、resume の戻りの句と言い直し、本人の番は足さない）。
 * 割り込みは偽の壁時計だけを進める。
 */
export async function runDiscussion(gen: DiscussionGenerator, opts: { interjections?: Interjection[]; onTurn?: (t: DiscussionTurn, i: number) => Promise<void> | void; max?: number } = {}): Promise<RunResult> {
  const turns: DiscussionTurn[] = [];
  const resumes: DiscussionTurn[] = [];
  let content = 0;
  let wall = 0;
  const signal = new AbortController().signal;
  for (let i = 0; i < (opts.max ?? 500); i++) {
    if (gen.isDone('discussion', { elapsed_ms: wall, content_elapsed_ms: content })) break;
    const turn = await gen.nextTurn({ turn_id: `t${i}`, content_elapsed_ms: content, discussion_elapsed_ms: wall }, signal);
    turns.push(turn);
    const ij = opts.interjections?.find((x) => x.at === i);
    if (ij && ij.prefix_chars > 0) {
      const chars = [...turn.text];
      const prefix = chars.slice(0, Math.min(ij.prefix_chars, chars.length - 1)).join('');
      const plan = gen.planInterjection({ interrupted_turn_id: turn.turn_id, spoken_prefix: prefix, last_speaker: turn.speaker, mode: ij.mode });
      gen.onTurnPlayed({ turn_id: turn.turn_id, audio_playback_id: i, spoken_text: prefix, played_ms: 100, completed: false });
      wall += 5000; // 受け止めと本人の番（中身の時計は進めない）
      if (plan.resume) {
        resumes.push(plan.resume);
        gen.onTurnPlayed({ turn_id: plan.resume.turn_id, audio_playback_id: 1000 + i, spoken_text: plan.resume.text, played_ms: 1000, completed: true });
      }
    } else {
      gen.onTurnPlayed({ turn_id: turn.turn_id, audio_playback_id: i, spoken_text: turn.text, played_ms: turn.est_duration_ms, completed: true });
      if (ij && ij.prefix_chars === 0) {
        gen.planInterjection({ interrupted_turn_id: null, spoken_prefix: '', last_speaker: turn.speaker, mode: ij.mode });
        wall += 5000;
      }
    }
    if (turn.turn_kind === 'discussion' || turn.turn_kind === 'point' || turn.turn_kind === 'point_elaboration') content += turn.gap_hint_ms + turn.est_duration_ms;
    wall += turn.gap_hint_ms + turn.est_duration_ms;
    await opts.onTurn?.(turn, i);
  }
  return { turns, resumes, content_ms: content };
}

/** 比較用の 1 ターンの要約（turn_id と resume を除く）。 */
export function signature(t: DiscussionTurn): string {
  return [t.speaker, t.turn_kind, t.point_id ?? '-', t.point_variant ?? '-', t.discussion_stage ?? '-', t.board_card?.card_id ?? '-', t.board_card?.text ?? '-', t.gap_hint_ms, t.text].join('|');
}

export function speakerName(ai: AiId): string {
  return ai === 'A' ? 'アオイ' : 'ハル';
}

/** prepared の取り違えの点だけを持つ台本。 */
export function preparedScript() {
  return testScript((s) => {
    s.planned_points = [
      {
        id: 'F1',
        kind: 'fact_slip',
        speaker: 'B',
        trigger: { in_stage: 1, after_stage_turn: 1 },
        elaborate_turns: 2,
        source: 'prepared',
        turns: [
          { turn_key: 'F.0', speaker: 'B', text: 'そういえばサトウさん、インターンの締切は12月末って話でしたよね。' },
          { turn_key: 'F.1', speaker: 'A', text: 'それなら、冬の説明会には、申し込みがもう間に合わないですね。' },
          { turn_key: 'F.2', speaker: 'B', text: 'すると、春のオンラインの回だけ見ておけば足りそうです。' },
        ],
        corrected_turns: [
          { turn_key: 'F.0', speaker: 'B', text: 'そういえばサトウさん、インターンの締切は2月末って話でしたよね。' },
          { turn_key: 'F.1', speaker: 'A', text: 'それなら、冬の説明会にも、申し込みがまだ十分に間に合いますね。' },
          { turn_key: 'F.2', speaker: 'B', text: 'すると、冬の会場の回にも行けるので、両方見ておけそうです。' },
        ],
        uptake: { turn_key: 'F.uptake', speaker: 'B', text: 'あ、インターンの締切は2月末なんですね。失礼しました。' },
        slip: { fact_id: 'prior_deadline', correct_statement: 'インターンの締切は2月末', slip_statement: 'インターンの締切は12月末', slip_value: '12月末' },
        inference: { premise_fact_id: 'prior_deadline', premise_statement: 'インターンの締切は12月末', steps: ['冬の説明会には、申し込みがもう間に合わない', '春のオンラインの回だけ見ておけば足りる'], conclusion: '春のオンラインの回だけ見る', target_option: '説明会の回', stakes: 'low' },
      },
    ];
  });
}
