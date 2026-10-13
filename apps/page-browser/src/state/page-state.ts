// Where the page is in its start (plan §4.1) and why it stands. Every change
// is a transition with its reason: the operator journals it and sends it to
// the engine (`state`, plan §4.13).
//
// - A start goes up the steps one by one, never skipping one.
// - A failure on any step sends the page back to the first step with a stop
//   reason, and a retry after the growing pause of plan §4.1.
// - A halt is a stop that holds until the engine starts the page again
//   (`restartBrowser`): the owner's stop, or what only the owner can decide
//   (a changed exit IP). Nothing of it is kept on disk: an operator or a
//   container that starts again stands until the engine starts it (stage 1,
//   amendment 17), so no failed write can turn a stop into a start.

import { atLeast, restartDelayMs, RESTART_BACKOFF_MS, stepIndex, type Step, type StopReason } from "./steps.ts";

export interface PageSnapshot {
  step: Step;
  stopReason: StopReason | null;
  retryAtWall: number | null;
  /** Stands until the engine's restartBrowser. */
  halted: boolean;
}

export interface Transition {
  from: Step;
  to: Step;
  stopReason: StopReason | null;
  retryAtWall: number | null;
  halted: boolean;
  /** Why, in words (no secrets: it goes to the journal). */
  note: string;
}

export interface PageStateOptions {
  backoffMs?: readonly number[];
  /** A page that kept its exit open this long starts its next failure at the
   *  first rung of the ladder again. */
  healthyAfterMs?: number;
  now?: () => number;
}

export class PageState {
  #step: Step = "exit_closed";
  #stopReason: StopReason | null = null;
  #retryAtWall: number | null = null;
  #halted = false;
  #failures = 0;
  #upSince: number | null = null;
  #backoff: readonly number[];
  readonly #healthyAfterMs: number;
  readonly #now: () => number;
  onTransition: (transition: Transition) => void = () => undefined;

  constructor(options: PageStateOptions = {}) {
    this.#backoff = options.backoffMs ?? RESTART_BACKOFF_MS;
    this.#healthyAfterMs = options.healthyAfterMs ?? 5 * 60_000;
    this.#now = options.now ?? Date.now;
  }

  /** The retry ladder (the engine's params, plan §4.14). */
  setBackoff(ladder: readonly number[]): void {
    if (ladder.length > 0) this.#backoff = [...ladder];
  }

  get snapshot(): PageSnapshot {
    return { step: this.#step, stopReason: this.#stopReason, retryAtWall: this.#retryAtWall, halted: this.#halted };
  }

  get step(): Step {
    return this.#step;
  }

  get halted(): boolean {
    return this.#halted;
  }

  get failures(): number {
    return this.#failures;
  }

  /** A start from step 1, by the engine's command or a scheduled retry. An
   *  explicit start (`fresh`) also clears the failure count. */
  beginStart(note: string, fresh: boolean): void {
    if (fresh) this.#failures = 0;
    this.#set("exit_closed", null, null, false, note);
  }

  /** The next step, and only the next one. */
  advance(to: Step, note = ""): void {
    if (this.#halted) throw new Error(`the page is halted (${this.#stopReason ?? "?"}): no step ${to}`);
    if (stepIndex(to) !== stepIndex(this.#step) + 1) throw new Error(`step ${to} does not follow ${this.#step}`);
    if (to === "exit_open") this.#upSince = this.#now();
    this.#set(to, null, null, false, note);
  }

  /** The exit closed on the engine's command: the page keeps what it
   *  verified and goes back below the open exit. */
  exitClosed(note: string): void {
    if (!atLeast(this.#step, "exit_open")) return;
    this.#upSince = null;
    this.#set("exit_ip_verified", null, null, false, note);
  }

  /** Back to a lower step the page still stands on, at or above the open
   *  exit (plan §4.1, steps 8–10): the site's session changed (back to
   *  `site_loaded`), the site is loaded anew (back to `exit_open`). */
  back(to: Step, note: string): void {
    if (this.#halted || !atLeast(to, "exit_open") || stepIndex(to) >= stepIndex(this.#step)) return;
    this.#set(to, null, null, false, note);
  }

  /** A failure: back to step 1, a retry after the backoff. Returns the
   *  moment of the retry (wall clock). */
  fail(reason: StopReason, note: string): number {
    if (this.#upSince !== null && this.#now() - this.#upSince >= this.#healthyAfterMs) this.#failures = 0;
    this.#upSince = null;
    this.#failures += 1;
    const retryAtWall = this.#now() + restartDelayMs(this.#failures, this.#backoff);
    this.#set("exit_closed", reason, retryAtWall, false, note);
    return retryAtWall;
  }

  /** Back to step 1 with nothing failed: the page stands until the engine
   *  starts it (a start that a new owner of the page ended). */
  stand(note: string): void {
    this.#upSince = null;
    this.#set("exit_closed", null, null, false, note);
  }

  /** A stop that holds until the engine starts the page again. */
  halt(reason: StopReason, note: string): void {
    this.#upSince = null;
    this.#set("exit_closed", reason, null, true, note);
  }

  #set(step: Step, stopReason: StopReason | null, retryAtWall: number | null, halted: boolean, note: string): void {
    const from = this.#step;
    if (from === step && this.#stopReason === stopReason && this.#retryAtWall === retryAtWall && this.#halted === halted) return;
    this.#step = step;
    this.#stopReason = stopReason;
    this.#retryAtWall = retryAtWall;
    this.#halted = halted;
    this.onTransition({ from, to: step, stopReason, retryAtWall, halted, note });
  }
}

