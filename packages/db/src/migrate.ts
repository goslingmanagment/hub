import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { loadConfig } from "@agency_hub_core/shared";

import { createPool } from "./client.ts";

function assertUniqueMigrationPrefixes(files: string[]) {
  const seenPrefixes = new Map<string, string>();

  for (const file of files) {
    const prefix = file.split("_", 1)[0] ?? "";
    if (!prefix) {
      continue;
    }

    const existing = seenPrefixes.get(prefix);
    if (existing) {
      throw new Error(
        `Duplicate migration prefix "${prefix}" found in "${existing}" and "${file}"`,
      );
    }

    seenPrefixes.set(prefix, file);
  }
}

async function main() {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);

  try {
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
    assertUniqueMigrationPrefixes(files);

    for (const file of files) {
      const alreadyApplied = await pool.query(
        "select 1 from schema_migrations where id = $1",
        [file],
      );

      if (alreadyApplied.rowCount) {
        continue;
      }

      const sql = await readFile(path.join(migrationsDir, file), "utf8");
      await pool.query("begin");
      try {
        await pool.query(sql);
        await pool.query("insert into schema_migrations (id) values ($1)", [file]);
        await pool.query("commit");
      } catch (error) {
        await pool.query("rollback");
        throw error;
      }
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
