import { readFile, readdir } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";

import { createDb, createFanslyPage, createModel, createPool, storeFanslySession } from "@fansly-connect/db";
import { createLogger, encryptJson, type FanslySessionBundle } from "@fansly-connect/shared";
import { GenericContainer } from "testcontainers";

const DATABASE_READY_TIMEOUT_MS = 10_000;
const DATABASE_READY_POLL_MS = 100;

async function waitForDatabaseReady(pool: ReturnType<typeof createPool>) {
  const deadline = Date.now() + DATABASE_READY_TIMEOUT_MS;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      await pool.query("select 1");
      return;
    } catch (error) {
      lastError = error;
      await sleep(DATABASE_READY_POLL_MS);
    }
  }

  throw new Error(`Postgres did not accept queries within ${DATABASE_READY_TIMEOUT_MS}ms`, {
    cause: lastError instanceof Error ? lastError : undefined,
  });
}

export async function startTestDatabase(input?: {
  from?: string;
  through?: string;
}) {
  const container = await new GenericContainer("postgres:16")
    .withEnvironment({
      POSTGRES_DB: "testdb",
      POSTGRES_USER: "postgres",
      POSTGRES_PASSWORD: "postgres",
    })
    .withExposedPorts(5432)
    .start();
  const connectionString = `postgres://postgres:postgres@${container.getHost()}:${container.getMappedPort(5432)}/testdb`;
  const pool = createPool(connectionString);
  try {
    await waitForDatabaseReady(pool);

    const db = createDb(pool);
    await applyTestMigrations(pool, input);

    return {
      container,
      connectionString,
      pool,
      db,
      logger: createLogger("silent"),
      async stop() {
        await pool.end();
        await container.stop();
      },
    };
  } catch (error) {
    await pool.end().catch(() => undefined);
    await container.stop().catch(() => undefined);
    throw error;
  }
}

export async function applyTestMigrations(
  pool: ReturnType<typeof createPool>,
  input?: {
    from?: string;
    through?: string;
  },
) {
  await pool.query(`
    create table if not exists schema_migrations (
      id text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  const migrationsDir = path.resolve("packages/db/migrations");
  const files = (await readdir(migrationsDir))
    .filter((file) => file.endsWith(".sql"))
    .sort();

  if (input?.from && !files.includes(input.from)) {
    throw new Error(`Migration "${input.from}" was not found`);
  }
  if (input?.through && !files.includes(input.through)) {
    throw new Error(`Migration "${input.through}" was not found`);
  }

  const selected = files.filter((file) => (
    (input?.from ? file >= input.from : true) &&
    (input?.through ? file <= input.through : true)
  ));

  for (const file of selected) {
    const migration = await readFile(path.join(migrationsDir, file), "utf8");
    await pool.query("begin");
    try {
      await pool.query(migration);
      await pool.query("insert into schema_migrations (id) values ($1)", [file]);
      await pool.query("commit");
    } catch (error) {
      await pool.query("rollback");
      throw error;
    }
  }
}

export async function seedFanslyPage(
  db: ReturnType<typeof createDb>,
  encryptionKey: Buffer,
  encryptionKeyVersion = 1,
) {
  const model = await createModel(db, {
    slug: "lora",
    name: "Lora",
  });
  const page = await createFanslyPage(db, {
    modelId: model.id,
    label: "lora-main",
  });
  const session: FanslySessionBundle = {
    authorization: "token",
    fanslyClientId: "client-id",
    fanslyClientCheck: "client-check",
    fanslySessionId: "session-id",
  };

  await storeFanslySession(
    db,
    page.id,
    JSON.stringify(encryptJson(session, encryptionKey, encryptionKeyVersion)),
    encryptionKeyVersion,
  );

  return { model, page, session };
}
