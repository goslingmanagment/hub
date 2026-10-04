import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  FANSLY_SEND_GUARD_OWNER_ENGINES,
  notificationIncidentKindEnum,
  HISTORY_DEPTH_KINDS,
  HISTORY_INPUT_KINDS,
  HISTORY_ITEM_REFUSALS,
  HISTORY_ITEM_SATISFIED_BY,
  HISTORY_ITEM_STATES,
  HISTORY_REQUEST_STATES,
  HISTORY_REQUESTER_KINDS,
  historyRequestItems,
  historyRequests,
  pageDmThreads,
  THREAD_CHAIN_SOURCES,
  THREAD_HISTORY_PROOFS,
  THREAD_HISTORY_STATES,
  SYNC_APPLY_STATES,
  SYNC_ENGINE_GUARD_OWNER,
  SYNC_ATTEMPT_OUTCOMES,
  SYNC_HOLD_KINDS,
  SYNC_HOLD_KINDS_BY_SCOPE,
  SYNC_HOLD_SCOPES,
  SYNC_PAGE_HOLD_KINDS,
  SYNC_PAGE_MODES,
  SYNC_SEND_MARKS,
  SYNC_WAITING_REASONS,
  SYNC_WORK_CLASSES,
  SYNC_WORK_KINDS,
  SYNC_WORK_STATES,
  SYNC_MEDIA_HANDOFF_MAX_BYTES,
  SYNC_LIFTABLE_DM_EXCLUSIONS,
  syncAttempts,
  syncHolds,
  syncMediaHandoff,
  syncPages,
} from "@agency_hub_core/db";
import { CONFIG_DESCRIPTORS, ENV_CONFIG_KEYS, RETIRED_FANSLY_ENV_KEYS } from "@agency_hub_core/shared";

// Fansly Sync Engine migrations (design §2.1): forward-only, purely additive,
// each in ROLLBACK_COMPATIBLE_MIGRATIONS. One block per migration.

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
    // The old hold slot, stale since step 4 S4-32 (nothing writes it): its
    // CHECK admits every kind a page's hold set has, and the page-wide 429
    // kind no build takes any more.
    expect(checkList(sql, "sync_pages_hold_kind_check")).toEqual(["rate_limit", ...SYNC_PAGE_HOLD_KINDS]);
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

describe("0232_history_requests.sql", () => {
  const migration = "0232_history_requests.sql";
  const text = readFileSync(`packages/db/migrations/${migration}`, "utf8");
  const sql = stripComments(text);
  const statements = topLevelStatements(sql);

  it("is purely additive: two new tables, their indexes, comments and grants", () => {
    for (const statement of statements) {
      expect(statement).toMatch(/^(create table if not exists|create (unique )?index if not exists|comment on|do \$\$)/);
      // A foreign key's own `on delete …` is not a deletion.
      expect(statement.replace(/on delete (restrict|cascade|set null)/g, "")).not.toMatch(/\b(drop|rename|truncate|delete|update|alter)\b/i);
    }
    expect(statements.filter((statement) => statement.startsWith("create table if not exists")).map((statement) => statement.split(" ")[5]))
      .toEqual(["history_requests", "history_request_items"]);
    // Page-owned (erasure keeps pages); the fans of a request go with it.
    expect(sql.match(/references pages\(id\) on delete restrict/g)).toHaveLength(2);
    expect(sql).toContain("request_id bigint not null references history_requests(id) on delete cascade");
    expect(sql).toContain("thread_id bigint references page_dm_threads(id) on delete set null");
    // [A4] resolved: the owner user is a `users` row, as agent_hydration_requests.decided_by_user_id.
    expect(sql).toContain("requester_user_id bigint references users(id) on delete restrict");
    expect(sql).toContain("requester_agent_key_id bigint references agent_keys(id) on delete restrict");
  });

  it("keeps the vocabularies of the checks equal to the repository's constants", () => {
    expect(checkList(sql, "history_requests_requester_kind_check")).toEqual([...HISTORY_REQUESTER_KINDS]);
    expect(checkList(sql, "history_requests_depth_kind_check")).toEqual([...HISTORY_DEPTH_KINDS]);
    expect(checkList(sql, "history_requests_state_check")).toEqual([...HISTORY_REQUEST_STATES]);
    expect(checkList(sql, "history_request_items_input_kind_check")).toEqual([...HISTORY_INPUT_KINDS]);
    expect(checkList(sql, "history_request_items_state_check")).toEqual([...HISTORY_ITEM_STATES]);
    expect(checkList(sql, "history_request_items_refusal_check")).toEqual([...HISTORY_ITEM_REFUSALS]);
    expect(checkList(sql, "history_request_items_satisfied_by_check")).toEqual([...HISTORY_ITEM_SATISFIED_BY]);
  });

  it("keeps one request per requester and idempotency key, and the requests class's round-robin indexes", () => {
    expect(statements).toContain(
      "create unique index if not exists history_requests_idempotency on history_requests "
        + "(requester_kind, coalesce(requester_agent_key_id, 0), coalesce(requester_user_id, 0), idempotency_key)",
    );
    expect(statements).toContain(
      "create index if not exists history_requests_page_open on history_requests (page_id, last_served_at nulls first, id) "
        + "where state = 'open'",
    );
    expect(statements).toContain(
      "create index if not exists history_request_items_rr on history_request_items "
        + "(request_id, last_served_at nulls first, ordinal) where state in ('queued', 'loading', 'blocked')",
    );
  });

  it("comments every column of both tables", () => {
    for (const table of ["history_requests", "history_request_items"]) {
      const body = sql.slice(sql.indexOf(`create table if not exists ${table} (`), sql.indexOf(");", sql.indexOf(`create table if not exists ${table} (`)));
      const columns = [...body.matchAll(/^\s{2}([a-z_0-9]+) (?:bigserial|bigint|uuid|text|integer|timestamptz|jsonb)\b/gm)].map((match) => match[1]!);
      expect(columns.length, table).toBeGreaterThan(10);
      for (const column of columns.filter((name) => name !== "id")) {
        expect(statements.some((statement) => statement.startsWith(`comment on column ${table}.${column} is '`)), `${table}.${column}`)
          .toBe(true);
      }
    }
  });

  it("grants the read role both tables", () => {
    expect(text).toContain("grant select on history_requests to read_only");
    expect(text).toContain("grant select on history_request_items to read_only");
  });

  it("names no table the runtime schema guard forbids, and is mirrored in drizzle", () => {
    expect(sql).not.toMatch(/create table if not exists sync_requests\b/);
    const names = (table: unknown) => Object.values(table as Record<string, { name?: unknown }>).map((column) => column.name);
    expect(names(historyRequests)).toEqual(expect.arrayContaining(["request_ref", "estimate_at_submit", "items_terminal"]));
    expect(names(historyRequestItems)).toEqual(expect.arrayContaining(["anchor_upward_count", "fan_platform_user_id", "final"]));
  });

  it("allows application rollback after the additive migration", () => {
    expect(rollbackCompatible()).toContain(`"${migration}"`);
  });
});

describe("0233_fansly_sync_engine_incident_kind.sql", () => {
  const migration = "0233_fansly_sync_engine_incident_kind.sql";
  const text = readFileSync(`packages/db/migrations/${migration}`, "utf8");
  const statements = topLevelStatements(stripComments(text));

  it("adds one incident kind and nothing else", () => {
    expect(statements).toEqual(["ALTER TYPE notification_incident_kind ADD VALUE IF NOT EXISTS 'fansly_sync_engine'"]);
  });

  it("is mirrored in drizzle, the repository union and the API contract", () => {
    expect(notificationIncidentKindEnum.enumValues).toContain("fansly_sync_engine");
    expect(readFileSync("packages/db/src/repositories/notifications.ts", "utf8")).toContain(`| "fansly_sync_engine"`);
    expect(readFileSync("packages/contracts/src/routes.ts", "utf8")).toMatch(/notificationIncidentKindEnum = z\.enum\(\[[^\]]*"fansly_sync_engine"/);
  });

  it("allows application rollback after the additive migration", () => {
    expect(rollbackCompatible()).toContain(`"${migration}"`);
  });
});

describe("0234_sync_media_handoff.sql", () => {
  const migration = "0234_sync_media_handoff.sql";
  const text = readFileSync(`packages/db/migrations/${migration}`, "utf8");
  const sql = stripComments(text);
  const statements = topLevelStatements(sql);

  it("is purely additive: one table, its indexes and comments", () => {
    for (const statement of statements) {
      expect(statement).toMatch(/^(create table if not exists sync_media_handoff \(|create index if not exists sync_media_handoff_|comment on )/);
    }
    expect(statements.filter((statement) => statement.startsWith("create index"))).toEqual([
      "create index if not exists sync_media_handoff_description on sync_media_handoff (description_id)",
      "create index if not exists sync_media_handoff_expires on sync_media_handoff (expires_at)",
    ]);
  });

  it("is page-owned and follows its description, caps the bytes at the download cap and expires in a day", () => {
    expect(sql).toContain("page_id bigint not null references pages(id) on delete cascade");
    expect(sql).toContain("description_id bigint not null references ai_media_descriptions(id) on delete cascade");
    expect(sql).toContain(`byte_count = octet_length(bytes) and byte_count between 0 and ${SYNC_MEDIA_HANDOFF_MAX_BYTES}`);
    expect(SYNC_MEDIA_HANDOFF_MAX_BYTES).toBe(5 * 1024 * 1024);
    expect(sql).toContain("expires_at timestamptz not null default clock_timestamp() + interval '24 hours'");
  });

  it("grants the read role nothing (chat media, read by the describer alone)", () => {
    expect(statements.filter((statement) => /^(grant|do \$\$)/i.test(statement))).toEqual([]);
    expect(sql).not.toMatch(/grant select/i);
  });

  it("comments every column", () => {
    const body = sql.slice(sql.indexOf("create table if not exists sync_media_handoff ("), sql.indexOf(");"));
    const columns = [...body.matchAll(/^\s{2}([a-z_0-9]+) (?:bigserial|bigint|text|integer|bytea|timestamptz)\b/gm)].map((match) => match[1]!);
    expect(columns).toEqual(["id", "page_id", "description_id", "work_id", "content_type", "byte_count", "bytes", "created_at", "expires_at"]);
    for (const column of columns.filter((name) => name !== "id")) {
      expect(statements.some((statement) => statement.startsWith(`comment on column sync_media_handoff.${column} is '`)), column).toBe(true);
    }
  });

  it("is mirrored in drizzle", () => {
    const names = Object.values(syncMediaHandoff as unknown as Record<string, { name?: unknown }>).map((column) => column.name);
    expect(names).toEqual(expect.arrayContaining(["page_id", "description_id", "work_id", "content_type", "byte_count", "bytes", "expires_at"]));
  });

  it("allows application rollback after the additive migration", () => {
    expect(rollbackCompatible()).toContain(`"${migration}"`);
  });
});

describe("0235_sync_pages_lifted_dm_exclusions.sql", () => {
  const migration = "0235_sync_pages_lifted_dm_exclusions.sql";
  const text = readFileSync(`packages/db/migrations/${migration}`, "utf8");
  const sql = stripComments(text);
  const statements = topLevelStatements(sql);

  it("is purely additive: one catalog-only column, its check (added not valid, then validated) and a comment", () => {
    expect(statements).toEqual([
      "alter table sync_pages add column if not exists lifted_dm_exclusions text[] not null default '{}'",
      "do $$…$$",
      "alter table sync_pages validate constraint sync_pages_lifted_dm_exclusions_check",
      expect.stringMatching(/^comment on column sync_pages\.lifted_dm_exclusions is 'Owner decision №8: /),
    ]);
    expect(sql).toMatch(
      /if not exists \(select 1 from pg_constraint where conname = 'sync_pages_lifted_dm_exclusions_check'\) then\s+alter table sync_pages add constraint sync_pages_lifted_dm_exclusions_check\s+check \(lifted_dm_exclusions <@ array\[[^\]]*\]::text\[\]\) not valid;/,
    );
    expect(sql).not.toMatch(/\b(drop|rename|truncate|delete|update)\b/i);
  });

  it("admits exactly the two exclusion reasons the shared vocabulary has", () => {
    const list = sql.slice(sql.indexOf("lifted_dm_exclusions <@ array["));
    const reasons = [...list.slice(0, list.indexOf("]")).matchAll(/'([a-z_]+)'/g)].map((match) => match[1]!);
    expect(reasons).toEqual([...SYNC_LIFTABLE_DM_EXCLUSIONS]);
  });

  it("keeps the table-level read grant (no grant of its own)", () => {
    expect(sql).not.toMatch(/grant/i);
  });

  it("is mirrored in drizzle", () => {
    expect((syncPages as unknown as Record<string, { name?: unknown }>).liftedDmExclusions?.name).toBe("lifted_dm_exclusions");
  });

  it("allows application rollback after the additive migration", () => {
    expect(rollbackCompatible()).toContain(`"${migration}"`);
  });
});

describe("0236_fansly_thread_summary_from_archive.sql", () => {
  const migration = "0236_fansly_thread_summary_from_archive.sql";
  const text = readFileSync(`packages/db/migrations/${migration}`, "utf8");
  const sql = stripComments(text);
  const statements = topLevelStatements(sql);

  it("is one data update of the live pages' stored window, and no DDL", () => {
    expect(statements).toHaveLength(1);
    const [update] = statements;
    expect(update).toMatch(/^with archive as \(.*\) update page_dm_threads t set stored_message_count = a\.stored_count, newest_stored_message_id = a\.newest_id, oldest_stored_message_id = a\.oldest_id, updated_at = now\(\) from archive a where t\.id = a\.thread_id and /);
    expect(update).toContain("join sync_pages sp on sp.page_id = t.platform_account_id and sp.mode = 'live'");
    expect(update).toContain("is distinct from (a.stored_count, a.newest_id, a.oldest_id)");
    expect(sql).not.toMatch(/\b(alter|create|drop|rename|truncate|delete|insert|grant)\b/i);
  });

  it("counts what the archive readers show: no tombstone, no content_pending stub, an instant", () => {
    expect(sql.replace(/\s+/g, " "))
      .toContain("and ma.deleted_at is null and ma.content_pending = false and ma.occurred_at is not null");
    expect(sql).not.toMatch(/last_(fan|model)_message_at\s*=/);
    expect(sql).not.toMatch(/message_coverage_status\s*=/);
  });

  it("allows application rollback after the data-only migration", () => {
    expect(rollbackCompatible()).toContain(`"${migration}"`);
  });
});

describe("0237_sync_attempt_route_intervals.sql", () => {
  const migration = "0237_sync_attempt_route_intervals.sql";
  const text = readFileSync(`packages/db/migrations/${migration}`, "utf8");
  const sql = stripComments(text);
  const statements = topLevelStatements(sql);

  it("is purely additive: two nullable columns without a default (catalog-only) and their comments", () => {
    expect(statements).toEqual([
      "alter table sync_attempts add column if not exists route_interval_ms integer",
      "alter table sync_attempts add column if not exists family_interval_ms integer",
      expect.stringMatching(/^comment on column sync_attempts\.route_interval_ms is 'I19: /),
      expect.stringMatching(/^comment on column sync_attempts\.family_interval_ms is 'I19: /),
    ]);
    expect(sql).not.toMatch(/\b(drop|rename|truncate|delete|update|default|not null|grant)\b/i);
  });

  it("is mirrored in drizzle", () => {
    const columns = syncAttempts as unknown as Record<string, { name?: unknown }>;
    expect(columns.routeIntervalMs?.name).toBe("route_interval_ms");
    expect(columns.familyIntervalMs?.name).toBe("family_interval_ms");
  });

  it("allows application rollback after the additive migration", () => {
    expect(rollbackCompatible()).toContain(`"${migration}"`);
  });
});

describe("retire_fansly_legacy_sync_states.sql (step 4, S4-21: the point of no return, stage 2)", () => {
  // Found by its name, not its number: the number is the next free one at merge.
  const found = readdirSync("packages/db/migrations").filter((file) => file.endsWith("_retire_fansly_legacy_sync_states.sql"));
  const migration = found[0] ?? "";
  const text = found.length === 1 ? readFileSync(`packages/db/migrations/${migration}`, "utf8") : "";
  const sql = stripComments(text);
  const statements = topLevelStatements(sql);

  it("exists once, after the migration that made the sync pages (0228)", () => {
    expect(found).toHaveLength(1);
    expect(migration > "0228_sync_engine_core.sql").toBe(true);
  });

  it("is one data update that parks the Fansly pages' legacy stream rows, and no DDL", () => {
    expect(statements).toHaveLength(1);
    const [update] = statements;
    expect(update).toMatch(
      /^update page_sync_states st set status = 'paused', blocker_kind = 'retired', blocker_code = 'fansly_sync_engine_owned', blocker_message = '[^']+', blocked_at = coalesce\(st\.blocked_at, clock_timestamp\(\)\), /,
    );
    // The lease and the retry are cleared, as 0097 parked the OnlyFans DM rows.
    for (const column of ["leased_seq", "lease_owner", "lease_token", "lease_heartbeat_at", "lease_expires_at", "retry_kind", "retry_at"]) {
      expect(update, column).toContain(`${column} = null`);
    }
    // Fansly pages only, and a row parked already is not rewritten.
    expect(update).toMatch(
      / from pages p where p\.id = st\.page_id and p\.platform = 'fansly' and not \(st\.status = 'paused' and st\.blocker_kind is not distinct from 'retired'\)$/,
    );
    // What a stream asked for and applied, its cursors and its runs stay.
    expect(update).not.toMatch(/request_seq|applied_seq|request_payload|progress|phase|consecutive_failures/);
    expect(sql).not.toMatch(/\b(alter|create|drop|rename|truncate|delete|insert|grant|trigger)\b/i);
    expect(sql).not.toMatch(/page_sync_cursors|sync_pages|onlyfans/);
  });

  it("uses the blocker no image clears: the one 0097 parked the OnlyFans DM rows with", () => {
    const retired = readFileSync("packages/db/migrations/0097_retire_onlyfans_legacy_dm_messages.sql", "utf8");
    expect(retired).toContain("blocker_kind = 'retired'");
    const pageSync = readFileSync("packages/db/src/repositories/page-sync.ts", "utf8");
    expect(pageSync).toContain('export const ONLYFANS_LEGACY_DM_MESSAGES_BLOCKER_KIND = "retired";');
    // A resume skips the kind; a reset keeps it and keeps the row paused.
    expect(pageSync).toContain("and blocker_kind is distinct from ${ONLYFANS_LEGACY_DM_MESSAGES_BLOCKER_KIND}");
    expect(pageSync).toContain("when blocker_kind = ${ONLYFANS_LEGACY_DM_MESSAGES_BLOCKER_KIND} then 'paused'::page_sync_status");
  });

  it("allows application rollback: the previous image serves no Fansly page from these rows", () => {
    expect(rollbackCompatible()).toContain(`"${migration}"`);
  });
});

describe("sync_holds.sql (step 4, S4-30: the hold set)", () => {
  // Found by its name, not its number: the number is the next free one at merge.
  const found = readdirSync("packages/db/migrations").filter((file) => file.endsWith("_sync_holds.sql"));
  const migration = found[0] ?? "";
  const text = found.length === 1 ? readFileSync(`packages/db/migrations/${migration}`, "utf8") : "";
  const sql = stripComments(text);
  const statements = topLevelStatements(sql);
  const columns = ["page_id", "scope", "key", "kind", "until", "since", "ladder_step", "detail", "revision", "created_at", "updated_at"];

  it("exists once, after the migration that made the sync pages (0228)", () => {
    expect(found).toHaveLength(1);
    expect(migration > "0228_sync_engine_core.sql").toBe(true);
  });

  it("is purely additive: one table, its partial unique index, comments and the read-role grant — no row, nothing of sync_pages", () => {
    for (const statement of statements) {
      expect(statement).toMatch(
        /^(create table if not exists sync_holds \(|create unique index if not exists sync_holds_page_credentials on sync_holds |comment on (table|column) sync_holds|do \$\$)/,
      );
      // A foreign key's own `on delete restrict` is not a deletion.
      expect(statement.replaceAll("on delete restrict", "")).not.toMatch(/\b(drop|rename|truncate|delete|update|insert|alter)\b/i);
    }
    expect(statements.filter((statement) => statement.startsWith("create table"))).toHaveLength(1);
    // The table starts empty: a page's state reached it when the hold-set
    // release acquired the page's ownership, never by a copy the image before
    // it could outdate.
    expect(sql).not.toMatch(/\bsync_pages\b/);
    expect(text).toContain("grant select on sync_holds to read_only");
    expect(statements.filter((statement) => statement.startsWith("do $$"))).toHaveLength(1);
  });

  it("is page-owned (the page delete restricted), keyed by page, scope, key and kind", () => {
    expect(sql).toContain("page_id bigint not null references pages(id) on delete restrict");
    expect(sql).toContain("constraint sync_holds_pkey primary key (page_id, scope, key, kind)");
    expect(sql).not.toMatch(/on delete cascade/);
    const body = sql.slice(sql.indexOf("create table if not exists sync_holds ("), sql.indexOf("\n);"));
    expect([...body.matchAll(/^\s{2}([a-z_]+) (?:bigint|text|timestamptz|smallint|jsonb)\b/gm)].map((match) => match[1])).toEqual(columns);
  });

  it("keeps the vocabularies of its checks equal to the repositories' constants", () => {
    expect(checkList(sql, "sync_holds_scope_check")).toEqual([...SYNC_HOLD_SCOPES]);
    expect(checkList(sql, "sync_holds_kind_check")).toEqual([...SYNC_HOLD_KINDS]);
    const byScope = sql.slice(sql.indexOf("constraint sync_holds_scope_kind_check check"), sql.indexOf("constraint sync_holds_until_check"));
    const kindsOf = (scope: string) => {
      const clause = byScope.slice(byScope.indexOf(`scope = '${scope}'`));
      return [...clause.slice(0, clause.indexOf("\n")).matchAll(/'([a-z_]+)'/g)].map((match) => match[1]).slice(1);
    };
    for (const scope of SYNC_HOLD_SCOPES) expect(kindsOf(scope), scope).toEqual([...SYNC_HOLD_KINDS_BY_SCOPE[scope]]);
    // A page-scope row has no key; a route's and a resource file's name theirs.
    expect(byScope).toMatch(/scope = 'page' and key = ''/);
    expect(byScope).toMatch(/scope = 'route' and key <> ''/);
    expect(byScope).toMatch(/scope = 'resource' and key <> ''/);
    // Only the route's state is a row without an end.
    expect(sql).toContain("constraint sync_holds_until_check check ((kind = 'route_budget') = (until is null))");
  });

  it("holds one credentials hold a page", () => {
    expect(statements).toContain(
      "create unique index if not exists sync_holds_page_credentials on sync_holds (page_id) "
        + "where scope = 'page' and kind in ('auth', 'identity_mismatch')",
    );
  });

  it("comments the table and every column", () => {
    expect(statements.some((statement) => statement.startsWith("comment on table sync_holds is '"))).toBe(true);
    for (const column of columns) {
      expect(statements.some((statement) => statement.startsWith(`comment on column sync_holds.${column} is '`)), column).toBe(true);
    }
  });

  it("is mirrored in drizzle", () => {
    const names = Object.values(syncHolds as unknown as Record<string, { name?: unknown }>).map((column) => column.name);
    expect(names).toEqual(expect.arrayContaining(columns));
  });

  it("no longer allows application rollback: the image before it reads the old hold columns, and no hold write rewrites them", () => {
    // It was listed while every hold write rewrote the page row's old hold
    // columns from the rows (the release that brought the table, and the one
    // after it). The hold writers write the rows alone now (step 4, S4-32;
    // tests/sync-old-hold-columns.test.ts), so an image that knows only the
    // columns would hold nothing taken since: a deploy that still applies
    // this migration must not roll back by itself.
    expect(rollbackCompatible()).not.toContain(`"${migration}"`);
    const pages = readFileSync("packages/db/src/repositories/sync/pages.ts", "utf8");
    expect(pages.match(/writeHoldSet\(db, input,/g)).toHaveLength(4);
    expect(pages).not.toMatch(/LegacyColumns/);
    // No other statement writes a hold row.
    for (const file of readdirSync("packages/db/src/repositories/sync")) {
      if (file === "pages.ts") continue;
      expect(readFileSync(`packages/db/src/repositories/sync/${file}`, "utf8"), file).not.toMatch(/(insert into|update|delete from) sync_holds\b/);
    }
  });
});

describe("retire_fansly_legacy_config_overrides.sql (step 4, S4-26: the legacy Fansly config keys go)", () => {
  // Found by its name, not its number: the number is the next free one at merge.
  const found = readdirSync("packages/db/migrations").filter((file) => file.endsWith("_retire_fansly_legacy_config_overrides.sql"));
  const migration = found[0] ?? "";
  const text = found.length === 1 ? readFileSync(`packages/db/migrations/${migration}`, "utf8") : "";
  const sql = stripComments(text);
  const statements = topLevelStatements(sql);
  const keys = [...(/^with retired \(key\) as \( values (.*?) \), batch as /.exec(statements[0] ?? "")?.[1] ?? "")
    .matchAll(/\('([^']*)'\)/g)].map((match) => match[1]!);
  /** The env var a key was read from: its name in upper snake case. */
  const envName = (key: string) => key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();

  it("exists once, after the migration that made the override tables (0035)", () => {
    expect(found).toHaveLength(1);
    expect(migration > "0035_config_settings.sql").toBe(true);
  });

  it("is one data statement — the overrides deleted, one audit row for each — and no DDL", () => {
    expect(statements).toHaveLength(1);
    const [statement] = statements;
    // Every scope of a retired key goes; what was stored comes back from the delete.
    expect(statement).toContain(
      "removed as ( delete from config_settings cs using retired r where cs.key = r.key "
        + "returning cs.scope_type, cs.scope_id, cs.key, cs.value, cs.version )",
    );
    // The audit row of a clear (repositories/config-settings.ts): the old value
    // and version, new value and version null, no user — and one group for all.
    expect(statement).toContain("batch as materialized ( select gen_random_uuid() as group_id )");
    expect(statement).toMatch(
      /insert into config_audit_log \(group_id, user_id, scope_type, scope_id, key, old_value, new_value, old_version, new_version, note\) select b\.group_id, null, d\.scope_type, d\.scope_id, d\.key, d\.value, null, d\.version, null, 'step 4: retired with the legacy Fansly engine \(migration retire_fansly_legacy_config_overrides\)' from removed d cross join batch b order by d\.key$/,
    );
    expect(sql).not.toMatch(/\b(alter|create|drop|rename|truncate|update|grant|trigger)\b/i);
    // Nothing but the two override tables is named.
    expect([...sql.matchAll(/\b(?:from|into|join|using)\s+([a-z_]+)/g)].map((match) => match[1]).sort())
      .toEqual(["batch", "config_audit_log", "config_settings", "removed", "retired"]);
  });

  it("names exactly the keys this release drops: none is registered, and their env vars are the retired list", () => {
    expect(keys).toHaveLength(68);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual([...keys].sort());
    const registered = new Set(CONFIG_DESCRIPTORS.map((descriptor) => descriptor.key));
    expect(keys.filter((key) => registered.has(key))).toEqual([]);
    // One list for the stored rows (here) and one for the env (the boot
    // warning): the same keys, by their two names.
    expect(keys.map(envName).sort()).toEqual([...RETIRED_FANSLY_ENV_KEYS].sort());
    expect(keys.map(envName).filter((name) => (ENV_CONFIG_KEYS as string[]).includes(name))).toEqual([]);
  });

  it("keeps the overrides of the keys the engine and OnlyFans still read", () => {
    for (const kept of [
      "fanslyDefaultDelayMs", "fanslyBaseUrl", "fanslyReplayMode", "fanslyRepliesRewalkCycleDays",
      "fanslyLiveOverlayReadPages", "pageDmPruneEnabled", "syncObservabilityRetentionDays", "syncHttpTraceFile",
      "syncHttpAttemptTraceStdout", "egressPacerMode", "agentHydrationMode", "syncPageExecutorConcurrency",
      "healthSyncLightMaxAgeMinutes", "onlyFansDefaultDelayMs", "onlyFansDmPollingEnabled", "onlyFansTopSpendersEnabled",
    ]) {
      expect(keys, kept).not.toContain(kept);
      expect(CONFIG_DESCRIPTORS.some((descriptor) => descriptor.key === kept), kept).toBe(true);
    }
  });

  it("allows application rollback: the previous image reads none of these keys", () => {
    expect(rollbackCompatible()).toContain(`"${migration}"`);
  });
});

describe("sync_pages_drop_hold_step.sql (step 4, S4-31: the first old hold column goes)", () => {
  // Found by its name, not its number: the number is the next free one at merge.
  const migrations = readdirSync("packages/db/migrations").filter((file) => file.endsWith(".sql")).sort();
  const found = migrations.filter((file) => file.endsWith("_sync_pages_drop_hold_step.sql"));
  const migration = found[0] ?? "";
  const text = found.length === 1 ? readFileSync(`packages/db/migrations/${migration}`, "utf8") : "";
  const statements = topLevelStatements(stripComments(text));

  it("exists once, after the hold set's table", () => {
    expect(found).toHaveLength(1);
    const holdSet = migrations.find((file) => file.endsWith("_sync_holds.sql")) ?? "";
    expect(holdSet).not.toBe("");
    expect(migration > holdSet).toBe(true);
  });

  it("drops `sync_pages.hold_step` and nothing else, its lock wait bounded", () => {
    expect(statements).toEqual([
      "set local lock_timeout = '5s'",
      "alter table sync_pages drop column if exists hold_step",
    ]);
  });

  it("leaves the other old hold columns in the database: no later migration has dropped them yet", () => {
    // The image before this one (S4-31) still writes them at every hold
    // write; this one names one of them once, for the marker of an
    // acquisition (tests/sync-old-hold-columns.test.ts).
    const base = stripComments(readFileSync("packages/db/migrations/0228_sync_engine_core.sql", "utf8"));
    for (const column of ["hold_kind", "hold_until", "hold_since", "hold_detail", "resource_holds"]) {
      expect(base, column).toMatch(new RegExp(`^\\s{2}${column} `, "m"));
      for (const later of migrations.filter((file) => file > "0228_sync_engine_core.sql")) {
        const sql = stripComments(readFileSync(`packages/db/migrations/${later}`, "utf8"));
        expect(sql, `${later}: ${column}`).not.toMatch(new RegExp(`drop column (if exists )?${column}\\b`, "i"));
      }
    }
    // The counter of consecutive network failures is no hold: it stays.
    expect(base).toMatch(/^\s{2}network_failure_streak smallint not null default 0,$/m);
  });

  it("no longer allows application rollback (the image before it lets the stale columns win); no source names the column", () => {
    // Listed while the hold writers kept the other old hold columns equal to
    // the rows, which the image before this migration compares at every
    // acquisition. They are stale since step 4 S4-32.
    expect(rollbackCompatible()).not.toContain(`"${migration}"`);
    // The page row is read through one list of named columns, never `*`.
    const pages = readFileSync("packages/db/src/repositories/sync/pages.ts", "utf8");
    expect(pages).not.toMatch(/\bsp\.\*|select \* from sync_pages|to_jsonb\(sp\)/);
    const sources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) return entry.name === "node_modules" || entry.name === "dist" ? [] : sources(path);
      return /\.(ts|tsx|sql|mjs|sh)$/.test(entry.name) ? [path] : [];
    });
    const naming = [...sources("apps"), ...sources("packages/db/src"), ...sources("packages/shared/src"), ...sources("packages/contracts/src"), ...sources("scripts")]
      .filter((path) => readFileSync(path, "utf8").replaceAll(migration, "").split("\n")
        .some((line) => /hold_step|holdStep/.test(line) && !/^\s*(\/\/|\/?\*|#|--)/.test(line)));
    expect(naming).toEqual([]);
    // Nor does a test select it: only the tests of this migration name it
    // (and the pin of the old hold columns, which names the migration's file).
    const tests = readdirSync("tests").filter((file) => file.endsWith(".ts") && /hold_step|holdStep/.test(readFileSync(`tests/${file}`, "utf8")));
    expect(tests.sort()).toEqual(["sync-engine-migrations.test.ts", "sync-hold-set.integration.test.ts", "sync-old-hold-columns.test.ts"]);
  });
});
