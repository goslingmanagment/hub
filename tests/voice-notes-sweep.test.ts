import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  casVoiceNoteDispatch,
  createFanslyPage,
  createModel,
  getVoiceNoteById,
  insertVoiceNoteJob,
  releaseStaleIndeterminateVoiceBudgets,
  reserveVoiceCharBudget,
  settleVoiceNoteTerminal,
} from "@agency_hub_core/db";

import {
  runVoiceNotesNightlyRetention,
  runVoiceNotesSweep,
} from "../apps/runtime/src/services/voice-notes-sweep.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";

// Task 7 — the minutely lease sweeper and the nightly audio/budget retention
// jobs. The DB is the real Docker Postgres; there is no provider or pg-boss in
// the loop (the service fns are called directly). Every budget assertion pins
// the UTC-day counter the reservation was made against.

const USER_ID = 7373;
const SCRIPT_CHARS = 120;

function baseJob(
  overrides: { platformAccountId: number; clientRequestId?: string } & Record<string, unknown>,
) {
  return {
    userId: USER_ID,
    conversationRef: "conv-1",
    sourceGenerationRef: "gen-1",
    clientRequestId: overrides.clientRequestId ?? randomUUID(),
    requestHash: "hash-1",
    scriptChars: SCRIPT_CHARS,
    originalScriptSha256: "a".repeat(64),
    finalScriptSha256: "a".repeat(64),
    scriptEdited: false,
    profileVoiceId: "voice-x",
    profileModel: "eleven_v3",
    profileSettings: { stability: 0.5 },
    profileOutputFormat: "mp3_44100_128",
    profileVersion: 1,
    createdAt: new Date(),
    ...overrides,
  };
}

async function createVoicePage(testDb: StartedTestDatabase, label: string) {
  const model = await createModel(testDb.db, { slug: `${label}-model`, name: `${label} model` });
  if (!model) {
    throw new Error("createModel returned no row");
  }
  const page = await createFanslyPage(testDb.db, { modelId: model.id, label });
  if (!page) {
    throw new Error("createFanslyPage returned no row");
  }
  return page;
}

async function spentChars(
  pool: StartedTestDatabase["pool"],
  scope: string,
  utcDay: string,
): Promise<number> {
  const res = await pool.query<{ spent_chars: number }>(
    "select spent_chars from voice_char_budget where scope = $1 and utc_day = $2",
    [scope, utcDay],
  );
  return res.rows[0] ? Number(res.rows[0].spent_chars) : 0;
}

async function backdate(pool: StartedTestDatabase["pool"], id: number, when: Date) {
  await pool.query("update voice_notes set created_at = $1, updated_at = $1 where id = $2", [
    when,
    id,
  ]);
}

async function insertQueued(
  testDb: StartedTestDatabase,
  pageId: number,
  createdAt: Date,
): Promise<number> {
  const clientRequestId = randomUUID();
  await insertVoiceNoteJob(testDb.db, baseJob({
    platformAccountId: pageId,
    clientRequestId,
    createdAt,
  }));
  const row = await testDb.pool.query<{ id: number }>(
    "select id from voice_notes where client_request_id = $1",
    [clientRequestId],
  );
  const id = Number(row.rows[0]!.id);
  return id;
}

describe("voice notes sweep + nightly retention", () => {
  let testDb: StartedTestDatabase | null = null;

  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
  });

  afterAll(async () => {
    if (testDb) {
      await testDb.stop();
    }
  });

  beforeEach(async () => {
    if (!testDb) {
      return;
    }
    await resetIntegrationDatabase(testDb.pool);
  });

  it("releases an abandoned-queued reservation against the reservation's UTC day, not today", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { db, pool } = testDb;
    const page = await createVoicePage(testDb, "sweep-abandoned");
    const pageScope = `page:${page.id}`;

    const reservedDay = new Date("2026-07-16T23:59:59.999Z");
    const reservedDayStr = "2026-07-16";
    const nextDayStr = "2026-07-17";
    const now = new Date("2026-07-18T12:00:00.000Z");
    const todayStr = "2026-07-18";

    // The reservation was made two days ago (the counter lives on that day).
    expect(
      await reserveVoiceCharBudget(db, {
        pageId: page.id,
        chars: SCRIPT_CHARS,
        pageBudget: 1_000_000,
        globalBudget: 1_000_000,
        now: reservedDay,
      }),
    ).toBe(true);
    expect(await spentChars(pool, pageScope, reservedDayStr)).toBe(SCRIPT_CHARS);
    expect(await spentChars(pool, "global", reservedDayStr)).toBe(SCRIPT_CHARS);

    // A queued row from that day the service crashed before dispatching.
    const id = await insertQueued(testDb, page.id, reservedDay);

    const result = await runVoiceNotesSweep({ db }, now);
    expect(result.abandonedQueued).toBe(1);
    expect(result.leaseExpired).toBe(0);
    expect(result.budgetsReleased).toBe(1);

    const swept = await getVoiceNoteById(db, id);
    expect(swept?.state).toBe("indeterminate");
    // billed=false marks it released (and fences the nightly job out).
    expect(swept?.billed).toBe(false);

    // The release hit the reservation's day, walking it back to zero...
    expect(await spentChars(pool, pageScope, reservedDayStr)).toBe(0);
    expect(await spentChars(pool, "global", reservedDayStr)).toBe(0);
    // ...NOT the next-day counter a transaction crossing midnight would have
    // used before the admission timestamp was pinned, nor today's counter.
    expect(await spentChars(pool, pageScope, nextDayStr)).toBe(0);
    expect(await spentChars(pool, "global", nextDayStr)).toBe(0);
    expect(await spentChars(pool, pageScope, todayStr)).toBe(0);
    expect(await spentChars(pool, "global", todayStr)).toBe(0);
  });

  it("keeps a lease-expired dispatched reservation reserved (billing unknown)", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { db, pool } = testDb;
    const page = await createVoicePage(testDb, "sweep-lease");
    const pageScope = `page:${page.id}`;
    const now = new Date("2026-07-18T12:00:00.000Z");
    const todayStr = "2026-07-18";

    expect(
      await reserveVoiceCharBudget(db, {
        pageId: page.id,
        chars: SCRIPT_CHARS,
        pageBudget: 1_000_000,
        globalBudget: 1_000_000,
        now,
      }),
    ).toBe(true);

    const id = await insertQueued(testDb, page.id, now);
    // Dispatched with an already-expired lease → swept, reservation preserved.
    await casVoiceNoteDispatch(db, {
      id,
      attemptToken: randomUUID(),
      leaseUntil: new Date(now.getTime() - 60_000),
    });

    const result = await runVoiceNotesSweep({ db }, now);
    expect(result.leaseExpired).toBe(1);
    expect(result.abandonedQueued).toBe(0);
    expect(result.budgetsReleased).toBe(0);

    const swept = await getVoiceNoteById(db, id);
    expect(swept?.state).toBe("indeterminate");
    // Billing is unknown for a dispatched attempt → billed stays NULL, reservation stays.
    expect(swept?.billed).toBeNull();
    expect(await spentChars(pool, pageScope, todayStr)).toBe(SCRIPT_CHARS);
    expect(await spentChars(pool, "global", todayStr)).toBe(SCRIPT_CHARS);
  });

  it("releases a fresh dispatched row's lease only after it expires", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { db } = testDb;
    const page = await createVoicePage(testDb, "sweep-fresh");
    const now = new Date("2026-07-18T12:00:00.000Z");

    const id = await insertQueued(testDb, page.id, now);
    await casVoiceNoteDispatch(db, {
      id,
      attemptToken: randomUUID(),
      leaseUntil: new Date(now.getTime() + 3_600_000),
    });

    const result = await runVoiceNotesSweep({ db }, now);
    expect(result.leaseExpired).toBe(0);
    expect((await getVoiceNoteById(db, id))?.state).toBe("dispatched");
  });

  it("nightly release of stale indeterminate budgets is idempotent (second run = 0)", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { db, pool } = testDb;
    const page = await createVoicePage(testDb, "nightly-stale");
    const pageScope = `page:${page.id}`;

    const reservedDay = new Date("2026-07-15T09:00:00.000Z");
    const reservedDayStr = "2026-07-15";
    const now = new Date("2026-07-18T09:00:00.000Z");

    expect(
      await reserveVoiceCharBudget(db, {
        pageId: page.id,
        chars: SCRIPT_CHARS,
        pageBudget: 1_000_000,
        globalBudget: 1_000_000,
        now: reservedDay,
      }),
    ).toBe(true);

    // A lease-expired dispatched row the minutely sweep already moved to
    // indeterminate (billed left NULL), older than 24h.
    const id = await insertQueued(testDb, page.id, reservedDay);
    await pool.query(
      "update voice_notes set state = 'indeterminate', billed = null where id = $1",
      [id],
    );

    const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    // Repo fn: first call returns the row and marks it released.
    const firstRows = await releaseStaleIndeterminateVoiceBudgets(db, cutoff);
    expect(firstRows).toHaveLength(1);
    expect(firstRows[0]!.platformAccountId).toBe(page.id);
    expect(firstRows[0]!.scriptChars).toBe(SCRIPT_CHARS);
    expect((await getVoiceNoteById(db, id))?.billed).toBe(false);
    // The refund is now atomic with the release stamp (the repo fn stamps
    // billed=false AND settles the counter in one per-row tx), so that FIRST call
    // already walked the reservation-day counter back to zero.
    expect(await spentChars(pool, pageScope, reservedDayStr)).toBe(0);

    // Idempotent: billed IS NULL no longer matches → nothing returned, no refund.
    expect(await releaseStaleIndeterminateVoiceBudgets(db, cutoff)).toHaveLength(0);

    // The nightly service helper applies the release against the reservation day.
    const nightly = await runVoiceNotesNightlyRetention({ db }, now);
    // The repo fn above already released this row, so the nightly pass finds none.
    expect(nightly.budgetsReleased).toBe(0);
    // The counter stays at zero — the first call refunded it; the idempotent
    // no-op nightly pass neither double-refunds nor resurrects the reservation.
    expect(await spentChars(pool, pageScope, reservedDayStr)).toBe(0);
  });

  it("nightly retention purges audio older than 7 days and releases stale budgets on the right day", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { db, pool } = testDb;
    const page = await createVoicePage(testDb, "nightly-purge");
    const pageScope = `page:${page.id}`;

    const reservedDay = new Date("2026-07-10T00:00:00.000Z");
    const reservedDayStr = "2026-07-10";
    const now = new Date("2026-07-18T00:00:00.000Z");

    // --- Audio purge target: a completed row with audio, created 8 days ago. ---
    const audioId = await insertQueued(testDb, page.id, reservedDay);
    const token = randomUUID();
    await casVoiceNoteDispatch(db, {
      id: audioId,
      attemptToken: token,
      leaseUntil: new Date(reservedDay.getTime() + 60_000),
    });
    await settleVoiceNoteTerminal(db, {
      id: audioId,
      attemptToken: token,
      state: "completed",
      billed: true,
      billedChars: SCRIPT_CHARS,
      providerRequestId: "p",
      providerTraceId: "t",
      providerRegion: "us",
      audioBytes: Buffer.from("audio-payload"),
      audioSha256: "c".repeat(64),
      audioBytesLen: 13,
      durationMs: 900,
    });
    // settle bumps updated_at; re-backdate created_at so it is > 7 days old.
    await backdate(pool, audioId, reservedDay);

    // --- Stale-indeterminate budget target, reserved on the same old day. ---
    expect(
      await reserveVoiceCharBudget(db, {
        pageId: page.id,
        chars: SCRIPT_CHARS,
        pageBudget: 1_000_000,
        globalBudget: 1_000_000,
        now: reservedDay,
      }),
    ).toBe(true);
    const staleId = await insertQueued(testDb, page.id, reservedDay);
    await pool.query(
      "update voice_notes set state = 'indeterminate', billed = null where id = $1",
      [staleId],
    );

    const result = await runVoiceNotesNightlyRetention({ db }, now);
    expect(result.audioPurged).toBe(1);
    expect(result.budgetsReleased).toBe(1);

    const purged = await getVoiceNoteById(db, audioId);
    expect(purged?.audioBytes).toBeNull();
    expect(purged?.state).toBe("artifact_expired");

    expect((await getVoiceNoteById(db, staleId))?.billed).toBe(false);
    // Release hit the reservation day, not `now`'s day.
    expect(await spentChars(pool, pageScope, reservedDayStr)).toBe(0);
    expect(await spentChars(pool, "global", reservedDayStr)).toBe(0);
  });

  it("runVoiceNotesSweep counts abandoned-queued, lease-expired, and released budgets end to end", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { db } = testDb;
    const page = await createVoicePage(testDb, "sweep-e2e");
    const now = new Date("2026-07-18T12:00:00.000Z");
    const oldDay = new Date("2026-07-16T12:00:00.000Z");

    // Abandoned queued (from an old day, before the 5-min cutoff).
    await reserveVoiceCharBudget(db, {
      pageId: page.id,
      chars: SCRIPT_CHARS,
      pageBudget: 1_000_000,
      globalBudget: 1_000_000,
      now: oldDay,
    });
    await insertQueued(testDb, page.id, oldDay);

    // Lease-expired dispatched.
    const leaseId = await insertQueued(testDb, page.id, now);
    await casVoiceNoteDispatch(db, {
      id: leaseId,
      attemptToken: randomUUID(),
      leaseUntil: new Date(now.getTime() - 60_000),
    });

    // Fresh dispatched (preserved).
    const freshId = await insertQueued(testDb, page.id, now);
    await casVoiceNoteDispatch(db, {
      id: freshId,
      attemptToken: randomUUID(),
      leaseUntil: new Date(now.getTime() + 3_600_000),
    });

    const result = await runVoiceNotesSweep({ db }, now);
    expect(result).toEqual({ abandonedQueued: 1, leaseExpired: 1, budgetsReleased: 1 });
    expect((await getVoiceNoteById(db, freshId))?.state).toBe("dispatched");
  });
});
