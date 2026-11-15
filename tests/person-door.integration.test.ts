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
  await seedSandbox(app, { scenarios: [], env: SANDBOX_PASSWORDS });
  server = await buildApiServer(app);
  await server.ready();
  const owner = await signIn("boss", "boss-password-for-tests");
  ownerSession = owner;
  const sessions = {
    owner,
    kmA: await contentManager("kira", "mia-1"),
    kmB: await contentManager("zara", "zoe-1"),
    lead: await signIn("lead", "lead-password-for-tests"),
    chatter: await signIn("chat", "chat-password-for-tests"),
    testKm: await signIn("t-km", "sandbox-km-1"),
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

describe("the person's door", () => {
  it("is the table: every route of the door is a row, every row a route, a call each", () => {
    const routes = Object.entries(routeSchemas as Record<string, { tags?: readonly string[] }>).filter(([, route]) => route.tags?.includes("person-door")).map(([key]) => key).sort();
    expect(routes).toEqual([...OPERATIONS].sort());
    expect(Object.keys(CALLS).sort()).toEqual([...OPERATIONS].sort());
  });

  it("hands a grant to everyone who may sign in to ContentOps", (context) => {
    if (!server) return context.skip();
    for (const who of ["owner", "kmA", "kmB", "testKm"]) expect(grants[who], who).toBeDefined();
  });

  it("opens to a content manager her own model's pages alone, and never shows the other model's", async (context) => {
    if (!server) return context.skip();
    for (const key of OPERATIONS) {
      const row = PERSON_DOOR_OPERATIONS[key];
      for (const [person, own, other, others] of [["kmA", "A", "B", ["zoe-1", "test-1"]], ["kmB", "B", "A", ["mia-1", "mia-2", "test-1"]]] as const) {
        const answer = await call(key, aim(own), grants[person]);
        if (row.who === "owner") {
          expect(answer.statusCode, `${key} as ${person}`).toBe(403);
          continue;
        }
        expect([401, 403, 404], `${key} as ${person}: ${answer.body}`).not.toContain(answer.statusCode);
        expect(leaks(answer.body, others), `${key} as ${person}`).toEqual([]);
        const refused = await call(key, aim(other), grants[person]);
        if (CALLS[key](aim(own)).path === CALLS[key](aim(other)).path && JSON.stringify(CALLS[key](aim("A")).body) === JSON.stringify(CALLS[key](aim("B")).body)) continue;
        expect([403, 404], `${key} as ${person} on the other model: ${refused.body}`).toContain(refused.statusCode);
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

  it("gives the owner every operation and every page", async (context) => {
    if (!server) return context.skip();
    for (const key of OPERATIONS) {
      const answer = await call(key, aim("B"), grants.owner);
      expect([401, 403, 404], `${key} as the owner: ${answer.body}`).not.toContain(answer.statusCode);
    }
    const all = await inject("POST", "/api/v1/person/publications/list", { bearer: KEY, payload: { client: "contentops", grant: grants.owner } });
    expect(all.body).toContain('"mia-1"');
    expect(all.body).toContain('"zoe-1"');
  });

  it("gives a team lead and a chatter nothing, nobody nothing, and nothing without ContentOps' sign-in key", async (context) => {
    if (!server) return context.skip();
    for (const key of OPERATIONS) {
      for (const person of ["lead", "chatter"] as const) {
        // Hub may not hand them to ContentOps at all: then their call is nobody's.
        const answer = await call(key, aim("A"), grants[person]);
        expect([401, 403], `${key} as ${person}: ${answer.body}`).toContain(answer.statusCode);
        if (grants[person] !== undefined) expect(answer.statusCode, `${key} as ${person}`).toBe(403);
      }
      expect((await call(key, aim("A"), undefined)).statusCode, `${key} without a grant`).toBe(401);
      expect((await call(key, aim("A"), grants.owner, NARROW_KEY)).statusCode, `${key} with another key`).toBe(403);
    }
  });

  it("keeps the test content manager to the test pages, and a live content manager away from them", async (context) => {
    if (!server) return context.skip();
    const list = await inject("POST", "/api/v1/person/publications/list", { bearer: KEY, payload: { client: "contentops", grant: grants.testKm } });
    expect(list.statusCode, list.body).toBe(200);
    expect(leaks(list.body, ["mia-1", "mia-2", "zoe-1"])).toEqual([]);
    expect((await call("personCreatorStatsContent", aim("T"), grants.testKm)).statusCode).toBe(200);
    expect([403, 404]).toContain((await call("personCreatorStatsContent", aim("A"), grants.testKm)).statusCode);
    expect([403, 404]).toContain((await call("personCreatorStatsContent", aim("T"), grants.kmA)).statusCode);
    expect([403, 404]).toContain((await call("personPublicationQueueRefresh", aim("T"), grants.testKm)).statusCode);
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
});
