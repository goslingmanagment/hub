import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  casVoiceNoteDispatch,
  clearVoiceProfile,
  createFanslyPage,
  createModel,
  getVoiceNoteByClientRequestId,
  getVoiceNoteById,
  getVoiceProfile,
  insertVoiceNoteJob,
  purgeExpiredVoiceNoteAudio,
  reserveVoiceCharBudget,
  settleVoiceCharBudget,
  settleVoiceNoteTerminal,
  sweepVoiceNotes,
  upsertVoiceProfile,
} from "@agency_hub_core/db";

import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";

const USER_ID = 4242;

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

function baseJob(
  overrides: { platformAccountId: number; clientRequestId?: string } & Record<string, unknown>,
) {
  return {
    userId: USER_ID,
    conversationRef: "conv-1",
    sourceGenerationRef: "gen-1",
    clientRequestId: overrides.clientRequestId ?? randomUUID(),
    requestHash: "hash-1",
    scriptChars: 120,
    originalScriptSha256: "a".repeat(64),
    finalScriptSha256: "a".repeat(64),
    scriptEdited: false,
    profileVoiceId: "voice-x",
    profileModel: "eleven_v3",
    profileSettings: { stability: 0.5 },
    profileOutputFormat: "mp3_44100_128",
    profileVersion: 1,
    ...overrides,
  };
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

describe("voice notes repository integration", () => {
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

  it("dedups a second insert on the same (user, clientRequestId)", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await createVoicePage(testDb, "voice-dedup");
    const clientRequestId = randomUUID();

    const first = await insertVoiceNoteJob(
      testDb.db,
      baseJob({ platformAccountId: page.id, clientRequestId }),
    );
    expect(first.inserted).toBe(true);

    const second = await insertVoiceNoteJob(
      testDb.db,
      baseJob({ platformAccountId: page.id, clientRequestId, requestHash: "different" }),
    );
    expect(second.inserted).toBe(false);

    const row = await getVoiceNoteByClientRequestId(testDb.db, USER_ID, clientRequestId);
    expect(row).not.toBeNull();
    // The original row is preserved — the losing insert is a no-op, not an update.
    expect(row?.requestHash).toBe("hash-1");
    expect(row?.state).toBe("queued");
  });

  it("grants dispatch exactly once under concurrent CAS calls", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { db } = testDb;
    const page = await createVoicePage(testDb, "voice-cas");
    const clientRequestId = randomUUID();
    await insertVoiceNoteJob(db, baseJob({ platformAccountId: page.id, clientRequestId }));
    const note = await getVoiceNoteByClientRequestId(db, USER_ID, clientRequestId);
    expect(note).not.toBeNull();
    const id = note!.id;

    const leaseUntil = new Date(Date.now() + 60_000);
    const tokens = Array.from({ length: 8 }, () => randomUUID());
    const results = await Promise.all(
      tokens.map((attemptToken) => casVoiceNoteDispatch(db, { id, attemptToken, leaseUntil })),
    );

    expect(results.filter(Boolean)).toHaveLength(1);

    const dispatched = await getVoiceNoteById(db, id);
    expect(dispatched?.state).toBe("dispatched");
    expect(dispatched?.attemptToken).not.toBeNull();
    expect(tokens).toContain(dispatched?.attemptToken);
  });

  it("settles a terminal state only for the fencing attempt token", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { db } = testDb;
    const page = await createVoicePage(testDb, "voice-settle");
    const clientRequestId = randomUUID();
    await insertVoiceNoteJob(db, baseJob({ platformAccountId: page.id, clientRequestId }));
    const note = await getVoiceNoteByClientRequestId(db, USER_ID, clientRequestId);
    const id = note!.id;

    const attemptToken = randomUUID();
    expect(
      await casVoiceNoteDispatch(db, { id, attemptToken, leaseUntil: new Date(Date.now() + 60_000) }),
    ).toBe(true);

    const terminal = {
      id,
      state: "completed" as const,
      billed: true,
      billedChars: 120,
      providerRequestId: "prov-req",
      providerTraceId: "prov-trace",
      providerRegion: "us-east",
      audioBytes: Buffer.from("hello-audio"),
      audioSha256: "b".repeat(64),
      audioBytesLen: 11,
      durationMs: 1_000,
    };

    // Stale token loses the fence.
    expect(await settleVoiceNoteTerminal(db, { ...terminal, attemptToken: randomUUID() })).toBe(false);
    expect((await getVoiceNoteById(db, id))?.state).toBe("dispatched");

    // Correct token settles.
    expect(await settleVoiceNoteTerminal(db, { ...terminal, attemptToken })).toBe(true);
    const done = await getVoiceNoteById(db, id);
    expect(done?.state).toBe("completed");
    expect(done?.billed).toBe(true);
    expect(done?.billedChars).toBe(120);
    expect(done?.providerRequestId).toBe("prov-req");
    expect(done?.audioBytesLen).toBe(11);
    expect(done?.durationMs).toBe(1_000);

    // A second settle on a now-terminal row is fenced out (state is no longer 'dispatched').
    expect(await settleVoiceNoteTerminal(db, { ...terminal, attemptToken })).toBe(false);
  });

  it("sweeps lease-expired dispatched and abandoned queued rows to indeterminate", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { db } = testDb;
    const page = await createVoicePage(testDb, "voice-sweep");

    // Dispatched with an already-expired lease → swept.
    const expiredCrid = randomUUID();
    await insertVoiceNoteJob(db, baseJob({ platformAccountId: page.id, clientRequestId: expiredCrid }));
    const expired = await getVoiceNoteByClientRequestId(db, USER_ID, expiredCrid);
    await casVoiceNoteDispatch(db, {
      id: expired!.id,
      attemptToken: randomUUID(),
      leaseUntil: new Date(Date.now() - 60_000),
    });

    // Dispatched with a fresh lease → preserved.
    const freshCrid = randomUUID();
    await insertVoiceNoteJob(db, baseJob({ platformAccountId: page.id, clientRequestId: freshCrid }));
    const fresh = await getVoiceNoteByClientRequestId(db, USER_ID, freshCrid);
    await casVoiceNoteDispatch(db, {
      id: fresh!.id,
      attemptToken: randomUUID(),
      leaseUntil: new Date(Date.now() + 3_600_000),
    });

    // Abandoned queued (created before the cutoff) → swept.
    const queuedCrid = randomUUID();
    await insertVoiceNoteJob(db, baseJob({ platformAccountId: page.id, clientRequestId: queuedCrid }));
    const queued = await getVoiceNoteByClientRequestId(db, USER_ID, queuedCrid);

    const result = await sweepVoiceNotes(db, new Date(), new Date(Date.now() + 60_000));
    expect(result.leaseExpired).toBe(1);
    expect(result.abandonedQueued).toBe(1);

    expect((await getVoiceNoteById(db, expired!.id))?.state).toBe("indeterminate");
    expect((await getVoiceNoteById(db, queued!.id))?.state).toBe("indeterminate");
    expect((await getVoiceNoteById(db, fresh!.id))?.state).toBe("dispatched");
  });

  it("purges expired audio bytes and flips only audio-bearing rows to artifact_expired", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { db } = testDb;
    const page = await createVoicePage(testDb, "voice-purge");

    // Row A: completed with audio bytes.
    const withAudioCrid = randomUUID();
    await insertVoiceNoteJob(db, baseJob({ platformAccountId: page.id, clientRequestId: withAudioCrid }));
    const withAudio = await getVoiceNoteByClientRequestId(db, USER_ID, withAudioCrid);
    const tokenA = randomUUID();
    await casVoiceNoteDispatch(db, {
      id: withAudio!.id,
      attemptToken: tokenA,
      leaseUntil: new Date(Date.now() + 60_000),
    });
    await settleVoiceNoteTerminal(db, {
      id: withAudio!.id,
      attemptToken: tokenA,
      state: "completed",
      billed: true,
      billedChars: 120,
      providerRequestId: "p",
      providerTraceId: "t",
      providerRegion: "us",
      audioBytes: Buffer.from("audio-payload"),
      audioSha256: "c".repeat(64),
      audioBytesLen: 13,
      durationMs: 900,
    });
    expect((await getVoiceNoteById(db, withAudio!.id))?.audioBytes).not.toBeNull();

    // Row B: terminal without audio → the purge must ignore it.
    const noAudioCrid = randomUUID();
    await insertVoiceNoteJob(db, baseJob({ platformAccountId: page.id, clientRequestId: noAudioCrid }));
    const noAudio = await getVoiceNoteByClientRequestId(db, USER_ID, noAudioCrid);
    const tokenB = randomUUID();
    await casVoiceNoteDispatch(db, {
      id: noAudio!.id,
      attemptToken: tokenB,
      leaseUntil: new Date(Date.now() + 60_000),
    });
    await settleVoiceNoteTerminal(db, {
      id: noAudio!.id,
      attemptToken: tokenB,
      state: "failed_definite",
      billed: false,
      billedChars: null,
      providerRequestId: null,
      providerTraceId: null,
      providerRegion: null,
      audioBytes: null,
      audioSha256: null,
      audioBytesLen: null,
      durationMs: null,
    });

    const purged = await purgeExpiredVoiceNoteAudio(db, new Date(Date.now() + 60_000));
    expect(purged).toBe(1);

    const afterA = await getVoiceNoteById(db, withAudio!.id);
    expect(afterA?.audioBytes).toBeNull();
    expect(afterA?.state).toBe("artifact_expired");

    const afterB = await getVoiceNoteById(db, noAudio!.id);
    expect(afterB?.state).toBe("failed_definite");

    // Idempotent: a second purge finds nothing (bytes already NULL).
    expect(await purgeExpiredVoiceNoteAudio(db, new Date(Date.now() + 60_000))).toBe(0);
  });

  it("reserves char budget atomically and refuses over page or global budget", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { db, pool } = testDb;
    const page = await createVoicePage(testDb, "voice-budget-page");
    const now = new Date("2026-07-18T00:00:00.000Z");
    const day = "2026-07-18";
    const pageScope = `page:${page.id}`;

    // A single reservation larger than the budget is refused from zero, no row written.
    expect(
      await reserveVoiceCharBudget(db, {
        pageId: page.id,
        chars: 200,
        pageBudget: 150,
        globalBudget: 1_000_000,
        now,
      }),
    ).toBe(false);
    expect(await spentChars(pool, pageScope, day)).toBe(0);
    expect(await spentChars(pool, "global", day)).toBe(0);

    expect(
      await reserveVoiceCharBudget(db, {
        pageId: page.id,
        chars: 100,
        pageBudget: 150,
        globalBudget: 1_000_000,
        now,
      }),
    ).toBe(true);

    // Cumulative would breach the page budget (100 + 100 > 150) → refused, and the
    // global counter is NOT advanced (page reserved first, then rolled back).
    expect(
      await reserveVoiceCharBudget(db, {
        pageId: page.id,
        chars: 100,
        pageBudget: 150,
        globalBudget: 1_000_000,
        now,
      }),
    ).toBe(false);
    expect(await spentChars(pool, pageScope, day)).toBe(100);
    expect(await spentChars(pool, "global", day)).toBe(100);

    expect(
      await reserveVoiceCharBudget(db, {
        pageId: page.id,
        chars: 50,
        pageBudget: 150,
        globalBudget: 1_000_000,
        now,
      }),
    ).toBe(true);
    expect(await spentChars(pool, pageScope, day)).toBe(150);
    expect(await spentChars(pool, "global", day)).toBe(150);

    // Settling a refund delta walks both scope counters back, clamped at zero.
    await settleVoiceCharBudget(db, { pageId: page.id, charsDelta: -30, now });
    expect(await spentChars(pool, pageScope, day)).toBe(120);
    expect(await spentChars(pool, "global", day)).toBe(120);
  });

  it("rolls back the page reservation when the global budget refuses", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { db, pool } = testDb;
    const page = await createVoicePage(testDb, "voice-budget-global");
    const now = new Date("2026-07-18T00:00:00.000Z");
    const day = "2026-07-18";
    const pageScope = `page:${page.id}`;

    expect(
      await reserveVoiceCharBudget(db, {
        pageId: page.id,
        chars: 60,
        pageBudget: 1_000_000,
        globalBudget: 100,
        now,
      }),
    ).toBe(true);

    // Page budget has room, but the global budget refuses (60 + 60 > 100). The
    // page increment done first in the same transaction must be rolled back.
    expect(
      await reserveVoiceCharBudget(db, {
        pageId: page.id,
        chars: 60,
        pageBudget: 1_000_000,
        globalBudget: 100,
        now,
      }),
    ).toBe(false);

    expect(await spentChars(pool, pageScope, day)).toBe(60);
    expect(await spentChars(pool, "global", day)).toBe(60);
  });

  it("upserts a voice profile with an auto-incrementing version and clears it", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { db } = testDb;
    const page = await createVoicePage(testDb, "voice-profile");

    const v1 = await upsertVoiceProfile(db, {
      platformAccountId: page.id,
      voiceId: "voice-1",
      model: "eleven_v3",
      settings: { stability: 0.4 },
      outputFormat: "mp3_44100_128",
    });
    expect(v1.version).toBe(1);

    const v2 = await upsertVoiceProfile(db, {
      platformAccountId: page.id,
      voiceId: "voice-2",
      model: "eleven_v3",
      settings: { stability: 0.6 },
      outputFormat: "mp3_22050_32",
    });
    expect(v2.version).toBe(2);

    const got = await getVoiceProfile(db, page.id);
    expect(got?.voiceId).toBe("voice-2");
    expect(got?.version).toBe(2);
    expect(got?.outputFormat).toBe("mp3_22050_32");

    await clearVoiceProfile(db, page.id);
    expect(await getVoiceProfile(db, page.id)).toBeNull();
  });
});
