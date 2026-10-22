import { describe, expect, it } from "vitest";

import * as node from "../packages/fansly/src/client-ts.ts";
import { buildFanslyRequestHeaders } from "../packages/fansly/src/request-headers.ts";
import * as operator from "../apps/page-browser/src/hub-requests/client-ts.ts";

// fansly-client-ts as Fansly's web app sets it (client-ts.ts): its two
// copies — the Node pages' and the page browser operator's — held to the
// same vectors. The vectors are what Fansly's own getNowTs (bundle
// main.0498e26990eb6fa6.js, both its session and its device service's
// method, which agree) gave for these inputs, run on 2026-10-22. The ids and
// times are synthetic: Fansly-shaped, nobody's.

type Step = { timeMs: number; id: string | null; value: number };

const VECTORS: Record<string, Step[]> = {
  // time[-6..-5] "12": id[-1]=4 ^ 1 = 5 → "57" (padded with id[-3]); id[-2]=3 ^ 2 = 1 → "14" (with id[-1])
  bothPairsOneDigit: [{ timeMs: 1800000123456, id: "100000000000000734", value: 1800000125714 }],
  // "35": 8 ^ 3 = 11, 9 ^ 5 = 12
  bothPairsTwoDigits: [{ timeMs: 1800000354321, id: "100000000000000198", value: 1800000351112 }],
  // "35": 1 ^ 3 = 2 → "24"; 8 ^ 5 = 13
  firstOneSecondTwo: [{ timeMs: 1800000350000, id: "100000000000000481", value: 1800000352413 }],
  // "35": 9 ^ 3 = 10; 1 ^ 5 = 4 → "49"
  firstTwoSecondOne: [{ timeMs: 1800000359999, id: "100000000000000619", value: 1800000351049 }],
  noId: [{ timeMs: 1800000123456, id: null, value: 1800000123456 }],
  // The clock goes back: the cache answers.
  clockBack: [
    { timeMs: 1800000400000, id: "100000000000000734", value: 1800000400734 },
    { timeMs: 1800000390000, id: "100000000000000734", value: 1800000400734 },
    { timeMs: 1800000410000, id: "100000000000000734", value: 1800000410724 },
  ],
  // Another id inside one 10 s: the cache answers until the next 10 s.
  idChangesInWindow: [
    { timeMs: 1800000129000, id: "100000000000000198", value: 1800000129111 },
    { timeMs: 1800000129500, id: "100000000000000734", value: 1800000129111 },
    { timeMs: 1800000130000, id: "100000000000000734", value: 1800000135704 },
  ],
};

const COPIES = { node, operator } as const;

describe("fansly-client-ts: both copies give Fansly's getNowTs", () => {
  for (const [copy, impl] of Object.entries(COPIES)) {
    for (const [name, steps] of Object.entries(VECTORS)) {
      it(`${copy}: ${name}`, () => {
        const clock = new impl.FanslyClientTsClock();
        expect(steps.map((step) => clock.next(step.timeMs, step.id))).toEqual(steps.map((step) => step.value));
        // The formula alone, where no cache answered.
        if (steps.length === 1) expect(impl.fanslyClientTs(steps[0]!.timeMs, steps[0]!.id)).toBe(steps[0]!.value);
      });
    }

    it(`${copy}: a value's tail is judged against its own leading digits`, () => {
      for (const steps of Object.values(VECTORS)) {
        for (const step of steps) {
          if (step.id === null || step.value !== impl.fanslyClientTs(step.timeMs, step.id)) continue;
          expect(impl.fanslyClientTsTailMatches(String(step.value), step.id)).toBe(true);
          const other = String(step.value).slice(0, -4) + (String(step.value).endsWith("0000") ? "1111" : "0000");
          expect(impl.fanslyClientTsTailMatches(other, step.id)).toBe(false);
        }
      }
      // Not what the formula was seen to take: no match.
      expect(impl.fanslyClientTsTailMatches("1800000125714", "pb-session-734")).toBe(false);
      expect(impl.fanslyClientTsTailMatches("18000001257x4", "100000000000000734")).toBe(false);
    });
  }
});

describe("a Node page's request (buildFanslyRequestHeaders)", () => {
  // Times in the past: the builder's cache lives with the module.
  const base = { authorization: "synthetic-token", routeChecks: {} };

  it("carries the formula's tail: from the session's id, without one from the device's, with neither the time itself", () => {
    const at = 1700000354321;
    const withSession = buildFanslyRequestHeaders({ ...base, fanslyClientId: "100000000000000481", fanslySessionId: "100000000000000198" }, "/api/v1/account/me", at);
    expect(withSession["fansly-client-ts"]).toBe("1700000351112");
    const deviceOnly = buildFanslyRequestHeaders({ ...base, fanslyClientId: "100000000000000198" }, "/api/v1/account/me", at);
    expect(deviceOnly["fansly-session-id"]).toBeUndefined();
    expect(deviceOnly["fansly-client-ts"]).toBe("1700000351112");
    expect(buildFanslyRequestHeaders(base, "/api/v1/account/me", at)["fansly-client-ts"]).toBe(String(at));
  });

  it("never goes back for the same session", () => {
    const session = { ...base, fanslyClientId: "100000000000000001", fanslySessionId: "100000000000000734" };
    expect(buildFanslyRequestHeaders(session, "/api/v1/account/me", 1700000400000)["fansly-client-ts"]).toBe("1700000400734");
    expect(buildFanslyRequestHeaders(session, "/api/v1/account/me", 1700000390000)["fansly-client-ts"]).toBe("1700000400734");
    expect(buildFanslyRequestHeaders(session, "/api/v1/account/me", 1700000410000)["fansly-client-ts"]).toBe("1700000410724");
  });
});
