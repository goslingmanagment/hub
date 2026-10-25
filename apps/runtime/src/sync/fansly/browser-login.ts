import {
  endSyncPageManualLogin,
  getSyncPageManualLogin,
  holdSyncPageManualLoginPause,
  lockOwnedPage,
  OwnershipLostError,
  readPageBrowserControl,
  type Database,
} from "@agency_hub_core/db";

import type { CommandKind, CommandResult, Mode, State } from "../../services/egress/page-browser-protocol.ts";
import type { MonoBridge, PageBrowserRpcClient } from "../../services/egress/page-browser-rpc.ts";
import { errorName, type SyncLogger } from "../engine/commit.ts";
import type { Clock, Metrics } from "../engine/ports.ts";
import { browserStands, browserStandsForLogin, browserStartRefusal } from "./browser-control.ts";

// The owner's login of a page's browser, on the engine's side (Project
// Browser plan §4.8 «Вход и ручной режим», §3.2; spec §6.1 `setMode`; stage 3
// PR 15). The owner opens and closes it in the dashboard (the API writes
// `sync_pages.manual_login`: `wanted` — the page goes on the owner's pause
// at once — or `ending`); the engine that owns the page follows it over its
// link to the operator, as only it may command the browser (plan §4.13:
// commands to the browser only under the current owner generation):
//
// - wanted: the page stays on its pause (put back if it was lifted
//   meanwhile); the operator goes into the manual login (`setMode`); a
//   browser that stands — stopped, or never started, or stopped because
//   Fansly signed it out (`login_required`, the halt the login is the
//   owner's decision for); never one halted for another decision of his — is
//   started (`restartBrowser`), so the site's login screen comes up. The
//   start goes under the one guard of every start of the browser
//   (`browserStartRefusal`, PR 17), read fresh right before it: never while
//   the owner stopped the browser (`sync browser stop`), never for a newer
//   owner, never one whose operator says it holds another
//   halt for the owner — which the operator itself refuses to start (it
//   holds its halt on its volume). The form's calls go from the API to the operator, which takes
//   them only now. The site's login operations pass the pause in the site
//   path (PR 8's exemption), under the pacer and the budgets.
// - ending: the automation is back (`setMode`: the operator checks the exit
//   IP, loads the site anew and is ready only once the engine's identity
//   read names the expected account under the live session); then `off`,
//   under this owner's fence —
//   the pause the login put on the page lifted with it, and the page's
//   credentials no longer trusted (`endSyncPageManualLogin`): nothing
//   ordinary goes before an account check sent after the login proves them
//   again (G2), whatever the session's fingerprint says.
// - off, while the operator still says it is in the manual login (the same
//   owner, a login closed by other means): the automation is back.
// - An operator that cannot be reached is no one in the manual login a
//   person could use (no admission goes without the engine): a closing
//   login ends without it after `unreachableEndMs`; an open one waits.

export interface BrowserLoginTiming {
  /** How often the driver looks. */
  everyMs: number;
  /** A command's wait for its result (and its deadline at the operator). */
  commandWaitMs: number;
  /** A closing login whose operator cannot be reached ends after this. */
  unreachableEndMs: number;
  /** A start asked of a browser that stands is asked again after this. */
  restartEveryMs: number;
}

export const BROWSER_LOGIN_TIMING: Readonly<BrowserLoginTiming> = Object.freeze({
  everyMs: 1_000,
  commandWaitMs: 15_000,
  unreachableEndMs: 15_000,
  restartEveryMs: 30_000,
});

export interface BrowserLoginDeps {
  db: Database;
  pageId: number;
  /** The page's browser profile: the guard's fresh read of it. */
  profileId: string;
  /** The slot's owner generation: its writes are fenced by it. */
  generation: bigint;
  client: PageBrowserRpcClient;
  bridge: MonoBridge;
  clock: Clock;
  logger: SyncLogger;
  metrics: Metrics;
  timing?: Partial<BrowserLoginTiming>;
}

/** The browser stands, waiting for the login's start: not in a failure's
 *  backoff, and not halted for the owner's decision (a changed exit IP, a
 *  header or socket the site changed, a buffer that does not open) — only
 *  stopped, or never started; or stopped because Fansly signed it out. */
function standsForLogin(state: State): boolean {
  return browserStands(state) || browserStandsForLogin(state);
}

export class BrowserLoginDriver {
  readonly #d: BrowserLoginDeps;
  readonly #timing: BrowserLoginTiming;
  #timer: ReturnType<typeof setInterval> | null = null;
  #running: Promise<void> | null = null;
  #stopped = false;
  #unreachableSince: number | null = null;
  #lastStartMono = Number.NEGATIVE_INFINITY;
  /** The owner's login as the last look read it (null: not read yet). */
  #last: "off" | "wanted" | "ending" | null = null;
  /** The guard's last refusal of the login's start (said once). */
  #refused: string | null = null;

  constructor(deps: BrowserLoginDeps) {
    this.#d = deps;
    this.#timing = { ...BROWSER_LOGIN_TIMING, ...deps.timing };
  }

  start(): void {
    if (this.#stopped || this.#timer !== null) return;
    this.#timer = setInterval(() => void this.#tick(), this.#timing.everyMs);
    this.#timer.unref?.();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    await this.#running?.catch(() => undefined);
  }

  #tick(): Promise<void> {
    if (this.#running !== null || this.#stopped) return Promise.resolve();
    this.#running = this.drive()
      .catch((error: unknown) => {
        if (error instanceof OwnershipLostError) return;
        this.#d.logger.warn({ pageId: this.#d.pageId, err: errorName(error) }, "Fansly sync browser login: a look failed; it is tried again");
      })
      .finally(() => {
        this.#running = null;
      });
    return this.#running;
  }

  /** Nothing of the login is left for this link to do: it is off, and the
   *  operator says it is in the automation (or cannot be reached). */
  get settled(): boolean {
    const client = this.#d.client;
    return this.#last === "off" && (!client.up || client.state === null || client.state.mode === "automation");
  }

  /** One look: what the owner wants, what the operator says, one step. */
  async drive(): Promise<void> {
    const { db, pageId, client } = this.#d;
    const login = await getSyncPageManualLogin(db, pageId);
    if (login === null || this.#stopped) return;
    this.#last = login.value;
    const state = client.state;
    if (!client.up || client.quiesced === null || state === null) {
      if (login.value !== "ending") {
        this.#unreachableSince = null;
        return;
      }
      const now = this.#d.clock.monoNow();
      this.#unreachableSince ??= now;
      if (now - this.#unreachableSince >= this.#timing.unreachableEndMs) await this.#end("the page's browser cannot be reached: no one can be in its login");
      return;
    }
    this.#unreachableSince = null;
    switch (login.value) {
      case "off":
        if (state.mode === "manual_login") await this.#command({ kind: "setMode", mode: "automation" }, "the login is closed");
        return;
      case "wanted": {
        if (!login.pausedAll) {
          // A person may be in the page only while it is paused.
          await this.#fenced((tx) => holdSyncPageManualLoginPause(tx, { pageId }));
          this.#d.logger.info({ pageId }, "Fansly sync browser login: the page was unpaused during its login; paused again");
          return;
        }
        if (state.mode !== "manual_login") {
          await this.#command({ kind: "setMode", mode: "manual_login" }, "the owner opened the login");
          return;
        }
        const now = this.#d.clock.monoNow();
        if (standsForLogin(state) && now - this.#lastStartMono >= this.#timing.restartEveryMs) {
          // The guard of every start of the browser, read fresh right before it.
          const refusal = browserStartRefusal({
            control: await readPageBrowserControl(db, { profileId: this.#d.profileId }),
            state: client.state,
            generation: this.#d.generation,
            who: "login",
          });
          if (refusal !== null || this.#stopped) {
            if (refusal !== null && refusal !== this.#refused) {
              this.#d.logger.info({ pageId, why: refusal }, "Fansly sync browser login: the browser stands; the login does not start it");
            }
            this.#refused = refusal;
            return;
          }
          this.#refused = null;
          this.#lastStartMono = now;
          await this.#command("restartBrowser", "the browser stands: its login screen comes with its start");
        }
        return;
      }
      case "ending": {
        if (state.mode !== "automation") {
          const result = await this.#command({ kind: "setMode", mode: "automation" }, "the owner closed the login");
          if (result === null || !result.ok) return;
        }
        await this.#end("the automation is back");
        return;
      }
    }
  }

  async #command(kind: CommandKind | { kind: "setMode"; mode: Mode }, why: string): Promise<CommandResult | null> {
    const { client, bridge, clock, logger, metrics, pageId } = this.#d;
    const name = typeof kind === "string" ? kind : `setMode:${kind.mode}`;
    const waitMs = this.#timing.commandWaitMs;
    const result = await client.command(kind, bridge.toKernel(clock.monoNow() + waitMs), waitMs);
    metrics.increment("sync_browser_login_command", { command: name, ok: result?.ok === true ? "true" : result === null ? "unknown" : "false" });
    logger.info({ pageId, command: name, why, ok: result?.ok ?? null, detail: result?.detail ?? "no answer" }, "Fansly sync browser login: a command to the operator");
    return result;
  }

  async #end(why: string): Promise<void> {
    const ended = await this.#fenced((tx) => endSyncPageManualLogin(tx, { pageId: this.#d.pageId, by: "engine" }));
    if (ended) {
      this.#d.metrics.increment("sync_browser_login_ended", { pageId: this.#d.pageId });
      this.#d.logger.info({ pageId: this.#d.pageId, why }, "Fansly sync browser login: closed; the page's pause of it lifted");
    }
  }

  async #fenced<T>(body: (tx: Database) => Promise<T>): Promise<T> {
    const { db, pageId, generation } = this.#d;
    return db.transaction(async (raw) => {
      const tx = raw as unknown as Database;
      await lockOwnedPage(tx, { pageId, generation, lock: "no_key_update" });
      return body(tx);
    });
  }
}
