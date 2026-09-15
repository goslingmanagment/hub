import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  getCheckpoint,
} from "@agency_hub_core/db";
import { FanslyApiError } from "@agency_hub_core/fansly";
import { startTestDatabase, resetIntegrationDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { earningsTargetFixture } from "./helpers/earnings-target-fixture.ts";
import { executeErasure } from "../apps/runtime/src/services/erasure/index.ts";

let db: StartedTestDatabase;
beforeAll(async () => { db = await startTestDatabase(); }, 120_000);
afterAll(async () => { await db?.stop(); });
beforeEach(async () => { await resetIntegrationDatabase(db.pool); });

const fixture = () => earningsTargetFixture(db);

describe("default-off addressed earnings", () => {
  it.each(["off", "empty_allowlist", "zero_budget"])("preserves exactly the original daily walk when %s", async mode => {
    const f = await fixture(); await f.dirty();
    if (mode === "off") f.app.config.fanslyFanEarningsTargetsEnabled = false;
    if (mode === "empty_allowlist") f.app.config.fanslyFanEarningsTargetsPageAllowlist = "";
    if (mode === "zero_budget") f.app.config.fanslyFanEarningsTargetsDailyAttemptLimit = 0;
    await f.chunk();
    expect(f.visits).toEqual(["fan-a", "fan-b"].flatMap(fanRef => [
      { fanRef, window: "lifetime" }, { fanRef, window: "monthly" },
    ]));
    expect(await f.attempts()).toBe(0);
  });
  it("captures an undiscovered fan without displacing the two daily fans", async () => {
    const f = await fixture(); await f.dirty();
    await f.chunk();
    expect(f.visits).toHaveLength(5);
    expect(f.visits[0]).toEqual({ fanRef: "absent-fan", window: "lifetime" });
    expect(await f.attempts()).toBe(1);
    expect((await f.rows()).find(row => row.subject_ref === "absent-fan" && row.plane === "fan_earnings_lifetime"))
      .toMatchObject({ last_refresh_outcome: "unconfirmed", refresh_checks: 1n, applied_revision: 0n });
    expect((await getCheckpoint(db.db, f.page.id, "fan_earnings"))?.state).toMatchObject({ cursorFanId: f.fans[1]!.id });
    const raw = (await db.pool.query("select request_params from sync_raw_payloads where request_params->>'selection'='target'")).rows;
    expect(raw).toHaveLength(1);
    expect(raw[0].request_params).toMatchObject({ correlationAccountId: "absent-fan", spendersOnly: false, fanId: null });
  });
  it("does not filter zero or negative fans from dirty selection", async () => {
    const f = await fixture();
    await db.pool.query("update page_fans set total_creator_net_mills=-100 where fan_id=$1", [f.fans[0]!.id]);
    await db.pool.query("update page_fans set total_creator_net_mills=0 where fan_id=$1", [f.fans[1]!.id]);
    await f.dirty(["fan-a", "fan-b"]);
    for (let n = 0; n < 4; n++) await f.step();
    expect(new Set(f.visits.map(v => v.fanRef))).toEqual(new Set(["fan-a", "fan-b"]));
    expect(f.visits).toHaveLength(4);
  });
  it("retains one endpoint's rejection while the other and daily work proceed", async () => {
    const f = await fixture(); await f.dirty();
    f.beforeResponse.mockImplementation(async (fanRef, window) => {
      if (fanRef === "absent-fan" && window === "lifetime") throw new FanslyApiError("gone", 404);
    });
    await f.chunk();
    expect(f.visits).toHaveLength(5);
    await f.step();
    const rows = (await f.rows()).filter(row => row.subject_ref === "absent-fan");
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ plane: "fan_earnings_lifetime", consecutive_failures: 1, refresh_checks: 0n, last_refresh_outcome: "rejected" }),
      expect.objectContaining({ plane: "fan_earnings_monthly", consecutive_failures: 0, refresh_checks: 1n }),
    ]));
  });
  it("preserves absolute provider cooldown and makes no ordinary calls after 429", async () => {
    const f = await fixture(); await f.dirty();
    const retryAt = new Date(Date.now() + 3_600_000);
    const error = new FanslyApiError("limited", 429, undefined, undefined, retryAt);
    f.beforeResponse.mockRejectedValueOnce(error);
    await expect(f.chunk()).rejects.toBe(error);
    expect(f.visits).toHaveLength(1);
    expect((await f.rows())[0].retry_after_at).toEqual(retryAt);
  });
  it("rechecks off immediately before transport without inventing a failure receipt", async () => {
    const f = await fixture(); await f.dirty();
    f.beforeDispatch.mockImplementation(async () => { f.app.config.fanslyFanEarningsTargetsEnabled = false; });
    await f.step();
    expect(f.visits).toEqual([]);
    expect(await f.attempts()).toBe(0);
    expect((await f.rows())[0]).toMatchObject({ refresh_visits: 0n, refresh_receipts: 0n, refresh_checks: 0n, consecutive_failures: 0, claim_token: null });
  });
  it("holds the rolling cap across off/on while daily rotation still proceeds", async () => {
    const f = await fixture(); await f.dirty();
    f.app.config.fanslyFanEarningsTargetsDailyAttemptLimit = 1;
    await f.step();
    f.app.config.fanslyFanEarningsTargetsEnabled = false;
    f.app.config.fanslyFanEarningsTargetsEnabled = true;
    await f.chunk();
    expect(await f.attempts()).toBe(1);
    expect(f.visits).toHaveLength(5);
    expect(f.visits.filter(v => v.fanRef === "absent-fan")).toHaveLength(1);
  });
  it("settles only claimed R when R+1 arrives during the request", async () => {
    const f = await fixture(); await f.dirty();
    await db.pool.query("update subject_refresh_state set last_content_fingerprint='previous' where plane='fan_earnings_lifetime'");
    f.beforeResponse.mockImplementationOnce(async () => { await f.dirty(); });
    await f.step();
    expect((await f.rows())[0]).toMatchObject({ requested_revision: 2n, applied_revision: 1n, refresh_checks: 1n });
  });
  it("does not recreate erased target custody and erases page-owned attempt reservations", async () => {
    const f = await fixture(); await f.dirty(["fan-a"]);
    const ownerId = Number((await db.pool.query("insert into users(username,role) values ('c2c-owner','owner') returning id")).rows[0].id);
    f.beforeResponse.mockImplementationOnce(async () => {
      await executeErasure(f.app, { scopeType: "fan", platform: "fansly", fanRef: "fan-a" }, { initiatedBy: ownerId });
    });
    await expect(f.step()).rejects.toThrow("fan_earnings_target_claim_fenced");
    expect((await f.rows()).filter(row => row.subject_ref === "fan-a")).toEqual([]);
    expect(await f.attempts()).toBe(1);
    await executeErasure(f.app, { scopeType: "page", pageLabel: f.page.label }, { initiatedBy: ownerId });
    expect(await f.attempts()).toBe(0);
  });
});
