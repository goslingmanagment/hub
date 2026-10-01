import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

import { FANSLY_SEND_OUTCOMES, FANSLY_SEND_SOURCES } from "../packages/fansly/src/send-guard.ts";

const migration = "0225_fansly_page_send_guards.sql";
const sql = readFileSync(`packages/db/migrations/${migration}`, "utf8")
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");

function checkList(constraint: string) {
  const body = sql.slice(sql.indexOf(`constraint ${constraint}`));
  const list = body.slice(body.indexOf("in (") + 4, body.indexOf(")"));
  return [...list.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
}

it("is purely additive: two new tables, a seed, indexes and grants", () => {
  const statements = sql.split(/;\s*(?:\n|$)/).map((statement) => statement.replace(/\s+/g, " ").trim()).filter(Boolean);
  const heads = statements.map((statement) => statement.split(" (")[0]!.split(" select")[0]);
  expect(heads.filter((head) => /^(alter|drop|delete|update|truncate)\b/i.test(head!))).toEqual([]);
  expect(sql).toContain("create table if not exists fansly_page_send_guards");
  expect(sql).toContain("create table if not exists fansly_send_log");
  // Existing pages start closed for 1.2 × S, as if a request had just completed.
  expect(sql).toMatch(/insert into fansly_page_send_guards \(page_id, last_completed_at, next_u, updated_at\)\s+select id, now\(\), 0\.2, now\(\) from pages where platform = 'fansly'\s+on conflict \(page_id\) do nothing/);
});

it("keeps the journal's vocabularies equal to the guard contract", () => {
  expect(checkList("fansly_send_log_source_check")).toEqual([...FANSLY_SEND_SOURCES]);
  expect(checkList("fansly_send_log_outcome_check")).toEqual([...FANSLY_SEND_OUTCOMES]);
});

it("allows application rollback after the additive guard tables", () => {
  const deploy = readFileSync("scripts/deploy-production.sh", "utf8");
  expect(deploy.match(/ROLLBACK_COMPATIBLE_MIGRATIONS=\([\s\S]*?\n\)/)?.[0])
    .toContain(`"${migration}"`);
});
