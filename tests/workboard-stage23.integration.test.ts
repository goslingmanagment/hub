import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  appendDomainEvents,
  appendWorkboardContact,
  claimWorkboardFan,
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  fans,
  listActiveWorkboardClaims,
  pageDmThreads,
  pageFans,
  releaseWorkboardClaim,
  retractLastWorkboardContact,
} from "@agency_hub_core/db";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import {
  claimWorkboardV2Fan,
  getWorkboardV2Report,
  recomputeWorkboardFan,
  unclaimWorkboardV2Fan,
  undoWorkboardContactV2,
} from "../apps/runtime/src/modules/workboard/index.ts";
import type { AuthenticatedUser, HumanAuthPrincipal } from "../apps/runtime/src/services/auth.ts";
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
import {
  runWorkboardFanRecompute,
  startWorkboardEventRecompute,
} from "../apps/runtime/src/services/workboard-event-recompute.ts";
import { WORKBOARD_FAN_RECOMPUTE_QUEUE } from "../apps/runtime/src/services/sync-queue.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

const DAY = 86_400_000;
const HOUR = 3_600_000;

let harness: StartedTestDatabase;
let app: AppContext;

beforeAll(async () => {
  const started = await startIntegrationTestDatabase();
  if (!started) {
    throw new Error("Docker-backed Postgres is required for this integration test");
  }
  harness = started;
  app = createTestAppContext(harness);
}, 120_000);

afterAll(async () => {
  await harness?.stop();
});

afterEach(async () => {
  await resetIntegrationDatabase(harness.pool);
});

async function seedPage() {
  const model = await createModel(harness.db, { slug: "lora", name: "Lora" });
  const page = await createFanslyPage(harness.db, { modelId: model.id, label: "lora-main" });
  return { model, page };
}

async function insertFan(platformUserId: string, username: string, platform: "fansly" | "onlyfans" = "fansly"): Promise<number> {
  const [row] = await harness.db
    .insert(fans)
    .values({ platform, platformUserId, username, displayName: username })
    .returning({ id: fans.id });
  return row!.id;
}

async function seedUser(username: string, role: "owner" | "chatter"): Promise<number> {
  await createUserAccount(app, {
    username,
    role,
    password: role === "owner" ? "owner-secret" : undefined,
  }, { source: "cli" });
  const result = await harness.pool.query<{ id: number }>(
    "select id::int as id from users where username = $1",
    [username],
  );
  return result.rows[0]!.id;
}

function sessionPrincipal(userId: number, username: string, role: "owner" | "chatter", assignedPageIds: number[] = []): HumanAuthPrincipal {
  return {
    authMethod: "session",
    user: { id: userId, username, role, mustChangePassword: false } as AuthenticatedUser,
    assignedPageIds,
  };
}

/** A fresh follower who said "hi" 12h ago — lands on fresh_mass when scored. */
async function seedFreshFan(pageId: number, handle: string, now: Date): Promise<number> {
  const fanId = await insertFan(`fan-${handle}`, handle);
  await harness.db.insert(pageFans).values({
    fanId,
    platformAccountId: pageId,
    isFollower: true,
    followerSince: new Date(now.getTime() - 2 * DAY),
  });
  await harness.db.insert(pageDmThreads).values({
    platformAccountId: pageId,
    fanId,
    platformConversationId: `conv-${handle}`,
    lastMessageAt: new Date(now.getTime() - 12 * HOUR),
    lastMessageSenderRole: "fan",
    lastFanMessageAt: new Date(now.getTime() - 12 * HOUR),
    lastMessagePreview: "hi",
    storedMessageCount: 1,
    messageCoverageStatus: "partial_window",
    isVisible: true,
  });
  return fanId;
}

async function listWorkboardEvents(pageId: number, type: string) {
  const result = await harness.pool.query<{ type: string; data: { pageId: number; fanId: number; fromTab: string | null; toTab: string | null; retractedByUserId?: number } }>(
    "select type, data from domain_events where account_id = $1 and type = $2 order by account_seq asc",
    [pageId, type],
  );
  return result.rows;
}

describe("workboard stage 23 (integration)", () => {
  it("claim lease lifecycle: claim → steal → release → expiry", async () => {
    const { page } = await seedPage();
    const fan = await insertFan("fan-claim", "claimed_fan");
    const annaId = await seedUser("anna", "chatter");
    const veraId = await seedUser("vera", "chatter");

    const claimed = await claimWorkboardFan(harness.db, {
      platformAccountId: page.id,
      fanId: fan,
      userId: annaId,
      ttlMinutes: 30,
    });
    expect(claimed.expiresAt.getTime()).toBeGreaterThan(Date.now() + 25 * 60_000);

    let active = await listActiveWorkboardClaims(harness.db, page.id);
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ fanId: fan, claimedByUserId: annaId, claimedByUsername: "anna" });

    // Non-blocking: a second chatter's claim steals the lease (one live row per fan).
    await claimWorkboardFan(harness.db, { platformAccountId: page.id, fanId: fan, userId: veraId });
    active = await listActiveWorkboardClaims(harness.db, page.id);
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ fanId: fan, claimedByUserId: veraId, claimedByUsername: "vera" });

    // Release stamps; the fan drops off the live list but the row is retained.
    expect(await releaseWorkboardClaim(harness.db, { platformAccountId: page.id, fanId: fan })).toBe(true);
    expect(await releaseWorkboardClaim(harness.db, { platformAccountId: page.id, fanId: fan })).toBe(false);
    expect(await listActiveWorkboardClaims(harness.db, page.id)).toHaveLength(0);

    // Re-claim reuses the row (released_at clears); an expired lease evaporates from reads.
    await claimWorkboardFan(harness.db, { platformAccountId: page.id, fanId: fan, userId: annaId });
    expect(await listActiveWorkboardClaims(harness.db, page.id)).toHaveLength(1);
    await harness.pool.query(
      "update workboard_claim_leases set expires_at = now() - interval '1 minute' where platform_account_id = $1",
      [page.id],
    );
    expect(await listActiveWorkboardClaims(harness.db, page.id)).toHaveLength(0);

    const rows = await harness.pool.query<{ count: string }>(
      "select count(*)::text as count from workboard_claim_leases where platform_account_id = $1",
      [page.id],
    );
    expect(rows.rows[0]!.count).toBe("1"); // one row per (page, fan) throughout
  });

  it("claim/unclaim services: board surfaces live claims, audit trail records both sides", async () => {
    const { page } = await seedPage();
    const fan = await insertFan("fan-svc", "svc_fan");
    const annaId = await seedUser("anna", "chatter");
    const anna = sessionPrincipal(annaId, "anna", "chatter", [page.id]);

    const claimed = await claimWorkboardV2Fan(app, anna, "lora-main", { fanId: fan, ttlMinutes: 45 });
    expect(claimed.ok).toBe(true);
    expect(new Date(claimed.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const board = await getWorkboardV2Report(app, anna, "lora-main", {
      tab: "subscribers",
      status: undefined,
      limit: 50,
      offset: 0,
    });
    expect(board.claims).toHaveLength(1);
    expect(board.claims[0]).toMatchObject({
      fanId: fan,
      claimedByUserId: annaId,
      claimedByUsername: "anna",
    });

    await unclaimWorkboardV2Fan(app, anna, "lora-main", fan);
    const after = await getWorkboardV2Report(app, anna, "lora-main", { tab: "subscribers", status: undefined, limit: 50, offset: 0 });
    expect(after.claims).toHaveLength(0);

    // Releasing an already-released claim is a no-op — no phantom audit fact.
    await unclaimWorkboardV2Fan(app, anna, "lora-main", fan);
    const audit = await harness.pool.query<{ event_type: string; actor_user_id: string }>(
      "select event_type, actor_user_id from audit_events where event_type like 'workboard.%' order by id asc",
      [],
    );
    expect(audit.rows.map((r) => r.event_type)).toEqual(["workboard.fan_claimed", "workboard.fan_released"]);
    expect(audit.rows.every((r) => Number(r.actor_user_id) === annaId)).toBe(true);
  });

  it("emits workboard.state_changed on real tab transitions only", async () => {
    const now = new Date();
    const { page } = await seedPage();
    const fan = await seedFreshFan(page.id, "mover", now);

    const first = await recomputeWorkboardFan(harness.db, { platformAccountId: page.id, fanId: fan, now });
    expect(first).toMatchObject({ evaluated: 1, changed: true, fromTab: null, toTab: "fresh_mass" });

    // Re-evaluating an unchanged fan emits nothing.
    const second = await recomputeWorkboardFan(harness.db, {
      platformAccountId: page.id,
      fanId: fan,
      now: new Date(now.getTime() + 60_000),
    });
    expect(second.changed).toBe(false);

    let events = await listWorkboardEvents(page.id, "workboard.state_changed");
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toMatchObject({ pageId: page.id, fanId: fan, fromTab: null, toTab: "fresh_mass" });

    // Removal is a transition too: the fan leaves the board (deleted) → toTab null.
    await harness.pool.query("update fans set deleted_detected_at = now(), deleted_last_detected_at = now() where id = $1", [fan]);
    const third = await recomputeWorkboardFan(harness.db, {
      platformAccountId: page.id,
      fanId: fan,
      now: new Date(now.getTime() + 120_000),
    });
    expect(third.changed).toBe(true);

    events = await listWorkboardEvents(page.id, "workboard.state_changed");
    expect(events).toHaveLength(2);
    expect(events[1]!.data).toMatchObject({ fromTab: "fresh_mass", toTab: null });
  });

  it("undo appends workboard.contact_retracted only when a contact was actually stamped", async () => {
    const { model, page } = await seedPage();
    const fan = await insertFan("fan-undo", "undo_fan");
    const ownerId = await seedUser("dima", "owner");
    const owner = sessionPrincipal(ownerId, "dima", "owner");

    await appendWorkboardContact(harness.db, {
      modelId: model.id,
      platformAccountId: page.id,
      fanId: fan,
      businessDate: "2026-07-06",
      action: "handled",
      wasProductive: true,
      actedByUserId: ownerId,
    });

    await undoWorkboardContactV2(app, owner, "lora-main", fan);
    let events = await listWorkboardEvents(page.id, "workboard.contact_retracted");
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toMatchObject({ pageId: page.id, fanId: fan, retractedByUserId: ownerId });

    // Nothing left to retract — the compensating event is not re-emitted.
    await undoWorkboardContactV2(app, owner, "lora-main", fan);
    events = await listWorkboardEvents(page.id, "workboard.contact_retracted");
    expect(events).toHaveLength(1);

    // Repo-level contract: the boolean drives the emission.
    expect(await retractLastWorkboardContact(harness.db, page.id, fan)).toBe(false);
  });

  it("serves OnlyFans boards (platform neutrality — the read-side throw is gone)", async () => {
    const model = await createModel(harness.db, { slug: "kate", name: "Kate" });
    await createOnlyFansPage(harness.db, { modelId: model.id, label: "kate-of" });
    const ownerId = await seedUser("dima", "owner");
    const owner = sessionPrincipal(ownerId, "dima", "owner");

    const board = await getWorkboardV2Report(app, owner, "kate-of", { tab: "subscribers", status: undefined, limit: 50, offset: 0 });
    expect(board).toMatchObject({ tab: "subscribers", total: 0, items: [], claims: [] });
  });

  it("hub subscriber enqueues debounced per-fan recompute jobs for fan-relevant events only", async () => {
    const { page } = await seedPage();
    const send = vi.fn(async () => null);
    const handle = startWorkboardEventRecompute(app, { send } as never);

    try {
      // The hub baselines watermarks at startup; probe-append until the LISTEN
      // path is live so the test never races the baseline.
      let probes = 0;
      while (send.mock.calls.length === 0 && probes < 50) {
        probes += 1;
        await appendDomainEvents(harness.db, page.id, [{
          type: "message.received",
          occurredAt: new Date(),
          fanIdentityRef: "fan-hub-1",
          data: { probe: probes },
          schemaVersion: 1,
          observationId: 0,
          dedupKey: `hubprobe:${probes}`,
        }]);
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      expect(send.mock.calls.length).toBeGreaterThan(0);
      expect(send).toHaveBeenLastCalledWith(
        WORKBOARD_FAN_RECOMPUTE_QUEUE,
        { accountId: page.id, fanIdentityRef: "fan-hub-1" },
        expect.objectContaining({ singletonKey: `${page.id}:fan-hub-1`, startAfter: 5 }),
      );

      // Irrelevant events are filtered: no fan ref, or a non-fan type. Delivery
      // is ordered per account, so once the fan-hub-2 job lands both filtered
      // events have already been seen (and skipped).
      await appendDomainEvents(harness.db, page.id, [
        {
          type: "message.received",
          occurredAt: new Date(),
          fanIdentityRef: null,
          data: {},
          schemaVersion: 1,
          observationId: 0,
          dedupKey: "hub-no-ref",
        },
        {
          type: "credit.balance_observed",
          occurredAt: new Date(),
          fanIdentityRef: "fan-hub-1",
          data: {},
          schemaVersion: 1,
          observationId: 0,
          dedupKey: "hub-wrong-type",
        },
        {
          type: "transaction.posted",
          occurredAt: new Date(),
          fanIdentityRef: "fan-hub-2",
          data: {},
          schemaVersion: 1,
          observationId: 0,
          dedupKey: "hub-relevant-2",
        },
      ]);
      const sentJobs = () => (send.mock.calls as unknown as Array<[string, { accountId: number; fanIdentityRef: string }]>)
        .map(([queue, payload]) => ({ queue, ...payload }));
      await vi.waitFor(() => {
        expect(sentJobs().some((job) => job.fanIdentityRef === "fan-hub-2")).toBe(true);
      }, { timeout: 10_000 });
      const refs = sentJobs().map((job) => job.fanIdentityRef);
      expect(refs).not.toContain(null);
      expect(sentJobs().every((job) => job.queue === WORKBOARD_FAN_RECOMPUTE_QUEUE)).toBe(true);
      // The wrong-type event for fan-hub-1 must not have produced an extra
      // send after the last fan-hub-1 probe: every fan-hub-1 send was a probe.
      const hub1Sends = refs.filter((ref) => ref === "fan-hub-1").length;
      expect(hub1Sends).toBeLessThanOrEqual(probes);
    } finally {
      await handle.stop();
    }
  });

  it("runWorkboardFanRecompute resolves the fan and re-evaluates exactly that row", async () => {
    const now = new Date();
    const { page } = await seedPage();
    await seedFreshFan(page.id, "jobfan", now);

    expect(await runWorkboardFanRecompute(app, { accountId: 999_999, fanIdentityRef: "fan-jobfan" }))
      .toEqual({ skipped: "page_missing" });
    expect(await runWorkboardFanRecompute(app, { accountId: page.id, fanIdentityRef: "fan-nobody" }))
      .toEqual({ skipped: "fan_unknown" });

    const result = await runWorkboardFanRecompute(app, { accountId: page.id, fanIdentityRef: "fan-jobfan" });
    expect(result).toEqual({ evaluated: 1, changed: true });

    const state = await harness.pool.query<{ tab: string }>(
      "select tab::text as tab from workboard_state where platform_account_id = $1",
      [page.id],
    );
    expect(state.rows).toEqual([{ tab: "fresh_mass" }]);
  });
});
