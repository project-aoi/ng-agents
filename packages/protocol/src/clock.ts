/** Injected time source. Nothing in the system calls `Date.now()` directly (timers, leases, deliverAt, cron). */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};

/** Deterministic clock for tests. Listeners fire after every `set`/`advance` so time-driven components can re-check. */
export class ManualClock implements Clock {
  #now: number;
  readonly #listeners = new Set<(now: number) => void>();

  constructor(start = 0) {
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  set(ms: number): void {
    if (ms < this.#now) throw new RangeError(`ManualClock cannot go backwards (${ms} < ${this.#now})`);
    this.#now = ms;
    this.#notify();
  }

  advance(ms: number): number {
    if (ms < 0) throw new RangeError("ManualClock.advance requires ms >= 0");
    this.#now += ms;
    this.#notify();
    return this.#now;
  }

  subscribe(listener: (now: number) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #notify(): void {
    for (const l of [...this.#listeners]) l(this.#now);
  }
}
