import { createHash } from "node:crypto";
import { readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { sql, type SQL } from "drizzle-orm";

import type { AppContext } from "../../bootstrap.ts";
import { recordAudit } from "../auth.ts";
import type { TieringManifest } from "../tiering/index.ts";

// Kernel Stage 28 Task 4 — the audited break-glass erasure (DP 7-A: business
// facts are forever; "delete" is a governed procedure). Owner-initiated,
// scoped (fan / page / model), dry-run by default. Execution reaches ALL
// history planes: hot tables, attached ledger partitions, detached-but-parked
// partitions in tiered_pending_drop (a parent-table DELETE never reaches
// those), and the Parquet lake (filter-out rewrite + manifest checksum
// update).
//
// EXECUTION DECISIONS (recorded):
// - Catalog rows survive: models/pages/users are the agency's own records,
//   not captured personal data — erasing a page removes its captured facts
//   and derived projections, not its catalog entry (offboarding is a
//   different act). The fans row IS captured identity and is deleted.
// - Fan-scope transactions are ANONYMIZED, not deleted (fan linkage and
//   vendor identifiers nulled): the money moved — aggregates must stay
//   truthful. Page-scope erasure deletes the page's transactions outright.
// - No post-erasure projection rebuilds: after tiering, a full account
//   rebuild replays hot events only and would DESTROY projection rows whose
//   source months are detached. Erasure purges projection rows directly;
//   non-resurrection is structural (the source events/observations are
//   gone) and the drill proves it by re-running the projections.
// - Observation exclusivity: an observation is erased only if NO other
//   fan's domain events reference it (deleting a shared batch capture would
//   orphan bystanders' lineage). Shared survivors are counted and reported
//   in the plan and tombstone — residual risk made visible, not hidden.
// - Undeclared kinds (parse_version 0, no events) are reached by a payload
//   text match on the fan ref (quoted-JSON form always; bare-numeric form
//   with boundaries when the ref is numeric).

export type ErasureScopeInput =
  | { scopeType: "fan"; platform: "onlyfans" | "fansly"; fanRef: string }
  | { scopeType: "page"; pageLabel: string }
  | { scopeType: "model"; modelSlug: string };

export function erasureScopeRef(scope: ErasureScopeInput): string {
  switch (scope.scopeType) {
    case "fan":
      return `fan:${scope.platform}:${scope.fanRef}`;
    case "page":
      return `page:${scope.pageLabel}`;
    case "model":
      return `model:${scope.modelSlug}`;
  }
}

export interface ErasureTarget {
  plane: "hot" | "ledger" | "lake";
  target: string;
  action: "delete" | "anonymize" | "cascade" | "rewrite";
  rows: number;
}

export interface ErasurePlan {
  scopeType: ErasureScopeInput["scopeType"];
  scopeRef: string;
  targets: ErasureTarget[];
  /** Observations shared with other fans' lineage — reported, never touched. */
  sharedObservations: number;
  totalRows: number;
  /** PR4 fence: the RESOLVED page ids at execution time. pages.label is
   * mutable, so the non-resurrection fence must never resolve a page scope
   * through scope_ref — a post-erasure rename would disarm it. The fence
   * check (isDmArchiveScopeFenced) matches page/model scopes against this
   * list in the stored plan jsonb; fan scopes match by immutable fan ref. */
  resolvedPageIds: number[];
}

interface ResolvedScope {
  input: ErasureScopeInput;
  scopeRef: string;
  pageIds: number[];
  /** fan scope only */
  fanId: number | null;
  fanRef: string | null;
  /** page/model scope: the pages' vendor-native account refs */
  nativeRefs: string[];
}

type Db = Pick<AppContext, "db" | "config" | "logger">;

async function rows<T extends Record<string, unknown>>(app: Db, query: SQL): Promise<T[]> {
  const result = await app.db.execute<T>(query);
  return result.rows as T[];
}

async function countOf(app: Db, query: SQL): Promise<number> {
  const result = await rows<{ n: string }>(app, query);
  return Number(result[0]?.n ?? 0);
}

// ---------------------------------------------------------------------------
// Scope resolution

async function resolveScope(app: Db, input: ErasureScopeInput): Promise<ResolvedScope> {
  const scopeRef = erasureScopeRef(input);
  if (input.scopeType === "fan") {
    const pageRows = await rows<{ id: string }>(
      app,
      sql`select id::text as id from pages where platform = ${input.platform}`,
    );
    const fanRows = await rows<{ id: string }>(
      app,
      sql`select id::text as id from fans
          where platform = ${input.platform} and platform_user_id = ${input.fanRef}`,
    );
    if (pageRows.length === 0) {
      // No pages on the platform → no capture surface where the fan could
      // exist; also keeps every `in (...)` list below non-empty.
      throw new Error(`erasure scope resolves to no pages: ${scopeRef}`);
    }
    return {
      input,
      scopeRef,
      pageIds: pageRows.map((row) => Number(row.id)),
      fanId: fanRows[0] ? Number(fanRows[0].id) : null,
      fanRef: input.fanRef,
      nativeRefs: [],
    };
  }

  const pageRows = input.scopeType === "page"
    ? await rows<{ id: string; a: string | null; b: string | null }>(
      app,
      sql`select id::text as id, external_page_id as a, ofapi_account_id as b
          from pages where label = ${input.pageLabel}`,
    )
    : await rows<{ id: string; a: string | null; b: string | null }>(
      app,
      sql`select p.id::text as id, p.external_page_id as a, p.ofapi_account_id as b
          from pages p join models m on m.id = p.model_id
          where m.slug = ${input.modelSlug}`,
    );
  if (pageRows.length === 0) {
    throw new Error(`erasure scope resolves to no pages: ${scopeRef}`);
  }
  return {
    input,
    scopeRef,
    pageIds: pageRows.map((row) => Number(row.id)),
    fanId: null,
    fanRef: null,
    nativeRefs: pageRows.flatMap((row) => [row.a, row.b]).filter((ref): ref is string => !!ref),
  };
}

// ---------------------------------------------------------------------------
// Ledger predicates (hot partitions, parked partitions, and — translated to
// DuckDB SQL — the lake files all use the same shapes)

function eventPredSql(scope: ResolvedScope, alias = ""): SQL {
  const a = alias ? sql.raw(`${alias}.`) : sql.raw("");
  if (scope.input.scopeType === "fan") {
    return sql`${a}account_id in ${scope.pageIds}
      and (${a}fan_identity_ref = ${scope.fanRef} or ${a}conversation_ref = ${scope.fanRef})`;
  }
  return sql`${a}account_id in ${scope.pageIds}`;
}

function observationPagePredSql(scope: ResolvedScope): SQL {
  if (scope.nativeRefs.length > 0) {
    return sql`(account_id in ${scope.pageIds}
      or native_account_ref in ${scope.nativeRefs})`;
  }
  return sql`account_id in ${scope.pageIds}`;
}

function payloadMatchPredSql(fanRef: string): SQL {
  const quoted = sql`payload::text like ${"%\"" + fanRef + "\"%"}`;
  if (/^\d+$/.test(fanRef)) {
    return sql`(${quoted} or payload::text ~ ${"[:\\[,[:space:]]" + fanRef + "[,}\\]]"})`;
  }
  return quoted;
}

function duckdbEscape(value: string): string {
  return value.replaceAll("'", "''");
}

function duckdbEventPred(scope: ResolvedScope): string {
  const ids = scope.pageIds.join(", ") || "-1";
  if (scope.input.scopeType === "fan") {
    const ref = duckdbEscape(scope.fanRef!);
    return `account_id IN (${ids}) AND (fan_identity_ref = '${ref}' OR conversation_ref = '${ref}')`;
  }
  return `account_id IN (${ids})`;
}

function duckdbObservationPred(scope: ResolvedScope, eraseObsIds: number[]): string {
  if (scope.input.scopeType !== "fan") {
    const ids = scope.pageIds.join(", ") || "-1";
    const refs = scope.nativeRefs.map((ref) => `'${duckdbEscape(ref)}'`).join(", ");
    return refs.length > 0
      ? `(account_id IN (${ids}) OR native_account_ref IN (${refs}))`
      : `account_id IN (${ids})`;
  }
  const ref = duckdbEscape(scope.fanRef!);
  const parts = [`CAST(payload AS VARCHAR) LIKE '%"${ref}"%'`];
  if (/^\d+$/.test(scope.fanRef!)) {
    parts.push(`regexp_matches(CAST(payload AS VARCHAR), '[:\\[,\\s]${ref}[,}\\]]')`);
  }
  if (eraseObsIds.length > 0) {
    parts.push(`id IN (${eraseObsIds.join(", ")})`);
  }
  return `(${parts.join(" OR ")})`;
}

// ---------------------------------------------------------------------------
// Parked partitions (tiered_pending_drop) — a DELETE on the partitioned
// parent never reaches detached tables, so they are separate targets.

async function listParkedTables(app: Db): Promise<{ observations: string[]; domainEvents: string[] }> {
  const parked = await rows<{ relname: string }>(app, sql`
    select c.relname from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'tiered_pending_drop' and c.relkind = 'r'
    order by c.relname
  `);
  return {
    observations: parked.map((row) => row.relname).filter((name) => name.startsWith("observations_")),
    domainEvents: parked.map((row) => row.relname).filter((name) => name.startsWith("domain_events_")),
  };
}

// ---------------------------------------------------------------------------
// Lake scanning

interface LakeManifestFile {
  table: "observations" | "domain_events";
  manifestPath: string;
  parquetPath: string;
  restrictedParquetPath: string;
  relPath: string;
  manifest: TieringManifest;
}

async function listLakeManifests(app: Db): Promise<LakeManifestFile[]> {
  const lakeDir = app.config.lakeDir;
  let entries: string[];
  try {
    entries = (await readdir(lakeDir, { recursive: true })) as string[];
  } catch {
    return [];
  }
  const found: LakeManifestFile[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".manifest.json")) {
      continue;
    }
    const manifestPath = path.join(lakeDir, entry);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as TieringManifest;
    const base = manifestPath.slice(0, -".manifest.json".length);
    const yearDir = path.dirname(base);
    const table = manifest.table as LakeManifestFile["table"];
    found.push({
      table,
      manifestPath,
      parquetPath: `${base}.parquet`,
      restrictedParquetPath: path.join(
        lakeDir, "restricted", table, path.basename(yearDir), `${path.basename(base)}.parquet`,
      ),
      relPath: entry.slice(0, -".manifest.json".length),
      manifest,
    });
  }
  return found;
}

type DuckRunner = (query: string) => Promise<Array<Record<string, unknown>>>;

async function withDuckDb<T>(fn: (run: DuckRunner) => Promise<T>): Promise<T> {
  const { DuckDBInstance } = await import("@duckdb/node-api");
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
    return await fn(async (query: string) => {
      const reader = await connection.run(query);
      return await reader.getRowObjects() as Array<Record<string, unknown>>;
    });
  } finally {
    connection.closeSync();
  }
}

async function sha256File(filePath: string): Promise<string> {
  const bytes = await readFile(filePath);
  return createHash("sha256").update(bytes).digest("hex");
}

// ---------------------------------------------------------------------------
// Fan-scope lineage: which observations may be erased.

interface LedgerLineage {
  /** domain_events ids matching the fan pred, across hot + parked + lake */
  eventIds: number[];
  /** observations to erase (exclusively this fan's), across all planes */
  eraseObsIds: number[];
  /** observations referenced by the fan AND by others — reported, kept */
  sharedObsIds: number[];
}

async function collectFanLineage(
  app: Db,
  scope: ResolvedScope,
  lakeFiles: LakeManifestFile[],
): Promise<LedgerLineage> {
  const parked = await listParkedTables(app);
  const eventIds = new Set<number>();
  const candidates = new Set<number>();
  const shared = new Set<number>();

  const eventSources = ["domain_events", ...parked.domainEvents.map((t) => `tiered_pending_drop."${t}"`)];
  for (const source of eventSources) {
    const fanEvents = await rows<{ id: string; observation_id: string }>(app, sql`
      select id::text as id, observation_id::text as observation_id
      from ${sql.raw(source)} where ${eventPredSql(scope)}
    `);
    for (const event of fanEvents) {
      eventIds.add(Number(event.id));
      candidates.add(Number(event.observation_id));
    }
  }

  // Payload-matched observations (undeclared kinds carry the fan ref only
  // inside the payload), hot + parked.
  const obsSources = ["observations", ...parked.observations.map((t) => `tiered_pending_drop."${t}"`)];
  for (const source of obsSources) {
    const matched = await rows<{ id: string }>(app, sql`
      select id::text as id from ${sql.raw(source)}
      where account_id in ${scope.pageIds} and ${payloadMatchPredSql(scope.fanRef!)}
    `);
    for (const row of matched) {
      candidates.add(Number(row.id));
    }
  }

  // Wave 2: REST-material lineage — observations that materially advanced
  // the fan's dm_message_archive rows (rest_material_observation_id), even
  // when the payload text match misses them. Collected BEFORE the hot
  // targets delete those rows (buildWork runs lineage first).
  const restLineage = await rows<{ id: string }>(app, sql`
    select distinct d.rest_material_observation_id::text as id
    from dm_message_archive d
    where d.rest_material_observation_id is not null
      and d.platform_account_id in ${scope.pageIds}
      and (d.fan_platform_user_id = ${scope.fanRef}
        or d.platform_conversation_id = ${scope.fanRef}
        or d.sender_platform_user_id = ${scope.fanRef})
  `);
  for (const row of restLineage) {
    candidates.add(Number(row.id));
  }

  // Lake-side lineage + payload matches.
  const eventFiles = lakeFiles.filter((file) => file.table === "domain_events");
  const obsFiles = lakeFiles.filter((file) => file.table === "observations");
  if (lakeFiles.length > 0) {
    await withDuckDb(async (run) => {
      for (const file of eventFiles) {
        const matched = await run(
          `SELECT id, observation_id FROM read_parquet('${duckdbEscape(file.parquetPath)}') `
          + `WHERE ${duckdbEventPred(scope)}`,
        );
        for (const row of matched) {
          eventIds.add(Number(row.id));
          candidates.add(Number(row.observation_id));
        }
      }
      for (const file of obsFiles) {
        const paths = [file.parquetPath];
        if (file.manifest.restrictedRowCount > 0) {
          paths.push(file.restrictedParquetPath);
        }
        for (const parquet of paths) {
          const matched = await run(
            `SELECT id FROM read_parquet('${duckdbEscape(parquet)}') `
            + `WHERE ${duckdbObservationPred(scope, [])}`,
          );
          for (const row of matched) {
            candidates.add(Number(row.id));
          }
        }
      }

      // Shared guard, lake side.
      if (candidates.size > 0) {
        const idList = [...candidates].join(", ");
        for (const file of eventFiles) {
          const others = await run(
            `SELECT DISTINCT observation_id FROM read_parquet('${duckdbEscape(file.parquetPath)}') `
            + `WHERE observation_id IN (${idList}) AND NOT COALESCE((${duckdbEventPred(scope)}), FALSE)`,
          );
          for (const row of others) {
            shared.add(Number(row.observation_id));
          }
        }
      }
    });
  }

  // Shared guard, hot + parked side.
  if (candidates.size > 0) {
    for (const source of eventSources) {
      const others = await rows<{ observation_id: string }>(app, sql`
        select distinct observation_id::text as observation_id from ${sql.raw(source)}
        where observation_id in ${[...candidates]} and not coalesce((${eventPredSql(scope)}), false)
      `);
      for (const row of others) {
        shared.add(Number(row.observation_id));
      }
    }
  }

  return {
    eventIds: [...eventIds],
    eraseObsIds: [...candidates].filter((id) => !shared.has(id)),
    sharedObsIds: [...shared],
  };
}

// ---------------------------------------------------------------------------
// Hot targets

interface WorkTarget extends ErasureTarget {
  /** Executes the target inside the erasure transaction; returns rows hit.
   * Absent for cascade (count-only) and lake targets. */
  run?: (tx: Db["db"]) => Promise<number>;
}

async function execCount(tx: Db["db"], query: SQL): Promise<number> {
  const result = await tx.execute(query);
  return Number((result as { rowCount?: number | null }).rowCount ?? 0);
}

/** Non-cascade FKs to fans need a curated stance; an unmapped one means a
 * new table joined the fan graph without an erasure decision — fail loudly. */
const FAN_FK_CURATED = new Set(["transactions", "page_dm_threads", "page_fan_identities", "fan_earnings_stats"]);

async function fanHotTargets(app: Db, scope: ResolvedScope, _lineage: LedgerLineage): Promise<WorkTarget[]> {
  const ref = scope.fanRef!;
  const fanId = scope.fanId ?? -1;
  const targets: WorkTarget[] = [];

  const fanFks = await rows<{ child: string; del_type: string }>(app, sql`
    select con.conrelid::regclass::text as child, con.confdeltype::text as del_type
    from pg_constraint con
    where con.contype = 'f' and con.confrelid = 'fans'::regclass
    order by child
  `);
  const unmapped = fanFks.filter((fk) => fk.del_type !== "c" && !FAN_FK_CURATED.has(fk.child));
  if (unmapped.length > 0) {
    throw new Error(
      `unmapped non-cascade FK(s) to fans — extend the erasure curation: ${unmapped.map((fk) => fk.child).join(", ")}`,
    );
  }

  // wb_closing_cache verdicts can quote fan text; resolve via the fan's DM
  // threads BEFORE those threads (and their messages) are deleted.
  const threadPred = sql`t.platform_account_id in ${scope.pageIds}
    and (t.fan_id = ${fanId} or t.platform_conversation_id = ${ref})`;
  targets.push({
    plane: "hot",
    target: "wb_closing_cache",
    action: "delete",
    rows: await countOf(app, sql`
      select count(*)::text as n from wb_closing_cache c
      where exists (
        select 1 from page_dm_messages m
        join page_dm_threads t on t.id = m.conversation_id
        where ${threadPred} and m.platform_account_id = c.platform_account_id
          and m.platform_message_id = c.platform_message_id
      )`),
    run: (tx) => execCount(tx, sql`
      delete from wb_closing_cache c
      where exists (
        select 1 from page_dm_messages m
        join page_dm_threads t on t.id = m.conversation_id
        where ${threadPred} and m.platform_account_id = c.platform_account_id
          and m.platform_message_id = c.platform_message_id
      )`),
  });

  // The fan's DM threads; messages ride the FK cascade but are counted.
  targets.push({
    plane: "hot",
    target: "page_dm_messages",
    action: "cascade",
    rows: await countOf(app, sql`
      select count(*)::text as n from page_dm_messages m
      where exists (select 1 from page_dm_threads t where t.id = m.conversation_id and ${threadPred})`),
  });
  targets.push({
    plane: "hot",
    target: "page_dm_threads",
    action: "delete",
    rows: await countOf(app, sql`select count(*)::text as n from page_dm_threads t where ${threadPred}`),
    run: (tx) => execCount(tx, sql`delete from page_dm_threads t where ${threadPred}`),
  });

  // fan_earnings_stats FKs fans with RESTRICT — must clear before the fans row.
  targets.push({
    plane: "hot",
    target: "fan_earnings_stats",
    action: "delete",
    rows: await countOf(app, sql`select count(*)::text as n from fan_earnings_stats where fan_id = ${fanId}`),
    run: (tx) => execCount(tx, sql`delete from fan_earnings_stats where fan_id = ${fanId}`),
  });

  const identityPred = sql`fan_id = ${fanId} or (platform_account_id in ${scope.pageIds}
    and (account_id = ${ref} or correlation_account_id = ${ref}))`;
  targets.push({
    plane: "hot",
    target: "page_fan_identities",
    action: "delete",
    rows: await countOf(app, sql`select count(*)::text as n from page_fan_identities where ${identityPred}`),
    run: (tx) => execCount(tx, sql`delete from page_fan_identities where ${identityPred}`),
  });

  const archivePred = sql`account_id in ${scope.pageIds}
    and (fan_native_id = ${ref} or conversation_ref = ${ref})`;
  targets.push({
    plane: "hot",
    target: "message_archive",
    action: "delete",
    rows: await countOf(app, sql`select count(*)::text as n from message_archive where ${archivePred}`),
    run: (tx) => execCount(tx, sql`delete from message_archive where ${archivePred}`),
  });

  const dmArchivePred = sql`platform_account_id in ${scope.pageIds}
    and (fan_platform_user_id = ${ref} or platform_conversation_id = ${ref} or sender_platform_user_id = ${ref})`;
  targets.push({
    plane: "hot",
    target: "dm_message_archive",
    action: "delete",
    rows: await countOf(app, sql`select count(*)::text as n from dm_message_archive where ${dmArchivePred}`),
    run: (tx) => execCount(tx, sql`delete from dm_message_archive where ${dmArchivePred}`),
  });

  // Sent-command payloads carry our side of the fan's conversation.
  const commandPred = sql`page_id in ${scope.pageIds} and conversation_id = ${ref}`;
  targets.push({
    plane: "hot",
    target: "ofapi_commands",
    action: "delete",
    rows: await countOf(app, sql`select count(*)::text as n from ofapi_commands where ${commandPred}`),
    run: (tx) => execCount(tx, sql`delete from ofapi_commands where ${commandPred}`),
  });

  // Stage 29 restricted class: generations tied to the fan's conversation
  // (acceptance rows resolve through them, so they go first).
  const generationPred = sql`page_id in ${scope.pageIds} and conversation_ref = ${ref}`;
  targets.push({
    plane: "hot",
    target: "ai_acceptance_events",
    action: "delete",
    rows: await countOf(app, sql`
      select count(*)::text as n from ai_acceptance_events
      where generation_ref in (
        select generation_ref from ai_generation_content where ${generationPred})`),
    run: (tx) => execCount(tx, sql`
      delete from ai_acceptance_events
      where generation_ref in (
        select generation_ref from ai_generation_content where ${generationPred})`),
  });
  targets.push({
    plane: "hot",
    target: "ai_generation_content",
    action: "delete",
    rows: await countOf(app, sql`
      select count(*)::text as n from ai_generation_content where ${generationPred}`),
    run: (tx) => execCount(tx, sql`
      delete from ai_generation_content where ${generationPred}`),
  });

  // Transactions: the money moved — anonymize, never delete (fan scope).
  const txnPred = sql`fan_id = ${fanId} or (platform_account_id in ${scope.pageIds}
    and (correlation_account_id = ${ref} or sender_id = ${ref}))`;
  targets.push({
    plane: "hot",
    target: "transactions",
    action: "anonymize",
    rows: await countOf(app, sql`select count(*)::text as n from transactions where ${txnPred}`),
    run: (tx) => execCount(tx, sql`
      update transactions
      set fan_id = null, correlation_id = null, correlation_account_id = null,
          sender_id = null, receiver_id = null, account_id = null,
          wallet_id = null, scan_token = null
      where ${txnPred}`),
  });

  // Cascade tables: counted for the plan; the fans-row delete carries them.
  for (const fk of fanFks.filter((row) => row.del_type === "c")) {
    targets.push({
      plane: "hot",
      target: fk.child,
      action: "cascade",
      rows: await countOf(app, sql`
        select count(*)::text as n from ${sql.raw(`"${fk.child}"`)} where fan_id = ${fanId}`),
    });
  }
  targets.push({
    plane: "hot",
    target: "fans",
    action: "delete",
    rows: scope.fanId === null ? 0 : 1,
    run: (tx) => execCount(tx, sql`delete from fans where id = ${fanId}`),
  });

  return targets;
}

async function pageHotTargets(app: Db, scope: ResolvedScope): Promise<WorkTarget[]> {
  const pageIds = scope.pageIds;
  const targets: WorkTarget[] = [];

  // Fans linked ONLY to these pages become orphaned identity rows; collect
  // the candidates before page_fans is purged, guard against links elsewhere.
  const linkedFanRows = await rows<{ id: string }>(app, sql`
    select distinct fan_id::text as id from page_fans
    where platform_account_id in ${pageIds}
  `);
  const linkedFanIds = linkedFanRows.map((row) => Number(row.id));
  const orphanPred = sql`id in ${linkedFanIds}
    and not exists (select 1 from page_fans pf where pf.fan_id = fans.id
                    and pf.platform_account_id not in ${pageIds})
    and not exists (select 1 from transactions t where t.fan_id = fans.id
                    and t.platform_account_id not in ${pageIds})
    and not exists (select 1 from fan_earnings_stats s where s.fan_id = fans.id
                    and s.account_id not in ${pageIds})`;

  const simple = (table: string, column: string): WorkTarget => ({
    plane: "hot",
    target: table,
    action: "delete",
    rows: -1, // filled below
    run: (tx) => execCount(tx, sql`
      delete from ${sql.raw(`"${table}"`)} where ${sql.raw(`"${column}"`)} in ${pageIds}`),
  });

  // Stage 29 restricted class: acceptance rows resolve through the
  // generations table — delete them by join before it.
  targets.push({
    plane: "hot",
    target: "ai_acceptance_events",
    action: "delete",
    rows: await countOf(app, sql`
      select count(*)::text as n from ai_acceptance_events
      where generation_ref in (
        select generation_ref from ai_generation_content where page_id in ${pageIds})`),
    run: (tx) => execCount(tx, sql`
      delete from ai_acceptance_events
      where generation_ref in (
        select generation_ref from ai_generation_content where page_id in ${pageIds})`),
  });

  const deletions: Array<[string, string]> = [
    ["ai_generation_content", "page_id"],
    ["wb_closing_cache", "platform_account_id"],
    ["page_dm_threads", "platform_account_id"], // messages ride the cascade
    ["message_archive", "account_id"],
    ["dm_message_archive", "platform_account_id"],
    ["dm_message_daily_aggregates", "platform_account_id"],
    ["ofapi_commands", "page_id"],
    ["fan_earnings_stats", "account_id"],
    ["page_fan_identities", "platform_account_id"],
    ["fan_spend_daily", "platform_account_id"],
    ["fan_spend_lifetime", "platform_account_id"],
    ["fan_notes", "platform_account_id"],
    ["page_fan_external_notes", "platform_account_id"],
    ["page_fan_aliases", "platform_account_id"],
    ["page_follows", "platform_account_id"],
    ["page_subscriptions", "platform_account_id"],
    ["page_fans", "platform_account_id"],
    ["daily_followers", "platform_account_id"],
    ["daily_subscribers", "platform_account_id"],
    ["workboard_state", "platform_account_id"],
    ["workboard_contact_log", "platform_account_id"],
    ["workboard_claim_leases", "platform_account_id"],
    ["workboard_snoozes", "platform_account_id"],
    ["transactions", "platform_account_id"],
    ["revenue_daily", "platform_account_id"],
    ["projection_seq_watermarks", "account_id"],
    ["domain_event_seq", "account_id"],
    // Decision #118: erasure is the one-way door for the page's secrets too.
    // Soft delete (#72) deliberately keeps these for undelete; without them
    // here a tombstoned page's encrypted credentials were unpurgeable by ANY
    // path (all other credential readers/deleters are active-gated).
    ["page_credentials", "platform_account_id"],
    ["egress_endpoints", "platform_account_id"],
  ];

  // page_dm_messages counted separately (cascade of page_dm_threads).
  targets.push({
    plane: "hot",
    target: "page_dm_messages",
    action: "cascade",
    rows: await countOf(app, sql`
      select count(*)::text as n from page_dm_messages
      where platform_account_id in ${pageIds}`),
  });

  for (const [table, column] of deletions) {
    const target = simple(table, column);
    target.rows = await countOf(app, sql`
      select count(*)::text as n from ${sql.raw(`"${table}"`)}
      where ${sql.raw(`"${column}"`)} in ${pageIds}`);
    targets.push(target);
  }

  targets.push({
    plane: "hot",
    target: "fans (orphaned)",
    action: "delete",
    rows: linkedFanIds.length === 0
      ? 0
      : await countOf(app, sql`select count(*)::text as n from fans where ${orphanPred}`),
    run: async (tx) => {
      if (linkedFanIds.length === 0) {
        return 0;
      }
      // fan_earnings_stats RESTRICTs fans; rows on these pages are already
      // gone by this point in the target order, elsewhere-rows keep the fan.
      return execCount(tx, sql`delete from fans where ${orphanPred}`);
    },
  });

  return targets;
}

// ---------------------------------------------------------------------------
// Ledger targets (hot partitions via the parent + parked partitions)

async function ledgerTargets(
  app: Db,
  scope: ResolvedScope,
  lineage: LedgerLineage | null,
): Promise<WorkTarget[]> {
  const targets: WorkTarget[] = [];
  const parked = await listParkedTables(app);

  const eventSources = [
    { name: "domain_events", from: "domain_events" },
    ...parked.domainEvents.map((table) => ({
      name: `tiered_pending_drop.${table}`,
      from: `tiered_pending_drop."${table}"`,
    })),
  ];
  const obsSources = [
    { name: "observations", from: "observations" },
    ...parked.observations.map((table) => ({
      name: `tiered_pending_drop.${table}`,
      from: `tiered_pending_drop."${table}"`,
    })),
  ];

  // Companion key tables are unpartitioned and never tier — their rows for
  // erased events/observations go by id, whatever plane the row lived in.
  const eventIds = lineage?.eventIds ?? null;
  targets.push({
    plane: "ledger",
    target: "domain_event_keys",
    action: "delete",
    rows: eventIds
      ? (eventIds.length === 0 ? 0 : await countOf(app, sql`
          select count(*)::text as n from domain_event_keys
          where event_id in ${eventIds}`))
      : await countOf(app, sql`
          select count(*)::text as n from domain_event_keys
          where account_id in ${scope.pageIds}`),
    run: (tx) => eventIds
      ? (eventIds.length === 0 ? Promise.resolve(0) : execCount(tx, sql`
          delete from domain_event_keys where event_id in ${eventIds}`))
      : execCount(tx, sql`
          delete from domain_event_keys where account_id in ${scope.pageIds}`),
  });

  for (const source of eventSources) {
    targets.push({
      plane: "ledger",
      target: source.name,
      action: "delete",
      rows: await countOf(app, sql`
        select count(*)::text as n from ${sql.raw(source.from)} where ${eventPredSql(scope)}`),
      run: (tx) => execCount(tx, sql`
        delete from ${sql.raw(source.from)} where ${eventPredSql(scope)}`),
    });
  }

  const obsPred = lineage
    ? (lineage.eraseObsIds.length === 0
      ? null
      : sql`id in ${lineage.eraseObsIds}`)
    : observationPagePredSql(scope);

  targets.push({
    plane: "ledger",
    target: "observation_keys",
    action: "delete",
    rows: lineage
      ? (lineage.eraseObsIds.length === 0 ? 0 : await countOf(app, sql`
          select count(*)::text as n from observation_keys
          where observation_id in ${lineage.eraseObsIds}`))
      : await countOf(app, sql`
          select count(*)::text as n from observation_keys k
          where exists (select 1 from observations o
                        where o.id = k.observation_id and ${observationPagePredSql(scope)})`),
    run: (tx) => lineage
      ? (lineage.eraseObsIds.length === 0 ? Promise.resolve(0) : execCount(tx, sql`
          delete from observation_keys where observation_id in ${lineage.eraseObsIds}`))
      : execCount(tx, sql`
          delete from observation_keys k
          using observations o
          where o.id = k.observation_id and ${observationPagePredSql(scope)}`),
  });

  for (const source of obsSources) {
    targets.push({
      plane: "ledger",
      target: source.name,
      action: "delete",
      rows: obsPred === null ? 0 : await countOf(app, sql`
        select count(*)::text as n from ${sql.raw(source.from)} where ${obsPred}`),
      run: (tx) => obsPred === null ? Promise.resolve(0) : execCount(tx, sql`
        delete from ${sql.raw(source.from)} where ${obsPred}`),
    });
  }

  return targets;
}

// ---------------------------------------------------------------------------
// Lake rewrite

interface LakeTarget extends ErasureTarget {
  file: LakeManifestFile;
  parquet: string;
  restricted: boolean;
  pred: string;
}

async function lakeTargets(
  app: Db,
  scope: ResolvedScope,
  lakeFiles: LakeManifestFile[],
  lineage: LedgerLineage | null,
): Promise<LakeTarget[]> {
  const targets: LakeTarget[] = [];
  if (lakeFiles.length === 0) {
    return targets;
  }
  await withDuckDb(async (run) => {
    for (const file of lakeFiles) {
      const pred = file.table === "domain_events"
        ? duckdbEventPred(scope)
        : duckdbObservationPred(scope, lineage?.eraseObsIds ?? []);
      const parquets: Array<{ path: string; restricted: boolean }> = [
        { path: file.parquetPath, restricted: false },
      ];
      if (file.manifest.restrictedRowCount > 0) {
        parquets.push({ path: file.restrictedParquetPath, restricted: true });
      }
      for (const parquet of parquets) {
        const counted = await run(
          `SELECT count(*)::bigint AS n FROM read_parquet('${duckdbEscape(parquet.path)}') WHERE ${pred}`,
        );
        const matching = Number(counted[0]?.n ?? 0);
        if (matching === 0) {
          continue;
        }
        targets.push({
          plane: "lake",
          target: parquet.restricted
            ? `restricted/${file.table}/${path.basename(path.dirname(parquet.path))}/${path.basename(parquet.path)}`
            : file.relPath + ".parquet",
          action: "rewrite",
          rows: matching,
          file,
          parquet: parquet.path,
          restricted: parquet.restricted,
          pred,
        });
      }
    }
  });
  return targets;
}

/** Filter-out rewrite: keep everything NOT matching, refresh the manifest
 * (counts, checksums, id bounds) and append an erasure record to it. */
async function rewriteLakeTarget(scopeRef: string, target: LakeTarget): Promise<number> {
  let removed = 0;
  await withDuckDb(async (run) => {
    const source = duckdbEscape(target.parquet);
    const tmp = `${target.parquet}.erasure.tmp`;
    const before = Number(
      (await run(`SELECT count(*)::bigint AS n FROM read_parquet('${source}')`))[0]?.n ?? 0,
    );
    await run(
      `COPY (SELECT * FROM read_parquet('${source}') WHERE NOT (${target.pred})) `
      + `TO '${duckdbEscape(tmp)}' (FORMAT parquet)`,
    );
    const after = Number(
      (await run(`SELECT count(*)::bigint AS n FROM read_parquet('${duckdbEscape(tmp)}')`))[0]?.n ?? 0,
    );
    removed = before - after;
    await rename(tmp, target.parquet);

    const manifest = JSON.parse(await readFile(target.file.manifestPath, "utf8")) as TieringManifest;
    if (target.restricted) {
      manifest.restrictedRowCount = after;
      manifest.restrictedSha256 = await sha256File(target.parquet);
    } else {
      manifest.rowCount = after;
      manifest.sha256 = await sha256File(target.parquet);
    }
    const boundsSources = [`read_parquet('${duckdbEscape(target.file.parquetPath)}')`];
    if (manifest.restrictedRowCount > 0) {
      boundsSources.push(`read_parquet('${duckdbEscape(target.file.restrictedParquetPath)}')`);
    }
    const bounds = await run(
      `SELECT min(id)::bigint AS lo, max(id)::bigint AS hi FROM (`
      + boundsSources.map((from) => `SELECT id FROM ${from}`).join(" UNION ALL ")
      + `)`,
    );
    manifest.minId = bounds[0]?.lo === null || bounds[0]?.lo === undefined ? null : Number(bounds[0].lo);
    manifest.maxId = bounds[0]?.hi === null || bounds[0]?.hi === undefined ? null : Number(bounds[0].hi);
    manifest.erasures = [
      ...(manifest.erasures ?? []),
      { scopeRef, removedRows: removed, at: new Date().toISOString() },
    ];
    await writeFile(target.file.manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  });
  return removed;
}

// ---------------------------------------------------------------------------
// Plan & execute

interface ErasureWork {
  scope: ResolvedScope;
  hot: WorkTarget[];
  ledger: WorkTarget[];
  lake: LakeTarget[];
  lineage: LedgerLineage | null;
}

async function buildWork(app: Db, input: ErasureScopeInput): Promise<ErasureWork> {
  const scope = await resolveScope(app, input);
  const lakeFiles = await listLakeManifests(app);
  const lineage = scope.input.scopeType === "fan"
    ? await collectFanLineage(app, scope, lakeFiles)
    : null;
  const hot = scope.input.scopeType === "fan"
    ? await fanHotTargets(app, scope, lineage!)
    : await pageHotTargets(app, scope);
  return {
    scope,
    hot,
    ledger: await ledgerTargets(app, scope, lineage),
    lake: await lakeTargets(app, scope, lakeFiles, lineage),
    lineage,
  };
}

function workToPlan(work: ErasureWork): ErasurePlan {
  const targets = [...work.hot, ...work.ledger, ...work.lake]
    .map(({ plane, target, action, rows: rowCount }) => ({ plane, target, action, rows: rowCount }));
  return {
    scopeType: work.scope.input.scopeType,
    scopeRef: work.scope.scopeRef,
    targets,
    sharedObservations: work.lineage?.sharedObsIds.length ?? 0,
    totalRows: targets.reduce((sum, target) => sum + target.rows, 0),
    resolvedPageIds: work.scope.pageIds,
  };
}

/** Dry run — read-only; the CLI records the tombstone and audit. */
export async function planErasure(app: Db, input: ErasureScopeInput): Promise<ErasurePlan> {
  return workToPlan(await buildWork(app, input));
}

export interface ErasureExecutionResult {
  plan: ErasurePlan;
  executedCounts: Record<string, number>;
  logId: number;
}

/**
 * The irreversible act. Hot + ledger deletes run in ONE transaction; the
 * lake rewrite follows after commit (filesystem work can't join it). The
 * tombstone is written BEFORE any deletion and completed with the actual
 * counts after — an executed erasure_log row with completed_at NULL is a
 * mid-flight death and must be re-run to convergence (all steps idempotent).
 */
export async function executeErasure(
  app: Db,
  input: ErasureScopeInput,
  options: { initiatedBy: number; auditSource?: string },
): Promise<ErasureExecutionResult> {
  const { insertErasureLog, completeErasureLog, acquireErasureFenceExclusiveLocks } =
    await import("@agency_hub_core/db");
  const work = await buildWork(app, input);
  const plan = workToPlan(work);

  // The tombstone (with the resolved page ids in its plan) commits BEFORE
  // the delete transaction: writers that lose the lock race below re-check
  // the fence after we release and see this row.
  const logRow = await insertErasureLog(app.db, {
    scopeType: input.scopeType,
    scopeRef: plan.scopeRef,
    initiatedBy: options.initiatedBy,
    dryRun: false,
    plan: plan as unknown as Record<string, unknown>,
  });

  const executedCounts: Record<string, number> = {};
  const record = (target: ErasureTarget, count: number) => {
    const key = `${target.plane}:${target.target}:${target.action}`;
    executedCounts[key] = (executedCounts[key] ?? 0) + count;
  };

  await app.db.transaction(async (tx) => {
    // PR4 non-resurrection fence: exclusive advisory locks over every
    // resolved page id, sorted, BEFORE any deletion — in-flight archive/
    // projection writers finish first; later writers fail their shared
    // try-lock and defer, then re-check the fence post-commit. WAIVER
    // (owner-acknowledged): the subscription/presence/spend projections
    // replay the same retained journal but are OUT of the Wave-1 fence
    // scope — they rebuild aggregate/status rows, not fan transcripts.
    await acquireErasureFenceExclusiveLocks(tx as unknown as Db["db"], work.scope.pageIds);
    for (const target of [...work.hot, ...work.ledger]) {
      if (target.run) {
        record(target, await target.run(tx as unknown as Db["db"]));
      } else {
        record(target, target.rows); // cascades ride their parent delete
      }
    }
  });

  for (const target of work.lake) {
    record(target, await rewriteLakeTarget(plan.scopeRef, target));
  }

  await completeErasureLog(app.db, {
    id: logRow.id,
    executedCounts: {
      ...executedCounts,
      sharedObservationsKept: plan.sharedObservations,
    },
  });

  // Stage 7 dual-write choke point: audit_events + an operator observation.
  // The observation's account_id is NULL by design — the erasure's own audit
  // trail must be structurally unreachable by a later re-run of itself.
  await recordAudit(app, {
    source: options.auditSource ?? "cli",
    actorUserId: options.initiatedBy,
    eventType: "erasure.executed",
    metadata: {
      scopeRef: plan.scopeRef,
      logId: logRow.id,
      totalRows: plan.totalRows,
      sharedObservationsKept: plan.sharedObservations,
    },
  });

  app.logger.info(
    { scopeRef: plan.scopeRef, totalRows: plan.totalRows, logId: logRow.id },
    "Erasure executed",
  );
  return { plan, executedCounts, logId: logRow.id };
}
