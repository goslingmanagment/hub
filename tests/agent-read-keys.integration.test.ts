import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  AGENT_KEY_MAX_LIFETIME_DAYS,
  AGENT_KEY_SLIDING_TTL_DAYS,
  AgentKeyConstraintError,
  AgentKeyLifetimeError,
  agentKeyBusinessDate,
  bumpAgentKeyUsage,
  countAgentReadAuditForSession,
  createUser,
  findAgentKeyByDigest,
  getAgentKeyUsage,
  insertAgentKey,
  insertAgentReadAudit,
  listAgentKeys,
  recordAgentKeyUse,
  reserveAgentKeyRows,
  revokeAgentKey,
} from "@agency_hub_core/db";

import { AGENT_CAPABILITIES } from "@agency_hub_core/contracts";

import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";

let testDb: StartedTestDatabase | null = null;
/** Read BEFORE the first reset: the truncate would remove the migration's seed row. */
let seededArchiveGeneration: { id: number; generation: string } | null = null;

const DAY_MS = 24 * 60 * 60 * 1000;
/** sha256 of the empty string — a real digest, used where a real one is required. */
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

beforeAll(async () => {
  const started = await startIntegrationTestDatabase();
  testDb = started;
  if (!started) {
    // No Docker: every test below skips itself through the same guard.
    return;
  }
  const seeded = await started.pool.query<{ id: number; generation: string }>(
    "select id, generation::text as generation from archive_generation",
  );
  seededArchiveGeneration = seeded.rows[0] ?? null;
}, 180_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async (context) => {
  if (!testDb) {
    context.skip();
    return;
  }
  await resetIntegrationDatabase(testDb.pool);
});

async function createOwner(name: string) {
  const owner = await createUser(testDb!.db, {
    username: name,
    role: "owner",
    passwordHash: null,
  });
  if (!owner) {
    throw new Error(`could not create test user ${name}`);
  }
  return owner;
}

function keyInput(overrides: Partial<Parameters<typeof insertAgentKey>[1]> = {}) {
  return {
    name: `agent-${Math.random().toString(36).slice(2, 10)}`,
    keyPrefix: "agency_hub_agent_ab",
    keyDigest: `digest-${Math.random().toString(36).slice(2)}`,
    capabilities: ["read:messages"],
    pageIds: [1, 2],
    dailyRequestBudget: 5000,
    dailyRowBudget: 500_000,
    expiresAt: new Date(Date.now() + 90 * DAY_MS),
    createdBy: null,
    ...overrides,
  };
}

describe("agent read plane schema (migration 0115)", () => {
  it("creates the four tables the plane needs", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const relations = await testDb.pool.query<{ name: string }>(`
      select table_name as name
      from information_schema.tables
      where table_schema = 'public'
        and table_name in (
          'agent_keys', 'agent_key_usage_daily', 'agent_read_audit', 'archive_generation'
        )
      order by table_name
    `);
    expect(relations.rows.map((row) => row.name)).toEqual([
      "agent_key_usage_daily",
      "agent_keys",
      "agent_read_audit",
      "archive_generation",
    ]);
  });

  it("indexes the audit table the way the owner-session daily cap queries it", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    // The #9b cap counts (session_user_id, operation, occurred_at). Without this
    // index the cap turns into a sequential scan of an append-only journal.
    const indexes = await testDb.pool.query<{ indexname: string }>(
      "select indexname from pg_indexes where tablename = 'agent_read_audit' order by indexname",
    );
    expect(indexes.rows.map((row) => row.indexname)).toContain(
      "agent_read_audit_session_operation_idx",
    );
  });

  it("seeds the archive generation singleton and refuses a second row", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    expect(seededArchiveGeneration).toEqual({ id: 1, generation: "0" });

    await expect(
      testDb.pool.query("insert into archive_generation (id, generation) values (2, 0)"),
    ).rejects.toThrow(/archive_generation_singleton_check/);
  });

  it("bumps the archive generation monotonically, seeded row or not", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    // The reset truncated the singleton away; the swap's statement must still
    // work, because a swap that silently skipped the bump would leave stale
    // cursors resumable against a different physical table.
    const bump = async () => {
      const result = await testDb!.pool.query<{ generation: string }>(`
        insert into archive_generation (id, generation, bumped_at, reason)
        values (1, 1, now(), 'test bump')
        on conflict (id) do update set
          generation = archive_generation.generation + 1,
          bumped_at = now(),
          reason = excluded.reason
        returning generation::text as generation
      `);
      return result.rows[0]!.generation;
    };

    expect(await bump()).toBe("1");
    expect(await bump()).toBe("2");
    expect(await bump()).toBe("3");
  });
});

describe("agent key repository", () => {
  it("issues, finds, lists and revokes a key", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const owner = await createOwner("agent-owner");
    const created = await insertAgentKey(
      testDb.db,
      keyInput({ name: "auditor", keyDigest: "digest-auditor", createdBy: owner.id }),
    );

    expect(created.capabilities).toEqual(["read:messages"]);
    expect(created.pageIds).toEqual([1, 2]);
    expect(created.revokedAt).toBeNull();
    expect(created.lastUsedAt).toBeNull();

    const found = await findAgentKeyByDigest(testDb.db, "digest-auditor");
    expect(found?.id).toBe(created.id);
    expect(await findAgentKeyByDigest(testDb.db, "digest-nobody")).toBeNull();

    expect((await listAgentKeys(testDb.db)).map((row) => row.name)).toEqual(["auditor"]);

    expect(await revokeAgentKey(testDb.db, { id: created.id })).toBe(true);
    // Idempotent: a second revoke must not move the original timestamp.
    expect(await revokeAgentKey(testDb.db, { id: created.id })).toBe(false);

    // A revoked key is STILL returned by the lookup — the authenticator decides,
    // so its rejection reasons stay testable in exactly one place.
    const revoked = await findAgentKeyByDigest(testDb.db, "digest-auditor");
    expect(revoked?.revokedAt).toBeInstanceOf(Date);
  });

  it("refuses a capability outside the closed matrix", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    // The table CHECK is the fail-closed backstop under the issuing route's own
    // validation, so a bug in a future issuance path cannot mint a grant nothing
    // in the code can check.
    const rejected = await insertAgentKey(
      testDb.db,
      keyInput({ capabilities: ["read:everything"] }),
    ).catch((error: unknown) => error);

    expect(rejected).toBeInstanceOf(AgentKeyConstraintError);
    expect((rejected as AgentKeyConstraintError).constraint).toBe("agent_keys_capabilities_check");
    // The driver's own error embeds the statement AND its parameters, which for
    // this table include the key digest. The typed error must not carry them.
    expect(String(rejected)).not.toContain("insert into");
    expect(String(rejected)).not.toContain("digest-");

    const all = await insertAgentKey(
      testDb.db,
      keyInput({ capabilities: [...AGENT_CAPABILITIES] }),
    );
    expect(all.capabilities).toEqual([...AGENT_CAPABILITIES]);
  });

  it("refuses a duplicate name or digest", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await insertAgentKey(testDb.db, keyInput({ name: "twin", keyDigest: "digest-twin" }));

    const duplicateName = await insertAgentKey(
      testDb.db,
      keyInput({ name: "twin", keyDigest: "digest-other" }),
    ).catch((error: unknown) => error);
    expect(duplicateName).toBeInstanceOf(AgentKeyConstraintError);
    expect((duplicateName as AgentKeyConstraintError).constraint).toBe("agent_keys_name_key");

    const duplicateDigest = await insertAgentKey(
      testDb.db,
      keyInput({ name: "other", keyDigest: "digest-twin" }),
    ).catch((error: unknown) => error);
    expect(duplicateDigest).toBeInstanceOf(AgentKeyConstraintError);
    expect((duplicateDigest as AgentKeyConstraintError).constraint)
      .toBe("agent_keys_key_digest_key");
    // Neither attempt may leak the digest it tried to store.
    expect(String(duplicateDigest)).not.toContain("digest-twin");
  });

  it("refuses an issuance beyond the hard lifetime ceiling", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    // Rejected, NOT silently clamped: an owner who asked for two years and got a
    // key that quietly dies in one would find out from a broken agent.
    const now = new Date();
    await expect(
      insertAgentKey(
        testDb.db,
        keyInput({
          createdAt: now,
          expiresAt: new Date(now.getTime() + (AGENT_KEY_MAX_LIFETIME_DAYS + 1) * DAY_MS),
        }),
      ),
    ).rejects.toBeInstanceOf(AgentKeyLifetimeError);

    // And the table itself refuses the same row, so no other writer can mint one.
    await expect(testDb.pool.query(
      `insert into agent_keys (name, key_prefix, key_digest, expires_at)
       values ('too-long', 'p', 'd', now() + interval '400 days')`,
    )).rejects.toThrow(/agent_keys_max_lifetime_check/);
  });

  it("slides the expiry forward on use and stamps last_used_at", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const now = new Date();
    const created = await insertAgentKey(
      testDb.db,
      keyInput({ expiresAt: new Date(now.getTime() + 3 * DAY_MS) }),
    );

    const used = await recordAgentKeyUse(testDb.db, { id: created.id, now });
    expect(used).not.toBeNull();
    expect(used!.cappedByMaxLifetime).toBe(false);

    const expected = now.getTime() + AGENT_KEY_SLIDING_TTL_DAYS * DAY_MS;
    expect(Math.abs(used!.expiresAt.getTime() - expected)).toBeLessThan(60_000);
    expect(Math.abs(used!.lastUsedAt.getTime() - now.getTime())).toBeLessThan(60_000);
  });

  it("never slides past the hard lifetime cap", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const created = await insertAgentKey(testDb.db, keyInput());
    // Age the row: a key issued nearly a year ago is at its ceiling, and a use
    // must not renew it into immortality — the owner has to issue a new one.
    // created_at and expires_at move together because the table now refuses any
    // row whose expiry sits past created_at + 365 days.
    await testDb.pool.query(
      `update agent_keys
          set created_at = now() - interval '360 days',
              expires_at = now() + interval '3 days'
        where id = $1`,
      [created.id],
    );

    const now = new Date();
    const used = await recordAgentKeyUse(testDb.db, { id: created.id, now });
    expect(used).not.toBeNull();
    expect(used!.cappedByMaxLifetime).toBe(true);

    const ceiling = now.getTime() + (AGENT_KEY_MAX_LIFETIME_DAYS - 360) * DAY_MS;
    expect(used!.expiresAt.getTime()).toBeLessThanOrEqual(ceiling + 60_000);
    expect(used!.expiresAt.getTime()).toBeLessThan(
      now.getTime() + AGENT_KEY_SLIDING_TTL_DAYS * DAY_MS,
    );
  });

  it("keeps a further-out expiry only while it is inside the ceiling", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    // THE EARLIER PIN HERE WAS THE BUG. It read "never shortens an expiry that is
    // already further out", which described `greatest(current, slid)` alone — and
    // that outer greatest() preserved an expiry sitting PAST the 365-day ceiling,
    // making the ceiling advisory. The rule is: a further-out expiry survives
    // while it is inside the cap, and the cap always wins otherwise.
    const now = new Date();
    const far = new Date(now.getTime() + 200 * DAY_MS);
    const created = await insertAgentKey(testDb.db, keyInput({ createdAt: now, expiresAt: far }));

    const used = await recordAgentKeyUse(testDb.db, { id: created.id, now });
    expect(used!.expiresAt.getTime()).toBe(far.getTime());
    expect(used!.cappedByMaxLifetime).toBe(false);

    // And an expiry can never GET past the ceiling in the first place — not even
    // by a hand-run UPDATE — which is what makes the preserved-expiry branch
    // safe. Ageing this row while its expiry stays 200 days out would put it
    // beyond created_at + 365 days, and the table refuses that outright.
    await expect(testDb.pool.query(
      "update agent_keys set created_at = now() - interval '190 days' where id = $1",
      [created.id],
    )).rejects.toThrow(/agent_keys_max_lifetime_check/);
    // The clamp itself is pinned by "never slides past the hard lifetime cap".
  });

  it("reports nothing for a key that does not exist", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    expect(await recordAgentKeyUse(testDb.db, { id: 987654 })).toBeNull();
  });

  it("does not touch a revoked key", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    // A revoked key must not get a fresh last_used_at and must not have its
    // expiry resurrected by the very request that should have been refused.
    const created = await insertAgentKey(testDb.db, keyInput());
    await revokeAgentKey(testDb.db, { id: created.id });

    expect(await recordAgentKeyUse(testDb.db, { id: created.id })).toBeNull();

    const after = await findAgentKeyByDigest(testDb.db, created.keyDigest);
    expect(after?.lastUsedAt).toBeNull();
    expect(after?.expiresAt.getTime()).toBe(created.expiresAt.getTime());
  });

  it("does not touch an already-expired key", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const created = await insertAgentKey(testDb.db, keyInput());
    await testDb.pool.query(
      `update agent_keys
          set created_at = now() - interval '100 days',
              expires_at = now() - interval '1 day'
        where id = $1`,
      [created.id],
    );

    expect(await recordAgentKeyUse(testDb.db, { id: created.id })).toBeNull();

    const after = await findAgentKeyByDigest(testDb.db, created.keyDigest);
    expect(after?.lastUsedAt).toBeNull();
    expect(after!.expiresAt.getTime()).toBeLessThan(Date.now());
  });
});

describe("agent key daily budget", () => {
  it("creates the counter on the first request of the day", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    // The first request of a UTC day has no row to update: a bare
    // UPDATE .. RETURNING could not budget it at all.
    const key = await insertAgentKey(testDb.db, keyInput());
    const now = new Date("2026-08-01T00:00:01.000Z");

    const state = await bumpAgentKeyUsage(testDb.db, {
      agentKeyId: key.id,
      requests: 1,
      rows: 10,
      now,
    });

    expect(state).toMatchObject({
      businessDate: "2026-08-01",
      requests: 1,
      rowsReturned: 10,
      dailyRequestBudget: 5000,
      dailyRowBudget: 500_000,
      withinBudget: true,
    });
    expect(agentKeyBusinessDate(now)).toBe("2026-08-01");
  });

  it("sums concurrent bumps instead of letting one overwrite the other", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const key = await insertAgentKey(testDb.db, keyInput());
    const now = new Date("2026-08-01T09:00:00.000Z");

    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        bumpAgentKeyUsage(testDb!.db, { agentKeyId: key.id, requests: 1, rows: 5, now })),
    );

    // Every call saw a distinct running total, and the last one saw all of them:
    // a read-then-write would have produced duplicates well below 12.
    expect(new Set(results.map((state) => state.requests)).size).toBe(12);
    const stored = await getAgentKeyUsage(testDb.db, { agentKeyId: key.id, now });
    expect(stored).toEqual({ businessDate: "2026-08-01", requests: 12, rowsReturned: 60 });
  });

  it("keeps each UTC day on its own counter", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const key = await insertAgentKey(testDb.db, keyInput());
    await bumpAgentKeyUsage(testDb.db, {
      agentKeyId: key.id,
      requests: 3,
      rows: 30,
      now: new Date("2026-08-01T23:59:59.000Z"),
    });
    const nextDay = await bumpAgentKeyUsage(testDb.db, {
      agentKeyId: key.id,
      requests: 1,
      rows: 1,
      now: new Date("2026-08-02T00:00:01.000Z"),
    });

    expect(nextDay).toMatchObject({ businessDate: "2026-08-02", requests: 1, rowsReturned: 1 });
    const previous = await getAgentKeyUsage(testDb.db, {
      agentKeyId: key.id,
      now: new Date("2026-08-01T12:00:00.000Z"),
    });
    expect(previous).toMatchObject({ requests: 3, rowsReturned: 30 });
  });

  it("decides withinBudget against the key's own ceilings in the same statement", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const key = await insertAgentKey(
      testDb.db,
      keyInput({ dailyRequestBudget: 2, dailyRowBudget: 100 }),
    );
    const now = new Date("2026-08-01T09:00:00.000Z");

    expect(
      (await bumpAgentKeyUsage(testDb.db, { agentKeyId: key.id, requests: 1, rows: 10, now }))
        .withinBudget,
    ).toBe(true);
    expect(
      (await bumpAgentKeyUsage(testDb.db, { agentKeyId: key.id, requests: 1, rows: 10, now }))
        .withinBudget,
    ).toBe(true);
    // Third request crosses the request ceiling.
    expect(
      (await bumpAgentKeyUsage(testDb.db, { agentKeyId: key.id, requests: 1, rows: 0, now }))
        .withinBudget,
    ).toBe(false);

    // Rows have their own ceiling, independent of the request count.
    const rowKey = await insertAgentKey(
      testDb.db,
      keyInput({ dailyRequestBudget: 100, dailyRowBudget: 50 }),
    );
    expect(
      (await bumpAgentKeyUsage(testDb.db, { agentKeyId: rowKey.id, requests: 1, rows: 51, now }))
        .withinBudget,
    ).toBe(false);
  });

  it("reserves rows atomically: concurrent reservations cannot overspend", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    // The defect this replaces: the allowance was READ before the work and the
    // rows added after it, so concurrent requests all saw the same allowance and
    // all spent it. A reservation is taken under the row lock, which makes the
    // ceiling a bound rather than a report.
    const key = await insertAgentKey(
      testDb.db,
      keyInput({ dailyRequestBudget: 5000, dailyRowBudget: 250 }),
    );
    const now = new Date("2026-08-01T09:00:00.000Z");

    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        reserveAgentKeyRows(testDb!.db, { agentKeyId: key.id, rows: 100, now })),
    );

    expect(results.reduce((total, result) => total + result.granted, 0)).toBe(250);
    // Two full grants, one partial, one empty — in whatever order the lock served
    // them.
    expect(results.filter((result) => result.granted === 100)).toHaveLength(2);
    const stored = await getAgentKeyUsage(testDb.db, { agentKeyId: key.id, now });
    expect(stored.rowsReturned).toBe(250);

    // A spent ceiling grants NOTHING: the caller answers 429 rather than being
    // handed a single row it cannot pay for.
    expect((await reserveAgentKeyRows(testDb.db, { agentKeyId: key.id, rows: 50, now })).granted)
      .toBe(0);

    // ... and an unused reservation is REFUNDED, never stranded.
    expect((await reserveAgentKeyRows(testDb.db, { agentKeyId: key.id, rows: -40, now })).granted)
      .toBe(-40);
    expect((await getAgentKeyUsage(testDb.db, { agentKeyId: key.id, now })).rowsReturned).toBe(210);
  });

  it("reports a zeroed counter for a day with no traffic", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const key = await insertAgentKey(testDb.db, keyInput());
    expect(
      await getAgentKeyUsage(testDb.db, {
        agentKeyId: key.id,
        now: new Date("2026-08-01T09:00:00.000Z"),
      }),
    ).toEqual({ businessDate: "2026-08-01", requests: 0, rowsReturned: 0 });
  });
});

describe("agent read audit", () => {
  it("stores a bounded structured summary and nothing a person typed", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const key = await insertAgentKey(testDb.db, keyInput());
    const row = await insertAgentReadAudit(testDb.db, {
      agentKeyId: key.id,
      operation: "agentSearchMessages",
      pageIds: [7],
      verbatimText: true,
      requestSummary: {
        qSha256: EMPTY_SHA256,
        qLength: 17,
        limit: 50,
        returned: 3,
        cursorConsumed: false,
        windowFrom: "2026-07-01T00:00:00.000Z",
      },
    });

    expect(row.verbatimText).toBe(true);
    expect(row.pageIds).toEqual([7]);
    expect(row.sessionUserId).toBeNull();
    expect(row.requestSummary).toEqual({
      qSha256: EMPTY_SHA256,
      qLength: 17,
      limit: 50,
      returned: 3,
      cursorConsumed: false,
      windowFrom: "2026-07-01T00:00:00.000Z",
    });
  });

  it("refuses free-form text rather than trimming it", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const key = await insertAgentKey(testDb.db, keyInput());
    const base = {
      agentKeyId: key.id,
      operation: "agentSearchMessages",
      pageIds: [7],
      verbatimText: false,
    };

    // The search string itself: the whole point of {qSha256, qLength}.
    await expect(
      insertAgentReadAudit(testDb.db, {
        ...base,
        requestSummary: { q: "did rick pay for the custom" },
      }),
    ).rejects.toThrow(/does not allow the key "q"/);

    // An allowlisted key still cannot smuggle prose: the value shape is checked.
    await expect(
      insertAgentReadAudit(testDb.db, {
        ...base,
        requestSummary: { cappedBy: "did rick pay for the custom" },
      }),
    ).rejects.toThrow(/must be a bounded identifier/);

    // A digest-shaped key must carry an actual digest — a short word satisfies
    // any "no whitespace" rule while being exactly the text we refuse to store.
    await expect(
      insertAgentReadAudit(testDb.db, { ...base, requestSummary: { qSha256: "rick" } }),
    ).rejects.toThrow(/lowercase hex sha256 digest/);
    await expect(
      insertAgentReadAudit(testDb.db, {
        ...base,
        requestSummary: { reasonSha256: EMPTY_SHA256.toUpperCase() },
      }),
    ).rejects.toThrow(/lowercase hex sha256 digest/);

    // A count-shaped key must carry a count, not a numeric-sounding string.
    await expect(
      insertAgentReadAudit(testDb.db, { ...base, requestSummary: { qLength: "secret" } }),
    ).rejects.toThrow(/non-negative integer/);
    await expect(
      insertAgentReadAudit(testDb.db, { ...base, requestSummary: { returned: -1 } }),
    ).rejects.toThrow(/non-negative integer/);
    await expect(
      insertAgentReadAudit(testDb.db, { ...base, requestSummary: { limit: 1.5 } }),
    ).rejects.toThrow(/non-negative integer/);

    // Flags and instants keep their own shapes.
    await expect(
      insertAgentReadAudit(testDb.db, { ...base, requestSummary: { cursorConsumed: "yes" } }),
    ).rejects.toThrow(/must be a boolean/);
    await expect(
      insertAgentReadAudit(testDb.db, { ...base, requestSummary: { windowFrom: "last tuesday" } }),
    ).rejects.toThrow(/ISO-8601 instant/);

    // Structured values are not a loophole either.
    await expect(
      insertAgentReadAudit(testDb.db, {
        ...base,
        requestSummary: { returned: { nested: "text" } },
      }),
    ).rejects.toThrow(/non-negative integer/);

    // Nothing was written by ANY of the attempts.
    const count = await testDb.pool.query<{ n: string }>(
      "select count(*)::text as n from agent_read_audit",
    );
    expect(count.rows[0]!.n).toBe("0");
  });

  it("needs exactly one principal", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await expect(
      insertAgentReadAudit(testDb.db, {
        operation: "agentObservationPayload",
        pageIds: [],
        verbatimText: true,
      }),
    ).rejects.toThrow(/needs a principal/);

    // Both set would claim a machine AND a human authored one read: it inflates
    // the #9b per-session count and attributes an agent's read to a person.
    const key = await insertAgentKey(testDb.db, keyInput());
    const owner = await createOwner("audit-both");
    await expect(
      insertAgentReadAudit(testDb.db, {
        agentKeyId: key.id,
        sessionUserId: owner.id,
        operation: "agentObservationPayload",
        pageIds: [],
        verbatimText: true,
      }),
    ).rejects.toThrow(/exactly one principal/);

    // The table refuses the same row, so no other writer can produce one.
    await expect(testDb.pool.query(
      `insert into agent_read_audit (agent_key_id, session_user_id, operation)
       values ($1, $2, 'agentObservationPayload')`,
      [key.id, owner.id],
    )).rejects.toThrow(/agent_read_audit_principal_check/);
  });

  it("counts an owner session's reads of one operation inside a window", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    // This count IS the #9b daily cap: 25 payload reads per owner session per day.
    const owner = await createOwner("audit-owner");
    const other = await createOwner("audit-other");
    const now = new Date("2026-08-01T12:00:00.000Z");
    const since = new Date(now.getTime() - 12 * 60 * 60 * 1000);

    for (const occurredAt of [
      new Date("2026-08-01T09:00:00.000Z"),
      new Date("2026-08-01T10:00:00.000Z"),
      // Outside the window: yesterday's reads never consume today's cap.
      new Date("2026-07-30T09:00:00.000Z"),
    ]) {
      await insertAgentReadAudit(testDb.db, {
        sessionUserId: owner.id,
        operation: "agentObservationPayload",
        pageIds: [1],
        verbatimText: true,
        occurredAt,
      });
    }
    // A different operation and a different human both stay out of the count.
    await insertAgentReadAudit(testDb.db, {
      sessionUserId: owner.id,
      operation: "agentObservations",
      pageIds: [1],
      verbatimText: false,
      occurredAt: new Date("2026-08-01T11:00:00.000Z"),
    });
    await insertAgentReadAudit(testDb.db, {
      sessionUserId: other.id,
      operation: "agentObservationPayload",
      pageIds: [1],
      verbatimText: true,
      occurredAt: new Date("2026-08-01T11:00:00.000Z"),
    });

    expect(
      await countAgentReadAuditForSession(testDb.db, {
        sessionUserId: owner.id,
        operation: "agentObservationPayload",
        since,
      }),
    ).toBe(2);
  });
});
