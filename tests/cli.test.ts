import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cliMocks = vi.hoisted(() => {
  const bossBehavior = {
    sendError: null as Error | null,
  };
  const bossInstances: Array<{
    createQueue: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  }> = [];

  class PgBossMock {
    start = vi.fn(async () => {});
    createQueue = vi.fn(async () => {});
    send = vi.fn(async () => {
      if (bossBehavior.sendError) {
        throw bossBehavior.sendError;
      }
    });
    stop = vi.fn(async () => {});

    constructor() {
      bossInstances.push(this);
    }
  }

  return {
    PgBossMock,
    bossBehavior,
    bossInstances,
    createAppContext: vi.fn(),
    onboardFanslyPage: vi.fn(),
    onboardOnlyFansPage: vi.fn(),
  };
});

vi.mock("pg-boss", () => ({
  default: cliMocks.PgBossMock,
}));

vi.mock("../apps/runtime/src/bootstrap.ts", () => ({
  createAppContext: cliMocks.createAppContext,
}));

vi.mock("../apps/runtime/src/services/page-onboarding.ts", () => ({
  onboardFanslyPage: cliMocks.onboardFanslyPage,
  onboardOnlyFansPage: cliMocks.onboardOnlyFansPage,
}));

import { buildProgram } from "../apps/runtime/src/cli.ts";
import { SYNC_TRIGGER_QUEUE } from "../apps/runtime/src/services/sync-queue.ts";
import {
  renderStatusDetail,
  renderWatchEventLine,
  renderWatchTty,
} from "../apps/runtime/src/services/sync/view.ts";

function createProgramHarness() {
  const program = buildProgram();
  program.exitOverride();
  program.configureOutput({
    writeOut: () => {},
    writeErr: () => {},
    outputError: (str, write) => {
      write(str);
    },
  });

  return {
    program,
  };
}

async function createTempJsonFile(name: string, contents: Record<string, unknown>) {
  const directory = await mkdtemp(path.join(tmpdir(), "cli-test-"));
  const filePath = path.join(directory, name);
  await writeFile(filePath, JSON.stringify(contents), "utf8");

  return {
    directory,
    filePath,
  };
}

describe("CLI parsing", () => {
  const cleanupDirectories = new Set<string>();

  beforeEach(() => {
    cliMocks.bossBehavior.sendError = null;
    cliMocks.bossInstances.length = 0;
    cliMocks.createAppContext.mockReset();
    cliMocks.onboardFanslyPage.mockReset();
    cliMocks.onboardOnlyFansPage.mockReset();

    cliMocks.createAppContext.mockResolvedValue({
      config: {
        databaseUrl: "postgres://postgres:postgres@127.0.0.1:5432/testdb",
      },
      db: {},
      pool: {},
      logger: {},
      adapter: {},
      onlyFansAdapter: {},
      close: vi.fn(async () => {}),
    });
  });

  afterEach(async () => {
    for (const directory of cleanupDirectories) {
      await rm(directory, { recursive: true, force: true });
    }
    cleanupDirectories.clear();
    vi.restoreAllMocks();
  });

  it("documents sync --page and rejects sync --account", async () => {
    const helpProgram = buildProgram();
    const syncCommand = helpProgram.commands.find((command) => command.name() === "sync");
    expect(syncCommand).toBeDefined();
    const syncHelp = syncCommand?.helpInformation();
    expect(syncHelp).toContain("--page <label>");
    expect(syncHelp).not.toContain("--account <label>");

    const invalidHarness = createProgramHarness();
    const invalidSyncCommand = invalidHarness.program.commands.find(
      (command) => command.name() === "sync",
    );
    expect(invalidSyncCommand).toBeDefined();
    invalidSyncCommand?.exitOverride();
    invalidSyncCommand?.configureOutput({
      writeOut: () => {},
      writeErr: () => {},
      outputError: () => {},
    });
    await expect(
      invalidSyncCommand!.parseAsync(["--account", "lora-main"], { from: "user" }),
    ).rejects.toThrow("required option '--page <label>' not specified");
  });

  it("documents apikey create as username-only with optional page assignment", () => {
    const helpProgram = buildProgram();
    const apiKeyCommand = helpProgram.commands.find((command) => command.name() === "apikey");
    expect(apiKeyCommand).toBeDefined();

    const createCommand = apiKeyCommand?.commands.find((command) => command.name() === "create");
    expect(createCommand).toBeDefined();

    const help = createCommand?.helpInformation();
    expect(help).toContain("--username <username>");
    expect(help).toContain("--page <label>");
    expect(help).toContain("also assign the user to this page");
  });

  it("documents page add onlyfans and model revenue", () => {
    const helpProgram = buildProgram();
    const pageCommand = helpProgram.commands.find((command) => command.name() === "page");
    expect(pageCommand).toBeDefined();
    const addCommand = pageCommand?.commands.find((command) => command.name() === "add");
    expect(addCommand).toBeDefined();
    const onlyFansCommand = addCommand?.commands.find((command) => command.name() === "onlyfans");
    expect(onlyFansCommand).toBeDefined();
    const onlyFansHelp = onlyFansCommand?.helpInformation();
    expect(onlyFansHelp).toContain("--token-file <file>");
    expect(onlyFansHelp).toContain("--username <username>");

    const modelCommand = helpProgram.commands.find((command) => command.name() === "model");
    expect(modelCommand).toBeDefined();
    const revenueCommand = modelCommand?.commands.find((command) => command.name() === "revenue");
    expect(revenueCommand).toBeDefined();
    const revenueHelp = revenueCommand?.helpInformation();
    expect(revenueHelp).toContain("--slug <slug>");
    expect(revenueHelp).toContain("--period <period>");
  });

  it("queues an initial full sync after adding a Fansly page", async () => {
    const tempFile = await createTempJsonFile("fansly-session.json", {
      authorization: "token",
    });
    cleanupDirectories.add(tempFile.directory);
    cliMocks.onboardFanslyPage.mockResolvedValue({
      page: {
        id: 101,
        label: "lora-main",
      },
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram();

    await program.parseAsync([
      "page",
      "add",
      "fansly",
      "--model",
      "lora",
      "--label",
      "lora-main",
      "--session-file",
      tempFile.filePath,
    ], { from: "user" });

    expect(cliMocks.onboardFanslyPage).toHaveBeenCalledWith(expect.anything(), {
      modelSlug: "lora",
      label: "lora-main",
      session: {
        authorization: "token",
      },
      proxy: null,
    });

    const boss = cliMocks.bossInstances[0];
    expect(boss).toBeDefined();
    expect(boss.start).toHaveBeenCalledTimes(1);
    expect(boss.createQueue).toHaveBeenCalledWith(SYNC_TRIGGER_QUEUE);
    expect(boss.send).toHaveBeenCalledWith(SYNC_TRIGGER_QUEUE, {
      pageLabel: "lora-main",
      scope: "all",
    });
    expect(boss.stop).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith("Created Fansly page lora-main (101)");
    expect(logSpy).toHaveBeenCalledWith("Queued initial full sync for lora-main");
  });

  it("queues an initial full sync after adding an OnlyFans page", async () => {
    const tempFile = await createTempJsonFile("onlyfans-token.json", {
      token: "om-token",
    });
    cleanupDirectories.add(tempFile.directory);
    cliMocks.onboardOnlyFansPage.mockResolvedValue({
      page: {
        id: 202,
        label: "lora-of",
      },
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram();

    await program.parseAsync([
      "page",
      "add",
      "onlyfans",
      "--model",
      "lora",
      "--label",
      "lora-of",
      "--token-file",
      tempFile.filePath,
      "--username",
      "lora_onlyfans",
    ], { from: "user" });

    expect(cliMocks.onboardOnlyFansPage).toHaveBeenCalledWith(expect.anything(), {
      modelSlug: "lora",
      label: "lora-of",
      auth: {
        token: "om-token",
      },
      username: "lora_onlyfans",
      proxy: null,
    });

    const boss = cliMocks.bossInstances[0];
    expect(boss).toBeDefined();
    expect(boss.start).toHaveBeenCalledTimes(1);
    expect(boss.createQueue).toHaveBeenCalledWith(SYNC_TRIGGER_QUEUE);
    expect(boss.send).toHaveBeenCalledWith(SYNC_TRIGGER_QUEUE, {
      pageLabel: "lora-of",
      scope: "all",
    });
    expect(boss.stop).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith("Created OnlyFans page lora-of (202)");
    expect(logSpy).toHaveBeenCalledWith("Queued initial full sync for lora-of");
  });

  it("surfaces enqueue failures after the page has been created", async () => {
    const tempFile = await createTempJsonFile("fansly-session.json", {
      authorization: "token",
    });
    cleanupDirectories.add(tempFile.directory);
    cliMocks.onboardFanslyPage.mockResolvedValue({
      page: {
        id: 303,
        label: "failed-page",
      },
    });
    cliMocks.bossBehavior.sendError = new Error("queue down");

    const program = buildProgram();

    await expect(program.parseAsync([
      "page",
      "add",
      "fansly",
      "--model",
      "lora",
      "--label",
      "failed-page",
      "--session-file",
      tempFile.filePath,
    ], { from: "user" })).rejects.toThrow(
      'Page "failed-page" was created, but the automatic sync could not be queued: queue down',
    );

    const boss = cliMocks.bossInstances[0];
    expect(boss.stop).toHaveBeenCalledTimes(1);
  });

  it("renders detailed status and both watch output paths", () => {
    const run = {
      runId: 12,
      pageLabel: "lana",
      platform: "fansly" as const,
      stream: "light",
      trigger: "worker",
      status: "success",
      startedAt: new Date("2026-03-10T10:00:00.000Z"),
      finishedAt: new Date("2026-03-10T10:00:05.000Z"),
      errorSummary: null,
      stats: {
        health: "healthy",
        requestTotals: {
          totalAttempts: 4,
          logicalRequests: 4,
          retryAttempts: 0,
          failedAttempts: 0,
        },
        anomalies: [],
        checkpoint: {
          before: {
            transactions: null,
          },
          after: {
            transactions: {
              cursorTimestamp: "2026-03-10T09:59:00.000Z",
            },
          },
          advanced: {
            transactions: true,
          },
        },
        boundary: {
          kind: "after",
          requestedLowerBound: "2026-03-03T10:00:00.000Z",
          olderThanBoundaryItems: 0,
          olderThanBoundaryPages: 0,
        },
        scan: {
          transactionPages: 1,
          processedTransactions: 12,
        },
      },
    };
    const events = [{
      id: 1,
      runId: 12,
      pageLabel: "lana",
      provider: "fansly" as const,
      stream: "light",
      eventType: "run_started",
      severity: "info" as const,
      message: "Sync run started",
      details: {},
      emittedAt: new Date("2026-03-10T10:00:00.000Z"),
    }];
    const attempts = [{
      attemptId: 1,
      runId: 12,
      pageLabel: "lana",
      provider: "fansly" as const,
      stream: "light",
      operation: "account_me",
      logicalRequestId: "account_me:test",
      attemptNumber: 1,
      state: "success",
      failureKind: null,
      httpStatus: 200,
      retryDelayMs: null,
      durationMs: 120,
      requestShape: {},
      responseShape: {},
      errorMessage: null,
      startedAt: new Date("2026-03-10T10:00:00.000Z"),
      finishedAt: new Date("2026-03-10T10:00:00.120Z"),
    }];

    const detail = renderStatusDetail({ run, events, attempts });
    const tty = renderWatchTty({
      runningRuns: [
        {
          ...run,
          status: "running",
          finishedAt: null,
          lastActivityAt: new Date("2026-03-10T10:00:10.000Z"),
        },
      ],
      recentRuns: [run],
      inflightAttempts: attempts.map((attempt) => ({
        ...attempt,
        state: "started",
        finishedAt: null,
      })),
      events,
    }, new Date("2026-03-10T10:00:20.000Z"));
    const nonTty = renderWatchEventLine(events[0]!);

    expect(detail).toContain("Run 12 lana light");
    expect(detail).toContain("Requests: attempts=4");
    expect(tty).toContain("Sync Watch 2026-03-10T10:00:20.000Z");
    expect(tty).toContain("Active Runs");
    expect(nonTty).toContain("event=run_started");
  });

  it("renders observability views when timestamps arrive as strings", () => {
    const run = {
      runId: 13,
      pageLabel: "lana",
      platform: "fansly" as const,
      stream: "light",
      trigger: "cli",
      status: "success",
      startedAt: "2026-03-10T10:00:00.000Z",
      finishedAt: "not-a-date",
      errorSummary: null,
      stats: {
        health: "healthy",
        requestTotals: {
          totalAttempts: 1,
          logicalRequests: 1,
          retryAttempts: 0,
          failedAttempts: 0,
        },
        anomalies: [],
      },
    };
    const events = [{
      id: 2,
      runId: 13,
      pageLabel: "lana",
      provider: "fansly" as const,
      stream: "light",
      eventType: "phase_started",
      severity: "warn" as const,
      message: "Still running",
      details: {},
      emittedAt: "not-a-date",
    }];
    const attempts = [{
      attemptId: 2,
      runId: 13,
      pageLabel: "lana",
      provider: "fansly" as const,
      stream: "light",
      operation: "account_me",
      logicalRequestId: "account_me:test",
      attemptNumber: 1,
      state: "started",
      failureKind: null,
      httpStatus: null,
      retryDelayMs: null,
      durationMs: null,
      requestShape: {},
      responseShape: {},
      errorMessage: null,
      startedAt: "not-a-date",
      finishedAt: null,
    }];

    const detail = renderStatusDetail({ run, events, attempts });
    const tty = renderWatchTty({
      runningRuns: [
        {
          ...run,
          status: "running",
          finishedAt: null,
          lastActivityAt: "2026-03-10T10:00:10.000Z",
        },
      ],
      recentRuns: [run],
      inflightAttempts: attempts,
      events,
    }, new Date("2026-03-10T10:00:20.000Z"));
    const nonTty = renderWatchEventLine(events[0]!);

    expect(detail).toContain("Run 13 lana light");
    expect(detail).toContain("Finished: -");
    expect(tty).toContain("- [warn] lana/light phase_started Still running");
    expect(nonTty).toContain(
      "- run=13 page=lana stream=light event=phase_started severity=warn Still running",
    );
  });
});
