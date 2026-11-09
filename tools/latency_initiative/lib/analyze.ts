/**
 * 候補ごとの遅延の区間（発話希望 → 合図の描画）。合図が送られた候補だけを数える。
 * 時間軸は orchestrator の単調時計（docs/time_axes.md）。読めない段は 0 にせず null と理由を返す。
 * 契約が作り変えられている最中の古いログも読むので zod で検証しない（読むものだけ見る）。
 *
 * 本文は根拠の照合に内部で使うだけで、返り値に入れない（実会話を持ち出さない）。
 */
import { firstSttContaining } from '@llm-vap/analysis';

// 読むものだけを型にした、ログの素の 1 行。古いログの項目の違いを許すために緩くしている。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RawEvent = Record<string, any> & { event: string; t_monotonic_ms: number };

/**
 * 話し止みと見なす無音の長さ（暫定値）。この長さ以上 user_speaking=false が続いたら話し止み。
 * 実際の話者の間の分布から決めた値ではない（2026-11 時点で未評価）。
 */
export const SUSTAINED_SILENCE_MS = 700;

/**
 * signal.started が signal.sent より前なら、時間軸の誤差か rAF の時刻の前倒しのはず。
 * 報告された誤差 + この余裕を超えて前なら、時間軸の異常として集計から外す。
 * 余裕はブラウザ内の実測（rAF の時刻が命令の受信より前になる量、-19〜-1ms。docs/overnight_verification.md §4）に合わせた暫定値。
 */
export const RENDER_SUSPECT_MARGIN_MS = 20;

/**
 * ブラウザの再生開始の時刻（speech.started.started_at、写像の値）が、その報告を受信した時刻より後なら物理的にありえない。
 * この余裕を超えていれば、そのセッションのブラウザ時計の写像は信用しない（時計の飛びが残っている。docs/time_axes.md）。
 */
export const RECEIPT_VIOLATION_MARGIN_MS = 50;

/** 16 kHz。audio_frame は 16 kHz のサンプル番号。 */
const FRAMES_PER_MS = 16;
/** 音声の時刻の写像に使う vap.state がこれより遠ければ写さない（フレーム数、2 秒分）。 */
const MAX_ANCHOR_DISTANCE_FRAMES = 32000;

export interface Section {
  value_ms: number | null;
  null_reason: string | null;
}

export interface CandidateLatency {
  session_id: string;
  candidate_id: string;
  cue_id: string | null;
  timing_strategy: 'llm' | 'immediate' | 'none';
  sections: {
    /** 根拠の音声 → ASR の受信（推定。audio_frame_end を vap.state の audio_frame と時刻の対で写す）。 */
    audio_to_asr_est: Section;
    /** 根拠が初めて ASR に現れた受信 → 発話希望の要求の送信。 */
    asr_to_desire_sent: Section;
    desire_llm: Section;
    /** タイミング段の LLM。immediate と 1 段判定はタイミング段を持たない（null、理由つき）。 */
    timing_llm: Section;
    /** 候補の最初のタイミング判定 → 合図を決めた判定（WAIT の後の再判定があったときだけ値を持つ）。 */
    timing_redecision_wait: Section;
    /** 合図を決めた判定（最後のタイミング判定か発話希望の受信）→ signal.sent。ゲートの待ちを含む。 */
    decision_to_signal_sent: Section;
    signal_sent_to_render: Section;
    /** 根拠の音声 → 描画（推定）。 */
    spoken_to_rendered_est: Section;
  };
  render: {
    started_at: number | null;
    visible: boolean | null;
    uncertainty_ms: number | null;
    /** 時間軸の異常の疑い（描画が送信より報告誤差を超えて前）。集計から外す。 */
    suspect: boolean;
  };
  cue_landing: {
    /** 描画の時刻（描画の時刻が使えないときは signal.sent）で人が話していたか。null なら理由。 */
    user_speaking: boolean | null;
    user_speaking_null_reason: string | null;
    reference: 'started_at' | 'signal_sent';
    /** 合図のあと人が話し続けた時間（ms）。話していなければ 0。 */
    continued_ms: number | null;
    continued_null_reason: string | null;
    /** 話し止みの判定の根拠。 */
    ended_by: 'sustained_silence' | 'stt_final_in_dip' | 'not_speaking_at_reference' | null;
    /** 話し止みの前の短い無音（SUSTAINED_SILENCE_MS 未満）の回数。 */
    brief_dips: number;
  };
}

function present(value_ms: number): Section {
  return { value_ms, null_reason: null };
}

function absent(null_reason: string): Section {
  return { value_ms: null, null_reason };
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** vap.state の audio_frame と時刻の対で、音声のフレームを orchestrator の時刻へ写す（推定）。 */
function frameToMs(vap: readonly RawEvent[], frame: number): { t_ms: number } | { reason: string } {
  if (vap.length === 0) return { reason: 'no_vap_state_for_audio_time' };
  let nearest: RawEvent | null = null;
  for (const state of vap) {
    if (nearest === null || Math.abs(state.audio_frame - frame) < Math.abs(nearest.audio_frame - frame)) nearest = state;
  }
  const anchor = nearest as RawEvent;
  if (Math.abs(anchor.audio_frame - frame) > MAX_ANCHOR_DISTANCE_FRAMES) return { reason: 'vap_state_too_far_from_audio_frame' };
  return { t_ms: anchor.t_monotonic_ms + (frame - anchor.audio_frame) / FRAMES_PER_MS };
}

function userSpeakingAt(vap: readonly RawEvent[], t: number): boolean | null {
  let latest: RawEvent | null = null;
  for (const state of vap) {
    if (state.t_monotonic_ms > t) break;
    latest = state;
  }
  return latest === null ? null : latest.user_speaking === true;
}

/**
 * 基準の時刻のあと、人の話し止みを探す。
 * 短い無音は話し止みではない。SUSTAINED_SILENCE_MS 続くか、無音の間に stt.final が届いたら話し止み。
 * ログが先に終わったら不明（0 にしない）。
 */
function continuedAfter(
  vap: readonly RawEvent[],
  sttFinals: readonly number[],
  reference: number,
): { continued_ms: number | null; continued_null_reason: string | null; ended_by: CandidateLatency['cue_landing']['ended_by']; brief_dips: number } {
  const after = vap.filter((s) => s.t_monotonic_ms > reference);
  let silenceStart: number | null = null;
  let briefDips = 0;
  const finalInDip = (from: number, to: number) => sttFinals.some((t) => t >= from && t <= to);
  for (const state of after) {
    const t = state.t_monotonic_ms;
    if (state.user_speaking === false) {
      if (silenceStart === null) silenceStart = t;
      continue;
    }
    if (silenceStart !== null) {
      if (t - silenceStart >= SUSTAINED_SILENCE_MS) {
        return { continued_ms: silenceStart - reference, continued_null_reason: null, ended_by: 'sustained_silence', brief_dips: briefDips };
      }
      if (finalInDip(silenceStart, t)) {
        return { continued_ms: silenceStart - reference, continued_null_reason: null, ended_by: 'stt_final_in_dip', brief_dips: briefDips };
      }
      briefDips += 1;
      silenceStart = null;
    }
  }
  if (silenceStart !== null) {
    const last = (after.at(-1) as RawEvent).t_monotonic_ms;
    if (last - silenceStart >= SUSTAINED_SILENCE_MS) {
      return { continued_ms: silenceStart - reference, continued_null_reason: null, ended_by: 'sustained_silence', brief_dips: briefDips };
    }
    if (finalInDip(silenceStart, last)) {
      return { continued_ms: silenceStart - reference, continued_null_reason: null, ended_by: 'stt_final_in_dip', brief_dips: briefDips };
    }
    return { continued_ms: null, continued_null_reason: 'log_ended_before_sustained_silence', ended_by: null, brief_dips: briefDips };
  }
  return { continued_ms: null, continued_null_reason: 'log_ended_before_sustained_silence', ended_by: null, brief_dips: briefDips };
}

/** 候補を登録した発話希望（NEW か保留からの昇格）。根拠の本文はここからだけ読み、外へ出さない。 */
function originDesire(events: readonly RawEvent[], candidateId: string): RawEvent | null {
  return (
    events.find(
      (e) =>
        e.event === 'initiative.desire' &&
        (e.outcome === 'registered' || e.outcome === 'held_promoted') &&
        e.candidate_id?.value === candidateId,
    ) ?? null
  );
}

function timingReceivedAt(timing: RawEvent): number {
  return timing.timing_strategy === 'llm' ? numberOr(timing.received_at, timing.t_monotonic_ms) : timing.t_monotonic_ms;
}

/** 1 セッションの events を候補ごとの遅延の区間にする。 */
export function analyzeSession(events: readonly RawEvent[]): CandidateLatency[] {
  const sorted = [...events].sort((a, b) => a.t_monotonic_ms - b.t_monotonic_ms);
  const vap = sorted.filter((e) => e.event === 'vap.state');
  const stt = sorted.filter((e) => e.event === 'stt.interim' || e.event === 'stt.final');
  const sttFinals = stt.filter((e) => e.event === 'stt.final').map((e) => e.t_monotonic_ms);
  const started = sorted.filter((e) => e.event === 'signal.started' && e.phase === 'inhale');
  const clockBroken = sorted.some(
    (e) => e.event === 'speech.started' && typeof e.started_at === 'number' && e.started_at - e.t_monotonic_ms > RECEIPT_VIOLATION_MARGIN_MS,
  );
  const seenCandidates = new Set<string>();
  const rows: CandidateLatency[] = [];

  for (const sent of sorted) {
    if (sent.event !== 'signal.sent' || sent.phase !== 'inhale') continue;
    const candidateId: string = sent.candidate_id;
    // 同じ候補の二度目の合図（保留からの再送など）は最初の合図で数える。
    if (seenCandidates.has(candidateId)) continue;
    seenCandidates.add(candidateId);
    const cueId: string | null = sent.parameters?.cue_id ?? null;
    const sentAt: number = sent.sent_at;

    const origin = originDesire(sorted, candidateId);
    const timings = sorted
      .filter((e) => e.event === 'initiative.timing' && e.candidate_id === candidateId)
      .filter((e) => timingReceivedAt(e) <= sentAt);
    const firstTiming = timings[0] ?? null;
    const lastTiming = timings.at(-1) ?? null;
    const strategy: CandidateLatency['timing_strategy'] =
      firstTiming === null ? 'none' : firstTiming.timing_strategy === 'llm' ? 'llm' : 'immediate';

    // 根拠の照合（本文は外へ出さない）。
    let audioToAsr: Section;
    let asrToDesire: Section;
    let audioTimeMs: number | null = null;
    if (origin === null) {
      audioToAsr = absent('no_origin_desire_event');
      asrToDesire = absent('no_origin_desire_event');
    } else {
      const found =
        typeof origin.evidence_span?.value === 'string'
          ? firstSttContaining(stt as never, {
              evidence_span: origin.evidence_span.value,
              evidence_segment_ids: origin.evidence_segment_ids?.value?.value ?? [],
              sent_at: origin.sent_at,
            })
          : null;
      if (found === null) {
        const reason = typeof origin.evidence_span?.value === 'string' ? 'evidence_span_not_found_in_stt' : 'no_evidence_span';
        audioToAsr = absent(reason);
        asrToDesire = absent(reason);
      } else {
        const hit = found as unknown as RawEvent;
        asrToDesire = present(origin.sent_at - hit.t_monotonic_ms);
        const mapped = typeof hit.audio_frame_end === 'number' ? frameToMs(vap, hit.audio_frame_end) : { reason: 'no_audio_frame_end' };
        if ('reason' in mapped) {
          audioToAsr = absent(mapped.reason);
        } else {
          audioTimeMs = mapped.t_ms;
          audioToAsr = present(hit.t_monotonic_ms - mapped.t_ms);
        }
      }
    }

    const desireLlm = origin === null ? absent('no_origin_desire_event') : present(origin.received_at - origin.sent_at);

    let timingLlm: Section;
    if (firstTiming === null) timingLlm = absent('no_timing_event_one_stage_or_missing');
    else if (firstTiming.timing_strategy === 'llm') timingLlm = present(numberOr(firstTiming.latency_ms, timingReceivedAt(firstTiming) - firstTiming.sent_at));
    else timingLlm = absent('timing_strategy_immediate_no_llm');

    const redecisionWait =
      firstTiming === null || lastTiming === null
        ? absent('no_timing_event_one_stage_or_missing')
        : lastTiming === firstTiming
          ? absent('single_timing_decision')
          : present(timingReceivedAt(lastTiming) - timingReceivedAt(firstTiming));

    const decidedAt = lastTiming !== null ? timingReceivedAt(lastTiming) : origin !== null ? (origin.received_at as number) : null;
    const decisionToSent = decidedAt === null ? absent('no_decision_event') : present(sentAt - decidedAt);

    const startedEvent =
      started.find((e) => e.candidate_id === candidateId && e.parameters?.cue_id === cueId && e.visible === true) ??
      started.find((e) => e.candidate_id === candidateId && e.parameters?.cue_id === cueId) ??
      null;
    let render: CandidateLatency['render'] = { started_at: null, visible: null, uncertainty_ms: null, suspect: false };
    let sentToRender: Section;
    let spokenToRendered: Section;
    if (startedEvent === null) {
      sentToRender = absent('signal_started_missing');
      spokenToRendered = absent('signal_started_missing');
    } else if (startedEvent.visible !== true || typeof startedEvent.started_at !== 'number') {
      const reason = `not_visible:${startedEvent.null_reason ?? 'unknown'}`;
      render = { ...render, visible: false };
      sentToRender = absent(reason);
      spokenToRendered = absent(reason);
    } else {
      const uncertainty = numberOr(startedEvent.time_basis?.uncertainty_ms?.value, 0);
      const startedAt: number = startedEvent.started_at;
      const delta = startedAt - sentAt;
      const suspect = clockBroken || delta < -(uncertainty + RENDER_SUSPECT_MARGIN_MS);
      const suspectReason = clockBroken ? 'time_axis_suspect_browser_clock_stepped' : 'time_axis_suspect_started_before_sent';
      render = { started_at: startedAt, visible: true, uncertainty_ms: uncertainty, suspect };
      if (suspect) {
        sentToRender = { value_ms: delta, null_reason: suspectReason };
        spokenToRendered = audioTimeMs === null ? absent('no_audio_time_or_time_axis_suspect') : { value_ms: startedAt - audioTimeMs, null_reason: suspectReason };
      } else {
        sentToRender = present(delta);
        spokenToRendered = audioTimeMs === null ? absent(audioToAsr.null_reason ?? 'no_audio_time') : present(startedAt - audioTimeMs);
      }
    }

    // 描画の時刻が信用できなければ、確かに描画より前である signal.sent を基準にする。
    const reference: 'started_at' | 'signal_sent' = render.started_at !== null && !render.suspect ? 'started_at' : 'signal_sent';
    const referenceMs = reference === 'started_at' ? (render.started_at as number) : sentAt;
    const speaking = userSpeakingAt(vap, referenceMs);
    let cueLanding: CandidateLatency['cue_landing'];
    if (speaking === null) {
      cueLanding = {
        user_speaking: null,
        user_speaking_null_reason: 'no_vap_state_before_reference',
        reference,
        continued_ms: null,
        continued_null_reason: 'no_vap_state_before_reference',
        ended_by: null,
        brief_dips: 0,
      };
    } else if (!speaking) {
      cueLanding = { user_speaking: false, user_speaking_null_reason: null, reference, continued_ms: 0, continued_null_reason: null, ended_by: 'not_speaking_at_reference', brief_dips: 0 };
    } else {
      cueLanding = { user_speaking: true, user_speaking_null_reason: null, reference, ...continuedAfter(vap, sttFinals, referenceMs) };
    }

    rows.push({
      session_id: sent.session_id,
      candidate_id: candidateId,
      cue_id: cueId,
      timing_strategy: strategy,
      sections: {
        audio_to_asr_est: audioToAsr,
        asr_to_desire_sent: asrToDesire,
        desire_llm: desireLlm,
        timing_llm: timingLlm,
        timing_redecision_wait: redecisionWait,
        decision_to_signal_sent: decisionToSent,
        signal_sent_to_render: sentToRender,
        spoken_to_rendered_est: spokenToRendered,
      },
      render,
      cue_landing: cueLanding,
    });
  }
  return rows;
}
