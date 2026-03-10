import { describe, expect, it } from "vitest";

import { buildProgram } from "../apps/runtime/src/cli.ts";
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

describe("CLI parsing", () => {
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

    expect(detail).toContain("Started: 2026-03-10T10:00:00.000Z");
    expect(detail).toContain("Finished: -");
    expect(detail).toContain("Duration: -");
    expect(detail).toContain("Request Attempts:");
    expect(tty).toContain("Sync Watch 2026-03-10T10:00:20.000Z");
    expect(tty).toContain("Recent Events");
    expect(nonTty).toContain("- run=13 page=lana");
  });
});
