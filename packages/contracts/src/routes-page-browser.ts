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
  pageBrowserScreen: {
    auth: { kind: "owner-session" },
    tags: ["admin"],
    summary: "The page's server browser screen (KasmVNC web client and its WebSocket), passed through with the page's own screen password",
    params: z.object({ pageLabel: z.string().min(1).max(100), "*": z.string().max(2000) }).strict(),
    response: { 200: z.unknown(), 400: z.unknown(), 401: z.unknown(), 403: z.unknown(), 404: z.unknown(), 502: z.unknown() },
  },
} as const;
