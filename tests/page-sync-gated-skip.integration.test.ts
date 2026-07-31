import { describe, expect, it } from "vitest";

import {
  acquirePageSyncLease,
  createFanslyPage,
  createModel,
  ensurePageSyncStates,
  getPageSyncState,
  requestPageSync,
  skipPageSync,
} from "@agency_hub_core/db";

import { startIntegrationTestDatabase } from "./helpers/db.ts";

/** A ramp-gated chunk (platform / flag / allowlist) short-circuits before any
 *  egress. It used to terminate through completePageSync, which stamped
 *  succeeded_at = now() and zeroed consecutive_failures for a stream that
 *  issued zero requests. That is how lora-1's fan_earnings feed sat dead from
 *  2026-07-17 to 2026-07-31 while every instrument read healthy. skipPageSync
 *  must release the lease and advance applied_seq while claiming NOTHING. */
describe("page sync gated skip", () => {
  async function seedLeasedFanEarnings(
    testDb: NonNullable<Awaited<ReturnType<typeof startIntegrationTestDatabase>>>,
    label: string,
  ) {
    const model = await createModel(testDb.db, {
      slug: `${label}-model`,
      name: `${label} model`,
    });
    if (!model) {
      throw new Error("Expected to create a model");
    }
    const page = await createFanslyPage(testDb.db, {
      modelId: model.id,
      label,
    });
    if (!page) {
      throw new Error("Expected to create a page");
    }
    await ensurePageSyncStates(testDb.db, { pageId: page.id });
    // Seeding a page auto-requests `light`, and the lease picker takes the
    // highest-priority runnable stream. Settle everything else so the lease
    // below can only be the one this test is about.
    await testDb.pool.query(
      `
        update page_sync_states
        set applied_seq = request_seq, status = 'idle'
        where page_id = $1 and stream <> 'fan_earnings'
      `,
      [page.id],
    );
    await requestPageSync(testDb.db, {
      pageId: page.id,
      streams: ["fan_earnings"],
      source: "scheduled",
    });

    // Deliberately old and non-zero: the assertions below are about what the
    // skip must NOT touch, so these values have to be distinguishable from
    // anything the function could write.
    await testDb.pool.query(
      `
        update page_sync_states
        set succeeded_at = timestamptz '2026-07-17 14:25:00+00',
            progressed_at = timestamptz '2026-07-17 14:25:00+00',
            consecutive_failures = 2,
            last_error_code = 'http_500',
            last_error_summary = 'upstream blew up'
        where page_id = $1 and stream = 'fan_earnings'
      `,
      [page.id],
    );

    const lease = await acquirePageSyncLease(testDb.db, {
      pageId: page.id,
      workerId: `${label}-worker`,
      leaseToken: `${label}-token`,
      leaseTtlMs: 60_000,
    });
    if (!lease || lease.stream !== "fan_earnings") {
      throw new Error(`Expected a fan_earnings lease, got ${lease?.stream ?? "none"}`);
    }

    return { page, lease, leasedSeq: lease.leasedSeq ?? lease.requestSeq };
  }

  it("releases the lease and advances applied_seq while claiming no success", async () => {
    const testDb = await startIntegrationTestDatabase();
    if (!testDb) {
      return;
    }

    try {
      const { page, leasedSeq } = await seedLeasedFanEarnings(testDb, "gated-skip-page");

      await expect(skipPageSync(testDb.db, {
        pageId: page.id,
        stream: "fan_earnings",
        requestSeq: leasedSeq,
        leaseToken: "gated-skip-page-token",
        progress: { skipped: "not_allowlisted" },
      })).resolves.toBe(true);

      const state = await getPageSyncState(testDb.db, page.id, "fan_earnings");
      expect(state).toMatchObject({
        status: "idle",
        appliedSeq: leasedSeq,
        requestSeq: leasedSeq,
        leasedSeq: null,
        leaseToken: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        retryAt: null,
        blockerKind: null,
      });
      expect(state?.finishedAt).not.toBeNull();

      // The whole point of the change: a skip is neither a success nor a
      // failure, so it moves none of these.
      expect(state?.succeededAt?.toISOString()).toBe("2026-07-17T14:25:00.000Z");
      expect(state?.progressedAt?.toISOString()).toBe("2026-07-17T14:25:00.000Z");
      expect(state?.consecutiveFailures).toBe(2);
      expect(state?.lastErrorCode).toBe("http_500");
      expect(state?.lastErrorSummary).toBe("upstream blew up");
    } finally {
      await testDb.stop();
    }
  }, 30_000);

  it("refuses a foreign lease token and leaves every column alone", async () => {
    const testDb = await startIntegrationTestDatabase();
    if (!testDb) {
      return;
    }

    try {
      const { page, leasedSeq } = await seedLeasedFanEarnings(testDb, "gated-skip-fence");
      const before = await getPageSyncState(testDb.db, page.id, "fan_earnings");

      await expect(skipPageSync(testDb.db, {
        pageId: page.id,
        stream: "fan_earnings",
        requestSeq: leasedSeq,
        leaseToken: "someone-elses-token",
        progress: { skipped: "not_allowlisted" },
      })).resolves.toBe(false);

      const after = await getPageSyncState(testDb.db, page.id, "fan_earnings");
      expect(after).toEqual(before);
    } finally {
      await testDb.stop();
    }
  }, 30_000);
});
