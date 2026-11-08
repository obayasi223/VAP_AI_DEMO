/**
 * AI の発話の結果の分類（観測だけ。判断には使わない。docs/known_gaps.md の節「発話の失敗の記録」）。
 *
 * 記録の入力（VAP、STT、開始の時点の値、再生の区間）から turn.outcome の本体を作る純粋な関数。
 * 配線は session/turn_outcome_wiring.ts（実行中）と dev/turn_outcome_replay.ts（録音の再生）で、どちらも同じ関数を通す。
 * ラベルは観測に基づく推定で、会話の失敗を確定するものではない。閾値は policy の turn.outcome（暫定、根拠なし）。
 */
import { absent, present } from '@llm-vap/contracts';
import type {
  Maybe,
  OutcomeTextKind,
  Policy,
  TurnAllowedPayload,
  TurnOutcomeAiUtterance,
  TurnOutcomeLabel,
  TurnOutcomeNoResponse,
  TurnOutcomeSettings,
} from '@llm-vap/contracts';
import { charNgramCosine, normalizeForSimilarity } from '../cognition/similarity';
import type { ControlSettings } from './settings';
import { fragmentReason } from './turn_manager';
import type { TurnState } from './state';

const FRAMES_PER_MS = 16;
/** 音声位置の比較の余裕（10ms。dev/metrics.ts と同じ）。 */
const FRAME_MARGIN = 160;
/** vap.state の窓（worker の1周期、80ms）。 */
const VAP_WINDOW_FRAMES = 1280;
const VOICE_LOOKBACK_MS = 30_000;

export interface OutcomeVapRow {
  t: number;
  frame: number;
  vad_user: number;
}

export interface OutcomeSttRow {
  t: number;
  /** segment_id * 1e6 + asr_segment_id。 */
  key: number;
  audio_frame_end: number;
  text: string;
}

export interface OutcomeStartInput {
  audio_playback_id: number;
  segment_id: number;
  origin: 'response' | 'candidate';
  candidate_id: Maybe<string>;
  conversation_kind: Maybe<string>;
  decided_at: number;
  audio_frame: number;
  payload: TurnAllowedPayload;
  /** 添字は読まない（添字の順は control/ の外で解決して渡す。separation.test.ts）。 */
  vad: { user: number; ai: number } | null;
  vap_age_ms: number | null;
}

export interface OutcomePlaybackInput {
  started_at: number;
  start_frame: number;
  ended_at: number;
  end_frame: number;
  interrupted: boolean;
  spoken_text: string | null;
}

export interface OutcomeAiEnd {
  at: number;
}

export interface OutcomeSettings extends TurnOutcomeSettings {
  speaking_threshold: number;
  /** null は相槌の判定ができない（hri2025）。 */
  backchannel_phrases: readonly string[] | null;
}

/** hri2025（原著の方策）には turn 節がないので、記録のときだけ同じ暫定値で観測する。 */
const HRI2025_OBSERVATION: TurnOutcomeSettings = {
  continuation_window_ms: 1500,
  settle_ms: 1000,
  user_just_before_ms: 1500,
  premature_onset_max_ms: 800,
  overlap_min_ms: 240,
  interrupted_early_max_ms: 2000,
  no_response_wait_ms: 4000,
  echo_text_similarity: 0.6,
  echo_overlap_ratio: 0.7,
};

export function turnOutcomeSettings(policy: Policy, control: ControlSettings): OutcomeSettings | null {
  const base = policy.policy_id === 'ja' ? (policy.turn.outcome ?? null) : HRI2025_OBSERVATION;
  if (base === null) return null;
  return {
    ...base,
    speaking_threshold: control.direction.speaking_threshold ?? 0.5,
    backchannel_phrases: control.after_ai_speech?.backchannel_phrases ?? null,
  };
}

function textKind(text: string, phrases: readonly string[] | null): OutcomeTextKind {
  if (normalizeForSimilarity(text) === '') return 'none';
  if (phrases === null) return 'content';
  // fragment_max_chars は 0: 短い断片（「で」など）は相槌に数えない（語句の一致だけ）。
  return fragmentReason(text, { rebase_user_end_times: false, fragment_max_chars: 0, backchannel_phrases: phrases as string[] }) === null
    ? 'content'
    : 'backchannel';
}

function chars(text: string): number {
  return [...normalizeForSimilarity(text)].length;
}

export interface Continuation {
  continued: boolean;
  firstResultAfterStartMs: number | null;
  firstAudioOffsetMs: number | null;
  /** 伸びた分の文（正規化後）。 */
  text: string;
}

/**
 * /tune の「発話の途中での開始」（dev/metrics.ts の midUtterance と同じ定義）: 開始 t から window 以内に届いた STT のうち、
 * 音声位置が開始より後で、同じ ASR 区間の文が伸びた（新しい区間なら文がある）ものが1件でもあるか。
 * stt は時刻の順。
 */
export function continuationAfter(stt: readonly OutcomeSttRow[], frame: number, t: number, windowMs: number): Continuation {
  const latest = new Map<number, number>();
  const grownBase = new Map<number, number>();
  const grownText = new Map<number, string>();
  let firstResult: number | null = null;
  let firstOffset: number | null = null;
  for (const r of stt) {
    if (r.t > t + windowMs) break;
    const n = chars(r.text);
    const prior = latest.get(r.key) ?? 0;
    if (r.t > t && r.audio_frame_end > frame + FRAME_MARGIN && n > prior) {
      firstResult ??= r.t - t;
      firstOffset ??= Math.max(0, (r.audio_frame_end - frame) / FRAMES_PER_MS);
      if (!grownBase.has(r.key)) grownBase.set(r.key, prior);
      grownText.set(r.key, [...normalizeForSimilarity(r.text)].slice(grownBase.get(r.key)).join(''));
    }
    latest.set(r.key, n);
  }
  return { continued: firstResult !== null, firstResultAfterStartMs: firstResult, firstAudioOffsetMs: firstOffset, text: [...grownText.values()].join('') };
}

/** frame の範囲（from、to］で音声が来ている vad の和。声の窓の境が分からないので window 単位で数える。 */
interface OverlapMeasure {
  overlap_ms: number;
  first_ms: number | null;
  longest_ms: number;
  hasRows: boolean;
}

function measureOverlap(vap: readonly OutcomeVapRow[], fromFrame: number, toFrame: number, threshold: number): OverlapMeasure {
  let total = 0;
  let longest = 0;
  let run = 0;
  let first: number | null = null;
  let prev = fromFrame;
  let hasRows = false;
  for (const row of vap) {
    if (row.frame <= fromFrame || row.frame > toFrame) {
      if (row.frame > toFrame) break;
      continue;
    }
    hasRows = true;
    const frames = Math.min(row.frame - prev, VAP_WINDOW_FRAMES);
    prev = row.frame;
    if (row.vad_user >= threshold) {
      total += frames;
      run += frames;
      longest = Math.max(longest, run);
      first ??= row.frame - fromFrame;
    } else {
      run = 0;
    }
  }
  return { overlap_ms: total / FRAMES_PER_MS, first_ms: first === null ? null : first / FRAMES_PER_MS, longest_ms: longest / FRAMES_PER_MS, hasRows };
}

function overlapText(stt: readonly OutcomeSttRow[], startT: number, startFrame: number, endFrame: number): string {
  const base = new Map<number, number>();
  const final = new Map<number, string>();
  for (const r of stt) {
    if (r.t <= startT) {
      base.set(r.key, chars(r.text));
      continue;
    }
    if (r.audio_frame_end > endFrame + FRAME_MARGIN || r.audio_frame_end <= startFrame) continue;
    final.set(r.key, normalizeForSimilarity(r.text));
  }
  let out = '';
  for (const [key, text] of final) {
    const grown = [...text].slice(base.get(key) ?? 0).join('');
    out += grown;
  }
  return out;
}

export interface OutcomeBuildInput {
  start: OutcomeStartInput;
  /** null は音声が流れなかった（理由は null_reason）。 */
  playback: OutcomePlaybackInput | null;
  /** 分類しない理由（playback が null のとき必須、それ以外でも playback.ended の異常などで付ける）。 */
  null_reason: string | null;
  vap: readonly OutcomeVapRow[];
  stt: readonly OutcomeSttRow[];
  previous_ai_end: OutcomeAiEnd | null;
}

export function buildTurnOutcome(input: OutcomeBuildInput, settings: OutcomeSettings): TurnOutcomeAiUtterance {
  const { start, playback, vap, stt, previous_ai_end: prev } = input;
  const t = start.decided_at;
  const thr = settings.speaking_threshold;

  let lastVoice: number | null = null;
  let voiceSincePrevious = false;
  for (const row of vap) {
    if (row.t > t) break;
    if (row.vad_user >= thr) {
      lastVoice = row.t;
      if (prev !== null && row.t > prev.at) voiceSincePrevious = true;
    }
  }
  const voiceGap = lastVoice !== null && t - lastVoice <= VOICE_LOOKBACK_MS ? t - lastVoice : null;
  const justBefore = voiceGap !== null && voiceGap <= settings.user_just_before_ms;

  const continuation = continuationAfter(stt, start.audio_frame, t, settings.continuation_window_ms);
  const contKind = textKind(continuation.text, settings.backchannel_phrases);

  const measure = playback ? measureOverlap(vap, playback.start_frame, playback.end_frame, thr) : null;
  const spanFrames = playback ? playback.end_frame - playback.start_frame : 0;
  const durationMs = playback ? playback.ended_at - playback.started_at : null;
  const overlapMs = measure !== null && measure.hasRows ? measure.overlap_ms : null;
  const overlapRatio = overlapMs !== null && spanFrames > 0 ? Math.min(1, overlapMs / (spanFrames / FRAMES_PER_MS)) : null;
  const overlapBody = playback ? overlapText(stt, t, start.audio_frame, playback.end_frame) : '';
  const overlapKind = textKind(overlapBody, settings.backchannel_phrases);

  const spoken = playback?.spoken_text ?? null;
  const similarity = spoken !== null && spoken !== '' && overlapBody !== '' ? charNgramCosine(overlapBody, spoken) : null;
  const echoSuspected = similarity !== null && similarity >= settings.echo_text_similarity && overlapRatio !== null && overlapRatio >= settings.echo_overlap_ratio;

  const onsets = [continuation.firstAudioOffsetMs, measure?.first_ms ?? null].filter((v): v is number => v !== null);
  const firstOnset = onsets.length === 0 ? null : Math.min(...onsets);

  const noSpeech = 'speech_not_played';
  const overlapNull = playback === null ? noSpeech : 'no_vap_during_speech';
  const observed: TurnOutcomeAiUtterance['observed'] = {
    user_voice_gap_before_ms: voiceGap === null ? absent('no_user_voice_within_30s') : present(Math.round(voiceGap)),
    user_voiced_just_before: justBefore,
    previous_ai_end_gap_ms: prev === null ? absent('first_ai_utterance') : present(Math.round(t - prev.at)),
    user_voice_since_previous_ai: prev === null ? absent('first_ai_utterance') : present(voiceSincePrevious),
    continuation: {
      continued: continuation.continued,
      first_result_after_start_ms:
        continuation.firstResultAfterStartMs === null ? absent('no_continuation') : present(Math.round(continuation.firstResultAfterStartMs)),
      first_audio_offset_ms: continuation.firstAudioOffsetMs === null ? absent('no_continuation') : present(Math.round(continuation.firstAudioOffsetMs)),
      chars: [...continuation.text].length,
      text_kind: contKind,
    },
    overlap: {
      overlap_ms: overlapMs === null ? absent(overlapNull) : present(Math.round(overlapMs)),
      first_after_start_ms: overlapMs === null ? absent(overlapNull) : measure?.first_ms === null || measure === null ? absent('no_overlap') : present(Math.round(measure.first_ms)),
      longest_run_ms: overlapMs === null ? absent(overlapNull) : present(Math.round(measure?.longest_ms ?? 0)),
      chars: [...overlapBody].length,
      text_kind: overlapKind,
    },
    echo: {
      suspected: echoSuspected,
      text_similarity: similarity === null ? absent(playback === null ? noSpeech : spoken === null || spoken === '' ? 'no_spoken_text' : 'no_user_text_during_speech') : present(Math.round(similarity * 1000) / 1000),
      overlap_ratio: overlapRatio === null ? absent(overlapNull) : present(Math.round(overlapRatio * 1000) / 1000),
    },
  };

  return {
    event: 'turn.outcome',
    kind: 'ai_utterance',
    audio_playback_id: start.audio_playback_id,
    segment_id: start.segment_id,
    origin: start.origin,
    candidate_id: start.candidate_id,
    conversation_kind: start.conversation_kind,
    start: {
      decided_at: t,
      audio_frame: start.audio_frame,
      decision_source: start.payload.decision_source,
      reason: start.payload.reason,
      policy_id: start.payload.policy_id,
      p_now: start.payload.p_now,
      p_future: start.payload.p_future,
      vad_user: start.vad === null ? absent('no_vap_state') : present(start.vad.user),
      vad_ai: start.vad === null ? absent('no_vap_state') : present(start.vad.ai),
      vap_freshness: start.payload.vap_freshness,
      vap_age_ms: start.vap_age_ms === null ? absent('no_vap_state') : present(Math.max(0, start.vap_age_ms)),
      completion_p: start.payload.completion_p,
      completion_revision: start.payload.completion_revision,
      gap_ms: start.payload.gap_ms,
      user_speaking: start.payload.user_speaking,
    },
    speech_started_at: playback ? present(playback.started_at) : absent(input.null_reason ?? noSpeech),
    speech_ended_at: playback ? present(playback.ended_at) : absent(input.null_reason ?? noSpeech),
    played_ms: playback && durationMs !== null ? present(Math.round(durationMs)) : absent(input.null_reason ?? noSpeech),
    interrupted: playback?.interrupted ?? false,
    observed,
    labels: classify(observed, playback, settings, firstOnset, input.null_reason, durationMs),
  };
}

function classify(
  observed: TurnOutcomeAiUtterance['observed'],
  playback: OutcomePlaybackInput | null,
  settings: OutcomeSettings,
  firstOnset: number | null,
  nullReason: string | null,
  durationMs: number | null,
): TurnOutcomeAiUtterance['labels'] {
  if (observed.echo.suspected) return absent('echo_suspected');
  if (nullReason !== null) return absent(nullReason);
  if (playback === null) return absent('speech_not_played');
  const labels: TurnOutcomeLabel[] = [];
  const cont = observed.continuation;
  if (cont.continued && cont.text_kind === 'content') {
    labels.push('user_continued_after_start');
    if (observed.user_voiced_just_before && firstOnset !== null && firstOnset <= settings.premature_onset_max_ms) labels.push('suspected_premature_start');
  }
  const ov = observed.overlap;
  const overlapMs = ov.overlap_ms.value;
  if (overlapMs !== null && overlapMs >= settings.overlap_min_ms) {
    if (ov.text_kind === 'backchannel') labels.push('backchannel_overlap');
    else if (ov.text_kind === 'none') labels.push('overlap_without_asr');
    else labels.push('user_overlap');
  } else if (ov.text_kind === 'backchannel') {
    labels.push('backchannel_overlap');
  } else if (overlapMs === null && ov.text_kind === 'content') {
    labels.push('user_overlap');
  }
  if (playback.interrupted && durationMs !== null && durationMs < settings.interrupted_early_max_ms) labels.push('ai_interrupted_early');
  if (observed.user_voice_since_previous_ai.value === false) labels.push('spoke_twice');
  return present(labels);
}

/** 話すべき間に話さなかった、の入力（TurnState の読み取りと、呼ぶ側の時刻）。 */
export interface NoResponseInput {
  now: number;
  state: Pick<
    TurnState,
    'speaking' | 'user_speaking' | 'asr_result' | 'asr_revision' | 'asr_is_final' | 'last_asr_time' | 'ignored_fragment' | 'segment_id' | 'permitted_to_speak' | 'vap_freshness'
  >;
  /** 許可の材料（直近の turn.allowed）。p_now などの参照用。 */
  latest_allowed: TurnAllowedPayload | null;
  last_user_voice_at: number | null;
  last_ai_end_at: number | null;
  start_blocked_reason: string | null;
  /** 既に記録した (segment_id, asr_revision)。 */
  fired_key: string | null;
}

export function noResponseOutcome(input: NoResponseInput, settings: OutcomeSettings): { body: TurnOutcomeNoResponse; key: string } | null {
  const { now, state: s, latest_allowed: allowed, last_user_voice_at: voice, last_ai_end_at: aiEnd } = input;
  if (s.speaking.phase !== 'silent' || s.user_speaking || s.asr_result === null) return null;
  if (input.start_blocked_reason !== null) return null;
  const fragment = s.ignored_fragment;
  if (fragment !== null && fragment.segment_id === s.segment_id) return null;
  if (voice === null || (aiEnd !== null && voice <= aiEnd)) return null;
  const key = `${s.segment_id}:${s.asr_revision}`;
  if (key === input.fired_key) return null;
  const lastAsr = s.last_asr_time;
  const quietFrom = lastAsr === null ? voice : Math.max(voice, lastAsr);
  const waited = now - quietFrom;
  if (waited < settings.no_response_wait_ms) return null;
  return {
    key,
    body: {
      event: 'turn.outcome',
      kind: 'no_response',
      labels: present(['no_response_after_user_yield']),
      segment_id: s.segment_id,
      transcript_revision: s.asr_revision === null ? absent('no_transcript_yet') : present(s.asr_revision),
      waited_ms: Math.round(waited),
      last_user_voice_at: present(voice),
      asr_chars: [...normalizeForSimilarity(s.asr_result)].length,
      asr_is_final: s.asr_is_final,
      wait_state: s.permitted_to_speak ? 'permitted_but_not_ready' : 'not_permitted',
      vap_freshness: s.vap_freshness,
      p_now: allowed?.p_now ?? absent('no_turn_allowed_yet'),
      p_future: allowed?.p_future ?? absent('no_turn_allowed_yet'),
      completion_p: allowed?.completion_p ?? absent('no_turn_allowed_yet'),
      decision_source: allowed === null ? absent('no_turn_allowed_yet') : present(allowed.decision_source),
    },
  };
}
