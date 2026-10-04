import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as DbModule from "@agency_hub_core/db";
import type * as InspectModule from "../apps/runtime/src/sync/inspect.ts";

// The owner's engine commands as `pnpm cli` parses them: through the whole
// program (`buildProgram`), where the legacy `sync` group has its own
// `--page`. Each command must receive its own `--page`, never lose it to the
// group (design §7.6).

const mocks = vi.hoisted(() => ({
  close: vi.fn(),
  createSyncContext: vi.fn(),
  changeSyncPageModeByOwner: vi.fn(),
  changeSyncPagePause: vi.fn(),
  changeSyncRegistryOverride: vi.fn(),
  confirmStoppedSyncOwners: vi.fn(),
  explainSyncWork: vi.fn(),
  listSyncPageWork: vi.fn(),
  findSyncPageByLabel: vi.fn(),
  readSyncPageStatuses: vi.fn(),
  requestSyncProbe: vi.fn(),
  listSyncPages: vi.fn(),
  requestPageSync: vi.fn(),
}));

vi.mock("../apps/runtime/src/sync/context.ts", () => ({
  createSyncContext: mocks.createSyncContext,
}));

vi.mock("../apps/runtime/src/sync/inspect.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof InspectModule>();
  return {
    ...actual,
    changeSyncPageModeByOwner: mocks.changeSyncPageModeByOwner,
    changeSyncPagePause: mocks.changeSyncPagePause,
    changeSyncRegistryOverride: mocks.changeSyncRegistryOverride,
    confirmStoppedSyncOwners: mocks.confirmStoppedSyncOwners,
    explainSyncWork: mocks.explainSyncWork,
    listSyncPageWork: mocks.listSyncPageWork,
    findSyncPageByLabel: mocks.findSyncPageByLabel,
    readSyncPageStatuses: mocks.readSyncPageStatuses,
    requestSyncProbe: mocks.requestSyncProbe,
  };
});

vi.mock("@agency_hub_core/db", async (importOriginal) => {
  const actual = await importOriginal<typeof DbModule>();
  return { ...actual, listSyncPages: mocks.listSyncPages };
});

// The legacy `sync --page` must keep its own flag: it never reaches a database.
vi.mock("../apps/runtime/src/bootstrap.ts", () => ({
  createAppContext: vi.fn(async () => {
    throw new Error("legacy sync reached createAppContext");
  }),
}));

import { INDEFINITE_UNTIL } from "@agency_hub_core/shared";

import { buildProgram } from "../apps/runtime/src/cli.ts";

const PAGE_ROW = { pageId: 7, pageLabel: "lora-1" };

async function run(argv: string[]): Promise<void> {
  const program = buildProgram();
  const quiet = (command: typeof program) => {
    command.exitOverride();
    command.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    for (const child of command.commands) quiet(child);
  };
  quiet(program);
  await program.parseAsync(argv, { from: "user" });
}

describe("the engine's owner commands through `pnpm cli`", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.createSyncContext.mockResolvedValue({ db: {}, rawConfig: {}, close: mocks.close });
    mocks.findSyncPageByLabel.mockResolvedValue(PAGE_ROW);
    mocks.readSyncPageStatuses.mockResolvedValue([{ page: "lora-1" }]);
    mocks.explainSyncWork.mockResolvedValue({ why: "test" });
    mocks.changeSyncPageModeByOwner.mockResolvedValue({ kind: "changed", from: "shadow", to: "off" });
    mocks.changeSyncPagePause.mockResolvedValue({
      pageLabel: "lora-1",
      pausedAll: false,
      pausedRequests: false,
      pausedResources: ["media-stats.walk"],
      pauseNote: null,
    });
    mocks.confirmStoppedSyncOwners.mockResolvedValue([]);
    mocks.requestSyncProbe.mockResolvedValue({ workId: 9 });
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sync page mode takes its --page", async () => {
    await run(["sync", "page", "mode", "--page", "lora-1", "--to", "off", "--note", "retired"]);
    expect(mocks.changeSyncPageModeByOwner).toHaveBeenCalledWith({}, {
      pageLabel: "lora-1",
      to: "off",
      changedBy: expect.stringMatching(/: retired$/),
    });
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it.each(["pause", "resume"] as const)("sync page %s takes its --page", async (action) => {
    await run(["sync", "page", action, "--page", "lora-1", "--resource", "media-stats.walk"]);
    expect(mocks.changeSyncPagePause).toHaveBeenCalledWith({}, expect.anything(), {
      pageLabel: "lora-1",
      action,
      all: false,
      requests: false,
      resources: ["media-stats.walk"],
    });
  });

  it("sync page override takes its --page", async () => {
    await run(["sync", "page", "override", "--page", "lora-1", "--resource", "media-stats.walk", "--period-ms", "60000"]);
    expect(mocks.changeSyncRegistryOverride).toHaveBeenCalledWith({}, expect.anything(), {
      pageLabel: "lora-1",
      resource: "media-stats.walk",
      override: { everyMs: 60_000 },
      ownerApproved: false,
    });
  });

  it("sync page override takes the vault walk's periods and the media-stats tiers (owner decision №6)", async () => {
    await run([
      "sync", "page", "override", "--page", "lora-1", "--resource", "catalog.vault",
      "--period-ms", "43200000", "--full-period-ms", "259200000", "--owner-approved",
    ]);
    expect(mocks.changeSyncRegistryOverride).toHaveBeenLastCalledWith({}, expect.anything(), {
      pageLabel: "lora-1",
      resource: "catalog.vault",
      override: { everyMs: 43_200_000, fullEveryMs: 259_200_000 },
      ownerApproved: true,
    });
    await run(["sync", "page", "override", "--page", "lora-1", "--resource", "catalog.vault", "--full-period-ms", "259200000", "--owner-approved"]);
    expect(mocks.changeSyncRegistryOverride.mock.lastCall![2]).toMatchObject({ override: { fullEveryMs: 259_200_000 } });
    const tiers = [{ maxAgeDays: 14, everyMs: 43_200_000 }, { maxAgeDays: 60, everyMs: 259_200_000 }, { maxAgeDays: null, everyMs: 1_209_600_000 }];
    await run(["sync", "page", "override", "--page", "lora-1", "--resource", "media-stats.walk", "--tiers", JSON.stringify(tiers), "--owner-approved"]);
    expect(mocks.changeSyncRegistryOverride.mock.lastCall![2]).toEqual({
      pageLabel: "lora-1", resource: "media-stats.walk", override: { tiers }, ownerApproved: true,
    });
    await expect(run(["sync", "page", "override", "--page", "lora-1", "--resource", "media-stats.walk", "--tiers", "[1]"]))
      .rejects.toThrow("Expected a JSON list of {maxAgeDays, everyMs}");
    await expect(run([
      "sync", "page", "override", "--page", "lora-1", "--resource", "media-stats.walk", "--tiers", JSON.stringify(tiers), "--period-ms", "1000",
    ])).rejects.toThrow("override takes exactly one of");
    expect(mocks.changeSyncRegistryOverride).toHaveBeenCalledTimes(3);
  });

  it("sync page status --page reads that page only", async () => {
    await run(["sync", "page", "status", "--page", "lora-1"]);
    expect(mocks.findSyncPageByLabel).toHaveBeenCalledWith({}, "lora-1");
    expect(mocks.listSyncPages).not.toHaveBeenCalled();
    expect(mocks.readSyncPageStatuses).toHaveBeenCalledTimes(1);
    expect(mocks.readSyncPageStatuses).toHaveBeenCalledWith({}, {}, [PAGE_ROW]);
  });

  it("sync why takes its --page", async () => {
    await run(["sync", "why", "--page", "lora-1", "--resource", "dm-messages.head", "--subject", "42"]);
    expect(mocks.findSyncPageByLabel).toHaveBeenCalledWith({}, "lora-1");
    expect(mocks.explainSyncWork).toHaveBeenCalledWith({}, {}, PAGE_ROW, { resource: "dm-messages.head", subject: "42" });
  });

  it("sync probe takes its --page, the route and its JSON parameters", async () => {
    await run(["sync", "probe", "--page", "lora-1", "--operation", "media.offer_stats", "--params", '{"mediaOfferId":"1","beforeMs":2,"afterMs":1,"periodMs":86400000}']);
    expect(mocks.requestSyncProbe).toHaveBeenCalledWith({}, expect.anything(), {
      pageLabel: "lora-1",
      operation: "media.offer_stats",
      params: { mediaOfferId: "1", beforeMs: 2, afterMs: 1, periodMs: 86_400_000 },
      requestedBy: expect.stringMatching(/^cli@/),
    });
    await run(["sync", "probe", "--page", "lora-1", "--operation", "polls"]);
    expect(mocks.requestSyncProbe).toHaveBeenLastCalledWith({}, expect.anything(), expect.objectContaining({ operation: "polls", params: {} }));
    await expect(run(["sync", "probe", "--page", "lora-1", "--operation", "polls", "--params", "[1]"])).rejects.toThrow("Expected a JSON object");
  });

  it("sync ownership confirm-stopped --page confirms that page only", async () => {
    await run([
      "sync", "ownership", "confirm-stopped",
      "--running-hosts", "abc,def",
      "--acquired-before", "2026-10-02T10:00:00.000Z",
      "--page", "lora-1",
      "--dry-run",
    ]);
    expect(mocks.confirmStoppedSyncOwners).toHaveBeenCalledWith({}, expect.objectContaining({
      runningHosts: ["abc", "def"],
      acquiredBefore: new Date("2026-10-02T10:00:00.000Z"),
      dryRun: true,
      pageLabel: "lora-1",
    }));
  });

  it("the deploy's confirm-stopped (no --page) confirms every page", async () => {
    await run(["sync", "ownership", "confirm-stopped", "--running-hosts", "abc", "--acquired-before", "2026-10-02T10:00:00.000Z"]);
    const input = mocks.confirmStoppedSyncOwners.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(input).not.toHaveProperty("pageLabel");
    expect(input.dryRun).toBe(false);
  });

  // S4-35: the table listed an ownerless page with a heartbeat and left the
  // reader to judge its age. It concludes now: `runs`.
  it("sync ownership status says whether each page's owner runs it, and why not", async () => {
    const now = new Date("2026-10-04T12:00:00.000Z");
    const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000);
    const owner = (overrides: Record<string, unknown> = {}) => ({
      generation: 4n, host: "sync-1", pid: 1, acquiredAt: ago(7200), heartbeatAt: ago(4), releasedAt: null,
      releaseGeneration: null, stopConfirmedAt: null, ...overrides,
    });
    mocks.listSyncPages.mockResolvedValue([
      { pageId: 1, pageLabel: "lora-1", mode: "live", dbNow: now, owner: owner() },
      { pageId: 2, pageLabel: "lora-2", mode: "live", dbNow: now, owner: owner({ heartbeatAt: ago(3600) }) },
      { pageId: 3, pageLabel: "lora-3", mode: "live", dbNow: now, owner: owner({ releasedAt: ago(60), releaseGeneration: 4n }) },
      { pageId: 4, pageLabel: "lora-4", mode: "live", dbNow: now, owner: owner({ generation: 0n, host: null, pid: null, acquiredAt: null, heartbeatAt: null }) },
      { pageId: 5, pageLabel: "lora-5", mode: "off", dbNow: now, owner: owner() },
    ]);
    await run(["sync", "ownership", "status"]);
    const lines = vi.mocked(console.log).mock.calls.map(([line]) => String(line).split("\t"));
    expect(lines[0]).toEqual(["page", "mode", "generation", "owner", "acquired_at", "heartbeat_at", "released", "stop_confirmed_at", "runs"]);
    const runs = Object.fromEntries(lines.slice(1).map((cells) => [cells[0], cells[8]]));
    expect(runs).toEqual({
      "lora-1": "yes",
      "lora-2": "no: the heartbeat is 3600 s old (an owner beats every 10 s; fresh within 30 s)",
      "lora-3": "no: its owner released it",
      "lora-4": "no: no host has taken the page",
      "lora-5": "no: the page is off (no actor runs it)",
    });
    // The heartbeat itself is still printed: the conclusion stands beside it.
    expect(lines[2]![5]).toBe(ago(3600).toISOString());
  });

  // A hold only new credentials lift ends at no instant: `Date#toISOString`
  // wrote it as the year 275760.
  it("sync work list and sync why print an endless hold as infinity", async () => {
    const waiting = [{
      work: { id: 9, resource: "account.poll", subject: "", dueAt: new Date("2026-10-04T12:00:00.000Z"), breakerUntil: null },
      waiting: { reason: "page_hold", until: INDEFINITE_UNTIL, detail: { kind: "auth" } },
    }];
    mocks.listSyncPageWork.mockResolvedValue(waiting);
    mocks.explainSyncWork.mockResolvedValue(waiting);
    for (const argv of [
      ["sync", "work", "list", "--page", "lora-1", "--state", "open"],
      ["sync", "why", "--page", "lora-1", "--resource", "account.poll"],
    ]) {
      vi.mocked(console.log).mockClear();
      await run(argv);
      const printed = JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0])) as typeof waiting;
      expect(printed[0]!.waiting, argv.join(" ")).toEqual({ reason: "page_hold", until: "infinity", detail: { kind: "auth" } });
      // An instant a clock reaches is printed as it was.
      expect(printed[0]!.work.dueAt).toBe("2026-10-04T12:00:00.000Z");
      expect(String(vi.mocked(console.log).mock.calls[0]?.[0])).not.toContain("275760");
    }
    expect(mocks.listSyncPageWork).toHaveBeenCalledWith({}, {}, PAGE_ROW, { state: "open", limit: 50, offset: 0 });
  });

  it("a missing --page is still refused", async () => {
    await expect(run(["sync", "page", "mode", "--to", "off"])).rejects.toThrow("required option '--page <label>' not specified");
    expect(mocks.changeSyncPageModeByOwner).not.toHaveBeenCalled();
  });

  it("the legacy `sync --page` keeps its own flag", async () => {
    await expect(run(["sync", "--page", "lora-1", "--scope", "light"])).rejects.toThrow("legacy sync reached createAppContext");
    await expect(run(["sync", "--scope", "light"])).rejects.toThrow("required option '--page <label>' not specified");
  });
});
