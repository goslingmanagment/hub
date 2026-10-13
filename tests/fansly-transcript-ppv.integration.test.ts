import { createHash } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  FANSLY_PURCHASE_WALK_RESOURCE,
  MEDIA_PLANE_PROJECTION_NAME,
  insertObservation,
  upsertFans,
} from "@agency_hub_core/db";

import { loadTranscriptContext } from "../apps/runtime/src/modules/ai/index.ts";
import { resetCanonicalizeSweepRuntime, runCanonicalization } from "../apps/runtime/src/services/canonicalize-driver.ts";
import { MEDIA_PLANE_PROJECTION, runMediaPlaneProjection } from "../apps/runtime/src/services/projections/media-plane.ts";
import { runMessageArchiveProjection } from "../apps/runtime/src/services/projections/message-archive.ts";
import { PURCHASES_TARGETS_KEY } from "../apps/runtime/src/sync/fansly/resources/purchases.ts";
import { resetIntegrationDatabase, seedFanslyPage, startTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import {
  FANSLY_DM_PAGE_WITH_PPV as DM_PAGE,
  PPV_FAN as FAN,
  PPV_GROUP as GROUP,
  PPV_ORDER_HISTORY as HISTORY,
  PPV_OTHER_FAN as OTHER_FAN,
  PPV_PAGE_REF as PAGE_REF,
  PPV_REFS as REFS,
  orderHistoryPage,
} from "./helpers/fansly-dm-page-ppv.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

// chat-extension R20 HF-7в, parity row AI-144 «Проверка покупки PPV
// (Fansly)»: in the transcript the hub loads itself for a Fansly chat (a
// request without clientContext) each paid attachment carries its own
// purchase mark, as the Fansly extension 2.10.1 marks it in the transcript it
// sends. The extension asks Fansly on every generation (the page's inline
// orders, then `/media/orderhistory` per paid attachment); the hub reads what
// it captured, through its real writers:
//
//   REST dm_messages + purchase_history observations → sync-pull
//   → archive and media-plane projections (media_orders) + the Sync Engine's
//   `purchases.targets` walk rows → loadTranscriptContext
//
// «Not purchased» only where the hub read the target's whole order history
// and every order of it landed; «unknown» everywhere else. Predicate of the
// new behaviour: a Fansly page and the hub-loaded transcript. The clientContext
// lane and OnlyFans keep their bytes (tests/ai-feature-service.integration.test.ts,
// tests/ai-transcript-exact-ids.integration.test.ts).

/**
 * The Fansly extension 2.10.1 over DM_PAGE (helpers/fansly-dm-page-ppv.ts):
 * fansly-chat src at ff30d00 run with TZ=UTC, the hub's clock —
 * `loadMediaPurchaseEvidence` through its real `FanslyClient` (a transport
 * that answers `/media/orderhistory` from PPV_ORDER_HISTORY, filtered by
 * `accountIds` as Fansly filters), then `formatTranscriptForKernel(
 * normalizeTranscript([DM_PAGE], PAGE_REF, FAN, evidence))`. It checked the
 * five paid attachments the page's own orders left open; Fansly answered three
 * and refused two (404: the extension's check did not complete, `unknown`).
 * The hub's two `unknown`s are those two: a bundle nobody bought (never
 * walked) and a video whose walk is still running. Had Fansly answered them,
 * the extension would read both `not purchased`; the hub cannot know that
 * until it walks them.
 */
const OLD_EXTENSION_LINES = [
  "[10:00] Model: [Video - PPV $15.00, purchased] unlock me",
  "[10:01] Model: [Media Bundle: 2 Photos - PPV $25.00, not purchased] a set",
  "[10:02] Fan: wow",
  "[10:03] Model: [Video - PPV $20.00, purchased] [Photo] [Media Bundle: 1 Photo, 1 Video - PPV $30.00, unknown] three things",
  "[10:04] Model: [Photo - PPV $12.00, not purchased] special price",
  "[10:05] Model: [Video - PPV $10.00, unknown] still waiting",
  "[10:06] Fan: ok",
];

let testDb: StartedTestDatabase;
beforeAll(async () => { testDb = await startTestDatabase(); }, 120_000);
afterAll(async () => { await testDb?.stop(); });
beforeEach(async () => {
  await resetIntegrationDatabase(testDb.pool);
  resetCanonicalizeSweepRuntime();
});

type WalkClose = "empty_page" | "known_order" | "subject_terminal:422";

async function fixture(options: { fan?: string | null } = {}) {
  const app = createTestAppContext(testDb, { databaseUrl: testDb.connectionString });
  const { page } = await seedFanslyPage(app.db, app.config.encryptionKey);
  if (!page) throw new Error("seed failed");
  await testDb.pool.query("update pages set external_page_id = $2 where id = $1", [page.id, PAGE_REF]);
  await upsertFans(app.db, [{ platform: "fansly", platformUserId: FAN }, { platform: "fansly", platformUserId: OTHER_FAN }]);
  await testDb.pool.query(
    `insert into page_dm_threads (platform_account_id, platform_conversation_id, partner_platform_user_id)
     values ($1, $2, $3)`,
    [page.id, GROUP, options.fan === undefined ? FAN : options.fan],
  );

  let observations = 0;
  const journal = async (kind: "dm_messages" | "purchase_history", payload: Record<string, unknown>) => insertObservation(app.db, {
    source: "pull", producer: `fansly-sync:${kind}`, platform: "fansly",
    accountId: page.id, kind, payload,
    payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest(),
    idempotencyKey: `transcript-ppv-${++observations}`, receivedAt: new Date(),
  });
  /** The DM page through the real canonicalizer and the archive projection. */
  const restPage = async () => {
    await journal("dm_messages", DM_PAGE);
    await runCanonicalization(app, { kinds: ["dm_messages"], accountId: page.id });
    await runMessageArchiveProjection(app, { accountId: page.id });
  };
  const canonicalizeOrders = () => runCanonicalization(app, { kinds: ["purchase_history"], accountId: page.id });
  const mediaPlane = () => runMediaPlaneProjection(app, { accountId: page.id });
  /**
   * One `purchases.targets` walk of a target as the Sync Engine leaves it: the
   * order-history pages it journaled (each an attempt of the work) and the
   * work row's state. Pages are canonicalized by the caller (the engine leaves
   * that to the minutely driver).
   */
  const walk = async (ref: string, input: {
    state: "done" | "running" | "open";
    close?: WalkClose;
    pages: Array<Record<string, unknown>>;
    shadow?: boolean;
  }) => {
    const subject = `${HISTORY[ref]?.kind ?? (ref.startsWith("82") ? "bundle" : "media")}:${ref}`;
    const closed = input.state === "done";
    const { rows: [work] } = await testDb.pool.query<{ id: string }>(
      `insert into sync_work (page_id, shadow, resource, subject, kind, class, state, closed_at, close_reason)
       values ($1, $2, $3, $4, 'goal', 'planned', $5, case when $6 then clock_timestamp() end, $7)
       returning id::text`,
      [page.id, input.shadow === true, PURCHASES_TARGETS_KEY, subject, input.state, closed, input.close ?? null],
    );
    for (const payload of input.pages) {
      const observation = await journal("purchase_history", payload);
      await testDb.pool.query(
        `insert into sync_attempts (page_id, shadow, work_id, resource, subject, class, owner_generation, setting_ms,
           jitter_u, pause_ms, operation, request, outcome, observation_id, observation_received_at, apply_state)
         values ($1, $2, $3, $4, $5, 'planned', 1, 2000, 0.1, 2200, 'media.order_history', '{}'::jsonb, 'response',
           $6, $7, 'applied')`,
        [page.id, input.shadow === true, Number(work!.id), PURCHASES_TARGETS_KEY, subject,
          observation.observationId, observation.receivedAt],
      );
    }
  };
  /** A whole walk of a target's history: its orders, then the empty page. */
  const walkToEnd = (ref: string) => walk(ref, {
    state: "done", close: "empty_page", pages: [orderHistoryPage(HISTORY[ref]!.orders), orderHistoryPage([])],
  });
  const transcript = async (liveOverlay: "off" | "serve" = "off") => {
    const loaded = await loadTranscriptContext(app, { pageId: page.id, conversationRef: GROUP, limit: 100, liveOverlay });
    return { loaded, lines: loaded.transcript.split("\n") };
  };
  return { app, page, restPage, canonicalizeOrders, mediaPlane, walk, walkToEnd, transcript };
}

/** Every walk the reference rests on; the bundle's latest one stopped on an
 *  order its previous whole walk saw. */
async function walkAsInProduction(f: Awaited<ReturnType<typeof fixture>>) {
  await f.walkToEnd(REFS.bundleOtherBought);
  await f.walk(REFS.bundleOtherBought, {
    state: "done", close: "known_order", pages: [orderHistoryPage(HISTORY[REFS.bundleOtherBought]!.orders)],
  });
  await f.walkToEnd(REFS.boughtInHistory);
  await f.walkToEnd(REFS.metadataPrice);
  await f.walk(REFS.walkRunning, { state: "running", pages: [] });
}

describe("[AI-144] Fansly PPV purchase state in the hub-loaded transcript (chat-extension R20 HF-7в)", () => {
  it("names the engine's walk resource and the media plane as the runtime does", () => {
    expect(FANSLY_PURCHASE_WALK_RESOURCE).toBe(PURCHASES_TARGETS_KEY);
    expect(MEDIA_PLANE_PROJECTION_NAME).toBe(MEDIA_PLANE_PROJECTION);
  });

  it("each paid attachment reads as the Fansly extension 2.10.1 read it after its order-history checks", async () => {
    const f = await fixture();
    await f.restPage();
    await walkAsInProduction(f);
    await f.canonicalizeOrders();
    await f.mediaPlane();

    const { loaded, lines } = await f.transcript();
    expect(lines).toEqual(OLD_EXTENSION_LINES);
    expect(loaded.contextManifest).toMatchObject({
      fanslyPpv: { paid: 6, purchased: 2, notPurchased: 2, unknown: 2 },
    });
    expect(loaded.contextManifest).not.toHaveProperty("fanslyPpvError");
    expect(loaded.contextManifest).not.toHaveProperty("fanslyMediaError");
    // The live overlay serves the same REST rows with the same marks.
    expect((await f.transcript("serve")).lines).toEqual(OLD_EXTENSION_LINES);

    // What the archive alone says: one price per message, the first priced
    // row's — 0 for the photo whose PPV row follows a free one.
    const { rows } = await testDb.pool.query<{ message_ref: string; price_mills: string | null }>(
      `select message_ref, price_mills::text from message_archive
       where account_id = $1 and message_ref in ('800000000000000204', '800000000000000205') order by message_ref`,
      [f.page.id],
    );
    expect(rows).toEqual([
      { message_ref: "800000000000000204", price_mills: "20000" },
      { message_ref: "800000000000000205", price_mills: "0" },
    ]);
  });

  it("before the media plane records the attachments, a message keeps the archive's one price on its first label, unknown", async () => {
    const f = await fixture();
    await f.restPage();
    await walkAsInProduction(f);
    await f.canonicalizeOrders();

    const { loaded, lines } = await f.transcript();
    // R20 HF-7a's reading: which attachment the price belongs to is not known.
    expect(lines).toEqual(expect.arrayContaining([
      "[10:00] Model: [Video - PPV $15.00, unknown] unlock me",
      "[10:03] Model: [Video - PPV $20.00, unknown] [Photo] [Media Bundle] three things",
      "[10:04] Model: [Photo] special price",
    ]));
    expect(loaded.contextManifest).not.toHaveProperty("fanslyPpv");
  });

  it("an order the walk read is not «not purchased» until it reaches media_orders", async () => {
    const f = await fixture();
    await f.restPage();
    await f.mediaPlane();
    await walkAsInProduction(f);

    // The walks are done, but their pages wait for the canonicalizer.
    const unread = await f.transcript();
    expect(unread.lines[1]).toBe("[10:01] Model: [Media Bundle: 2 Photos - PPV $25.00, unknown] a set");
    expect(unread.lines[3]).toBe(
      "[10:03] Model: [Video - PPV $20.00, unknown] [Photo] [Media Bundle: 1 Photo, 1 Video - PPV $30.00, unknown] three things",
    );
    expect(unread.lines[4]).toBe("[10:04] Model: [Photo - PPV $12.00, unknown] special price");

    // Canonicalized: the fan's order of the video waits above the media
    // plane's watermark. Another fan's orders tell nothing about this fan.
    await f.canonicalizeOrders();
    const unprojected = await f.transcript();
    expect(unprojected.lines[1]).toBe("[10:01] Model: [Media Bundle: 2 Photos - PPV $25.00, not purchased] a set");
    expect(unprojected.lines[3]).toBe(
      "[10:03] Model: [Video - PPV $20.00, unknown] [Photo] [Media Bundle: 1 Photo, 1 Video - PPV $30.00, unknown] three things",
    );

    await f.mediaPlane();
    expect((await f.transcript()).lines).toEqual(OLD_EXTENSION_LINES);
  });

  it("a walk closed on a refusal, still open, or the engine's shadow proves nothing", async () => {
    const f = await fixture();
    await f.restPage();
    await f.walk(REFS.bundleOtherBought, { state: "done", close: "subject_terminal:422", pages: [] });
    await f.walk(REFS.metadataPrice, {
      state: "done", close: "empty_page", shadow: true,
      pages: [orderHistoryPage(HISTORY[REFS.metadataPrice]!.orders), orderHistoryPage([])],
    });
    // A target read to the end once, then signalled again: its new walk is open.
    await f.walkToEnd(REFS.boughtInHistory);
    await f.walk(REFS.boughtInHistory, { state: "open", pages: [] });
    await f.canonicalizeOrders();
    await f.mediaPlane();

    const { lines } = await f.transcript();
    expect(lines[1]).toBe("[10:01] Model: [Media Bundle: 2 Photos - PPV $25.00, unknown] a set");
    expect(lines[4]).toBe("[10:04] Model: [Photo - PPV $12.00, unknown] special price");
    // The fan's own order still says «purchased»: an order needs no walk.
    expect(lines[3]).toBe(
      "[10:03] Model: [Video - PPV $20.00, purchased] [Photo] [Media Bundle: 1 Photo, 1 Video - PPV $30.00, unknown] three things",
    );
  });

  it("a chat whose fan the hub does not know reads every paid attachment unknown, as the extension without the fan", async () => {
    const f = await fixture({ fan: null });
    await f.restPage();
    await walkAsInProduction(f);
    await f.canonicalizeOrders();
    await f.mediaPlane();

    const { loaded, lines } = await f.transcript();
    expect(lines[0]).toBe("[10:00] Model: [Video - PPV $15.00, unknown] unlock me");
    expect(lines[1]).toBe("[10:01] Model: [Media Bundle: 2 Photos - PPV $25.00, unknown] a set");
    expect(loaded.contextManifest).toMatchObject({ fanslyPpv: { paid: 6, purchased: 0, notPurchased: 0, unknown: 6 } });
  });

  it("a failed purchase read never fails the transcript: the marks read unknown, and the manifest says so", async () => {
    const f = await fixture();
    await f.restPage();
    await walkAsInProduction(f);
    await f.canonicalizeOrders();
    await f.mediaPlane();
    await testDb.pool.query("alter table media_orders rename column order_type to order_type_moved");
    try {
      const { loaded, lines } = await f.transcript();
      expect(loaded.contextManifest).toMatchObject({
        fanslyPpvError: true,
        fanslyPpv: { paid: 6, purchased: 0, notPurchased: 0, unknown: 6 },
      });
      expect(lines[0]).toBe("[10:00] Model: [Video - PPV $15.00, unknown] unlock me");
      expect(lines[4]).toBe("[10:04] Model: [Photo - PPV $12.00, unknown] special price");
    } finally {
      await testDb.pool.query("alter table media_orders rename column order_type_moved to order_type");
    }
  });
});
