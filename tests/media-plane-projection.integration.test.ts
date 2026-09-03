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
import { readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createFanslyPage,
  createModel,
  ensureDomainEventPartitions,
  insertObservation,
  listEventsSince,
} from "@agency_hub_core/db";

import {
  resetCanonicalizeSweepCursors,
  runCanonicalization,
} from "../apps/runtime/src/services/canonicalize-driver.ts";
import {
  MEDIA_PLANE_PROJECTION,
  rebuildMediaPlaneProjection,
  runMediaPlaneProjection,
} from "../apps/runtime/src/services/projections/media-plane.ts";
import {
  findProjection,
  projectionNames,
} from "../apps/runtime/src/services/projections/registry.ts";
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
  resetCanonicalizeSweepCursors();
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

async function project(pageId: number) {
  await runCanonicalization(appStub(), { kinds: ["dm_messages", "purchase_history"] });
  const result = await runMediaPlaneProjection(appStub(), { accountId: pageId });
  await runMessageArchiveProjection(appStub());
  return result;
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

  it("A17-4 VARIANT B: message_archive and its shadow gain NO columns", async (context) => {
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

    resetCanonicalizeSweepCursors();
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

describe("media plane — registration", () => {
  // Source-level, and deliberately so: a projector that runs but that nobody
  // can REBUILD is a projection you cannot repair, and a projector registered
  // nowhere is a table that silently stops filling. Both are the kind of
  // omission a passing end-to-end test does not notice.
  //
  // WP-F1(0) moved the two registration sites INTO the projection registry, so
  // the property is now checked against the registry itself rather than against
  // the shape of two hand-written blocks. That is strictly stronger: the old
  // assertions could only see whether one specific literal was present, and the
  // registry is what the tick and the CLI now both read.
  it("is declared in the projection registry, with its rebuild and its tables", () => {
    const definition = findProjection(MEDIA_PLANE_PROJECTION);
    expect(definition).not.toBeNull();
    expect(definition?.rebuildKind).toBe("truncate_replay");
    expect(definition?.rebuild).not.toBeNull();
    expect(definition?.stateClass).toBe("fact_projection");
    expect([...(definition?.eventTypes ?? [])]).toEqual([
      "media.observed",
      "media.file_observed",
      "media.order_observed",
      "media.offer_location_observed",
      "message.attachments_observed",
    ]);
    expect([...(definition?.tables ?? [])]).toEqual([
      "creator_media",
      "creator_raw_media",
      "creator_media_bundles",
      "media_orders",
      "message_media_offers",
      "media_offer_locations",
    ]);
  });

  it("rides the registry-driven worker tick and the registry-driven CLI", () => {
    const worker = readFileSync(
      path.resolve("apps/runtime/src/worker-services.ts"),
      "utf8",
    );
    // The tick iterates the registry; nothing about media_plane is named here
    // any more, which is the point — one call site now covers every projection.
    expect(worker).toContain("runProjectionTick");

    const cli = readFileSync(path.resolve("apps/runtime/src/cli.ts"), "utf8");
    expect(cli).toContain("rebuildRegisteredProjection");
    // The argument help is DERIVED from the registry, so an accepted value
    // nobody is told about is impossible rather than merely caught.
    expect(cli).toContain("projectionNames().join(\" | \")");
    expect(projectionNames()).toContain(MEDIA_PLANE_PROJECTION);
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
