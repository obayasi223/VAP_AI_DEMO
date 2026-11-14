/**
 * 2 つのスロットが共有する再生 ID と世代の数え（docs/design/two_ai/06 §5、01 §2.1）。
 * ブラウザは「最後の playback.stop の世代より古い PCM」を棄てるので、2 体の SpeechGeneratorImpl は同じ数えを使う。
 * 1 対 1 は SpeechGeneratorImpl が自分専用のものを作る（今と同じ振る舞い）。
 */
export class SharedPlaybackCounters {
  private nextId: number;
  private gen = 0;

  constructor(first_playback_id = 1) {
    this.nextId = first_playback_id;
  }

  nextPlaybackId(): number {
    return this.nextId++;
  }

  get generation(): number {
    return this.gen;
  }

  /** stop のたびに呼ぶ。新しい世代を返す。 */
  bumpGeneration(): number {
    this.gen += 1;
    return this.gen;
  }
}
