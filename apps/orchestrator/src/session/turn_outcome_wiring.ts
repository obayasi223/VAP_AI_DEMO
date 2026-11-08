/**
 * AI の発話の結果（turn.outcome）の配線。観測だけで、開始の判断には関わらない（docs/known_gaps.md の節「発話の失敗の記録」）。
 *
 * セッションから VAP と STT の値と、開始と再生の区切りを受けて貯め、再生の終わりから settle_ms 経ったら control/turn_outcome.ts の
 * buildTurnOutcome で分類して1件のイベントにする。話すべき間に話さなかった場合も tick ごとに見る。
 * 再生の中止で確定しないときは、理由を null_reason に残して分類しない。
 */
import { absent, present } from '@llm-vap/contracts';
import type { EventDraft, EventEmitter, Maybe, TurnAllowedPayload, TurnDecision, TurnInputs } from '@llm-vap/contracts';
import { buildTurnOutcome, noResponseOutcome } from '../control/turn_outcome';
import type { OutcomePlaybackInput, OutcomeSettings, OutcomeSttRow, OutcomeVapRow, OutcomeAiEnd, OutcomeStartInput } from '../control/turn_outcome';
import type { TurnState } from '../control';
import type { SpeechFinished, SpeechStateChange } from '../speech/speech_generator';

export interface TurnOutcomeWiringOptions {
  settings: OutcomeSettings;
  emitter: EventEmitter;
  conversation_kind: Maybe<string>;
}

/** 実行中の入力を貯める長さ。VAP（80ms 周期）と STT の行なので小さい。 */
const RETAIN_MS = 45_000;

interface Pending {
  start: OutcomeStartInput;
  previous_ai_end: OutcomeAiEnd | null;
  started: { at: number; frame: number } | null;
  ended: { at: number; frame: number; interrupted: boolean; spoken_text: string | null } | null;
  null_reason: string | null;
  settle_at: number | null;
}

export class TurnOutcomeWiring {
  private readonly settings: OutcomeSettings;
  private readonly emitter: EventEmitter;
  private readonly conversationKind: Maybe<string>;
  private readonly vap: OutcomeVapRow[] = [];
  private readonly stt: OutcomeSttRow[] = [];
  private readonly pending = new Map<number, Pending>();
  private lastAiEnd: OutcomeAiEnd | null = null;
  private lastUserVoiceAt: number | null = null;
  private latestAllowed: TurnAllowedPayload | null = null;
  private latestVad: readonly [number, number] | null = null;
  private latestVapAt: number | null = null;
  private firedNoResponse: string | null = null;

  constructor(options: TurnOutcomeWiringOptions) {
    this.settings = options.settings;
    this.emitter = options.emitter;
    this.conversationKind = options.conversation_kind;
  }

  /** speech.started／ended／interrupted の下書きから再生の区間を読む（session の emitter をそのまま通す）。 */
  tee(base: EventEmitter): EventEmitter {
    return {
      emit: (draft, options) => {
        const event = base.emit(draft, options);
        this.observe(draft);
        return event;
      },
    };
  }

  private observe(draft: EventDraft): void {
    switch (draft.event) {
      case 'speech.started': {
        const pending = this.pending.get(draft.audio_playback_id);
        if (pending) pending.started = { at: draft.started_at, frame: draft.audio_frame };
        return;
      }
      case 'speech.ended':
      case 'speech.interrupted': {
        const pending = this.pending.get(draft.audio_playback_id);
        if (!pending) return;
        const at = draft.event === 'speech.ended' ? draft.ended_at : draft.interrupted_at;
        pending.ended = { at, frame: draft.audio_frame, interrupted: draft.event === 'speech.interrupted', spoken_text: draft.spoken_text };
        pending.settle_at = at + this.settings.settle_ms;
        this.lastAiEnd = { at };
        return;
      }
      default:
        return;
    }
  }

  onVap(t: number, frame: number, vad: readonly [number, number]): void {
    this.vap.push({ t, frame, vad_user: vad[0] });
    this.latestVad = vad;
    this.latestVapAt = t;
    if (vad[0] >= this.settings.speaking_threshold) this.lastUserVoiceAt = t;
  }

  onStt(result: { received_at: number; segment_id: number; asr_segment_id: number; audio_frame_end: number; text: string }): void {
    this.stt.push({ t: result.received_at, key: result.segment_id * 1_000_000 + result.asr_segment_id, audio_frame_end: result.audio_frame_end, text: result.text });
  }

  /** SpeechGenerator の状態の変化。失敗と、ブラウザの代行や異常での終わりは結果が確定しない。 */
  onSpeechState(change: SpeechStateChange): void {
    const pending = this.pending.get(change.audio_playback_id);
    if (!pending) return;
    if (change.state === 'failed') {
      pending.null_reason ??= `speech_failed:${(change.reason ?? 'unknown').slice(0, 80)}`;
      if (pending.started === null) pending.settle_at = 0;
    } else if (change.state === 'finished' && change.reason === 'error') {
      pending.null_reason ??= 'playback_ended_abnormally';
    }
  }

  onFinished(finished: Pick<SpeechFinished, 'audio_playback_id' | 'no_audio'>, now: number): void {
    const pending = this.pending.get(finished.audio_playback_id);
    if (!pending || !finished.no_audio) return;
    pending.null_reason ??= 'no_audio_played';
    pending.settle_at = now;
  }

  /** tick の最後に、確定した1組の決定を渡す（開始の取消の後）。 */
  afterStep(input: {
    now: number;
    decisions: readonly TurnDecision[];
    state: TurnState;
    inputs: TurnInputs;
    candidate_id: string | null;
  }): void {
    const { now, decisions, state, inputs } = input;
    const allowed = decisions.find((d) => d.kind === 'turn_allowed');
    if (allowed?.kind === 'turn_allowed') this.latestAllowed = allowed.payload;
    const start = decisions.find((d) => d.kind === 'start_speech');
    if (start?.kind === 'start_speech' && allowed?.kind === 'turn_allowed') {
      const advance = decisions.find((d) => d.kind === 'advance_segment');
      this.pending.set(start.audio_playback_id, {
        start: {
          audio_playback_id: start.audio_playback_id,
          segment_id: advance?.kind === 'advance_segment' ? advance.new_segment_id : state.segment_id,
          origin: input.candidate_id === null ? 'response' : 'candidate',
          candidate_id: input.candidate_id === null ? absent('normal_response') : present(input.candidate_id),
          conversation_kind: this.conversationKind,
          decided_at: now,
          audio_frame: inputs.received_audio_frame,
          payload: allowed.payload,
          vad: this.latestVad === null ? null : { user: this.latestVad[0], ai: this.latestVad[1] },
          vap_age_ms: this.latestVapAt === null ? null : now - this.latestVapAt,
        },
        previous_ai_end: this.lastAiEnd,
        started: null,
        ended: null,
        null_reason: null,
        settle_at: null,
      });
    }
    for (const [id, pending] of this.pending) {
      if (pending.settle_at !== null && now >= pending.settle_at) {
        this.settle(id, pending, pending.null_reason);
        this.prune(now);
      }
    }
    const missing = noResponseOutcome(
      {
        now,
        state,
        latest_allowed: this.latestAllowed,
        last_user_voice_at: this.lastUserVoiceAt,
        last_ai_end_at: this.lastAiEnd?.at ?? null,
        start_blocked_reason: inputs.start_blocked_reason ?? null,
        fired_key: this.firedNoResponse,
      },
      this.settings,
    );
    if (missing !== null) {
      this.firedNoResponse = missing.key;
      this.emitter.emit(missing.body as EventDraft);
    }
  }

  private settle(id: number, pending: Pending, nullReason: string | null): void {
    this.pending.delete(id);
    const playback: OutcomePlaybackInput | null =
      pending.started !== null && pending.ended !== null
        ? {
            started_at: pending.started.at,
            start_frame: pending.started.frame,
            ended_at: pending.ended.at,
            end_frame: pending.ended.frame,
            interrupted: pending.ended.interrupted,
            spoken_text: pending.ended.spoken_text,
          }
        : null;
    const body = buildTurnOutcome(
      {
        start: pending.start,
        playback,
        null_reason: nullReason ?? (playback === null ? 'speech_not_played' : null),
        vap: this.vap,
        stt: this.stt,
        previous_ai_end: pending.previous_ai_end,
      },
      this.settings,
    );
    this.emitter.emit(body as EventDraft);
  }

  private prune(now: number): void {
    let keep = now - RETAIN_MS;
    for (const pending of this.pending.values()) keep = Math.min(keep, pending.start.decided_at - 31_000);
    const drop = <T extends { t: number }>(list: T[]) => {
      let n = 0;
      while (n < list.length && (list[n] as T).t < keep) n += 1;
      if (n > 0) list.splice(0, n);
    };
    drop(this.vap);
    drop(this.stt);
  }

  /** セッションを閉じる。確定していない発話は理由を残して記録する。 */
  close(): void {
    for (const [id, pending] of [...this.pending]) {
      this.settle(id, pending, pending.null_reason ?? (pending.ended === null ? 'session_closed_during_speech' : 'session_closed_before_settle'));
    }
  }
}

