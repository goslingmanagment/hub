import { createHash } from "node:crypto";
import { readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { sql, type SQL } from "drizzle-orm";

import {
  type CapturePayloadErasureSubject,
  capturePayloadErasureSubject,
} from "@agency_hub_core/db";

import type { AppContext } from "../../bootstrap.ts";
import { recordAudit } from "../auth.ts";
import type { TieringManifest } from "../tiering/index.ts";
import {
  type CapturePayloadCatalogWork,
  buildCapturePayloadCatalogWork,
  capturePayloadCatalogJournal,
  sweepCapturePayloadCatalog,
} from "./capture-catalog.ts";

// Kernel Stage 28 Task 4 — the audited break-glass erasure (DP 7-A: business
// facts are forever; "delete" is a governed procedure). Owner-initiated,
// scoped (fan / page / model), dry-run by default. Execution reaches ALL
// history planes: hot tables, attached ledger partitions, detached-but-parked
// partitions in tiered_pending_drop and capture_pending_drop (a parent-table
// DELETE never reaches those), and the Parquet lake (filter-out rewrite + manifest checksum
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
// - G5 slice 3b: execution reaches the CONTENT-ADDRESSED CATALOG too, in the
//   same run. A capture body now lives twice — inline (still the authority)
//   and once in capture_payload_objects — and slice 3c is about to remove the
//   inline copy, so the catalog needs its own governed act first. The catalog
//   plane INHERITS this module's verdicts instead of forming its own: a body
//   whose every envelope this erasure deleted dies with them (the one
//   sanctioned deleter of a capture body); a body a SURVIVING envelope still
//   references is a bystander's fact — kept, counted, reported, and never
//   rewritten, for the same reason a shared observation is never deleted. See
//   services/erasure/capture-catalog.ts for the full argument.

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
  plane: "hot" | "ledger" | "lake" | "catalog";
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
  /** Fan scope only: Fansly messaging group ids resolved before any thread
   * deletion. Projection writers may carry only this group id. */
  resolvedFanGroupIds: string[];
}

interface ResolvedScope {
  input: ErasureScopeInput;
  scopeRef: string;
  pageIds: number[];
  /** fan scope only */
  fanId: number | null;
  fanRef: string | null;
  /** Fansly messaging group ids linked to the fan. Creator-sent message
   * events use this id as conversation_ref, not the partner account id. */
  fanGroupIds: string[];
  /** page/model scope: the pages' vendor-native account refs */
  nativeRefs: string[];
  ofapiExclusiveObservationIds?: number[];
  ofapiExclusiveReceiptIds?: number[];
  ofapiSharedObservations?: number;
}

type Db = Pick<AppContext, "db" | "config" | "logger" | "pool">;

const ERASURE_EXECUTION_LOCK_KEY = 8_154_030_001;

/** Catalog matches translated back into referencing observations per statement.
 *  Bounded so one erasure cannot build a single query with an unbounded VALUES
 *  list. */
const CATALOG_LINEAGE_BATCH = 500;

/** The catalog plane's single plan/executed-count key. */
const CATALOG_TARGET = {
  plane: "catalog",
  target: "capture_payload_objects",
  action: "delete",
} as const;

/**
 * Erasures are rare break-glass operations and every scope can touch the same
 * parquet file/temp path. One global session lock spans database transactions
 * and post-commit lake rewrites, preventing cross-scope filesystem races.
 */
export async function withErasureExecutionLock<T>(
  app: Pick<AppContext, "pool">,
  run: () => Promise<T>,
): Promise<T> {
  const client = await app.pool.connect();
  let destroyClient = false;
  try {
    try {
      await client.query(
        "select pg_advisory_lock($1::bigint)",
        [ERASURE_EXECUTION_LOCK_KEY],
      );
    } catch (error) {
      // The server may have acquired the session lock before the response was
      // lost. Never return an ambiguously locked connection to the pool.
      destroyClient = true;
      throw error;
    }

    let outcome: { ok: true; value: T } | { ok: false; error: unknown };
    try {
      outcome = { ok: true, value: await run() };
    } catch (error) {
      outcome = { ok: false, error };
    }

    let unlocked = false;
    let unlockFailed = false;
    let unlockError: unknown;
    try {
      const unlockResult = await client.query<{ unlocked: boolean }>(
        "select pg_advisory_unlock($1::bigint) as unlocked",
        [ERASURE_EXECUTION_LOCK_KEY],
      );
      unlocked = unlockResult.rows[0]?.unlocked === true;
    } catch (error) {
      unlockFailed = true;
      unlockError = error;
      // A session-level advisory lock survives a normal pool release. If the
      // explicit unlock failed, destroy this connection so PostgreSQL closes
      // the session and releases every lock it may still carry.
      destroyClient = true;
    }
    if (!unlockFailed && !unlocked) {
      destroyClient = true;
    }

    // Preserve the execution failure if both work and unlock fail; closing the
    // dedicated session below still releases every session advisory lock.
    if (!outcome.ok) {
      throw outcome.error;
    }
    if (unlockFailed) {
      throw unlockError;
    }
    if (!unlocked) {
      throw new Error("Global erasure execution lock was not held");
    }
    return outcome.value;
  } finally {
    client.release(destroyClient ? true : undefined);
  }
}

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
    const pageIds = pageRows.map((row) => Number(row.id));
    const fanId = fanRows[0] ? Number(fanRows[0].id) : null;
    const fanGroupRows = await rows<{ group_id: string }>(app, sql`
      select distinct platform_conversation_id as group_id
      from page_dm_threads
      where platform_account_id in ${pageIds}
        and (
          partner_platform_user_id = ${input.fanRef}
          or platform_conversation_id = ${input.fanRef}
          ${fanId === null ? sql`` : sql`or fan_id = ${fanId}`}
        )
    `);
    return {
      input,
      scopeRef,
      pageIds,
      fanId,
      fanRef: input.fanRef,
      fanGroupIds: fanGroupRows
        .map((row) => row.group_id)
        .filter((id): id is string => !!id && id !== input.fanRef),
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
    fanGroupIds: [],
    nativeRefs: [...new Set([
      ...pageRows.flatMap((row) => [row.a, row.b]).filter((ref): ref is string => !!ref),
      ...(await rows<{ account_id: string }>(app, sql`
        select account_id from ofapi_account_bindings where page_id in ${pageRows.map(row => Number(row.id))}
      `)).map(row => row.account_id),
    ])],
  };
}

// ---------------------------------------------------------------------------
// Ledger predicates (hot partitions, parked partitions, and — translated to
// DuckDB SQL — the lake files all use the same shapes)

function eventPredSql(scope: ResolvedScope, alias = ""): SQL {
  const a = alias ? sql.raw(`${alias}.`) : sql.raw("");
  if (scope.input.scopeType === "fan") {
    const conversationPred = scope.fanGroupIds.length > 0
      ? sql`(${a}conversation_ref = ${scope.fanRef} or ${a}conversation_ref in ${scope.fanGroupIds})`
      : sql`${a}conversation_ref = ${scope.fanRef}`;
    return sql`${a}account_id in ${scope.pageIds}
      and (
        ${a}fan_identity_ref = ${scope.fanRef}
        or ${conversationPred}
        or ${a}data ->> 'authorRef' = ${scope.fanRef}
        or ${a}data ->> 'correlationGroupRef' = ${scope.fanRef}
        or (${a}type = 'notification.observed'
          and ${a}data ->> 'rawTypeCode' = '3002'
          and ${a}data ->> 'correlationRef' = ${scope.fanRef})
        or coalesce(${a}data -> 'buyerRefs', '[]'::jsonb) @> jsonb_build_array(${scope.fanRef}::text)
      )`;
  }
  return sql`${a}account_id in ${scope.pageIds}`;
}

function observationPagePredSql(scope: ResolvedScope): SQL {
  const extra = scope.ofapiExclusiveObservationIds?.length
    ? sql`or id in ${scope.ofapiExclusiveObservationIds}` : sql``;
  if (scope.nativeRefs.length > 0) {
    return sql`(account_id in ${scope.pageIds}
      or native_account_ref in ${scope.nativeRefs} ${extra})`;
  }
  return sql`account_id in ${scope.pageIds}`;
}

// CAS-READ-BACKLOG(§6.4): the LAST site still reading the inline body in SQL
// after G5 slice 3a took the field extractions to typed columns. This one is
// not a field — it matches the WHOLE body as text to find a subject, so there
// is nothing to project into a column.
//
// G5 slice 3b answered the catalog half of it. The literals below now come from
// `capturePayloadErasureSubject`, the SAME function the catalog scan
// (repositories/capture-payload-erasure.ts) builds its predicate from, so the
// two planes cannot disagree about what "this body contains the subject" means.
// The inline arm stays here because the inline column is still the authority;
// the arm that reads catalog bodies lives in `collectFanLineage` below, where a
// catalog match is translated back into the envelopes that reference it.
function payloadMatchPredSql(
  fanRef: string,
  payloadColumn: SQL = sql.raw("payload"),
): SQL {
  const subject = capturePayloadErasureSubject(fanRef);
  const quoted = sql`${payloadColumn}::text like ${subject.quotedLike}`;
  if (subject.numericBoundaryRegex !== null) {
    return sql`(${quoted} or ${payloadColumn}::text ~ ${subject.numericBoundaryRegex})`;
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
    const conversations = [scope.fanRef!, ...scope.fanGroupIds]
      .map((value) => `'${duckdbEscape(value)}'`)
      .join(", ");
    const jsonRef = duckdbEscape(JSON.stringify(scope.fanRef!));
    return `account_id IN (${ids}) AND (`
      + `fan_identity_ref = '${ref}' OR conversation_ref IN (${conversations}) `
      + `OR coalesce(json_extract_string(data, '$.authorRef') = '${ref}', false) `
      + `OR coalesce(json_extract_string(data, '$.correlationGroupRef') = '${ref}', false) `
      + `OR coalesce((type = 'notification.observed' `
      + `AND json_extract_string(data, '$.rawTypeCode') = '3002' `
      + `AND json_extract_string(data, '$.correlationRef') = '${ref}'), false) `
      + `OR coalesce(json_contains(json_extract(data, '$.buyerRefs'), '${jsonRef}'), false))`;
  }
  return `account_id IN (${ids})`;
}

function duckdbObservationPred(scope: ResolvedScope, eraseObsIds: number[]): string {
  if (scope.input.scopeType !== "fan") {
    const ids = scope.pageIds.join(", ") || "-1";
    const refs = scope.nativeRefs.map((ref) => `'${duckdbEscape(ref)}'`).join(", ");
    return refs.length > 0
      ? `(account_id IN (${ids}) OR native_account_ref IN (${refs})${scope.ofapiExclusiveObservationIds?.length ? ` OR id IN (${scope.ofapiExclusiveObservationIds.join(",")})` : ""})`
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
// Parked partitions — a DELETE on the partitioned parent never reaches
// detached tables, so they are separate targets.
//
// TWO SCHEMAS, TWO MEANINGS, ONE OBLIGATION.
//   tiered_pending_drop  Stage 28: this month's rows left the hot table and the
//                        lake has them.
//   capture_pending_drop G5 slice 3c-2: this partition was SUPERSEDED by a
//                        skinny twin that is attached under its old name. Its
//                        rows are also live over there — but until the owner
//                        drops it, this copy still physically holds every body
//                        the swap left behind, an erased fan's included.
//
// The meanings differ; the erasure's duty does not. A subject that must be
// unreachable has to be unreachable in both, so both are scanned. Missing the
// second one would leave a window — between a swap and its owner-gated drop —
// in which an executed erasure quietly under-erased.

/** Fully qualified, quoted references — the caller must never re-derive the
 *  schema, because there is now more than one it could get wrong. */
async function listParkedTables(app: Db): Promise<{ observations: string[]; domainEvents: string[] }> {
  const parked = await rows<{ nspname: string; relname: string }>(app, sql`
    select n.nspname, c.relname from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('tiered_pending_drop', 'capture_pending_drop') and c.relkind = 'r'
    order by n.nspname, c.relname
  `);
  const qualified = parked.map((row) => ({
    prefix: row.relname,
    ref: `${row.nspname}."${row.relname}"`,
  }));
  return {
    observations: qualified.filter((row) => row.prefix.startsWith("observations_")).map((row) => row.ref),
    domainEvents: qualified.filter((row) => row.prefix.startsWith("domain_events_")).map((row) => row.ref),
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
  /** Retained sync journal envelopes whose body contains the fan. */
  rawPayloadIds: number[];
}

async function collectFanLineage(
  app: Db,
  scope: ResolvedScope,
  lakeFiles: LakeManifestFile[],
  catalog: CapturePayloadCatalogWork,
): Promise<LedgerLineage> {
  const parked = await listParkedTables(app);
  const eventIds = new Set<number>();
  const candidates = new Set<number>();
  const shared = new Set<number>();
  const rawPayloadIds = new Set<number>();

  const eventSources = ["domain_events", ...parked.domainEvents];
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
  const obsSources = ["observations", ...parked.observations];
  for (const source of obsSources) {
    const matched = await rows<{ id: string }>(app, sql`
      select id::text as id from ${sql.raw(source)}
      where account_id in ${scope.pageIds} and ${payloadMatchPredSql(scope.fanRef!)}
    `);
    for (const row of matched) {
      candidates.add(Number(row.id));
    }
  }

  const inlineRaw = await rows<{ id: string }>(app, sql`
    select id::text as id from sync_raw_payloads
    where page_id in ${scope.pageIds}
      and response_payload is not null
      and ${payloadMatchPredSql(scope.fanRef!, sql.raw("response_payload"))}
  `);
  for (const row of inlineRaw) {
    rawPayloadIds.add(Number(row.id));
  }

  // G5 slice 3b: the CATALOG arm of the same subject match. An observation
  // whose catalog body carries the fan ref is fan material even if its inline
  // column does not say so. Today the two copies are identical by construction,
  // so this arm finds exactly what the inline arm above already found — and
  // that is the point of landing it now: after slice 3c nulls the inline
  // column it becomes the ONLY arm that can find these rows, and the erasure
  // will not have to change on the day the heap is rewritten. Scoped to
  // `account_id in pageIds` like the inline arm, so the two planes reach the
  // same envelopes and neither can quietly out-erase the other.
  for (let offset = 0; offset < catalog.matches.length; offset += CATALOG_LINEAGE_BATCH) {
    const batch = catalog.matches.slice(offset, offset + CATALOG_LINEAGE_BATCH);
    const refs = sql.join(
      batch.map((match, index) =>
        index === 0
          ? sql`(${match.bucketMonth}::date, ${match.objectId}::bigint)`
          : sql`(${match.bucketMonth}, ${match.objectId})`
      ),
      sql`, `,
    );
    const referencing = await rows<{ id: string }>(app, sql`
      with target (bucket_month, object_id) as (values ${refs})
      select distinct o.id::text as id
      from target t
      join observations o
        on o.payload_bucket_month = t.bucket_month
       and o.payload_object_id = t.object_id
      where o.account_id in ${scope.pageIds}
    `);
    for (const row of referencing) {
      candidates.add(Number(row.id));
    }
    const rawReferencing = await rows<{ id: string }>(app, sql`
      with target (bucket_month, object_id) as (values ${refs})
      select distinct r.id::text as id
      from target t
      join sync_raw_payloads r
        on r.payload_bucket_month = t.bucket_month
       and r.payload_object_id = t.object_id
      where r.page_id in ${scope.pageIds}
    `);
    for (const row of rawReferencing) {
      rawPayloadIds.add(Number(row.id));
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
    rawPayloadIds: [...rawPayloadIds],
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

/** How the fan-scope plan reaches a fan-ref column's row. */
export type FanRefErasureReach =
  /** A predicate in `fanHotTargets` matches THIS column by name. */
  | "predicate"
  /** No predicate names the column; the row dies with its parent through an
   *  ON DELETE CASCADE the plan counts as its own target. */
  | "cascade";

export interface FanRefErasureColumn {
  /** `table.column`, exactly as `information_schema.columns` reports it. */
  column: string;
  /** The `ErasureTarget.target` in the FAN-scope plan that reaches it. */
  target: string;
  reach: FanRefErasureReach;
}

/**
 * §9.3 — the COLUMN-level census of fan references the fan-scope plan reaches.
 *
 * Erasure targets carry only a table name, so a table-scoped ratchet answers
 * the wrong question: `media_orders` being in the plan says nothing about
 * whether a NEW fan-ref column on `media_orders` is in any predicate. Under-
 * erasure is silent by nature — the run reports success and the fan's rows
 * stay — so the claim has to be made per column, where a reviewer can check it
 * against the predicates a few dozen lines below.
 *
 * Every entry is a promise a reader can verify by opening `fanHotTargets`.
 * `tests/erasure-fan-ref-columns.integration.test.ts` discovers the real
 * columns from `information_schema` and requires each one to appear here (with
 * a target the plan actually emits) or in that test's justified-exception list.
 */
export const FAN_REF_ERASURE_COLUMNS: readonly FanRefErasureColumn[] = [
  // dmArchivePred: `fan_platform_user_id = ref or platform_conversation_id = ref
  // or sender_platform_user_id = ref`.
  { column: "dm_message_archive.fan_platform_user_id", target: "dm_message_archive", reach: "predicate" },
  { column: "dm_message_archive.sender_platform_user_id", target: "dm_message_archive", reach: "predicate" },
  // tipContextPred: `sender_platform_user_id = ref or receiver… or conversation…`.
  {
    column: "transaction_tip_contexts.sender_platform_user_id",
    target: "transaction_tip_contexts",
    reach: "predicate",
  },
  // creatorPostTipPred — the precedent this whole ratchet exists for: it had to
  // be hand-added, and nothing would have noticed its absence.
  {
    column: "creator_post_tips.tip_sender_platform_user_id",
    target: "creator_post_tips",
    reach: "predicate",
  },
  // WP-F0(b) media plane (0130). Both are TEXT refs with no FK to `fans`.
  { column: "media_orders.buyer_platform_user_id", target: "media_orders", reach: "predicate" },
  {
    column: "message_media_offers.fan_platform_user_id",
    target: "message_media_offers",
    reach: "predicate",
  },
  // No predicate names this column, and none should: a DM message is reachable
  // only through its thread, and `page_dm_messages.conversation_id` FKs
  // `page_dm_threads` ON DELETE CASCADE. The plan carries `page_dm_messages` as
  // an explicit `action: "cascade"` target with its own row count, so the rows
  // are erased and reported — just not by a predicate on this column.
  { column: "page_dm_messages.sender_platform_user_id", target: "page_dm_messages", reach: "cascade" },
  // WP-F2 engagement core (0134). Both are TEXT refs with no FK to `fans`.
  //
  // Captured Fansly purchase/follow/subscription rows name the fan in
  // correlation_group_ref; correlation_ref names the purchased media/bundle
  // or another creator-owned subject. Code 3002 is the documented exception:
  // its follower id uses correlation_ref.
  {
    column: "platform_notifications.correlation_ref",
    target: "platform_notifications",
    reach: "predicate",
  },
  {
    column: "platform_notifications.correlation_group_ref",
    target: "platform_notifications",
    reach: "predicate",
  },
  // `post_likes.liker_platform_user_id` IS the fan, always. The table is EMPTY
  // on Fansly today ([E4]) and the OF webhook is its only writer — which is
  // exactly why it is declared now: a table that arrives empty arrives without
  // its erasure predicate tested, and by the time it fills nobody remembers.
  {
    column: "post_likes.liker_platform_user_id",
    target: "post_likes",
    reach: "predicate",
  },
  // WP-F5 comment archive (0138). A TEXT ref with no FK to `fans`, like every
  // other entry on this list, and the one that carries the fan's own WORDS: a
  // comment row holds `text_plain` verbatim, so an under-erasure here leaves
  // the fan quoted on the page after they asked to be forgotten. The predicate
  // is exact — `author_ref` IS the fan on every row, with none of
  // `platform_notifications.correlation_ref`'s ambiguity, because a comment
  // always has exactly one author and it is never the creator's own content.
  {
    column: "post_comments.author_ref",
    target: "post_comments",
    reach: "predicate",
  },
];

async function fanHotTargets(app: Db, scope: ResolvedScope, _lineage: LedgerLineage): Promise<WorkTarget[]> {
  const ref = scope.fanRef!;
  const fanId = scope.fanId ?? -1;
  const targets: WorkTarget[] = [];

  targets.push({
    plane: "hot",
    target: "sync_raw_payloads",
    action: "delete",
    rows: _lineage.rawPayloadIds.length,
    run: (tx) => _lineage.rawPayloadIds.length === 0
      ? Promise.resolve(0)
      : execCount(tx, sql`delete from sync_raw_payloads where id in ${_lineage.rawPayloadIds}`),
  });

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

  // Resolved before ledger lineage is collected: creator-sent events use the
  // messaging group id as conversation_ref and must be deleted with this fan.
  const fanGroupIds = scope.fanGroupIds;

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

  // Exact Fansly tip notes are sensitive conversation material but carry no
  // fan FK. Reach them through the mandatory sender ref and the resolved
  // groupId linkage; receiver/conversation direct matches cover asymmetric
  // provider shapes without broadening to every tip on the page.
  const tipContextConversationPred = fanGroupIds.length > 0
    ? sql`(captured_conversation_ref = ${ref}
        or captured_conversation_ref in ${fanGroupIds})`
    : sql`captured_conversation_ref = ${ref}`;
  const tipContextPred = sql`account_id in ${scope.pageIds}
    and (
      sender_platform_user_id = ${ref}
      or receiver_platform_user_id = ${ref}
      or ${tipContextConversationPred}
    )`;
  targets.push({
    plane: "hot",
    target: "transaction_tip_contexts",
    action: "delete",
    rows: await countOf(app, sql`
      select count(*)::text as n from transaction_tip_contexts where ${tipContextPred}`),
    run: (tx) => execCount(tx, sql`
      delete from transaction_tip_contexts where ${tipContextPred}`),
  });

  // Fansly post-tip attribution carries the fan's native id and verbatim note
  // without a fan FK. The canonical event pins sender identity, so the same
  // immutable fan ref is the narrow deletion boundary; co-resident tips stay.
  const creatorPostTipPred = sql`account_id in ${scope.pageIds}
    and tip_sender_platform_user_id = ${ref}`;
  targets.push({
    plane: "hot",
    target: "creator_post_tips",
    action: "delete",
    rows: await countOf(app, sql`
      select count(*)::text as n from creator_post_tips where ${creatorPostTipPred}`),
    run: (tx) => execCount(tx, sql`
      delete from creator_post_tips where ${creatorPostTipPred}`),
  });

  // WP-F0(b) media plane (0130). Both tables carry a TEXT fan ref with NO FK to
  // `fans`, so the unmapped-non-cascade-FK guard above is structurally blind to
  // them — exactly the gap `tip_sender_platform_user_id` had to be hand-added
  // for. `tests/erasure-fan-ref-columns.integration.test.ts` is the ratchet that
  // makes the next such column fail CI instead of under-erasing silently.
  //
  // media_orders says WHO bought WHAT for HOW MUCH; the buyer ref is the fan.
  const mediaOrderPred = sql`page_id in ${scope.pageIds}
    and buyer_platform_user_id = ${ref}`;
  targets.push({
    plane: "hot",
    target: "media_orders",
    action: "delete",
    rows: await countOf(app, sql`
      select count(*)::text as n from media_orders where ${mediaOrderPred}`),
    run: (tx) => execCount(tx, sql`delete from media_orders where ${mediaOrderPred}`),
  });

  // message_media_offers says what was OFFERED in the fan's conversation. Reach
  // it by the fan ref AND by the resolved Fansly group ids, because the offer
  // row's conversation_ref is the messaging GROUP id, a different id space than
  // the partnerAccountId fanRef (recorded law A49).
  const offerConversationPred = fanGroupIds.length > 0
    ? sql`(conversation_ref = ${ref} or conversation_ref in ${fanGroupIds})`
    : sql`conversation_ref = ${ref}`;
  const mediaOfferPred = sql`page_id in ${scope.pageIds}
    and (fan_platform_user_id = ${ref} or ${offerConversationPred})`;
  targets.push({
    plane: "hot",
    target: "message_media_offers",
    action: "delete",
    rows: await countOf(app, sql`
      select count(*)::text as n from message_media_offers where ${mediaOfferPred}`),
    run: (tx) => execCount(tx, sql`delete from message_media_offers where ${mediaOfferPred}`),
  });

  // WP-F2 engagement core (0134). Same shape as the media plane above: TEXT fan
  // refs with NO FK to `fans`, invisible to the unmapped-non-cascade-FK guard.
  //
  // platform_notifications says WHAT THIS FAN DID to the page — bought,
  // followed, subscribed. Captured rows put the actor in correlation_group_ref;
  // only follow code 3002 names the actor in correlation_ref.
  const notificationPred = sql`page_id in ${scope.pageIds}
    and (correlation_group_ref = ${ref}
      or (type_code = 3002 and correlation_ref = ${ref}))`;
  targets.push({
    plane: "hot",
    target: "platform_notifications",
    action: "delete",
    rows: await countOf(app, sql`
      select count(*)::text as n from platform_notifications where ${notificationPred}`),
    run: (tx) => execCount(tx, sql`
      delete from platform_notifications where ${notificationPred}`),
  });

  // post_likes says the fan liked something. Empty on Fansly until a like code
  // is live-confirmed ([E4]); the OF webhook fills it independently, and the
  // predicate has to be right before that happens, not after.
  const postLikePred = sql`page_id in ${scope.pageIds}
    and liker_platform_user_id = ${ref}`;
  targets.push({
    plane: "hot",
    target: "post_likes",
    action: "delete",
    rows: await countOf(app, sql`
      select count(*)::text as n from post_likes where ${postLikePred}`),
    run: (tx) => execCount(tx, sql`delete from post_likes where ${postLikePred}`),
  });

  // WP-F5 comment archive (0138). The fan's own words, stored verbatim: this is
  // the fan-ref column on this list whose under-erasure is most visible, since
  // the row holds text the fan wrote. `author_ref` IS the fan on every row —
  // no code-dependent ambiguity, unlike the notification correlation ref above.
  const commentPred = sql`page_id in ${scope.pageIds}
    and author_ref = ${ref}`;
  targets.push({
    plane: "hot",
    target: "post_comments",
    action: "delete",
    rows: await countOf(app, sql`
      select count(*)::text as n from post_comments where ${commentPred}`),
    run: (tx) => execCount(tx, sql`delete from post_comments where ${commentPred}`),
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

  // Stage 29 restricted class: generations tied to the fan — by legacy
  // conversation_ref = fanId, canonical fan_ref, OR a resolved Fansly groupId
  // on pre-fix/unresolved-fan rows whose fan_ref is NULL. Acceptance rows
  // resolve through them, so they go first.
  const generationConvPred = fanGroupIds.length > 0
    ? sql`(conversation_ref = ${ref} or conversation_ref in ${fanGroupIds})`
    : sql`conversation_ref = ${ref}`;
  const generationPred = sql`page_id in ${scope.pageIds}
    and (${generationConvPred} or fan_ref = ${ref})`;
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

  // Voice-notes lane (0109): a fan's rendered audio + conversation_ref + a
  // source_generation_ref into an ai_generation_content row this same erasure
  // deletes. voice_notes has NO FK to `fans`, so the unmapped-FK guard cannot
  // flag its omission — the delete must be explicit, or a fan erasure leaves up
  // to 2 MiB of audio addressed to the erased fan behind (now dangling on a
  // deleted source_generation_ref).
  //
  // conversation_ref is the fanRef on OnlyFans, but on Fansly the extension may
  // fall back to the messaging GROUP id (item.groupId) — a DIFFERENT id space
  // than the fan's partnerAccountId fanRef (recorded law A49 / decisions.md
  // ~3570: Fansly conversationRef is the group id, the partner id travels
  // separately). Matching conversation_ref = fanRef alone leaves those
  // group-ref'd notes behind. Resolve the fan's group ids from page_dm_threads
  // (the sync table linking groupId ↔ partnerAccountId ↔ fan) via the SAME
  // linkage the thread target above uses, plus the partner-id column that
  // carries the Fansly partnerAccountId, and scope voice notes to fanRef OR
  // those group ids. The list was resolved above before the thread target can
  // delete the linkage; a live subquery here would find nothing at execution.
  const voiceNoteConvPred = fanGroupIds.length > 0
    ? sql`(conversation_ref = ${ref} or conversation_ref in ${fanGroupIds})`
    : sql`conversation_ref = ${ref}`;
  const voiceNotePred = sql`platform_account_id in ${scope.pageIds} and ${voiceNoteConvPred}`;
  targets.push({
    plane: "hot",
    target: "voice_notes",
    action: "delete",
    rows: await countOf(app, sql`select count(*)::text as n from voice_notes where ${voiceNotePred}`),
    run: (tx) => execCount(tx, sql`delete from voice_notes where ${voiceNotePred}`),
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

export interface PageErasureTableExclusion {
  table: string;
  reason: string;
}

/** Direct page children that intentionally survive a page-data erasure.
 * This is deliberately tiny: everything not named here must appear as a hot
 * target, because the page catalog row survives and no FK action will run. */
export const PAGE_ERASURE_TABLE_EXCLUSIONS: readonly PageErasureTableExclusion[] = [
  { table: "ofapi_account_bindings", reason: "Provider-to-page custody evidence, retained with the pages catalog row and operator audit. It contains creator association, not fan facts; retaining old refs keeps late replay and future erasure scoped to the original page." },
  {
    table: "audit_events",
    reason: "Agency audit evidence is an append-only governance record, not captured platform data; retaining the page id preserves who authorized and executed the erasure itself.",
  },
  {
    table: "user_page_assignments",
    reason: "User-to-page authorization is agency catalog configuration, not captured creator or fan data; offboarding access is a separate owner action.",
  },
];

async function pageHotTargets(app: Db, scope: ResolvedScope): Promise<WorkTarget[]> {
  const pageIds = scope.pageIds;
  const targets: WorkTarget[] = [];
  if (scope.nativeRefs.length) {
    // Shared response bytes remain evidence for other accounts. Per-attempt
    // summaries and their dispatch intents are independently erasable.
    const match = sql`account_refs ?| array[${sql.join(scope.nativeRefs.map(ref => sql`${ref}`), sql`, `)}]::text[]`;
    const exclusive = sql`${match} and account_refs <@ ${JSON.stringify(scope.nativeRefs)}::jsonb`;
    targets.push({ plane: "hot", target: "ofapi_webhook_redelivery_intents", action: "delete",
      rows: await countOf(app, sql`select count(*)::text n from ofapi_webhook_redelivery_intents i where exists(select 1 from ofapi_webhook_delivery_attempts a where a.webhook_id=i.webhook_id and a.attempt_id=i.attempt_id and ${exclusive})`),
      run: tx => execCount(tx, sql`delete from ofapi_webhook_redelivery_intents i where exists(select 1 from ofapi_webhook_delivery_attempts a where a.webhook_id=i.webhook_id and a.attempt_id=i.attempt_id and ${exclusive})`) });
    targets.push({ plane: "hot", target: "ofapi_webhook_delivery_attempts", action: "delete",
      rows: await countOf(app, sql`select count(*)::text n from ofapi_webhook_delivery_attempts where ${exclusive}`),
      run: tx => execCount(tx, sql`delete from ofapi_webhook_delivery_attempts where ${exclusive}`) });
  }
  if (scope.ofapiExclusiveReceiptIds?.length) targets.push({ plane: "hot", target: "ofapi_webhook_events:team_scope", action: "delete",
    rows: scope.ofapiExclusiveReceiptIds.length,
    run: tx => execCount(tx, sql`delete from ofapi_webhook_events where id in ${scope.ofapiExclusiveReceiptIds!}`) });

  // Financial response receipts follow the ledger's explicit page erasure.
  // Their attribution is nested metadata, not a page FK discovered below.
  targets.push({
    plane: "hot", target: "ofapi_credit_receipts", action: "delete",
    rows: await countOf(app, sql`
      select count(*)::text as n from ofapi_credit_receipts
      where (observation ->> 'pageId')::bigint in ${pageIds}`),
    run: tx => execCount(tx, sql`
      delete from ofapi_credit_receipts
      where (observation ->> 'pageId')::bigint in ${pageIds}`),
  });

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
    ["ofapi_collection_requests", "page_id"],
    ["ofapi_collection_jobs", "page_id"],
    ["ofapi_collection_policies", "page_id"],
    // Rows that RESTRICT parents below go first.
    ["creator_vault_album_members", "page_id"],
    ["creator_vault_album_scans", "page_id"],
    ["page_subscription_tier_plans", "page_id"],
    ["page_poll_options", "page_id"],
    ["ofapi_credit_ledger", "page_id"],
    ["ofapi_request_attempts", "page_id"],
    ["sync_http_attempts", "page_id"],
    ["sync_run_events", "page_id"],
    ["sync_raw_payloads", "page_id"],
    ["ofapi_spend_projection_events", "page_id"],

    // Endpoints-cover fact projections and capture-plane state (0130–0142).
    ["media_offer_locations", "page_id"],
    ["media_orders", "page_id"],
    ["message_media_offers", "page_id"],
    ["creator_media_bundles", "page_id"],
    ["creator_raw_media", "page_id"],
    ["creator_media", "page_id"],
    ["stats_traffic_buckets", "page_id"],
    ["stats_top_media", "page_id"],
    ["stats_top_tags", "page_id"],
    ["fansly_media_tag_stats", "page_id"],
    ["platform_tag_daily", "page_id"],
    ["platform_notifications", "page_id"],
    ["post_likes", "page_id"],
    ["post_comments", "page_id"],
    ["subject_refresh_state", "page_id"],
    ["creator_vault_albums", "page_id"],
    ["page_subscription_tiers", "page_id"],
    ["page_walls", "page_id"],
    ["page_automated_messages", "page_id"],
    ["page_promo_links", "page_id"],
    ["page_polls", "page_id"],
    ["page_broadcasts", "page_id"],
    ["page_payout_requests", "page_id"],
    ["page_payout_methods", "page_id"],
    ["page_recap_stats", "page_id"],
    ["capture_coverage", "page_id"],

    // Pre-existing projections and operational surfaces that also own page
    // data. The schema ratchet makes this list fail closed on future tables.
    ["creator_posts", "account_id"],
    ["fan_profiles", "platform_account_id"],
    ["fan_summaries", "platform_account_id"],
    ["message_archive_shadow", "account_id"],
    ["notification_incidents", "platform_account_id"],
    ["agent_hydration_requests", "page_id"],
    ["ai_usage_events", "page_id"],
    ["ofapi_budget_denial_daily", "page_id"],
    ["ofapi_capture_jobs", "page_id"],
    ["ofapi_interactive_requests", "page_id"],
    ["ofapi_message_coverage", "page_id"],
    ["ofapi_webhook_events", "platform_account_id"],
    ["page_sync_cursors", "page_id"],
    ["page_sync_states", "page_id"],
    ["projection_watermarks", "platform_account_id"],
    ["revenue_mix_daily", "page_id"],
    ["revenue_month_totals", "page_id"],
    ["sync_runs", "page_id"],
    ["wb_classifier_runs", "platform_account_id"],
    ["wb_closing_settings", "platform_account_id"],
    ["wb_llm_usage_daily", "platform_account_id"],
    ["ai_generation_content", "page_id"],
    // Voice-notes lane (0109): both are page-scoped and must be purged
    // explicitly. voice_notes REFERENCES pages WITHOUT cascade (it would block
    // a page delete; erasure keeps the pages catalog row, so we delete the
    // notes — audio bytes, user_id, conversation_ref, provider metadata — here).
    // page_voice_profiles DOES cascade on pages, but erasure preserves the pages
    // row, so the cascade never fires — it too needs an explicit delete.
    ["voice_notes", "platform_account_id"],
    ["page_voice_profiles", "platform_account_id"],
    ["wb_closing_cache", "platform_account_id"],
    ["page_dm_threads", "platform_account_id"], // messages ride the cascade
    ["message_archive", "account_id"],
    ["dm_message_archive", "platform_account_id"],
    ["transaction_tip_contexts", "account_id"],
    ["creator_post_tips", "account_id"],
    ["dm_message_daily_aggregates", "platform_account_id"],
    ["ofapi_commands", "page_id"],
    ["fan_earnings_stats", "account_id"],
    ["page_fan_identities", "platform_account_id"],
    // Link-stats lane (0111): both page-scoped, RESTRICT FKs; snapshots first
    // (they reference runs).
    ["page_link_stat_snapshots", "platform_account_id"],
    ["page_link_stat_runs", "platform_account_id"],
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

  // `listParkedTables` already returns fully qualified, quoted references; the
  // plan's display name is the same string with the quotes taken out, so a
  // tombstone still says which schema a target lived in.
  const eventSources = [
    { name: "domain_events", from: "domain_events" },
    ...parked.domainEvents.map((ref) => ({ name: ref.replaceAll('"', ""), from: ref })),
  ];
  const obsSources = [
    { name: "observations", from: "observations" },
    ...parked.observations.map((ref) => ({ name: ref.replaceAll('"', ""), from: ref })),
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
  catalog: CapturePayloadCatalogWork;
}

async function buildWork(app: Db, input: ErasureScopeInput): Promise<ErasureWork> {
  const scope = await resolveScope(app, input);
  if (scope.input.scopeType !== "fan" && scope.nativeRefs.length) {
    // Team-level receipts have no native_account_ref. Preserve their exact
    // bytes when a bystander still owns part of the envelope, and report that
    // residual under the same shared-observation rule used by fan erasure.
    const receipts = await rows<{ id: string; observation_id: string | null; refs: string[] }>(app, sql`
      select w.id::text,k.observation_id::text, w.payload->'payload'->'account_ids' as refs
      from ofapi_webhook_events w left join observation_keys k on k.source='webhook' and k.idempotency_key=w.idempotency_key
      where jsonb_typeof(w.payload->'payload'->'account_ids')='array'`);
    const exclusive = new Set<number>(); const shared = new Set<number>(); const receiptIds: number[] = [];
    for (const row of receipts) {
      if (!row.refs.some(ref => scope.nativeRefs.includes(ref))) continue;
      if (row.refs.every(ref => scope.nativeRefs.includes(ref))) {
        receiptIds.push(Number(row.id)); if (row.observation_id) exclusive.add(Number(row.observation_id));
      } else if (row.observation_id) shared.add(Number(row.observation_id));
    }
    // Every raw response, including overlapping scans, is considered. A
    // failed parser leaves unknown scope visible as a retained residual.
    const captures = await rows<{ id: string; payload: { body?: string } }>(app, sql`
      select id::text,payload from observations where producer='ofapi:admin' and kind='ofapi_webhook_deliveries'`);
    for (const capture of captures) {
      try {
        const body = JSON.parse(capture.payload.body ?? "null");
        if (!Array.isArray(body?.data)) { shared.add(Number(capture.id)); continue; }
        const refs = body.data.flatMap((attempt: { payload?: { account_id?: string; payload?: { account_ids?: string[] } } }) =>
          attempt.payload?.account_id ? [attempt.payload.account_id] : attempt.payload?.payload?.account_ids ?? []);
        const matched = refs.some((ref: string) => scope.nativeRefs.includes(ref));
        if (!matched) continue;
        const fullyScoped = body.data.every((attempt: { payload?: { account_id?: string; payload?: { account_ids?: string[] } } }) =>
          attempt.payload?.account_id || attempt.payload?.payload?.account_ids?.length);
        if (fullyScoped && refs.every((ref: string) => scope.nativeRefs.includes(ref))) exclusive.add(Number(capture.id));
        else shared.add(Number(capture.id));
      } catch { shared.add(Number(capture.id)); }
    }
    scope.ofapiExclusiveObservationIds = [...exclusive]; scope.ofapiExclusiveReceiptIds = receiptIds;
    scope.ofapiSharedObservations = shared.size;
  }
  // The catalog scan runs FIRST because the fan lineage consumes it: a body
  // that carries the subject names the envelopes that must go with it.
  const subject: CapturePayloadErasureSubject | null = scope.fanRef === null
    ? null
    : capturePayloadErasureSubject(scope.fanRef);
  const catalog = await buildCapturePayloadCatalogWork(app, {
    scopeType: scope.input.scopeType,
    pageIds: scope.pageIds,
    subject,
  });
  const lakeFiles = await listLakeManifests(app);
  const lineage = scope.input.scopeType === "fan"
    ? await collectFanLineage(app, scope, lakeFiles, catalog)
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
    catalog,
  };
}

function workToPlan(work: ErasureWork): ErasurePlan {
  // The catalog row is a plan for the objects IN SCOPE, not a promise that all
  // of them die: how many actually do depends on which envelopes survive this
  // run, which is only knowable after the delete transaction commits. The
  // executed counts report the real split (erased vs kept), the same way
  // `sharedObservations` reports the inline plane's kept survivors.
  const catalogTarget: ErasureTarget = {
    ...CATALOG_TARGET,
    rows: work.catalog.matches.length,
  };
  const targets = [...work.hot, ...work.ledger, ...work.lake, catalogTarget]
    .map(({ plane, target, action, rows: rowCount }) => ({ plane, target, action, rows: rowCount }));
  return {
    scopeType: work.scope.input.scopeType,
    scopeRef: work.scope.scopeRef,
    targets,
    sharedObservations: (work.lineage?.sharedObsIds.length ?? 0) + (work.scope.ofapiSharedObservations ?? 0),
    totalRows: targets.reduce((sum, target) => sum + target.rows, 0),
    resolvedPageIds: [...new Set(work.scope.pageIds)].sort((left, right) => left - right),
    resolvedFanGroupIds: [...new Set(work.scope.fanGroupIds)].sort(),
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
 * counts after. An unresolved execution is a mid-flight death and must be
 * re-run to convergence; the successful retry supersedes that exact scope.
 */
export async function executeErasure(
  app: Db,
  input: ErasureScopeInput,
  options: { initiatedBy: number; auditSource?: string },
): Promise<ErasureExecutionResult> {
  return withErasureExecutionLock(app, () => executeErasureLocked(app, input, options));
}

async function executeErasureLocked(
  app: Db,
  input: ErasureScopeInput,
  options: { initiatedBy: number; auditSource?: string },
): Promise<ErasureExecutionResult> {
  const {
    insertErasureLog,
    completeErasureLogAndSupersedeScope,
    acquireErasureFenceExclusiveLocks,
    ERASURE_EXECUTION_PROTOCOL,
  } =
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
    executionProtocol: ERASURE_EXECUTION_PROTOCOL,
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

  // G5 slice 3b — the catalog plane, in the SAME run and deliberately AFTER
  // the delete transaction: "no surviving envelope reference" is only true
  // once those deletes are visible. Bounded batches, each its own transaction
  // under the erasure fence, each independently resumable.
  const catalogOutcome = await sweepCapturePayloadCatalog(app, {
    scopeRef: plan.scopeRef,
    pageIds: work.scope.pageIds,
    matches: work.catalog.matches,
  });
  record({ ...CATALOG_TARGET, rows: work.catalog.matches.length }, catalogOutcome.deleted.length);

  for (const target of work.lake) {
    record(target, await rewriteLakeTarget(plan.scopeRef, target));
  }

  const catalogJournal = capturePayloadCatalogJournal(catalogOutcome);
  const resolution = await completeErasureLogAndSupersedeScope(app.db, {
    id: logRow.id,
    scopeType: input.scopeType,
    scopeRef: plan.scopeRef,
    resolvedPageIds: plan.resolvedPageIds,
    executionProtocol: ERASURE_EXECUTION_PROTOCOL,
    executedCounts: {
      ...executedCounts,
      sharedObservationsKept: plan.sharedObservations,
      // The catalog journal lives ONLY in the tombstone, never in the numeric
      // executedCounts the caller gets back: it carries a manifest array and a
      // "kept" count that is legitimately non-zero on a converged re-run, and
      // the result contract is "every count reaches zero when the erasure has
      // converged".
      ...catalogJournal,
    },
  });
  if (!resolution) {
    throw new Error(`Erasure log ${logRow.id} could not be completed`);
  }

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
      capturePayloadObjectsErased: catalogOutcome.deleted.length,
      capturePayloadObjectsKept: catalogOutcome.retained,
      supersededLogIds: resolution.supersededIds,
    },
  });

  app.logger.info(
    {
      scopeRef: plan.scopeRef,
      totalRows: plan.totalRows,
      logId: logRow.id,
      capturePayloadObjectsErased: catalogOutcome.deleted.length,
      capturePayloadObjectsKept: catalogOutcome.retained,
      supersededLogIds: resolution.supersededIds,
    },
    "Erasure executed",
  );
  return { plan, executedCounts, logId: logRow.id };
}
