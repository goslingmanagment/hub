import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createDb,
  createPool,
  ensureObservationPartitions,
  findObservationByKey,
  getObservationPartitionLeadMonths,
  insertObservation,
} from "@agency_hub_core/db";

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

function webhookObservation(idempotencyKey: string, payload: Record<string, unknown> = { event: "messages.received" }) {
  return {
    source: "webhook" as const,
    producer: "ofapi:webhook",
    platform: "onlyfans",
    nativeAccountRef: "acct_test",
    kind: "messages.received",
    payload,
    payloadHash: sha256(payload),
    idempotencyKey,
  };
}

/** Distinct application_name so the crash drill terminates ONLY its own
 * backend and never the suite's control connections. */
const CRASH_APP_NAME = "obs_crash_sim";

/** The SQL text of a drizzle statement, string chunks only (parameters are
 * skipped, so payload bytes can never look like a statement). */
function statementText(query: unknown): string {
  const chunks = (query as { queryChunks?: readonly unknown[] }).queryChunks;
  if (!Array.isArray(chunks)) {
    return "";
  }
  return chunks
    .map((chunk) => {
      const value = chunk == null ? null : (chunk as { value?: unknown }).value;
      return Array.isArray(value) ? value.join("") : "";
    })
    .join("");
}

/**
 * Wraps a database handle so `onJournalInsert` fires immediately BEFORE the
 * `insert into observations` statement — the exact window between the key
 * claim and the journal write. Transactions are wrapped too, so the hook
 * still fires when the insert protocol runs inside its own transaction.
 *
 * With `crashAfter`, the handle also stops serving statements once the hook
 * has run: that models the PROCESS dying (SIGKILL/OOM/container stop), the
 * only faithful simulation of the window — a merely dropped connection is
 * survivable, because a pool-backed handle just reconnects and compensates.
 */
function interceptJournalInsert<T extends object>(
  handle: T,
  onJournalInsert: () => Promise<void>,
  options?: { crashAfter?: boolean },
): T {
  const state = { crashed: false };
  const wrap = <H extends object>(target_: H): H => new Proxy(target_, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (property === "execute" && typeof value === "function") {
        const execute = value as (query: unknown) => Promise<unknown>;
        return async (query: unknown) => {
          if (state.crashed) {
            throw new Error("simulated process crash: no further statements");
          }
          if (/insert\s+into\s+observations\s/i.test(statementText(query))) {
            await onJournalInsert();
            if (options?.crashAfter === true) {
              state.crashed = true;
              throw new Error("simulated process crash: no further statements");
            }
          }
          return execute.call(target, query);
        };
      }
      if (property === "transaction" && typeof value === "function") {
        const transaction = value as (run: (tx: object) => Promise<unknown>) => Promise<unknown>;
        return (run: (tx: object) => Promise<unknown>) =>
          transaction.call(target, (tx: object) => run(wrap(tx)));
      }
      return value;
    },
  });
  return wrap(handle);
}

/** Hard-kills the crash drill's backend from another connection and waits for
 * the server to finish reaping it — a real crash, not a thrown error, so no
 * in-process cleanup can compensate. */
async function crashSimulatedBackend(control: StartedTestDatabase["pool"]) {
  await control.query(
    `select pg_terminate_backend(pid)
     from pg_stat_activity
     where application_name = $1 and pid <> pg_backend_pid()
       and datname = current_database()`,
    [CRASH_APP_NAME],
  );
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const alive = await control.query<{ n: string }>(
      `select count(*)::text as n
       from pg_stat_activity
       where application_name = $1 and pid <> pg_backend_pid()
         and datname = current_database()`,
      [CRASH_APP_NAME],
    );
    if (alive.rows[0]!.n === "0") {
      return;
    }
    await sleep(25);
  }
  throw new Error("crash-simulation backend did not terminate");
}

describe("observations insert protocol", () => {
  it("inserts the journal row and the dedup key atomically", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const result = await insertObservation(testDb.db, webhookObservation("evt-1"));
    expect(result.inserted).toBe(true);

    const rows = await testDb.pool.query<{
      id: string;
      source: string;
      producer: string;
      kind: string;
      parse_version: number;
      payload_hash: Buffer;
    }>(
      "select id::text as id, source, producer, kind, parse_version, payload_hash from observations",
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      id: String(result.observationId),
      source: "webhook",
      producer: "ofapi:webhook",
      kind: "messages.received",
      parse_version: 0,
    });
    expect(Buffer.compare(rows.rows[0]!.payload_hash, sha256({ event: "messages.received" }))).toBe(0);

    const keys = await testDb.pool.query<{ observation_id: string; received_at: Date }>(
      "select observation_id::text as observation_id, received_at from observation_keys",
    );
    expect(keys.rows).toHaveLength(1);
    expect(keys.rows[0]!.observation_id).toBe(String(result.observationId));

    // The key's received_at matches the journal row's (same-tx now()) so the
    // key can locate the row inside the partitioned table.
    const found = await findObservationByKey(testDb.db, "webhook", "evt-1");
    expect(found).toMatchObject({ id: result.observationId, kind: "messages.received" });
  });

  it("signals duplicates without writing a second journal row", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const first = await insertObservation(testDb.db, webhookObservation("evt-dup"));
    const second = await insertObservation(testDb.db, webhookObservation("evt-dup", { event: "retry-delivery" }));

    expect(first.inserted).toBe(true);
    // PR4: the duplicate path surfaces the EXISTING key's received_at so an
    // immediate projector can stamp partition-exact — never new Date().
    expect(second).toEqual({
      inserted: false,
      observationId: first.observationId,
      receivedAt: first.receivedAt,
      // #222: no row is written on the duplicate path, so no reference is
      // stamped and the liveness probe never runs — the flag is false because
      // there was nothing to prove, not because a proof succeeded.
      payloadRefVanished: false,
    });

    const count = await testDb.pool.query<{ n: string }>("select count(*)::text as n from observations");
    expect(count.rows[0]!.n).toBe("1");
  });

  it("survives a crash between the key claim and the journal write (the fact is never lost)", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    // DP 7: an idempotency claim that outlives its journal row is a
    // PERMANENT silent loss — every retry reads the orphan claim as "already
    // journaled" and skips. The claim and the journal write must therefore
    // commit together or not at all. The drill kills the backend mid-protocol
    // (no thrown error to catch, no cleanup statement possible).
    const crashPool = createPool(`${testDb.connectionString}?application_name=${CRASH_APP_NAME}`);
    // A terminated backend raises an asynchronous error on its client — on the
    // pool when idle, on the checked-out client when it is mid-transaction.
    // Both need a listener or Node aborts the whole run.
    crashPool.on("error", () => undefined);
    crashPool.on("connect", (client) => {
      client.on("error", () => undefined);
    });

    try {
      const crashDb = interceptJournalInsert(
        createDb(crashPool),
        () => crashSimulatedBackend(testDb!.pool),
        { crashAfter: true },
      );

      await expect(
        insertObservation(crashDb, webhookObservation("evt-crash")),
      ).rejects.toThrow();

      // Nothing survives the crash: no journal row AND no key claim.
      const stranded = await testDb.pool.query<{ n: string }>(
        "select count(*)::text as n from observation_keys where idempotency_key = 'evt-crash'",
      );
      expect(stranded.rows[0]!.n).toBe("0");
      const journaled = await testDb.pool.query<{ n: string }>(
        "select count(*)::text as n from observations where idempotency_key = 'evt-crash'",
      );
      expect(journaled.rows[0]!.n).toBe("0");

      // So the producer's retry still captures the fact.
      const retried = await insertObservation(testDb.db, webhookObservation("evt-crash"));
      expect(retried.inserted).toBe(true);
      const found = await findObservationByKey(testDb.db, "webhook", "evt-crash");
      expect(found).toMatchObject({ id: retried.observationId, kind: "messages.received" });
    } finally {
      await crashPool.end().catch(() => undefined);
    }
  });

  it("never publishes a key claim before its journal row exists", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    // The same property, asserted without a crash: mid-protocol (claim
    // written, journal row not yet) no other session may see the claim. If it
    // can, the claim is already durable on its own and a crash right here
    // strands it forever.
    let claimVisibleMidProtocol: boolean | null = null;
    const probed = interceptJournalInsert(testDb.db, async () => {
      const seen = await testDb!.pool.query(
        "select 1 from observation_keys where idempotency_key = 'evt-midflight'",
      );
      claimVisibleMidProtocol = (seen.rowCount ?? 0) > 0;
    });

    const result = await insertObservation(probed, webhookObservation("evt-midflight"));

    expect(result.inserted).toBe(true);
    expect(claimVisibleMidProtocol).toBe(false);
    // …and both rows are visible once the protocol returns.
    const settled = await testDb.pool.query<{ n: string }>(
      `select count(*)::text as n
       from observation_keys k
       join observations o on o.id = k.observation_id and o.received_at = k.received_at
       where k.idempotency_key = 'evt-midflight'`,
    );
    expect(settled.rows[0]!.n).toBe("1");
  });

  it("joins a caller's transaction: their rollback takes the claim with it", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    // The composition contract (the webhook receiver, the OFAPI capture
    // writers): the protocol must run ON the caller's connection, so their
    // rollback releases the claim. A private connection or a committed claim
    // here would strand the key and lose the fact on retry.
    await expect(
      testDb.db.transaction(async (tx) => {
        const database = tx as unknown as StartedTestDatabase["db"];
        const result = await insertObservation(database, webhookObservation("evt-caller-tx"));
        expect(result.inserted).toBe(true);
        throw new Error("caller aborts after capture");
      }),
    ).rejects.toThrow("caller aborts after capture");

    const stranded = await testDb.pool.query<{ n: string }>(
      "select count(*)::text as n from observation_keys where idempotency_key = 'evt-caller-tx'",
    );
    expect(stranded.rows[0]!.n).toBe("0");

    const retried = await insertObservation(testDb.db, webhookObservation("evt-caller-tx"));
    expect(retried.inserted).toBe(true);
  });

  it("keeps concurrent duplicate inserts at exactly one journal row and one claim", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    // Two racers on the same key: the loser's ON CONFLICT DO NOTHING blocks on
    // the winner's uncommitted claim, then reads it back — one fact, one id.
    const [first, second] = await Promise.all([
      insertObservation(testDb.db, webhookObservation("evt-race", { event: "a" })),
      insertObservation(testDb.db, webhookObservation("evt-race", { event: "b" })),
    ]);

    expect([first.inserted, second.inserted].sort()).toEqual([false, true]);
    expect(second.observationId).toBe(first.observationId);
    expect(second.receivedAt.getTime()).toBe(first.receivedAt.getTime());

    const journaled = await testDb.pool.query<{ n: string }>(
      "select count(*)::text as n from observations where idempotency_key = 'evt-race'",
    );
    expect(journaled.rows[0]!.n).toBe("1");
    const claims = await testDb.pool.query<{ n: string }>(
      "select count(*)::text as n from observation_keys where idempotency_key = 'evt-race'",
    );
    expect(claims.rows[0]!.n).toBe("1");
    const found = await findObservationByKey(testDb.db, "webhook", "evt-race");
    expect(found).toMatchObject({ id: first.observationId });
  });

  it("scopes dedup by source: the same key under another source is a new fact", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const webhook = await insertObservation(testDb.db, webhookObservation("shared-key"));
    const pull = await insertObservation(testDb.db, {
      source: "pull",
      producer: "sync:fansly:subscribers",
      platform: "fansly",
      accountId: null,
      kind: "subscribers",
      payload: { page: 1 },
      payloadHash: sha256({ page: 1 }),
      idempotencyKey: "shared-key",
    });

    expect(webhook.inserted).toBe(true);
    expect(pull.inserted).toBe(true);
    expect(pull.observationId).not.toBe(webhook.observationId);

    const count = await testDb.pool.query<{ n: string }>("select count(*)::text as n from observations");
    expect(count.rows[0]!.n).toBe("2");
  });

  it("fails loudly when the target partition is missing (never a silent drop)", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    // 2029 sits in the gap between the pre-created monthlies and 0082's
    // `observations_future` catch-all (FROM '2031-01-01') — still uncovered.
    // (2031 was this drill's date before W8.2; the catch-all absorbs it now —
    // pinned below.)
    await expect(
      insertObservation(testDb.db, {
        ...webhookObservation("evt-far-future"),
        receivedAt: new Date("2029-01-15T00:00:00.000Z"),
      }),
    ).rejects.toThrow(/no partition|Failed query/);

    // The failed journal insert must not leave a dangling key claim — an
    // orphaned claim would make the producer's retry look like a duplicate
    // and lose the fact.
    const rows = await testDb.pool.query<{ n: string }>(
      "select count(*)::text as n from observations",
    );
    expect(rows.rows[0]!.n).toBe("0");
    const keys = await testDb.pool.query<{ n: string }>(
      "select count(*)::text as n from observation_keys where idempotency_key = 'evt-far-future'",
    );
    expect(keys.rows[0]!.n).toBe("0");

    // And the retry (with a partition present) succeeds cleanly.
    const retried = await insertObservation(testDb.db, webhookObservation("evt-far-future"));
    expect(retried.inserted).toBe(true);

    // W8.2 (0082): beyond 2031 the future catch-all is the structural
    // backstop — a stray far-future insert degrades to a hot catch-all row,
    // never an ExecFindPartition failure.
    const caught = await insertObservation(testDb.db, {
      ...webhookObservation("evt-catchall-2031"),
      receivedAt: new Date("2031-01-15T00:00:00.000Z"),
    });
    expect(caught.inserted).toBe(true);
    const landed = await testDb.pool.query<{ n: string }>(
      "select count(*)::text as n from observations_future",
    );
    expect(landed.rows[0]!.n).toBe("1");
  });
});

describe("observation partition management", () => {
  it("pre-creates months ahead idempotently and reports the lead", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    // The migration ships partitions for 2026-07..2026-12. From a November
    // vantage the lead is 1 month (December only).
    const november = new Date("2026-11-15T12:00:00.000Z");
    expect(await getObservationPartitionLeadMonths(testDb.db, november)).toBe(1);

    const ensured = await ensureObservationPartitions(testDb.db, { monthsAhead: 3, now: november });
    expect(ensured).toEqual([
      "observations_2026_11",
      "observations_2026_12",
      "observations_2027_01",
      "observations_2027_02",
    ]);
    expect(await getObservationPartitionLeadMonths(testDb.db, november)).toBe(3);

    // Idempotent re-run.
    await ensureObservationPartitions(testDb.db, { monthsAhead: 3, now: november });
    const partition = await testDb.pool.query<{ found: string | null }>(
      "select to_regclass('public.observations_2027_02')::text as found",
    );
    expect(partition.rows[0]!.found).toBe("observations_2027_02");

    // A row lands in the newly created month.
    const result = await insertObservation(testDb.db, {
      ...webhookObservation("evt-2027-01"),
      receivedAt: new Date("2027-01-10T00:00:00.000Z"),
    });
    expect(result.inserted).toBe(true);
    const placed = await testDb.pool.query<{ n: string }>(
      "select count(*)::text as n from observations_2027_01",
    );
    expect(placed.rows[0]!.n).toBe("1");
  });
});
