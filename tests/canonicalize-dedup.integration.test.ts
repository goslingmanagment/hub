// Stage 8 CI headline: the SAME DM delivered as a webhook AND fetched as a
// REST page produces two observations but exactly ONE message.received event
// — the passport's binding cross-producer dedup proof.

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  appendDomainEvents,
  insertObservation,
  listEventsSince,
  listObservationsForReplay,
} from "@agency_hub_core/db";

import { familyForObservation } from "../apps/runtime/src/services/canonicalize/index.ts";
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
});

function sha256(payload: unknown): Buffer {
  return createHash("sha256").update(JSON.stringify(payload)).digest();
}

describe("cross-producer dedup (Stage 8 CI headline)", () => {
  it("one DM via webhook AND REST page → two observations, ONE event", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const accountId = 4;

    // Producer 1: the webhook delivery (live fixture envelope).
    const envelope = JSON.parse(
      readFileSync("tests/fixtures/ofapi-webhooks/messages_received.json", "utf8"),
    ) as Record<string, unknown>;
    delete envelope._meta;
    const webhookObservation = await insertObservation(testDb.db, {
      source: "webhook",
      producer: "ofapi:webhook",
      platform: "onlyfans",
      accountId,
      kind: "messages.received",
      payload: envelope,
      payloadHash: sha256(envelope),
      idempotencyKey: "evt-dedup-webhook-1",
    });
    expect(webhookObservation.inserted).toBe(true);

    // Producer 2: the same message arriving on a REST dm_messages page.
    const restPage = {
      items: [{
        id: 1000006, // same platform message id as the webhook fixture
        createdAt: "2026-06-10T18:35:30+00:00",
        fromUser: { id: 1000005 },
        isSentByMe: false,
        text: "<p>Sample fan message text used in anonymized fixtures.</p>",
        price: 0,
        isTip: false,
        isFree: true,
      }],
    };
    const pullObservation = await insertObservation(testDb.db, {
      source: "pull",
      producer: "sync:onlyfans:dm_messages",
      platform: "onlyfans",
      accountId,
      kind: "dm_messages",
      payload: restPage,
      payloadHash: sha256(restPage),
      idempotencyKey: `${accountId}:dm_messages:1:1`,
    });
    expect(pullObservation.inserted).toBe(true);

    // Canonicalize both observations through the registry, in either order.
    const pending = await listObservationsForReplay(testDb.db, { belowParseVersion: 1 });
    expect(pending).toHaveLength(2);
    let appended = 0;
    let deduped = 0;
    for (const observationRow of pending) {
      const family = familyForObservation(observationRow);
      expect(family).not.toBeNull();
      const drafts = family!.canonicalize(observationRow);
      const result = await appendDomainEvents(
        testDb.db,
        observationRow.accountId!,
        drafts.map((draft) => ({ ...draft, observationId: observationRow.id })),
      );
      appended += result.appended;
      deduped += result.deduped;
    }

    // Two observations, ONE canonical event.
    expect(appended).toBe(1);
    expect(deduped).toBe(1);
    const events = await listEventsSince(testDb.db, { accountId, afterSeq: 0 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "message.received",
      accountSeq: 1,
      messageRef: "1000006",
      fanIdentityRef: "1000005",
      dedupKey: "msg:received:1000006",
    });
    // Provenance points at whichever producer won the race — one of ours.
    expect([webhookObservation.observationId, pullObservation.observationId])
      .toContain(events[0]!.observationId);

    // Replaying the SAME corpus appends nothing (idempotency by dedup keys).
    for (const observationRow of pending) {
      const family = familyForObservation(observationRow)!;
      const drafts = family.canonicalize(observationRow);
      const result = await appendDomainEvents(
        testDb.db,
        observationRow.accountId!,
        drafts.map((draft) => ({ ...draft, observationId: observationRow.id })),
      );
      expect(result.appended).toBe(0);
    }
    expect(await listEventsSince(testDb.db, { accountId, afterSeq: 0 })).toHaveLength(1);
  });
});
