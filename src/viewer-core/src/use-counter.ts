/** Counts the users of shared things, and cleans one up when its last user lets go. */
export class UseCounter<Key> {
  readonly #counts = new Map<Key, number>();

  /**
   * Adds a user of the thing under this key. Returns a function that lets go, which counts once however often it's
   * called. The last user to let go runs its cleanup.
   */
  acquire(key: Key, cleanup: () => void): () => void {
    this.#counts.set(key, (this.#counts.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const remaining = this.#counts.get(key)! - 1;
      if (remaining > 0) {
        this.#counts.set(key, remaining);
      } else {
        this.#counts.delete(key);
        cleanup();
      }
    };
  }
}
