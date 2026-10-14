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
import { authenticateSessionToken, recordAudit, requireOwner, SESSION_COOKIE_NAME } from "../../services/auth.ts";
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
 *   session, an Origin of this host.
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

  /** The page's login is open and its browser ready: the browser, or why not. */
  async function openLoginOf(pageId: number): Promise<PageBrowserRow> {
    const login = await getSyncPageManualLogin(appContext.db, pageId);
    if (login === null || login.value !== "wanted") throw new AppError("The login of the page's browser is not open", 409, "login_not_open");
    const browser = await browserOf(pageId);
    if ("problem" in browser) throw new AppError(`The page's browser is not ready: ${browser.problem}`, 409, "browser_not_ready");
    return browser.profile;
  }

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
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    return change(request, principal, "wanted");
  });

  server.post("/api/v1/page-browser/pages/:pageLabel/login/finish", {
    schema: routeSchemas.pageBrowserLoginFinish,
  }, async (request): Promise<PageBrowserLoginChangeResponse> => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    return change(request, principal, "ending");
  });

  async function step(request: { params: { pageLabel: string } }, principal: Awaited<ReturnType<typeof requirePrincipal>>, what: LoginCall & { type: "login.submit" | "login.code" }): Promise<PageBrowserLoginStepResponse> {
    const page = await pageOf(request.params.pageLabel);
    const profile = await openLoginOf(page.pageId);
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
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    return step(request, principal, { type: "login.submit", login: request.body.login, password: request.body.password });
  });

  server.post("/api/v1/page-browser/pages/:pageLabel/login/code", {
    schema: routeSchemas.pageBrowserLoginCode,
    config: { rateLimit: { max: 20, timeWindow: 60_000 } },
  }, async (request): Promise<PageBrowserLoginStepResponse> => {
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
    const profile = await openLoginOf(page.pageId);
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
  async function screenOf(label: string): Promise<{ target: { host: string; port: number }; password: string }> {
    const page = await pageOf(label);
    const profile = await openLoginOf(page.pageId);
    return { target: endpoints().screen(profile.container), password: openPageBrowserSecret(appContext.config, profile.encryptedVncPassword) };
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
    const origin = req.headers.origin;
    let sameOrigin: boolean;
    try {
      sameOrigin = origin !== undefined && new URL(origin).host === req.headers.host;
    } catch {
      sameOrigin = false;
    }
    if (!sameOrigin) return refuseUpgrade(socket, 403);
    const token = cookieOf(req.headers.cookie, SESSION_COOKIE_NAME);
    const principal = token === null ? null : await authenticateSessionToken(appContext, token);
    if (principal === null) return refuseUpgrade(socket, 401);
    requireOwner(principal);
    const label = decodeURIComponent(match[1]!);
    const screen = await screenOf(label);
    proxyScreenUpgrade({ req, socket, head, target: screen.target, path: `${match[2] ?? "/"}${match[3] ?? ""}`, password: screen.password });
  }
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
