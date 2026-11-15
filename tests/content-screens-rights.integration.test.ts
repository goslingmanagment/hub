import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createFanslyPage, createModel } from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createInvite, redeemAccountLink } from "../apps/runtime/src/services/account-links.ts";
import { SESSION_COOKIE_NAME, createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { CONTENT_SCREEN_OPERATIONS } from "../apps/runtime/src/services/content-manager-operations.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

// «Публикации» and «Статистика» inside ContentOps (products plan §2.4, package C2): Hub draws them, the person acts with
// their own session. Every operation of the two screens (CONTENT_SCREEN_OPERATIONS, the one table) is called as the
// owner, the content manager of model A, the content manager of model B, a team lead and a chatter: a content manager
// reads and changes their own model's pages alone (the other's are not there: 404, or 403 by the page's grant), the
// owner's standing operations stay his, a team lead and a chatter get nothing. Every answer a content manager gets is
// searched for the other model's page ids and labels. The frame headers of the two pages are walked beside three others.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

const HUB = "http://hub.test";
const TEAM = "http://team.test";
const CONTENTOPS = "http://co.test";
const DAY_MS = 86_400_000;
const HASH = "a".repeat(64);

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
const pages: Record<string, number> = {};
const sessions: Record<string, string> = {};
/** Drafts by model: each mutating call takes its own, so the walk's order decides nothing. */
const drafts: Record<"A" | "B", Array<{ id: number; version: number }>> = { A: [], B: [] };

type Injected = Awaited<ReturnType<Awaited<ReturnType<typeof buildApiServer>>["inject"]>>;

function call(method: string, url: string, session?: string, payload?: object): Promise<Injected> {
  return server!.inject({
    method: method as "GET",
    url,
    headers: { host: new URL(HUB).host, origin: HUB, ...(session ? { cookie: `${SESSION_COOKIE_NAME}=${session}` } : {}) },
    ...(payload ? { payload } : {}),
  });
}

function sessionOf(response: Injected): string {
  return response.cookies.find((cookie) => cookie.name === SESSION_COOKIE_NAME)!.value;
}

async function signIn(username: string, password: string): Promise<string> {
  const response = await call("POST", "/api/v1/auth/login", undefined, { username, password });
  expect(response.statusCode, response.body).toBe(200);
  return sessionOf(response);
}

/** A content manager invited by role on one working page; the link sets the password. */
async function contentManager(code: string, page: string): Promise<string> {
  const created = await call("POST", "/api/v1/admin/people", sessions.owner, {
    code, displayName: code, role: "content_manager", state: "invited", workingPageLabels: [page],
    invite: { username: code, role: "content_manager", pageLabels: [page] },
  });
  expect(created.statusCode, created.body).toBe(200);
  const token = created.json<{ invite: { link: { token: string } } }>().invite.link.token;
  const redeemed = await server!.inject({
    method: "POST", url: "/api/v1/auth/links/redeem", headers: { host: new URL(TEAM).host, origin: TEAM },
    payload: { token, password: `${code}-strong-password-for-tests` },
  });
  expect(redeemed.statusCode, redeemed.body).toBe(200);
  return signIn(code, `${code}-strong-password-for-tests`);
}

async function draftOn(page: string, model: "A" | "B") {
  const response = await call("POST", "/api/v1/admin/publications", sessions.owner, {
    pageLabel: page, kind: "fyp_post", text: `post on ${page}`, media: [{ source: "vault", mediaRef: `${page}-m1` }],
    publishAt: new Date(Date.now() + 2 * DAY_MS).toISOString(),
  });
  expect(response.statusCode, response.body).toBe(200);
  const created = response.json<{ id: number; version: number }>();
  drafts[model].push({ id: created.id, version: created.version });
}

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
  if (!testDb) return;
  app = createTestAppContext(testDb);
  Object.assign(app.config, { webConsoleOrigin: HUB, webTeamOrigin: TEAM, webSigninClients: { contentops: `${CONTENTOPS}/auth/hub/callback` } });
  await createUserAccount(app, { username: "boss", role: "owner", password: "boss-password-for-tests" }, { source: "cli" });
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
  await createUserAccount(app, { username: "lead", role: "team_lead", password: "lead-password-for-tests" }, { source: "cli" });
  const invited = await createInvite(app, { username: "chat", pageLabels: ["mia-1", "zoe-1"] }, { source: "cli" });
  await redeemAccountLink(app, { token: invited.link.token, password: "chat-password-for-tests" });
  server = await buildApiServer(app);
  await server.ready();
  sessions.owner = await signIn("boss", "boss-password-for-tests");
  sessions.lead = await signIn("lead", "lead-password-for-tests");
  sessions.chatter = await signIn("chat", "chat-password-for-tests");
  sessions.kmA = await contentManager("kira", "mia-1");
  sessions.kmB = await contentManager("zara", "zoe-1");
  for (let index = 0; index < 12; index += 1) {
    await draftOn("mia-1", "A");
    await draftOn("zoe-1", "B");
  }
}, 180_000);

afterAll(async () => {
  await server?.close();
  await testDb?.stop();
});

/** One call of an operation, aimed at a model's own objects; `take` hands out that model's next draft. */
type Aim = { page: string; model: "A" | "B"; take: () => { id: number; version: number } };
const STATS = "days=7";
const COMMENTS = `from=${encodeURIComponent("2026-01-01T00:00:00.000Z")}&to=${encodeURIComponent("2026-02-01T00:00:00.000Z")}`;

/** How each operation of the two screens is called. Every row of the table has one (the first test says so). */
const CALLS: Record<string, (aim: Aim) => { method: string; url: string; payload?: object }> = {
  adminPublicationList: (aim) => ({ method: "GET", url: `/api/v1/admin/publications?pageLabel=${aim.page}` }),
  adminPublicationGet: (aim) => ({ method: "GET", url: `/api/v1/admin/publications/${aim.take().id}` }),
  adminPublicationApprove: (aim) => ({ method: "POST", url: "/api/v1/admin/publications/approve", payload: { items: [aim.take()] } }),
  adminPublicationCancel: (aim) => ({ method: "POST", url: `/api/v1/admin/publications/${aim.take().id}/cancel` }),
  adminPublicationWithdraw: (aim) => ({ method: "POST", url: `/api/v1/admin/publications/${aim.take().id}/withdraw` }),
  adminPublicationReplace: (aim) => ({ method: "POST", url: `/api/v1/admin/publications/${aim.take().id}/replace` }),
  adminPublicationResolve: (aim) => ({ method: "POST", url: `/api/v1/admin/publications/${aim.take().id}/resolve`, payload: { outcome: "did_not_go_out" } }),
  adminPublicationQueueList: () => ({ method: "GET", url: "/api/v1/admin/publications/queue" }),
  adminPublicationQueueRefresh: (aim) => ({ method: "POST", url: "/api/v1/admin/publications/queue/refresh", payload: { pageLabel: aim.page } }),
  adminPublicationSettingsList: () => ({ method: "GET", url: "/api/v1/admin/publications/settings" }),
  adminPublicationDeletePost: (aim) => ({ method: "POST", url: `/api/v1/admin/publications/${aim.take().id}/delete-post` }),
  adminPublicationWithdrawPage: (aim) => ({ method: "POST", url: "/api/v1/admin/publications/withdraw-page", payload: { pageLabel: aim.page } }),
  adminPublicationSettingsUpdate: (aim) => ({
    method: "PUT", url: `/api/v1/admin/publications/settings/${aim.page}`,
    payload: { enabled: false, paidPriceMinMills: null, paidPriceMaxMills: null, repostThresholdDays: 30, dailyLimit: null },
  }),
  adminConfig: () => ({ method: "GET", url: "/api/v1/admin/config" }),
  adminConfigUpdate: () => ({ method: "PATCH", url: "/api/v1/admin/config", payload: { changes: [] } }),
  adminConfigClear: () => ({ method: "DELETE", url: "/api/v1/admin/config/publishingEnabled" }),
  syncOverview: () => ({ method: "GET", url: "/api/v1/sync/overview" }),
  syncPages: () => ({ method: "GET", url: "/api/v1/sync/pages" }),
  creatorStatsContent: (aim) => ({ method: "GET", url: `/api/v1/pages/${aim.page}/stats/creator/content?${STATS}` }),
  creatorStatsMedia: (aim) => ({ method: "GET", url: `/api/v1/pages/${aim.page}/stats/creator/media/m1?${STATS}` }),
  contentComments: (aim) => ({ method: "GET", url: `/api/v1/pages/${aim.page}/content/comments?${COMMENTS}` }),
  me: () => ({ method: "GET", url: "/api/v1/auth/me" }),
  pages: () => ({ method: "GET", url: "/api/v1/pages" }),
};

function aim(model: "A" | "B"): Aim {
  // Each call takes the next draft; past the last, the last again (a refusal needs no fresh one).
  return { page: model === "A" ? "mia-1" : "zoe-1", model, take: () => (drafts[model].length > 1 ? drafts[model].shift()! : drafts[model][0]!) };
}

/** The other model's pages as they would show in an answer: ids and labels. */
function leaksOf(body: string, model: "A" | "B"): string[] {
  const others = model === "A" ? ["zoe-1"] : ["mia-1", "mia-2"];
  const found = others.filter((label) => body.includes(`"${label}"`));
  for (const label of others) {
    if (new RegExp(`"(pageId|platformAccountId)":${pages[label]}[,}]`).test(body)) found.push(`id of ${label}`);
  }
  return found;
}

describe("the two content screens' operations", () => {
  it("have a call for every row of the one table", () => {
    expect(Object.keys(CALLS).sort()).toEqual(Object.keys(CONTENT_SCREEN_OPERATIONS).sort());
  });

  it("open to a content manager their own model's pages alone, and never show them the other model's", async (context) => {
    if (!server) return context.skip();
    for (const [key, who] of Object.entries(CONTENT_SCREEN_OPERATIONS)) {
      for (const [person, own, other] of [["kmA", "A", "B"], ["kmB", "B", "A"]] as const) {
        const mine = CALLS[key]!(aim(own));
        const answer = await call(mine.method, mine.url, sessions[person], mine.payload);
        if (who === "owner") {
          expect(answer.statusCode, `${key} as ${person}`).toBe(403);
          continue;
        }
        expect([401, 403, 404], `${key} as ${person}: ${answer.body}`).not.toContain(answer.statusCode);
        expect(leaksOf(answer.body, own), `${key} as ${person}`).toEqual([]);
        // The same operation aimed at the other model's page or publication: not there for them.
        const theirs = CALLS[key]!(aim(other));
        if (theirs.url === mine.url && JSON.stringify(theirs.payload) === JSON.stringify(mine.payload)) continue;
        const refused = await call(theirs.method, theirs.url, sessions[person], theirs.payload);
        expect([403, 404], `${key} as ${person} on the other model: ${refused.body}`).toContain(refused.statusCode);
      }
    }
    // A list without a page, and the model's own list: the person's pages only.
    for (const [person, own] of [["kmA", "A"], ["kmB", "B"]] as const) {
      for (const url of ["/api/v1/admin/publications", "/api/v1/admin/publications?modelSlug=zoe", "/api/v1/admin/publications?modelSlug=mia"]) {
        const answer = await call("GET", url, sessions[person]);
        expect(answer.statusCode, answer.body).toBe(200);
        expect(leaksOf(answer.body, own), `${url} as ${person}`).toEqual([]);
      }
    }
  });

  it("give the owner every page, and a model's own list on asking", async (context) => {
    if (!server) return context.skip();
    for (const [key, who] of Object.entries(CONTENT_SCREEN_OPERATIONS)) {
      // The owner's own operations are as they were (their own suites); here only what both share is called.
      if (who === "owner") continue;
      const request = CALLS[key]!(aim("B"));
      const answer = await call(request.method, request.url, sessions.owner, request.payload);
      expect([401, 403, 404], `${key} as the owner: ${answer.body}`).not.toContain(answer.statusCode);
    }
    const all = await call("GET", "/api/v1/admin/publications", sessions.owner);
    expect(all.body).toContain('"mia-1"');
    expect(all.body).toContain('"zoe-1"');
    const mia = await call("GET", "/api/v1/admin/publications?modelSlug=Mia", sessions.owner);
    expect(mia.body).toContain('"mia-1"');
    expect(mia.body).not.toContain('"zoe-1"');
  });

  it("give a team lead and a chatter nothing", async (context) => {
    if (!server) return context.skip();
    for (const person of ["lead", "chatter"] as const) {
      for (const key of Object.keys(CONTENT_SCREEN_OPERATIONS)) {
        // Who is signed in, and the pages a person works: everyone's own, not the screens'.
        if (key === "me" || key === "pages") continue;
        const request = CALLS[key]!(aim("A"));
        const answer = await call(request.method, request.url, sessions[person], request.payload);
        expect(answer.statusCode, `${key} as ${person}: ${answer.body}`).toBe(403);
      }
    }
  });
});

describe("the frame headers", () => {
  it("let ContentOps alone frame the two content screens; every other page keeps its ban", async (context) => {
    if (!server) return context.skip();
    for (const path of ["/frame/publications", "/frame/content-stats?page=mia-1&model=mia"]) {
      const answer = await call("GET", path);
      expect(answer.headers["content-security-policy"], path).toBe(`frame-ancestors ${CONTENTOPS}`);
      expect(answer.headers["x-frame-options"], path).toBeUndefined();
    }
    for (const path of ["/", "/content/publications", "/frame/publications/x", "/api/v1/health"]) {
      const answer = await call("GET", path);
      expect(answer.headers["content-security-policy"], path).toBe("frame-ancestors 'self'");
      expect(answer.headers["x-frame-options"], path).toBe("SAMEORIGIN");
    }
  });
});
