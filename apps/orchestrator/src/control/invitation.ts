/**
 * 明示的な招待の語句検出（仕様§4、計画 §4.6）。STT の文字列の照合で、誤認しうる。譲渡の意思の証明ではない。
 *
 * 構造は Jarvis の招待検出（docs/related_work_notes.md の 6）を参考にした:
 *  - 文末に固定する。日本語の否定や引用は語句の後ろに来るので（「どうぞって言ってない」）、固定で除ける。
 *  - ASR の分割で語句が割れるので、呼び出し側は segment の累積文を渡す。
 *  - 検出後の待ちは別に持たず、TurnManager が MIN_GAP_TIME と非発話を要求する。
 *
 * 句読点は比較の前に除く。interim の末尾の「？」「。」は変動するので根拠にしない（docs/known_gaps.md §3）。
 * そのため上昇調でしか質問と分からない文（「もう食べた」）は検出しない。
 * 語句は自作の案で、実対話での誤検出率は測っていない。
 */
import type { Invitation, TranscriptSnapshot } from '@llm-vap/contracts';
import { normalizeForSimilarity } from '../cognition/similarity';

type InvitationKind = Extract<Invitation, { detected: true }>['kind'];

export interface InvitationRule {
  id: string;
  kind: InvitationKind;
  /** 正規化後の文末に一致させる。 */
  re: RegExp;
}

export const INVITATION_RULES: readonly InvitationRule[] = [
  { id: 'doozo', kind: 'go_ahead', re: /どうぞ(どうぞ)?(ー|ね|はい|お願いします)?$/u },
  { id: 'please_speak', kind: 'go_ahead', re: /(話して|言って|続けて)(ください|下さい)$/u },
  // 「私はそれを話したい」は利用者自身の希望なので、「何か」のない形と「です」で終わる形は入れない。
  { id: 'want_to_say', kind: 'go_ahead', re: /((何か|なんか)(言いたい|話したい)(こと)?(ある|ありますか|の|ですか)?|言いたいこと(ある|ありますか))$/u },
  // 「そこに何かある」を拾うので「何かある」は入れない。
  { id: 'anything_to_add', kind: 'go_ahead', re: /(何か|なんか)ありますか$/u },
  { id: 'how_do_you_think', kind: 'direct_question', re: /どう(思う|思います|思いますか|ですか|でしょうか|かな)$/u },
  { id: 'how_about', kind: 'direct_question', re: /いかが(ですか|でしょうか)$/u },
  { id: 'tell_me', kind: 'direct_question', re: /(教えて|聞かせて)(ください|下さい|ほしい|欲しい)?$/u },
  { id: 'your_turn', kind: 'other', re: /(そちら|そっち|あなた|君)の(番|ターン)(です|だよ)?$/u },
];

export interface InvitationDetection {
  invitation: Invitation;
  /** 一致した規則の ID。turn.allowed の reason に残す。 */
  rule_id: string | null;
}

export const NO_INVITATION: Invitation = { detected: false };

export function detectInvitation(
  text: string,
  source: Pick<TranscriptSnapshot, 'segment_id' | 'transcript_revision'>,
): InvitationDetection {
  const normalized = normalizeForSimilarity(text);
  for (const rule of INVITATION_RULES) {
    const match = rule.re.exec(normalized);
    if (match) {
      return {
        invitation: {
          detected: true,
          kind: rule.kind,
          phrase: match[0],
          segment_id: source.segment_id,
          transcript_revision: source.transcript_revision,
        },
        rule_id: rule.id,
      };
    }
  }
  return { invitation: NO_INVITATION, rule_id: null };
}
