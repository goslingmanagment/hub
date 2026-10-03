import { writeSync } from "node:fs";

import type { Clock } from "./ports.ts";

// The `sync` process's stall watchdog (step 4, 4-3, layer 1). The pool's
// timeouts (layer 0, `sync/context.ts`) turn a hung database call into an error
// the engine already handles; what is left is a promise that never settles —
// an actor's step, a pass of the host's mode loop, a heartbeat beat, an alert
// pass. Each of them reports its progress here; one that has not moved for
// `SYNC_STALL_AFTER_MS` stops the process: one line on stderr, a best-effort
// `process` incident, `process.exit(70)`. Docker restarts the container
// (`restart: unless-stopped`); node is PID 1 there, so a SIGKILL sent to itself
// would do nothing, and a stalled process is never trusted to stop gracefully.
//
// Nothing changes in ownership: the advisory locks go with the process and no
// safe release is written (fail closed); the restarted container takes its
// pages back by the OS proof (a new pid namespace under the same container
// id), and the first send waits 1.2 × S after every send the database knows
// (I5); an attempt left in flight is closed `unknown`.

/** A tracker that has not moved for this long is a stall. The longest
 *  legitimate phase is ≈ 72 s: a pacer wait of 1.2 × S at the largest S
 *  (60 s), a 20 s request, a 60 s statement (the pool's `statement_timeout`). */
export const SYNC_STALL_AFTER_MS = 120_000;
/** How often the watchdog looks. */
export const SYNC_STALL_CHECK_MS = 5_000;
/** The incident write before the exit is cut off after this long. */
export const SYNC_STALL_REPORT_TIMEOUT_MS = 2_000;
/** EX_SOFTWARE: the exit code of a stall. */
export const SYNC_STALL_EXIT_CODE = 70;

export type StallComponent = "actor" | "host" | "heartbeat" | "alerts";

/** What a tracker watches: an actor (its page and owner generation), a pass
 *  of the host's mode loop, a heartbeat beat or an alert pass. */
export interface StallSubject {
  component: StallComponent;
  pageId?: number;
  generation?: bigint;
}

export interface StallTracker {
  /** The tracked work moved on (to `phase`): its age starts again. */
  progress(phase: string): void;
  /** The tracked work ended; it is no longer watched. */
  done(): void;
}

/** What the components the watchdog watches are given. */
export interface StallTracking {
  track(subject: StallSubject, phase: string): StallTracker;
}

export const noStallTracker: StallTracker = {
  progress: () => undefined,
  done: () => undefined,
};

/** The oldest stale tracker (what stderr and the incident say). */
export interface SyncStall {
  component: StallComponent;
  pageId: number | null;
  /** The owner generation, as text (JSON has no bigint). */
  generation: string | null;
  phase: string;
  ageMs: number;
  /** Trackers stale at the same check, this one included. */
  stale: number;
}

export interface SyncStallWatchdogOptions {
  /** Ages are measured on its monotonic clock. Default: `performance.now()`. */
  clock?: Pick<Clock, "monoNow">;
  /** Default: `process.exit`. */
  exit?: (code: number) => void;
  /** One line, written synchronously so it survives the exit. Default: fd 2. */
  writeStderr?: (line: string) => void;
  /** The best-effort incident (main.ts: through a client of its own). */
  report?: (stall: SyncStall) => Promise<void>;
  staleAfterMs?: number;
  checkEveryMs?: number;
  reportTimeoutMs?: number;
}

interface Tracked {
  subject: StallSubject;
  phase: string;
  sinceMono: number;
}

const monotonic: Pick<Clock, "monoNow"> = { monoNow: () => performance.now() };

function writeToStderr(line: string): void {
  writeSync(2, line);
}

export class SyncStallWatchdog implements StallTracking {
  readonly #clock: Pick<Clock, "monoNow">;
  readonly #exit: (code: number) => void;
  readonly #writeStderr: (line: string) => void;
  readonly #report: ((stall: SyncStall) => Promise<void>) | null;
  readonly #staleAfterMs: number;
  readonly #checkEveryMs: number;
  readonly #reportTimeoutMs: number;
  readonly #tracked = new Set<Tracked>();
  #timer: ReturnType<typeof setInterval> | null = null;
  #stopped = false;
  #exiting: Promise<void> | null = null;

  constructor(options: SyncStallWatchdogOptions = {}) {
    this.#clock = options.clock ?? monotonic;
    this.#exit = options.exit ?? ((code) => process.exit(code));
    this.#writeStderr = options.writeStderr ?? writeToStderr;
    this.#report = options.report ?? null;
    this.#staleAfterMs = options.staleAfterMs ?? SYNC_STALL_AFTER_MS;
    this.#checkEveryMs = options.checkEveryMs ?? SYNC_STALL_CHECK_MS;
    this.#reportTimeoutMs = options.reportTimeoutMs ?? SYNC_STALL_REPORT_TIMEOUT_MS;
  }

  /** The exit under way (null: none); tests await it. */
  get exiting(): Promise<void> | null {
    return this.#exiting;
  }

  /** Trackers watched now (tests). */
  get tracked(): number {
    return this.#tracked.size;
  }

  track(subject: StallSubject, phase: string): StallTracker {
    if (this.#stopped) return noStallTracker;
    const entry: Tracked = { subject, phase, sinceMono: this.#clock.monoNow() };
    this.#tracked.add(entry);
    return {
      progress: (next) => {
        entry.phase = next;
        entry.sinceMono = this.#clock.monoNow();
      },
      done: () => {
        this.#tracked.delete(entry);
      },
    };
  }

  /** Look every `checkEveryMs` (the timer never keeps the process alive). */
  start(): void {
    if (this.#stopped || this.#timer !== null) return;
    this.#timer = setInterval(() => void this.check(), this.#checkEveryMs);
    this.#timer.unref?.();
  }

  /** The process is stopping (`runtime.stop()` began): nothing is watched any
   *  more. An exit already under way goes on. */
  stop(): void {
    this.#stopped = true;
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    this.#tracked.clear();
  }

  /** One look: the oldest stale tracker, whose exit has begun, or null. */
  check(): SyncStall | null {
    if (this.#stopped || this.#exiting !== null) return null;
    const now = this.#clock.monoNow();
    let oldest: Tracked | null = null;
    let stale = 0;
    for (const entry of this.#tracked) {
      if (now - entry.sinceMono < this.#staleAfterMs) continue;
      stale += 1;
      if (oldest === null || entry.sinceMono < oldest.sinceMono) oldest = entry;
    }
    if (oldest === null) return null;
    const stall: SyncStall = {
      component: oldest.subject.component,
      pageId: oldest.subject.pageId ?? null,
      generation: oldest.subject.generation === undefined ? null : oldest.subject.generation.toString(),
      phase: oldest.phase,
      ageMs: Math.round(now - oldest.sinceMono),
      stale,
    };
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    this.#exiting = this.#exitFor(stall);
    return stall;
  }

  async #exitFor(stall: SyncStall): Promise<void> {
    try {
      this.#writeStderr(`${JSON.stringify({ msg: "Fansly sync: stalled; exiting for a restart", ...stall })}\n`);
    } catch {
      // The exit below is what matters.
    }
    if (this.#report !== null) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this.#report(stall).catch(() => undefined),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, this.#reportTimeoutMs);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
    this.#exit(SYNC_STALL_EXIT_CODE);
  }
}
