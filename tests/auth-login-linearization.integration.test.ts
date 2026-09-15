import { setTimeout as sleep } from "node:timers/promises";

import argon2 from "argon2";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { findUserByUsername } from "@agency_hub_core/db";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import {
  createUserAccount,
  issueDeviceTokenWithPassword,
  loginWithPassword,
} from "../apps/runtime/src/services/auth.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

// Decision 349 §4.3: a password verified BEFORE the transaction is not
// authority. Every password-based sign-in re-reads the user row under
// `FOR UPDATE` and compares the hash, the deactivation tombstone and the
// device-token epoch with what it verified — so a reset, a deactivation or a
// revoke-all that commits while the request is in flight WINS, and the request
// answers 401 instead of minting on stale authority.
//
// Each test drives the race deterministically: a raw transaction holds the user
// row, the sign-in blocks on that lock after its argon2 check, the holder
// mutates the authority and commits, and only then is the sign-in released.

let testDb: StartedTestDatabase | null = null;
let app: AppContext | null = null;

const PASSWORD = "chatter-secret-1";

function requireSetup(context: { skip: () => void }) {
  if (!testDb || !app) {
    context.skip();
    return null;
  }
  return { testDb, app };
}

/** Waits until the sign-in under test is actually parked on the row lock, so
 * the mutation below lands in the window the test means to exercise. */
async function waitForUserLockWaiter(db: StartedTestDatabase) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await db.pool.query<{ count: string }>(`
      select count(*)::text as count
      from pg_stat_activity
      where datname = current_database()
        and wait_event_type = 'Lock'
        and query ilike '%for update%'
    `);
    if (Number(result.rows[0]?.count ?? 0) >= 1) return;
    await sleep(10);
  }
  throw new Error("Timed out waiting for the sign-in to park on the user row lock");
}

/**
 * Holds the user row, lets `attempt` run until it blocks, commits `mutate`
 * (inside the SAME transaction, so it is invisible until the commit), and
 * returns what the attempt then did.
 */
async function raceAgainstUserLock<T>(
  db: StartedTestDatabase,
  userId: number,
  mutate: string,
  attempt: () => Promise<T>,
): Promise<{ settled: PromiseSettledResult<T> }> {
  const client = await db.pool.connect();
  let pending: Promise<T>;
  try {
    await client.query("begin");
    await client.query("select id from users where id = $1 for update", [userId]);
    pending = attempt();
    const settledEarly = await Promise.race([
      pending.then(() => "settled" as const).catch(() => "settled" as const),
      waitForUserLockWaiter(db).then(() => "blocked" as const),
    ]);
    expect(settledEarly).toBe("blocked");
    await client.query(mutate, [userId]);
    await client.query("commit");
  } finally {
    client.release();
  }
  const [settled] = await Promise.allSettled([pending]);
  return { settled: settled! };
}

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
  if (!testDb) return;
  app = createTestAppContext(testDb);
}, 120_000);

beforeEach(async () => {
  if (!testDb || !app) return;
  await resetIntegrationDatabase(testDb.pool);
  await createUserAccount(app, {
    username: "grisha",
    role: "team_lead",
    password: PASSWORD,
  }, { source: "cli" });
});

afterAll(async () => {
  await testDb?.stop();
});

async function grishaId(db: StartedTestDatabase) {
  const user = await findUserByUsername(db.db, "grisha");
  return user!.id;
}

async function activeSessionCount(db: StartedTestDatabase) {
  const result = await db.pool.query<{ count: string }>(
    "select count(*)::text as count from auth_sessions where revoked_at is null",
  );
  return Number(result.rows[0]?.count ?? "-1");
}

async function deviceTokenCount(db: StartedTestDatabase) {
  const result = await db.pool.query<{ count: string }>(
    "select count(*)::text as count from device_tokens",
  );
  return Number(result.rows[0]?.count ?? "-1");
}

describe("cookie login", () => {
  it("creates NO session when the password is reset while the login waits", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    const userId = await grishaId(setup.testDb);
    const newHash = await argon2.hash("owner-chosen-42", { type: argon2.argon2id });

    const { settled } = await raceAgainstUserLock(
      setup.testDb,
      userId,
      `update users set password_hash = '${newHash}' where id = $1`,
      () => loginWithPassword(setup.app, { username: "grisha", password: PASSWORD }),
    );

    expect(settled.status).toBe("rejected");
    expect(settled.status === "rejected" ? settled.reason : null)
      .toMatchObject({ statusCode: 401, message: "Invalid username or password" });
    expect(await activeSessionCount(setup.testDb)).toBe(0);
  });

  it("creates NO session when the account is deactivated while the login waits", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    const userId = await grishaId(setup.testDb);

    const { settled } = await raceAgainstUserLock(
      setup.testDb,
      userId,
      "update users set disabled_at = now() where id = $1",
      () => loginWithPassword(setup.app, { username: "grisha", password: PASSWORD }),
    );

    expect(settled.status).toBe("rejected");
    expect(settled.status === "rejected" ? settled.reason : null)
      .toMatchObject({ statusCode: 401 });
    expect(await activeSessionCount(setup.testDb)).toBe(0);
  });

  it("creates NO session when every device is revoked (epoch advanced) while the login waits", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    const userId = await grishaId(setup.testDb);

    const { settled } = await raceAgainstUserLock(
      setup.testDb,
      userId,
      "update users set device_token_epoch = device_token_epoch + 1 where id = $1",
      () => loginWithPassword(setup.app, { username: "grisha", password: PASSWORD }),
    );

    expect(settled.status).toBe("rejected");
    expect(await activeSessionCount(setup.testDb)).toBe(0);
  });

  it("still signs in when nothing changed under the lock", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    const userId = await grishaId(setup.testDb);

    const { settled } = await raceAgainstUserLock(
      setup.testDb,
      userId,
      "update users set updated_at = now() where id = $1",
      () => loginWithPassword(setup.app, { username: "grisha", password: PASSWORD }),
    );

    expect(settled.status).toBe("fulfilled");
    expect(await activeSessionCount(setup.testDb)).toBe(1);
  });
});

describe("password device sign-in", () => {
  it("mints NO device token when the password is reset while the sign-in waits", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    const userId = await grishaId(setup.testDb);
    const newHash = await argon2.hash("owner-chosen-42", { type: argon2.argon2id });

    const { settled } = await raceAgainstUserLock(
      setup.testDb,
      userId,
      `update users set password_hash = '${newHash}' where id = $1`,
      () => issueDeviceTokenWithPassword(setup.app, {
        username: "grisha",
        password: PASSWORD,
        label: "Firefox · Windows",
        mode: "active",
        clientVersion: "2.3.0",
      }),
    );

    expect(settled.status).toBe("rejected");
    expect(settled.status === "rejected" ? settled.reason : null)
      .toMatchObject({ statusCode: 401, message: "Invalid username or password" });
    expect(await deviceTokenCount(setup.testDb)).toBe(0);
  });

  it("mints NO reservation when the account is deactivated while the sign-in waits", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    const userId = await grishaId(setup.testDb);

    const { settled } = await raceAgainstUserLock(
      setup.testDb,
      userId,
      "update users set disabled_at = now() where id = $1",
      () => issueDeviceTokenWithPassword(setup.app, {
        username: "grisha",
        password: PASSWORD,
        label: "Desktop · kevin",
        mode: "pending",
        clientVersion: null,
      }),
    );

    expect(settled.status).toBe("rejected");
    const pending = await setup.testDb.pool.query<{ count: string }>(
      "select count(*)::text as count from pending_device_tokens",
    );
    expect(Number(pending.rows[0]?.count)).toBe(0);
  });

  it("mints the token when the authority is unchanged under the lock", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    const userId = await grishaId(setup.testDb);

    const { settled } = await raceAgainstUserLock(
      setup.testDb,
      userId,
      "update users set updated_at = now() where id = $1",
      () => issueDeviceTokenWithPassword(setup.app, {
        username: "grisha",
        password: PASSWORD,
        label: "Firefox · Windows",
        mode: "active",
        clientVersion: "2.3.0",
      }),
    );

    expect(settled.status).toBe("fulfilled");
    expect(await deviceTokenCount(setup.testDb)).toBe(1);
  });
});
