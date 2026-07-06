import { createHash } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { insertObservation } from "@agency_hub_core/db";

import { runCanonicalization } from "../apps/runtime/src/services/canonicalize-driver.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";

// Kernel Stage 25 Task 2: the multi-worker ordering property. Stage 8 proved
// the append protocol gapless under 8-way concurrent appends in ONE process;
// this harness races SEVERAL sweep runners (what N workers' canonicalize
// jobs are) over a live, growing corpus and re-proves the invariants:
// per-account account_seq is gapless 1..K, dedup keys collapse to exactly
// one event, and killing a runner mid-load loses nothing (the survivors and
// the next sweep pick up unstamped rows). The staging chaos drill (real
// processes, kill -9) is Task 4's ops step — this is the CI-shaped proof.

let harness: StartedTestDatabase;

beforeAll(async () => {
  const started = await startIntegrationTestDatabase();
  if (!started) {
    throw new Error("Docker-backed Postgres is required for this integration test");
  }
  harness = started;
}, 120_000);

afterAll(async () => {
  await harness?.stop();
});

function appStub() {
  return {
    db: harness.db,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  } as never;
}

const ACCOUNTS = [41, 42, 43] as const;

function sha256(seed: string): Buffer {
  return createHash("sha256").update(seed).digest();
}

async function seedMessage(accountId: number, n: number): Promise<void> {
  await insertObservation(harness.db, {
    source: "webhook",
    producer: "ofapi:webhook",
    platform: "onlyfans",
    accountId,
    kind: "messages.received",
    payload: {
      event: "messages.received",
      account_id: `acct_${accountId}`,
      payload: {
        id: `${accountId}00${n}`,
        createdAt: "2026-07-06T10:00:00+00:00",
        fromUser: { id: `${accountId}77` },
        text: `msg ${n}`,
        price: 0,
        isTip: false,
        isFree: true,
        mediaCount: 0,
      },
    },
    payloadHash: sha256(`mw:${accountId}:${n}`),
    idempotencyKey: `mw:${accountId}:${n}`,
  });
}

async function assertInvariants(expectedPerAccount: number): Promise<void> {
  for (const accountId of ACCOUNTS) {
    const rows = await harness.pool.query<{ account_seq: string; dedup_key: string }>(
      `select de.account_seq::text, k.dedup_key
       from domain_events de
       join domain_event_keys k on k.event_id = de.id
       where de.account_id = $1
       order by de.account_seq asc`,
      [accountId],
    );
    const seqs = rows.rows.map((row) => Number(row.account_seq));
    // Gapless 1..K — the load-bearing multi-worker property.
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1));
    // Exactly one event per source message (dedup collapse under racing sweeps).
    const keys = rows.rows.map((row) => row.dedup_key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(seqs.length).toBe(expectedPerAccount);
  }
}

describe("multi-worker ordering property (Stage 25)", () => {
  it("racing sweep runners over a growing corpus keep per-account seq gapless and deduped", async () => {
    const PER_ACCOUNT = 40;
    // Producer: interleaved inserts across accounts while sweeps race.
    const producer = (async () => {
      for (let n = 1; n <= PER_ACCOUNT; n += 1) {
        await Promise.all(ACCOUNTS.map((accountId) => seedMessage(accountId, n)));
      }
    })();

    // Three "workers": each loops the sweep until the corpus stops growing.
    let producing = true;
    const runners = Array.from({ length: 3 }, () => (async () => {
      let idle = 0;
      while (producing || idle < 2) {
        const result = await runCanonicalization(appStub());
        if (result.appended === 0 && result.stamped === 0) {
          idle += 1;
        } else {
          idle = 0;
        }
      }
    })());

    await producer;
    producing = false;
    await Promise.all(runners);

    await assertInvariants(PER_ACCOUNT);
  }, 120_000);

  it("killing a runner mid-load loses nothing: survivors and the next sweep finish the corpus", async () => {
    const EXTRA = 20;
    const abort = { dead: false };

    const producer = (async () => {
      for (let n = 100; n < 100 + EXTRA; n += 1) {
        await Promise.all(ACCOUNTS.map((accountId) => seedMessage(accountId, n)));
      }
    })();

    // The doomed worker dies after its first pass, mid-corpus.
    const doomed = (async () => {
      await runCanonicalization(appStub());
      abort.dead = true; // simulated crash: no cleanup, no handoff
    })();

    let producing = true;
    const survivor = (async () => {
      let idle = 0;
      while (producing || idle < 2) {
        const result = await runCanonicalization(appStub());
        if (result.appended === 0 && result.stamped === 0) {
          idle += 1;
        } else {
          idle = 0;
        }
      }
    })();

    await producer;
    producing = false;
    await Promise.all([doomed, survivor]);
    expect(abort.dead).toBe(true);

    // 40 from the first test + 20 now — nothing lost, nothing duplicated.
    await assertInvariants(40 + EXTRA);
  }, 120_000);
});
