import type { Unsubscribe } from '@llm-vap/contracts';

export class Listeners<T> {
  private readonly items = new Set<(value: T) => void>();

  add(listener: (value: T) => void): Unsubscribe {
    this.items.add(listener);
    return () => this.items.delete(listener);
  }

  emit(value: T): void {
    for (const listener of [...this.items]) listener(value);
  }
}
