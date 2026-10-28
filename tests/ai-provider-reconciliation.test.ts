import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as DbModule from "@agency_hub_core/db";
import type { AiProviderReportSyncRow, HubAnthropicSpendRow } from "@agency_hub_core/db";

import { microUsdFromCents, sumCentsDecimals } from "../packages/shared/src/money.ts";
import { parseAnthropicAdminKeys } from "../packages/shared/src/config.ts";

const db = vi.hoisted(() => ({
  recordAiProviderReportAttempt: vi.fn(async () => undefined),
  recordAiProviderReportFailure: vi.fn(async () => undefined),
  saveAiProviderReports: vi.fn(async () => undefined),
}));
vi.mock("@agency_hub_core/db", async (importOriginal) => ({
  ...(await importOriginal<typeof DbModule>()),
  ...db,
}));

const { createAnthropicAdminClient } = await import("../apps/runtime/src/services/anthropic-admin-api.ts");
const { adminKeyFingerprint, syncAiProviderReports } = await import("../apps/runtime/src/services/ai-provider-reports.ts");
const {
  allocateMicroUsd,
  buildReconciliation,
  mapApiKeysToLabels,
  providerSpendSinceReading,
  splitOrgDay,
} = await import("../apps/runtime/src/services/ai-provider-reconciliation.ts");
const { balanceRunway } = await import("../apps/runtime/src/services/ai-provider-accounts-report.ts");

const ADMIN_KEY = "sk-ant-admin01-SECRETSECRETSECRET";

describe("Anthropic cents → micro-USD", () => {
  it("is ×10 000 per cent: \"123.78912\" cents is $1.2378912", () => {
    expect(microUsdFromCents(["123.78912"])).toBe(1_237_891);
    expect(microUsdFromCents(["100"])).toBe(1_000_000);
    expect(microUsdFromCents([])).toBe(0);
  });

  it("adds the lines exactly and rounds once, not line by line", () => {
    // Each line is 0.4 micro-USD: rounded alone each is 0, together 2.
    const lines = Array.from({ length: 5 }, () => "0.00004");
    expect(lines.map((line) => microUsdFromCents([line])).reduce((a, b) => a + b, 0)).toBe(0);
    expect(microUsdFromCents(lines)).toBe(2);
    expect(microUsdFromCents(["0.00005"])).toBe(1);
    expect(microUsdFromCents(["1.5", "-0.25"])).toBe(12_500);
  });

  it("sums cent strings exactly and refuses what is not a decimal", () => {
    expect(sumCentsDecimals(["0.1", "0.2", "10"])).toBe("10.3");
    expect(sumCentsDecimals(["1.005", "-2"])).toBe("-0.995");
    expect(() => microUsdFromCents(["1e3"])).toThrow(/Invalid cents amount/);
  });
});

describe("ANTHROPIC_ADMIN_KEYS", () => {
  it("lets labels of one organization share an admin key", () => {
    expect(parseAnthropicAdminKeys("main=sk-ant-admin-a, bukake=sk-ant-admin-a\noag=sk-ant-admin-b")).toEqual([
      { label: "main", adminKey: "sk-ant-admin-a" },
      { label: "bukake", adminKey: "sk-ant-admin-a" },
      { label: "oag", adminKey: "sk-ant-admin-b" },
    ]);
    expect(parseAnthropicAdminKeys(undefined)).toEqual([]);
  });

  it("refuses a malformed list or a repeated label without echoing a key", () => {
    expect(() => parseAnthropicAdminKeys("sk-ant-admin-secret")).toThrow(/ANTHROPIC_ADMIN_KEYS entries must use the format label=key/);
    expect(() => parseAnthropicAdminKeys("main=sk-ant-admin-secret main=sk-other")).toThrow("ANTHROPIC_ADMIN_KEYS repeats the label main");
    try {
      parseAnthropicAdminKeys("Main=sk-ant-admin-secret");
    } catch (error) {
      expect(String(error)).not.toContain("secret");
    }
  });
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function costResult(amount: string, model: string | null, tokenType: string | null) {
  return {
    amount, currency: "USD", description: model ? `${model} ${tokenType}` : "Web Search Usage",
    model, cost_type: model ? "tokens" : "web_search", token_type: tokenType, service_tier: model ? "standard" : null,
    context_window: model ? "0-200k" : null, inference_geo: model ? "global" : null, speed: model ? "standard" : null,
    workspace_id: null,
  };
}

function usageResult(apiKeyId: string | null, model: string, tokens: Partial<Record<string, number>>) {
  return {
    account_id: null, api_key_id: apiKeyId, model, workspace_id: null, service_tier: null, context_window: null,
    inference_geo: null, speed: null, service_account_id: null,
    uncached_input_tokens: tokens.input ?? 0,
    cache_read_input_tokens: tokens.read ?? 0,
    cache_creation: { ephemeral_5m_input_tokens: tokens.w5m ?? 0, ephemeral_1h_input_tokens: tokens.w1h ?? 0 },
    output_tokens: tokens.output ?? 0,
    server_tool_use: { web_search_requests: tokens.search ?? 0 },
  };
}

describe("the Admin API client", () => {
  it("pages the cost report by next_page and keeps the cents exact", async () => {
    const calls: Array<{ url: URL; headers: Record<string, string> }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const parsed = new URL(String(url));
      calls.push({ url: parsed, headers: init?.headers as Record<string, string> });
      if (!parsed.searchParams.get("page")) {
        return jsonResponse({
          data: [{
            starting_at: "2026-10-26T00:00:00Z", ending_at: "2026-10-27T00:00:00Z",
            results: [costResult("100.5", "claude-opus-5-5", "output_tokens"), costResult("0.25", null, null)],
          }],
          has_more: true, next_page: "page_2",
        });
      }
      return jsonResponse({
        data: [
          { starting_at: "2026-10-27T00:00:00Z", ending_at: "2026-10-28T00:00:00Z", results: [costResult("7.000001", "claude-opus-5-5", "output_tokens")] },
          { starting_at: "2026-10-28T00:00:00Z", ending_at: "2026-10-29T00:00:00Z", results: [] },
        ],
        has_more: false, next_page: null,
      });
    });
    const client = createAnthropicAdminClient({ adminKey: ADMIN_KEY, fetchImpl });
    const report = await client.costReport(new Date("2026-10-26T00:00:00Z"));

    expect(calls).toHaveLength(2);
    expect(calls[0]!.url.pathname).toBe("/v1/organizations/cost_report");
    expect(calls[0]!.url.searchParams.getAll("group_by[]")).toEqual(["description"]);
    expect(calls[0]!.url.searchParams.get("bucket_width")).toBe("1d");
    expect(calls[0]!.headers).toMatchObject({ "x-api-key": ADMIN_KEY, "anthropic-version": "2023-06-01" });
    expect(calls[1]!.url.searchParams.get("page")).toBe("page_2");
    // An empty day is still a day read: its costs are zero, not unknown.
    expect(report.days).toEqual(["2026-10-26", "2026-10-27", "2026-10-28"]);
    expect(report.lines.map((line) => [line.day, line.model, line.costType, line.amountCents])).toEqual([
      ["2026-10-26", "claude-opus-5-5", "tokens", "100.5"],
      ["2026-10-26", null, "web_search", "0.25"],
      ["2026-10-27", "claude-opus-5-5", "tokens", "7.000001"],
    ]);
  });

  it("pages the usage report and sums a key's tokens by kind", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const parsed = new URL(String(url));
      expect(parsed.pathname).toBe("/v1/organizations/usage_report/messages");
      expect(parsed.searchParams.getAll("group_by[]")).toEqual(["api_key_id", "model"]);
      const day = { starting_at: "2026-10-27T00:00:00Z", ending_at: "2026-10-28T00:00:00Z" };
      return parsed.searchParams.get("page")
        ? jsonResponse({ data: [{ ...day, results: [usageResult(null, "claude-opus-5-5", { input: 5 })] }], has_more: false, next_page: null })
        : jsonResponse({
          data: [{ ...day, results: [usageResult("apikey_1", "claude-opus-5-5", { input: 10, read: 20, w5m: 30, w1h: 40, output: 50, search: 2 })] }],
          has_more: true, next_page: "page_2",
        });
    });
    const report = await createAnthropicAdminClient({ adminKey: ADMIN_KEY, fetchImpl }).usageReport(new Date("2026-10-27T00:00:00Z"));
    expect(report.lines).toEqual([
      { day: "2026-10-27", apiKeyId: "apikey_1", model: "claude-opus-5-5", uncachedInputTokens: 10, cacheReadInputTokens: 20, cacheWrite5mTokens: 30, cacheWrite1hTokens: 40, outputTokens: 50, webSearchRequests: 2 },
      { day: "2026-10-27", apiKeyId: null, model: "claude-opus-5-5", uncachedInputTokens: 5, cacheReadInputTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, outputTokens: 0, webSearchRequests: 0 },
    ]);
  });

  it("pages the key list by last_id and keeps only hints", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const parsed = new URL(String(url));
      return parsed.searchParams.get("after_id") === "apikey_1"
        ? jsonResponse({ data: [{ id: "apikey_2", type: "api_key", name: "Bench", partial_key_hint: "sk-ant-api03-Zz...9q", status: "active" }], has_more: false, first_id: "apikey_2", last_id: "apikey_2" })
        : jsonResponse({ data: [{ id: "apikey_1", type: "api_key", name: "Hub", partial_key_hint: "sk-ant-api03-R2D...igAA", status: "active" }], has_more: true, first_id: "apikey_1", last_id: "apikey_1" });
    });
    expect(await createAnthropicAdminClient({ adminKey: ADMIN_KEY, fetchImpl }).apiKeys()).toEqual([
      { id: "apikey_1", name: "Hub", hint: "sk-ant-api03-R2D...igAA", status: "active" },
      { id: "apikey_2", name: "Bench", hint: "sk-ant-api03-Zz...9q", status: "active" },
    ]);
  });

  it("names Anthropic's refusal, never the key", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, 401));
    const error = await createAnthropicAdminClient({ adminKey: ADMIN_KEY, fetchImpl }).organization().catch((cause: unknown) => cause);
    expect(String(error)).toContain("/v1/organizations/me answered 401: authentication_error — invalid x-api-key");
    expect(String(error)).not.toContain(ADMIN_KEY);
  });

  it("refuses a bucket that is not one UTC day, and a currency other than USD", async () => {
    const bucket = (start: string, end: string, currency = "USD") => vi.fn(async () => jsonResponse({
      data: [{ starting_at: start, ending_at: end, results: [{ ...costResult("1", "claude-opus-5-5", "output_tokens"), currency }] }],
      has_more: false, next_page: null,
    }));
    const from = new Date("2026-10-27T00:00:00Z");
    await expect(createAnthropicAdminClient({ adminKey: ADMIN_KEY, fetchImpl: bucket("2026-10-27T00:00:00Z", "2026-10-27T01:00:00Z") }).costReport(from))
      .rejects.toThrow(/not one UTC day/);
    await expect(createAnthropicAdminClient({ adminKey: ADMIN_KEY, fetchImpl: bucket("2026-10-27T00:00:00Z", "2026-10-28T00:00:00Z", "EUR") }).costReport(from))
      .rejects.toThrow(/EUR/);
  });
});

describe("which API key is which account", () => {
  const labels = [
    { label: "main", apiKey: "sk-ant-api03-R2DxxxxxxxxxxigAA" },
    { label: "bukake", apiKey: "sk-ant-api03-K9pyyyyyyyyyy7Qw" },
  ];

  it("fits a listed key's hint to exactly one configured key", () => {
    const mapped = mapApiKeysToLabels({
      labels,
      listedKeys: [
        { id: "apikey_main", name: "hub", hint: "sk-ant-api03-R2D...igAA", status: "active" },
        { id: "apikey_bench", name: "bench", hint: "sk-ant-api03-Zz1...9q00", status: "active" },
      ],
      usedKeyIds: ["apikey_main", "apikey_bench"],
    });
    expect([...mapped]).toEqual([["apikey_main", "main"]]);
  });

  it("gives an organization's only used key to its only account when no hint is listed", () => {
    const one = [{ label: "oag", apiKey: "sk-ant-usr-abc" }];
    expect([...mapApiKeysToLabels({ labels: one, listedKeys: [], usedKeyIds: ["apikey_x", "apikey_x"] })])
      .toEqual([["apikey_x", "oag"]]);
    // Two accounts in the organization: the key could be either.
    expect(mapApiKeysToLabels({ labels, listedKeys: [], usedKeyIds: ["apikey_x"] }).size).toBe(0);
    // Two keys used: one of them is spend outside Hub, which is not known.
    expect(mapApiKeysToLabels({ labels: one, listedKeys: [], usedKeyIds: ["apikey_x", "apikey_y"] }).size).toBe(0);
    // The key is listed and its hint is another key's.
    expect(mapApiKeysToLabels({
      labels: one,
      listedKeys: [{ id: "apikey_x", name: "bench", hint: "sk-ant-api03-Zz1...9q00", status: "active" }],
      usedKeyIds: ["apikey_x"],
    }).size).toBe(0);
  });
});

describe("an organization's day between its keys", () => {
  it("allocates in proportion and always adds up", () => {
    expect(allocateMicroUsd(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocateMicroUsd(10, [0, 0])).toEqual([0, 0]);
  });

  it("gives a model's cost to the keys that used it, priced with Hub's catalog", () => {
    const split = splitOrgDay({
      costs: [
        { model: "claude-opus-5-5", amountCents: "300" },
        { model: "claude-haiku-4-5", amountCents: "50" },
        { model: null, amountCents: "1" },
        { model: "claude-sonnet-5-5", amountCents: "2" },
      ],
      usage: [
        // Opus: key A wrote 1M output ($20 list), key B 0.5M ($10): 2:1.
        { apiKeyId: "a", model: "claude-opus-5-5", uncachedInputTokens: 0, cacheReadInputTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, outputTokens: 1_000_000 },
        { apiKeyId: "b", model: "claude-opus-5-5", uncachedInputTokens: 0, cacheReadInputTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, outputTokens: 500_000 },
        { apiKeyId: "b", model: "claude-haiku-4-5", uncachedInputTokens: 100, cacheReadInputTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, outputTokens: 0 },
      ],
    });
    expect(split.totalMicroUsd).toBe(3_530_000);
    expect(split.shared).toBe(true);
    expect(Object.fromEntries(split.keys.get("a")!)).toEqual({ "claude-opus-5-5": 2_000_000, "": 6_667 });
    expect(Object.fromEntries(split.keys.get("b")!)).toEqual({ "claude-opus-5-5": 1_000_000, "claude-haiku-4-5": 500_000, "": 3_333 });
    // Sonnet cost with no key's Sonnet usage: no one to give it to.
    expect(split.unsplitMicroUsd).toBe(20_000);
  });
});

const NOW = new Date("2026-10-28T12:00:00Z");
const DAYS = ["2026-10-28", "2026-10-27", "2026-10-26", "2026-10-25"];

function sync(fingerprint: string, orgId: string, apiKeys: AiProviderReportSyncRow["apiKeys"] = []): AiProviderReportSyncRow {
  return {
    adminKeyFingerprint: fingerprint, orgId, orgName: `Org ${orgId}`, apiKeys,
    lastAttemptAt: NOW, lastSuccessAt: NOW, lastError: null, lastErrorAt: null,
  };
}

function hub(accountId: number, day: string, costMicroUsd: number): HubAnthropicSpendRow {
  return {
    accountId, day, model: "anthropic:claude-opus-5-5", requests: 10, costMicroUsd,
    inputTokens: 100, cacheReadTokens: 200, cacheWriteTokens: 300, cacheWrite5mTokens: 260, cacheWrite1hTokens: 40, outputTokens: 400,
  };
}

function opusUsage(orgId: string, day: string, apiKeyId: string | null, outputTokens: number) {
  return {
    orgId, day, apiKeyId, model: "claude-opus-5-5", uncachedInputTokens: 100, cacheReadInputTokens: 200,
    cacheWrite5mTokens: 250, cacheWrite1hTokens: 50, outputTokens, webSearchRequests: 0,
  };
}

const NO_INPUT = { uncachedInputTokens: 0, cacheReadInputTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0 };

describe("the reconciliation", () => {
  const accounts = [{ id: 1, label: "main" }, { id: 2, label: "bukake" }, { id: 3, label: "oag" }];
  const apiKeys = [
    { label: "main", apiKey: "sk-ant-api03-R2DxxxxxxxxxxigAA" },
    { label: "bukake", apiKey: "sk-ant-api03-K9pyyyyyyyyyy7Qw" },
    { label: "oag", apiKey: "sk-ant-usr-oagoagoag" },
  ];
  const shared = "sk-ant-admin-shared";
  const own = "sk-ant-admin-oag";
  const adminKeys = [
    { label: "main", adminKey: shared },
    { label: "bukake", adminKey: shared },
    { label: "oag", adminKey: own },
  ];
  const syncs = [
    sync(adminKeyFingerprint(shared), "org_shared", [
      { id: "k_main", name: "hub main", hint: "sk-ant-api03-R2D...igAA", status: "active" },
      { id: "k_bukake", name: "hub bukake", hint: "sk-ant-api03-K9p...7Qw", status: "active" },
      { id: "k_bench", name: "bench", hint: "sk-ant-api03-Zz1...9q00", status: "active" },
    ]),
    sync(adminKeyFingerprint(own), "org_oag"),
  ];
  const reports = {
    days: ["2026-10-28", "2026-10-27", "2026-10-26"].flatMap((day) => [
      { orgId: "org_shared", day, fetchedAt: NOW },
      { orgId: "org_oag", day, fetchedAt: NOW },
    ]),
    costs: [
      // oag alone in its org: $10.00 billed on the 26th.
      { orgId: "org_oag", day: "2026-10-26", model: "claude-opus-5-5", amountCents: "1000" },
      { orgId: "org_oag", day: "2026-10-28", model: "claude-opus-5-5", amountCents: "100" },
      // Shared org: $6.00 between main (2/3 of the tokens) and the bench key (1/3).
      { orgId: "org_shared", day: "2026-10-26", model: "claude-opus-5-5", amountCents: "600" },
    ],
    usage: [
      opusUsage("org_oag", "2026-10-26", "k_oag", 500_000),
      opusUsage("org_oag", "2026-10-28", "k_oag", 50_000),
      { ...opusUsage("org_shared", "2026-10-26", "k_main", 200_000), ...NO_INPUT },
      { ...opusUsage("org_shared", "2026-10-26", "k_bench", 100_000), ...NO_INPUT },
    ],
  };
  const build = (overrides: Partial<Parameters<typeof buildReconciliation>[0]> = {}) => buildReconciliation({
    now: NOW, days: DAYS, accounts, apiKeys, adminKeys, syncs, reports,
    hub: [hub(3, "2026-10-26", 10_050_000), hub(1, "2026-10-26", 3_900_000), hub(3, "2026-10-28", 990_000), hub(2, "2026-10-26", 0)],
    ...overrides,
  });
  const row = (result: ReturnType<typeof build>, label: string, day: string) =>
    result.rows.find((candidate) => candidate.label === label && candidate.day === day)!;

  it("matches an account alone in its organization within ±1%", () => {
    const oag = row(build(), "oag", "2026-10-26");
    expect(oag).toMatchObject({
      status: "ok", hubMicroUsd: 10_050_000, providerMicroUsd: 10_000_000, diffMicroUsd: 50_000, diffPct: 0.5, split: false,
    });
    expect(oag.models).toEqual([{
      model: "claude-opus-5-5",
      hub: { requests: 10, costMicroUsd: 10_050_000, inputTokens: 100, cacheReadTokens: 200, cacheWriteTokens: 300, cacheWrite5mTokens: 260, cacheWrite1hTokens: 40, outputTokens: 400 },
      provider: { costMicroUsd: 10_000_000, inputTokens: 100, cacheReadTokens: 200, cacheWriteTokens: 300, cacheWrite5mTokens: 250, cacheWrite1hTokens: 50, outputTokens: 500_000, webSearchRequests: 0 },
    }]);
  });

  it("splits a shared organization's bill and shows the key outside Hub on its own line", () => {
    const result = build();
    const main = row(result, "main", "2026-10-26");
    expect(main).toMatchObject({ providerMicroUsd: 4_000_000, hubMicroUsd: 3_900_000, diffPct: -2.5, status: "mismatch", split: true });
    expect(row(result, "bukake", "2026-10-26")).toMatchObject({ providerMicroUsd: 0, status: "ok" });
    expect(result.otherKeys).toEqual([{
      day: "2026-10-26", orgId: "org_shared", orgName: "Org org_shared", kind: "key", apiKeyId: "k_bench",
      keyName: "bench", keyHint: "sk-ant-api03-Zz1...9q00", providerMicroUsd: 2_000_000, open: false,
    }]);
  });

  it("keeps today and yesterday open, a day never read not synced, an account without an admin key apart", () => {
    const result = build({ adminKeys: adminKeys.filter((entry) => entry.label !== "bukake") });
    expect(row(result, "oag", "2026-10-28")).toMatchObject({ status: "open", providerMicroUsd: 1_000_000, diffMicroUsd: -10_000 });
    expect(row(result, "oag", "2026-10-27")).toMatchObject({ status: "open", providerMicroUsd: 0 });
    expect(row(result, "oag", "2026-10-25")).toMatchObject({ status: "not_synced", providerMicroUsd: null, diffMicroUsd: null });
    expect(row(result, "bukake", "2026-10-26")).toMatchObject({ status: "no_admin_key", providerMicroUsd: null });
    expect(result.syncs.map((entry) => entry.labels)).toEqual([["main"], ["oag"]]);
  });

  it("is not synced while the admin key's organization was never read", () => {
    const result = build({ syncs: [sync(adminKeyFingerprint(shared), "org_shared")] });
    expect(row(result, "oag", "2026-10-26")).toMatchObject({ status: "not_synced", providerMicroUsd: null });
  });

  it("calls a gap under 1% ok and over 1% a mismatch", () => {
    const at = (hubMicroUsd: number) => row(build({ hub: [hub(3, "2026-10-26", hubMicroUsd)] }), "oag", "2026-10-26").status;
    expect(at(10_100_000)).toBe("ok");
    expect(at(10_100_001)).toBe("mismatch");
    expect(at(9_899_000)).toBe("mismatch");
  });
});

describe("the balance runway", () => {
  it("dates the day the balance runs out at the pace", () => {
    expect(balanceRunway({ estimatedMicroUsd: 15_000_000, dailyBurnMicroUsd: 10_000_000, now: NOW }))
      .toEqual({ daysLeft: 1.5, runsOutAt: "2026-10-30T00:00:00.000Z" });
    expect(balanceRunway({ estimatedMicroUsd: 15_000_000, dailyBurnMicroUsd: 0, now: NOW }))
      .toEqual({ daysLeft: null, runsOutAt: null });
  });

  it("prorates the reading's day by Hub's spend after the reading", () => {
    const rows = [
      { day: "2026-10-26", hubMicroUsd: 4_000_000, providerMicroUsd: 4_400_000 },
      { day: "2026-10-27", hubMicroUsd: 2_000_000, providerMicroUsd: 2_100_000 },
      { day: "2026-10-28", hubMicroUsd: 1_000_000, providerMicroUsd: 1_000_000 },
    ];
    // Of Hub's $4 on the 26th, $1 came after the reading: a quarter of Anthropic's $4.40.
    expect(providerSpendSinceReading({ readAt: new Date("2026-10-26T18:00:00Z"), now: NOW, rows, hubSpentSinceMicroUsd: 4_000_000 }))
      .toBe(1_100_000 + 2_100_000 + 1_000_000);
    // No Hub spend on the reading's day: the clock decides (6 h of 24 left).
    expect(providerSpendSinceReading({
      readAt: new Date("2026-10-26T18:00:00Z"), now: NOW, hubSpentSinceMicroUsd: 3_000_000,
      rows: rows.map((entry) => (entry.day === "2026-10-26" ? { ...entry, hubMicroUsd: 0 } : entry)),
    })).toBe(1_100_000 + 2_100_000 + 1_000_000);
    // A reading taken today with no Hub spend yet: what the key billed before
    // it is not after it. Taken now, nothing is; taken at 06:00, half of the
    // 12 hours the report covers so far.
    const today = [{ day: "2026-10-28", hubMicroUsd: 0, providerMicroUsd: 10_000_000 }];
    expect(providerSpendSinceReading({ readAt: NOW, now: NOW, hubSpentSinceMicroUsd: 0, rows: today })).toBe(0);
    expect(providerSpendSinceReading({ readAt: new Date("2026-10-28T06:00:00Z"), now: NOW, hubSpentSinceMicroUsd: 0, rows: today }))
      .toBe(5_000_000);
    // A day missing from the reports: no provider estimate.
    expect(providerSpendSinceReading({
      readAt: new Date("2026-10-26T18:00:00Z"), now: NOW, hubSpentSinceMicroUsd: 4_000_000,
      rows: rows.map((entry) => (entry.day === "2026-10-27" ? { ...entry, providerMicroUsd: null } : entry)),
    })).toBeNull();
  });
});

describe("the hourly sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads each organization once, and one failure stops no other", async () => {
    const logger = { warn: vi.fn(), info: vi.fn() };
    const client = (orgId: string | null) => ({
      organization: vi.fn(async () => {
        if (!orgId) throw new Error("Anthropic Admin API /v1/organizations/me answered 401");
        return { id: orgId, name: orgId };
      }),
      apiKeys: vi.fn(async () => []),
      costReport: vi.fn(async () => ({ days: ["2026-10-27", "2026-10-28"], lines: [] })),
      usageReport: vi.fn(async () => ({ days: ["2026-10-28"], lines: [] })),
    });
    const clients = new Map([["sk-a", client("org_1")], ["sk-bad", client(null)], ["sk-a2", client("org_1")]]);
    const app = {
      db: {} as never,
      logger: logger as never,
      config: { anthropicAdminKeys: [
        { label: "main", adminKey: "sk-a" },
        { label: "bukake", adminKey: "sk-a" },
        { label: "oag", adminKey: "sk-bad" },
        { label: "other", adminKey: "sk-a2" },
      ] } as never,
    };
    const results = await syncAiProviderReports(app, { now: NOW, days: 2, clientFor: (key) => clients.get(key)! });

    expect(results.map((result) => [result.labels, result.orgId, result.days, result.error])).toEqual([
      [["main", "bukake"], "org_1", 2, null],
      [["oag"], null, 0, "Anthropic Admin API /v1/organizations/me answered 401"],
      [["other"], "org_1", 2, null],
    ]);
    expect(clients.get("sk-a")!.costReport).toHaveBeenCalledWith(new Date("2026-10-27T00:00:00Z"));
    expect(clients.get("sk-a2")!.costReport).not.toHaveBeenCalled();
    expect(db.saveAiProviderReports).toHaveBeenCalledTimes(2);
    expect(db.saveAiProviderReports.mock.calls[0]).toEqual([app.db, expect.objectContaining({
      fingerprint: adminKeyFingerprint("sk-a"), orgId: "org_1", days: ["2026-10-27", "2026-10-28"],
    })]);
    expect(db.recordAiProviderReportFailure).toHaveBeenCalledWith(app.db, expect.objectContaining({
      fingerprint: adminKeyFingerprint("sk-bad"), error: "Anthropic Admin API /v1/organizations/me answered 401",
    }));
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("sk-bad");
  });
});
