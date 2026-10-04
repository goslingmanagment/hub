import { describe, expect, it } from "vitest";

import {
  AGENT_SYNC_WHY_MAX_ROWS,
  agentSyncAttemptOutcomeEnum,
  agentSyncPageHoldKindEnum,
  agentSyncPageModeEnum,
  agentSyncPageStatusSchema,
  agentSyncResourceKeyEnum,
  agentSyncWhyQuerySchema,
  agentSyncWorkClassEnum,
  agentSyncWorkKindEnum,
  agentSyncWorkSchema,
  agentSyncWorkStateEnum,
  routeSchemas,
  syncPageRefreshBodySchema,
  syncPageWorkQuerySchema,
  syncResourceFileEnum,
} from "@agency_hub_core/contracts";
import {
  SYNC_ATTEMPT_OUTCOMES,
  SYNC_PAGE_HOLD_KINDS,
  SYNC_PAGE_MODES,
  SYNC_WORK_CLASSES,
  SYNC_WORK_KINDS,
  SYNC_WORK_STATES,
} from "@agency_hub_core/db";
import { INDEFINITE_UNTIL } from "@agency_hub_core/shared";

import { agentSyncWhyCapabilities } from "../apps/runtime/src/modules/agent-read/index.ts";
import { EMPTY_HOLD_SET, holdSetOf } from "../apps/runtime/src/sync/engine/admission.ts";
import { buildPageStatus, type StatusPage } from "../apps/runtime/src/sync/engine/status.ts";
import { FANSLY_RESOURCE_SPECS } from "../apps/runtime/src/sync/fansly/registry.ts";
import type { WorkWhy } from "../apps/runtime/src/sync/inspect.ts";
import {
  apiResourceSpec,
  syncWorkStatusUrl,
  UrgentWorkRefusedError,
  workIdOfDonePayload,
} from "../apps/runtime/src/sync/requests/urgent.ts";
import { toSyncPageStatusWire, toSyncWorkWire } from "../apps/runtime/src/sync/requests/wire.ts";
import { pageHoldRow, resourceBreakerRow } from "./helpers/sync-holds.ts";

// The engine's status and "why waiting" on the wire (design §3.9, §7.4) and
// the "enqueue and wait" wrapper's pure parts (§7.3). The contracts package
// cannot import the server's closed lists, so each vocabulary is pinned equal
// here: a value on one side only would be a response the SDK refuses, or a
// filter the hub cannot apply.

const NOW = new Date("2026-10-02T12:00:00.000Z");
const at = (ms: number) => new Date(NOW.getTime() + ms);

describe("sync status: the wire vocabularies mirror the server's", () => {
  it("page modes, hold kinds, work kinds, classes, states and attempt outcomes", () => {
    expect(agentSyncPageModeEnum.options).toEqual([...SYNC_PAGE_MODES]);
    expect(agentSyncPageHoldKindEnum.options).toEqual([...SYNC_PAGE_HOLD_KINDS]);
    expect(agentSyncWorkKindEnum.options).toEqual([...SYNC_WORK_KINDS]);
    expect(agentSyncWorkClassEnum.options).toEqual([...SYNC_WORK_CLASSES]);
    expect(agentSyncWorkStateEnum.options).toEqual([...SYNC_WORK_STATES]);
    expect(agentSyncAttemptOutcomeEnum.options).toEqual([...SYNC_ATTEMPT_OUTCOMES]);
  });

  it("every registry key, in registry order, and every resource file", () => {
    expect(agentSyncResourceKeyEnum.options).toEqual(FANSLY_RESOURCE_SPECS.map((spec) => spec.key));
    expect(new Set(syncResourceFileEnum.options)).toEqual(new Set(FANSLY_RESOURCE_SPECS.map((spec) => spec.file)));
    expect(syncResourceFileEnum.options).toHaveLength(new Set(syncResourceFileEnum.options).size);
  });
});

describe("sync status: query and body shapes", () => {
  it("why names a registry key; the subject is optional and '' is the page-level row", () => {
    expect(agentSyncWhyQuerySchema.safeParse({ resource: "dm-messages.head" }).success).toBe(true);
    expect(agentSyncWhyQuerySchema.safeParse({ resource: "transactions.head", subject: "" }).success).toBe(true);
    expect(agentSyncWhyQuerySchema.safeParse({ resource: "dm-live.frame" }).success).toBe(false);
    expect(agentSyncWhyQuerySchema.safeParse({}).success).toBe(false);
    expect(agentSyncWhyQuerySchema.safeParse({ resource: "posts.refresh", subject: "x".repeat(201) }).success).toBe(false);
  });

  it("the owner's work list pages with defaults; sync now names resource files or nothing", () => {
    expect(syncPageWorkQuerySchema.parse({})).toEqual({ limit: 50, offset: 0 });
    expect(syncPageWorkQuerySchema.parse({ state: "open", limit: "10", offset: "20" }))
      .toEqual({ state: "open", limit: 10, offset: 20 });
    expect(syncPageWorkQuerySchema.safeParse({ limit: 201 }).success).toBe(false);
    expect(syncPageWorkQuerySchema.safeParse({ state: "pending" }).success).toBe(false);
    expect(syncPageRefreshBodySchema.parse({})).toEqual({});
    expect(syncPageRefreshBodySchema.safeParse({ resources: ["transactions", "posts"] }).success).toBe(true);
    expect(syncPageRefreshBodySchema.safeParse({ resources: [] }).success).toBe(false);
    expect(syncPageRefreshBodySchema.safeParse({ resources: ["transactions.head"] }).success).toBe(false);
  });

  it("the owner routes answer the same shapes; sync now is a 202 with a 409 for an off page", () => {
    const refresh = routeSchemas.syncPageRefresh as { response: Record<string, unknown> };
    expect(Object.keys(refresh.response)).toContain("202");
    expect(Object.keys(refresh.response)).toContain("409");
    expect(Object.keys(refresh.response)).not.toContain("200");
    for (const key of ["syncPages", "syncPageWork", "syncPageWorkGet", "syncPageRefresh"] as const) {
      expect((routeSchemas[key] as { auth: { kind: string } }).auth.kind).toBe("owner-session");
    }
  });
});

describe("sync status: the capabilities of why", () => {
  it("a key whose subjects are chats or fans needs read:messages beside read:datasets", () => {
    for (const spec of FANSLY_RESOURCE_SPECS) {
      const key = agentSyncResourceKeyEnum.parse(spec.key);
      const expected = spec.subject === "thread" || spec.subject === "fan"
        ? ["read:datasets", "read:messages"]
        : ["read:datasets"];
      expect(agentSyncWhyCapabilities(key), spec.key).toEqual(expected);
    }
    expect(agentSyncWhyCapabilities("dm-messages.history")).toContain("read:messages");
    expect(agentSyncWhyCapabilities("fan-profiles.probe")).toContain("read:messages");
    expect(agentSyncWhyCapabilities("transactions.head")).toEqual(["read:datasets"]);
  });
});

function statusPage(overrides: Partial<StatusPage> = {}): StatusPage {
  return {
    mode: "shadow",
    pausedAll: false,
    pausedRequests: false,
    pausedResources: [],
    holds: EMPTY_HOLD_SET,
    owner: {
      generation: 3n,
      host: "sync-1",
      acquiredAt: at(-3_600_000),
      heartbeatAt: at(-5_000),
      releasedAt: null,
      releaseGeneration: null,
    },
    ...overrides,
  };
}

describe("sync status: the page status on the wire", () => {
  it("keeps every field, ISO instants and an auth hold's 'infinity'", () => {
    const status = buildPageStatus({
      pageLabel: "lora-1",
      page: {
        ...statusPage({
          holds: holdSetOf([
            pageHoldRow("auth", INDEFINITE_UNTIL, { since: at(-60_000) }),
            resourceBreakerRow("dm-conversations", at(60_000), { step: 1, since: at(-1_000) }),
          ]),
        }),
        lastSendAt: at(-2_000),
      },
      settingMs: 2_000,
      now: NOW,
      runtime: { slotOpensAt: null },
      works: [
        { id: 1, resource: "transactions.head", subject: "", class: "urgent", state: "open", dueAt: at(-1), breakerUntil: null, blockedByVendorAt: null, waitingReason: null, waitingUntil: null },
        { id: 2, resource: "dm-messages.head", subject: "1", class: "urgent", state: "quarantined", dueAt: at(-1), breakerUntil: null, blockedByVendorAt: null, waitingReason: "quarantined", waitingUntil: null },
      ],
      sends: {
        lastHour: { urgent: 3, requests: 0, planned: 2, byResource: { "transactions.head": 3, "posts.refresh": 2 } },
        minGapLastHourMs: 2_100.5,
        violationsLastDay: 0,
      },
      requests: [],
      shadow: { attemptsLastHour: 5, demandVsEstimate: null },
    });
    const wire = toSyncPageStatusWire(status);
    expect(agentSyncPageStatusSchema.parse(wire)).toEqual(wire);
    expect(wire.holds.page).toEqual({ kind: "auth", until: "infinity", since: at(-60_000).toISOString() });
    expect(wire.holds.resources).toEqual([
      { file: "dm-conversations", until: at(60_000).toISOString(), step: 1, kind: "breaker" },
    ]);
    expect(wire.owner).toMatchObject({ generation: "3", running: true });
    expect(wire.quarantined).toBe(1);
    expect(wire.sendsLastHour.byResource).toEqual({ "transactions.head": 3, "posts.refresh": 2 });
    // A copy, not the status's own objects.
    expect(wire.queue.urgent).not.toBe(status.queue.urgent);
  });
});

function why(overrides: Partial<WorkWhy["work"]> = {}, waiting: WorkWhy["waiting"] = { reason: "not_due", until: at(60_000), detail: {} }): WorkWhy {
  return {
    work: {
      id: 41,
      resource: "account.verify",
      subject: "",
      shadow: false,
      kind: "trigger",
      class: "urgent",
      state: "open",
      dueAt: at(60_000),
      demandRevision: 2,
      appliedRevision: 1,
      attempts: 1,
      failureCount: 0,
      breakerUntil: null,
      blockedByVendorAt: null,
      lastErrorClass: null,
      lastAttempt: { id: 7, admittedAt: at(-10_000), sentAt: at(-9_000), outcome: "response", httpStatus: 200 },
      closedAt: null,
      closeReason: null,
      result: { identity: "secret-ish" },
      ...overrides,
    },
    waiting,
  };
}

describe("sync status: a work row on the wire", () => {
  it("carries why it waits, its revisions and last attempt, and never its result", () => {
    const wire = toSyncWorkWire(why());
    expect(agentSyncWorkSchema.parse(wire)).toEqual(wire);
    expect(wire).toMatchObject({
      id: 41,
      resource: "account.verify",
      waitingReason: "not_due",
      waitingUntil: at(60_000).toISOString(),
      demandRevision: 2,
      appliedRevision: 1,
      lastAttempt: { admittedAt: at(-10_000).toISOString(), sentAt: at(-9_000).toISOString(), outcome: "response", httpStatus: 200 },
    });
    expect(wire).not.toHaveProperty("result");
    expect(wire).not.toHaveProperty("attempts");
  });

  it("closed work waits for nothing; an indefinite instant has none on the wire", () => {
    const closed = toSyncWorkWire(why({ state: "done", closedAt: at(-1_000), closeReason: "applied", lastAttempt: null }, null));
    expect(closed).toMatchObject({ state: "done", waitingReason: null, waitingUntil: null, closedAt: at(-1_000).toISOString(), lastAttempt: null });
    const held = toSyncWorkWire(why({ breakerUntil: INDEFINITE_UNTIL }, { reason: "page_hold", until: INDEFINITE_UNTIL, detail: {} }));
    expect(held.breakerUntil).toBeNull();
    expect(held.waitingUntil).toBeNull();
    expect(agentSyncWorkSchema.safeParse(held).success).toBe(true);
  });

  it("answers at most the documented number of rows", () => {
    expect(AGENT_SYNC_WHY_MAX_ROWS).toBe(200);
  });
});

describe("enqueue and wait: the pure parts", () => {
  it("only a registry key with the api trigger may be enqueued", () => {
    const allowed = FANSLY_RESOURCE_SPECS.filter((spec) => spec.triggers.includes("api")).map((spec) => spec.key);
    expect(allowed).toEqual(["account.verify", "account.identity", "media-download.fetch"]);
    for (const key of allowed) expect(apiResourceSpec(key).key).toBe(key);
    for (const key of ["transactions.head", "dm-messages.history", "probe.manual", "no.such-key"]) {
      expect(() => apiResourceSpec(key), key).toThrow(UrgentWorkRefusedError);
    }
  });

  it("the status link and the work-done payload", () => {
    expect(syncWorkStatusUrl("lora 1", 42)).toBe("/api/v1/sync/pages/lora%201/work/42");
    expect(workIdOfDonePayload("42:7")).toBe(42);
    expect(workIdOfDonePayload("42")).toBe(42);
    expect(workIdOfDonePayload("x:1")).toBeNull();
    expect(workIdOfDonePayload("0:1")).toBeNull();
    expect(workIdOfDonePayload("")).toBeNull();
  });
});
