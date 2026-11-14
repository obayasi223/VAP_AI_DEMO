/**
 * 2 体の AI の話し合い（two_ai）の設定、台本、人格、点の文型、予備の筋書き、manifest（docs/design/two_ai/06 §9）。
 *
 * JSON Schema は出さない（SCHEMAS に名前を足さない。06 §4.5、第 3 回 m6）。正本は zod で、起動時に parse する。
 */
import { z } from 'zod';
import {
  AiId,
  BoardDependency,
  DiscussionStage,
  NonEmptyString,
  NonNegativeInt,
  NonNegativeMs,
  PointKind,
  PointTrigger,
  Probability,
  TwoAiCondition,
} from './common';

// ---- 9.1 セッションの設定 ------------------------------------------------------

const Sec = z.number().min(0);
const GapDist = z.strictObject({ median: NonNegativeMs, min: NonNegativeMs, max: NonNegativeMs });

export const TwoAiSessionConfig = z
  .strictObject({
    config_id: NonEmptyString,
    version: z.number().int().min(1),
    /** 研究者が本人役（correction.mode: 'auto' を許す）。 */
    self_run: z.boolean(),
    phases: z.strictObject({
      intake: z.strictObject({
        min_sec: Sec,
        soft_sec: Sec,
        max_sec: Sec,
        /** これ以降、台帳に core があれば早い計画を始める（既定 = soft_sec）。 */
        plan_start_sec: Sec,
      }),
      plan_wait: z.strictObject({
        /** 始めの台詞の後、計画がなければこの後につなぎ 1（既定 0）。 */
        filler_after_ms: NonNegativeMs,
        /** 待ちの始まりからつなぎ 2 まで（既定 12000。null で言わない）。 */
        second_filler_after_ms: NonNegativeMs.nullable(),
        /** 待ちの上限（暫定 25000）。 */
        max_wait_ms: NonNegativeMs,
        on_timeout: z.enum(['fallback_plan', 'pause_for_woz']),
      }),
      discussion: z.strictObject({
        target_sec: Sec,
        /** これ以降は optional の拍を飛ばして close へ。 */
        close_at_sec: Sec,
        /** 点がすべて閉じていれば、ここで段を移る。 */
        max_sec: Sec,
        /** 点のために max_sec を延ばせる上限（絶対の上限 = max_sec + これ）。 */
        points_overrun_max_sec: Sec,
        /** after_turn の見込みの時刻（暫定 9）。 */
        avg_turn_sec_estimate: z.number().positive(),
        /** 最後の点の後に残す見込み（暫定 30）。 */
        closing_reserve_sec: Sec,
        chars_per_sec_estimate: z.number().positive(),
        /** 4 段の長さの割合（target_sec に対して。和は 1）。 */
        stage_fracs: z.tuple([z.number().positive(), z.number().positive(), z.number().positive(), z.number().positive()]),
      }),
      /** 最後の段の前半（some 型の問い → 本人 → 受け止め → 作り直し）。両条件で同一。② に追加の時間はない。 */
      response: z.strictObject({
        /** 条件ごとに分けない 1 つの値（AC6(a)）。 */
        duration_sec: Sec,
        /** 時間の後に本人の話の切れ目を待つ上限（既定 10）。 */
        overrun_max_sec: Sec,
        silence_prompt_sec: Sec,
        max_silence_prompts: NonNegativeInt,
      }),
      /** 最後の段の後半：板から 1 枚を選ぶ。 */
      next_step: z.strictObject({ pick_max_sec: Sec }),
    }),
    /** next_step は選ぶ案内（pick_*）の話者。closing は最後の段の問いと作り直しの最初の話者。 */
    speakers: z.strictObject({ intake: AiId, next_step: AiId, closing: AiId }),
    gaps_ms: z.strictObject({
      default: GapDist,
      react: GapDist,
      after_point: GapDist,
      resume_gap_ms: NonNegativeMs,
      /** 暫定 1500。文が届かなければ凍結の fallback。 */
      max_wait_for_ready_ms: NonNegativeMs,
      /** 体験の旗の feed_turn だけ（暫定 4000）。 */
      feed_turn_max_wait_ms: NonNegativeMs,
    }),
    interjection: z.strictObject({
      detector: z.strictObject({
        /** null は policy の値。 */
        vad_threshold: Probability.nullable(),
        p_now_user_min: Probability.nullable(),
        p_future_user_min: Probability.nullable(),
        p_combine: z.enum(['and', 'or']),
        onset_min_ms: NonNegativeMs,
        refractory_ms: NonNegativeMs,
        fallback_dbfs: z.number(),
        fallback_onset_min_ms: NonNegativeMs,
        sub_threshold_min_ms: NonNegativeMs,
      }),
      /** null は policy.turn.stop_boundary_max_ms。 */
      stop_max_wait_ms: NonNegativeMs.nullable(),
      /** 超えたら two_ai.anomaly(user_floor_long)。打ち切りは WoZ の resume。 */
      user_floor_max_ms: NonNegativeMs,
      /** onset からこの長さの間に、声が backchannel_max_voiced_ms に届かず文もなければ false_onset（暫定 1500）。 */
      false_onset_window_ms: NonNegativeMs,
      classify: z.strictObject({ backchannel_max_voiced_ms: NonNegativeMs, backchannel_max_chars: NonNegativeInt }),
    }),
    /** 印のボタン。両条件で同じ（条件ごとの値は型として書けない）。 */
    marker: z.strictObject({
      enabled: z.boolean(),
      /** これより短い間隔の連打は記録するが数えない（暫定 1000）。 */
      min_interval_ms: NonNegativeMs,
      /** 声の onset の前後この長さに印があれば episode に near_marker（暫定 500）。 */
      near_window_ms: NonNegativeMs,
    }),
    /** 当日の撤回。self_run でないセッションは after_measures に限る（superRefine）。 */
    retraction: z.strictObject({
      timing: z.enum(['end_of_session', 'after_measures']),
      /**
       * 穴：{slip_statement}、{correct_statement}、{inference_steps}、{inference_conclusion}。過程の説明は穴なし。
       * inference は元の推論を話したとき、inference_unspoken は話していないとき。
       */
      template: z.strictObject({
        fact: NonEmptyString,
        inference: NonEmptyString,
        inference_unspoken: NonEmptyString,
        process: NonEmptyString,
      }),
      speaker: AiId,
    }),
    acknowledgment: z.strictObject({
      templates: z.array(z.strictObject({ id: NonEmptyString, text: NonEmptyString })).min(1),
      selection: z.enum(['fixed_first', 'round_robin']),
      duration_tolerance_ms: NonNegativeMs,
      speaker: z.literal('interrupted_ai'),
    }),
    fixed: z.strictObject({
      /** 「話を戻すと、」 */
      bridge: NonEmptyString,
      /** 判定の保留が時間切れのときの中立のつなぎ（取り違えの文を含めない。開始時に 2 体の声で合成して保持）。 */
      hold_bridge: NonEmptyString,
      lines: z.strictObject({
        opening_two: NonEmptyString,
        opening_cond: z.strictObject({ respond_on_spot: NonEmptyString, respond_at_end: NonEmptyString }),
        /** 条件で変えない。 */
        plan_fillers: z.array(NonEmptyString).min(1).max(2),
        closing_two: NonEmptyString,
        /** 最後の段の some 型の問い。名前を含めない（長さを固定する）。開始時に合成して保持。 */
        closing_question: NonEmptyString,
        response_more: NonEmptyString,
        intake_first_question: NonEmptyString,
        /** 中立な事実の問い（06 §9.5）。 */
        intake_fact_questions: z.array(NonEmptyString).min(1).max(2),
        /** 穴 {core}。 */
        core_readback: NonEmptyString,
        /** 台帳に core がないとき。 */
        core_readback_no_core: NonEmptyString,
        pick_prompt: NonEmptyString,
        pick_confirm: NonEmptyString,
        pick_timeout: NonEmptyString,
      }),
      /** 台本に stages がないときの 4 つの見出し（中立な文。C の語、取り違えの値を含めない）。 */
      stage_headings: z.tuple([NonEmptyString, NonEmptyString, NonEmptyString, NonEmptyString]),
      instruction_keys: z.strictObject({
        intake: NonEmptyString,
        discussion: z.strictObject({ respond_on_spot: NonEmptyString, respond_at_end: NonEmptyString }),
        response: NonEmptyString,
        next_step: NonEmptyString,
        end: NonEmptyString,
      }),
    }),
    correction: z.strictObject({
      assist: z.boolean(),
      mode: z.enum(['researcher', 'auto']),
      decision_window_ms: NonNegativeMs,
      /** F のブロックの途中の割り込みで、判定を待つ上限（本人の発話の終わりから。暫定 6000）。decision_window_ms 以上。 */
      hold_max_ms: NonNegativeMs,
    }),
    experience: z.strictObject({
      interjection_feeds_generation: z.boolean().default(false),
      response_mode: z.enum(['fixed', 'reflective']).default('fixed'),
      feed: z.strictObject({ max_items: z.number().int().min(1).max(5), max_chars: z.number().int().min(20).max(400) }),
    }),
    generation: z.strictObject({
      models: z.strictObject({
        intake: NonEmptyString,
        ledger: NonEmptyString,
        discussion_plan: NonEmptyString,
        discussion_turn: NonEmptyString,
        correction_assist: NonEmptyString,
      }),
      lookahead_turns: z.number().int().min(1).max(3),
      history_turns: NonNegativeInt,
      timeout_ms: z.strictObject({
        discussion_turn: NonNegativeMs,
        discussion_plan: NonNegativeMs,
        ledger: NonNegativeMs,
        correction_assist: NonNegativeMs,
      }),
    }),
    safety: z.strictObject({ banned_terms_file: NonEmptyString, person_evaluation_pairs_file: NonEmptyString }),
    render: z.strictObject({
      max_fps: z.number().positive(),
      pixel_ratio_max: z.number().positive(),
      spring_bones: z.enum(['all', 'speaker_only', 'none']),
    }),
  })
  .superRefine((c, ctx) => {
    const i = c.phases.intake;
    const d = c.phases.discussion;
    if (!(i.min_sec <= i.plan_start_sec && i.plan_start_sec <= i.soft_sec && i.soft_sec <= i.max_sec)) {
      ctx.addIssue({ code: 'custom', message: 'intake: min ≤ plan_start ≤ soft ≤ max' });
    }
    if (!(d.close_at_sec <= d.target_sec && d.target_sec <= d.max_sec)) {
      ctx.addIssue({ code: 'custom', message: 'discussion: close_at ≤ target ≤ max' });
    }
    if (c.correction.mode === 'auto' && !c.self_run) {
      ctx.addIssue({ code: 'custom', message: "correction.mode 'auto' needs self_run: true" });
    }
    if (c.phases.plan_wait.second_filler_after_ms !== null && c.phases.plan_wait.second_filler_after_ms >= c.phases.plan_wait.max_wait_ms) {
      ctx.addIssue({ code: 'custom', message: 'plan_wait: second filler must come before max_wait' });
    }
    if (new Set(c.acknowledgment.templates.map((t) => t.id)).size !== c.acknowledgment.templates.length) {
      ctx.addIssue({ code: 'custom', message: 'acknowledgment template ids must be unique' });
    }
    if (Math.abs(d.stage_fracs.reduce((a, b) => a + b, 0) - 1) > 1e-6) {
      ctx.addIssue({ code: 'custom', message: 'discussion.stage_fracs must sum to 1' });
    }
    if (!c.self_run && c.retraction.timing !== 'after_measures') {
      ctx.addIssue({ code: 'custom', message: "retraction.timing must be 'after_measures' unless self_run" });
    }
    if (c.interjection.false_onset_window_ms < c.interjection.classify.backchannel_max_voiced_ms) {
      ctx.addIssue({ code: 'custom', message: 'false_onset_window_ms must be ≥ backchannel_max_voiced_ms' });
    }
    if (c.correction.hold_max_ms < c.correction.decision_window_ms) {
      ctx.addIssue({ code: 'custom', message: 'correction.hold_max_ms must be ≥ decision_window_ms' });
    }
  });
/** parse の後の形（experience の既定が埋まっている）。 */
export type TwoAiSessionConfig = z.infer<typeof TwoAiSessionConfig>;
/** ファイルに書く形（experience の 2 項目は省略できる）。 */
export type TwoAiSessionConfigInput = z.input<typeof TwoAiSessionConfig>;

// ---- 9.3 台本 ---------------------------------------------------------------

export const FrozenTurnSpec = z.strictObject({ turn_key: NonEmptyString, speaker: AiId, text: NonEmptyString });
export type FrozenTurnSpec = z.infer<typeof FrozenTurnSpec>;

/** 2 段の推論（fact_slip と control_inference で同じ形）。結論は利害の低い選択肢だけに向ける。 */
export const InferenceSpec = z.strictObject({
  premise_fact_id: NonEmptyString,
  /** fact_slip では slip_statement と同じ文。 */
  premise_statement: NonEmptyString,
  /** 「それなら△△は外れる」「すると残るのは□□だ」 */
  steps: z.tuple([NonEmptyString, NonEmptyString]),
  /** 事後の「推論への同意」の項目に使う 1 文。 */
  conclusion: NonEmptyString,
  /** 結論が向く選択肢（利害の低いもの）。 */
  target_option: NonEmptyString,
  stakes: z.literal('low'),
});
export type InferenceSpec = z.infer<typeof InferenceSpec>;

export const PlannedPointSpec = z.strictObject({
  id: NonEmptyString,
  kind: PointKind,
  speaker: AiId,
  trigger: PointTrigger,
  /** fact_slip と control_inference は 2（推論の 2 段）。 */
  elaborate_turns: NonNegativeInt,
  /** prepared：文を研究者が書いて凍結済み。generated：intake の後に 02 が文型（point_templates）から作る。 */
  source: z.enum(['prepared', 'generated']),
  /** prepared のとき 1 + elaborate_turns 本。generated は null。 */
  turns: z.array(FrozenTurnSpec).nullable(),
  /**
   * 訂正後の版。すべての点で必須（prepared のとき）。turns と同じ本数、同じ turn_key と話者。
   * fact_slip の訂正後の版は、取り違えた値とそれを前提にした推論を含まない。文字数は各ターンで元の ±15% 以内。
   */
  corrected_turns: z.array(FrozenTurnSpec).nullable(),
  /** fact_slip で prepared のとき必須（訂正後に受け止めの後で話す 1 文）。それ以外は null。 */
  uptake: FrozenTurnSpec.nullable(),
  /** fact_slip で prepared のとき必須。slip_value は取り違えた値そのもの（検査に使う）。 */
  slip: z
    .strictObject({
      fact_id: NonEmptyString,
      correct_statement: NonEmptyString,
      slip_statement: NonEmptyString,
      slip_value: NonEmptyString,
    })
    .nullable(),
  /** fact_slip と control_inference で prepared のとき必須。framing_C は null。 */
  inference: InferenceSpec.nullable(),
});
export type PlannedPointSpec = z.infer<typeof PlannedPointSpec>;

/** 事前に書く中立な事実。真の値で書く。取り違えと対照で 2 つ要る。 */
export const PriorFact = z.strictObject({
  fact_id: NonEmptyString,
  kind: z.enum(['date', 'number', 'status', 'place']),
  /** 例「インターンの締切は 2 月末」 */
  text: NonEmptyString,
  /** 例「12 月末」。null は 02 が作る。 */
  slip_hint: NonEmptyString.nullable(),
});
export type PriorFact = z.infer<typeof PriorFact>;

/** 板の 1 枚（台本の版）。 */
export const BoardCardSpec = z.strictObject({
  card_id: NonEmptyString,
  order: z.number().int().min(1).max(4),
  /** その段の終わりのターン（02 が決める）で出す。 */
  discussion_stage: DiscussionStage,
  /** 計画 v2：1 は fact_slip、3 は framing_C。 */
  depends_on: BoardDependency,
  text: NonEmptyString,
  /** 訂正後の板の文。depends_on が fact_slip 以外なら text と同じでよい。取り違えた値を含まない。 */
  corrected_text: NonEmptyString,
});
export type BoardCardSpec = z.infer<typeof BoardCardSpec>;

/** 当日の撤回の文（prepared）。generated は設定の retraction.template を穴埋めして作る。 */
export const RetractionSpec = z.strictObject({
  fact: NonEmptyString,
  inference: NonEmptyString,
  inference_unspoken: NonEmptyString,
  process: NonEmptyString,
});
export type RetractionSpec = z.infer<typeof RetractionSpec>;

export const TwoAiScript = z
  .strictObject({
    script_id: NonEmptyString,
    version: z.number().int().min(1),
    /** own は *.local.json に限る（読み込みで検査）。 */
    kind: z.enum(['demo', 'own']),
    topic: NonEmptyString,
    aspect: NonEmptyString,
    user_name: NonEmptyString,
    user_name_reading: NonEmptyString,
    sample_persona: z.strictObject({ name: NonEmptyString, profile: z.array(NonEmptyString) }).nullable(),
    prior: z.strictObject({
      core: NonEmptyString.nullable(),
      confidence_0_100: z.number().min(0).max(100).nullable(),
      facts: z.array(PriorFact),
    }),
    personas_file: NonEmptyString,
    /** 4 段の見出し（中立な文）。null は設定の fixed.stage_headings。 */
    stages: z.tuple([NonEmptyString, NonEmptyString, NonEmptyString, NonEmptyString]).nullable(),
    planned_points: z.array(PlannedPointSpec).min(1),
    /** 板（4 枚）。null は 02 が計画の凍結で作る（generated）。 */
    board: z.array(BoardCardSpec).length(4).nullable(),
    /** 最後の段の作り直しの文（1〜2 ターン。訂正後の板を読み上げる）。null は 02 が文型から作る。 */
    rebuild_turns: z.array(FrozenTurnSpec).min(1).max(2).nullable(),
    retraction: RetractionSpec.nullable(),
    intake_source: z.enum(['live', 'scripted']),
    scripted_intake: z.array(z.strictObject({ at_sec: Sec, text: NonEmptyString })).nullable(),
    hide_points_on_research_screen: z.boolean(),
  })
  .superRefine((s, ctx) => {
    const ids = s.planned_points.map((p) => p.id);
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: 'point ids must be unique' });
    for (const k of ['framing_C', 'fact_slip', 'control_inference'] as const) {
      if (s.planned_points.filter((p) => p.kind === k).length > 1) ctx.addIssue({ code: 'custom', message: `at most one ${k} in v1` });
    }
    for (const p of s.planned_points) {
      const needsInference = p.kind === 'fact_slip' || p.kind === 'control_inference';
      if (p.source === 'prepared') {
        if (p.turns === null || p.turns.length !== 1 + p.elaborate_turns) {
          ctx.addIssue({ code: 'custom', message: `${p.id}: prepared needs 1 + elaborate_turns turns` });
        }
        const turns = p.turns;
        if (
          p.corrected_turns === null ||
          turns === null ||
          p.corrected_turns.length !== turns.length ||
          p.corrected_turns.some((t, i) => t.turn_key !== turns[i]!.turn_key || t.speaker !== turns[i]!.speaker)
        ) {
          ctx.addIssue({ code: 'custom', message: `${p.id}: corrected_turns must mirror turns` });
        }
        if (p.kind === 'fact_slip' && (p.uptake === null || p.slip === null)) {
          ctx.addIssue({ code: 'custom', message: `${p.id}: prepared fact_slip needs uptake and slip` });
        }
        if (p.kind !== 'fact_slip' && (p.uptake !== null || p.slip !== null)) {
          ctx.addIssue({ code: 'custom', message: `${p.id}: uptake/slip only for fact_slip` });
        }
        if (needsInference !== (p.inference !== null)) {
          ctx.addIssue({ code: 'custom', message: `${p.id}: inference iff fact_slip/control_inference` });
        }
      } else if (p.turns !== null || p.corrected_turns !== null || p.uptake !== null || p.slip !== null || p.inference !== null) {
        ctx.addIssue({ code: 'custom', message: `${p.id}: generated must not carry turns/corrected_turns/uptake/slip/inference` });
      }
      if (needsInference && p.elaborate_turns !== 2) {
        ctx.addIssue({ code: 'custom', message: `${p.id}: inference points need elaborate_turns 2` });
      }
    }
    // 取り違えた値が、訂正後に話す文と出す文（点の corrected_turns、板の corrected_text、作り直し）に出ない（AC3(h) の静的な検査）
    const slip = s.planned_points.find((p) => p.kind === 'fact_slip')?.slip ?? null;
    if (slip !== null) {
      const after = [
        // fact_slip の訂正後の版の最初のターン（F.0。使われない）は除く
        ...s.planned_points.flatMap((p) => (p.corrected_turns ?? []).slice(p.kind === 'fact_slip' ? 1 : 0)).map((t) => t.text),
        ...(s.board ?? []).map((c) => c.corrected_text),
        ...(s.rebuild_turns ?? []).map((t) => t.text),
      ];
      if (after.some((x) => x.includes(slip.slip_statement) || x.includes(slip.slip_value))) {
        ctx.addIssue({ code: 'custom', message: 'slip text must not appear in corrected versions, corrected board or rebuild' });
      }
    }
    if (s.board !== null && new Set(s.board.map((c) => c.order)).size !== 4) {
      ctx.addIssue({ code: 'custom', message: 'board orders must be 1..4' });
    }
    // 計画 §4.4：カード 1 は取り違えに、カード 3 は C に依存する
    const board = s.board;
    if (board !== null) {
      const dep = (o: number) => board.find((c) => c.order === o)?.depends_on;
      if (dep(1) !== 'fact_slip') ctx.addIssue({ code: 'custom', message: 'board card 1 must depend on fact_slip' });
      if (dep(3) !== 'framing_C') ctx.addIssue({ code: 'custom', message: 'board card 3 must depend on framing_C' });
    }
    // 取り違えの推論と対照の推論は、話者の並びをそろえる（同意の差に人格の差を混ぜない）
    const f = s.planned_points.find((p) => p.kind === 'fact_slip');
    const k = s.planned_points.find((p) => p.kind === 'control_inference');
    if (f && k) {
      if (f.speaker !== k.speaker) ctx.addIssue({ code: 'custom', message: 'control_inference speaker must equal fact_slip speaker' });
      if (f.turns && k.turns && f.turns.map((t) => t.speaker).join() !== k.turns.map((t) => t.speaker).join()) {
        ctx.addIssue({ code: 'custom', message: 'control_inference turn speakers must mirror fact_slip' });
      }
    }
    if (s.intake_source === 'scripted' && s.scripted_intake === null) {
      ctx.addIssue({ code: 'custom', message: 'scripted intake needs scripted_intake' });
    }
  });
export type TwoAiScript = z.infer<typeof TwoAiScript>;

// ---- 9.4 人格、点の文型、予備の筋書き ---------------------------------------------

export const TwoAiPersona = z.strictObject({
  ai_id: AiId,
  persona_id: NonEmptyString,
  version: z.number().int().min(1),
  display_name: NonEmptyString,
  lens_id: NonEmptyString,
  lens_summary: NonEmptyString,
  interests: z.array(NonEmptyString),
  questions_it_asks: z.array(NonEmptyString),
  speech_style: NonEmptyString,
  not_to_do: z.array(NonEmptyString),
  voice_env: z.enum(['TWO_AI_VOICE_A', 'TWO_AI_VOICE_B']),
  avatar_key: NonEmptyString,
});
export type TwoAiPersona = z.infer<typeof TwoAiPersona>;

export const TwoAiPersonas = z
  .strictObject({ version: z.number().int().min(1), personas: z.tuple([TwoAiPersona, TwoAiPersona]) })
  .refine(
    (p) => p.personas[0].ai_id === 'A' && p.personas[1].ai_id === 'B' && p.personas[0].voice_env !== p.personas[1].voice_env,
    { message: 'personas must be [A, B] with different voice_env' },
  );
export type TwoAiPersonas = z.infer<typeof TwoAiPersonas>;

/** config/two_ai/point_templates.ja.json：generated の点の文型と既定。 */
export const TwoAiPointTemplates = z.strictObject({
  version: z.number().int().min(1),
  points: z.array(
    z.strictObject({
      kind: PointKind,
      default_speaker: AiId,
      /** 既定は in_stage（計画 v2 の配置）。 */
      default_trigger: PointTrigger,
      elaborate_turns: NonNegativeInt,
      turns: z.array(
        z.strictObject({
          turn_key: NonEmptyString,
          role: z.enum(['speaker', 'peer']),
          template: NonEmptyString,
          /** 訂正後の版の文型。取り違えに依らない点は template と同じ文型。 */
          corrected_template: NonEmptyString,
          target_chars: z.tuple([NonNegativeInt, NonNegativeInt]),
        }),
      ),
      uptake_template: NonEmptyString.nullable(),
    }),
  ),
  /** 板の 4 枚の文型（order 1〜4。穴は計画の点の値と台帳）。 */
  board_cards: z
    .array(
      z.strictObject({
        order: z.number().int().min(1).max(4),
        discussion_stage: DiscussionStage,
        depends_on: BoardDependency,
        template: NonEmptyString,
        corrected_template: NonEmptyString,
        target_chars: z.tuple([NonNegativeInt, NonNegativeInt]),
      }),
    )
    .length(4),
  /** 最後の段の作り直しの文型（穴 {card_1}〜{card_4} は訂正後の板の文）。 */
  rebuild_templates: z
    .array(z.strictObject({ turn_key: NonEmptyString, role: z.enum(['closing_speaker', 'peer']), template: NonEmptyString }))
    .min(1)
    .max(2),
});
export type TwoAiPointTemplates = z.infer<typeof TwoAiPointTemplates>;

/** config/two_ai/fallback_outline.ja.json：計画の待ちの上限で使う筋書き（LLM を使わない）。 */
export const TwoAiFallbackOutline = z.strictObject({
  version: z.number().int().min(1),
  beats: z
    .array(
      z.strictObject({
        beat_id: NonEmptyString,
        speaker: AiId,
        kind: z.enum(['open', 'develop', 'react', 'question', 'contrast', 'close']),
        /** 各段に 1 拍以上。optional は段 4 だけ。 */
        discussion_stage: DiscussionStage,
        /** 台帳の穴：{user_name}、{core_short}、{option_1}、{option_2}、{value_1}。 */
        text_template: NonEmptyString,
        /** 穴が台帳から埋まらないときの文（穴なし）。 */
        text_generic: NonEmptyString,
        optional: z.boolean(),
      }),
    )
    .min(6),
  /** 予備の筋書きの板（台帳の穴なしの汎用の 4 枚。2 版とも同じ文）と作り直しの文。 */
  board_generic: z
    .array(z.strictObject({ order: z.number().int().min(1).max(4), discussion_stage: DiscussionStage, text: NonEmptyString }))
    .length(4),
  rebuild_generic: z.array(NonEmptyString).min(1).max(2),
});
export type TwoAiFallbackOutline = z.infer<typeof TwoAiFallbackOutline>;

// ---- 9.2 点の日程の検査 ------------------------------------------------------------

export interface PointScheduleCheck {
  ok: boolean;
  points: {
    point_id: string;
    discussion_stage: DiscussionStage | null;
    expected_start_sec: number;
    expected_block_sec: number;
    expected_end_sec: number;
  }[];
  /** 段ごとの見込み（in_stage の台本のとき）。 */
  stages: { discussion_stage: DiscussionStage; expected_start_sec: number; expected_end_sec: number }[];
  latest_point_end_sec: number;
  /** close_at_sec − closing_reserve_sec。 */
  limit_sec: number;
  reason: string | null;
}

const STAGES = [1, 2, 3, 4] as const;

/** 計画 v2 の配置（in_stage の点だけに掛ける）。 */
const PLACEMENT: Record<PointKind, readonly DiscussionStage[]> = {
  fact_slip: [1],
  framing_C: [3],
  control_inference: [2, 4],
};

function chars(turns: readonly { text: string }[]): number {
  return turns.reduce((sum, t) => sum + [...t.text].length, 0);
}

/** 点のブロックの見込みの長さ（秒）。凍結文があれば 2 版の長い方、なければ文型の目標の上限。null は文型がない。 */
function blockSec(point: PlannedPointSpec, templates: TwoAiPointTemplates, charsPerSec: number): number | null {
  if (point.turns !== null) {
    return Math.max(chars(point.turns), chars(point.corrected_turns ?? [])) / charsPerSec;
  }
  const template = templates.points.find((t) => t.kind === point.kind);
  if (template === undefined) return null;
  return template.turns.reduce((sum, t) => sum + t.target_chars[1], 0) / charsPerSec;
}

/**
 * 点の日程の検査（06 §9.2。起動時と計画の凍結時）。時刻はすべて中身の時計の見込み（秒）。
 * 見込みの開始：in_stage s, k は「段 s の始まり ＋ k × avg_turn_sec_estimate ＋ 同じ段のそれより前の点のブロック」。
 *   段 s の始まりは、前の段の拍の数 × avg ＋ 前の段の点のブロックの和（拍の数は stage_beats、なければ target_sec × stage_fracs ÷ avg を丸めた値、最小 1）。
 * after_turn k は k × avg ＋ それより前の点のブロック、at_sec t は t、at_frac f は f × target_sec。
 * 合格：(1) すべての点で expected_end_sec ≤ close_at_sec − closing_reserve_sec。
 *       (2) in_stage の点は、その段の中に収まる（段の拍の数 ≥ k）。
 *       (3) fact_slip は段 1、framing_C は段 3、control_inference は段 2 か段 4（in_stage の点だけ）。
 */
export function validatePointSchedule(
  config: TwoAiSessionConfig,
  points: PlannedPointSpec[],
  templates: TwoAiPointTemplates,
  stage_beats: [number, number, number, number] | null,
): PointScheduleCheck {
  const d = config.phases.discussion;
  const avg = d.avg_turn_sec_estimate;
  const limit_sec = d.close_at_sec - d.closing_reserve_sec;
  const beats: [number, number, number, number] =
    stage_beats ?? (d.stage_fracs.map((f) => Math.max(1, Math.round((d.target_sec * f) / avg))) as [number, number, number, number]);
  const reasons: string[] = [];

  const blocks = new Map<string, number>();
  for (const p of points) {
    const b = blockSec(p, templates, d.chars_per_sec_estimate);
    if (b === null) {
      reasons.push(`${p.id}: no point template for ${p.kind}`);
      blocks.set(p.id, 0);
    } else {
      blocks.set(p.id, b);
    }
  }
  const blockOf = (p: PlannedPointSpec) => blocks.get(p.id) ?? 0;

  // in_stage の点（段と k の順。同じ k は台本の順）
  type InStage = { point: PlannedPointSpec; stage: DiscussionStage; k: number; index: number };
  const inStage: InStage[] = [];
  points.forEach((p, index) => {
    if ('in_stage' in p.trigger) inStage.push({ point: p, stage: p.trigger.in_stage, k: p.trigger.after_stage_turn, index });
  });
  inStage.sort((a, b) => a.stage - b.stage || a.k - b.k || a.index - b.index);

  const stageBlock = (s: DiscussionStage) => inStage.filter((x) => x.stage === s).reduce((sum, x) => sum + blockOf(x.point), 0);
  const stageStart: Record<number, number> = {};
  let cursor = 0;
  for (const s of STAGES) {
    stageStart[s] = cursor;
    cursor += beats[s - 1]! * avg + stageBlock(s);
  }
  const stages: PointScheduleCheck['stages'] =
    inStage.length === 0
      ? []
      : STAGES.map((s) => ({
          discussion_stage: s,
          expected_start_sec: stageStart[s]!,
          expected_end_sec: stageStart[s]! + beats[s - 1]! * avg + stageBlock(s),
        }));

  const starts = new Map<string, { start: number; stage: DiscussionStage | null }>();
  for (const s of STAGES) {
    let before = 0;
    for (const x of inStage.filter((y) => y.stage === s)) {
      starts.set(x.point.id, { start: stageStart[s]! + x.k * avg + before, stage: s });
      before += blockOf(x.point);
      if (x.k > beats[s - 1]!) reasons.push(`${x.point.id}: after_stage_turn ${x.k} exceeds stage ${s} beats ${beats[s - 1]}`);
      if (!PLACEMENT[x.point.kind].includes(s)) reasons.push(`${x.point.id}: ${x.point.kind} must be in stage ${PLACEMENT[x.point.kind].join(' or ')}`);
    }
  }
  for (const p of points) {
    if ('at_sec' in p.trigger) starts.set(p.id, { start: p.trigger.at_sec, stage: null });
    else if ('at_frac' in p.trigger) starts.set(p.id, { start: p.trigger.at_frac * d.target_sec, stage: null });
  }
  // after_turn は k の順に、それより前に始まる点のブロックを足す
  const afterTurn = points.filter((p) => 'after_turn' in p.trigger).sort((a, b) => turnOf(a) - turnOf(b));
  for (const p of afterTurn) {
    const base = turnOf(p) * avg;
    let before = 0;
    for (const q of points) {
      if (q === p) continue;
      const known = starts.get(q.id);
      if (known !== undefined && known.start <= base + before) before += blockOf(q);
    }
    starts.set(p.id, { start: base + before, stage: null });
  }

  const rows: PointScheduleCheck['points'] = points.map((p) => {
    const known = starts.get(p.id) ?? { start: 0, stage: null };
    const block = blockOf(p);
    return {
      point_id: p.id,
      discussion_stage: known.stage,
      expected_start_sec: known.start,
      expected_block_sec: block,
      expected_end_sec: known.start + block,
    };
  });
  const latest_point_end_sec = rows.reduce((m, r) => Math.max(m, r.expected_end_sec), 0);
  for (const r of rows) {
    if (r.expected_end_sec > limit_sec) {
      reasons.push(`${r.point_id}: expected end ${r.expected_end_sec.toFixed(1)}s > limit ${limit_sec.toFixed(1)}s`);
    }
  }
  return {
    ok: reasons.length === 0,
    points: rows,
    stages,
    latest_point_end_sec,
    limit_sec,
    reason: reasons.length === 0 ? null : reasons.join('; '),
  };
}

function turnOf(p: PlannedPointSpec): number {
  return 'after_turn' in p.trigger ? p.trigger.after_turn : 0;
}

// ---- 9.6 manifest ------------------------------------------------------------------

/** SessionManifestDetails の two_ai（1 対 1 は書かない）。文面はハッシュだけ。 */
export const TwoAiManifest = z.strictObject({
  config_file: NonEmptyString,
  config_sha256: NonEmptyString,
  config_id: NonEmptyString,
  config_version: z.number().int(),
  script_file: NonEmptyString,
  script_sha256: NonEmptyString,
  script_id: NonEmptyString,
  script_kind: z.enum(['demo', 'own']),
  condition: TwoAiCondition,
  condition_source: z.enum(['research_screen', 'env']),
  arm_id: NonEmptyString.nullable(),
  self_run: z.boolean(),
  correction_mode: z.enum(['researcher', 'auto']),
  personas: z.strictObject({
    A: z.strictObject({
      persona_id: NonEmptyString,
      version: z.number().int(),
      voice_env: z.literal('TWO_AI_VOICE_A'),
      voice_provider: z.enum(['elevenlabs', 'gemini']),
    }),
    B: z.strictObject({
      persona_id: NonEmptyString,
      version: z.number().int(),
      voice_env: z.literal('TWO_AI_VOICE_B'),
      voice_provider: z.enum(['elevenlabs', 'gemini']),
    }),
  }),
  planned_points: z.array(
    z.strictObject({
      id: NonEmptyString,
      kind: PointKind,
      speaker: AiId,
      trigger: PointTrigger,
      elaborate_turns: NonNegativeInt,
      source: z.enum(['prepared', 'generated']),
      /** prepared の文面のハッシュだけ。generated は計画の凍結の後に plan_hash で。 */
      text_sha256: NonEmptyString.nullable(),
    }),
  ),
  point_schedule: z.strictObject({ ok: z.boolean(), latest_point_end_sec: z.number(), limit_sec: z.number() }),
  ack_templates: z.array(
    z.strictObject({
      id: NonEmptyString,
      text_sha256: NonEmptyString,
      synthesized_ms: z.strictObject({ A: NonNegativeMs, B: NonNegativeMs }),
    }),
  ),
  response_duration_sec: z.number().min(0),
  experience: z.strictObject({
    interjection_feeds_generation: z.strictObject({
      requested: z.boolean(),
      effective: z.boolean(),
      source: z.enum(['config', 'research_screen']),
    }),
    response_mode: z.enum(['fixed', 'reflective']),
  }),
  exploratory: z.boolean(),
  /** 凍結の後に書き直す。 */
  plan_hash: NonEmptyString.nullable(),
  plan_source: z.enum(['prepared', 'generated', 'researcher_edited', 'fallback_outline']).nullable(),
  plan_wait_ms: NonNegativeMs.nullable(),
  fact_slip: z.enum(['available', 'unavailable']).nullable(),
  fact_slip_source: z.enum(['prior', 'ledger', 'none']).nullable(),
  control_inference: z.enum(['available', 'unavailable']).nullable(),
  /** 見出し、板（2 版）、作り直し、撤回の文のハッシュ（文面は manifest に写さない）。計画の凍結の後に書き直す。 */
  stage_headings_sha256: NonEmptyString,
  board_sha256: NonEmptyString.nullable(),
  rebuild_sha256: NonEmptyString.nullable(),
  /** script_sha256 は end で確定した文のハッシュ。two_ai.retraction.script_sha256 と同じ値に、end で書き直す。 */
  retraction: z.strictObject({
    timing: z.enum(['end_of_session', 'after_measures']),
    script_sha256: NonEmptyString.nullable(),
    inference_form: z.enum(['spoken', 'not_spoken', 'none']).nullable(),
  }),
  marker_enabled: z.boolean(),
  order: z.strictObject({
    session_index: z.union([z.literal(1), z.literal(2)]).nullable(),
    counterbalance_label: NonEmptyString.nullable(),
  }),
  /** 研究の比較の証拠に使えるか。exploratory、fallback_outline、fact_slip か control_inference の欠け、点の forced／missed で false。 */
  evidence_ok_for_comparison: z.boolean(),
  evidence_notes: z.array(NonEmptyString),
});
export type TwoAiManifest = z.infer<typeof TwoAiManifest>;
