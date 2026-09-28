// J4: the account_me captures whose observation the pre-J4 run-less key
// dropped. refreshPageMetadata journaled account_me under
// `page:stream:norun:requestSeq.fetchN`; continuation chunks of one request
// share requestSeq and restart fetchN, so followers_reconcile's closing
// account_me (the first capture of a later chunk) repeated the sweep-start key
// and the claim swallowed it. The raw rows survive. The repair pairs every
// request's raw captures with its observations by body, re-journals the
// unpaired ones verbatim (dated at capture, per-raw-row keys), and is a
// read-only dry-run unless told otherwise.
//
// The captures below go through the REAL capture seam (persistRawPayload in a
// page-sync execution context), so the collision is the production one, not a
// hand-forged imitation of it.

import { createHash } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createFanslyPage,
  createModel,
  ensureDomainEventPartitions,
  insertObservation,
  runWithPageSyncExecutionContext,
  startSyncRun,
  type SyncStream,
} from "@agency_hub_core/db";

import {
  publishCaptureCasDualWritePages,
  publishCaptureCasPointerOnlyPages,
  resetCaptureCasDualWriteForTests,
} from "../apps/runtime/src/services/capture-cas-dual-write.ts";
import { runCanonicalization } from "../apps/runtime/src/services/canonicalize-driver.ts";
import { FANSLY_REPLAY_FAMILY } from "../apps/runtime/src/services/canonicalize/fansly-replay.ts";
import {
  ACCOUNT_ME_REPAIR_PRODUCER,
  accountMeRepairKey,
  runAccountMeRejournal,
} from "../apps/runtime/src/services/observations-account-me-rejournal.ts";
import { resetCaptureCasReadForTests } from "../apps/runtime/src/services/payload-reader.ts";
import { persistRawPayload, retentionDate } from "../apps/runtime/src/services/sync/shared.ts";
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
  resetCaptureCasDualWriteForTests();
  resetCaptureCasReadForTests();
  if (testDb) {
    await resetIntegrationDatabase(testDb.pool);
  }
});

function appStub() {
  return {
    db: testDb!.db,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  } as never;
}

async function seedPage(label: string, nativeId: string) {
  const model = await createModel(testDb!.db, { slug: `m-${label}`, name: label });
  if (!model) throw new Error(`model ${label} was not created`);
  const page = await createFanslyPage(testDb!.db, { modelId: model.id, label });
  if (!page) throw new Error(`page ${label} was not created`);
  await testDb!.pool.query("update pages set external_page_id = $1 where id = $2", [nativeId, page.id]);
  return page;
}

function accountMe(nativeId: string, followCount: number) {
  return {
    account: {
      id: nativeId,
      username: "creator",
      displayName: "Creator",
      followCount,
      subscriberCount: 3,
      createdAt: 1_600_000_000_000,
    },
  };
}

/** One account_me capture, exactly as refreshPageMetadata made it: inside a
 *  chunk of (stream, requestSeq), with or without the chunk's run id. */
async function capture(input: {
  pageId: number;
  stream: SyncStream;
  requestSeq: number;
  body: unknown;
  syncRunId?: number | null;
}) {
  return runWithPageSyncExecutionContext(
    { pageId: input.pageId, stream: input.stream, requestSeq: input.requestSeq, leaseToken: "t" },
    () => persistRawPayload(testDb!.db, {
      platformAccountId: input.pageId,
      syncRunId: input.syncRunId ?? null,
      endpoint: "account_me",
      requestParams: {},
      responsePayload: input.body,
      mapperVersion: "test-v1",
      payloadKind: "mapping_critical",
      retainUntil: retentionDate(),
    }, { platform: "fansly" }),
  );
}

async function query<T>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await testDb!.pool.query(text, params)).rows as T[];
}

async function observationCount(): Promise<number> {
  const [row] = await query<{ n: string }>("select count(*)::text as n from observations");
  return Number(row!.n);
}

describe("observations:rejournal-account-me (J4)", () => {
  it("re-journals exactly the dropped captures, verbatim and dated at capture; dry-run writes nothing; re-runs are no-ops", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const inline = await seedPage("inline", "7001");
    const pointer = await seedPage("pointer", "7002");
    // Production is pointer-only for these rows: both canaries on for one page.
    publishCaptureCasDualWritePages(String(pointer.id));
    publishCaptureCasPointerOnlyPages(String(pointer.id));

    // Request 42 (followers_reconcile): sweep start in chunk 1, closing
    // account_me as the first capture of chunk 2 — same key, swallowed.
    const sweepStart = await capture({ pageId: inline.id, stream: "followers_reconcile", requestSeq: 42, body: accountMe("7001", 10) });
    const closing = await capture({ pageId: inline.id, stream: "followers_reconcile", requestSeq: 42, body: accountMe("7001", 11) });
    // Request 45: two IDENTICAL bodies; the later capture is the dropped one.
    await capture({ pageId: inline.id, stream: "followers_reconcile", requestSeq: 45, body: accountMe("7001", 12) });
    const identical = await capture({ pageId: inline.id, stream: "followers_reconcile", requestSeq: 45, body: accountMe("7001", 12) });
    // Request 43 (light): one capture, one observation — healthy.
    await capture({ pageId: inline.id, stream: "light", requestSeq: 43, body: accountMe("7001", 13) });
    // Request 44: the fixed shape (each chunk's run id in its key), whose runs
    // are later pruned (sync_run_id is ON DELETE SET NULL) — fully journaled,
    // so not a candidate although its raw rows now look run-less too.
    for (const followCount of [14, 15]) {
      const run = await startSyncRun(testDb.db, {
        platformAccountId: inline.id, stream: "followers_reconcile", trigger: "scheduled",
      });
      if (!run) throw new Error("run seed failed");
      await capture({
        pageId: inline.id, stream: "followers_reconcile", requestSeq: 44,
        body: accountMe("7001", followCount), syncRunId: run.id,
      });
    }
    // Request 7 on the pointer-only page: the same collision.
    await capture({ pageId: pointer.id, stream: "followers_reconcile", requestSeq: 7, body: accountMe("7002", 20) });
    const pointerClosing = await capture({ pageId: pointer.id, stream: "followers_reconcile", requestSeq: 7, body: accountMe("7002", 21) });

    // The collision really happened: three captures without an observation.
    expect(closing.observationId).toBe(sweepStart.observationId);
    const [counts] = await query<{ raw: string; obs: string }>(`
      select (select count(*) from sync_raw_payloads where endpoint = 'account_me')::text as raw,
             (select count(*) from observations where kind = 'account_me')::text as obs
    `);
    expect(counts).toEqual({ raw: "9", obs: "6" });

    // Request 46: an observation whose body matches neither capture — nothing
    // is safe to conclude, so the request is reported and left alone.
    await testDb.pool.query(
      `insert into sync_raw_payloads
         (page_id, stream, request_seq, endpoint, request_params, response_payload,
          mapper_version, payload_kind, retain_until)
       select $1, 'followers_reconcile', 46, 'account_me', '{}'::jsonb, body::jsonb,
              'test-v1', 'mapping_critical', now() + interval '100 years'
       from unnest(array[$2, $3]) as body`,
      [inline.id, JSON.stringify(accountMe("7001", 30)), JSON.stringify(accountMe("7001", 31))],
    );
    await insertObservation(testDb.db, {
      source: "pull",
      producer: "sync:fansly:followers_reconcile",
      platform: "fansly",
      accountId: inline.id,
      kind: "account_me",
      payload: accountMe("7001", 99),
      payloadHash: Buffer.alloc(32),
      idempotencyKey: `${inline.id}:followers_reconcile:norun:46.1`,
    });

    // Honest dating: the closing capture happened on 2026-08-10.
    const capturedAt = new Date("2026-08-10T05:00:00.000Z");
    await testDb.pool.query("update sync_raw_payloads set captured_at = $2 where id = $1", [closing.id, capturedAt]);
    await testDb.pool.query("update sync_raw_payloads set sync_run_id = null");

    // ── dry-run (the default): the census, and not one write ────────────────
    const observationsBefore = await observationCount();
    const dry = await runAccountMeRejournal(appStub());
    expect(dry).toEqual({
      dryRun: true,
      requests: 4,
      unpairedRequests: 1,
      perStream: {
        followers_reconcile: { missing: 3, rejournaled: 3, alreadyRejournaled: 0, unavailableBody: 0, errored: 0 },
      },
      totals: { missing: 3, rejournaled: 3, alreadyRejournaled: 0, unavailableBody: 0, errored: 0 },
    });
    expect(await observationCount()).toBe(observationsBefore);

    // ── execute ─────────────────────────────────────────────────────────────
    const done = await runAccountMeRejournal(appStub(), { dryRun: false });
    expect(done.totals).toEqual({ missing: 3, rejournaled: 3, alreadyRejournaled: 0, unavailableBody: 0, errored: 0 });
    expect(await observationCount()).toBe(observationsBefore + 3);

    const repaired = await query<{
      idempotency_key: string;
      producer: string;
      source: string;
      platform: string;
      account_id: string;
      kind: string;
      payload: unknown;
      payload_hash: Buffer;
      payload_object_id: string | null;
      received_at: Date;
    }>(`
      select idempotency_key, producer, source, platform, account_id::text as account_id, kind,
             payload, payload_hash, payload_object_id::text as payload_object_id, received_at
      from observations where producer = $1 order by idempotency_key
    `, [ACCOUNT_ME_REPAIR_PRODUCER]);
    expect(repaired.map((row) => row.idempotency_key).sort()).toEqual(
      [accountMeRepairKey(closing.id), accountMeRepairKey(identical.id), accountMeRepairKey(pointerClosing.id)].sort(),
    );
    const byKey = new Map(repaired.map((row) => [row.idempotency_key, row]));

    // Verbatim, dated at capture, attributed like the capture it replaces.
    const closingRow = byKey.get(accountMeRepairKey(closing.id))!;
    expect(closingRow).toMatchObject({
      source: "pull",
      platform: "fansly",
      account_id: String(inline.id),
      kind: "account_me",
      payload: accountMe("7001", 11),
      payload_object_id: null,
    });
    expect(closingRow.received_at.toISOString()).toBe(capturedAt.toISOString());
    expect(closingRow.payload_hash.equals(
      createHash("sha256").update(JSON.stringify(closingRow.payload)).digest(),
    )).toBe(true);

    // Pointer-only in, pointer-only out: the SAME catalog object, no inline copy.
    const [pointerRaw] = await query<{ payload_object_id: string }>(
      "select payload_object_id::text as payload_object_id from sync_raw_payloads where id = $1",
      [pointerClosing.id],
    );
    const pointerRow = byKey.get(accountMeRepairKey(pointerClosing.id))!;
    expect(pointerRaw!.payload_object_id).not.toBeNull();
    expect(pointerRow.payload).toBeNull();
    expect(pointerRow.payload_object_id).toBe(pointerRaw!.payload_object_id);

    // The unpaired request was left alone.
    const [untouched] = await query<{ n: string }>(`
      select count(*)::text as n from observations o
      join sync_raw_payloads r on o.idempotency_key = 'repair:account_me:raw:' || r.id
      where r.request_seq = 46
    `);
    expect(untouched!.n).toBe("0");

    // The replay reads the repaired snapshot on the day it was captured.
    await ensureDomainEventPartitions(testDb.db);
    await runCanonicalization(appStub(), { families: [FANSLY_REPLAY_FAMILY], accountIds: [inline.id] });
    const identity = await query<{ follow_count: string }>(`
      select data->>'followCount' as follow_count from domain_events
      where account_id = $1 and type = 'page.identity_observed' and data->>'businessDate' = '2026-08-10'
    `, [inline.id]);
    expect(identity).toEqual([{ follow_count: "11" }]);

    // ── re-runs: nothing new, in either mode ─────────────────────────────────
    const again = await runAccountMeRejournal(appStub(), { dryRun: false });
    expect(again.totals).toEqual({ missing: 3, rejournaled: 0, alreadyRejournaled: 3, unavailableBody: 0, errored: 0 });
    const dryAgain = await runAccountMeRejournal(appStub());
    expect(dryAgain.totals).toEqual({ missing: 3, rejournaled: 0, alreadyRejournaled: 3, unavailableBody: 0, errored: 0 });
    expect(await observationCount()).toBe(observationsBefore + 3);

    // Scoped to one page, the other page's capture is out of sight.
    const scoped = await runAccountMeRejournal(appStub(), { accountId: pointer.id });
    expect(scoped.totals.missing).toBe(1);
    expect(scoped.unpairedRequests).toBe(0);
  });
});
