import {
  insertAuditEvent,
  listAiProviderAccounts,
  listAiProviderKeyMappings,
  recordAiProviderKeyMappings,
  saveAiProviderCsvImport,
  setAiProviderAccountOrg,
  setAiProviderKeyMapping,
  type AiProviderCostLineInput,
  type AiProviderUsageLineInput,
} from "@agency_hub_core/db";
import {
  anthropicKeyPoolEntries,
  centsFromDollarsDecimal,
  microUsdFromCents,
  sumCentsDecimals,
} from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { resolveAnthropicGatewayModel } from "./ai-gateway-pricing.ts";
import { ANTHROPIC_ADMIN_BASE_URL } from "./anthropic-admin-api.ts";
import { BadRequestError, ConflictError, NotFoundError, ServiceUnavailableError } from "./errors.ts";

// The Anthropic console's Cost page, exported as CSV by the owner, as the
// reconciliation's provider data when no admin key reads the reports (the
// organizations of Hub's keys have none). The file is one organization's: a
// row per UTC day, key, model and token type, in dollars rounded to the cent.
// Its dollars are the key's own — no split. Its organization is the one the
// chosen account's API key lives in (GET /v1/models answers it in a header;
// a free call, never /v1/messages).

const DAY_MS = 86_400_000;
const REQUIRED_COLUMNS = ["usage_date_utc", "model", "api_key", "token_type", "cost_usd", "cost_type", "api_key_id"] as const;
/** The console's "--" for a field a row has none of. */
const NONE = "--";
/** The key name the owner gives Hub's key in each organization. */
const HUB_KEY_NAME = "hub";

const TOKEN_TYPES: Record<string, string> = {
  input_no_cache: "uncached_input_tokens",
  input_cache_read: "cache_read_input_tokens",
  input_cache_write_5m: "cache_creation.ephemeral_5m_input_tokens",
  input_cache_write_1h: "cache_creation.ephemeral_1h_input_tokens",
  output: "output_tokens",
};
const COST_TYPES: Record<string, string> = { token: "tokens", session_runtime: "session_usage" };
const CONTEXT_WINDOWS: Record<string, string> = { "≤ 200k": "0-200k", "200k - 1M": "200k-1M" };

/** RFC 4180: quoted fields, doubled quotes, CRLF or LF, a BOM. */
export function parseCsvRecords(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  const input = text.startsWith("﻿") ? text.slice(1) : text;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;
    if (quoted) {
      if (char === "\"" && input[index + 1] === "\"") {
        field += "\"";
        index += 1;
      } else if (char === "\"") {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === "\"") {
      quoted = true;
    } else if (char === ",") {
      record.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && input[index + 1] === "\n") index += 1;
      record.push(field);
      records.push(record);
      record = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field !== "" || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records.filter((row) => row.some((value) => value.trim() !== ""));
}

/** "Claude Opus 5.5" → "claude-opus-5-5", the id the API and Hub's catalog use. */
export function csvModelId(name: string) {
  return name.trim().toLowerCase().replace(/[\s.]+/g, "-");
}

function orNull(value: string | undefined) {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" || trimmed === NONE ? null : trimmed;
}

export interface CostCsvKey {
  /** "" = the Console (no API key). */
  apiKeyId: string;
  name: string | null;
  amountCents: string;
  microUsd: number;
}

export interface ParsedCostCsv {
  periodFrom: string;
  periodTo: string;
  /** Every UTC day from periodFrom to periodTo: a day the file has no spend
   * on is an empty day, not an unknown one. */
  days: string[];
  rowCount: number;
  amountCents: string;
  keys: CostCsvKey[];
  costLines: Array<AiProviderCostLineInput & { apiKeyId: string }>;
  /** Tokens estimated from the dollars at Hub's list prices (the file has
   * none): for the per-model breakdown only. */
  usageLines: AiProviderUsageLineInput[];
}

export function parseAnthropicCostCsv(text: string): ParsedCostCsv {
  const [header, ...rows] = parseCsvRecords(text);
  if (!header) throw new BadRequestError("The CSV file is empty");
  const column = new Map(header.map((name, index) => [name.trim(), index]));
  const missing = REQUIRED_COLUMNS.filter((name) => !column.has(name));
  if (missing.length > 0) {
    throw new BadRequestError(`Not the Anthropic console's Cost CSV: no column ${missing.join(", ")}`);
  }
  const get = (row: string[], name: string) => {
    const index = column.get(name);
    return index === undefined ? undefined : row[index];
  };

  const lines = new Map<string, AiProviderCostLineInput & { apiKeyId: string; amounts: string[] }>();
  const keys = new Map<string, { name: string | null; amounts: string[] }>();
  const usage = new Map<string, AiProviderUsageLineInput>();
  let from = null as string | null;
  let to = null as string | null;

  for (const [index, row] of rows.entries()) {
    const line = index + 2;
    const day = get(row, "usage_date_utc")?.trim() ?? "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) {
      throw new BadRequestError(`CSV line ${line}: usage_date_utc "${day}" is not a date`);
    }
    from = from === null || day < from ? day : from;
    to = to === null || day > to ? day : to;
    const rawKeyId = get(row, "api_key_id")?.trim() ?? "";
    if (rawKeyId === "") throw new BadRequestError(`CSV line ${line}: no api_key_id`);
    const apiKeyId = rawKeyId === "console" ? "" : rawKeyId;
    const dollars = get(row, "cost_usd")?.trim() || "0";
    let cents: string;
    try {
      cents = centsFromDollarsDecimal(dollars);
    } catch {
      throw new BadRequestError(`CSV line ${line}: cost_usd "${dollars}" is not an amount`);
    }

    const keyName = orNull(get(row, "api_key"));
    const key = keys.get(apiKeyId) ?? { name: keyName, amounts: [] };
    key.amounts.push(cents);
    key.name ??= keyName;
    keys.set(apiKeyId, key);

    const modelName = orNull(get(row, "model"));
    const fields = {
      description: [modelName, orNull(get(row, "token_type")) ?? orNull(get(row, "cost_type"))].filter(Boolean).join(" ") || null,
      model: modelName === null ? null : csvModelId(modelName),
      costType: COST_TYPES[get(row, "cost_type")?.trim() ?? ""] ?? orNull(get(row, "cost_type")),
      tokenType: TOKEN_TYPES[get(row, "token_type")?.trim() ?? ""] ?? orNull(get(row, "token_type")),
      serviceTier: null,
      contextWindow: CONTEXT_WINDOWS[get(row, "context_window")?.trim() ?? ""] ?? orNull(get(row, "context_window")),
      inferenceGeo: orNull(get(row, "inference_geo")),
      speed: orNull(get(row, "speed")),
    };
    const lineKey = [`key:${apiKeyId}`, ...Object.values(fields).slice(1), orNull(get(row, "usage_type"))]
      .map((value) => value ?? "").join("|");
    const existing = lines.get(`${day}|${lineKey}`);
    if (existing) {
      existing.amounts.push(cents);
    } else {
      lines.set(`${day}|${lineKey}`, { day, lineKey, ...fields, apiKeyId, amountCents: cents, currency: "USD", amounts: [cents] });
    }

    if (fields.model && fields.costType === "tokens" && fields.tokenType) {
      const tokens = estimatedTokens(fields.model, fields.tokenType, dollars);
      if (tokens > 0) {
        const usageKey = `${day}|${apiKeyId}|${fields.model}`;
        const entry = usage.get(usageKey) ?? {
          day, apiKeyId, model: fields.model, uncachedInputTokens: 0, cacheReadInputTokens: 0,
          cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, outputTokens: 0, webSearchRequests: 0,
        };
        if (fields.tokenType === "uncached_input_tokens") entry.uncachedInputTokens += tokens;
        if (fields.tokenType === "cache_read_input_tokens") entry.cacheReadInputTokens += tokens;
        if (fields.tokenType === "cache_creation.ephemeral_5m_input_tokens") entry.cacheWrite5mTokens += tokens;
        if (fields.tokenType === "cache_creation.ephemeral_1h_input_tokens") entry.cacheWrite1hTokens += tokens;
        if (fields.tokenType === "output_tokens") entry.outputTokens += tokens;
        usage.set(usageKey, entry);
      }
    }
  }

  if (from === null || to === null) throw new BadRequestError("The CSV file has no rows");
  const periodFrom = from;
  const periodTo = to;
  const days: string[] = [];
  for (let at = Date.parse(`${periodFrom}T00:00:00Z`); at <= Date.parse(`${periodTo}T00:00:00Z`); at += DAY_MS) {
    days.push(new Date(at).toISOString().slice(0, 10));
  }
  const allAmounts = [...keys.values()].flatMap((key) => key.amounts);
  return {
    periodFrom,
    periodTo,
    days,
    rowCount: rows.length,
    amountCents: sumCentsDecimals(allAmounts),
    keys: [...keys].map(([apiKeyId, key]) => ({
      apiKeyId,
      name: key.name,
      amountCents: sumCentsDecimals(key.amounts),
      microUsd: microUsdFromCents(key.amounts),
    })),
    costLines: [...lines.values()]
      .map(({ amounts, ...line }) => ({ ...line, amountCents: sumCentsDecimals(amounts) }))
      .filter((line) => /[1-9]/.test(line.amountCents)),
    usageLines: [...usage.values()],
  };
}

/** Tokens a dollar amount buys at Hub's list price of the model (0 for a
 * model Hub does not price). An estimate: the file rounds to the cent. */
function estimatedTokens(model: string, tokenType: string, dollars: string) {
  let rates;
  try {
    rates = resolveAnthropicGatewayModel(`anthropic:${model}`);
  } catch {
    return 0;
  }
  const perMillion = {
    uncached_input_tokens: rates.inputUsdPerMillion,
    cache_read_input_tokens: rates.cacheReadUsdPerMillion,
    "cache_creation.ephemeral_5m_input_tokens": rates.cacheWrite5mUsdPerMillion,
    "cache_creation.ephemeral_1h_input_tokens": rates.cacheWrite1hUsdPerMillion,
    output_tokens: rates.outputUsdPerMillion,
  }[tokenType];
  return perMillion ? Math.round((Number(dollars) / perMillion) * 1_000_000) : 0;
}

/** The organization an API key lives in: the `anthropic-organization-id`
 * header of GET /v1/models (free; lists models, spends nothing). */
export async function resolveAnthropicOrgId(input: { apiKey: string; fetchImpl?: typeof fetch; baseUrl?: string }) {
  const fetchImpl = input.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(new URL("/v1/models?limit=1", input.baseUrl ?? ANTHROPIC_ADMIN_BASE_URL), {
      headers: { "x-api-key": input.apiKey, "anthropic-version": "2023-06-01", "user-agent": "agency-hub/ai-reconciliation" },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new ServiceUnavailableError(`Anthropic did not answer GET /v1/models (${error instanceof Error ? error.message : String(error)})`);
  }
  await response.body?.cancel().catch(() => undefined);
  const orgId = response.headers.get("anthropic-organization-id");
  if (!response.ok || !orgId) {
    throw new ServiceUnavailableError(`Anthropic answered GET /v1/models ${response.status} without the account's organization`);
  }
  return orgId;
}

type ImportApp = Pick<AppContext, "db" | "config">;

export interface CostCsvImportResult {
  importId: number;
  orgId: string;
  accountId: number;
  label: string;
  fileName: string | null;
  periodFrom: string;
  periodTo: string;
  days: number;
  microUsd: number;
  keys: Array<{
    apiKeyId: string | null;
    name: string | null;
    microUsd: number;
    /** Null: not Hub's key (the Console never is). */
    accountId: number | null;
    source: "hint" | "name" | "owner" | null;
  }>;
}

/**
 * Imports one organization's Cost CSV for the account `label`: the file's
 * days replace what Hub had for them. A key with no decision yet is decided
 * by its name — "hub" is the account's, any other is not Hub's; `hubKeyIds`
 * are the owner's own decision (the account's). A key Hub knows in another
 * organization refuses the file: it is not this account's organization.
 */
export async function importAnthropicCostCsv(
  app: ImportApp,
  input: {
    account: { id: number } | { label: string };
    csv: string;
    fileName?: string | null;
    hubKeyIds?: readonly string[];
    actorUserId?: number | null;
    source: "dashboard" | "cli";
    now?: Date;
    resolveOrgId?: (apiKey: string) => Promise<string>;
  },
): Promise<CostCsvImportResult> {
  const now = input.now ?? new Date();
  const account = (await listAiProviderAccounts(app.db, "anthropic"))
    .find((row) => ("id" in input.account ? row.id === input.account.id : row.label === input.account.label));
  if (!account) throw new NotFoundError("Anthropic account not found");
  const apiKey = anthropicKeyPoolEntries(app.config).find((entry) => entry.label === account.label)?.apiKey;
  if (!apiKey) throw new ConflictError(`The account ${account.label} has no key in ANTHROPIC_API_KEYS: its organization is unknown`);
  const parsed = parseAnthropicCostCsv(input.csv);
  const orgId = await (input.resolveOrgId ?? ((key: string) => resolveAnthropicOrgId({ apiKey: key })))(apiKey);

  const known = await listAiProviderKeyMappings(app.db);
  const fileKeyIds = parsed.keys.map((key) => key.apiKeyId).filter((id) => id !== "");
  const elsewhere = known.find((mapping) => mapping.orgId !== orgId && fileKeyIds.includes(mapping.apiKeyId));
  if (elsewhere) {
    throw new ConflictError(
      `The file names the key ${elsewhere.apiKeyId}, which is another organization's: it is not the CSV of ${account.label}'s organization`,
    );
  }

  const ownerKeys = new Set(input.hubKeyIds ?? []);
  for (const keyId of ownerKeys) {
    if (!fileKeyIds.includes(keyId)) throw new BadRequestError(`The file has no key ${keyId}`);
    const name = parsed.keys.find((key) => key.apiKeyId === keyId)?.name ?? null;
    await setAiProviderKeyMapping(app.db, { orgId, apiKeyId: keyId, accountId: account.id, keyName: name, at: now });
  }
  await recordAiProviderKeyMappings(app.db, {
    orgId,
    mappings: parsed.keys.filter((key) => key.apiKeyId !== "").map((key) => ({
      apiKeyId: key.apiKeyId,
      accountId: key.name?.trim().toLowerCase() === HUB_KEY_NAME ? account.id : null,
      source: "name" as const,
      keyName: key.name,
      keyHint: null,
    })),
    at: now,
  });
  await setAiProviderAccountOrg(app.db, { accountId: account.id, orgId, at: now });
  const importId = await saveAiProviderCsvImport(app.db, {
    orgId,
    accountId: account.id,
    fileName: input.fileName ?? null,
    periodFrom: parsed.periodFrom,
    periodTo: parsed.periodTo,
    rowCount: parsed.rowCount,
    amountCents: parsed.amountCents,
    days: parsed.days,
    costLines: parsed.costLines,
    usageLines: parsed.usageLines,
    importedAt: now,
  });
  await insertAuditEvent(app.db, {
    actorUserId: input.actorUserId ?? null,
    source: input.source,
    eventType: "admin.ai_provider_csv_import",
    metadata: { importId, orgId, label: account.label, fileName: input.fileName ?? null, periodFrom: parsed.periodFrom, periodTo: parsed.periodTo },
  });

  const mappings = (await listAiProviderKeyMappings(app.db)).filter((mapping) => mapping.orgId === orgId);
  return {
    importId,
    orgId,
    accountId: account.id,
    label: account.label,
    fileName: input.fileName ?? null,
    periodFrom: parsed.periodFrom,
    periodTo: parsed.periodTo,
    days: parsed.days.length,
    microUsd: microUsdFromCents([parsed.amountCents]),
    keys: parsed.keys.map((key) => {
      const mapping = mappings.find((candidate) => candidate.apiKeyId === key.apiKeyId);
      return {
        apiKeyId: key.apiKeyId === "" ? null : key.apiKeyId,
        name: key.apiKeyId === "" ? "console" : key.name,
        microUsd: key.microUsd,
        accountId: mapping?.accountId ?? null,
        source: mapping?.source ?? null,
      };
    }),
  };
}

/** The owner's decision on whose a key is (null: not Hub's). */
export async function setAnthropicKeyMapping(
  app: Pick<AppContext, "db">,
  input: { orgId: string; apiKeyId: string; accountId: number | null; actorUserId: number | null; source: "dashboard" | "cli"; now?: Date },
) {
  const now = input.now ?? new Date();
  if (input.accountId !== null) {
    const accounts = await listAiProviderAccounts(app.db, "anthropic");
    if (!accounts.some((account) => account.id === input.accountId)) {
      throw new NotFoundError("Anthropic account not found");
    }
  }
  await setAiProviderKeyMapping(app.db, { orgId: input.orgId, apiKeyId: input.apiKeyId, accountId: input.accountId, at: now });
  await insertAuditEvent(app.db, {
    actorUserId: input.actorUserId,
    source: input.source,
    eventType: "admin.ai_provider_key_mapping",
    metadata: { orgId: input.orgId, apiKeyId: input.apiKeyId, accountId: input.accountId },
  });
}
