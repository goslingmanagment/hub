import { appendFileSync } from "node:fs";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ensurePollRows,
  getSyncPage,
  listSyncPages,
  upsertDemand,
  upsertFans,
  type Database,
} from "@agency_hub_core/db";
import type { FanslyWireOutcome, FanslyWireRequest } from "@agency_hub_core/fansly";

import { readSyncAlertStatus } from "../apps/runtime/src/sync/engine/alerts.ts";
import { pollsFor, type EngineRegistry } from "../apps/runtime/src/sync/engine/resource.ts";
import { createFanslyRegistry, FANSLY_RESOURCE_SPECS, fanslyResourceSpec } from "../apps/runtime/src/sync/fansly/registry.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import {
  makeTestActor,
  okResponse,
  RecordingAlerts,
  RecordingMetrics,
  ScriptedLiveTransport,
  seedSyncPage,
  statusResponse,
  waitFor,
} from "./helpers/sync-engine-host.ts";
import { replaceHoldRows, resourceBreakerRow } from "./helpers/sync-holds.ts";

// Bug hunt 2026-10-09, skeptic of SIL-3 and SIL-4 (scratch, not for merge).
// Production functions against a real Postgres; the real actor where a
// breaker must be armed by real failures.

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

const OWN_ID = "300000000000000001";
const GROUP = "400000000000000001";
const GROUP2 = "400000000000000002";
const HOUR = 3_600_000;
const NOW_MS = Date.now();
const fanslyRegistry = createFanslyRegistry();

const pad = (n: number, width: number) => String(n).padStart(width, "0");
const groupOf = (n: number) => `71000000000${pad(n, 7)}`;
const fanOf = (n: number) => `51000000000${pad(n, 7)}`;
const messageOf = (n: number, k = 0) => `91${pad(k, 3)}00000${pad(n, 8)}`;

function record(name: string, value: unknown): void {
  const out = process.env.BUGHUNT_OUT;
  if (out === undefined) return;
  appendFileSync(out, `${JSON.stringify({ name, at: new Date().toISOString(), value }, (_key, item) => (typeof item === "bigint" ? item.toString() : item))}\n`);
}

async function seedPage(): Promise<{ pageId: number; label: string }> {
  const seeded = await seedSyncPage({ db: db(), pool: testDb!.pool }, { mode: "live", guard: "fansly_sync_engine" });
  await testDb!.pool.query(
    "update pages set external_page_id = $2, metadata = $3::jsonb, last_verified_at = clock_timestamp() where id = $1",
    [seeded.pageId, OWN_ID, JSON.stringify({ accountCreatedAt: "2026-08-15T00:00:00.000Z" })],
  );
  await testDb!.pool.query(
    `update sync_pages set owner_heartbeat_at = clock_timestamp(),
            legacy_imported_at = clock_timestamp() - interval '1 day', mode_changed_at = clock_timestamp() - interval '1 day'
      where page_id = $1`,
    [seeded.pageId],
  );
  return seeded;
}

async function parkStandingRows(pageId: number, registry: EngineRegistry): Promise<void> {
  const page = await getSyncPage(db(), pageId);
  await ensurePollRows(db(), { pageId, polls: pollsFor(registry, page!).map((poll) => ({ ...poll, phase: 0.999 })) });
}

async function makeDue(pageId: number, resource: string, extra: { subject?: string; messageIds?: string[] } = {}) {
  const spec = fanslyResourceSpec(resource)!;
  await upsertDemand(db(), {
    pageId,
    resource,
    kind: spec.kind,
    class: spec.class,
    ...(extra.subject === undefined ? {} : { subject: extra.subject }),
    demand: { messageIds: extra.messageIds ?? [], reasons: ["test"] },
  });
}

async function conditionsOf(label: string) {
  const status = await readSyncAlertStatus(db(), { registry: fanslyRegistry, pages: await listSyncPages(db()) });
  return status.pages.find((entry) => entry.page === label)!.conditions;
}

function reasonsOf(conditions: Awaited<ReturnType<typeof conditionsOf>>, subKey: string) {
  return conditions.find((entry) => entry.subKey === subKey)?.reasons ?? [];
}

function detailsOf(conditions: Awaited<ReturnType<typeof conditionsOf>>, subKey: string): string[] {
  return reasonsOf(conditions, subKey).map((reason) => reason.detail);
}

async function resourceHolds(pageId: number) {
  const result = await testDb!.pool.query<{ key: string; until: Date; ladder_step: number; since: Date }>(
    "select key, until, ladder_step, since from sync_holds where page_id = $1 and scope = 'resource' order by key",
    [pageId],
  );
  return result.rows;
}

/** Thread rows as the dm-list tests seed them (straight rows). */
async function seedThread(pageId: number, n: number, options: { partner: string | null; headId: string | null; metadata?: Record<string, unknown> }) {
  let fanId: number | null = null;
  if (options.partner !== null) {
    const fans = await upsertFans(db(), [{ platform: "fansly" as const, platformUserId: options.partner }]);
    fanId = fans[0]!.id;
  }
  await testDb!.pool.query(
    `insert into page_dm_threads (platform_account_id, platform_conversation_id, fan_id, partner_platform_user_id,
            partner_username, conversation_flags, unread_count, last_message_id, last_message_at, last_message_sender_id,
            last_message_sender_role, last_message_preview, newest_stored_message_id, stored_message_count,
            message_coverage_status, last_message_sync_at, is_visible, metadata)
     values ($1, $2, $3, $4, $5, 0, 0, $6, case when $6::text is null then null else clock_timestamp() - interval '2 hours' end, $4,
             case when $4::text is null then 'unknown' else 'fan' end::dm_sender_role, 'stored preview', $6, 0,
             'partial_window', timestamptz '2026-09-01T00:00:00Z', true, $7::jsonb)`,
    [pageId, groupOf(n), fanId, options.partner, options.partner === null ? null : `fan${options.partner.slice(-4)}`,
      options.headId, JSON.stringify(options.metadata ?? {})],
  );
}

/** One `/messaging/groups` answer listing chat n with its known head. */
function listPage(n: number) {
  const partner = fanOf(n);
  return {
    data: [{
      account_id: OWN_ID, groupId: groupOf(n), partnerAccountId: partner, partnerUsername: `fan${partner.slice(-4)}`, flags: 0,
      unreadCount: 0, subscriptionTierId: null, lastMessageId: messageOf(n), lastUnreadMessageId: null,
    }],
    aggregationData: {
      accounts: [{ id: partner, username: `fan${partner.slice(-4)}`, displayName: `Fan ${partner.slice(-4)}`, createdAt: Date.UTC(2025, 0, 1) }],
      groups: [{
        id: groupOf(n), type: 1, groupFlags: 0, createdBy: OWN_ID,
        users: [
          { groupId: groupOf(n), userId: OWN_ID, type: 0, permissionFlags: 0 },
          { groupId: groupOf(n), userId: partner, type: 0, permissionFlags: 0 },
        ],
        lastMessage: {
          id: messageOf(n), type: 1, dataVersion: 1, content: `message ${messageOf(n)}`, groupId: groupOf(n), senderId: partner,
          correlationId: null, inReplyTo: null, inReplyToRoot: null, createdAt: NOW_MS - 2 * HOUR,
          attachments: [], embeds: [], interactions: [], likes: [],
        },
      }],
    },
  };
}

async function runActor(
  pageId: number,
  until: () => Promise<boolean>,
  respond: (req: FanslyWireRequest) => FanslyWireOutcome,
): Promise<string[]> {
  const transport = new ScriptedLiveTransport();
  transport.respond = (req) => respond(req);
  const { actor, stop, abort } = await makeTestActor({
    db: db(), pageId, registry: fanslyRegistry, alerts: new RecordingAlerts(), metrics: new RecordingMetrics(), transport,
  });
  const run = actor.run({ stop: stop.signal, abort: abort.signal });
  try {
    await waitFor(async () => ((await until()) ? true : null), 30_000, "the condition");
  } finally {
    stop.abort();
    await run;
  }
  return transport.hits.map((hit) => hit.spec);
}

const fail500 = () => statusResponse(500, { success: false, error: { code: 500 } });

describe("bughunt skeptic SIL-3 / SIL-4", () => {
  it("SIL-3/A: whatever stopped them, none of the eight non-poll keys with a declared staleAfterMs reaches planned_stale; a poll in the same state does", async (context) => {
    if (!testDb) return context.skip();
    const { pageId, label } = await seedPage();
    await parkStandingRows(pageId, fanslyRegistry);
    const keys = FANSLY_RESOURCE_SPECS
      .filter((spec) => spec.kind !== "poll" && spec.slo?.staleAfterMs !== undefined)
      .map((spec) => spec.key)
      .sort();
    expect(keys).toEqual([
      "catalog.vault", "dm-messages.catchup", "fan-earnings.roster", "followers.reconcile",
      "media-stats.walk", "post-replies.walk", "posts.engagement", "purchases.targets",
    ]);
    // The demand-driven keys get the row their trigger would create.
    await makeDue(pageId, "fan-earnings.roster");
    await makeDue(pageId, "followers.reconcile");
    await makeDue(pageId, "purchases.targets", { subject: "media:910000000000000001" });
    await makeDue(pageId, "dm-messages.catchup", { subject: GROUP });
    // Every one of them and the poll `stats.daily`: last admitted 4 days ago
    // and due since (no plan error here — any cause that stops admission).
    const all = [...keys, "stats.daily"];
    await testDb.pool.query(
      `update sync_work set last_served_at = clock_timestamp() - interval '4 days', created_at = clock_timestamp() - interval '4 days',
              first_demand_at = clock_timestamp() - interval '4 days', due_at = clock_timestamp() - interval '4 days'
        where page_id = $1 and resource = any($2::text[])`,
      [pageId, all],
    );
    const rows = await testDb.pool.query<{ resource: string; kind: string; class: string; state: string }>(
      "select resource, kind, class, state from sync_work where page_id = $1 and resource = any($2::text[]) order by resource",
      [pageId, all],
    );
    expect(rows.rows).toHaveLength(9);
    const conditions = await conditionsOf(label);
    record("SIL-3/A rows and conditions", {
      rows: rows.rows,
      slo: Object.fromEntries(all.map((key) => [key, fanslyResourceSpec(key)!.slo?.staleAfterMs ?? null])),
      conditions,
    });
    expect(reasonsOf(conditions, "stuck").find((reason) => reason.detail === "planned_stale")?.context)
      .toEqual({ resources: ["stats.daily"] });
    // Nothing else pages for the eight: alert 3 reads urgent rows only, alert 2 has no quarantine.
    expect(detailsOf(conditions, "freshness")).toEqual([]);
    expect(detailsOf(conditions, "live_degraded")).not.toContain("quarantined");
  });

  it("SIL-3/B guard: a walk stopped by a contract or apply failure is quarantined and pages alert 2", async (context) => {
    if (!testDb) return context.skip();
    const { pageId, label } = await seedPage();
    await parkStandingRows(pageId, fanslyRegistry);
    await testDb.pool.query(
      "update sync_work set state = 'quarantined', waiting_reason = 'quarantined' where page_id = $1 and resource = 'media-stats.walk'",
      [pageId],
    );
    const degraded = reasonsOf(await conditionsOf(label), "live_degraded").find((reason) => reason.detail === "quarantined");
    record("SIL-3/B quarantined walk", degraded ?? null);
    expect(degraded?.context).toEqual({ byResource: { "media-stats.walk": 1 } });
  });

  it("SIL-4/C scope: under a dm-messages breaker the exempt head still pages urgent_waiting and a stalled history request pages request_stalled", async (context) => {
    if (!testDb) return context.skip();
    const { pageId, label } = await seedPage();
    await parkStandingRows(pageId, fanslyRegistry);
    await replaceHoldRows(testDb, pageId, "resource", [resourceBreakerRow("dm-messages", new Date(Date.now() + 6 * HOUR), { step: 3 })]);
    // A confirmation read (the exempt key) due 10 min ago.
    await makeDue(pageId, "dm-messages.head", { subject: GROUP, messageIds: ["910000000000000009"] });
    await testDb.pool.query(
      `update sync_work set due_at = clock_timestamp() - interval '10 minutes', first_demand_at = clock_timestamp() - interval '10 minutes',
              waiting_reason = null
        where page_id = $1 and resource = 'dm-messages.head'`,
      [pageId],
    );
    // A history request whose only fan waits behind the same breaker for 40 min.
    await makeDue(pageId, "dm-messages.history", { subject: GROUP2 });
    const work = await testDb.pool.query<{ id: string }>(
      `update sync_work set due_at = clock_timestamp() - interval '40 minutes', first_demand_at = clock_timestamp() - interval '40 minutes'
        where page_id = $1 and resource = 'dm-messages.history' returning id`,
      [pageId],
    );
    const request = await testDb.pool.query<{ id: string }>(
      `insert into history_requests (request_ref, page_id, requester_kind, idempotency_key, request_fingerprint, depth_kind,
              reason_sha256, reason_length, items_total, estimate_at_submit, created_at)
       values (gen_random_uuid(), $1, 'owner_cli', gen_random_uuid(), repeat('a', 64), 'all', repeat('b', 64), 4, 1, '{}'::jsonb,
               clock_timestamp() - interval '40 minutes')
       returning id`,
      [pageId],
    );
    await testDb.pool.query(
      `insert into history_request_items (request_id, page_id, ordinal, input_kind, input_ref, conversation_ref, state, work_id)
       values ($1, $2, 0, 'conversation_ref', $3, $3, 'queued', $4)`,
      [Number(request.rows[0]!.id), pageId, GROUP2, Number(work.rows[0]!.id)],
    );
    const conditions = await conditionsOf(label);
    record("SIL-4/C conditions under a dm-messages breaker", conditions);
    expect(reasonsOf(conditions, "freshness").find((reason) => reason.detail === "urgent_waiting")?.context)
      .toMatchObject({ resources: ["dm-messages.head"] });
    expect(detailsOf(conditions, "stuck")).toContain("request_stalled");
  });

  it("SIL-4/D reachability (real actor): five failing chat details arm the dm-conversations breaker; it silences the list poll and a due find; the ladder climbs only while no key of the file succeeds", async (context) => {
    if (!testDb) return context.skip();
    const { pageId, label } = await seedPage();
    for (let n = 1; n <= 5; n += 1) await seedThread(pageId, n, { partner: null, headId: null, metadata: { unresolvedIdentity: true } });
    await seedThread(pageId, 6, { partner: fanOf(6), headId: messageOf(6) });
    await parkStandingRows(pageId, fanslyRegistry);
    for (let n = 1; n <= 5; n += 1) await makeDue(pageId, "dm-conversations.detail", { subject: groupOf(n) });

    // 1. Five distinct chats' group details answer 500 → the file's breaker (step 1, 30 min).
    const hits1 = await runActor(pageId, async () => (await resourceHolds(pageId)).length > 0, fail500);
    const armed = await resourceHolds(pageId);
    const failures = await testDb.pool.query(
      `select resource, subject, error_class, http_status from sync_attempts where page_id = $1 and error_class is not null order by id`,
      [pageId],
    );
    record("SIL-4/D first arm", { hits: hits1, hold: armed, failures: failures.rows });
    expect(armed).toHaveLength(1);
    expect(armed[0]).toMatchObject({ key: "dm-conversations", ladder_step: 1 });
    const minutes = (armed[0]!.until.getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(25);
    expect(minutes).toBeLessThanOrEqual(30);

    // 2. While it stands: the list head unread for 2 h (SLO 90 min) and a new chat's find due 10 min → no page.
    await testDb.pool.query(
      "update sync_work set last_served_at = clock_timestamp() - interval '2 hours' where page_id = $1 and resource = 'dm-conversations.head'",
      [pageId],
    );
    await makeDue(pageId, "dm-conversations.find", { subject: groupOf(7), messageIds: ["910000000000000007"] });
    await testDb.pool.query(
      `update sync_work set due_at = clock_timestamp() - interval '10 minutes', first_demand_at = clock_timestamp() - interval '10 minutes',
              waiting_reason = null
        where page_id = $1 and resource = 'dm-conversations.find'`,
      [pageId],
    );
    const held = await conditionsOf(label);
    record("SIL-4/D conditions under the armed breaker", held);
    expect(detailsOf(held, "freshness")).toEqual([]);
    expect(detailsOf(held, "stuck")).toEqual([]);
    // Control: the same rows without the breaker page alerts 3 and 4.
    await testDb.pool.query("update sync_holds set until = clock_timestamp() - interval '1 second' where page_id = $1 and scope = 'resource'", [pageId]);
    const free = await conditionsOf(label);
    expect(detailsOf(free, "freshness")).toContain("urgent_waiting");
    expect(detailsOf(free, "stuck")).toContain("planned_stale");
    // The find and the list poll leave the next runs (only the details run).
    await testDb.pool.query(
      "update sync_work set due_at = clock_timestamp() + interval '1 day' where page_id = $1 and resource in ('dm-conversations.find', 'dm-conversations.head')",
      [pageId],
    );

    // 3. The breaker ended (still on the row) and the details fail again before any success → step 2, 2 h.
    await testDb.pool.query(
      "update sync_work set breaker_until = null, due_at = clock_timestamp() where page_id = $1 and resource = 'dm-conversations.detail'",
      [pageId],
    );
    await runActor(pageId, async () => (await resourceHolds(pageId))[0]?.ladder_step === 2, fail500);
    const climbed = await resourceHolds(pageId);
    record("SIL-4/D climb without a success", climbed);
    expect(climbed[0]).toMatchObject({ key: "dm-conversations", ladder_step: 2 });
    expect((climbed[0]!.until.getTime() - Date.now()) / 60_000).toBeGreaterThan(110);

    // 4. The breaker ended again; the list poll is read first and Fansly answers it: that success clears the row …
    await testDb.pool.query("update sync_holds set until = clock_timestamp() - interval '1 second' where page_id = $1 and scope = 'resource'", [pageId]);
    await testDb.pool.query(
      "update sync_work set breaker_until = clock_timestamp() + interval '1 hour', due_at = clock_timestamp() + interval '1 hour' where page_id = $1 and resource = 'dm-conversations.detail'",
      [pageId],
    );
    await testDb.pool.query(
      "update sync_work set due_at = clock_timestamp() where page_id = $1 and resource = 'dm-conversations.head'",
      [pageId],
    );
    const hits4 = await runActor(pageId, async () => (await resourceHolds(pageId)).length === 0,
      (req) => (req.spec === "messaging.groups" ? okResponse(listPage(6)) : fail500()));
    record("SIL-4/D a list success clears the ended breaker", { hits: hits4, holds: await resourceHolds(pageId) });
    expect(hits4[0]).toBe("messaging.groups");

    // … so the next five failures arm it at step 1 (30 min) again, not step 3.
    await testDb.pool.query(
      "update sync_work set breaker_until = null, due_at = clock_timestamp() where page_id = $1 and resource = 'dm-conversations.detail'",
      [pageId],
    );
    await runActor(pageId, async () => (await resourceHolds(pageId)).length > 0, fail500);
    const rearmed = await resourceHolds(pageId);
    record("SIL-4/D re-arm after a success", rearmed);
    expect(rearmed[0]).toMatchObject({ key: "dm-conversations", ladder_step: 1 });
    expect((rearmed[0]!.until.getTime() - Date.now()) / 60_000).toBeLessThanOrEqual(30);
  });
});
