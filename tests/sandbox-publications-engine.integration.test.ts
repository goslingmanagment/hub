import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  fanslyScheduleReadWanted,
  listDueFanslyPublications,
  listDueOnlyfansPublications,
  listDueOnlyfansVaultAlbums,
  listFanslyCheckCandidates,
  listFanslyQueuePages,
  listOnlyfansCheckCandidates,
  listOnlyfansPublicationsForUpload,
  listOnlyfansPublicationsWithUploads,
  listOnlyfansQueuePages,
  listSubmittingFanslyPublications,
  listSubmittingOnlyfansPublications,
} from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { SESSION_COOKIE_NAME } from "../apps/runtime/src/services/auth.ts";
import { seedSandbox } from "../apps/runtime/src/services/sandbox/seed.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

// The test team's «Публикации» on production (products package C2): `sandbox:seed --scenario publications` writes posts
// on the test pages in every state the feed shows; nothing of a test page is ever handed to a platform or to
// OnlyFansAPI. Every selection the engine takes its work from — the scheduler's due posts and uploads, the sender's
// in-flight dispatches, the checks after a send, the vault albums, the schedules' reads — leaves the test pages out even
// with their publishing switched on; an action a test person takes changes Hub's own row and stops before a platform
// with words the screen shows.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

const PASSWORDS = { SANDBOX_PASSWORD_T_OWNER: "sandbox-owner-1" };
const WORDS = "тестовая страница: на площадку не отправляется";
const DAY_MS = 86_400_000;
/**
 * The seed's «now», fixed: a few minutes back, never before the UTC day began — so the second run, a minute later,
 * is another minute of the same day (its day, not the wall clock's minute, decides whether a run adds posts).
 */
const WALL = Date.now();
const SEEDED_AT = new Date(Math.max(Date.parse(`${new Date(WALL).toISOString().slice(0, 10)}T00:00:00Z`), WALL - 5 * 60_000));

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let testPages: number[] = [];
let cookie = "";

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
  if (!testDb) return;
  app = createTestAppContext(testDb);
  const seeded = await seedSandbox(app, { scenarios: ["publications"], env: PASSWORDS, now: SEEDED_AT });
  expect(seeded.scenarios.publications).toEqual({ publications: 5 });
  // A second run the same day adds nothing (below).
  testPages = seeded.pages.map((page) => page.id);
  // The worst case: the test pages' publishing switched on and the Fansly page on its browser, as a live page's would be.
  for (const pageId of testPages) {
    await testDb.pool.query(
      `insert into page_publishing_settings (page_id, enabled) values ($1, true)
       on conflict (page_id) do update set enabled = true, autostopped_at = null`, [pageId]);
  }
  await testDb.pool.query(
    "insert into sync_pages (page_id, transport) values ($1, 'browser') on conflict (page_id) do update set transport = 'browser'",
    [seeded.pages.find((page) => page.label === "test-1")!.id],
  ).catch(() => undefined);
  // Every test post as if the engine had it: approved and due, submitting, scheduled.
  await testDb.pool.query("update publications set publish_at = now() - interval '1 minute' where page_id = any($1) and status = 'approved'", [testPages]);
  server = await buildApiServer(app);
  await server.ready();
  const login = await server.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "t-owner", password: PASSWORDS.SANDBOX_PASSWORD_T_OWNER } });
  expect(login.statusCode, login.body).toBe(200);
  cookie = login.cookies.find((one) => one.name === SESSION_COOKIE_NAME)!.value;
}, 240_000);

afterAll(async () => {
  await server?.close();
  await testDb?.stop();
});

const touches = (pageIds: readonly number[]) => pageIds.filter((id) => testPages.includes(id));

describe("a test page's publications", () => {
  it("are seeded in the states the feed shows, once a day", async (context) => {
    if (!testDb) return context.skip();
    // Later the same UTC day, another minute: nothing more.
    const again = await seedSandbox(app, { scenarios: ["publications"], env: PASSWORDS, now: new Date(SEEDED_AT.getTime() + 60_000) });
    expect(again.scenarios.publications).toEqual({ publications: 0 });
    const states = await testDb.pool.query<{ status: string }>("select status from publications where page_id = any($1) order by status", [testPages]);
    expect(states.rows.map((row) => row.status)).toEqual(["approved", "draft", "published", "unknown", "withdrawn"]);
  });

  it("are never taken by the scheduler, the sender, the checks, the vault albums or the schedules' reads", async (context) => {
    if (!testDb) return context.skip();
    const db = app.db;
    const now = new Date();
    const later = new Date(now.getTime() + 30 * DAY_MS);
    expect(touches((await listDueFanslyPublications(db, { now, postsUntil: later, storiesUntil: later })).map((one) => one.pageId))).toEqual([]);
    expect(touches((await listDueOnlyfansPublications(db, { now, postsUntil: later })).map((one) => one.pageId))).toEqual([]);
    expect(touches((await listOnlyfansPublicationsForUpload(db, { postsUntil: later, storiesUntil: later })).map((one) => one.pageId))).toEqual([]);
    expect(touches((await listDueOnlyfansVaultAlbums(db, later)).map((one) => one.pageId))).toEqual([]);
    expect(touches((await listSubmittingFanslyPublications(db)).map((one) => one.pageId))).toEqual([]);
    expect(touches((await listSubmittingOnlyfansPublications(db)).map((one) => one.pageId))).toEqual([]);
    expect(touches((await listFanslyCheckCandidates(db)).map((one) => one.pageId))).toEqual([]);
    expect(touches((await listOnlyfansCheckCandidates(db)).map((one) => one.pageId))).toEqual([]);
    expect(await listOnlyfansPublicationsWithUploads(db)).toEqual([]);
    expect(touches((await listFanslyQueuePages(db)).map((one) => one.pageId))).toEqual([]);
    expect(touches((await listOnlyfansQueuePages(db, now)).map((one) => one.pageId))).toEqual([]);
    for (const pageId of testPages) expect(await fanslyScheduleReadWanted(db, pageId)).toBe(false);
  });

  it("stop before a platform when a test person acts: «Снять», the schedule's read; approve and cancel change Hub's row alone", async (context) => {
    if (!server || !testDb) return context.skip();
    const call = (method: "GET" | "POST", url: string, payload?: object) => server!.inject({ method, url, headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` }, ...(payload ? { payload } : {}) });
    const listed = await call("GET", "/api/v1/admin/publications");
    expect(listed.statusCode, listed.body).toBe(200);
    const list = listed.json<{ publications: Array<{ id: number; status: string; version: number }> }>().publications;
    const approved = list.find((one) => one.status === "approved")!;
    const withdraw = await call("POST", `/api/v1/admin/publications/${approved.id}/withdraw`);
    expect(withdraw.statusCode, withdraw.body).toBe(200);
    expect(withdraw.json()).toMatchObject({ results: [{ id: approved.id, outcome: "refused", reason: WORDS }] });
    const refresh = await call("POST", "/api/v1/admin/publications/queue/refresh", { pageLabel: "test-of" });
    expect(refresh.statusCode).toBe(409);
    expect(refresh.json()).toMatchObject({ message: WORDS });
    expect((await testDb.pool.query("select count(*)::int as n from publication_dispatches where publication_id in (select id from publications where page_id = any($1))", [testPages])).rows[0].n).toBe(0);
    const cancelled = await call("POST", `/api/v1/admin/publications/${approved.id}/cancel`);
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(cancelled.json()).toMatchObject({ id: approved.id, status: "cancelled" });
  });
});
