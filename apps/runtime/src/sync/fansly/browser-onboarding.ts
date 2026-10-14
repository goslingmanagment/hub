import { createHash, randomUUID } from "node:crypto";

import pg from "pg";

import {
  browserProfileRouteHoldDetail,
  closeUnfinishedBrowserProfileSends,
  completeFanslySendAttempt,
  countBrowserProfileSendsSince,
  endPageBrowserOnboarding,
  findOnboardingProfile,
  insertObservation,
  journalBrowserProfileSend,
  lastBrowserProfileSendAt,
  listOnboardingLinksWanted,
  lockOnboardingLink,
  nextBrowserAttemptId,
  OnboardingLinkLostError,
  readBrowserProfileRouteJournal,
  readProfileIntakePosition,
  recordOnboardingIdentity,
  recordPageBrowserLinkError,
  recordPageBrowserState,
  takeOnboardingLink,
  writePageBrowserIntake,
  type Database,
  type FanslySendHolderIdentity,
  type OnboardingIdentityResult,
  type OnboardingProfile,
  type SyncRouteSend,
} from "@agency_hub_core/db";
import { buildFanslyWireUrl, FANSLY_WIRE_MAX_BODY_BYTES, fanslyWireSpec, readFanslyWireResponse, type FanslyWireOutcome } from "@agency_hub_core/fansly";
import { FANSLY_PAUSE_MIN_MS, redactSensitiveText, type AppConfig } from "@agency_hub_core/shared";

import {
  onboardingLinkProblem,
  pageBrowserRpcUrl,
  readOnboardingLinkRevision,
  readOnboardingLinkSettings,
} from "../../services/egress/page-browser-link.ts";
import { REFUSALS, type CommandKind, type CommandResult, type Mode, type Refusal, type State } from "../../services/egress/page-browser-protocol.ts";
import {
  PageBrowserRpcClient,
  systemMonoBridge,
  type CheckReply,
  type DeliveredEvents,
  type DeliveredResult,
  type MonoBridge,
  type PageBrowserLinkSettings,
  type PageBrowserRpcTiming,
} from "../../services/egress/page-browser-rpc.ts";
import { errorName, type SyncLogger } from "../engine/commit.ts";
import { FLOOR_LOOKBACK_MS, Pacer, REQUEST_TIMEOUT_MS, TAKEOVER_FACTOR, type Admission, type PacerDeps } from "../engine/pacer.ts";
import { cryptoRng, noopMetrics, systemClock, type Clock, type Metrics, type PauseSource, type Rng } from "../engine/ports.ts";
import { EMPTY_ROUTE_STATE, routeAdmissionView, RouteClocks, routeJournalLookbackMs, type RouteState } from "../engine/route-policy.ts";
import {
  classifySiteRequest,
  decideSite,
  SITE_END_WAIT_MS,
  SITE_WAIT_MS,
  siteAnswerEffect,
  transportOutcomeOfSite,
} from "../engine/site-admission.ts";
import { routeOfEngineOperation, routeOfLegacyOperation, type FanslyRoute } from "./routes.ts";
import { BrowserSiteAdmission, SEND_REPORT_GUARD_MS } from "./browser-site.ts";
import { siteResponseObservation } from "./browser-site-capture.ts";
import { prepareJournalBody } from "./capture.ts";
import { accountOf } from "./identity-without-page.ts";

// A new page's onboarding through its own browser, on the engine's side
// (Project Browser plan §3.2 «Подключение новой страницы через браузер»,
// steps 2–3, §4.8; stage 3 PR 16). A profile `add-profile` made serves no
// page yet: no actor, no page row, no owner generation of a page. The engine
// links to its operator by the profile alone, while the owner's onboarding
// of it is under way (`page_browsers.onboarding`) or an identity request
// waits for its answer:
//
// - One process at a time drives these links: a session advisory lock
//   `(58216, 2)` on a connection of its own (as the public reader's (58216,
//   1)); a lost lock stops every link. Every take of a link raises the
//   profile's `link_generation` — the hello's owner generation, page 0 at the
//   operator (`ONBOARDING_PAGE_ID`): an earlier link is superseded there and
//   fenced off here (`lockOnboardingLink` before every write and every grant).
// - The owner's login (`login`): the operator into the manual login and the
//   browser started (`setMode`, `restartBrowser`), as PR 15's driver does for
//   a page. The site's requests are admitted by the profile key (plan §3.2,
//   step 2): the login operations and the reads its interface makes only
//   (`loginOnly`: everything else, and every socket, refused at once); the
//   owner's pause S × (1 + u) between any two sends of the profile, one in
//   flight (the engine's pacer, its floor 1.2 × S after the profile's last
//   send — the journal's, and the operator's `quiesced`); the route and
//   family budgets a page's sends keep (`engine/route-policy.ts`), the hour's
//   ceiling and a 429's hold of its route, by the site decision a page's
//   requests take (`decideSite`) — the clocks read from the profile's journal
//   on every slot, so a new link (a restart) is held as the one before was
//   (Astra's review of PR 16, item 4); each journaled in `fansly_send_log`
//   without a page (source `onboarding`, the profile and the attempt), as
//   today's check without a page is. Only while the onboarding is the
//   owner's login in the generation the request was admitted in, checked
//   under the profile's row lock — the journal's entry under one, the grant
//   itself under another (Astra's review of PR 16, item 3): a move (given
//   up, the login closed) or a binding that commits first refuses the grant,
//   one that comes after waits for it.
// - The login closed (`open`): the operator back in the automation (it checks
//   the exit IP and loads the site anew); the site's own requests are then
//   refused (`mode`), nothing of it runs but its documents.
// - The identity check (plan §3.2, step 3): one `GET /account/me` through the
//   browser — a Hub request under the same pacer, journaled without a page
//   under the request's source (`onboarding`, `credentials_verify`) — and its
//   answer journaled in `observations` (`pull`, no page: the account it names
//   as its native ref) with the profile's `identity_result`, in one
//   transaction; the operator's copy acknowledged after. It proves the
//   account (Astra's review of PR 16, item 1; PR 15's rule) only when the
//   operator's own `sent` came — its clock at the gate's first bytes; without
//   it the send instant is unknown and proves nothing — and that instant lies
//   after the automation came back in the onboarding generation that still
//   holds: once the owner closed the login (`open`, a new generation) the
//   link asks the operator for the automation and takes the instant its
//   answer arrived as the login's boundary (no person is in the browser
//   after it); a read sent before it, or answered once a move made another
//   generation, names no account.
// - Given up (`closing`): the browser stopped (`stopPage`: the exit closed,
//   Chrome quit; the profile kept), the automation back, then `off`.
// - The buffer's events: the site's answers journaled in `observations`
//   (`browser_site`, keyed by the profile), the position on the profile's
//   row with them — the page's intake goes on from it once bound.
//
// Once the profile is bound (the API's binding raises its link generation)
// the link closes without a command: the page's own slot takes the browser
// (its hello, a newer generation of the page's own, supersedes this one). A
// shutdown leaves the browser running.

/** The onboarding links' advisory lock: one process drives them. */
export const ONBOARDING_LOCK_KEY = [58216, 2] as const;

export interface BrowserOnboardingTiming {
  /** How often the task looks at the profiles. */
  everyMs: number;
  /** How often a link looks at its profile and its operator. */
  driveEveryMs: number;
  /** A command's wait for its result (and its deadline at the operator). */
  commandWaitMs: number;
  /** A closing onboarding whose operator cannot be reached ends after this. */
  unreachableEndMs: number;
  /** A start asked of a browser that stands is asked again after this. */
  restartEveryMs: number;
  /** The site loop's wait while nothing of the site waits. */
  siteIdleMs: number;
  /** The operator's state is recorded at most this often (and on a change). */
  stateRecordMs: number;
  /** A lock held elsewhere, or lost, is tried again after this. */
  lockRetryMs: number;
  /** An identity request the browser cannot serve (not up at the site, in the
   *  automation) is answered with why after this. */
  identityWaitMs: number;
  /** A Hub request's wait for its result. */
  resultWaitMs: number;
  /** An account read's wait for the operator to confirm the session it went
   *  under (`confirmsRead`). */
  confirmWaitMs: number;
}

export const BROWSER_ONBOARDING_TIMING: Readonly<BrowserOnboardingTiming> = Object.freeze({
  everyMs: 1_000,
  driveEveryMs: 500,
  commandWaitMs: 15_000,
  unreachableEndMs: 15_000,
  restartEveryMs: 30_000,
  siteIdleMs: 50,
  stateRecordMs: 1_000,
  lockRetryMs: 5_000,
  identityWaitMs: 45_000,
  resultWaitMs: 60_000,
  confirmWaitMs: 15_000,
});

/** TESTS ONLY: the operator's address and hello, scaled timings, a pacer
 *  with a test setting floor (as the host's `pacerFactory`). Never passed by
 *  `main.ts`. */
export interface BrowserOnboardingOverrides {
  url?: (profileId: string) => string;
  settings?: (profileId: string) => Promise<PageBrowserLinkSettings>;
  rpcTiming?: Partial<PageBrowserRpcTiming>;
  timing?: Partial<BrowserOnboardingTiming>;
  pacerFactory?: (deps: PacerDeps) => Pacer;
  /** Awaited between a site request's journal entry and its grant (a test
   *  moves the onboarding there). */
  beforeGrant?: (siteRequestId: string) => Promise<void>;
  /** Awaited right before an account read's grant is written, under the
   *  profile's row lock (a test moves the onboarding there). */
  beforeCheckAnswer?: (attemptId: number) => Promise<void>;
  /** Awaited after a look read the profile, before it acts on it (a test
   *  lets the profile change meanwhile). */
  afterProfileRead?: (profile: OnboardingProfile) => Promise<void>;
  /** Every route and family interval × this (`RoutePolicyOptions.timeScale`). */
  routeTimeScale?: number;
}

/** A route hold an answer puts on the profile is kept at most this long
 *  (the journal is read back as far for it). */
const ROUTE_HOLD_MAX_MS = 3_600_000;
/** The site loop's longest wait for a route that opens later: a request of
 *  another route asked meanwhile waits no longer. */
const ROUTE_WAIT_STEP_MS = 250;

/** A profile's journal operation as the route clocks read it: the site's
 *  and the login's (`site:<route>`, `login:<route>`) by their route, the
 *  engine's own (the account's read) by its legacy operation. */
function routeSendOf(operation: string, lastAt: Date): SyncRouteSend {
  const site = /^(?:site|login):(.+)$/.exec(operation);
  return site === null ? { journal: "legacy", operation, lastAt } : { journal: "engine", operation: site[1]!, lastAt };
}

function routeOfProfileOperation(operation: string): FanslyRoute | null {
  const send = routeSendOf(operation, new Date(0));
  return send.journal === "engine" ? routeOfEngineOperation(send.operation) : routeOfLegacyOperation(send.operation);
}

export interface BrowserOnboardingOptions {
  db: Database;
  connectionString: string;
  config: Pick<AppConfig, "encryptionKey" | "encryptionKeyVersion" | "encryptionKeysByVersion" | "fanslyBaseUrl">;
  logger: SyncLogger;
  /** The owner's S (the pacer's setting). */
  pause: PauseSource;
  /** The journal's holder (this process). */
  holder: FanslySendHolderIdentity;
  metrics?: Metrics;
  clock?: Clock;
  rng?: Rng;
  overrides?: BrowserOnboardingOverrides;
}

/** The onboarding links of a `sync` process. */
export class BrowserOnboardingTask {
  readonly #o: BrowserOnboardingOptions;
  readonly #timing: BrowserOnboardingTiming;
  readonly #links = new Map<string, OnboardingLink>();
  #lock: pg.Client | null = null;
  #lockAlive = false;
  #nextLockTry = 0;
  #timer: ReturnType<typeof setInterval> | null = null;
  #running: Promise<void> | null = null;
  #stopped = false;

  constructor(options: BrowserOnboardingOptions) {
    this.#o = options;
    this.#timing = { ...BROWSER_ONBOARDING_TIMING, ...options.overrides?.timing };
  }

  get links(): ReadonlyMap<string, OnboardingLink> {
    return this.#links;
  }

  start(): void {
    if (this.#stopped || this.#timer !== null) return;
    this.#timer = setInterval(() => void this.tick(), this.#timing.everyMs);
    this.#timer.unref?.();
    void this.tick();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    await this.#running?.catch(() => undefined);
    await this.#stopLinks("the process stops");
    await this.#releaseLock();
  }

  /** One look (tests call it). */
  tick(): Promise<void> {
    if (this.#running !== null || this.#stopped) return this.#running ?? Promise.resolve();
    this.#running = this.#pass()
      .catch((error: unknown) => {
        this.#o.logger.warn({ err: errorName(error) }, "Fansly sync browser onboarding: a pass failed; it is tried again");
      })
      .finally(() => {
        this.#running = null;
      });
    return this.#running;
  }

  async #pass(): Promise<void> {
    if (!(await this.#holdLock())) {
      await this.#stopLinks("the onboarding lock is not this process's");
      return;
    }
    const wanted = await listOnboardingLinksWanted(this.#o.db);
    const ids = new Set<string>();
    for (const profile of wanted) {
      if (onboardingLinkProblem(profile) !== null && this.#o.overrides?.settings === undefined) continue;
      ids.add(profile.profileId);
      if (this.#links.has(profile.profileId)) continue;
      const generation = await takeOnboardingLink(this.#o.db, profile.profileId);
      if (generation === null) continue;
      const link = new OnboardingLink(this.#o, this.#timing, profile, generation, () => this.#lockAlive && !this.#stopped);
      this.#links.set(profile.profileId, link);
      this.#o.logger.info({ profileId: profile.profileId, generation: generation.toString(), onboarding: profile.onboarding },
        "Fansly sync browser onboarding: the link to a profile no page has is taken");
      try {
        await link.start();
      } catch (error) {
        this.#links.delete(profile.profileId);
        await link.stop("its start failed");
        this.#o.logger.warn({ profileId: profile.profileId, err: errorName(error) }, "Fansly sync browser onboarding: the link could not start; tried again");
      }
    }
    for (const [profileId, link] of [...this.#links]) {
      if (!ids.has(profileId) || link.lost) {
        this.#links.delete(profileId);
        await link.stop(link.lost ? "its generation no longer holds the profile" : "nothing of the onboarding is left for it");
      }
    }
  }

  async #stopLinks(why: string): Promise<void> {
    const links = [...this.#links.values()];
    this.#links.clear();
    await Promise.all(links.map((link) => link.stop(why)));
  }

  async #holdLock(): Promise<boolean> {
    if (this.#lock !== null && this.#lockAlive) return true;
    if (Date.now() < this.#nextLockTry) return false;
    this.#nextLockTry = Date.now() + this.#timing.lockRetryMs;
    await this.#releaseLock();
    const client = new pg.Client({ connectionString: this.#o.connectionString, application_name: "fansly-sync-onboarding", connectionTimeoutMillis: 5_000, query_timeout: 5_000 });
    const lost = () => {
      if (this.#lock === client) this.#lockAlive = false;
    };
    client.on("error", lost);
    client.on("end", lost);
    try {
      await client.connect();
      const result = await client.query<{ locked: boolean }>("select pg_try_advisory_lock($1, $2) as locked", [...ONBOARDING_LOCK_KEY]);
      if (result.rows[0]?.locked !== true) {
        await client.end().catch(() => undefined);
        return false;
      }
    } catch (error) {
      await client.end().catch(() => undefined);
      this.#o.logger.warn({ err: errorName(error) }, "Fansly sync browser onboarding: its lock could not be had");
      return false;
    }
    this.#lock = client;
    this.#lockAlive = true;
    return true;
  }

  async #releaseLock(): Promise<void> {
    const client = this.#lock;
    this.#lock = null;
    this.#lockAlive = false;
    if (client !== null) await client.end().catch(() => undefined);
  }
}

/** The browser stands, waiting for a start: never started, or stopped —
 *  not in a failure's backoff, not halted for the owner's decision. */
function stands(state: State): boolean {
  return state.step === "exit_closed" && !state.exitOpen && state.retryAtWall === null && (state.stopReason === null || state.stopReason === "owner_stop");
}

const STEP_ORDER = ["exit_closed", "env_applied", "chrome_started", "control_attached", "selftest_passed", "exit_ip_verified", "exit_open", "site_loaded", "session_confirmed", "ready"];

/** The browser can take a Hub request: up at the site, in the automation. */
function takesHubRequests(state: State): boolean {
  return state.mode === "automation" && state.exitOpen && state.stopReason === null && state.sessionFingerprint !== null
    && STEP_ORDER.indexOf(state.step) >= STEP_ORDER.indexOf("site_loaded");
}

/** The operator confirmed the session an account read went under — PR 15's
 *  mechanism, a page's «ready only after a fresh identity read under the
 *  live session», which for a profile no page has confirms whatever account
 *  the read named, but only under the session the site showed after the
 *  person's login (Astra's review of PR 16, round 2): it says so in its
 *  state, at `session_confirmed` or later, with that account and that
 *  session live. */
export function confirmsRead(state: State | null, accountId: string, fingerprint: string): boolean {
  return state !== null && state.mode === "automation" && state.stopReason === null && state.exitOpen
    && STEP_ORDER.indexOf(state.step) >= STEP_ORDER.indexOf("session_confirmed")
    && state.sessionFingerprint === fingerprint && state.accountId === accountId;
}

const PROTOCOL_REFUSALS: ReadonlySet<string> = new Set(REFUSALS);

/** The link to one profile no page has. */
export class OnboardingLink {
  readonly profileId: string;
  readonly generation: bigint;
  readonly client: PageBrowserRpcClient;
  readonly site: BrowserSiteAdmission;
  readonly pacer: Pacer;
  readonly #o: BrowserOnboardingOptions;
  readonly #t: BrowserOnboardingTiming;
  readonly #clock: Clock;
  readonly #metrics: Metrics;
  readonly #bridge: MonoBridge;
  readonly #holds: () => boolean;
  readonly #stop = new AbortController();
  readonly #unlisten: Array<() => void> = [];
  #profile: OnboardingProfile;
  #lost = false;
  #stopped: Promise<void> | null = null;
  #driveTimer: ReturnType<typeof setInterval> | null = null;
  #driving: Promise<void> | null = null;
  #siteLoop: Promise<void> | null = null;
  #slot: Promise<void> = Promise.resolve();
  #lastStartMono = Number.NEGATIVE_INFINITY;
  #unreachableSince: number | null = null;
  /** When the pin the browser halted under was set (a changed exit IP): a
   *  pin set after it — the owner's word on the IP — starts it again. */
  #haltedPinAt: number | null = null;
  /** The login's boundary in an open onboarding: the generation and the
   *  instant (this process's monotonic clock) the operator's answer that the
   *  automation is back arrived. An identity read proves the account only if
   *  it was sent after it, in that generation. */
  #automationBack: { generation: bigint; mono: number } | null = null;
  #identity: Promise<void> | null = null;
  /** The identity request this link answered last: never read again, even
   *  when a look read the profile before its answer was written. */
  #answeredRequest: string | null = null;
  #lastRecorded: { at: number; key: string } | null = null;
  #subscribed: string | null = null;
  #intake: Promise<void> = Promise.resolve();
  #committedSeq = 0;

  constructor(options: BrowserOnboardingOptions, timing: BrowserOnboardingTiming, profile: OnboardingProfile, generation: bigint, holds: () => boolean) {
    this.#o = options;
    this.#t = timing;
    this.#profile = profile;
    this.profileId = profile.profileId;
    this.generation = generation;
    this.#holds = holds;
    this.#clock = options.clock ?? systemClock;
    this.#metrics = options.metrics ?? noopMetrics;
    this.#bridge = systemMonoBridge();
    const overrides = options.overrides ?? {};
    this.client = new PageBrowserRpcClient({
      url: overrides.url?.(profile.profileId) ?? pageBrowserRpcUrl(profile.container),
      ownerGeneration: generation,
      settings: overrides.settings !== undefined
        ? () => overrides.settings!(profile.profileId)
        : () => readOnboardingLinkSettings({ db: options.db, config: options.config }, profile.profileId),
      ...(overrides.settings !== undefined ? {} : { revision: () => readOnboardingLinkRevision({ db: options.db }, profile.profileId) }),
      logger: options.logger,
      ...(overrides.rpcTiming === undefined ? {} : { timing: overrides.rpcTiming }),
    });
    this.site = new BrowserSiteAdmission({ client: this.client, bridge: this.#bridge, monoNow: () => this.#clock.monoNow(), metrics: this.#metrics, loginOnly: true });
    const pacerDeps: PacerDeps = {
      clock: this.#clock,
      rng: options.rng ?? cryptoRng,
      pause: options.pause,
      ownership: { alive: () => !this.#lost && this.#stopped === null && this.#holds() },
    };
    this.pacer = overrides.pacerFactory?.(pacerDeps) ?? new Pacer(pacerDeps);
  }

  /** Its generation no longer holds the profile (bound, removed, taken
   *  again): the task closes it. */
  get lost(): boolean {
    return this.#lost;
  }

  async start(): Promise<void> {
    const { db, logger } = this.#o;
    // The earlier links' sends that never completed may have gone: closed
    // as unknown, and counted for the pause.
    await closeUnfinishedBrowserProfileSends(db, this.profileId);
    // S as the host reads it for a takeover floor (never below the owner's minimum).
    const settingMs = Math.max(await this.#o.pause.readSettingMs(), FANSLY_PAUSE_MIN_MS);
    const last = await lastBrowserProfileSendAt(db, { profileId: this.profileId, lookbackMs: FLOOR_LOOKBACK_MS });
    const floorDelayMs = last === null ? 0 : last.getTime() + Math.ceil(TAKEOVER_FACTOR * settingMs) - Date.now();
    this.pacer.initTakeover(Math.max(0, floorDelayMs));
    this.#unlisten.push(this.client.onQuiesced((quiesced) => {
      if (quiesced.lastSendMono === null) return;
      try {
        this.pacer.raiseTakeoverFloor(this.#bridge.fromKernel(quiesced.lastSendMono) + SEND_REPORT_GUARD_MS + Math.ceil(TAKEOVER_FACTOR * settingMs));
      } catch (error) {
        logger.warn({ profileId: this.profileId, err: errorName(error) }, "Fansly sync browser onboarding: the floor of the operator's last send could not be set");
      }
    }));
    this.#unlisten.push(this.client.onState((state) => this.#record(state)));
    this.#unlisten.push(this.client.onLink((status) => {
      if (status.kind === "up") this.#subscribe(status.bufferId);
      else this.#subscribed = null;
      if (status.kind === "refused") {
        void recordPageBrowserLinkError(db, { profileId: this.profileId, linkError: status.reason === "protocol_major" ? "protocol_version" : status.reason }).catch(() => undefined);
      }
    }));
    this.client.onEvents((delivered) => {
      this.#intake = this.#intake.then(() => this.#takeEvents(delivered)).catch((error: unknown) => {
        logger.warn({ profileId: this.profileId, err: errorName(error) }, "Fansly sync browser onboarding: an event batch was not taken; it comes again");
      });
    });
    this.client.onEventsRefused((refused) => {
      if (refused.reason === "ahead") {
        logger.warn({ profileId: this.profileId, bufferId: refused.bufferId }, "Fansly sync browser onboarding: the operator's buffer is behind what Hub took of it; nothing more is taken of it");
        return;
      }
      this.#subscribed = null;
      if (refused.reason !== "unavailable") this.#subscribe(refused.bufferId, refused.reason === "foreign_buffer" ? 0 : null);
    });
    // Ends and results of earlier links nobody waits for: acknowledged (their
    // sends were closed as unknown at this link's start).
    this.client.onUnclaimedOutcome((end) => this.client.resultAck(end.attemptId));
    this.client.onUnclaimedResult((delivered) => {
      if (delivered.bodyProblem === null) this.client.resultAck(delivered.result.attemptId);
    });
    this.client.start();
    this.#driveTimer = setInterval(() => void this.drive(), this.#t.driveEveryMs);
    this.#driveTimer.unref?.();
    this.#siteLoop = this.#runSite();
  }

  async stop(why: string): Promise<void> {
    this.#stopped ??= (async () => {
      this.#stop.abort(new Error(why));
      this.pacer.stop();
      if (this.#driveTimer !== null) clearInterval(this.#driveTimer);
      this.#driveTimer = null;
      await this.#driving?.catch(() => undefined);
      this.site.close();
      await this.#siteLoop?.catch(() => undefined);
      await this.#identity?.catch(() => undefined);
      await this.#intake.catch(() => undefined);
      for (const unlisten of this.#unlisten.splice(0)) unlisten();
      this.client.onEvents(null);
      this.client.onEventsRefused(null);
      this.client.onUnclaimedOutcome(null);
      this.client.onUnclaimedResult(null);
      await this.client.close();
      this.#o.logger.info({ profileId: this.profileId, generation: this.generation.toString(), why }, "Fansly sync browser onboarding: the link closed");
    })().catch(() => undefined);
    return this.#stopped;
  }

  // ── the owner's onboarding, followed ────────────────────────────────────

  /** One look: the profile as stored, the operator's word, one step. */
  drive(): Promise<void> {
    if (this.#driving !== null || this.#stopped !== null) return this.#driving ?? Promise.resolve();
    this.#driving = this.#drive()
      .catch((error: unknown) => {
        if (error instanceof OnboardingLinkLostError) {
          this.#lost = true;
          return;
        }
        this.#o.logger.warn({ profileId: this.profileId, err: errorName(error) }, "Fansly sync browser onboarding: a look failed; it is tried again");
      })
      .finally(() => {
        this.#driving = null;
      });
    return this.#driving;
  }

  async #drive(): Promise<void> {
    const profile = await findOnboardingProfile(this.#o.db, this.profileId);
    await this.#o.overrides?.afterProfileRead?.(profile!);
    if (profile === null || profile.pageId !== null || profile.linkGeneration !== this.generation) {
      this.#lost = true;
      return;
    }
    this.#profile = profile;
    const client = this.client;
    // A pin or a proxy changed since the hello: said again.
    if (client.up && this.#o.overrides?.settings === undefined) {
      const now = await client.settingsDigestNow().catch(() => null);
      if (now !== null && client.helloDigest !== null && now !== client.helloDigest) {
        client.reconnect("the profile's pin or proxy changed");
        return;
      }
    }
    const state = client.state;
    if (!client.up || client.quiesced === null || state === null) {
      if (profile.onboarding !== "closing") {
        this.#unreachableSince = null;
        return;
      }
      const now = this.#clock.monoNow();
      this.#unreachableSince ??= now;
      if (now - this.#unreachableSince >= this.#t.unreachableEndMs) await this.#endOnboarding("the browser cannot be reached: no one can be in it");
      return;
    }
    this.#unreachableSince = null;
    if (state.stopReason === "exit_ip_changed") this.#haltedPinAt ??= profile.pinnedExitIpAt?.getTime() ?? 0;
    else this.#haltedPinAt = null;
    switch (profile.onboarding) {
      case "login":
        if (state.mode !== "manual_login") {
          await this.#command({ kind: "setMode", mode: "manual_login" }, "the owner opened the login");
          return;
        }
        await this.#startIfStanding(state, "the browser stands: its login screen comes with its start");
        return;
      case "open":
        if (state.mode !== "automation" || this.#automationBack?.generation !== profile.onboardingGeneration) {
          // Asked even of an operator that says it is in the automation: its
          // answer, after the change, is the boundary of this generation's
          // login (the state may lag behind a command).
          const result = await this.#command({ kind: "setMode", mode: "automation" }, "the owner closed the login");
          if (result?.ok === true) this.#automationBack = { generation: profile.onboardingGeneration, mono: this.#clock.monoNow() };
          return;
        }
        await this.#startIfStanding(state, "the browser stands: the account is checked through it");
        this.#maybeIdentity(profile, state);
        return;
      case "closing":
        if (!(state.step === "exit_closed" && !state.exitOpen)) {
          await this.#command("stopPage", "the owner gave the onboarding up: the browser stops, its profile kept");
          return;
        }
        if (state.mode !== "automation") {
          const result = await this.#command({ kind: "setMode", mode: "automation" }, "the onboarding is given up");
          if (result === null || !result.ok) return;
        }
        await this.#endOnboarding("the browser is stopped");
        return;
      case "off":
        // Only an identity request keeps the link: answered with why not.
        this.#maybeIdentity(profile, state);
        return;
    }
  }

  /** A browser that stands is started (`restartBrowser`); one halted for a
   *  changed exit IP is started again once the owner pinned the IP again —
   *  his word on what the browser should see (PR 17's `sync browser pin-ip`
   *  then `start`, for a profile no page has). */
  async #startIfStanding(state: State, why: string): Promise<void> {
    const now = this.#clock.monoNow();
    const pinnedAt = this.#profile.pinnedExitIpAt?.getTime() ?? 0;
    const repinned = state.stopReason === "exit_ip_changed" && this.#haltedPinAt !== null && pinnedAt > this.#haltedPinAt;
    if (repinned) {
      this.#haltedPinAt = pinnedAt;
      this.#lastStartMono = now;
      await this.#command("restartBrowser", "the owner pinned the exit IP again: the browser starts again and checks it");
      return;
    }
    if (!stands(state) || now - this.#lastStartMono < this.#t.restartEveryMs) return;
    this.#lastStartMono = now;
    await this.#command("restartBrowser", why);
  }

  async #command(kind: CommandKind | { kind: "setMode"; mode: Mode }, why: string): Promise<CommandResult | null> {
    const name = typeof kind === "string" ? kind : `setMode:${kind.mode}`;
    const waitMs = this.#t.commandWaitMs;
    const result = await this.client.command(kind, this.#bridge.toKernel(this.#clock.monoNow() + waitMs), waitMs);
    this.#metrics.increment("sync_browser_onboarding_command", { command: name, ok: result?.ok === true ? "true" : result === null ? "unknown" : "false" });
    this.#o.logger.info({ profileId: this.profileId, command: name, why, ok: result?.ok ?? null, detail: result?.detail ?? "no answer" },
      "Fansly sync browser onboarding: a command to the operator");
    return result;
  }

  async #endOnboarding(why: string): Promise<void> {
    const ended = await this.#fenced((tx) => endPageBrowserOnboarding(tx, { profileId: this.profileId, by: "engine" }));
    if (ended) this.#o.logger.info({ profileId: this.profileId, why }, "Fansly sync browser onboarding: given up; the profile stays, unbound");
  }

  async #fenced<T>(body: (tx: Database, profile: OnboardingProfile) => Promise<T>): Promise<T> {
    try {
      return await this.#o.db.transaction(async (raw) => {
        const tx = raw as unknown as Database;
        const profile = await lockOnboardingLink(tx, { profileId: this.profileId, generation: this.generation });
        return body(tx, profile);
      });
    } catch (error) {
      if (error instanceof OnboardingLinkLostError) this.#lost = true;
      throw error;
    }
  }

  #record(state: State): void {
    const key = JSON.stringify([state.step, state.stopReason, state.mode, state.exitOpen, state.sessionFingerprint, state.accountId, state.exitIp, state.selfTest?.ok ?? null]);
    const now = this.#clock.monoNow();
    if (this.#lastRecorded !== null && this.#lastRecorded.key === key && now - this.#lastRecorded.at < this.#t.stateRecordMs) return;
    this.#lastRecorded = { at: now, key };
    void recordPageBrowserState(this.#o.db, {
      profileId: this.profileId,
      step: state.step,
      stopReason: state.stopReason,
      mode: state.mode,
      exitOpen: state.exitOpen,
      sessionFingerprint: state.sessionFingerprint,
      accountId: state.accountId,
      exitIp: state.exitIp,
      chromeVersion: state.chromeVersion,
      operatorVersion: state.operatorVersion,
      selfTest: state.selfTest === null ? null : { ok: state.selfTest.ok, at: new Date(state.selfTest.atWall), failed: state.selfTest.failed },
      buffer: { bytes: state.buffer.bytes, oldestAgeMs: state.buffer.oldestAgeMs },
    }).catch(() => undefined);
  }

  // ── one send at a time: the site's and the identity check's ────────────

  /** The slot: one admission of the profile at a time (the pacer's I2 says
   *  so too; this orders the two loops that ask for it). */
  #inSlot<T>(body: () => Promise<T>): Promise<T> {
    const run = this.#slot.then(body, body);
    this.#slot = run.then(() => undefined, () => undefined);
    return run;
  }

  async #runSite(): Promise<void> {
    const signal = this.#stop.signal;
    while (!signal.aborted) {
      try {
        const waitMs = await this.#siteStep(signal);
        if (waitMs > 0) await this.#clock.sleep(waitMs, signal);
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof OnboardingLinkLostError) return;
        this.#o.logger.warn({ profileId: this.profileId, err: errorName(error) }, "Fansly sync browser onboarding: a site request's admission failed");
        await this.#clock.sleep(this.#t.driveEveryMs, signal).catch(() => undefined);
      }
    }
  }

  /** The profile's route clocks now: its journal's sends and the holds its
   *  answers put on routes. */
  async #routeClocks(): Promise<RouteClocks> {
    const scale = this.#o.overrides?.routeTimeScale;
    const options = scale === undefined ? {} : { timeScale: scale };
    const read = await readBrowserProfileRouteJournal(this.#o.db, {
      profileId: this.profileId,
      withinMs: routeJournalLookbackMs(EMPTY_ROUTE_STATE, options),
      holdsWithinMs: ROUTE_HOLD_MAX_MS,
    });
    const routes: RouteState["routes"] = {};
    for (const hold of read.holds) {
      const route = routeOfProfileOperation(hold.operation);
      if (route === null) continue;
      routes[route] = { holdUntil: hold.until.toISOString(), ladderStep: 0, effectivePerMin: null, policyVersion: null, last429AttemptId: null, last429At: null, revision: 0 };
    }
    return new RouteClocks({ sends: read.sends.map((send) => routeSendOf(send.operation, send.lastAt)), state: { routes }, ...options });
  }

  /** Refuse what cannot pass; admit the oldest that can. 0: one went (or
   *  was refused at its grant); else how long to wait before looking again. */
  async #siteStep(signal: AbortSignal): Promise<number> {
    const idle = this.#t.siteIdleMs;
    if (this.#refuseExpired() === 0) return idle;
    return this.#inSlot(async () => {
      if (this.#refuseExpired() === 0) return idle;
      const grant = await this.pacer.waitForSlot(signal);
      // At the slot: what still waits, and may pass now — by the decision a
      // page's site requests take: the hour's ceiling, the route and family
      // budgets and holds (the manual login's own exemptions; the profile
      // has no pause or hold of a page).
      if (this.#refuseExpired() === 0) return idle;
      const now = this.#clock.wallNow();
      const view = routeAdmissionView(await this.#routeClocks(), [], now);
      const sendsLastHour = await countBrowserProfileSendsSince(this.#o.db, { profileId: this.profileId, since: new Date(now.getTime() - 3_600_000) });
      const decision = decideSite(this.site.pending(), {
        nowMono: this.#clock.monoNow(),
        now,
        pausedAll: false,
        pageHeld: null,
        checksOnly: false,
        routeOpensAt: (route) => {
          const closure = view.routeOpensAt(route);
          return closure === null ? null : { at: closure.at };
        },
        sendsLastHour,
      });
      for (const refusal of decision.refuse) this.site.refuse(refusal.id, refusal.reason);
      const admit = decision.admit;
      if (admit === null) {
        // Looked at again when the first closed route opens (or sooner).
        let opensInMs = Number.POSITIVE_INFINITY;
        for (const request of this.site.pending()) {
          const classified = classifySiteRequest(request);
          if ("refuse" in classified) continue;
          const at = view.routeOpensAt(classified.route)?.at.getTime();
          if (at !== undefined) opensInMs = Math.min(opensInMs, at - now.getTime());
        }
        return Math.max(idle, Math.min(ROUTE_WAIT_STEP_MS, opensInMs));
      }
      const chosen = { id: admit.request.id, route: admit.route, origin: admit.origin, manualLogin: admit.exempt };
      const attemptId = await nextBrowserAttemptId(this.#o.db);
      const token = randomUUID();
      const issuedMono = this.#clock.monoNow();
      // Journaled only while the owner's login is open: what it was admitted
      // in is what its grant is checked against.
      const generation = await this.#fenced(async (tx, profile) => {
        if (profile.onboarding !== "login") return null;
        await journalBrowserProfileSend(tx, {
          token,
          source: "onboarding",
          operation: `${chosen.origin}:${chosen.route}`,
          holder: this.#o.holder,
          profileId: this.profileId,
          attemptId,
          settingMs: grant.settingMs,
          jitterU: grant.jitterU,
          pauseMs: grant.pauseMs,
        });
        return profile.onboardingGeneration;
      });
      if (generation === null) {
        // The login is no longer open: nothing of the site passes.
        for (const request of this.site.pending()) this.site.refuse(request.id, "mode");
        return idle;
      }
      const admission = this.pacer.arm(grant, attemptId, issuedMono);
      const refusal = this.pacer.checkRemoteGrant(admission);
      if (refusal !== null) {
        this.site.refuse(chosen.id, "lease");
        await this.#complete(admission, token, { kind: "aborted_before_send", refusal: refusal.reason }, null);
        return 0;
      }
      await this.#o.overrides?.beforeGrant?.(chosen.id);
      // The grant under the profile's row lock, the login still open in that
      // generation: the owner's move and the binding wait for it, and none
      // goes once either committed.
      let granted = false;
      try {
        await this.#fenced(async (_tx, profile) => {
          if (profile.onboarding !== "login" || profile.onboardingGeneration !== generation) return;
          this.site.grant(chosen.id, { attemptId, sendWithinMs: Math.max(0, admission.sendDeadlineMono - this.#clock.monoNow()) });
          granted = true;
        });
      } catch (error) {
        // A failure after the grant went (its commit) changes nothing of it.
        if (!granted) this.#o.logger.warn({ profileId: this.profileId, err: errorName(error) }, "Fansly sync browser onboarding: a site request's grant could not be checked; refused");
      }
      if (!granted) {
        this.site.refuse(chosen.id, "mode");
        await this.#complete(admission, token, { kind: "aborted_before_send", refusal: "lease_inactive" }, null);
        this.#metrics.increment("sync_browser_onboarding_site", { origin: chosen.origin, outcome: "refused_at_grant" });
        return 0;
      }
      let end: Awaited<ReturnType<BrowserSiteAdmission["end"]>>;
      try {
        end = await this.site.end(chosen.id, AbortSignal.any([signal, AbortSignal.timeout(SITE_END_WAIT_MS)]));
      } catch {
        // No end heard: it may have gone (the safe upper bound).
        end = { kind: "transport_error", sent: true, message: "no end of the site request was heard" };
      }
      const outcome = transportOutcomeOfSite(end);
      // A 429 (or a 5xx naming its deadline) holds the route that answered:
      // recorded with the send's completion, read back by every slot.
      const effect = siteAnswerEffect(end, chosen.manualLogin);
      const hold = effect.kind === "route_limited" ? browserProfileRouteHoldDetail(Math.min(ROUTE_HOLD_MAX_MS, effect.retryAfterMs ?? 60_000)) : null;
      await this.#complete(admission, token, outcome, end.kind === "response" ? end.status : null, hold);
      this.site.settled(chosen.id, attemptId);
      this.#metrics.increment("sync_browser_onboarding_site", { origin: chosen.origin, outcome: outcome.kind });
      return 0;
    });
  }

  /** The requests whose wait is over, refused; how many still wait. */
  #refuseExpired(): number {
    const now = this.#clock.monoNow();
    let waiting = 0;
    for (const request of this.site.pending()) {
      const leftMs = Math.min(SITE_WAIT_MS - (now - request.askedMono), (request.waitDeadlineMono ?? Number.POSITIVE_INFINITY) - now);
      if (leftMs <= 0) this.site.refuse(request.id, "waited_too_long");
      else waiting += 1;
    }
    return waiting;
  }

  /** The pacer's completion and the journal's: the send instant as the
   *  browser reported it, on the wall clock. */
  async #complete(admission: Admission, token: string, outcome: FanslyWireOutcome, httpStatus: number | null, responseDetail: string | null = null): Promise<void> {
    this.pacer.complete(admission, outcome);
    const sentAt = admission.sentWall;
    await completeFanslySendAttempt(this.#o.db, {
      pageId: null,
      token,
      nextU: 0,
      outcome: outcome.kind,
      outcomeDetail: outcome.kind === "aborted_before_send" ? outcome.refusal : outcome.kind === "response" ? responseDetail : redactSensitiveText(outcome.message).slice(0, 200),
      httpStatus,
      sentAt,
      sendOffsetMs: admission.sentMono === null ? null : Math.max(0, Math.ceil(admission.sentMono - admission.issuedMono)),
    }).catch((error: unknown) => {
      this.#o.logger.warn({ profileId: this.profileId, err: errorName(error) }, "Fansly sync browser onboarding: a send's completion was not journaled");
    });
  }

  // ── the identity check (plan §3.2, step 3) ─────────────────────────────

  #maybeIdentity(profile: OnboardingProfile, state: State): void {
    const request = profile.identityRequest;
    if (request === null || this.#identity !== null || request.id === this.#answeredRequest) return;
    if (profile.identityResult?.requestId === request.id) return;
    const boundary = this.#automationBack;
    const bounded = boundary !== null && boundary.generation === profile.onboardingGeneration;
    if (profile.onboarding !== "open" || !takesHubRequests(state) || !bounded) {
      if (profile.onboarding === "open" && Date.now() - request.requestedAt.getTime() < this.#t.identityWaitMs) return;
      const why = profile.onboarding !== "open" ? `the onboarding is ${profile.onboarding}, not open`
        : state.mode !== "automation" || !bounded ? "a person is in the browser (its login is open)"
        : state.stopReason !== null ? `the browser stands (${state.stopReason})`
          : state.sessionFingerprint === null ? "the browser knows no live session: log it in first"
            : `the browser is not up at the site (${state.step})`;
      this.#identity = this.#fenced((tx) => recordOnboardingIdentity(tx, { profileId: this.profileId, result: { requestId: request.id, ok: false, error: why, httpStatus: null, at: new Date().toISOString() } }))
        .then(() => {
          this.#answeredRequest = request.id;
        })
        .finally(() => {
          this.#identity = null;
        });
      return;
    }
    this.#identity = this.#inSlot(() => this.#checkIdentity(request.id, request.source, state.sessionFingerprint!, boundary!))
      .catch((error: unknown) => {
        if (error instanceof OnboardingLinkLostError) return;
        this.#o.logger.warn({ profileId: this.profileId, err: errorName(error) }, "Fansly sync browser onboarding: the identity check failed; asked again on the next look");
      })
      .finally(() => {
        this.#identity = null;
      });
  }

  async #checkIdentity(requestId: string, source: "onboarding" | "credentials_verify", fingerprint: string, boundary: { generation: bigint; mono: number }): Promise<void> {
    const signal = this.#stop.signal;
    const spec = fanslyWireSpec("account.me");
    if (spec.legacyOperation === null || spec.kind === null) throw new Error("account.me is journaled under its legacy operation and its kind");
    // Its route's budget and hold first (a page's account check keeps them).
    for (;;) {
      const opensAt = (await this.#routeClocks()).notBefore("account.me");
      const waitMs = opensAt === null ? 0 : opensAt.getTime() - this.#clock.wallNow().getTime();
      if (waitMs <= 0) break;
      await this.#clock.sleep(Math.min(waitMs, 1_000), signal);
    }
    const grant = await this.pacer.waitForSlot(signal);
    const attemptId = await nextBrowserAttemptId(this.#o.db);
    const token = randomUUID();
    const issuedMono = this.#clock.monoNow();
    await this.#fenced((tx) => journalBrowserProfileSend(tx, {
      token,
      source,
      operation: spec.legacyOperation!,
      holder: this.#o.holder,
      profileId: this.profileId,
      attemptId,
      settingMs: grant.settingMs,
      jitterU: grant.jitterU,
      pauseMs: grant.pauseMs,
    }));
    const admission = this.pacer.arm(grant, attemptId, issuedMono);
    const sent = await this.#sendIdentity(admission, fingerprint, signal, { requestId, generation: boundary.generation });
    // One read a request: a look that read the profile before this answer
    // was written never sends another.
    this.#answeredRequest = requestId;
    const outcome = sent.outcome;
    await this.#complete(admission, token, outcome, outcome.kind === "response" ? outcome.status : null);
    const failure = (why: string): OnboardingIdentityResult => ({
      requestId,
      ok: false,
      error: redactSensitiveText(why).slice(0, 400),
      httpStatus: outcome.kind === "response" ? outcome.status : null,
      at: new Date().toISOString(),
    });
    let result: OnboardingIdentityResult;
    let observation: { kind: string; payload: unknown; payloadHash: Buffer; accountId: string } | null = null;
    try {
      const account = accountOf(outcome);
      // The observation is the engine's own body of the answer (the codec of
      // `fansly/capture.ts`), as a page's account read journals it.
      const read = outcome.kind === "response" ? readFanslyWireResponse(spec, {}, outcome) : null;
      if (read === null || read.kind !== "accepted") throw new Error("Fansly session verification returned an invalid account");
      const journal = prepareJournalBody({ kind: spec.kind }, { response: read.response, contractAccepted: true });
      // Captured whatever it proves (capture before parse).
      observation = { kind: spec.kind, payload: journal.payload, payloadHash: journal.payloadHash, accountId: account.id };
      // Proof: the operator's own `sent`, after the login's boundary; and
      // the operator's word that the session the read went under is the one
      // that exists after the login (its confirmation, `confirmsRead`).
      if (sent.sentFloorMono === null || admission.sentWall === null) {
        result = failure("the browser did not say when the account's read left it: what it names proves nothing — check again");
      } else if (sent.sentFloorMono <= boundary.mono) {
        result = failure("the account was read before the browser's login closed: check again");
      } else if (!(await this.#operatorConfirms(account.id, fingerprint, signal))) {
        result = failure("the browser did not confirm the session the account was read under as the one after the login (the site has not shown it since, or shows another): check again");
      } else {
        result = {
          requestId,
          ok: true,
          accountId: account.id,
          username: account.username ?? null,
          displayName: account.displayName ?? null,
          sentAt: admission.sentWall.toISOString(),
          onboardingGeneration: boundary.generation.toString(),
          sessionFingerprint: fingerprint,
          observationId: 0,
          attemptId,
        };
      }
    } catch (error) {
      result = failure(error instanceof Error ? error.message : String(error));
    }
    await this.#fenced(async (tx, profile) => {
      if (result.ok && (profile.onboarding !== "open" || profile.onboardingGeneration !== boundary.generation)) {
        // A move since (a login opened again, given up): the read is of
        // before it. (A move voids the request too: nothing is written then.)
        result = failure("the onboarding changed while the account was read: check again");
      } else if (result.ok && !confirmsRead(this.client.state, result.accountId, result.sessionFingerprint)) {
        // Still the browser's session, confirmed, at the write.
        result = failure("the browser's session changed while the account was read: check again");
      }
      if (observation !== null) {
        const inserted = await insertObservation(tx, {
          source: "pull",
          producer: "fansly-onboarding:account.me",
          platform: "fansly",
          accountId: null,
          nativeAccountRef: observation.accountId,
          kind: observation.kind,
          payload: observation.payload,
          payloadHash: observation.payloadHash,
          idempotencyKey: `fansly-onboarding:${this.profileId}:attempt:${attemptId}`,
        });
        if (result.ok) result = { ...result, observationId: inserted.observationId };
      }
      await recordOnboardingIdentity(tx, { profileId: this.profileId, result });
    });
    if (sent.whole) this.client.resultAck(attemptId);
    this.#metrics.increment("sync_browser_onboarding_identity", { ok: result.ok ? "true" : "false" });
    this.#o.logger.info({ profileId: this.profileId, attemptId, ok: result.ok, accountId: result.ok ? result.accountId : null },
      "Fansly sync browser onboarding: the account read through the browser");
  }

  /** The operator confirms the session `fingerprint` with `accountId`
   *  (`confirmsRead`) — now, or within `confirmWaitMs` (a read that went
   *  before the site showed that same session is confirmed once it does). */
  async #operatorConfirms(accountId: string, fingerprint: string, signal: AbortSignal): Promise<boolean> {
    if (confirmsRead(this.client.state, accountId, fingerprint)) return true;
    return new Promise<boolean>((resolve) => {
      let done = false;
      const finish = (confirmed: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        unlisten();
        signal.removeEventListener("abort", onAbort);
        resolve(confirmed);
      };
      const onAbort = () => finish(false);
      const timer = setTimeout(() => finish(false), this.#t.confirmWaitMs);
      const unlisten = this.client.onState((state) => {
        if (confirmsRead(state, accountId, fingerprint)) finish(true);
      });
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** One Hub request `GET /account/me` through the browser, under the
   *  admission: its outcome as the engine takes outcomes, whether it arrived
   *  whole (only then is the operator's copy acknowledged), and the earliest
   *  instant the operator's own `sent` puts its send at (this process's
   *  clock; null: no `sent` came — the instant is unknown). */
  async #sendIdentity(
    admission: Admission,
    fingerprint: string,
    signal: AbortSignal,
    asked: { requestId: string; generation: bigint },
  ): Promise<{ outcome: FanslyWireOutcome; whole: boolean; sentFloorMono: number | null }> {
    const client = this.client;
    const attemptId = admission.attemptId;
    let granted = false;
    let reported: number | null = null;
    let sentFloorMono: number | null = null;
    let firstAnswer: Promise<CheckReply> | null = null;
    let settle!: (value: { outcome: FanslyWireOutcome; whole: boolean; sentFloorMono: number | null }) => void;
    const done = new Promise<{ outcome: FanslyWireOutcome; whole: boolean; sentFloorMono: number | null }>((resolve) => (settle = resolve));
    let finished = false;
    const finish = (outcome: FanslyWireOutcome, whole = true) => {
      if (finished) return;
      finished = true;
      settle({ outcome, whole, sentFloorMono });
    };
    const maySent = (message: string) => finish(reported === null ? { kind: "transport_error", sent: true, message } : { kind: "transport_error", sent: true, message, sentMono: reported });
    // The grant leaves from inside the profile's row lock, the onboarding
    // found open there in the generation the request was asked in and the
    // request not voided (Astra's review of PR 16, round 2): a move (given
    // up, a login opened again) or a binding that commits first refuses it,
    // one that comes later waits for it — as the site's grants.
    const answerCheck = async (liveSession: string, answerNow: (reply: CheckReply) => boolean): Promise<CheckReply> => {
      if (finished) return { admit: false, reason: "lease_inactive" };
      if (liveSession !== fingerprint) return { admit: false, reason: "session_mismatch" };
      let reply: CheckReply = { admit: false, reason: "generation_stale" };
      try {
        await this.#fenced(async (_tx, profile) => {
          if (!this.#holds()) return;
          if (profile.onboarding !== "open" || profile.onboardingGeneration !== asked.generation || profile.identityRequest?.id !== asked.requestId || finished) {
            reply = { admit: false, reason: "lease_inactive" };
            return;
          }
          const refusal = this.pacer.checkRemoteGrant(admission);
          if (refusal !== null) {
            reply = { admit: false, reason: PROTOCOL_REFUSALS.has(refusal.reason) ? (refusal.reason as Refusal) : "lease_inactive" };
            return;
          }
          reply = { admit: true, deadlineMono: this.#bridge.toKernel(admission.sendDeadlineMono) };
          await this.#o.overrides?.beforeCheckAnswer?.(admission.attemptId);
          // Written now, under the lock (false: the link changed — the
          // operator failed the paused request already).
          granted = answerNow(reply);
        });
      } catch (error) {
        // A failure after the grant went (its commit) changes nothing of it.
        if (!granted) this.#o.logger.warn({ profileId: this.profileId, err: errorName(error) }, "Fansly sync browser onboarding: an account read's check could not be made; refused");
      }
      return granted ? reply : reply.admit ? { admit: false, reason: "lease_inactive" } : reply;
    };
    const unregister = client.register(attemptId, {
      onCheck: (check, answerNow) => {
        if (firstAnswer !== null) return firstAnswer.then(() => ({ admit: false, reason: "lease_used" as const }));
        firstAnswer = answerCheck(check.liveSessionFingerprint, answerNow);
        return firstAnswer;
      },
      onSent: (message) => {
        if (reported !== null) return;
        const at = this.#bridge.fromKernel(message.sentMono);
        // The pause runs from the latest it may have been, the proof from
        // the earliest (the two clocks' shift is read, not known).
        reported = at + SEND_REPORT_GUARD_MS;
        sentFloorMono = at - SEND_REPORT_GUARD_MS;
      },
      onResult: (delivered) => {
        const taken = this.#identityOutcome(delivered, fingerprint, reported);
        finish(taken.outcome, taken.whole);
      },
    });
    const stopLink = client.onLink((status) => {
      if (status.kind === "up") return;
      if (!granted) finish({ kind: "aborted_before_send", refusal: "transport_unavailable" });
      else if (status.kind === "closed" || status.kind === "superseded") maySent(`the link to the browser ended (${status.kind})`);
    });
    const onAbort = () => (granted ? maySent("cancelled while the browser may be sending") : finish({ kind: "aborted_before_send", refusal: "lease_inactive" }));
    signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => (granted ? maySent(`no result from the browser within ${this.#t.resultWaitMs} ms`) : finish({ kind: "aborted_before_send", refusal: "transport_unavailable" })), this.#t.resultWaitMs);
    try {
      const now = this.#clock.monoNow();
      const url = buildFanslyWireUrl("account.me", {} as never, this.#o.config.fanslyBaseUrl);
      const proxy = this.#profile.proxy;
      const written = client.send({
        attemptId,
        route: "account.me",
        // Carried, not compared at the operator: the profile, its live
        // session and its proxy, as a page's browser generation is.
        credentialsGeneration: createHash("sha256").update(JSON.stringify({ transport: "browser", profile: this.profileId, browserSession: fingerprint, proxy: proxy?.url ?? null })).digest("hex"),
        sessionFingerprint: fingerprint,
        method: "GET",
        url,
        headers: {},
        kind: "api",
        maxBodyBytes: FANSLY_WIRE_MAX_BODY_BYTES,
        sendDeadlineMono: this.#bridge.toKernel(admission.sendDeadlineMono),
        requestDeadlineMono: this.#bridge.toKernel(Math.max(admission.sendDeadlineMono, now + REQUEST_TIMEOUT_MS)),
      });
      if (!written) finish({ kind: "aborted_before_send", refusal: "transport_unavailable" });
      return await done;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      stopLink();
      unregister();
    }
  }

  /** The result as the engine takes it. Its send instant is the operator's
   *  `sent` as it came (`reported`), never the result's own: without a `sent`
   *  the instant is unknown — the completion stands in for the pause
   *  (`completion_fallback`), and it proves nothing (PR 15's rule). */
  #identityOutcome(delivered: DeliveredResult, fingerprint: string, reported: number | null): { outcome: FanslyWireOutcome; whole: boolean } {
    const { result, body, bodyProblem } = delivered;
    const o = result.outcome;
    const sentError = (message: string): FanslyWireOutcome =>
      reported === null ? { kind: "transport_error", sent: true, message } : { kind: "transport_error", sent: true, message, sentMono: reported };
    if (result.sessionFingerprint !== fingerprint) {
      if (o.kind === "aborted_before_send" || ((o.kind === "transport_error" || o.kind === "timeout") && !o.sent)) {
        return { outcome: { kind: "aborted_before_send", refusal: "session_mismatch" }, whole: true };
      }
      return { outcome: sentError("the answer came under another session of the browser"), whole: true };
    }
    switch (o.kind) {
      case "aborted_before_send":
        return { outcome: { kind: "aborted_before_send", refusal: o.refusal }, whole: true };
      case "transport_error":
      case "timeout": {
        if (!o.sent) return { outcome: { kind: "aborted_before_send", refusal: "transport_unavailable" }, whole: true };
        return { outcome: reported === null ? { kind: o.kind, sent: true, message: o.message } : { kind: o.kind, sent: true, message: o.message, sentMono: reported }, whole: true };
      }
      case "response": {
        if (bodyProblem !== null || body === null) return { outcome: sentError(`the browser answered, but ${bodyProblem ?? "its body is missing"}`), whole: false };
        if (o.preflight === true && o.status >= 200 && o.status < 300) return { outcome: sentError("only the CORS preflight of the request went"), whole: true };
        if (o.source === "cache_unconfirmed" || o.source === "service_worker") {
          return { outcome: sentError(`the answer is not the server's confirmed word (${o.source})`), whole: true };
        }
        const at = reported;
        return {
          outcome: {
            kind: "response",
            status: o.status,
            headers: o.headers,
            bodyText: new TextDecoder("utf-8").decode(body),
            bodyBytes: o.encodedBytes,
            ...(at === null ? { sendMark: "completion_fallback" as const } : { sendMark: "transport_reported" as const, sentMono: at }),
          },
          whole: true,
        };
      }
    }
  }

  // ── the buffer's events (the site's answers) ────────────────────────────

  #subscribe(bufferId: string, from: number | null = null): void {
    if (bufferId === "" || this.#subscribed === bufferId) return;
    void readProfileIntakePosition(this.#o.db, this.profileId).then((position) => {
      if (position === null || this.#stopped !== null) return;
      const afterSeq = from ?? (position.bufferId === bufferId ? position.ackedSeq : 0);
      this.#committedSeq = afterSeq;
      if (this.client.subscribe(bufferId, afterSeq)) this.#subscribed = bufferId;
    }).catch(() => undefined);
  }

  /** A batch: the site's answers journaled with the new position, in one
   *  transaction under the link's fence; acknowledged after. A body that did
   *  not arrive whole cuts the batch there: it comes again. */
  async #takeEvents(delivered: DeliveredEvents): Promise<void> {
    if (delivered.bufferId !== this.#subscribed || delivered.epoch !== this.client.epoch) return;
    const before = this.#committedSeq;
    const fresh = delivered.events.filter((event) => event.seq > before);
    const taken: typeof fresh = [];
    for (const event of fresh) {
      if (event.seq !== (taken.at(-1)?.seq ?? before) + 1) break;
      if (event.kind === "site.response" && delivered.bodies.get(event.body.bodyId)?.problem != null) break;
      taken.push(event);
    }
    if (taken.length > 0) {
      const last = taken.at(-1)!;
      await this.#fenced(async (tx) => {
        for (const event of taken) {
          if (event.kind !== "site.response") continue;
          const observation = siteResponseObservation({
            pageId: 0,
            profileId: this.profileId,
            bufferId: delivered.bufferId,
            event,
            body: delivered.bodies.get(event.body.bodyId)?.body ?? null,
          });
          if (observation === null) continue;
          await insertObservation(tx, {
            source: observation.source,
            producer: observation.producer,
            platform: "fansly",
            accountId: null,
            nativeAccountRef: null,
            kind: observation.kind,
            payload: observation.payload,
            payloadHash: observation.payloadHash,
            idempotencyKey: observation.idempotencyKey,
            observedAt: new Date(event.atWall),
          });
        }
        await writePageBrowserIntake(tx, { profileId: this.profileId, bufferId: delivered.bufferId, ackedSeq: last.seq, lastWall: new Date(last.atWall), gapSince: null });
      });
      this.#committedSeq = last.seq;
      this.client.ack(delivered.bufferId, last.seq);
    }
    if (taken.length < fresh.length) {
      // Cut (a hole, a body that did not arrive whole): asked again from
      // what is committed.
      this.#subscribed = null;
      this.#subscribe(delivered.bufferId, this.#committedSeq);
    }
  }
}
