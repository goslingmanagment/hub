import { describe, expect, it } from "vitest";

import type { SyncWorkResourceCounts, SyncWorkRow } from "@agency_hub_core/db";

import {
  engineOwnerRunning,
  engineStreamState,
  type EngineStatusFacts,
} from "../apps/runtime/src/services/sync-status-engine.ts";

// One lever stream of an engine page as its surfaces read it (the Settings
// blocks, the analytics Coverage panel): what of it is open, why its earliest
// work waits — as data, for a surface that words it itself — and, when it
// needs the owner, the commands that really list that work (step 4, S4-34).

const NOW = new Date("2026-10-04T09:00:00.000Z");
const minutes = (n: number): Date => new Date(NOW.getTime() + n * 60_000);

function page(overrides: Record<string, unknown> = {}): EngineStatusFacts["page"] {
  return {
    pageId: 7,
    pageLabel: "lilly-1",
    mode: "live",
    pausedAll: false,
    pausedRequests: false,
    pausedResources: [],
    holdKind: null,
    holdUntil: null,
    holdSince: null,
    holdDetail: {},
    resourceHolds: {},
    lastSendAt: minutes(-1),
    lastCompletedAt: minutes(-1),
    dbNow: NOW,
    // A host runs the page: a heartbeat a few seconds old.
    owner: {
      generation: 3n, host: "sync-1", acquiredAt: minutes(-60), heartbeatAt: new Date(NOW.getTime() - 5_000),
      releasedAt: null, releaseGeneration: null,
    },
    ...overrides,
  } as unknown as EngineStatusFacts["page"];
}

function counts(resource: string, overrides: Partial<SyncWorkResourceCounts> = {}): SyncWorkResourceCounts {
  return {
    pageId: 7, resource, active: 1, running: 0, quarantined: 0, blockedByVendor: 0, maxFailureCount: 0, nextDueAt: null,
    ...overrides,
  };
}

function row(resource: string, overrides: Record<string, unknown> = {}): SyncWorkRow {
  return {
    id: 1, resource, subject: "", class: "planned", state: "open", dueAt: minutes(30), breakerUntil: null,
    blockedByVendorAt: null, waitingReason: "not_due", waitingUntil: minutes(30),
    ...overrides,
  } as unknown as SyncWorkRow;
}

function facts(input: {
  page?: Record<string, unknown>;
  counts?: SyncWorkResourceCounts[];
  rows?: SyncWorkRow[];
  appliedAt?: Record<string, Date>;
} = {}): EngineStatusFacts {
  return {
    page: page(input.page),
    counts: new Map((input.counts ?? []).map((entry) => [entry.resource, entry])),
    pageRows: input.rows ?? [],
    appliedAt: new Map(Object.entries(input.appliedAt ?? {})),
    settingMs: 2500,
  };
}

describe("a lever stream of an engine page", () => {
  it("says why its earliest page-level work waits as data, and as one line for the API", () => {
    const state = engineStreamState("light", facts({
      counts: [counts("account.poll", { nextDueAt: minutes(30) })],
      rows: [row("account.poll")],
      appliedAt: { "account.poll": minutes(-30) },
    }));
    expect(state).toMatchObject({
      activeWork: 1,
      needsAttention: false,
      succeededAt: minutes(-30),
      nextDueAt: minutes(30),
      waiting: { resource: "account.poll", reason: "not_due", until: minutes(30) },
      statusReason: { code: "not_due", summary: `account.poll: not_due until ${minutes(30).toISOString()}` },
    });
  });

  it("counts the open work of every key and subject, and has nothing to explain when none is page-level", () => {
    const state = engineStreamState("dm_messages", facts({
      counts: [
        counts("dm-messages.head", { active: 2, running: 1, nextDueAt: minutes(-1) }),
        counts("dm-messages.history", { active: 40, nextDueAt: minutes(2) }),
      ],
      appliedAt: { "dm-messages.head": minutes(-4), "dm-messages.history": minutes(-2) },
    }));
    expect(state).toMatchObject({
      activeWork: 42,
      succeededAt: minutes(-2),
      nextDueAt: minutes(-1),
      waiting: null,
      statusReason: null,
    });
  });

  it("a stream nothing asked for has no work and no read", () => {
    expect(engineStreamState("followers_reconcile", facts())).toMatchObject({
      activeWork: 0, succeededAt: null, nextDueAt: null, waiting: null, needsAttention: false,
    });
  });

  it("names the command that lists work Fansly refuses: it is open, not quarantined", () => {
    const state = engineStreamState("payouts", facts({
      counts: [counts("payouts.daily", { blockedByVendor: 1, maxFailureCount: 2 })],
      rows: [row("payouts.daily", { blockedByVendorAt: minutes(-180), breakerUntil: minutes(120) })],
    }));
    expect(state.needsAttention).toBe(true);
    expect(state.waiting).toBeNull();
    expect(state.statusReason).toEqual({
      code: "engine_blocked_by_vendor",
      summary: "1 blocked by Fansly (payouts.daily); "
        + "pnpm cli sync work list --page lilly-1 --state open --resource payouts.daily",
      waitingFor: null,
    });
    expect(state.statusReason!.summary).not.toContain("--state quarantined");
  });

  it("names the quarantine listing for quarantined work, and both when a stream has both", () => {
    const quarantined = engineStreamState("catalog", facts({
      counts: [counts("catalog.fixed", { quarantined: 1, maxFailureCount: 5 })],
    }));
    expect(quarantined.statusReason).toEqual({
      code: "engine_quarantined",
      summary: "1 quarantined (catalog.fixed); pnpm cli sync work list --page lilly-1 --state quarantined",
      waitingFor: null,
    });

    const both = engineStreamState("catalog", facts({
      counts: [
        counts("catalog.fixed", { quarantined: 1 }),
        counts("catalog.vault", { blockedByVendor: 2 }),
        counts("catalog.hydrate", { active: 3, blockedByVendor: 1 }),
      ],
    }));
    expect(both.statusReason!.summary).toBe(
      "1 quarantined (catalog.fixed), 3 blocked by Fansly (catalog.vault, catalog.hydrate); "
      + "pnpm cli sync work list --page lilly-1 --state quarantined; "
      + "pnpm cli sync work list --page lilly-1 --state open --resource catalog.vault; "
      + "pnpm cli sync work list --page lilly-1 --state open --resource catalog.hydrate",
    );
    expect(both.activeWork).toBe(5);
  });

  it("a hold with no end has no 'until'", () => {
    const state = engineStreamState("light", facts({
      page: { holdKind: "auth", holdUntil: new Date(8.64e15), holdSince: minutes(-10) },
      counts: [counts("account.poll", { nextDueAt: minutes(-1) })],
      rows: [row("account.poll", { dueAt: minutes(-1), waitingReason: null, waitingUntil: null })],
    }));
    expect(state.waiting).toEqual({ resource: "account.poll", reason: "page_hold", until: null });
    expect(state.statusReason!.summary).toBe("account.poll: page_hold");
  });
});

describe("whether a host runs the page", () => {
  it("takes a fresh heartbeat of an owner in a mode an actor runs in", () => {
    expect(engineOwnerRunning(facts())).toBe(true);
    // The owner stopped beating.
    expect(engineOwnerRunning(facts({
      page: { owner: { generation: 3n, host: "sync-1", acquiredAt: minutes(-60), heartbeatAt: minutes(-5), releasedAt: null, releaseGeneration: null } },
    }))).toBe(false);
    // Nobody ever owned it.
    expect(engineOwnerRunning(facts({
      page: { owner: { generation: 0n, host: null, acquiredAt: null, heartbeatAt: null, releasedAt: null, releaseGeneration: null } },
    }))).toBe(false);
    // A handover: neither engine sends.
    expect(engineOwnerRunning(facts({ page: { mode: "handover" } }))).toBe(false);
  });

  it("without one every row waits for an owner, whatever else is true of it", () => {
    const state = engineStreamState("light", facts({
      page: { owner: { generation: 0n, host: null, acquiredAt: null, heartbeatAt: null, releasedAt: null, releaseGeneration: null } },
      counts: [counts("account.poll", { nextDueAt: minutes(-10) })],
      rows: [row("account.poll", { dueAt: minutes(-10), waitingReason: null, waitingUntil: null })],
    }));
    expect(state.waiting).toEqual({ resource: "account.poll", reason: "ownership_unconfirmed", until: null });
  });
});
