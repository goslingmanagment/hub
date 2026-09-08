import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

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
