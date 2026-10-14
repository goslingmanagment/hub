import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import {
  routeSchemas,
  type PageBrowserLoginChangeResponse,
  type PageBrowserLoginResponse,
  type PageBrowserLoginStepResponse,
} from "@agency_hub_core/contracts";
import {
  endSyncPageManualLogin,
  findPageByLabel,
  getSyncPageManualLogin,
  getSyncPageTransport,
  setSyncPageManualLogin,
  type Database,
  type PageBrowserRow,
} from "@agency_hub_core/db";

import { auditCtx } from "../../api/request-auth.ts";
import { authenticateSessionToken, isLiveOwnerSession, recordAudit, requireOwner, SESSION_COOKIE_NAME } from "../../services/auth.ts";
import { openPageBrowserSecret, readPageBrowserPageSettings } from "../../services/egress/page-browser-link.ts";
import {
  callPageBrowserLogin,
  PAGE_BROWSER_ENDPOINTS,
  proxyScreenRequest,
  proxyScreenUpgrade,
  type LoginAnswer,
  type LoginCall,
} from "../../services/egress/page-browser-login.ts";
import { AppError, NotFoundError } from "../../services/errors.ts";
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

const SCREEN_PATH = /^\/api\/v1\/page-browser\/pages\/([^/?#]+)\/screen(\/[^?#]*)?(\?.*)?$/;

/**
 * The owner's login of a page's server browser (Project Browser plan §4.8;
 * stage 3 PR 15), under `/api/v1/page-browser/`. Owner session only.
 *
 * - The login's state is the owner's lever (`sync_pages.manual_login`, with
 *   its audit row): opening it puts the page on its pause at once; the
 *   engine that owns the page follows it — the browser into the manual login
 *   and back — as only it may command the browser. Nothing here talks to the
 *   engine but through the database.
 * - The form's calls go to the page's operator over pb-control with the API's
 *   own token (`page_browsers.encrypted_api_token`); the operator takes them
 *   only in the manual login the engine switched on. The login, the password
 *   and the code live in the request for the time of the hand-over: the body
 *   is never logged (Fastify logs no body), never audited (a step's fact and
 *   result only), never in an error.
 * - The screenshot: the operator's JPEG, passed on, kept nowhere. Polled by
 *   the open login page every second: its route logs at warn only.
 * - The browser's own screen (KasmVNC): its web client and WebSocket under
 *   `…/screen/`, passed to the container with the page's own screen password
 *   (`page_browsers.encrypted_vnc_password`) — only while the page's login is
 *   open, so a person is never in the browser of a page that works. The
 *   WebSocket's upgrade is checked here as a route is: the owner's cookie
 *   session, an Origin of this host. And it is checked for as long as it
 *   lives (Astra's review of PR 15, item 2): each one is bound to the
 *   session that opened it and to the login it was opened in. The owner's
 *   close of the login closes every screen of the page before the closing
 *   is written (so before the engine can bring the automation back); while
 *   it is being written no screen of the page opens, and one that was being
 *   opened meanwhile is closed with the rest once it is written — so no
 *   screen of the page is open from the moment the closing commits. A
 *   screen whose session was revoked or expired, or whose login is no
 *   longer the open one (closed by other means), is closed within
 *   `SCREEN_WATCH_MS`. The API is one process (docker-compose.production.yml:
 *   one `api`), so its screens are all here.
 * - Every change (`POST`) is taken only from a page of the dashboard's own
 *   origin — the dashboard is served by this API, so its `Origin` names the
 *   host the request came to — as the screen's upgrade checks it (Astra's
 *   review of PR 15, item 7). The session cookie is `SameSite=Lax`, which a
 *   page of another origin of the same site (any `*.gosling-agency.ru`)
 *   still sends with a POST; the API has no CSRF token, and a browser sends
 *   `Origin` with every POST. Refused: 403 `cross_origin`, before the
 *   session is read.
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

  /** The page's browser, or why it has none Hub can use. */
  async function browserOf(pageId: number): Promise<{ profile: PageBrowserRow } | { problem: string }> {
    const read = await readPageBrowserPageSettings(appContext.db, pageId);
    return "problem" in read ? { problem: read.problem } : { profile: read.profile };
  }

  function call(profile: PageBrowserRow, what: LoginCall, timeoutMs: number): Promise<LoginAnswer> {
    return callPageBrowserLogin({
      url: endpoints().rpcUrl(profile.container),
      token: openPageBrowserSecret(appContext.config, profile.encryptedApiToken),
      call: what,
      timeoutMs,
    });
  }

  function screenUrl(label: string): string {
    const base = `/api/v1/page-browser/pages/${encodeURIComponent(label)}/screen`;
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

  /** The page's login is open and its browser ready: the browser and the
   *  instant the login was opened (which login it is), or why not. */
  async function openLoginOf(pageId: number): Promise<{ profile: PageBrowserRow; since: number | null }> {
    const login = await getSyncPageManualLogin(appContext.db, pageId);
    if (login === null || login.value !== "wanted") throw new AppError("The login of the page's browser is not open", 409, "login_not_open");
    const browser = await browserOf(pageId);
    if ("problem" in browser) throw new AppError(`The page's browser is not ready: ${browser.problem}`, 409, "browser_not_ready");
    return { profile: browser.profile, since: login.changedAt?.getTime() ?? null };
  }

  // ── the screens open now (Astra's review of PR 15, item 2) ──────────────

  interface Tunnel {
    pageId: number;
    /** The owner's session token that opened it. */
    session: string;
    /** The login it was opened in (its `manual_login_changed_at`). */
    since: number | null;
    /** Still being opened: its login not read yet. */
    opening: boolean;
    close: () => void;
  }
  const tunnels = new Set<Tunnel>();
  /** The pages whose login's closing is being written now (how many
   *  closings at once): no screen of theirs opens meanwhile. */
  const closing = new Map<number, number>();
  const watchMs = appContext.pageBrowserScreenWatchMs ?? SCREEN_WATCH_MS;
  let watch: NodeJS.Timeout | null = null;
  let sweeping = false;

  function track(tunnel: Tunnel): void {
    tunnels.add(tunnel);
    if (watch !== null) return;
    watch = setInterval(() => void sweep(), watchMs);
    watch.unref();
  }

  function untrack(tunnel: Tunnel): void {
    tunnels.delete(tunnel);
    if (tunnels.size > 0 || watch === null) return;
    clearInterval(watch);
    watch = null;
  }

  /** Close the screens `which` names: both sockets of each. */
  function closeScreens(which: (tunnel: Tunnel) => boolean): void {
    for (const tunnel of [...tunnels]) {
      if (!which(tunnel)) continue;
      untrack(tunnel);
      tunnel.close();
    }
  }

  /** Each open screen: its session still an owner's, its login still the
   *  open one — else closed. A read that fails closes it too. */
  async function sweep(): Promise<void> {
    if (sweeping) return;
    sweeping = true;
    try {
      const sessions = new Map<string, Promise<boolean>>();
      const logins = new Map<number, Promise<{ value: string; since: number | null } | null>>();
      for (const tunnel of [...tunnels]) {
        if (tunnel.opening) continue;
        if (!sessions.has(tunnel.session)) sessions.set(tunnel.session, isLiveOwnerSession(appContext, tunnel.session).catch(() => false));
        if (!logins.has(tunnel.pageId)) {
          logins.set(tunnel.pageId, getSyncPageManualLogin(appContext.db, tunnel.pageId)
            .then((login) => (login === null ? null : { value: login.value, since: login.changedAt?.getTime() ?? null }))
            .catch(() => null));
        }
        const [live, login] = await Promise.all([sessions.get(tunnel.session)!, logins.get(tunnel.pageId)!]);
        if (live && login !== null && login.value === "wanted" && login.since === tunnel.since) continue;
        if (!tunnels.has(tunnel)) continue;
        untrack(tunnel);
        tunnel.close();
      }
    } finally {
      sweeping = false;
    }
  }

  server.addHook("onClose", async () => {
    closeScreens(() => true);
  });

  server.get("/api/v1/page-browser/pages/:pageLabel/login", {
    schema: routeSchemas.pageBrowserLoginGet,
    // Polled by the open login page every second.
    logLevel: "warn",
  }, async (request): Promise<PageBrowserLoginResponse> => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    const page = await pageOf(request.params.pageLabel);
    const [transport, login, browser] = await Promise.all([
      getSyncPageTransport(appContext.db, page.pageId),
      getSyncPageManualLogin(appContext.db, page.pageId),
      browserOf(page.pageId),
    ]);
    if (transport === null || login === null) throw new AppError(`The page ${page.label} has no engine row`, 404, "sync_page_not_found");
    const ready = !("problem" in browser);
    let step: PageBrowserLoginStepResponse | null = null;
    if (ready && login.value !== "off") step = stepOf(await call(browser.profile, { type: "login.state" }, READ_CALL_MS));
    return {
      page: { label: page.label, pageId: page.pageId },
      transport,
      login: { state: login.value, changedAt: login.changedAt?.toISOString() ?? null },
      browser: { ready, problem: ready ? null : browser.problem, reachable: step === null ? null : !step.unreachable },
      screen: step?.screen ?? null,
      refused: step?.refused ?? null,
      screenUrl: screenUrl(page.label),
    };
  });

  async function change(request: { params: { pageLabel: string } }, principal: Awaited<ReturnType<typeof requirePrincipal>>, to: "wanted" | "ending"): Promise<PageBrowserLoginChangeResponse> {
    const page = await pageOf(request.params.pageLabel);
    const browser = await browserOf(page.pageId);
    if (to === "wanted" && "problem" in browser) throw new AppError(`The page's browser is not ready: ${browser.problem}`, 409, "browser_not_ready");
    if (to === "wanted") return write(page, principal, browser, to);
    // The page's screens close before the closing is written (the engine
    // brings the automation back only once it reads it), none opens while
    // it is written, and one that was being opened meanwhile closes with
    // the rest once it is (`upgrade` refuses it, or it is tracked here).
    const ofPage = (tunnel: Tunnel) => tunnel.pageId === page.pageId;
    closing.set(page.pageId, (closing.get(page.pageId) ?? 0) + 1);
    closeScreens(ofPage);
    try {
      return await write(page, principal, browser, to);
    } finally {
      closeScreens(ofPage);
      const left = (closing.get(page.pageId) ?? 1) - 1;
      if (left > 0) closing.set(page.pageId, left);
      else closing.delete(page.pageId);
    }
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

  async function step(request: { params: { pageLabel: string } }, principal: Awaited<ReturnType<typeof requirePrincipal>>, what: LoginCall & { type: "login.submit" | "login.code" }): Promise<PageBrowserLoginStepResponse> {
    const page = await pageOf(request.params.pageLabel);
    const { profile } = await openLoginOf(page.pageId);
    const answer = stepOf(await call(profile, what, STEP_CALL_MS));
    // The step's fact and result: never what was typed.
    await recordAudit({ db: appContext.db }, {
      ...auditCtx(principal),
      eventType: PAGE_BROWSER_LOGIN_AUDIT_EVENT,
      platformAccountId: page.pageId,
      metadata: { pageLabel: page.label, step: what.type === "login.submit" ? "submit" : "code", screen: answer.screen?.screen ?? null, refused: answer.refused, unreachable: answer.unreachable },
    });
    return answer;
  }

  server.post("/api/v1/page-browser/pages/:pageLabel/login/submit", {
    schema: routeSchemas.pageBrowserLoginSubmit,
    config: { rateLimit: { max: 20, timeWindow: 60_000 } },
  }, async (request): Promise<PageBrowserLoginStepResponse> => {
    requireThisOrigin(request.headers);
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    return step(request, principal, { type: "login.submit", login: request.body.login, password: request.body.password });
  });

  server.post("/api/v1/page-browser/pages/:pageLabel/login/code", {
    schema: routeSchemas.pageBrowserLoginCode,
    config: { rateLimit: { max: 20, timeWindow: 60_000 } },
  }, async (request): Promise<PageBrowserLoginStepResponse> => {
    requireThisOrigin(request.headers);
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    return step(request, principal, { type: "login.code", code: request.body.code });
  });

  server.get("/api/v1/page-browser/pages/:pageLabel/login/screenshot", {
    schema: routeSchemas.pageBrowserLoginScreenshot,
    logLevel: "warn",
  }, async (request, reply) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    const page = await pageOf(request.params.pageLabel);
    const { profile } = await openLoginOf(page.pageId);
    const answer = await call(profile, { type: "login.screenshot" }, READ_CALL_MS);
    if (answer.kind === "refused") throw new AppError(`The page's browser gives no screenshot now (${answer.reason})`, 409, `screenshot_${answer.reason}`);
    if (answer.kind !== "screenshot") throw new AppError("The page's browser cannot be reached", 409, "browser_unreachable");
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "image/jpeg",
      "content-length": String(answer.jpeg.length),
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    });
    reply.raw.end(answer.jpeg);
  });

  /** The page's screen may be opened now: its login open, its browser
   *  ready. The browser's screen target and password, or the refusal. */
  async function screenOf(label: string): Promise<{ pageId: number; since: number | null; target: { host: string; port: number }; password: string }> {
    const page = await pageOf(label);
    const { profile, since } = await openLoginOf(page.pageId);
    return { pageId: page.pageId, since, target: endpoints().screen(profile.container), password: openPageBrowserSecret(appContext.config, profile.encryptedVncPassword) };
  }

  server.get("/api/v1/page-browser/pages/:pageLabel/screen/*", {
    schema: routeSchemas.pageBrowserScreen,
    logLevel: "warn",
  }, async (request, reply) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    const screen = await screenOf(request.params.pageLabel);
    const query = request.url.includes("?") ? request.url.slice(request.url.indexOf("?")) : "";
    reply.hijack();
    proxyScreenRequest({ req: request.raw, res: reply.raw, target: screen.target, path: `/${request.params["*"]}${query}`, password: screen.password });
  });

  // The screen's WebSocket: an upgrade never reaches Fastify's routes. Every
  // upgrade of the API comes here; only the screen's path is taken.
  server.server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on("error", () => undefined);
    void upgrade(req, socket, head).catch((error: unknown) => {
      const status = error instanceof AppError ? error.statusCode : 500;
      if (status >= 500) appContext.logger.warn({ err: error instanceof Error ? error.name : "error" }, "page browser screen: the upgrade failed");
      refuseUpgrade(socket, status);
    });
  });

  async function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const match = SCREEN_PATH.exec(req.url ?? "");
    if (match === null) return refuseUpgrade(socket, 404);
    // A page of another origin may not open the owner's screen.
    if (!fromThisOrigin(req.headers)) return refuseUpgrade(socket, 403);
    const token = cookieOf(req.headers.cookie, SESSION_COOKIE_NAME);
    const principal = token === null ? null : await authenticateSessionToken(appContext, token);
    if (principal === null || token === null) return refuseUpgrade(socket, 401);
    requireOwner(principal);
    const label = decodeURIComponent(match[1]!);
    const page = await pageOf(label);
    // Known before its login is read: an owner's close that comes meanwhile
    // closes it too.
    const tunnel: Tunnel = { pageId: page.pageId, session: token, since: null, opening: true, close: () => socket.destroy() };
    track(tunnel);
    let screen: Awaited<ReturnType<typeof screenOf>>;
    try {
      screen = await screenOf(label);
    } catch (error) {
      untrack(tunnel);
      throw error;
    }
    // Closed meanwhile, or the login's closing is being written now (what
    // was read may be the login before it): no screen.
    if (!tunnels.has(tunnel) || closing.has(page.pageId)) {
      untrack(tunnel);
      return refuseUpgrade(socket, 409);
    }
    tunnel.since = screen.since;
    const proxied = proxyScreenUpgrade({ req, socket, head, target: screen.target, path: `${match[2] ?? "/"}${match[3] ?? ""}`, password: screen.password, onClose: () => untrack(tunnel) });
    tunnel.close = proxied.close;
    tunnel.opening = false;
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
