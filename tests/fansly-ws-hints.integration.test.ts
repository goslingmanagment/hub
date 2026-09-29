import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  advanceFanslyWsHint, admitFanslyWsHintAttempt, claimFanslyWsHint, nextFanslyWsHintBudgetAt, routeFanslyWsHintEvent,
  saveFanslyWsHintWalk, isFanslyWsHintClaimEnabled, type Database, type FanslyWsHintEvent,
} from "@agency_hub_core/db";
import type { FanslyWsHintPolicy } from "@agency_hub_core/shared";
import { startTestDatabase, resetIntegrationDatabase, seedFanslyPage, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

let db: StartedTestDatabase;
beforeAll(async () => { db = await startTestDatabase(); }, 120_000);
afterAll(async () => { await db?.stop(); });
beforeEach(async () => { await resetIntegrationDatabase(db.pool); });
const now = new Date("2026-09-15T01:00:00Z");
const later = (seconds: number) => new Date(now.getTime() + seconds * 1000);
const policy: FanslyWsHintPolicy = {
  generation: "a".repeat(64), activationAt: "2026-09-15T00:00:00Z",
  enabledTypes: new Set(["message_created", "group_created"]),
  baselineAttempts24h: 100, baselineReference: "fixture", maxAttempts24h: 5,
};

async function fixture() {
  const app = createTestAppContext(db);
  const seeded = await seedFanslyPage(app.db, app.config.encryptionKey);
  if (!seeded.page) throw new Error("page missing");
  const pageId = seeded.page.id;
  const event = (id = 1, groupRef = "100"): FanslyWsHintEvent => ({
    id, pageId, observationId: id, receivedAt: now, generation: policy.generation,
    node: { path: [], outcome: "hint", hint: { type: "message_created", groupRef, messageRef: String(id + 1000) } },
  });
  const tx = <T>(run: (database: Database) => Promise<T>) => db.db.transaction(t => run(t as unknown as Database));
  const route = (e = event(), p: FanslyWsHintPolicy | null = policy) => tx(database => routeFanslyWsHintEvent(database, e, p));
  const claim = (at = now, p = policy) => tx(database => claimFanslyWsHint(database, pageId, p, at));
  const rows = async () => (await db.pool.query("select * from subject_refresh_state where page_id=$1 order by subject_ref", [pageId])).rows;
  return { app, pageId, event, tx, route, claim, rows };
}

// Nothing in routing or claiming depends on the burst size (claim is `limit 1`),
// so a small burst proves the same coalescing and durability as a large one.
const BURST = 20;

describe("B1 durable coalescing and claim settlement", () => {
  it(`coalesces ${BURST} signals to one subject and replay does not increment revisions`, async () => {
    const f = await fixture();
    await f.tx(async database => {
      for (let id = 1; id <= BURST; id++) await routeFanslyWsHintEvent(database, f.event(id), policy);
      for (let id = 1; id <= BURST; id++) await routeFanslyWsHintEvent(database, f.event(id), policy);
    });
    expect(await f.rows()).toMatchObject([{ requested_revision: BigInt(BURST), applied_revision: 0n, next_due_at: now }]);
    expect((await f.rows()).length).toBe(1);
    expect((await db.pool.query("select count(*)::int n from fansly_ws_hint_receipts")).rows[0].n).toBe(BURST);
  });
  it(`keeps ${BURST} distinct groups durable while claiming only one at a time`, async () => {
    const f = await fixture();
    await f.tx(async database => {
      for (let id = 1; id <= BURST; id++) await routeFanslyWsHintEvent(database, f.event(id, String(id)), policy);
    });
    expect(await f.rows()).toHaveLength(BURST);
    const first = await f.claim();
    const second = await f.claim();
    expect(first?.groupRef).not.toBe(second?.groupRef);
    expect((await db.pool.query("select count(*)::int n from subject_refresh_state where claim_token is not null")).rows[0].n).toBe(2);
    expect((await db.pool.query("select count(*)::int n from fansly_ws_hint_attempts")).rows[0].n).toBe(0);
  });
  it("R+1 during R survives settlement, and an old token cannot settle again", async () => {
    const f = await fixture(); await f.route();
    const claim = (await f.claim())!;
    await f.tx(database => saveFanslyWsHintWalk(database, claim, { ...claim.walk, before: "500", boundaryMessageRef: "200" }));
    await f.route(f.event(2));
    await f.tx(database => advanceFanslyWsHint(database, claim, { walk: claim.walk, complete: true, outcome: "boundary_checked", now: later(1) }));
    expect(await f.rows()).toMatchObject([{ requested_revision: 2n, applied_revision: 1n, next_due_at: later(1), backfill_cursor: { generation: policy.generation } }]);
    await expect(f.tx(database => advanceFanslyWsHint(database, claim, { walk: claim.walk, complete: true, outcome: "stale", now: later(2) }))).rejects.toThrow("claim_fenced");
    expect((await f.claim(later(2)))?.revision).toBe(2);
  });
  it("preserves the original boundary and revision after expiry, despite R+1", async () => {
    const f = await fixture(); await f.route(); const first = (await f.claim())!;
    await f.tx(database => saveFanslyWsHintWalk(database, first, { ...first.walk, before: "500", boundaryMessageRef: "200" }));
    await f.route(f.event(2));
    // save uses the database clock; expire explicitly rather than assuming a test wall clock.
    await db.pool.query("update subject_refresh_state set claim_expires_at=$1", [later(1)]);
    const replacement = (await f.claim(later(2)))!;
    expect(replacement.revision).toBe(1);
    expect(replacement.walk).toMatchObject({ before: "500", boundaryMessageRef: "200", revision: 1 });
    await expect(f.tx(database => advanceFanslyWsHint(database, first, { walk: first.walk, complete: true, outcome: "old", now: later(3) }))).rejects.toThrow("claim_fenced");
  });
  it("rolls back the receipt and mark together on routing failure", async () => {
    const f = await fixture();
    await expect(f.tx(async database => { await routeFanslyWsHintEvent(database, f.event(), policy); throw new Error("crash"); })).rejects.toThrow("crash");
    expect(await f.rows()).toEqual([]);
    expect((await db.pool.query("select count(*)::int n from fansly_ws_hint_receipts")).rows[0].n).toBe(0);
    expect(await f.route()).toBe(true);
  });
  it("retains delete as debt without a head-read target", async () => {
    const f = await fixture();
    await f.route({ ...f.event(), node: { path: [], outcome: "mutation_debt", mutation: {
      groupRef: "100", messageRef: "99", correlationRef: "55", bulk: true,
    } } });
    expect(await f.rows()).toEqual([]);
    expect((await db.pool.query("select outcome,message_ref from fansly_ws_hint_receipts")).rows).toEqual([{ outcome: "mutation_debt", message_ref: "99" }]);
  });
  it("does not route disabled, unbound or pre-activation observations", async () => {
    const f = await fixture();
    await f.route(f.event(1), null);
    await f.route({ ...f.event(2), generation: null });
    await f.route({ ...f.event(3), receivedAt: new Date("2026-09-14T23:00:00Z") });
    expect(await f.rows()).toEqual([]);
    expect((await db.pool.query("select outcome from fansly_ws_hint_receipts order by event_id")).rows.map(r => r.outcome))
      .toEqual(["disabled", "generation_unknown", "before_activation"]);
  });
  it("changing the type allowlist or activation boundary revokes old queued work", async () => {
    const f = await fixture(); await f.route();
    expect(await f.claim(now, { ...policy, enabledTypes: new Set(["group_created"]) })).toBeNull();
    expect(await f.claim(now, { ...policy, activationAt: later(1).toISOString() })).toBeNull();
    const claim = (await f.claim())!;
    expect(await isFanslyWsHintClaimEnabled(db.db, claim, { ...policy, enabledTypes: new Set(["group_created"]) })).toBe(false);
    expect(await isFanslyWsHintClaimEnabled(db.db, claim, policy)).toBe(true);
  });
  it("new generation invalidates the old claim and starts a new boundary", async () => {
    const f = await fixture(); await f.route(); const old = (await f.claim())!;
    const nextPolicy = { ...policy, generation: "b".repeat(64) };
    await f.route({ ...f.event(2), generation: nextPolicy.generation }, nextPolicy);
    await expect(f.tx(database => advanceFanslyWsHint(database, old, { walk: old.walk, complete: true, outcome: "old", now }))).rejects.toThrow("claim_fenced");
    expect(await f.claim()).toBeNull();
    expect((await f.claim(now, nextPolicy))?.walk).toEqual({ generation: nextPolicy.generation });
  });
  it("a new allowed type releases a frozen disabled-type walk without applying its revision", async () => {
    const f = await fixture(); await f.route(); const original = (await f.claim())!;
    await f.tx(database => advanceFanslyWsHint(database, original, {
      walk: { ...original.walk, before: "500", boundaryMessageRef: "200" }, complete: false, outcome: "walk_pending", now,
    }));
    const nextPolicy: FanslyWsHintPolicy = { ...policy, enabledTypes: new Set(["group_created"]) };
    const nextEvent = f.event(2);
    nextEvent.node.hint = { type: "group_created", groupRef: "100", messageRef: null };
    await f.route(nextEvent, nextPolicy);
    const replacement = (await f.claim(now, nextPolicy))!;
    expect(replacement.revision).toBe(2);
    expect(replacement.walk).toEqual({ generation: policy.generation });
    expect(await f.rows()).toMatchObject([{ requested_revision: 2n, applied_revision: 0n }]);
  });
  it("counts retries and generation changes against one rolling page budget", async () => {
    const f = await fixture();
    const attempt = (attemptNumber: number, at = now) => f.tx(database => admitFanslyWsHintAttempt(database, {
      pageId: f.pageId, generation: attemptNumber % 2 ? policy.generation : "b".repeat(64),
      requestId: "request", attemptNumber, maxAttempts24h: 2, now: at,
    }));
    await attempt(1); await attempt(2);
    await expect(attempt(3)).rejects.toThrow("budget_exhausted");
    await attempt(3, later(86401));
    expect((await db.pool.query("select count(*)::int n from fansly_ws_hint_attempts where source='event'")).rows[0].n).toBe(3);
  });
  it("serves subjects deferred to one budget reopening in deferral order", async () => {
    const f = await fixture();
    const reopenAt = later(3600);
    const deferToReopen = async (at: Date) => {
      const claim = (await f.claim(at))!;
      await f.tx(database => advanceFanslyWsHint(database, claim, {
        walk: claim.walk, complete: false, outcome: "budget_exhausted", now: at, retryAt: reopenAt,
      }));
      return claim.groupRef;
    };
    // A newer conversation (higher snowflake) is refused first, an older one after it.
    await f.route(f.event(1, "900"));
    expect(await deferToReopen(later(1))).toBe("900");
    await f.route({ ...f.event(2, "100"), receivedAt: later(2) });
    expect(await deferToReopen(later(2))).toBe("100");
    expect((await f.rows()).map(row => row.next_due_at)).toEqual([reopenAt, reopenAt]);

    // Before, the tie fell to the lowest group id at every reopening.
    expect((await f.claim(reopenAt))?.groupRef).toBe("900");
    expect((await f.claim(reopenAt))?.groupRef).toBe("100");
  });
  it("names the moment admission reopens with the same rolling count", async () => {
    const f = await fixture();
    for (const [n, seconds] of [[1, -90_000], [2, 0], [3, 60], [4, 120], [5, 180]] as const) {
      await f.tx(database => admitFanslyWsHintAttempt(database, {
        pageId: f.pageId, generation: policy.generation, requestId: `r-${n}`, attemptNumber: 1,
        maxAttempts24h: 10, now: later(seconds),
      }));
    }
    const reopen = (maxAttempts24h: number) => nextFanslyWsHintBudgetAt(db.db, { pageId: f.pageId, maxAttempts24h, now: later(200) });
    // Four attempts are inside the window; the one from 25 hours ago is not.
    expect(await reopen(5)).toBeNull();
    expect(await reopen(4)).toEqual(later(86_400));
    // A cap lowered below usage waits for enough attempts to age out.
    expect(await reopen(2)).toEqual(later(86_400 + 120));
    expect(await reopen(0)).toEqual(later(200 + 86_400));
    await expect(f.tx(database => admitFanslyWsHintAttempt(database, {
      pageId: f.pageId, generation: policy.generation, requestId: "r-6", attemptNumber: 1, maxAttempts24h: 2,
      now: new Date(later(86_400 + 120).getTime() - 1),
    }))).rejects.toThrow("budget_exhausted");
    await f.tx(database => admitFanslyWsHintAttempt(database, {
      pageId: f.pageId, generation: policy.generation, requestId: "r-6", attemptNumber: 1, maxAttempts24h: 2,
      now: later(86_400 + 120),
    }));
  });
});
