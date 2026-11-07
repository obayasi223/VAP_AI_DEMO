/**
 * TurnManager の状態。JSON にできる値だけを持ち、ログとリプレイにそのまま使える。
 *
 * want_to_speak、permitted_to_speak、speaking は別の変数で、互いから導かない（計画 §4.6）。
 *  - want_to_speak: 話す内容があるか。E1 では準備済みの応答だけ。E2a が候補の種類を足す。
 *  - permitted_to_speak: 今の tick で話してよいか（Appendix A の turn_shift_allowed）。システムの暫定判断。
 *  - speaking: 実際の再生の状況。
 */
import type { Invitation, TurnStateCore, VapFreshness } from '@llm-vap/contracts';
import { NO_INVITATION } from './invitation';
import type { SimilarityGate } from './prepare';

export type WantToSpeak =
  | { kind: 'none' }
  /** E2a はここへ候補の種類を足す。 */
  | { kind: 'response'; audio_playback_id: number; segment_id: number };

export type Speaking =
  | { phase: 'silent' }
  /** start_speech を出し、再生の報告を待っている。U-1 の重なりを防ぐために話し中として扱う。 */
  | { phase: 'starting'; audio_playback_id: number; requested_at: number }
  | { phase: 'playing'; audio_playback_id: number }
  /** interrupt_speech を出した後。U-8 の重複を防ぐ。 */
  | { phase: 'stopping'; audio_playback_id: number };

/** segment 内の利用者の発話。STT の text は ASR 区間ごとなので（assembler.ts）ここで連結する。 */
export interface UtteranceBuffer {
  segment_id: number;
  /** 閉じた ASR 区間の連結。 */
  closed_text: string;
  asr_segment_id: number;
  current_text: string;
}

/** L47 の最後の判定。prepare の決定には閾値の状態を書く項目がないので、ここに残す。 */
export interface LastPrepareGate {
  at: number;
  gate: SimilarityGate;
  fired: boolean;
}

export interface PrepareTrack {
  text: string;
  /** D の報告で見えた準備の ID。 */
  audio_playback_id: number | null;
}

export interface TurnState extends TurnStateCore {
  want_to_speak: WantToSpeak;
  permitted_to_speak: boolean;
  speaking: Speaking;

  // Appendix A の変数（L23〜L28）。時計は最初の step で初期化する（initialState は時刻を受け取らない）。
  user_speak_end_time: number | null;
  last_asr_time: number | null;
  asr_result: string | null;
  last_sent_asr_result: string | null;
  turngpt_output: number;

  /** L37 の has_new_result の判定に使う、処理済みの revision。 */
  asr_revision: number | null;
  utterance: UtteranceBuffer | null;
  /** U-4: 前の segment の推定値を読まないための下限。この revision 以前の p は使わない。 */
  completion_floor_revision: number | null;
  /** turngpt_output の元になった revision（U-9）。 */
  completion_revision: number | null;

  vap_freshness: VapFreshness;
  degraded: boolean;
  /** U-7 の最短継続に使う生の発話判定。 */
  user_speaking_raw: boolean;
  user_speaking_raw_since: number | null;
  user_last_voiced_at: number | null;
  /** degraded 時の無音の起点。fallback_energy から求めた値で VAP ではない。 */
  fallback_last_voiced_at: number | null;

  invitation: Invitation;
  invitation_rule_id: string | null;

  last_prepare_gate: LastPrepareGate | null;
  prepare_track: PrepareTrack | null;
  /** 準備の喪失の再試行は同じ文で1回まで。 */
  prepare_retried_text: string | null;
  last_cancelled_prepare_id: number | null;

  /** turn_allowed の変化の検出に使う。 */
  last_turn_allowed_key: string | null;
  gaze_pause_logged: boolean;
}

export function createInitialState(): TurnState {
  return {
    mode: 'listening',
    segment_id: 0,
    user_speaking: false,
    user_turn_end_time: null,
    last_prepare_at: null,
    gaze_target: 'user',
    want_to_speak: { kind: 'none' },
    permitted_to_speak: false,
    speaking: { phase: 'silent' },
    user_speak_end_time: null,
    last_asr_time: null,
    asr_result: null,
    last_sent_asr_result: null,
    turngpt_output: 0,
    asr_revision: null,
    utterance: null,
    completion_floor_revision: null,
    completion_revision: null,
    vap_freshness: 'down',
    degraded: false,
    user_speaking_raw: false,
    user_speaking_raw_since: null,
    user_last_voiced_at: null,
    fallback_last_voiced_at: null,
    invitation: NO_INVITATION,
    invitation_rule_id: null,
    last_prepare_gate: null,
    prepare_track: null,
    prepare_retried_text: null,
    last_cancelled_prepare_id: null,
    last_turn_allowed_key: null,
    gaze_pause_logged: false,
  };
}
