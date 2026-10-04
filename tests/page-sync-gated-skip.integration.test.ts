import { describe, expect, it } from "vitest";

import {
  acquirePageSyncLease,
  createModel,
  createOnlyFansPage,
  ensurePageSyncStates,
  finishSyncRun,
  getPageSyncState,
  requestPageSync,
  skipPageSync,
  startSyncRun,
} from "@agency_hub_core/db";

import { getSyncMonitorSnapshot } from "../apps/runtime/src/services/sync-monitor.ts";
import { startIntegrationTestDatabase } from "./helpers/db.ts";
import { EVERY_PLATFORM } from "./helpers/page-sync-scope.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

/** A gated chunk (platform / flag / allowlist) short-circuits before any
 *  egress. It used to terminate through completePageSync, which stamped
 *  succeeded_at = now() and zeroed consecutive_failures for a stream that
 *  issued zero requests. That is how lora-1's fan_earnings feed sat dead from
 *  2026-07-17 to 2026-07-31 while every instrument read healthy. skipPageSync
 *  must release the lease and advance applied_seq while claiming NOTHING.
 *
 *  The legacy executor serves OnlyFans only (step 4); its gated lane here is
 *  `transactions` on a page whose transactions come from webhooks. */
describe("page sync gated skip", () => {
  async function seedLeasedTransactions(
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
    const page = await createOnlyFansPage(testDb.db, {
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
        where page_id = $1 and stream <> 'transactions'
      `,
      [page.id],
    );
    await requestPageSync(testDb.db, {
      pageId: page.id,
      streams: ["transactions"],
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
        where page_id = $1 and stream = 'transactions'
      `,
      [page.id],
    );

    const lease = await acquirePageSyncLease(testDb.db, {
      platforms: EVERY_PLATFORM,
      pageId: page.id,
      workerId: `${label}-worker`,
      leaseToken: `${label}-token`,
      leaseTtlMs: 60_000,
    });
    if (!lease || lease.stream !== "transactions") {
      throw new Error(`Expected a transactions lease, got ${lease?.stream ?? "none"}`);
    }

    return { page, lease, leasedSeq: lease.leasedSeq ?? lease.requestSeq };
  }

  it("releases the lease and advances applied_seq while claiming no success", async () => {
    const testDb = await startIntegrationTestDatabase();
    if (!testDb) {
      return;
    }

    try {
      const { page, leasedSeq } = await seedLeasedTransactions(testDb, "gated-skip-page");

      await expect(skipPageSync(testDb.db, {
        pageId: page.id,
        stream: "transactions",
        requestSeq: leasedSeq,
        leaseToken: "gated-skip-page-token",
        progress: { skipped: "onlyfans_transactions_webhook_sourced" },
      })).resolves.toBe(true);

      const state = await getPageSyncState(testDb.db, page.id, "transactions");
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
      const { page, leasedSeq } = await seedLeasedTransactions(testDb, "gated-skip-fence");
      const before = await getPageSyncState(testDb.db, page.id, "transactions");

      await expect(skipPageSync(testDb.db, {
        pageId: page.id,
        stream: "transactions",
        requestSeq: leasedSeq,
        leaseToken: "someone-elses-token",
        progress: { skipped: "onlyfans_transactions_webhook_sourced" },
      })).resolves.toBe(false);

      const after = await getPageSyncState(testDb.db, page.id, "transactions");
      expect(after).toEqual(before);
    } finally {
      await testDb.stop();
    }
  }, 30_000);

  it("tells a gate skip apart from a lost lease", async () => {
    const testDb = await startIntegrationTestDatabase();
    if (!testDb) {
      return;
    }

    async function recordRun(input: {
      pageId: number;
      stream: "light" | "transactions";
      status: "success" | "skipped";
      stats: Record<string, unknown>;
      errorSummary?: string;
      startedAt: string;
      finishedAt: string;
    }) {
      const run = await startSyncRun(testDb!.db, {
        platformAccountId: input.pageId,
        stream: input.stream,
        trigger: "scheduled",
      });
      if (!run) {
        throw new Error(`Expected to start a ${input.stream} sync run`);
      }
      await finishSyncRun(testDb!.db, run.id, {
        status: input.status,
        stats: input.stats,
        errorSummary: input.errorSummary ?? null,
      });
      await testDb!.pool.query(
        "update sync_runs set started_at = $1, finished_at = $2 where id = $3",
        [new Date(input.startedAt), new Date(input.finishedAt), run.id],
      );
      return run.id;
    }

    try {
      const model = await createModel(testDb.db, {
        slug: "gated-skip-monitor-model",
        name: "Gated Skip Monitor Model",
      });
      if (!model) {
        throw new Error("Expected to create a model");
      }
      const page = await createOnlyFansPage(testDb.db, {
        modelId: model.id,
        label: "gated-skip-monitor",
      });
      if (!page) {
        throw new Error("Expected to create a page");
      }
      await ensurePageSyncStates(testDb.db, { pageId: page.id });
      // Settle every row: this test is about what the monitor says AFTER a
      // chunk ran, and a still-queued row short-circuits to "catching up" long
      // before the branch under test. skipPageSync leaves exactly this shape.
      await testDb.pool.query(
        `
          update page_sync_states
          set applied_seq = request_seq, status = 'idle'
          where page_id = $1
        `,
        [page.id],
      );

      // A healthy light stream: it succeeded, and then a stale worker unwound
      // and wrote its lost-lease `skipped` with a LATER finished_at. That is the
      // ordering completed_runs picks, and it is why the UX must not read the
      // outcome alone.
      await recordRun({
        pageId: page.id,
        stream: "light",
        status: "success",
        stats: {},
        startedAt: "2026-07-30T10:00:00.000Z",
        finishedAt: "2026-07-30T10:01:00.000Z",
      });
      await recordRun({
        pageId: page.id,
        stream: "light",
        status: "skipped",
        stats: {},
        errorSummary: "Page sync lease lost",
        startedAt: "2026-07-30T09:59:00.000Z",
        finishedAt: "2026-07-30T10:02:00.000Z",
      });
      await testDb.pool.query(
        "update page_sync_states set succeeded_at = $1 where page_id = $2 and stream = 'light'",
        [new Date("2026-07-30T10:01:00.000Z"), page.id],
      );

      // A genuinely gated stream, carrying the structured marker.
      await recordRun({
        pageId: page.id,
        stream: "transactions",
        status: "skipped",
        stats: { skipped: "onlyfans_transactions_webhook_sourced", gatedSkip: "onlyfans_transactions_webhook_sourced" },
        errorSummary: "onlyfans_transactions_webhook_sourced",
        startedAt: "2026-07-30T10:00:00.000Z",
        finishedAt: "2026-07-30T10:00:05.000Z",
      });

      const snapshot = await getSyncMonitorSnapshot(createTestAppContext(testDb), {
        pageLabel: "gated-skip-monitor",
      });
      const monitored = snapshot.pages.find((item) => item.pageLabel === "gated-skip-monitor");
      if (!monitored) {
        throw new Error("Expected the page in the monitor snapshot");
      }
      const streamState = (stream: string) =>
        monitored.streams.find((item) => item.stream === stream)?.syncUx.state;

      // Defect 1: a lost lease is not a gate. Reading the `skipped` outcome
      // alone reported this healthy stream as "gated off" until its next run.
      expect(streamState("light")).not.toBe("off");

      // The gated stream tells the truth about itself.
      expect(streamState("transactions")).toBe("off");
    } finally {
      await testDb.stop();
    }
  }, 30_000);
});
