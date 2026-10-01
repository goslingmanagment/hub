import { describe, expect, it, vi } from "vitest";

import type { Database } from "@agency_hub_core/db";

import { fanslySendFailureOutcome, isFanslyHost } from "../apps/runtime/src/services/egress/fansly-send-lease.ts";
import {
  buildFanslySendHolderIdentity,
  createPortableFanslySendOsProbe,
  createProcFanslySendOsProbe,
  createFanslySendGuards,
  FanslySendGuardRegistry,
  FanslySendProbeUnknownError,
  judgeFanslySendHolderTermination,
  parseProcStatStartToken,
  settlesWithin,
  startFanslySendGuardSweeper,
  type FanslySendOsProbe,
} from "../apps/runtime/src/services/fansly-send-guard/index.ts";
import { describeFanslyPaceViolations } from "../apps/runtime/src/services/fansly-send-guard/monitor.ts";
import {
  InMemoryFanslySendGuardStore,
  silentFanslySendGuardLogger,
  TEST_FANSLY_SEND_HOLDER,
} from "./helpers/fansly-send-guard.ts";

// The send guard's robustness points and helpers added in its second step
// (PR B2). Database-backed behaviour is in
// tests/fansly-send-guard-b2.integration.test.ts.

function errno(code: string) {
  return Object.assign(new Error(`${code}: fixture`), { code });
}

// A /proc/<pid>/stat line: "1234 (node worker) S 1 …", field 22 = start time.
const STAT = "1234 (node (worker)) S 1 1234 1234 0 -1 4194560 100 0 0 0 5 1 0 0 20 0 11 0 987654 123456 789";

describe("the /proc probe tells 'gone' from 'cannot tell' (plan §2.5: only a proof opens a page)", () => {
  it("reads the start token, and a zombie or dead task as gone", () => {
    expect(parseProcStatStartToken(STAT)).toBe("987654");
    expect(parseProcStatStartToken(STAT.replace(") S ", ") Z "))).toBeNull();
    expect(parseProcStatStartToken(STAT.replace(") S ", ") X "))).toBeNull();
  });

  it("refuses a stat it cannot parse", () => {
    expect(() => parseProcStatStartToken("garbage")).toThrow(FanslySendProbeUnknownError);
    expect(() => parseProcStatStartToken("1 (x) S 1 2")).toThrow(FanslySendProbeUnknownError);
  });

  it.each(["ENOENT", "ESRCH"])("takes %s as 'no such process'", (code) => {
    const probe = createProcFanslySendOsProbe({ readFile: () => { throw errno(code); } });
    expect(probe.processStartToken(42)).toBeNull();
  });

  it.each(["EACCES", "EPERM", "EIO", "EMFILE", "ENFILE", "ENOMEM", "EINVAL"])(
    "never takes %s as death: it cannot tell", (code) => {
      const probe = createProcFanslySendOsProbe({ readFile: () => { throw errno(code); } });
      expect(() => probe.processStartToken(42)).toThrow(FanslySendProbeUnknownError);
    },
  );

  it("never takes an error without a code, or a non-pid, as death", () => {
    const probe = createProcFanslySendOsProbe({ readFile: () => { throw new Error("odd"); } });
    expect(() => probe.processStartToken(42)).toThrow(FanslySendProbeUnknownError);
    expect(() => createProcFanslySendOsProbe({ readFile: () => STAT }).processStartToken(0))
      .toThrow(FanslySendProbeUnknownError);
  });

  it("reads /proc/<pid>/stat of the asked pid", () => {
    const readFile = vi.fn(() => STAT);
    expect(createProcFanslySendOsProbe({ readFile }).processStartToken(1234)).toBe("987654");
    expect(readFile).toHaveBeenCalledWith("/proc/1234/stat");
  });
});

describe("the portable probe tells 'gone' from 'cannot tell'", () => {
  function psFailure(input: { status?: number | null; stdout?: string; code?: string }) {
    return () => {
      throw Object.assign(new Error("ps failed"), input);
    };
  }

  it("takes ps selecting nothing (exit 1, no output) as gone", () => {
    expect(createPortableFanslySendOsProbe({ ps: psFailure({ status: 1, stdout: "" }) }).processStartToken(42)).toBeNull();
  });

  it.each([
    ["ps missing", { code: "ENOENT" }],
    ["ps killed", { status: null }],
    ["another exit status", { status: 2, stdout: "" }],
    ["exit 1 with output", { status: 1, stdout: "something" }],
  ])("never takes %s as death", (_label, failure) => {
    expect(() => createPortableFanslySendOsProbe({ ps: psFailure(failure) }).processStartToken(42))
      .toThrow(FanslySendProbeUnknownError);
  });

  it("refuses an empty answer", () => {
    expect(() => createPortableFanslySendOsProbe({ ps: () => "  \n" }).processStartToken(42))
      .toThrow(FanslySendProbeUnknownError);
  });
});

describe("the termination judge with a probe that cannot tell", () => {
  const unknownProbe: FanslySendOsProbe = {
    hostname: () => "container-a",
    bootId: () => "boot-1",
    pidNamespace: () => "pid:[1]",
    processStartToken: () => {
      throw new FanslySendProbeUnknownError("cannot read /proc/10/stat (EACCES)");
    },
    containerId: () => null,
  };
  const holder = {
    holderHost: "container-a",
    holderPid: 10,
    holderPidStart: "start-10",
    holderPidNs: "pid:[1]",
    holderBootId: "boot-1",
    holderInstance: "33333333-3333-4333-8333-333333333333",
  };

  it("confirms nothing: an unknown is never a release", () => {
    const identity = buildFanslySendHolderIdentity(unknownProbe, "worker");
    expect(judgeFanslySendHolderTermination(holder, { identity, probe: unknownProbe })).toBeNull();
    // This process's own start token is simply unknown, not a crash.
    expect(identity.pidStart).toBeNull();
  });

  it("still confirms by a changed boot id, which needs no pid probe", () => {
    const identity = buildFanslySendHolderIdentity(unknownProbe, "worker");
    expect(judgeFanslySendHolderTermination({ ...holder, holderBootId: "boot-0" }, { identity, probe: unknownProbe }))
      .toBe("boot_id_changed");
  });
});

describe("the sweeper's stop is bounded (api and worker shutdown)", () => {
  it("returns within its timeout while a pass hangs on the database", async () => {
    const hung = new Promise<never>(() => {});
    const db = { execute: () => hung } as unknown as Database;
    const warn = vi.fn();
    const registry = createFanslySendGuards({
      db, config: {} as never, logger: silentFanslySendGuardLogger, role: "test",
      probe: createPortableFanslySendOsProbe(),
    });
    const sweeper = startFanslySendGuardSweeper(
      { db, logger: { ...silentFanslySendGuardLogger, warn } },
      { registry, intervalMs: 1, random: () => 0.5 },
    );
    // Let the first pass start and hang.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const started = performance.now();
    await sweeper.stop({ timeoutMs: 50 });
    const waited = performance.now() - started;
    expect(waited).toBeGreaterThanOrEqual(45);
    expect(waited).toBeLessThan(1_000);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ component: "fansly_send_guard", timeoutMs: 50 }),
      expect.stringContaining("stop timed out"),
    );
  });

  it("returns at once when no pass is in flight", async () => {
    const db = { execute: vi.fn() } as unknown as Database;
    const registry = createFanslySendGuards({
      db, config: {} as never, logger: silentFanslySendGuardLogger, role: "test",
      probe: createPortableFanslySendOsProbe(),
    });
    const sweeper = startFanslySendGuardSweeper({ db, logger: silentFanslySendGuardLogger }, { registry, intervalMs: 60_000 });
    const started = performance.now();
    await sweeper.stop();
    expect(performance.now() - started).toBeLessThan(100);
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("settlesWithin tells a settled promise from a hung one", async () => {
    await expect(settlesWithin(Promise.resolve(1), 10)).resolves.toBe(true);
    await expect(settlesWithin(Promise.reject(new Error("x")), 10)).resolves.toBe(true);
    await expect(settlesWithin(new Promise(() => {}), 10)).resolves.toBe(false);
  });
});

describe("an acquire waiting on the pause setting can be cancelled", () => {
  it("rejects with the signal's reason and leaves no capture behind", async () => {
    const store = new InMemoryFanslySendGuardStore(() => Date.now(), true);
    // A setting read that never answers (a stalled database).
    const registry = new FanslySendGuardRegistry({
      store,
      readSettingMs: () => new Promise<number>(() => {}),
      identity: () => TEST_FANSLY_SEND_HOLDER,
      logger: silentFanslySendGuardLogger,
    });
    const controller = new AbortController();
    const pending = registry.forPage(7, "ws_connect").acquire({
      operation: "ws_connect", requestTimeoutMs: 1_000, signal: controller.signal,
    });
    controller.abort(new Error("page disabled"));
    await expect(pending).rejects.toThrow("page disabled");
    expect(store.journal).toEqual([]);
    expect(registry.inflightCount).toBe(0);
  });
});

describe("egress helpers", () => {
  it("knows Fansly's hosts", () => {
    for (const host of ["fansly.com", "apiv3.fansly.com", "wsv3.fansly.com", "cdn3.fansly.com", "CDN5.Fansly.com", "cdn3.fansly.com."]) {
      expect(isFanslyHost(host), host).toBe(true);
    }
    for (const host of ["cdn3.fansly.com.evil.example", "notfansly.com", "cdn2.onlyfans.com", "cdn.fansapi.com"]) {
      expect(isFanslyHost(host), host).toBe(false);
    }
  });

  it("takes only a timeout as a timeout", () => {
    const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    expect(fanslySendFailureOutcome(timeout)).toBe("timeout");
    expect(fanslySendFailureOutcome(new TypeError("fetch failed", { cause: timeout }))).toBe("timeout");
    expect(fanslySendFailureOutcome(new DOMException("aborted", "AbortError"))).toBe("transport_error");
    expect(fanslySendFailureOutcome(new TypeError("fetch failed"))).toBe("transport_error");
    expect(fanslySendFailureOutcome("weird")).toBe("transport_error");
  });

  it("summarises pace violations within the incident's 240 characters, the closest first", () => {
    const send = (id: number, at: string, source: string) => ({
      id, sentAt: new Date(at), source, operation: "messages", holderRole: "worker", holderHost: "1b311277ddfc",
    });
    const summary = describeFanslyPaceViolations([
      { pageId: 7, pageLabel: "lilly-1", earlier: send(1, "2026-10-01T12:00:00.000Z", "sync_stream"),
        later: send(2, "2026-10-01T12:00:02.000Z", "ws_connect"), gapMs: 2_000.4, settingMs: 2_500 },
      { pageId: 7, pageLabel: "lilly-1", earlier: send(3, "2026-10-01T12:05:00.000Z", "targeted_backfill"),
        later: send(4, "2026-10-01T12:05:00.309Z", "media_download"), gapMs: 309.7, settingMs: 2_500 },
    ]);
    expect(summary).toBe(
      "2 pair(s) of sends closer than the setting; closest 309 ms apart (setting 2500 ms) at 2026-10-01T12:05:00.309Z: "
      + "targeted_backfill@worker then media_download@worker. See fansly-send-guard report --since 2026-10-01T12:05:00Z",
    );
    expect(summary.length).toBeLessThanOrEqual(240);
  });
});
