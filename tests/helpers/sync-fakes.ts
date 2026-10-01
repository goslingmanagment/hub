import type { Clock, PauseSource, Rng } from "../../apps/runtime/src/sync/engine/ports.ts";

// Deterministic doubles of the Fansly Sync Engine ports (engine/ports.ts) for
// unit tests: a virtual clock whose sleeps advance time instantly, a seeded
// PRNG, a pause setting the test can change or break.

/** mulberry32: a small, fast, seedable PRNG, uniform in [0, 1). */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export class SeededRng implements Rng {
  readonly #random: () => number;
  constructor(seed: number) {
    this.#random = seededRandom(seed);
  }
  next(): number {
    return this.#random();
  }
}

/** An Rng that returns the given values in turn (the last one repeats). */
export class ScriptedRng implements Rng {
  #index = 0;
  constructor(readonly values: readonly number[]) {}
  next(): number {
    const value = this.values[Math.min(this.#index, this.values.length - 1)]!;
    this.#index += 1;
    return value;
  }
}

export interface FakeClockOptions {
  /** Monotonic start (ms). */
  startMono?: number;
  /** The wall clock at mono 0. */
  wallEpochMs?: number;
}

/**
 * Virtual time. `sleep(ms)` advances the clock by `ms` (or by what
 * `wakeEarlyBy` says, to model timers that fire early) and resolves at once;
 * an aborted signal rejects. `onSleep` runs after the advance, so a test can
 * change the world "during" a wait.
 */
export class FakeClock implements Clock {
  mono: number;
  readonly wallEpochMs: number;
  sleeps: number[] = [];
  /** How much earlier than asked a sleep returns (ms); default 0. */
  wakeEarlyBy: (ms: number) => number = () => 0;
  onSleep: ((ms: number) => void) | null = null;

  constructor(options: FakeClockOptions = {}) {
    this.mono = options.startMono ?? 1_000_000;
    this.wallEpochMs = options.wallEpochMs ?? Date.UTC(2026, 9, 2, 12, 0, 0);
  }

  monoNow(): number {
    return this.mono;
  }

  wallNow(): Date {
    return new Date(this.wallEpochMs + this.mono);
  }

  advance(ms: number): void {
    this.mono += ms;
  }

  sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    this.sleeps.push(ms);
    if (ms > 0) this.mono += Math.max(0, ms - Math.max(0, this.wakeEarlyBy(ms)));
    this.onSleep?.(ms);
    if (signal?.aborted) return Promise.reject(signal.reason);
    return Promise.resolve();
  }
}

/** The owner's setting as a test controls it. */
export class FakePauseSource implements PauseSource {
  reads = 0;
  failure: Error | null = null;
  constructor(public settingMs: number) {}
  readSettingMs(): Promise<number> {
    this.reads += 1;
    if (this.failure) return Promise.reject(this.failure);
    return Promise.resolve(this.settingMs);
  }
}

/** A lock session whose liveness the test flips. */
export class FakeOwnership {
  isAlive = true;
  alive(): boolean {
    return this.isAlive;
  }
}
