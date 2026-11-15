import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createFanslyPage, createModel, insertAgentKey, listContentManagerLoginsByPage, openMatter } from "@agency_hub_core/db";
import { sha256Hex } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import { createInvite } from "../apps/runtime/src/services/account-links.ts";
import { publicationItems } from "../apps/runtime/src/services/matters-mirror.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import {
  AGENT_KEY_TOKEN_PREFIX, LOGIN_BACKOFF_FREE_FAILURES, SESSION_COOKIE_NAME, authenticateSessionToken, createUserAccount, setUserPassword,
} from "../apps/runtime/src/services/auth.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// The content manager's product (products plan §4.1): the owner invites a person with the role «Контент-менеджер»,
// the link sets the password, the login holds a session that opens ContentOps alone, reads the pages of the models of
// its working pages and nothing of the console; ContentOps learns the person from the sign-in and reads what waits.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

const HUB = "http://hub.test";
const TEAM = "http://team.test";
const CALLBACK = "http://co.test/auth/hub/callback";
const KEY = `${AGENT_KEY_TOKEN_PREFIX}contentops-signin-for-tests`;

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let ownerCookie = "";
const pages: Record<string, number> = {};

type Injected = Awaited<ReturnType<Awaited<ReturnType<typeof buildApiServer>>["inject"]>>;

function request(method: "GET" | "POST", url: string, options: { session?: string; headers?: Record<string, string>; payload?: object } = {}): Promise<Injected> {
  const address = new URL(url);
  return server!.inject({
    method,
    url: `${address.pathname}${address.search}`,
    headers: {
      host: address.host,
      ...(options.session ? { cookie: `${SESSION_COOKIE_NAME}=${options.session}` } : {}),
      ...options.headers,
    },
    ...(options.payload ? { payload: options.payload } : {}),
  });
}

function sessionOf(response: Injected): string {
  return response.cookies.find((cookie) => cookie.name === SESSION_COOKIE_NAME)!.value;
}

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
  if (!testDb) return;
  app = createTestAppContext(testDb);
  Object.assign(app.config, { webConsoleOrigin: HUB, webTeamOrigin: TEAM, webSigninClients: { contentops: CALLBACK } });
  await createUserAccount(app, { username: "boss", role: "owner", password: "boss-password-for-tests" }, { source: "cli" });
  const mia = await createModel(app.db, { slug: "Mia", name: "Mia" });
  const zoe = await createModel(app.db, { slug: "zoe", name: "Zoe" });
  pages["mia-1"] = (await createFanslyPage(app.db, { modelId: mia!.id, label: "mia-1" }))!.id;
  pages["mia-2"] = (await createFanslyPage(app.db, { modelId: mia!.id, label: "mia-2" }))!.id;
  pages["zoe-1"] = (await createFanslyPage(app.db, { modelId: zoe!.id, label: "zoe-1" }))!.id;
  await insertAgentKey(testDb.db, {
    name: "contentops-signin",
    keyPrefix: KEY.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6),
    keyDigest: sha256Hex(KEY),
    capabilities: ["signin:contentops"] as never,
    pageIds: [],
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    createdBy: await fixtureUserId(app, "boss"),
  });
  server = await buildApiServer(app);
  await server.ready();
  const login = await request("POST", `${HUB}/api/v1/auth/login`, { headers: { origin: HUB }, payload: { username: "boss", password: "boss-password-for-tests" } });
  expect(login.statusCode, login.body).toBe(200);
  ownerCookie = sessionOf(login);
}, 180_000);

afterAll(async () => {
  await server?.close();
  await testDb?.stop();
});

describe("a content manager", () => {
  let session = "";
  let userId = 0;

  it("is invited by role: the person, the login and the link; the link sets the password and signs in", async (context) => {
    if (!server) return context.skip();
    const created = await request("POST", `${HUB}/api/v1/admin/people`, {
      session: ownerCookie,
      headers: { origin: HUB },
      payload: {
        code: "kira", displayName: "Кира", role: "content_manager", state: "invited", workingPageLabels: ["mia-1"],
        invite: { username: "kira", role: "content_manager", pageLabels: ["mia-1"] },
      },
    });
    expect(created.statusCode, created.body).toBe(200);
    const invite = created.json<{ invite: { userId: number; link: { token: string } } }>().invite;
    userId = invite.userId;
    const redeemed = await request("POST", `${TEAM}/api/v1/auth/links/redeem`, {
      headers: { origin: TEAM },
      payload: { token: invite.link.token, password: "a-strong-password-for-tests" },
    });
    expect(redeemed.statusCode, redeemed.body).toBe(200);
    const me = await request("GET", `${TEAM}/api/v1/auth/me`, { session: sessionOf(redeemed) });
    expect(me.json()).toMatchObject({ authMethod: "session", user: { username: "kira", role: "content_manager" }, products: ["contentops"] });
    const signedIn = await request("POST", `${HUB}/api/v1/auth/login`, { headers: { origin: HUB }, payload: { username: "kira", password: "a-strong-password-for-tests" } });
    expect(signedIn.statusCode, signedIn.body).toBe(200);
    session = sessionOf(signedIn);
  });

  it("reads nothing of the console or Workboard: every operation off its table is 403", async (context) => {
    if (!server || !session) return context.skip();
    for (const path of ["/api/v1/overview", "/api/v1/team/shifts", "/api/v1/matters/waiting", "/api/v1/pages", "/api/v1/admin/users"]) {
      expect((await request("GET", `${HUB}${path}`, { session })).statusCode, path).toBe(403);
    }
    expect((await request("GET", `${HUB}/api/v1/auth/me`, { session })).statusCode).toBe(200);
    // Its page scope: every page of the models of its working pages (mia-1 → Mia's two), never another model's.
    const principal = await authenticateSessionToken(app, session);
    expect([...principal!.assignedPageIds].sort()).toEqual([pages["mia-1"], pages["mia-2"]].sort());
  });

  it("is told to ContentOps with the code, the role, the models of the working pages and the products; then what waits", async (context) => {
    if (!server || !session) return context.skip();
    const minted = await request("GET", `${HUB}/api/v1/auth/sso?${new URLSearchParams({ to: "contentops", state: "client-state-0123456789", next: "/" })}`, { session });
    expect(minted.statusCode, minted.body).toBe(302);
    const code = new URL(String(minted.headers.location)).searchParams.get("code")!;
    const redeemed = await request("POST", `${HUB}/api/v1/auth/sso/redeem`, { headers: { authorization: `Bearer ${KEY}` }, payload: { client: "contentops", code } });
    expect(redeemed.statusCode, redeemed.body).toBe(200);
    expect(redeemed.json()).toMatchObject({
      owner: false,
      user: { username: "kira", role: "content_manager" },
      person: { code: "kira", displayName: "Кира", role: "content_manager", models: ["mia"], customsModels: [], products: ["contentops"] },
    });
    const grant = redeemed.json<{ grant: string }>().grant;

    // What waits: the person's own ContentOps matters, never the chat side of an order nor anybody else's.
    const opened = (key: string, kind: string, owner: { userId: number } | { role: "owner" }) => openMatter(app.db, {
      key, kind, source: "server", title: key, object: null, pageIds: [pages["mia-1"]!], owner, money: false, evidence: {}, link: "/plan",
    }, { door: "system" });
    await opened("content.week_approve:mia-1", "content.week_approve", { userId });
    await opened("custom.give_on_shift:1", "custom.give_on_shift", { userId });
    await opened("content.week_approve:zoe-1", "content.week_approve", { role: "owner" });
    const waiting = await request("POST", `${HUB}/api/v1/auth/sso/waiting`, { headers: { authorization: `Bearer ${KEY}` }, payload: { client: "contentops", grant } });
    expect(waiting.statusCode, waiting.body).toBe(200);
    expect(waiting.json<{ matters: Array<{ key?: string; title: string }> }>().matters.map((matter) => matter.title)).toEqual(["content.week_approve:mia-1"]);
    // Each matter names its model as Hub's slug: ContentOps cuts by Hub's model, not by its own pages' binding.
    expect(waiting.json<{ matters: Array<{ models: string[] }> }>().matters[0]?.models).toEqual(["mia"]);

    // Closed in the registry: the re-check says so, ContentOps closes its own person.
    await testDb!.pool.query("update people set state = 'left', left_on = current_date where code = 'kira'");
    const check = await request("POST", `${HUB}/api/v1/auth/sso/check`, { headers: { authorization: `Bearer ${KEY}` }, payload: { client: "contentops", grant } });
    expect(check.json()).toMatchObject({ active: true, person: { code: "kira", state: "left" } });
  });

  it("has no extension: a device token is refused", async (context) => {
    if (!server || !session) return context.skip();
    const device = await request("POST", `${HUB}/api/v1/auth/device-tokens/password`, {
      payload: { username: "kira", password: "a-strong-password-for-tests", label: "Firefox · Windows", mode: "active" },
    });
    expect(device.statusCode).toBe(403);
  });
});

describe("ContentOps' own entrance (package C4)", () => {
  const door = (path: string, payload: object) =>
    request("POST", `${HUB}/api/v1/auth/sso/${path}`, { headers: { authorization: `Bearer ${KEY}` }, payload: { client: "contentops", ...payload } });
  const signIn = (username: string, password: string) =>
    door("password", { username, password, ip: "203.0.113.7", userAgent: "Firefox · Windows" });

  it("signs a content manager in by login and password: the person and a grant, journaled as via ContentOps", async (context) => {
    if (!server) return context.skip();
    const created = await request("POST", `${HUB}/api/v1/admin/people`, {
      session: ownerCookie,
      headers: { origin: HUB },
      payload: {
        code: "lina", displayName: "Лина", role: "content_manager", state: "invited", workingPageLabels: ["mia-1"],
        invite: { username: "lina", role: "content_manager", pageLabels: ["mia-1"] },
      },
    });
    expect(created.statusCode, created.body).toBe(200);
    const token = created.json<{ invite: { link: { token: string } } }>().invite.link.token;

    // The invitation ends on ContentOps' page: the password is set in the registry, the person is signed in.
    const joined = await door("link", { token, password: "a-strong-password-for-lina" });
    expect(joined.json()).toMatchObject({ result: "signed_in", user: { username: "lina" }, person: { code: "lina", products: ["contentops"] } });
    expect((await door("link", { token, password: "a-strong-password-for-lina" })).json()).toMatchObject({ result: "refused", reason: "link_used" });

    const signed = await signIn("lina", "a-strong-password-for-lina");
    expect(signed.statusCode, signed.body).toBe(200);
    expect(signed.json()).toMatchObject({ result: "signed_in", owner: false, user: { username: "lina" }, person: { models: ["mia"] } });
    const grant = signed.json<{ grant: string }>().grant;
    const check = await door("check", { grant });
    expect(check.json()).toMatchObject({ active: true, user: { username: "lina" } });
    const journal = await testDb!.pool.query<{ metadata: Record<string, unknown> }>(
      "select metadata from audit_events where event_type = 'auth.login' and metadata->>'username' = 'lina' order by id desc limit 1");
    expect(journal.rows[0]?.metadata).toMatchObject({ via: "contentops", ip: "203.0.113.7" });
    expect(JSON.stringify(journal.rows)).not.toContain("a-strong-password");

    // «Выйти» on ContentOps ends the session its page opened, and the grant with it.
    expect((await door("logout", { grant })).json()).toEqual({ ended: true });
    expect((await door("check", { grant })).json()).toEqual({ active: false });
  });

  it("answers one word for an unknown login and a wrong password, and locks after Hub's own number of tries", async (context) => {
    if (!server) return context.skip();
    expect((await signIn("nobody-here", "whatever-password")).json()).toEqual({ result: "refused", reason: "wrong" });
    let last: unknown = null;
    for (let i = 0; i < LOGIN_BACKOFF_FREE_FAILURES; i += 1) last = (await signIn("lina", "not-her-password")).json();
    expect(last).toEqual({ result: "refused", reason: "wrong" });
    // Locked now, the right password too, as on Hub's own page.
    expect((await signIn("lina", "a-strong-password-for-lina")).json()).toEqual({ result: "refused", reason: "locked" });
  });

  it("refuses the owner before the password, and a person without ContentOps after it", async (context) => {
    if (!server) return context.skip();
    expect((await signIn("boss", "boss-password-for-tests")).json()).toEqual({ result: "refused", reason: "owner" });
    expect((await signIn("boss", "anything")).json()).toEqual({ result: "refused", reason: "owner" });
    await createUserAccount(app, { username: "chatty", role: "chatter" }, { source: "cli" });
    await setUserPassword(app, { userId: await fixtureUserId(app, "chatty"), password: "chatty-password-for-tests" }, { source: "cli" });
    expect((await signIn("chatty", "chatty-password-for-tests")).json()).toEqual({ result: "refused", reason: "no_access" });
    expect((await signIn("chatty", "wrong-password-here")).json()).toEqual({ result: "refused", reason: "wrong" });
  });

  it("does not sign out a session the person opened in Hub themselves", async (context) => {
    if (!server) return context.skip();
    const hubSession = sessionOf(await request("POST", `${HUB}/api/v1/auth/login`, {
      headers: { origin: HUB }, payload: { username: "kira", password: "a-strong-password-for-tests" },
    }));
    const minted = await request("GET", `${HUB}/api/v1/auth/sso?${new URLSearchParams({ to: "contentops", state: "client-state-0123456789", next: "/" })}`, { session: hubSession });
    const code = new URL(String(minted.headers.location)).searchParams.get("code")!;
    const grant = (await door("redeem", { code })).json<{ grant: string }>().grant;
    expect((await door("logout", { grant })).json()).toEqual({ ended: false });
    expect((await request("GET", `${HUB}/api/v1/auth/me`, { session: hubSession })).statusCode).toBe(200);
  });
  it("refuses the owner's password change before anything changes: the password stays, his sessions live", async (context) => {
    if (!server) return context.skip();
    const ownerSession = sessionOf(await request("POST", `${HUB}/api/v1/auth/login`, {
      headers: { origin: HUB }, payload: { username: "boss", password: "boss-password-for-tests" },
    }));
    const minted = await request("GET", `${HUB}/api/v1/auth/sso?${new URLSearchParams({ to: "contentops", state: "client-state-0123456789", next: "/" })}`, { session: ownerSession });
    const code = new URL(String(minted.headers.location)).searchParams.get("code")!;
    const grant = (await door("redeem", { code })).json<{ grant: string }>().grant;
    const refusedChange = await door("password-change", { grant, currentPassword: "boss-password-for-tests", newPassword: "a-brand-new-password-1" });
    expect(refusedChange.json()).toEqual({ result: "refused", reason: "owner" });
    expect((await request("GET", `${HUB}/api/v1/auth/me`, { session: ownerSession })).statusCode).toBe(200);
    expect((await door("check", { grant })).json()).toMatchObject({ active: true });
    const again = await request("POST", `${HUB}/api/v1/auth/login`, { headers: { origin: HUB }, payload: { username: "boss", password: "boss-password-for-tests" } });
    expect(again.statusCode).toBe(200);
  });

  it("refuses a link of a login that opens elsewhere before the link is spent", async (context) => {
    if (!server) return context.skip();
    const invite = await createInvite(app, { username: "chat-newbie", pageLabels: [] }, { source: "cli" });
    expect((await door("link", { token: invite.link.token, password: "a-strong-password-for-tests" })).json())
      .toEqual({ result: "refused", reason: "not_here" });
    const link = await testDb!.pool.query<{ used: boolean }>("select used_at is not null as used from account_links where user_id = $1", [invite.user.id]);
    expect(link.rows[0]?.used).toBe(false);
  });
  it("journals the owner's login and a right password without ContentOps; limits by the person's address", async (context) => {
    if (!server) return context.skip();
    const before = Number((await testDb!.pool.query<{ n: string }>("select count(*) as n from audit_events where event_type = 'auth.login_refused'")).rows[0]?.n);
    await signIn("boss", "anything");
    await signIn("chatty", "chatty-password-for-tests");
    const rows = await testDb!.pool.query<{ metadata: { reason: string; via: string } }>(
      "select metadata from audit_events where event_type = 'auth.login_refused' order by id");
    expect(rows.rows.length - before).toBe(2);
    expect(rows.rows.slice(-2).map((row) => row.metadata.reason)).toEqual(["owner", "no_access"]);
    // Twenty tries a minute from one address; another address is not held back by it.
    let last = 0;
    for (let i = 0; i < 21; i += 1) {
      last = (await door("password", { username: `nobody-${i}`, password: "x", ip: "198.51.100.1" })).statusCode;
    }
    expect(last).toBe(429);
    expect((await door("password", { username: "nobody", password: "x", ip: "198.51.100.2" })).statusCode).toBe(200);
  });

  it("names the content manager of each page, and gives her the shooting's matter with what it is about", async (context) => {
    if (!server) return context.skip();
    const created = await request("POST", `${HUB}/api/v1/admin/people`, {
      session: ownerCookie,
      headers: { origin: HUB },
      payload: {
        code: "mira", displayName: "Мира", role: "content_manager", state: "invited", workingPageLabels: ["mia-2"],
        invite: { username: "mira", role: "content_manager", pageLabels: ["mia-2"] },
      },
    });
    const token = created.json<{ invite: { userId: number; link: { token: string } } }>().invite.link.token;
    const mira = created.json<{ invite: { userId: number } }>().invite.userId;
    // Invited, never signed in: not the page's content manager yet — a post of mia-2 stays the owner's.
    expect((await listContentManagerLoginsByPage(app.db)).has("mia-2")).toBe(false);
    expect(publicationItems("publication.draft", [{ id: 1, pageLabel: "mia-2", kind: "wall_post", publishAt: new Date().toISOString(), version: 1 }],
      await listContentManagerLoginsByPage(app.db))[0]?.owner).toBeUndefined();
    await openMatter(app.db, {
      key: "custom.checked_not_at_model:K-7", kind: "custom.checked_not_at_model", source: "server", title: "Кастом K-7 проверен и сутки не у модели",
      object: { type: "custom_order", id: "7" }, pageIds: [pages["mia-2"]!], owner: { userId: mira }, money: false, evidence: {}, link: "/workboard/customs/K-7",
    }, { door: "system" });
    const grant = (await door("link", { token, password: "a-strong-password-for-mira" })).json<{ grant: string }>().grant;
    // She set her password: the mirror's next pass addresses her page's posts to her.
    const managers = await listContentManagerLoginsByPage(app.db);
    expect(managers.get("mia-2")).toBe(mira);
    expect(managers.has("zoe-1")).toBe(false);
    expect(publicationItems("publication.draft", [{ id: 1, pageLabel: "mia-2", kind: "wall_post", publishAt: new Date().toISOString(), version: 1 }],
      managers)[0]?.owner).toEqual({ userId: mira });
    const waiting = await door("waiting", { grant });
    expect(waiting.json<{ matters: Array<{ kind: string; object: unknown }> }>().matters)
      .toContainEqual(expect.objectContaining({ kind: "custom.checked_not_at_model", object: { type: "custom_order", id: "7" } }));
  });
});
