/**
 * One sign-in for people across the names Hub serves (ecosystem plan §3.2).
 * Cookies stay host-only; a sign-in crosses from one name to another by a
 * one-time code (60 s, single use, bound to the name it was minted for, stored
 * hashed). Hub is the only source of who someone is.
 *
 * - `authSso` (on a name of Hub's own: the console's or the team's) mints a
 *   code for the session of that name and sends the browser to the target's
 *   `authSsoAccept`; without a session, to the one sign-in page and on. A
 *   browser target first binds the code to the browser: `authSsoBegin` on the
 *   target sets a state cookie there and comes back.
 * - `authSsoAccept` (on the target name) plants the SAME session there as a
 *   host-only cookie and leads to `next`, checked against the allow-list of
 *   names and paths. A narrow code (from the extension) opens a narrow session.
 * - `authIntrospect` answers nginx's `auth_request`: 200 with who it is, or
 *   401. Reads only.
 * - `authSsoRedeem` / `authSsoCheck`: another service's server (ContentOps,
 *   TaskIndex, server-monitor) exchanges a code for «who is this» — and whether
 *   it is the owner — with its own agent key (`signin:<client>`), and re-checks
 *   that sign-in later. It never receives a Hub session token.
 *   To ContentOps both answers carry the `person` (products plan §4.1): enough
 *   to make, change and close its own person without a second registry; and
 *   `authSsoWaiting` reads what waits in Hub for a person signed in that way.
 * - `authWebLink`: the extension's device token asks for a one-time link into
 *   the team's place (web-link-v1).
 */
import { z } from "zod";

import { userRoles } from "@agency_hub_core/shared";

import type { AgentCapability } from "./agent-read-capabilities.ts";
import { errorResponseSchema, intId, isoTimestamp } from "./primitives.ts";
import { PRODUCTS } from "./products.ts";

/** How long a minted code may be accepted or redeemed. */
export const SIGNIN_CODE_TTL_SECONDS = 60;

/**
 * The services whose servers redeem a code themselves, each by the capability
 * its own agent key holds: a key redeems only its own service's codes. Their
 * callback URLs are WEB_SIGNIN_CLIENTS.
 */
export const SIGNIN_CLIENT_CAPABILITIES = {
  contentops: "signin:contentops",
  taskindex: "signin:taskindex",
  monitor: "signin:monitor",
} as const satisfies Readonly<Record<string, AgentCapability>>;

export type SigninClient = keyof typeof SIGNIN_CLIENT_CAPABILITIES;

export const SIGNIN_CLIENTS = Object.keys(SIGNIN_CLIENT_CAPABILITIES) as SigninClient[];

export function isSigninClient(value: string): value is SigninClient {
  return Object.hasOwn(SIGNIN_CLIENT_CAPABILITIES, value);
}

/** A server client's name (`contentops`, `taskindex`, `monitor`). */
export const signinClientNameSchema = z.enum(SIGNIN_CLIENTS as [SigninClient, ...SigninClient[]]);

const nextParam = z.string().min(1).max(2048);
const codeParam = z.string().min(1).max(128);

export const authSsoQuerySchema = z.object({
  /** The target: an origin of a name that takes the session (`https://chatgoose.gosling-agency.ru`), or a server client's name (`contentops`). */
  to: z.string().min(1).max(300),
  /** Where the target leads after the accept: a path on the target, or a URL on one of the names; a client's own path for a client. */
  next: nextParam.optional(),
  /** A browser target: the state its `authSsoBegin` set (absent — the begin comes first). A client: its own opaque state, echoed to its callback. */
  state: z.string().min(1).max(256).optional(),
  /**
   * `1`: a silent try (a name or a service arrived at without a session asks
   * this one). No full session on this name → never a sign-in page here: a
   * browser target goes straight back to `next`; a client to its callback with
   * `error=none`, its `state` and `next` (no code).
   */
  silent: z.literal("1").optional(),
});

export const authSsoBeginQuerySchema = z.object({
  /** The name of Hub's own that holds the session (the console's or the team's). */
  from: z.string().min(1).max(300),
  next: nextParam.optional(),
  /** `1`: a silent try, passed on to `authSso` (see there). */
  silent: z.literal("1").optional(),
});

export const authSsoAcceptQuerySchema = z.object({
  code: codeParam,
});

export const signinUserSchema = z.object({
  id: intId,
  username: z.string(),
  role: z.enum(userRoles),
});

export const authIntrospectResponseSchema = z.object({
  user: signinUserSchema,
});

export const authSsoRedeemBodySchema = z.object({
  client: signinClientNameSchema,
  code: codeParam,
}).strict();

/**
 * The person behind a sign-in, as ContentOps needs it (products plan §4.1): the registry's code, name, role and state;
 * the models of their working pages (lower-case slugs); the models where they lead customs («ведёт кастомы»); the
 * products `auth/me` gives them (the frame's switcher). null — the login is nobody's in the registry. Sent to ContentOps
 * only.
 */
export const signinPersonSchema = z.object({
  code: z.string(),
  displayName: z.string(),
  role: z.string(),
  state: z.string(),
  models: z.array(z.string()),
  customsModels: z.array(z.string()),
  products: z.array(z.enum(PRODUCTS)),
}).nullable();

export const authSsoRedeemResponseSchema = z.object({
  user: signinUserSchema,
  /** The agency's owner (`user.role` is `owner`): TaskIndex and server-monitor open only for them. */
  owner: z.boolean(),
  /** The handle the client re-checks this sign-in with (`authSsoCheck`). Not a Hub session token, and no use to a browser. */
  grant: z.string(),
  /** When the Hub session behind it ends at the latest. */
  expiresAt: isoTimestamp,
  /** ContentOps only: who this is in the registry. */
  person: signinPersonSchema.optional(),
});

export const authSsoCheckBodySchema = z.object({
  client: signinClientNameSchema,
  grant: z.string().min(1).max(128),
}).strict();

export const authSsoCheckResponseSchema = z.discriminatedUnion("active", [
  z.object({ active: z.literal(true), user: signinUserSchema, owner: z.boolean(), expiresAt: isoTimestamp, person: signinPersonSchema.optional() }),
  /** Signed out, revoked, expired, or the person is deactivated: end the client's own session. */
  z.object({ active: z.literal(false) }),
]);

export const authSsoWaitingBodySchema = authSsoCheckBodySchema;

/** One open matter of the person, as ContentOps lists it: it opens where it is decided (`link`). */
export const signinWaitingMatterSchema = z.object({
  id: intId,
  kind: z.string(),
  title: z.string(),
  /** Where it is decided: a path of Hub or Workboard, or an address of ContentOps; null — the list in Hub. */
  link: z.string().nullable(),
  pageLabels: z.array(z.string()),
  /** The models of those pages (Hub's lower-case slugs); none — a matter of no page, every model's. */
  models: z.array(z.string()).optional(),
  /**
   * What the matter is about (`publication`, `custom_order`, …): ContentOps opens its own screen for it (a post's card
   * in «Публикации», an order in «Съёмка»); null — nothing of ContentOps'.
   */
  object: z.object({ type: z.string(), id: z.string() }).nullable().optional(),
  openedAt: isoTimestamp,
});

export const authSsoWaitingResponseSchema = z.discriminatedUnion("active", [
  z.object({ active: z.literal(true), matters: z.array(signinWaitingMatterSchema), serverNow: isoTimestamp }),
  /** The sign-in is over: nothing to read. */
  z.object({ active: z.literal(false) }),
]);

/**
 * ContentOps' own entrance (products plan, package C4): its server signs a person in by the login and the password
 * they typed on ContentOps' page — the same sign-in as Hub's own page (lockout, journal) — and gets what `authSsoRedeem`
 * gives. The person's address and browser come along for the journal; the password is never logged or kept.
 */
const clientOrigin = {
  /** The person's address as ContentOps saw it (for the journal). */
  ip: z.string().max(64).optional(),
  /** The person's browser as ContentOps saw it (for the journal). */
  userAgent: z.string().max(512).optional(),
};

export const authSsoPasswordBodySchema = z.object({
  client: signinClientNameSchema,
  username: z.string().min(1).max(100),
  password: z.string().min(1).max(256),
  ...clientOrigin,
}).strict();

/**
 * Why a sign-in on another service's page was refused, in one word each: `wrong` — an unknown login or a wrong
 * password, one answer for both; `locked` — too many tries, wait; `owner` — the owner's password never passes through
 * another service: the owner enters through Hub; `no_access` — the person has no ContentOps; `link_unknown`,
 * `link_used`, `link_expired`, `link_revoked` — an invitation or a new password's link that cannot be used;
 * `not_here` — a link of a login that opens elsewhere; `weak` — a password Hub does not take (`message` says why).
 */
export const SIGNIN_REFUSALS = [
  "wrong", "locked", "owner", "no_access", "link_unknown", "link_used", "link_expired", "link_revoked", "not_here", "weak",
] as const;

export const authSsoSignedInResponseSchema = z.discriminatedUnion("result", [
  authSsoRedeemResponseSchema.extend({ result: z.literal("signed_in") }),
  z.object({ result: z.literal("refused"), reason: z.enum(SIGNIN_REFUSALS), message: z.string().optional() }),
]);

export const authSsoLinkBodySchema = z.object({
  client: signinClientNameSchema,
  /** The secret of an invitation or of a new password's link (`/join#…`). */
  token: z.string().min(1).max(256),
  password: z.string().min(1).max(256),
  ...clientOrigin,
}).strict();

export const authSsoPasswordChangeBodySchema = z.object({
  client: signinClientNameSchema,
  grant: z.string().min(1).max(128),
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(8).max(256),
  ...clientOrigin,
}).strict();

export const authSsoLogoutBodySchema = z.object({
  client: signinClientNameSchema,
  grant: z.string().min(1).max(128),
}).strict();

export const authSsoLogoutResponseSchema = z.object({
  /** A Hub session the service's own page opened is ended; one the person opened in Hub stays. */
  ended: z.boolean(),
});

export const authWebLinkBodySchema = z.object({
  /** A path of the team's place to open (`/workboard/my/shifts`); absent — Workboard's home. */
  next: nextParam.optional(),
}).strict();

export const authWebLinkResponseSchema = z.object({
  /** Open it in a new tab from the person's click; it works once, within the minute. */
  url: z.string(),
  expiresAt: isoTimestamp,
});

export type AuthSsoRedeemResponse = z.infer<typeof authSsoRedeemResponseSchema>;
export type AuthSsoCheckResponse = z.infer<typeof authSsoCheckResponseSchema>;
export type SigninPerson = z.infer<typeof signinPersonSchema>;
export type AuthSsoWaitingResponse = z.infer<typeof authSsoWaitingResponseSchema>;
export type AuthSsoSignedInResponse = z.infer<typeof authSsoSignedInResponseSchema>;
export type SigninRefusal = (typeof SIGNIN_REFUSALS)[number];
export type AuthWebLinkResponse = z.infer<typeof authWebLinkResponseSchema>;

export const signinRouteSchemas = {
  authSso: {
    auth: { kind: "public" },
    tags: ["auth"],
    summary: "Sign in on another name: mint a one-time code for this name's session and go to the target's accept",
    description: "A browser navigation, never a fetch. With a session on this name: a code bound to the target (60 s, "
      + "single use) and a redirect to the target's `authSsoAccept`, or to a client's registered callback with "
      + "`code`, `state` and `next`. A browser target without `state` is sent to its `authSsoBegin` first, which "
      + "binds the code to the browser. Without a session (or with a narrow one): the sign-in page, then on — "
      + "or, with `silent=1`, straight back to `next` (a client: its callback with `error=none`, `state` and "
      + "`next`, no code). `next` outside the allow-list of names and paths: 400.",
    querystring: authSsoQuerySchema,
    response: { 302: z.unknown(), 400: errorResponseSchema, 429: errorResponseSchema },
  },
  authSsoBegin: {
    auth: { kind: "public" },
    tags: ["auth"],
    summary: "On the target name: set the browser's state cookie and go back to `authSso` on the name with the session",
    querystring: authSsoBeginQuerySchema,
    response: { 302: z.unknown(), 400: errorResponseSchema, 429: errorResponseSchema },
  },
  authSsoAccept: {
    auth: { kind: "public" },
    tags: ["auth"],
    summary: "On the target name: redeem a one-time code, set the session as this name's host-only cookie, go to `next`",
    description: "A code is accepted once, within 60 s, only on the name it was minted for and only by the browser "
      + "whose state cookie it is bound to. A narrow code opens a narrow web session (unless this browser already "
      + "has the person's full one here). A code that cannot be accepted leads on without a session.",
    querystring: authSsoAcceptQuerySchema,
    response: { 302: z.unknown(), 400: errorResponseSchema, 429: errorResponseSchema },
  },
  authIntrospect: {
    auth: { kind: "public" },
    tags: ["auth"],
    summary: "For nginx `auth_request`: who this name's cookie session is (headers x-hub-user, x-hub-login, x-hub-role), or 401",
    description: "Reads only (no last-seen write); a cookie session only — a bearer and a narrow web session are 401.",
    response: { 200: authIntrospectResponseSchema, 401: errorResponseSchema },
  },
  authStaticReports: {
    auth: { kind: "public" },
    tags: ["auth"],
    summary: "For nginx's guard of the static reports on chatgoose. (`/customs/`, `/fyp/`): 204 for a signed-in live person",
    description: "The reports hold the agency's real data: 204 for any signed-in person of the live agency (what `auth/me` "
      + "let in before), 401 with no sign-in, 403 for a person of the test team (Hub's sandbox/realm.ts). Reads only.",
    response: { 204: z.null(), 401: errorResponseSchema, 403: errorResponseSchema },
  },
  authSsoRedeem: {
    auth: { kind: "agentKey" },
    tags: ["auth"],
    summary: "Another service's server exchanges a one-time code for who signed in and whether it is the owner (needs signin:<client>)",
    description: "ContentOps, TaskIndex, server-monitor, each with its own key holding `signin:<client>`. The code must "
      + "be one minted for this client by `authSso`; once, within 60 s. Returns the person, `owner`, and a grant to "
      + "re-check the sign-in with (`authSsoCheck`) — never a Hub session token.",
    body: authSsoRedeemBodySchema,
    response: {
      200: authSsoRedeemResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      409: errorResponseSchema,
      429: errorResponseSchema,
    },
  },
  authSsoCheck: {
    auth: { kind: "agentKey" },
    tags: ["auth"],
    summary: "Whether a sign-in redeemed by `authSsoRedeem` is still alive (needs signin:<client>)",
    description: "Reads only. Inactive once the Hub session is signed out, revoked or expired, or the person deactivated.",
    body: authSsoCheckBodySchema,
    response: {
      200: authSsoCheckResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      429: errorResponseSchema,
    },
  },
  authSsoWaiting: {
    auth: { kind: "agentKey" },
    tags: ["auth"],
    summary: "What waits in Hub for the person of a live sign-in, for ContentOps' «Ждут вас» (needs signin:contentops)",
    description: "Reads only. The person's own open matters whose kind ContentOps shows (waiting-groups.ts "
      + "`waitsInContentops`): the owner's also those of the owner's role. Inactive once the sign-in is over.",
    body: authSsoWaitingBodySchema,
    response: {
      200: authSsoWaitingResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      429: errorResponseSchema,
    },
  },
  authSsoPassword: {
    auth: { kind: "agentKey" },
    tags: ["auth"],
    summary: "ContentOps' own page signs a person in by login and password (needs signin:contentops)",
    description: "The same sign-in as Hub's own page: lockout and journal (`auth.login`, via contentops). The owner role is refused "
      + "(`owner`): the owner enters through Hub. A person without ContentOps is refused (`no_access`) after the password. "
      + "Signed in: what `authSsoRedeem` answers.",
    body: authSsoPasswordBodySchema,
    response: {
      200: authSsoSignedInResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      429: errorResponseSchema,
    },
  },
  authSsoLink: {
    auth: { kind: "agentKey" },
    tags: ["auth"],
    summary: "ContentOps' own page sets the password of an invitation or a reset link and signs the person in (needs signin:contentops)",
    description: "The same redemption as Hub's `/join`, for a login whose only product is ContentOps (else `not_here`). Signed in: "
      + "what `authSsoRedeem` answers.",
    body: authSsoLinkBodySchema,
    response: {
      200: authSsoSignedInResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      429: errorResponseSchema,
    },
  },
  authSsoPasswordChange: {
    auth: { kind: "agentKey" },
    tags: ["auth"],
    summary: "A person changes their password from ContentOps' profile (needs signin:contentops)",
    description: "The same change as Hub's own: every sign-in of the person ends; the person is signed in again here with the new "
      + "password and a new grant comes back.",
    body: authSsoPasswordChangeBodySchema,
    response: {
      200: authSsoSignedInResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      429: errorResponseSchema,
    },
  },
  authSsoLogout: {
    auth: { kind: "agentKey" },
    tags: ["auth"],
    summary: "ContentOps' «Выйти»: ends the Hub session its own page opened (needs signin:contentops)",
    description: "A session the person opened in Hub or Workboard themselves stays. Idempotent.",
    body: authSsoLogoutBodySchema,
    response: {
      200: authSsoLogoutResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      429: errorResponseSchema,
    },
  },
  authWebLink: {
    auth: { kind: "device-token" },
    tags: ["auth"],
    summary: "A one-time link into the team's place for this device's person: it opens a narrow web session (web-link-v1)",
    description: "The narrow session opens only the team's place, is refused every owner route (an owner's device "
      + "too) and stops signing in with this device token. The link works once, within 60 s.",
    body: authWebLinkBodySchema,
    response: {
      200: authWebLinkResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      429: errorResponseSchema,
    },
  },
} as const;
