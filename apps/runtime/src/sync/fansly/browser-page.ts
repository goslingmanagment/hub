import { recordPageBrowserHandover, type Database } from "@agency_hub_core/db";
import type { AppConfig } from "@agency_hub_core/shared";

import { createFanslyWsLiveApplier } from "../../services/fansly-ws/live-apply.ts";
import {
  pageBrowserRpcUrl,
  readPageBrowserLinkRevision,
  readPageBrowserLinkSettings,
  readPageBrowserPageSettings,
} from "../../services/egress/page-browser-link.ts";
import type { CommandResult, Quiesced } from "../../services/egress/page-browser-protocol.ts";
import {
  PageBrowserRpcClient,
  systemMonoBridge,
  type MonoBridge,
  type PageBrowserLinkSettings,
  type PageBrowserRpcTiming,
} from "../../services/egress/page-browser-rpc.ts";
import { errorName, type SyncLogger } from "../engine/commit.ts";
import { TAKEOVER_FACTOR } from "../engine/pacer.ts";
import type { Clock, Metrics, PageTransport } from "../engine/ports.ts";
import type { DemandSignal, EngineRegistry } from "../engine/resource.ts";
import { BrowserBufferIntake, type BrowserIntakeTiming } from "./browser-intake.ts";
import { BrowserSiteAdmission, SEND_REPORT_GUARD_MS } from "./browser-site.ts";
import { createBrowserPageTransport, type BrowserPageTransportOptions } from "./browser-transport.ts";
import { BrowserWsGuard, type BrowserWsGuardTiming } from "./ws/browser-guard.ts";
import { BrowserWsSource } from "./ws/browser-source.ts";
import { SYNC_WS_APPLY_DRAIN_MS } from "./ws/source.ts";
import { routeFanslyWsReceiptDemand } from "./ws/route-receipt.ts";

// A browser page's slot (Project Browser, plan §3.2 «Выбор транспорта
// страницы», §4.7, §4.13; stage 3 PR 14): what the host builds for a page
// whose transport is `browser`, in place of the undici transport and the
// engine's own socket — one link to the page's operator and, over it:
// - the browser transport (`browser-transport.ts`, PR 12), the actor's
//   `PageTransport`;
// - the site path (`browser-site.ts`): the site's own requests and its
//   socket's CONNECT under the engine's admission (PR 8's port);
// - the site socket's connection rows (`ws/browser-source.ts`), the page's
//   socket owner as `ws.connect` sees it;
// - the buffer's intake (`browser-intake.ts`, PR 13) — frames to the live
//   overlay as the engine's own socket's (the applier, the post-ack routing);
// - the site socket's guard and down timer (`ws/browser-guard.ts`): its row
//   renewed while the stream says it is open, `dm-conversations.ws-down`
//   after two minutes without one.
//
// The hand-over (plan §4.7): the operator answers this owner's hello with
// `quiesced` once the earlier owners' requests are over. Until then nothing
// of this owner goes (the transport and the site path wait for it); then
// its generation is recorded on the profile (`page_browsers.handover_*`,
// which `sync ownership confirm-stopped` waits for) and the pacer's
// takeover floor is raised to 1.2 × S after the last send the operator
// names (plan §4.13: the hand-over pause counts from it) — never lowered.
//
// Leaving the browser (the page's transport changed away from it): the
// operator is told to stop the page — it closes its exit first, then stops
// Chrome; the profile stays (plan §3.2 «Переключение транспорта страницы и
// откат»). Otherwise the site would go on and open a second socket. A
// shutdown or a deploy leaves the browser running: it outlives its owner.

/** How long the slot waits for the operator's answer to `stopPage`. */
export const BROWSER_LEAVE_WAIT_MS = 15_000;

/** The page's browser is not ready to be a page's transport: nothing is
 *  built (no profile bound, nothing pinned, no environment). */
export class BrowserPageNotReadyError extends Error {
  constructor(readonly pageId: number, readonly why: string) {
    super(`Page ${pageId} cannot run on its browser: ${why}`);
    this.name = "BrowserPageNotReadyError";
  }
}

/** TESTS ONLY: where the operator listens, the hello's settings, and the
 *  scaled timings. Never passed by `main.ts`. */
export interface BrowserPageOverrides {
  url?: (pageId: number) => string;
  settings?: (pageId: number) => Promise<PageBrowserLinkSettings>;
  rpcTiming?: Partial<PageBrowserRpcTiming>;
  transportTiming?: BrowserPageTransportOptions["timing"];
  intakeTiming?: Partial<BrowserIntakeTiming>;
  guardTiming?: Partial<BrowserWsGuardTiming>;
  cdnUrlAllowed?: (url: URL) => boolean;
  leaveWaitMs?: number;
}

export interface BrowserPageDeps {
  db: Database;
  config: AppConfig;
  logger: SyncLogger;
  metrics: Metrics;
  registry: EngineRegistry;
  clock: Clock;
  pageId: number;
  /** The slot's owner generation: every message of the link carries it. */
  generation: bigint;
  /** `pages.external_page_id` (the observations' native account ref). */
  ownRef: string | null;
  /** S as the host read it for the takeover floor (≥ the owner's minimum). */
  settingMs: number;
  /** The slot's pacer: the floor learnt from the operator's `quiesced`. */
  raiseTakeoverFloor(atMono: number): void;
  /** The page's demand under the slot's generation (the socket's
   *  `dm-conversations.ws-down`). Rejects when it was not written. */
  enqueue(signals: readonly DemandSignal[]): Promise<void>;
  overrides?: BrowserPageOverrides;
}

export interface BrowserPage {
  readonly profileId: string;
  readonly client: PageBrowserRpcClient;
  readonly bridge: MonoBridge;
  readonly transport: PageTransport;
  readonly site: BrowserSiteAdmission;
  readonly socket: BrowserWsSource;
  readonly intake: BrowserBufferIntake;
  readonly guard: BrowserWsGuard;
  /** The intake and the socket's guard run (the link was started with the
   *  transport). */
  start(): void;
  /** The page leaves its browser: `stopPage` (null: not answered). */
  leave(): Promise<CommandResult | null>;
  /** The intake, the overlay applier, the socket rows' source and the site
   *  path stop; the transport (and with it the link) is the caller's to
   *  close, after this. Never rejects. */
  stop(): Promise<void>;
}

/**
 * Build a browser page's slot. Throws `BrowserPageNotReadyError` when the
 * page's browser has no profile or no settings: nothing was started then.
 */
export async function openBrowserPage(deps: BrowserPageDeps): Promise<BrowserPage> {
  const { db, config, logger, metrics, pageId, generation } = deps;
  const read = await readPageBrowserPageSettings(db, pageId);
  if ("problem" in read) throw new BrowserPageNotReadyError(pageId, read.problem);
  const profileId = read.profile.profileId;
  const overrides = deps.overrides ?? {};
  const bridge = systemMonoBridge();
  // Read again at every hello: a pin, an environment or a proxy changed while
  // the slot runs goes in the next one.
  const pageSettings = async () => {
    const now = await readPageBrowserPageSettings(db, pageId);
    if ("problem" in now) throw new BrowserPageNotReadyError(pageId, now.problem);
    return now.settings;
  };
  const client = new PageBrowserRpcClient({
    url: overrides.url?.(pageId) ?? pageBrowserRpcUrl(read.profile.container),
    ownerGeneration: generation,
    settings: overrides.settings !== undefined
      ? () => overrides.settings!(pageId)
      : async () => readPageBrowserLinkSettings({ db, config }, pageId, await pageSettings()),
    ...(overrides.settings !== undefined ? {} : { revision: async () => readPageBrowserLinkRevision({ db }, pageId, await pageSettings()) }),
    logger,
    ...(overrides.rpcTiming === undefined ? {} : { timing: overrides.rpcTiming }),
  });
  client.onQuiesced((quiesced) => onQuiesced(quiesced));

  function onQuiesced(quiesced: Quiesced): void {
    if (quiesced.lastSendMono !== null) {
      const at = bridge.fromKernel(quiesced.lastSendMono) + SEND_REPORT_GUARD_MS + Math.ceil(TAKEOVER_FACTOR * deps.settingMs);
      try {
        deps.raiseTakeoverFloor(at);
      } catch (error) {
        logger.warn({ pageId, err: errorName(error) }, "Fansly sync browser page: the takeover floor of the operator's last send could not be set");
      }
    }
    metrics.increment("sync_browser_quiesced", { pageId });
    logger.info({ pageId, generation: generation.toString(), previousGeneration: quiesced.previousGeneration },
      "Fansly sync browser page: the operator says the previous owner's work is over");
    void recordPageBrowserHandover(db, {
      profileId,
      generation,
      lastSendAt: quiesced.lastSendWall === null ? null : new Date(quiesced.lastSendWall),
    }).catch((error: unknown) => {
      logger.warn({ pageId, err: errorName(error) }, "Fansly sync browser page: the hand-over could not be recorded");
    });
  }

  const site = new BrowserSiteAdmission({ client, bridge, monoNow: () => deps.clock.monoNow(), metrics });
  let transport: PageTransport;
  try {
    transport = await createBrowserPageTransport({ db, config }, { pageId }, {
      client,
      monoNow: () => deps.clock.monoNow(),
      bridge,
      ...(overrides.transportTiming === undefined ? {} : { timing: overrides.transportTiming }),
      ...(overrides.cdnUrlAllowed === undefined ? {} : { cdnUrlAllowed: overrides.cdnUrlAllowed }),
    });
  } catch (error) {
    site.close();
    await client.close();
    throw error;
  }
  const socket = new BrowserWsSource({ db, pageId });
  // A captured frame reaches the overlay, its receipt routed in the ack
  // transaction (I18), as the engine's own socket's.
  const applier = createFanslyWsLiveApplier({ db, logger: logger as never }, { afterAck: routeFanslyWsReceiptDemand });
  const intake = new BrowserBufferIntake({
    db,
    pageId,
    generation,
    ownRef: deps.ownRef,
    client,
    source: socket,
    registry: deps.registry,
    logger,
    metrics,
    applyLive: (observationId) => applier.enqueue(observationId),
    ...(overrides.intakeTiming === undefined ? {} : { timing: overrides.intakeTiming }),
  });
  const guard = new BrowserWsGuard({
    db,
    pageId,
    clock: deps.clock,
    metrics,
    logger,
    link: client,
    intake,
    socket,
    enqueue: deps.enqueue,
    ...(overrides.guardTiming === undefined ? {} : { timing: overrides.guardTiming }),
  });
  let stopped: Promise<void> | null = null;
  return {
    profileId,
    client,
    bridge,
    transport,
    site,
    socket,
    intake,
    guard,
    start() {
      intake.start();
      guard.start();
    },
    async leave() {
      const waitMs = overrides.leaveWaitMs ?? BROWSER_LEAVE_WAIT_MS;
      const result = await client.command("stopPage", bridge.toKernel(deps.clock.monoNow() + waitMs), waitMs);
      if (result === null || !result.ok) {
        logger.warn({ pageId, detail: result?.detail ?? "no answer" },
          "Fansly sync browser page: the operator did not confirm it stopped the page; with no owner of it, it admits nothing");
      } else {
        logger.info({ pageId }, "Fansly sync browser page: the operator stopped the page (exit closed, Chrome stopped)");
      }
      return result;
    },
    stop() {
      stopped ??= (async () => {
        await guard.stop();
        await intake.stop();
        await applier.drain(SYNC_WS_APPLY_DRAIN_MS);
        socket.stop();
        site.close();
      })().catch(() => undefined);
      return stopped;
    },
  };
}
