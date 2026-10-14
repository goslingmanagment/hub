import {
  finishPageBrowserCommand,
  isOwnerDecisionHalt,
  LOGIN_DECIDES_HALT,
  readPageBrowserControl,
  stricterHalt,
  takePageBrowserCommand,
  type Database,
  type PageBrowserCommandRow,
  type PageBrowserControlRead,
} from "@agency_hub_core/db";

import type { CommandKind, CommandResult, State } from "../../services/egress/page-browser-protocol.ts";
import type { MonoBridge, PageBrowserRpcClient } from "../../services/egress/page-browser-rpc.ts";
import { errorName, type SyncLogger } from "../engine/commit.ts";
import type { Clock, Metrics } from "../engine/ports.ts";

// The owner's levers on a page's browser, carried out by the page's current
// owner over its link — the only one that may command its browser (Project
// Browser plan §4.8, §4.11, §4.13; stage 3 PR 17):
//
// - The owner's commands (`page_browser_commands`), first, each taken by
//   this owner and run once by its id: a stop (`stopPage` — the operator
//   answers once Chrome is down, so its answer is the stop's confirmation,
//   bound to the command and this owner's generation), a start, a self-test
//   (the exit closed for it, opened again after when it passes).
// - The owner's stop (`page_browsers.owner_stop_*`): while it stands the
//   operator is told `stopPage` until it says it stands stopped by the owner.
// - A page's slot on its browser starts it (`restartBrowser`) when it stands
//   — never started by this operator, or stopped by a leave or the owner's
//   stop since lifted — at the switch to `browser` and back.
//
// One guard (`browserStartRefusal`), read fresh right before each command
// that brings the browser up — `restartBrowser`, a self-test's `openExit`;
// the start of a slot, the owner's start and the login's (PR 15's driver)
// alike: never a page leaving its browser, or of a newer owner; never while
// the owner stopped it; never a browser halted for the owner's decision. That
// halt is latched in Hub (`halt_reason`, written by the recorder when it
// hears it, lifted by the owner's audited `sync browser start` — and a
// `login_required` by his successful login; a stricter halt replaces a
// latched `login_required`, never the reverse): an operator that starts again
// stands with no reason and knows nothing of it. Until the latch holds it,
// the halt this control heard on its link holds its own starts and its
// login's too; and the halt the operator says right now holds every start
// but the owner's.
// A slot's start and the owner's: only a page on its browser, never while the
// owner paused the page or a login of its browser is open (Hub's
// `manual_login`, not only the operator's mode) — the login brings up the
// browser it needs itself: a merely stopped one, or one stopped because
// Fansly signed it out (`login_required`: the login is the owner's decision
// it waits for), on Node or on its browser.
//
// Nothing goes to the operator before its hand-over to this owner
// (`quiesced`), and nothing — a stop either, the owner's or kept — once Hub
// says a newer owner has the page or, on a login link, that the login ended:
// read fresh right before each command (the operator learns of a newer owner
// only at its hello). A superseded owner leaves the owner's command to the
// newer one. A leave of the browser keeps the owner's stop and nothing
// more: it starts nothing and takes no command. The link of a page on Node
// for its login (`role: "login"`) takes the owner's commands and keeps his
// stop, and starts nothing by itself.

export interface BrowserControlTiming {
  /** How often the owner's levers are looked at. */
  everyMs: number;
  /** `stopPage` again while the operator does not say it stopped. */
  stopEveryMs: number;
  /** `restartBrowser` again while the browser still stands. */
  startEveryMs: number;
  /** A command's wait for its result (and its deadline at the operator). */
  commandWaitMs: number;
}

export const BROWSER_CONTROL_TIMING: Readonly<BrowserControlTiming> = Object.freeze({
  everyMs: 2_000,
  stopEveryMs: 5_000,
  startEveryMs: 30_000,
  commandWaitMs: 15_000,
});

export interface BrowserControlDeps {
  db: Database;
  pageId: number;
  profileId: string;
  /** The owner generation of the link: the commands it takes are its own. */
  generation: bigint;
  client: PageBrowserRpcClient;
  bridge: MonoBridge;
  clock: Clock;
  logger: SyncLogger;
  metrics: Metrics;
  /** `slot`: the page's slot on its browser; `leave`: a leave of it;
   *  `login`: the link of a page on Node for the owner's login (PR 15). */
  role: "slot" | "leave" | "login";
  timing?: Partial<BrowserControlTiming>;
}

/** The browser stands, waiting for a start: not in a failure's backoff, and
 *  not halted for the owner's decision — only stopped, or never started. */
export function browserStands(state: State): boolean {
  return state.step === "exit_closed" && !state.exitOpen && state.retryAtWall === null
    && (state.stopReason === null || state.stopReason === "owner_stop");
}

/** The operator says it stands stopped by the engine's `stopPage`. */
export function browserStoppedByOwner(state: State): boolean {
  return state.step === "exit_closed" && !state.exitOpen && state.stopReason === "owner_stop";
}

const LOGIN_DECIDES = LOGIN_DECIDES_HALT;

/** Hub's latch already holds what this control heard: the same halt, or a
 *  stricter one (`stricterHalt`) — a latched `login_required` holds no other. */
function latchCovers(latched: string | null, heard: string | null): boolean {
  return latched !== null && heard !== null && stricterHalt(latched, heard) === latched;
}

/** The browser stopped because Fansly signed it out: it stands for the
 *  owner's login, which may bring it up (plan §4.8 — «нужен вход», then the
 *  owner logs in on the live screen). */
export function browserStandsForLogin(state: State): boolean {
  return state.step === "exit_closed" && !state.exitOpen && state.retryAtWall === null && state.stopReason === LOGIN_DECIDES;
}

/**
 * Why the page's browser may not be brought up now (null: it may) — one guard
 * for the start of a slot (`who: "slot"`, which also respects a halt it heard
 * itself and not yet read back), the owner's own start (`who: "owner"`: his
 * start lifted the stop and the latch it names, in its transaction) and the
 * start the owner's open login asks for (`who: "login"`, PR 15's driver: on
 * Node or on its browser, under the login's own pause; a `login_required`
 * halt is the one it decides), read fresh right before the command goes.
 */
export function browserStartRefusal(input: {
  control: PageBrowserControlRead | null;
  state: State | null;
  generation: bigint;
  who: "slot" | "owner" | "login";
  /** A halt for the owner's decision this control heard on its link. */
  haltHeard?: string | null;
}): string | null {
  const { control, state, who } = input;
  if (control === null) return "the page's browser serves no page";
  if (state === null) return "the operator cannot be reached";
  if (who === "login" && control.manualLogin !== "wanted") return `the login of the page's browser is not open (${control.manualLogin ?? "no engine row"})`;
  if (who !== "login" && control.transport !== "browser") return `the page is not on its browser (its transport is ${control.transport ?? "unknown"})`;
  if (control.leaveGeneration !== null) return "a leave of the page's browser is pending";
  if (control.ownerGeneration !== input.generation) return "this owner of the page was superseded";
  if (control.ownerStopAt !== null) return "the owner stopped the page's browser (sync browser start lifts the stop)";
  if (control.haltReason !== null && !(who === "login" && control.haltReason === LOGIN_DECIDES)) {
    return `the browser stands for the owner's decision (${control.haltReason}): sync browser start`;
  }
  const heard = input.haltHeard ?? null;
  if (who !== "owner" && heard !== null && !(who === "login" && heard === LOGIN_DECIDES)) {
    return `the browser stands for the owner's decision (${heard}): sync browser start`;
  }
  // What the operator says right now (Astra round 2): a halt said while the
  // latch was being read is not started past.
  if (who !== "owner" && isOwnerDecisionHalt(state) && !(who === "login" && state.stopReason === LOGIN_DECIDES)) {
    return `the browser stands for the owner's decision (${state.stopReason!}): sync browser start`;
  }
  if (who === "login") return null;
  if (control.pausedAll) return "the page is paused (sync page resume --all)";
  if (control.manualLogin !== "off" || state.mode === "manual_login") return "a login of the page's browser is open: the login brings up the browser it needs";
  return null;
}

export class BrowserControl {
  readonly #d: BrowserControlDeps;
  readonly #timing: BrowserControlTiming;
  readonly #unlisten: Array<() => void> = [];
  #timer: ReturnType<typeof setInterval> | null = null;
  #tick: Promise<void> | null = null;
  #stopped = false;
  #nextStopMono = Number.NEGATIVE_INFINITY;
  /** The last `restartBrowser` this control sent (of either kind). */
  #lastStartMono = Number.NEGATIVE_INFINITY;
  /** A halt for the owner's decision heard on the link, until the latch in
   *  Hub is read back (or the owner's start ran). */
  #haltHeard: string | null = null;

  constructor(deps: BrowserControlDeps) {
    this.#d = deps;
    this.#timing = { ...BROWSER_CONTROL_TIMING, ...deps.timing };
  }

  start(): void {
    if (this.#stopped || this.#timer !== null) return;
    this.#unlisten.push(this.#d.client.onState((state) => this.#heard(state)));
    const state = this.#d.client.state;
    if (state !== null) this.#heard(state);
    this.#timer = setInterval(() => void this.tick(), this.#timing.everyMs);
    this.#timer.unref?.();
  }

  /** Stops looking; a look under way finishes. Never rejects. */
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    for (const unlisten of this.#unlisten.splice(0)) unlisten();
    await this.#tick?.catch(() => undefined);
  }

  /** One look now (the timer; tests): a look under way is joined. */
  tick(): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    this.#tick ??= this.#look()
      .catch((error: unknown) => {
        this.#d.logger.warn({ pageId: this.#d.pageId, err: errorName(error) }, "Fansly sync browser: a look at the owner's levers failed");
      })
      .finally(() => {
        this.#tick = null;
      });
    return this.#tick;
  }

  /** A halt for the owner's decision heard on the link and not yet read
   *  back from Hub's latch (null: none) — the login driver's too. */
  get haltHeard(): string | null {
    return this.#haltHeard;
  }

  #heard(state: State): void {
    // The stricter one holds: a halt heard after a `login_required` is never
    // hidden behind it (Astra round 2).
    if (isOwnerDecisionHalt(state)) this.#haltHeard = stricterHalt(this.#haltHeard, state.stopReason);
  }

  /** Why this control no longer speaks for the page's owner, read fresh
   *  (Astra round 2) — null: it does. `superseded`: a newer owner has the
   *  page (its commands are left to it); `over`: the login this link was
   *  opened for ended (a login link's). */
  #stale(control: PageBrowserControlRead | null): { kind: "superseded" | "over"; why: string } | null {
    if (control === null || control.pageId !== this.#d.pageId) return { kind: "over", why: "the page's browser serves no page" };
    if (control.ownerGeneration !== this.#d.generation) return { kind: "superseded", why: "this owner of the page was superseded" };
    if (this.#d.role === "login" && (control.manualLogin === "off" || control.manualLogin === null)) {
      return { kind: "over", why: "the login of the page's browser is over" };
    }
    return null;
  }

  async #look(): Promise<void> {
    const { client, db, profileId, pageId, generation } = this.#d;
    // Nothing goes to the operator before its hand-over to this owner.
    if (client.state === null || client.quiesced === null) return;
    const control = await readPageBrowserControl(db, { profileId });
    // Nothing of a superseded owner, or of a login link whose login ended.
    if (control === null || this.#stale(control) !== null || this.#stopped) return;
    // Hub's latch is read back: it governs from now on, once it holds what
    // was heard.
    if (latchCovers(control.haltReason, this.#haltHeard)) this.#haltHeard = null;
    // The owner's command first, in order.
    if (this.#d.role !== "leave") {
      const command = await takePageBrowserCommand(db, { pageId, profileId, generation });
      if (command !== null) {
        let outcome: { ok: boolean; detail: string | null } | null;
        try {
          outcome = await this.#run(command);
        } catch (error) {
          outcome = { ok: false, detail: `not run: ${errorName(error)}` };
        }
        // Left to the page's newer owner, which takes it again.
        if (outcome === null) return;
        await finishPageBrowserCommand(db, { id: command.id, generation, ok: outcome.ok, detail: outcome.detail });
        this.#d.logger.info({ pageId, command: command.kind, by: command.requestedBy, ok: outcome.ok, detail: outcome.detail },
          "Fansly sync browser: the owner's command ran");
        return;
      }
    }
    const state = client.state;
    if (state === null || this.#stopped) return;
    const now = this.#d.clock.monoNow();
    if (control.ownerStopAt !== null) {
      if (!browserStoppedByOwner(state) && now >= this.#nextStopMono) {
        // Read fresh right before it goes: still the owner's stop, still this
        // owner's page, still the login's link (Astra round 2).
        const fresh = await readPageBrowserControl(db, { profileId });
        if (fresh === null || this.#stale(fresh) !== null || fresh.ownerStopAt === null || this.#stopped) return;
        this.#nextStopMono = now + this.#timing.stopEveryMs;
        await this.#command("stopPage", "the owner stopped the page's browser");
      }
      return;
    }
    if (this.#d.role !== "slot" || !browserStands(state) || now - this.#lastStartMono < this.#timing.startEveryMs) return;
    // The guard, read fresh right before the start.
    const fresh = await readPageBrowserControl(db, { profileId });
    const refusal = browserStartRefusal({ control: fresh, state: client.state, generation, who: "slot", haltHeard: this.#haltHeard });
    if (refusal !== null || this.#stopped) return;
    this.#lastStartMono = now;
    await this.#command("restartBrowser", "the page runs on its browser, which stands");
  }

  /** An owner's command, run (null: left to the page's newer owner). */
  async #run(command: PageBrowserCommandRow): Promise<{ ok: boolean; detail: string | null } | null> {
    const { db, profileId, generation } = this.#d;
    // Still this owner's page, still the login's link, read fresh (Astra
    // round 2): the operator learns of a newer owner only at its hello.
    const current = await readPageBrowserControl(db, { profileId });
    const stale = this.#stale(current);
    if (stale?.kind === "superseded") return null;
    if (stale !== null) return { ok: false, detail: `not run: ${stale.why}` };
    switch (command.kind) {
      case "stopPage": {
        // Only while the owner's stop stands: a start since lifted it.
        if (current?.ownerStopAt == null) return { ok: false, detail: "not run: the owner's stop was lifted (sync browser start)" };
        if (this.#d.client.state === null) return { ok: false, detail: "not run: the operator cannot be reached" };
        const result = await this.#command("stopPage", `the owner's stop (${command.requestedBy})`, command.commandId);
        return result === null ? { ok: false, detail: "no answer from the operator" } : { ok: result.ok, detail: result.detail };
      }
      case "restartBrowser": {
        const state = this.#d.client.state;
        const refusal = browserStartRefusal({ control: await readPageBrowserControl(db, { profileId }), state, generation, who: "owner" });
        if (refusal !== null) return { ok: false, detail: `not run: ${refusal}` };
        if (state!.step !== "exit_closed" || state!.exitOpen) return { ok: true, detail: `not needed: the browser is up or starting (${state!.step})` };
        this.#lastStartMono = this.#d.clock.monoNow();
        const result = await this.#command("restartBrowser", `the owner's start (${command.requestedBy})`, command.commandId);
        // The owner decided: a halt this control heard is his to have lifted.
        if (result?.ok === true) this.#haltHeard = null;
        return result === null ? { ok: false, detail: "no answer from the operator" } : { ok: result.ok, detail: result.detail };
      }
      case "selfTest": {
        const state = this.#d.client.state;
        if (state === null) return { ok: false, detail: "not run: the operator cannot be reached" };
        // The self-test runs with the exit closed (plan §4.1 step 5): closed
        // for it, opened again after when it was open and the test passed —
        // under the guard, read fresh then.
        const wasOpen = state.exitOpen;
        const steps: string[] = [];
        // An exit closed for the test is one the guard would let open again:
        // never closed for a page that could not have it back.
        if (wasOpen) {
          const refusal = browserStartRefusal({ control: await readPageBrowserControl(db, { profileId }), state, generation, who: "owner" });
          if (refusal !== null) return { ok: false, detail: `not run: ${refusal}` };
        }
        if (wasOpen) {
          const closed = await this.#command("closeExit", "the owner's self-test", `${command.commandId}:closeExit`);
          steps.push(`closeExit: ${closed === null ? "no answer" : closed.detail ?? String(closed.ok)}`);
          if (closed?.ok !== true) return { ok: false, detail: steps.join("; ") };
        }
        const tested = await this.#command("selfTest", "the owner's self-test", `${command.commandId}:selfTest`);
        steps.push(`selfTest: ${tested === null ? "no answer" : tested.detail ?? String(tested.ok)}`);
        let ok = tested?.ok === true;
        if (wasOpen && ok) {
          const refusal = browserStartRefusal({
            control: await readPageBrowserControl(db, { profileId }), state: this.#d.client.state, generation, who: "owner",
          });
          if (refusal !== null) {
            steps.push(`openExit: not run: ${refusal}`);
            ok = false;
          } else {
            const opened = await this.#command("openExit", "the owner's self-test passed", `${command.commandId}:openExit`);
            steps.push(`openExit: ${opened === null ? "no answer" : opened.detail ?? String(opened.ok)}`);
            ok = opened?.ok === true;
          }
        }
        return { ok, detail: steps.join("; ") };
      }
    }
  }

  async #command(kind: CommandKind, why: string, commandId?: string): Promise<CommandResult | null> {
    const { client, bridge, clock, logger, metrics, pageId } = this.#d;
    const waitMs = this.#timing.commandWaitMs;
    const result = await client.command(kind, bridge.toKernel(clock.monoNow() + waitMs), waitMs, ...(commandId === undefined ? [] : [commandId]));
    metrics.increment("sync_browser_command", { pageId, kind, ok: result?.ok === true ? "yes" : result === null ? "unknown" : "no" });
    logger.info({ pageId, kind, why, ok: result?.ok ?? null, detail: result?.detail ?? null }, "Fansly sync browser: a command to the page's operator");
    return result;
  }
}
