import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

const migration = "0226_fansly_ws_live_overlay.sql";
const text = readFileSync(`packages/db/migrations/${migration}`, "utf8");
const sql = text
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");
// Guarded blocks (the NOT VALID check, the read-only grant) are pinned by text;
// every other statement is one top-level DDL statement.
const blocks = sql.match(/do \$\$[\s\S]*?end \$\$;/g) ?? [];
const statements = sql
  .replace(/do \$\$[\s\S]*?end \$\$;/g, "")
  // Statements end a line; a comment's text may hold a semicolon of its own.
  .split(/;\s*(?:\n|$)/)
  .map((statement) => statement.replace(/\s+/g, " ").trim())
  .filter(Boolean);

it("is purely additive: a new table, defaulted columns, a NOT VALID check, indexes and grants", () => {
  for (const statement of statements) {
    expect(statement).toMatch(/^(create table if not exists|create index if not exists|comment on|alter table fansly_ws_decode_receipts)/);
    // A foreign key's own `on delete restrict` is not a deletion.
    expect(statement.replaceAll("on delete restrict", "")).not.toMatch(/\b(drop|rename|truncate|delete|update)\b/i);
  }
  // Existing receipts read as legacy (never replayed); new captures start pending.
  expect(statements).toContain("alter table fansly_ws_decode_receipts add column if not exists live_state text not null default 'legacy', "
    + "add column if not exists live_decoder_version integer, add column if not exists live_applied_at timestamptz");
  expect(statements).toContain("alter table fansly_ws_decode_receipts alter column live_state set default 'pending'");
  expect(blocks).toHaveLength(2);
  expect(blocks[0]).toContain("check (live_state in ('legacy', 'pending', 'applied', 'debt', 'skipped')) not valid");
  expect(blocks[1]).toContain("grant select on dm_live_messages to read_only");
  for (const block of blocks) expect(block).not.toMatch(/\b(drop|rename|truncate|delete|update)\b/i);
});

it("keeps money out of the overlay: no tip, price or amount column", () => {
  const table = statements.find((statement) => statement.startsWith("create table if not exists dm_live_messages"));
  expect(table).toBeDefined();
  expect(table).not.toMatch(/tip|price|amount|mills|cents|purchase/i);
  expect(table).toContain("primary key (page_id, platform_message_id)");
});

it("allows application rollback after the additive overlay migration", () => {
  const deploy = readFileSync("scripts/deploy-production.sh", "utf8");
  expect(deploy.match(/ROLLBACK_COMPATIBLE_MIGRATIONS=\([\s\S]*?\n\)/)?.[0]).toContain(`"${migration}"`);
});
