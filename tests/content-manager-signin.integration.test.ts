import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createFanslyPage, createModel, insertAgentKey, openMatter } from "@agency_hub_core/db";
import { sha256Hex } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { AGENT_KEY_TOKEN_PREFIX, SESSION_COOKIE_NAME, authenticateSessionToken, createUserAccount } from "../apps/runtime/src/services/auth.ts";
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
    for (const path of ["/api/v1/overview", "/api/v1/team/shifts", "/api/v1/matters/waiting", "/api/v1/admin/users"]) {
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
