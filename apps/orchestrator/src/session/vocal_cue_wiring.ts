/**
 * 吸気の後の短い声の配線（docs/initiative_v3_design.md §10）。vocal_cue が none なら作らない（無音の吸気の動作は 1 行も変わらない）。
 *
 * 語の音声は事前に合成しておく（候補の TTS の先読みと同じ考え）。候補がある間は 1 本用意し、使ったら作り直す。空きの文脈がないときは待つので、
 * 通常応答と候補の準備を押しのけない。音声は通常の AI 発話と同じ再生の経路（SpeechGenerator）を通るが、発話の許可は使わない（TurnManager の
 * segment も進めず、人の発話の文は消えない）。履歴には入れない（LLM の文脈を汚さない）。
 *
 * 記録: initiative.vocal_cue を声ごとに 1 件。切れ目の値と、音声の時刻と、その後の窓の間の観測。人が譲ったとは確定しない。
 */
import { absent, present } from '@llm-vap/contracts';
import type { CandidateState, EventDraft, EventEmitter } from '@llm-vap/contracts';
import { judgeVocalCue } from '../control/vocal_cue';
import type { VocalCueSettings } from '../control/vocal_cue';
import type { TurnState } from '../control';
import type { SpeechFinished, SpeechGeneratorImpl, SpeechStateChange } from '../speech';
import type { NegotiationWiring } from './negotiation_wiring';
import type { InitiativeWiring } from './initiative_wiring';

type SpeechPort = Pick<SpeechGeneratorImpl, 'prepare' | 'stateOf' | 'startChecked' | 'hasFreeContext'>;

export interface VocalCueWiringOptions {
  settings: VocalCueSettings;
  negotiation: Pick<NegotiationWiring, 'candidateViews' | 'negotiatorState'>;
  initiative: Pick<InitiativeWiring, 'ledger'>;
  emitter: EventEmitter;
  speech: () => SpeechPort | null;
}

export interface VocalCueTick {
  now: number;
  /** この tick の決定を実行した後の TurnManager の状態。 */
  state: TurnState;
  link_attached: boolean;
  /** 再生中か停止中の音声の ID（なければ null）。 */
  active_playback: number | null;
  vad_user: number | null;
  p_now_ai: number | null;
  p_future_ai: number | null;
}

export interface StartedVocalCue {
  audio_playback_id: number;
  candidate_id: string;
  phrase: string;
  user_silence_ms: number;
}

interface Observation {
  from: number;
  speaking_at_audio_end: boolean;
  ticks: number;
  user_speaking_ticks: number;
  resume_at: number | null;
  states: CandidateState[];
  candidate_spoke: boolean;
}

interface Active {
  candidate_id: string;
  candidate_version: number;
  cue_id: string;
  phrase: string;
  audio_playback_id: number;
  decided_at: number;
  gap: Extract<EventDraft, { event: 'initiative.vocal_cue' }>['gap'];
  audio_started_at: number | null;
  audio_ended_at: number | null;
  interrupted: boolean;
  spoken_text: string;
  speaking_during_audio: boolean;
  obs: Observation | null;
}

/** 語の合成の失敗の連続の上限（TTS が落ちているときに作り続けない）。 */
const MAX_PREPARE_FAILURES = 3;

export class VocalCueWiring {
  readonly settings: VocalCueSettings;
  private prepared: number | null = null;
  private prepareFailures = 0;
  private readonly voiced = new Set<string>();
  private active: Active | null = null;
  private lastUserSpeaking = false;

  constructor(private readonly options: VocalCueWiringOptions) {
    this.settings = options.settings;
  }

  /** speech.* の下書きから音声の時刻を読む（session の emitter に重ねる）。 */
  tee(base: EventEmitter): EventEmitter {
    return {
      emit: (draft, options) => {
        const event = base.emit(draft, options);
        this.observeSpeech(draft);
        return event;
      },
    };
  }

  private observeSpeech(draft: EventDraft): void {
    const active = this.active;
    if (active === null) return;
    if (draft.event === 'speech.started' && draft.audio_playback_id === active.audio_playback_id) {
      active.audio_started_at = draft.started_at;
    } else if ((draft.event === 'speech.ended' || draft.event === 'speech.interrupted') && draft.audio_playback_id === active.audio_playback_id) {
      active.audio_ended_at = draft.event === 'speech.ended' ? draft.ended_at : draft.interrupted_at;
      active.interrupted = draft.event === 'speech.interrupted';
      active.spoken_text = draft.spoken_text;
    }
  }

  /** D の状態の通知。語の準備が落ちたら作り直す。再生の前に失敗した声は「音が出なかった」として閉じる。 */
  onSpeechState(change: SpeechStateChange, now: number): void {
    if (change.request.origin.kind !== 'vocal_cue') return;
    if (change.audio_playback_id === this.prepared && (change.state === 'cancelled' || change.state === 'failed')) {
      this.prepared = null;
      if (change.state === 'failed') this.prepareFailures += 1;
    }
    const active = this.active;
    if (active !== null && change.audio_playback_id === active.audio_playback_id && change.state === 'failed' && active.audio_started_at === null) {
      this.close(active, now, 'not_played');
    }
  }

  /** 語の再生が終わった。ここから窓の間の観測を始める。音が出なかったらこの場で閉じる。 */
  onFinished(finished: SpeechFinished, now: number): void {
    const active = this.active;
    if (active === null || finished.audio_playback_id !== active.audio_playback_id) return;
    if (finished.no_audio) {
      this.close(active, now, 'not_played');
      return;
    }
    active.obs = {
      from: now,
      speaking_at_audio_end: this.lastUserSpeaking,
      ticks: 0,
      user_speaking_ticks: 0,
      resume_at: null,
      states: [],
      candidate_spoke: false,
    };
  }

  /** tick の最後（TurnManager の決定を実行した後）。声を始めたらその内容を返す。 */
  tick(input: VocalCueTick): StartedVocalCue | null {
    this.lastUserSpeaking = input.state.user_speaking;
    this.prepare(input.state.segment_id);
    this.observe(input);
    return this.fire(input);
  }

  /** セッションの終わりで、観測中の声を閉じる。 */
  close_session(now: number): void {
    if (this.active !== null) this.close(this.active, now, 'session_ended');
  }

  private prepare(segment_id: number): void {
    if (this.prepared !== null || this.prepareFailures >= MAX_PREPARE_FAILURES) return;
    const speech = this.options.speech();
    if (speech === null || !speech.hasFreeContext()) return;
    if (this.options.initiative.ledger.list().length === 0) return;
    const { audio_playback_id } = speech.prepare({
      segment_id,
      transcript_revision: 0,
      text: this.settings.phrase,
      origin: { kind: 'vocal_cue', vocal_cue_kind: this.settings.kind },
    });
    this.prepared = audio_playback_id;
  }

  private observe(input: VocalCueTick): void {
    const active = this.active;
    if (active === null) return;
    const obs = active.obs;
    if (obs === null) {
      if (input.state.user_speaking) active.speaking_during_audio = true;
      return;
    }
    const speaking = input.state.user_speaking;
    obs.ticks += 1;
    if (speaking) obs.user_speaking_ticks += 1;
    if (!obs.speaking_at_audio_end && speaking && obs.resume_at === null) obs.resume_at = input.now;
    const record = this.options.initiative.ledger.get(active.candidate_id);
    const state = record?.state ?? null;
    if (state !== null && obs.states.at(-1) !== state) obs.states.push(state);
    if (state === 'SPEAKING') obs.candidate_spoke = true;
    // 別の AI の発話（候補か通常応答）が始まったら閉じる。
    if (input.active_playback !== null && input.active_playback !== active.audio_playback_id) this.close(active, input.now, 'ai_speech_started');
    else if (state === null || state === 'WITHDRAWN' || state === 'SPOKEN') this.close(active, input.now, 'candidate_resolved');
    else if (input.now - obs.from >= this.settings.observation_window_ms) this.close(active, input.now, 'window');
  }

  private fire(input: VocalCueTick): StartedVocalCue | null {
    if (this.active !== null) return null;
    const speech = this.options.speech();
    if (speech === null) return null;
    const candidate = this.options.negotiation.candidateViews().find((c) => c.state === 'DEFERRED');
    if (candidate === undefined) return null;
    const { state, now } = input;
    const user_silence_ms = Math.max(0, now - (state.user_speak_end_time ?? now));
    const asr_quiet_ms = Math.max(0, now - (state.last_asr_time ?? now));
    const prepared = this.prepared;
    const decision = judgeVocalCue(this.settings, {
      candidate,
      already_voiced: this.voiced.has(candidate.candidate_id),
      ai_speaking: state.speaking.phase !== 'silent' || input.active_playback !== null,
      permitted: state.permitted_to_speak,
      user_speaking: state.user_speaking,
      link_attached: input.link_attached,
      vap_fresh: state.vap_freshness === 'fresh',
      user_silence_ms,
      asr_quiet_ms,
      vad_user: input.vad_user,
      invitation: state.invitation,
      user_text: state.asr_result,
      phrase_ready: prepared !== null && speech.stateOf(prepared) === 'ready',
    });
    if (!decision.fire || prepared === null) return null;
    const deferred = this.options.negotiation.negotiatorState().deferred.find((d) => d.candidate_id === candidate.candidate_id);
    if (deferred === undefined) return null;
    const started = speech.startChecked(prepared);
    this.prepared = null;
    if (!started.ok) return null;
    this.voiced.add(candidate.candidate_id);
    const { min_user_silence_ms, min_asr_quiet_ms, max_vad_user } = this.settings;
    const vap = (value: number | null) => (value === null ? absent('vap_not_fresh') : present(value));
    this.active = {
      candidate_id: candidate.candidate_id,
      candidate_version: candidate.candidate_version,
      cue_id: deferred.cue_id,
      phrase: this.settings.phrase,
      audio_playback_id: prepared,
      decided_at: now,
      gap: {
        user_silence_ms,
        asr_quiet_ms,
        vad_user: vap(input.vad_user),
        p_now_ai: vap(input.p_now_ai),
        p_future_ai: vap(input.p_future_ai),
        min_user_silence_ms,
        min_asr_quiet_ms,
        max_vad_user,
      },
      audio_started_at: null,
      audio_ended_at: null,
      interrupted: false,
      spoken_text: '',
      speaking_during_audio: state.user_speaking,
      obs: null,
    };
    return { audio_playback_id: prepared, candidate_id: candidate.candidate_id, phrase: this.settings.phrase, user_silence_ms };
  }

  private close(active: Active, now: number, ended_by: 'window' | 'ai_speech_started' | 'candidate_resolved' | 'session_ended' | 'not_played'): void {
    if (this.active !== active) return;
    this.active = null;
    const played = active.audio_started_at !== null;
    const obs = active.obs;
    const window_ms = this.settings.observation_window_ms;
    const speakingAtEnd = obs?.speaking_at_audio_end ?? false;
    this.options.emitter.emit({
      event: 'initiative.vocal_cue',
      vocal_cue_kind: this.settings.kind,
      phrase: active.phrase,
      candidate_id: active.candidate_id,
      candidate_version: active.candidate_version,
      cue_id: active.cue_id,
      audio_playback_id: active.audio_playback_id,
      decided_at: active.decided_at,
      gap: active.gap,
      audio_started_at: played ? present(active.audio_started_at as number) : absent('not_played'),
      audio_ended_at: active.audio_ended_at === null ? absent(played ? 'not_ended' : 'not_played') : present(active.audio_ended_at),
      audio_outcome: !played ? 'not_played' : active.interrupted ? 'interrupted' : 'played',
      spoken_text: active.spoken_text,
      observation: {
        window_ms,
        observed_ms: obs === null ? 0 : Math.max(0, now - obs.from),
        ended_by,
        ticks: obs?.ticks ?? 0,
        user_speaking_ticks: obs?.user_speaking_ticks ?? 0,
        user_speaking_during_audio: active.speaking_during_audio,
        user_speaking_at_audio_end: speakingAtEnd,
        time_to_user_resume_ms: speakingAtEnd
          ? absent('user_speaking_at_audio_end')
          : obs?.resume_at != null
            ? present(Math.max(0, obs.resume_at - obs.from))
            : absent(obs === null ? 'not_observed' : 'user_did_not_resume_in_window'),
        candidate_speech_started: obs?.candidate_spoke ?? false,
        candidate_states: obs?.states ?? [],
      },
    });
  }
}
