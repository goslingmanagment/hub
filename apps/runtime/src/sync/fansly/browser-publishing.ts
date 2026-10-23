import { autostopPagePublishing, findPageById, getPagePublishingSettings, type Database, type PagePublishingSettingsRecord } from "@agency_hub_core/db";

import type { Publishing, PublishingStopReason, State } from "../../services/egress/page-browser-protocol.ts";
import { notifyPublishingStoppedIncident } from "../../services/notification-incidents.ts";
import type { MonoBridge, PageBrowserRpcClient } from "../../services/egress/page-browser-rpc.ts";
import { errorName, type SyncLogger } from "../engine/commit.ts";
import type { Clock, Metrics, SettingsSource } from "../engine/ports.ts";

// The permissions of Hub's writes at a page's browser (wall posts PR 7, spec
// §8.4): the rules extension is baked into the image, so whether the page
// publishes now is the operator's to check at every write it would release —
// and the engine's to tell it. Two permissions:
//
// - create — upload a file, make account media, post, story: the global
//   switch (`publishingEnabled`) and the page's own on, no autostop;
// - withdraw — take a scheduled post off the schedule: no autostop (spec
//   §8.4: what Hub put on the platform can be withdrawn while publishing is
//   off; an autostop — for a lost login, a Fansly check, a 401/403/429 —
//   leaves the schedule as it is).
//
// The page's slot looks every `everyMs`, read fresh, and when the operator's
// `state.publishing` says otherwise sends `setPublishing` — a switch turned
// off reaches the operator within a look, a write already admitted is
// refused at its check anyway (the write module's `confirmWrite`). Only to an
// operator that said at hello that it takes writes (protocol minor 8), and
// only after its hand-over to this owner (`quiesced`): an older one would
// take the command for a protocol error. The operator starts with both off,
// and sets both off at every hello: a new owner says them anew.
//
// The operator's own stop (spec §8.3; PR 7 part 2): it stops both by itself
// when Fansly signs the browser out, a Fansly check answers a request of the
// page, or a 401/403/429 answers one of Hub's writes, and holds the stop
// (`state.publishing.stop`) until it is named back. A look records it as the
// page's autostop first (`autostopPagePublishing`: publishing off, its
// reason kept — only the owner turns it on again), then names it back
// (`setPublishing.clearStop`): the database holds the stop from then on. A
// halt for a lost login (`login_required`, held on the operator's volume
// across its restarts) is the same stop. A page with no publishing settings
// never published: nothing to record, the stop is let go.
//
// Every autostop of the page's Fansly publishing — the operator's, or the
// engine's own on a write's 401/403/429 (publish/module.ts) — is told to the
// owner once (an incident, `publishing_stopped`), after its commit; for a
// lost login or a Fansly check with the word that what is on Fansly's
// schedule stays there.

export interface BrowserPublishingTiming {
  /** How often the page's publishing is read and compared. */
  everyMs: number;
  /** A `setPublishing`'s wait for its result (and its deadline). */
  commandWaitMs: number;
}

export const BROWSER_PUBLISHING_TIMING: Readonly<BrowserPublishingTiming> = Object.freeze({
  everyMs: 2_000,
  commandWaitMs: 10_000,
});

export interface BrowserPublishingDeps {
  db: Database;
  pageId: number;
  client: PageBrowserRpcClient;
  bridge: MonoBridge;
  clock: Clock;
  logger: SyncLogger;
  metrics: Metrics;
  /** The live settings (the global switch); absent: it reads off. */
  settings?: SettingsSource;
  timing?: Partial<BrowserPublishingTiming>;
  /** The owner told of an autostop (an incident). Default: the page's
   *  `publishing_stopped` incident. TESTS pass their own. */
  notify?: (input: { pageId: number; reason: string; occurredAt: Date; note?: string }) => Promise<boolean>;
}

/** The autostop reason an operator's stop is recorded with. */
export function autostopReasonOfStop(reason: PublishingStopReason): string {
  return reason === "login_lost" || reason === "challenge" ? `browser_${reason}` : `fansly_${reason}`;
}

/** What the owner is told beside an autostop's reason. */
export function autostopNote(reason: string): string | undefined {
  if (reason === "browser_login_lost") return "Fansly signed the page's browser out: posts on Fansly's schedule stay there, and nothing is withdrawn until the login is back and publishing is on again";
  if (reason === "browser_challenge") return "a Fansly check answered the page's browser: posts on Fansly's schedule stay there, and nothing is withdrawn until publishing is on again";
  if (reason.startsWith("fansly_http_")) return "Fansly refused a publishing request: turn publishing on again once it is understood";
  return undefined;
}

/** The stop the operator says, or holds as a halt for a lost login. */
function operatorStop(state: State): { reason: string; clearStop: string | null } | null {
  const stop = state.publishing?.stop ?? null;
  if (stop !== null) return { reason: autostopReasonOfStop(stop.reason), clearStop: stop.id };
  if (state.halt?.reason === "login_required" || state.stopReason === "login_required") return { reason: "browser_login_lost", clearStop: null };
  return null;
}

/** The permissions a page's publishing gives its browser now. */
export function pagePublishingPermissions(input: { publishingEnabled: boolean; page: { enabled: boolean; autostopReason: string | null } }): Publishing {
  const stopped = input.page.autostopReason !== null;
  return { create: !stopped && input.publishingEnabled && input.page.enabled, withdraw: !stopped };
}

export class BrowserPublishing {
  readonly #d: BrowserPublishingDeps;
  readonly #timing: BrowserPublishingTiming;
  #timer: ReturnType<typeof setInterval> | null = null;
  #tick: Promise<void> | null = null;
  #stopped = false;
  /** The autostop this process told the owner of (its instant). */
  #told: number | null = null;

  constructor(deps: BrowserPublishingDeps) {
    this.#d = deps;
    this.#timing = { ...BROWSER_PUBLISHING_TIMING, ...deps.timing };
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
        this.#d.logger.warn({ pageId: this.#d.pageId, err: errorName(error) }, "Fansly sync browser: a look at the page's publishing failed");
      })
      .finally(() => {
        this.#tick = null;
      });
    return this.#tick;
  }

  async #look(): Promise<void> {
    const { client, db, pageId, settings, logger } = this.#d;
    // An operator that takes no writes is never told (it would refuse the
    // command as unknown); nothing before its hand-over to this owner.
    if (!client.writes || client.quiesced === null) return;
    const [read, config] = await Promise.all([getPagePublishingSettings(db, pageId), settings === undefined ? Promise.resolve(null) : settings.read()]);
    let page = read;
    const state = client.state;
    if (state === null || !client.writes || this.#stopped) return;
    // The operator's own stop: the page's autostop first, committed.
    const stop = operatorStop(state);
    if (stop !== null && page.autostopReason === null && page.updatedAt !== null) {
      if (await autostopPagePublishing(db, pageId, stop.reason)) {
        logger.warn({ pageId, reason: stop.reason }, "Fansly sync browser: the page's operator stopped Hub's writes; the page's publishing is stopped until the owner turns it on");
      }
      page = await getPagePublishingSettings(db, pageId);
    }
    await this.#tell(page);
    // Fail closed: no live settings, no creating.
    const want = pagePublishingPermissions({ publishingEnabled: config?.publishingEnabled === true, page });
    const have = state.publishing ?? { create: false, withdraw: false };
    // The stop is named back once the database holds it (or the page never
    // published: nothing to hold).
    const clearStop = stop?.clearStop != null && (page.autostopReason !== null || page.updatedAt === null) ? stop.clearStop : null;
    if (clearStop === null && have.create === want.create && have.withdraw === want.withdraw) return;
    const { bridge, clock, metrics } = this.#d;
    const waitMs = this.#timing.commandWaitMs;
    const result = await client.command({ kind: "setPublishing", ...want, ...(clearStop === null ? {} : { clearStop }) }, bridge.toKernel(clock.monoNow() + waitMs), waitMs);
    metrics.increment("sync_browser_publishing_set", { pageId, create: want.create, withdraw: want.withdraw, ok: result?.ok === true ? "yes" : result === null ? "unknown" : "no" });
    logger.info({ pageId, from: have, to: want, clearStop, ok: result?.ok ?? null, detail: result?.detail ?? null }, "Fansly sync browser: the page's publishing told to its operator");
  }

  /** The owner is told of the page's autostop once (this process; the
   *  incident is a latch: telling it again only refreshes it). */
  async #tell(page: PagePublishingSettingsRecord): Promise<void> {
    if (page.autostopReason === null || page.autostoppedAt === null || this.#told === page.autostoppedAt.getTime()) return;
    const note = autostopNote(page.autostopReason);
    const told = await (this.#d.notify ?? this.#notify)({ pageId: this.#d.pageId, reason: page.autostopReason, occurredAt: page.autostoppedAt, ...(note === undefined ? {} : { note }) });
    if (told) this.#told = page.autostoppedAt.getTime();
  }

  readonly #notify = async (input: { pageId: number; reason: string; occurredAt: Date; note?: string }): Promise<boolean> => {
    const { db, logger } = this.#d;
    const label = (await findPageById(db, input.pageId))?.page.label ?? `page ${input.pageId}`;
    return notifyPublishingStoppedIncident({ db, logger }, { ...input, pageLabel: label, platform: "fansly" });
  };
}
