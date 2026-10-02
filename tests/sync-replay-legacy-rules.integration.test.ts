import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { insertObservation, type Database } from "@agency_hub_core/db";

import { familyForObservation } from "../apps/runtime/src/services/canonicalize/index.ts";
import { contentHash } from "../apps/runtime/src/services/canonicalize/sync-pull.ts";
import { buildCanonicalDrafts } from "../apps/runtime/src/services/canonicalize-drafts.ts";
import type { ReplayVerdict } from "../apps/runtime/src/sync/engine/resource.ts";
import { canonicalizeObservationInTransaction } from "../apps/runtime/src/sync/engine/canonicalize.ts";
import {
  PRE_122_MEDIA_DURATION_TRUNC,
  PRE_281_CONTENT_KEYED_ROWS,
  truncatedDurationLegacyKey,
} from "../apps/runtime/src/sync/fansly/lib/family-replay.ts";
import { createFanslyRegistry, fanslyReplayOwner } from "../apps/runtime/src/sync/fansly/registry.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { FakeChats, HARNESS_OWN_REF, seedChatThread, seedHarnessPage } from "./helpers/sync-engine.ts";
import { changedTables, tableCounts } from "./helpers/sync-engine-host.ts";

// The named legacy rules of the journal replay (design §3.12 B5,
// `lib/family-replay.ts`, `lib/replay-rules.ts`), each against what legacy
// actually stored on production before 2026-10-02 — and each refused the
// moment its evidence is missing. A rule never skips a reader or a kind
// wholesale: every key or row it accepts is checked, and a match through a
// rule names it.
//
// - #281 content keys: the catalog and comment row events legacy stored under
//   one key per distinct content before 2026-09-29.
// - #122 media durations: the `media:v1` keys hashed over a truncated duration
//   before 2026-09-03.
// - group details: the page's mass-message container is no chat; a direct
//   chat legacy's socket-hint path deferred is legacy's gap (D5).
// - DM rows legacy's journal-only readers never stored: below its window, in
//   a chat it calls complete, or deleted on Fansly first.

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

const FIXTURES = path.resolve("tests/fixtures");

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8")) as Record<string, unknown>;
}

interface Journaled {
  id: number;
  kind: string;
  receivedAt: Date;
  payload: unknown;
}

async function journal(pageId: number, kind: string, payload: unknown, receivedAt?: Date): Promise<Journaled> {
  const inserted = await insertObservation(db(), {
    source: "pull",
    producer: "fansly-legacy-fixture",
    platform: "fansly",
    accountId: pageId,
    nativeAccountRef: HARNESS_OWN_REF,
    kind,
    payload,
    payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest(),
    idempotencyKey: `replay-rules:${randomUUID()}`,
    ...(receivedAt === undefined ? {} : { receivedAt }),
  });
  return { id: inserted.observationId, kind, receivedAt: inserted.receivedAt, payload };
}

/** Legacy's canonicalization of one observation, under today's family. */
async function canonicalize(pageId: number, observation: Journaled): Promise<void> {
  const family = familyForObservation({ source: "pull", kind: observation.kind, platform: "fansly" })!;
  await db().transaction(async (tx) => {
    await canonicalizeObservationInTransaction(tx as unknown as Database, family, {
      id: observation.id, source: "pull", producer: "fansly-legacy-fixture", platform: "fansly", accountId: pageId,
      kind: observation.kind, payload: observation.payload, observedAt: null, receivedAt: observation.receivedAt,
    }, { nativeAccountRefByAccountId: new Map([[pageId, HARNESS_OWN_REF]]) });
  });
}

/** The replay verdict of one observation through the owner of its kind. */
async function replay(pageId: number, observation: Journaled): Promise<ReplayVerdict> {
  const owner = fanslyReplayOwner(observation.kind)!;
  const module = await createFanslyRegistry().module(owner.key);
  return module.replay!(
    { id: observation.id, receivedAt: observation.receivedAt, kind: observation.kind, pageId, payload: observation.payload },
    { db: db(), pageId },
  );
}

/** Replays that write nothing: the table counts before and after. */
async function replayReadOnly(pageId: number, observations: readonly Journaled[]): Promise<ReplayVerdict[]> {
  const before = await tableCounts(testDb!.pool);
  const verdicts: ReplayVerdict[] = [];
  for (const observation of observations) verdicts.push(await replay(pageId, observation));
  expect(changedTables(before, await tableCounts(testDb!.pool))).toEqual([]);
  return verdicts;
}

// ── #281: content-keyed catalog and comment rows ────────────────────────────

const PRE_281 = new Date("2026-09-20T08:00:00Z");
const ROW_V2 = "^(album|tier|tierplan|giftcode|automation|wall|comment|payoutmethod):v2:(.+):obs:";

/** Every event this look minted, written at `at`. */
async function writtenAt(pageId: number, observationId: number, at: Date): Promise<void> {
  await testDb!.pool.query("update domain_events set created_at = $3 where account_id = $1 and observation_id = $2", [pageId, observationId, at]);
}

/** The pre-#281 code's first look at a row: its event under the content key. */
async function rowsContentKeyed(pageId: number, observationId: number): Promise<number> {
  const pattern = `${ROW_V2}${observationId}$`;
  const keys = await testDb!.pool.query(
    "update domain_event_keys set dedup_key = regexp_replace(dedup_key, $2, '\\1:v1:\\2') where account_id = $1 and dedup_key ~ $2",
    [pageId, pattern],
  );
  await testDb!.pool.query(
    "update domain_events set dedup_key = regexp_replace(dedup_key, $3, '\\1:v1:\\2') where account_id = $1 and observation_id = $2 and dedup_key ~ $3",
    [pageId, observationId, pattern],
  );
  return keys.rowCount ?? 0;
}

/** A look whose row events were never written: the pre-#281 dedup against an
 *  earlier look (or, under today's code, a loss). `keep` spares these keys. */
async function rowsNotWritten(pageId: number, observationId: number, keep: (key: string) => boolean = () => false): Promise<void> {
  const rows = await testDb!.pool.query<{ dedup_key: string }>(
    "select dedup_key from domain_events where account_id = $1 and observation_id = $2 and dedup_key ~ $3",
    [pageId, observationId, `${ROW_V2}${observationId}$`],
  );
  const drop = rows.rows.map((row) => row.dedup_key).filter((key) => !keep(key));
  await testDb!.pool.query("delete from domain_event_keys where account_id = $1 and dedup_key = any($2::text[])", [pageId, drop]);
  await testDb!.pool.query("delete from domain_events where account_id = $1 and dedup_key = any($2::text[])", [pageId, drop]);
}

/** Drop one event of this look by key prefix (its roster, say). */
async function dropOwnEvent(pageId: number, observationId: number, prefix: string): Promise<void> {
  const rows = await testDb!.pool.query<{ dedup_key: string }>(
    "select dedup_key from domain_events where account_id = $1 and observation_id = $2 and starts_with(dedup_key, $3)",
    [pageId, observationId, prefix],
  );
  expect(rows.rows.length).toBeGreaterThan(0);
  const keys = rows.rows.map((row) => row.dedup_key);
  await testDb!.pool.query("delete from domain_event_keys where account_id = $1 and dedup_key = any($2::text[])", [pageId, keys]);
  await testDb!.pool.query("delete from domain_events where account_id = $1 and dedup_key = any($2::text[])", [pageId, keys]);
}

const viaRows = (rows: number): ReplayVerdict => ({
  kind: "match",
  detail: expect.objectContaining({ legacyKeys: { [PRE_281_CONTENT_KEYED_ROWS]: rows } }) as never,
  via: [PRE_281_CONTENT_KEYED_ROWS],
});

const eventsMissing = (missing: number): ReplayVerdict => ({
  kind: "mismatch",
  reason: "events_missing",
  detail: expect.objectContaining({ missing }) as never,
});

describe("#281: rows legacy keyed by content", () => {
  it("catalog rows stored under the content key at this look or an earlier one match, and the rule is named", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedHarnessPage(handles(), { mode: "shadow" });
    const albums = fixture("fansly-catalog/vault-albums.json");
    const codes = { rows: fixture("fansly-catalog/gift-codes.json").rows };

    // Look A of each kind: the first sighting, every row under its content key.
    const albumsA = await journal(pageId, "vault_albums", albums);
    const codesA = await journal(pageId, "gift_codes", codes.rows);
    // Look B: the same bodies; the old code wrote no row event (deduped).
    const albumsB = await journal(pageId, "vault_albums", albums);
    const codesB = await journal(pageId, "gift_codes", codes.rows);
    for (const look of [albumsA, codesA, albumsB, codesB]) await canonicalize(pageId, look);
    const albumRows = await rowsContentKeyed(pageId, albumsA.id);
    const codeRows = await rowsContentKeyed(pageId, codesA.id);
    expect(albumRows).toBeGreaterThan(1);
    expect(codeRows).toBeGreaterThan(1);
    await rowsNotWritten(pageId, albumsB.id);
    await rowsNotWritten(pageId, codesB.id);
    for (const look of [albumsA, codesA, albumsB, codesB]) await writtenAt(pageId, look.id, PRE_281);

    expect(await replayReadOnly(pageId, [albumsA, codesA, albumsB, codesB])).toEqual([
      viaRows(albumRows), viaRows(codeRows), viaRows(albumRows), viaRows(codeRows),
    ]);
  });

  it("refuses a row whose content is not stored, content minted only later, a look under today's keys, and a missing roster", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedHarnessPage(handles(), { mode: "shadow" });
    const albums = fixture("fansly-catalog/vault-albums.json") as { albums: Array<Record<string, unknown>> };
    const first = await journal(pageId, "vault_albums", albums);
    await canonicalize(pageId, first);
    const rows = await rowsContentKeyed(pageId, first.id);
    await writtenAt(pageId, first.id, PRE_281);
    expect(await replay(pageId, first)).toEqual(viaRows(rows));

    // One album edited since: its content was never stored (legacy lost the look).
    const edited = structuredClone(albums);
    edited.albums[0] = { ...edited.albums[0], title: "renamed since" };
    const changed = await journal(pageId, "vault_albums", edited);
    await canonicalize(pageId, changed);
    await rowsNotWritten(pageId, changed.id);
    await writtenAt(pageId, changed.id, PRE_281);

    // Content stored only by a later look: an earlier look cannot borrow it.
    const other = { ...albums, albums: albums.albums.map((album) => ({ ...album, itemCount: Number(album.itemCount) + 1 })) };
    const early = await journal(pageId, "vault_albums", other);
    const late = await journal(pageId, "vault_albums", other);
    await canonicalize(pageId, early);
    await rowsNotWritten(pageId, early.id);
    await canonicalize(pageId, late);
    await rowsContentKeyed(pageId, late.id);
    for (const look of [early, late]) await writtenAt(pageId, look.id, PRE_281);

    // Some rows under today's per-look key and the rest only under the old one:
    // today's code ran and lost rows.
    const mixed = await journal(pageId, "vault_albums", albums);
    await canonicalize(pageId, mixed);
    let kept = false;
    await rowsNotWritten(pageId, mixed.id, () => (kept ? false : (kept = true)));
    await writtenAt(pageId, mixed.id, PRE_281);

    // The look's own roster is not stored.
    const rosterless = await journal(pageId, "vault_albums", albums);
    await canonicalize(pageId, rosterless);
    await rowsNotWritten(pageId, rosterless.id);
    await dropOwnEvent(pageId, rosterless.id, "cataloglisting:");
    await writtenAt(pageId, rosterless.id, PRE_281);

    // Today's code wrote the roster and dropped every row (after the cutover).
    const dropped = await journal(pageId, "vault_albums", albums);
    await canonicalize(pageId, dropped);
    await rowsNotWritten(pageId, dropped.id);

    const verdicts = await replayReadOnly(pageId, [changed, early, mixed, rosterless, dropped]);
    expect(verdicts[0]).toEqual({
      kind: "mismatch",
      reason: "events_missing",
      detail: expect.objectContaining({ missing: 1, legacyKeys: { [PRE_281_CONTENT_KEYED_ROWS]: rows - 1 } }),
    });
    expect(verdicts[1]).toEqual(eventsMissing(rows));
    expect(verdicts[2]).toEqual(eventsMissing(rows - 1));
    expect(verdicts[3]).toEqual({
      kind: "mismatch",
      reason: "events_missing",
      detail: expect.objectContaining({ missing: 1, examples: [expect.stringMatching(/^cataloglisting:/)] }),
    });
    expect(verdicts[4]).toEqual(eventsMissing(rows));
  });

  it("comment rows follow the same rule", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedHarnessPage(handles(), { mode: "shadow" });
    const replies = fixture("fansly-comments/replies-four-with-accounts.json");
    const first = await journal(pageId, "post_replies", replies);
    const again = await journal(pageId, "post_replies", replies);
    const today = await journal(pageId, "post_replies", replies);
    for (const look of [first, again, today]) await canonicalize(pageId, look);
    const rows = await rowsContentKeyed(pageId, first.id);
    expect(rows).toBe(4);
    await rowsNotWritten(pageId, again.id);
    await rowsNotWritten(pageId, today.id);
    for (const look of [first, again]) await writtenAt(pageId, look.id, PRE_281);
    expect(await replayReadOnly(pageId, [first, again, today])).toEqual([viaRows(4), viaRows(4), eventsMissing(4)]);
  });
});

// ── #122: truncated media durations ─────────────────────────────────────────

describe("#122: media keys hashed over a truncated duration", () => {
  const stats = fixture("fansly-stats/stats-account-daily.json") as {
    aggregationData: { accountMedia: Array<Record<string, unknown>> };
  } & Record<string, unknown>;

  /** The stats body with one video of `seconds` under the offer `offerRef`. */
  function body(offerRef: string, seconds: number): Record<string, unknown> {
    const payload = structuredClone(stats);
    const row = payload.aggregationData.accountMedia[0]!;
    const media = row.media as Record<string, unknown>;
    const metadata = JSON.parse(media.metadata as string) as Record<string, unknown>;
    payload.aggregationData.accountMedia[0] = { ...row, id: offerRef, media: { ...media, metadata: JSON.stringify({ ...metadata, duration: seconds }) } };
    return payload;
  }

  /** The look's media draft of this offer, as today's family builds it. */
  function mediaDraft(pageId: number, observation: Journaled, offerRef: string) {
    const family = familyForObservation({ source: "pull", kind: "account_stats", platform: "fansly" })!;
    const outcome = buildCanonicalDrafts(family, {
      id: observation.id, source: "pull", producer: "test", platform: "fansly", accountId: pageId, kind: "account_stats",
      payload: observation.payload, observedAt: null, receivedAt: observation.receivedAt,
    }, { nativeAccountRefByAccountId: new Map([[pageId, HARNESS_OWN_REF]]), now: new Date() });
    if (outcome.kind !== "accepted") throw new Error("the stats body must canonicalize");
    return outcome.drafts.find((draft) => draft.type === "media.observed" && draft.data.mediaOfferRef === offerRef)!;
  }

  /** What the truncating code stored for the draft: `key`, written at `at`. */
  async function storedAs(pageId: number, from: string, key: string, at: Date): Promise<void> {
    await testDb!.pool.query("update domain_event_keys set dedup_key = $3 where account_id = $1 and dedup_key = $2", [pageId, from, key]);
    const moved = await testDb!.pool.query(
      "update domain_events set dedup_key = $3, created_at = $4 where account_id = $1 and dedup_key = $2",
      [pageId, from, key, at],
    );
    expect(moved.rowCount).toBe(1);
  }

  const BEFORE = new Date("2026-09-02T05:02:22Z");
  const AFTER = new Date("2026-09-04T05:02:17Z");

  it("a missing rounded key whose truncated spelling the old code stored matches, named; nothing else does", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedHarnessPage(handles(), { mode: "shadow" });
    const cases = {
      truncated: "900000000000000201",
      receivedAfter: "900000000000000202",
      otherFieldDiffers: "900000000000000203",
      writtenAfter: "900000000000000204",
      untouched: "900000000000000205",
    };
    const looks: Record<string, Journaled> = {};
    for (const [name, offer] of Object.entries(cases)) {
      looks[name] = await journal(pageId, "account_stats", body(offer, 192.866667), name === "receivedAfter" ? AFTER : BEFORE);
      await canonicalize(pageId, looks[name]);
    }
    const legacyKey = (name: keyof typeof cases) => {
      const draft = mediaDraft(pageId, looks[name]!, cases[name]);
      expect(draft.data.durationMs).toBe(192_867);
      return { draft, key: truncatedDurationLegacyKey(draft)! };
    };
    for (const name of ["truncated", "receivedAfter"] as const) {
      const { draft, key } = legacyKey(name);
      await storedAs(pageId, draft.dedupKey, key, BEFORE);
    }
    {
      // The stored row differs in a counter too: another fact, not a spelling.
      const { draft } = legacyKey("otherFieldDiffers");
      const material: Record<string, unknown> = { ...draft.data };
      delete material.contentHash;
      const other = `media:v1:${pageId}:${cases.otherFieldDiffers}:${contentHash({
        ...material, durationMs: 192_866, likeCount: Number(material.likeCount ?? 0) + 1,
      })}`;
      await storedAs(pageId, draft.dedupKey, other, BEFORE);
    }
    {
      // The truncated spelling written after #122 went live: not the old code's.
      const { draft, key } = legacyKey("writtenAfter");
      await storedAs(pageId, draft.dedupKey, key, new Date("2026-09-03T13:47:21Z"));
    }

    const verdicts = await replayReadOnly(pageId, Object.values(looks));
    expect(verdicts[0]).toEqual({
      kind: "match",
      detail: expect.objectContaining({ legacyKeys: { [PRE_122_MEDIA_DURATION_TRUNC]: 1 } }),
      via: [PRE_122_MEDIA_DURATION_TRUNC],
    });
    expect(verdicts[1]).toEqual(eventsMissing(1));
    expect(verdicts[2]).toEqual(eventsMissing(1));
    expect(verdicts[3]).toEqual(eventsMissing(1));
    // Untouched rounded keys: a plain match, no rule.
    expect(verdicts[4]).toEqual({ kind: "match", detail: expect.objectContaining({ drafts: expect.any(Number) }) });
    expect(verdicts[4]).not.toHaveProperty("via");
  });
});

// ── group details ───────────────────────────────────────────────────────────

describe("group details legacy's socket-hint path journaled", () => {
  const FAN = "500000000000000031";
  const LIST = "920000000000000001";

  function detail(groupId: string, members: readonly string[], type = 1) {
    const head = type === 3
      ? { senderId: HARNESS_OWN_REF, type: 3, correlationId: groupId }
      : { senderId: members[0] ?? HARNESS_OWN_REF, type: 1, correlationId: null };
    return {
      id: groupId,
      type,
      groupFlags: type === 3 ? 62 : 0,
      createdBy: HARNESS_OWN_REF,
      users: [HARNESS_OWN_REF, ...members].map((userId) => ({ groupId, userId, type: 0, permissionFlags: 0 })),
      ...(type === 3 ? { recipients: [{ id: LIST, type: 30001 }] } : {}),
      lastMessage: {
        id: "960676759517286400", dataVersion: 1, content: "hey", groupId, inReplyTo: null, inReplyToRoot: null,
        createdAt: 1_790_537_547, attachments: [], embeds: [], interactions: [], likes: [], ...head,
      },
    };
  }

  async function deferred(pageId: number, groupId: string, captured: boolean): Promise<void> {
    await testDb!.pool.query(
      `insert into subject_refresh_state (page_id, plane, subject_ref, last_refresh_outcome, backfill_cursor, consecutive_failures)
       values ($1, 'fansly_ws_dm', $2, 'membership_pending', $3::jsonb, 18)`,
      [pageId, groupId, JSON.stringify({ revision: 1, generation: "g", groupDetailCaptured: captured })],
    );
  }

  it("a container is no chat, a direct chat legacy deferred is its named gap, any other missing thread a mismatch", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedHarnessPage(handles(), { mode: "shadow" });
    const container = await journal(pageId, "group_detail", detail("960676540402638848", [], 3));
    const several = await journal(pageId, "group_detail", detail("960676540402638849", [FAN, "500000000000000032"]));
    const pending = await journal(pageId, "group_detail", detail("962163412371009536", [FAN]));
    await deferred(pageId, "962163412371009536", true);
    const notCaptured = await journal(pageId, "group_detail", detail("962163412371009537", [FAN]));
    await deferred(pageId, "962163412371009537", false);
    const unexplained = await journal(pageId, "group_detail", detail("962163412371009538", [FAN]));

    expect(await replayReadOnly(pageId, [container, several, pending, notCaptured, unexplained])).toEqual([
      { kind: "match", detail: { notAChat: true, members: 0, type: 3 }, via: ["detail_not_a_chat"] },
      { kind: "match", detail: { notAChat: true, members: 2, type: 1 }, via: ["detail_not_a_chat"] },
      { kind: "not_replayable", reason: "legacy_ws_hint_membership_pending" },
      { kind: "mismatch", reason: "thread_missing", detail: { groupId: "962163412371009537" } },
      { kind: "mismatch", reason: "thread_missing", detail: { groupId: "962163412371009538" } },
    ]);
  });
});

// ── DM rows legacy never stored ─────────────────────────────────────────────

describe("DM pages legacy's journal-only readers read", () => {
  it("rows below legacy's window, in a chat it calls complete, or deleted on Fansly first are named; a hole never is", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedHarnessPage(handles(), { mode: "shadow" });
    const chats = new FakeChats();
    const later = new Date(Date.now() + 60_000);
    const page = (groupId: string, before: string | null, limit: number) => ({ messages: chats.page(groupId, before, limit) });

    // Legacy stored k = 10..12 of a 13-message chat.
    const chat = chats.add({ count: 13, ageMs: 86_400_000 });
    const k = (n: number) => chat.messages[n]!.id;
    await seedChatThread(handles(), pageId, chat, { stored: chat.messages.slice(10) });
    const below = await journal(pageId, "dm_messages", page(chat.groupId, k(6), 5), later); // k = 5..1
    const across = await journal(pageId, "dm_messages", page(chat.groupId, k(12), 3), later); // k = 11, 10, 9
    // A fast-lane head read of k = 13, deleted on Fansly seconds later.
    chats.append(chat.groupId, 1, "fan", Date.now() - 500);
    const deletedHead = await journal(pageId, "dm_messages", page(chat.groupId, null, 3), later); // k = 13, 12, 11
    await testDb.pool.query(
      `insert into fansly_ws_hint_receipts (event_id, page_id, observation_id, received_at, generation, group_ref, message_ref, outcome)
       values (987654321, $1, 1, clock_timestamp(), 'g', $2, $3, 'mutation_debt')`,
      [pageId, chat.groupId, k(13)],
    );
    const editedBelow = await journal(pageId, "dm_messages", {
      messages: page(chat.groupId, k(12), 3).messages.map((message, index) => (index === 1 ? { ...message, content: "edited" } : message)),
    }, later);

    // A hole inside the stored window: 10 and 12 stored, 11 not.
    const holed = chats.add({ count: 13, ageMs: 86_400_000 });
    await seedChatThread(handles(), pageId, holed, { stored: [holed.messages[10]!, holed.messages[12]!] });
    const hole = await journal(pageId, "dm_messages", page(holed.groupId, null, 3), later);
    // The same head read of a new row without a deletion receipt.
    const fresh = chats.add({ count: 13, ageMs: 86_400_000 });
    await seedChatThread(handles(), pageId, fresh, { stored: fresh.messages.slice(10, 12) });
    const unreceipted = await journal(pageId, "dm_messages", page(fresh.groupId, null, 3), later);

    // A chat legacy marks complete, served older history.
    const claimed = chats.add({ count: 13, ageMs: 86_400_000 });
    const claimedThread = await seedChatThread(handles(), pageId, claimed, { stored: claimed.messages.slice(10) });
    await testDb.pool.query("update page_dm_threads set message_coverage_status = 'complete' where id = $1", [claimedThread]);
    const claimedBelow = await journal(pageId, "dm_messages", page(claimed.groupId, claimed.messages[6]!.id, 5), later);

    // A chat legacy stored nothing of.
    const empty = chats.add({ count: 5, ageMs: 86_400_000 });
    await seedChatThread(handles(), pageId, empty, { stored: [] });
    const nothingStored = await journal(pageId, "dm_messages", page(empty.groupId, null, 3), later);

    const verdicts = await replayReadOnly(pageId, [
      below, across, deletedHead, editedBelow, hole, unreceipted, claimedBelow, nothingStored,
    ]);
    expect(verdicts).toEqual([
      { kind: "not_replayable", reason: "legacy_unstored_below_window" },
      {
        kind: "match",
        detail: { served: 3, compared: 2, unparseable: 0, legacyGap: { legacy_unstored_below_window: 1 } },
        via: ["legacy_unstored_below_window"],
      },
      {
        kind: "match",
        detail: { served: 3, compared: 2, unparseable: 0, legacyGap: { legacy_unstored_deleted_on_platform: 1 } },
        via: ["legacy_unstored_deleted_on_platform"],
      },
      {
        kind: "mismatch",
        reason: "rows_differ",
        detail: { served: 3, missing: 0, differs: 1, examples: [k(10)], legacyGap: { legacy_unstored_below_window: 1 } },
      },
      { kind: "mismatch", reason: "rows_missing", detail: { served: 3, missing: 1, differs: 0, examples: [holed.messages[11]!.id] } },
      { kind: "mismatch", reason: "rows_missing", detail: { served: 3, missing: 1, differs: 0, examples: [fresh.messages[12]!.id] } },
      { kind: "not_replayable", reason: "legacy_unstored_below_complete_claim" },
      {
        kind: "mismatch",
        reason: "rows_missing",
        detail: { served: 3, missing: 3, differs: 0, examples: empty.messages.slice(2).map((message) => message.id).reverse() },
      },
    ]);
  });

  it("a page of rows all deleted on Fansly before legacy stored them is not replayable under that name", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedHarnessPage(handles(), { mode: "shadow" });
    const chats = new FakeChats();
    const chat = chats.add({ count: 3, ageMs: 86_400_000 });
    await seedChatThread(handles(), pageId, chat, { stored: chat.messages.slice(0, 2) });
    const head = await journal(pageId, "dm_messages", { messages: chats.page(chat.groupId, null, 1) }, new Date(Date.now() + 60_000));
    await testDb.pool.query(
      `insert into fansly_ws_hint_receipts (event_id, page_id, observation_id, received_at, generation, group_ref, message_ref, outcome)
       values (987654322, $1, 1, clock_timestamp(), 'g', $2, $3, 'mutation_debt')`,
      [pageId, chat.groupId, chat.messages[2]!.id],
    );
    expect(await replayReadOnly(pageId, [head])).toEqual([{ kind: "not_replayable", reason: "legacy_unstored_deleted_on_platform" }]);
  });
});
