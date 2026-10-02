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
  findSyncPageByLabel: vi.fn(),
  readSyncPageStatus: vi.fn(),
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
    findSyncPageByLabel: mocks.findSyncPageByLabel,
    readSyncPageStatus: mocks.readSyncPageStatus,
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
    mocks.readSyncPageStatus.mockResolvedValue({ page: "lora-1" });
    mocks.explainSyncWork.mockResolvedValue({ why: "test" });
    mocks.changeSyncPageModeByOwner.mockResolvedValue({ kind: "changed", from: "off", to: "shadow" });
    mocks.changeSyncPagePause.mockResolvedValue({
      pageLabel: "lora-1",
      pausedAll: false,
      pausedRequests: false,
      pausedResources: ["media-stats.walk"],
      pauseNote: null,
    });
    mocks.confirmStoppedSyncOwners.mockResolvedValue([]);
    mocks.requestSyncProbe.mockResolvedValue({ workId: 9, shadow: true });
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sync page mode takes its --page", async () => {
    await run(["sync", "page", "mode", "--page", "lora-1", "--to", "shadow", "--note", "acceptance"]);
    expect(mocks.changeSyncPageModeByOwner).toHaveBeenCalledWith({}, {
      pageLabel: "lora-1",
      to: "shadow",
      changedBy: expect.stringMatching(/: acceptance$/),
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

  it("sync page status --page reads that page only", async () => {
    await run(["sync", "page", "status", "--page", "lora-1"]);
    expect(mocks.findSyncPageByLabel).toHaveBeenCalledWith({}, "lora-1");
    expect(mocks.listSyncPages).not.toHaveBeenCalled();
    expect(mocks.readSyncPageStatus).toHaveBeenCalledTimes(1);
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

  it("a missing --page is still refused", async () => {
    await expect(run(["sync", "page", "mode", "--to", "shadow"])).rejects.toThrow("required option '--page <label>' not specified");
    expect(mocks.changeSyncPageModeByOwner).not.toHaveBeenCalled();
  });

  it("the legacy `sync --page` keeps its own flag", async () => {
    await expect(run(["sync", "--page", "lora-1", "--scope", "light"])).rejects.toThrow("legacy sync reached createAppContext");
    await expect(run(["sync", "--scope", "light"])).rejects.toThrow("required option '--page <label>' not specified");
  });
});
