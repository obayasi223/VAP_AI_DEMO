/**
 * 完了の推定の要求と最新の値（session.ts の requestCompletion から切り出し。docs/design/two_ai/06 §11、01 §1.3。WP1a）。
 */
import { absent } from '@llm-vap/contracts';
import type { Maybe, TranscriptSnapshot, TurnCompletionEstimator } from '@llm-vap/contracts';
import { userTextFor } from '../../control';
import type { TurnState } from '../../control';
import type { SessionHistory } from '../history';

export class CompletionTracker {
  private value: { p: Maybe<number>; revision: number | null } = { p: absent('no_estimate_yet'), revision: null };
  private requested = -1;

  constructor(private readonly deps: { estimator: TurnCompletionEstimator }) {}

  /** 推定は非同期。新しい revision の結果だけを残す（E1 が segment の境界で古い値を読まない）。 */
  request(snapshot: TranscriptSnapshot, turnState: TurnState, history: SessionHistory, isClosed: () => boolean): void {
    if (snapshot.segment_id < turnState.segment_id) return;
    const revision = snapshot.transcript_revision;
    this.requested = revision;
    const partial = userTextFor(turnState, snapshot);
    const entries = history.snapshot().filter((e) => !(e.role === 'user' && e.segment_id === snapshot.segment_id));
    this.deps.estimator
      .estimate(entries, partial, { transcript_revision: revision })
      .then((estimate) => {
        if (isClosed() || revision < (this.value.revision ?? -1)) return;
        this.value = { p: estimate.p, revision };
      })
      .catch(() => undefined);
  }

  get p(): Maybe<number> {
    return this.value.p;
  }

  get revision(): number | null {
    return this.value.revision;
  }

  /** 最後に要求した revision（-1 はまだ）。 */
  get lastRequested(): number {
    return this.requested;
  }
}
