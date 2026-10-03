import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  insertObservation,
  markFanEarningsDirty,
  putPayloadObject,
  upsertFans,
  upsertFanslyTransactionWithEarningsDirty,
  upsertPageTopSpenders,
  type Database,
} from "@agency_hub_core/db";
import { fanslyWireSpec } from "@agency_hub_core/fansly";

import { familyForObservation } from "../apps/runtime/src/services/canonicalize/index.ts";
import { runCanonicalization } from "../apps/runtime/src/services/canonicalize-driver.ts";
import { runFanslyPayoutsProjection } from "../apps/runtime/src/services/projections/fansly-payouts.ts";
import { runMediaPlaneProjection } from "../apps/runtime/src/services/projections/media-plane.ts";
import { buildFanEarningsReceipt } from "../apps/runtime/src/sync/fansly/lib/fan-earnings-receipt.ts";
import { mapFanslyTransactionItem } from "../apps/runtime/src/sync/fansly/lib/money-rules.ts";
import { canonicalizeObservationInTransaction } from "../apps/runtime/src/sync/engine/canonicalize.ts";
import { createFanslyRegistry, FANSLY_RESOURCE_SPECS } from "../apps/runtime/src/sync/fansly/registry.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { envelope as notificationsEnvelope, row as notificationRow } from "./helpers/fansly-notifications-fixtures.ts";
import {
  FakeChats,
  HARNESS_OWN_REF,
  replayPageJournal,
  seedChatThread,
  seedHarnessPage,
  type ReplayTally,
} from "./helpers/sync-engine.ts";
import { changedTables, tableCounts } from "./helpers/sync-engine-host.ts";

// Plan §15 step 2, "повтор ресурсов на журнале" (design §3.12 B5): the
// harness that runs every journaled legacy observation of a page through the
// registry entry that replays its kind — the new wire contract plus the
// resource's intended effects against what legacy stored — reading each body
// through the capture seam, whether the journal row holds it inline or only
// points into the content-addressed catalog. Pinned: a body legacy applied
// faithfully matches, a divergence is reported with its observation id and
// reason, a kind nobody replays is not counted, and the replay writes nothing.
// Then the whole registry: every replay owner over legacy shapes of every kind
// it owns, with the legacy state built the way legacy builds it — the
// minutely canonicalization driver and the payouts and media-plane
// projections for what lives in events and projections, the shared ledger,
// ranking and receipt writers for the money facts, the stored rows for the
// audience and the chats. Each owner both matches and names a divergence; a
// new replay kind without a fixture here fails the test.

let testDb: StartedTestDatabase | null = null;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async () => {
  if (testDb) await resetIntegrationDatabase(testDb.pool);
});

function db(): Database {
  return testDb!.db as unknown as Database;
}

function handles() {
  return { db: db(), pool: testDb!.pool };
}

/** A legacy journal row of the page: the body inline, or only in the catalog. */
async function journal(pageId: number, kind: string, payload: unknown, options: { pointerOnly?: boolean; receivedAt?: Date } = {}) {
  const ref = options.pointerOnly === true
    ? await putPayloadObject(db(), {
      representation: "canonical_json",
      json: payload,
      captureInstant: new Date(),
      lane: "platform_capture",
      platformAccountId: pageId,
    })
    : null;
  const inserted = await insertObservation(db(), {
    source: "pull",
    producer: "fansly-legacy-fixture",
    platform: "fansly",
    accountId: pageId,
    nativeAccountRef: HARNESS_OWN_REF,
    kind,
    payload,
    payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest(),
    idempotencyKey: `replay-fixture:${randomUUID()}`,
    ...(options.receivedAt === undefined ? {} : { receivedAt: options.receivedAt }),
    ...(ref === null ? {} : { payloadRef: { bucketMonth: ref.bucketMonth, objectId: ref.objectId }, omitInlinePayload: true }),
  });
  return { id: inserted.observationId, receivedAt: inserted.receivedAt, payload };
}

describe("resource replay over the journal", () => {
  it("every replayed kind through its owner, inline and pointer-only alike: matches counted, every mismatch named", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedHarnessPage(handles(), { mode: "shadow" });

    // account.poll: the served account is the page's own.
    const account = (id: string) => ({ account: { id, username: "harness", displayName: null, createdAt: 0, followCount: 0, subscriberCount: 0 } });
    await journal(pageId, "account_me", account(HARNESS_OWN_REF));
    const accountPointer = await journal(pageId, "account_me", account(HARNESS_OWN_REF), { pointerOnly: true });
    const accountOther = await journal(pageId, "account_me", account("300000000000000999"));

    // dm-messages.head: a /message page against the rows legacy stored. The
    // pages were journaled after legacy wrote the rows.
    const chats = new FakeChats();
    const chat = chats.add({ count: 6, ageMs: 86_400_000 });
    await seedChatThread(handles(), pageId, chat, { stored: chat.messages });
    const later = new Date(Date.now() + 60_000);
    const page = { messages: chats.page(chat.groupId, null, 25) };
    const dmPointer = await journal(pageId, "dm_messages", page, { pointerOnly: true, receivedAt: later });
    const edited = { messages: page.messages.map((message, index) => (index === 2 ? { ...message, content: "edited" } : message)) };
    const dmEdited = await journal(pageId, "dm_messages", edited, { receivedAt: later });

    // notifications.forward: its whole effect is its canonical events; one
    // body was canonicalized by legacy, the other never was.
    const notified = await journal(pageId, "notifications", notificationsEnvelope([notificationRow(1), notificationRow(2)]));
    const family = familyForObservation({ source: "pull", kind: "notifications", platform: "fansly" })!;
    await db().transaction(async (tx) => {
      await canonicalizeObservationInTransaction(tx as unknown as Database, family, {
        id: notified.id, source: "pull", producer: "fansly-legacy-fixture", platform: "fansly", accountId: pageId,
        kind: "notifications", payload: notified.payload, observedAt: null, receivedAt: notified.receivedAt,
      }, { nativeAccountRefByAccountId: new Map([[pageId, HARNESS_OWN_REF]]) });
    });
    const neverApplied = await journal(pageId, "notifications", notificationsEnvelope([notificationRow(3)]), { pointerOnly: true });

    // A kind no entry replays is not the harness's business.
    await journal(pageId, "account_me:failed", { status: 500, bodyText: "{}" });

    const pointerOnly = await testDb.pool.query<{ id: string }>(
      "select id::text from observations where account_id = $1 and payload is null order by id", [pageId]);
    expect(pointerOnly.rows.map((row) => Number(row.id))).toEqual([accountPointer.id, dmPointer.id, neverApplied.id]);

    const before = await tableCounts(testDb.pool);
    const tallies = await replayPageJournal(handles(), { pageId, registry: createFanslyRegistry() });
    expect(changedTables(before, await tableCounts(testDb.pool))).toEqual([]);

    expect(tallies.map(({ resource, kind, total, matched, mismatches, notReplayable }) => ({
      resource, kind, total, matched, mismatches, notReplayable,
    }))).toEqual([
      {
        resource: "account.poll", kind: "account_me", total: 3, matched: 2,
        mismatches: [{ observationId: accountOther.id, reason: "account_differs" }], notReplayable: [],
      },
      {
        resource: "dm-messages.head", kind: "dm_messages", total: 2, matched: 1,
        mismatches: [{ observationId: dmEdited.id, reason: "rows_differ" }], notReplayable: [],
      },
      {
        resource: "notifications.forward", kind: "notifications", total: 2, matched: 1,
        mismatches: [{ observationId: neverApplied.id, reason: "events_missing" }], notReplayable: [],
      },
    ]);
  });

  it("a page whose identity is unknown cannot be judged: its bodies are counted as not replayable, never as matches", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedHarnessPage(handles(), { mode: "shadow" });
    await testDb.pool.query("update pages set external_page_id = null where id = $1", [pageId]);
    const served = await journal(pageId, "account_me", {
      account: { id: HARNESS_OWN_REF, username: "harness", displayName: null, createdAt: 0, followCount: 0, subscriberCount: 0 },
    }, { pointerOnly: true });
    const tallies = await replayPageJournal(handles(), { pageId, registry: createFanslyRegistry(), kinds: ["account_me"] });
    expect(tallies).toEqual([{
      resource: "account.poll", kind: "account_me", total: 1, matched: 0, mismatches: [],
      notReplayable: [{ observationId: served.id, reason: "page_without_identity" }],
    }]);
  });
});

// ── the whole registry ──────────────────────────────────────────────────────

const FIXTURES = path.resolve("tests/fixtures");

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8")) as Record<string, unknown>;
}

/** The served answer inside a captured `{data: {success, response}}` file. */
function served(name: string): unknown {
  return (fixture(name).data as { response: unknown }).response;
}

/** The same body about other objects: every `from` becomes `to`. */
function retarget(body: unknown, from: string, to: string): unknown {
  return JSON.parse(JSON.stringify(body).split(from).join(to)) as unknown;
}

const FAN = "500000000000000021";
const BUYER = "500000000000000011";
const OFFER = "880000000000000002";
const HOUR = 3_600_000;

function transaction(id: string, fanRef: string) {
  return {
    walletId: "wallet-1", transactionId: id, accountId: HARNESS_OWN_REF, correlationId: null, correlationAccountId: fanRef,
    type: 7001, destination: 1, amount: 10_000, destinationTax: 2_000, destinationAmount: 8_000, newBalance: null,
    newBalance64: 100_000, createdAt: Date.now() - HOUR, updatedAt: null, status: 1, senderId: fanRef, receiverId: HARNESS_OWN_REF,
  };
}

function order(orderId: string, buyer: string) {
  return { orderId, accountId: buyer, accountMediaId: OFFER, createdAt: Math.floor(Date.now() / 1000) - 60, type: 1 };
}

const spender = (fanRef: string) => ({ totalGross: 9_000, totalNet: 8_800, accountId: HARNESS_OWN_REF, correlationAccountId: fanRef });
const lifetime = (fanRef: string) => [{ correlationAccountId: fanRef, type: 7001, totalGross: 1_000, totalNet: 800 }];
const monthly = (fanRef: string) => [{ correlationAccountId: fanRef, type: 7001, totalGross: 1_000, totalNet: 800, year: 2026, month: 9 }];

type Expected = { kind: "match" } | { kind: "mismatch"; reason: string };

interface Entry {
  kind: string;
  payload: unknown;
  expect: Expected;
  receivedAt?: Date;
  /** What legacy wrote for this observation, once it is journaled. */
  legacy?: (observation: { id: number; receivedAt: Date; payload: unknown }) => Promise<void>;
}

const MATCH: Expected = { kind: "match" };
const mismatch = (reason: string): Expected => ({ kind: "mismatch", reason });

/** The kinds legacy turns into canonical events with its minutely driver
 *  (and, for payouts and media orders, the projections after it). */
function driverKinds(entries: readonly Entry[]): string[] {
  const direct = new Set([
    "account_me", "dm_conversations", "group_detail", "dm_messages", "earnings_transactions", "earnings_accounts",
    "fan_earnings_stats", "fan_earnings_monthly", "subscribers", "followers", "account_lookup",
  ]);
  return [...new Set(entries.map((entry) => entry.kind).filter((kind) => !direct.has(kind)))];
}

describe("every replay owner of the registry", () => {
  it("over legacy shapes of every kind it owns: what legacy stored matches, a divergence is named, nothing is written", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedHarnessPage(handles(), { mode: "shadow" });
    const app = { db: testDb.db, logger: { info: () => {}, warn: () => {}, error: () => {} } } as never;

    // ── what legacy stored before the journal rows below were read ──
    const chats = new FakeChats();
    const chat = chats.add({ count: 6, ageMs: 86_400_000 });
    await seedChatThread(handles(), pageId, chat, { stored: chat.messages });
    // The captured list and detail name `group_alpha` with `acct_fan_alpha`.
    await seedChatThread(handles(), pageId, { groupId: "group_alpha", fanRef: "acct_fan_alpha", messages: [] });
    const [fanAlpha, known] = await upsertFans(db(), [
      { platform: "fansly", platformUserId: "acct_fan_alpha" },
      { platform: "fansly", platformUserId: FAN },
    ]);
    await testDb.pool.query(
      "insert into page_fans (fan_id, platform_account_id) values ($1, $3), ($2, $3) on conflict do nothing",
      [fanAlpha!.id, known!.id, pageId],
    );
    await testDb.pool.query(
      `insert into page_subscriptions (platform_subscription_id, platform_account_id, fan_id, raw_status, canonical_status,
              price_mills, renew_price_mills, is_current, last_seen_at)
       values ('subscription_alpha', $1, $2, 3, 'active', 1234, 1456, true, clock_timestamp() - interval '1 hour')`,
      [pageId, fanAlpha!.id],
    );
    await testDb.pool.query(
      `insert into page_follows (platform_account_id, fan_id, platform_follow_id, followed_at, is_active)
       values ($1, $2, '863308077229670400', clock_timestamp() - interval '1 day', true)`,
      [pageId, fanAlpha!.id],
    );
    const windowEnd = new Date();
    await upsertPageTopSpenders(db(), [{
      platformAccountId: pageId, sourceIdentityKey: `fan:${FAN}`, correlationAccountId: FAN, fanId: known!.id,
      grossAmountMills: 9_000n, creatorNetAmountMills: 8_800n,
      sourceWindowStartedAt: new Date(windowEnd.getTime() - 7 * 24 * HOUR), sourceWindowEndedAt: windowEnd,
    }]);
    await markFanEarningsDirty(db(), { pageId, fanRefs: [FAN], now: new Date() });

    /** The ledger rows of a served transactions page, as the one Fansly writer stores them. */
    const ledger = async (observation: { id: number; payload: unknown }) => {
      const parsed = fanslyWireSpec("transactions.page").parse(observation.payload, { limit: 100, offset: 0 });
      if (!parsed.ok) throw new Error("the transactions fixture must parse");
      for (const item of parsed.value.data) {
        const { row } = mapFanslyTransactionItem(item, 0);
        await upsertFanslyTransactionWithEarningsDirty(db(), {
          platformAccountId: pageId, source: "fansly:rest", fanId: null, sourceObservationId: observation.id, ...row,
        });
      }
    };
    /** The fan-earnings receipt legacy settled for this observation. */
    const receipt = (window: "lifetime" | "monthly") => async (observation: { id: number; receivedAt: Date; payload: unknown }) => {
      const built = buildFanEarningsReceipt({
        pageId, fanRef: FAN, window, observationId: observation.id, payload: observation.payload, checkedAt: observation.receivedAt,
      });
      expect(built.outcome).toBe("observed");
      await testDb!.pool.query(
        `update subject_refresh_state set last_checked_observation_id = $4, last_content_fingerprint = $5
          where page_id = $1 and plane = $2 and subject_ref = $3`,
        [pageId, window === "lifetime" ? "fan_earnings_lifetime" : "fan_earnings_monthly", FAN, observation.id, built.fingerprint],
      );
    };

    const dmPage = { messages: chats.page(chat.groupId, null, 25) };
    const later = new Date(Date.now() + 60_000);
    const list = served("fansly/messaging_groups.json");
    const detail = served("fansly/group_detail.json");
    const posts = (id: string) => ({ posts: [{ id, accountId: HARNESS_OWN_REF, content: "a post", createdAt: 1_786_000_000, attachments: [] }] });
    const tips = [{ id: "tip-1", senderId: FAN, receiverId: HARNESS_OWN_REF, amount: 250_000, message: "for you", createdAt: 1_786_000_100, targetId: "post-1" }];
    const catalog = (name: string) => fixture(`fansly-catalog/${name}.json`);
    const stats = (name: string) => fixture(`fansly-stats/${name}.json`);
    const rows = (name: string) => stats(name).rows;
    const payoutRequests = fixture("fansly-payouts/payout-requests-page.json").page;

    // What legacy read and applied: every one matches.
    const applied: Entry[] = [
      { kind: "account_me", payload: { account: { id: HARNESS_OWN_REF, username: "harness", displayName: null, createdAt: 0 } }, expect: MATCH },
      { kind: "dm_conversations", payload: list, expect: MATCH },
      { kind: "group_detail", payload: detail, expect: MATCH },
      { kind: "dm_messages", payload: dmPage, expect: MATCH, receivedAt: later },
      { kind: "earnings_transactions", payload: { total: 1, data: [transaction("tx-1", FAN)] }, expect: MATCH, legacy: ledger },
      { kind: "earnings_accounts", payload: [spender(FAN)], expect: MATCH },
      { kind: "fan_earnings_stats", payload: lifetime(FAN), expect: MATCH, legacy: receipt("lifetime") },
      { kind: "fan_earnings_monthly", payload: monthly(FAN), expect: MATCH, legacy: receipt("monthly") },
      { kind: "purchase_history", payload: { accountMediaOrderHistory: [order("9001", BUYER)] }, expect: MATCH },
      { kind: "payout_methods", payload: fixture("fansly-payouts/payout-methods.json").rows, expect: MATCH },
      { kind: "payout_requests", payload: payoutRequests, expect: MATCH },
      { kind: "subscribers", payload: served("fansly/subscribers.json"), expect: MATCH },
      { kind: "followers", payload: served("fansly/followers.json"), expect: MATCH },
      { kind: "account_lookup", payload: [{ id: "acct_fan_alpha", username: "fixture_fan", displayName: null, createdAt: 0 }], expect: MATCH },
      { kind: "notifications", payload: notificationsEnvelope([notificationRow(1), notificationRow(2)]), expect: MATCH },
      { kind: "posts", payload: posts("post-1"), expect: MATCH },
      { kind: "post_tips", payload: tips, expect: MATCH },
      { kind: "post_replies", payload: fixture("fansly-comments/replies-four-with-accounts.json"), expect: MATCH },
      ...["vault_albums", "uservault_albums", "subscription_tiers", "gift_codes", "automated_messages", "account_walls"].map((kind) => ({
        kind, payload: catalog(kind.replaceAll("_", "-")), expect: MATCH,
      })),
      { kind: "vault_media", payload: catalog("vault-media-page"), expect: MATCH },
      { kind: "account_media_batch", payload: catalog("account-media-batch"), expect: MATCH },
      { kind: "account_media_bundle_batch", payload: catalog("account-media-bundle-batch"), expect: MATCH },
      { kind: "media_offer_stats", payload: stats("media-offer-stats"), expect: MATCH },
      { kind: "account_stats", payload: stats("stats-account-daily"), expect: MATCH },
      { kind: "earnings_stats_snapshot", payload: rows("earnings-stats"), expect: MATCH },
      { kind: "earnings_monthlystats_snapshot", payload: rows("earnings-monthlystats"), expect: MATCH },
      { kind: "tracking_links", payload: rows("tracking-links"), expect: MATCH },
      { kind: "discovery_feed", payload: stats("discovery-feed"), expect: MATCH },
      { kind: "broadcast_stats", payload: stats("broadcast-stats"), expect: MATCH },
      { kind: "broadcast_stats_deleted", payload: stats("broadcast-stats"), expect: MATCH },
      { kind: "broadcast_scheduled", payload: stats("broadcast-scheduled"), expect: MATCH },
      { kind: "polls", payload: rows("polls"), expect: MATCH },
      { kind: "recapstats", payload: rows("recapstats"), expect: MATCH },
    ];
    // What legacy journaled but never stored the way the body says: each
    // owner names its divergence.
    const diverged: Entry[] = [
      { kind: "account_me", payload: { account: { id: "300000000000000999", username: "other", displayName: null, createdAt: 0 } }, expect: mismatch("account_differs") },
      { kind: "dm_conversations", payload: retarget(list, "group_alpha", "group_omega"), expect: mismatch("threads_missing") },
      // A direct chat (the page and one fan) legacy has no thread for and no
      // deferral of its own on record.
      {
        kind: "group_detail",
        payload: retarget(retarget(detail, "group_alpha", "group_omega"), "acct_creator", HARNESS_OWN_REF),
        expect: mismatch("thread_missing"),
      },
      {
        kind: "dm_messages",
        payload: { messages: dmPage.messages.map((message, index) => (index === 1 ? { ...message, content: "edited" } : message)) },
        expect: mismatch("rows_differ"),
        receivedAt: later,
      },
      { kind: "earnings_transactions", payload: { total: 1, data: [transaction("tx-2", FAN)] }, expect: mismatch("ledger_differs") },
      { kind: "earnings_accounts", payload: [spender("500000000000000099")], expect: mismatch("rankings_missing") },
      { kind: "fan_earnings_stats", payload: lifetime("500000000000000098"), expect: mismatch("no_receipt") },
      { kind: "purchase_history", payload: { accountMediaOrderHistory: [order("9002", "500000000000000097")] }, expect: mismatch("orders_missing") },
      { kind: "payout_requests", payload: retarget(payoutRequests, "000900000000008001", "000900000000008091"), expect: mismatch("rows_missing") },
      { kind: "subscribers", payload: retarget(served("fansly/subscribers.json"), "subscription_alpha", "subscription_omega"), expect: mismatch("subscriptions_differ") },
      { kind: "followers", payload: retarget(served("fansly/followers.json"), "863308077229670400", "863308077229670499"), expect: mismatch("follows_differ") },
      { kind: "account_lookup", payload: [{ id: "acct_fan_omega", username: "other_fan", displayName: null, createdAt: 0 }], expect: mismatch("fans_missing") },
      { kind: "notifications", payload: notificationsEnvelope([notificationRow(3)]), expect: mismatch("events_missing") },
      { kind: "posts", payload: posts("post-2"), expect: mismatch("events_missing") },
      // The events of these name the observation that carried them.
      { kind: "post_replies", payload: fixture("fansly-comments/replies-four-with-accounts.json"), expect: mismatch("events_missing") },
      { kind: "vault_albums", payload: catalog("vault-albums"), expect: mismatch("events_missing") },
      { kind: "vault_media", payload: catalog("vault-media-page"), expect: mismatch("events_missing") },
      // These are keyed by content: a body about other objects.
      { kind: "account_media_bundle_batch", payload: retarget(catalog("account-media-bundle-batch"), "000900000000000651", "000900000000000659"), expect: mismatch("events_missing") },
      { kind: "media_offer_stats", payload: retarget(stats("media-offer-stats"), "000900000000004001", "000900000000004091"), expect: mismatch("events_missing") },
      { kind: "polls", payload: retarget(rows("polls"), "000900000000000015", "000900000000000095"), expect: mismatch("events_missing") },
    ];

    const journaled: Array<Entry & { observationId: number }> = [];
    const put = async (entry: Entry) => {
      // Every other body lives only in the content-addressed catalog.
      const observation = await journal(pageId, entry.kind, entry.payload, {
        pointerOnly: journaled.length % 2 === 1,
        ...(entry.receivedAt === undefined ? {} : { receivedAt: entry.receivedAt }),
      });
      journaled.push({ ...entry, observationId: observation.id });
      await entry.legacy?.(observation);
    };
    for (const entry of applied) await put(entry);
    // Legacy's minutely driver and its projections over what it read.
    const canonicalized = await runCanonicalization(app, { kinds: driverKinds(applied) });
    expect(canonicalized).toMatchObject({ errored: 0, quarantined: 0, skippedUnavailable: 0, skippedUnparseable: 0, partitionBlocked: 0 });
    await runFanslyPayoutsProjection(app, { accountId: pageId });
    await runMediaPlaneProjection(app, { accountId: pageId });
    for (const entry of diverged) await put(entry);
    expect(await testDb.pool.query("select count(*)::int as n from observations where account_id = $1 and payload is null", [pageId]))
      .toMatchObject({ rows: [{ n: Math.floor(journaled.length / 2) }] });

    const before = await tableCounts(testDb.pool);
    const tallies = await replayPageJournal(handles(), { pageId, registry: createFanslyRegistry() });
    expect(changedTables(before, await tableCounts(testDb.pool))).toEqual([]);

    // Every journaled body got the verdict its case says, under its owner.
    const ownerOf = new Map(FANSLY_RESOURCE_SPECS.flatMap((spec) => (spec.replayKinds ?? []).map((kind) => [kind as string, spec.key] as const)));
    const expected = new Map<string, ReplayTally>();
    for (const entry of journaled) {
      const resource = ownerOf.get(entry.kind);
      expect(resource, `${entry.kind} has a replay owner`).toBeDefined();
      const key = `${resource}\u0000${entry.kind}`;
      const tally = expected.get(key) ?? { resource: resource!, kind: entry.kind, total: 0, matched: 0, mismatches: [], notReplayable: [] };
      tally.total += 1;
      if (entry.expect.kind === "match") tally.matched += 1;
      else tally.mismatches.push({ observationId: entry.observationId, reason: entry.expect.reason });
      expected.set(key, tally);
    }
    const sorted = (list: readonly ReplayTally[]) => [...list].sort((a, b) => a.resource.localeCompare(b.resource) || a.kind.localeCompare(b.kind));
    expect(tallies).toEqual(sorted([...expected.values()]));

    // The coverage of this file: every kind the registry replays is in the
    // journal, and every owner both matched and named a divergence.
    expect(new Set(tallies.map((tally) => tally.kind))).toEqual(new Set(ownerOf.keys()));
    const owners = new Set(ownerOf.values());
    expect(new Set(tallies.filter((tally) => tally.matched > 0).map((tally) => tally.resource))).toEqual(owners);
    expect(new Set(tallies.filter((tally) => tally.mismatches.length > 0).map((tally) => tally.resource))).toEqual(owners);
  }, 120_000);
});
