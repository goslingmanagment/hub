import { touchBrowserWsConnection, type Database } from "@agency_hub_core/db";

import { errorName, type SyncLogger } from "../../engine/commit.ts";
import type { Clock, Metrics } from "../../engine/ports.ts";
import type { DemandSignal } from "../../engine/resource.ts";
import { socketUp } from "../resources/dm-conversations.ts";
import { FANSLY_WS_SOURCE_TIMING } from "./source.ts";

// The guard and the down timer of a browser page's socket (Project Browser,
// plan §3.2 «Кадры сокета», §4.4; stage 3 PR 14) — what the engine's own
// socket source does for its socket (`ws/source.ts`), for the site's:
//
// - The guard. The engine's own receiver proves its socket alive every few
//   seconds (`last_guard_at`), whatever the socket carries; the alerts
//   (alert 2 `socket_down`, a row renewed within a minute) and the list's
//   live signal (`dm-conversations.ws-down`, a verified row renewed within
//   30 s, `socketUp`) read that proof. The site's socket's rows are renewed
//   only by the frames the intake takes, so a quiet socket would look down.
//   While the link to the operator is up, the intake is subscribed to its
//   stream and the site's connection is open by that stream (no `ws.close`
//   came), the row is renewed here every `checkMs`: a close would have come
//   on that live stream. A link that went, an intake that stopped, a closed
//   connection — no renewal, and the row goes stale as a dead receiver's.
// - The down timer. No verified, renewed connection for `downListAfterMs`
//   (2 min, the engine's own socket's): `dm-conversations.ws-down` once per
//   outage — the list head every 30 s until a socket proves itself (its
//   module's own rule). Demand the database refused is written again at the
//   next check. The outage starts with the slot: nothing proved the socket
//   up before.

export interface BrowserWsGuardTiming {
  /** The guard's renewal and the down check, this often. */
  checkMs: number;
  /** No socket up this long ⇒ `dm-conversations.ws-down` (plan §7 p.10 (в)). */
  downListAfterMs: number;
}

export const BROWSER_WS_GUARD_TIMING: Readonly<BrowserWsGuardTiming> = Object.freeze({
  checkMs: 5_000,
  downListAfterMs: FANSLY_WS_SOURCE_TIMING.downListAfterMs,
});

export interface BrowserWsGuardDeps {
  db: Database;
  pageId: number;
  clock: Clock;
  metrics: Metrics;
  logger: SyncLogger;
  /** The link to the operator. */
  link: { readonly up: boolean };
  /** The intake of the operator's stream: subscribed (a position) and running. */
  intake: { readonly position: unknown; readonly stopReason: string | null };
  /** The site's connection open by that stream. */
  socket: { readonly openConnectionId: string | null };
  /** The page's demand (`dm-conversations.ws-down`), under the slot's
   *  generation. Rejects when the database refused it. */
  enqueue(signals: readonly DemandSignal[]): Promise<void>;
  /** TESTS ONLY. */
  timing?: Partial<BrowserWsGuardTiming>;
}

export class BrowserWsGuard {
  readonly #d: BrowserWsGuardDeps;
  readonly #timing: BrowserWsGuardTiming;
  #timer: ReturnType<typeof setInterval> | null = null;
  #checking: Promise<void> | null = null;
  #downSince: Date | null = null;
  #listed = false;
  #stopped = false;

  constructor(deps: BrowserWsGuardDeps) {
    this.#d = deps;
    this.#timing = { ...BROWSER_WS_GUARD_TIMING, ...deps.timing };
  }

  /** The current outage's start (null: the socket is up). */
  get downSince(): Date | null {
    return this.#downSince;
  }

  start(): void {
    if (this.#timer !== null || this.#stopped) return;
    this.#downSince = this.#d.clock.wallNow();
    this.#timer = setInterval(() => void this.check(), this.#timing.checkMs);
    this.#timer.unref?.();
  }

  /** One renewal and down check (the timer's; tests call it). Never rejects. */
  check(): Promise<void> {
    this.#checking ??= this.#check().finally(() => {
      this.#checking = null;
    });
    return this.#checking;
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    await this.#checking?.catch(() => undefined);
  }

  async #check(): Promise<void> {
    const d = this.#d;
    if (this.#stopped) return;
    try {
      const connection = d.socket.openConnectionId;
      if (connection !== null && d.link.up && d.intake.stopReason === null && d.intake.position !== null) {
        await touchBrowserWsConnection(d.db, { pageId: d.pageId, browserConnectionId: connection, at: d.clock.wallNow() });
      }
      if (await socketUp(d.db, d.pageId)) {
        this.#downSince = null;
        this.#listed = false;
        return;
      }
    } catch (error) {
      d.logger.warn({ pageId: d.pageId, err: errorName(error) }, "Fansly sync browser socket: the guard's check failed");
      return;
    }
    const now = d.clock.wallNow();
    this.#downSince ??= now;
    if (this.#listed || now.getTime() - this.#downSince.getTime() <= this.#timing.downListAfterMs) return;
    // Once per outage: the work re-arms itself every 30 s while the socket
    // stays down, and a further demand would make it due at once.
    this.#listed = true;
    d.metrics.increment("sync_ws_down_list", { pageId: d.pageId, origin: "browser" });
    try {
      await d.enqueue([{ resource: "dm-conversations.ws-down", demand: { reason: "ws_down" } }]);
    } catch (error) {
      this.#listed = false;
      d.logger.warn({ pageId: d.pageId, err: errorName(error) }, "Fansly sync browser socket: the ws-down demand was not written; it is written again");
    }
  }
}
