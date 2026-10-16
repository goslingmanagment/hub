import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { startIntegrationTestDatabase } from "./helpers/db.ts";

// docs/runbooks/storage-census.sql is run by hand on production, read only.
// Every query in it must still parse and run on the schema the migrations
// build, and none may write: each runs here inside a READ ONLY transaction.

const SCRIPT = readFileSync("docs/runbooks/storage-census.sql", "utf8");

/** The script's SQL statements: psql meta-commands (`\pset`, `\echo`) and
 *  comments dropped, split on a `;` that ends a line. */
function statements(script: string): string[] {
  const sqlOnly = script
    .split("\n")
    .filter((line) => !line.startsWith("\\") && !line.trimStart().startsWith("--"))
    .join("\n");
  return sqlOnly.split(/;\s*\n/).map((statement) => statement.trim()).filter(Boolean);
}

describe("docs/runbooks/storage-census.sql", () => {
  it("guards the session: read only, statement and lock timeouts", () => {
    expect(SCRIPT).toContain("set default_transaction_read_only = on;");
    expect(SCRIPT).toContain("set statement_timeout = '60s';");
    expect(SCRIPT).toContain("set lock_timeout = '1s';");
    for (const statement of statements(SCRIPT)) {
      expect(statement).not.toMatch(/^\s*(insert|update|delete|truncate|alter|drop|create|vacuum|analyze|reindex|cluster|grant)\b/i);
    }
  });

  it("every query runs on the migrated schema in a read-only transaction", async () => {
    const testDb = await startIntegrationTestDatabase();
    if (!testDb) {
      return;
    }
    const client = await testDb.pool.connect();
    try {
      const queries = statements(SCRIPT);
      expect(queries.length).toBeGreaterThan(20);
      for (const query of queries) {
        await client.query("begin read only");
        try {
          await client.query(query);
        } catch (error) {
          throw new Error(`census query failed: ${query.slice(0, 120)}`, { cause: error });
        } finally {
          await client.query("rollback");
        }
      }
    } finally {
      client.release();
      await testDb.stop();
    }
  });
});
