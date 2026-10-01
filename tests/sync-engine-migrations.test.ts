import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  SYNC_APPLY_STATES,
  SYNC_ATTEMPT_OUTCOMES,
  SYNC_PAGE_HOLD_KINDS,
  SYNC_PAGE_MODES,
  SYNC_SEND_MARKS,
  SYNC_WAITING_REASONS,
  SYNC_WORK_CLASSES,
  SYNC_WORK_KINDS,
  SYNC_WORK_STATES,
} from "@agency_hub_core/db";

// Fansly Sync Engine migrations (design §2.1): forward-only, purely additive,
// each in ROLLBACK_COMPATIBLE_MIGRATIONS. One block per migration; later
// step-2 PRs (0229–0233) add theirs here.

function stripComments(text: string): string {
  return text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .map((line) => line.replace(/\s--\s.*$/, ""))
    .join("\n");
}

function topLevelStatements(sql: string): string[] {
  // Function bodies and guarded blocks are dollar-quoted; pin them by text.
  return sql
    .replace(/\$\$[\s\S]*?\$\$/g, () => "$$…$$")
    .split(/;\s*(?:\n|$)/)
    .map((statement) => statement.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function checkList(sql: string, constraint: string): string[] {
  const start = sql.indexOf(`constraint ${constraint} check`);
  expect(start, `constraint ${constraint}`).toBeGreaterThanOrEqual(0);
  const body = sql.slice(start);
  const list = body.slice(body.indexOf(" in (") + 5, body.indexOf(")", body.indexOf(" in (")));
  return [...list.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]!);
}

function rollbackCompatible(): string {
  const deploy = readFileSync("scripts/deploy-production.sh", "utf8");
  return deploy.match(/ROLLBACK_COMPATIBLE_MIGRATIONS=\([\s\S]*?\n\)/)?.[0] ?? "";
}

describe("0228_sync_engine_core.sql", () => {
  const migration = "0228_sync_engine_core.sql";
  const text = readFileSync(`packages/db/migrations/${migration}`, "utf8");
  const sql = stripComments(text);
  const statements = topLevelStatements(sql);

  it("is purely additive: new tables, functions, indexes, comments, a seed and grants", () => {
    for (const statement of statements) {
      expect(statement).toMatch(
        /^(create table if not exists|create (unique )?index if not exists|create or replace function sync_work_merge_(ids|demand)\(|comment on|insert into sync_pages|do \$\$)/,
      );
      // A foreign key's own `on delete restrict` is not a deletion.
      expect(statement.replaceAll("on delete restrict", "")).not.toMatch(/\b(drop|rename|truncate|delete|update|alter)\b/i);
    }
    expect(statements.filter((statement) => statement.startsWith("create table if not exists")).map((statement) => statement.split(" ")[5]))
      .toEqual(["sync_pages", "sync_work", "sync_attempts"]);
    // Every page-scoped table restricts the page delete (erasure keeps pages).
    expect(sql.match(/references pages\(id\) on delete restrict/g)).toHaveLength(3);
    expect(sql).not.toMatch(/on delete cascade/);
  });

  it("seeds one row in mode 'off' for every Fansly page, never overwriting one", () => {
    expect(statements).toContain(
      "insert into sync_pages (page_id, mode, mode_changed_by) select p.id, 'off', 'migration:0228' from pages p "
        + "where p.platform = 'fansly' on conflict (page_id) do nothing",
    );
  });

  it("keeps the vocabularies of the checks equal to the repositories' constants", () => {
    expect(checkList(sql, "sync_pages_mode_check")).toEqual([...SYNC_PAGE_MODES]);
    expect(checkList(sql, "sync_pages_hold_kind_check")).toEqual([...SYNC_PAGE_HOLD_KINDS]);
    expect(checkList(sql, "sync_work_kind_check")).toEqual([...SYNC_WORK_KINDS]);
    expect(checkList(sql, "sync_work_class_check")).toEqual([...SYNC_WORK_CLASSES]);
    expect(checkList(sql, "sync_attempts_class_check")).toEqual([...SYNC_WORK_CLASSES]);
    expect(checkList(sql, "sync_work_state_check")).toEqual([...SYNC_WORK_STATES]);
    expect(checkList(sql, "sync_work_waiting_reason_check")).toEqual([...SYNC_WAITING_REASONS]);
    expect(checkList(sql, "sync_attempts_outcome_check")).toEqual([...SYNC_ATTEMPT_OUTCOMES]);
    expect(checkList(sql, "sync_attempts_apply_state_check")).toEqual([...SYNC_APPLY_STATES]);
    expect(checkList(sql, "sync_attempts_send_mark_check")).toEqual([...SYNC_SEND_MARKS]);
  });

  it("keeps one open work row per page, shadow, resource and subject", () => {
    expect(statements).toContain(
      "create unique index if not exists sync_work_open_uniq on sync_work (page_id, shadow, resource, subject) "
        + "where state in ('open', 'running', 'quarantined')",
    );
  });

  it("grants the read role every sync_work column except the ciphertext", () => {
    const grant = text.slice(text.indexOf("grant select ("), text.indexOf("on sync_work to read_only"));
    const granted = grant.slice(grant.indexOf("(") + 1, grant.lastIndexOf(")")).split(",").map((column) => column.trim());
    const table = sql.slice(sql.indexOf("create table if not exists sync_work ("), sql.indexOf("create unique index"));
    const columns = [...table.matchAll(/^\s{2}([a-z_]+) (?:bigserial|bigint|boolean|text|timestamptz|jsonb|smallint|integer)\b/gm)]
      .map((match) => match[1]!);
    expect(columns).toContain("secret_params");
    expect(granted).not.toContain("secret_params");
    expect([...granted].sort()).toEqual(columns.filter((column) => column !== "secret_params").sort());
    expect(text).toContain("grant select on sync_pages to read_only");
    expect(text).toContain("grant select on sync_attempts to read_only");
  });

  it("names no table the runtime schema guard forbids", () => {
    for (const name of ["sync_state", "sync_cursors", "sync_requests", "rate_limit_buckets", "raw_payloads"]) {
      expect(sql).not.toMatch(new RegExp(`create table if not exists ${name}\\b`));
    }
  });

  it("allows application rollback after the additive migration", () => {
    expect(rollbackCompatible()).toContain(`"${migration}"`);
  });
});
