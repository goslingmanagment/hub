import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { PublicationContentBody } from "@agency_hub_core/contracts";
import { createModel, createOnlyFansPage, setPageOfapiAccountId } from "@agency_hub_core/db";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { createOfapiClient } from "../apps/runtime/src/services/ofapi.ts";
import { ofapiCredentialPolicy } from "../apps/runtime/src/services/ofapi-credential-policy.ts";
import { runOnlyfansPublishingTick } from "../apps/runtime/src/services/publications-onlyfans.ts";
import { approvePublications, createPublicationDraft } from "../apps/runtime/src/services/publications.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

/**
 * OnlyFans wall posts end to end (plan PR 4b) against a stub OnlyFansAPI: an
 * approved publication goes out once and only once, never while a switch is
 * off, five per page in a row; a lost answer is "unknown" and is not sent
 * again; an authorization refusal stops the page's publishing and pages the
 * owner; a story too late is missed without a request.
 */

const ACCOUNT = "acct_22000000000000000000000000000000";
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let pageId = 0;
let ownerId = 0;
let posts: Array<Record<string, unknown>> = [];
let stories: Array<Record<string, unknown>> = [];
let postAnswer: () => Response = () => json({ data: { id: 700000 + posts.length, responseType: "post" } });

/** The action client sends its body as bytes. */
const bodyOf = (init?: RequestInit) => JSON.parse(
  typeof init?.body === "string" ? init.body : Buffer.from(init?.body as Uint8Array).toString("utf8"),
) as Record<string, unknown>;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

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
  // The page's OnlyFans vault, as the vault metadata refresh leaves it: ready to send.
  for (let ref = 101; ref <= 110; ref += 1) {
    await testDb.pool.query(
      `insert into ofapi_media_catalog (account_id, page_id, media_ref, material_kind, is_ready, has_error, can_view,
                                        metadata, observation_id, observation_received_at)
       values ($1, $2, $3, 'vault', true, false, true, '{}', 1, now())`,
      [ACCOUNT, pageId, String(ref)],
    );
  }
  await testDb.pool.query("insert into page_publishing_settings (page_id, enabled) values ($1, true)", [pageId]);

  posts = [];
  stories = [];
  postAnswer = () => json({ data: { id: 700000 + posts.length, responseType: "post" } });
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith("/whoami")) return json({ team: { slug: "agency" } });
    if (path.endsWith(`/${ACCOUNT}/posts`)) {
      posts.push(bodyOf(init));
      return postAnswer();
    }
    if (path.endsWith(`/${ACCOUNT}/stories`)) {
      stories.push(bodyOf(init));
      return json({ data: { id: 880001, isReady: false, media: [] } });
    }
    throw new Error(`unexpected OFAPI request ${path}`);
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

async function approved(overrides: Partial<PublicationContentBody> = {}) {
  const draft = await createPublicationDraft(app.db, { pageId, body: body(overrides), author: { kind: "human", userId: ownerId }, idempotencyKey: null });
  const [result] = await approvePublications(app.db, { items: [{ id: draft.id, version: draft.version }], userId: ownerId });
  expect(result?.outcome, JSON.stringify(result)).toBe("approved");
  return draft.id;
}

async function statusOf(id: number) {
  const row = await testDb!.pool.query<{ status: string; platform_post_ref: string | null; status_reason: string | null }>(
    "select status, platform_post_ref, status_reason from publications where id = $1", [id],
  );
  return row.rows[0];
}

describe("OnlyFans publications: once, and only with every switch on", () => {
  it("nothing goes while a switch is off; on, the post goes into OnlyFans' schedule once", async () => {
    const id = await approved();
    app.config.publishingOnlyfansEnabled = false;
    await runOnlyfansPublishingTick(app);
    expect(posts).toEqual([]);
    expect(await statusOf(id)).toMatchObject({ status: "approved" });

    app.config.publishingOnlyfansEnabled = true;
    await runOnlyfansPublishingTick(app);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ text: "new set", mediaFiles: [101], blockBannedWords: "strict_ban" });
    expect(posts[0]?.scheduledDate).toEqual(expect.any(String));
    expect(await statusOf(id)).toMatchObject({ status: "scheduled", platform_post_ref: "700001" });

    await runOnlyfansPublishingTick(app);
    expect(posts).toHaveLength(1);
    const dispatches = await testDb!.pool.query("select count(*)::int as n from publication_dispatches where publication_id = $1", [id]);
    expect(dispatches.rows[0].n).toBe(1);
  });

  it("five posts of a page in a row; the rest wait for the next batch", async () => {
    const ids: number[] = [];
    for (let index = 0; index < 7; index += 1) {
      ids.push(await approved({
        media: [{ source: "vault", mediaRef: String(101 + index) }],
        publishAt: new Date(Date.now() + (index + 1) * DAY / 2 + 3 * 60 * MIN).toISOString(),
      }));
    }
    await runOnlyfansPublishingTick(app);
    expect(posts).toHaveLength(5);
    const waiting = await testDb!.pool.query("select count(*)::int as n from publications where status = 'approved'");
    expect(waiting.rows[0].n).toBe(2);

    await runOnlyfansPublishingTick(app, new Date(Date.now() + 11 * MIN));
    expect(posts).toHaveLength(7);
  });

  it("a lost answer is unknown and is never sent again", async () => {
    postAnswer = () => json({ error: "upstream" }, 502);
    const id = await approved();
    await runOnlyfansPublishingTick(app);
    expect(await statusOf(id)).toMatchObject({ status: "unknown" });
    await runOnlyfansPublishingTick(app);
    expect(posts).toHaveLength(1);
  });

  it("an authorization refusal stops the page's publishing and pages the owner", async () => {
    postAnswer = () => json({ error: "unauthorized" }, 401);
    const first = await approved();
    const second = await approved({ media: [{ source: "vault", mediaRef: "102" }], publishAt: new Date(Date.now() + 3 * DAY).toISOString() });
    await runOnlyfansPublishingTick(app);
    expect(await statusOf(first)).toMatchObject({ status: "rejected", status_reason: "vendor_http_401" });
    expect(await statusOf(second)).toMatchObject({ status: "approved" });
    expect(posts).toHaveLength(1);
    const settings = await testDb!.pool.query("select enabled, autostop_reason from page_publishing_settings where page_id = $1", [pageId]);
    expect(settings.rows[0]).toMatchObject({ enabled: false, autostop_reason: "vendor_http_401" });
    const incidents = await testDb!.pool.query("select kind::text as kind, status::text as status from notification_incidents where kind = 'publishing_stopped'");
    expect(incidents.rows).toEqual([{ kind: "publishing_stopped", status: "open" }]);

    await runOnlyfansPublishingTick(app);
    expect(posts).toHaveLength(1);
  });

  it("a story goes at its time and waits while OnlyFans prepares it; one too late is missed without a request", async () => {
    const story = await approved({ kind: "story", text: "", publishAt: new Date(Date.now() + 2 * MIN).toISOString() });
    await runOnlyfansPublishingTick(app);
    expect(stories).toEqual([]);
    await runOnlyfansPublishingTick(app, new Date(Date.now() + 3 * MIN));
    expect(stories).toEqual([{ mediaFiles: [101] }]);
    expect(await statusOf(story)).toMatchObject({ status: "processing", platform_post_ref: "880001" });

    const late = await approved({ kind: "story", text: "", media: [{ source: "vault", mediaRef: "103" }], publishAt: new Date(Date.now() + 2 * MIN).toISOString() });
    await runOnlyfansPublishingTick(app, new Date(Date.now() + 40 * MIN));
    expect(stories).toHaveLength(1);
    expect(await statusOf(late)).toMatchObject({ status: "missed", status_reason: "window_passed" });
  });
});
