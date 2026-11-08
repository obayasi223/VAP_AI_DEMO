import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TurnInputs, TurnStepOutput, PolicyHri2025, PolicyJa, absent, present } from '@llm-vap/contracts';
import type { Policy, TranscriptSnapshot, TurnDecision, Vap2chState } from '@llm-vap/contracts';
import { createTurnManager } from '../../src/control';
import type { ControlOptions, TurnState } from '../../src/control';

export const repoRoot = join(import.meta.dirname, '..', '..', '..', '..');
const readPolicy = (name: string): unknown => JSON.parse(readFileSync(join(repoRoot, 'config', name), 'utf8'));

export const hri2025 = (): PolicyHri2025 => PolicyHri2025.parse(readPolicy('policy.hri2025.json'));
export const ja = (patch: (policy: PolicyJa) => void = () => undefined): PolicyJa => {
  const policy = PolicyJa.parse(readPolicy('policy.ja.json'));
  patch(policy);
  return PolicyJa.parse(policy);
};
/**
 * Appendix A の分岐を見る試験用の ja。原著にない開始の慎重化（turn.start_guard）と AI の発話の終わりの扱い
 * （turn.after_ai_speech）を外す。その2つは start_guard.test.ts と after_ai_speech.test.ts で config の値のまま見る。
 */
export const jaAppendixA = (patch: (policy: PolicyJa) => void = () => undefined): PolicyJa =>
  ja((p) => {
    delete p.turn.start_guard;
    delete p.turn.after_ai_speech;
    patch(p);
  });
/** 試験用の視線の設定。config の値は null のまま。 */
export const jaWithGaze = (signal: 'p_now' | 'p_future' = 'p_now'): PolicyJa =>
  ja((p) => {
    p.gaze = { pause_min_ms: 200, signal, p_threshold: 0.5 };
  });

/** 保持時間つきの視線の設定（原著にない追加。docs/known_gaps.md §7）。 */
export const jaWithGazeHold = (hold_away_min_ms = 600, re_avert_min_ms = 1000): PolicyJa =>
  ja((p) => {
    p.gaze = { pause_min_ms: 200, signal: 'p_now', p_threshold: 0.5, hold_away_min_ms, re_avert_min_ms };
  });

export const T0 = 100_000;

/** pAi は AI 側の値。向きの変換は実物（readVap）を通すので、ここは生の配列で作る（ch1=mic, ch2=sys）。 */
export function vapAt(pNowAi: number, pFutAi: number, userSpeaking: boolean, audio_frame = 0): Vap2chState {
  return {
    t: 0,
    audio_frame,
    model_variant: 'test_values_not_maai',
    inference_ms: 1,
    raw: {},
    channel_layout: '2ch',
    p_now: [1 - pNowAi, pNowAi],
    p_future: [1 - pFutAi, pFutAi],
    vad: [userSpeaking ? 0.9 : 0.1, 0.1],
    user_speaking: userSpeaking,
    system_speaking: false,
  };
}

export function transcript(text: string, revision: number, extra: Partial<TranscriptSnapshot> = {}): TranscriptSnapshot {
  return {
    segment_id: 0,
    asr_segment_id: 0,
    asr_segment_frame_start: 0,
    transcript_revision: revision,
    text,
    stable_text: '',
    unstable_text: text,
    is_final: false,
    stability: absent('test'),
    stability_source: 'derived',
    audio_frame_end: 0,
    timing_precision: 'result_end_offset',
    words: absent('test'),
    received_at: 0,
    ...extra,
  };
}

export const ready = (audio_playback_id = 7, segment_id = 0): TurnInputs['prefetch'] => ({
  state: 'ready',
  audio_playback_id,
  segment_id,
  transcript_revision: 1,
  started_at: 0,
});
export const preparing = (audio_playback_id = 7, segment_id = 0): TurnInputs['prefetch'] => ({
  state: 'preparing',
  audio_playback_id,
  segment_id,
  transcript_revision: 1,
  started_at: 0,
});
export const playing = (audio_playback_id = 9, system_silence_ms = 0): TurnInputs['playback'] => ({
  state: 'playing',
  audio_playback_id,
  samples_written: 0,
  system_silence_ms,
});

export interface TickInput extends Partial<TurnInputs> {
  /** 省略時は [pNow, pFut, userSpeaking] = [0.45, 0.45, false]（不感帯、非発話）。 */
  p?: [number, number, boolean];
  /** 省略すると前の tick の値を保つ。 */
  text?: string;
  p_completion?: number;
  sim?: number;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

/** step を回す。毎回、入出力を契約で検証し、前の状態を凍結して純粋性も確かめる。 */
export class Driver {
  readonly manager;
  state: TurnState;
  private revision = 0;
  private lastTranscript: TurnInputs['transcript'] = absent('no_speech_yet');

  constructor(policy: Policy, options: ControlOptions = {}) {
    this.manager = createTurnManager(policy, options);
    this.state = this.manager.initialState();
  }

  tick(now: number, input: TickInput = {}): TurnDecision[] {
    const [pNow, pFut, speaking] = input.p ?? [0.45, 0.45, false];
    if (input.text !== undefined) {
      this.revision += 1;
      this.lastTranscript = present(
        transcript(input.text, this.revision, { segment_id: this.state.segment_id }),
      );
    }
    const inputs = TurnInputs.parse({
      vap: present(vapAt(pNow, pFut, speaking, 16000)),
      vap_received_at: present(now),
      received_audio_frame: 16000,
      vap_worker_started_at: present(0),
      fallback_energy: absent('vap_is_fresh'),
      transcript: this.lastTranscript,
      completion_p: input.p_completion === undefined ? absent('no_estimator') : present(input.p_completion),
      completion_revision: input.p_completion === undefined ? absent('no_estimator') : present(this.revision),
      similarity_to_prepared: input.sim === undefined ? absent('no_previous_prepare') : present(input.sim),
      prefetch: { state: 'idle' },
      playback: { state: 'idle' },
      woz: [],
      ...stripExtras(input),
    });
    deepFreeze(this.state);
    const output = this.manager.step(this.state, inputs, now);
    TurnStepOutput.parse(output);
    // ログとリプレイに使えるように JSON で往復できること。
    expectJsonSafe(output.state);
    this.state = output.state;
    return output.decisions;
  }
}

function stripExtras(input: TickInput): Partial<TurnInputs> {
  const { p: _p, text: _t, p_completion: _c, sim: _s, ...rest } = input;
  return rest;
}

function expectJsonSafe(state: TurnState): void {
  const back = JSON.parse(JSON.stringify(state)) as TurnState;
  if (JSON.stringify(back) !== JSON.stringify(state)) throw new Error('state is not JSON safe');
}

export const kinds = (decisions: TurnDecision[]): string[] => decisions.map((d) => d.kind);
export const pick = <K extends TurnDecision['kind']>(decisions: TurnDecision[], kind: K) =>
  decisions.filter((d): d is Extract<TurnDecision, { kind: K }> => d.kind === kind);
export const turnAllowed = (decisions: TurnDecision[]) => pick(decisions, 'turn_allowed')[0]?.payload;
export const gaze = (decisions: TurnDecision[]) => pick(decisions, 'gaze')[0]?.payload;
