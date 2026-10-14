import {
  finishPageBrowserCommand,
  readPageBrowserControl,
  takePageBrowserCommand,
  type Database,
  type PageBrowserCommandRow,
} from "@agency_hub_core/db";

import type { CommandKind, CommandResult, State } from "../../services/egress/page-browser-protocol.ts";
import type { MonoBridge, PageBrowserRpcClient } from "../../services/egress/page-browser-rpc.ts";
import { errorName, type SyncLogger } from "../engine/commit.ts";
import type { Clock, Metrics } from "../engine/ports.ts";

// The owner's levers on a page's browser, carried out by the page's current
// owner over its link — the only one that may command its browser (Project
// Browser plan §4.8, §4.11, §4.13; stage 3 PR 17):
//
// - The owner's stop (`sync browser stop`, `page_browsers.owner_stop_*`):
//   while it stands the operator is told `stopPage` — its exit closed first,
//   then Chrome — until it says it stands stopped by the owner.
// - A page's slot on its browser starts it (`restartBrowser`) when it stands
//   — never started by this operator, or stopped by a leave or the owner's
//   stop since lifted — at the switch to `browser` and back: not while the
//   owner stopped it or paused the page, not while a person logs it in (the
//   manual login), never one halted for the owner's decision (a changed exit
//   IP, a guard that failed: the owner's `sync browser start`).
// - The owner's one-shot commands (`page_browser_commands`): a start of a
//   halted browser, a self-test (with the exit closed: closed for it and
//   opened again after when it was open and the test passed). Each is taken
//   by this owner and run once by its id.
//
// Nothing goes to the operator before its hand-over to this owner
// (`quiesced`). A leave of the browser keeps the owner's stop and nothing
// more: it starts nothing and takes no command.

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
  /** `slot`: the page's slot on its browser; `leave`: a leave of it. */
  role: "slot" | "leave";
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

  async #look(): Promise<void> {
    const { client, db, profileId, pageId, generation } = this.#d;
    const state = client.state;
    // Nothing goes to the operator before its hand-over to this owner.
    if (state === null || client.quiesced === null) return;
    const control = await readPageBrowserControl(db, { profileId });
    if (control === null || control.pageId !== pageId || this.#stopped) return;
    if (control.ownerStopAt !== null) {
      const now = this.#d.clock.monoNow();
      if (!browserStoppedByOwner(state) && now >= this.#nextStopMono) {
        this.#nextStopMono = now + this.#timing.stopEveryMs;
        await this.#command("stopPage", "the owner stopped the page's browser");
      }
    }
    if (this.#d.role !== "slot" || this.#stopped) return;
    // The owner's command first: a start he asked for is the start.
    const command = await takePageBrowserCommand(db, { pageId, profileId, generation });
    if (command !== null) {
      let outcome: { ok: boolean; detail: string | null };
      try {
        outcome = await this.#run(command, control.ownerStopAt !== null);
      } catch (error) {
        outcome = { ok: false, detail: `not run: ${errorName(error)}` };
      }
      await finishPageBrowserCommand(db, { id: command.id, generation, ok: outcome.ok, detail: outcome.detail });
      this.#d.logger.info({ pageId, command: command.kind, by: command.requestedBy, ok: outcome.ok, detail: outcome.detail },
        "Fansly sync browser: the owner's command ran");
      return;
    }
    const now = this.#d.clock.monoNow();
    if (control.ownerStopAt === null && control.transport === "browser" && !control.pausedAll && state.mode === "automation"
      && browserStands(state) && now - this.#lastStartMono >= this.#timing.startEveryMs) {
      this.#lastStartMono = now;
      await this.#command("restartBrowser", "the page runs on its browser, which stands");
    }
  }

  async #run(command: PageBrowserCommandRow, ownerStopped: boolean): Promise<{ ok: boolean; detail: string | null }> {
    const state = this.#d.client.state;
    if (state === null) return { ok: false, detail: "not run: the operator cannot be reached" };
    switch (command.kind) {
      case "restartBrowser": {
        if (ownerStopped) return { ok: false, detail: "not run: the owner stopped the page's browser (sync browser start lifts the stop)" };
        if (state.step !== "exit_closed" || state.exitOpen) return { ok: true, detail: `not needed: the browser is up or starting (${state.step})` };
        this.#lastStartMono = this.#d.clock.monoNow();
        const result = await this.#command("restartBrowser", `the owner's start (${command.requestedBy})`, command.commandId);
        return result === null ? { ok: false, detail: "no answer from the operator" } : { ok: result.ok, detail: result.detail };
      }
      case "selfTest": {
        // The self-test runs with the exit closed (plan §4.1 step 5): closed
        // for it, opened again after when it was open and the test passed.
        const wasOpen = state.exitOpen;
        const steps: string[] = [];
        if (wasOpen) {
          const closed = await this.#command("closeExit", "the owner's self-test", `${command.commandId}:closeExit`);
          steps.push(`closeExit: ${closed === null ? "no answer" : closed.detail ?? String(closed.ok)}`);
          if (closed?.ok !== true) return { ok: false, detail: steps.join("; ") };
        }
        const tested = await this.#command("selfTest", "the owner's self-test", `${command.commandId}:selfTest`);
        steps.push(`selfTest: ${tested === null ? "no answer" : tested.detail ?? String(tested.ok)}`);
        let ok = tested?.ok === true;
        if (wasOpen && ok) {
          const opened = await this.#command("openExit", "the owner's self-test passed", `${command.commandId}:openExit`);
          steps.push(`openExit: ${opened === null ? "no answer" : opened.detail ?? String(opened.ok)}`);
          ok = opened?.ok === true;
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
