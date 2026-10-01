import { spawnSync } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FanslySendRefusedError } from "@agency_hub_core/fansly";

import {
  FanslyPageOwnedBySyncEngineError,
  FanslyPageSendClosedError,
  FanslySendGuardStoppedError,
  FANSLY_SEND_BUSY_POLL_MS,
  FANSLY_SEND_LEASE_MARGIN_MS,
  isFanslyPageOwnedBySyncEngineError,
} from "../apps/runtime/src/services/fansly-send-guard/engine.ts";
import {
  buildFanslySendHolderIdentity,
  containerIdFromMountinfo,
  createPortableFanslySendOsProbe,
  hostnameIsContainerId,
  judgeFanslySendHolderTermination,
  type FanslySendOsProbe,
} from "../apps/runtime/src/services/fansly-send-guard/os-probe.ts";
import {
  createTestFanslySendGuards,
  globalTimersFanslySendGuardClock,
  InMemoryFanslySendGuardStore,
  TEST_FANSLY_SEND_HOLDER,
} from "./helpers/fansly-send-guard.ts";

// The guard's state machine against an in-memory twin of the 0225/0229 statements,
// on a fake clock. The database-backed statements and the two-process
// acceptance run are in tests/fansly-send-guard.integration.test.ts.

const S = 2_000;
const PAGE = 7;
const TIMEOUT_MS = 30_000;

function setup(options: { settingMs?: number | (() => number); random?: () => number } = {}) {
  const store = new InMemoryFanslySendGuardStore(() => Date.now());
  store.seed(PAGE, { lastCompletedAt: Date.now() - 60_000, nextU: 0 });
  const { registry } = createTestFanslySendGuards({
    store,
    settingMs: options.settingMs ?? S,
    random: options.random ?? (() => 0),
    clock: globalTimersFanslySendGuardClock,
  });
  return { store, registry, guard: registry.forPage(PAGE, "sync_stream") };
}

/** The holder another process left on the row. */
function holdByOtherProcess(store: InMemoryFanslySendGuardStore, leaseMs: number) {
  const row = store.rows.get(PAGE)!;
  Object.assign(row, {
    holderToken: "11111111-1111-4111-8111-111111111111",
    holderSource: "sync_stream",
    holderOperation: "messages",
    holder: { ...TEST_FANSLY_SEND_HOLDER, pid: 99, instance: "22222222-2222-4222-8222-222222222222" },
    capturedAt: Date.now(),
    leaseUntil: Date.now() + leaseMs,
  });
  return row.holderToken as string;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-01T12:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("capture and pause", () => {
  it("captures at once when nobody holds the page and the pause has passed", async () => {
    const { guard, store } = setup();
    const lease = await guard.acquire({ operation: "messages", requestTimeoutMs: TIMEOUT_MS });
    expect(lease.pageId).toBe(PAGE);
    expect(store.rows.get(PAGE)?.holderToken).toBe(lease.token);
    expect(store.rows.get(PAGE)?.leaseUntil).toBe(Date.now() + 2 * TIMEOUT_MS + FANSLY_SEND_LEASE_MARGIN_MS);
    expect(store.journal[0]).toMatchObject({ pageId: PAGE, source: "sync_stream", operation: "messages", settingMs: S });
    await lease.complete({ outcome: "response", httpStatus: 200 });
    expect(store.rows.get(PAGE)?.holderToken).toBeNull();
  });

  it("waits exactly S × (1 + u) from the previous completion, by the store's clock", async () => {
    // u for the next pause is drawn at completion: 0.15 → 2 300 ms.
    const { guard, store } = setup({ random: () => 0.75 });
    const first = await guard.acquire({ operation: "a", requestTimeoutMs: TIMEOUT_MS });
    await vi.advanceTimersByTimeAsync(400);
    await first.complete({ outcome: "response", httpStatus: 200 });
    const completedAt = Date.now();
    expect(store.rows.get(PAGE)?.nextU).toBeCloseTo(0.15);

    let captured = false;
    const second = guard.acquire({ operation: "b", requestTimeoutMs: TIMEOUT_MS }).then((lease) => {
      captured = true;
      return lease;
    });
    await vi.advanceTimersByTimeAsync(2_299);
    expect(captured).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const lease = await second;
    expect(Date.now() - completedAt).toBe(2_300);
    expect(store.journal[1]).toMatchObject({ jitterU: 0.75 * 0.2, pauseMs: 2_300, captureRefusals: 1 });
    await lease.complete({ outcome: "response", httpStatus: 200 });
  });

  it("never draws u outside [0, 0.2)", async () => {
    const { guard, store } = setup({ random: () => 0.999_999_999_999 });
    const lease = await guard.acquire({ operation: "a", requestTimeoutMs: TIMEOUT_MS });
    await lease.complete({ outcome: "response", httpStatus: 200 });
    const u = store.rows.get(PAGE)!.nextU;
    expect(u).toBeGreaterThanOrEqual(0);
    expect(u).toBeLessThan(0.2);
  });

  it("reads S fresh before every capture", async () => {
    let setting = S;
    const { guard } = setup({ settingMs: () => setting });
    const first = await guard.acquire({ operation: "a", requestTimeoutMs: TIMEOUT_MS });
    await first.complete({ outcome: "response", httpStatus: 200 });
    setting = 5_000;
    let captured = false;
    const second = guard.acquire({ operation: "b", requestTimeoutMs: TIMEOUT_MS }).then((lease) => {
      captured = true;
      return lease;
    });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(captured).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await (await second).complete({ outcome: "response", httpStatus: 200 });
  });

  it("refuses an unusable setting instead of guessing one", async () => {
    const { guard } = setup({ settingMs: Number.NaN });
    await expect(guard.acquire({ operation: "a", requestTimeoutMs: TIMEOUT_MS })).rejects.toThrow("unusable pause setting");
  });

  it("a page without a row starts closed for 1.2 × S, like the migration's seed", async () => {
    const store = new InMemoryFanslySendGuardStore(() => Date.now());
    const { registry } = createTestFanslySendGuards({
      store,
      settingMs: S,
      clock: globalTimersFanslySendGuardClock,
    });
    let captured = false;
    const pending = registry.forPage(99, "account_me_cli").acquire({ operation: "account_me", requestTimeoutMs: TIMEOUT_MS })
      .then((lease) => {
        captured = true;
        return lease;
      });
    await vi.advanceTimersByTimeAsync(2_399);
    expect(captured).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await (await pending).complete({ outcome: "response", httpStatus: 200 });
  });
});

describe("one request in flight", () => {
  it("polls about every 250 ms while another process's request is in flight", async () => {
    const { guard, store } = setup();
    const token = holdByOtherProcess(store, 60_000);
    const captureSpy = vi.spyOn(store, "capture");
    let captured = false;
    const pending = guard.acquire({ operation: "a", requestTimeoutMs: TIMEOUT_MS }).then((lease) => {
      captured = true;
      return lease;
    });
    await vi.advanceTimersByTimeAsync(1_000);
    // 1 000 ms at 250 ms ± 20 % (here the spread is −20 %: random() = 0).
    expect(captureSpy.mock.calls.length).toBeGreaterThanOrEqual(1_000 / (FANSLY_SEND_BUSY_POLL_MS * 1.2));
    expect(captureSpy.mock.calls.length).toBeLessThanOrEqual(1 + 1_000 / (FANSLY_SEND_BUSY_POLL_MS * 0.8));
    expect(captured).toBe(false);

    await store.complete({
      pageId: PAGE, token, nextU: 0, outcome: "response", outcomeDetail: null,
      httpStatus: 200, sentAt: null, sendOffsetMs: null,
    });
    const releasedAt = Date.now();
    await vi.advanceTimersByTimeAsync(S + FANSLY_SEND_BUSY_POLL_MS);
    const lease = await pending;
    expect(captured).toBe(true);
    expect(store.journal.at(-1)!.capturedAt - releasedAt).toBeGreaterThanOrEqual(S);
    await lease.complete({ outcome: "response", httpStatus: 200 });
  });

  it("waits for this process's own request without polling the store", async () => {
    const { guard, store } = setup();
    const first = await guard.acquire({ operation: "a", requestTimeoutMs: TIMEOUT_MS });
    const captureSpy = vi.spyOn(store, "capture");
    const second = guard.acquire({ operation: "b", requestTimeoutMs: TIMEOUT_MS });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(captureSpy).not.toHaveBeenCalled();
    await first.complete({ outcome: "response", httpStatus: 200 });
    await vi.advanceTimersByTimeAsync(S);
    await (await second).complete({ outcome: "response", httpStatus: 200 });
    expect(captureSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("never opens the page because a lease expired: closed until completion or confirmed termination", async () => {
    const { guard, store } = setup();
    const token = holdByOtherProcess(store, 1_000);
    await vi.advanceTimersByTimeAsync(1_000);

    const refused = guard.acquire({ operation: "a", requestTimeoutMs: TIMEOUT_MS });
    await expect(refused).rejects.toBeInstanceOf(FanslyPageSendClosedError);
    expect(store.rows.get(PAGE)?.holderToken).toBe(token);
    expect(store.rows.get(PAGE)?.closedReason).toBe("lease_expired_unconfirmed");

    // Hours later it is still closed: expiry alone opens nothing.
    await vi.advanceTimersByTimeAsync(3 * 60 * 60 * 1000);
    await expect(guard.acquire({ operation: "a", requestTimeoutMs: TIMEOUT_MS }))
      .rejects.toBeInstanceOf(FanslyPageSendClosedError);

    // Confirmed terminated → open after another 1.2 × S.
    expect(store.confirmTerminated(PAGE, token)).toBe(true);
    const confirmedAt = Date.now();
    let captured = false;
    const pending = guard.acquire({ operation: "a", requestTimeoutMs: TIMEOUT_MS }).then((lease) => {
      captured = true;
      return lease;
    });
    await vi.advanceTimersByTimeAsync(1.2 * S - 1);
    expect(captured).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const lease = await pending;
    expect(Date.now() - confirmedAt).toBe(1.2 * S);
    expect(store.journal.find((row) => row.token === token)).toBeUndefined();
    await lease.complete({ outcome: "response", httpStatus: 200 });
  });
});

describe("a page the Fansly Sync Engine owns (0229, design §2.7)", () => {
  it("refuses at once, writes nothing and never loops, whatever the pause or the holder", async () => {
    const warnings: string[] = [];
    const store = new InMemoryFanslySendGuardStore(() => Date.now());
    // Just completed: a legacy capture would have to wait 1.2 × S.
    store.seed(PAGE, { lastCompletedAt: Date.now(), nextU: 0.2, ownerEngine: "fansly_sync_engine" });
    const { registry } = createTestFanslySendGuards({
      store,
      settingMs: S,
      clock: globalTimersFanslySendGuardClock,
      logger: { info: () => undefined, warn: (_object, message) => warnings.push(message), error: () => undefined },
    });
    const captureSpy = vi.spyOn(store, "capture");
    const startedAt = Date.now();

    for (const source of ["sync_stream", "targeted_backfill", "ai_fast_lane", "ws_connect"] as const) {
      const refused = await registry.forPage(PAGE, source)
        .acquire({ operation: "messages", requestTimeoutMs: TIMEOUT_MS })
        .catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(FanslyPageOwnedBySyncEngineError);
      expect(refused).toMatchObject({ name: "FanslyPageOwnedBySyncEngineError", pageId: PAGE });
    }
    // No sleep, no poll: one capture statement per acquire, no time passed.
    expect(captureSpy).toHaveBeenCalledTimes(4);
    expect(Date.now()).toBe(startedAt);
    expect(store.journal).toEqual([]);
    expect(store.rows.get(PAGE)?.holderToken).toBeNull();
    expect(registry.inflightCount).toBe(0);
    expect(registry.counters).toMatchObject({ captures: 0, captureRefusals: 4, engineOwnedRefusals: 4, closedRefusals: 0 });
    expect(warnings).toEqual(Array(4).fill("Fansly page is owned by the Fansly Sync Engine; the legacy sender stops"));
  });

  it("reports the engine before a holder or a pause", async () => {
    const { guard, store, registry } = setup();
    holdByOtherProcess(store, 60_000);
    store.rows.get(PAGE)!.ownerEngine = "fansly_sync_engine";
    await expect(guard.acquire({ operation: "a", requestTimeoutMs: TIMEOUT_MS }))
      .rejects.toBeInstanceOf(FanslyPageOwnedBySyncEngineError);
    expect(registry.counters).toMatchObject({ engineOwnedRefusals: 1, closedRefusals: 0 });
  });

  it("captures again 1.2 × S after a rollback hands the page back", async () => {
    const { guard, store } = setup();
    store.rows.get(PAGE)!.ownerEngine = "fansly_sync_engine";
    await expect(guard.acquire({ operation: "a", requestTimeoutMs: TIMEOUT_MS }))
      .rejects.toBeInstanceOf(FanslyPageOwnedBySyncEngineError);

    // The rollback flip (design §2.8): last_completed_at = now, next_u = 0.2.
    Object.assign(store.rows.get(PAGE)!, { ownerEngine: "legacy", lastCompletedAt: Date.now(), nextU: 0.2 });
    const flippedAt = Date.now();
    let captured = false;
    const pending = guard.acquire({ operation: "a", requestTimeoutMs: TIMEOUT_MS }).then((lease) => {
      captured = true;
      return lease;
    });
    await vi.advanceTimersByTimeAsync(1.2 * S - 1);
    expect(captured).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const lease = await pending;
    expect(Date.now() - flippedAt).toBe(1.2 * S);
    await lease.complete({ outcome: "response", httpStatus: 200 });
  });

  it("is recognised by name through a cause chain, and nothing else is", () => {
    const refusal = new FanslyPageOwnedBySyncEngineError(PAGE, new Date("2026-10-01T10:00:00.000Z"));
    expect(refusal.message).toBe(
      `Fansly page ${PAGE} is owned by the Fansly Sync Engine since 2026-10-01T10:00:00.000Z: `
        + "the legacy engine sends nothing for it",
    );
    expect(isFanslyPageOwnedBySyncEngineError(refusal)).toBe(true);
    expect(isFanslyPageOwnedBySyncEngineError(new Error("wrapped", { cause: refusal }))).toBe(true);
    const copy = Object.assign(new Error("from another module copy"), { name: "FanslyPageOwnedBySyncEngineError" });
    expect(isFanslyPageOwnedBySyncEngineError(copy)).toBe(true);
    expect(isFanslyPageOwnedBySyncEngineError(new FanslyPageSendClosedError(PAGE, {
      token: "t", source: null, operation: null, host: null, pid: null, role: null, instance: null, leaseUntil: null,
    }))).toBe(false);
    expect(isFanslyPageOwnedBySyncEngineError("FanslyPageOwnedBySyncEngineError")).toBe(false);
    expect(isFanslyPageOwnedBySyncEngineError(null)).toBe(false);
  });
});

describe("the send check", () => {
  it("lets exactly one physical request go per capture", async () => {
    const { guard, store } = setup();
    const lease = await guard.acquire({ operation: "a", requestTimeoutMs: TIMEOUT_MS }) as unknown as {
      checkSend(): FanslySendRefusedError | null;
    } & Awaited<ReturnType<typeof guard.acquire>>;
    expect(lease.checkSend()).toBeNull();
    expect(lease.sent).toBe(true);
    // A redirect hop or undici's hidden 421 re-send is a second dispatch.
    expect(lease.checkSend()?.reason).toBe("lease_used");
    await lease.complete({ outcome: "response", httpStatus: 421 });
    expect(lease.checkSend()?.reason).toBe("lease_inactive");
    expect(store.journal[0]).toMatchObject({ outcome: "response", outcomeDetail: "lease_used", httpStatus: 421 });
    expect(store.journal[0]?.sentAt).toEqual(new Date(Date.now()));
  });

  it("never sends past the send window, which starts before the capture statement", async () => {
    const { guard, store } = setup();
    const lease = await guard.acquire({ operation: "a", requestTimeoutMs: 5_000 }) as unknown as {
      checkSend(): FanslySendRefusedError | null;
    } & Awaited<ReturnType<typeof guard.acquire>>;
    await vi.advanceTimersByTimeAsync(5_000);
    const refusal = lease.checkSend();
    expect(refusal).toBeInstanceOf(FanslySendRefusedError);
    expect(refusal?.reason).toBe("send_deadline_passed");
    expect(lease.sent).toBe(false);
    await lease.complete({ outcome: "transport_error" });
    expect(store.journal[0]).toMatchObject({ outcome: "aborted_before_send", outcomeDetail: "send_deadline_passed", sentAt: null });
  });

  it("binds the check to the dispatcher of this lease", async () => {
    const { guard } = setup();
    const lease = await guard.acquire({ operation: "a", requestTimeoutMs: TIMEOUT_MS });
    const compose = vi.fn((interceptor: unknown) => ({ interceptor }));
    const bound = lease.bind({ compose } as never) as unknown as { interceptor: unknown };
    expect(compose).toHaveBeenCalledOnce();
    expect(typeof bound.interceptor).toBe("function");
    await lease.complete({ outcome: "aborted_before_send" });
  });
});

describe("completion", () => {
  it("is retried until durable; the page stays held and this process captures nothing meanwhile", async () => {
    const { guard, store, registry } = setup();
    store.faults.complete = 3;
    const first = await guard.acquire({ operation: "a", requestTimeoutMs: TIMEOUT_MS });
    const completing = first.complete({ outcome: "response", httpStatus: 200 });
    const captureSpy = vi.spyOn(store, "capture");
    const second = guard.acquire({ operation: "b", requestTimeoutMs: TIMEOUT_MS });
    await vi.advanceTimersByTimeAsync(200 + 400);
    expect(store.rows.get(PAGE)?.holderToken).toBe(first.token);
    expect(captureSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(800);
    await completing;
    expect(store.completeCalls).toBe(4);
    expect(store.rows.get(PAGE)?.holderToken).toBeNull();
    await vi.advanceTimersByTimeAsync(S);
    await (await second).complete({ outcome: "response", httpStatus: 200 });
    expect(registry.inflightCount).toBe(0);
  });

  it("is idempotent", async () => {
    const { guard, store } = setup();
    const lease = await guard.acquire({ operation: "a", requestTimeoutMs: TIMEOUT_MS });
    await Promise.all([
      lease.complete({ outcome: "response", httpStatus: 200 }),
      lease.complete({ outcome: "timeout" }),
    ]);
    expect(store.completeCalls).toBe(1);
    expect(store.journal[0]?.outcome).toBe("response");
  });

  it("releases a capture whose answer was lost, and holds the page in this process until it is", async () => {
    const { guard, store } = setup();
    store.faults.capture.push("lost_answer");
    await expect(guard.acquire({ operation: "a", requestTimeoutMs: TIMEOUT_MS })).rejects.toThrow("connection lost");
    await vi.advanceTimersByTimeAsync(0);
    expect(store.rows.get(PAGE)?.holderToken).toBeNull();
    expect(store.journal[0]).toMatchObject({ outcome: "aborted_before_send" });
  });
});

describe("cancellation and shutdown", () => {
  it("honours the admission signal while it waits, and captures nothing", async () => {
    const { guard, store } = setup();
    const first = await guard.acquire({ operation: "a", requestTimeoutMs: TIMEOUT_MS });
    await first.complete({ outcome: "response", httpStatus: 200 });
    const controller = new AbortController();
    const reason = new Error("lease lost");
    const pending = guard.acquire({ operation: "b", requestTimeoutMs: TIMEOUT_MS, signal: controller.signal });
    const rejected = expect(pending).rejects.toBe(reason);
    await vi.advanceTimersByTimeAsync(500);
    controller.abort(reason);
    await rejected;
    expect(store.journal).toHaveLength(1);
  });

  it("releases a capture that lands after the signal fired", async () => {
    const { guard, store } = setup();
    const controller = new AbortController();
    const reason = new Error("lease lost");
    const capture = store.capture.bind(store);
    vi.spyOn(store, "capture").mockImplementation(async (input) => {
      const result = await capture(input);
      controller.abort(reason);
      return result;
    });
    await expect(guard.acquire({ operation: "a", requestTimeoutMs: TIMEOUT_MS, signal: controller.signal }))
      .rejects.toBe(reason);
    expect(store.rows.get(PAGE)?.holderToken).toBeNull();
    expect(store.journal[0]?.outcome).toBe("aborted_before_send");
  });

  it("stops admitting on stop() and drains the requests in flight", async () => {
    const { guard, registry, store } = setup();
    const inFlight = await guard.acquire({ operation: "a", requestTimeoutMs: TIMEOUT_MS });
    registry.stop();
    await expect(guard.acquire({ operation: "b", requestTimeoutMs: TIMEOUT_MS }))
      .rejects.toBeInstanceOf(FanslySendGuardStoppedError);
    let drained = false;
    const draining = registry.drain().then(() => {
      drained = true;
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(drained).toBe(false);
    await inFlight.complete({ outcome: "response", httpStatus: 200 });
    await draining;
    expect(store.rows.get(PAGE)?.holderToken).toBeNull();
  });
});

describe("a check of an unknown session", () => {
  it("is journaled without a page, paced against none, and still sends once", async () => {
    const { registry, store } = setup();
    const guard = registry.withoutPage("onboarding");
    const a = await guard.acquire({ operation: "account_me", requestTimeoutMs: TIMEOUT_MS }) as unknown as {
      checkSend(): FanslySendRefusedError | null;
    } & Awaited<ReturnType<typeof guard.acquire>>;
    const b = await guard.acquire({ operation: "account_me", requestTimeoutMs: TIMEOUT_MS });
    expect(a.pageId).toBeNull();
    expect(a.checkSend()).toBeNull();
    expect(a.checkSend()?.reason).toBe("lease_used");
    await a.complete({ outcome: "response", httpStatus: 200 });
    await b.complete({ outcome: "response", httpStatus: 200 });
    expect(store.journal.map((row) => [row.pageId, row.source, row.outcome])).toEqual([
      [null, "onboarding", "response"],
      [null, "onboarding", "response"],
    ]);
  });
});

describe("termination evidence", () => {
  const probe = (alive: Record<number, string>): FanslySendOsProbe => ({
    hostname: () => "container-a",
    bootId: () => "boot-1",
    pidNamespace: () => "pid:[1]",
    processStartToken: (pid) => alive[pid] ?? null,
    containerId: () => null,
  });
  const local = {
    identity: { ...buildFanslySendHolderIdentity(probe({ [process.pid]: "me" }), "api") },
    probe: probe({ 10: "start-10" }),
  };
  const holder = {
    holderHost: "container-a",
    holderPid: 10,
    holderPidStart: "start-10",
    holderPidNs: "pid:[1]",
    holderBootId: "boot-1",
    holderInstance: "33333333-3333-4333-8333-333333333333",
  };

  it("confirms nothing about a live holder", () => {
    expect(judgeFanslySendHolderTermination(holder, local)).toBeNull();
  });

  it("confirms a holder whose pid is gone or reused on this host", () => {
    expect(judgeFanslySendHolderTermination({ ...holder, holderPid: 11 }, local)).toBe("pid_gone");
    expect(judgeFanslySendHolderTermination({ ...holder, holderPidStart: "start-older" }, local)).toBe("pid_reused");
  });

  it("confirms a holder from another kernel boot", () => {
    expect(judgeFanslySendHolderTermination({ ...holder, holderHost: "container-b", holderBootId: "boot-0" }, local))
      .toBe("boot_id_changed");
  });

  it("never judges another container, another pid namespace or this very process", () => {
    expect(judgeFanslySendHolderTermination({ ...holder, holderHost: "container-b", holderPid: 11 }, local)).toBeNull();
    expect(judgeFanslySendHolderTermination({ ...holder, holderPidNs: "pid:[2]", holderPid: 11 }, local)).toBeNull();
    expect(judgeFanslySendHolderTermination({ ...holder, holderPid: 11, holderInstance: local.identity.instance }, local))
      .toBeNull();
  });

  // Taken from `docker run` (Docker 29): a container's hostname is the first
  // 12 hex digits of its id, and /etc/hostname is bind-mounted from its own
  // directory, also under `--hostname`, `--network host` and `--uts host`.
  const CONTAINER_ID = "1b311277ddfc9a6d6b022a2181b7b2136a2d16c7a7351f5c8d17a79e409c730f";
  const mountinfo = (id: string) => [
    "102 97 0:94 / / rw,relatime master:1 - overlay overlay rw,lowerdir=/x,upperdir=/y,workdir=/z",
    `111 102 254:1 /docker/containers/${id}/hostname /etc/hostname rw,relatime - ext4 /dev/vda1 rw,discard`,
    `112 102 254:1 /docker/containers/${id}/hosts /etc/hosts rw,relatime - ext4 /dev/vda1 rw,discard`,
  ].join("\n");

  it("reads the container id from the source of the /etc/hostname mount", () => {
    expect(containerIdFromMountinfo(mountinfo(CONTAINER_ID))).toBe(CONTAINER_ID);
    expect(containerIdFromMountinfo(
      `120 100 0:50 /var/lib/docker/containers/${CONTAINER_ID}/hostname /etc/hostname rw - xfs /dev/sdb rw`,
    )).toBe(CONTAINER_ID);
    // Outside a container there is no such mount.
    expect(containerIdFromMountinfo("22 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw")).toBeNull();
    expect(containerIdFromMountinfo("")).toBeNull();

    expect(hostnameIsContainerId("1b311277ddfc", CONTAINER_ID)).toBe(true);
    expect(hostnameIsContainerId(CONTAINER_ID, CONTAINER_ID)).toBe(true);
    // `--hostname worker`, `--network host` (the host's name), another id, no container.
    expect(hostnameIsContainerId("worker", CONTAINER_ID)).toBe(false);
    expect(hostnameIsContainerId("docker-desktop", CONTAINER_ID)).toBe(false);
    expect(hostnameIsContainerId("cb7d59d9c0d7", CONTAINER_ID)).toBe(false);
    expect(hostnameIsContainerId("1b31", CONTAINER_ID)).toBe(false);
    expect(hostnameIsContainerId("1b311277ddfc", null)).toBe(false);
  });

  describe("an earlier run of this container", () => {
    // The container restarted: same hostname (its id), same kernel boot, a new
    // pid namespace; the old holder's pid may well be taken in the new one.
    const containerProbe = (input: { host?: string; containerId?: string | null; pidNs?: string | null } = {}) => ({
      hostname: () => input.host ?? "1b311277ddfc",
      bootId: () => "boot-1",
      pidNamespace: () => (input.pidNs === undefined ? "pid:[4026532779]" : input.pidNs),
      processStartToken: (pid: number) => ({ 1: "start-1", 7: "start-7-new" } as Record<number, string>)[pid] ?? null,
      containerId: () => (input.containerId === undefined ? CONTAINER_ID : input.containerId),
    }) satisfies FanslySendOsProbe;
    const restarted = (input: Parameters<typeof containerProbe>[0] = {}) => {
      const local = containerProbe(input);
      return { identity: buildFanslySendHolderIdentity(local, "worker"), probe: local };
    };
    const oldRun = {
      holderHost: "1b311277ddfc",
      holderPid: 7,
      holderPidStart: "start-7-old",
      holderPidNs: "pid:[4026532643]",
      holderBootId: "boot-1",
      holderInstance: "44444444-4444-4444-8444-444444444444",
    };

    it("is confirmed gone: the pid namespace was replaced", () => {
      expect(judgeFanslySendHolderTermination(oldRun, restarted())).toBe("pid_namespace_replaced");
      // Whatever now runs under its pid in the new namespace.
      expect(judgeFanslySendHolderTermination({ ...oldRun, holderPid: 1, holderPidStart: "start-1" }, restarted()))
        .toBe("pid_namespace_replaced");
    });

    it("is judged by pid when the new run got the same namespace inode back", () => {
      const sameInode = restarted({ pidNs: oldRun.holderPidNs });
      expect(judgeFanslySendHolderTermination(oldRun, sameInode)).toBe("pid_reused");
      expect(judgeFanslySendHolderTermination({ ...oldRun, holderPid: 9 }, sameInode)).toBe("pid_gone");
    });

    it("is not judged when the hostname is not provably this container's id", () => {
      // `--hostname`, `--network host` / `--uts host`: another container, or
      // the host, may run under the same name in a pid namespace of its own.
      expect(judgeFanslySendHolderTermination({ ...oldRun, holderHost: "worker" }, restarted({ host: "worker" })))
        .toBeNull();
      expect(judgeFanslySendHolderTermination(
        { ...oldRun, holderHost: "docker-desktop" },
        restarted({ host: "docker-desktop" }),
      )).toBeNull();
      // Not in a container at all, or no /etc/hostname mount to prove it.
      expect(judgeFanslySendHolderTermination(oldRun, restarted({ containerId: null }))).toBeNull();
      // Another container's id.
      expect(judgeFanslySendHolderTermination(
        oldRun,
        restarted({ containerId: "cb7d59d9c0d71776450f2bdfff298a6d14d960b0d3780bcff09cd1350bd3fee0" }),
      )).toBeNull();
    });

    it("is not judged without both pid namespaces", () => {
      expect(judgeFanslySendHolderTermination({ ...oldRun, holderPidNs: null }, restarted())).toBeNull();
      expect(judgeFanslySendHolderTermination(oldRun, restarted({ pidNs: null }))).toBeNull();
    });

    it("never judges this very process", () => {
      const local = restarted();
      expect(judgeFanslySendHolderTermination({ ...oldRun, holderInstance: local.identity.instance }, local)).toBeNull();
    });
  });

  it("the portable probe sees this process and not a finished one", () => {
    vi.useRealTimers();
    const portable = createPortableFanslySendOsProbe();
    expect(portable.processStartToken(process.pid)).not.toBeNull();
    const finished = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    expect(finished.pid).toBeGreaterThan(0);
    expect(portable.processStartToken(finished.pid!)).toBeNull();
  });
});
