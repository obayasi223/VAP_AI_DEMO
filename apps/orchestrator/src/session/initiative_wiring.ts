/**
 * 発話希望（G の InitiativeMonitor と E2a の CandidateLedger）の配線（計画 §5.1 J、波2）。
 * セッション（session.ts）とリプレイ（tools/initiative_spike/run_replay.ts）が同じこの部品を通る。
 *
 *   STT の結果 → monitor.onStt（増分で起動。固定周期では起動しない）
 *   固定周期の tick → ledger.observeUserFloor（人が再開したら保留した NEW を候補へ）、ledger.tick（期限）、
 *                     monitor.poll（失敗の後の待ちの明け。失敗した入力をそこで判定し直す）
 *   segment の変更 → ledger.onSegmentChanged、通常応答の開始 → ledger.onNormalResponseStarted
 *   候補の発話の終わり → ledger.finishSpeech（波2では候補を話さないので通常は呼ばれない。口だけ用意）
 *
 * 波2の範囲: 候補を作り、撤回し、ログと研究者画面に出すところまで。NEW は合図の許可でも発声の許可でもなく、
 * ここから吸気（H2）も発声（D）も起こさない。候補の先行音声も準備しない（TTS を作らない）。
 * LLM の呼び出しは非同期で、tick を待たせない。
 */
import type {
  EventEmitter,
  LlmProvider,
  PolicyJa,
  SpeechStartResult,
  SttResult,
  TimeSource,
} from '@llm-vap/contracts';
import { InitiativeMonitor } from '../cognition/initiative';
import type { FailureBackoff, InitiativePersona, StagedOptions, SttInput, TriggerOptions } from '../cognition/initiative';
import { CandidateLedger, candidateLedgerSettings } from '../control/candidates';
import type { CandidateSpeechPort } from '../control/candidates';

/** STT の結果を安定テキストの入力へ。stt.* イベントと同じ項目を写すだけ（値は変えない）。 */
export function sttInputFromResult(result: SttResult): SttInput {
  return {
    event: result.kind === 'final' ? 'stt.final' : 'stt.interim',
    transcript_revision: result.transcript_revision,
    segment_id: result.segment_id,
    asr_segment_id: result.asr_segment_id,
    text: result.text,
    stable_text: result.stable_text,
    stability_source: result.stability_source,
    parts: result.parts,
    audio_frame_end: result.audio_frame_end,
  };
}

/** D の音声がないとき（TTS を開けなかった、リプレイ）の口。候補の PCM はないので、開始は拒否し、破棄は 0 件。 */
export const NO_CANDIDATE_SPEECH: CandidateSpeechPort = {
  startChecked: (): SpeechStartResult => ({ ok: false, reason: 'unknown_playback' }),
  discardCandidate: () => 0,
};

export interface InitiativeWiringOptions {
  llm: LlmProvider;
  persona: InitiativePersona;
  policy: PolicyJa;
  emitter: EventEmitter;
  time: TimeSource;
  /** D の SpeechGeneratorImpl。後から作られるので関数で渡す。null なら NO_CANDIDATE_SPEECH。 */
  speech: () => CandidateSpeechPort | null;
  prompt_version?: string;
  /** policy.initiative.trigger より優先する（スパイクとの比較用）。 */
  trigger?: TriggerOptions;
  failure_backoff?: FailureBackoff;
  /** 二段判定（生成段とタイミング段）。省略と timing_strategy=v2 は1段判定。 */
  staged?: StagedOptions;
}

export class InitiativeWiring {
  readonly ledger: CandidateLedger;
  readonly monitor: InitiativeMonitor;
  private closed = false;

  constructor(options: InitiativeWiringOptions) {
    const speech: CandidateSpeechPort = {
      startChecked: (id, expected) => (options.speech() ?? NO_CANDIDATE_SPEECH).startChecked(id, expected),
      discardCandidate: (id, reason, keep) => (options.speech() ?? NO_CANDIDATE_SPEECH).discardCandidate(id, reason, keep),
    };
    // monitor より先に作るので、stable は monitor ができてから読む。
    let monitor: InitiativeMonitor | null = null;
    this.ledger = new CandidateLedger({
      emitter: options.emitter,
      stable: () => monitor?.stableSnapshot() ?? [],
      speech,
      settings: candidateLedgerSettings(options.policy),
    });
    monitor = new InitiativeMonitor({
      llm: options.llm,
      ledger: this.ledger,
      emitter: options.emitter,
      time: options.time,
      persona: options.persona,
      limits: options.policy.initiative,
      ...(options.trigger ? { trigger: options.trigger } : {}),
      ...(options.prompt_version ? { prompt_version: options.prompt_version } : {}),
      ...(options.failure_backoff ? { failure_backoff: options.failure_backoff } : {}),
      ...(options.staged ? { staged: options.staged } : {}),
    });
    this.monitor = monitor;
  }

  onSttResult(result: SttResult): void {
    this.onStt(sttInputFromResult(result));
  }

  onStt(input: SttInput): void {
    if (this.closed) return;
    this.monitor.onStt(input);
  }

  /** J の固定周期の tick から。軽い同期処理だけで、LLM を待たない。 */
  tick(now: number, user_speaking: boolean): void {
    if (this.closed) return;
    // 話の後として保留した NEW は、人が再開したら E2a が照合し直して候補にする。G が initiative.decision を出す。
    const promoted = this.ledger.observeUserFloor(user_speaking, now);
    if (promoted) this.monitor.onHeldPromoted(promoted, now);
    this.ledger.tick(now);
    this.monitor.poll();
  }

  onSegmentChanged(segment_id: number, now: number): void {
    if (this.closed) return;
    this.ledger.onSegmentChanged(segment_id, now);
    this.monitor.noteAiStarted(segment_id);
  }

  onNormalResponseStarted(now: number): void {
    if (this.closed) return;
    this.ledger.onNormalResponseStarted(now);
  }

  /** speech.ended／interrupted。候補の発話だけを E2a へ伝える。1 音も出なかった終わりは no_audio で区別する。 */
  onSpeechFinished(
    finished: { audio_playback_id: number; interrupted: boolean; no_audio?: boolean; origin: { kind: string; candidate_id?: string } },
    now: number,
  ): void {
    if (this.closed || finished.origin.kind !== 'candidate' || !finished.origin.candidate_id) return;
    const record = this.ledger.getRecord(finished.origin.candidate_id);
    // 再生の失敗で先に閉じた候補の、遅れて届いた終わりの報告（履歴には session 側で発話済みの部分だけが入る）。
    if (record?.state === 'WITHDRAWN' && record.audio_playback_id === finished.audio_playback_id) return;
    this.ledger.finishSpeech(
      finished.origin.candidate_id,
      finished.audio_playback_id,
      finished.no_audio ? 'speech_no_audio' : finished.interrupted ? 'speech_interrupted' : 'speech_finished',
      now,
    );
  }

  /** D が再生中の音声を失敗にした。SPEAKING の候補を終端する（残すと以後の NEW を塞ぐ）。発話中でない候補には何もしない。 */
  onSpeechFailed(candidate_id: string, audio_playback_id: number, now: number): void {
    if (this.closed) return;
    const record = this.ledger.getRecord(candidate_id);
    if (record?.state !== 'SPEAKING' || record.audio_playback_id !== audio_playback_id) return;
    this.ledger.finishSpeech(candidate_id, audio_playback_id, 'speech_failed', now);
  }

  close(): void {
    this.closed = true;
    this.monitor.stop();
  }
}
