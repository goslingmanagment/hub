import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createFanslyPage, createModel, insertAgentKey } from "@agency_hub_core/db";
import { routeSchemas } from "@agency_hub_core/contracts";
import { sha256Hex } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createInvite, redeemAccountLink } from "../apps/runtime/src/services/account-links.ts";
import { AGENT_KEY_TOKEN_PREFIX, SESSION_COOKIE_NAME, createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { PERSON_DOOR_OPERATIONS } from "../apps/runtime/src/services/person-door.ts";
import { seedSandbox } from "../apps/runtime/src/services/sandbox/seed.ts";
import { recordCustomOrder } from "../apps/runtime/src/services/custom-orders/index.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// ContentOps acts in Hub as the signed-in person (products plan §2.4, package C2): its key (`signin:contentops`) and
// the person's grant. Every operation of the door (PERSON_DOOR_OPERATIONS, the one table) is called as the owner, the
// content manager of model A, of model B, a team lead, a chatter, nobody (a grant that is not), and the test content
// manager: a content manager reads and changes her own model's pages alone (the other's are not there), the owner's
// standing operations stay his, a team lead and a chatter get nothing, the test content manager never a live page and a
// live one never a test page. Every answer a content manager gets is searched for the other model's pages. A change is
// recorded as the person's, never as ContentOps' key.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

const HUB = "http://hub.test";
const TEAM = "http://team.test";
const CALLBACK = "http://co.test/auth/hub/callback";
const KEY = `${AGENT_KEY_TOKEN_PREFIX}contentops-person-door-tests`;
const NARROW_KEY = `${AGENT_KEY_TOKEN_PREFIX}contentops-door-no-signin`;
const DAY_MS = 86_400_000;
const HASH = "a".repeat(64);
const SANDBOX_PASSWORDS = {
  SANDBOX_PASSWORD_T_OWNER: "sandbox-owner-1",
  SANDBOX_PASSWORD_T_LEAD: "sandbox-lead-1",
  SANDBOX_PASSWORD_T_CHAT_1: "sandbox-chat-1",
  SANDBOX_PASSWORD_T_CHAT_2: "sandbox-chat-2",
  SANDBOX_PASSWORD_T_KM: "sandbox-km-1",
};

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
const pages: Record<string, number> = {};
const grants: Record<string, string> = {};
const userIds: Record<string, number> = {};
const drafts: Record<"A" | "B", Array<{ id: number; version: number }>> = { A: [], B: [] };
let ownerSession = "";
/** «Съёмка»: an order «Проверен» on each model's page (A, B, the test page T, and Ivy, whose customs lead shoots too). */
const orders: Record<"A" | "A2" | "B" | "T" | "I", string> = { A: "", A2: "", B: "", T: "", I: "" };

type Injected = Awaited<ReturnType<Awaited<ReturnType<typeof buildApiServer>>["inject"]>>;

function inject(method: "GET" | "POST", url: string, options: { session?: string; bearer?: string; payload?: object; host?: string } = {}): Promise<Injected> {
  return server!.inject({
    method,
    url,
    headers: {
      host: new URL(options.host ?? HUB).host,
      origin: options.host ?? HUB,
      ...(options.session ? { cookie: `${SESSION_COOKIE_NAME}=${options.session}` } : {}),
      ...(options.bearer ? { authorization: `Bearer ${options.bearer}` } : {}),
    },
    ...(options.payload ? { payload: options.payload } : {}),
  });
}

async function signIn(username: string, password: string): Promise<string> {
  const response = await inject("POST", "/api/v1/auth/login", { payload: { username, password } });
  expect(response.statusCode, response.body).toBe(200);
  return response.cookies.find((cookie) => cookie.name === SESSION_COOKIE_NAME)!.value;
}

/** The person's grant, as ContentOps gets it: the hand-off's code, redeemed with ContentOps' key. Null: Hub hands nobody. */
async function grantOf(session: string): Promise<string | null> {
  const minted = await inject("GET", `/api/v1/auth/sso?${new URLSearchParams({ to: "contentops", state: "client-state-0123456789", next: "/" })}`, { session });
  const location = String(minted.headers.location ?? "");
  const code = location ? new URL(location).searchParams.get("code") : null;
  if (minted.statusCode !== 302 || code === null) return null;
  const redeemed = await inject("POST", "/api/v1/auth/sso/redeem", { bearer: KEY, payload: { client: "contentops", code } });
  return redeemed.statusCode === 200 ? redeemed.json<{ grant: string }>().grant : null;
}

async function contentManager(code: string, page: string): Promise<string> {
  const owner = await signIn("boss", "boss-password-for-tests");
  const created = await inject("POST", "/api/v1/admin/people", {
    session: owner,
    payload: {
      code, displayName: code, role: "content_manager", state: "invited", workingPageLabels: [page],
      invite: { username: code, role: "content_manager", pageLabels: [page] },
    },
  });
  expect(created.statusCode, created.body).toBe(200);
  const invite = created.json<{ invite: { userId: number; link: { token: string } } }>().invite;
  userIds[code] = invite.userId;
  const redeemed = await inject("POST", "/api/v1/auth/links/redeem", { host: TEAM, payload: { token: invite.link.token, password: `${code}-strong-password-for-tests` } });
  expect(redeemed.statusCode, redeemed.body).toBe(200);
  return signIn(code, `${code}-strong-password-for-tests`);
}

async function draftOn(page: string, model: "A" | "B", owner: string) {
  const response = await inject("POST", "/api/v1/admin/publications", {
    session: owner,
    payload: { pageLabel: page, kind: "fyp_post", text: `post on ${page}`, media: [{ source: "vault", mediaRef: `${page}-m1` }], publishAt: new Date(Date.now() + 2 * DAY_MS).toISOString() },
  });
  expect(response.statusCode, response.body).toBe(200);
  const created = response.json<{ id: number; version: number }>();
  drafts[model].push({ id: created.id, version: created.version });
}

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
  if (!testDb) return;
  app = createTestAppContext(testDb);
  Object.assign(app.config, { webConsoleOrigin: HUB, webTeamOrigin: TEAM, webSigninClients: { contentops: CALLBACK } });
  await createUserAccount(app, { username: "boss", role: "owner", password: "boss-password-for-tests" }, { source: "cli" });
  userIds.boss = await fixtureUserId(app, "boss");
  const mia = await createModel(app.db, { slug: "mia", name: "Mia" });
  const zoe = await createModel(app.db, { slug: "zoe", name: "Zoe" });
  pages["mia-1"] = (await createFanslyPage(app.db, { modelId: mia!.id, label: "mia-1" }))!.id;
  pages["mia-2"] = (await createFanslyPage(app.db, { modelId: mia!.id, label: "mia-2" }))!.id;
  pages["zoe-1"] = (await createFanslyPage(app.db, { modelId: zoe!.id, label: "zoe-1" }))!.id;
  for (const label of Object.keys(pages)) {
    await testDb.pool.query(
      `insert into creator_raw_media (page_id, platform, media_ref, source_kind, first_origin, first_observed_at,
                                      last_observed_at, content_hash, source_event_id, source_observation_id, source_account_seq)
       values ($1, 'fansly', $2, 'vault_media', 'vault', now(), now(), $3, 1, 1, 1)`,
      [pages[label], `${label}-m1`, HASH],
    );
  }
  for (const [token, name, capabilities] of [[KEY, "contentops-door", ["signin:contentops"]], [NARROW_KEY, "contentops-reader", ["read:content"]]] as const) {
    await insertAgentKey(testDb.db, {
      name, keyPrefix: token.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6), keyDigest: sha256Hex(token),
      capabilities: [...capabilities] as never, pageIds: [], expiresAt: new Date(Date.now() + 30 * DAY_MS), createdBy: userIds.boss,
    });
  }
  await createUserAccount(app, { username: "lead", role: "team_lead", password: "lead-password-for-tests" }, { source: "cli" });
  const invited = await createInvite(app, { username: "chat", pageLabels: ["mia-1", "zoe-1"] }, { source: "cli" });
  await redeemAccountLink(app, { token: invited.link.token, password: "chat-password-for-tests" });
  await seedSandbox(app, { scenarios: ["publications"], env: SANDBOX_PASSWORDS });
  // «Съёмка»: a third model with no content manager, and a chatter who leads customs of Mia and Ivy.
  const ivy = await createModel(app.db, { slug: "ivy", name: "Ivy" });
  pages["ivy-1"] = (await createFanslyPage(app.db, { modelId: ivy!.id, label: "ivy-1" }))!.id;
  const nikInvite = await createInvite(app, { username: "nik", pageLabels: ["mia-1"] }, { source: "cli" });
  await redeemAccountLink(app, { token: nikInvite.link.token, password: "nik-password-for-tests" });
  userIds.nik = await fixtureUserId(app, "nik");
  const nik = (await testDb.pool.query<{ id: string }>(
    "insert into people (code, display_name, role, state) values ('nik', 'Nik', 'chatter', 'working') returning id",
  )).rows[0]!.id;
  await testDb.pool.query("insert into person_logins (user_id, person_id) values ($1, $2)", [userIds.nik, nik]);
  for (const model of [mia!.id, ivy!.id]) {
    await testDb.pool.query("insert into team_roles (person_id, model_id, kind) values ($1, $2, 'customs')", [nik, model]);
  }
  const testPage = (await testDb.pool.query<{ id: string }>("select id from pages where label = 'test-1'")).rows[0]!.id;
  for (const [key, pageId] of [["A", pages["mia-1"]], ["A2", pages["mia-2"]], ["B", pages["zoe-1"]], ["T", Number(testPage)], ["I", pages["ivy-1"]]] as const) {
    const id = await recordCustomOrder(app, {
      pageId: pageId!, fanId: null, buyer: `buyer_${key}`, conversationRef: null, card: { task: `Съёмка ${key}` }, deadlineOn: null,
      acceptedByUserId: null, origin: "workboard", state: "checked", actor: { door: "system" },
    });
    orders[key] = `K-${id}`;
  }
  server = await buildApiServer(app);
  await server.ready();
  const owner = await signIn("boss", "boss-password-for-tests");
  ownerSession = owner;
  const sessions = {
    owner,
    kmA: await contentManager("kira", "mia-1"),
    // Mia's second content manager, on her other page (plan §11 item 13).
    kmA2: await contentManager("mira", "mia-2"),
    kmB: await contentManager("zara", "zoe-1"),
    lead: await signIn("lead", "lead-password-for-tests"),
    chatter: await signIn("chat", "chat-password-for-tests"),
    testKm: await signIn("t-km", "sandbox-km-1"),
    customsLead: await signIn("nik", "nik-password-for-tests"),
  };
  for (const [who, session] of Object.entries(sessions)) {
    const grant = await grantOf(session);
    if (grant !== null) grants[who] = grant;
  }
  for (let index = 0; index < 12; index += 1) {
    await draftOn("mia-1", "A", owner);
    await draftOn("zoe-1", "B", owner);
  }
}, 240_000);

afterAll(async () => {
  await server?.close();
  await testDb?.stop();
});

type Aim = { page: string; model: "A" | "B" | "T"; take: () => { id: number; version: number } };
const COMMENTS = { from: "2026-01-01T00:00:00.000Z", to: "2026-02-01T00:00:00.000Z" };

/** Each operation of the door: its path and body, aimed at a model's own objects. Every row of the table has one. */
const CALLS: Record<keyof typeof PERSON_DOOR_OPERATIONS, (aim: Aim) => { path: string; body: object }> = {
  personPublicationList: (aim) => ({ path: "publications/list", body: { pageLabel: aim.page } }),
  personPublicationGet: (aim) => ({ path: "publications/get", body: { id: aim.take().id } }),
  personPublicationTargets: (aim) => ({ path: "publications/targets", body: { pageLabel: aim.page } }),
  personPublicationApprove: (aim) => ({ path: "publications/approve", body: { items: [aim.take()] } }),
  personPublicationCancel: (aim) => ({ path: "publications/cancel", body: { id: aim.take().id } }),
  personPublicationWithdraw: (aim) => ({ path: "publications/withdraw", body: { id: aim.take().id } }),
  personPublicationReplace: (aim) => ({ path: "publications/replace", body: { id: aim.take().id } }),
  personPublicationResolve: (aim) => ({ path: "publications/resolve", body: { id: aim.take().id, answer: { outcome: "did_not_go_out" } } }),
  personPublicationQueueList: () => ({ path: "publications/queue", body: {} }),
  personPublicationQueueRefresh: (aim) => ({ path: "publications/queue/refresh", body: { pageLabel: aim.page } }),
  personPublicationSettingsList: () => ({ path: "publications/settings", body: {} }),
  personPublicationSwitches: () => ({ path: "publications/switches", body: {} }),
  personPublicationSettingsUpdate: (aim) => ({
    path: "publications/settings/update",
    body: { pageLabel: aim.page, settings: { enabled: false, paidPriceMinMills: null, paidPriceMaxMills: null, repostThresholdDays: 30, dailyLimit: null } },
  }),
  personPublicationDeletePost: (aim) => ({ path: "publications/delete-post", body: { id: aim.take().id } }),
  personPublicationWithdrawPage: (aim) => ({ path: "publications/withdraw-page", body: { pageLabel: aim.page } }),
  personPublicationSwitchSet: () => ({ path: "publications/switches/set", body: { patches: [{ key: "publishingOnlyfansDailyCredits", value: 40 }] } }),
  personFanslyLoginPages: () => ({ path: "fansly/login-pages", body: {} }),
  personCreatorStatsContent: (aim) => ({ path: "stats/content", body: { pageLabel: aim.page, days: 7 } }),
  personCreatorStatsMedia: (aim) => ({ path: "stats/media", body: { pageLabel: aim.page, mediaOfferId: "1", days: 7 } }),
  personContentComments: (aim) => ({ path: "stats/comments", body: { pageLabel: aim.page, ...COMMENTS } }),
  personCustomOrderList: (aim) => ({ path: "custom-orders/list", body: { modelSlug: aim.model === "A" ? "mia" : aim.model === "B" ? "zoe" : "test" } }),
  personCustomOrderStep: (aim) => ({ path: "custom-orders/step", body: { code: orders[aim.model], step: "at_model", deadlineOn: "2030-01-10" } }),
};

function aim(model: "A" | "B" | "T"): Aim {
  const page = model === "A" ? "mia-1" : model === "B" ? "zoe-1" : "test-1";
  const pool = model === "T" ? [{ id: 999_999, version: 1 }] : drafts[model];
  return { page, model, take: () => (pool.length > 1 ? pool.shift()! : pool[0]!) };
}

function call(key: keyof typeof PERSON_DOOR_OPERATIONS, target: Aim, grant: string | undefined, bearer = KEY) {
  const { path, body } = CALLS[key](target);
  return inject("POST", `/api/v1/person/${path}`, { bearer, payload: { client: "contentops", grant: grant ?? "no-such-grant-of-anybody", ...body } });
}

/** Labels and ids of pages that must not show in an answer. */
function leaks(body: string, others: readonly string[]): string[] {
  const found = others.filter((label) => body.includes(`"${label}"`));
  for (const label of others) {
    if (pages[label] !== undefined && new RegExp(`"(pageId|platformAccountId)":${pages[label]}[,}]`).test(body)) found.push(`id of ${label}`);
  }
  return found;
}

const OPERATIONS = Object.keys(PERSON_DOOR_OPERATIONS) as Array<keyof typeof PERSON_DOOR_OPERATIONS>;
/** «Съёмка»'s rows: a chatter's or a team lead's login is served there only while the person leads customs of a model. */
const SHOOTING_ROWS: ReadonlySet<string> = new Set(["personCustomOrderList", "personCustomOrderStep"]);

describe("the person's door", () => {
  it("is the table: every route of the door is a row, every row a route, a call each", () => {
    const routes = Object.entries(routeSchemas as Record<string, { tags?: readonly string[] }>).filter(([, route]) => route.tags?.includes("person-door")).map(([key]) => key).sort();
    expect(routes).toEqual([...OPERATIONS].sort());
    expect(Object.keys(CALLS).sort()).toEqual([...OPERATIONS].sort());
  });

  it("hands a grant to everyone who may sign in to ContentOps", (context) => {
    if (!server) return context.skip();
    for (const who of ["owner", "kmA", "kmB", "testKm", "customsLead"]) expect(grants[who], who).toBeDefined();
  });

  // Every row as every persona, by the row's roles: a persona whose role is on the row gets its own pages and never
  // another model's; one whose role is not gets 403; nobody 401; another key 403.
  const PERSONAS = [
    { who: "kmA", role: "content_manager", own: "A", other: "B", hidden: ["zoe-1", "test-1"] },
    { who: "kmB", role: "content_manager", own: "B", other: "A", hidden: ["mia-1", "mia-2", "test-1"] },
    { who: "lead", role: "team_lead", own: "A", other: "B", hidden: ["test-1"] },
    { who: "chatter", role: "chatter", own: "A", other: "B", hidden: ["test-1"] },
  ] as const;

  it("serves each persona exactly what its row's roles open, on its own pages alone", async (context) => {
    if (!server) return context.skip();
    for (const key of OPERATIONS) {
      const roles: readonly string[] = PERSON_DOOR_OPERATIONS[key].roles;
      for (const persona of PERSONAS) {
        const grant = grants[persona.who];
        const answer = await call(key, aim(persona.own), grant);
        // Hub may not hand someone to ContentOps at all: their call is nobody's.
        if (grant === undefined) {
          expect(answer.statusCode, `${key} as ${persona.who} (no grant)`).toBe(401);
          continue;
        }
        // «Съёмка» serves a chatter only while they lead customs (services/custom-orders/person.ts): this one does not.
        if (!roles.includes(persona.role) || (SHOOTING_ROWS.has(key) && (persona.role === "chatter" || persona.role === "team_lead"))) {
          expect(answer.statusCode, `${key} as ${persona.who}: ${answer.body}`).toBe(403);
          continue;
        }
        expect([401, 403, 404], `${key} as ${persona.who}: ${answer.body}`).not.toContain(answer.statusCode);
        expect(leaks(answer.body, persona.hidden), `${key} as ${persona.who}`).toEqual([]);
        const mine = CALLS[key](aim(persona.own));
        const theirs = CALLS[key](aim(persona.other));
        if (mine.path === theirs.path && JSON.stringify(CALLS[key](aim("A")).body) === JSON.stringify(CALLS[key](aim("B")).body)) continue;
        const refused = await call(key, aim(persona.other), grant);
        expect([403, 404], `${key} as ${persona.who} on the other model: ${refused.body}`).toContain(refused.statusCode);
      }
    }
    for (const [person, others] of [["kmA", ["zoe-1"]], ["kmB", ["mia-1", "mia-2"]]] as const) {
      for (const body of [{}, { modelSlug: "zoe" }, { modelSlug: "mia" }]) {
        const answer = await inject("POST", "/api/v1/person/publications/list", { bearer: KEY, payload: { client: "contentops", grant: grants[person], ...body } });
        expect(answer.statusCode, answer.body).toBe(200);
        expect(leaks(answer.body, others), `${JSON.stringify(body)} as ${person}`).toEqual([]);
      }
    }
  });

  it("gives the owner every row his role is on, and every page", async (context) => {
    if (!server) return context.skip();
    for (const key of OPERATIONS) {
      const roles: readonly string[] = PERSON_DOOR_OPERATIONS[key].roles;
      const answer = await call(key, aim("B"), grants.owner);
      if (roles.includes("owner")) expect([401, 403, 404], `${key} as the owner: ${answer.body}`).not.toContain(answer.statusCode);
      else expect(answer.statusCode, `${key} as the owner`).toBe(403);
    }
    const all = await inject("POST", "/api/v1/person/publications/list", { bearer: KEY, payload: { client: "contentops", grant: grants.owner } });
    expect(all.body).toContain('"mia-1"');
    expect(all.body).toContain('"zoe-1"');
  });

  it("serves nobody without a live grant, and nobody without ContentOps' sign-in key", async (context) => {
    if (!server) return context.skip();
    for (const key of OPERATIONS) {
      expect((await call(key, aim("A"), undefined)).statusCode, `${key} without a grant`).toBe(401);
      expect((await call(key, aim("A"), grants.owner, NARROW_KEY)).statusCode, `${key} with another key`).toBe(403);
    }
  });

  it("keeps the test content manager to the test pages, and a live content manager away from them", async (context) => {
    if (!server) return context.skip();
    const list = await inject("POST", "/api/v1/person/publications/list", { bearer: KEY, payload: { client: "contentops", grant: grants.testKm } });
    expect(list.statusCode, list.body).toBe(200);
    expect(leaks(list.body, ["mia-1", "mia-2", "zoe-1"])).toEqual([]);
    // ContentOps asks for a model by Hub's slug (`test`), never by a page it binds: the pages come from Hub's answer.
    for (const path of ["publications/settings", "publications/list"]) {
      const ofModel = await inject("POST", `/api/v1/person/${path}`, { bearer: KEY, payload: { client: "contentops", grant: grants.testKm, modelSlug: "test" } });
      expect(ofModel.statusCode, ofModel.body).toBe(200);
      expect(ofModel.body, path).toContain('"test-1"');
      expect(leaks(ofModel.body, ["mia-1", "mia-2", "zoe-1"]), path).toEqual([]);
    }
    const otherModel = await inject("POST", "/api/v1/person/publications/settings", { bearer: KEY, payload: { client: "contentops", grant: grants.owner, modelSlug: "zoe" } });
    expect(otherModel.json<{ pages: Array<{ pageLabel: string }> }>().pages.map((page) => page.pageLabel)).toEqual(["zoe-1"]);
    // The test pages' seeded posts are hers to see; a live person's lists never name them.
    expect(list.body).toContain('"test-1"');
    for (const who of ["owner", "kmA", "kmB"]) {
      const live = await inject("POST", "/api/v1/person/publications/list", { bearer: KEY, payload: { client: "contentops", grant: grants[who] } });
      expect(live.body.includes('"test-1"') || live.body.includes('"test-of"'), who).toBe(false);
    }
    expect((await call("personCreatorStatsContent", aim("T"), grants.testKm)).statusCode).toBe(200);
    expect([403, 404]).toContain((await call("personCreatorStatsContent", aim("A"), grants.testKm)).statusCode);
    expect([403, 404]).toContain((await call("personCreatorStatsContent", aim("T"), grants.kmA)).statusCode);
    // A test page's schedule is never read from a platform: Hub says so in words.
    const refresh = await call("personPublicationQueueRefresh", aim("T"), grants.testKm);
    expect(refresh.statusCode, refresh.body).toBe(409);
    expect(refresh.json()).toMatchObject({ message: "тестовая страница: на площадку не отправляется" });
  });

  it("names who drafted and approved a post, and where it goes, without logins or prices", async (context) => {
    if (!server) return context.skip();
    const list = await inject("POST", "/api/v1/person/publications/list", { bearer: KEY, payload: { client: "contentops", grant: grants.testKm, status: "approved" } });
    const [post] = list.json<{ publications: Array<{ id: number; author: { userId: number | null } }> }>().publications;
    expect(post, list.body).toBeDefined();
    const card = await inject("POST", "/api/v1/person/publications/get", { bearer: KEY, payload: { client: "contentops", grant: grants.testKm, id: post!.id } });
    expect(card.statusCode, card.body).toBe(200);
    const { names, revision } = card.json<{ names: { users: Array<{ id: number; name: string }> }; revision: { approvedByUserId: number } }>();
    // The seeded test posts are the test content manager's: her registry name, never her login.
    for (const id of [post!.author.userId!, revision.approvedByUserId]) {
      const named = names.users.find((user) => user.id === id);
      expect(named?.name, card.body).toBeTruthy();
      expect(named!.name).not.toBe("t-km");
    }
    const targets = await inject("POST", "/api/v1/person/publications/targets", { bearer: KEY, payload: { client: "contentops", grant: grants.testKm, pageLabel: "test-1" } });
    expect(targets.statusCode, targets.body).toBe(200);
    expect(targets.json()).toMatchObject({ pageLabel: "test-1", platform: "fansly", walls: [{ wallRef: "sandbox-wall", name: "Posts", defaultWall: true }] });
    expect(targets.body).not.toMatch(/price/i);
    // Another person's page is not there for her.
    const foreign = await inject("POST", "/api/v1/person/publications/targets", { bearer: KEY, payload: { client: "contentops", grant: grants.testKm, pageLabel: "mia-1" } });
    expect(foreign.statusCode).toBe(404);
  });

  it("takes «Вышел» on an unknown outcome with the post's number and where it is, and refuses it without them", async (context) => {
    if (!server) return context.skip();
    const list = await inject("POST", "/api/v1/person/publications/list", { bearer: KEY, payload: { client: "contentops", grant: grants.testKm, status: "unknown" } });
    const [post] = list.json<{ publications: Array<{ id: number; pageLabel: string }> }>().publications;
    expect(post?.pageLabel, list.body).toBe("test-1");
    const resolve = (answer: Record<string, unknown>) =>
      inject("POST", "/api/v1/person/publications/resolve", { bearer: KEY, payload: { client: "contentops", grant: grants.testKm, id: post!.id, answer } });
    // What ContentOps' card sent before its form came back: refused, nothing changed.
    const bare = await resolve({ outcome: "went_out" });
    expect(bare.statusCode, bare.body).toBe(400);
    const answered = await resolve({ outcome: "went_out", state: "scheduled", platformPostRef: "851203394123456789" });
    expect(answered.statusCode, answered.body).toBe(200);
    expect(answered.json()).toMatchObject({ publication: { id: post!.id, status: "scheduled", platformPostRef: "851203394123456789" }, replacement: null });
  });

  it("keeps two content managers of one model each to her own page (plan §11 item 13)", async (context) => {
    if (!server) return context.skip();
    // Mia's posts: kira works on mia-1, mira on mia-2.
    const created = await inject("POST", "/api/v1/admin/publications", {
      session: ownerSession,
      payload: { pageLabel: "mia-2", kind: "fyp_post", text: "post on mia-2", media: [{ source: "vault", mediaRef: "mia-2-m1" }], publishAt: new Date(Date.now() + 2 * DAY_MS).toISOString() },
    });
    expect(created.statusCode, created.body).toBe(200);
    const onMia2 = created.json<{ id: number; version: number }>();
    const onMia1 = drafts.A[drafts.A.length - 1]!;
    const door = (who: string, path: string, body: object) =>
      inject("POST", `/api/v1/person/${path}`, { bearer: KEY, payload: { client: "contentops", grant: grants[who], ...body } });
    for (const [who, mine, theirs, theirPage, myPost, theirPost] of [
      ["kmA", "mia-1", "mia-2", "mia-2", onMia1, onMia2],
      ["kmA2", "mia-2", "mia-1", "mia-1", onMia2, onMia1],
    ] as const) {
      const list = await door(who, "publications/list", { modelSlug: "mia" });
      expect(list.statusCode, list.body).toBe(200);
      expect(list.body, who).toContain(`"${mine}"`);
      expect(leaks(list.body, [theirs]), who).toEqual([]);
      const settings = await door(who, "publications/settings", { modelSlug: "mia" });
      expect(settings.json<{ pages: Array<{ pageLabel: string }> }>().pages.map((page) => page.pageLabel), who).toEqual([mine]);
      expect((await door(who, "publications/get", { id: myPost.id })).statusCode, who).toBe(200);
      for (const [path, body] of [
        ["publications/get", { id: theirPost.id }],
        ["publications/approve", { items: [{ id: theirPost.id, version: theirPost.version }] }],
        ["publications/cancel", { id: theirPost.id }],
        ["publications/withdraw", { id: theirPost.id }],
        ["publications/targets", { pageLabel: theirPage }],
        ["stats/content", { pageLabel: theirPage, days: 7 }],
      ] as const) {
        const answer = await door(who, path, body);
        // Not hers: as one that is not there (an approve answers per post, refused).
        if (path === "publications/approve") {
          expect(answer.statusCode === 404 || answer.json<{ results: Array<{ outcome: string }> }>().results[0]?.outcome === "refused", `${who} ${path}: ${answer.body}`).toBe(true);
        } else {
          expect([403, 404], `${who} ${path}: ${answer.body}`).toContain(answer.statusCode);
        }
      }
    }
    // «Съёмка» keeps its own rule: a page of her model no content manager works on is still hers to shoot.
  });

  it("carries Hub's words of the codes: reasons, checks, refusals, a page's stop", async (context) => {
    if (!server) return context.skip();
    const door = (path: string, body: object) =>
      inject("POST", `/api/v1/person/${path}`, { bearer: KEY, payload: { client: "contentops", grant: grants.testKm, ...body } });
    const list = await door("publications/list", {});
    expect(list.statusCode, list.body).toBe(200);
    const publications = list.json<{ publications: Array<{ id: number; status: string; statusReason: string | null; findings: unknown[]; words: { statusReason: string | null; findings: string[] } }> }>().publications;
    expect(publications.length).toBeGreaterThan(0);
    for (const one of publications) {
      expect(one.words.findings).toHaveLength(one.findings.length);
      if (one.statusReason !== null) expect(one.words.statusReason, one.statusReason).toMatch(/[а-яё]/i);
    }
    // The draft with a file the vault does not hold: its check in words.
    const flagged = publications.find((one) => one.findings.length > 0)!;
    expect(flagged.words.findings.join(" "), JSON.stringify(flagged.findings)).toMatch(/нет среди файлов этой страницы/);
    const card = await door("publications/get", { id: flagged.id });
    const detail = card.json<{ events: unknown[]; words: { events: Array<string | null>; album: unknown } }>();
    expect(detail.words.events).toHaveLength(detail.events.length);
    expect(detail.words.album).toBeNull();
    // A test page's post is never sent anywhere: the refusal in words.
    const scheduled = publications.find((one) => one.status === "approved")!;
    const withdrawn = await door("publications/withdraw", { id: scheduled.id });
    expect(withdrawn.statusCode, withdrawn.body).toBe(200);
    expect(withdrawn.json<{ results: Array<{ words: string }> }>().results[0]?.words).toMatch(/^Не убран: тестовая страница/);
    const settings = await door("publications/settings", { modelSlug: "test" });
    expect(settings.json<{ pages: Array<{ autostopReasonWords: string | null }> }>().pages.every((page) => "autostopReasonWords" in page)).toBe(true);
  });

  it("records a change as the person's, never as ContentOps' key", async (context) => {
    if (!server) return context.skip();
    await draftOn("mia-1", "A", ownerSession);
    const target = drafts.A.at(-1)!;
    const cancelled = await inject("POST", "/api/v1/person/publications/cancel", { bearer: KEY, payload: { client: "contentops", grant: grants.kmA, id: target.id } });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    const events = await testDb!.pool.query<{ actor_kind: string; actor_user_id: string | null; actor_agent_key_id: string | null }>(
      "select actor_kind, actor_user_id::text, actor_agent_key_id::text from publication_status_events where publication_id = $1 order by id desc limit 1",
      [target.id],
    );
    expect(events.rows[0]).toEqual({ actor_kind: "human", actor_user_id: String(userIds.kira), actor_agent_key_id: null });
  });
  it("«Съёмка»: each person reads the orders of their own shooting and moves the ones whose step they lead", async (context) => {
    if (!server) return context.skip();
    const list = async (who: string) => {
      const answer = await inject("POST", "/api/v1/person/custom-orders/list", { bearer: KEY, payload: { client: "contentops", grant: grants[who] } });
      expect(answer.statusCode, `${who}: ${answer.body}`).toBe(200);
      return answer.json<{ orders: Array<{ code: string }> }>().orders.map((one) => one.code).sort();
    };
    const step = (who: string, code: string, extra: object = {}) =>
      inject("POST", "/api/v1/person/custom-orders/step", { bearer: KEY, payload: { client: "contentops", grant: grants[who], code, step: "partly", note: "пришло видео", ...extra } });
    // The owner: every live order, never a test one; a content manager: her model's; the customs lead: his models'.
    expect(await list("owner")).toEqual([orders.A, orders.A2, orders.B, orders.I].sort());
    // Two content managers of one model: each reads the orders of her own page only.
    expect(await list("kmA")).toEqual([orders.A]);
    expect(await list("kmA2")).toEqual([orders.A2]);
    expect(await list("kmB")).toEqual([orders.B]);
    expect(await list("customsLead")).toEqual([orders.A, orders.A2, orders.I].sort());
    // The test content manager: the test order alone; a live one never sees it.
    expect(await list("testKm")).toEqual([orders.T]);
    expect((await step("testKm", orders.A)).statusCode).toBe(404);
    expect((await step("kmA", orders.T)).statusCode).toBe(404);
    // Ivy has no content manager: its customs lead takes the shooting's steps; Mia's are her content manager's.
    const handed = await inject("POST", "/api/v1/person/custom-orders/step", {
      bearer: KEY, payload: { client: "contentops", grant: grants.customsLead, code: orders.I, step: "at_model", deadlineOn: "2030-01-12" },
    });
    expect(handed.statusCode, handed.body).toBe(200);
    expect(handed.json<{ order: { state: string; deadlineOn: string } }>().order).toMatchObject({ state: "at_model", deadlineOn: "2030-01-12" });
    const notHis = await step("customsLead", orders.A);
    expect(notHis.statusCode, notHis.body).toBe(409);
    expect(notHis.json<{ reason: string }>().reason).toBe("not_allowed");
    // The history names the person and the door, never ContentOps' key.
    const events = await testDb!.pool.query<{ event: string; door: string; actor_user_id: string | null; actor_agent_key_id: string | null }>(
      "select event, door, actor_user_id::text, actor_agent_key_id::text from object_events where object_type = 'custom_order' and object_id = $1 order by id",
      [orders.I.slice(2)],
    );
    expect(events.rows.slice(-2)).toEqual([
      { event: "custom_order.deadline", door: "contentops", actor_user_id: String(userIds.nik), actor_agent_key_id: null },
      { event: "custom_order.at_model", door: "contentops", actor_user_id: String(userIds.nik), actor_agent_key_id: null },
    ]);
  });
  it("«Съёмка» goes by the order's page: Mia's second content manager moves her page's order and not the other's", async (context) => {
    if (!server) return context.skip();
    const step = (who: string, code: string) =>
      inject("POST", "/api/v1/person/custom-orders/step", { bearer: KEY, payload: { client: "contentops", grant: grants[who], code, step: "at_model" } });
    const mine = await step("kmA2", orders.A2);
    expect(mine.statusCode, mine.body).toBe(200);
    expect(mine.json<{ order: { state: string; leader: { name: string | null } } }>().order).toMatchObject({ state: "at_model", leader: { name: "mira" } });
    // Kira's page is not hers to shoot, nor hers Kira's: outside their shooting, the order is not there.
    expect([404, 409]).toContain((await step("kmA2", orders.A)).statusCode);
    expect([404, 409]).toContain((await step("kmA", orders.A2)).statusCode);
  });
  it("«Съёмка» lets in a team lead who leads customs: he lists the orders and moves one; a team lead without the record is refused", async (context) => {
    if (!server || !testDb) return context.skip();
    await createUserAccount(app, { username: "tl-customs", role: "team_lead", password: "tl-customs-password-for-tests" }, { source: "cli" });
    const tlUser = await fixtureUserId(app, "tl-customs");
    const tl = (await testDb.pool.query<{ id: string }>(
      "insert into people (code, display_name, role, state) values ('tl-customs', 'Tl', 'team_lead', 'working') returning id",
    )).rows[0]!.id;
    await testDb.pool.query("insert into person_logins (user_id, person_id) values ($1, $2)", [tlUser, tl]);
    // A model of his alone: no content manager, he the only one who leads its customs.
    const una = await createModel(app.db, { slug: "una", name: "Una" });
    pages["una-1"] = (await createFanslyPage(app.db, { modelId: una!.id, label: "una-1" }))!.id;
    await testDb.pool.query("insert into team_roles (person_id, model_id, kind) values ($1, $2, 'customs')", [tl, una!.id]);
    const id = await recordCustomOrder(app, {
      pageId: pages["una-1"]!, fanId: null, buyer: "buyer_tl", conversationRef: null, card: { task: "Съёмка тимлида" }, deadlineOn: null,
      acceptedByUserId: null, origin: "workboard", state: "checked", actor: { door: "system" },
    });
    const grant = await grantOf(await signIn("tl-customs", "tl-customs-password-for-tests"));
    expect(grant).not.toBeNull();
    const listed = await inject("POST", "/api/v1/person/custom-orders/list", { bearer: KEY, payload: { client: "contentops", grant } });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json<{ orders: Array<{ code: string }> }>().orders.map((one) => one.code)).toContain(`K-${id}`);
    // Una has no content manager: its customs lead — this team lead — leads the shooting.
    const step = await inject("POST", "/api/v1/person/custom-orders/step", {
      bearer: KEY, payload: { client: "contentops", grant, code: `K-${id}`, step: "at_model", deadlineOn: "2030-01-14" },
    });
    expect(step.statusCode, step.body).toBe(200);
    // The team lead with no customs record: refused, as the rule says.
    const plain = await inject("POST", "/api/v1/person/custom-orders/list", { bearer: KEY, payload: { client: "contentops", grant: grants.lead ?? "none" } });
    expect([401, 403]).toContain(plain.statusCode);
  });
});
