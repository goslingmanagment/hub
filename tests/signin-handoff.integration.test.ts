import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { insertAgentKey } from "@agency_hub_core/db";
import { sha256Hex } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createInvite } from "../apps/runtime/src/services/account-links.ts";
import {
  AGENT_KEY_TOKEN_PREFIX,
  SESSION_COOKIE_NAME,
  createUserAccount,
  issueDeviceTokenWithPassword,
  setUserPassword,
} from "../apps/runtime/src/services/auth.ts";
import { NARROW_WEB_SESSION_REFUSAL_MESSAGE } from "../apps/runtime/src/services/narrow-web-session.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// One sign-in across the names (ecosystem plan §3.2), end to end on a database
// through the API server: the session planted on another name by a one-time
// code, every way a code must not be accepted, the Origin check of a change
// made with a cookie, sign-out on one name ending the session on all of them,
// /join signing the newcomer in, the narrow web session opened from the
// extension and everything it is refused, and another machine's server that
// learns who signed in without ever holding a Hub session.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

const HUB = "http://hub.test";
const TEAM = "http://team.test";
const TASKS = "http://tasks.test";
const CLIENT_CALLBACK = "http://co.test/auth/hub/callback";
const TASKS_CALLBACK = `${TASKS}/auth/hub/callback`;
const STATE_COOKIE = "agency_hub_sso_state";

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
const users: Record<string, number> = {};

type Cookies = Record<string, string>;
type Injected = Awaited<ReturnType<Awaited<ReturnType<typeof buildApiServer>>["inject"]>>;

function cookieHeader(cookies: Cookies): string {
  return Object.entries(cookies).map(([name, value]) => `${name}=${value}`).join("; ");
}

function cookieSet(response: Injected, name: string): string | undefined {
  return response.cookies.find((cookie) => cookie.name === name)?.value;
}

async function request(method: "GET" | "POST" | "DELETE", url: string, options: {
  cookies?: Cookies;
  headers?: Record<string, string>;
  payload?: object;
} = {}): Promise<Injected> {
  const address = new URL(url);
  return server!.inject({
    method,
    url: `${address.pathname}${address.search}`,
    headers: {
      host: address.host,
      ...(options.cookies && Object.keys(options.cookies).length > 0 ? { cookie: cookieHeader(options.cookies) } : {}),
      ...options.headers,
    },
    ...(options.payload ? { payload: options.payload } : {}),
  });
}

async function signIn(username: string, origin: string): Promise<string> {
  const response = await request("POST", `${origin}/api/v1/auth/login`, {
    headers: { origin },
    payload: { username, password: `${username}-password-for-tests` },
  });
  expect(response.statusCode, response.body).toBe(200);
  return cookieSet(response, SESSION_COOKIE_NAME)!;
}

async function me(origin: string, session: string | undefined) {
  return request("GET", `${origin}/api/v1/auth/me`, { cookies: session ? { [SESSION_COOKIE_NAME]: session } : {} });
}

/** The browser's way from `from` (with its session) to `to`, up to the accept's address. */
async function hopToAccept(from: string, session: string, to: string, next?: string) {
  const start = await request("GET", `${from}/api/v1/auth/sso?${new URLSearchParams({ to, ...(next ? { next } : {}) })}`, {
    cookies: { [SESSION_COOKIE_NAME]: session },
  });
  expect(start.statusCode, start.body).toBe(302);
  const begin = String(start.headers.location);
  expect(begin.startsWith(`${to}/api/v1/auth/sso/begin?`)).toBe(true);
  const begun = await request("GET", begin);
  expect(begun.statusCode, begun.body).toBe(302);
  const state = cookieSet(begun, STATE_COOKIE)!;
  expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
  // Only the state's hash travels in the address.
  expect(String(begun.headers.location)).not.toContain(state);
  const minted = await request("GET", String(begun.headers.location), { cookies: { [SESSION_COOKIE_NAME]: session } });
  expect(minted.statusCode, minted.body).toBe(302);
  const accept = String(minted.headers.location);
  expect(accept.startsWith(`${to}/api/v1/auth/sso/accept?code=`)).toBe(true);
  return { accept, state };
}

function codeOf(acceptUrl: string): string {
  return new URL(acceptUrl).searchParams.get("code")!;
}

async function agentKey(capabilities: string[]): Promise<string> {
  const token = `${AGENT_KEY_TOKEN_PREFIX}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
  await insertAgentKey(app.db, {
    name: `server-key-${Math.random().toString(36).slice(2, 8)}`,
    keyPrefix: token.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6),
    keyDigest: sha256Hex(token),
    capabilities,
    pageIds: [1],
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    createdBy: users.owner ?? null,
    createdAt: new Date(),
  });
  return token;
}

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
  if (!testDb) return;
  app = createTestAppContext(testDb);
  Object.assign(app.config, {
    webConsoleOrigin: HUB,
    webTeamOrigin: TEAM,
    webSigninClients: { contentops: CLIENT_CALLBACK, taskindex: TASKS_CALLBACK },
  });
  await createUserAccount(app, { username: "owner", role: "owner", password: "owner-password-for-tests" }, { source: "cli" });
  users.owner = await fixtureUserId(app, "owner");
  await createUserAccount(app, { username: "chatter-a", role: "chatter" }, { source: "cli" });
  users.chatterA = await fixtureUserId(app, "chatter-a");
  await setUserPassword(app, { userId: users.chatterA, password: "chatter-a-password-for-tests" }, { source: "cli" });
  server = await buildApiServer(app);
  await server.ready();
}, 180_000);

afterAll(async () => {
  await server?.close();
  await testDb?.stop();
});

describe("the session planted on another name", () => {
  it("is the same session there, and a sign-out on one name ends it on every name", async (context) => {
    if (!server) return context.skip();
    const session = await signIn("owner", HUB);
    const { accept, state } = await hopToAccept(HUB, session, TEAM, `${HUB}/settings`);
    const accepted = await request("GET", accept, { cookies: { [STATE_COOKIE]: state } });
    expect(accepted.statusCode).toBe(302);
    expect(accepted.headers.location).toBe(`${HUB}/settings`);
    expect(accepted.headers["x-frame-options"]).toBe("DENY");
    expect(accepted.headers["referrer-policy"]).toBe("no-referrer");
    const planted = accepted.cookies.find((cookie) => cookie.name === SESSION_COOKIE_NAME)!;
    expect(planted.value).toBe(session);
    // Host-only: no Domain; HttpOnly, SameSite=Lax.
    expect({ domain: planted.domain, httpOnly: planted.httpOnly, sameSite: planted.sameSite, path: planted.path })
      .toEqual({ domain: undefined, httpOnly: true, sameSite: "Lax", path: "/" });
    expect((await me(TEAM, planted.value)).json()).toMatchObject({ user: { username: "owner" } });

    const out = await request("POST", `${TEAM}/api/v1/auth/logout`, {
      cookies: { [SESSION_COOKIE_NAME]: planted.value },
      headers: { origin: TEAM },
    });
    expect(out.statusCode, out.body).toBe(200);
    expect((await me(TEAM, planted.value)).statusCode).toBe(401);
    expect((await me(HUB, session)).statusCode).toBe(401);
  });

  it("asks the sign-in page first when the name has no session, and comes back to the same step", async (context) => {
    if (!server) return context.skip();
    const begun = await request("GET", `${TEAM}/api/v1/auth/sso/begin?${new URLSearchParams({ from: HUB, next: "/workboard/" })}`);
    const minted = await request("GET", String(begun.headers.location));
    expect(minted.statusCode).toBe(302);
    const login = new URL(String(minted.headers.location));
    expect(`${login.origin}${login.pathname}`).toBe(`${HUB}/login`);
    expect(login.searchParams.get("next")).toMatch(/^\/api\/v1\/auth\/sso\?/);
  });
});

describe("the silent try of a name arrived at without a session", () => {
  /** What the sign-in page of `here` sends to: ask `other`, come back to this page with the marker. */
  function silentBegin(here: string, other: string): { url: string; back: string } {
    const back = `${here}/login?next=%2Fworkboard%2F&sso=none`;
    return { url: `${here}/api/v1/auth/sso/begin?${new URLSearchParams({ from: other, next: back, silent: "1" })}`, back };
  }

  async function silentTry(here: string, other: string, otherCookies: Cookies) {
    const { url, back } = silentBegin(here, other);
    const begun = await request("GET", url);
    expect(begun.statusCode, begun.body).toBe(302);
    const state = cookieSet(begun, STATE_COOKIE)!;
    const asked = String(begun.headers.location);
    expect(new URL(asked).searchParams.get("silent")).toBe("1");
    const answered = await request("GET", asked, { cookies: otherCookies });
    expect(answered.statusCode, answered.body).toBe(302);
    return { back, state, location: String(answered.headers.location) };
  }

  it("signs the person in with the other name's session, in both directions", async (context) => {
    if (!server) return context.skip();
    for (const [signedOn, arrivedAt] of [[HUB, TEAM], [TEAM, HUB]] as const) {
      // A session from before the names shared one: on one name only.
      const session = await signIn("owner", signedOn);
      const { back, state, location } = await silentTry(arrivedAt, signedOn, { [SESSION_COOKIE_NAME]: session });
      expect(location.startsWith(`${arrivedAt}/api/v1/auth/sso/accept?code=`), location).toBe(true);
      const accepted = await request("GET", location, { cookies: { [STATE_COOKIE]: state } });
      expect(accepted.headers.location).toBe(back);
      expect(cookieSet(accepted, SESSION_COOKIE_NAME)).toBe(session);
      expect((await me(arrivedAt, session)).json()).toMatchObject({ user: { username: "owner" } });
    }
  });

  it("with nobody signed in on the other name, comes straight back to the marked sign-in page — no code, no second page", async (context) => {
    if (!server || !testDb) return context.skip();
    const codes = async () => Number((await testDb!.pool.query<{ n: string }>("select count(*)::text as n from auth_handoff_codes")).rows[0]!.n);
    const before = await codes();
    const { back, location } = await silentTry(TEAM, HUB, {});
    expect(location).toBe(back);
    expect(new URL(location).searchParams.get("sso")).toBe("none");
    expect(await codes()).toBe(before);
  });

  it("does not take a narrow session for a sign-in", async (context) => {
    if (!server) return context.skip();
    const device = await issueDeviceTokenWithPassword(app, {
      username: "chatter-a", password: "chatter-a-password-for-tests", label: "Firefox", clientVersion: null, clientProfile: "chat-extension",
    });
    const link = await request("POST", `${HUB}/api/v1/auth/web-link`, { headers: { authorization: `Bearer ${device.token}` }, payload: {} });
    const narrow = cookieSet(await request("GET", (link.json() as { url: string }).url), SESSION_COOKIE_NAME)!;
    const { back, location } = await silentTry(HUB, TEAM, { [SESSION_COOKIE_NAME]: narrow });
    expect(location).toBe(back);
  });

  it("without `silent`, nobody still gets the sign-in page of the name asked", async (context) => {
    if (!server) return context.skip();
    const begun = await request("GET", `${TEAM}/api/v1/auth/sso/begin?${new URLSearchParams({ from: HUB, next: "/workboard/" })}`);
    const asked = await request("GET", String(begun.headers.location));
    expect(String(asked.headers.location).startsWith(`${HUB}/login?`)).toBe(true);
  });
});

describe("a one-time code", () => {
  it("is accepted once", async (context) => {
    if (!server) return context.skip();
    const session = await signIn("owner", HUB);
    const { accept, state } = await hopToAccept(HUB, session, TEAM);
    expect(cookieSet(await request("GET", accept, { cookies: { [STATE_COOKIE]: state } }), SESSION_COOKIE_NAME)).toBe(session);
    const again = await request("GET", accept, { cookies: { [STATE_COOKIE]: state } });
    expect(again.statusCode).toBe(302);
    expect(cookieSet(again, SESSION_COOKIE_NAME)).toBeUndefined();
  });

  it("expires", async (context) => {
    if (!server || !testDb) return context.skip();
    const session = await signIn("owner", HUB);
    const { accept, state } = await hopToAccept(HUB, session, TEAM);
    await testDb.pool.query("update auth_handoff_codes set expires_at = now() - interval '1 second' where code_digest = $1", [sha256Hex(codeOf(accept))]);
    expect(cookieSet(await request("GET", accept, { cookies: { [STATE_COOKIE]: state } }), SESSION_COOKIE_NAME)).toBeUndefined();
  });

  it("is accepted only on the name it was minted for", async (context) => {
    if (!server) return context.skip();
    const session = await signIn("owner", HUB);
    const { accept, state } = await hopToAccept(HUB, session, TEAM);
    // A name that takes no browser sign-in at all (another service's): refused before the code is looked at.
    expect((await request("GET", accept.replace(TEAM, TASKS), { cookies: { [STATE_COOKIE]: state } })).statusCode).toBe(400);
    // Hub's other name: the code is not its own.
    expect(cookieSet(await request("GET", accept.replace(TEAM, HUB), { cookies: { [STATE_COOKIE]: state } }), SESSION_COOKIE_NAME))
      .toBeUndefined();
    // Spent by that try: not even its own name takes it now.
    expect(cookieSet(await request("GET", accept, { cookies: { [STATE_COOKIE]: state } }), SESSION_COOKIE_NAME)).toBeUndefined();
  });

  it("is accepted only by the browser that asked for it (no session fixation by a link)", async (context) => {
    if (!server) return context.skip();
    const session = await signIn("owner", HUB);
    // Someone else's browser: no state cookie, or a state of its own.
    const first = await hopToAccept(HUB, session, TEAM);
    expect(cookieSet(await request("GET", first.accept), SESSION_COOKIE_NAME)).toBeUndefined();
    const second = await hopToAccept(HUB, session, TEAM);
    const other = await hopToAccept(HUB, session, TEAM);
    expect(cookieSet(await request("GET", second.accept, { cookies: { [STATE_COOKIE]: other.state } }), SESSION_COOKIE_NAME)).toBeUndefined();
  });

  it("of a session signed out meanwhile plants nothing", async (context) => {
    if (!server) return context.skip();
    const session = await signIn("owner", HUB);
    const { accept, state } = await hopToAccept(HUB, session, TEAM);
    await request("POST", `${HUB}/api/v1/auth/logout`, { cookies: { [SESSION_COOKIE_NAME]: session }, headers: { origin: HUB } });
    expect(cookieSet(await request("GET", accept, { cookies: { [STATE_COOKIE]: state } }), SESSION_COOKIE_NAME)).toBeUndefined();
  });
});

describe("where a hand-off may lead", () => {
  it.each([
    ["sso", `${HUB}/api/v1/auth/sso?${new URLSearchParams({ to: TEAM, next: "https://evil.example/" })}`],
    ["sso", `${HUB}/api/v1/auth/sso?${new URLSearchParams({ to: TEAM, next: "//evil.example/" })}`],
    ["sso", `${HUB}/api/v1/auth/sso?${new URLSearchParams({ to: TEAM, next: `${HUB}/api/v1/admin/users` })}`],
    ["sso", `${HUB}/api/v1/auth/sso?${new URLSearchParams({ to: "http://evil.test", next: "/" })}`],
    ["sso", `${HUB}/api/v1/auth/sso?${new URLSearchParams({ to: "http://ext.test" })}`],
    ["sso to another service's name as a browser", `${HUB}/api/v1/auth/sso?${new URLSearchParams({ to: TASKS })}`],
    ["sso to a service without its callback", `${HUB}/api/v1/auth/sso?${new URLSearchParams({ to: "monitor", state: "client-state-0123456789" })}`],
    ["sso to a service without its own state", `${HUB}/api/v1/auth/sso?${new URLSearchParams({ to: "contentops" })}`],
    ["begin", `${TEAM}/api/v1/auth/sso/begin?${new URLSearchParams({ from: HUB, next: "https://evil.example/" })}`],
    ["begin", `${TEAM}/api/v1/auth/sso/begin?${new URLSearchParams({ from: "http://evil.test", next: "/" })}`],
    ["begin", `${TEAM}/api/v1/auth/sso/begin?${new URLSearchParams({ from: TASKS, next: "/" })}`],
    ["begin on a name that takes no sign-in", `http://evil.test/api/v1/auth/sso/begin?${new URLSearchParams({ from: HUB })}`],
    ["sso on a name that mints no code", `${TASKS}/api/v1/auth/sso?${new URLSearchParams({ to: TEAM })}`],
  ])("refuses an address off the allow-list (%s)", async (_step, url) => {
    if (!server) return;
    const response = await request("GET", url);
    expect(response.statusCode, response.body).toBe(400);
    expect(response.headers.location).toBeUndefined();
  });
});

describe("a change made with a cookie", () => {
  it("is refused from another name's page, sibling subdomains included", async (context) => {
    if (!server) return context.skip();
    const session = await signIn("owner", HUB);
    for (const origin of ["http://ext.test", "http://tasks.test", "https://evil.example", "null"]) {
      const response = await request("POST", `${HUB}/api/v1/admin/invites`, {
        cookies: { [SESSION_COOKIE_NAME]: session },
        headers: { origin },
        payload: { username: "never-made", role: "chatter", pageLabels: [] },
      });
      expect(response.statusCode, origin).toBe(403);
      expect(response.json(), origin).toMatchObject({ error: "cross_origin" });
    }
    const forged = await request("POST", `${HUB}/api/v1/auth/login`, {
      headers: { origin: "http://ext.test" },
      payload: { username: "owner", password: "owner-password-for-tests" },
    });
    expect(forged.statusCode).toBe(403);
    expect(cookieSet(forged, SESSION_COOKIE_NAME)).toBeUndefined();
  });

  it("is taken from Hub's own pages, and a bearer is never asked", async (context) => {
    if (!server) return context.skip();
    const session = await signIn("owner", HUB);
    const ours = await request("POST", `${TEAM}/api/v1/admin/invites`, {
      cookies: { [SESSION_COOKIE_NAME]: session },
      headers: { origin: TEAM },
      payload: { username: "made-from-team", role: "chatter", pageLabels: [] },
    });
    expect(ours.statusCode, ours.body).toBe(200);
    const device = await issueDeviceTokenWithPassword(app, {
      username: "chatter-a", password: "chatter-a-password-for-tests", label: "Firefox", clientVersion: null, clientProfile: "chat-extension",
    });
    const bearer = await request("POST", `${HUB}/api/v1/auth/web-link`, {
      headers: { authorization: `Bearer ${device.token}`, origin: "moz-extension://abc" },
      payload: {},
    });
    expect(bearer.statusCode, bearer.body).toBe(200);
  });
});

describe("/join", () => {
  it("signs the newcomer in on the name the link was opened on", async (context) => {
    if (!server) return context.skip();
    const invite = await createInvite(app, { username: "newcomer", pageLabels: [] }, { source: "cli" });
    const redeemed = await request("POST", `${TEAM}/api/v1/auth/links/redeem`, {
      headers: { origin: TEAM },
      payload: { token: invite.link.token, password: "a-strong-password-for-tests" },
    });
    expect(redeemed.statusCode, redeemed.body).toBe(200);
    expect(redeemed.json()).toEqual({ username: "newcomer" });
    const session = cookieSet(redeemed, SESSION_COOKIE_NAME);
    expect(session).toBeDefined();
    expect((await me(TEAM, session)).json()).toMatchObject({ authMethod: "session", user: { username: "newcomer", role: "chatter" } });
  });
});

describe("the narrow web session from the extension", () => {
  async function narrowSession(username: string, password: string, cookies: Cookies = {}) {
    const device = await issueDeviceTokenWithPassword(app, {
      username, password, label: "Firefox", clientVersion: null, clientProfile: "chat-extension",
    });
    const link = await request("POST", `${HUB}/api/v1/auth/web-link`, {
      headers: { authorization: `Bearer ${device.token}` },
      payload: { next: "/workboard/my/shifts" },
    });
    expect(link.statusCode, link.body).toBe(200);
    const url = (link.json() as { url: string }).url;
    expect(url.startsWith(`${TEAM}/api/v1/auth/sso/accept?code=`)).toBe(true);
    const accepted = await request("GET", url, { cookies });
    expect(accepted.statusCode).toBe(302);
    expect(accepted.headers.location).toBe(`${TEAM}/workboard/my/shifts`);
    return { device, url, accepted, session: cookieSet(accepted, SESSION_COOKIE_NAME) };
  }

  it("opens the team's place and is refused every other route — an owner's device too", async (context) => {
    if (!server) return context.skip();
    const { session } = await narrowSession("owner", "owner-password-for-tests");
    expect(session).toBeDefined();
    expect((await me(TEAM, session)).json()).toMatchObject({ authMethod: "session", narrow: true, user: { role: "owner" } });

    const answered: Record<string, number> = {};
    const leaked: string[] = [];
    let walked = 0;
    for (const row of server.routePolicyTable) {
      if (row.auth?.kind === "public" || row.auth?.kind === "hmac") continue;
      walked += 1;
      const url = row.url.replace(/:[A-Za-z]+/g, "1").replace("*", "x");
      const response = await request(row.method as "GET" | "POST" | "DELETE", `${TEAM}${url}`, {
        cookies: { [SESSION_COOKIE_NAME]: session! },
        ...(row.method === "GET" || row.method === "DELETE" ? {} : { payload: {} }),
      });
      const allowed = ["me", "accountChatterStats", "accountReports"].includes(row.routeKey);
      const refused = response.statusCode === 403 && (response.json() as { message?: string }).message === NARROW_WEB_SESSION_REFUSAL_MESSAGE;
      if (allowed) answered[row.routeKey] = response.statusCode;
      else if (!refused) leaked.push(`${row.method} ${row.url} → ${response.statusCode}`);
    }
    expect(leaked).toEqual([]);
    expect(walked).toBeGreaterThan(300);
    expect(answered.me).toBe(200);
    expect(answered.accountChatterStats).toBe(200);

    // The API document and the page browser's screen go through the dashboard guard: refused too.
    const docs = await request("GET", `${TEAM}/documentation/json`, { cookies: { [SESSION_COOKIE_NAME]: session! } });
    expect(docs.statusCode).toBe(403);
    // nginx's question: a narrow session is nobody to the names behind it.
    expect((await request("GET", `${TEAM}/api/v1/auth/introspect`, { cookies: { [SESSION_COOKIE_NAME]: session! } })).statusCode).toBe(401);
    // It never travels to another name: the sign-in page instead.
    const hop = await request("GET", `${TEAM}/api/v1/auth/sso?${new URLSearchParams({ to: HUB, state: "a".repeat(64) })}`, {
      cookies: { [SESSION_COOKIE_NAME]: session! },
    });
    expect(String(hop.headers.location)).toMatch(new RegExp(`^${TEAM}/login\\?`));
  });

  it("dies with its device token", async (context) => {
    if (!server) return context.skip();
    const { device, session } = await narrowSession("chatter-a", "chatter-a-password-for-tests");
    expect((await me(TEAM, session)).statusCode).toBe(200);
    const revoked = await request("DELETE", `${HUB}/api/v1/auth/device-tokens/current`, { headers: { authorization: `Bearer ${device.token}` } });
    expect(revoked.statusCode, revoked.body).toBe(200);
    expect((await me(TEAM, session)).statusCode).toBe(401);
  });

  it("leaves a browser's full session of the same person as it is, and its link works once", async (context) => {
    if (!server) return context.skip();
    const full = await signIn("chatter-a", TEAM);
    const { url, accepted } = await narrowSession("chatter-a", "chatter-a-password-for-tests", { [SESSION_COOKIE_NAME]: full });
    expect(cookieSet(accepted, SESSION_COOKIE_NAME)).toBeUndefined();
    expect((await me(TEAM, full)).json()).not.toHaveProperty("narrow");
    expect(cookieSet(await request("GET", url), SESSION_COOKIE_NAME)).toBeUndefined();
  });
});

describe("nginx's question (introspect)", () => {
  it("answers who the cookie's session is, without a write; 401 for nobody and for a bearer", async (context) => {
    if (!server || !testDb) return context.skip();
    const session = await signIn("owner", HUB);
    const seen = async () => (await testDb!.pool.query<{ last_seen_at: Date }>(
      "select last_seen_at from auth_sessions where token_digest = $1", [sha256Hex(session)],
    )).rows[0]!.last_seen_at.getTime();
    const before = await seen();
    const answer = await request("GET", `${TEAM}/api/v1/auth/introspect`, { cookies: { [SESSION_COOKIE_NAME]: session } });
    expect(answer.statusCode).toBe(200);
    expect({ user: answer.headers["x-hub-user"], login: answer.headers["x-hub-login"], role: answer.headers["x-hub-role"] })
      .toEqual({ user: String(users.owner), login: "owner", role: "owner" });
    expect(await seen()).toBe(before);
    expect((await request("GET", `${TEAM}/api/v1/auth/introspect`)).statusCode).toBe(401);
    expect((await request("GET", `${TEAM}/api/v1/auth/introspect`, {
      cookies: { [SESSION_COOKIE_NAME]: session },
      headers: { authorization: "Bearer agency_hub_device_nobody" },
    })).statusCode).toBe(401);
  });
});

describe("another service's server", () => {
  async function clientCode(session: string, client = "contentops", callback = CLIENT_CALLBACK): Promise<string> {
    const minted = await request("GET", `${HUB}/api/v1/auth/sso?${new URLSearchParams({ to: client, state: "client-state-0123456789", next: "/plan" })}`, {
      cookies: { [SESSION_COOKIE_NAME]: session },
    });
    expect(minted.statusCode, minted.body).toBe(302);
    const at = new URL(String(minted.headers.location));
    expect(`${at.origin}${at.pathname}`).toBe(callback);
    expect(at.searchParams.get("state")).toBe("client-state-0123456789");
    expect(at.searchParams.get("next")).toBe("/plan");
    return at.searchParams.get("code")!;
  }

  function redeem(key: string, client: string, code: string) {
    return request("POST", `${HUB}/api/v1/auth/sso/redeem`, { headers: { authorization: `Bearer ${key}` }, payload: { client, code } });
  }

  it("learns who signed in and whether it is the owner, once, never the session; and loses the sign-in with it", async (context) => {
    if (!server) return context.skip();
    const session = await signIn("owner", HUB);
    const key = await agentKey(["signin:contentops"]);
    const code = await clientCode(session);
    const redeemed = await redeem(key, "contentops", code);
    expect(redeemed.statusCode, redeemed.body).toBe(200);
    expect(redeemed.json()).toMatchObject({ user: { id: users.owner, username: "owner", role: "owner" }, owner: true });
    expect(redeemed.body).not.toContain(session);
    const grant = (redeemed.json() as { grant: string }).grant;

    expect((await redeem(key, "contentops", code)).statusCode).toBe(409);

    const check = () => request("POST", `${HUB}/api/v1/auth/sso/check`, {
      headers: { authorization: `Bearer ${key}` },
      payload: { client: "contentops", grant },
    });
    expect((await check()).json()).toMatchObject({ active: true, owner: true, user: { username: "owner" } });
    await request("POST", `${HUB}/api/v1/auth/logout`, { cookies: { [SESSION_COOKIE_NAME]: session }, headers: { origin: HUB } });
    expect((await check()).json()).toEqual({ active: false });
  });

  it("says a chatter is not the owner (TaskIndex opens only for the owner)", async (context) => {
    if (!server) return context.skip();
    const session = await signIn("chatter-a", HUB);
    const key = await agentKey(["signin:taskindex"]);
    const redeemed = await redeem(key, "taskindex", await clientCode(session, "taskindex", TASKS_CALLBACK));
    expect(redeemed.statusCode, redeemed.body).toBe(200);
    expect(redeemed.json()).toMatchObject({ user: { username: "chatter-a", role: "chatter" }, owner: false });
  });

  it("redeems only its own service's codes, with its own capability", async (context) => {
    if (!server) return context.skip();
    const session = await signIn("owner", HUB);
    const tasksKey = await agentKey(["signin:taskindex"]);
    // Another service's capability does not reach ContentOps' redeem.
    expect((await redeem(tasksKey, "contentops", await clientCode(session))).statusCode).toBe(403);
    // Nor does naming its own client make another service's code its own.
    const contentopsCode = await clientCode(session);
    expect((await redeem(tasksKey, "taskindex", contentopsCode)).statusCode).toBe(409);
    // A key with no sign-in capability at all.
    expect((await redeem(await agentKey(["read:content"]), "contentops", await clientCode(session))).statusCode).toBe(403);
  });

  it("cannot take a browser's code, nor a browser the server's", async (context) => {
    if (!server) return context.skip();
    const session = await signIn("owner", HUB);
    const key = await agentKey(["signin:contentops"]);
    const browser = await hopToAccept(HUB, session, TEAM);
    expect((await redeem(key, "contentops", codeOf(browser.accept))).statusCode).toBe(409);

    const serverCode = await clientCode(session);
    const asBrowser = await request("GET", `${TEAM}/api/v1/auth/sso/accept?${new URLSearchParams({ code: serverCode })}`, {
      cookies: { [STATE_COOKIE]: browser.state },
    });
    expect(cookieSet(asBrowser, SESSION_COOKIE_NAME)).toBeUndefined();
  });
});
