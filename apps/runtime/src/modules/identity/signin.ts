import { SIGNIN_CLIENT_CAPABILITIES, isSigninClient, routeSchemas, type SigninClient } from "@agency_hub_core/contracts";
import type { FastifyReply, FastifyRequest } from "fastify";

import { auditCtx } from "../../api/request-auth.ts";
import type { AppContext } from "../../bootstrap.ts";
import { SESSION_COOKIE_NAME, requireDeviceTokenUser, readSessionIdentity } from "../../services/auth.ts";
import { AppError, BadRequestError } from "../../services/errors.ts";
import {
  SSO_STATE_TTL_SECONDS,
  acceptHandoffCode,
  bareOriginOf,
  checkServerGrant,
  defaultLandingOf,
  isClientState,
  isStateDigest,
  issueWebLink,
  liveFullSession,
  mintServerCode,
  mintSessionCode,
  newSsoState,
  redeemServerCode,
  resolveBrowserNext,
  resolveClientNext,
  signinNamesOf,
  ssoStateCookieName,
} from "../../services/signin-handoff.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

// One sign-in across the names Hub serves (ecosystem plan §3.2,
// services/signin-handoff.ts). The three browser steps are top-level
// navigations answered with a redirect; their request lines carry a code or a
// state digest, so Hub's request log skips them (`logLevel: "warn"`), and their
// answers are never stored, never framed and send no Referer on.

const HANDOFF_RATE_LIMIT = { max: 60, timeWindow: 60_000 };

/**
 * The key must hold its own service's capability (`signin:<client>`): a key
 * redeems and re-checks only its own service's sign-ins. The refusal is the
 * agent plane's own, word for word (agent-read/errors.ts).
 */
function requireSigninCapability(capabilities: readonly string[], client: SigninClient): void {
  const capability = SIGNIN_CLIENT_CAPABILITIES[client];
  if (!capabilities.includes(capability)) {
    throw new AppError(`agent key lacks the ${capability} capability`, 403, "agent_capability_missing");
  }
}
const SERVER_RATE_LIMIT = { max: 120, timeWindow: 60_000 };

/** The origin this request came to, as a browser would name it (nginx passes Host and the scheme). */
export function requestOriginOf(request: Pick<FastifyRequest, "protocol" | "host">): string | null {
  try {
    return new URL(`${request.protocol}://${request.host}`).origin;
  } catch {
    return null;
  }
}

function handoffHeaders(reply: FastifyReply) {
  reply.header("cache-control", "no-store");
  reply.header("referrer-policy", "no-referrer");
  reply.header("x-frame-options", "DENY");
  reply.header("content-security-policy", "frame-ancestors 'none'");
}

function cookieSecurity(app: AppContext) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: app.config.isProduction ? true : ("auto" as const),
    path: "/",
  };
}

/** The session's cookie on this name: host-only (no Domain), until the session's own fixed end. */
export function setSessionCookie(reply: Pick<FastifyReply, "setCookie">, app: AppContext, sessionToken: string, expiresAt: Date) {
  reply.setCookie(SESSION_COOKIE_NAME, sessionToken, { ...cookieSecurity(app), expires: expiresAt });
}

function ssoAddress(origin: string, params: Record<string, string>): string {
  return `${origin}/api/v1/auth/sso?${new URLSearchParams(params).toString()}`;
}

/** The one sign-in page of this name, and back to the same `authSso` after it. */
function signInFirst(here: string, params: Record<string, string>): string {
  const back = `/api/v1/auth/sso?${new URLSearchParams(params).toString()}`;
  return `${here}/login?${new URLSearchParams({ next: back }).toString()}`;
}

function isBearerRequest(request: FastifyRequest): boolean {
  const authorization = request.headers.authorization;
  return typeof authorization === "string" && /^bearer\s+\S/i.test(authorization);
}

export function registerSigninRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext } = ctx;
  const { requirePrincipal, requireAgentKeyPrincipal } = ctx.auth;

  server.get("/api/v1/auth/sso", {
    schema: routeSchemas.authSso,
    logLevel: "warn",
    config: { rateLimit: HANDOFF_RATE_LIMIT },
  }, async (request, reply) => {
    handoffHeaders(reply);
    const names = signinNamesOf(appContext.config);
    const here = requestOriginOf(request);
    if (here === null || !names.hubOrigins.has(here)) {
      throw new BadRequestError("A sign-in code is minted only on the console's or the team's name");
    }
    const { to, state } = request.query;
    const silent = request.query.silent === "1";
    const session = await liveFullSession(appContext, request.cookies[SESSION_COOKIE_NAME]);

    // Another service's server: its registered callback, a code with no token in it.
    const callback = isSigninClient(to) ? names.clients.get(to) : undefined;
    if (callback !== undefined) {
      const next = resolveClientNext(request.query.next);
      if (next === null || state === undefined || !isClientState(state)) {
        throw new BadRequestError("A client's sign-in needs its own `state` and a path for `next`");
      }
      if (!session) {
        if (silent) {
          // A silent try (the service opened without its own session): nobody
          // here → its own callback, told so, never Hub's sign-in page. No code.
          const nobody = new URL(callback);
          nobody.search = new URLSearchParams({ error: "none", state, next }).toString();
          return reply.redirect(nobody.href, 302);
        }
        return reply.redirect(signInFirst(here, { to, next, state }), 302);
      }
      const code = await mintServerCode(appContext, { sessionId: session.session.id, userId: session.user.id, client: to, next });
      const url = new URL(callback);
      url.search = new URLSearchParams({ code, state, next }).toString();
      return reply.redirect(url.href, 302);
    }

    const target = bareOriginOf(to);
    if (target === null || !names.hubOrigins.has(target)) {
      throw new BadRequestError("`to` is not a name that takes this sign-in");
    }
    const next = resolveBrowserNext(request.query.next, target, names);
    if (next === null) {
      throw new BadRequestError("`next` is not a path of the target or an address on our names");
    }
    if (target === here) {
      return reply.redirect(next, 302);
    }
    // The code is bound to the browser first: the target sets its state cookie and comes back with its hash.
    if (state === undefined) {
      const begin = new URL(`${target}/api/v1/auth/sso/begin`);
      begin.search = new URLSearchParams({ from: here, next, ...(silent ? { silent: "1" } : {}) }).toString();
      return reply.redirect(begin.href, 302);
    }
    if (!isStateDigest(state)) {
      throw new BadRequestError("`state` is not a state digest");
    }
    if (!session) {
      // A silent try (the other name asking whether someone is signed in here):
      // nobody → back where it came from, which shows its own sign-in page.
      // Its `next` carries the marker that stops a second try (LoginPage).
      return reply.redirect(silent ? next : signInFirst(here, { to: target, next, state }), 302);
    }
    const code = await mintSessionCode(appContext, {
      sessionToken: request.cookies[SESSION_COOKIE_NAME]!,
      sessionId: session.session.id,
      userId: session.user.id,
      target,
      stateDigest: state,
      next,
    });
    return reply.redirect(`${target}/api/v1/auth/sso/accept?${new URLSearchParams({ code }).toString()}`, 302);
  });

  server.get("/api/v1/auth/sso/begin", {
    schema: routeSchemas.authSsoBegin,
    logLevel: "warn",
    config: { rateLimit: HANDOFF_RATE_LIMIT },
  }, async (request, reply) => {
    handoffHeaders(reply);
    const names = signinNamesOf(appContext.config);
    const here = requestOriginOf(request);
    if (here === null || !names.hubOrigins.has(here)) {
      throw new BadRequestError("This name does not take the sign-in");
    }
    const from = bareOriginOf(request.query.from);
    if (from === null || !names.hubOrigins.has(from)) {
      throw new BadRequestError("`from` is not the console's or the team's name");
    }
    const next = resolveBrowserNext(request.query.next, here, names);
    if (next === null) {
      throw new BadRequestError("`next` is not a path of this name or an address on our names");
    }
    if (from === here) {
      return reply.redirect(next, 302);
    }
    const { state, digest } = newSsoState();
    reply.setCookie(ssoStateCookieName(appContext), state, { ...cookieSecurity(appContext), maxAge: SSO_STATE_TTL_SECONDS });
    const silent = request.query.silent === "1" ? { silent: "1" } : {};
    return reply.redirect(ssoAddress(from, { to: here, next, state: digest, ...silent }), 302);
  });

  server.get("/api/v1/auth/sso/accept", {
    schema: routeSchemas.authSsoAccept,
    logLevel: "warn",
    config: { rateLimit: HANDOFF_RATE_LIMIT },
  }, async (request, reply) => {
    handoffHeaders(reply);
    const names = signinNamesOf(appContext.config);
    const here = requestOriginOf(request);
    if (here === null || !names.hubOrigins.has(here)) {
      throw new BadRequestError("This name does not take the sign-in");
    }
    const stateCookieName = ssoStateCookieName(appContext);
    const outcome = await acceptHandoffCode(appContext, {
      code: request.query.code,
      here,
      stateCookie: request.cookies[stateCookieName],
      currentSessionToken: request.cookies[SESSION_COOKIE_NAME],
    });
    if (outcome.kind !== "keep" && outcome.clearState) {
      reply.clearCookie(stateCookieName, cookieSecurity(appContext));
    }
    if (outcome.kind === "cookie") {
      setSessionCookie(reply, appContext, outcome.sessionToken, outcome.expiresAt);
      return reply.redirect(outcome.next, 302);
    }
    if (outcome.kind === "keep") {
      return reply.redirect(outcome.next, 302);
    }
    request.log.warn({ reason: outcome.reason }, "sign-in hand-off: a code was not accepted");
    // The code's own `next` was checked when it was minted; without one, this name's landing.
    return reply.redirect(outcome.next ?? defaultLandingOf(here, names), 302);
  });

  server.get("/api/v1/auth/introspect", {
    schema: routeSchemas.authIntrospect,
    // nginx asks on every request of a name behind it: no request line in the log, no write.
    logLevel: "warn",
  }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    const token = request.cookies[SESSION_COOKIE_NAME];
    const identity = isBearerRequest(request) || !token ? null : await readSessionIdentity(appContext, token);
    if (identity === null) {
      return reply.code(401).send({ error: "unauthorized", message: "Not signed in", statusCode: 401 });
    }
    reply.header("x-hub-user", String(identity.user.id));
    // Percent-encoded UTF-8, so any login is a valid header value (an ASCII login is unchanged).
    reply.header("x-hub-login", encodeURIComponent(identity.user.username));
    reply.header("x-hub-role", identity.user.role);
    return { user: identity.user };
  });

  server.post("/api/v1/auth/sso/redeem", {
    schema: routeSchemas.authSsoRedeem,
    config: { rateLimit: SERVER_RATE_LIMIT },
  }, async (request) => {
    const principal = await requireAgentKeyPrincipal(request);
    requireSigninCapability(principal.capabilities, request.body.client);
    if (!signinNamesOf(appContext.config).clients.has(request.body.client)) {
      throw new BadRequestError("Not a sign-in client of this Hub");
    }
    return redeemServerCode(appContext, { client: request.body.client, code: request.body.code }, auditCtx(principal));
  });

  server.post("/api/v1/auth/sso/check", {
    schema: routeSchemas.authSsoCheck,
    config: { rateLimit: SERVER_RATE_LIMIT },
  }, async (request) => {
    const principal = await requireAgentKeyPrincipal(request);
    requireSigninCapability(principal.capabilities, request.body.client);
    return checkServerGrant(appContext, { client: request.body.client, grant: request.body.grant });
  });

  server.post("/api/v1/auth/web-link", {
    schema: routeSchemas.authWebLink,
    config: { rateLimit: { max: 20, timeWindow: 60_000 } },
  }, async (request) => {
    const principal = await requirePrincipal(request);
    const deviceTokenId = requireDeviceTokenUser(principal);
    return issueWebLink(appContext, { userId: principal.user.id, deviceTokenId, next: request.body.next });
  });
}
