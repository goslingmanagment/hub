import { beforeEach, describe, expect, it, vi } from "vitest";

// §3.2c(i) — the READ-SIDE preflight, asserted for EVERY registered projection.
//
// Tiering exports and DETACHES `domain_events` monthlies older than ~6 months,
// and `listEventsSince` sees only ATTACHED partitions. A rebuild that ran anyway
// would truncate the projection, replay a truncated ledger, and call the result
// authoritative — silently. Before WP-F1(0) only `media_plane` and
// `message_archive` had the gate: `creator_posts` and `fan_earnings` would have
// replayed a truncated ledger without a word. The registry is what makes
// "every projection" checkable rather than a promise.
//
// A fresh-database checksum test does NOT discharge this (§9.1 says so): a
// fresh database has no detached partitions, so it can only ever prove the
// happy path.

const dbMocks = vi.hoisted(() => ({
  listDetachedPartitionsHoldingAccount: vi.fn(),
  listEventAccounts: vi.fn(),
}));

vi.mock("@agency_hub_core/db", () => dbMocks);

const { PROJECTION_REGISTRY, rebuildRegisteredProjection, assertProjectionRebuildable } =
  await import("../apps/runtime/src/services/projections/registry.ts");

const app = {
  db: {} as never,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
};

beforeEach(() => {
  dbMocks.listDetachedPartitionsHoldingAccount.mockReset();
  dbMocks.listEventAccounts.mockReset();
  dbMocks.listEventAccounts.mockResolvedValue([7]);
});

describe("rebuild preflight", () => {
  it("refuses every rebuildable projection when a detached partition holds the account", async () => {
    dbMocks.listDetachedPartitionsHoldingAccount.mockResolvedValue([
      { schema: "public", name: "domain_events_2026_01", rows: 41_002 },
    ]);

    const rebuildable = PROJECTION_REGISTRY.filter(
      (projection) => projection.rebuild !== null,
    );
    expect(rebuildable.length).toBeGreaterThan(0);

    for (const projection of rebuildable) {
      await expect(
        rebuildRegisteredProjection(app, projection.name, { accountId: 7 }),
        projection.name,
      ).rejects.toThrow(
        // The message must name the projection, the partition, AND the recovery
        // — an operator who reads "refused" without "re-attach the month" will
        // reach for `create partition`, which orphans the facts the detached
        // table holds.
        new RegExp(
          `${projection.name} rebuild REFUSED for account 7:.*domain_events_2026_01 \\(41002 rows\\)`,
          "s",
        ),
      );
    }
  });

  it("names the 0077 re-attach ritual and forbids DROP in the refusal", async () => {
    dbMocks.listDetachedPartitionsHoldingAccount.mockResolvedValue([
      { schema: "public", name: "domain_events_2026_02", rows: 12 },
    ]);
    await expect(assertProjectionRebuildable(app, "fansly_stats", [7])).rejects.toThrow(
      /re-attach the month \(the 0077 ritual — DETACH\/ATTACH only, never DROP\)/,
    );
  });

  it("runs the census over every account in scope when no account is given", async () => {
    dbMocks.listEventAccounts.mockResolvedValue([11, 12, 13]);
    dbMocks.listDetachedPartitionsHoldingAccount.mockResolvedValue([]);
    const stats = PROJECTION_REGISTRY.find((projection) => projection.name === "fansly_stats");
    expect(stats).toBeDefined();
    // Stub the rebuild itself: the property under test is the preflight's
    // SCOPE, not what the replay produces.
    const rebuild = vi.fn(async () => ({ ok: true }));
    const patched = { ...stats!, rebuild };
    const index = PROJECTION_REGISTRY.indexOf(stats!);
    const registry = PROJECTION_REGISTRY as unknown as Array<typeof patched>;
    registry[index] = patched;
    try {
      await rebuildRegisteredProjection(app, "fansly_stats");
      expect(dbMocks.listDetachedPartitionsHoldingAccount).toHaveBeenCalledTimes(3);
      expect(rebuild).toHaveBeenCalledTimes(1);
    } finally {
      registry[index] = stats as never;
    }
  });

  it("refuses a projection that declares no repair path instead of pretending", async () => {
    dbMocks.listDetachedPartitionsHoldingAccount.mockResolvedValue([]);
    const unrebuildable = PROJECTION_REGISTRY.find(
      (projection) => projection.rebuildKind === "none",
    );
    expect(unrebuildable).toBeDefined();
    await expect(
      rebuildRegisteredProjection(app, unrebuildable!.name, { accountId: 7 }),
    ).rejects.toThrow(/declares rebuildKind "none"/);
  });

  it("rejects an unknown projection name with the list of known ones", async () => {
    await expect(rebuildRegisteredProjection(app, "not_a_projection")).rejects.toThrow(
      /Unknown projection: not_a_projection\. Known: /,
    );
  });
});
