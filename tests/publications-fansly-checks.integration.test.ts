import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { PublicationContentBody } from "@agency_hub_core/contracts";
import {
  admitFanslyWriteCommand,
  requestPublicationQueueRefresh,
  savePublicationQueueSnapshot,
  settleFanslyWriteCommand,
  type Database,
} from "@agency_hub_core/db";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { listFanslyQueueWire, runFanslyChecksTick } from "../apps/runtime/src/services/publications-fansly-checks.ts";
import { runFanslyPublishingTick } from "../apps/runtime/src/services/publications-fansly.ts";
import { approvePublications, createPublicationDraft } from "../apps/runtime/src/services/publications.ts";
import type { FanslyPublicationReads, FanslyScheduleEntry, FanslyScheduleRead } from "../apps/runtime/src/sync/fansly/publish/reads.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { seedSyncPage } from "./helpers/sync-engine-host.ts";

/**
 * Did the Fansly post go out (plan PR 9): 10 minutes after its time the job
 * asks the page's engine for the fresh reads once, concludes from them when
 * they are taken, and never twice from one read; a work that ended without
 * its reads is a failed read; an absence proves nothing while the stand has
 * not confirmed Fansly's answers. The owner's "Обновить" makes the page's
 * schedule poll due. The engine's side is played here: the verify work is
 * closed with the reads it would have taken.
 */

const MIN = 60_000;
const HASH = "f".repeat(64);

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let pageId = 0;
let ownerId = 0;
let attemptId = 5000;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

async function sql<T extends Record<string, unknown> = Record<string, unknown>>(text: string, values: unknown[] = []) {
  return (await testDb!.pool.query<T>(text, values)).rows;
}

beforeEach(async (context) => {
  if (!testDb) {
    context.skip();
    return;
  }
  await resetIntegrationDatabase(testDb.pool);
  app = createTestAppContext(testDb);
  app.config.publishingEnabled = true;
  ({ pageId } = await seedSyncPage({ db: app.db as unknown as Database, pool: testDb.pool }, { label: "lilly-1", mode: "live", guard: "fansly_sync_engine" }));
  await sql("update sync_pages set transport = 'browser' where page_id = $1", [pageId]);
  await sql(
    `insert into page_walls (page_id, platform, wall_ref, name, default_wall, main_wall, first_observed_at, last_observed_at,
                             content_hash, source_event_id, source_observation_id, source_account_seq)
     values ($1, 'fansly', 'wall-main', 'Main', true, true, now(), now(), $2, 1, 1, 1)`,
    [pageId, HASH],
  );
  await sql(
    `insert into creator_raw_media (page_id, platform, media_ref, source_kind, first_origin, first_observed_at,
                                    last_observed_at, content_hash, source_event_id, source_observation_id, source_account_seq)
     values ($1, 'fansly', 'm1', 'vault_media', 'vault', now(), now(), $2, 1, 1, 1)`,
    [pageId, HASH],
  );
  await sql("insert into page_publishing_settings (page_id, enabled) values ($1, true)", [pageId]);
  ownerId = (await createUserAccount(app, { username: "owner", role: "owner", password: "owner-password-for-tests" }, { source: "cli" })).id;
});

async function settleCommand(id: string, result: Record<string, unknown>) {
  attemptId += 1;
  expect(await admitFanslyWriteCommand(app.db, {
    id: Number(id), attemptId, workId: 1,
    request: {
      spec: "publish.post", method: "POST", host: "api", pathAndQuery: "/api/v1/post",
      body: JSON.stringify({ content: "new set", attachments: [{ contentId: "am1", contentType: 1, pos: 0 }] }), fingerprint: "e".repeat(64),
    },
  })).toBe(true);
  expect(await settleFanslyWriteCommand(app.db, { id: Number(id), attemptId, to: "answered", reason: null, result })).toBe(true);
}

/** A post Hub put in Fansly's schedule as "p1", due in a few minutes. */
async function scheduledPost(): Promise<{ id: number; publishAt: Date }> {
  const publishAt = new Date(Date.now() + 10 * MIN);
  const body: PublicationContentBody = {
    kind: "fyp_post", text: "new set", media: [{ source: "vault", mediaRef: "m1" }], previews: [],
    publishAt: publishAt.toISOString(), expiresAt: null, wallRefs: [], tierRefs: [], priceMills: null, repost: false,
  };
  const draft = await createPublicationDraft(app.db, { pageId, body, author: { kind: "human", userId: ownerId }, idempotencyKey: null });
  const [approved] = await approvePublications(app.db, { items: [{ id: draft.id, version: draft.version }], userId: ownerId });
  expect(approved?.outcome).toBe("approved");
  const tick = () => runFanslyPublishingTick(app, { isSendable: () => true });
  await tick();
  const queued = () => sql<{ id: string }>("select id::text from fansly_write_commands where state = 'queued'");
  await settleCommand((await queued())[0]!.id, { accountMediaIds: ["am1"] });
  await tick();
  await settleCommand((await queued())[0]!.id, { postId: "p1" });
  await tick();
  expect((await sql("select status, platform_post_ref from publications where id = $1", [draft.id]))[0]).toEqual({ status: "scheduled", platform_post_ref: "p1" });
  return { id: draft.id, publishAt };
}

const verifyWorks = (publicationId: number) => sql<{ id: string; state: string; params: { mode: string } }>(
  "select id::text, state, params from sync_work where resource = 'publish.verify' and subject = $1 order by id", [String(publicationId)],
);

async function closeWork(id: string, result: unknown) {
  await sql("update sync_work set state = 'done', closed_at = now(), close_reason = 'reads_taken', result = $2::jsonb where id = $1", [id, JSON.stringify(result)]);
}

const status = async (id: number) => (await sql<{ status: string; status_reason: string | null; platform_post_ref: string | null }>(
  "select status, status_reason, platform_post_ref from publications where id = $1", [id],
))[0]!;

const checks = (id: number) => sql<{ kind: string; outcome: string; reason: string | null; evidence: Record<string, unknown> }>(
  "select kind, outcome, reason, evidence from publication_checks where publication_id = $1 order by id", [id],
);

const scheduleRead = (entries: FanslyScheduleEntry[]): FanslyScheduleRead => ({ ok: true, active: entries, statuses: {}, complete: false, incompleteReasons: ["list_whole_unverified"] });

describe("did the Fansly post go out (spec §3.6)", () => {
  it("asks the page's engine once, then concludes from the reads it took, once", async () => {
    const { id, publishAt } = await scheduledPost();
    const at = (minutes: number) => ({ now: new Date(publishAt.getTime() + minutes * MIN) });
    expect((await runFanslyChecksTick(app, at(5))).readsAsked).toBe(0);
    expect((await runFanslyChecksTick(app, at(11))).readsAsked).toBe(1);
    expect((await runFanslyChecksTick(app, at(12))).readsAsked).toBe(0);
    const [work] = await verifyWorks(id);
    expect(work).toMatchObject({ state: "open", params: { mode: "verify" } });

    const reads: FanslyPublicationReads = {
      v: 1, publicationId: id, mode: "verify",
      byId: { ref: "p1", found: { id: "p1", atMs: publishAt.getTime(), text: "new set", attachmentIds: ["am1"] }, answered: 1 },
      schedule: scheduleRead([]),
    };
    await closeWork(work!.id, reads);
    await runFanslyChecksTick(app, at(13));
    expect(await status(id)).toMatchObject({ status: "published", status_reason: "read_by_id", platform_post_ref: "p1" });
    expect(await checks(id)).toEqual([expect.objectContaining({ kind: "verify", outcome: "published", evidence: expect.objectContaining({ workId: Number(work!.id) }) })]);
    await runFanslyChecksTick(app, at(14));
    expect(await verifyWorks(id)).toHaveLength(1);
    expect(await checks(id)).toHaveLength(1);
  });

  it("absent everywhere is unknown while the stand has not confirmed Fansly's answers — no owner page", async () => {
    const { id, publishAt } = await scheduledPost();
    const at = (minutes: number) => ({ now: new Date(publishAt.getTime() + minutes * MIN) });
    await runFanslyChecksTick(app, at(11));
    const [work] = await verifyWorks(id);
    await closeWork(work!.id, {
      v: 1, publicationId: id, mode: "verify",
      byId: { ref: "p1", found: null, answered: 0 },
      schedule: scheduleRead([]),
      timeline: { posts: [], oldestMs: publishAt.getTime() - 60 * MIN },
    });
    await runFanslyChecksTick(app, at(12));
    expect(await status(id)).toMatchObject({ status: "unknown", status_reason: expect.stringMatching(/^absent_unproven:/) });
    expect(await sql("select kind from notification_incidents where kind = 'publication_not_published'")).toEqual([]);
  });

  it("a work that ended without its reads is a failed read, asked again 10 minutes later", async () => {
    const { id, publishAt } = await scheduledPost();
    const at = (minutes: number) => ({ now: new Date(publishAt.getTime() + minutes * MIN) });
    await runFanslyChecksTick(app, at(11));
    const [work] = await verifyWorks(id);
    await sql("update sync_work set state = 'cancelled', closed_at = now(), close_reason = 'owner_cancelled' where id = $1", [work!.id]);
    expect((await runFanslyChecksTick(app, at(12))).readFailures).toBe(1);
    expect(await checks(id)).toEqual([expect.objectContaining({ outcome: "read_failed", reason: "reads_missing:owner_cancelled" })]);
    expect((await runFanslyChecksTick(app, at(15))).readsAsked).toBe(0);
    expect((await runFanslyChecksTick(app, at(23))).readsAsked).toBe(1);
    expect(await status(id)).toMatchObject({ status: "scheduled" });
  });
});

describe("the page's schedule on the screen (spec §9)", () => {
  it("the owner's «Обновить» makes the schedule poll due; the screen tells Hub's posts from the ones put by hand", async () => {
    const { id } = await scheduledPost();
    await requestPublicationQueueRefresh(app.db, { pageId, userId: ownerId });
    expect((await runFanslyChecksTick(app)).scheduleRefreshes).toBe(1);
    const polls = await sql<{ kind: string; due: boolean }>("select kind, due_at <= now() as due from sync_work where resource = 'publish.schedule'");
    expect(polls).toEqual([{ kind: "poll", due: true }]);

    await savePublicationQueueSnapshot(app.db, {
      pageId, answeredRequestAt: new Date(), readAt: new Date(), windowFrom: null, windowTo: null, complete: false,
      incompleteReasons: ["list_whole_unverified"], postsPerDay: {},
      entries: [
        { queueId: "p1", postRef: "p1", publishAt: new Date().toISOString(), text: "new set", mediaCount: 1 },
        { queueId: "p9", postRef: "p9", publishAt: new Date().toISOString(), text: "by hand", mediaCount: 2 },
      ],
      evidence: {},
    });
    const [page] = await listFanslyQueueWire(app);
    expect(page).toMatchObject({ pageLabel: "lilly-1", platform: "fansly", complete: false, stale: false, refreshRequestedAt: null });
    expect(page!.entries.map((entry) => [entry.postRef, entry.publicationId])).toEqual([["p1", id], ["p9", null]]);
  });
});
