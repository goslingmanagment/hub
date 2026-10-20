import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as DbModule from "@agency_hub_core/db";
import type { AiProviderAccountRow } from "@agency_hub_core/db";

import type { AiGatewayProviderInput } from "../apps/runtime/src/services/ai-gateway.ts";
import {
  classifyAnthropicAccountFailure,
  createAnthropicAiGatewayProvider,
  type AnthropicGatewayClient,
} from "../apps/runtime/src/services/ai-gateway-anthropic-provider.ts";
import type {
  AiProviderAccountCandidate,
  AnthropicAccountPool,
} from "../apps/runtime/src/services/ai-provider-account-pool.ts";
import type * as IncidentsModule from "../apps/runtime/src/services/notification-incidents.ts";
import { anthropicKeyPoolEntries, parseAnthropicApiKeys } from "../packages/shared/src/config.ts";

const db = vi.hoisted(() => ({
  syncAiProviderAccounts: vi.fn(async () => undefined),
  listAiProviderAccounts: vi.fn(async (): Promise<AiProviderAccountRow[]> => []),
  claimAiProviderAccountProbe: vi.fn(async () => true),
  markAiProviderAccountUnavailable: vi.fn(async (): Promise<string | null> => "active"),
  markAiProviderAccountServing: vi.fn(async (): Promise<string | null> => "active"),
}));
const incidents = vi.hoisted(() => ({
  openCriticalNotificationIncident: vi.fn(async () => true),
  resolveCriticalNotificationIncident: vi.fn(async () => undefined),
}));

vi.mock("@agency_hub_core/db", async (importOriginal) => ({
  ...(await importOriginal<typeof DbModule>()),
  ...db,
}));
vi.mock("../apps/runtime/src/services/notification-incidents.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof IncidentsModule>()),
  ...incidents,
}));

const { createAnthropicAccountPool } = await import("../apps/runtime/src/services/ai-provider-account-pool.ts");

// The SDK is a runtime-package dependency (and import-banned outside the
// gateway provider); resolve it the way the runtime does, only to build errors.
const Anthropic = (await import(
  pathToFileURL(path.resolve("apps/runtime/node_modules/@anthropic-ai/sdk/index.mjs")).href
) as { default: { APIError: { generate(status: number, body: unknown, message: string, headers: Headers): Error } } }).default;

const LOW_CREDIT = "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.";

function apiError(status: number, type: string, message: string) {
  return Anthropic.APIError.generate(status, { type: "error", error: { type, message } }, message, new Headers());
}

describe("ANTHROPIC_API_KEYS", () => {
  it("keeps the accounts in the order given, comma- or line-separated", () => {
    expect(parseAnthropicApiKeys("main=sk-a, second=sk-b\nthird=sk-c")).toEqual([
      { label: "main", apiKey: "sk-a" },
      { label: "second", apiKey: "sk-b" },
      { label: "third", apiKey: "sk-c" },
    ]);
    expect(parseAnthropicApiKeys(undefined)).toEqual([]);
  });

  it("refuses to boot on a malformed list instead of dropping an account", () => {
    expect(() => parseAnthropicApiKeys("sk-only")).toThrow(/label=key/);
    expect(() => parseAnthropicApiKeys("Main=sk-a")).toThrow(/label=key/);
    expect(() => parseAnthropicApiKeys("main=")).toThrow(/label=key/);
    expect(() => parseAnthropicApiKeys("main=sk-a,main=sk-b")).toThrow(/repeats the label main/);
    expect(() => parseAnthropicApiKeys("main=sk-a,second=sk-a")).toThrow(/another label/);
  });

  it("falls back to the single ANTHROPIC_API_KEY as the account `default`", () => {
    expect(anthropicKeyPoolEntries({ anthropicApiKeys: [], anthropicApiKey: "sk-x" }))
      .toEqual([{ label: "default", apiKey: "sk-x" }]);
    expect(anthropicKeyPoolEntries({ anthropicApiKeys: [{ label: "main", apiKey: "sk-a" }], anthropicApiKey: "sk-x" }))
      .toEqual([{ label: "main", apiKey: "sk-a" }]);
    expect(anthropicKeyPoolEntries({ anthropicApiKey: null })).toEqual([]);
  });
});

describe("account-level refusals", () => {
  it.each([
    ["the production low-credit 400", apiError(400, "invalid_request_error", LOW_CREDIT), "credit_exhausted"],
    ["a reworded low-credit 400", apiError(400, "invalid_request_error", "Your credit balance is too low. Add credits."), "credit_exhausted"],
    ["a 402 billing_error", apiError(402, "billing_error", "Billing problem"), "credit_exhausted"],
    ["an unknown key (401)", apiError(401, "authentication_error", "invalid x-api-key"), "key_invalid"],
    ["a refusal by policy (403)", apiError(403, "permission_error", "not allowed"), null],
    ["a rate limit (429)", apiError(429, "rate_limit_error", "slow down"), null],
    ["an overload (529)", apiError(529, "overloaded_error", "overloaded"), null],
    ["another 400", apiError(400, "invalid_request_error", "The request body is invalid."), null],
  ] as const)("%s", (_name, error, expected) => {
    expect(classifyAnthropicAccountFailure(error)).toBe(expected);
  });
});

function providerInput(overrides: Partial<AiGatewayProviderInput> = {}): AiGatewayProviderInput {
  return {
    requestId: randomUUID(),
    principal: {
      authMethod: "device_token",
      user: { id: 7, username: "chatter", role: "chatter", mustChangePassword: false, assignedPages: [] },
      assignedPageIds: [11],
    },
    page: {
      id: 11,
      label: "lora-of",
      platform: "onlyfans",
      proxy: { url: "socks5://proxy.example:1080", username: "u", password: "p" },
      egressKey: "socks5://proxy.example:1080",
    },
    body: {
      clientRequestId: randomUUID(),
      feature: "fast-reply",
      pageLabel: "lora-of",
      platform: "onlyfans",
      platformUserId: "123",
      model: "anthropic:claude-sonnet-4-6",
      reasoningEffort: "off",
      isRegeneration: false,
      prompt: { systemBlocks: [{ text: "system", cache: "none" }], userBlocks: [{ text: "user", cache: "none" }] },
    },
    quota: { accepted: true, remainingRequestsToday: 10, remainingMicroUsdToday: 1_000_000 },
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function* okEvents() {
  yield { type: "message_start", message: { id: "msg_1", usage: { input_tokens: 5, output_tokens: 0 } } };
  yield { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } };
  yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 5, output_tokens: 1 } };
}

async function collect<T>(items: AsyncIterable<T>) {
  const out: T[] = [];
  for await (const item of items) out.push(item);
  return out;
}

function fakePool(accounts: AiProviderAccountCandidate[]) {
  return {
    labels: accounts.map((account) => account.label),
    ensureRegistered: vi.fn(async () => undefined),
    invalidate: vi.fn(),
    candidates: vi.fn(async () => accounts),
    reportRefusal: vi.fn(async () => undefined),
    reportServed: vi.fn(async () => undefined),
  } satisfies AnthropicAccountPool;
}

const MAIN = { id: 1, label: "main", apiKey: "sk-main" };
const SECOND = { id: 2, label: "second", apiKey: "sk-second" };

describe("the gateway over the account pool", () => {
  function providerWith(behaviour: Record<string, () => unknown>, pool: AnthropicAccountPool) {
    const calls: string[] = [];
    const provider = createAnthropicAiGatewayProvider({
      accountPool: pool,
      createAccountClient: (apiKey): AnthropicGatewayClient => ({
        messages: {
          async create() {
            calls.push(apiKey);
            return behaviour[apiKey]!() as AsyncIterable<unknown>;
          },
        },
      }),
    });
    return { provider, calls };
  }

  it("moves to the next account when one is out of credit, and names the one that served", async () => {
    const pool = fakePool([MAIN, SECOND]);
    const { provider, calls } = providerWith({
      "sk-main": () => { throw apiError(400, "invalid_request_error", LOW_CREDIT); },
      "sk-second": () => okEvents(),
    }, pool);
    const served: number[] = [];

    const frames = await collect(provider.stream(providerInput({ onProviderAccount: (id) => served.push(id) })));

    expect(calls).toEqual(["sk-main", "sk-second"]);
    expect(frames.some((frame) => frame.type === "content_delta")).toBe(true);
    expect(served).toEqual([2]);
    expect(pool.reportRefusal).toHaveBeenCalledWith(MAIN, "credit_exhausted", { providerHttpStatus: 400 });
    expect(pool.reportServed).toHaveBeenCalledWith(SECOND);
  });

  it("moves on from a key Anthropic does not know (401)", async () => {
    const pool = fakePool([MAIN, SECOND]);
    const { provider, calls } = providerWith({
      "sk-main": () => { throw apiError(401, "authentication_error", "invalid x-api-key"); },
      "sk-second": () => okEvents(),
    }, pool);

    await collect(provider.stream(providerInput()));

    expect(calls).toEqual(["sk-main", "sk-second"]);
    expect(pool.reportRefusal).toHaveBeenCalledWith(MAIN, "key_invalid", { providerHttpStatus: 401 });
  });

  it.each([
    ["a rate limit", () => apiError(429, "rate_limit_error", "slow down")],
    ["a refusal by policy", () => apiError(403, "permission_error", "not allowed")],
    ["an overload", () => apiError(529, "overloaded_error", "overloaded")],
  ])("stays on the account after %s", async (_name, error) => {
    const pool = fakePool([MAIN, SECOND]);
    const { provider, calls } = providerWith({
      "sk-main": () => { throw error(); },
      "sk-second": () => okEvents(),
    }, pool);

    await expect(collect(provider.stream(providerInput()))).rejects.toMatchObject({ name: "AiProviderFailureError" });
    expect(calls).toEqual(["sk-main"]);
    expect(pool.reportRefusal).not.toHaveBeenCalled();
  });

  it("fails with the last refusal when every account is out of credit", async () => {
    const pool = fakePool([MAIN, SECOND]);
    const { provider, calls } = providerWith({
      "sk-main": () => { throw apiError(400, "invalid_request_error", LOW_CREDIT); },
      "sk-second": () => { throw apiError(400, "invalid_request_error", LOW_CREDIT); },
    }, pool);

    await expect(collect(provider.stream(providerInput()))).rejects.toMatchObject({
      name: "AiProviderFailureError",
      providerHttpStatus: 400,
    });
    expect(calls).toEqual(["sk-main", "sk-second"]);
    expect(pool.reportRefusal).toHaveBeenCalledTimes(2);
  });
});

function accountRow(overrides: Partial<AiProviderAccountRow> & Pick<AiProviderAccountRow, "id" | "label" | "priority">): AiProviderAccountRow {
  return {
    provider: "anthropic",
    enabled: true,
    status: "active",
    statusReason: null,
    statusChangedAt: null,
    nextProbeAt: null,
    keyFingerprint: null,
    keyHint: null,
    lastSuccessAt: null,
    balanceSnapshotMicroUsd: null,
    balanceSnapshotAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

describe("the account pool's order", () => {
  const NOW = new Date("2026-10-18T12:00:00.000Z");
  const entries = [
    { label: "main", apiKey: "sk-main" },
    { label: "second", apiKey: "sk-second" },
    { label: "third", apiKey: "sk-third" },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function pool() {
    return createAnthropicAccountPool({ db: {} as never, logger: { warn: vi.fn() }, entries, now: () => NOW })!;
  }

  it("spends active accounts by priority, exhausted ones last, never disabled, invalid or unconfigured ones", async () => {
    db.listAiProviderAccounts.mockResolvedValueOnce([
      accountRow({ id: 1, label: "main", priority: 1, status: "exhausted", nextProbeAt: new Date(NOW.getTime() + 60_000) }),
      accountRow({ id: 2, label: "second", priority: 2 }),
      accountRow({ id: 3, label: "third", priority: 3 }),
      accountRow({ id: 4, label: "gone", priority: 0 }),
    ]);

    expect((await pool().candidates()).map((account) => account.label)).toEqual(["second", "third", "main"]);
    expect(db.claimAiProviderAccountProbe).not.toHaveBeenCalled();

    db.listAiProviderAccounts.mockResolvedValueOnce([
      accountRow({ id: 1, label: "main", priority: 1, status: "invalid" }),
      accountRow({ id: 2, label: "second", priority: 2, enabled: false }),
      accountRow({ id: 3, label: "third", priority: 3 }),
    ]);
    expect((await pool().candidates()).map((account) => account.apiKey)).toEqual(["sk-third"]);
  });

  it("puts an exhausted account above the first active one first when its hourly probe is won", async () => {
    db.listAiProviderAccounts.mockResolvedValue([
      accountRow({ id: 1, label: "main", priority: 1, status: "exhausted", nextProbeAt: new Date(NOW.getTime() - 1) }),
      accountRow({ id: 2, label: "second", priority: 2 }),
    ]);
    db.claimAiProviderAccountProbe.mockResolvedValueOnce(true);
    expect((await pool().candidates()).map((account) => account.label)).toEqual(["main", "second"]);

    db.claimAiProviderAccountProbe.mockResolvedValueOnce(false);
    expect((await pool().candidates()).map((account) => account.label)).toEqual(["second", "main"]);
  });
});
