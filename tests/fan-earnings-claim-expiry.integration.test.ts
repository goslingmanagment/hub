import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquirePageSyncLease, claimFanEarningsRotation, PageSyncLeaseLostError,
  runWithPageSyncExecutionContext,
} from "@agency_hub_core/db";
import { FanslyApiError } from "@agency_hub_core/fansly";
import { captureFanEarningsEndpoint } from "../apps/runtime/src/services/sync/fan-earnings-capture.ts";
import { resetIntegrationDatabase, startTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { earningsShadowFixture } from "./helpers/earnings-shadow-fixture.ts";

let db: StartedTestDatabase;
let f: Awaited<ReturnType<typeof earningsShadowFixture>>;
const payload = [{ correlationAccountId: "fan-a", type: 2110, totalGross: 100, totalNet: 80 }];
const expiredAt = new Date("2000-01-01T00:00:00Z");

beforeAll(async () => { db = await startTestDatabase(); }, 120_000);
afterAll(async () => { await db?.stop(); });
beforeEach(async () => {
  await resetIntegrationDatabase(db.pool);
  f = await earningsShadowFixture(db);
});

async function expireClaim() {
  const before = (await f.rows())[0];
  expect(before).toMatchObject({
    subject_ref: "fan-a", plane: "fan_earnings_lifetime",
    refresh_visits: 1n, refresh_receipts: 0n,
  });
  expect(before.claim_token).toBeTypeOf("string");
  // Simulate a fetch outliving five minutes without advancing global timers.
  await db.pool.query(`update subject_refresh_state set claim_expires_at = $2
    where page_id = $1 and plane = 'fan_earnings_lifetime' and subject_ref = 'fan-a'`,
  [f.page.id, expiredAt]);
  return before;
}

async function capture(fetch: () => Promise<{ items: unknown; raw?: unknown }>) {
  const input = await f.chunkInput();
  return captureFanEarningsEndpoint(f.app, {
    pageId: f.page.id, syncRunId: input.syncRunId,
    fan: { fanId: f.fans[0]!.id, platformUserId: "fan-a" },
    window: "lifetime", after: new Date(0), before: new Date(), shadow: true, fetch,
  });
}

async function capturedPayloads() {
  return (await db.pool.query(
    "select o.payload from observations o where o.account_id = $1 order by o.id", [f.page.id],
  )).rows;
}

describe("C2b receipts after claim expiry during a fetch", () => {
  it("captures the completed response before renewing its original claim", async () => {
    await db.pool.query(`create function require_capture_before_claim_renewal() returns trigger
      language plpgsql as $$ begin
        if new.claim_expires_at > old.claim_expires_at and not exists (
          select 1 from observations where account_id = new.page_id and kind = 'fan_earnings_stats'
        ) then raise exception 'claim renewed before capture'; end if;
        return new; end $$;
      create trigger require_capture_before_claim_renewal before update on subject_refresh_state
      for each row execute function require_capture_before_claim_renewal()`);
    try {
      const fetch = vi.fn(async () => {
        await expireClaim();
        return { items: payload, raw: payload };
      });
      await capture(fetch);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(await capturedPayloads()).toEqual([{ payload }]);
      expect((await f.rows())[0]).toMatchObject({
        refresh_visits: 1n, refresh_receipts: 1n, refresh_checks: 1n,
        last_refresh_outcome: "observed", claim_token: null,
      });
    } finally {
      await db.pool.query(`drop trigger require_capture_before_claim_renewal on subject_refresh_state;
        drop function require_capture_before_claim_renewal()`);
    }
  });

  it("records a late failure without changing the provider error or Retry-After", async () => {
    const retryAfterAt = new Date(Date.now() + 3_600_000);
    const failure = new FanslyApiError("provider cooldown", 429, undefined, undefined, retryAfterAt);
    const fetch = vi.fn(async () => {
      await expireClaim();
      throw failure;
    });
    await expect(capture(fetch)).rejects.toBe(failure);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await capturedPayloads()).toEqual([]);
    expect((await f.rows())[0]).toMatchObject({
      refresh_visits: 1n, refresh_receipts: 1n, refresh_checks: 0n,
      last_refresh_outcome: "failed", retry_after_at: retryAfterAt, claim_token: null,
    });
  });

  it("keeps captured bytes and missing-receipt debt when another claim takes over", async () => {
    let replacementToken: string | undefined;
    const fetch = vi.fn(async () => {
      const original = await expireClaim();
      const replacement = await claimFanEarningsRotation(db.db, {
        pageId: f.page.id, fanRef: "fan-a", window: "lifetime", now: new Date(),
      });
      expect(replacement?.token).not.toBe(original.claim_token);
      replacementToken = replacement?.token;
      return { items: payload, raw: payload };
    });
    await capture(fetch);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(replacementToken).toBeTypeOf("string");
    expect(await capturedPayloads()).toEqual([{ payload }]);
    expect((await f.rows())[0]).toMatchObject({
      refresh_visits: 2n, refresh_receipts: 0n, refresh_checks: 0n,
      last_checked_at: null, claim_token: replacementToken,
    });
  });

  it("cannot renew a receipt after losing the owning page lease", async () => {
    await db.pool.query(`update page_sync_states set applied_seq = request_seq
      where page_id = $1 and stream <> 'fan_earnings'`, [f.page.id]);
    const lease = await acquirePageSyncLease(db.db, {
      pageId: f.page.id, workerId: "claim-expiry-test", leaseToken: "owned-page-lease", leaseTtlMs: 60_000,
    });
    if (!lease || lease.stream !== "fan_earnings") throw new Error("Expected earnings page lease");
    const fetch = vi.fn(async () => {
      await expireClaim();
      await db.pool.query(`update page_sync_states set lease_expires_at = $2
        where page_id = $1 and stream = 'fan_earnings'`, [f.page.id, expiredAt]);
      return { items: payload, raw: payload };
    });
    await expect(runWithPageSyncExecutionContext({
      pageId: f.page.id, stream: lease.stream,
      requestSeq: lease.leasedSeq ?? lease.requestSeq, leaseToken: "owned-page-lease",
    }, () => capture(fetch))).rejects.toBeInstanceOf(PageSyncLeaseLostError);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await capturedPayloads()).toEqual([{ payload }]);
    expect((await f.rows())[0]).toMatchObject({
      refresh_receipts: 0n, refresh_checks: 0n, claim_expires_at: expiredAt,
    });
  });
});
