import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  FANSLY_SEND_GUARD_OWNER_ENGINES,
  pageDmThreads,
  THREAD_CHAIN_SOURCES,
  THREAD_HISTORY_PROOFS,
  THREAD_HISTORY_STATES,
  SYNC_APPLY_STATES,
  SYNC_ENGINE_GUARD_OWNER,
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
// step-2 PRs (0232–0233) add theirs here.

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

describe("0229_send_guard_owner_engine.sql", () => {
  const migration = "0229_send_guard_owner_engine.sql";
  const text = readFileSync(`packages/db/migrations/${migration}`, "utf8");
  const sql = stripComments(text);
  const statements = topLevelStatements(sql);

  it("only adds two columns, a check, comments and the read-role grant on the step-1 guard table", () => {
    expect(statements).toEqual([
      "alter table fansly_page_send_guards add column if not exists owner_engine text not null default 'legacy', "
        + "add column if not exists engine_switched_at timestamptz",
      "do $$…$$",
      "alter table fansly_page_send_guards validate constraint fansly_page_send_guards_owner_engine_check",
      "comment on column fansly_page_send_guards.owner_engine is "
        + "'Who may capture the page: legacy (the legacy engine, every process) or fansly_sync_engine (no legacy "
        + "capture; the engine''s live admission requires it). Flipped only by the step-3 switch and its rollback.'",
      "comment on column fansly_page_send_guards.engine_switched_at is 'When owner_engine last changed; null if it never did.'",
      "do $$…$$",
    ]);
    // No row changes owner here: the default makes every row 'legacy'.
    expect(sql).not.toMatch(/\b(update|delete|drop|rename|truncate)\b/i);
    expect(sql).toMatch(
      /if not exists \(select 1 from pg_constraint where conname = 'fansly_page_send_guards_owner_engine_check'\) then\s+alter table fansly_page_send_guards add constraint fansly_page_send_guards_owner_engine_check\s+check \(owner_engine in \('legacy', 'fansly_sync_engine'\)\) not valid;/,
    );
    expect(sql).toContain("grant select on fansly_page_send_guards to read_only");
  });

  it("keeps the owner vocabulary equal to the repositories' constants", () => {
    const start = sql.indexOf("check (owner_engine in (");
    const list = sql.slice(start, sql.indexOf(")", start + "check (owner_engine in (".length));
    expect([...list.matchAll(/'([a-z_]+)'/g)].map((match) => match[1])).toEqual([...FANSLY_SEND_GUARD_OWNER_ENGINES]);
    expect(FANSLY_SEND_GUARD_OWNER_ENGINES).toContain(SYNC_ENGINE_GUARD_OWNER);
  });

  it("allows application rollback after the additive migration", () => {
    expect(rollbackCompatible()).toContain(`"${migration}"`);
  });
});

describe("0230_tip_context_observation_lineage.sql", () => {
  const migration = "0230_tip_context_observation_lineage.sql";
  const text = readFileSync(`packages/db/migrations/${migration}`, "utf8");
  const sql = stripComments(text);
  const statements = topLevelStatements(sql);

  it("only adds four nullable lineage columns, their pair check, an index and comments", () => {
    expect(statements).toEqual([
      "alter table transaction_tip_contexts add column if not exists source_observation_id bigint, "
        + "add column if not exists source_observation_received_at timestamptz, "
        + "add column if not exists tip_message_source_observation_id bigint, "
        + "add column if not exists tip_message_source_observation_received_at timestamptz",
      "do $$…$$",
      "alter table transaction_tip_contexts validate constraint transaction_tip_contexts_obs_lineage_check",
      "create index if not exists transaction_tip_contexts_source_observation_idx on transaction_tip_contexts "
        + "(source_observation_id) where source_observation_id is not null",
      ...[
        "source_observation_id",
        "source_observation_received_at",
        "tip_message_source_observation_id",
        "tip_message_source_observation_received_at",
      ].map((column) => expect.stringMatching(new RegExp(`^comment on column transaction_tip_contexts\\.${column} is '`))),
    ]);
    // Nullable, no default (catalog-only), no foreign key (observations are
    // partitioned), and no existing row is touched.
    expect(statements[0]).not.toMatch(/\b(not null|default|references)\b/i);
    expect(sql).not.toMatch(/\b(update|delete|drop|rename|truncate)\b/i);
    expect(sql).toMatch(
      /if not exists \(select 1 from pg_constraint where conname = 'transaction_tip_contexts_obs_lineage_check'\) then\s+alter table transaction_tip_contexts add constraint transaction_tip_contexts_obs_lineage_check check \(\s+\(source_observation_id is null\) = \(source_observation_received_at is null\)\s+and \(tip_message_source_observation_id is null\) = \(tip_message_source_observation_received_at is null\)\s+\) not valid;/,
    );
  });

  it("grants nothing new: the read role has never been granted the fan-note table", () => {
    expect(sql).not.toMatch(/\bgrant\b/i);
  });

  it("allows application rollback after the additive migration", () => {
    expect(rollbackCompatible()).toContain(`"${migration}"`);
  });
});

describe("0231_dm_thread_history_chain.sql", () => {
  const migration = "0231_dm_thread_history_chain.sql";
  const text = readFileSync(`packages/db/migrations/${migration}`, "utf8");
  const sql = stripComments(text);
  const statements = topLevelStatements(sql);
  const threadColumns = [
    "head_confirmed_id", "head_confirmed_at", "contiguous_oldest_id", "contiguous_oldest_at", "contiguous_count",
    "chain_upward_count", "chain_epoch", "history_state", "history_proof", "history_proven_at",
    "history_proof_observation_id", "history_proof_observation_received_at", "history_proof_raw_payload_id",
    "chain_source", "chain_journal_watermark",
  ];

  it("adds columns, checks, comments and one marking of the new state column — nothing else", () => {
    for (const statement of statements) {
      expect(statement).toMatch(
        /^(alter table (page_dm_threads|fansly_ws_connections) (add column if not exists|validate constraint)|update page_dm_threads t set history_state = 'unverified' from pages p|comment on column|do \$\$)/,
      );
      expect(statement).not.toMatch(/\b(drop|rename|truncate|delete)\b/i);
    }
    const added = statements[0]!.match(/add column if not exists ([a-z_]+)/g)!.map((clause) => clause.split(" ").pop());
    expect(added).toEqual(threadColumns);
    // Nullable or NOT NULL with a constant default: catalog-only on Postgres 16.
    for (const clause of statements[0]!.split(", ")) {
      if (/not null/.test(clause)) expect(clause).toMatch(/not null default ('none'|0)$/);
    }
    expect(statements).toContain(
      "alter table fansly_ws_connections add column if not exists state_reconciled_at timestamptz, "
        + "add column if not exists transient_unknown tstzrange",
    );
  });

  it("marks only Fansly threads holding messages, and only from 'none' (§2.3)", () => {
    const updates = statements.filter((statement) => statement.startsWith("update"));
    expect(updates).toEqual([
      "update page_dm_threads t set history_state = 'unverified' from pages p where p.id = t.platform_account_id "
        + "and p.platform = 'fansly' and t.stored_message_count > 0 and t.history_state = 'none'",
    ]);
  });

  it("keeps the vocabularies of the checks equal to the repository's constants", () => {
    const list = (constraint: string) => {
      const start = sql.indexOf(`constraint ${constraint}`);
      expect(start, constraint).toBeGreaterThanOrEqual(0);
      const body = sql.slice(start, sql.indexOf("not valid", start));
      return [...body.slice(body.indexOf(" in (")).matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
    };
    expect(list("page_dm_threads_history_state_check")).toEqual([...THREAD_HISTORY_STATES]);
    expect(list("page_dm_threads_history_proof_check")).toEqual([...THREAD_HISTORY_PROOFS]);
    expect(list("page_dm_threads_chain_source_check")).toEqual([...THREAD_CHAIN_SOURCES]);
    for (const constraint of [
      "page_dm_threads_history_state_check",
      "page_dm_threads_history_proof_check",
      "page_dm_threads_contiguous_count_check",
      "page_dm_threads_chain_source_check",
      "page_dm_threads_history_proof_observation_check",
    ]) {
      expect(sql).toContain(`if not exists (select 1 from pg_constraint where conname = '${constraint}')`);
      expect(statements).toContain(`alter table page_dm_threads validate constraint ${constraint}`);
    }
  });

  it("comments every new column", () => {
    for (const column of threadColumns) {
      expect(statements.some((statement) => statement.startsWith(`comment on column page_dm_threads.${column} is '`)), column)
        .toBe(true);
    }
    for (const column of ["state_reconciled_at", "transient_unknown"]) {
      expect(statements.some((statement) => statement.startsWith(`comment on column fansly_ws_connections.${column} is '`)))
        .toBe(true);
    }
  });

  it("grants the read role nothing new on the fan-material thread table", () => {
    expect(sql).not.toMatch(/grant [^;]* on page_dm_threads/i);
    expect(sql).toContain("grant select on fansly_ws_connections to read_only");
  });

  it("is mirrored in the drizzle table", () => {
    const names = Object.values(pageDmThreads as unknown as Record<string, { name?: unknown }>)
      .map((column) => column.name);
    for (const column of threadColumns) expect(names).toContain(column);
  });

  it("allows application rollback after the additive migration", () => {
    expect(rollbackCompatible()).toContain(`"${migration}"`);
  });
});
