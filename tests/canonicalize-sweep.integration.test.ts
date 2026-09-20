import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  appendDomainEvents,
  advanceCanonicalizeSweepCursor,
  applyVerifiedOfapiBinding,
  getOfapiBindingPage,
  getCanonicalizeSweepCursor,
  createModel,
  createOnlyFansPage,
  insertObservation,
  listEventsSince,
  markObservationParsed,
  setPageOfapiAccountId,
} from "@agency_hub_core/db";

import {
  resetCanonicalizeSweepRuntime,
  runCanonicalization,
} from "../apps/runtime/src/services/canonicalize-driver.ts";
import { CANONICALIZER_FAMILIES } from "../apps/runtime/src/services/canonicalize/index.ts";
import {
  computeHealthFloorBacklogMs,
  HEALTH_FLOOR_REGISTRY,
} from "../apps/runtime/src/services/health-floors.ts";
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
  // Reset process-local family rotation; the database reset clears durable cursors.
  resetCanonicalizeSweepRuntime();
});

function sha256(payload: unknown): Buffer {
  return createHash("sha256").update(JSON.stringify(payload)).digest();
}

function appStub() {
  return {
    db: testDb!.db,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  } as never;
}

async function seedCorpus() {
  const db = testDb!.db;
  // 1. Webhook DM for account 4.
  await insertObservation(db, {
    source: "webhook",
    producer: "ofapi:webhook",
    platform: "onlyfans",
    accountId: 4,
    kind: "messages.received",
    payload: {
      event: "messages.received",
      account_id: "acct_x",
      payload: { id: 9001, createdAt: "2026-06-20T10:00:00+00:00", fromUser: { id: 777 }, text: "hey", price: 0, isTip: false, isFree: true, mediaCount: 0 },
    },
    payloadHash: sha256("wh-1"),
    idempotencyKey: "evt-sweep-1",
  });
  // 2. Pull transactions page for account 3 (fansly).
  await insertObservation(db, {
    source: "pull",
    producer: "sync:fansly:transactions",
    platform: "fansly",
    accountId: 3,
    kind: "earnings_transactions",
    payload: { total: 1, data: [{ transactionId: "ftx-9", correlationAccountId: "fan-2", type: 2110, amount: 100, destinationAmount: 80, status: 2, createdAt: Date.parse("2026-06-19T09:00:00Z") }] },
    payloadHash: sha256("pull-1"),
    idempotencyKey: "3:transactions:1:1",
  });
  // 3. Command result for account 4.
  await insertObservation(db, {
    source: "command_result",
    producer: "ofapi:command-executor",
    platform: "onlyfans",
    accountId: 4,
    kind: "command.confirmed",
    payload: { commandId: "cmd-1", commandKind: "send_text", pageId: 4, conversationId: "777", state: "confirmed" },
    payloadHash: sha256("cmd-1"),
    idempotencyKey: "cmd:cmd-1:confirmed",
  });
  // 4. Undeclared kind — must remain untouched at parse_version 0.
  // (tips.received graduated to declared in family v2 — Stage 14; users.typing
  // is the remaining unmapped-by-design representative.)
  await insertObservation(db, {
    source: "webhook",
    producer: "ofapi:webhook",
    platform: "onlyfans",
    accountId: 4,
    kind: "users.typing",
    payload: { event: "users.typing", payload: { user: { id: 778 } } },
    payloadHash: sha256("typing-1"),
    idempotencyKey: "evt-sweep-typing-1",
  });
  // 4b. tips.received — declared as of v2, parses from the verified shape.
  await insertObservation(db, {
    source: "webhook",
    producer: "ofapi:webhook",
    platform: "onlyfans",
    accountId: 4,
    kind: "tips.received",
    payload: {
      event: "tips.received",
      payload: { id: "n1", user: { id: 310112051 }, amountGross: 8, amountNet: 6.4, createdAt: "2026-06-30T14:42:00+00:00" },
    },
    payloadHash: sha256("tip-1"),
    idempotencyKey: "evt-sweep-tip-1",
  });
  // 4c. Client-capture (Stage 11): registration-only family — the sweep
  // stamps parse_version with ZERO events (desktop facts wait for Stage 29).
  await insertObservation(db, {
    source: "client_capture",
    producer: "desktop@0.1.29",
    platform: null,
    accountId: 4,
    kind: "desktop.ai_acceptance",
    payload: { suggestionId: "s1", outcome: "inserted" },
    payloadHash: sha256("cc-1"),
    idempotencyKey: "cc-sweep-1",
  });
  // 4d. desktop.unknown:* stays OUTSIDE the family — pending at 0.
  await insertObservation(db, {
    source: "client_capture",
    producer: "desktop@0.1.29",
    platform: null,
    accountId: 4,
    kind: "desktop.unknown:mystery_metric",
    payload: { n: 1 },
    payloadHash: sha256("cc-2"),
    idempotencyKey: "cc-sweep-2",
  });
  // 5. Unmapped account (NULL) with a canonicalizable kind — retried, never lost.
  await insertObservation(db, {
    source: "webhook",
    producer: "ofapi:webhook",
    platform: "onlyfans",
    accountId: null,
    kind: "messages.received",
    payload: {
      event: "messages.received",
      account_id: "acct_unmapped",
      payload: { id: 9002, createdAt: "2026-06-20T11:00:00+00:00", fromUser: { id: 778 }, text: "yo", price: 0, isFree: true, mediaCount: 0 },
    },
    payloadHash: sha256("wh-2"),
    idempotencyKey: "evt-sweep-2",
  });
}

describe("canonicalization sweep (Stage 8)", () => {
  it("persists alternating turns when either pass overruns its budget", async () => {
    const ids: number[] = [];
    for (let index = 0; index < 4; index += 1) {
      const receipt = await insertObservation(testDb!.db, {
        source: "pull", producer: "freshness-test", platform: "fansly", accountId: 3,
        kind: "earnings_transactions", payload: {}, payloadHash: sha256(index), idempotencyKey: `turn:${index}`,
      });
      ids.push(receipt.observationId);
      if (index < 2) await markObservationParsed(testDb!.db, {
        observationId: receipt.observationId, receivedAt: receipt.receivedAt, parseVersion: 5,
      });
    }
    let clock = Date.now();
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
    try {
      const processed: number[] = [];
      const family = {
        source: "pull" as const, lane: "turn-test", version: 6, kinds: ["earnings_transactions"],
        prioritizeUnparsed: true,
        canonicalize: (observation: { id: number }) => { processed.push(observation.id); clock += 120; return []; },
      };
      for (let run = 0; run < 3; run += 1) {
        resetCanonicalizeSweepRuntime();
        expect(await runCanonicalization(appStub(), {
          families: [family], useSweepCursor: true, pageSize: 1, maxPagesPerFamily: 4, maxDurationMs: 100,
        })).toMatchObject({ scanned: 1, stamped: 1, errored: 0, truncatedByBudget: true });
      }
      expect(processed).toEqual([ids[2], ids[0], ids[3]]);
    } finally {
      now.mockRestore();
    }
  });

  it.each([false, true])("keeps new capture and v6 replay moving after restart (unmapped capture: %s)", async (unmapped) => {
    const family = CANONICALIZER_FAMILIES.find(item => item.source === "pull" && item.lane === "sync")!;
    async function capture(name: string, accountId: number | null = 3, parsed = false) {
      const receipt = await insertObservation(testDb!.db, {
        source: "pull", producer: "sync:fansly:transactions", platform: "fansly", accountId,
        kind: "earnings_transactions",
        payload: { total: 1, data: [{ transactionId: name, correlationAccountId: "fan-2", type: 2110,
          amount: 100, destinationAmount: 80, status: 2, createdAt: Date.parse("2026-09-07T09:00:00Z") }] },
        payloadHash: sha256(name), idempotencyKey: `freshness:${name}`,
      });
      if (parsed) await markObservationParsed(testDb!.db, {
        observationId: receipt.observationId, receivedAt: receipt.receivedAt, parseVersion: family.version - 1,
      });
      return receipt.observationId;
    }
    const old: number[] = [];
    for (const name of ["old-1", "old-2", "old-3"]) old.push(await capture(name, 3, true));
    const poison = unmapped ? await capture("unmapped", null) : null;
    const fresh = await capture("fresh");
    const options = { useSweepCursor: true, pageSize: 1, maxPagesPerFamily: 2, families: [family] };

    const first = await runCanonicalization(appStub(), options);
    expect(first).toMatchObject({ scanned: 2, stamped: unmapped ? 1 : 2, skippedUnmapped: unmapped ? 1 : 0, errored: 0 });
    async function versions() {
      const rows = await testDb!.pool.query<{ id: string; parse_version: number }>(
        "select id::text,parse_version from observations where idempotency_key like 'freshness:%' order by id",
      );
      return new Map(rows.rows.map(item => [Number(item.id), item.parse_version]));
    }
    const afterFirst = await versions();
    expect(afterFirst.get(fresh)).toBe(unmapped ? 0 : family.version);
    expect(old.map(id => afterFirst.get(id))).toEqual([family.version, family.version - 1, family.version - 1]);

    // The fresh cursor must not move the replay cursor beyond old-2. A stuck
    // unmapped row must not pin the fresh cursor after a process restart.
    resetCanonicalizeSweepRuntime();
    const nextFresh = unmapped ? fresh : await capture("fresh-after-restart");
    expect(await runCanonicalization(appStub(), options)).toMatchObject({ scanned: 2, stamped: 2, errored: 0 });
    const afterRestart = await versions();
    expect(afterRestart.get(nextFresh)).toBe(family.version);
    expect(old.map(id => afterRestart.get(id))).toEqual([family.version, family.version, family.version - 1]);
    if (poison !== null) expect(afterRestart.get(poison)).toBe(0);
    const events = await listEventsSince(testDb!.db, { accountId: 3, afterSeq: 0 });
    expect(events.filter(event => event.dedupKey === "txn:fresh")).toHaveLength(1);
  });

  it("rejects stale cursor writers, including a writer from before a wrap", async () => {
    const first = await getCanonicalizeSweepCursor(testDb!.db, "concurrent-sweep");
    const second = await getCanonicalizeSweepCursor(testDb!.db, first.key);
    const advanced = await advanceCanonicalizeSweepCursor(testDb!.db, first, 10);
    await expect(advanceCanonicalizeSweepCursor(testDb!.db, second, 20)).rejects.toThrow("changed concurrently");
    const wrapped = await advanceCanonicalizeSweepCursor(testDb!.db, advanced, null);
    await expect(advanceCanonicalizeSweepCursor(testDb!.db, advanced, 30)).rejects.toThrow("changed concurrently");
    expect(await getCanonicalizeSweepCursor(testDb!.db, first.key)).toEqual(wrapped);
  });

  it("settles the corpus, leaves undeclared/unmapped pending, and replays idempotently", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await seedCorpus();

    const first = await runCanonicalization(appStub());
    expect(first).toMatchObject({
      appended: 4,       // message + transaction + command.settled + tip.received
      deduped: 0,
      stamped: 5,        // + the client-capture row (zero events by design)
      skippedUnmapped: 1,
    });

    const account4 = await listEventsSince(testDb.db, { accountId: 4, afterSeq: 0 });
    expect(account4.map((event) => event.type).sort())
      .toEqual(["command.settled", "message.received", "tip.received"]);
    expect(account4.find((event) => event.type === "tip.received")).toMatchObject({
      dedupKey: "tip:n1",
      fanIdentityRef: "310112051",
    });
    const account3 = await listEventsSince(testDb.db, { accountId: 3, afterSeq: 0 });
    expect(account3[0]).toMatchObject({ type: "transaction.posted", dedupKey: "txn:ftx-9" });

    // The undeclared kind stays at parse_version 0 (capture now, parse later).
    const typingRow = await testDb.pool.query<{ parse_version: number }>(
      "select parse_version from observations where kind = 'users.typing'",
    );
    expect(typingRow.rows[0]?.parse_version).toBe(0);

    // Stage 11 family: declared desktop kind stamped (zero events), unknown
    // desktop kind pending.
    const captureRows = await testDb.pool.query<{ kind: string; parse_version: number }>(
      "select kind, parse_version from observations where source = 'client_capture' order by kind",
    );
    expect(captureRows.rows).toEqual([
      // v2 since Stage 12 (harvest kinds joined the family).
      { kind: "desktop.ai_acceptance", parse_version: 2 },
      { kind: "desktop.unknown:mystery_metric", parse_version: 0 },
    ]);

    // Second sweep: stamped rows are gone from the listing; only the unmapped
    // row is rescanned (and skipped again).
    const second = await runCanonicalization(appStub());
    expect(second).toMatchObject({ appended: 0, stamped: 0, skippedUnmapped: 1 });

    // Version bump (replay): rescans consumed rows, appends nothing new.
    // Floor must exceed EVERY family's current version (sync-pull is v3
    // since Stage 16's parse slice) so all stamped rows rescan.
    const replay = await runCanonicalization(appStub(), { belowParseVersion: 99 });
    expect(replay.appended).toBe(0);
    expect(replay.deduped).toBe(4);
    expect(await listEventsSince(testDb.db, { accountId: 4, afterSeq: 0 })).toHaveLength(3);

    // Dry-run never writes: only the unmapped row remains below the current
    // family versions; narrow to its kind and confirm counts only.
    const dry = await runCanonicalization(appStub(), { kinds: ["messages.received"], dryRun: true });
    expect(dry.stamped).toBe(0);
    expect(dry.appended).toBeGreaterThan(0); // the unmapped row's draft, counted not written
  });

  it("resolves capture-first webhook rows via native_account_ref (prod shape: account_id NULL)", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    // Prod truth: the webhook journal producer stores only the vendor ref —
    // the page id must resolve at canonicalize time through the page map.
    const model = await createModel(testDb.db, { slug: "reso", name: "Reso" });
    if (!model) throw new Error("Expected synthetic model");
    const page = await createOnlyFansPage(testDb.db, { modelId: model.id, label: "reso-of" });
    if (!page) throw new Error("Expected synthetic page");
    await setPageOfapiAccountId(testDb.db, {
      pageId: page.id,
      ofapiAccountId: "acct_reso11111111111111111111111111111",
    });

    await insertObservation(testDb.db, {
      source: "webhook",
      producer: "ofapi:webhook",
      platform: "onlyfans",
      accountId: null,
      nativeAccountRef: "acct_reso11111111111111111111111111111",
      kind: "messages.received",
      payload: {
        event: "messages.received",
        account_id: "acct_reso11111111111111111111111111111",
        payload: { id: 9100, createdAt: "2026-07-06T08:00:00+00:00", fromUser: { id: 900 }, text: "resolve me", price: 0, isFree: true, mediaCount: 0 },
      },
      payloadHash: sha256("wh-reso"),
      idempotencyKey: "evt-reso-1",
    });
    // Retire it BEFORE parsing: arrival today still attributes the old fact.
    const binding = await getOfapiBindingPage(testDb.db, page.id);
    expect(await applyVerifiedOfapiBinding(testDb.db, {
      authVerifiedAt: null,
      pageId: page.id, expectedAccountId: binding!.account_id, expectedGeneration: binding!.generation,
      accountId: "acct_replacement", creatorId: "123", historicalAccountIds: [], recovery: [],
      evidence: { source: "synthetic_test" },
    })).toBe(true);
    // A ref no page owns stays pending (self-heal contract unchanged).
    await insertObservation(testDb.db, {
      source: "webhook",
      producer: "ofapi:webhook",
      platform: "onlyfans",
      accountId: null,
      nativeAccountRef: "acct_nobody",
      kind: "messages.received",
      payload: {
        event: "messages.received",
        account_id: "acct_nobody",
        payload: { id: 9101, createdAt: "2026-07-06T08:01:00+00:00", fromUser: { id: 901 }, text: "orphan", price: 0, isFree: true, mediaCount: 0 },
      },
      payloadHash: sha256("wh-orphan"),
      idempotencyKey: "evt-reso-2",
    });

    const run = await runCanonicalization(appStub());
    expect(run).toMatchObject({ appended: 1, skippedUnmapped: 1, errored: 0 });

    const events = await listEventsSince(testDb.db, { accountId: page.id, afterSeq: 0 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "message.received" });
  }, 60_000);

  it("late custody import replays a retired account's v3 rows without duplicating facts (Decision 381)", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const db = testDb.db;
    const pool = testDb.pool;
    // Prod shape 2026-09-20: pages 8/9 were re-registered in OFAPI twice
    // BEFORE migration 0150 existed, so the retired acct_* refs own ~452k
    // v3-stamped webhook rows that no page or custody row maps. The webhook
    // family is v5, so they sit under the health floor forever
    // (obs_backlog_webhook_ofapi_v5 burns every minute) and cost the whole
    // replay budget as skippedUnmapped. The repair is the custody import in
    // docs/runbooks/ofapi-historical-binding-import.md; this fixture runs that
    // exact SQL and pins what the sweep must do afterwards: dedupe every fact
    // the v3 pass already appended (money included), append only the
    // never-consumed v5 material, stamp the rows, and drop the gauge to zero.
    const model = await createModel(db, { slug: "cust", name: "Custody" });
    if (!model) throw new Error("Expected synthetic model");
    const page = await createOnlyFansPage(db, { modelId: model.id, label: "cust-of" });
    if (!page) throw new Error("Expected synthetic page");
    const retired = "acct_retired000000000000000000000000";
    const current = "acct_current00000000000000000000000";
    await setPageOfapiAccountId(db, { pageId: page.id, ofapiAccountId: retired });

    const envelope = (kind: string, payload: Record<string, unknown>) => ({
      event: kind, account_id: retired, payload,
    });
    const journal = async (kind: string, key: string, payload: Record<string, unknown>) => {
      const inserted = await insertObservation(db, {
        source: "webhook", producer: "ofapi:webhook", platform: "onlyfans",
        accountId: null, nativeAccountRef: retired, kind,
        payload: envelope(kind, payload), payloadHash: sha256(key), idempotencyKey: key,
      });
      if (!inserted.inserted) throw new Error(`seed ${key} deduped unexpectedly`);
      return inserted;
    };
    // The six fact kinds the retired refs hold on prod (presence dominates there).
    const v3Rows = [
      await journal("tips.received", "cust-tip-1", { id: "n-cust-1", user: { id: 900 }, amountGross: 25, amountNet: 20, createdAt: "2026-07-10T10:00:00+00:00" }),
      await journal("transactions.new", "cust-txn-1", { id: "tx-cust-1", type: "tip", amount: 25, net_amount: 20, fan: { id: 900 }, currency: "USD", status: "done", created_at: "2026-07-10T10:00:01+00:00" }),
      await journal("messages.sent", "cust-msg-sent-1", { id: 5001, createdAt: "2026-07-10T10:01:00+00:00", toUser: { id: 900 }, text: "hi", price: 0, isFree: true, mediaCount: 0 }),
      await journal("messages.received", "cust-msg-recv-1", { id: 5002, createdAt: "2026-07-10T10:02:00+00:00", fromUser: { id: 900 }, text: "hey", price: 0, isFree: true, mediaCount: 0 }),
      await journal("subscriptions.new", "cust-sub-1", { id: "n-cust-2", type: "subscribed", subType: "new_subscriber", user_id: "creator", user: { id: 901 }, createdAt: "2026-07-10T10:03:00+00:00" }),
      await journal("users.online", "cust-online-1", { fan: { id: 900 }, observed_at: "2026-07-10T10:04:00+00:00", status_changed_at: "2026-07-10T10:04:00+00:00" }),
    ];

    // The v3 pass, under the then-live mapping: every fact appended, rows stamped.
    const v3Pass = await runCanonicalization(appStub());
    expect(v3Pass).toMatchObject({ appended: 6, deduped: 0, stamped: 6, skippedUnmapped: 0, errored: 0 });
    const countEvents = async () => Number((await pool.query<{ n: string }>(
      "select count(*)::text as n from domain_events where account_id = $1", [page.id],
    )).rows[0]!.n);
    const eventsAfterV3 = await countEvents();
    for (const row of v3Rows) {
      await pool.query("update observations set parse_version = 3 where id = $1 and received_at = $2", [row.observationId, row.receivedAt]);
    }
    // Pre-custody re-registration (the July/September prod shape): the page's
    // column moves to the replacement ref, no custody row survives for the
    // retired one, and migration 0150 later seeds only the CURRENT mapping.
    await pool.query("update pages set ofapi_account_id = $2 where id = $1", [page.id, current]);
    await pool.query("delete from ofapi_account_bindings where account_id = $1", [retired]);
    await pool.query(
      `insert into ofapi_account_bindings(account_id,page_id,generation,evidence)
       values ($1,$2,1,'{"source":"mapping_at_migration","boundary":"unknown"}'::jsonb)
       on conflict (account_id) do nothing`, [current, page.id],
    );
    // v5 material the v3 pass never consumed (prod: eight chat_queue.* rows at parse_version 0).
    await journal("chat_queue.updated", "cust-queue-1", { id: 777, date: "2026-08-22T09:00:00+00:00", isDone: false, pending: 3, total: 10 });

    const webhookFloor = HEALTH_FLOOR_REGISTRY.find((floor) => floor.source === "webhook" && floor.lane === "ofapi");
    if (!webhookFloor) throw new Error("webhook/ofapi health floor missing from the registry");

    // Unmapped: every row rescans and is skipped, nothing is stamped, the gauge burns.
    const stuck = await runCanonicalization(appStub());
    expect(stuck).toMatchObject({ scanned: 7, appended: 0, stamped: 0, skippedUnmapped: 7, errored: 0, bindingConflicts: [] });
    expect(await computeHealthFloorBacklogMs(db, webhookFloor)).toBeGreaterThan(0);
    expect(await countEvents()).toBe(eventsAfterV3);

    // The runbook's custody import — same locks as every binding writer, a
    // historical row (no generation), observed boundaries, evidence retained.
    await pool.query("begin");
    await pool.query("select pg_advisory_xact_lock(9003010, $1::integer)", [page.id]);
    await pool.query("select pg_advisory_xact_lock(9003011)");
    await pool.query(
      `insert into ofapi_account_bindings(account_id,page_id,creator_id,generation,valid_from,valid_to,evidence)
       select $1, $2, '518588958', null, '2026-07-05T01:55:05.652Z', '2026-07-21T20:22:03.864Z',
         '{"source":"historical_custody_import","decision":381}'::jsonb
       where not exists (select 1 from ofapi_account_bindings where account_id = $1)
         and not exists (select 1 from pages where ofapi_account_id = $1)`, [retired, page.id],
    );
    await pool.query("commit");

    // Mapped again: the v3 facts dedupe (money included) and, fully deduped,
    // mint no checkpoint; the v5 material appends once — its hidden event plus
    // the atomic projection checkpoint covering it; every row is stamped and
    // the gauge reads caught up.
    const healed = await runCanonicalization(appStub());
    expect(healed).toMatchObject({ scanned: 7, appended: 2, deduped: 6, stamped: 7, skippedUnmapped: 0, errored: 0 });
    expect(await countEvents()).toBe(eventsAfterV3 + 2);
    const newEvents = await pool.query<{ type: string }>(
      "select type from domain_events where account_id = $1 and observation_id > $2 order by type", [page.id, v3Rows[5]!.observationId],
    );
    expect(newEvents.rows.map((row) => row.type)).toEqual(["ofapi.chat_queue_observed", "stream.projection_checkpoint"]);
    const versions = await pool.query<{ parse_version: number; n: string }>(
      "select parse_version, count(*)::text as n from observations where native_account_ref = $1 group by 1", [retired],
    );
    expect(versions.rows).toEqual([{ parse_version: webhookFloor.version, n: "7" }]);
    expect(await computeHealthFloorBacklogMs(db, webhookFloor)).toBe(0);

    // Nothing left below the floor: the next sweep does not rescan the refs.
    const settled = await runCanonicalization(appStub());
    expect(settled).toMatchObject({ scanned: 0, appended: 0, stamped: 0, skippedUnmapped: 0 });
  }, 60_000);

  it("isolates a poison row: one throwing observation never wedges the sweep", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const db = testDb.db;
    await insertObservation(db, {
      source: "webhook",
      producer: "ofapi:webhook",
      platform: "onlyfans",
      accountId: 4,
      kind: "poison.test",
      payload: { poison: true },
      payloadHash: sha256("poison-1"),
      idempotencyKey: "iso-poison-1",
    });
    await insertObservation(db, {
      source: "webhook",
      producer: "ofapi:webhook",
      platform: "onlyfans",
      accountId: 4,
      kind: "poison.test",
      payload: { poison: false },
      payloadHash: sha256("healthy-1"),
      idempotencyKey: "iso-healthy-1",
    });

    const throwingFamily = {
      source: "webhook" as const,
      lane: "test",
      kinds: ["poison.test"],
      version: 1,
      canonicalize: (observation: { payload: unknown }) => {
        if ((observation.payload as { poison?: boolean }).poison === true) {
          throw new Error("boom");
        }
        return [{
          type: "message.received",
          occurredAt: new Date("2026-06-01T00:00:00.000Z"),
          fanIdentityRef: "555",
          messageRef: "iso-1",
          data: {},
          schemaVersion: 1,
          dedupKey: "msg:received:iso-1",
        }];
      },
    };

    // The healthy row lands and stamps; the poison row errors, stays
    // unstamped, and the run STILL RETURNS (no wedge).
    const first = await runCanonicalization(appStub(), { families: [throwingFamily] });
    expect(first).toMatchObject({ errored: 1, stamped: 1, appended: 1 });

    const pending = await testDb.pool.query<{ parse_version: number }>(
      "select parse_version from observations where idempotency_key = 'iso-poison-1'",
    );
    expect(pending.rows[0]?.parse_version).toBe(0);

    // Next sweep retries ONLY the poison row and errors again — bounded,
    // never spreading to already-stamped work.
    const second = await runCanonicalization(appStub(), { families: [throwingFamily] });
    expect(second).toMatchObject({ scanned: 1, errored: 1, stamped: 0, appended: 0 });
  });

  // W8.2 / A48 (decision #133): the v2→v3 webhook version bump makes the
  // sweep REPLAY already-stamped history — pre-fix subscriptions.renewed
  // observations (journaled, zero events through v2) backfill as
  // subscription.renewed; everything already canonicalized dedupes.
  it("v3 replay backfills subscription.renewed from a v2-stamped observation (A48)", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const db = testDb.db;
    const inserted = await insertObservation(db, {
      source: "webhook",
      producer: "ofapi:webhook",
      platform: "onlyfans",
      accountId: 4,
      kind: "subscriptions.renewed",
      payload: {
        event: "subscriptions.renewed",
        account_id: "acct_x",
        payload: {
          id: "n-renew-1",
          type: "subscribed",
          createdAt: "2026-07-01T10:00:00+00:00",
          subType: "returning_subscriber",
          user_id: "creator-1",
          user: { id: "778001" },
        },
      },
      payloadHash: sha256("renewed-1"),
      idempotencyKey: "evt-renewed-1",
    });
    if (!inserted.inserted) {
      throw new Error("seed insert deduped unexpectedly");
    }
    // Simulate prod history: the row was already CONSUMED by webhook family
    // v2 (which produced zero events for this kind).
    await markObservationParsed(db, {
      observationId: inserted.observationId,
      receivedAt: inserted.receivedAt,
      parseVersion: 2,
    });

    // A v2-floor sweep must NOT touch it (proves it was settled pre-bump)...
    const settled = await runCanonicalization(appStub(), { belowParseVersion: 2 });
    expect(settled).toMatchObject({ scanned: 0, appended: 0 });

    // ...and the CURRENT sweep (family now v3) replays it into the event.
    const replay = await runCanonicalization(appStub());
    expect(replay).toMatchObject({ appended: 1, errored: 0 });
    const events = await listEventsSince(db, { accountId: 4, afterSeq: 0 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "subscription.renewed",
      fanIdentityRef: "778001",
      dedupKey: `sub:renewed:778001:${new Date("2026-07-01T10:00:00+00:00").toISOString()}`,
    });

    // Second sweep: stamped at 3 now — nothing rescans, nothing duplicates.
    const second = await runCanonicalization(appStub());
    expect(second).toMatchObject({ scanned: 0, appended: 0 });
  });

  it("deduplicates a corrected subscription identity after an append-before-stamp retry", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const db = testDb.db;
    const occurredAt = new Date("2026-07-02T10:00:00Z");
    const inserted = await insertObservation(db, {
      source: "webhook",
      producer: "ofapi:webhook",
      platform: "onlyfans",
      accountId: 4,
      kind: "subscriptions.new",
      payload: {
        event: "subscriptions.new",
        account_id: "acct_x",
        payload: {
          id: "n-start-identity-fix",
          createdAt: occurredAt.toISOString(),
          subType: "new_subscriber",
          user_id: "creator-1",
          user: { id: "778001" },
        },
      },
      payloadHash: sha256("started-identity-fix"),
      idempotencyKey: "evt-started-identity-fix",
    });
    if (!inserted.inserted) {
      throw new Error("seed insert deduped unexpectedly");
    }

    // Simulate the old v3 crash window: the creator-key event committed, but
    // parse_version was never stamped. The retry now derives the subscriber.
    const oldKey = `sub:started:creator-1:${occurredAt.toISOString()}`;
    const seeded = await appendDomainEvents(db, 4, [{
      type: "subscription.started",
      occurredAt,
      fanIdentityRef: "creator-1",
      data: { subType: "new_subscriber", notificationId: "n-start-identity-fix" },
      schemaVersion: 1,
      observationId: inserted.observationId,
      dedupKey: oldKey,
    }]);
    expect(seeded).toMatchObject({ appended: 1, deduped: 0 });

    const retry = await runCanonicalization(appStub());
    expect(retry).toMatchObject({ appended: 0, deduped: 1, stamped: 1, errored: 0 });
    const events = await listEventsSince(db, { accountId: 4, afterSeq: 0 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "subscription.started",
      fanIdentityRef: "creator-1",
      dedupKey: oldKey,
    });

    const correctedKey = `sub:started:778001:${occurredAt.toISOString()}`;
    const keys = await testDb.pool.query<{ dedup_key: string; event_id: string }>(
      `select dedup_key, event_id::text as event_id
       from domain_event_keys
       where account_id = 4 and dedup_key in ($1, $2)
       order by dedup_key`,
      [oldKey, correctedKey],
    );
    // The corrected fan-bearing key must not survive independently: the old
    // creator-key event is outside fan-erasure selection.
    expect(keys.rows).toEqual([{ dedup_key: oldKey, event_id: String(events[0]!.id) }]);
  });

  // W8.2 (A13 remainder, decision #133): garbage provider timestamps clamp to
  // the observation's receipt time AT CANONICALIZE TIME — the event lands in
  // a live partition with the raw value preserved in data, instead of aiming
  // the insert at a partition that may not exist (23514 retry-forever).
  it("clamps out-of-window occurred_at to receivedAt and preserves the raw value (W8.2)", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const db = testDb.db;
    const receivedAt = new Date("2026-07-08T12:00:00Z");
    await insertObservation(db, {
      source: "pull",
      producer: "sync:fansly:transactions",
      platform: "fansly",
      accountId: 3,
      kind: "earnings_transactions",
      payload: {
        total: 2,
        data: [
          // Pre-2024 (1999) and far-future (2035) — both out of window.
          { transactionId: "ftx-clamp-old", correlationAccountId: "fan-9", type: 2110, amount: 100, destinationAmount: 80, status: 2, createdAt: Date.parse("1999-12-31T23:59:59Z") },
          { transactionId: "ftx-clamp-future", correlationAccountId: "fan-9", type: 2110, amount: 200, destinationAmount: 160, status: 2, createdAt: Date.parse("2035-06-01T00:00:00Z") },
        ],
      },
      payloadHash: sha256("clamp-pull-1"),
      idempotencyKey: "3:transactions:9:9",
      receivedAt,
    });

    const run = await runCanonicalization(appStub());
    expect(run).toMatchObject({ appended: 2, errored: 0 });

    const events = await listEventsSince(db, { accountId: 3, afterSeq: 0 });
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event.occurredAt.toISOString()).toBe(receivedAt.toISOString());
    }
    const byRef = new Map(events.map((event) => [event.transactionRef, event]));
    expect((byRef.get("ftx-clamp-old")!.data as Record<string, unknown>)).toMatchObject({
      occurredAtClamped: true,
      occurredAtRaw: "1999-12-31T23:59:59.000Z",
      amountUnit: "mills",
    });
    expect((byRef.get("ftx-clamp-future")!.data as Record<string, unknown>)).toMatchObject({
      occurredAtClamped: true,
      occurredAtRaw: "2035-06-01T00:00:00.000Z",
    });
  });

  // W5.3 (B3, decision #123 semantics): the minutely sweep resumes from a
  // per-family cursor, so permanently-unstampable rows at the scan head can
  // no longer starve fresh rows behind them; a wrap retries skipped rows
  // once per full cycle; CLI/replay runs ignore the cursor entirely.
  it("sweep cursor: stuck rows stop starving fresh rows; wrap retries them; CLI runs bypass (W5.3)", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const db = testDb.db;
    const bounds = { pageSize: 2, maxPagesPerFamily: 2 };

    // Five permanently-stuck rows at the head (unmapped account: canonicalize
    // yields a draft but no account resolves — skippedUnmapped every pass)...
    for (let i = 1; i <= 5; i += 1) {
      await insertObservation(db, {
        source: "webhook",
        producer: "ofapi:webhook",
        platform: "onlyfans",
        accountId: null,
        kind: "messages.received",
        payload: {
          event: "messages.received",
          account_id: "acct_stuck",
          payload: { id: 9200 + i, createdAt: "2026-07-01T10:00:00+00:00", fromUser: { id: 900 + i }, text: `stuck-${i}`, price: 0, isFree: true, mediaCount: 0 },
        },
        payloadHash: sha256(`stuck-${i}`),
        idempotencyKey: `cursor-stuck-${i}`,
      });
    }
    // ...and two fresh mappable rows BEHIND them.
    for (let i = 1; i <= 2; i += 1) {
      await insertObservation(db, {
        source: "webhook",
        producer: "ofapi:webhook",
        platform: "onlyfans",
        accountId: 4,
        kind: "messages.received",
        payload: {
          event: "messages.received",
          account_id: "acct_x",
          payload: { id: 9300 + i, createdAt: "2026-07-01T11:00:00+00:00", fromUser: { id: 950 + i }, text: `fresh-${i}`, price: 0, isFree: true, mediaCount: 0 },
        },
        payloadHash: sha256(`fresh-${i}`),
        idempotencyKey: `cursor-fresh-${i}`,
      });
    }

    // Run 1 (sweep): the paging budget is eaten entirely by the stuck head —
    // this is the pre-fix starvation shape, bounded to one run now.
    const first = await runCanonicalization(appStub(), { useSweepCursor: true, ...bounds });
    expect(first).toMatchObject({ scanned: 4, skippedUnmapped: 4, appended: 0, stamped: 0 });

    const snapshot = () => testDb!.pool.query("select * from canonicalize_sweep_cursors order by key");
    const beforeDryRun = (await snapshot()).rows;
    const dryRun = await runCanonicalization(appStub(), { useSweepCursor: true, dryRun: true, ...bounds });
    expect(dryRun).toMatchObject({ scanned: 4, stamped: 0 });
    expect((await snapshot()).rows).toEqual(beforeDryRun);

    // A CLI-style run (no cursor) rescans from the head — deterministic —
    // and does NOT move the sweep cursor.
    const cli = await runCanonicalization(appStub(), { ...bounds });
    expect(cli).toMatchObject({ scanned: 4, skippedUnmapped: 4, appended: 0 });

    resetCanonicalizeSweepRuntime(); // worker restart must preserve database progress
    // Run 2 (sweep): resumes past the stuck head — the fresh rows finally
    // process. Pre-fix, this run would have rescanned the same head forever.
    const second = await runCanonicalization(appStub(), { useSweepCursor: true, ...bounds });
    expect(second).toMatchObject({ scanned: 3, skippedUnmapped: 1, appended: 2, stamped: 2 });
    const events = await listEventsSince(db, { accountId: 4, afterSeq: 0 });
    expect(events.map((event) => event.type)).toEqual(["message.received", "message.received"]);

    // Run 3 (sweep): end-of-signal wrapped the cursor to the head — the
    // stuck rows get their once-per-cycle retry.
    const third = await runCanonicalization(appStub(), { useSweepCursor: true, ...bounds });
    expect(third).toMatchObject({ scanned: 4, skippedUnmapped: 4, appended: 0 });
  });
});
