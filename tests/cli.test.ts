import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as DbModule from "@agency_hub_core/db";
import type * as SyncServiceModule from "../apps/runtime/src/services/sync.ts";
import type { ConstructorOptions, Queue, SendOptions, StopOptions } from "pg-boss";

const cliMocks = vi.hoisted(() => {
  const bossBehavior = {
    sendError: null as Error | null,
    sendResult: "job-1" as string | null,
  };
  const bossInstances: Array<{
    createQueue: ReturnType<typeof vi.fn>;
    getQueue: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    updateQueue: ReturnType<typeof vi.fn>;
  }> = [];

  class PgBossMock {
    start = vi.fn(async (): Promise<this> => this);
    on = vi.fn((_event: string, _listener: (...args: unknown[]) => void): this => this);
    createQueue = vi.fn(async (_name: string, _options?: Omit<Queue, "name">) => {});
    updateQueue = vi.fn(async (_name: string, _options?: Omit<Queue, "name" | "partition" | "policy">) => {});
    getQueue = vi.fn(async (name: string) => ({
      name,
      policy: "exclusive" as const,
      expireInSeconds: 15 * 60,
      heartbeatSeconds: 30,
      retryLimit: 0,
    }));
    send = vi.fn(async (_name: string, _data?: object | null, _options?: SendOptions) => {
      if (bossBehavior.sendError) {
        throw bossBehavior.sendError;
      }

      return bossBehavior.sendResult;
    });
    stop = vi.fn(async (_options?: StopOptions) => {});

    constructor(_options?: string | ConstructorOptions) {
      bossInstances.push(this);
    }
  }

  return {
    PgBossMock,
    backfillFanslyPageAliases: vi.fn(),
    bossBehavior,
    bossInstances,
    countHarvestObservations: vi.fn(),
    createAppContext: vi.fn(),
    findPageByLabel: vi.fn(),
    findUserByUsername: vi.fn(),
    handleSuccessfulPageVerificationRecovery: vi.fn(),
    insertDeliveryAttempt: vi.fn(),
    listPages: vi.fn(),
    listHarvestTransactionResidue: vi.fn(),
    onboardFanslyPage: vi.fn(),
    onboardOnlyFansPage: vi.fn(),
    request: vi.fn(),
    requestPageSync: vi.fn(),
    waitForRequestedSyncRequests: vi.fn(),
    removePageProxy: vi.fn(),
    sendDailyRevenueTelegramReport: vi.fn(),
    sendManualDailyRevenueTelegramReport: vi.fn(),
    sendTelegramTestMessage: vi.fn(),
    setPageProxy: vi.fn(),
    verifyServiceEgress: vi.fn(),
  };
});

vi.mock("pg-boss", () => ({
  PgBoss: cliMocks.PgBossMock,
}));

vi.mock("@agency_hub_core/db", async (importOriginal) => {
  const actual = await importOriginal<typeof DbModule>();

  return {
    ...actual,
    countHarvestObservations: cliMocks.countHarvestObservations,
    findPageByLabel: cliMocks.findPageByLabel,
    findUserByUsername: cliMocks.findUserByUsername,
    insertDeliveryAttempt: cliMocks.insertDeliveryAttempt,
    listHarvestTransactionResidue: cliMocks.listHarvestTransactionResidue,
  };
});

vi.mock("undici", () => ({
  request: cliMocks.request,
}));

vi.mock("../apps/runtime/src/bootstrap.ts", () => ({
  createAppContext: cliMocks.createAppContext,
}));

vi.mock("../apps/runtime/src/services/page-onboarding.ts", () => ({
  onboardFanslyPage: cliMocks.onboardFanslyPage,
  onboardOnlyFansPage: cliMocks.onboardOnlyFansPage,
}));

vi.mock("../apps/runtime/src/services/page-proxies.ts", () => ({
  setPageProxy: cliMocks.setPageProxy,
  removePageProxy: cliMocks.removePageProxy,
}));

vi.mock("../apps/runtime/src/services/fansly-page-alias-backfill.ts", () => ({
  backfillFanslyPageAliases: cliMocks.backfillFanslyPageAliases,
}));

vi.mock("../apps/runtime/src/services/notification-incidents.ts", () => ({
  handleSuccessfulPageVerificationRecovery: cliMocks.handleSuccessfulPageVerificationRecovery,
}));

vi.mock("../apps/runtime/src/services/sync-control.ts", () => ({
  requestPageSync: cliMocks.requestPageSync,
  waitForRequestedSyncRequests: cliMocks.waitForRequestedSyncRequests,
}));

vi.mock("../apps/runtime/src/services/telegram.ts", () => ({
  sendTelegramTestMessage: cliMocks.sendTelegramTestMessage,
}));

vi.mock("../apps/runtime/src/services/service-egress-verify.ts", () => ({
  verifyServiceEgress: cliMocks.verifyServiceEgress,
}));

vi.mock("../apps/runtime/src/services/telegram-report.ts", () => ({
  sendDailyRevenueTelegramReport: cliMocks.sendDailyRevenueTelegramReport,
  sendManualDailyRevenueTelegramReport: cliMocks.sendManualDailyRevenueTelegramReport,
}));

vi.mock("../apps/runtime/src/services/sync.ts", async () => {
  const actual = await vi.importActual<typeof SyncServiceModule>(
    "../apps/runtime/src/services/sync.ts",
  );

  return {
    ...actual,
    listPages: cliMocks.listPages,
  };
});

import { buildProgram } from "../apps/runtime/src/cli.ts";
import { SYNC_PLANNER_QUEUE } from "../apps/runtime/src/services/sync-queue.ts";
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

async function createTempTextFile(name: string, contents: string) {
  const directory = await mkdtemp(path.join(tmpdir(), "cli-test-"));
  const filePath = path.join(directory, name);
  await writeFile(filePath, contents, "utf8");

  return {
    directory,
    filePath,
  };
}

describe("CLI parsing", () => {
  const cleanupDirectories = new Set<string>();

  beforeEach(() => {
    process.exitCode = undefined;
    cliMocks.bossBehavior.sendError = null;
    cliMocks.bossBehavior.sendResult = "job-1";
    cliMocks.bossInstances.length = 0;
    cliMocks.backfillFanslyPageAliases.mockReset();
    cliMocks.createAppContext.mockReset();
    cliMocks.countHarvestObservations.mockReset();
    cliMocks.findPageByLabel.mockReset();
    cliMocks.findUserByUsername.mockReset();
    cliMocks.listPages.mockReset();
    cliMocks.listHarvestTransactionResidue.mockReset();
    cliMocks.onboardFanslyPage.mockReset();
    cliMocks.onboardOnlyFansPage.mockReset();
    cliMocks.request.mockReset();
    cliMocks.requestPageSync.mockReset();
    cliMocks.waitForRequestedSyncRequests.mockReset();
    cliMocks.removePageProxy.mockReset();
    cliMocks.sendDailyRevenueTelegramReport.mockReset();
    cliMocks.sendManualDailyRevenueTelegramReport.mockReset();
    cliMocks.sendTelegramTestMessage.mockReset();
    cliMocks.setPageProxy.mockReset();
    cliMocks.handleSuccessfulPageVerificationRecovery.mockReset();
    cliMocks.insertDeliveryAttempt.mockReset();
    cliMocks.verifyServiceEgress.mockReset();

    cliMocks.createAppContext.mockResolvedValue({
      config: {
        databaseUrl: "postgres://postgres:postgres@127.0.0.1:5432/testdb",
        serviceEgressProxyUrl: "socks5://proxy.example.internal:1080",
        serviceEgressProxyUsername: "fake-service-user",
        serviceEgressProxyPassword: "fake-service-password",
      },
      db: {},
      pool: {},
      logger: {},
      adapter: {},
      onlyFansAdapter: {},
      close: vi.fn(async () => {}),
    });
    cliMocks.findPageByLabel.mockResolvedValue({
      page: {
        id: 44,
        label: "lora-main",
        platform: "fansly",
      },
      credentials: null,
      proxy: null,
    });
    cliMocks.listPages.mockResolvedValue([]);
    cliMocks.countHarvestObservations.mockResolvedValue(0);
    cliMocks.listHarvestTransactionResidue.mockResolvedValue({ total: 0, sample: [] });
    cliMocks.request.mockResolvedValue({
      statusCode: 200,
      body: {
        text: vi.fn(async () => JSON.stringify({ ip: "203.0.113.10" })),
      },
    });
    cliMocks.requestPageSync.mockResolvedValue({
      page: { id: 1, label: "page" },
      requests: [],
      wakeupId: "job-1",
    });
    cliMocks.backfillFanslyPageAliases.mockResolvedValue({
      totalPages: 1,
      totalMembershipsScanned: 10,
      totalUniqueFanIds: 10,
      totalAccountsReturned: 8,
      totalFallbackMisses: 2,
      totalReconciledAccounts: 8,
      totalNotesSeen: 5,
      totalNotesUpserted: 5,
      totalNotesDeactivated: 1,
      totalAliasesSet: 3,
      totalAliasesCleared: 1,
      pages: [{
        pageId: 44,
        pageLabel: "lora-main",
        membershipsScanned: 10,
        uniqueFanIds: 10,
        accountsReturned: 8,
        fallbackMisses: 2,
        reconciledAccounts: 8,
        notesSeen: 5,
        notesUpserted: 5,
        notesDeactivated: 1,
        aliasesSet: 3,
        aliasesCleared: 1,
      }],
    });
    cliMocks.waitForRequestedSyncRequests.mockResolvedValue(undefined);
    cliMocks.removePageProxy.mockResolvedValue(undefined);
    cliMocks.setPageProxy.mockResolvedValue(undefined);
    cliMocks.handleSuccessfulPageVerificationRecovery.mockResolvedValue(undefined);
    cliMocks.sendTelegramTestMessage.mockResolvedValue({
      status: "skipped",
      reason: "unconfigured",
    });
    cliMocks.insertDeliveryAttempt.mockResolvedValue({});
    cliMocks.verifyServiceEgress.mockResolvedValue([{
      consumer: "elevenlabs",
      route: "socks5://proxy.example.internal:1080 (auth)",
      egressKey: "service:socks5://proxy.example.internal:1080",
      exitIp: "203.0.113.10",
    }]);
    cliMocks.sendDailyRevenueTelegramReport.mockResolvedValue({
      delivery: {
        status: "skipped",
        reason: "unconfigured",
      },
      report: null,
    });
    cliMocks.sendManualDailyRevenueTelegramReport.mockResolvedValue({
      delivery: {
        status: "skipped",
        reason: "unconfigured",
      },
      report: null,
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
    ).rejects.toThrow("unknown option '--account'");
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
    // Stage 18: OFAPI-era onboarding takes an identity, not credentials.
    expect(onlyFansHelp).not.toContain("--token-file");
    expect(onlyFansHelp).toContain("--username <username>");

    const modelCommand = helpProgram.commands.find((command) => command.name() === "model");
    expect(modelCommand).toBeDefined();
    const revenueCommand = modelCommand?.commands.find((command) => command.name() === "revenue");
    expect(revenueCommand).toBeDefined();
    const revenueHelp = revenueCommand?.helpInformation();
    expect(revenueHelp).toContain("--slug <slug>");
    expect(revenueHelp).toContain("--period <period>");

    const telegramCommand = helpProgram.commands.find((command) => command.name() === "telegram");
    expect(telegramCommand).toBeDefined();
    const testCommand = telegramCommand?.commands.find((command) => command.name() === "test");
    const reportCommand = telegramCommand?.commands.find((command) => command.name() === "report");
    expect(testCommand).toBeDefined();
    expect(reportCommand).toBeDefined();
  });

  it("returns a failing exit status when harvest reconciliation is incomplete", async () => {
    const tempFile = await createTempJsonFile("harvest-manifest.json", {
      machineId: "11111111-1111-4111-8111-111111111111",
      tables: [
        ["messages", "harvest.messages", 1],
        ["fan_transactions", "harvest.fan_transactions", 0],
        ["outbox", "harvest.outbox", 0],
        ["message_guard_events", "harvest.message_guard_events", 0],
        ["usage_events", "harvest.usage_events", 0],
        ["ai_spend_log", "harvest.ai_spend_log", 0],
        ["credit_log", "harvest.credit_log", 0],
      ].map(([table, kind, walked]) => ({
        table,
        kind,
        walked,
        uploaded: walked,
        duplicates: 0,
      })),
    });
    cleanupDirectories.add(tempFile.directory);
    cliMocks.countHarvestObservations.mockResolvedValue(0);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;

    try {
      const program = buildProgram();
      await program.parseAsync([
        "harvest:reconcile",
        "--manifest",
        tempFile.filePath,
      ], { from: "user" });

      expect(process.exitCode).toBe(1);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("INCOMPLETE: 1 kind(s) mismatch"));
      expect(cliMocks.countHarvestObservations).toHaveBeenCalledWith(expect.anything(), {
        machineId: "11111111-1111-4111-8111-111111111111",
        kind: "harvest.messages",
      });
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("documents page proxy management commands", () => {
    const helpProgram = buildProgram();
    const pageCommand = helpProgram.commands.find((command) => command.name() === "page");
    expect(pageCommand).toBeDefined();

    const setProxyCommand = pageCommand?.commands.find((command) => command.name() === "set-proxy");
    expect(setProxyCommand?.helpInformation()).toContain("--proxy-url <url>");
    expect(setProxyCommand?.helpInformation()).toContain("--page <label>");

    const removeProxyCommand = pageCommand?.commands.find((command) => command.name() === "remove-proxy");
    expect(removeProxyCommand?.helpInformation()).toContain("--page <label>");
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
    expect(cliMocks.requestPageSync).toHaveBeenCalledWith(expect.anything(), boss, {
      pageLabel: "lora-main",
      scope: "all",
      reason: "onboarding",
    });
    expect(boss.stop).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith("Created Fansly page lora-main (101)");
    expect(logSpy).toHaveBeenCalledWith("Queued initial full sync for lora-main");
  });

  it("queues an initial full sync after adding an OnlyFans page", async () => {
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
      "--username",
      "lora_onlyfans",
    ], { from: "user" });

    expect(cliMocks.onboardOnlyFansPage).toHaveBeenCalledWith(expect.anything(), {
      modelSlug: "lora",
      label: "lora-of",
      username: "lora_onlyfans",
    });

    const boss = cliMocks.bossInstances[0];
    expect(boss).toBeDefined();
    expect(boss.start).toHaveBeenCalledTimes(1);
    expect(cliMocks.requestPageSync).toHaveBeenCalledWith(expect.anything(), boss, {
      pageLabel: "lora-of",
      scope: "all",
      reason: "onboarding",
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
    cliMocks.requestPageSync.mockRejectedValueOnce(new Error("queue down"));

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

  it("waits for requested requests by default on sync", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    cliMocks.requestPageSync.mockResolvedValue({
      page: { id: 44, label: "lora-main" },
      requests: [{ stream: "light", requestedSeq: 2 }],
      wakeupId: "job-44",
    });

    const program = buildProgram();
    await program.parseAsync([
      "sync",
      "--page",
      "lora-main",
      "--scope",
      "light",
    ], { from: "user" });

    expect(cliMocks.requestPageSync).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      pageLabel: "lora-main",
      scope: "light",
      reason: "manual",
      onlyFansTransactionsStart: null,
    });
    expect(cliMocks.waitForRequestedSyncRequests).toHaveBeenCalledWith(expect.anything(), {
      pageId: 44,
      requests: [{ stream: "light", requestedSeq: 2 }],
    });
    expect(logSpy).toHaveBeenCalledWith("Completed light sync for lora-main");
  });

  it("supports sync --no-wait without polling page sync state", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    cliMocks.findPageByLabel.mockResolvedValueOnce({
      page: {
        id: 55,
        label: "lora-main",
        platform: "fansly",
      },
      credentials: null,
      proxy: null,
    });
    cliMocks.requestPageSync.mockResolvedValue({
      page: { id: 55, label: "lora-main" },
      requests: [{ stream: "followers", requestedSeq: 1 }],
      wakeupId: "job-55",
    });

    const program = buildProgram();
    await program.parseAsync([
      "sync",
      "--page",
      "lora-main",
      "--scope",
      "followers",
      "--no-wait",
    ], { from: "user" });

    expect(cliMocks.waitForRequestedSyncRequests).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith("Queued followers sync for lora-main");
  });

  it("runs the Fansly page alias backfill with repeated page filters", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram();

    await program.parseAsync([
      "fansly-page-alias-backfill",
      "--page",
      "lora-main",
      "--page",
      "lora-vip",
      "--chunk-size",
      "50",
    ], { from: "user" });

    expect(cliMocks.backfillFanslyPageAliases).toHaveBeenCalledWith(expect.anything(), {
      pageLabels: ["lora-main", "lora-vip"],
      chunkSize: 50,
    });
    expect(logSpy).toHaveBeenCalledWith(
      "page_label\tmemberships_scanned\tunique_fan_ids\taccounts_returned\tfallback_misses\treconciled_accounts\tnotes_seen\tnotes_upserted\tnotes_deactivated\taliases_set\taliases_cleared",
    );
    expect(logSpy).toHaveBeenCalledWith("pages=1");
    expect(logSpy).toHaveBeenCalledWith("aliases_cleared=1");
  });

  it("queues a fresh sync.planner recovery job", async () => {
    cliMocks.bossBehavior.sendResult = "planner-job-1";
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram();

    await program.parseAsync([
      "queue",
      "planner-recover",
    ], { from: "user" });

    const boss = cliMocks.bossInstances[0];
    const app = await cliMocks.createAppContext.mock.results[0]?.value;
    expect(boss).toBeDefined();
    expect(boss.start).toHaveBeenCalledTimes(1);
    expect(boss.createQueue).toHaveBeenCalled();
    expect(boss.send).toHaveBeenCalledWith(SYNC_PLANNER_QUEUE);
    expect(boss.stop).toHaveBeenCalledTimes(1);
    expect(app?.close).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith("Queued sync.planner recovery job planner-job-1");
  });

  it("reports when sync.planner is already queued or active", async () => {
    cliMocks.bossBehavior.sendResult = null;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram();

    await program.parseAsync([
      "queue",
      "planner-recover",
    ], { from: "user" });

    const boss = cliMocks.bossInstances[0];
    const app = await cliMocks.createAppContext.mock.results[0]?.value;
    expect(boss).toBeDefined();
    expect(boss.start).toHaveBeenCalledTimes(1);
    expect(boss.createQueue).toHaveBeenCalled();
    expect(boss.send).toHaveBeenCalledWith(SYNC_PLANNER_QUEUE);
    expect(boss.stop).toHaveBeenCalledTimes(1);
    expect(app?.close).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith("sync.planner is already queued or active");
  });

  it("sends a Telegram test message when configured", async () => {
    cliMocks.sendTelegramTestMessage.mockResolvedValue({
      status: "sent",
      chatId: "6065935464",
      messageId: 123,
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram();

    await program.parseAsync([
      "telegram",
      "test",
    ], { from: "user" });

    const app = await cliMocks.createAppContext.mock.results[0]?.value;
    expect(cliMocks.sendTelegramTestMessage).toHaveBeenCalledWith(expect.anything());
    expect(cliMocks.insertDeliveryAttempt).toHaveBeenCalledWith(expect.anything(), {
      kind: "test",
      status: "sent",
      messageId: 123,
      error: null,
    });
    expect(app?.close).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith("Sent Telegram test message to 6065935464");
    expect(process.exitCode).toBeUndefined();
  });

  it("reports skipped Telegram test messages when unconfigured", async () => {
    cliMocks.sendTelegramTestMessage.mockResolvedValue({
      status: "skipped",
      reason: "unconfigured",
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram();

    await program.parseAsync([
      "telegram",
      "test",
    ], { from: "user" });

    expect(logSpy).toHaveBeenCalledWith("Telegram is not configured; skipping");
    expect(cliMocks.insertDeliveryAttempt).toHaveBeenCalledWith(expect.anything(), {
      kind: "test",
      status: "skipped",
      messageId: null,
      error: "unconfigured",
    });
    expect(process.exitCode).toBe(1);
  });

  it("persists failed Telegram tests and exits nonzero", async () => {
    cliMocks.sendTelegramTestMessage.mockResolvedValue({
      status: "failed",
      error: "fake service proxy unavailable",
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await buildProgram().parseAsync(["telegram", "test"], { from: "user" });

    expect(cliMocks.insertDeliveryAttempt).toHaveBeenCalledWith(expect.anything(), {
      kind: "test",
      status: "failed",
      messageId: null,
      error: "fake service proxy unavailable",
    });
    expect(logSpy).toHaveBeenCalledWith(
      "Telegram test delivery failed: fake service proxy unavailable",
    );
    expect(process.exitCode).toBe(1);
  });

  it("prints only masked service-egress verification summaries", async () => {
    cliMocks.verifyServiceEgress.mockResolvedValue([
      {
        consumer: "elevenlabs",
        route: "socks5://proxy.example.internal:1080 (auth)",
        egressKey: "service:socks5://proxy.example.internal:1080",
        exitIp: "203.0.113.10",
      },
      {
        consumer: "telegram",
        route: "socks5://proxy.example.internal:1080 (auth)",
        egressKey: "service:socks5://proxy.example.internal:1080",
        exitIp: "203.0.113.10",
      },
    ]);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await buildProgram().parseAsync(
      ["service-egress", "verify", "--consumer", "all"],
      { from: "user" },
    );

    expect(cliMocks.verifyServiceEgress).toHaveBeenCalledWith(expect.anything(), "all");
    const output = logSpy.mock.calls.flat().join("\n");
    expect(output).toContain("route=socks5://proxy.example.internal:1080 (auth)");
    expect(output).toContain("egress_key=service:socks5://proxy.example.internal:1080");
    expect(output).toContain("exit_ip=203.0.113.10");
    expect(output).not.toContain("fake-service-user");
    expect(output).not.toContain("fake-service-password");
  });

  it("sends the Telegram daily report when configured", async () => {
    cliMocks.sendManualDailyRevenueTelegramReport.mockResolvedValue({
      delivery: {
        status: "sent",
        chatId: "6065935464",
        messageId: 456,
      },
      report: {
        reportDate: "2026-03-19",
      },
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram();

    await program.parseAsync([
      "telegram",
      "report",
    ], { from: "user" });

    expect(cliMocks.sendManualDailyRevenueTelegramReport).toHaveBeenCalledWith(expect.anything());
    expect(logSpy).toHaveBeenCalledWith("Sent Telegram daily report for 2026-03-19");
  });

  it("reports skipped Telegram daily reports when unconfigured", async () => {
    cliMocks.sendManualDailyRevenueTelegramReport.mockResolvedValue({
      delivery: {
        status: "skipped",
        reason: "unconfigured",
      },
      report: null,
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram();

    await program.parseAsync([
      "telegram",
      "report",
    ], { from: "user" });

    expect(logSpy).toHaveBeenCalledWith("Telegram is not configured; skipping");
  });

  it("sets a proxy on an existing page", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram();

    await program.parseAsync([
      "page",
      "set-proxy",
      "--page",
      "lora-main",
      "--proxy-url",
      "socks5://proxy-user:proxy-pass@127.0.0.1:1080",
    ], { from: "user" });

    expect(cliMocks.setPageProxy).toHaveBeenCalledWith(expect.anything(), "lora-main", {
      url: "socks5://proxy-user:proxy-pass@127.0.0.1:1080",
      username: null,
      password: null,
    });
    expect(logSpy).toHaveBeenCalledWith("Updated proxy for page lora-main");
  });

  it("reads proxy passwords from files to avoid putting secrets in argv", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const secret = await createTempTextFile("proxy-password.txt", "proxy-pass\n");
    cleanupDirectories.add(secret.directory);
    const program = buildProgram();

    await program.parseAsync([
      "page",
      "set-proxy",
      "--page",
      "lora-main",
      "--proxy-url",
      "socks5://proxy.example:1080",
      "--proxy-username",
      "proxy-user",
      "--proxy-password-file",
      secret.filePath,
    ], { from: "user" });

    expect(cliMocks.setPageProxy).toHaveBeenCalledWith(expect.anything(), "lora-main", {
      url: "socks5://proxy.example:1080",
      username: "proxy-user",
      password: "proxy-pass",
    });
    expect(logSpy).toHaveBeenCalledWith("Updated proxy for page lora-main");
  });

  it("removes a proxy from an existing page", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram();

    await program.parseAsync([
      "page",
      "remove-proxy",
      "--page",
      "lora-main",
    ], { from: "user" });

    expect(cliMocks.removePageProxy).toHaveBeenCalledWith(expect.anything(), "lora-main");
    expect(logSpy).toHaveBeenCalledWith("Removed proxy for page lora-main");
  });

  it("shows masked proxy state in page list output", async () => {
    cliMocks.listPages.mockResolvedValue([{
      platform: "fansly",
      model: "lora",
      label: "lora-main",
      username: "lora",
      follower_count: 42,
      subscriber_count: 7,
      last_light_sync_at: "2026-03-10T10:00:00.000Z",
      last_follower_sync_at: "2026-03-10T11:00:00.000Z",
      proxy_url: "socks5://proxy-user:proxy-pass@127.0.0.1:1080",
      proxy_has_auth: false,
    }]);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram();

    await program.parseAsync([
      "page",
      "list",
    ], { from: "user" });

    expect(logSpy).toHaveBeenNthCalledWith(
      1,
      "platform\tmodel\tlabel\tusername\tfollower_count\tsubscriber_count\tlast_light_sync_at\tlast_follower_sync_at\tproxy",
    );
    expect(logSpy).toHaveBeenNthCalledWith(
      2,
      "fansly\tlora\tlora-main\tlora\t42\t7\t2026-03-10T10:00:00.000Z\t2026-03-10T11:00:00.000Z\tsocks5://127.0.0.1:1080 (auth)",
    );
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

  it("ai:feature-smoke fails fast on coach-chat without --question", async () => {
    // Blocker 5: the T5 gate rejects coach-chat with no chatterQuestion, so the
    // smoke must fail with a clear CLI message BEFORE opening the app context /
    // spending a provider call — never a bare server 400.
    const program = buildProgram();
    program.exitOverride();

    await expect(program.parseAsync([
      "ai:feature-smoke",
      "--feature",
      "coach-chat",
      "--page",
      "svc-of",
      "--conversation",
      "group-1",
      "--as",
      "owner",
    ], { from: "user" })).rejects.toThrow("coach-chat requires --question");

    // The guard runs ahead of any I/O — the app context is never created.
    expect(cliMocks.createAppContext).not.toHaveBeenCalled();
  });

  it("ai:feature-smoke fails on coach-chat without --fan on a FANSLY page", async () => {
    // Blocker 2 (P1-3): canonical Fansly coach-chat REQUIRES --fan so the stored
    // record's fan_ref carries the fan identity (conversationRef is the groupId).
    // The guard now runs AFTER the page resolves (so it can key off platform),
    // so the app context IS created — the default mocked page is Fansly, so the
    // --fan tripwire still fires. --question is supplied so this gate is the one.
    cliMocks.findPageByLabel.mockResolvedValueOnce({
      page: { id: 44, label: "svc-fs", platform: "fansly" },
      credentials: null,
      proxy: null,
    });
    const program = buildProgram();
    program.exitOverride();

    await expect(program.parseAsync([
      "ai:feature-smoke",
      "--feature",
      "coach-chat",
      "--page",
      "svc-fs",
      "--conversation",
      "group-1",
      "--as",
      "owner",
      "--question",
      "как продать ppv?",
    ], { from: "user" })).rejects.toThrow("coach-chat requires --fan <ref> on fansly");

    // The page had to be resolved for the platform-specific guard, so the app
    // context was opened — and closed again in the finally.
    const app = await cliMocks.createAppContext.mock.results[0]?.value;
    expect(app?.close).toHaveBeenCalledTimes(1);
  });

  it("ai:feature-smoke proceeds past the --fan guard for OnlyFans coach-chat with no --fan", async () => {
    // P1-3: OnlyFans conversationRef IS the fan id, so the server contract does
    // NOT require fanRef there. A valid OnlyFans smoke without --fan must pass
    // the CLI guard. Prove it by resolving an OnlyFans page and letting the NEXT
    // step (user lookup) be the thing that stops — the --fan guard never fires.
    cliMocks.findPageByLabel.mockResolvedValueOnce({
      page: { id: 202, label: "svc-of", platform: "onlyfans" },
      credentials: null,
      proxy: null,
    });
    cliMocks.findUserByUsername.mockResolvedValueOnce(null);
    const program = buildProgram();
    program.exitOverride();

    await expect(program.parseAsync([
      "ai:feature-smoke",
      "--feature",
      "coach-chat",
      "--page",
      "svc-of",
      "--conversation",
      "fan-1",
      "--as",
      "owner",
      "--question",
      "how to sell ppv?",
    ], { from: "user" })).rejects.toThrow("unknown user: owner");

    // The guard did not throw the --fan error; control reached the user lookup.
    expect(cliMocks.findUserByUsername).toHaveBeenCalledTimes(1);
  });
});
