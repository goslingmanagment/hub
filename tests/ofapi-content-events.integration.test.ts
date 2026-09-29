import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { createHmac, randomUUID } from "node:crypto";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  createModel,
  createOnlyFansPage,
  setPageOfapiAccountId,
  upsertOfapiWebhookConfig,
  readOfapiContentEvents,
} from "@agency_hub_core/db";
import { encryptJson } from "@agency_hub_core/shared";
import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import { processOfapiWebhookEvent } from "../apps/runtime/src/services/ofapi-events.ts";
import { runCanonicalization } from "../apps/runtime/src/services/canonicalize-driver.ts";
import {
  runOfapiContentProjection,
  rebuildOfapiContentProjection,
} from "../apps/runtime/src/services/projections/ofapi-content-events.ts";
import {
  runFanslyEngagementProjection,
  rebuildFanslyEngagementProjection,
} from "../apps/runtime/src/services/projections/fansly-engagement.ts";
import { executeErasure } from "../apps/runtime/src/services/erasure/index.ts";
import { OFAPI_WEBHOOK_EVENTS } from "../apps/runtime/src/services/ofapi-webhooks.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

// Fixture passwords hash at minimum cost; sign-in still runs the real argon2
// verify (tests/helpers/cheap-argon2.ts).
vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

let testDb: StartedTestDatabase;
let app: ReturnType<typeof createTestAppContext>;
let server: Awaited<ReturnType<typeof buildApiServer>>;
let pageId: number;
let ownerId: number;
const secret = "content-synthetic";
beforeAll(async () => {
  const db = await startIntegrationTestDatabase();
  if (!db) throw new Error("Postgres required");
  testDb = db;
}, 120000);
afterAll(async () => {
  await server?.close();
  await testDb?.stop();
});
beforeEach(async () => {
  vi.unstubAllGlobals();
  await server?.close();
  await resetIntegrationDatabase(testDb.pool);
  app = createTestAppContext(testDb);
  await createUserAccount(
    app,
    {
      username: "content-owner",
      role: "owner",
      password: "test-owner-password",
    },
    { source: "cli" },
  );
  ownerId = Number(
    (
      await testDb.pool.query(
        "select id from users where username='content-owner'",
      )
    ).rows[0].id,
  );
  const model = (await createModel(app.db, {
    slug: "content-events",
    name: "Content events",
  }))!;
  pageId = (await createOnlyFansPage(app.db, {
    modelId: model.id,
    label: "content-page",
  }))!.id;
  await setPageOfapiAccountId(app.db, {
    pageId,
    ofapiAccountId: "acct_content",
  });
  await upsertOfapiWebhookConfig(app.db, {
    externalWebhookId: "wh_content",
    endpointUrl: "https://example.test/webhook",
    accountScope: "global",
    events: [...OFAPI_WEBHOOK_EVENTS, "posts.liked"],
    encryptedSigningSecret: JSON.stringify(
      encryptJson(
        secret,
        app.config.encryptionKey,
        app.config.encryptionKeyVersion,
      ),
    ),
  });
  server = await buildApiServer(app);
});
const like = (id: string, post: string | null = "123") => ({
  id,
  user_id: "999",
  user: { id: "55" },
  createdAt: "2026-09-06T10:00:00Z",
  replacePairs: post
    ? {
        "{POST_LINK}": `<a href='https://onlyfans.com/${post}/creator'>post</a>`,
      }
    : {},
});
const queue = (pending: number, done = false) => ({
  id: "90071992547409931234",
  date: "2026-09-01T00:00:00Z",
  isDone: done,
  isCanceled: done,
  pending,
  total: 7,
});
async function deliver(event: string, payload: unknown) {
  const body = JSON.stringify({ event, account_id: "acct_content", payload });
  const response = await server.inject({
    method: "POST",
    url: "/api/v1/ofapi/webhook",
    payload: body,
    headers: {
      "content-type": "application/json",
      signature: createHmac("sha256", secret).update(body).digest("hex"),
      "x-ofapi-idempotency-key": randomUUID(),
    },
  });
  expect(response.statusCode).toBe(200);
  const row = (
    await testDb.pool.query(
      "select id,raw_body from ofapi_webhook_events order by id desc limit 1",
    )
  ).rows[0]!;
  expect(row.raw_body).not.toBeNull();
  await processOfapiWebhookEvent(app, Number(row.id));
  return row.id;
}
async function project() {
  const result = await runCanonicalization(app, {
    kinds: ["posts.liked", "chat_queue.updated", "chat_queue.finished"],
  });
  expect(result.errored).toBe(0);
  await runOfapiContentProjection(app, { accountId: pageId });
  await runFanslyEngagementProjection(app, { accountId: pageId });
  return result;
}
describe("content events raw-to-owner report", () => {
  it("captures, dedupes and rebuilds exact post/actor facts and terminal queue evidence without outbound work", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await deliver("posts.liked", like("77"));
    await deliver("posts.liked", like("77"));
    await deliver("posts.liked", like("78", null));
    await deliver("chat_queue.updated", queue(6));
    await deliver("chat_queue.finished", queue(0, true));
    await deliver("chat_queue.updated", queue(5));
    const result = await project();
    // Receipt processing already canonicalized these facts; the recovery
    // pass must find no parse debt and projections rebuild from that ledger.
    expect(result).toMatchObject({ scanned: 0, appended: 0, errored: 0 });
    const report = await readOfapiContentEvents(app.db, { pageId });
    expect(report.likes).toHaveLength(1);
    expect(report.likes[0]).toMatchObject({
      postRef: "123",
      fanRef: "55",
      state: "active",
    });
    expect(report.unattributedLikes).toBe(1);
    expect(report.queues).toHaveLength(1);
    expect(report.queues[0]).toMatchObject({
      queueId: "90071992547409931234",
      phase: "finished",
      state: { pending: 0, isCanceled: true },
    });
    await rebuildOfapiContentProjection(app, { accountId: pageId });
    await rebuildFanslyEngagementProjection(app, { accountId: pageId });
    expect(await readOfapiContentEvents(app.db, { pageId })).toEqual(report);
    expect(
      (await testDb.pool.query("select count(*)::int n from ofapi_commands"))
        .rows[0]?.n,
    ).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(
      (
        await server.inject({
          method: "GET",
          url: `/api/v1/admin/ofapi/content/events?pageId=${pageId}`,
        })
      ).statusCode,
    ).toBe(401);
    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "content-owner", password: "test-owner-password" },
    });
    const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
    const served = await server.inject({
      method: "GET",
      url: `/api/v1/admin/ofapi/content/events?pageId=${pageId}`,
      headers: { cookie },
    });
    expect(served.statusCode).toBe(200);
    expect(served.json().coverage).toBe("observed_events_only");
  });
  it("erases queue and fan facts and blocks old source material recollected after page erasure", async () => {
    await deliver("posts.liked", like("77"));
    await deliver("chat_queue.finished", queue(0, true));
    await project();
    await executeErasure(
      app,
      { scopeType: "page", pageLabel: "content-page" },
      { initiatedBy: ownerId },
    );
    expect(await readOfapiContentEvents(app.db, { pageId })).toMatchObject({
      likes: [],
      queues: [],
      unattributedLikes: 0,
    });
    await deliver("posts.liked", like("88"));
    await deliver("chat_queue.updated", queue(4));
    await project();
    expect(await readOfapiContentEvents(app.db, { pageId })).toMatchObject({
      likes: [],
      queues: [],
      unattributedLikes: 0,
    });
  });
  it("fan erasure keeps bystanders and queues; old liker source cannot reappear but new activity can", async () => {
    await deliver("posts.liked", like("77"));
    await deliver("posts.liked", { ...like("78"), user: { id: "66" } });
    await deliver("chat_queue.updated", queue(6));
    await project();
    await executeErasure(
      app,
      { scopeType: "fan", platform: "onlyfans", fanRef: "55" },
      { initiatedBy: ownerId },
    );
    let report = await readOfapiContentEvents(app.db, { pageId });
    expect(report.likes.map((row) => row.fanRef)).toEqual(["66"]);
    expect(report.queues).toHaveLength(1);
    await deliver("posts.liked", like("79"));
    await project();
    await rebuildFanslyEngagementProjection(app, { accountId: pageId });
    report = await readOfapiContentEvents(app.db, { pageId });
    expect(report.likes.map((row) => row.fanRef)).toEqual(["66"]);
    await deliver("posts.liked", {
      ...like("80"),
      createdAt: new Date(Date.now() + 1000).toISOString(),
    });
    await project();
    expect(
      (await readOfapiContentEvents(app.db, { pageId })).likes.map(
        (row) => row.fanRef,
      ),
    ).toContain("55");
  });
  it("leaves malformed actor or unsafe identity observations replayable", async () => {
    await deliver("posts.liked", { ...like("91"), user: undefined });
    await deliver("chat_queue.updated", {
      ...queue(6),
      id: Number.MAX_SAFE_INTEGER + 1,
    });
    const result = await project();
    expect(result.skippedUnparseable).toBe(2);
    const rows = (
      await testDb.pool.query(
        "select parse_version from observations where kind in ('posts.liked','chat_queue.updated') order by id",
      )
    ).rows;
    expect(rows).toEqual([{ parse_version: 0 }, { parse_version: 0 }]);
    expect(await readOfapiContentEvents(app.db, { pageId })).toMatchObject({
      likes: [],
      queues: [],
    });
  });
});
