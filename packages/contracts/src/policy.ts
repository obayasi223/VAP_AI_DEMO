/**
 * config/policy.hri2025.json と config/policy.ja.json のスキーマ（計画 §4.1）。
 *
 * hri2025 は Appendix A の原著値。リテラルで固定しているので、値を変えるとスキーマ検証で落ちる。
 * 英語 Furhat の値であり、日本語で最適とは主張しない。
 *
 * ja は日本語調整値。未校正の値は null を許し、status で状態を示す。
 * 節の持ち主: turn、gaze は E、similarity、completion は D、initiative は G。
 */
import { z } from 'zod';
import { ConversationKind, TimingStrategy } from './candidates';
import { ChannelLayout, NonEmptyString, NonNegativeMs, Probability } from './common';

/**
 * Appendix A の定数の形。hri2025 では値もリテラルで固定する。
 *
 * ja では TURNGPT_PREPARE_THRESHOLD と SIMILARITY_PREPARE_THRESHOLD を読まない。正本は completion.thresholds と
 * similarity.threshold で、prepareThresholds() から読む（理由は docs/known_gaps.md）。項目は後方互換のために残す。
 */
const TurnConstantsShape = {
  TURNGPT_PREPARE_THRESHOLD: Probability,
  ASR_PREPARE_TIMEOUT_MS: NonNegativeMs,
  SIMILARITY_PREPARE_THRESHOLD: Probability,
  VAP_PNOW_INTERRUPT: Probability,
  VAP_PFUT_INTERRUPT: Probability,
  VAP_PNOW_YIELD: Probability,
  VAP_PFUT_YIELD: Probability,
  MIN_GAP_TIME_MS: NonNegativeMs,
  YIELD_TIMEOUTS_MS: z.strictObject({
    '0.3': NonNegativeMs,
    '0.2': NonNegativeMs,
    '0.1': NonNegativeMs,
    '0.0': NonNegativeMs,
  }),
};

export const TurnConstants = z.strictObject(TurnConstantsShape);
export type TurnConstants = z.infer<typeof TurnConstants>;

/**
 * 計画 §4.1 の解釈の切替。
 *  - user_turn_end_updates_during_speech: true は発話中の分岐でも更新する（0ms 許可を防ぐ、計画の既定）。
 *    false は擬似コードどおり。
 *  - stop_point: word_boundary は語境界（上限つき、本文の記述）、immediate は比較用の即時停止
 *    （擬似コードは停止点を規定しない。docs/hri2025_mapping.md の I-2）。
 */
export const TurnInterpretation = z.strictObject({
  user_turn_end_updates_during_speech: z.boolean(),
  stop_point: z.enum(['word_boundary', 'immediate']),
  /** docs/hri2025_mapping.md の U 項目の補正を入れるか。false は擬似コードどおり（original）。 */
  apply_u_corrections: z.boolean(),
});
export type TurnInterpretation = z.infer<typeof TurnInterpretation>;

const VapDirection = z.strictObject({
  channel_layout: z.literal('2ch' satisfies ChannelLayout),
  /** p_now_ai = p_now[p_ai_index]。 */
  p_ai_index: z.union([z.literal(0), z.literal(1)]),
  /** R2 の実測前は provisional。 */
  direction_status: z.enum(['provisional', 'measured']),
  /** vad をこの値以上で speaking とする。 */
  speaking_threshold: Probability,
});

export const PolicyHri2025 = z.strictObject({
  $schema: z.string().optional(),
  policy_id: z.literal('hri2025'),
  immutable: z.literal(true),
  source: z.literal('Skantze & Irfan, HRI 2025, Appendix A'),
  note: z.literal(
    'English/Furhat pilot values kept for comparison. Not claimed to be optimal for Japanese.',
  ),
  constants: z.strictObject({
    TURNGPT_PREPARE_THRESHOLD: z.literal(0.2),
    ASR_PREPARE_TIMEOUT_MS: z.literal(200),
    SIMILARITY_PREPARE_THRESHOLD: z.literal(0.8),
    VAP_PNOW_INTERRUPT: z.literal(0.4),
    VAP_PFUT_INTERRUPT: z.literal(0.4),
    VAP_PNOW_YIELD: z.literal(0.5),
    VAP_PFUT_YIELD: z.literal(0.5),
    MIN_GAP_TIME_MS: z.literal(500),
    YIELD_TIMEOUTS_MS: z.strictObject({
      '0.3': z.literal(500),
      '0.2': z.literal(1000),
      '0.1': z.literal(2000),
      '0.0': z.literal(3000),
    }),
  }),
  /** 擬似コードどおりの挙動。計画の既定との差は docs/hri2025_mapping.md に記録する（R1）。 */
  interpretation: z.strictObject({
    user_turn_end_updates_during_speech: z.literal(false),
    stop_point: z.literal('immediate'),
    apply_u_corrections: z.literal(false),
  }),
});
export type PolicyHri2025 = z.infer<typeof PolicyHri2025>;

/** null は未校正。使う側は null を見たら黙って別の値へ置き換えず、未校正として扱う。 */
const Uncalibrated = (schema: z.ZodType<number>) => schema.nullable();

/**
 * InitiativeMonitor の起動の条件（計画 §4.5）。正規化後の新規の安定文字数で数える。
 * 値は【未検証の暫定値】で、実測の根拠はまだない。
 */
export const InitiativeTrigger = z.strictObject({
  /** 新規の安定文字数がこれ以上で起動。 */
  min_new_stable_chars: z.number().int().min(1),
  /** 文の区切りまたは final があるとき、これ以上で起動。null で文の区切りを見ない（final は常に見る）。 */
  min_new_chars_at_boundary: z.number().int().min(1).nullable(),
});
export type InitiativeTrigger = z.infer<typeof InitiativeTrigger>;

/**
 * 発話希望を振る舞いにつなぐ交渉（E2 の合図、E3 の選択。計画 §4.6）。値はどれも【暫定、未校正】。
 * 省略したら交渉は動かず、どの条件でも候補を記録するだけ（波2の振る舞い）。
 */
export const InitiativeNegotiation = z.strictObject({
  /**
   * 吸気の長さ（ms）。orchestrator が決めて合図に入れ、吸気の完了は orchestrator の時計で判定する
   * （ブラウザの完了の報告を待たない）。範囲はアバターの受け付ける範囲（apps/web の INHALE_MS_RANGE）と揃える。
   * アバターは範囲外を丸めるので、外れた値だと描く長さと orchestrator の時計がずれる。上限 1400 は出典がなく暫定。
   */
  inhale_ms: z.number().int().min(200).max(1400),
  /**
   * 吸気の後の準備姿勢（BREATH_HOLD_OR_READY）の長さ（ms）。これを過ぎた時点、またはそれ以降に人が話していたら
   * DEFERRED（脱力）へ移る。人が黙っている間は発話の許可を待つ。
   */
  hold_max_ms: z.number().int().min(0),
  /**
   * 合図と発話の直前の「判定が古くない」の上限。候補の最後の判定（NEW／KEEP／REVISE）の入力より後の新規の安定文字数。
   * null は max_new_stable_chars_since_input と同じ値。
   */
  max_new_stable_chars_since_judgement: z.number().int().min(0).nullable(),
  /**
   * 合図の直前の鮮度。候補の最後の判定を受けてからの経過（ms）がこれを超えたら合図しない（発話は妨げない）。
   * null は max_result_age_ms と同じ値。
   */
  cue_max_judgement_age_ms: NonNegativeMs.nullable(),
  /** 合図の後の人の反応を観測する窓（negotiation.cue_reaction）。【暫定、未校正】省略は記録しない。 */
  cue_reaction_window_ms: NonNegativeMs.optional(),
});
export type InitiativeNegotiation = z.infer<typeof InitiativeNegotiation>;

/**
 * 発話希望の二段判定（生成段とタイミング段。docs/initiative_v3_design.md）。値はどれも【未検証の暫定値】。
 * 省略は既存の1段判定（initiative-ja-v2）のまま。timing_strategy の既定は llm（設定ファイルで明示する）。
 */
export const InitiativeStaged = z.strictObject({
  timing_strategy: TimingStrategy,
  /** 開始画面で選ぶまでの既定の会話の種類。 */
  conversation_kind: ConversationKind,
  desire_prompt_version: NonEmptyString,
  timing_prompt_version: NonEmptyString,
  /** 生成段とタイミング段へ渡す直近の会話（今の発話より前）。 */
  recent_context: z.strictObject({
    max_turns: z.number().int().min(0),
    max_chars_per_turn: z.number().int().min(1),
  }),
  /**
   * REVISE の前後の proposed_utterance がこれ以上似ていて intent_type が同じなら、作り直さず維持として扱う（文字 2-gram のコサイン）。
   * 【暫定、未校正】省略は比較しない（すべて REVISE として適用）。
   */
  revise_min_utterance_similarity: Probability.optional(),
  /**
   * 候補の文と AI がすでに話した文の文字 2-gram のコサインがこれ以上なら「すでに話した内容」とする（発話の直前のガード、発話の後の照合、同内容の NEW の棄却）。
   * 【暫定、未校正】手書きの例で置いた値。省略はこの3つの照合をしない。
   */
  already_said_min_similarity: Probability.optional(),
  /**
   * 通常応答の材料が実際の発話に反映されたかの推定の基準（内容の字を含む文字 2-gram の包含率）。
   * 【暫定、未校正】推定の記録にだけ使う。省略は推定を記録しない。
   */
  reflection_min_containment: Probability.optional(),
});
export type InitiativeStaged = z.infer<typeof InitiativeStaged>;

/**
 * 開始の慎重化（原著にない、ja のみ。docs/known_gaps.md §10）。省略は原著どおりの開始の条件。
 * 値は【暫定、根拠は実機の1セッション（s20261108T045055-ca6e12）のみ】。
 */
export const StartGuard = z.strictObject({
  /** L67、L74、招待のどの経路でも、利用者の発話の終わりからこれ未満では許可しない（MIN_GAP_TIME_MS と大きい方）。 */
  min_gap_ms: NonNegativeMs,
  /** L74 で開始するとき、p_now_ai がこれ未満なら completion_timeout_low_p_min_ms 以上を待つ。 */
  completion_timeout_min_p_ai: Probability,
  completion_timeout_low_p_min_ms: NonNegativeMs,
});
export type StartGuard = z.infer<typeof StartGuard>;

/**
 * AI の発話が終わったときの扱い（原著にない、ja のみ。docs/known_gaps.md §10）。省略は原著どおり。
 * 値は【暫定、根拠は実機の1セッションのみ】。
 */
export const AfterAiSpeech = z.strictObject({
  /** AI の発話の終わりに user_speak_end_time と user_turn_end_time を終わりの時刻へ数え直す（L74 と L67 の待ちを数え直す）。 */
  rebase_user_end_times: z.boolean(),
  /**
   * AI の発話中に始まり、AI が話し終えた時点で止んでいた利用者の断片を、新しい発話として応答の対象にしない上限
   * （正規化後の文字数。この値以下）。0 は文字数で判定しない。断片は履歴には残す。
   */
  fragment_max_chars: z.number().int().min(0),
  /** 同じ扱いにする相槌の語句。正規化後の全体がこの語句の繰り返しだけなら断片とみなす。 */
  backchannel_phrases: z.array(NonEmptyString),
});
export type AfterAiSpeech = z.infer<typeof AfterAiSpeech>;

/**
 * VAP が使えない、信用できないとき（助走中、鮮度切れ、ワーカーの停止、値の異常など）の安全側の開始と割り込み
 * （原著にない、ja のみ。docs/known_gaps.md §12）。省略は今までどおりの fallback。値は【暫定、根拠は実機の1セッションのみ】。
 * 開始の待ちの長さは fallback_silence_max_ms と start_guard から求めるので、ここには持たない。
 */
export const VapUnavailable = z.strictObject({
  /** ASR の最後の更新が final のとき、更新が止まっていることを求める長さ。 */
  asr_quiet_after_final_ms: NonNegativeMs,
  /** ASR の最後の更新が final でないとき（final が来ないときの上限）。 */
  asr_quiet_without_final_ms: NonNegativeMs,
  /** fallback の割り込みは、ASR の更新がこの長さ以内に来ているときだけ（新しい発話の内容がある）。 */
  interrupt_asr_recent_ms: NonNegativeMs,
  /**
   * AI の再生中に sys の無音がこれ以上続いたら AI の音声の参照が来ていないとみなし、VAP を信用しない。
   * null は検査しない（docs/known_gaps.md §12。実機の sys は揃っているので、試験の素材を直すまでは検査を入れていない）。
   */
  ai_reference_missing_ms: Uncalibrated(NonNegativeMs),
});
export type VapUnavailable = z.infer<typeof VapUnavailable>;

/**
 * AI の発話の結果の分類（観測だけ。判断には使わない）。原著にない。値はどれも暫定で根拠なし（docs/known_gaps.md）。
 * 省略は記録しない。
 */
export const TurnOutcomeSettings = z.strictObject({
  /** 開始の後に同じ発話の続きが来たかを見る窓（/tune の発話の途中での開始と同じ 1500ms）。 */
  continuation_window_ms: NonNegativeMs,
  /** 再生の終わりから、後ろの ASR が届くのを待って分類するまでの長さ。 */
  settle_ms: NonNegativeMs,
  /** 開始の何 ms 前まで人の声があれば「直前まで話していた」とするか。 */
  user_just_before_ms: NonNegativeMs,
  /** 発話の続きの始まりが開始からこの長さ以内なら suspected_premature_start にする。 */
  premature_onset_max_ms: NonNegativeMs,
  /** 重なりとみなす人の声の最短の合計。 */
  overlap_min_ms: NonNegativeMs,
  /** 再生の長さがこれより短く割り込まれたら ai_interrupted_early。 */
  interrupted_early_max_ms: NonNegativeMs,
  /** 人の声と ASR の更新が止まってから、AI が話し始めないまま経過したら no_response_after_user_yield。 */
  no_response_wait_ms: NonNegativeMs,
  /** ASR の文と AI の発話文の類似度がこれ以上なら回り込みの疑い。 */
  echo_text_similarity: Probability,
  /** 再生区間に占める人の声の割合がこれ以上なら回り込みの疑い（類似度の条件と両方）。 */
  echo_overlap_ratio: Probability,
});
export type TurnOutcomeSettings = z.infer<typeof TurnOutcomeSettings>;

export const PolicyJa = z.strictObject({
  $schema: z.string().optional(),
  policy_id: z.literal('ja'),
  immutable: z.literal(false),
  status: z.enum(['template', 'provisional', 'calibrated']),
  note: NonEmptyString,
  vap: VapDirection,
  turn: z.strictObject({
    constants: TurnConstants,
    interpretation: TurnInterpretation,
    /** 計画の【暫定】値。 */
    tick_ms: z.number().min(1),
    stop_boundary_max_ms: NonNegativeMs,
    vap_stale_ms: NonNegativeMs,
    vap_rewarm_ms: NonNegativeMs,
    /** user_speaking の最短継続（hri2025_mapping の U-7）。null は原著どおりなし。 */
    user_speaking_min_ms: Uncalibrated(NonNegativeMs),
    /** VAP の鮮度切れ時の代替（計画 §4.1 の表）。VAP ではない。 */
    fallback_silence_max_ms: Uncalibrated(NonNegativeMs),
    fallback_interrupt_min_words: Uncalibrated(z.number().int().min(1)),
    /**
     * fallback_energy（mic の RMS、dBFS）がこれ以上なら声があるとみなす。VAP ではない。
     * 省略と null は未校正で、fallback_energy による開始と割り込みをしない。
     */
    fallback_energy_silence_dbfs: Uncalibrated(z.number().max(0)).optional(),
    /** 開始の慎重化。省略は原著どおり。 */
    start_guard: StartGuard.optional(),
    /** AI の発話の終わりの扱い。省略は原著どおり。 */
    after_ai_speech: AfterAiSpeech.optional(),
    /** VAP が使えないときの安全側の開始と割り込み。省略は今までどおり。 */
    vap_unavailable: VapUnavailable.optional(),
    /** AI の発話の結果の分類（観測だけ）。省略は記録しない。 */
    outcome: TurnOutcomeSettings.optional(),
  }),
  gaze: z.strictObject({
    /** 原著に数値の閾値はない（計画 §4.2）。 */
    pause_min_ms: Uncalibrated(NonNegativeMs),
    /** p_now と p_future のどちらで判定するか、原著に書かれていない（計画 §4.2）。 */
    signal: z.enum(['p_now', 'p_future']).nullable(),
    p_threshold: Uncalibrated(Probability),
    /**
     * 逸らした後、user へ戻すまでの最短（原著にない、ちらつきの防止。docs/known_gaps.md §7）。
     * 人の発話、割り込み、AI の発話の終わり、VAP の鮮度切れではこれを待たずに戻す。省略と null は保持なし。
     */
    hold_away_min_ms: Uncalibrated(NonNegativeMs).optional(),
    /** user へ戻した後、再び逸らすまでの最短（原著にない）。省略と null は保持なし。 */
    re_avert_min_ms: Uncalibrated(NonNegativeMs).optional(),
  }),
  similarity: z.strictObject({
    method: NonEmptyString,
    /** 手法が原著と違うので 0.8 をそのまま適用しない（計画 §4.1）。 */
    threshold: Uncalibrated(Probability),
  }),
  completion: z.strictObject({
    /** 使う推定器の名前。推定器なしは null（仕様§7-4）。 */
    estimator: NonEmptyString.nullable(),
    /** 推定器ごとの閾値表（計画 §4.4）。 */
    thresholds: z.record(
      z.string(),
      z.strictObject({ prepare_threshold: Uncalibrated(Probability) }),
    ),
  }),
  initiative: z.strictObject({
    /** 鮮度の上限（計画 §4.5）: 入力以降の新規安定テキスト量と経過時間。 */
    max_new_stable_chars_since_input: Uncalibrated(z.number().int().min(0)),
    max_result_age_ms: Uncalibrated(NonNegativeMs),
    min_stability: Uncalibrated(Probability),
    /** stability が取れないモデルの代替: 連続 N revision で不変の接頭部（計画 §4.5）。 */
    stable_prefix_revisions: Uncalibrated(z.number().int().min(1)),
    stable_prefix_min_age_ms: Uncalibrated(NonNegativeMs),
    /** 候補の期限。expiry_policy とは別に、コード側で強制する上限。 */
    candidate_expiry_ms: Uncalibrated(NonNegativeMs),
    /** segment_id の変更でも期限切れにするか（計画 §4.6）。 */
    candidate_expires_on_segment_change: z.boolean().nullable(),
    /** 合図のゲート（計画 §4.6）。 */
    signal_cooldown_ms: Uncalibrated(NonNegativeMs),
    max_active_candidates: z.number().int().min(1),
    max_requests_per_session: Uncalibrated(z.number().int().min(1)),
    trigger: InitiativeTrigger.optional(),
    /** 合図と発話の交渉（E2、E3）。省略は候補を記録するだけ。 */
    negotiation: InitiativeNegotiation.optional(),
    /** 二段判定。省略は既存の1段判定。 */
    staged: InitiativeStaged.optional(),
  }),
  speech: z.strictObject({
    /** is_ready の定義。最初の PCM がこの長さバッファされた状態（計画 §4.3）。 */
    is_ready_buffer_ms: NonNegativeMs,
  }),
});
export type PolicyJa = z.infer<typeof PolicyJa>;

export const Policy = z.discriminatedUnion('policy_id', [PolicyHri2025, PolicyJa]);
export type Policy = z.infer<typeof Policy>;

/** TurnManager が読む部分を、どちらの方策からでも同じ形で取り出す。 */
export function turnConstants(policy: Policy): TurnConstants {
  return policy.policy_id === 'hri2025' ? policy.constants : policy.turn.constants;
}

export function turnInterpretation(policy: Policy): TurnInterpretation {
  return policy.policy_id === 'hri2025' ? policy.interpretation : policy.turn.interpretation;
}

/** 準備の2つの閾値。null は未校正または推定器なしで、黙って別の値へ置き換えない。 */
export interface PrepareThresholds {
  completion_prepare_threshold: number | null;
  similarity_prepare_threshold: number | null;
}

/**
 * 準備の閾値の唯一の読み口。TurnManager は turnConstants() の同名の項目を読まない。
 *  - hri2025: Appendix A の constants（原著の値を再現するため）。
 *  - ja: 使う推定器の completion.thresholds と similarity.threshold。推定器と類似度の手法が原著と違い、
 *    尺度が合わないので、turn.constants の値は使わない（計画 §4.1、§4.4）。
 */
export function prepareThresholds(policy: Policy): PrepareThresholds {
  if (policy.policy_id === 'hri2025') {
    return {
      completion_prepare_threshold: policy.constants.TURNGPT_PREPARE_THRESHOLD,
      similarity_prepare_threshold: policy.constants.SIMILARITY_PREPARE_THRESHOLD,
    };
  }
  const { estimator, thresholds } = policy.completion;
  return {
    completion_prepare_threshold:
      estimator === null ? null : (thresholds[estimator]?.prepare_threshold ?? null),
    similarity_prepare_threshold: policy.similarity.threshold,
  };
}
