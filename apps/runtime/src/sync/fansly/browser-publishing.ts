import { getPagePublishingSettings, type Database } from "@agency_hub_core/db";

import type { Publishing } from "../../services/egress/page-browser-protocol.ts";
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
    const { client, db, pageId, settings } = this.#d;
    // An operator that takes no writes is never told (it would refuse the
    // command as unknown); nothing before its hand-over to this owner.
    if (!client.writes || client.quiesced === null) return;
    const [page, config] = await Promise.all([getPagePublishingSettings(db, pageId), settings === undefined ? Promise.resolve(null) : settings.read()]);
    const state = client.state;
    if (state === null || !client.writes || this.#stopped) return;
    // Fail closed: no live settings, no creating.
    const want = pagePublishingPermissions({ publishingEnabled: config?.publishingEnabled === true, page });
    const have = state.publishing ?? { create: false, withdraw: false };
    if (have.create === want.create && have.withdraw === want.withdraw) return;
    const { bridge, clock, logger, metrics } = this.#d;
    const waitMs = this.#timing.commandWaitMs;
    const result = await client.command({ kind: "setPublishing", ...want }, bridge.toKernel(clock.monoNow() + waitMs), waitMs);
    metrics.increment("sync_browser_publishing_set", { pageId, create: want.create, withdraw: want.withdraw, ok: result?.ok === true ? "yes" : result === null ? "unknown" : "no" });
    logger.info({ pageId, from: have, to: want, ok: result?.ok ?? null, detail: result?.detail ?? null }, "Fansly sync browser: the page's publishing told to its operator");
  }
}
