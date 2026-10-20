import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  claimFanEarningsRotation, settleFanEarningsReceipt, upsertTransaction,
  upsertFanslyTransactionWithEarningsDirty, type FanEarningsClaim,
} from "@agency_hub_core/db";
import { millsFromInteger } from "@agency_hub_core/shared";
import { startIntegrationTestDatabase, resetIntegrationDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { earningsShadowFixture } from "./helpers/earnings-shadow-fixture.ts";

let db: StartedTestDatabase;
let f: Awaited<ReturnType<typeof earningsShadowFixture>>;
const at = (seconds = 0) => new Date(Date.now() + seconds * 1000);
beforeAll(async () => {
  const started = await startIntegrationTestDatabase();
  if (!started) throw new Error("Docker Postgres required");
  db = started;
}, 120000);
afterAll(async () => { await db?.stop(); });
beforeEach(async () => {
  await resetIntegrationDatabase(db.pool);
  f = await earningsShadowFixture(db);
  // A transaction and an earnings baseline both predate the status signal.
  await upsertTransaction(db.db, f.transaction);
});

async function claim(window: "lifetime" | "monthly" = "lifetime") {
  const result = await claimFanEarningsRotation(db.db, {
    pageId: f.page.id, fanRef: "fan-a", window, now: at(),
  });
  if (!result) throw new Error("Claim unavailable");
  return result;
}
async function observe(token: FanEarningsClaim, fingerprint = "a") {
  return settleFanEarningsReceipt(db.db, token, {
    outcome: "observed", observationId: await f.observation(),
    fingerprint: fingerprint.repeat(64), checkedAt: at(1),
  });
}
async function posted() {
  await upsertFanslyTransactionWithEarningsDirty(db.db, {
    ...f.transaction, rawStatus: 2, transactionState: "posted",
  });
}
async function money(rawStatus = 1) {
  await upsertFanslyTransactionWithEarningsDirty(db.db, {
    ...f.transaction, rawStatus, transactionState: rawStatus === 1 ? "pending" : "posted",
    grossAmountMills: millsFromInteger(200),
  });
}
async function lifetime() { return (await f.rows()).find((row) => row.plane === "fan_earnings_lifetime"); }

describe("Fansly pending-to-posted earnings rechecks", () => {
  it("rechecks both endpoints and settles unchanged content without inventing a change", async () => {
    await observe(await claim());
    await observe(await claim("monthly"));
    await posted();
    expect((await f.rows()).map((row) => row.requested_revision)).toEqual([1n, 1n]);
    await observe(await claim());
    expect(await lifetime()).toMatchObject({
      requested_revision: 1n, applied_revision: 1n, last_refresh_outcome: "observed",
      refresh_checks: 2n, refresh_changes: 0n, last_changed_at: null,
      retry_after_at: null, next_due_at: null,
    });
    expect((await f.rows()).find((row) => row.plane === "fan_earnings_monthly"))
      .toMatchObject({ requested_revision: 1n, applied_revision: 0n });
    await observe(await claim("monthly"));
    expect((await f.rows()).map((row) => row.applied_revision)).toEqual([1n, 1n]);
  });

  it("keeps a first baseline after status-only discovery unconfirmed", async () => {
    await posted();
    await observe(await claim());
    expect(await lifetime()).toMatchObject({ applied_revision: 0n, last_refresh_outcome: "unconfirmed" });
    await observe(await claim());
    expect(await lifetime()).toMatchObject({ applied_revision: 1n, refresh_changes: 0n });
  });

  it("does not let a later status signal erase outstanding money debt", async () => {
    await observe(await claim());
    await money();
    await money(2);
    await observe(await claim());
    expect(await lifetime()).toMatchObject({ requested_revision: 2n, applied_revision: 0n, last_refresh_outcome: "unconfirmed" });
  });

  it("settles money R then unchanged status R+1 without losing either revision", async () => {
    await observe(await claim());
    await money();
    const r = await claim();
    await money(2);
    await observe(r, "b");
    expect(await lifetime()).toMatchObject({ requested_revision: 2n, applied_revision: 1n });
    await observe(await claim(), "b");
    expect(await lifetime()).toMatchObject({ applied_revision: 2n, refresh_changes: 1n });
  });

  it("retains money R+1 arriving during a status-only R fetch", async () => {
    await observe(await claim());
    await posted();
    const r = await claim();
    await money(2);
    await observe(r);
    expect(await lifetime()).toMatchObject({ requested_revision: 2n, applied_revision: 0n });
    await observe(await claim());
    expect(await lifetime()).toMatchObject({ applied_revision: 0n, last_refresh_outcome: "unconfirmed" });
    await observe(await claim(), "b");
    expect(await lifetime()).toMatchObject({ applied_revision: 2n });
  });

  it.each(["empty", "invalid", "rejected", "failed"] as const)("keeps status debt after %s", async (outcome) => {
    await observe(await claim());
    await posted();
    await settleFanEarningsReceipt(db.db, await claim(), {
      outcome, observationId: null, fingerprint: null, checkedAt: at(1),
    });
    expect(await lifetime()).toMatchObject({ applied_revision: 0n, last_refresh_outcome: outcome });
  });

  it("does not treat posted-to-pending or status plus another semantic change as neutral", async () => {
    await observe(await claim());
    await posted();
    await observe(await claim());
    await upsertFanslyTransactionWithEarningsDirty(db.db, f.transaction);
    await observe(await claim());
    expect(await lifetime()).toMatchObject({ requested_revision: 2n, applied_revision: 1n, last_refresh_outcome: "unconfirmed" });
    await observe(await claim(), "b");
    await upsertFanslyTransactionWithEarningsDirty(db.db, {
      ...f.transaction, rawStatus: 2, transactionState: "posted", senderId: "changed",
    });
    await observe(await claim(), "b");
    expect(await lifetime()).toMatchObject({ requested_revision: 3n, applied_revision: 2n, last_refresh_outcome: "unconfirmed" });
  });
});
