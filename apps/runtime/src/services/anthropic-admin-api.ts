import { sumCentsDecimals } from "@agency_hub_core/shared";
import type {
  AiProviderCostLineInput,
  AiProviderReportApiKey,
  AiProviderUsageLineInput,
} from "@agency_hub_core/db";
import { z } from "zod";

// Anthropic's Admin API reports, read straight from this server with an
// admin key of ANTHROPIC_ADMIN_KEYS (the reports are not in the SDK). Reads
// only: nothing here spends. Docs:
// https://platform.claude.com/docs/en/manage-claude/usage-cost-api
// No error message or log line carries the key.

export const ANTHROPIC_ADMIN_BASE_URL = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";
const REQUEST_TIMEOUT_MS = 30_000;
/** A runaway cursor stops here instead of looping. */
const MAX_PAGES = 50;

export class AnthropicAdminApiError extends Error {
  constructor(message: string, readonly status: number | null) {
    super(message);
    this.name = "AnthropicAdminApiError";
  }
}

const organizationSchema = z.object({ id: z.string().min(1), name: z.string().nullish() });

const apiKeysPageSchema = z.object({
  data: z.array(z.object({
    id: z.string(),
    name: z.string().nullish(),
    partial_key_hint: z.string().nullish(),
    status: z.string().nullish(),
  })),
  has_more: z.boolean(),
  last_id: z.string().nullish(),
});

const costPageSchema = z.object({
  data: z.array(z.object({
    starting_at: z.string(),
    ending_at: z.string(),
    results: z.array(z.object({
      amount: z.string(),
      currency: z.string(),
      description: z.string().nullish(),
      model: z.string().nullish(),
      cost_type: z.string().nullish(),
      token_type: z.string().nullish(),
      service_tier: z.string().nullish(),
      context_window: z.string().nullish(),
      inference_geo: z.string().nullish(),
      speed: z.string().nullish(),
    })),
  })),
  has_more: z.boolean(),
  next_page: z.string().nullish(),
});

const tokens = z.number().int().nonnegative();
const usagePageSchema = z.object({
  data: z.array(z.object({
    starting_at: z.string(),
    ending_at: z.string(),
    results: z.array(z.object({
      api_key_id: z.string().nullish(),
      model: z.string().nullish(),
      uncached_input_tokens: tokens,
      cache_read_input_tokens: tokens,
      cache_creation: z.object({
        ephemeral_5m_input_tokens: tokens.default(0),
        ephemeral_1h_input_tokens: tokens.default(0),
      }).nullish(),
      output_tokens: tokens,
      server_tool_use: z.object({ web_search_requests: tokens.default(0) }).nullish(),
    })),
  })),
  has_more: z.boolean(),
  next_page: z.string().nullish(),
});

export interface AnthropicAdminClient {
  organization(): Promise<{ id: string; name: string | null }>;
  apiKeys(): Promise<AiProviderReportApiKey[]>;
  /** Cost by description per UTC day from `startingAt` on. */
  costReport(startingAt: Date): Promise<{ days: string[]; lines: AiProviderCostLineInput[] }>;
  /** Usage by API key and model per UTC day from `startingAt` on. */
  usageReport(startingAt: Date): Promise<{ days: string[]; lines: AiProviderUsageLineInput[] }>;
}

export function createAnthropicAdminClient(input: {
  adminKey: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}): AnthropicAdminClient {
  const fetchImpl = input.fetchImpl ?? fetch;
  const baseUrl = input.baseUrl ?? ANTHROPIC_ADMIN_BASE_URL;

  async function get(path: string, query: Array<[string, string]>): Promise<unknown> {
    const url = new URL(path, baseUrl);
    for (const [key, value] of query) {
      url.searchParams.append(key, value);
    }
    let response: Response;
    try {
      response = await fetchImpl(url, {
        headers: {
          "x-api-key": input.adminKey,
          "anthropic-version": ANTHROPIC_VERSION,
          "user-agent": "agency-hub/ai-reconciliation",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new AnthropicAdminApiError(`Anthropic Admin API ${path}: no answer (${reason})`, null);
    }
    const text = await response.text();
    if (!response.ok) {
      throw new AnthropicAdminApiError(
        `Anthropic Admin API ${path} answered ${response.status}${errorDetail(text)}`,
        response.status,
      );
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new AnthropicAdminApiError(`Anthropic Admin API ${path} answered ${response.status} with no JSON`, response.status);
    }
  }

  function parse<T>(schema: z.ZodType<T>, path: string, body: unknown): T {
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new AnthropicAdminApiError(
        `Anthropic Admin API ${path} answered an unexpected shape (${issue?.path.join(".") ?? "?"}: ${issue?.message ?? "?"})`,
        null,
      );
    }
    return parsed.data;
  }

  /** The report endpoints' `has_more` / `next_page` cursor. */
  async function reportPages<T extends { has_more: boolean; next_page?: string | null | undefined }>(
    path: string,
    schema: z.ZodType<T>,
    query: Array<[string, string]>,
  ): Promise<T[]> {
    const pages: T[] = [];
    let cursor: string | null = null;
    for (let index = 0; index < MAX_PAGES; index += 1) {
      const page: T = parse(schema, path, await get(path, cursor ? [...query, ["page", cursor]] : query));
      pages.push(page);
      if (!page.has_more) {
        return pages;
      }
      if (!page.next_page || page.next_page === cursor) {
        throw new AnthropicAdminApiError(`Anthropic Admin API ${path} said has_more without a new next_page`, null);
      }
      cursor = page.next_page;
    }
    throw new AnthropicAdminApiError(`Anthropic Admin API ${path} paged past ${MAX_PAGES} pages`, null);
  }

  return {
    async organization() {
      const org = parse(organizationSchema, "/v1/organizations/me", await get("/v1/organizations/me", []));
      return { id: org.id, name: org.name ?? null };
    },

    async apiKeys() {
      const path = "/v1/organizations/api_keys";
      const keys: AiProviderReportApiKey[] = [];
      let afterId: string | null = null;
      for (let index = 0; index < MAX_PAGES; index += 1) {
        const query: Array<[string, string]> = [["limit", "1000"]];
        if (afterId) query.push(["after_id", afterId]);
        const page = parse(apiKeysPageSchema, path, await get(path, query));
        keys.push(...page.data.map((key) => ({
          id: key.id,
          name: key.name ?? null,
          hint: key.partial_key_hint ?? null,
          status: key.status ?? null,
        })));
        if (!page.has_more || !page.last_id || page.last_id === afterId) {
          return keys;
        }
        afterId = page.last_id;
      }
      throw new AnthropicAdminApiError(`Anthropic Admin API ${path} paged past ${MAX_PAGES} pages`, null);
    },

    async costReport(startingAt) {
      const pages = await reportPages("/v1/organizations/cost_report", costPageSchema, [
        ["starting_at", startingAt.toISOString()],
        ["bucket_width", "1d"],
        ["group_by[]", "description"],
        ["limit", "31"],
      ]);
      return parseCostPages(pages);
    },

    async usageReport(startingAt) {
      const pages = await reportPages("/v1/organizations/usage_report/messages", usagePageSchema, [
        ["starting_at", startingAt.toISOString()],
        ["bucket_width", "1d"],
        ["group_by[]", "api_key_id"],
        ["group_by[]", "model"],
        ["limit", "31"],
      ]);
      return parseUsagePages(pages);
    },
  };
}

function errorDetail(text: string) {
  try {
    const body = JSON.parse(text) as { error?: { type?: unknown; message?: unknown } };
    const type = typeof body.error?.type === "string" ? body.error.type : null;
    const message = typeof body.error?.message === "string" ? body.error.message.slice(0, 200) : null;
    return type || message ? `: ${[type, message].filter(Boolean).join(" — ")}` : "";
  } catch {
    return "";
  }
}

/** A bucket's UTC day; a bucket that is not one whole UTC day is refused. */
function bucketDay(bucket: { starting_at: string; ending_at: string }) {
  const start = new Date(bucket.starting_at);
  const end = new Date(bucket.ending_at);
  if (Number.isNaN(start.getTime()) || start.getTime() % 86_400_000 !== 0 || end.getTime() - start.getTime() !== 86_400_000) {
    throw new AnthropicAdminApiError(`Anthropic Admin API answered a bucket that is not one UTC day (${bucket.starting_at})`, null);
  }
  return start.toISOString().slice(0, 10);
}

export function parseCostPages(pages: Array<z.infer<typeof costPageSchema>>) {
  const days = new Set<string>();
  const lines = new Map<string, AiProviderCostLineInput & { amounts: string[] }>();
  for (const bucket of pages.flatMap((page) => page.data)) {
    const day = bucketDay(bucket);
    days.add(day);
    for (const result of bucket.results) {
      if (result.currency !== "USD") {
        throw new AnthropicAdminApiError(`Anthropic cost report has a ${result.currency} amount; only USD is compared`, null);
      }
      const fields = {
        description: result.description ?? null,
        model: result.model ?? null,
        costType: result.cost_type ?? null,
        tokenType: result.token_type ?? null,
        serviceTier: result.service_tier ?? null,
        contextWindow: result.context_window ?? null,
        inferenceGeo: result.inference_geo ?? null,
        speed: result.speed ?? null,
      };
      const lineKey = Object.values(fields).map((value) => value ?? "").join("|");
      const existing = lines.get(`${day}|${lineKey}`);
      if (existing) {
        existing.amounts.push(result.amount);
      } else {
        lines.set(`${day}|${lineKey}`, { day, lineKey, ...fields, amountCents: result.amount, currency: "USD", amounts: [result.amount] });
      }
    }
  }
  return {
    days: [...days].sort(),
    lines: [...lines.values()].map(({ amounts, ...line }) => ({ ...line, amountCents: sumCentsDecimals(amounts) })),
  };
}

export function parseUsagePages(pages: Array<z.infer<typeof usagePageSchema>>) {
  const days = new Set<string>();
  const lines = new Map<string, AiProviderUsageLineInput>();
  for (const bucket of pages.flatMap((page) => page.data)) {
    const day = bucketDay(bucket);
    days.add(day);
    for (const result of bucket.results) {
      const apiKeyId = result.api_key_id ?? null;
      const model = result.model ?? "";
      const key = `${day}|${apiKeyId ?? ""}|${model}`;
      const line = lines.get(key) ?? {
        day,
        apiKeyId,
        model,
        uncachedInputTokens: 0,
        cacheReadInputTokens: 0,
        cacheWrite5mTokens: 0,
        cacheWrite1hTokens: 0,
        outputTokens: 0,
        webSearchRequests: 0,
      };
      line.uncachedInputTokens += result.uncached_input_tokens;
      line.cacheReadInputTokens += result.cache_read_input_tokens;
      line.cacheWrite5mTokens += result.cache_creation?.ephemeral_5m_input_tokens ?? 0;
      line.cacheWrite1hTokens += result.cache_creation?.ephemeral_1h_input_tokens ?? 0;
      line.outputTokens += result.output_tokens;
      line.webSearchRequests += result.server_tool_use?.web_search_requests ?? 0;
      lines.set(key, line);
    }
  }
  return { days: [...days].sort(), lines: [...lines.values()] };
}
