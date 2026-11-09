/**
 * 申し出の状況（docs/initiative_v3_design.md §11）。吸気の合図を実際に見せたかと、その後に観測した人の振る舞いの事実だけを持つ。
 * 人が受け入れた、譲った、といった意思は推定しない（語も持たない）。
 *
 * 入口はセッションの送信の経路（NegotiationWiring の signal.sent と signal.report）だけで、研究条件の名前は読まない。
 * initiative_no_cue と reactive は合図を送らないので、記録がなく not_presented になる。候補の状態（BREATH_INHALE など）も
 * 読まない（送信に失敗しても状態は進むため）。
 * 候補は合図を1回しか受けない（REVISE は再吸気しない）ので、候補ごとに1件を持つ。
 */
import { absent, present } from '@llm-vap/contracts';
import type { OfferFollowUp, OfferView } from '@llm-vap/contracts';

interface TrackedCue {
  cue_id: string;
  sent_at: number;
  /** ブラウザが描いたと報告した時刻。未報告は null。 */
  shown_at: number | null;
  /** ブラウザが描いていないと報告した（背景タブ、アバターが受け付けなかった）。 */
  reported_not_visible: boolean;
  follow_up: OfferFollowUp;
  /** 合図より前の招待を、合図の後の招待として数えないための印。招待がない時刻を一度通ったら立つ。 */
  invitation_armed: boolean;
}

export interface OfferTick {
  now: number;
  user_speaking: boolean;
  ai_speaking: boolean;
  invitation_detected: boolean;
  /** 未解決の候補。これ以外の記録は捨てる。 */
  live_candidate_ids: ReadonlySet<string>;
}

const NOT_PRESENTED = (null_reason: string): OfferView => ({
  presentation: 'not_presented',
  cue_id: absent(null_reason),
  elapsed_s: absent(null_reason),
  follow_up: 'unknown',
});

export class OfferObservations {
  private readonly cues = new Map<string, TrackedCue>();

  /** 合図をブラウザへ送れた（送れなかった合図はここへ来ない）。 */
  noteSent(cue: { cue_id: string; candidate_id: string; at: number; invitation_detected: boolean }): void {
    this.cues.set(cue.candidate_id, {
      cue_id: cue.cue_id,
      sent_at: cue.at,
      shown_at: null,
      reported_not_visible: false,
      follow_up: 'unknown',
      invitation_armed: !cue.invitation_detected,
    });
  }

  /** ブラウザの吸気の開始の報告。描かれた報告は描かれていない報告より優先する。 */
  noteReport(candidate_id: string, cue_id: string, shown: { visible: true; started_at: number } | { visible: false }): void {
    const cue = this.cues.get(candidate_id);
    if (cue?.cue_id !== cue_id) return;
    if (!shown.visible) {
      if (cue.shown_at === null) cue.reported_not_visible = true;
      return;
    }
    if (cue.shown_at !== null) return;
    cue.shown_at = shown.started_at;
    cue.reported_not_visible = false;
    // 描かれる前の振る舞いは、合図の後の振る舞いではない。
    cue.follow_up = 'unknown';
  }

  /** tick ごとの観測。合図の時点より後の tick だけを数える。AI の発話中の人の声は、合図の後の振る舞いとして数えない。 */
  observe(tick: OfferTick): void {
    for (const [candidate_id, cue] of [...this.cues]) {
      if (!tick.live_candidate_ids.has(candidate_id)) {
        this.cues.delete(candidate_id);
        continue;
      }
      if (tick.ai_speaking) continue;
      if (!tick.invitation_detected) cue.invitation_armed = true;
      if (tick.now <= (cue.shown_at ?? cue.sent_at)) continue;
      cue.follow_up = tick.invitation_detected && cue.invitation_armed ? 'invited' : tick.user_speaking ? 'kept_talking' : 'stopped';
    }
  }

  /** at の時点の状況。判定に渡す値と記録する値は同じこの値。 */
  view(candidate_id: string, at: number): OfferView {
    const cue = this.cues.get(candidate_id);
    if (cue === undefined) return NOT_PRESENTED('no_cue_sent');
    if (cue.reported_not_visible) return { ...NOT_PRESENTED('cue_not_visible'), cue_id: present(cue.cue_id) };
    const since = cue.shown_at ?? cue.sent_at;
    return {
      presentation: cue.shown_at !== null ? 'presented' : 'sent_unconfirmed',
      cue_id: present(cue.cue_id),
      elapsed_s: present(Math.round(Math.max(0, at - since) / 100) / 10),
      follow_up: cue.follow_up,
    };
  }
}
