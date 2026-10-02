import { describe, expect, it } from "vitest";

import { PlatformAccountIdentityConflictError, PlatformAccountIdentityImmutableError, type Database, type SyncPageRow } from "@agency_hub_core/db";
import { FanslySendRefusedError } from "@agency_hub_core/fansly";

import { FANSLY_SEND_HOLDER_ROLES } from "../apps/runtime/src/services/fansly-send-guard/os-probe.ts";
import { CapturePayloadUnavailableError } from "../apps/runtime/src/services/payload-reader.ts";
import { WrongTransactionsWriterError } from "../apps/runtime/src/services/transactions-writer-gate.ts";
import { pickExclusions } from "../apps/runtime/src/sync/engine/actor.ts";
import {
  ApplyDeferred,
  applyErrorScope,
  classifyApplyError,
  deferredRetryInMs,
  errorName,
  FanslyContractViolationError,
  RATE_LIMIT_LOOKBACK_MS,
  requestJsonOf,
} from "../apps/runtime/src/sync/engine/commit.ts";
import {
  escalateResourceHold,
  onOutcome,
  RATE_LIMIT_LADDER_RESET_MS,
  RESOURCE_HOLD_LADDER_MS,
  type OutcomeClass,
  type OutcomeInput,
} from "../apps/runtime/src/sync/engine/errors.ts";
import { REQUEST_TIMEOUT_MS, SEND_WINDOW_MS } from "../apps/runtime/src/sync/engine/pacer.ts";
import { systemClock } from "../apps/runtime/src/sync/engine/ports.ts";
import {
  createEngineRegistry,
  demandToUpsert,
  nextPollDueAt,
  NOT_IMPLEMENTED_RECHECK_MS,
  pollsFor,
  type EngineResourceSpec,
  type ResourceModule,
} from "../apps/runtime/src/sync/engine/resource.ts";
import { createLegacyShadowLatency, fixedShadowLatency, SHADOW_DEFAULT_LATENCY_MS, ShadowTransport } from "../apps/runtime/src/sync/engine/shadow.ts";
import { FANSLY_RESOURCE_SPECS } from "../apps/runtime/src/sync/fansly/registry.ts";
import { changeSyncRegistryOverride, SyncOwnerLeverError } from "../apps/runtime/src/sync/inspect.ts";
import { RecordingMetrics } from "./helpers/sync-engine-host.ts";

// The pure parts of the engine host (design §3.5–§3.7, §4.1–§4.2): the
// registry rules every entry shares, what a pick leaves out, how apply errors
// are classified, and the shadow transport.

const noop: ResourceModule = {
  plan: async () => ({ kind: "done", reason: "test" }),
  apply: async () => ({ work: { satisfiesRevision: true }, followups: [] }),
  shadow: async () => ({ work: { satisfiesRevision: true }, followups: [] }),
};

function spec(key: string, overrides: Partial<EngineResourceSpec> = {}): EngineResourceSpec {
  return { key, kind: "trigger", class: "urgent", http: true, evidence: false, fence: "none", module: async () => noop, ...overrides };
}

function page(overrides: Partial<SyncPageRow> = {}): SyncPageRow {
  return {
    registryOverrides: {},
    pausedResources: [],
    resourceHolds: {},
    ...overrides,
  } as SyncPageRow;
}

const NOW = new Date("2026-10-02T12:00:00Z");

describe("the registry rules", () => {
  it("refuses malformed or duplicate keys and polls without a period", () => {
    expect(() => createEngineRegistry([spec("NoDot")])).toThrow(/Not a sync resource key/);
    expect(() => createEngineRegistry([spec("a.b"), spec("a.b")])).toThrow(/Duplicate/);
    expect(() => createEngineRegistry([spec("a.poll", { kind: "poll" })])).toThrow(/positive period/);
  });

  it("a key without a module waits on its dependency and counts not_implemented", async () => {
    const metrics = new RecordingMetrics();
    const registry = createEngineRegistry([], { metrics });
    const module = await registry.module("purchases.targets");
    const plan = await module.plan({} as never, { now: NOW } as never);
    expect(plan).toEqual({ kind: "wait", reason: "dependency", until: new Date(NOW.getTime() + NOT_IMPLEMENTED_RECHECK_MS) });
    expect(metrics.get("sync_not_implemented")).toBe(1);
  });

  it("every entry of the Fansly table has its code since S3-04 (sync-registry-coverage pins the rest)", () => {
    expect(FANSLY_RESOURCE_SPECS.filter((entry) => entry.module === undefined).map((entry) => entry.key)).toEqual([]);
    expect(FANSLY_RESOURCE_SPECS.find((entry) => entry.key === "subscribers.poll")?.module).toBeTypeOf("function");
  });

  it("polls: live-only entries never in shadow, the page's period override, a switched-off key", () => {
    const registry = createEngineRegistry([
      spec("subscribers.poll", { kind: "poll", class: "planned", period: { everyMs: 3_600_000 } }),
      spec("stats.daily", { kind: "poll", class: "planned", period: { everyMs: 86_400_000 } }),
      spec("ws.connect", { kind: "poll", class: "urgent", period: { everyMs: 60_000 }, liveOnly: true }),
      spec("dm-messages.head"),
    ]);
    const overridden = page({ registryOverrides: { "subscribers.poll": { everyMs: 1_800_000 }, "stats.daily": { enabled: false } } });
    expect(pollsFor(registry, overridden, true)).toEqual([{ resource: "subscribers.poll", class: "planned", everyMs: 1_800_000 }]);
    expect(pollsFor(registry, page(), false).map((poll) => poll.resource)).toEqual(["subscribers.poll", "stats.daily", "ws.connect"]);
  });

  it("a poll is due again after its period ± 10 %", () => {
    const poll = spec("subscribers.poll", { kind: "poll", class: "planned", period: { everyMs: 1_000_000 } });
    expect(nextPollDueAt(poll, page(), NOW, 0)!.getTime() - NOW.getTime()).toBe(900_000);
    expect(nextPollDueAt(poll, page(), NOW, 0.5)!.getTime() - NOW.getTime()).toBe(1_000_000);
    expect(nextPollDueAt(poll, page(), NOW, 0.999_999)!.getTime() - NOW.getTime()).toBeLessThanOrEqual(1_100_000);
    expect(nextPollDueAt(spec("a.b"), page(), NOW, 0.5)).toBeNull();
  });

  it("a demand becomes its work row: coalescing window, deadline, the entry's kind and class", () => {
    const head = spec("dm-messages.head", {
      coalesce: { quietMs: 5_000, maxMs: 20_000, extendOnSignal: true, fast: { quietMs: 2_000, maxMs: 6_000 } },
      slo: { resultMs: 30_000 },
    });
    expect(demandToUpsert({ resource: head.key, subject: "g1", demand: { messageIds: ["m1"], reason: "ws" } }, head,
      { pageId: 7, shadow: true, now: NOW })).toEqual({
      pageId: 7,
      shadow: true,
      resource: "dm-messages.head",
      subject: "g1",
      kind: "trigger",
      class: "urgent",
      dueAt: new Date(NOW.getTime() + 5_000),
      coalesceUntil: new Date(NOW.getTime() + 20_000),
      deadlineAt: new Date(NOW.getTime() + 30_000),
      extendOnSignal: true,
      demand: { messageIds: ["m1"], txIds: [], reasons: ["ws"] },
    });
    const fast = demandToUpsert({ resource: head.key, coalesce: "fast" }, head, { pageId: 7, shadow: false, now: NOW })!;
    expect([fast.dueAt, fast.coalesceUntil]).toEqual([new Date(NOW.getTime() + 2_000), new Date(NOW.getTime() + 6_000)]);
    const download = spec("media-download.fetch", { liveOnly: true });
    expect(demandToUpsert({ resource: download.key }, download, { pageId: 7, shadow: true, now: NOW })).toBeNull();
    expect(demandToUpsert({ resource: head.key }, head, {
      pageId: 7, shadow: false, now: NOW, page: page({ registryOverrides: { "dm-messages.head": { enabled: false } } }),
    })).toBeNull();
  });
});

describe("what a pick leaves out", () => {
  const registry = createEngineRegistry([
    spec("dm-messages.head"),
    spec("dm-messages.catchup", { class: "planned" }),
    spec("media-stats.walk", { class: "planned", kind: "goal" }),
    spec("media-download.fetch", { liveOnly: true }),
  ]);
  const later = new Date(NOW.getTime() + 60_000).toISOString();

  it("paused and switched-off keys, live-only keys in shadow", () => {
    const exclusions = pickExclusions(page({
      pausedResources: ["media-stats.walk"],
      registryOverrides: { "dm-messages.catchup": { enabled: false } },
    }), registry, true, NOW);
    expect(exclusions).toEqual({
      excludeResources: ["dm-messages.catchup", "media-download.fetch", "media-stats.walk"],
      excludeFiles: [],
      excludeClasses: [],
    });
  });

  it("the owner's requests pause: the whole requests class (the idle wait must not count it as due)", () => {
    expect(pickExclusions(page({ pausedRequests: true }), registry, false, NOW).excludeClasses).toEqual(["requests"]);
  });

  it("a held file, but never the key a hold does not stop (dm-messages.head)", () => {
    const exclusions = pickExclusions(page({
      resourceHolds: {
        "media-stats": { until: later, step: 1, since: NOW.toISOString() },
        "dm-messages": { until: later, step: 1, since: NOW.toISOString() },
        "posts": { until: new Date(NOW.getTime() - 1).toISOString(), step: 1, since: NOW.toISOString() },
      },
    }), registry, false, NOW);
    expect(exclusions).toEqual({ excludeResources: ["dm-messages.catchup"], excludeFiles: ["media-stats"], excludeClasses: [] });
  });
});

function wrongWriter(): WrongTransactionsWriterError {
  return new WrongTransactionsWriterError({ platformAccountId: 7, attemptedWriter: "fansly", assignedWriter: "ofapi" });
}

describe("apply errors (design §3.7.3)", () => {
  const sqlError = (code: string) => Object.assign(new Error("driver text with SQL and parameters"), { code });

  it.each([
    ["a typed deferral", new ApplyDeferred("erasure_busy"), "deferred"],
    ["an unreadable journal body", new CapturePayloadUnavailableError({
      envelope: "observation", envelopeId: 1, bucketMonth: "2026-10-01", objectId: 2, reason: "missing" as never, readMode: "serve",
    }), "deferred"],
    ["a unique violation", sqlError("23505"), "deterministic"],
    ["a data exception", sqlError("22P02"), "deterministic"],
    ["a contract violation", new FanslyContractViolationError("response", "no id"), "deterministic"],
    ["an identity change", new PlatformAccountIdentityImmutableError("lora-1", "1", "2"), "deterministic"],
    ["an identity conflict", new PlatformAccountIdentityConflictError("fansly", "1", "lora-2"), "deterministic"],
    ["a wrong transactions writer", wrongWriter(), "deterministic"],
    ["a wrapped identity change", new Error("apply failed", { cause: new PlatformAccountIdentityImmutableError("lora-1", "1", "2") }), "deterministic"],
    ["a serialization failure", sqlError("40001"), "transient"],
    ["a deadlock", sqlError("40P01"), "transient"],
    ["a lock timeout", sqlError("55P03"), "transient"],
    ["a cancelled statement", sqlError("57014"), "transient"],
    ["a lost connection", sqlError("08006"), "transient"],
    ["a pool timeout", new Error("timeout exceeded when trying to connect"), "transient"],
    ["a wrapped deadlock", new Error("apply failed", { cause: sqlError("40P01") }), "transient"],
    ["a resource bug", new TypeError("x is undefined"), "other"],
    ["an unknown SQLSTATE", sqlError("XX000"), "other"],
  ])("%s → %s", (_label, error, kind) => {
    expect(classifyApplyError(error)).toBe(kind);
  });

  it("an identity error stops the page, a wrong transactions writer its resource file", () => {
    expect(applyErrorScope(new PlatformAccountIdentityImmutableError("lora-1", "1", "2"))).toBe("page_identity");
    expect(applyErrorScope(new PlatformAccountIdentityConflictError("fansly", "1", null))).toBe("page_identity");
    expect(applyErrorScope(new Error("wrapped", { cause: wrongWriter() }))).toBe("resource_writer");
    expect(applyErrorScope(sqlError("23505"))).toBeNull();
    expect(applyErrorScope(new FanslyContractViolationError("response", "no id"))).toBeNull();
  });

  it("journals an error class, never a message", () => {
    expect(errorName(sqlError("23505"))).toBe("23505");
    expect(errorName(new ApplyDeferred("erasure_busy"))).toBe("deferred:erasure_busy");
    expect(errorName(new TypeError("secret text"))).toBe("TypeError");
  });

  it("a deferred apply is retried 1 s → 5 s → 30 s → 60 s by the age of its answer", () => {
    expect([0, 4_999, 5_000, 29_999, 30_000, 299_999, 300_000, 3_600_000].map(deferredRetryInMs))
      .toEqual([1_000, 1_000, 5_000, 5_000, 30_000, 30_000, 60_000, 60_000]);
  });
});

describe("the resource hold of a wrong transactions writer", () => {
  const NOW = new Date("2026-10-02T12:00:00.000Z");
  const iso = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();

  it("climbs the 30 m → 2 h → 6 h ladder and keeps a hold in force", () => {
    expect(escalateResourceHold({}, "transactions.head", NOW)).toEqual({
      action: "set", file: "transactions", until: new Date(NOW.getTime() + RESOURCE_HOLD_LADDER_MS[0]!), step: 1,
    });
    const expired = { transactions: { until: iso(-1), step: 1, since: iso(-3_600_000) } };
    expect(escalateResourceHold(expired, "transactions.rescan", NOW)).toEqual({
      action: "set", file: "transactions", until: new Date(NOW.getTime() + RESOURCE_HOLD_LADDER_MS[1]!), step: 2,
    });
    const top = { transactions: { until: iso(-1), step: 7, since: iso(-3_600_000) } };
    expect(escalateResourceHold(top, "transactions.head", NOW)).toMatchObject({
      until: new Date(NOW.getTime() + RESOURCE_HOLD_LADDER_MS[2]!), step: 8,
    });
    const active = { transactions: { until: iso(60_000), step: 1, since: iso(-60_000) } };
    expect(escalateResourceHold(active, "transactions.head", NOW)).toEqual({ action: "keep" });
    expect(escalateResourceHold({}, "dm-messages.head", NOW)).toEqual({ action: "keep" });
  });
});

describe("the capture's newest-429 read", () => {
  const NOW = new Date("2026-10-02T12:00:00.000Z");
  const input = (errorClass: OutcomeClass, lastRateLimitAt: Date | null): OutcomeInput => ({
    errorClass,
    now: NOW,
    resource: "posts.refresh",
    subject: "",
    httpStatus: errorClass === "rate_limit" ? 429 : 200,
    retryAfterMs: null,
    page: {
      holdKind: null,
      holdUntil: null,
      holdSince: null,
      holdStep: 0,
      holdDetail: {},
      networkFailureStreak: 0,
      resourceHolds: {},
      credentialsGeneration: "1",
    },
    lastRateLimitAt,
    subjectState: { failureCount: 0, breakerUntil: null, blockedByVendorAt: null },
    subjectQueue: false,
    recentFailedSubjects: 0,
  });

  it.each<OutcomeClass>([
    "ok", "rate_limit", "auth", "identity_mismatch", "subject_failure", "subject_terminal",
    "network", "contract", "cursor_stuck", "envelope_unsuccessful", "not_sent",
  ])("is not needed at 429 step 0 (%s): the capture skips it", (errorClass) => {
    const recent = new Date(NOW.getTime() - 60_000);
    expect(onOutcome(input(errorClass, recent))).toEqual(onOutcome(input(errorClass, null)));
  });

  it("looks back past the decay hour by more than an admission → completion span", () => {
    expect(RATE_LIMIT_LOOKBACK_MS - RATE_LIMIT_LADDER_RESET_MS).toBeGreaterThan(SEND_WINDOW_MS + REQUEST_TIMEOUT_MS);
  });
});

describe("the journaled request", () => {
  it("carries the wire id, the parameters and the request line — never a header", () => {
    expect(requestJsonOf({ spec: "messages.page", params: { groupId: "123", before: "456" } })).toEqual({
      spec: "messages.page",
      params: { groupId: "123", before: "456" },
      path: "/message",
      query: { "ngsw-bypass": "true", groupId: "123", before: "456", limit: "25" },
    });
  });
});

describe("the shadow transport", () => {
  const request = { spec: "polls" as const, params: {} };

  it("asks the send check, then simulates the answer's latency; nothing is dialled", async () => {
    const transport = new ShadowTransport({ clock: systemClock, latency: fixedShadowLatency(5) });
    const prepared = await transport.prepare(request);
    expect(prepared.headers).toEqual({});
    let checks = 0;
    const outcome = await transport.send(prepared, { check: () => { checks += 1; return null; } }, new AbortController().signal);
    expect(checks).toBe(1);
    expect(outcome.kind).toBe("shadow");
    expect(transport.sends).toBe(1);
  });

  it("a refused check is a refusal, as live", async () => {
    const transport = new ShadowTransport({ clock: systemClock, latency: fixedShadowLatency(5) });
    const outcome = await transport.send(await transport.prepare(request), {
      check: () => new FanslySendRefusedError("lease_inactive"),
    }, new AbortController().signal);
    expect(outcome).toEqual({ kind: "aborted_before_send", refusal: "lease_inactive" });
    expect(transport.sends).toBe(0);
  });

  it("legacy latencies: uniform between p50 and p95 of the operation; the default without data", async () => {
    const db = {
      execute: async () => ({ rows: [{ operation: "polls_probe", p50: 200, p95: 1_000 }] }),
    } as unknown as Database;
    const sampled = createLegacyShadowLatency({ db, pageId: 1, clock: systemClock, rng: { next: () => 0.5 } });
    expect(await sampled.sampleMs("polls")).toBe(600);
    expect(await sampled.sampleMs("recapstats")).toBe(SHADOW_DEFAULT_LATENCY_MS);
    const broken = { execute: async () => { throw new Error("db down"); } } as unknown as Database;
    expect(await createLegacyShadowLatency({ db: broken, pageId: 1, clock: systemClock, rng: { next: () => 0.5 } }).sampleMs("polls"))
      .toBe(SHADOW_DEFAULT_LATENCY_MS);
  });
});

describe("owner levers that need no database", () => {
  const registry = createEngineRegistry([
    spec("media-stats.walk", { kind: "goal", class: "planned", ownerProtected: true }),
    spec("subscribers.poll", { kind: "poll", class: "planned", period: { everyMs: 3_600_000 }, ownerProtected: true }),
    spec("dm-messages.head"),
  ]);
  const unused = {} as Database;

  it("an unknown key, an owner-protected change without approval, a period on a non-poll are refused", async () => {
    await expect(changeSyncRegistryOverride(unused, registry, {
      pageLabel: "lora-1", resource: "nope.nope", override: { everyMs: 1 }, ownerApproved: false,
    })).rejects.toThrow(/No registry entry/);
    await expect(changeSyncRegistryOverride(unused, registry, {
      pageLabel: "lora-1", resource: "subscribers.poll", override: { everyMs: 60_000 }, ownerApproved: false,
    })).rejects.toThrow(/owner decision №6/);
    await expect(changeSyncRegistryOverride(unused, registry, {
      pageLabel: "lora-1", resource: "dm-messages.head", override: { everyMs: 60_000 }, ownerApproved: true,
    })).rejects.toBeInstanceOf(SyncOwnerLeverError);
  });

  it("a cadence or tiers override is refused where the entry has none a page can change (it would be ignored)", async () => {
    const tiered = createEngineRegistry([
      spec("media-stats.walk", {
        kind: "goal", class: "planned", ownerProtected: true, pageOverride: "tiers",
        tiers: [{ maxAgeDays: 30, everyMs: 86_400_000 }, { maxAgeDays: null, everyMs: 604_800_000 }],
      }),
      spec("posts.engagement", { kind: "goal", class: "planned", tiers: [{ maxAgeDays: null, everyMs: 86_400_000 }] }),
      spec("subscribers.poll", { kind: "poll", class: "planned", period: { everyMs: 3_600_000 } }),
    ]);
    const tiers = [{ maxAgeDays: 14, everyMs: 43_200_000 }, { maxAgeDays: null, everyMs: 86_400_000 }];
    const refused = (resource: string, override: Parameters<typeof changeSyncRegistryOverride>[2]["override"]) =>
      expect(changeSyncRegistryOverride(unused, tiered, { pageLabel: "lora-1", resource, override, ownerApproved: true }))
        .rejects.toBeInstanceOf(SyncOwnerLeverError);
    await refused("media-stats.walk", { tiers: tiers.slice(1) });
    await refused("media-stats.walk", { tiers: [{ maxAgeDays: 14, everyMs: 1 }, { maxAgeDays: 7, everyMs: 1 }] });
    await refused("media-stats.walk", { everyMs: 86_400_000 });
    await refused("posts.engagement", { tiers: [{ maxAgeDays: null, everyMs: 1 }] });
    await refused("subscribers.poll", { everyMs: 60_000, fullEveryMs: 86_400_000 });
    await refused("subscribers.poll", { tiers });
  });
});

describe("the sync process's owner identity", () => {
  it("`sync` is a holder role of the step-1 OS proof (§14 F4)", () => {
    expect(FANSLY_SEND_HOLDER_ROLES).toContain("sync");
  });
});
