import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { FanslySendRefusedError } from "@agency_hub_core/fansly";
import { FANSLY_PAUSE_MIN_MS } from "@agency_hub_core/shared";

import {
  JITTER_MAX,
  Pacer,
  PacerInvariantError,
  PacerStoppedError,
  REQUEST_TIMEOUT_MS,
  SEND_WINDOW_MS,
  SETTING_RECHECK_MS,
  TAKEOVER_FACTOR,
  type Admission,
  type SlotGrant,
} from "../apps/runtime/src/sync/engine/pacer.ts";
import type { TransportOutcome } from "../apps/runtime/src/sync/engine/ports.ts";
import { FakeClock, FakeOwnership, FakePauseSource, ScriptedRng, SeededRng } from "./helpers/sync-fakes.ts";

// The pacer's rules one by one (design §3.3; invariants I1, I2, I4, I5), on a
// virtual clock. The randomized run over a million admissions is
// tests/sync-pacer-property.test.ts.

const S = 2_000;

function setup(options: { settingMs?: number; rng?: { next(): number }; minSettingMs?: number } = {}) {
  const clock = new FakeClock();
  const pause = new FakePauseSource(options.settingMs ?? S);
  const ownership = new FakeOwnership();
  const pacer = new Pacer({
    clock,
    rng: options.rng ?? new ScriptedRng([0]),
    pause,
    ownership,
    ...(options.minSettingMs === undefined ? {} : { minSettingMs: options.minSettingMs }),
  });
  return { clock, pause, ownership, pacer };
}

const live = () => new AbortController().signal;

const response = (sendMark: "request_start" | "completion_fallback" = "request_start"): TransportOutcome => ({
  kind: "response",
  status: 200,
  headers: {},
  bodyText: "{}",
  bodyBytes: 2,
  sendMark,
});

/** One admission as the actor runs it: slot → issue → (tx 1) → arm → the
 *  transport calls the check → completion. Returns the admission. */
async function sendOne(
  ctx: ReturnType<typeof setup>,
  options: { attemptId?: number; admitMs?: number; connectMs?: number; responseMs?: number } = {},
): Promise<{ grant: SlotGrant; admission: Admission; refusal: FanslySendRefusedError | null }> {
  const grant = await ctx.pacer.waitForSlot(live());
  const issued = ctx.clock.monoNow();
  ctx.clock.advance(options.admitMs ?? 5);
  const admission = ctx.pacer.arm(grant, options.attemptId ?? 1, issued);
  ctx.clock.advance(options.connectMs ?? 0);
  const refusal = ctx.pacer.check(admission);
  ctx.clock.advance(options.responseMs ?? 300);
  ctx.pacer.complete(
    admission,
    refusal === null ? response() : { kind: "aborted_before_send", refusal: refusal.reason },
  );
  return { grant, admission, refusal };
}

describe("sync pacer: admission preconditions", () => {
  it("admits nothing before the takeover floor is set", async () => {
    const { pacer } = setup();
    await expect(pacer.waitForSlot(live())).rejects.toMatchObject({ name: "PacerInvariantError", reason: "no_takeover" });
  });

  it("the first send waits for the takeover floor", async () => {
    const ctx = setup();
    const floorMs = Math.ceil(S * TAKEOVER_FACTOR);
    const takeoverAt = ctx.clock.monoNow();
    ctx.pacer.initTakeover(floorMs);
    const { admission, refusal } = await sendOne(ctx);
    expect(refusal).toBeNull();
    expect(admission.sentMono).toBeGreaterThanOrEqual(takeoverAt + floorMs);
  });

  it("a negative floor counts as none; a non-finite one is refused", () => {
    const ctx = setup();
    ctx.pacer.initTakeover(-5_000);
    expect(ctx.pacer.snapshot().floorMono).toBe(ctx.clock.monoNow());
    expect(() => ctx.pacer.initTakeover(Number.NaN)).toThrow(PacerInvariantError);
    expect(() => ctx.pacer.initTakeover(Number.POSITIVE_INFINITY)).toThrow(/floor_invalid/);
  });

  it("an unreadable setting admits nothing (the read throws)", async () => {
    const ctx = setup();
    ctx.pacer.initTakeover(0);
    ctx.pause.failure = new Error("connection terminated");
    await expect(ctx.pacer.waitForSlot(live())).rejects.toThrow("connection terminated");
    expect(ctx.pacer.snapshot().inFlight).toBeNull();
  });

  it.each([Number.NaN, 0, -1, Number.POSITIVE_INFINITY])("an unusable setting (%s) admits nothing", async (value) => {
    const ctx = setup();
    ctx.pacer.initTakeover(0);
    ctx.pause.settingMs = value;
    await expect(ctx.pacer.waitForSlot(live())).rejects.toMatchObject({ reason: "setting_invalid" });
  });

  it("S below 2 000 ms is impossible: the pacer paces at the owner's floor", async () => {
    const ctx = setup({ settingMs: 500 });
    ctx.pacer.initTakeover(0);
    const first = await sendOne(ctx);
    const second = await sendOne(ctx, { attemptId: 2 });
    expect(second.grant.settingMs).toBe(FANSLY_PAUSE_MIN_MS);
    expect(second.admission.sentMono! - first.admission.sentMono!).toBeGreaterThanOrEqual(FANSLY_PAUSE_MIN_MS);
  });

  it("the test-only minimum lowers the floor (and nothing else does)", async () => {
    const ctx = setup({ settingMs: 300, minSettingMs: 1 });
    ctx.pacer.initTakeover(0);
    const first = await sendOne(ctx);
    const second = await sendOne(ctx, { attemptId: 2 });
    expect(second.grant.settingMs).toBe(300);
    expect(second.admission.sentMono! - first.admission.sentMono!).toBeGreaterThanOrEqual(300);
  });

  it("the jitter source must stay in [0, 1)", async () => {
    const ctx = setup({ rng: new ScriptedRng([1]) });
    ctx.pacer.initTakeover(0);
    await expect(ctx.pacer.waitForSlot(live())).rejects.toMatchObject({ reason: "rng_invalid" });
  });

  it("an aborted wait admits nothing", async () => {
    const ctx = setup();
    ctx.pacer.initTakeover(10_000);
    const controller = new AbortController();
    ctx.clock.onSleep = () => controller.abort(new Error("shutdown"));
    await expect(ctx.pacer.waitForSlot(controller.signal)).rejects.toThrow("shutdown");
    expect(ctx.pacer.snapshot().inFlight).toBeNull();
  });

  it("a stopped pacer admits nothing and refuses the dispatch in flight", async () => {
    const ctx = setup();
    ctx.pacer.initTakeover(0);
    const grant = await ctx.pacer.waitForSlot(live());
    const admission = ctx.pacer.arm(grant, 1, ctx.clock.monoNow());
    ctx.pacer.stop();
    expect(ctx.pacer.check(admission)?.reason).toBe("lease_inactive");
    ctx.pacer.complete(admission, { kind: "aborted_before_send", refusal: "lease_inactive" });
    await expect(ctx.pacer.waitForSlot(live())).rejects.toBeInstanceOf(PacerStoppedError);
  });
});

describe("sync pacer: the pause rule (I1, I2, I4)", () => {
  it("pause = ceil(S × (1 + u)), u = rng × 0.2, measured from the previous actual send", async () => {
    const ctx = setup({ rng: new ScriptedRng([0.5, 0.25]) });
    ctx.pacer.initTakeover(0);
    const first = await sendOne(ctx, { responseMs: 100 });
    expect(first.grant.jitterU).toBeCloseTo(0.1, 12);
    const second = await sendOne(ctx, { attemptId: 2 });
    expect(second.grant.jitterU).toBeCloseTo(0.05, 12);
    expect(second.grant.pauseMs).toBe(Math.ceil(S * 1.05));
    expect(second.admission.sentMono! - first.admission.sentMono!).toBeGreaterThanOrEqual(second.grant.pauseMs);
    expect(second.admission.gapPrevMs).toBe(second.admission.sentMono! - first.admission.sentMono!);
    expect(second.admission.sendMark).toBe("request_start");
  });

  it("the gap is measured at the actual send, so a slow admission or proxy never shortens it", async () => {
    const ctx = setup();
    ctx.pacer.initTakeover(0);
    const first = await sendOne(ctx, { admitMs: 400, connectMs: 4_000, responseMs: 10 });
    const second = await sendOne(ctx, { attemptId: 2, admitMs: 0, connectMs: 0 });
    expect(second.admission.sentMono! - first.admission.sentMono!).toBeGreaterThanOrEqual(S);
  });

  it("the next slot never opens before the previous request completed", async () => {
    const ctx = setup();
    ctx.pacer.initTakeover(0);
    const first = await sendOne(ctx, { responseMs: 9_000 });
    const completedAt = ctx.clock.monoNow();
    const second = await ctx.pacer.waitForSlot(live());
    expect(second.earliestMono).toBeGreaterThanOrEqual(completedAt);
    expect(first.admission.sentMono! + second.pauseMs).toBeLessThan(completedAt);
  });

  it("one request in flight: no slot and no second arm until the completion", async () => {
    const ctx = setup();
    ctx.pacer.initTakeover(0);
    const grant = await ctx.pacer.waitForSlot(live());
    const admission = ctx.pacer.arm(grant, 1, ctx.clock.monoNow());
    await expect(ctx.pacer.waitForSlot(live())).rejects.toMatchObject({ reason: "in_flight" });
    expect(() => ctx.pacer.arm(grant, 2, ctx.clock.monoNow())).toThrow(/in_flight/);
    expect(() => ctx.pacer.initTakeover(0)).toThrow(/in_flight/);
    ctx.pacer.check(admission);
    ctx.pacer.complete(admission, response());
    await expect(ctx.pacer.waitForSlot(live())).resolves.toMatchObject({ settingMs: S });
  });

  it("u is drawn once per send: re-waits keep it, a completed send draws the next", async () => {
    const ctx = setup({ rng: new ScriptedRng([0.9, 0.1]) });
    ctx.pacer.initTakeover(0);
    const idle1 = await ctx.pacer.waitForSlot(live());
    const idle2 = await ctx.pacer.waitForSlot(live());
    expect(idle2.jitterU).toBe(idle1.jitterU);
    // A refused dispatch sends nothing: u stays.
    const refusedAdmission = ctx.pacer.arm(idle2, 1, ctx.clock.monoNow() - SEND_WINDOW_MS);
    expect(ctx.pacer.check(refusedAdmission)?.reason).toBe("send_deadline_passed");
    ctx.pacer.complete(refusedAdmission, { kind: "aborted_before_send", refusal: "send_deadline_passed" });
    expect(ctx.pacer.snapshot().pendingU).toBeCloseTo(0.18, 12);
    const sent = await sendOne(ctx, { attemptId: 2 });
    expect(sent.grant.jitterU).toBeCloseTo(0.18, 12);
    expect(ctx.pacer.snapshot().pendingU).toBeNull();
    const next = await ctx.pacer.waitForSlot(live());
    expect(next.jitterU).toBeCloseTo(0.02, 12);
  });

  it("re-reads S at least every second while waiting: a raised S lengthens the wait in progress", async () => {
    const ctx = setup({ settingMs: 2_000 });
    ctx.pacer.initTakeover(0);
    const first = await sendOne(ctx, { responseMs: 100 });
    const readsBefore = ctx.pause.reads;
    ctx.clock.onSleep = () => {
      ctx.pause.settingMs = 6_000;
    };
    const grant = await ctx.pacer.waitForSlot(live());
    expect(grant.settingMs).toBe(6_000);
    expect(ctx.clock.monoNow() - first.admission.sentMono!).toBeGreaterThanOrEqual(6_000);
    expect(Math.max(...ctx.clock.sleeps)).toBeLessThanOrEqual(SETTING_RECHECK_MS);
    expect(ctx.pause.reads - readsBefore).toBeGreaterThanOrEqual(6);
  });

  it("a lowered S applies to the next admission: the gap follows the setting read at that admission", async () => {
    const ctx = setup({ settingMs: 6_000 });
    ctx.pacer.initTakeover(0);
    const first = await sendOne(ctx, { responseMs: 100 });
    ctx.pause.settingMs = 2_000;
    const second = await sendOne(ctx, { attemptId: 2 });
    expect(second.grant.settingMs).toBe(2_000);
    const gap = second.admission.sentMono! - first.admission.sentMono!;
    expect(gap).toBeGreaterThanOrEqual(2_000);
    expect(gap).toBeLessThan(6_000);
  });

  it("timers that fire early never open the slot early (the loop re-checks)", async () => {
    const ctx = setup();
    ctx.pacer.initTakeover(0);
    // Every sleep resolves 50 ms early (half of a short one).
    ctx.clock.wakeEarlyBy = (ms) => Math.min(50, ms / 2);
    const first = await sendOne(ctx, { responseMs: 50 });
    const second = await sendOne(ctx, { attemptId: 2 });
    expect(second.admission.sentMono! - first.admission.sentMono!).toBeGreaterThanOrEqual(second.grant.pauseMs);
    expect(ctx.clock.sleeps.length).toBeGreaterThan(3);
  });
});

describe("sync pacer: the send check", () => {
  async function armed(ctx: ReturnType<typeof setup>) {
    const grant = await ctx.pacer.waitForSlot(live());
    return ctx.pacer.arm(grant, 7, ctx.clock.monoNow());
  }

  it("passes once; a second dispatch of the same admission is refused (lease_used)", async () => {
    const ctx = setup();
    ctx.pacer.initTakeover(0);
    const admission = await armed(ctx);
    expect(ctx.pacer.check(admission)).toBeNull();
    const sentAt = admission.sentMono;
    ctx.clock.advance(3_000);
    const hop = ctx.pacer.check(admission);
    expect(hop).toBeInstanceOf(FanslySendRefusedError);
    expect(hop?.reason).toBe("lease_used");
    expect(admission.sentMono).toBe(sentAt);
    expect(ctx.pacer.snapshot().lastSendMono).toBe(sentAt);
  });

  it("refuses after the lock session is gone (lease_inactive)", async () => {
    const ctx = setup();
    ctx.pacer.initTakeover(0);
    const admission = await armed(ctx);
    ctx.ownership.isAlive = false;
    expect(ctx.pacer.check(admission)?.reason).toBe("lease_inactive");
    expect(admission.sentMono).toBeNull();
    expect(admission.refusal).toBe("lease_inactive");
  });

  it("refuses once the send window, measured from the issue before the admission commit, has passed", async () => {
    const ctx = setup();
    ctx.pacer.initTakeover(0);
    const grant = await ctx.pacer.waitForSlot(live());
    const issued = ctx.clock.monoNow();
    ctx.clock.advance(4_000); // a slow admission transaction
    const admission = ctx.pacer.arm(grant, 1, issued);
    expect(admission.sendDeadlineMono).toBe(issued + SEND_WINDOW_MS);
    ctx.clock.advance(SEND_WINDOW_MS - 4_000); // the proxy tunnel took the rest
    expect(ctx.pacer.check(admission)?.reason).toBe("send_deadline_passed");
  });

  it("refuses before the takeover floor (takeover_floor)", () => {
    const ctx = setup();
    ctx.pacer.initTakeover(5_000);
    const grant: SlotGrant = { settingMs: S, jitterU: 0, pauseMs: S, earliestMono: 0 };
    const admission = ctx.pacer.arm(grant, 1, ctx.clock.monoNow());
    expect(ctx.pacer.check(admission)?.reason).toBe("takeover_floor");
  });

  it("refuses a dispatch closer than the pause to the previous send (pace: a belt that fires only on a bug)", async () => {
    const ctx = setup();
    ctx.pacer.initTakeover(0);
    await sendOne(ctx, { responseMs: 10 });
    const grant: SlotGrant = { settingMs: S, jitterU: 0, pauseMs: S, earliestMono: 0 };
    const admission = ctx.pacer.arm(grant, 2, ctx.clock.monoNow());
    expect(ctx.pacer.check(admission)?.reason).toBe("pace");
  });

  it("refuses a stale admission that is no longer in flight", async () => {
    const ctx = setup();
    ctx.pacer.initTakeover(0);
    const admission = await armed(ctx);
    ctx.pacer.complete(admission, { kind: "aborted_before_send", refusal: "lease_inactive" });
    expect(ctx.pacer.check(admission)?.reason).toBe("lease_inactive");
    expect(() => ctx.pacer.complete(admission, response())).toThrow(/foreign_admission/);
  });
});

describe("sync pacer: completions", () => {
  it("a response without an onRequestStart mark counts as sent at its completion (safe upper bound)", async () => {
    const ctx = setup();
    ctx.pacer.initTakeover(0);
    const grant = await ctx.pacer.waitForSlot(live());
    const admission = ctx.pacer.arm(grant, 1, ctx.clock.monoNow());
    ctx.clock.advance(1_500);
    const completedAt = ctx.clock.monoNow();
    ctx.pacer.complete(admission, response("completion_fallback"));
    expect(admission.sentMono).toBe(completedAt);
    expect(admission.sendMark).toBe("completion_fallback");
    const next = await ctx.pacer.waitForSlot(live());
    expect(ctx.clock.monoNow()).toBeGreaterThanOrEqual(completedAt + next.pauseMs);
  });

  it("a transport error after the bytes may have left counts as a send at its completion", async () => {
    const ctx = setup();
    ctx.pacer.initTakeover(0);
    const grant = await ctx.pacer.waitForSlot(live());
    const admission = ctx.pacer.arm(grant, 1, ctx.clock.monoNow());
    ctx.clock.advance(800);
    ctx.pacer.complete(admission, { kind: "transport_error", sent: true, message: "socket hang up" });
    expect(admission.sentMono).toBe(ctx.clock.monoNow());
    expect(ctx.pacer.snapshot().lastSendMono).toBe(ctx.clock.monoNow());
  });

  it("a refusal sends nothing: neither the send nor the completion instant moves", async () => {
    const ctx = setup();
    ctx.pacer.initTakeover(0);
    const first = await sendOne(ctx);
    const before = ctx.pacer.snapshot();
    const grant = await ctx.pacer.waitForSlot(live());
    const admission = ctx.pacer.arm(grant, 2, ctx.clock.monoNow());
    ctx.ownership.isAlive = false;
    expect(ctx.pacer.check(admission)?.reason).toBe("lease_inactive");
    ctx.pacer.complete(admission, { kind: "aborted_before_send", refusal: "lease_inactive" });
    const after = ctx.pacer.snapshot();
    expect(after.lastSendMono).toBe(first.admission.sentMono);
    expect(after.lastCompletionMono).toBe(before.lastCompletionMono);
    expect(after.inFlight).toBeNull();
  });

  it("a network failure before sending still marks the completion (never earlier than it)", async () => {
    const ctx = setup();
    ctx.pacer.initTakeover(0);
    const grant = await ctx.pacer.waitForSlot(live());
    const admission = ctx.pacer.arm(grant, 1, ctx.clock.monoNow());
    ctx.clock.advance(REQUEST_TIMEOUT_MS);
    ctx.pacer.complete(admission, { kind: "timeout", sent: false, message: "budget" });
    expect(admission.sentMono).toBeNull();
    expect(ctx.pacer.snapshot().lastCompletionMono).toBe(ctx.clock.monoNow());
  });

  it("an answer after a passed check keeps the check instant as the send", async () => {
    const ctx = setup();
    ctx.pacer.initTakeover(0);
    const grant = await ctx.pacer.waitForSlot(live());
    const admission = ctx.pacer.arm(grant, 1, ctx.clock.monoNow());
    expect(ctx.pacer.check(admission)).toBeNull();
    const sentAt = ctx.clock.monoNow();
    ctx.clock.advance(600);
    ctx.pacer.complete(admission, response());
    expect(admission.sentMono).toBe(sentAt);
    expect(ctx.pacer.snapshot().lastCompletionMono).toBe(sentAt + 600);
  });
});

describe("sync pacer: takeover (I5)", () => {
  it("a re-takeover keeps what this process already knows: the floor never shortens a pause", async () => {
    const ctx = setup({ rng: new ScriptedRng([0.5]) });
    ctx.pacer.initTakeover(0);
    const first = await sendOne(ctx, { responseMs: 10 });
    ctx.pacer.initTakeover(0);
    const second = await sendOne(ctx, { attemptId: 2 });
    expect(second.admission.sentMono! - first.admission.sentMono!).toBeGreaterThanOrEqual(second.grant.pauseMs);
  });

  it("the floor holds even when the previous send is long past", async () => {
    const ctx = setup();
    ctx.pacer.initTakeover(0);
    await sendOne(ctx);
    ctx.clock.advance(60_000);
    const takeoverAt = ctx.clock.monoNow();
    ctx.pacer.initTakeover(2_400);
    const next = await sendOne(ctx, { attemptId: 2 });
    expect(next.admission.sentMono).toBeGreaterThanOrEqual(takeoverAt + 2_400);
  });
});

describe("sync pacer: constants and the test-only floor", () => {
  it("the constants are the plan's", () => {
    expect(JITTER_MAX).toBe(0.2);
    expect(TAKEOVER_FACTOR).toBe(1.2);
    expect(SETTING_RECHECK_MS).toBe(1_000);
    expect(SEND_WINDOW_MS).toBe(15_000);
    expect(REQUEST_TIMEOUT_MS).toBe(20_000);
  });

  it("u stays in [0, 0.2) for the production-shaped source", async () => {
    const ctx = setup({ rng: new SeededRng(42) });
    ctx.pacer.initTakeover(0);
    for (let i = 0; i < 200; i += 1) {
      const { grant } = await sendOne(ctx, { attemptId: i });
      expect(grant.jitterU).toBeGreaterThanOrEqual(0);
      expect(grant.jitterU).toBeLessThan(JITTER_MAX);
      expect(grant.pauseMs).toBeGreaterThanOrEqual(grant.settingMs);
    }
  });

  it("I4: no runtime source but the pacer names `minSettingMs` (the host never lowers the 2 s floor)", () => {
    const root = path.resolve("apps/runtime/src");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts") && readFileSync(full, "utf8").includes("minSettingMs")) {
          offenders.push(path.relative(root, full));
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([path.join("sync", "engine", "pacer.ts")]);
  });
});
