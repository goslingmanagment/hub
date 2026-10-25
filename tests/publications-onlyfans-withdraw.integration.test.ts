import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { PublicationContentBody } from "@agency_hub_core/contracts";
import { createModel, createOnlyFansPage, requestPublicationQueueRefresh, setPageOfapiAccountId } from "@agency_hub_core/db";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { createOfapiClient } from "../apps/runtime/src/services/ofapi.ts";
import { ofapiCredentialPolicy } from "../apps/runtime/src/services/ofapi-credential-policy.ts";
import { runOnlyfansPublishingTick } from "../apps/runtime/src/services/publications-onlyfans.ts";
import { runOnlyfansChecksTick } from "../apps/runtime/src/services/publications-onlyfans-checks.ts";
import {
  listOnlyfansQueueWire,
  refreshOnlyfansQueueSnapshots,
  withdrawAllOnlyfansPublications,
  withdrawOnlyfansPublications,
} from "../apps/runtime/src/services/publications-onlyfans-queue.ts";
import { approvePublications, createPublicationDraft, replaceWithdrawnPublication } from "../apps/runtime/src/services/publications.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

/**
 * OnlyFans' schedule and withdrawal (plan PR 5b) against a stub OnlyFansAPI.
 * OnlyFansAPI's post delete removes live posts too, so Hub withdraws only 15
 * minutes or more before the time and only after a fresh complete read of the
 * schedule shows the post: near the time, on a schedule still syncing, or with
 * the post not in it, nothing is sent. A withdrawal is sent once; a lost
 * answer is unknown and never sent again; it is confirmed only by a read that
 * no longer shows the post, and only then may a replacement be drafted.
 */

const ACCOUNT = "acct_24000000000000000000000000000000";
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let pageId = 0;
let ownerId = 0;
let created = 0;
let deleted: string[] = [];
let reads: string[] = [];
let schedule: Array<Record<string, unknown>> = [];
let syncing = false;
let deleteAnswer: (postId: string) => Response;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function inWindow(entry: Record<string, unknown>, url: URL) {
  const day = String(entry.publishDateTime).slice(0, 10);
  return day >= (url.searchParams.get("publishDateStart") ?? "") && day <= (url.searchParams.get("publishDateEnd") ?? "9999");
}

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

afterEach(() => vi.unstubAllGlobals());

beforeEach(async (context) => {
  if (!testDb) {
    context.skip();
    return;
  }
  await resetIntegrationDatabase(testDb.pool);
  app = createTestAppContext(testDb);
  app.config.ofapiExpectedTeamSlug = "agency";
  app.config.publishingEnabled = true;
  app.config.publishingOnlyfansEnabled = true;
  const model = await createModel(app.db, { slug: "lora", name: "Lora" });
  pageId = (await createOnlyFansPage(app.db, { modelId: model.id, label: "lora-of" })).id;
  await setPageOfapiAccountId(app.db, { pageId, ofapiAccountId: ACCOUNT });
  ownerId = (await createUserAccount(app, { username: "owner", role: "owner", password: "owner-password-for-tests" }, { source: "cli" })).id;
  for (let ref = 101; ref <= 105; ref += 1) {
    await testDb.pool.query(
      `insert into ofapi_media_catalog (account_id, page_id, media_ref, material_kind, is_ready, has_error, can_view,
                                        metadata, observation_id, observation_received_at)
       values ($1, $2, $3, 'vault', true, false, true, '{}', 1, now())`,
      [ACCOUNT, pageId, String(ref)],
    );
  }
  await testDb.pool.query("insert into page_publishing_settings (page_id, enabled, updated_by_user_id) values ($1, true, $2)", [pageId, ownerId]);

  created = 0;
  deleted = [];
  reads = [];
  schedule = [];
  syncing = false;
  deleteAnswer = (postId) => {
    schedule = schedule.filter((entry) => String((entry.entity as { id: number }).id) !== postId);
    return json({ data: { success: true } });
  };
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    if (url.pathname.endsWith("/whoami")) return json({ team: { slug: "agency" } });
    const rest = url.pathname.slice(url.pathname.indexOf(ACCOUNT) + ACCOUNT.length);
    if (method === "POST" && rest === "/posts") {
      created += 1;
      const raw = typeof init?.body === "string" ? init.body : Buffer.from(init?.body as Uint8Array).toString("utf8");
      const body = JSON.parse(raw) as { text: string; scheduledDate?: string };
      const id = 700000 + created;
      // OnlyFans puts it in its schedule: entry 50+n holding post 700000+n.
      schedule.push({
        id: 50 + created, type: "post", publishDateTime: body.scheduledDate,
        entity: { responseType: "post", id, rawText: body.text, postedAt: body.scheduledDate, media: [{ id: 101 }] },
      });
      return json({ data: { id, responseType: "post" } });
    }
    if (method === "DELETE" && rest.startsWith("/posts/")) {
      const postId = rest.slice("/posts/".length);
      deleted.push(postId);
      return deleteAnswer(postId);
    }
    if (method !== "GET") throw new Error(`unexpected OFAPI write ${method} ${url.pathname}`);
    reads.push(rest);
    if (rest === "/queue/counts") {
      const list: Record<string, { post: number }> = {};
      for (const entry of schedule.filter((item) => inWindow(item, url))) {
        const day = String(entry.publishDateTime).slice(0, 10);
        list[day] = { post: (list[day]?.post ?? 0) + 1 };
      }
      return json({ data: { list, syncInProcess: syncing } });
    }
    if (rest === "/queue") return json({ data: { list: schedule.filter((item) => inWindow(item, url)), syncInProcess: syncing } });
    if (rest.startsWith("/posts/")) return json({ error: "Post not found" }, 404);
    throw new Error(`unexpected OFAPI request ${method} ${url.pathname}`);
  }));
  app.ofapi = createOfapiClient({ apiKey: "synthetic-key", restDelayMs: 0, ...ofapiCredentialPolicy(app.db, app.config, app.logger) });
});

function body(overrides: Partial<PublicationContentBody> = {}): PublicationContentBody {
  return {
    kind: "subscriber_post", text: "new set", media: [{ source: "vault", mediaRef: "101" }], previews: [],
    publishAt: new Date(Date.now() + 2 * DAY).toISOString(), expiresAt: null, wallRefs: [], tierRefs: [], priceMills: null,
    repost: false, pinWallRefs: [], replyLock: [], subscribersOnly: false, extraAttachments: [], ...overrides,
  };
}

/** Approved and put in OnlyFans' schedule by Hub. */
async function scheduled(overrides: Partial<PublicationContentBody> = {}) {
  const draft = await createPublicationDraft(app.db, { pageId, body: body(overrides), author: { kind: "human", userId: ownerId }, idempotencyKey: null });
  const [result] = await approvePublications(app.db, { items: [{ id: draft.id, version: draft.version }], userId: ownerId });
  expect(result?.outcome, JSON.stringify(result)).toBe("approved");
  await runOnlyfansPublishingTick(app);
  const row = await testDb!.pool.query<{ status: string }>("select status from publications where id = $1", [draft.id]);
  expect(row.rows[0]?.status).toBe("scheduled");
  return draft.id;
}

async function statusOf(id: number) {
  const row = await testDb!.pool.query<{ status: string; status_reason: string | null }>("select status, status_reason from publications where id = $1", [id]);
  return row.rows[0];
}

describe("withdrawal from OnlyFans' schedule", () => {
  it("a fresh read shows it, one delete, a read no longer shows it: withdrawn — even with publishing off; then a replacement", async () => {
    const id = await scheduled();
    app.config.publishingEnabled = false;
    const [result] = await withdrawOnlyfansPublications(app, { ids: [id], userId: ownerId });
    expect(result).toMatchObject({ id, outcome: "withdrawn", reason: "withdrawn" });
    expect(deleted).toEqual(["700001"]);
    expect(reads).toEqual(["/queue/counts", "/queue", "/queue/counts"]);
    expect(await statusOf(id)).toMatchObject({ status: "withdrawn" });
    const dispatches = await testDb!.pool.query("select kind, mode from publication_dispatches where publication_id = $1 order by id", [id]);
    expect(dispatches.rows).toEqual([{ kind: "create", mode: "scheduled" }, { kind: "withdraw", mode: "withdraw" }]);

    const replacement = await replaceWithdrawnPublication(app.db, { id, userId: ownerId });
    expect(replacement).toMatchObject({ status: "draft", previousPublicationId: id, text: "new set" });
  });

  it("near its time nothing is read or sent: OnlyFans' delete would remove a post that already went out", async () => {
    const id = await scheduled({ publishAt: new Date(Date.now() + 10 * MIN).toISOString() });
    const [result] = await withdrawOnlyfansPublications(app, { ids: [id], userId: ownerId });
    expect(result).toMatchObject({ outcome: "refused", reason: "too_close_to_publish_time" });
    expect(deleted).toEqual([]);
    expect(reads).toEqual([]);
    expect(await statusOf(id)).toMatchObject({ status: "scheduled" });
  });

  it("a schedule still syncing, or one without the post, refuses the withdrawal before any delete", async () => {
    const id = await scheduled();
    syncing = true;
    const [stale] = await withdrawOnlyfansPublications(app, { ids: [id], userId: ownerId });
    expect(stale).toMatchObject({ outcome: "refused", reason: "schedule_incomplete:sync_in_process" });
    syncing = false;
    schedule = [];
    const [gone] = await withdrawOnlyfansPublications(app, { ids: [id], userId: ownerId });
    expect(gone).toMatchObject({ outcome: "refused", reason: "not_in_schedule" });
    expect(deleted).toEqual([]);
    expect(await statusOf(id)).toMatchObject({ status: "scheduled" });
    // A replacement is not allowed while the post is not withdrawn.
    await expect(replaceWithdrawnPublication(app.db, { id, userId: ownerId })).rejects.toMatchObject({ code: "publication_not_editable" });
  });

  it("a lost answer is unknown and the delete is never sent again", async () => {
    const id = await scheduled();
    deleteAnswer = () => json({ error: "upstream" }, 502);
    const [first] = await withdrawOnlyfansPublications(app, { ids: [id], userId: ownerId });
    expect(first).toMatchObject({ outcome: "unknown", reason: "withdraw_vendor_http_502" });
    const [second] = await withdrawOnlyfansPublications(app, { ids: [id], userId: ownerId });
    expect(second).toMatchObject({ outcome: "refused", reason: "status_unknown" });
    expect(deleted).toEqual(["700001"]);
    await expect(replaceWithdrawnPublication(app.db, { id, userId: ownerId })).rejects.toMatchObject({ code: "publication_not_editable" });
  });

  it("OnlyFans' refusal leaves the post scheduled, and the withdrawal is not sent twice", async () => {
    const id = await scheduled();
    deleteAnswer = () => json({ error: "Post not found" }, 404);
    const [first] = await withdrawOnlyfansPublications(app, { ids: [id], userId: ownerId });
    expect(first).toMatchObject({ outcome: "rejected", reason: "vendor_http_404" });
    expect(first?.publication).toMatchObject({ status: "scheduled", withdrawal: { state: "rejected", errorCode: "vendor_http_404" } });
    const [second] = await withdrawOnlyfansPublications(app, { ids: [id], userId: ownerId });
    expect(second).toMatchObject({ outcome: "refused", reason: "withdraw_already_sent" });
    expect(deleted).toEqual(["700001"]);
  });

  it("a delete the read after cannot confirm is unknown; the search finds it gone from a complete read: withdrawn", async () => {
    const id = await scheduled();
    deleteAnswer = (postId) => {
      schedule = schedule.filter((entry) => String((entry.entity as { id: number }).id) !== postId);
      syncing = true;
      return json({ data: { success: true } });
    };
    const [result] = await withdrawOnlyfansPublications(app, { ids: [id], userId: ownerId });
    expect(result).toMatchObject({ outcome: "unknown", reason: "withdraw_unconfirmed_incomplete" });
    await expect(replaceWithdrawnPublication(app.db, { id, userId: ownerId })).rejects.toMatchObject({ code: "publication_not_editable" });

    syncing = false;
    await runOnlyfansChecksTick(app, new Date(Date.now() + 11 * MIN));
    expect(await statusOf(id)).toMatchObject({ status: "withdrawn", status_reason: "withdraw_confirmed_by_read" });
    expect(deleted).toEqual(["700001"]);
  });

  it("a page stopped for its authorization sends nothing: the schedule stays on the platform", async () => {
    const id = await scheduled();
    await testDb!.pool.query(
      "update page_publishing_settings set enabled = false, autostop_reason = 'vendor_http_401', autostopped_at = now() where page_id = $1",
      [pageId],
    );
    const [result] = await withdrawOnlyfansPublications(app, { ids: [id], userId: ownerId });
    expect(result).toMatchObject({ outcome: "refused", reason: "publishing_stopped_schedule_stays" });
    expect(deleted).toEqual([]);
    expect(reads).toEqual([]);
  });

  it("«Снять всё, что поставил Hub»: one delete per post, each its own outcome; posts put in by hand stay", async () => {
    const first = await scheduled();
    const second = await scheduled({ media: [{ source: "vault", mediaRef: "102" }], publishAt: new Date(Date.now() + 3 * DAY).toISOString() });
    const late = await scheduled({ media: [{ source: "vault", mediaRef: "103" }], publishAt: new Date(Date.now() + 10 * MIN).toISOString() });
    schedule.push({ id: 99, type: "post", publishDateTime: new Date(Date.now() + 2 * DAY).toISOString(), entity: { responseType: "post", id: 990099, rawText: "by hand" } });

    const results = await withdrawAllOnlyfansPublications(app, { pageId, userId: ownerId });
    expect(results.map((result) => [result.id, result.outcome, result.reason])).toEqual([
      [late, "refused", "too_close_to_publish_time"],
      [first, "withdrawn", "withdrawn"],
      [second, "withdrawn", "withdrawn"],
    ]);
    expect(deleted).toEqual(["700001", "700002"]);
    expect(schedule.map((entry) => entry.id)).toEqual([53, 99]);
  });
});

describe("the page's schedule on screen", () => {
  it("the owner's «Обновить» reads it within a minute; Hub's posts are told from the ones put in by hand", async () => {
    const id = await scheduled();
    schedule.push({ id: 99, type: "post", publishDateTime: new Date(Date.now() + DAY).toISOString(), entity: { responseType: "post", id: 990099, rawText: "by hand", media: [] } });
    await requestPublicationQueueRefresh(app.db, { pageId, userId: ownerId });

    expect(await refreshOnlyfansQueueSnapshots(app)).toBe(1);
    const [queue] = await listOnlyfansQueueWire(app);
    expect(queue).toMatchObject({ pageLabel: "lora-of", complete: true, stale: false, refreshRequestedAt: null });
    expect(queue?.entries.map((entry) => [entry.postRef, entry.publicationId])).toEqual(
      expect.arrayContaining([["700001", id], ["990099", null]]),
    );
    // Read just now, with Hub posts in it: the next read is an hour away.
    expect(await refreshOnlyfansQueueSnapshots(app)).toBe(0);
    expect(await refreshOnlyfansQueueSnapshots(app, new Date(Date.now() + 61 * MIN))).toBe(1);
  });
});
