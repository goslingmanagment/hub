import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  agentCaptureFloorSchema,
  agentHistoryItemSchema,
  agentHistoryItemStateEnum,
  agentHistoryRefusalEnum,
  agentHistoryRequestCreateBodySchema,
  agentHistoryRequestGetQuerySchema,
  agentHistoryRequestListQuerySchema,
  agentHistoryRequestSchema,
  agentHistoryRequestStateEnum,
  agentHistoryRequesterKindEnum,
  agentHistorySatisfiedByEnum,
  agentSyncWaitingReasonEnum,
  agentThreadCaptureFloorSchema,
  agentThreadHistoryStateEnum,
  routeSchemas,
  syncHistoryRequestCreateBodySchema,
} from "@agency_hub_core/contracts";
import {
  HISTORY_ITEM_REFUSALS,
  HISTORY_ITEM_SATISFIED_BY,
  HISTORY_ITEM_STATES,
  HISTORY_REQUEST_MAX_ITEMS,
  HISTORY_REQUEST_MAX_LATEST,
  HISTORY_REQUEST_STATES,
  HISTORY_REQUESTER_KINDS,
  THREAD_HISTORY_STATES,
  type AgentThreadCoverageRow,
} from "@agency_hub_core/db";

import { threadCaptureFloor, threadCoverage } from "../apps/runtime/src/modules/agent-read/index.ts";
import { WAITING_REASONS } from "../apps/runtime/src/sync/engine/status.ts";
import type { HistoryItemView, HistoryRequestView } from "../apps/runtime/src/sync/requests/history.ts";
import { toHistoryItemWire, toHistoryRequestWire } from "../apps/runtime/src/sync/requests/wire.ts";

// The history-request contracts (design §7.4) against the server's own closed
// lists: the contracts package cannot import them, so a value added on one side
// only would be a response the SDK refuses, or a filter the hub cannot apply.

describe("history requests: the wire vocabularies mirror the server's", () => {
  it("request, item, refusal, requester and satisfaction vocabularies", () => {
    expect(agentHistoryRequestStateEnum.options).toEqual([...HISTORY_REQUEST_STATES]);
    expect(agentHistoryItemStateEnum.options).toEqual([...HISTORY_ITEM_STATES]);
    expect(agentHistoryRefusalEnum.options).toEqual([...HISTORY_ITEM_REFUSALS]);
    expect(agentHistoryRequesterKindEnum.options).toEqual([...HISTORY_REQUESTER_KINDS]);
    expect(agentHistorySatisfiedByEnum.options).toEqual([...HISTORY_ITEM_SATISFIED_BY]);
  });

  it("the engine's waiting reasons and the chain's history states", () => {
    expect(agentSyncWaitingReasonEnum.options).toEqual([...WAITING_REASONS]);
    expect(agentThreadHistoryStateEnum.options).toEqual([...THREAD_HISTORY_STATES]);
  });

  it("the plane's capture floor keeps its two kinds; only a thread floor can be a proven chain", () => {
    expect(agentCaptureFloorSchema.shape.kind.options).toEqual(["oldest_stored_row", "unknown"]);
    expect(agentThreadCaptureFloorSchema.shape.kind.options).toEqual(["oldest_stored_row", "unknown", "proven_chain"]);
  });
});

function fan(n: number) {
  return { kind: "fan" as const, platformUserId: `51000000000000${String(n).padStart(4, "0")}` };
}

describe("history requests: the create body", () => {
  const base = { depth: { kind: "all" }, reason: "audit", idempotencyKey: randomUUID() };

  it("takes 1..1000 fans of three kinds and a required depth", () => {
    const body = {
      ...base,
      fans: [fan(1), { kind: "conversation", conversationRef: "810272281019305984" }, { kind: "chat_url", url: "https://fansly.com/messages/1" }],
    };
    expect(agentHistoryRequestCreateBodySchema.safeParse(body).success).toBe(true);
    expect(agentHistoryRequestCreateBodySchema.safeParse({ ...body, fans: [] }).success).toBe(false);
    const max = Array.from({ length: HISTORY_REQUEST_MAX_ITEMS }, (_, index) => fan(index));
    expect(agentHistoryRequestCreateBodySchema.safeParse({ ...body, fans: max }).success).toBe(true);
    expect(agentHistoryRequestCreateBodySchema.safeParse({ ...body, fans: [...max, fan(5000)] }).success).toBe(false);
    const { depth: _depth, ...noDepth } = body;
    expect(agentHistoryRequestCreateBodySchema.safeParse(noDepth).success).toBe(false);
  });

  it("bounds latest N like the server does and refuses a boundary depth from a caller", () => {
    const parse = (depth: unknown) => agentHistoryRequestCreateBodySchema.safeParse({ ...base, fans: [fan(1)], depth }).success;
    expect(parse({ kind: "latest", count: 1 })).toBe(true);
    expect(parse({ kind: "latest", count: HISTORY_REQUEST_MAX_LATEST })).toBe(true);
    expect(parse({ kind: "latest", count: HISTORY_REQUEST_MAX_LATEST + 1 })).toBe(false);
    expect(parse({ kind: "latest", count: 0 })).toBe(false);
    expect(parse({ kind: "latest" })).toBe(false);
    // `before_boundary` belongs to the legacy hydration wrapper (step 3), not to callers.
    expect(parse({ kind: "before_boundary", at: "2026-01-01T00:00:00Z" })).toBe(false);
  });

  it("refuses the same fan twice, trimmed as the server de-duplicates", () => {
    const parsed = agentHistoryRequestCreateBodySchema.safeParse({
      ...base,
      fans: [fan(1), { kind: "fan", platformUserId: ` ${fan(1).platformUserId} ` }],
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain("duplicate fan");
    // The same id under another kind is another input.
    expect(agentHistoryRequestCreateBodySchema.safeParse({
      ...base,
      fans: [fan(1), { kind: "conversation", conversationRef: fan(1).platformUserId }],
    }).success).toBe(true);
  });

  it("the owner body is the same without the agent-plane claim", () => {
    const body = { ...base, fans: [fan(1), fan(1)] };
    expect(syncHistoryRequestCreateBodySchema.safeParse(body).success).toBe(false);
    expect(syncHistoryRequestCreateBodySchema.safeParse({ ...body, fans: [fan(1)] }).success).toBe(true);
    expect(syncHistoryRequestCreateBodySchema.safeParse({
      ...body,
      fans: [fan(1)],
      claim: { fields: ["textPlain"], targets: "all_in_scope" },
    }).success).toBe(false);
  });

  it("a cursor pins the item filter and the list's scope", () => {
    expect(agentHistoryRequestGetQuerySchema.safeParse({ cursor: "abc", state: "ready" }).success).toBe(false);
    expect(agentHistoryRequestGetQuerySchema.safeParse({ cursor: "abc" }).success).toBe(true);
    expect(agentHistoryRequestListQuerySchema.safeParse({ cursor: "abc", pageLabel: "lora-1" }).success).toBe(false);
    expect(agentHistoryRequestListQuerySchema.safeParse({ pageLabel: "lora-1", state: "open" }).success).toBe(true);
  });

  it("the owner routes are owner-session and never page-scoped by the middleware", () => {
    for (const key of ["syncHistoryRequests", "syncHistoryRequestCreate", "syncHistoryRequestGet", "syncHistoryRequestCancel"] as const) {
      expect(routeSchemas[key].auth).toEqual({ kind: "owner-session" });
    }
  });
});

const NOW = "2026-10-02T10:00:00.000Z";

function requestView(overrides: Partial<HistoryRequestView> = {}): HistoryRequestView {
  return {
    ref: randomUUID(),
    pageId: 7,
    pageLabel: "lora-1",
    state: "open",
    depth: { kind: "latest", count: 50 },
    requesterKind: "agent_key",
    createdAt: NOW,
    doneAt: null,
    cancelledAt: null,
    counts: { total: 3, ready: 1, queued: 1, loading: 0, blocked: 0, refused: 1, cancelled: 0 },
    reads: { done: 4, remainingMin: 2, remainingEstimate: null },
    eta: { lowerBoundSeconds: 5, estimateSeconds: null, basis: "estimate", ratePerHour: 1309.1, sharePercent: 80 },
    queuePosition: 1,
    waitingReason: "ownership_unconfirmed",
    waitingUntil: null,
    estimateAtSubmit: { readsMin: 3 },
    ...overrides,
  };
}

function itemView(overrides: Partial<HistoryItemView> = {}): HistoryItemView {
  return {
    ordinal: 0,
    input: { kind: "fan_platform_user_id", ref: "510000000000000001" },
    fanPlatformUserId: "510000000000000001",
    conversationRef: "810272281019305984",
    state: "queued",
    refusal: null,
    excludedReason: null,
    probeAt: null,
    waitingReason: "pacer",
    waitingUntil: NOW,
    loadedMessages: 25,
    oldestLoadedAt: NOW,
    readsSpent: 1,
    historyState: "partial",
    historyProof: null,
    anchorMessageRef: "810272281019305999",
    satisfiedAt: null,
    satisfiedBy: null,
    estimate: { readsMin: 1, readsEstimate: 3 },
    ...overrides,
  };
}

describe("history requests: views on the wire", () => {
  it("a request view is a valid wire request without the page id or the submit estimate", () => {
    const wire = toHistoryRequestWire(requestView());
    expect(agentHistoryRequestSchema.safeParse(wire).success).toBe(true);
    expect(wire).not.toHaveProperty("pageId");
    expect(wire).not.toHaveProperty("estimateAtSubmit");
    const boundary = toHistoryRequestWire(requestView({
      depth: { kind: "before_boundary", boundaryAt: NOW, boundaryMessageRef: null },
      requesterKind: "legacy_hydration_wrapper",
    }));
    expect(agentHistoryRequestSchema.safeParse(boundary).success).toBe(true);
  });

  it("an item goes out in the vocabulary a caller files it in", () => {
    const kinds = [
      ["fan_platform_user_id", "fan"],
      ["conversation_ref", "conversation"],
      ["chat_url", "chat_url"],
    ] as const;
    for (const [stored, wire] of kinds) {
      const item = toHistoryItemWire(itemView({ input: { kind: stored, ref: "x" } }));
      expect(item.input).toEqual({ kind: wire, ref: "x" });
      expect(agentHistoryItemSchema.safeParse(item).success).toBe(true);
    }
    const refused = toHistoryItemWire(itemView({
      state: "refused",
      refusal: "excluded",
      excludedReason: "partner_missing_from_aggregation_accounts",
      waitingReason: null,
      waitingUntil: null,
      historyState: "unverified",
    }));
    expect(agentHistoryItemSchema.safeParse(refused).success).toBe(true);
  });
});

function coverage(overrides: Partial<AgentThreadCoverageRow> = {}): AgentThreadCoverageRow {
  return {
    historyState: "none",
    historyProof: null,
    contiguousOldestAt: null,
    contiguousCount: 0,
    headConfirmedAt: null,
    ...overrides,
  };
}

describe("a thread's own capture floor (design §7.7)", () => {
  const at = new Date("2026-07-05T10:00:00Z");

  it("is the oldest message of a PROVEN chain, partial or complete", () => {
    expect(threadCaptureFloor(coverage({ historyState: "partial", contiguousOldestAt: at, contiguousCount: 40 })))
      .toEqual({ at: at.toISOString(), kind: "proven_chain" });
    expect(threadCaptureFloor(coverage({
      historyState: "complete",
      historyProof: "empty_page",
      contiguousOldestAt: at,
      contiguousCount: 40,
    }))).toEqual({ at: at.toISOString(), kind: "proven_chain" });
  });

  it("claims nothing for stored-but-unproven messages, an empty chat or a missing chain", () => {
    // Legacy windows have holes: a floor drawn from one would claim coverage nobody proved.
    expect(threadCaptureFloor(coverage({ historyState: "unverified", contiguousOldestAt: at })))
      .toEqual({ at: null, kind: "unknown" });
    expect(threadCaptureFloor(coverage({ historyState: "none" }))).toEqual({ at: null, kind: "unknown" });
    expect(threadCaptureFloor(coverage({ historyState: "complete", historyProof: "empty_page" })))
      .toEqual({ at: null, kind: "unknown" });
  });

  it("the coverage block carries ISO instants", () => {
    expect(threadCoverage(coverage({
      historyState: "partial",
      contiguousOldestAt: at,
      contiguousCount: 40,
      headConfirmedAt: at,
    }))).toEqual({
      historyState: "partial",
      historyProof: null,
      contiguousOldestAt: at.toISOString(),
      contiguousCount: 40,
      headConfirmedAt: at.toISOString(),
    });
  });
});
