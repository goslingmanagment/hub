import { readdirSync, readFileSync } from "node:fs";

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

// Arena "vanished chat" R5 (M5): the source CHECK is replaced by a later
// migration, found by its name (its number is the next free one at merge).
const widenings = readdirSync("packages/db/migrations").filter((file) => file.endsWith("_fansly_public_lookup_egress.sql"));
const widening = widenings[0] ?? "";
const wideningSql = widenings.length === 1
  ? readFileSync(`packages/db/migrations/${widening}`, "utf8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
  : "";

function wideningSourceList(): string[] {
  const body = wideningSql.slice(wideningSql.indexOf("add constraint fansly_send_log_source_check"));
  const list = body.slice(body.indexOf("in (") + 4, body.indexOf(")) not valid"));
  return [...list.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]!);
}

it("keeps the journal's vocabularies equal to the guard contract", () => {
  // 0225's list is the original; the widening adds `public_lookup` and keeps
  // every value 0225 admits, in its order.
  expect(widenings).toHaveLength(1);
  expect(wideningSourceList()).toEqual([...checkList("fansly_send_log_source_check"), "public_lookup"]);
  expect(wideningSourceList()).toEqual([...FANSLY_SEND_SOURCES]);
  expect(checkList("fansly_send_log_outcome_check")).toEqual([...FANSLY_SEND_OUTCOMES]);
});

it("allows application rollback after the additive guard tables", () => {
  const deploy = readFileSync("scripts/deploy-production.sh", "utf8");
  expect(deploy.match(/ROLLBACK_COMPATIBLE_MIGRATIONS=\([\s\S]*?\n\)/)?.[0])
    .toContain(`"${migration}"`);
});

// 0227: the send guard's checks (plan §2.4 «проверка, а не вера», §10).
const checks = "0227_fansly_send_guard_checks.sql";
const checksSql = readFileSync(`packages/db/migrations/${checks}`, "utf8")
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");

it("0227 only adds: a nullable journal column, the cursor table, its seed row and a grant", () => {
  const statements = checksSql.split(/;\s*(?:\n|$)/).map((statement) => statement.replace(/\s+/g, " ").trim()).filter(Boolean);
  expect(statements.filter((statement) => /^(drop|delete|update|truncate)\b/i.test(statement))).toEqual([]);
  const alters = statements.filter((statement) => /^alter\b/i.test(statement));
  // Catalog-only: nullable, no default, no rewrite of the journal.
  expect(alters).toEqual(["alter table fansly_send_log add column if not exists lease_until timestamptz"]);
  expect(checksSql).toContain("create table if not exists fansly_send_pace_cursor");
  expect(checksSql).toMatch(/insert into fansly_send_pace_cursor \(id\) values \(1\) on conflict \(id\) do nothing/);
});

it("allows application rollback after the additive checks migration", () => {
  const deploy = readFileSync("scripts/deploy-production.sh", "utf8");
  expect(deploy.match(/ROLLBACK_COMPATIBLE_MIGRATIONS=\([\s\S]*?\n\)/)?.[0])
    .toContain(`"${checks}"`);
});
