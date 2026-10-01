import { describe, expect, it } from "vitest";

import { FANSLY_PAUSE_MIN_MS, FANSLY_PAUSE_MAX_MS } from "@agency_hub_core/shared";

import {
  JITTER_MAX,
  Pacer,
  REQUEST_TIMEOUT_MS,
  SEND_WINDOW_MS,
  TAKEOVER_FACTOR,
  type SlotGrant,
} from "../apps/runtime/src/sync/engine/pacer.ts";
import type { PauseSource, TransportOutcome } from "../apps/runtime/src/sync/engine/ports.ts";
import { FakeClock, FakeOwnership, seededRandom } from "./helpers/sync-fakes.ts";

// Plan §15 step 2: "10⁶ admissions with random delays — 0 violations". The
// pacer state machine on a virtual clock with a seeded RNG: random admission
// commits, proxy connect delays (some beyond the send window), response
// times 0–3 s, timers that wake early, owner setting changes anywhere in
// [2 000, 60 000] ms (also in the middle of a wait), aborted waits, redirect
// hops, transports without an onRequestStart mark (the true send instant is
// then somewhere before the completion), network failures before and after
// the bytes left, and ownership losses followed by a takeover. After every
// ACTUAL send the invariants are checked:
//   I1  gap to the previous actual send ≥ ceil(S × (1 + u)) ≥ S ≥ 2 000 ms,
//       S and u being those of the later admission;
//   I2  the send is not before the previous request completed;
//   I5  the first send after a takeover is not before its floor.

const ADMISSIONS = 1_000_000;

type Violation = { admission: number; rule: string; detail: string };

describe("sync pacer property: 10⁶ admissions, 0 violations", () => {
  it("holds I1, I2 and I5 under random delays, settings, aborts and takeovers", async () => {
    const random = seededRandom(20_261_002);
    const clock = new FakeClock();
    const ownership = new FakeOwnership();
    let settingMs = FANSLY_PAUSE_MIN_MS;
    let reads = 0;
    const pause: PauseSource = {
      readSettingMs() {
        reads += 1;
        const r = random();
        // Mostly near the floor (a realistic S); now and then anywhere up to
        // the ceiling; the change may land in the middle of a wait.
        if (r < 2e-4) settingMs = FANSLY_PAUSE_MIN_MS + Math.floor(random() * (FANSLY_PAUSE_MAX_MS - FANSLY_PAUSE_MIN_MS));
        else if (r < 4e-3) settingMs = FANSLY_PAUSE_MIN_MS + Math.floor(random() * 1_000);
        return Promise.resolve(settingMs);
      },
    };
    // A third of the sleeps resolve early, by up to 100 ms (never more than half).
    clock.wakeEarlyBy = (ms) => (random() < 0.33 ? Math.min(ms / 2, random() * 100) : 0);

    const pacer = new Pacer({ clock, rng: { next: random }, pause, ownership });
    let takeoverFloor = clock.monoNow() + Math.ceil(settingMs * TAKEOVER_FACTOR);
    pacer.initTakeover(takeoverFloor - clock.monoNow());
    let floorPending = true;

    let prevSend: number | null = null;
    let prevCompletion: number | null = null;
    let sends = 0;
    let refusals = 0;
    let fallbacks = 0;
    let aborts = 0;
    let takeovers = 1;
    let minRatio = Number.POSITIVE_INFINITY;
    const uBins = new Array<number>(10).fill(0);
    const violations: Violation[] = [];

    const recordSend = (index: number, at: number, grant: SlotGrant) => {
      if (grant.settingMs < FANSLY_PAUSE_MIN_MS) {
        violations.push({ admission: index, rule: "I4", detail: `S ${grant.settingMs}` });
      }
      if (grant.pauseMs !== Math.ceil(grant.settingMs * (1 + grant.jitterU))) {
        violations.push({ admission: index, rule: "pause", detail: `${grant.pauseMs} for S ${grant.settingMs}, u ${grant.jitterU}` });
      }
      if (prevSend !== null) {
        const gap = at - prevSend;
        minRatio = Math.min(minRatio, gap / grant.settingMs);
        if (gap < grant.pauseMs) {
          violations.push({ admission: index, rule: "I1", detail: `gap ${gap} < pause ${grant.pauseMs}` });
        }
      }
      if (prevCompletion !== null && at < prevCompletion) {
        violations.push({ admission: index, rule: "I2", detail: `send ${at} before completion ${prevCompletion}` });
      }
      if (floorPending && at < takeoverFloor) {
        violations.push({ admission: index, rule: "I5", detail: `send ${at} before floor ${takeoverFloor}` });
      }
      floorPending = false;
      prevSend = at;
      sends += 1;
    };

    for (let index = 0; index < ADMISSIONS && violations.length === 0; index += 1) {
      // The slot. One wait in a thousand is aborted (shutdown, mode change).
      const controller = new AbortController();
      if (random() < 1e-3) {
        clock.onSleep = () => {
          if (random() < 0.5) controller.abort(new Error("aborted"));
        };
      }
      let grant: SlotGrant;
      try {
        grant = await pacer.waitForSlot(controller.signal);
      } catch (error) {
        clock.onSleep = null;
        if ((error as Error).message !== "aborted") throw error;
        aborts += 1;
        continue;
      }
      clock.onSleep = null;
      uBins[Math.min(9, Math.floor((grant.jitterU / JITTER_MAX) * 10))]! += 1;

      // Picking work and the admission commit take a little time.
      const issued = clock.monoNow();
      clock.advance(random() * 50);
      const admission = pacer.arm(grant, index, issued);

      // The proxy tunnel: mostly fast, sometimes slow, rarely past the window.
      const c = random();
      clock.advance(c < 0.9 ? random() * 300 : c < 0.99 ? random() * 5_000 : SEND_WINDOW_MS + random() * 5_000);
      if (random() < 2e-4) ownership.isAlive = false; // the lock session died

      let outcome: TransportOutcome;
      const mode = random();
      if (mode < 0.85) {
        // A normal dispatch: the check runs at onRequestStart.
        const refusal = pacer.check(admission);
        if (refusal !== null) {
          refusals += 1;
          outcome = { kind: "aborted_before_send", refusal: refusal.reason };
        } else {
          recordSend(index, clock.monoNow(), grant);
          if (random() < 0.01 && pacer.check(admission)?.reason !== "lease_used") {
            // A redirect hop or hidden re-send of the same admission.
            violations.push({ admission: index, rule: "I3", detail: "second dispatch was not refused" });
          }
          clock.advance(random() * 3_000);
          outcome = { kind: "response", status: 200, headers: {}, bodyText: "{}", bodyBytes: 2, sendMark: "request_start" };
        }
      } else if (mode < 0.9) {
        // No onRequestStart mark: the bytes leave now, the pacer learns only
        // of the completion.
        recordSend(index, clock.monoNow(), grant);
        fallbacks += 1;
        clock.advance(random() * 3_000);
        outcome = { kind: "response", status: 200, headers: {}, bodyText: "{}", bodyBytes: 2, sendMark: "completion_fallback" };
      } else if (mode < 0.92) {
        // The request went out without an onRequestStart mark, then the
        // connection broke: the transport reports `sent`.
        recordSend(index, clock.monoNow(), grant);
        fallbacks += 1;
        clock.advance(random() * 3_000);
        outcome = { kind: "transport_error", sent: true, message: "socket hang up" };
      } else if (mode < 0.95) {
        // The request went out, then the connection broke.
        const refusal = pacer.check(admission);
        if (refusal !== null) {
          refusals += 1;
          outcome = { kind: "aborted_before_send", refusal: refusal.reason };
        } else {
          recordSend(index, clock.monoNow(), grant);
          clock.advance(random() * 3_000);
          outcome = { kind: "transport_error", sent: true, message: "socket hang up" };
        }
      } else if (mode < 0.98) {
        outcome = { kind: "transport_error", sent: false, message: "proxy refused" };
      } else {
        clock.advance(REQUEST_TIMEOUT_MS);
        outcome = { kind: "timeout", sent: false, message: "budget" };
      }
      pacer.complete(admission, outcome);
      prevCompletion = clock.monoNow();

      if (!ownership.isAlive) {
        // A new owner (this very pacer, a new generation): the database floor
        // is 1.2 × S from now at least.
        ownership.isAlive = true;
        const floorDelay = Math.ceil(settingMs * TAKEOVER_FACTOR);
        takeoverFloor = clock.monoNow() + floorDelay;
        pacer.initTakeover(floorDelay);
        floorPending = true;
        takeovers += 1;
      }
    }

    expect(violations).toEqual([]);
    expect(sends).toBeGreaterThan(ADMISSIONS * 0.9);
    expect(minRatio).toBeGreaterThanOrEqual(1);
    expect(refusals).toBeGreaterThan(0);
    expect(fallbacks).toBeGreaterThan(0);
    expect(aborts).toBeGreaterThan(0);
    expect(takeovers).toBeGreaterThan(10);
    expect(reads).toBeGreaterThan(ADMISSIONS);
    // u is uniform on [0, 0.2): every tenth of the range within 5 % of its share.
    const draws = uBins.reduce((sum, count) => sum + count, 0);
    for (const count of uBins) {
      expect(Math.abs(count / draws - 0.1)).toBeLessThan(0.005);
    }
  }, 300_000);
});
