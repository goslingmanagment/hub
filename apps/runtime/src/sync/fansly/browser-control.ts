import {
  clearPageBrowserHaltMirror,
  finishPageBrowserCommand,
  isOwnerDecisionHalt,
  markPageBrowserCommandSent,
  readPageBrowserControl,
  releasePageBrowserCommand,
  takePageBrowserCommand,
  type Database,
  type PageBrowserCommandRow,
  type PageBrowserControlRead,
} from "@agency_hub_core/db";

import type { Command, CommandKind, CommandResult, State } from "../../services/egress/page-browser-protocol.ts";
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
//   (the exit closed for it, opened again after when it passes). A command
//   is marked sent before anything of it goes to the operator: one sent and
//   not answered ends `unknown` and is never sent again; one this owner was
//   superseded before sending is given back to the newer owner.
// - The owner's stop (`page_browsers.owner_stop_*`): while it stands the
//   operator is told `stopPage` until it says it stands stopped by the owner.
// - A page's slot on its browser starts it (`restartBrowser`) when it stands
//   — never started by this operator, or stopped by a leave or the owner's
//   stop since lifted — at the switch to `browser` and back.
//
// A halt for the owner's decision is the operator's (Astra round 3: it holds
// it on its volume, across restarts, and refuses every start and the exit's
// opening until it is cleared): the owner's start sends `clearHalt` naming the
// halt he decided on — the one Hub mirrored when he asked — in any mode and
// transport, during a login too, and then a start only if the guard lets it.
// Hub's mirror is never the enforcement.
//
// The guard (`browserStartRefusal`), read fresh right before each command
// that brings the browser up — `restartBrowser`, a self-test's `openExit` —
// of a slot, of the owner and of the login (PR 15's driver): never a page
// leaving its browser, or of a newer owner; never while the owner stopped it.
// A slot's start and the owner's: only a page on its browser, never while the
// owner paused the page or a login of its browser is open (Hub's
// `manual_login`, not only the operator's mode) — the login brings up the
// browser it needs itself, on Node or on its browser. A slot and the login
// do not ask a browser whose operator says it holds a halt (it would refuse:
// the login's own `login_required` aside).
//
// Nothing goes to the operator before its hand-over to this owner
// (`quiesced`), and nothing — a stop either, the owner's or kept — once Hub
// says a newer owner has the page or, on a login link, that the login ended:
// read fresh right before each command (the operator learns of a newer owner
// only at its hello). A leave of the browser keeps the owner's stop and
// nothing more: it starts nothing and takes no command. The link of a page on
// Node for its login (`role: "login"`) takes the owner's commands and keeps
// his stop, and starts nothing by itself.

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

/** The halt the owner's login decides (Fansly signed the browser out). */
const LOGIN_DECIDES = "login_required";

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

/** The browser stopped because Fansly signed it out: it stands for the
 *  owner's login, which may bring it up (plan §4.8 — «нужен вход», then the
 *  owner logs in on the live screen). */
export function browserStandsForLogin(state: State): boolean {
  return state.step === "exit_closed" && !state.exitOpen && state.retryAtWall === null && state.stopReason === LOGIN_DECIDES;
}

/** The halt the operator says it holds for the owner's decision (its
 *  volume's, minor 1), or — an operator from before — the stop it says. */
function operatorHalt(state: State): string | null {
  if (state.halt !== undefined) return state.halt?.reason ?? null;
  return isOwnerDecisionHalt(state) ? state.stopReason : null;
}

/**
 * Why the page's browser may not be brought up now (null: it may) — one guard
 * for the start of a slot (`who: "slot"`), the owner's own start (`who:
 * "owner"`, after his `clearHalt`) and the start the owner's open login asks
 * for (`who: "login"`, PR 15's driver: on Node or on its browser, under the
 * login's own pause), read fresh right before the command goes. A halt for the
 * owner's decision is the operator's to refuse; a slot and the login do not
 * ask while the operator says it holds one (but the login for its
 * `login_required`).
 */
export function browserStartRefusal(input: {
  control: PageBrowserControlRead | null;
  state: State | null;
  generation: bigint;
  who: "slot" | "owner" | "login";
}): string | null {
  const { control, state, who } = input;
  if (control === null) return "the page's browser serves no page";
  if (state === null) return "the operator cannot be reached";
  if (who === "login" && control.manualLogin !== "wanted") return `the login of the page's browser is not open (${control.manualLogin ?? "no engine row"})`;
  if (who !== "login" && control.transport !== "browser") return `the page is not on its browser (its transport is ${control.transport ?? "unknown"})`;
  if (control.leaveGeneration !== null) return "a leave of the page's browser is pending";
  if (control.ownerGeneration !== input.generation) return "this owner of the page was superseded";
  if (control.ownerStopAt !== null) return "the owner stopped the page's browser (sync browser start lifts the stop)";
  const halt = who === "owner" ? null : operatorHalt(state);
  if (halt !== null && !(who === "login" && halt === LOGIN_DECIDES)) return `the operator holds a halt for the owner's decision (${halt}): sync browser start`;
  // Hub's mirror (Astra round 4): a halt the operator said, kept until it
  // says it cleared that very one — one it lost (a restart, a full disk)
  // refuses here.
  const mirrored = who === "owner" ? null : control.haltReason;
  if (mirrored !== null && !(who === "login" && mirrored === LOGIN_DECIDES)) {
    return `Hub holds the halt the operator said (${mirrored}, ${control.haltId ?? "no id"}) until it is cleared: sync browser start`;
  }
  if (who === "login") return null;
  if (control.pausedAll) return "the page is paused (sync page resume --all)";
  if (control.manualLogin !== "off" || state.mode === "manual_login") return "a login of the page's browser is open: the login brings up the browser it needs";
  return null;
}

type CommandEnd = { outcome: "ok" | "failed" | "unknown"; detail: string | null };

/** A self-test's exit (the owner's command, PR 17) neither closed nor opened
 *  again while Hub mirrors a halt (Astra round 4). */
function mirroredHalt(control: PageBrowserControlRead | null): string | null {
  return control?.haltReason == null ? null : `Hub holds the halt the operator said (${control.haltReason}, ${control.haltId ?? "no id"}) until it is cleared: sync browser start`;
}

/** A command taken by this owner is not its own any more (a newer owner took
 *  it, or it ended): nothing more of it goes. */
class CommandNotOurs extends Error {}

export class BrowserControl {
  readonly #d: BrowserControlDeps;
  readonly #timing: BrowserControlTiming;
  #timer: ReturnType<typeof setInterval> | null = null;
  #tick: Promise<void> | null = null;
  #stopped = false;
  #nextStopMono = Number.NEGATIVE_INFINITY;
  /** The last `restartBrowser` this control sent (of either kind). */
  #lastStartMono = Number.NEGATIVE_INFINITY;

  constructor(deps: BrowserControlDeps) {
    this.#d = deps;
    this.#timing = { ...BROWSER_CONTROL_TIMING, ...deps.timing };
  }

  start(): void {
    if (this.#stopped || this.#timer !== null) return;
    this.#timer = setInterval(() => void this.tick(), this.#timing.everyMs);
    this.#timer.unref?.();
  }

  /** Stops looking; a look under way finishes. Never rejects. */
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
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
    // The owner's command first, in order.
    if (this.#d.role !== "leave") {
      const command = await takePageBrowserCommand(db, { pageId, profileId, generation });
      if (command !== null) {
        await this.#runTaken(command);
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
    const refusal = browserStartRefusal({ control: fresh, state: client.state, generation, who: "slot" });
    if (refusal !== null || this.#stopped) return;
    this.#lastStartMono = now;
    await this.#command("restartBrowser", "the page runs on its browser, which stands");
  }

  /** An owner's command this owner took: run, and ended once (Astra round 3:
   *  nothing stays taken) — or given back to a newer owner when nothing of it
   *  was sent. */
  async #runTaken(command: PageBrowserCommandRow): Promise<void> {
    const { db, generation, logger, pageId } = this.#d;
    const sent = { any: false };
    let end: CommandEnd | "superseded";
    try {
      end = await this.#run(command, sent);
    } catch (error) {
      if (error instanceof CommandNotOurs) return;
      end = { outcome: sent.any ? "unknown" : "failed", detail: `${sent.any ? "unknown" : "not run"}: ${errorName(error)}` };
    }
    if (end === "superseded") {
      await releasePageBrowserCommand(db, { id: command.id, generation });
      logger.info({ pageId, command: command.kind }, "Fansly sync browser: the owner's command is left to the page's newer owner");
      return;
    }
    await finishPageBrowserCommand(db, { id: command.id, generation, outcome: end.outcome, detail: end.detail });
    logger.info({ pageId, command: command.kind, by: command.requestedBy, outcome: end.outcome, detail: end.detail }, "Fansly sync browser: the owner's command ran");
  }

  /** An owner's command, run: its end, or `superseded` (nothing of it sent:
   *  left to the newer owner). */
  async #run(command: PageBrowserCommandRow, sent: { any: boolean }): Promise<CommandEnd | "superseded"> {
    const { db, profileId, generation } = this.#d;
    // Still this owner's page, still the login's link, read fresh (Astra
    // round 2): the operator learns of a newer owner only at its hello.
    const current = await readPageBrowserControl(db, { profileId });
    const stale = this.#stale(current);
    if (stale?.kind === "superseded") return "superseded";
    if (stale !== null) return { outcome: "failed", detail: `not run: ${stale.why}` };
    const answered = (result: CommandResult | null, what: string): CommandEnd =>
      result === null ? { outcome: "unknown", detail: `${what}: sent, no answer from the operator (not sent again)` } : { outcome: result.ok ? "ok" : "failed", detail: result.detail };
    switch (command.kind) {
      case "stopPage": {
        // Only while the owner's stop stands: a start since lifted it.
        if (current?.ownerStopAt == null) return { outcome: "failed", detail: "not run: the owner's stop was lifted (sync browser start)" };
        if (this.#d.client.state === null) return { outcome: "failed", detail: "not run: the operator cannot be reached" };
        return answered(await this.#send(command, sent, "stopPage", `the owner's stop (${command.requestedBy})`, command.commandId), "stopPage");
      }
      case "restartBrowser":
        return this.#ownersStart(command, sent, current!);
      case "clearHalt":
        // A profile no page has: its onboarding link's (never a page's slot).
        return { outcome: "failed", detail: "not run: a profile's clearHalt is its onboarding link's" };
      case "selfTest": {
        const state = this.#d.client.state;
        if (state === null) return { outcome: "failed", detail: "not run: the operator cannot be reached" };
        // The self-test runs with the exit closed (plan §4.1 step 5): closed
        // for it, opened again after when it was open and the test passed —
        // under the guard, read fresh then.
        const wasOpen = state.exitOpen;
        const steps: string[] = [];
        // An exit closed for the test is one the guard would let open again:
        // never closed for a page that could not have it back.
        if (wasOpen) {
          const fresh = await readPageBrowserControl(db, { profileId });
          const refusal = browserStartRefusal({ control: fresh, state, generation, who: "owner" }) ?? mirroredHalt(fresh);
          if (refusal !== null) return { outcome: "failed", detail: `not run: ${refusal}` };
          const closed = await this.#send(command, sent, "closeExit", "the owner's self-test", `${command.commandId}:closeExit`);
          steps.push(`closeExit: ${closed === null ? "no answer" : closed.detail ?? String(closed.ok)}`);
          if (closed === null) return { outcome: "unknown", detail: steps.join("; ") };
          if (!closed.ok) return { outcome: "failed", detail: steps.join("; ") };
        }
        const tested = await this.#send(command, sent, "selfTest", "the owner's self-test", `${command.commandId}:selfTest`);
        steps.push(`selfTest: ${tested === null ? "no answer" : tested.detail ?? String(tested.ok)}`);
        if (tested === null) return { outcome: "unknown", detail: steps.join("; ") };
        if (!tested.ok || !wasOpen) return { outcome: tested.ok ? "ok" : "failed", detail: steps.join("; ") };
        const fresh = await readPageBrowserControl(db, { profileId });
        const refusal = browserStartRefusal({ control: fresh, state: this.#d.client.state, generation, who: "owner" }) ?? mirroredHalt(fresh);
        if (refusal !== null) {
          steps.push(`openExit: not run: ${refusal}`);
          return { outcome: "failed", detail: steps.join("; ") };
        }
        const opened = await this.#send(command, sent, "openExit", "the owner's self-test passed", `${command.commandId}:openExit`);
        steps.push(`openExit: ${opened === null ? "no answer" : opened.detail ?? String(opened.ok)}`);
        return { outcome: opened === null ? "unknown" : opened.ok ? "ok" : "failed", detail: steps.join("; ") };
      }
    }
  }

  /** The owner's start (`sync browser start`, audited): the halt he decided
   *  on cleared at the operator — whatever the mode and the transport, a
   *  login's included — then the start, if the guard lets it; while a login
   *  is open the login brings the browser up. */
  async #ownersStart(command: PageBrowserCommandRow, sent: { any: boolean }, current: PageBrowserControlRead): Promise<CommandEnd> {
    const { db, profileId, generation } = this.#d;
    const steps: string[] = [];
    const state = this.#d.client.state;
    if (state === null) return { outcome: "failed", detail: "not run: the operator cannot be reached" };
    if (command.haltId !== null) {
      if (state.halt === undefined) {
        steps.push("clearHalt: not sent (this operator holds no halt on its volume: an image from before)");
      } else {
        const cleared = await this.#send(command, sent, { kind: "clearHalt", haltId: command.haltId }, `the owner's start (${command.requestedBy})`, `${command.commandId}:clearHalt`);
        steps.push(`clearHalt ${command.haltId}: ${cleared === null ? "no answer" : cleared.detail ?? String(cleared.ok)}`);
        if (cleared === null) return { outcome: "unknown", detail: steps.join("; ") };
        if (!cleared.ok) return { outcome: "failed", detail: steps.join("; ") };
      }
      // The owner's decision on that halt: Hub's mirror of it goes with it, in
      // the same flow (Astra round 4: it refuses starts until then).
      if (await clearPageBrowserHaltMirror(db, { profileId, haltId: command.haltId })) steps.push(`Hub's mirror of halt ${command.haltId} cleared`);
    }
    if (current.manualLogin === "wanted") {
      steps.push("restartBrowser: not here — the open login of the page's browser brings it up");
      return { outcome: "ok", detail: steps.join("; ") };
    }
    const fresh = this.#d.client.state;
    const refusal = browserStartRefusal({ control: await readPageBrowserControl(db, { profileId }), state: fresh, generation, who: "owner" });
    if (refusal !== null) {
      steps.push(`restartBrowser: not run: ${refusal}`);
      return { outcome: "failed", detail: steps.join("; ") };
    }
    if (fresh!.step !== "exit_closed" || fresh!.exitOpen) {
      steps.push(`restartBrowser: not needed: the browser is up or starting (${fresh!.step})`);
      return { outcome: "ok", detail: steps.join("; ") };
    }
    this.#lastStartMono = this.#d.clock.monoNow();
    const started = await this.#send(command, sent, "restartBrowser", `the owner's start (${command.requestedBy})`, command.commandId);
    steps.push(`restartBrowser: ${started === null ? "no answer" : started.detail ?? String(started.ok)}`);
    return { outcome: started === null ? "unknown" : started.ok ? "ok" : "failed", detail: steps.join("; ") };
  }

  /** A part of an owner's command to the operator: the command marked sent
   *  first (by this owner; else nothing goes — `CommandNotOurs`). */
  async #send(command: PageBrowserCommandRow, sent: { any: boolean }, kind: CommandKind | Exclude<Command["command"], { kind: CommandKind }>, why: string, commandId: string): Promise<CommandResult | null> {
    if (!sent.any) {
      if (!(await markPageBrowserCommandSent(this.#d.db, { id: command.id, generation: this.#d.generation }))) throw new CommandNotOurs();
      sent.any = true;
    }
    return this.#command(kind, why, commandId);
  }

  async #command(kind: CommandKind | Exclude<Command["command"], { kind: CommandKind }>, why: string, commandId?: string): Promise<CommandResult | null> {
    const { client, bridge, clock, logger, metrics, pageId } = this.#d;
    const waitMs = this.#timing.commandWaitMs;
    const name = typeof kind === "string" ? kind : kind.kind;
    const result = await client.command(kind, bridge.toKernel(clock.monoNow() + waitMs), waitMs, ...(commandId === undefined ? [] : [commandId]));
    metrics.increment("sync_browser_command", { pageId, kind: name, ok: result?.ok === true ? "yes" : result === null ? "unknown" : "no" });
    logger.info({ pageId, kind: name, why, ok: result?.ok ?? null, detail: result?.detail ?? null }, "Fansly sync browser: a command to the page's operator");
    return result;
  }
}
