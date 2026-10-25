import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { PublicationContentBody } from "@agency_hub_core/contracts";
import {
  admitFanslyWriteCommand,
  savePublicationQueueSnapshot,
  settleFanslyWriteCommand,
  type Database,
} from "@agency_hub_core/db";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { runFanslyPublishingTick } from "../apps/runtime/src/services/publications-fansly.ts";
import {
  followFanslyWithdrawals,
  withdrawAllFanslyPublications,
  withdrawFanslyPublications,
} from "../apps/runtime/src/services/publications-fansly-withdraw.ts";
import { approvePublications, createPublicationDraft, getPublicationDetail, replaceWithdrawnPublication } from "../apps/runtime/src/services/publications.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { seedSyncPage } from "./helpers/sync-engine-host.ts";

/**
 * Withdrawal of a Fansly post from its schedule (plan PR 9, spec §8.2, §8.4):
 * refused without a request when too close to its time, when the page is
 * stopped, or while the cancel route is unverified; otherwise one cancel
 * command, queued once, a fresh read of the schedule asked for; "Снят" only by
 * a complete read after Fansly's answer — never before the stand confirms the
 * list is whole; a lost answer "Неизвестно"; works while publishing is off;
 * a replacement only for a withdrawn post.
 */

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const HASH = "f".repeat(64);
const VERIFIED = { scheduleListWhole: true, scheduledPostKeepsId: true, storyListRead: true, immediatePost: false };

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let pageId = 0;
let ownerId = 0;
let attemptId = 9000;
const isSendable = () => true;

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
  await sql("insert into page_publishing_settings (page_id, enabled) values ($1, true)", [pageId]);
  ownerId = (await createUserAccount(app, { username: "owner", role: "owner", password: "owner-password-for-tests" }, { source: "cli" })).id;
});

async function settleCommand(id: string | number, to: "answered" | "rejected" | "unknown", result: Record<string, unknown> | null, reason: string | null = null) {
  attemptId += 1;
  expect(await admitFanslyWriteCommand(app.db, {
    id: Number(id), attemptId, workId: 1,
    request: { spec: "publish.post", method: "POST", host: "api", pathAndQuery: "/api/v1/post", body: "{}", fingerprint: "e".repeat(64) },
  })).toBe(true);
  expect(await settleFanslyWriteCommand(app.db, { id: Number(id), attemptId, to, reason, result })).toBe(true);
}

/** A text post Hub put in Fansly's schedule as `postRef`, `days` ahead. */
async function scheduledPost(postRef: string, days = 2): Promise<number> {
  const body: PublicationContentBody = {
    kind: "fyp_post", text: `post ${postRef}`, media: [], previews: [],
    publishAt: new Date(Date.now() + days * DAY).toISOString(), expiresAt: null, wallRefs: [], tierRefs: [], priceMills: null, repost: false, pinWallRefs: [], replyLock: [], subscribersOnly: false, extraAttachments: [],
  };
  const draft = await createPublicationDraft(app.db, { pageId, body, author: { kind: "human", userId: ownerId }, idempotencyKey: null });
  const [approved] = await approvePublications(app.db, { items: [{ id: draft.id, version: draft.version }], userId: ownerId });
  expect(approved?.outcome).toBe("approved");
  await runFanslyPublishingTick(app, { isSendable });
  const [queued] = await sql<{ id: string }>("select id::text from fansly_write_commands where publication_id = $1 and state = 'queued'", [draft.id]);
  await settleCommand(queued!.id, "answered", { postId: postRef });
  await runFanslyPublishingTick(app, { isSendable });
  expect((await sql("select status from publications where id = $1", [draft.id]))[0]).toEqual({ status: "scheduled" });
  return draft.id;
}

const cancels = (publicationId: number) => sql<{ id: string; state: string; not_after: Date }>(
  "select id::text, state, not_after from fansly_write_commands where publication_id = $1 and step = 'post_cancel' order by id", [publicationId],
);
const status = async (id: number) => (await sql<{ status: string; status_reason: string | null }>("select status, status_reason from publications where id = $1", [id]))[0]!;

/** The page's schedule as a read taken now would leave it. */
async function readSchedule(postRefs: string[], complete = false) {
  await savePublicationQueueSnapshot(app.db, {
    pageId, answeredRequestAt: null, readAt: new Date(Date.now() + 1000), windowFrom: null, windowTo: null, complete,
    incompleteReasons: complete ? [] : ["list_whole_unverified"], postsPerDay: {},
    entries: postRefs.map((postRef) => ({ queueId: postRef, postRef, publishAt: null, text: "", mediaCount: 0 })), evidence: {},
  });
}

describe("a Fansly withdrawal is refused without a request (spec §8.2, §8.4)", () => {
  it("while the cancel route is unverified, too close to the time, or the page stopped — the schedule stays", async () => {
    const id = await scheduledPost("p1");
    // A cancel route not verified (the contract verified it: as if it had not).
    expect((await withdrawFanslyPublications(app, { ids: [id], userId: ownerId, isSendable: () => false }))[0]).toMatchObject({ outcome: "refused", reason: "route_unverified" });
    const close = new Date(Date.now() + 2 * DAY - 10 * MIN);
    expect((await withdrawFanslyPublications(app, { ids: [id], userId: ownerId, isSendable, now: close }))[0])
      .toMatchObject({ outcome: "refused", reason: "too_close_to_publish_time" });
    await sql("update page_publishing_settings set enabled = false, autostop_reason = 'browser_login_lost', autostopped_at = now() where page_id = $1", [pageId]);
    expect((await withdrawFanslyPublications(app, { ids: [id], userId: ownerId, isSendable }))[0])
      .toMatchObject({ outcome: "refused", reason: "publishing_stopped_schedule_stays" });
    expect(await sql("select id from publication_dispatches where kind = 'withdraw'")).toEqual([]);
    expect(await cancels(id)).toEqual([]);
    expect(await status(id)).toMatchObject({ status: "scheduled" });
  });
});

describe("a Fansly withdrawal (spec §8.2)", () => {
  it("one cancel, queued once, a fresh read asked; withdrawn only by a complete read after Fansly's answer; then a replacement", async () => {
    const id = await scheduledPost("p1");
    // Publishing off does not stop a withdrawal.
    app.config.publishingEnabled = false;
    await sql("update page_publishing_settings set enabled = false where page_id = $1", [pageId]);
    const [first] = await withdrawFanslyPublications(app, { ids: [id], userId: ownerId, isSendable });
    expect(first).toMatchObject({ outcome: "accepted" });
    const [cancel] = await cancels(id);
    expect(cancel).toMatchObject({ state: "queued" });
    const publishAt = new Date((await sql<{ publish_at: Date }>("select publish_at from publications where id = $1", [id]))[0]!.publish_at);
    expect(cancel!.not_after.getTime()).toBe(publishAt.getTime() - 15 * MIN);
    expect(await sql("select kind from sync_work where resource = 'publish.schedule'")).toEqual([{ kind: "poll" }]);
    expect((await withdrawFanslyPublications(app, { ids: [id], userId: ownerId, isSendable }))[0]).toMatchObject({ outcome: "refused", reason: "withdraw_in_progress" });
    expect((await getPublicationDetail(app.db, id)).withdrawal).toMatchObject({ state: "dispatching" });

    await settleCommand(cancel!.id, "answered", { cancelled: true });
    // No read after the answer yet: the job asks for one and waits.
    expect(await followFanslyWithdrawals(app)).toMatchObject({ followed: 1, readsAsked: 1, withdrawn: 0, unknown: 0 });
    await readSchedule([], true);
    await followFanslyWithdrawals(app, { facts: VERIFIED });
    expect(await status(id)).toMatchObject({ status: "withdrawn", status_reason: "withdrawn" });
    const replacement = await replaceWithdrawnPublication(app.db, { id, userId: ownerId });
    expect(replacement).toMatchObject({ status: "draft", previousPublicationId: id });
  });

  it("until the stand confirms the list is whole, a read without the post is not a confirmation: unknown, no replacement", async () => {
    const id = await scheduledPost("p1");
    await withdrawFanslyPublications(app, { ids: [id], userId: ownerId, isSendable });
    await settleCommand((await cancels(id))[0]!.id, "answered", { cancelled: true });
    await readSchedule([]);
    await followFanslyWithdrawals(app);
    expect(await status(id)).toMatchObject({ status: "unknown", status_reason: "withdraw_unconfirmed_incomplete" });
    await expect(replaceWithdrawnPublication(app.db, { id, userId: ownerId })).rejects.toThrow(/only a withdrawn publication/);
  });

  it("a lost answer is unknown and never sent again; Fansly's refusal leaves the post scheduled", async () => {
    const lost = await scheduledPost("p1");
    const refused = await scheduledPost("p2", 3);
    expect((await withdrawAllFanslyPublications(app, { pageId, userId: ownerId, isSendable })).map((result) => result.outcome)).toEqual(["accepted", "accepted"]);
    await settleCommand((await cancels(lost))[0]!.id, "unknown", null, "no_answer:timeout");
    await settleCommand((await cancels(refused))[0]!.id, "rejected", null, "fansly_http_400");
    await followFanslyWithdrawals(app);
    expect(await status(lost)).toMatchObject({ status: "unknown", status_reason: "withdraw_no_answer:timeout" });
    expect(await status(refused)).toMatchObject({ status: "scheduled" });
    expect((await getPublicationDetail(app.db, refused)).withdrawal).toMatchObject({ state: "rejected", errorCode: "fansly_http_400" });
    // The rejected one went: no second cancel.
    expect((await withdrawFanslyPublications(app, { ids: [refused], userId: ownerId, isSendable }))[0]).toMatchObject({ outcome: "refused", reason: "withdraw_already_sent" });
    expect(await cancels(lost)).toHaveLength(1);
  });
});
