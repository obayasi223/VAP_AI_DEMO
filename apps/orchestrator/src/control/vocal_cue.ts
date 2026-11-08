/**
 * 吸気の後の短い声（別モード。docs/initiative_v3_design.md §10）。声を出すかの判断の純粋関数で、配線は session/vocal_cue_wiring.ts。
 *
 * 研究の主眼は発声前の無音の吸気なので既定は none（このモジュールは使われない）。声を出してよいのは次を全部満たす tick だけ:
 * 候補が DEFERRED（吸気の後に人が話し続けて延期した）で、この候補でまだ出しておらず、話してよい許可がまだ出ていない短い切れ目。
 * 切れ目は既存の信号だけで決める（VAP の vad、ASR の更新の間隔、人の発話の終わりからの間）。値は policy の暫定値で未校正。
 * 許可（permitted_to_speak）とは別の判断で、声は発話の許可を作らない。人が譲った後の発話は既存の許可の経路のまま。
 */
import type { Invitation, PolicyJa, VocalCueKind, VocalCueMode } from '@llm-vap/contracts';
import { detectDirectQuestion } from './negotiator';
import type { CandidateView } from './negotiator';

/** 相槌の語（固定）。発話権を主張しない語だけ。 */
export const BACKCHANNEL_PHRASE = 'うん';

export interface VocalCueSettings {
  kind: VocalCueKind;
  phrase: string;
  min_user_silence_ms: number;
  min_asr_quiet_ms: number;
  max_vad_user: number;
  observation_window_ms: number;
  /** 判定の古さの上限（交渉と同じ値）。これより古い候補の声は出さない。 */
  max_new_stable_chars_since_judgement: number;
}

/** 方策と選択から設定を作る。声を出さないときは settings が null で、その理由（none の選択は理由なし）。 */
export function vocalCueSettings(
  policy: PolicyJa,
  mode: VocalCueMode,
  condition: string,
): { settings: VocalCueSettings | null; reason: string | null } {
  if (mode === 'none') return { settings: null, reason: null };
  if (condition !== 'initiative_inhale') return { settings: null, reason: `condition:${condition}` };
  const negotiation = policy.initiative.negotiation;
  const section = negotiation?.vocal_cue;
  if (!negotiation || !section) return { settings: null, reason: 'policy_has_no_vocal_cue_section' };
  const { min_user_silence_ms, min_asr_quiet_ms, max_vad_user } = section;
  if (min_user_silence_ms === null || min_asr_quiet_ms === null || max_vad_user === null) {
    return { settings: null, reason: 'policy_vocal_cue_uncalibrated' };
  }
  const maxChars = negotiation.max_new_stable_chars_since_judgement ?? policy.initiative.max_new_stable_chars_since_input;
  if (maxChars === null) return { settings: null, reason: 'policy_judgement_age_uncalibrated' };
  return {
    settings: {
      kind: mode,
      phrase: mode === 'pre_beginning' ? section.pre_beginning_phrase : BACKCHANNEL_PHRASE,
      min_user_silence_ms,
      min_asr_quiet_ms,
      max_vad_user,
      observation_window_ms: section.observation_window_ms,
      max_new_stable_chars_since_judgement: maxChars,
    },
    reason: null,
  };
}

export interface VocalCueGateInputs {
  /** 対象の候補。DEFERRED のものだけが対象。 */
  candidate: CandidateView;
  /** この候補はもう声を出した（1 候補 1 回まで）。 */
  already_voiced: boolean;
  /** 候補の DEFERRED の記録があるか（吸気の後に延期したことの確認）。 */
  ai_speaking: boolean;
  permitted: boolean;
  user_speaking: boolean;
  link_attached: boolean;
  /** VAP が新鮮か。新鮮でなければ切れ目を判定しない（vad が読めない）。 */
  vap_fresh: boolean;
  user_silence_ms: number;
  asr_quiet_ms: number;
  vad_user: number | null;
  invitation: Invitation;
  user_text: string | null;
  /** 語の音声が用意できている。 */
  phrase_ready: boolean;
}

export interface VocalCueDecision {
  fire: boolean;
  reasons: string[];
}

/** 声を出すか。止める理由があれば fire は false で、全部の理由を返す。 */
export function judgeVocalCue(settings: VocalCueSettings, input: VocalCueGateInputs): VocalCueDecision {
  const reasons: string[] = [];
  const c = input.candidate;
  if (c.state !== 'DEFERRED') reasons.push(`state:${c.state}`);
  if (input.already_voiced) reasons.push('already_voiced');
  if (input.ai_speaking) reasons.push('ai_speaking');
  if (input.permitted) reasons.push('permitted');
  if (!input.link_attached) reasons.push('browser_detached');
  if (input.user_speaking) reasons.push('user_speaking');
  if (!input.vap_fresh) reasons.push('vap_not_fresh');
  if (input.vad_user === null) reasons.push('vad_unavailable');
  else if (input.vad_user >= settings.max_vad_user) reasons.push(`vad_user=${input.vad_user}`);
  if (input.user_silence_ms < settings.min_user_silence_ms) reasons.push(`silence_short:${input.user_silence_ms}ms`);
  if (input.asr_quiet_ms < settings.min_asr_quiet_ms) reasons.push(`asr_recent:${input.asr_quiet_ms}ms`);
  if (input.invitation.detected) reasons.push('invitation');
  if (detectDirectQuestion(input.invitation, input.user_text) !== null) reasons.push('direct_question');
  const chars = c.new_chars_since_judgement;
  if (chars === null) reasons.push('judgement_input_unknown');
  else if (chars > settings.max_new_stable_chars_since_judgement) reasons.push(`judgement_stale:chars=${chars}`);
  // 発話権の申し出は、この後に候補の音声が出せないと出す意味がない。相槌は候補の発話の準備に関係しない。
  if (settings.kind === 'pre_beginning' && c.audio !== 'ready') reasons.push(`candidate_audio_${c.audio}`);
  if (!input.phrase_ready) reasons.push('phrase_not_ready');
  return { fire: reasons.length === 0, reasons };
}
