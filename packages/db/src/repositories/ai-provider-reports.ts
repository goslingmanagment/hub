import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

// Anthropic's own reports (0330) next to Hub's ledger: what the Admin API
// said each organization was billed and used per UTC day, and Hub's spend
// per account, day and model to compare them with.

type NumericValue = number | bigint | string | null | undefined;

function toNumber(value: NumericValue) {
  return value === null || value === undefined ? 0 : Number(value);
}

function rowsOf<T>(result: { rows: unknown[] }): T[] {
  return result.rows as T[];
}

export interface AiProviderReportApiKey {
  id: string;
  name: string | null;
  hint: string | null;
  status: string | null;
}

export interface AiProviderCostLineInput {
  day: string;
  lineKey: string;
  description: string | null;
  model: string | null;
  costType: string | null;
  tokenType: string | null;
  serviceTier: string | null;
  contextWindow: string | null;
  inferenceGeo: string | null;
  speed: string | null;
  /** Cents, a decimal string exactly as the provider wrote it. */
  amountCents: string;
  currency: string;
  /** The key a CSV line names ("" = the Console); absent or null: an Admin
   * API line, which knows the organization only. */
  apiKeyId?: string | null;
}

export interface AiProviderUsageLineInput {
  day: string;
  /** Null: usage without an API key (the Console's workbench). */
  apiKeyId: string | null;
  model: string;
  uncachedInputTokens: number;
  cacheReadInputTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  outputTokens: number;
  webSearchRequests: number;
}

export interface AiProviderReportSyncRow {
  adminKeyFingerprint: string;
  orgId: string | null;
  orgName: string | null;
  apiKeys: AiProviderReportApiKey[];
  lastAttemptAt: Date | null;
  lastSuccessAt: Date | null;
  lastError: string | null;
  lastErrorAt: Date | null;
}

export async function recordAiProviderReportAttempt(
  db: Database,
  input: { fingerprint: string; at: Date },
) {
  await db.execute(sql`
    insert into ai_provider_report_syncs (admin_key_fingerprint, last_attempt_at, updated_at)
    values (${input.fingerprint}, ${input.at}, ${input.at})
    on conflict (admin_key_fingerprint) do update set
      last_attempt_at = excluded.last_attempt_at,
      updated_at = excluded.updated_at
  `);
}

/** A failed sync keeps the last good data; only the error is recorded. */
export async function recordAiProviderReportFailure(
  db: Database,
  input: { fingerprint: string; at: Date; error: string },
) {
  await db.execute(sql`
    insert into ai_provider_report_syncs (admin_key_fingerprint, last_attempt_at, last_error, last_error_at, updated_at)
    values (${input.fingerprint}, ${input.at}, ${input.error}, ${input.at}, ${input.at})
    on conflict (admin_key_fingerprint) do update set
      last_error = excluded.last_error,
      last_error_at = excluded.last_error_at,
      updated_at = excluded.updated_at
  `);
}

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * An organization's `days` as one read wrote them: each day's header (with
 * its source), cost and usage lines upserted; a line of those days the read
 * no longer names is zeroed (the provider withdrew it, or the re-imported
 * file no longer has it), never deleted.
 */
async function writeReportDays(
  tx: Transaction,
  input: {
    orgId: string;
    source: "admin_api" | "csv";
    importId: number | null;
    days: string[];
    costLines: AiProviderCostLineInput[];
    usageLines: AiProviderUsageLineInput[];
    at: Date;
  },
) {
  const at = input.at;
  for (const day of input.days) {
    await tx.execute(sql`
      insert into ai_provider_report_days (org_id, day, fetched_at, source, import_id)
      values (${input.orgId}, ${day}::date, ${at}, ${input.source}, ${input.importId})
      on conflict (org_id, day) do update set
        fetched_at = excluded.fetched_at,
        source = excluded.source,
        import_id = excluded.import_id
    `);
  }
  for (const line of input.costLines) {
    await tx.execute(sql`
      insert into ai_provider_cost_lines (
        org_id, day, line_key, description, model, cost_type, token_type, service_tier,
        context_window, inference_geo, speed, amount_cents, currency, api_key_id, fetched_at
      ) values (
        ${input.orgId}, ${line.day}::date, ${line.lineKey}, ${line.description}, ${line.model},
        ${line.costType}, ${line.tokenType}, ${line.serviceTier}, ${line.contextWindow},
        ${line.inferenceGeo}, ${line.speed}, ${line.amountCents}::numeric, ${line.currency},
        ${line.apiKeyId ?? null}, ${at}
      )
      on conflict (org_id, day, line_key) do update set
        amount_cents = excluded.amount_cents,
        currency = excluded.currency,
        api_key_id = excluded.api_key_id,
        fetched_at = excluded.fetched_at
    `);
  }
  for (const line of input.usageLines) {
    await tx.execute(sql`
      insert into ai_provider_usage_lines (
        org_id, day, api_key_id, model, uncached_input_tokens, cache_read_input_tokens,
        cache_write_5m_tokens, cache_write_1h_tokens, output_tokens, web_search_requests, fetched_at
      ) values (
        ${input.orgId}, ${line.day}::date, ${line.apiKeyId ?? ""}, ${line.model},
        ${line.uncachedInputTokens}, ${line.cacheReadInputTokens}, ${line.cacheWrite5mTokens},
        ${line.cacheWrite1hTokens}, ${line.outputTokens}, ${line.webSearchRequests}, ${at}
      )
      on conflict (org_id, day, api_key_id, model) do update set
        uncached_input_tokens = excluded.uncached_input_tokens,
        cache_read_input_tokens = excluded.cache_read_input_tokens,
        cache_write_5m_tokens = excluded.cache_write_5m_tokens,
        cache_write_1h_tokens = excluded.cache_write_1h_tokens,
        output_tokens = excluded.output_tokens,
        web_search_requests = excluded.web_search_requests,
        fetched_at = excluded.fetched_at
    `);
  }
  if (input.days.length > 0) {
    const days = sql.join(input.days.map((day) => sql`${day}::date`), sql`, `);
    await tx.execute(sql`
      update ai_provider_cost_lines set amount_cents = 0, fetched_at = ${at}
      where org_id = ${input.orgId} and day in (${days}) and fetched_at < ${at}
    `);
    await tx.execute(sql`
      update ai_provider_usage_lines set
        uncached_input_tokens = 0, cache_read_input_tokens = 0, cache_write_5m_tokens = 0,
        cache_write_1h_tokens = 0, output_tokens = 0, web_search_requests = 0, fetched_at = ${at}
      where org_id = ${input.orgId} and day in (${days}) and fetched_at < ${at}
    `);
  }
}

/** The Admin API sync's read of an organization: its days written, and the
 * admin key's sync row pointed at the organization, its error cleared. */
export async function saveAiProviderReports(
  db: Database,
  input: {
    fingerprint: string;
    orgId: string;
    orgName: string | null;
    apiKeys: AiProviderReportApiKey[];
    days: string[];
    costLines: AiProviderCostLineInput[];
    usageLines: AiProviderUsageLineInput[];
    fetchedAt: Date;
  },
) {
  const at = input.fetchedAt;
  await db.transaction(async (tx) => {
    await writeReportDays(tx, {
      orgId: input.orgId, source: "admin_api", importId: null, days: input.days,
      costLines: input.costLines, usageLines: input.usageLines, at,
    });
    await tx.execute(sql`
      insert into ai_provider_report_syncs (
        admin_key_fingerprint, org_id, org_name, api_keys, last_attempt_at, last_success_at,
        last_error, last_error_at, updated_at
      ) values (
        ${input.fingerprint}, ${input.orgId}, ${input.orgName}, ${JSON.stringify(input.apiKeys)}::jsonb,
        ${at}, ${at}, null, null, ${at}
      )
      on conflict (admin_key_fingerprint) do update set
        org_id = excluded.org_id,
        org_name = excluded.org_name,
        api_keys = excluded.api_keys,
        last_success_at = excluded.last_success_at,
        last_error = null,
        last_error_at = null,
        updated_at = excluded.updated_at
    `);
  });
}

/** A Cost-page CSV of an organization: the import recorded and every day of
 * its period replaced by the file's lines (a day with no spend is an empty
 * day). Returns the import's id. */
export async function saveAiProviderCsvImport(
  db: Database,
  input: {
    orgId: string;
    accountId: number;
    fileName: string | null;
    periodFrom: string;
    periodTo: string;
    rowCount: number;
    amountCents: string;
    days: string[];
    costLines: AiProviderCostLineInput[];
    usageLines: AiProviderUsageLineInput[];
    importedAt: Date;
  },
): Promise<number> {
  return db.transaction(async (tx) => {
    const result = await tx.execute(sql`
      insert into ai_provider_csv_imports (
        org_id, account_id, file_name, period_from, period_to, row_count, amount_cents, imported_at
      ) values (
        ${input.orgId}, ${input.accountId}, ${input.fileName}, ${input.periodFrom}::date, ${input.periodTo}::date,
        ${input.rowCount}, ${input.amountCents}::numeric, ${input.importedAt}
      )
      returning id
    `);
    const importId = Number(rowsOf<{ id: NumericValue }>(result)[0]!.id);
    await writeReportDays(tx, {
      orgId: input.orgId, source: "csv", importId, days: input.days,
      costLines: input.costLines, usageLines: input.usageLines, at: input.importedAt,
    });
    return importId;
  });
}

export interface AiProviderCsvImportRow {
  id: number;
  orgId: string;
  accountId: number;
  fileName: string | null;
  periodFrom: string;
  periodTo: string;
  rowCount: number;
  amountCents: string;
  importedAt: Date;
}

/** Each organization's latest import. */
export async function listLatestAiProviderCsvImports(db: Database): Promise<AiProviderCsvImportRow[]> {
  const result = await db.execute(sql`
    select distinct on (org_id) id, org_id as "orgId", account_id as "accountId", file_name as "fileName",
           period_from::text as "periodFrom", period_to::text as "periodTo", row_count as "rowCount",
           amount_cents::text as "amountCents", imported_at as "importedAt"
    from ai_provider_csv_imports
    order by org_id, imported_at desc, id desc
  `);
  return rowsOf<Record<keyof AiProviderCsvImportRow, NumericValue | Date>>(result).map((row) => ({
    id: Number(row.id),
    orgId: String(row.orgId),
    accountId: Number(row.accountId),
    fileName: row.fileName === null ? null : String(row.fileName),
    periodFrom: String(row.periodFrom),
    periodTo: String(row.periodTo),
    rowCount: Number(row.rowCount),
    amountCents: String(row.amountCents),
    importedAt: new Date(row.importedAt as Date | string),
  }));
}

export type AiProviderKeyMappingSource = "hint" | "name" | "owner";

export interface AiProviderKeyMappingRow {
  orgId: string;
  apiKeyId: string;
  /** Null: not Hub's key. */
  accountId: number | null;
  source: AiProviderKeyMappingSource;
  keyName: string | null;
  keyHint: string | null;
  decidedAt: Date;
}

export async function listAiProviderKeyMappings(db: Database): Promise<AiProviderKeyMappingRow[]> {
  const result = await db.execute(sql`
    select org_id as "orgId", api_key_id as "apiKeyId", account_id as "accountId", source,
           key_name as "keyName", key_hint as "keyHint", decided_at as "decidedAt"
    from ai_provider_key_mappings
  `);
  return rowsOf<Record<keyof AiProviderKeyMappingRow, NumericValue | Date>>(result).map((row) => ({
    orgId: String(row.orgId),
    apiKeyId: String(row.apiKeyId),
    accountId: row.accountId === null ? null : Number(row.accountId),
    source: row.source as AiProviderKeyMappingSource,
    keyName: row.keyName === null ? null : String(row.keyName),
    keyHint: row.keyHint === null ? null : String(row.keyHint),
    decidedAt: new Date(row.decidedAt as Date | string),
  }));
}

/**
 * Hub's own decisions (a hint, a name on import): recorded for a key Hub has
 * no decision on yet, never over one — an earlier decision, the owner's
 * above all, wins. A known key's name and hint are refreshed.
 */
export async function recordAiProviderKeyMappings(
  db: Database,
  input: {
    orgId: string;
    mappings: Array<{ apiKeyId: string; accountId: number | null; source: "hint" | "name"; keyName: string | null; keyHint: string | null }>;
    at: Date;
  },
) {
  for (const mapping of input.mappings) {
    await db.execute(sql`
      insert into ai_provider_key_mappings (org_id, api_key_id, account_id, source, key_name, key_hint, decided_at)
      values (${input.orgId}, ${mapping.apiKeyId}, ${mapping.accountId}, ${mapping.source}, ${mapping.keyName},
        ${mapping.keyHint}, ${input.at})
      on conflict (org_id, api_key_id) do update set
        key_name = coalesce(excluded.key_name, ai_provider_key_mappings.key_name),
        key_hint = coalesce(excluded.key_hint, ai_provider_key_mappings.key_hint)
    `);
  }
}

/** The owner's decision on a key: over any earlier one. */
export async function setAiProviderKeyMapping(
  db: Database,
  input: { orgId: string; apiKeyId: string; accountId: number | null; keyName?: string | null; at: Date },
) {
  await db.execute(sql`
    insert into ai_provider_key_mappings (org_id, api_key_id, account_id, source, key_name, decided_at)
    values (${input.orgId}, ${input.apiKeyId}, ${input.accountId}, 'owner', ${input.keyName ?? null}, ${input.at})
    on conflict (org_id, api_key_id) do update set
      account_id = excluded.account_id,
      source = 'owner',
      key_name = coalesce(excluded.key_name, ai_provider_key_mappings.key_name),
      decided_at = excluded.decided_at
  `);
}

export async function setAiProviderAccountOrg(
  db: Database,
  input: { accountId: number; orgId: string; at: Date },
) {
  await db.execute(sql`
    insert into ai_provider_account_orgs (account_id, org_id, resolved_at)
    values (${input.accountId}, ${input.orgId}, ${input.at})
    on conflict (account_id) do update set org_id = excluded.org_id, resolved_at = excluded.resolved_at
  `);
}

export async function listAiProviderAccountOrgs(db: Database) {
  const result = await db.execute(sql`
    select account_id as "accountId", org_id as "orgId", resolved_at as "resolvedAt" from ai_provider_account_orgs
  `);
  return rowsOf<{ accountId: NumericValue; orgId: string; resolvedAt: Date | string }>(result).map((row) => ({
    accountId: Number(row.accountId),
    orgId: row.orgId,
    resolvedAt: new Date(row.resolvedAt),
  }));
}

export async function listAiProviderReportSyncs(db: Database): Promise<AiProviderReportSyncRow[]> {
  const result = await db.execute(sql`
    select admin_key_fingerprint as "adminKeyFingerprint", org_id as "orgId", org_name as "orgName",
           api_keys as "apiKeys", last_attempt_at as "lastAttemptAt", last_success_at as "lastSuccessAt",
           last_error as "lastError", last_error_at as "lastErrorAt"
    from ai_provider_report_syncs
    where provider = 'anthropic'
  `);
  const date = (value: Date | string | null) => (value === null ? null : new Date(value));
  return rowsOf<{
    adminKeyFingerprint: string;
    orgId: string | null;
    orgName: string | null;
    apiKeys: AiProviderReportApiKey[] | null;
    lastAttemptAt: Date | string | null;
    lastSuccessAt: Date | string | null;
    lastError: string | null;
    lastErrorAt: Date | string | null;
  }>(result).map((row) => ({
    adminKeyFingerprint: row.adminKeyFingerprint,
    orgId: row.orgId,
    orgName: row.orgName,
    apiKeys: row.apiKeys ?? [],
    lastAttemptAt: date(row.lastAttemptAt),
    lastSuccessAt: date(row.lastSuccessAt),
    lastError: row.lastError,
    lastErrorAt: date(row.lastErrorAt),
  }));
}

export interface AiProviderCostByModelRow {
  orgId: string;
  day: string;
  /** The key a CSV line names ("" = the Console); null: the organization's
   * (an Admin API line). */
  apiKeyId: string | null;
  /** Null: a cost that is not a model's tokens (web search, code execution). */
  model: string | null;
  /** The exact sum of the lines' cents, a decimal string. */
  amountCents: string;
}

export interface AiProviderUsageRow {
  orgId: string;
  day: string;
  apiKeyId: string | null;
  model: string;
  uncachedInputTokens: number;
  cacheReadInputTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  outputTokens: number;
  webSearchRequests: number;
}

export interface AiProviderReportDayRow {
  orgId: string;
  day: string;
  fetchedAt: Date;
  source: "admin_api" | "csv";
  importId: number | null;
}

/** The organizations' read days, cost per key and model and usage per key and model
 * over [fromDay, toDay] (UTC dates, inclusive). */
export async function listAiProviderReports(
  db: Database,
  input: { orgIds: string[]; fromDay: string; toDay: string },
) {
  if (input.orgIds.length === 0) {
    return { days: [], costs: [], usage: [] } as {
      days: AiProviderReportDayRow[];
      costs: AiProviderCostByModelRow[];
      usage: AiProviderUsageRow[];
    };
  }
  const orgIds = sql.join(input.orgIds.map((id) => sql`${id}`), sql`, `);
  const window = sql`day between ${input.fromDay}::date and ${input.toDay}::date`;
  const [days, costs, usage] = await Promise.all([
    db.execute(sql`
      select org_id as "orgId", day::text as day, fetched_at as "fetchedAt", source, import_id as "importId"
      from ai_provider_report_days
      where org_id in (${orgIds}) and ${window}
    `),
    db.execute(sql`
      select org_id as "orgId", day::text as day, api_key_id as "apiKeyId", model,
             sum(amount_cents)::text as "amountCents"
      from ai_provider_cost_lines
      where org_id in (${orgIds}) and ${window}
      group by org_id, day, api_key_id, model
    `),
    db.execute(sql`
      select org_id as "orgId", day::text as day, api_key_id as "apiKeyId", model,
             uncached_input_tokens as "uncachedInputTokens", cache_read_input_tokens as "cacheReadInputTokens",
             cache_write_5m_tokens as "cacheWrite5mTokens", cache_write_1h_tokens as "cacheWrite1hTokens",
             output_tokens as "outputTokens", web_search_requests as "webSearchRequests"
      from ai_provider_usage_lines
      where org_id in (${orgIds}) and ${window}
    `),
  ]);
  return {
    days: rowsOf<{ orgId: string; day: string; fetchedAt: Date | string; source: string | null; importId: NumericValue }>(days)
      .map((row): AiProviderReportDayRow => ({
        orgId: row.orgId,
        day: row.day,
        fetchedAt: new Date(row.fetchedAt),
        // Days before 0332 were the Admin API sync's.
        source: row.source === "csv" ? "csv" : "admin_api",
        importId: row.importId === null || row.importId === undefined ? null : Number(row.importId),
      })),
    costs: rowsOf<AiProviderCostByModelRow>(costs).map((row) => ({
      orgId: row.orgId,
      day: row.day,
      apiKeyId: row.apiKeyId,
      model: row.model,
      amountCents: row.amountCents,
    })),
    usage: rowsOf<Record<keyof AiProviderUsageRow, NumericValue>>(usage).map((row): AiProviderUsageRow => ({
      orgId: String(row.orgId),
      day: String(row.day),
      apiKeyId: row.apiKeyId === "" ? null : String(row.apiKeyId),
      model: String(row.model),
      uncachedInputTokens: toNumber(row.uncachedInputTokens),
      cacheReadInputTokens: toNumber(row.cacheReadInputTokens),
      cacheWrite5mTokens: toNumber(row.cacheWrite5mTokens),
      cacheWrite1hTokens: toNumber(row.cacheWrite1hTokens),
      outputTokens: toNumber(row.outputTokens),
      webSearchRequests: toNumber(row.webSearchRequests),
    })),
  };
}

export interface HubAnthropicSpendRow {
  /** Null: an Anthropic call from before Hub named the account. */
  accountId: number | null;
  day: string;
  model: string;
  requests: number;
  costMicroUsd: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** The cache writes by TTL (0329); null when a row with cache writes
   * predates the split. */
  cacheWrite5mTokens: number | null;
  cacheWrite1hTokens: number | null;
  outputTokens: number;
}

/** Hub's ledger per account (null: an Anthropic call that names none), UTC
 * day of completed_at and model, every outcome, over [fromDay, toDay]
 * inclusive. */
export async function listHubAnthropicSpendByDay(
  db: Database,
  input: { fromDay: string; toDay: string },
): Promise<HubAnthropicSpendRow[]> {
  const result = await db.execute(sql`
    select provider_account_id as "accountId",
           (completed_at at time zone 'UTC')::date::text as day,
           model,
           count(*) as requests,
           coalesce(sum(cost_micro_usd), 0) as "costMicroUsd",
           coalesce(sum(input_tokens), 0) as "inputTokens",
           coalesce(sum(cache_read_tokens), 0) as "cacheReadTokens",
           coalesce(sum(cache_write_tokens), 0) as "cacheWriteTokens",
           case when bool_and(cache_write_tokens = 0 or cache_write_5m_tokens is not null or cache_write_1h_tokens is not null)
             then coalesce(sum(cache_write_5m_tokens), 0) end as "cacheWrite5mTokens",
           case when bool_and(cache_write_tokens = 0 or cache_write_5m_tokens is not null or cache_write_1h_tokens is not null)
             then coalesce(sum(cache_write_1h_tokens), 0) end as "cacheWrite1hTokens",
           coalesce(sum(output_tokens), 0) as "outputTokens"
    from ai_usage_events
    where (provider_account_id is not null or provider = 'anthropic')
      and completed_at >= ${input.fromDay}::date::timestamp at time zone 'UTC'
      and completed_at < (${input.toDay}::date + 1)::timestamp at time zone 'UTC'
    group by 1, 2, 3
  `);
  return rowsOf<Record<keyof HubAnthropicSpendRow, NumericValue>>(result).map((row) => ({
    accountId: row.accountId === null ? null : toNumber(row.accountId),
    day: String(row.day),
    model: String(row.model),
    requests: toNumber(row.requests),
    costMicroUsd: toNumber(row.costMicroUsd),
    inputTokens: toNumber(row.inputTokens),
    cacheReadTokens: toNumber(row.cacheReadTokens),
    cacheWriteTokens: toNumber(row.cacheWriteTokens),
    cacheWrite5mTokens: row.cacheWrite5mTokens === null ? null : toNumber(row.cacheWrite5mTokens),
    cacheWrite1hTokens: row.cacheWrite1hTokens === null ? null : toNumber(row.cacheWrite1hTokens),
    outputTokens: toNumber(row.outputTokens),
  }));
}
