import { recordPageBrowserHandover, type Database } from "@agency_hub_core/db";
import type { AppConfig } from "@agency_hub_core/shared";

import { createFanslyWsLiveApplier } from "../../services/fansly-ws/live-apply.ts";
import {
  pageBrowserRpcUrl,
  readPageBrowserLinkRevision,
  readPageBrowserLinkSettings,
  readPageBrowserPageSettings,
} from "../../services/egress/page-browser-link.ts";
import type { Quiesced } from "../../services/egress/page-browser-protocol.ts";
import {
  PageBrowserRpcClient,
  systemMonoBridge,
  type MonoBridge,
  type PageBrowserLinkSettings,
  type PageBrowserRpcTiming,
} from "../../services/egress/page-browser-rpc.ts";
import { errorName, type SyncLogger } from "../engine/commit.ts";
import { TAKEOVER_FACTOR } from "../engine/pacer.ts";
import type { Clock, Metrics, PageTransport, SettingsSource } from "../engine/ports.ts";
import type { DemandSignal, EngineRegistry } from "../engine/resource.ts";
import { BrowserControl, type BrowserControlTiming } from "./browser-control.ts";
import { BrowserBufferIntake, type BrowserIntakeTiming } from "./browser-intake.ts";
import { BrowserLoginDriver, type BrowserLoginTiming } from "./browser-login.ts";
import { BrowserPublishing, type BrowserPublishingTiming } from "./browser-publishing.ts";
import { BrowserRecorder, type BrowserRecorderTiming } from "./browser-record.ts";
import { BrowserSiteAdmission, SEND_REPORT_GUARD_MS } from "./browser-site.ts";
import { createBrowserPageTransport, type BrowserPageTransportOptions } from "./browser-transport.ts";
import { BrowserWsGuard, type BrowserWsGuardTiming } from "./ws/browser-guard.ts";
import { BrowserWsSource } from "./ws/browser-source.ts";
import { createFanslyWsReceiptRouter } from "./ws/route-receipt.ts";

// A browser page's slot (Project Browser, plan §3.2, §4.7, §4.13; stage 3
// PR 14): what the host builds for every live page — one link to the page's
// operator and, over it:
// - the browser transport (`browser-transport.ts`, PR 12), the actor's
//   `PageTransport`;
// - the site path (`browser-site.ts`): the site's own requests and its
//   socket's CONNECT under the engine's admission (PR 8's port);
// - the site socket's connection rows (`ws/browser-source.ts`), the page's
//   socket owner;
// - the buffer's intake (`browser-intake.ts`, PR 13) — frames to the live
//   overlay (the applier, the post-ack routing);
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
// A shutdown or a deploy leaves the browser running: it outlives its owner.
//
// The owner's login (PR 15, `login`): the login driver (`browser-login.ts`)
// follows `sync_pages.manual_login` over the same link — the operator into
// the manual login and back.

/** The overlay apply drain of a slot that stops: bounded to 10 s in `sync`
 *  (the leftovers stay pending for the worker timer, I18). */
export const SYNC_WS_APPLY_DRAIN_MS = 10_000;

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
  loginTiming?: Partial<BrowserLoginTiming>;
  recorderTiming?: Partial<BrowserRecorderTiming>;
  controlTiming?: Partial<BrowserControlTiming>;
  publishingTiming?: Partial<BrowserPublishingTiming>;
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
  /** The slot follows the owner's login of the page's browser (PR 15). */
  login?: boolean;
  /** The live settings: the global publishing switch the page's browser is
   *  told with its permissions (wall posts PR 7). Absent: it reads off. */
  settings?: SettingsSource;
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
  /** The owner's login of the page's browser (PR 15); null: not followed. */
  readonly login: BrowserLoginDriver | null;
  /** What the operator says of itself, recorded (PR 17). */
  readonly recorder: BrowserRecorder;
  /** The owner's stop, start and commands (PR 17). */
  readonly control: BrowserControl;
  /** The permissions of Hub's writes told to the operator (wall posts PR 7). */
  readonly publishing: BrowserPublishing;
  /** The intake and the socket's guard run (the link was started with the
   *  transport). */
  start(): void;
  /** The intake, the overlay applier, the socket rows' source and the site
   *  path stop; the transport (and with it the link) is the caller's to
   *  close, after this. Never rejects. */
  stop(): Promise<void>;
}

/** Why the page's browser cannot be linked to (no profile bound to the page,
 *  no pinned exit IP or environment), or null: what `openBrowserPage` would
 *  refuse with `BrowserPageNotReadyError`, asked before the page is taken. */
export async function browserPageProblem(db: Database, pageId: number): Promise<string | null> {
  const read = await readPageBrowserPageSettings(db, pageId);
  return "problem" in read ? read.problem : null;
}

/**
 * Build a browser page's slot. Throws `BrowserPageNotReadyError` when the
 * page's browser has no profile or no settings: nothing was started then.
 */
export async function openBrowserPage(deps: BrowserPageDeps): Promise<BrowserPage> {
  const { db, logger, metrics, pageId, generation } = deps;
  const { profileId, client, bridge } = await openBrowserLink(deps);
  const overrides = deps.overrides ?? {};
  const site = new BrowserSiteAdmission({ client, bridge, monoNow: () => deps.clock.monoNow(), metrics, logger: deps.logger });
  let transport: PageTransport;
  try {
    transport = await createBrowserPageTransport({ db, config: deps.config }, { pageId }, {
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
  const recorder = new BrowserRecorder({
    db,
    pageId,
    profileId,
    client,
    clock: deps.clock,
    logger,
    metrics,
    ...(overrides.recorderTiming === undefined ? {} : { timing: overrides.recorderTiming }),
  });
  const control = new BrowserControl({
    db,
    pageId,
    profileId,
    generation,
    client,
    bridge,
    clock: deps.clock,
    logger,
    metrics,
    ...(overrides.controlTiming === undefined ? {} : { timing: overrides.controlTiming }),
  });
  const { socket, applier, intake } = browserIntakeOf(deps, client, (lagsMs) => recorder.delivered(lagsMs));
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
  // The permissions of Hub's writes, told to the operator (PR 7).
  const publishing = new BrowserPublishing({
    db,
    pageId,
    client,
    bridge,
    clock: deps.clock,
    logger,
    metrics,
    ...(deps.settings === undefined ? {} : { settings: deps.settings }),
    ...(overrides.publishingTiming === undefined ? {} : { timing: overrides.publishingTiming }),
  });
  const login = deps.login === true
    ? new BrowserLoginDriver({
      db, pageId, profileId, generation, client, bridge, clock: deps.clock, logger, metrics,
      ...(overrides.loginTiming === undefined ? {} : { timing: overrides.loginTiming }),
    })
    : null;
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
    login,
    recorder,
    control,
    publishing,
    start() {
      recorder.start();
      intake.start();
      guard.start();
      control.start();
      publishing.start();
      login?.start();
    },
    stop() {
      stopped ??= (async () => {
        await login?.stop();
        await publishing.stop();
        await control.stop();
        await recorder.stop();
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

/** The link to a page's operator: its client (the hello's settings read
 *  anew at every connect) and the hand-over of `quiesced` — the takeover
 *  floor raised, the generation recorded on the profile. Throws
 *  `BrowserPageNotReadyError` when the page's browser has no profile or no
 *  settings: nothing was started then. */
export async function openBrowserLink(deps: Omit<BrowserPageDeps, "enqueue" | "registry" | "ownRef">): Promise<{ profileId: string; client: PageBrowserRpcClient; bridge: MonoBridge }> {
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

  return { profileId, client, bridge };
}

/** The buffer's intake of a link (PR 13): the site socket's connection
 *  rows, the live overlay's applier (a captured frame reaches the overlay,
 *  its receipt routed in the ack transaction, I18), the intake itself.
 *  `onDelivered`: the delivery lags of what it committed (PR 17's recorder). */
export function browserIntakeOf(
  deps: Pick<BrowserPageDeps, "db" | "pageId" | "generation" | "ownRef" | "registry" | "logger" | "metrics" | "overrides">,
  client: PageBrowserRpcClient,
  onDelivered?: (lagsMs: readonly number[]) => void,
): { socket: BrowserWsSource; applier: ReturnType<typeof createFanslyWsLiveApplier>; intake: BrowserBufferIntake } {
  const { db, pageId, logger, metrics } = deps;
  const socket = new BrowserWsSource({ db, pageId });
  const applier = createFanslyWsLiveApplier({ db, logger: logger as never }, { afterAck: createFanslyWsReceiptRouter({ metrics }) });
  const intakeTiming = deps.overrides?.intakeTiming;
  const intake = new BrowserBufferIntake({
    db,
    pageId,
    generation: deps.generation,
    ownRef: deps.ownRef,
    client,
    source: socket,
    registry: deps.registry,
    logger,
    metrics,
    applyLive: (observationId) => applier.enqueue(observationId),
    ...(onDelivered === undefined ? {} : { onDelivered }),
    ...(intakeTiming === undefined ? {} : { timing: intakeTiming }),
  });
  return { socket, applier, intake };
}
