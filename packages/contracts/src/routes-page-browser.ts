import { z } from "zod";

import { errorResponseSchema, isoDateTime } from "./primitives.ts";

// The owner's login of a page's server browser (Project Browser plan §4.8;
// stage 3 PR 15): the dashboard's form — the screen the browser shows now,
// its live screenshot, the fields Fansly asks for, the site's error — and the
// browser's own screen (KasmVNC) for what the form does not know. Owner
// session only. What the owner types goes from here to the page's browser and
// nowhere else: never into the database, a log or an answer.

const errors = { 400: errorResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema, 409: errorResponseSchema };

const pageLabelParams = z.object({ pageLabel: z.string().min(1).max(100) }).strict();

/** The screens the browser's login desk knows (spec §7); `unknown`: none of
 *  them — the owner opens the screen. */
export const pageBrowserLoginScreenSchema = z.enum(["login", "code", "error", "success", "unknown"]);
export type PageBrowserLoginScreen = z.infer<typeof pageBrowserLoginScreenSchema>;

export const pageBrowserLoginFieldSchema = z.enum(["login", "password", "code"]);

/** What the browser shows now. */
export const pageBrowserScreenSchema = z.object({
  screen: pageBrowserLoginScreenSchema,
  /** The version of the screens' signs that read it. */
  screenVersion: z.string(),
  /** The fields Fansly asks for on it. */
  fields: z.array(pageBrowserLoginFieldSchema),
  /** The site's own error text, as it shows it. */
  siteError: z.string().nullable(),
  /** Where the code it asks for comes from: `email` — Fansly e-mailed it
   *  to the account for a login from a new device (owner decision
   *  2026-10-15); absent — the page's 2FA code. */
  codeFrom: z.literal("email").optional(),
}).strict();

/** Why the browser did not do what was asked: not in the manual login (yet,
 *  or any more), the screen is another one now, a step is under way, the
 *  browser refused Hub's token. */
export const pageBrowserLoginRefusalSchema = z.enum(["not_manual_login", "screen_changed", "busy", "token"]);

/** The login of the page's browser: closed, open, closing (the engine
 *  brings the automation back). */
export const pageBrowserLoginStateSchema = z.enum(["off", "wanted", "ending"]);

export const pageBrowserLoginResponseSchema = z.object({
  page: z.object({ label: z.string(), pageId: z.number().int().positive() }).strict(),
  /** Which sender the page's requests leave through now. */
  transport: z.enum(["node", "browser"]),
  login: z.object({
    state: pageBrowserLoginStateSchema,
    changedAt: isoDateTime().nullable(),
  }).strict(),
  browser: z.object({
    /** The page has a browser Hub can reach and log in (a profile bound to
     *  it, its exit IP pinned, its environment set). */
    ready: z.boolean(),
    /** Why not, in the owner's words; null: ready. */
    problem: z.string().nullable(),
    /** The browser answered (null: not asked — the login is closed). */
    reachable: z.boolean().nullable(),
  }).strict(),
  /** The screen now (null: the login is closed, or the browser said no). */
  screen: pageBrowserScreenSchema.nullable(),
  refused: pageBrowserLoginRefusalSchema.nullable(),
  /** Where the browser's own screen opens (a new tab). */
  screenUrl: z.string(),
}).strict();
export type PageBrowserLoginResponse = z.infer<typeof pageBrowserLoginResponseSchema>;

/** The answer to a step: the screen after it, or why it was not done. */
export const pageBrowserLoginStepResponseSchema = z.object({
  screen: pageBrowserScreenSchema.nullable(),
  refused: pageBrowserLoginRefusalSchema.nullable(),
  /** The browser did not answer. */
  unreachable: z.boolean(),
}).strict();
export type PageBrowserLoginStepResponse = z.infer<typeof pageBrowserLoginStepResponseSchema>;

export const pageBrowserLoginChangeResponseSchema = z.object({
  state: pageBrowserLoginStateSchema,
  changed: z.boolean(),
}).strict();
export type PageBrowserLoginChangeResponse = z.infer<typeof pageBrowserLoginChangeResponseSchema>;

/** No line break: what is typed goes into one field of the site's form. */
const typed = (max: number) => z.string().min(1).max(max).regex(/^[^\r\n\0]*$/);

export const pageBrowserLoginSubmitBodySchema = z.object({
  login: typed(320),
  password: typed(1024),
}).strict();
export type PageBrowserLoginSubmitBody = z.infer<typeof pageBrowserLoginSubmitBodySchema>;

export const pageBrowserLoginCodeBodySchema = z.object({
  code: typed(32),
}).strict();
export type PageBrowserLoginCodeBody = z.infer<typeof pageBrowserLoginCodeBodySchema>;

// ── a new page's onboarding through its browser (Project Browser PR 16) ──
// A profile `scripts/deploy-page-browser.sh add-profile` made serves no page
// yet: the owner gives the proxy of the page to be, pins the exit IP its
// browser goes out through, logs the browser in through the same form, and
// checks the account through it (`POST /api/v1/admin/credentials/verify`
// with `browserProfileId`); the page is created and the profile bound to it
// by `POST /api/v1/admin/pages` with `browserProfileId`.

const profileParams = z.object({ profileId: z.string().uuid() }).strict();

/** The onboarding of a profile no page has: off, the owner's login, open
 *  (the login closed, the account checked on request), closing (given up). */
export const pageBrowserOnboardingStateSchema = z.enum(["off", "login", "open", "closing"]);
export type PageBrowserOnboardingState = z.infer<typeof pageBrowserOnboardingStateSchema>;

/** What the profile's operator last said of itself, as Hub recorded it. */
export const pageBrowserOperatorViewSchema = z.object({
  step: z.string().nullable(),
  stopReason: z.string().nullable(),
  mode: z.enum(["automation", "manual_login"]),
  exitOpen: z.boolean(),
  /** The exit IP the browser itself saw when it opened its exit. */
  exitIp: z.string().nullable(),
  /** The account the browser's live session showed (its last identity read). */
  accountId: z.string().nullable(),
  sessionKnown: z.boolean(),
  selfTest: z.object({ ok: z.boolean(), at: isoDateTime(), failed: z.string().nullable() }).strict().nullable(),
  lastStateAt: isoDateTime().nullable(),
  linkError: z.string().nullable(),
}).strict();

/** The account the browser's live session belongs to, as the engine read it
 *  through the browser (`GET /account/me`), or why there is none. */
export const pageBrowserIdentitySchema = z.object({
  requestedAt: isoDateTime().nullable(),
  /** Asked and not answered yet. */
  pending: z.boolean(),
  ok: z.boolean().nullable(),
  accountId: z.string().nullable(),
  username: z.string().nullable(),
  displayName: z.string().nullable(),
  checkedAt: isoDateTime().nullable(),
  error: z.string().nullable(),
}).strict();

export const pageBrowserProfileSummarySchema = z.object({
  profileId: z.string().uuid(),
  /** The name the profile was made for (`page-browser-<name>`): the new
   *  page's label. */
  name: z.string(),
  container: z.string(),
  onboarding: pageBrowserOnboardingStateSchema,
  createdAt: isoDateTime(),
  proxySet: z.boolean(),
  pinnedExitIp: z.string().nullable(),
  envSet: z.boolean(),
  operator: pageBrowserOperatorViewSchema,
}).strict();
export type PageBrowserProfileSummary = z.infer<typeof pageBrowserProfileSummarySchema>;

export const pageBrowserProfilesResponseSchema = z.object({
  profiles: z.array(pageBrowserProfileSummarySchema),
}).strict();
export type PageBrowserProfilesResponse = z.infer<typeof pageBrowserProfilesResponseSchema>;

export const pageBrowserProfileResponseSchema = z.object({
  profile: pageBrowserProfileSummarySchema,
  /** The SOCKS5 its container admits (`ip:port`): the proxy given must be it. */
  socksEndpoint: z.string().nullable(),
  /** The proxy given for the page to be: its URL (its password never). */
  proxy: z.object({ url: z.string(), username: z.string().nullable() }).strict().nullable(),
  env: z.object({ timeZone: z.string(), languages: z.array(z.string()), geolocation: z.object({ latitude: z.number(), longitude: z.number(), accuracyM: z.number() }).strict() }).strict().nullable(),
  login: z.object({
    state: pageBrowserOnboardingStateSchema,
    changedAt: isoDateTime().nullable(),
  }).strict(),
  browser: z.object({
    /** The browser can be linked to: a proxy, a pin and an environment. */
    ready: z.boolean(),
    problem: z.string().nullable(),
    reachable: z.boolean().nullable(),
  }).strict(),
  screen: pageBrowserScreenSchema.nullable(),
  refused: pageBrowserLoginRefusalSchema.nullable(),
  screenUrl: z.string(),
  identity: pageBrowserIdentitySchema,
}).strict();
export type PageBrowserProfileResponse = z.infer<typeof pageBrowserProfileResponseSchema>;

export const pageBrowserProfileProxyBodySchema = z.object({
  proxy: z.object({
    url: z.string().min(1).max(2000),
    username: z.string().max(500).nullable().optional(),
    password: z.string().max(500).nullable().optional(),
  }).strict(),
}).strict();
export type PageBrowserProfileProxyBody = z.infer<typeof pageBrowserProfileProxyBodySchema>;

/** The proxy saved: the exit IP Hub saw through it (`api.ipify.org`), for
 *  the owner to pin. */
export const pageBrowserProfileProxyResponseSchema = z.object({
  exitIp: z.string(),
}).strict();

export const pageBrowserProfilePinBodySchema = z.object({
  ip: z.string().min(3).max(64),
}).strict();

export const pageBrowserProfilePinResponseSchema = z.object({
  pinnedExitIp: z.string(),
}).strict();

export const pageBrowserProfileChangeResponseSchema = z.object({
  state: pageBrowserOnboardingStateSchema,
  changed: z.boolean(),
}).strict();
export type PageBrowserProfileChangeResponse = z.infer<typeof pageBrowserProfileChangeResponseSchema>;

export const pageBrowserRouteSchemas = {
  pageBrowserLoginGet: {
    auth: { kind: "owner-session" },
    tags: ["admin"],
    summary: "Read the login of a page's server browser: its state, whether the browser is ready, the screen it shows now",
    params: pageLabelParams,
    response: { 200: pageBrowserLoginResponseSchema, ...errors },
  },
  pageBrowserLoginStart: {
    auth: { kind: "owner-session" },
    tags: ["admin"],
    summary: "Open the login of a page's server browser: the page pauses, the engine puts the browser into the manual login",
    params: pageLabelParams,
    response: { 200: pageBrowserLoginChangeResponseSchema, ...errors },
  },
  pageBrowserLoginFinish: {
    auth: { kind: "owner-session" },
    tags: ["admin"],
    summary: "Close the login of a page's server browser: the engine checks the browser and brings the automation back",
    params: pageLabelParams,
    response: { 200: pageBrowserLoginChangeResponseSchema, ...errors },
  },
  pageBrowserLoginSubmit: {
    auth: { kind: "owner-session" },
    tags: ["admin"],
    summary: "Type the login and the password into the site's login form in the page's server browser and press its button",
    params: pageLabelParams,
    body: pageBrowserLoginSubmitBodySchema,
    response: { 200: pageBrowserLoginStepResponseSchema, ...errors },
  },
  pageBrowserLoginCode: {
    auth: { kind: "owner-session" },
    tags: ["admin"],
    summary: "Type the 2FA code into the site's code form in the page's server browser and press its button",
    params: pageLabelParams,
    body: pageBrowserLoginCodeBodySchema,
    response: { 200: pageBrowserLoginStepResponseSchema, ...errors },
  },
  pageBrowserLoginScreenshot: {
    auth: { kind: "owner-session" },
    tags: ["admin"],
    summary: "Binary image/jpeg — the page's server browser as it shows now, while its login is open (kept nowhere)",
    params: pageLabelParams,
    response: { 200: z.string().describe("Binary image/jpeg"), ...errors },
  },
  pageBrowserProfiles: {
    auth: { kind: "owner-session" },
    tags: ["admin"],
    summary: "The page browsers' profiles no page has yet (made by add-profile): their onboarding, proxy, pin, the browser's last word",
    response: { 200: pageBrowserProfilesResponseSchema, ...errors },
  },
  pageBrowserProfileGet: {
    auth: { kind: "owner-session" },
    tags: ["admin"],
    summary: "Read a new page's onboarding through its browser: the profile, its proxy and pin, the login and the screen it shows, the account check",
    params: profileParams,
    response: { 200: pageBrowserProfileResponseSchema, ...errors },
  },
  pageBrowserProfileProxy: {
    auth: { kind: "owner-session" },
    tags: ["admin"],
    summary: "Give the proxy of the page to be (the SOCKS5 its browser's container admits): saved sealed, and its exit IP read through it",
    params: profileParams,
    body: pageBrowserProfileProxyBodySchema,
    response: { 200: pageBrowserProfileProxyResponseSchema, ...errors },
  },
  pageBrowserProfilePin: {
    auth: { kind: "owner-session" },
    tags: ["admin"],
    summary: "Pin the exit IP the new page's browser may open its exit through (it checks it itself before it opens)",
    params: profileParams,
    body: pageBrowserProfilePinBodySchema,
    response: { 200: pageBrowserProfilePinResponseSchema, ...errors },
  },
  pageBrowserProfileLoginStart: {
    auth: { kind: "owner-session" },
    tags: ["admin"],
    summary: "Open the owner's login of a new page's browser: the engine puts it into the manual login and starts it",
    params: profileParams,
    response: { 200: pageBrowserProfileChangeResponseSchema, ...errors },
  },
  pageBrowserProfileLoginFinish: {
    auth: { kind: "owner-session" },
    tags: ["admin"],
    summary: "Close the owner's login of a new page's browser: the automation back, the account can be checked through it",
    params: profileParams,
    response: { 200: pageBrowserProfileChangeResponseSchema, ...errors },
  },
  pageBrowserProfileLoginSubmit: {
    auth: { kind: "owner-session" },
    tags: ["admin"],
    summary: "Type the login and the password into the site's login form in a new page's browser and press its button",
    params: profileParams,
    body: pageBrowserLoginSubmitBodySchema,
    response: { 200: pageBrowserLoginStepResponseSchema, ...errors },
  },
  pageBrowserProfileLoginCode: {
    auth: { kind: "owner-session" },
    tags: ["admin"],
    summary: "Type the 2FA code into the site's code form in a new page's browser and press its button",
    params: profileParams,
    body: pageBrowserLoginCodeBodySchema,
    response: { 200: pageBrowserLoginStepResponseSchema, ...errors },
  },
  pageBrowserProfileLoginScreenshot: {
    auth: { kind: "owner-session" },
    tags: ["admin"],
    summary: "Binary image/jpeg — a new page's browser as it shows now, while its login is open (kept nowhere)",
    params: profileParams,
    response: { 200: z.string().describe("Binary image/jpeg"), ...errors },
  },
  pageBrowserProfileClose: {
    auth: { kind: "owner-session" },
    tags: ["admin"],
    summary: "Give a new page's onboarding up: the engine stops its browser (the profile kept, unbound; remove-profile deletes it)",
    params: profileParams,
    response: { 200: pageBrowserProfileChangeResponseSchema, ...errors },
  },
  pageBrowserProfileScreen: {
    auth: { kind: "owner-session" },
    tags: ["admin"],
    summary: "A new page's browser screen (KasmVNC web client and its WebSocket), passed through with the profile's own screen password",
    params: z.object({ profileId: z.string().uuid(), "*": z.string().max(2000) }).strict(),
    response: { 200: z.unknown(), 400: z.unknown(), 401: z.unknown(), 403: z.unknown(), 404: z.unknown(), 502: z.unknown() },
  },
  pageBrowserScreen: {
    auth: { kind: "owner-session" },
    tags: ["admin"],
    summary: "The page's server browser screen (KasmVNC web client and its WebSocket), passed through with the page's own screen password",
    params: z.object({ pageLabel: z.string().min(1).max(100), "*": z.string().max(2000) }).strict(),
    response: { 200: z.unknown(), 400: z.unknown(), 401: z.unknown(), 403: z.unknown(), 404: z.unknown(), 502: z.unknown() },
  },
} as const;
