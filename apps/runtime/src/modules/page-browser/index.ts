import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
import type { Duplex } from "node:stream";

import type { FastifyReply } from "fastify";

import {
  routeSchemas,
  type PageBrowserLoginChangeResponse,
  type PageBrowserLoginResponse,
  type PageBrowserLoginStepResponse,
  type PageBrowserProfileChangeResponse,
  type PageBrowserProfileResponse,
  type PageBrowserProfileSummary,
} from "@agency_hub_core/contracts";
import {
  endSyncPageManualLogin,
  findOnboardingProfile,
  findPageByLabel,
  getSyncPageManualLogin,
  getSyncPageTransport,
  listUnboundPageBrowsers,
  lockPageBrowserProfile,
  pageBrowserEnvOf,
  setOnboardingProxy,
  setPageBrowserOnboarding,
  setPageBrowserSettings,
  setSyncPageManualLogin,
  type Database,
  type OnboardingProfile,
} from "@agency_hub_core/db";
import {
  createProxyRequestDispatcher,
  encryptJson,
  normalizeProxyConfig,
  redactSensitiveText,
  undiciRequest,
} from "@agency_hub_core/shared";

import { auditCtx } from "../../api/request-auth.ts";
import { authenticateSessionToken, ownerSessionExpiry, recordAudit, requireOwner, SESSION_COOKIE_NAME } from "../../services/auth.ts";
import {
  onboardingLinkProblem,
  onboardingProxyMismatch,
  openPageBrowserSecret,
  readPageBrowserPageSettings,
} from "../../services/egress/page-browser-link.ts";
import {
  callPageBrowserLogin,
  PAGE_BROWSER_ENDPOINTS,
  proxyScreenRequest,
  proxyScreenUpgrade,
  type LoginAnswer,
  type LoginCall,
} from "../../services/egress/page-browser-login.ts";
import { AppError, BadRequestError, NotFoundError } from "../../services/errors.ts";
import { onboardingProxyOf, PAGE_BROWSER_ONBOARDING_AUDIT_EVENT, profilePageName } from "../../services/page-browser-onboarding.ts";
import { assertAllowedProxyTarget } from "../../services/proxy-validation.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

/** The owner's login of a page's browser in the audit log: opened, closed,
 *  each step and its result — never what was typed. */
export const PAGE_BROWSER_LOGIN_AUDIT_EVENT = "admin.page_browser_login";

/** A call that reads (the screen, its screenshot) waits this long. */
const READ_CALL_MS = 6_000;
/** A step waits for the site's next screen (the operator's own wait, 10 s). */
const STEP_CALL_MS = 25_000;

/** How often an open screen is looked at: still the owner's session, still
 *  the login it was opened in. */
const SCREEN_WATCH_MS = 1_000;
/** A look that has not answered by then closes its screen (fail closed). */
const SCREEN_LOOK_DEADLINE_MS = 1_000;
/** The longest wait a Node timer takes (a longer one fires at once). */
const MAX_TIMER_MS = 2 ** 31 - 1;

const SCREEN_PATH = /^\/api\/v1\/page-browser\/pages\/([^/?#]+)\/screen(\/[^?#]*)?(\?.*)?$/;
/** A new page's browser's screen, by its profile (PR 16). */
const PROFILE_SCREEN_PATH = /^\/api\/v1\/page-browser\/profiles\/([0-9a-f-]{36})\/screen(\/[^?#]*)?(\?.*)?$/;

/** Whose browser a login is of: a page's (its manual login,
 *  `sync_pages.manual_login`), or a profile no page has yet (its onboarding,
 *  `page_browsers.onboarding`, PR 16). */
type Target =
  | { kind: "page"; key: string; pageId: number; label: string }
  | { kind: "profile"; key: string; profileId: string };

/** The login of a target as the screens watch it: open or not, and since
 *  when (which login it is). */
interface LoginNow {
  open: boolean;
  since: number | null;
}

/**
 * The owner's login of a page's server browser (Project Browser plan §4.8;
 * stage 3 PR 15), under `/api/v1/page-browser/`, and a new page's onboarding
 * through its browser (plan §3.2 «Подключение новой страницы через браузер»;
 * PR 16) under `/api/v1/page-browser/profiles/`. Owner session only.
 *
 * - The login's state is the owner's lever (`sync_pages.manual_login` for a
 *   page; `page_browsers.onboarding` for a profile no page has; with its
 *   audit row): opening a page's puts the page on its pause at once; the
 *   engine that owns the page — or the onboarding link of the profile —
 *   follows it, the browser into the manual login and back, as only it may
 *   command the browser. Nothing here talks to the engine but through the
 *   database.
 * - The form's calls go to the browser's operator over pb-control with the
 *   API's own token (`page_browsers.encrypted_api_token`); the operator takes
 *   them only in the manual login the engine switched on. The login, the
 *   password and the code live in the request for the time of the hand-over:
 *   the body is never logged (Fastify logs no body), never audited (a step's
 *   fact and result only), never in an error.
 * - The screenshot: the operator's JPEG, passed on, kept nowhere. Polled by
 *   the open login page every second: its route logs at warn only.
 * - The browser's own screen (KasmVNC): its web client and WebSocket under
 *   `…/screen/`, passed to the container with the browser's own screen
 *   password (`page_browsers.encrypted_vnc_password`) — only while its login
 *   is open, so a person is never in a browser that works. The WebSocket's
 *   upgrade is checked here as a route is: the owner's cookie session, an
 *   Origin of this host. And it is checked for as long as it lives (Astra's
 *   review of PR 15, item 2, rounds 1 and 2): each one is bound to the
 *   session that opened it and to the login it was opened in. The owner's
 *   close of the login closes every screen of its browser before the closing
 *   is written (so before the engine can bring the automation back); while
 *   it is being written no screen of it opens, and one that was being opened
 *   meanwhile is closed with the rest once it is written — so no screen of
 *   it is open from the moment the closing commits. Each screen watches
 *   itself, apart from the others and without waiting on the database: it
 *   closes at its session's expiry (a timer from the expiry known when it
 *   opened — a session's is fixed at its login); every `SCREEN_WATCH_MS` it
 *   reads its session and its login again, and closes when the session was
 *   revoked or expired, or its user is no longer an active owner, or the
 *   login is no longer the one it was opened in — or when that read fails or
 *   has not answered within `SCREEN_LOOK_DEADLINE_MS` (fail closed). The API
 *   is one process (docker-compose.production.yml: one `api`), so its
 *   screens are all here.
 * - Every change (`POST`) is taken only from a page of the dashboard's own
 *   origin — the dashboard is served by this API, so its `Origin` names the
 *   host the request came to — as the screen's upgrade checks it (Astra's
 *   review of PR 15, item 7). The session cookie is `SameSite=Lax`, which a
 *   page of another origin of the same site (any `*.gosling-agency.ru`)
 *   still sends with a POST; the API has no CSRF token, and a browser sends
 *   `Origin` with every POST. Refused: 403 `cross_origin`, before the
 *   session is read.
 * - A new page's onboarding (PR 16): the proxy of the page to be (saved
 *   sealed, the SOCKS5 its container admits only; its exit IP read through
 *   it for the owner), the exit IP pinned (the browser checks it itself
 *   before it opens its exit: its own word is what the view shows), the
 *   login as a page's, and the onboarding given up (the engine stops the
 *   browser; `remove-profile` deletes the profile). The account check and
 *   the page's creation are the catalog's (`/api/v1/admin/credentials/verify`,
 *   `/api/v1/admin/pages`, with `browserProfileId`). Only a profile no page
 *   has: once bound, the page's own levers hold (PR 15's login, PR 17's
 *   `sync browser pin-ip`).
 */
export function registerPageBrowserRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext } = ctx;
  const { requirePrincipal } = ctx.auth;
  const endpoints = () => appContext.pageBrowserEndpoints ?? PAGE_BROWSER_ENDPOINTS;

  async function pageOf(label: string): Promise<{ pageId: number; label: string }> {
    const found = await findPageByLabel(appContext.db, label);
    if (found === null) throw new NotFoundError(`No active page ${label}`);
    return { pageId: found.page.id, label };
  }

  function pageTarget(page: { pageId: number; label: string }): Target {
    return { kind: "page", key: `page:${page.pageId}`, pageId: page.pageId, label: page.label };
  }

  /** A profile no page has yet, or the refusal. */
  async function profileOf(profileId: string): Promise<OnboardingProfile> {
    const profile = await findOnboardingProfile(appContext.db, profileId);
    if (profile === null) throw new NotFoundError(`No page browser profile ${profileId}`);
    if (profile.pageId !== null) throw new AppError(`Profile ${profileId} serves a page now: its login is the page's`, 409, "profile_bound");
    return profile;
  }

  function profileTarget(profileId: string): Target {
    return { kind: "profile", key: `profile:${profileId}`, profileId };
  }

  /** The browser of a target as the form reaches it — its container and its
   *  sealed tokens — or why it has none Hub can use. */
  async function browserOf(target: Target): Promise<{ container: string; encryptedApiToken: string; encryptedVncPassword: string } | { problem: string }> {
    if (target.kind === "page") {
      const read = await readPageBrowserPageSettings(appContext.db, target.pageId);
      return "problem" in read ? { problem: read.problem } : read.profile;
    }
    const profile = await findOnboardingProfile(appContext.db, target.profileId);
    if (profile === null) return { problem: "the profile is gone" };
    const problem = onboardingLinkProblem(profile);
    return problem !== null ? { problem } : profile;
  }

  /** The target's login now: open or not, and since when. */
  async function loginNow(target: Target): Promise<LoginNow | null> {
    if (target.kind === "page") {
      const login = await getSyncPageManualLogin(appContext.db, target.pageId);
      return login === null ? null : { open: login.value === "wanted", since: login.changedAt?.getTime() ?? null };
    }
    const profile = await findOnboardingProfile(appContext.db, target.profileId);
    return profile === null || profile.pageId !== null ? null : { open: profile.onboarding === "login", since: profile.onboardingChangedAt?.getTime() ?? null };
  }

  function call(browser: { container: string; encryptedApiToken: string }, what: LoginCall, timeoutMs: number): Promise<LoginAnswer> {
    return callPageBrowserLogin({
      url: endpoints().rpcUrl(browser.container),
      token: openPageBrowserSecret(appContext.config, browser.encryptedApiToken),
      call: what,
      timeoutMs,
    });
  }

  function screenUrl(target: Target): string {
    const base = target.kind === "page"
      ? `/api/v1/page-browser/pages/${encodeURIComponent(target.label)}/screen`
      : `/api/v1/page-browser/profiles/${target.profileId}/screen`;
    const socketPath = `${base.slice(1)}/websockify`;
    return `${base}/index.html?autoconnect=1&resize=remote&path=${encodeURIComponent(socketPath)}`;
  }

  function stepOf(answer: LoginAnswer): PageBrowserLoginStepResponse {
    switch (answer.kind) {
      case "state":
        return { screen: { screen: answer.screen, screenVersion: answer.screenVersion, fields: answer.fields, siteError: answer.siteError }, refused: null, unreachable: false };
      case "refused":
        return { screen: null, refused: answer.reason, unreachable: false };
      case "unreachable":
        return { screen: null, refused: null, unreachable: true };
      case "screenshot":
        return { screen: null, refused: null, unreachable: true };
    }
  }

  /** The target's login is open and its browser ready: the browser and the
   *  instant the login was opened (which login it is), or why not. */
  async function openLoginOf(target: Target): Promise<{ browser: { container: string; encryptedApiToken: string; encryptedVncPassword: string }; since: number | null }> {
    const login = await loginNow(target);
    if (login === null || !login.open) throw new AppError("The login of the browser is not open", 409, "login_not_open");
    const browser = await browserOf(target);
    if ("problem" in browser) throw new AppError(`The browser is not ready: ${browser.problem}`, 409, "browser_not_ready");
    return { browser, since: login.since };
  }

  // ── the screens open now (Astra's review of PR 15, item 2) ──────────────

  interface Tunnel {
    target: Target;
    /** The owner's session token that opened it. */
    session: string;
    /** The login it was opened in (its changed-at instant). */
    since: number | null;
    /** Still being opened: its login not read yet, not watched yet. */
    opening: boolean;
    close: () => void;
    /** Its own watch: the next look, the deadline of the look under way,
     *  the session's expiry. */
    timers: { next: NodeJS.Timeout | null; deadline: NodeJS.Timeout | null; expiry: NodeJS.Timeout | null };
    /** The session's expiry as last read (ms since the epoch). */
    expiresAt: number;
  }
  const tunnels = new Set<Tunnel>();
  /** The targets whose login's closing is being written now (how many
   *  closings at once): no screen of theirs opens meanwhile. */
  const closing = new Map<string, number>();
  const watchMs = appContext.pageBrowserScreenWatch?.everyMs ?? SCREEN_WATCH_MS;
  const deadlineMs = appContext.pageBrowserScreenWatch?.deadlineMs ?? SCREEN_LOOK_DEADLINE_MS;

  function track(tunnel: Tunnel): void {
    tunnels.add(tunnel);
  }

  /** Forgotten, its watch stopped (its sockets closed or closing). */
  function untrack(tunnel: Tunnel): void {
    tunnels.delete(tunnel);
    for (const timer of Object.values(tunnel.timers)) if (timer !== null) clearTimeout(timer);
    tunnel.timers = { next: null, deadline: null, expiry: null };
  }

  /** Closed: both sockets, its watch stopped. */
  function shut(tunnel: Tunnel, why: string): void {
    if (!tunnels.has(tunnel)) return;
    untrack(tunnel);
    tunnel.close();
    appContext.logger.info({ target: tunnel.target.key, why }, "page browser screen: closed");
  }

  /** Close the screens `which` names: both sockets of each. */
  function closeScreens(which: (tunnel: Tunnel) => boolean, why: string): void {
    for (const tunnel of [...tunnels]) if (which(tunnel)) shut(tunnel, why);
  }

  function later(run: () => void, ms: number): NodeJS.Timeout {
    const timer = setTimeout(run, Math.min(Math.max(0, ms), MAX_TIMER_MS));
    timer.unref();
    return timer;
  }

  /** The screen closes at its session's expiry — a timer, whatever the
   *  database does meanwhile. */
  function expireAt(tunnel: Tunnel, expiresAt: number): void {
    if (tunnel.timers.expiry !== null && tunnel.expiresAt === expiresAt) return;
    if (tunnel.timers.expiry !== null) clearTimeout(tunnel.timers.expiry);
    tunnel.expiresAt = expiresAt;
    if (expiresAt <= Date.now()) return shut(tunnel, "its session expired");
    tunnel.timers.expiry = later(() => {
      tunnel.timers.expiry = null;
      // A timer longer than Node takes fires early: armed again then.
      if (Date.now() >= tunnel.expiresAt) shut(tunnel, "its session expired");
      else expireAt(tunnel, tunnel.expiresAt);
    }, expiresAt - Date.now());
  }

  /** The screen's watch, its own: it starts at its open. */
  function watchTunnel(tunnel: Tunnel, expiresAt: number): void {
    expireAt(tunnel, expiresAt);
    if (!tunnels.has(tunnel)) return;
    tunnel.timers.next = later(() => look(tunnel), watchMs);
  }

  /** One look: its session still an owner's (and when it expires), its
   *  login still the one it was opened in — else closed. A read that fails,
   *  or has not answered by the deadline, closes it too. */
  function look(tunnel: Tunnel): void {
    tunnel.timers.next = null;
    if (!tunnels.has(tunnel)) return;
    let answered = false;
    tunnel.timers.deadline = later(() => {
      tunnel.timers.deadline = null;
      if (!answered) shut(tunnel, `its session and login did not read within ${deadlineMs} ms`);
    }, deadlineMs);
    const done = (why: string | null, expiresAt: number | null) => {
      if (answered) return;
      answered = true;
      if (tunnel.timers.deadline !== null) clearTimeout(tunnel.timers.deadline);
      tunnel.timers.deadline = null;
      if (!tunnels.has(tunnel)) return;
      if (why !== null) return shut(tunnel, why);
      expireAt(tunnel, expiresAt!);
      if (!tunnels.has(tunnel)) return;
      tunnel.timers.next = later(() => look(tunnel), watchMs);
    };
    Promise.all([ownerSessionExpiry(appContext, tunnel.session), loginNow(tunnel.target)]).then(
      ([expiry, login]) => {
        if (expiry === null) return done("its session is no longer an owner's", null);
        if (login === null || !login.open || login.since !== tunnel.since) return done("its login is no longer the open one", null);
        done(null, expiry.getTime());
      },
      () => done("its session and login could not be read", null),
    );
  }

  /** Close a target's login: its screens close before the closing is
   *  written, none opens while it is written, and one that was being opened
   *  meanwhile closes with the rest once it is. */
  async function closingScreensOf<T>(target: Target, why: string, write: () => Promise<T>): Promise<T> {
    const ofTarget = (tunnel: Tunnel) => tunnel.target.key === target.key;
    closing.set(target.key, (closing.get(target.key) ?? 0) + 1);
    closeScreens(ofTarget, why);
    try {
      return await write();
    } finally {
      closeScreens(ofTarget, why);
      const left = (closing.get(target.key) ?? 1) - 1;
      if (left > 0) closing.set(target.key, left);
      else closing.delete(target.key);
    }
  }

  server.addHook("onClose", async () => {
    closeScreens(() => true, "the API closes");
  });

  // ── a page's login (PR 15) ───────────────────────────────────────────────

  server.get("/api/v1/page-browser/pages/:pageLabel/login", {
    schema: routeSchemas.pageBrowserLoginGet,
    // Polled by the open login page every second.
    logLevel: "warn",
  }, async (request): Promise<PageBrowserLoginResponse> => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    const page = await pageOf(request.params.pageLabel);
    const target = pageTarget(page);
    const [transport, login, browser] = await Promise.all([
      getSyncPageTransport(appContext.db, page.pageId),
      getSyncPageManualLogin(appContext.db, page.pageId),
      browserOf(target),
    ]);
    if (transport === null || login === null) throw new AppError(`The page ${page.label} has no engine row`, 404, "sync_page_not_found");
    const ready = !("problem" in browser);
    let step: PageBrowserLoginStepResponse | null = null;
    if (ready && login.value !== "off") step = stepOf(await call(browser, { type: "login.state" }, READ_CALL_MS));
    return {
      page: { label: page.label, pageId: page.pageId },
      transport,
      login: { state: login.value, changedAt: login.changedAt?.toISOString() ?? null },
      browser: { ready, problem: ready ? null : browser.problem, reachable: step === null ? null : !step.unreachable },
      screen: step?.screen ?? null,
      refused: step?.refused ?? null,
      screenUrl: screenUrl(target),
    };
  });

  async function change(request: { params: { pageLabel: string } }, principal: Awaited<ReturnType<typeof requirePrincipal>>, to: "wanted" | "ending"): Promise<PageBrowserLoginChangeResponse> {
    const page = await pageOf(request.params.pageLabel);
    const target = pageTarget(page);
    const browser = await browserOf(target);
    if (to === "wanted" && "problem" in browser) throw new AppError(`The page's browser is not ready: ${browser.problem}`, 409, "browser_not_ready");
    if (to === "wanted") return write(page, principal, browser, to);
    return closingScreensOf(target, "the owner closes the login", () => write(page, principal, browser, to));
  }

  async function write(
    page: { pageId: number; label: string },
    principal: Awaited<ReturnType<typeof requirePrincipal>>,
    browser: Awaited<ReturnType<typeof browserOf>>,
    to: "wanted" | "ending",
  ): Promise<PageBrowserLoginChangeResponse> {
    return appContext.db.transaction(async (raw) => {
      const tx = raw as unknown as Database;
      const result = await setSyncPageManualLogin(tx, { pageId: page.pageId, to, by: `owner:${principal.user.id}` });
      if (result.kind === "no_page") throw new AppError(`The page ${page.label} has no engine row`, 404, "sync_page_not_found");
      // A page without a browser has no one in its login: closed at once.
      const ended = to === "ending" && "problem" in browser && result.kind === "changed"
        ? await endSyncPageManualLogin(tx, { pageId: page.pageId, by: `owner:${principal.user.id}`, evenIfWanted: true })
        : false;
      const state = ended ? "off" : result.kind === "changed" ? result.to : result.row.value;
      await recordAudit({ db: tx }, {
        ...auditCtx(principal),
        eventType: PAGE_BROWSER_LOGIN_AUDIT_EVENT,
        platformAccountId: page.pageId,
        metadata: { pageLabel: page.label, step: to === "wanted" ? "open" : "close", from: result.kind === "changed" ? result.from : result.row.value, to: state },
      });
      return { state, changed: result.kind === "changed" };
    });
  }

  server.post("/api/v1/page-browser/pages/:pageLabel/login/start", {
    schema: routeSchemas.pageBrowserLoginStart,
  }, async (request): Promise<PageBrowserLoginChangeResponse> => {
    requireThisOrigin(request.headers);
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    return change(request, principal, "wanted");
  });

  server.post("/api/v1/page-browser/pages/:pageLabel/login/finish", {
    schema: routeSchemas.pageBrowserLoginFinish,
  }, async (request): Promise<PageBrowserLoginChangeResponse> => {
    requireThisOrigin(request.headers);
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    return change(request, principal, "ending");
  });

  /** A step of the form: its fact and result audited, never what was typed. */
  async function step(target: Target, principal: Awaited<ReturnType<typeof requirePrincipal>>, what: LoginCall & { type: "login.submit" | "login.code" }): Promise<PageBrowserLoginStepResponse> {
    const { browser } = await openLoginOf(target);
    const answer = stepOf(await call(browser, what, STEP_CALL_MS));
    const fact = { step: what.type === "login.submit" ? "submit" : "code", screen: answer.screen?.screen ?? null, refused: answer.refused, unreachable: answer.unreachable };
    await recordAudit({ db: appContext.db }, target.kind === "page"
      ? { ...auditCtx(principal), eventType: PAGE_BROWSER_LOGIN_AUDIT_EVENT, platformAccountId: target.pageId, metadata: { pageLabel: target.label, ...fact } }
      : { ...auditCtx(principal), eventType: PAGE_BROWSER_ONBOARDING_AUDIT_EVENT, metadata: { profileId: target.profileId, ...fact } });
    return answer;
  }

  server.post("/api/v1/page-browser/pages/:pageLabel/login/submit", {
    schema: routeSchemas.pageBrowserLoginSubmit,
    config: { rateLimit: { max: 20, timeWindow: 60_000 } },
  }, async (request): Promise<PageBrowserLoginStepResponse> => {
    requireThisOrigin(request.headers);
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    const target = pageTarget(await pageOf(request.params.pageLabel));
    return step(target, principal, { type: "login.submit", login: request.body.login, password: request.body.password });
  });

  server.post("/api/v1/page-browser/pages/:pageLabel/login/code", {
    schema: routeSchemas.pageBrowserLoginCode,
    config: { rateLimit: { max: 20, timeWindow: 60_000 } },
  }, async (request): Promise<PageBrowserLoginStepResponse> => {
    requireThisOrigin(request.headers);
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    const target = pageTarget(await pageOf(request.params.pageLabel));
    return step(target, principal, { type: "login.code", code: request.body.code });
  });

  /** The target's live screenshot, passed on as it came. */
  async function screenshot(target: Target, reply: FastifyReply): Promise<void> {
    const { browser } = await openLoginOf(target);
    const answer = await call(browser, { type: "login.screenshot" }, READ_CALL_MS);
    if (answer.kind === "refused") throw new AppError(`The browser gives no screenshot now (${answer.reason})`, 409, `screenshot_${answer.reason}`);
    if (answer.kind !== "screenshot") throw new AppError("The browser cannot be reached", 409, "browser_unreachable");
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "image/jpeg",
      "content-length": String(answer.jpeg.length),
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    });
    reply.raw.end(answer.jpeg);
  }

  server.get("/api/v1/page-browser/pages/:pageLabel/login/screenshot", {
    schema: routeSchemas.pageBrowserLoginScreenshot,
    logLevel: "warn",
  }, async (request, reply) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    await screenshot(pageTarget(await pageOf(request.params.pageLabel)), reply);
  });

  /** The target's screen may be opened now: its login open, its browser
   *  ready. The browser's screen target and password, or the refusal. */
  async function screenOf(target: Target): Promise<{ since: number | null; target: { host: string; port: number }; password: string }> {
    const { browser, since } = await openLoginOf(target);
    return { since, target: endpoints().screen(browser.container), password: openPageBrowserSecret(appContext.config, browser.encryptedVncPassword) };
  }

  server.get("/api/v1/page-browser/pages/:pageLabel/screen/*", {
    schema: routeSchemas.pageBrowserScreen,
    logLevel: "warn",
  }, async (request, reply) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    const screen = await screenOf(pageTarget(await pageOf(request.params.pageLabel)));
    const query = request.url.includes("?") ? request.url.slice(request.url.indexOf("?")) : "";
    reply.hijack();
    proxyScreenRequest({ req: request.raw, res: reply.raw, target: screen.target, path: `/${request.params["*"]}${query}`, password: screen.password });
  });

  // ── a new page's onboarding through its browser (PR 16) ──────────────────

  function operatorView(profile: OnboardingProfile): PageBrowserProfileSummary["operator"] {
    return {
      step: profile.step,
      stopReason: profile.stopReason,
      mode: profile.mode,
      exitOpen: profile.exitOpen,
      exitIp: profile.exitIp,
      accountId: profile.accountId,
      sessionKnown: profile.sessionFingerprint !== null,
      selfTest: profile.selftestOk === null || profile.selftestAt === null ? null : { ok: profile.selftestOk, at: profile.selftestAt.toISOString(), failed: profile.selftestFailed },
      lastStateAt: profile.lastStateAt?.toISOString() ?? null,
      linkError: profile.linkError,
    };
  }

  function summaryOf(profile: OnboardingProfile): PageBrowserProfileSummary {
    return {
      profileId: profile.profileId,
      name: profilePageName(profile),
      container: profile.container,
      onboarding: profile.onboarding,
      createdAt: profile.createdAt.toISOString(),
      proxySet: profile.proxy !== null,
      pinnedExitIp: profile.pinnedExitIp,
      envSet: pageBrowserEnvOf(profile.env) !== null,
      operator: operatorView(profile),
    };
  }

  server.get("/api/v1/page-browser/profiles", {
    schema: routeSchemas.pageBrowserProfiles,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    return { profiles: (await listUnboundPageBrowsers(appContext.db)).map(summaryOf) };
  });

  server.get("/api/v1/page-browser/profiles/:profileId", {
    schema: routeSchemas.pageBrowserProfileGet,
    // Polled by the open onboarding page every second.
    logLevel: "warn",
  }, async (request): Promise<PageBrowserProfileResponse> => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    const profile = await profileOf(request.params.profileId);
    const target = profileTarget(profile.profileId);
    const problem = onboardingLinkProblem(profile);
    let screen: PageBrowserLoginStepResponse | null = null;
    if (problem === null && profile.onboarding === "login") screen = stepOf(await call(profile, { type: "login.state" }, READ_CALL_MS));
    const request_ = profile.identityRequest;
    const result = profile.identityResult;
    const answered = request_ !== null && result !== null && result.requestId === request_.id;
    const env = pageBrowserEnvOf(profile.env);
    return {
      profile: summaryOf(profile),
      socksEndpoint: profile.socksEndpoint,
      proxy: profile.proxy === null ? null : { url: profile.proxy.url, username: proxyUsername(profile) },
      env,
      login: { state: profile.onboarding, changedAt: profile.onboardingChangedAt?.toISOString() ?? null },
      browser: { ready: problem === null, problem, reachable: screen === null ? null : !screen.unreachable },
      screen: screen?.screen ?? null,
      refused: screen?.refused ?? null,
      screenUrl: screenUrl(target),
      identity: {
        requestedAt: request_?.requestedAt.toISOString() ?? null,
        pending: request_ !== null && !answered,
        ok: result === null ? null : result.ok,
        accountId: result?.ok === true ? result.accountId : null,
        username: result?.ok === true ? result.username : null,
        displayName: result?.ok === true ? result.displayName : null,
        checkedAt: result === null ? null : result.ok ? result.sentAt : result.at,
        error: result?.ok === false ? result.error : null,
      },
    };
  });

  /** The proxy's username, shown so the owner sees which one is set (never
   *  its password). */
  function proxyUsername(profile: OnboardingProfile): string | null {
    try {
      return onboardingProxyOf(appContext, profile)?.username ?? null;
    } catch {
      return null;
    }
  }

  async function audit(principal: Awaited<ReturnType<typeof requirePrincipal>>, metadata: Record<string, unknown>, db: Database = appContext.db): Promise<void> {
    await recordAudit({ db }, { ...auditCtx(principal), eventType: PAGE_BROWSER_ONBOARDING_AUDIT_EVENT, metadata });
  }

  server.post("/api/v1/page-browser/profiles/:profileId/proxy", {
    schema: routeSchemas.pageBrowserProfileProxy,
  }, async (request) => {
    requireThisOrigin(request.headers);
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    const profile = await profileOf(request.params.profileId);
    if (profile.onboarding === "login") throw new AppError("The browser's login is open: close it before its proxy changes", 409, "login_open");
    let proxy: ReturnType<typeof normalizeProxyConfig>;
    try {
      const given = request.body.proxy;
      proxy = normalizeProxyConfig({ url: given.url, username: given.username ?? null, password: given.password ?? null });
      if (appContext.pageBrowserProxyTest === undefined) await assertAllowedProxyTarget(proxy);
    } catch (error) {
      throw new BadRequestError(`Invalid proxy: ${redactSensitiveText(error instanceof Error ? error.message : "Invalid proxy URL")}`);
    }
    const mismatch = await onboardingProxyMismatch(profile, proxy);
    if (mismatch !== null) throw new BadRequestError(`Invalid proxy: ${mismatch}`);
    const exitIp = await exitIpThrough(proxy);
    const encryptedAuth = proxy.username || proxy.password
      ? JSON.stringify(encryptJson({ username: proxy.username ?? null, password: proxy.password ?? null }, appContext.config.encryptionKey, appContext.config.encryptionKeyVersion))
      : null;
    if (!(await setOnboardingProxy(appContext.db, { profileId: profile.profileId, url: proxy.url, encryptedAuth, keyVersion: encryptedAuth === null ? null : appContext.config.encryptionKeyVersion }))) {
      throw new AppError(`Profile ${profile.profileId} serves a page now`, 409, "profile_bound");
    }
    await audit(principal, { profileId: profile.profileId, step: "proxy", exitIp });
    return { exitIp };
  });

  /** The exit IP seen through a proxy (`api.ipify.org`, as the dashboard's
   *  proxy test reads it). */
  async function exitIpThrough(proxy: ReturnType<typeof normalizeProxyConfig>): Promise<string> {
    if (appContext.pageBrowserProxyTest !== undefined) return appContext.pageBrowserProxyTest(proxy);
    const dispatcher = createProxyRequestDispatcher(proxy);
    try {
      const { statusCode, body } = await undiciRequest("https://api.ipify.org?format=json", { method: "GET", signal: AbortSignal.timeout(30_000), dispatcher });
      const text = await body.text();
      if (statusCode < 200 || statusCode >= 300) throw new Error(`IP check returned HTTP ${statusCode}`);
      const ip = (JSON.parse(text) as { ip?: unknown }).ip;
      if (typeof ip !== "string" || isIP(ip) === 0) throw new Error("the IP check named no address");
      return ip;
    } catch (error) {
      throw new BadRequestError(`Proxy test failed: ${redactSensitiveText(error instanceof Error ? error.message : "Unknown error")}`);
    } finally {
      await dispatcher.close();
    }
  }

  server.post("/api/v1/page-browser/profiles/:profileId/pin", {
    schema: routeSchemas.pageBrowserProfilePin,
  }, async (request) => {
    requireThisOrigin(request.headers);
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    const ip = request.body.ip.trim();
    if (isIP(ip) === 0) throw new BadRequestError(`Not an IP address: ${ip}`);
    // Only a profile no page has (a page's pin is PR 17's `sync browser
    // pin-ip`), locked with its row; the same write that lever makes — and
    // its audit row in the same transaction: a pin is the owner's decision on
    // a halt for a changed exit IP (the onboarding clears it on a newer pin),
    // so none commits without its audit (Astra's review of PR 17, round 4).
    const pinned = await appContext.db.transaction(async (raw): Promise<"pinned" | "bound" | "no_profile"> => {
      const tx = raw as unknown as Database;
      const locked = await lockPageBrowserProfile(tx, request.params.profileId);
      if (locked === null) return "no_profile";
      if (locked.pageId !== null) return "bound";
      await setPageBrowserSettings(tx, { profileId: request.params.profileId, pinnedExitIp: ip });
      await audit(principal, { profileId: request.params.profileId, step: "pin", pinnedExitIp: ip }, tx);
      return "pinned";
    });
    if (pinned === "no_profile") throw new NotFoundError(`No page browser profile ${request.params.profileId}`);
    if (pinned === "bound") throw new AppError(`Profile ${request.params.profileId} serves a page now: its pin is sync browser pin-ip`, 409, "profile_bound");
    return { pinnedExitIp: ip };
  });

  async function changeOnboarding(profileId: string, principal: Awaited<ReturnType<typeof requirePrincipal>>, to: "login" | "open" | "closing"): Promise<PageBrowserProfileChangeResponse> {
    const profile = await profileOf(profileId);
    if (to === "login") {
      const problem = onboardingLinkProblem(profile);
      if (problem !== null) throw new AppError(`The browser is not ready: ${problem}`, 409, "browser_not_ready");
    }
    const writeIt = () => appContext.db.transaction(async (raw) => {
      const tx = raw as unknown as Database;
      const result = await setPageBrowserOnboarding(tx, { profileId, to, by: `owner:${principal.user.id}` });
      switch (result.kind) {
        case "no_profile":
          throw new NotFoundError(`No page browser profile ${profileId}`);
        case "bound":
          throw new AppError(`Profile ${profileId} serves a page now`, 409, "profile_bound");
        case "refused":
          throw new AppError(`The onboarding cannot go to ${to}: ${result.why}`, 409, "onboarding_refused");
        case "unchanged":
          return { state: result.state, changed: false };
        case "changed":
          await recordAudit({ db: tx }, { ...auditCtx(principal), eventType: PAGE_BROWSER_ONBOARDING_AUDIT_EVENT, metadata: { profileId, step: to === "login" ? "open" : to === "open" ? "close" : "give_up", from: result.from, to: result.to } });
          return { state: result.to, changed: true };
      }
    });
    // Leaving the login: its screens close before it is written.
    return to === "login" ? writeIt() : closingScreensOf(profileTarget(profileId), "the owner closes the login", writeIt);
  }

  server.post("/api/v1/page-browser/profiles/:profileId/login/start", {
    schema: routeSchemas.pageBrowserProfileLoginStart,
  }, async (request) => {
    requireThisOrigin(request.headers);
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    return changeOnboarding(request.params.profileId, principal, "login");
  });

  server.post("/api/v1/page-browser/profiles/:profileId/login/finish", {
    schema: routeSchemas.pageBrowserProfileLoginFinish,
  }, async (request) => {
    requireThisOrigin(request.headers);
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    return changeOnboarding(request.params.profileId, principal, "open");
  });

  server.post("/api/v1/page-browser/profiles/:profileId/close", {
    schema: routeSchemas.pageBrowserProfileClose,
  }, async (request) => {
    requireThisOrigin(request.headers);
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    return changeOnboarding(request.params.profileId, principal, "closing");
  });

  server.post("/api/v1/page-browser/profiles/:profileId/login/submit", {
    schema: routeSchemas.pageBrowserProfileLoginSubmit,
    config: { rateLimit: { max: 20, timeWindow: 60_000 } },
  }, async (request): Promise<PageBrowserLoginStepResponse> => {
    requireThisOrigin(request.headers);
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    await profileOf(request.params.profileId);
    return step(profileTarget(request.params.profileId), principal, { type: "login.submit", login: request.body.login, password: request.body.password });
  });

  server.post("/api/v1/page-browser/profiles/:profileId/login/code", {
    schema: routeSchemas.pageBrowserProfileLoginCode,
    config: { rateLimit: { max: 20, timeWindow: 60_000 } },
  }, async (request): Promise<PageBrowserLoginStepResponse> => {
    requireThisOrigin(request.headers);
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    await profileOf(request.params.profileId);
    return step(profileTarget(request.params.profileId), principal, { type: "login.code", code: request.body.code });
  });

  server.get("/api/v1/page-browser/profiles/:profileId/login/screenshot", {
    schema: routeSchemas.pageBrowserProfileLoginScreenshot,
    logLevel: "warn",
  }, async (request, reply) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    await profileOf(request.params.profileId);
    await screenshot(profileTarget(request.params.profileId), reply);
  });

  server.get("/api/v1/page-browser/profiles/:profileId/screen/*", {
    schema: routeSchemas.pageBrowserProfileScreen,
    logLevel: "warn",
  }, async (request, reply) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    await profileOf(request.params.profileId);
    const screen = await screenOf(profileTarget(request.params.profileId));
    const query = request.url.includes("?") ? request.url.slice(request.url.indexOf("?")) : "";
    reply.hijack();
    proxyScreenRequest({ req: request.raw, res: reply.raw, target: screen.target, path: `/${request.params["*"]}${query}`, password: screen.password });
  });

  // The screen's WebSocket: an upgrade never reaches Fastify's routes. Every
  // upgrade of the API comes here; only the screens' paths are taken.
  server.server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on("error", () => undefined);
    void upgrade(req, socket, head).catch((error: unknown) => {
      const status = error instanceof AppError ? error.statusCode : 500;
      if (status >= 500) appContext.logger.warn({ err: error instanceof Error ? error.name : "error" }, "page browser screen: the upgrade failed");
      refuseUpgrade(socket, status);
    });
  });

  async function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const pageMatch = SCREEN_PATH.exec(req.url ?? "");
    const profileMatch = pageMatch === null ? PROFILE_SCREEN_PATH.exec(req.url ?? "") : null;
    const match = pageMatch ?? profileMatch;
    if (match === null) return refuseUpgrade(socket, 404);
    // A page of another origin may not open the owner's screen.
    if (!fromThisOrigin(req.headers)) return refuseUpgrade(socket, 403);
    const token = cookieOf(req.headers.cookie, SESSION_COOKIE_NAME);
    const principal = token === null ? null : await authenticateSessionToken(appContext, token);
    if (principal === null || token === null) return refuseUpgrade(socket, 401);
    requireOwner(principal);
    // When the session expires: the screen closes then whatever else happens.
    const expiry = await ownerSessionExpiry(appContext, token);
    if (expiry === null) return refuseUpgrade(socket, 401);
    let target: Target;
    if (pageMatch !== null) {
      target = pageTarget(await pageOf(decodeURIComponent(pageMatch[1]!)));
    } else {
      await profileOf(profileMatch![1]!);
      target = profileTarget(profileMatch![1]!);
    }
    // Known before its login is read: an owner's close that comes meanwhile
    // closes it too.
    const tunnel: Tunnel = { target, session: token, since: null, opening: true, close: () => socket.destroy(), timers: { next: null, deadline: null, expiry: null }, expiresAt: expiry.getTime() };
    track(tunnel);
    let screen: Awaited<ReturnType<typeof screenOf>>;
    try {
      screen = await screenOf(target);
    } catch (error) {
      untrack(tunnel);
      throw error;
    }
    // Closed meanwhile, or the login's closing is being written now (what
    // was read may be the login before it): no screen.
    if (!tunnels.has(tunnel) || closing.has(target.key)) {
      untrack(tunnel);
      return refuseUpgrade(socket, 409);
    }
    tunnel.since = screen.since;
    const proxied = proxyScreenUpgrade({ req, socket, head, target: screen.target, path: `${match[2] ?? "/"}${match[3] ?? ""}`, password: screen.password, onClose: () => untrack(tunnel) });
    tunnel.close = proxied.close;
    tunnel.opening = false;
    watchTunnel(tunnel, expiry.getTime());
  }
}

/** The request came from a page of this host — the dashboard's origin: its
 *  `Origin` (http or https) names the host it came to. No `Origin` (no
 *  browser sends a POST or a WebSocket without one), another host or port,
 *  or `null`: not. */
export function fromThisOrigin(headers: IncomingMessage["headers"]): boolean {
  const origin = headers.origin;
  const host = headers.host;
  if (typeof origin !== "string" || typeof host !== "string" || host === "") return false;
  try {
    const url = new URL(origin);
    return (url.protocol === "https:" || url.protocol === "http:") && url.host === host;
  } catch {
    return false;
  }
}

function requireThisOrigin(headers: IncomingMessage["headers"]): void {
  if (!fromThisOrigin(headers)) throw new AppError("A change of the page's browser is taken only from the dashboard's own pages", 403, "cross_origin");
}

function refuseUpgrade(socket: Duplex, status: number): void {
  const phrase = status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : status === 404 ? "Not Found" : status === 409 ? "Conflict" : "Error";
  socket.end(`HTTP/1.1 ${status} ${phrase}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
  // Never left half-open by a peer that does not close its side.
  setTimeout(() => socket.destroy(), 2_000).unref();
}

function cookieOf(header: string | undefined, name: string): string | null {
  if (header === undefined) return null;
  for (const part of header.split(";")) {
    const at = part.indexOf("=");
    if (at < 0) continue;
    if (part.slice(0, at).trim() === name) {
      try {
        return decodeURIComponent(part.slice(at + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}
