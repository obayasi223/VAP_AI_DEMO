/** 購読者の一覧。購読者の例外で音声経路を止めない（testkit は開発用の依存なので、ここでは別に持つ）。 */
export class Listeners<T> {
  private readonly listeners = new Set<(value: T) => void>();

  add(listener: (value: T) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(value: T): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(value);
      } catch (error) {
        console.error('provider listener failed', error);
      }
    }
  }
}
