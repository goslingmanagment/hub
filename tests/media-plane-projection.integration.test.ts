// WP-F0(b) end to end: a journaled Fansly DM page becomes the media plane.
//
// observation → sync-pull v5 drafts → MIXED append (§3.2a) → the four
// rebuildable tables of migration 0130. Everything below reads the DATABASE,
// not the canonicalizer, because the claims this file exists to hold are
// database claims:
//
//  - A17-4 VARIANT B: `message_archive` gains NO columns. Purchase state is
//    served by JOINING `message_media_offers` on (page_id, message_ref) at read
//    time. The archive's column set is pinned here from information_schema, so
//    adding `purchase_state` to it would fail this test rather than quietly
//    break the shadow-rebuild set-equality gate.
//  - COEXISTENCE: an inline `dm_messages` order row and a `purchase_history`
//    row for the SAME purchase produce ONE `media_orders` row, while
//    `message.ppv_unlocked` keeps running beside it. Two identities, one
//    purchase, never summed.
//  - §3.2b: the archive dates a material row from the message time even when
//    the driver clamped the event to receipt time.

import { createHash } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createFanslyPage,
  createModel,
  deleteDmOnlyMediaStatsQueueRows,
  ensureDomainEventPartitions,
  insertObservation,
  listEventsSince,
} from "@agency_hub_core/db";

import {
  resetCanonicalizeSweepRuntime,
  runCanonicalization,
} from "../apps/runtime/src/services/canonicalize-driver.ts";
import { runFanslyMediaStatsDmOnlyPrune } from "../apps/runtime/src/services/fansly-media-stats-dm-only-prune.ts";
import { runFanslyMediaStatsForeignPrune } from "../apps/runtime/src/services/fansly-media-stats-foreign-prune.ts";
import { runCreatorPostsProjection } from "../apps/runtime/src/services/projections/creator-posts.ts";
import { runFanslyStatsProjection } from "../apps/runtime/src/services/projections/fansly-stats.ts";
import {
  rebuildMediaPlaneProjection,
  runMediaPlaneProjection,
} from "../apps/runtime/src/services/projections/media-plane.ts";
import { runMessageArchiveProjection } from "../apps/runtime/src/services/projections/message-archive.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";

let testDb: StartedTestDatabase | null = null;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async () => {
  if (testDb) {
    await resetIntegrationDatabase(testDb.pool);
  }
  resetCanonicalizeSweepRuntime();
});

const OWN_REF = "acct-creator-plane";
const FAN_REF = "acct-fan-plane";

/** Every column `message_archive` has TODAY. A17-4 variant B says this set does
 *  not change — purchase_state / purchased_at / purchase_ref are NOT added. */
const MESSAGE_ARCHIVE_COLUMNS = [
  "account_id",
  "archived_at",
  "backfill_source",
  "content_pending",
  "conversation_ref",
  "deleted_at",
  "fan_native_id",
  "id",
  "in_reply_to_ref",
  "is_new",
  "is_opened",
  "is_sent_by_me",
  "is_tip",
  "material_observed_at",
  "media_metadata",
  "message_ref",
  "native_account_ref",
  "native_message_id",
  "occurred_at",
  "origin_class",
  "platform",
  "price_mills",
  "reply_metadata",
  "reply_parent_observed_at",
  "reply_root_observed_at",
  "sender_role",
  "serving_contract_version",
  "source_account_seq",
  "source_event_id",
  "text_html",
  "text_plain",
  "tip_amount_mills",
  "tip_text_plain",
  "updated_at",
  "vendor_changed_at",
];

function sha256(value: unknown): Buffer {
  return createHash("sha256").update(JSON.stringify(value)).digest();
}

function appStub() {
  return {
    db: testDb!.db,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  } as never;
}

function paidVideoPayload(options: {
  messageId: string;
  messageAt: Date;
  orderAt?: Date;
  withOrder?: boolean;
  /** Live order-history rows carry `orderId`; DM sidecar rows do not. */
  orderId?: string;
}) {
  const seconds = Math.floor(options.messageAt.getTime() / 1000);
  const orderSeconds = Math.floor((options.orderAt ?? options.messageAt).getTime() / 1000);
  return {
    messages: [{
      id: options.messageId,
      type: 0,
      content: "",
      groupId: "group-plane",
      senderId: OWN_REF,
      createdAt: seconds,
      attachments: [{
        messageId: options.messageId,
        contentType: 1,
        contentId: `offer-${options.messageId}`,
        pos: 0,
      }],
      embeds: [],
      interactions: [],
      likes: [],
      totalTipAmount: 0,
    }],
    accountMedia: [{
      id: `offer-${options.messageId}`,
      accountId: OWN_REF,
      mediaId: `raw-${options.messageId}`,
      previewId: null,
      permissionFlags: 9,
      createdAt: seconds - 3_600,
      permissions: {
        permissionFlags: [{
          id: `perm-${options.messageId}`,
          accountMediaId: `offer-${options.messageId}`,
          type: 0,
          flags: 9,
          price: 79_000,
        }],
      },
      likeCount: 4,
      saleStats: { sales: 1, total: 63_200, pending: 63_200 },
      media: {
        id: `raw-${options.messageId}`,
        type: 2,
        mimetype: "video/mp4",
        width: 2160,
        height: 3840,
        // Signed CDN material: present in the payload BECAUSE it is present
        // live. The assertion below proves it never reaches a serving table.
        location: "https://cdn.example.invalid/signed?Signature=abc",
        locations: [{ locationId: "loc-1", location: "https://cdn.example.invalid/m" }],
        metadata: "{\"duration\":1067.584}",
      },
      purchased: false,
      access: true,
    }],
    accountMediaBundles: [],
    accountMediaOrders: options.withOrder === false ? [] : [{
      accountId: FAN_REF,
      accountMediaId: `offer-${options.messageId}`,
      type: 0,
      createdAt: orderSeconds,
      ...(options.orderId === undefined ? {} : { orderId: options.orderId }),
    }],
  };
}

async function seedPage() {
  const model = await createModel(testDb!.db, { slug: "plane", name: "Plane" });
  if (!model) {
    throw new Error("Expected the media-plane test model to be created");
  }
  const page = await createFanslyPage(testDb!.db, { modelId: model.id, label: "plane-page" });
  if (!page) {
    throw new Error("Expected the media-plane test page to be created");
  }
  await testDb!.pool.query("update pages set external_page_id = $1 where id = $2", [
    OWN_REF,
    page.id,
  ]);
  await ensureDomainEventPartitions(testDb!.db);
  return page;
}

async function seedObservation(
  pageId: number,
  kind: "dm_messages" | "purchase_history",
  key: string,
  payload: unknown,
) {
  await insertObservation(testDb!.db, {
    source: "pull",
    producer: `sync:fansly:${kind}`,
    platform: "fansly",
    accountId: pageId,
    kind,
    payload,
    payloadHash: sha256(key),
    idempotencyKey: `plane:${key}`,
  });
}

/** One `/timeline` page: a single post attaching every media it carries, with
 *  their cards in `accountMedia` exactly as the DM sidecar serves them. With
 *  `bundles`, the post attaches each bundle instead of the media it names — the
 *  timeline still serves the members' cards in `accountMedia`. */
async function seedPostsObservation(
  pageId: number,
  key: string,
  media: ReadonlyArray<Record<string, unknown>>,
  options: { bundles?: ReadonlyArray<{ id: string; accountMediaIds: string[] }> } = {},
) {
  const bundles = options.bundles ?? [];
  const bundled = new Set(bundles.flatMap((bundle) => bundle.accountMediaIds));
  const attachments = [
    ...media.filter((row) => !bundled.has(String(row.id)))
      .map((row) => ({ contentType: 1, contentId: row.id })),
    ...bundles.map((bundle) => ({ contentType: 2, contentId: bundle.id })),
  ].map((attachment, pos) => ({ ...attachment, pos }));
  const payload = {
    posts: [{
      id: `post-${key}`,
      content: "",
      createdAt: Math.floor(new Date("2026-08-20T12:00:00Z").getTime() / 1000),
      attachments,
    }],
    accountMedia: media,
    accountMediaBundles: bundles.map((bundle) => ({ ...bundle, accountId: OWN_REF })),
    account: { id: OWN_REF },
  };
  await insertObservation(testDb!.db, {
    source: "pull",
    producer: "sync:fansly:posts",
    platform: "fansly",
    accountId: pageId,
    kind: "posts",
    payload,
    payloadHash: sha256(`posts:${key}`),
    idempotencyKey: `plane:posts:${key}`,
  });
}

async function projectPosts(pageId: number) {
  await runCanonicalization(appStub(), { kinds: ["posts"] });
  return runMediaPlaneProjection(appStub(), { accountId: pageId });
}

async function mediaStatsQueue(pageId: number) {
  return (await testDb!.pool.query<{ subject_ref: string }>(
    `select subject_ref from subject_refresh_state
      where page_id = $1 and plane = 'media_stats' order by subject_ref`,
    [pageId],
  )).rows.map((row) => row.subject_ref);
}

async function project(pageId: number) {
  await runCanonicalization(appStub(), { kinds: ["dm_messages", "purchase_history"] });
  const result = await runMediaPlaneProjection(appStub(), { accountId: pageId });
  await runMessageArchiveProjection(appStub());
  return result;
}

/** The projectors whose tables the DM-only prune reads, besides the media plane. */
async function projectPruneEvidence(pageId: number) {
  await runCreatorPostsProjection(appStub(), { accountId: pageId });
  await runFanslyStatsProjection(appStub(), { accountId: pageId });
}

/** The `media_stats` queue as it stood before the DM-only policy: every head
 *  had a row, whatever showed it. */
async function queueAsBeforeDmPolicy(pageId: number, refs: readonly string[]) {
  await testDb!.pool.query(
    `insert into subject_refresh_state (page_id, plane, subject_ref, refresh_class, next_due_at)
     select $1, 'media_stats', ref, 'fresh', now()
       from unnest($2::text[]) as ref
     on conflict (page_id, plane, subject_ref) do nothing`,
    [pageId, refs],
  );
}

async function rows<T extends Record<string, unknown>>(sql: string, params: unknown[] = []) {
  return (await testDb!.pool.query<T>(sql, params)).rows;
}

describe("media plane — one paid DM page, end to end", () => {
  it("projects creator_media with mills money, shape and sale counters, and NO url", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await seedObservation(
      page.id,
      "dm_messages",
      "m1",
      paidVideoPayload({ messageId: "message-1", messageAt: new Date("2026-08-19T12:00:00Z") }),
    );

    const projected = await project(page.id);
    expect(projected.media).toBe(1);
    expect(projected.orders).toBe(1);
    expect(projected.offers).toBe(1);

    const media = await rows(`select * from creator_media where page_id = $1`, [page.id]);
    expect(media).toHaveLength(1);
    expect(media[0]).toMatchObject({
      platform: "fansly",
      media_offer_ref: "offer-message-1",
      media_ref: "raw-message-1",
      mime_type: "video/mp4",
      width: 2160,
      height: 3840,
      first_origin: "dm_sidecar",
    });
    // BIGINT comes back as a string from pg — compared as such on purpose: a
    // Number() here would hide a units bug behind a lossy cast.
    expect(String(media[0]!.price_mills)).toBe("79000");
    expect(String(media[0]!.sales_net_mills)).toBe("63200");
    expect(String(media[0]!.sales_pending_mills)).toBe("63200");
    expect(String(media[0]!.duration_ms)).toBe("1067584");
    expect(String(media[0]!.sales_count)).toBe("1");
    // Every permissions.permissionFlags[] row, verbatim.
    expect(media[0]!.permission_entries).toEqual([expect.objectContaining({ price: 79_000 })]);
    // No signed CDN address anywhere in the projected row. (BigInt columns are
    // spelled out first — JSON.stringify refuses to serialize one.)
    const serialized = JSON.stringify(
      media[0],
      (_key, value) => (typeof value === "bigint" ? value.toString() : value),
    );
    expect(serialized).not.toMatch(/cdn\.example\.invalid|Signature=|variants/);
  });

  it("A17-4 VARIANT B: purchase state resolves through the message_media_offers join", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await seedObservation(
      page.id,
      "dm_messages",
      "m1",
      paidVideoPayload({ messageId: "message-1", messageAt: new Date("2026-08-19T12:00:00Z") }),
    );
    await project(page.id);

    // The archive learned about this Fansly message through the EXISTING
    // message.material_observed channel — the whole of variant B.
    const archive = await rows(
      `select message_ref, price_mills, media_metadata
         from message_archive where account_id = $1`,
      [page.id],
    );
    expect(archive).toHaveLength(1);
    expect(archive[0]!.message_ref).toBe("message-1");
    // pg hands bigint back as a string or a bigint depending on the column's
    // registered parser — compare the decimal spelling, never a Number().
    expect(String(archive[0]!.price_mills)).toBe("79000");

    // …and purchase state is answered by a JOIN, not by a column.
    const joined = await rows<{ message_ref: string; purchase_state: string; price_mills: string }>(
      `select a.message_ref, o.purchase_state, o.price_mills
         from message_archive a
         join message_media_offers o
           on o.page_id = a.account_id and o.message_ref = a.message_ref
        where a.account_id = $1`,
      [page.id],
    );
    expect(joined).toHaveLength(1);
    expect(joined[0]!.message_ref).toBe("message-1");
    expect(joined[0]!.purchase_state).toBe("purchased");
    expect(String(joined[0]!.price_mills)).toBe("79000");
  });

  it("A17-4 VARIANT B: archive and shadow retain matching schemas, with decision 278 reply clocks", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    for (const table of ["message_archive", "message_archive_shadow"]) {
      const columns = (await rows<{ column_name: string }>(
        `select column_name from information_schema.columns
          where table_schema = 'public' and table_name = $1
          order by column_name`,
        [table],
      )).map((row) => row.column_name);
      expect(columns, table).toEqual(MESSAGE_ARCHIVE_COLUMNS);
      // Named explicitly, because these three are what an earlier draft added
      // and what the shadow-rebuild set-equality gate would have choked on.
      for (const forbidden of ["purchase_state", "purchased_at", "purchase_ref"]) {
        expect(columns, `${table}.${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("COEXISTENCE: a DM order row and a purchase_history row make ONE media_orders row", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    const messageAt = new Date("2026-08-19T12:00:00Z");
    const orderAt = new Date("2026-08-19T12:10:00Z");
    await seedObservation(
      page.id,
      "dm_messages",
      "m1",
      paidVideoPayload({ messageId: "message-1", messageAt, orderAt }),
    );
    // The SAME purchase, seen again through the purchase-history lane.
    await seedObservation(
      page.id,
      "purchase_history",
      "ph1",
      paidVideoPayload({ messageId: "message-1", messageAt, orderAt }),
    );

    await project(page.id);

    const orders = await rows(`select * from media_orders where page_id = $1`, [page.id]);
    expect(orders, "two lanes, one purchase, one row").toHaveLength(1);
    expect(orders[0]).toMatchObject({
      media_offer_ref: "offer-message-1",
      buyer_platform_user_id: FAN_REF,
      message_ref: "message-1",
      conversation_ref: "group-plane",
    });
    expect(String(orders[0]!.price_mills)).toBe("79000");
    expect(new Date(orders[0]!.occurred_at as string).toISOString()).toBe(orderAt.toISOString());

    // …and the fan-purchase event existing consumers read is still emitted,
    // once, beside the order-identity lane. They are never summed.
    const events = await listEventsSince(testDb.db, { accountId: page.id, afterSeq: 0, limit: 200 });
    expect(events.filter((event) => event.type === "message.ppv_unlocked")).toHaveLength(1);
    expect(events.filter((event) => event.type === "media.order_observed")).toHaveLength(1);
  });

  it("order_ref is the orderId of an order-history-first order and stays NULL for a DM-first one", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    const messageAt = new Date("2026-08-19T12:00:00Z");
    // Order history sees purchase 1 first: its orderId becomes order_ref.
    await seedObservation(
      page.id,
      "purchase_history",
      "ph-first",
      paidVideoPayload({ messageId: "message-1", messageAt, orderId: "order-1" }),
    );
    // A DM sees purchase 2 first; order history serves its orderId later.
    await seedObservation(
      page.id,
      "dm_messages",
      "dm-first",
      paidVideoPayload({ messageId: "message-2", messageAt }),
    );
    await project(page.id);
    resetCanonicalizeSweepRuntime();
    await seedObservation(
      page.id,
      "purchase_history",
      "ph-second",
      paidVideoPayload({ messageId: "message-2", messageAt, orderId: "order-2" }),
    );
    await project(page.id);

    // The later order-history sighting dedupes on the composite key and cannot
    // backfill it: DM-first orders — most of them live — keep order_ref NULL,
    // so the column is NOT a complete order-id map.
    expect(await rows(
      `select media_offer_ref, order_ref from media_orders where page_id = $1
        order by media_offer_ref`,
      [page.id],
    )).toEqual([
      { media_offer_ref: "offer-message-1", order_ref: "order-1" },
      { media_offer_ref: "offer-message-2", order_ref: null },
    ]);
  });

  it("§3.2b: a pre-2024 message keeps its TRUE time on the archive row while the event is clamped", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    const ancient = new Date("2022-11-05T08:30:00Z");
    await seedObservation(
      page.id,
      "dm_messages",
      "old",
      paidVideoPayload({ messageId: "message-old", messageAt: ancient }),
    );
    await project(page.id);

    const events = await listEventsSince(testDb.db, { accountId: page.id, afterSeq: 0, limit: 200 });
    const material = events.find((event) => event.type === "message.material_observed")!;
    expect(material).toBeDefined();
    // The clamp fired: the EVENT is receipt-time, with the raw value preserved.
    expect(material.occurredAt.getTime()).toBeGreaterThan(Date.parse("2024-01-01T00:00:00Z"));
    expect(material.data).toMatchObject({
      occurredAtClamped: true,
      occurredAtRaw: ancient.toISOString(),
    });

    // …and the ARCHIVE still holds the true message time, because it dates the
    // row from head.messageCreatedAt, not from event.occurredAt. Without that
    // the row would land on the day of the drain.
    const archive = await rows<{ occurred_at: string }>(
      `select occurred_at from message_archive where account_id = $1`,
      [page.id],
    );
    expect(archive).toHaveLength(1);
    expect(new Date(archive[0]!.occurred_at).toISOString()).toBe(ancient.toISOString());
  });

  it("queues no per-media stats for media seen only in a DM, and keeps every head", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    const payload = paidVideoPayload({
      messageId: "message-1",
      messageAt: new Date("2026-08-19T12:00:00Z"),
      withOrder: false,
    });
    const own = payload.accountMedia[0]!;
    // A DM sidecar carries every media in the thread — the ones the FAN sent
    // included — and a row that names no owner at all.
    payload.accountMedia.push(
      { ...own, id: "offer-fan-sent", accountId: FAN_REF, mediaId: "raw-fan-sent" },
      { ...own, id: "offer-no-owner", accountId: undefined as never, mediaId: "raw-no-owner" },
    );
    await seedObservation(page.id, "dm_messages", "owners", payload);
    await project(page.id);

    // Every head is kept: DM media are still facts other readers want.
    const media = await rows<{ media_offer_ref: string }>(
      `select media_offer_ref from creator_media where page_id = $1 order by media_offer_ref`,
      [page.id],
    );
    expect(media.map((row) => row.media_offer_ref))
      .toEqual(["offer-fan-sent", "offer-message-1", "offer-no-owner"]);
    // None is queued. A fan's media the route cannot serve; the page's own DM
    // PPV it can, but its per-media views are not wanted (owner, 2026-09-29).
    expect(await mediaStatsQueue(page.id)).toEqual([]);
  });

  it("queues a DM-first media once a post shows it — and still only the page's own", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    const payload = paidVideoPayload({
      messageId: "message-1",
      messageAt: new Date("2026-08-19T12:00:00Z"),
      withOrder: false,
    });
    await seedObservation(page.id, "dm_messages", "dm-first", payload);
    await project(page.id);
    expect(await mediaStatsQueue(page.id)).toEqual([]);

    // The same media on a post, next to one another account owns and one that
    // names no owner: the owner check applies to every origin.
    const own = payload.accountMedia[0]!;
    await seedPostsObservation(page.id, "later", [
      own,
      { ...own, id: "offer-fan-sent", accountId: FAN_REF, mediaId: "raw-fan-sent" },
      { ...own, id: "offer-no-owner", accountId: undefined as never, mediaId: "raw-no-owner" },
    ]);
    await projectPosts(page.id);

    expect(await mediaStatsQueue(page.id)).toEqual(["offer-message-1", "offer-no-owner"]);
    // The head keeps its first origin; the queue row is new and never visited.
    const [head] = await rows<{ first_origin: string }>(
      `select first_origin from creator_media
        where page_id = $1 and media_offer_ref = 'offer-message-1'`,
      [page.id],
    );
    expect(head!.first_origin).toBe("dm_sidecar");
    const [queued] = await rows<{ last_visited_at: Date | null; dirty_reason: string | null }>(
      `select last_visited_at, dirty_reason from subject_refresh_state
        where page_id = $1 and plane = 'media_stats' and subject_ref = 'offer-message-1'`,
      [page.id],
    );
    expect(queued).toEqual({ last_visited_at: null, dirty_reason: null });
  });

  it("queues a DM-first media once a post's BUNDLE shows it, and never the bundle", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    const payload = paidVideoPayload({
      messageId: "message-1",
      messageAt: new Date("2026-08-19T12:00:00Z"),
      withOrder: false,
    });
    await seedObservation(page.id, "dm_messages", "dm-first-bundled", payload);
    await project(page.id);
    expect(await mediaStatsQueue(page.id)).toEqual([]);

    // The post names only the bundle; the member is reached through it.
    await seedPostsObservation(page.id, "bundled", [payload.accountMedia[0]!], {
      bundles: [{ id: "bundle-on-post", accountMediaIds: ["offer-message-1"] }],
    });
    await projectPosts(page.id);

    // The member is queued — the route reads media offers — and the bundle is
    // not a media subject, so it never is.
    expect(await mediaStatsQueue(page.id)).toEqual(["offer-message-1"]);
    const [bundle] = await rows<{ member_refs: string[] }>(
      `select member_refs from creator_media_bundles
        where page_id = $1 and bundle_ref = 'bundle-on-post'`,
      [page.id],
    );
    expect(bundle!.member_refs).toEqual(["offer-message-1"]);
  });

  it("prunes the fan's rows queued before the owner check, on an owner's --execute only", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    const first = paidVideoPayload({
      messageId: "message-1",
      messageAt: new Date("2026-08-19T12:00:00Z"),
      withOrder: false,
    });
    const own = first.accountMedia[0]!;
    first.accountMedia.push(
      { ...own, id: "offer-fan-sent", accountId: FAN_REF, mediaId: "raw-fan-sent" },
      { ...own, id: "offer-fan-visited", accountId: FAN_REF, mediaId: "raw-fan-visited" },
      { ...own, id: "offer-mixed", accountId: FAN_REF, mediaId: "raw-mixed" },
      { ...own, id: "offer-no-owner", accountId: undefined as never, mediaId: "raw-no-owner" },
    );
    // The same ref observed ONCE as the page's own keeps its row.
    const second = paidVideoPayload({
      messageId: "message-2",
      messageAt: new Date("2026-08-20T12:00:00Z"),
      withOrder: false,
    });
    second.accountMedia.push({ ...own, id: "offer-mixed", accountId: OWN_REF, mediaId: "raw-mixed" });
    await seedObservation(page.id, "dm_messages", "prune-1", first);
    await seedObservation(page.id, "dm_messages", "prune-2", second);
    await project(page.id);

    // The queue as it stood before the owner check: every head had a row, and
    // a purchase could queue a ref no media event names.
    await testDb.pool.query(
      `insert into subject_refresh_state (page_id, plane, subject_ref, refresh_class, next_due_at)
       select $1, 'media_stats', ref, 'fresh', now()
         from unnest($2::text[]) as ref
       on conflict (page_id, plane, subject_ref) do nothing`,
      [page.id, [
        "offer-fan-sent",
        "offer-fan-visited",
        "offer-message-1",
        "offer-message-2",
        "offer-mixed",
        "offer-no-owner",
        "offer-orphan",
      ]],
    );
    await testDb.pool.query(
      `update subject_refresh_state set consecutive_failures = 3
        where page_id = $1 and plane = 'media_stats' and subject_ref = 'offer-fan-sent'`,
      [page.id],
    );
    // A served window proves the page can read it, whatever the event says.
    await testDb.pool.query(
      `update subject_refresh_state set last_visited_at = now()
        where page_id = $1 and plane = 'media_stats' and subject_ref = 'offer-fan-visited'`,
      [page.id],
    );
    const queued = async () =>
      (await rows<{ subject_ref: string }>(
        `select subject_ref from subject_refresh_state
          where page_id = $1 and plane = 'media_stats' order by subject_ref`,
        [page.id],
      )).map((row) => row.subject_ref);
    const everything = [
      "offer-fan-sent",
      "offer-fan-visited",
      "offer-message-1",
      "offer-message-2",
      "offer-mixed",
      "offer-no-owner",
      "offer-orphan",
    ];
    expect(await queued()).toEqual(everything);
    const expected = [{ pageId: page.id, pageLabel: "plane-page", rows: 1, failing: 1 }];

    // Dry-run is the default: it counts, per page, and writes nothing.
    const dry = await runFanslyMediaStatsForeignPrune(appStub());
    expect(dry).toEqual({ dryRun: true, pages: expected, rows: 1, failing: 1 });
    expect(await queued()).toEqual(everything);
    // Another page's scope finds nothing here.
    expect((await runFanslyMediaStatsForeignPrune(appStub(), { accountId: page.id + 1 })).pages)
      .toEqual([]);

    const executed = await runFanslyMediaStatsForeignPrune(appStub(), {
      dryRun: false,
      accountId: page.id,
    });
    expect(executed).toEqual({ dryRun: false, pages: expected, rows: 1, failing: 1 });
    expect(await queued()).toEqual(everything.filter((ref) => ref !== "offer-fan-sent"));
    // Queue state only: the fan's media head stays.
    expect(await rows(
      `select 1 from creator_media where page_id = $1 and media_offer_ref = 'offer-fan-sent'`,
      [page.id],
    )).toHaveLength(1);
    // And a second run finds nothing to do.
    expect(await runFanslyMediaStatsForeignPrune(appStub(), { dryRun: false }))
      .toEqual({ dryRun: false, pages: [], rows: 0, failing: 0 });
  });

  it("prunes the queue rows of media seen only in DMs, on an owner's --execute only", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    const payload = paidVideoPayload({
      messageId: "message-1",
      messageAt: new Date("2026-08-19T12:00:00Z"),
      withOrder: false,
    });
    const own = payload.accountMedia[0]!;
    for (const id of [
      "offer-dm-visited",
      "offer-dm-posted",
      "offer-dm-bundled",
      "offer-dm-by-ref",
      "offer-dm-top",
    ]) {
      payload.accountMedia.push({ ...own, id, mediaId: `raw-${id}` });
    }
    await seedObservation(page.id, "dm_messages", "dm-only", payload);
    await project(page.id);
    // A head first seen on a post: the enqueue stamps its row.
    await seedPostsObservation(page.id, "post-first", [
      { ...own, id: "offer-post-first", mediaId: "raw-post-first" },
    ]);
    await projectPosts(page.id);
    expect(await mediaStatsQueue(page.id)).toEqual(["offer-post-first"]);
    // The projectors whose tables the prune reads are at the journal head.
    await projectPruneEvidence(page.id);

    // Where each DM-first media ALSO appears outside DMs.
    await testDb.pool.query(
      `insert into creator_posts (account_id, platform, platform_post_id, published_at,
         first_observed_at, last_observed_at, content_hash, attachment_count,
         attachment_refs, source_event_id, source_observation_id, source_account_seq)
       values ($1, 'fansly', 'post-kept', '2026-08-20T00:00:00Z', '2026-08-20T00:00:00Z',
               '2026-08-20T00:00:00Z', repeat('d', 64), 4, $2::jsonb, 1, 1, 1)`,
      [page.id, JSON.stringify([
        { pos: 0, contentType: 1, contentId: "offer-dm-posted" },
        { pos: 1, contentType: 2, contentId: "bundle-on-post" },
        { pos: 2, contentType: 1, contentId: "offer-orphan-posted" },
        { pos: 3, contentType: 2, contentId: "bundle-by-ref" },
      ])],
    );
    // A bundle on a post that only the MEMBER's head names — no bundle head.
    await testDb.pool.query(
      `update creator_media set bundle_refs = array['bundle-by-ref']
        where page_id = $1 and media_offer_ref = 'offer-dm-by-ref'`,
      [page.id],
    );
    // A ranked item: first seen from the account statistics, on no post, and
    // no longer in any `stats_top_media` window.
    await testDb.pool.query(
      `insert into creator_media (
         page_id, platform, media_offer_ref, first_origin, first_observed_at,
         last_observed_at, content_hash, source_event_id, source_observation_id,
         source_account_seq
       ) values ($1, 'fansly', 'offer-ranked', 'stats_agg', now(), now(),
                 repeat('c', 64), 1, 1, 1)`,
      [page.id],
    );
    await testDb.pool.query(
      `insert into creator_media_bundles (
         page_id, platform, bundle_ref, member_refs, first_observed_at, last_observed_at,
         content_hash, source_event_id, source_observation_id, source_account_seq
       ) values ($1, 'fansly', 'bundle-on-post', $2::text[], now(), now(), repeat('e', 64), 1, 1, 1)`,
      [page.id, ["offer-dm-bundled"]],
    );
    await testDb.pool.query(
      `insert into stats_top_media (
         page_id, platform, plane, period_ms, requested_start, requested_end,
         media_offer_ref, rank, content_hash, observed_at, source_event_id,
         source_observation_id, source_account_seq
       ) values ($1, 'fansly', 'top_media', 86400000, '2026-07-21T00:00:00Z',
                 '2026-08-20T00:00:00Z', 'offer-dm-top', 0, repeat('f', 64), now(), 1, 1, 1)`,
      [page.id],
    );
    // The queue as it stood before this policy: every DM head had a row, and a
    // purchase could queue a ref no head names — here one no post names either,
    // and one a post does.
    await testDb.pool.query(
      `insert into subject_refresh_state (page_id, plane, subject_ref, refresh_class, next_due_at)
       select $1, 'media_stats', ref, 'fresh', now()
         from unnest($2::text[]) as ref
       on conflict (page_id, plane, subject_ref) do nothing`,
      [page.id, [
        "offer-message-1",
        "offer-dm-visited",
        "offer-dm-posted",
        "offer-dm-bundled",
        "offer-dm-by-ref",
        "offer-dm-top",
        "offer-orphan",
        "offer-orphan-posted",
        "offer-ranked",
      ]],
    );
    // A row the lane has visited, and a purchase has marked since: its
    // collected buckets stay whatever happens to the row.
    await testDb.pool.query(
      `update subject_refresh_state
          set last_visited_at = now(), dirty_reason = 'purchase_notification'
        where page_id = $1 and plane = 'media_stats' and subject_ref = 'offer-dm-visited'`,
      [page.id],
    );
    const everything = [
      "offer-dm-bundled",
      "offer-dm-by-ref",
      "offer-dm-posted",
      "offer-dm-top",
      "offer-dm-visited",
      "offer-message-1",
      "offer-orphan",
      "offer-orphan-posted",
      "offer-post-first",
      "offer-ranked",
    ];
    expect(await mediaStatsQueue(page.id)).toEqual(everything);
    const pruned = ["offer-dm-visited", "offer-message-1", "offer-orphan"];
    const expected = [{
      pageId: page.id,
      pageLabel: "plane-page",
      rows: 3,
      visited: 1,
      dirty: 1,
      headless: 1,
    }];

    // Dry-run is the default: it counts, per page, and writes nothing.
    const dry = await runFanslyMediaStatsDmOnlyPrune(appStub());
    expect(dry).toEqual({
      dryRun: true,
      refused: false,
      lagging: [],
      pages: expected,
      rows: 3,
      visited: 1,
      dirty: 1,
      headless: 1,
    });
    expect(await mediaStatsQueue(page.id)).toEqual(everything);
    // Another page's scope finds nothing here.
    expect((await runFanslyMediaStatsDmOnlyPrune(appStub(), { accountId: page.id + 1 })).pages)
      .toEqual([]);

    const executed = await runFanslyMediaStatsDmOnlyPrune(appStub(), {
      dryRun: false,
      accountId: page.id,
    });
    expect(executed).toEqual({
      dryRun: false,
      refused: false,
      lagging: [],
      pages: expected,
      rows: 3,
      visited: 1,
      dirty: 1,
      headless: 1,
    });
    expect(await mediaStatsQueue(page.id)).toEqual(everything.filter((ref) => !pruned.includes(ref)));
    // Queue state only: every media head stays.
    expect((await rows(
      `select media_offer_ref from creator_media where page_id = $1 order by media_offer_ref`,
      [page.id],
    )).map((row) => row.media_offer_ref)).toEqual([
      "offer-dm-bundled",
      "offer-dm-by-ref",
      "offer-dm-posted",
      "offer-dm-top",
      "offer-dm-visited",
      "offer-message-1",
      "offer-post-first",
      "offer-ranked",
    ]);
    // And a second run finds nothing to do.
    expect(await runFanslyMediaStatsDmOnlyPrune(appStub(), { dryRun: false })).toEqual({
      dryRun: false,
      refused: false,
      lagging: [],
      pages: [],
      rows: 0,
      visited: 0,
      dirty: 0,
      headless: 0,
    });
  });

  it("prunes a purchase mark on a post's BUNDLE, and keeps the post's media", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    const own = paidVideoPayload({
      messageId: "message-1",
      messageAt: new Date("2026-08-19T12:00:00Z"),
      withOrder: false,
    }).accountMedia[0]!;
    const posted = { ...own, id: "offer-post-media", mediaId: "raw-post-media" };
    // A post that shows one media of its own and a bundle of another.
    await seedPostsObservation(page.id, "bundle-mark", [posted, own], {
      bundles: [{ id: "bundle-on-post", accountMediaIds: ["offer-message-1"] }],
    });
    await projectPosts(page.id);
    await projectPruneEvidence(page.id);
    // The queue as it stood before 0222 carried no stamp, and a purchase of
    // the bundle, before the mark learned to leave bundles alone, queued the
    // bundle's ref. No head names it — a bundle is not a media offer — so the
    // chunk never admits it and it stays dirty for good (production
    // 2026-09-30: 93 such rows, every one of them on a post).
    await testDb.pool.query(
      `update subject_refresh_state set media_shown_outside_dm_at = null
        where page_id = $1 and plane = 'media_stats'`,
      [page.id],
    );
    await testDb.pool.query(
      `insert into subject_refresh_state (
         page_id, plane, subject_ref, refresh_class, next_due_at, dirty_reason
       ) values ($1, 'media_stats', 'bundle-on-post', 'dirty', now(), 'purchase_notification')`,
      [page.id],
    );
    expect(await mediaStatsQueue(page.id))
      .toEqual(["bundle-on-post", "offer-message-1", "offer-post-media"]);

    const pages = [{ pageId: page.id, pageLabel: "plane-page", rows: 1, visited: 0, dirty: 1, headless: 1 }];
    expect(await runFanslyMediaStatsDmOnlyPrune(appStub())).toMatchObject({ pages, rows: 1 });
    expect(await runFanslyMediaStatsDmOnlyPrune(appStub(), { dryRun: false, waitMs: 0 }))
      .toMatchObject({ refused: false, pages, rows: 1 });
    expect(await mediaStatsQueue(page.id)).toEqual(["offer-message-1", "offer-post-media"]);
  });

  it("keeps a DM-first media's row once media_plane projects its post, before creator_posts has", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    const payload = paidVideoPayload({
      messageId: "message-1",
      messageAt: new Date("2026-08-19T12:00:00Z"),
      withOrder: false,
    });
    const own = payload.accountMedia[0]!;
    const posted = { ...own, id: "offer-dm-era-posted", mediaId: "raw-dm-era-posted" };
    payload.accountMedia.push(posted, { ...own, id: "offer-dm-only", mediaId: "raw-dm-only" });
    await seedObservation(page.id, "dm_messages", "dm-first", payload);
    await project(page.id);
    // Two of them were queued from the DM before the policy; the third was not.
    await queueAsBeforeDmPolicy(page.id, ["offer-dm-era-posted", "offer-dm-only"]);

    // Projection rotation: the media plane reaches the post observation first,
    // and the post's head is not in creator_posts yet.
    await seedPostsObservation(page.id, "later", [own, posted]);
    await projectPosts(page.id);
    expect(await rows(`select 1 from creator_posts where account_id = $1`, [page.id])).toEqual([]);
    expect(await mediaStatsQueue(page.id))
      .toEqual(["offer-dm-era-posted", "offer-dm-only", "offer-message-1"]);

    // Every head is still first seen in a DM, and no post names either media —
    // yet the post has shown both, and the prune keeps both rows. It deletes
    // the one media nothing showed outside the DM.
    const deleted = await deleteDmOnlyMediaStatsQueueRows(testDb.db, { pageId: page.id });
    expect(deleted.map((row) => row.rows)).toEqual([1]);
    expect(await mediaStatsQueue(page.id)).toEqual(["offer-dm-era-posted", "offer-message-1"]);
    expect((await rows<{ first_origin: string }>(
      `select distinct first_origin from creator_media where page_id = $1`,
      [page.id],
    )).map((row) => row.first_origin)).toEqual(["dm_sidecar"]);

    // The evidence is the queue row's own, written by the enqueue that queued
    // it: the post observation's instant, on a new row and on the DM-era one.
    const evidence = await rows<{ subject_ref: string; shown: Date | null }>(
      `select subject_ref, media_shown_outside_dm_at as shown from subject_refresh_state
        where page_id = $1 and plane = 'media_stats' order by subject_ref`,
      [page.id],
    );
    expect(evidence.map((row) => row.subject_ref)).toEqual(["offer-dm-era-posted", "offer-message-1"]);
    for (const row of evidence) {
      expect(row.shown).toBeInstanceOf(Date);
    }
    // And a second prune deletes nothing.
    expect(await deleteDmOnlyMediaStatsQueueRows(testDb.db, { pageId: page.id })).toEqual([]);
  });

  it("refuses --execute while its projectors are behind the journal head, and waits for them", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    const payload = paidVideoPayload({
      messageId: "message-1",
      messageAt: new Date("2026-08-19T12:00:00Z"),
      withOrder: false,
    });
    const own = payload.accountMedia[0]!;
    payload.accountMedia.push({ ...own, id: "offer-dm-only", mediaId: "raw-dm-only" });
    await seedObservation(page.id, "dm_messages", "dm-lag", payload);
    await project(page.id);
    await queueAsBeforeDmPolicy(page.id, ["offer-dm-only", "offer-message-1"]);
    await seedPostsObservation(page.id, "lag", [own]);
    await projectPosts(page.id);

    // The media plane is at the head; creator_posts and fansly_stats have not
    // started. The dry run counts and reports the lag.
    const [head] = await rows<{ head: string }>(
      `select (next_seq - 1)::text as head from domain_event_seq where account_id = $1`,
      [page.id],
    );
    const lagging = ["creator_posts", "fansly_stats"].map((projection) => ({
      pageId: page.id,
      pageLabel: "plane-page",
      projection,
      watermark: 0,
      head: Number(head!.head),
    }));
    const pages = [{ pageId: page.id, pageLabel: "plane-page", rows: 1, visited: 0, dirty: 0, headless: 0 }];
    expect(await runFanslyMediaStatsDmOnlyPrune(appStub())).toEqual({
      dryRun: true,
      refused: false,
      lagging,
      pages,
      rows: 1,
      visited: 0,
      dirty: 0,
      headless: 0,
    });

    // --execute refuses and deletes nothing.
    expect(await runFanslyMediaStatsDmOnlyPrune(appStub(), { dryRun: false, waitMs: 0 })).toEqual({
      dryRun: false,
      refused: true,
      lagging,
      pages: [],
      rows: 0,
      visited: 0,
      dirty: 0,
      headless: 0,
    });
    expect(await mediaStatsQueue(page.id)).toEqual(["offer-dm-only", "offer-message-1"]);

    // Given time, it waits for them to reach the head it started at.
    const executing = runFanslyMediaStatsDmOnlyPrune(appStub(), {
      dryRun: false,
      waitMs: 60_000,
      pollMs: 20,
    });
    await projectPruneEvidence(page.id);
    expect(await executing).toEqual({
      dryRun: false,
      refused: false,
      lagging: [],
      pages,
      rows: 1,
      visited: 0,
      dirty: 0,
      headless: 0,
    });
    expect(await mediaStatsQueue(page.id)).toEqual(["offer-message-1"]);
    expect(await runFanslyMediaStatsDmOnlyPrune(appStub(), { dryRun: false, waitMs: 0 })).toEqual({
      dryRun: false,
      refused: false,
      lagging: [],
      pages: [],
      rows: 0,
      visited: 0,
      dirty: 0,
      headless: 0,
    });
  });

  it("is idempotent: a second sweep + projection changes nothing", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await seedObservation(
      page.id,
      "dm_messages",
      "m1",
      paidVideoPayload({ messageId: "message-1", messageAt: new Date("2026-08-19T12:00:00Z") }),
    );
    await project(page.id);
    const before = await rows(
      `select page_id, media_offer_ref, price_mills, sales_net_mills, content_hash
         from creator_media where page_id = $1`,
      [page.id],
    );

    resetCanonicalizeSweepRuntime();
    const second = await runCanonicalization(appStub(), { kinds: ["dm_messages"] });
    // Already stamped at v5, so the sweep re-reads nothing and appends nothing.
    expect(second.appended).toBe(0);
    await runMediaPlaneProjection(appStub(), { accountId: page.id });

    expect(await rows(
      `select page_id, media_offer_ref, price_mills, sales_net_mills, content_hash
         from creator_media where page_id = $1`,
      [page.id],
    )).toEqual(before);
    expect(await rows(`select * from media_orders where page_id = $1`, [page.id])).toHaveLength(1);
    expect(await rows(`select * from message_media_offers where page_id = $1`, [page.id]))
      .toHaveLength(1);
  });
});

describe("media plane — rebuild", () => {
  it("truncates its scope and reproduces the same rows from the ledger alone", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await seedObservation(
      page.id,
      "dm_messages",
      "m1",
      paidVideoPayload({ messageId: "message-1", messageAt: new Date("2026-08-19T12:00:00Z") }),
    );
    await project(page.id);
    const before = await rows(
      `select page_id, media_offer_ref, price_mills, sales_net_mills, content_hash
         from creator_media where page_id = $1 order by media_offer_ref`,
      [page.id],
    );

    // A rebuild reads EVENTS only — never observations.payload. That is the
    // property that makes these tables rebuildable and the journal the truth.
    await rebuildMediaPlaneProjection(appStub(), { accountId: page.id });

    expect(await rows(
      `select page_id, media_offer_ref, price_mills, sales_net_mills, content_hash
         from creator_media where page_id = $1 order by media_offer_ref`,
      [page.id],
    )).toEqual(before);
    expect(await rows(`select * from media_orders where page_id = $1`, [page.id])).toHaveLength(1);
  });

  it("§3.2c(i): REFUSES when a detached partition holds the account's events", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await seedObservation(
      page.id,
      "dm_messages",
      "m1",
      paidVideoPayload({ messageId: "message-1", messageAt: new Date("2026-08-19T12:00:00Z") }),
    );
    await project(page.id);

    // Move this account's events into a month, then detach it holding rows —
    // exactly what tiering does at ~6 months. `listEventsSince` sees only
    // ATTACHED partitions, so a rebuild that ran anyway would truncate the
    // projection, replay a truncated ledger and call the result authoritative.
    await testDb.pool.query(`
      create table if not exists "domain_events_2026_02" partition of "domain_events"
      for values from ('2026-02-01 00:00:00+00') to ('2026-03-01 00:00:00+00')
    `);
    await testDb.pool.query(`
      insert into domain_events (
        account_id, account_seq, type, occurred_at, data, schema_version, dedup_key, observation_id
      )
      select account_id, account_seq + 1000, type, timestamptz '2026-02-10 09:00:00+00',
             data, schema_version, dedup_key || ':tiered', observation_id
        from domain_events where account_id = $1 limit 1
    `, [page.id]);
    await testDb.pool.query(
      `alter table "domain_events" detach partition "domain_events_2026_02"`,
    );

    await expect(rebuildMediaPlaneProjection(appStub(), { accountId: page.id }))
      .rejects.toThrow(/REFUSED.*detached.*TRUNCATED projection/s);
    // Refusing means refusing BEFORE the truncate: the rows are still there.
    expect(await rows(`select * from creator_media where page_id = $1`, [page.id]))
      .toHaveLength(1);

    await testDb.pool.query(`drop table if exists "domain_events_2026_02" cascade`);
  });
});
