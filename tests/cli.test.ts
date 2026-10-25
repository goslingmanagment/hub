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
    bossBehavior,
    bossInstances,
    countHarvestObservations: vi.fn(),
    createAppContext: vi.fn(),
    findPageByLabel: vi.fn(),
    findUserById: vi.fn(),
    findUserByUsername: vi.fn(),
    handleSuccessfulPageVerificationRecovery: vi.fn(),
    insertDeliveryAttempt: vi.fn(),
    listPages: vi.fn(),
    listHarvestTransactionResidue: vi.fn(),
    onboardOnlyFansPage: vi.fn(),
    request: vi.fn(),
    requestPageSync: vi.fn(),
    waitForRequestedSyncRequests: vi.fn(),
    removePageProxy: vi.fn(),
    sendDailyRevenueTelegramReport: vi.fn(),
    sendManualDailyRevenueTelegramReport: vi.fn(),
    sendTelegramTestMessage: vi.fn(),
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
    findUserById: cliMocks.findUserById,
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
  onboardOnlyFansPage: cliMocks.onboardOnlyFansPage,
}));

vi.mock("../apps/runtime/src/services/page-proxies.ts", () => ({
  removePageProxy: cliMocks.removePageProxy,
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

function createProgramHarness() {
  const program = buildProgram();
  const configure = (command: typeof program) => {
    command.exitOverride();
    command.configureOutput({
      writeOut: () => {},
      writeErr: () => {},
      outputError: (str, write) => {
        write(str);
      },
    });
    for (const child of command.commands) configure(child);
  };
  configure(program);

  return {
    program,
  };
}

describe("CLI parsing", () => {
  beforeEach(() => {
    process.exitCode = undefined;
    cliMocks.bossBehavior.sendError = null;
    cliMocks.bossBehavior.sendResult = "job-1";
    cliMocks.bossInstances.length = 0;
    cliMocks.createAppContext.mockReset();
    cliMocks.countHarvestObservations.mockReset();
    cliMocks.findPageByLabel.mockReset();
    cliMocks.findUserById.mockReset();
    cliMocks.findUserByUsername.mockReset();
    cliMocks.listPages.mockReset();
    cliMocks.listHarvestTransactionResidue.mockReset();
    cliMocks.onboardOnlyFansPage.mockReset();
    cliMocks.request.mockReset();
    cliMocks.requestPageSync.mockReset();
    cliMocks.waitForRequestedSyncRequests.mockReset();
    cliMocks.removePageProxy.mockReset();
    cliMocks.sendDailyRevenueTelegramReport.mockReset();
    cliMocks.sendManualDailyRevenueTelegramReport.mockReset();
    cliMocks.sendTelegramTestMessage.mockReset();
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
    cliMocks.waitForRequestedSyncRequests.mockResolvedValue(undefined);
    cliMocks.removePageProxy.mockResolvedValue(undefined);
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

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ["user", "set-password"], ["user", "delete"],
  ])("refuses legacy username targeting in %s %s before opening the database", async (group, command) => {
    const { program } = createProgramHarness();
    const args = [group, command, "--user-id", "12", "--username", "12"];
    if (command === "assign-page" || command === "unassign-page") args.push("--page", "fixture");
    if (command === "delete") args.push("--confirm-user-id", "12");
    await expect(program.parseAsync(args, { from: "user" }))
      .rejects.toThrow("unknown option '--username'");
    expect(cliMocks.createAppContext).not.toHaveBeenCalled();
    expect(cliMocks.findUserByUsername).not.toHaveBeenCalled();
  });

  it("requires matching immutable IDs before deleting an account", async () => {
    const { program } = createProgramHarness();
    await expect(program.parseAsync([
      "user", "delete", "--user-id", "12", "--confirm-user-id", "13",
    ], { from: "user" })).rejects.toThrow("--confirm-user-id must match --user-id");
    expect(cliMocks.createAppContext).not.toHaveBeenCalled();
  });

  it("requires an explicit account deletion confirmation ID", async () => {
    const { program } = createProgramHarness();
    await expect(program.parseAsync(["user", "delete", "--user-id", "12"], { from: "user" }))
      .rejects.toThrow("--confirm-user-id");
    expect(cliMocks.createAppContext).not.toHaveBeenCalled();
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

  // Decision #223: the drill seam may not answer for the real gate.
  describe("capture:reclaim --assume-free-bytes", () => {
    it("REJECTS the drill figure on an executing run, before any database work", async () => {
      const program = buildProgram();
      program.exitOverride();

      await expect(program.parseAsync([
        "capture:reclaim",
        "--table",
        "sync_raw_payloads",
        "--phase",
        "null-bodies",
        "--assume-free-bytes",
        "1",
        "--execute",
      ], { from: "user" })).rejects.toThrow(/cannot be combined with --execute/);

      // BEFORE any database work: the refusal is a category error, not a bad
      // run, and an app context (a pool, a heartbeat) must not be built for it.
      expect(cliMocks.createAppContext).not.toHaveBeenCalled();
    });
  });
});

