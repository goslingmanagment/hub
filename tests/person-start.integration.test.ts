import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { accountStartResponseSchema, adminPersonResponseSchema } from "@agency_hub_core/contracts";
import { createFanslyPage, createModel, insertAgentKey, listOpenMattersOfKinds } from "@agency_hub_core/db";
import { sha256Hex } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { AGENT_KEY_TOKEN_PREFIX, createUserAccount, setUserPassword } from "../apps/runtime/src/services/auth.ts";
import { runPeopleStartTick } from "../apps/runtime/src/services/people/start-tick.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// «Начало» (ecosystem plan 2026-11-12, package J). Where a person's payouts go
// is money-adjacent: only the person's own session and the owner's card read
// it — never a team lead's or another chatter's session, never an agent key,
// never a device token. And every step of a newcomer's way closes by itself
// when its fact appears; the owner's matters open and close by themselves.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

const PAYOUT = "Bybit UID 55501-test-marker";
const NEWBIE_PASSWORD = "newbie-password-for-tests";
const KEY = `${AGENT_KEY_TOKEN_PREFIX}start-team-terms`;
const HOUR = 3_600_000;

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let pageId = 0;
const cookies: Record<string, string> = {};

const asSession = (who: string, method: "GET" | "POST" | "PUT" | "PATCH", url: string, payload?: Record<string, unknown>) =>
  server!.inject({ method, url, headers: { cookie: cookies[who]! }, ...(payload ? { payload } : {}) });

function cookieOf(header: string | string[] | number | undefined): string {
  return String(Array.isArray(header) ? header[0] : header).split(";")[0]!;
}

async function start(who: string) {
  const response = await asSession(who, "GET", "/api/v1/account/start");
  expect(response.statusCode, response.body).toBe(200);
  return accountStartResponseSchema.parse(response.json());
}

const doneSteps = (body: { start: { steps: { step: string; done: boolean }[] } | null }) =>
  body.start!.steps.filter((step) => step.done).map((step) => step.step);

async function invite(code: string, pages: string[]) {
  const created = await asSession("boss", "POST", "/api/v1/admin/people", {
    code, displayName: code === "newbie" ? "Новичок" : "Без страницы", role: "chatter", state: "invited", workingPageLabels: pages,
    invite: { username: code, pageLabels: pages },
  });
  expect(created.statusCode, created.body).toBe(200);
  return created.json().invite.link.token as string;
}

describe("«Начало»: a newcomer's way, and where they are paid", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
    if (!testDb) return;
    app = createTestAppContext(testDb);
    await createUserAccount(app, { username: "boss", role: "owner", password: "boss-password-for-tests" }, { source: "cli" });
    await createUserAccount(app, { username: "lead", role: "team_lead", password: "lead-password-for-tests" }, { source: "cli" });
    await createUserAccount(app, { username: "old", role: "chatter" }, { source: "cli" });
    await setUserPassword(app, { userId: await fixtureUserId(app, "old"), password: "old-password-for-tests" }, { source: "cli" });
    const model = await createModel(app.db, { slug: "mia", name: "Mia" });
    pageId = (await createFanslyPage(app.db, { modelId: model!.id, label: "mia-1" }))!.id;
    await insertAgentKey(testDb.db, {
      name: "start-team-terms",
      keyPrefix: KEY.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6),
      keyDigest: sha256Hex(KEY),
      capabilities: ["read:team", "read:pay_terms"] as never,
      pageIds: [pageId],
      expiresAt: new Date(Date.now() + 30 * 24 * HOUR),
      createdBy: await fixtureUserId(app, "boss"),
    });
    server = await buildApiServer(app);
    await server.ready();
    for (const user of ["boss", "lead", "old"]) {
      const login = await server.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: user, password: `${user}-password-for-tests` } });
      expect(login.statusCode, login.body).toBe(200);
      cookies[user] = cookieOf(login.headers["set-cookie"]);
    }
    const old = await asSession("boss", "POST", "/api/v1/admin/people", {
      code: "old", displayName: "Давний", role: "chatter", state: "working", workingPageLabels: ["mia-1"],
      logins: { add: [await fixtureUserId(app, "old")] },
    });
    expect(old.statusCode, old.body).toBe(200);

    // The owner's one form; the newcomer opens the link and is signed in by it.
    const token = await invite("newbie", ["mia-1"]);
    const redeemed = await server.inject({ method: "POST", url: "/api/v1/auth/links/redeem", payload: { token, password: NEWBIE_PASSWORD } });
    expect(redeemed.statusCode, redeemed.body).toBe(200);
    cookies.newbie = cookieOf(redeemed.headers["set-cookie"]);
  }, 180_000);

  afterAll(async () => {
    await server?.close();
    await testDb?.stop();
  });

  it("closes each step by itself as its fact appears", async (context) => {
    if (!testDb) return context.skip();
    const first = await start("newbie");
    expect(first.person).toEqual({ code: "newbie", displayName: "Новичок" });
    expect(first.username).toBe("newbie");
    expect(first.start).toMatchObject({ newcomer: true, signedUp: true, done: 1, total: 5, current: "install", stuck: false });
    expect(doneSteps(first)).toEqual(["pages"]);
    expect(first.start!.pages).toEqual([{ pageLabel: "mia-1", platform: "fansly", modelName: "Mia" }]);

    // The extension signs in: a device token of the person.
    const device = await server!.inject({
      method: "POST", url: "/api/v1/auth/device-tokens/password",
      payload: { username: "newbie", password: NEWBIE_PASSWORD, label: "Firefox · Windows · ChatGoose", mode: "active" },
    });
    expect(device.statusCode, device.body).toBe(200);
    const signedIn = await start("newbie");
    expect(doneSteps(signedIn)).toEqual(["install", "extension", "pages"]);
    expect(signedIn.start!.extension).toMatchObject({ label: "Firefox · Windows · ChatGoose", active: true });
    expect(signedIn.start!.current).toBe("activity");

    // The first active minute on the page.
    const minute = new Date(Math.floor(Date.now() / 60_000) * 60_000);
    await testDb.pool.query(
      "insert into chatter_activity_minutes (user_id, page_id, minute, input) values ($1, $2, $3, true)",
      [await fixtureUserId(app, "newbie"), pageId, minute],
    );
    const worked = await start("newbie");
    expect(worked.start!.firstActivity).toEqual({ at: minute.toISOString(), pageLabel: "mia-1" });
    expect(worked.start!.current).toBe("payout");

    // Where to pay, in the person's words: the last step; with it the way is done.
    const set = await asSession("newbie", "PUT", "/api/v1/account/payout-details", { text: `  ${PAYOUT}  ` });
    expect(set.statusCode, set.body).toBe(200);
    expect(set.json().payoutDetails.text).toBe(PAYOUT);
    const all = await start("newbie");
    expect(all.start).toMatchObject({ done: 5, current: null, since: null, stuck: false });
    expect(all.payoutDetails?.text).toBe(PAYOUT);

    // Someone who works already is no newcomer, and their own read has nobody else's payout.
    const old = await start("old");
    expect(old.person?.code).toBe("old");
    expect(old.start?.newcomer).toBe(false);
    expect(old.payoutDetails).toBeNull();
  });

  it("gives where a person is paid to the person and the owner only", async (context) => {
    if (!testDb) return context.skip();
    const own = await start("newbie");
    expect(own.payoutDetails?.text).toBe(PAYOUT);
    const card = adminPersonResponseSchema.parse((await asSession("boss", "GET", "/api/v1/admin/people/newbie")).json());
    expect(card.payoutDetails?.text).toBe(PAYOUT);
    expect(card.start?.done).toBe(5);

    // A team lead: no card, and the team's list has none of it.
    expect((await asSession("lead", "GET", "/api/v1/admin/people/newbie")).statusCode).toBe(403);
    const list = await asSession("lead", "GET", "/api/v1/team/people");
    expect(list.statusCode, list.body).toBe(200);
    expect(list.body).not.toContain(PAYOUT);
    expect(list.body).not.toContain("payoutDetails");
    // Another chatter: their own read only, and no card.
    expect((await asSession("old", "GET", "/api/v1/account/start")).body).not.toContain(PAYOUT);
    expect((await asSession("old", "GET", "/api/v1/admin/people/newbie")).statusCode).toBe(403);
    // An agent key, even with read:pay_terms: the feed never carries it, and no person route answers it.
    const feed = await server!.inject({ method: "GET", url: "/api/v1/agent/people", headers: { authorization: `Bearer ${KEY}` } });
    expect(feed.statusCode, feed.body).toBe(200);
    expect(feed.body).not.toContain(PAYOUT);
    for (const url of ["/api/v1/account/start", "/api/v1/admin/people/newbie"]) {
      const answer = await server!.inject({ method: "GET", url, headers: { authorization: `Bearer ${KEY}` } });
      expect(answer.statusCode).toBeGreaterThanOrEqual(401);
      expect(answer.body).not.toContain(PAYOUT);
    }
    // The person's own device token (the extension) is not a session: it neither reads nor writes it.
    const device = await server!.inject({
      method: "POST", url: "/api/v1/auth/device-tokens/password",
      payload: { username: "newbie", password: NEWBIE_PASSWORD, label: "Firefox · macOS · ChatGoose", mode: "active" },
    });
    const bearer = { authorization: `Bearer ${device.json().token as string}` };
    const read = await server!.inject({ method: "GET", url: "/api/v1/account/start", headers: bearer });
    expect(read.statusCode).toBe(403);
    expect(read.body).not.toContain(PAYOUT);
    expect((await server!.inject({ method: "PUT", url: "/api/v1/account/payout-details", headers: bearer, payload: { text: "x" } })).statusCode).toBe(403);
    // The audit says it changed, never what it says.
    const audit = await testDb.pool.query("select metadata::text as metadata from audit_events where event_type = 'person.payout_details_set'");
    expect(audit.rows.length).toBeGreaterThan(0);
    for (const row of audit.rows) expect(String(row.metadata)).not.toContain("55501");
  });

  it("opens the owner's matters by itself and closes them when the cause goes", async (context) => {
    if (!testDb) return context.skip();
    await invite("bare", []);
    const keys = async () => (await listOpenMattersOfKinds(app.db, ["person.no_pages", "person.onboarding_stuck"])).map((matter) => matter.key).sort();

    await runPeopleStartTick(app);
    expect(await keys()).toEqual(["person.no_pages:bare"]);
    // Two days on: the invitation never opened is the owner's matter too; the newcomer whose way is done is nobody's.
    await runPeopleStartTick(app, new Date(Date.now() + 49 * HOUR));
    expect(await keys()).toEqual(["person.no_pages:bare", "person.onboarding_stuck:bare"]);

    // The page opened: the first matter closes by itself.
    await testDb.pool.query(
      "insert into user_page_assignments (user_id, platform_account_id) values ($1, $2)",
      [await fixtureUserId(app, "bare"), pageId],
    );
    await runPeopleStartTick(app, new Date(Date.now() + 49 * HOUR));
    expect(await keys()).toEqual(["person.onboarding_stuck:bare"]);
    // The person working now (the owner's word): nothing of the way is a matter any more.
    const working = await asSession("boss", "PATCH", "/api/v1/admin/people/bare", { state: "working" });
    expect(working.statusCode, working.body).toBe(200);
    await runPeopleStartTick(app, new Date(Date.now() + 49 * HOUR));
    expect(await keys()).toEqual([]);
  });
});
