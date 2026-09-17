export type Listener<T> = (event: T) => void;

/**
 * Minimal typed event emitter. Core cannot use `vscode.EventEmitter` (host API)
 * and Node's `EventEmitter` is untyped and stringly-keyed, so this is the
 * smallest thing that works identically in both hosts and in tests.
 */
export class Emitter<T> {
  readonly #listeners = new Set<Listener<T>>();

  get event(): (listener: Listener<T>) => Disposable {
    return (listener) => {
      this.#listeners.add(listener);
      return { [Symbol.dispose]: () => void this.#listeners.delete(listener) };
    };
  }

  fire(event: T): void {
    // Copy first: a listener may dispose itself while we iterate.
    for (const listener of [...this.#listeners]) listener(event);
  }

  get size(): number {
    return this.#listeners.size;
  }

  dispose(): void {
    this.#listeners.clear();
  }
}

/** Collects disposables so a whole subsystem tears down in one call. */
export class DisposableStore implements Disposable {
  readonly #items: Disposable[] = [];

  add<T extends Disposable>(item: T): T {
    this.#items.push(item);
    return item;
  }

  [Symbol.dispose](): void {
    while (this.#items.length > 0) {
      this.#items.pop()?.[Symbol.dispose]();
    }
  }
}
