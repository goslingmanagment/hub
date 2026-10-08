import { readFileSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";

// The SQL of `docs/runbooks/sync.md` (step 4, S4-25) on the migrated schema.
// An operator pastes these blocks into production, so each one must be what
// the runbook says it is: valid against the tables as they are, and read-only.
// Every block runs here inside a READ ONLY transaction — a renamed or dropped
// column fails it, and so does a statement that writes. The command lines of
// the runbook are pinned by tests/sync-runbook.test.ts.

const RUNBOOK = readFileSync(new URL("../docs/runbooks/sync.md", import.meta.url), "utf8");

/** The fenced `sql` blocks, each with the heading it stands under. */
function sqlBlocks(markdown: string): Array<{ heading: string; sql: string }> {
  const blocks: Array<{ heading: string; sql: string }> = [];
  let heading = "";
  let current: string[] | null = null;
  for (const line of markdown.split("\n")) {
    const trimmed = line.trim();
    if (current === null) {
      if (/^#{1,3} /.test(line)) heading = line.replace(/^#+ /, "");
      if (trimmed === "```sql") current = [];
      continue;
    }
    if (trimmed === "```") {
      blocks.push({ heading, sql: current.join("\n") });
      current = null;
      continue;
    }
    current.push(line);
  }
  return blocks;
}

/** The psql variables the runbook's SQL takes (`:'name'`), as an operator
 *  would set them. */
const VARIABLES: Readonly<Record<string, string>> = {
  page_label: "lora-1",
  fan_ref: "438766025723355136",
  group_id: "810272281019305984",
  from: "2026-10-01T00:00:00Z",
  to: "2026-10-02T00:00:00Z",
};

function bind(sql: string): string {
  return sql.replace(/:'([a-z_]+)'/g, (_match, name: string) => {
    const value = VARIABLES[name];
    if (value === undefined) throw new Error(`The runbook's SQL takes a variable this test does not set: ${name}`);
    return `'${value}'`;
  });
}

const BLOCKS = sqlBlocks(RUNBOOK);

let testDb: StartedTestDatabase | null = null;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

/** Run `sql` (one or more statements) in a READ ONLY transaction, rolled back. */
async function runReadOnly(sql: string): Promise<void> {
  const client = await testDb!.pool.connect();
  try {
    await client.query("begin transaction read only");
    await client.query("set local statement_timeout = '30s'");
    // The simple protocol: one string, several statements.
    await client.query(sql);
  } finally {
    await client.query("rollback").catch(() => undefined);
    client.release();
  }
}

describe("the SQL of the sync runbook", () => {
  it("is still there", () => {
    // A rewrite that dropped the checks must not leave this file passing vacuously.
    expect(BLOCKS.length).toBeGreaterThanOrEqual(10);
  });

  it("leaves the transaction to the operator", () => {
    // A block that committed or changed role would step out of the READ ONLY
    // transaction it is run in — here and in production.
    const control = /\b(begin|start\s+transaction|commit|rollback|savepoint|set\s+(session\s+)?role|reset)\b/i;
    expect(BLOCKS.filter((block) => control.test(block.sql)).map((block) => block.heading)).toEqual([]);
  });

  it.each(BLOCKS.map((block, index) => [index + 1, block.heading, block.sql] as const))(
    "block %i (%s) runs in a READ ONLY transaction",
    async (_index, _heading, sql) => {
      await expect(runReadOnly(bind(sql))).resolves.toBeUndefined();
    },
  );

  it("a block that wrote would have been refused", async () => {
    await expect(runReadOnly("update sync_pages set paused_all = paused_all")).rejects.toMatchObject({ code: "25006" });
  });
});
