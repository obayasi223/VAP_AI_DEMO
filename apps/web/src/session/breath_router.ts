/**
 * 2 体のモードの吸気の配線（docs/design/two_ai/03 §2.5）。1 体ぶんの規則は ParticipantController.onBreath と同じ
 * （コードは移植。participant.ts は変えない）。AI ごとに 1 つ持ち、signal.report に ai_id を付けて返す。
 *  - breath.cue → BreathController.startInhale、breath.release → release、breath.prepare → prepareShort の後に release('speech_started')。
 *  - 描画を始めた時刻（次の rAF）を signal.report(started) で返す。アバターが受け付けなかった合図は visible:false。
 *  - 局面の実時刻（BreathLayer.onPhase）を BreathSignalReporter で signal.report へ。
 *  - 吸気音（BreathSound）は AI ごとに 1 つ。出力は context.destination で、sys チャネルには入らない。
 * 吸気の長さと完了の判定は Node が持つ（ここから完了を知らせない）。
 */
import type { AiId } from '@llm-vap/contracts/common';
import type { BreathCue, BreathPrepare, BreathRelease, SignalReport } from '@llm-vap/contracts/browser_rpc';
import type { Avatar } from '../avatar';
import type { BreathPhaseEvent } from '../avatar/breath';
import { BreathSignalReporter } from '../avatar/breath_signal';
import { breathOf, DEFERRED_SPEECH_PREP_MS } from './participant';

export interface BreathSoundLike {
  play(durationMs: number): void;
  stop(): void;
}

export interface BreathCommandRecord {
  ai_id: AiId | null;
  type: 'breath.cue' | 'breath.release' | 'breath.prepare';
  cue_id: string | null;
  reason?: string;
  client_t_ms: number;
  breath: boolean;
}

export interface BreathRouterDeps {
  avatar: () => Avatar | null;
  send: (signal: SignalReport) => void;
  record: (entry: BreathCommandRecord) => void;
  /** 吸気音。音声を始める前は null。 */
  breathSound: () => BreathSoundLike | null;
  now?: () => number;
  raf?: (cb: (t: number) => void) => void;
  visible?: () => boolean;
}

export class BreathRouter {
  private prepareTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly candidates = new Map<string, string>();
  private prepareCandidate: string | null = null;
  private boundAvatar: Avatar | null = null;
  private unsubscribe: (() => void) | null = null;
  private readonly signals: BreathSignalReporter;

  constructor(
    readonly ai_id: AiId,
    private readonly deps: BreathRouterDeps,
  ) {
    this.signals = new BreathSignalReporter(
      (cueId) => (cueId !== null ? (this.candidates.get(cueId) ?? this.prepareCandidate) : this.prepareCandidate),
      (event) =>
        this.deps.send({
          type: 'signal.report',
          candidate_id: event.candidate_id,
          phase: event.phase,
          state: event.state,
          visible: true,
          client_t_ms: { value: event.client_t_ms },
          ai_id: this.ai_id,
        }),
    );
  }

  private now(): number {
    return this.deps.now?.() ?? performance.now();
  }

  private visible(): boolean {
    if (this.deps.visible) return this.deps.visible();
    return typeof document === 'undefined' || document.visibilityState === 'visible';
  }

  private raf(cb: (t: number) => void): void {
    if (this.deps.raf) this.deps.raf(cb);
    else requestAnimationFrame(cb);
  }

  /** ai_id は呼び出し側が振り分けた後の値（省略を 'A' と数えたかは recordAiId で分かる）。 */
  onCue(message: BreathCue | BreathRelease, recordAiId: AiId | null = this.ai_id): void {
    const breath = breathOf(this.deps.avatar());
    this.deps.record({
      ai_id: recordAiId,
      type: message.type,
      cue_id: message.cue_id,
      ...(message.type === 'breath.release' ? { reason: message.reason } : {}),
      client_t_ms: this.now(),
      breath: breath !== null,
    });
    if (breath === null) return;
    if (message.type === 'breath.release') this.clearPrepareTimer();
    if (message.type === 'breath.cue') this.noteCandidate(message.cue_id, message.candidate_id);
    this.bindPhases();
    const applied =
      message.type === 'breath.cue'
        ? breath.startInhale({ cue_id: message.cue_id, duration_ms: message.duration_ms })
        : breath.release(message.reason);
    if (message.type === 'breath.release') this.deps.breathSound()?.stop();
    else if (applied && this.visible()) this.deps.breathSound()?.play(message.duration_ms);
    const phase: SignalReport['phase'] =
      message.type === 'breath.cue' ? 'inhale' : message.reason === 'speech_started' ? 'pre_speech' : 'relax';
    const report = (visible: boolean, t: number | null, nullReason = 'not_visible') =>
      this.deps.send({
        type: 'signal.report',
        candidate_id: message.candidate_id,
        phase,
        state: 'started',
        visible,
        client_t_ms: t === null ? { value: null, null_reason: nullReason } : { value: t },
        ai_id: this.ai_id,
      });
    if (!applied) report(false, null, 'avatar_did_not_apply');
    else if (!this.visible()) report(false, null);
    else this.raf((t) => report(true, t));
  }

  onPrepare(message: BreathPrepare, recordAiId: AiId | null = this.ai_id): void {
    const breath = breathOf(this.deps.avatar());
    this.deps.record({ ai_id: recordAiId, type: 'breath.prepare', cue_id: null, client_t_ms: this.now(), breath: breath !== null });
    this.prepareCandidate = message.candidate_id;
    this.bindPhases();
    breath?.prepareShort?.(DEFERRED_SPEECH_PREP_MS);
    this.clearPrepareTimer();
    this.prepareTimer = setTimeout(() => {
      this.prepareTimer = null;
      breath?.release('speech_started');
    }, DEFERRED_SPEECH_PREP_MS);
  }

  private bindPhases(): void {
    const avatar = this.deps.avatar();
    if (avatar === null || avatar === this.boundAvatar) return;
    this.unsubscribe?.();
    this.boundAvatar = avatar;
    const subscribe = (avatar as Avatar & { onBreathPhase?: Avatar['onBreathPhase'] }).onBreathPhase;
    this.unsubscribe = subscribe?.call(avatar, (event: BreathPhaseEvent) => this.signals.onPhase(event)) ?? null;
  }

  private noteCandidate(cueId: string, candidateId: string): void {
    this.candidates.set(cueId, candidateId);
    if (this.candidates.size > 16) this.candidates.delete(this.candidates.keys().next().value as string);
  }

  private clearPrepareTimer(): void {
    if (this.prepareTimer !== null) clearTimeout(this.prepareTimer);
    this.prepareTimer = null;
  }

  stop(): void {
    this.clearPrepareTimer();
    this.deps.breathSound()?.stop();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.boundAvatar = null;
  }
}
