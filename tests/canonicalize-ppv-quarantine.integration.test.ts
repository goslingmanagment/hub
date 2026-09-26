import { createHash } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createModel,
  createOnlyFansPage,
  insertObservation,
  setPageOfapiAccountId,
} from "@agency_hub_core/db";

import { CANONICALIZER_FAMILIES } from "../apps/runtime/src/services/canonicalize/index.ts";
import { runCanonicalization } from "../apps/runtime/src/services/canonicalize-driver.ts";
import {
  computeGoldenSignals,
  GOLDEN_SIGNAL_THRESHOLDS_MS,
  runGoldenSignalSample,
} from "../apps/runtime/src/services/golden-signals.ts";
import {
  computeHealthFloorBacklogMs,
  HEALTH_FLOOR_REGISTRY,
  HEALTH_FLOOR_THRESHOLD_MS,
  healthFloorQuarantineName,
} from "../apps/runtime/src/services/health-floors.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";

// H2 (INC-001): a PPV notification with no chat ref is a TERMINAL quarantine.
// It produces zero events (its only fan-looking id is the creator's), the
// driver still stamps it — so the family's backlog-age gauge drops back to
// zero instead of paging golden_signal_lag forever — and the outcome is
// recorded explicitly (observation_parse_quarantine + a threshold-free
// counter) instead of vanishing into "stamped with zero events".

const ACCOUNT = "acct_0q000000000000000000000000000000";
const WEBHOOK = CANONICALIZER_FAMILIES.find((family) => family.source === "webhook")!;
const WEBHOOK_FLOOR = HEALTH_FLOOR_REGISTRY.find((floor) => floor.source === "webhook")!;
const QUARANTINE_GAUGE = healthFloorQuarantineName(WEBHOOK.source, WEBHOOK.lane, WEBHOOK.version);

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
});

function app() {
  return {
    db: testDb!.db,
    config: { telegramEnabled: false },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  } as never;
}

async function seedPage() {
  const model = await createModel(testDb!.db, { slug: "ppv-q", name: "PPV quarantine" });
  const page = model ? await createOnlyFansPage(testDb!.db, { modelId: model.id, label: "ppv-q-of" }) : undefined;
  if (!page) {
    throw new Error("Expected the quarantine test page to be created");
  }
  await setPageOfapiAccountId(testDb!.db, { pageId: page.id, ofapiAccountId: ACCOUNT });
  return page;
}

async function journalPpv(key: string, payload: Record<string, unknown>, receivedAt: Date) {
  const envelope = { event: "messages.ppv.unlocked", account_id: ACCOUNT, payload };
  return insertObservation(testDb!.db, {
    source: "webhook",
    producer: "ofapi:webhook",
    platform: "onlyfans",
    nativeAccountRef: ACCOUNT,
    kind: "messages.ppv.unlocked",
    payload: envelope,
    payloadHash: createHash("sha256").update(key).digest(),
    idempotencyKey: key,
    receivedAt,
  });
}

describe("PPV notification quarantine (H2, INC-001)", () => {
  it("stamps a chat-ref-less PPV, records the terminal outcome, and keeps it out of the backlog gauge", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    const twentyMinutesAgo = new Date(Date.now() - 20 * 60_000);
    // The creator id as top-level user_id, no payload.user, no chat link.
    const poisoned = await journalPpv("ppv-q-1", {
      id: "7001",
      createdAt: "2026-09-20T10:00:00+00:00",
      user_id: "514788334",
      replacePairs: { "{AMOUNT}": "$12.00", "{MESSAGE_LINK}": "<p>no link here</p>" },
    }, twentyMinutesAgo);
    // A healthy PPV in the same family: an event, no quarantine.
    await journalPpv("ppv-q-2", {
      id: "7002",
      createdAt: "2026-09-20T10:01:00+00:00",
      user_id: "514788334",
      user: { id: 900001 },
      replacePairs: {
        "{AMOUNT}": "$45.00",
        "{MESSAGE_LINK}": "<a href='https://onlyfans.com/my/chats/chat/900001?firstId=55501'>message</a>",
      },
    }, twentyMinutesAgo);

    // Unconsumed, the poisoned row is exactly the standing breach the plan
    // warned about: older than the 10-minute floor threshold.
    expect(await computeHealthFloorBacklogMs(testDb.db, WEBHOOK_FLOOR)).toBeGreaterThan(HEALTH_FLOOR_THRESHOLD_MS);

    // Dry run: the verdict is counted, nothing is written or stamped.
    const dry = await runCanonicalization(app(), { families: [WEBHOOK], dryRun: true });
    expect(dry).toMatchObject({ scanned: 2, appended: 1, quarantined: 1, stamped: 0 });
    expect((await testDb.pool.query("select count(*)::int as n from observation_parse_quarantine")).rows[0].n)
      .toBe(0);

    const run = await runCanonicalization(app(), { families: [WEBHOOK] });
    expect(run).toMatchObject({
      scanned: 2, appended: 1, stamped: 2, quarantined: 1, errored: 0, skippedUnparseable: 0,
    });
    expect(run.quarantineSamples).toEqual([{
      observationId: poisoned.observationId,
      family: "webhook:ofapi",
      kind: "messages.ppv.unlocked",
      reasonCode: "ppv_unlocked_no_chat_ref",
    }]);

    const outcome = await testDb.pool.query(
      `select observation_id::int, parse_version, source, lane, kind, reason_code
       from observation_parse_quarantine`,
    );
    expect(outcome.rows).toEqual([{
      observation_id: poisoned.observationId,
      parse_version: WEBHOOK.version,
      source: "webhook",
      lane: "ofapi",
      kind: "messages.ppv.unlocked",
      reason_code: "ppv_unlocked_no_chat_ref",
    }]);
    // Kept the stamp: the quarantined row is consumed at the family version.
    const stamped = await testDb.pool.query(
      "select parse_version from observations where id = $1",
      [poisoned.observationId],
    );
    expect(stamped.rows[0].parse_version).toBe(WEBHOOK.version);
    // Zero events from it; the healthy one appended with numeric amountUsd.
    const events = await testDb.pool.query(
      "select observation_id::int, conversation_ref, data from domain_events where account_id = $1",
      [page.id],
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0].observation_id).not.toBe(poisoned.observationId);
    expect(events.rows[0].conversation_ref).toBe("900001");
    expect(events.rows[0].data).toMatchObject({ amountText: "$45.00", amountUsd: 45 });

    // The backlog gauge is back to zero; the quarantine is its own counter.
    expect(await computeHealthFloorBacklogMs(testDb.db, WEBHOOK_FLOOR)).toBe(0);
    // A fresh smoke checkpoint, so the only question the sampler answers here
    // is about the observation families.
    await testDb.pool.query(`
      insert into domain_events_smoke_checkpoint (id, cursor, frames_seen, gap_count, duplicate_count, updated_at)
      values (1, 'CUR', 0, 0, 0, now())
      on conflict (id) do update set updated_at = excluded.updated_at
    `);
    const { samples, failedProbes } = await computeGoldenSignals(app());
    expect(failedProbes).toEqual([]);
    expect(samples.find((s) => s.metric === QUARANTINE_GAUGE && s.quantile === "p95")?.valueMs).toBe(1);
    expect(samples.find((s) => s.metric === WEBHOOK_FLOOR.name && s.quantile === "p95")?.valueMs).toBe(0);
    expect(GOLDEN_SIGNAL_THRESHOLDS_MS[QUARANTINE_GAUGE]).toBeUndefined();
    const sampled = await runGoldenSignalSample(app());
    expect(sampled.breaches).not.toContain(QUARANTINE_GAUGE);
    expect(sampled.breaches).not.toContain(WEBHOOK_FLOOR.name);
    // (The healthy row's own 20-minute canonicalize lag may breach
    // `canonicalize` — by construction of this fixture; not our question.)
    const incidents = await testDb.pool.query<{ incident_key: string }>(
      "select incident_key from notification_incidents where kind = 'golden_signal_lag' and status = 'open'",
    );
    for (const { incident_key: key } of incidents.rows) {
      expect(key).not.toContain(QUARANTINE_GAUGE);
      expect(key).not.toContain(WEBHOOK_FLOOR.name);
    }

    // Idempotent: a replay finds nothing below the floor and records nothing new.
    expect(await runCanonicalization(app(), { families: [WEBHOOK] })).toMatchObject({ scanned: 0, quarantined: 0 });
    expect((await testDb.pool.query("select count(*)::int as n from observation_parse_quarantine")).rows[0].n)
      .toBe(1);
  });
});
