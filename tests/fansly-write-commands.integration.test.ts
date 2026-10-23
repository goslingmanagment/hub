import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  admitFanslyWriteCommand,
  getFanslyWriteCommand,
  getFanslyWriteDispatch,
  insertFanslyWriteCommand,
  insertPublication,
  insertPublicationDispatch,
  insertPublicationRevision,
  listFanslyWriteCommandsOfDispatch,
  refuseFanslyWriteCommand,
  requeueFanslyWriteCommand,
  settleFanslyWriteCommand,
  transitionPublication,
  type Database,
  type FanslyWriteRequestRecord,
} from "@agency_hub_core/db";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { enqueueFanslyWriteCommand, FanslyWriteRefusedError } from "../apps/runtime/src/sync/fansly/publish/enqueue.ts";
import { databaseWriteStore } from "../apps/runtime/src/sync/fansly/publish/module.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { seedSyncPage } from "./helpers/sync-engine-host.ts";

// Wall posts PR 6: the table of a page's Fansly write commands (0300). A
// request of a dispatch is queued once; it leaves `queued` only by its
// admission, with its fingerprint; it comes back only when its attempt never
// left; it is settled once. And no write can be queued while the routes are
// unverified, whatever the switches say.

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let pageId = 0;
let publicationId = 0;
let dispatchId = 0;

const FINGERPRINT = "d".repeat(64);
const REQUEST: FanslyWriteRequestRecord = {
  spec: "publish.post", method: "POST", host: "api", pathAndQuery: "/api/v1/post?ngsw-bypass=true", body: "{}", fingerprint: FINGERPRINT,
};

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async (context) => {
  if (!testDb) {
    context.skip();
    return;
  }
  await resetIntegrationDatabase(testDb.pool);
  app = createTestAppContext(testDb);
  ({ pageId } = await seedSyncPage({ db: app.db as unknown as Database, pool: testDb.pool }, { mode: "live", guard: "fansly_sync_engine" }));
  const ownerId = (await createUserAccount(app, { username: "owner", role: "owner", password: "owner-password-for-tests" }, { source: "cli" })).id;
  const modelId = Number((await testDb.pool.query<{ model_id: string }>("select model_id from pages where id = $1", [pageId])).rows[0]!.model_id);
  ({ id: publicationId } = await insertPublication(app.db, {
    pageId, kind: "subscriber_post", text: "hello", publishAt: new Date(Date.now() + 2 * 86_400_000), expiresAt: null,
    wallRefs: ["w1"], tierRefs: [], priceMills: null, repost: false, media: [],
    author: { kind: "human", userId: ownerId }, idempotencyKey: null, findings: [],
  }));
  const revisionId = await insertPublicationRevision(app.db, {
    publicationId, fingerprint: "c".repeat(64), form: { v: 1 }, pageId, platformAccountRef: null, ofapiAccountRef: null,
    ofapiBindingGeneration: 0, modelId, approvedByUserId: ownerId,
  });
  expect(await transitionPublication(app.db, { id: publicationId, from: "draft", to: "approved", actor: { kind: "human", userId: ownerId }, approvedRevisionId: revisionId })).toBe(true);
  const dispatch = await insertPublicationDispatch(app.db, {
    publicationId, revisionId, kind: "create", platform: "fansly", ofapiActionIntentId: null, mode: "scheduled",
  });
  dispatchId = dispatch!.id;
});

const queue = (step: "post" | "account_media" = "post") => insertFanslyWriteCommand(app.db, {
  dispatchId, step, item: "", priority: "background", notBefore: new Date(), notAfter: null,
});

describe("fansly_write_commands", () => {
  it("queues one request per dispatch, step and item; a refused one may be queued again", async () => {
    const first = await queue();
    expect(first).toMatchObject({ pageId, publicationId, dispatchId, step: "post", item: "", state: "queued", attemptId: null });
    expect(await queue()).toBeNull();
    const media = await queue("account_media");
    expect(await refuseFanslyWriteCommand(app.db, { id: media!.id, reason: "publishing_off" })).toBe(true);
    expect(await refuseFanslyWriteCommand(app.db, { id: media!.id, reason: "again" })).toBe(false);
    const again = await queue("account_media");
    expect(again).not.toBeNull();
    expect((await listFanslyWriteCommandsOfDispatch(app.db, dispatchId)).map((row) => `${row.step}:${row.state}`))
      .toEqual(["post:queued", "account_media:refused", "account_media:queued"]);
    expect(await getFanslyWriteDispatch(app.db, dispatchId)).toMatchObject({ publicationId, pageId, kind: "create", platform: "fansly" });
  });

  it("leaves queued only by its admission with its fingerprint, comes back only unsent, and settles once", async () => {
    const command = (await queue())!;
    expect(await admitFanslyWriteCommand(app.db, { id: command.id, attemptId: 8, workId: 1, request: REQUEST })).toBe(true);
    // One admission: a second one finds it sending.
    expect(await admitFanslyWriteCommand(app.db, { id: command.id, attemptId: 9, workId: 1, request: REQUEST })).toBe(false);
    expect(await getFanslyWriteCommand(app.db, command.id)).toMatchObject({ state: "sending", attemptId: 8, requestFingerprint: FINGERPRINT, request: REQUEST });
    // Only its own attempt moves it.
    expect(await requeueFanslyWriteCommand(app.db, { id: command.id, attemptId: 9, reason: "not_sent" })).toBe(false);
    expect(await requeueFanslyWriteCommand(app.db, { id: command.id, attemptId: 8, reason: "not_sent:pace" })).toBe(true);
    expect(await getFanslyWriteCommand(app.db, command.id)).toMatchObject({ state: "queued", attemptId: null, notSentCount: 1 });
    expect(await admitFanslyWriteCommand(app.db, { id: command.id, attemptId: 10, workId: 1, request: REQUEST })).toBe(true);
    expect(await settleFanslyWriteCommand(app.db, { id: command.id, attemptId: 10, to: "answered", reason: null, result: { postId: "p1" }, httpStatus: 200, observationId: 5 })).toBe(true);
    expect(await settleFanslyWriteCommand(app.db, { id: command.id, attemptId: 10, to: "unknown", reason: "late" })).toBe(false);
    expect(await requeueFanslyWriteCommand(app.db, { id: command.id, attemptId: 10, reason: "not_sent" })).toBe(false);
    expect(await getFanslyWriteCommand(app.db, command.id)).toMatchObject({ state: "answered", result: { postId: "p1" }, httpStatus: 200, observationId: 5 });
  });

  it("refuses a row that went without its attempt and fingerprint", async () => {
    const command = (await queue())!;
    await expect(testDb!.pool.query("update fansly_write_commands set state = 'sending' where id = $1", [command.id])).rejects.toThrow(/fansly_write_commands_attempt_check/);
    await expect(testDb!.pool.query("update fansly_write_commands set state = 'unknown', settled_at = now(), attempt_id = 3, admitted_at = now() where id = $1", [command.id]))
      .rejects.toThrow(/fansly_write_commands_attempt_check/);
  });

  it("reads the approval without consequences: a changed publication stays where it is", async () => {
    const command = (await queue())!;
    // The revision's fingerprint is not the publication's: the check says so, and moves nothing.
    expect(await databaseWriteStore.readDeriveContext(app.db, command)).toMatchObject({ ok: false, reason: expect.stringMatching(/^approval_(content|account)_changed$/) });
    const status = await testDb!.pool.query<{ status: string }>("select status from publications where id = $1", [publicationId]);
    expect(status.rows[0]!.status).toBe("approved");
  });
});

describe("no write can be queued while the routes are unverified", () => {
  it("every switch on and the page on its browser: still refused, nothing written", async () => {
    await testDb!.pool.query("insert into page_publishing_settings (page_id, enabled) values ($1, true)", [pageId]);
    await testDb!.pool.query("update sync_pages set transport = 'browser' where page_id = $1", [pageId]);
    const enqueue = () => enqueueFanslyWriteCommand(app.db, {
      dispatchId, step: "post", item: "", priority: "background", notBefore: new Date(), notAfter: null, config: { publishingEnabled: true },
    });
    await expect(enqueue()).rejects.toThrow(FanslyWriteRefusedError);
    await expect(enqueue()).rejects.toThrow(/route_unverified/);
    // On Node it is refused before the route is even looked at.
    await testDb!.pool.query("update sync_pages set transport = 'node' where page_id = $1", [pageId]);
    await expect(enqueue()).rejects.toThrow(/transport_node/);
    const rows = await testDb!.pool.query<{ n: number }>("select count(*)::int as n from fansly_write_commands");
    const works = await testDb!.pool.query<{ n: number }>("select count(*)::int as n from sync_work where resource like 'publish.%'");
    expect(rows.rows[0]!.n).toBe(0);
    expect(works.rows[0]!.n).toBe(0);
  });
});
