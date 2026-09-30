import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

const migration = "0224_page_fan_account_lookup_stamps.sql";

it("adds the once-a-day lookup stamps to page_fans as nullable columns only", () => {
  const sql = readFileSync(`packages/db/migrations/${migration}`, "utf8")
    .split("\n")
    .filter((line) => !line.startsWith("--"))
    .join("\n");
  // Statements end a line; a comment's text may hold a semicolon of its own.
  const statements = sql.split(/;\s*(?:\n|$)/).map((statement) => statement.replace(/\s+/g, " ").trim()).filter(Boolean);

  // page_fans is a hot table: the ALTER stays catalog-only (nullable, no
  // default), and existing rows read as never looked up.
  expect(statements[0]).toBe(
    "ALTER TABLE page_fans ADD COLUMN IF NOT EXISTS account_lookup_at timestamptz, "
      + "ADD COLUMN IF NOT EXISTS account_probe_at timestamptz, "
      + "ADD COLUMN IF NOT EXISTS account_probe_resolved boolean",
  );
  expect(statements.slice(1).map((statement) => statement.split(" IS ")[0])).toEqual([
    "COMMENT ON COLUMN page_fans.account_lookup_at",
    "COMMENT ON COLUMN page_fans.account_probe_at",
    "COMMENT ON COLUMN page_fans.account_probe_resolved",
  ]);
});

it("allows application rollback after the additive stamp columns", () => {
  const deploy = readFileSync("scripts/deploy-production.sh", "utf8");
  expect(deploy.match(/ROLLBACK_COMPATIBLE_MIGRATIONS=\([\s\S]*?\n\)/)?.[0])
    .toContain(`"${migration}"`);
});
