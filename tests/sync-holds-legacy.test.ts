import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  holdRowsOfLegacyColumns,
  legacyHoldColumnsOf,
  sameLegacyHoldColumns,
  SyncLegacyHoldsUnreadableError,
  type SyncHoldRow,
  type SyncLegacyHoldColumns,
} from "@agency_hub_core/db";
import { INDEFINITE_UNTIL } from "@agency_hub_core/shared";

import { holdSetOf } from "../apps/runtime/src/sync/engine/admission.ts";
import { pageHoldRow, resourceBreakerRow, routeHoldRows } from "./helpers/sync-holds.ts";

// The hold set beside the old hold columns, while the previous image reads
// them (step 4, S4-30): what that image must read to hold what the rows
// hold, and the rows the columns say — the two pure halves of the dual write
// and of the import at an acquisition (tests/sync-hold-set.integration.test.ts
// runs them on a database).

const NOW = new Date("2026-10-04T12:00:00.000Z");
const MIN = 60_000;
const at = (ms: number) => new Date(NOW.getTime() + ms);

const empty: SyncLegacyHoldColumns = { holdKind: null, holdUntil: null, holdSince: null, holdDetail: {}, resourceHolds: {} };
const refusal = { status: 401, credentialsGeneration: "gen-b", failedAttemptId: 7, failedAt: at(-MIN).toISOString() };
const backoff = { streak: 4, networkSince: at(-5 * MIN).toISOString() };

/** Rows as a database would hand out those the columns say (`since` filled). */
function imported(columns: SyncLegacyHoldColumns): SyncHoldRow[] {
  return holdRowsOfLegacyColumns(7, columns).map((row) => ({ ...row, since: row.since ?? NOW }));
}

describe("the old columns of a hold set (what the previous image reads)", () => {
  it("nothing held is the empty slot and no resource hold", () => {
    expect(legacyHoldColumnsOf([])).toEqual(empty);
  });

  it("the slot: the credentials hold carrying the network hold beside it; else the network hold", () => {
    const auth = pageHoldRow("auth", INDEFINITE_UNTIL, { since: at(-10 * MIN), detail: refusal });
    const network = pageHoldRow("network", at(MIN), { since: at(-5 * MIN), detail: backoff });
    expect(legacyHoldColumnsOf([auth])).toEqual({ ...empty, holdKind: "auth", holdUntil: INDEFINITE_UNTIL, holdSince: at(-10 * MIN), holdDetail: refusal });
    expect(legacyHoldColumnsOf([network])).toEqual({ ...empty, holdKind: "network", holdUntil: at(MIN), holdSince: at(-5 * MIN), holdDetail: backoff });
    expect(legacyHoldColumnsOf([auth, network])).toEqual({
      ...empty,
      holdKind: "auth",
      holdUntil: INDEFINITE_UNTIL,
      holdSince: at(-10 * MIN),
      // As that image carries a timed hold beside a credentials hold.
      holdDetail: { ...refusal, timedHold: { kind: "network", until: at(MIN).toISOString(), detail: backoff } },
    });
  });

  it("`resource_holds`: each breaker by file, and every route's entry under `route:state` (version 1)", () => {
    const rows = [
      resourceBreakerRow("probe", at(30 * MIN), { step: 7, since: at(-MIN) }),
      ...routeHoldRows("messaging.groups", {
        holdUntil: at(5_000).toISOString(), ladderStep: 2, effectivePerMin: 3, policyVersion: "abc", last429AttemptId: 9,
        last429At: at(-1_000).toISOString(), revision: 4,
      }),
      ...routeHoldRows("polls", { revision: 2 }),
    ];
    expect(legacyHoldColumnsOf(rows).resourceHolds).toEqual({
      probe: { until: at(30 * MIN).toISOString(), step: 7, since: at(-MIN).toISOString() },
      "route:state": {
        version: 1,
        routes: {
          "messaging.groups": {
            holdUntil: at(5_000).toISOString(), ladderStep: 2, effectivePerMin: 3, policyVersion: "abc", last429AttemptId: 9,
            last429At: at(-1_000).toISOString(), revision: 4,
          },
          polls: { holdUntil: null, ladderStep: 0, effectivePerMin: null, policyVersion: null, last429AttemptId: null, last429At: null, revision: 2 },
        },
      },
    });
  });
});

describe("the hold set the old columns say", () => {
  it("reads back exactly the rows the columns were written from: a round trip changes neither side", () => {
    const rows = [
      pageHoldRow("identity_mismatch", INDEFINITE_UNTIL, { since: at(-10 * MIN), detail: refusal }),
      pageHoldRow("network", at(MIN), { since: at(-5 * MIN), detail: backoff }),
      resourceBreakerRow("probe", at(30 * MIN), { step: 7, since: at(-MIN) }),
      resourceBreakerRow("transactions", at(-MIN), { step: 1, since: at(-60 * MIN) }),
      ...routeHoldRows("messaging.groups", {
        holdUntil: at(5_000).toISOString(), ladderStep: 2, effectivePerMin: 3, policyVersion: "abc", last429AttemptId: 9,
        last429At: at(-1_000).toISOString(), revision: 4,
      }),
      ...routeHoldRows("media.offer_stats", { ladderStep: 1, effectivePerMin: 2.5, revision: 2 }),
    ];
    const columns = legacyHoldColumnsOf(rows);
    const back = imported(columns);
    expect(sameLegacyHoldColumns(legacyHoldColumnsOf(back), columns)).toBe(true);
    // The engine reads the same holds from either set of rows.
    const [before, after] = [holdSetOf(rows), holdSetOf(back)];
    expect(after.page).toEqual(before.page);
    expect(after.resources).toEqual(before.resources);
    expect(after.routes).toEqual(before.routes);
    expect(after.unreadable).toEqual([]);
  });

  it("columns that say something else are told apart, whatever the JSON key order or an instant's precision", () => {
    const columns = legacyHoldColumnsOf([pageHoldRow("auth", INDEFINITE_UNTIL, { since: at(-MIN), detail: refusal }), resourceBreakerRow("probe", at(MIN))]);
    const reordered = { ...columns, holdDetail: Object.fromEntries(Object.entries(columns.holdDetail).reverse()) };
    expect(sameLegacyHoldColumns(columns, reordered)).toBe(true);
    for (const other of [
      { ...columns, holdKind: "identity_mismatch" },
      { ...columns, holdUntil: at(MIN) },
      { ...columns, holdSince: at(-2 * MIN) },
      { ...columns, holdDetail: { ...columns.holdDetail, failedAttemptId: 8 } },
      { ...columns, resourceHolds: {} },
      { ...columns, resourceHolds: { ...columns.resourceHolds, posts: { until: at(MIN).toISOString(), step: 1, since: NOW.toISOString() } } },
      empty,
    ]) {
      expect(sameLegacyHoldColumns(columns, other), JSON.stringify(other)).toBe(false);
    }
  });

  it("a page-wide 429 hold an older build wrote — the slot's own, or carried — is a hold of the page until its end, named", () => {
    const own = imported({ ...empty, holdKind: "rate_limit", holdUntil: at(2 * MIN), holdSince: at(-MIN), holdDetail: { status: 429 } });
    expect(own).toEqual([pageHoldRow("network", at(2 * MIN), { since: at(-MIN), detail: { status: 429, legacyKind: "rate_limit" } })]);
    expect(holdSetOf(own).page.timed).toMatchObject({ kind: "network", until: at(2 * MIN) });
    const carried = imported({
      ...empty,
      holdKind: "auth",
      holdUntil: INDEFINITE_UNTIL,
      holdSince: at(-10 * MIN),
      holdDetail: { ...refusal, timedHold: { kind: "rate_limit", until: at(90_000).toISOString(), detail: { lastRateLimitAt: at(-2_000).toISOString() } } },
    });
    expect(carried).toEqual([
      pageHoldRow("auth", INDEFINITE_UNTIL, { since: at(-10 * MIN), detail: refusal }),
      pageHoldRow("network", at(90_000), { since: at(-2_000), detail: { lastRateLimitAt: at(-2_000).toISOString(), legacyKind: "rate_limit" } }),
    ]);
    // A carried hold that is not one (a malformed end, another kind) is none.
    const broken = imported({ ...empty, holdKind: "auth", holdUntil: INDEFINITE_UNTIL, holdDetail: { timedHold: { kind: "auth", until: "soon" } } });
    expect(broken.map((row) => row.kind)).toEqual(["auth"]);
    expect(broken[0]!.detail).toEqual({});
    // A slot whose end is not an instant holds indefinitely.
    const [endless] = imported({ ...empty, holdKind: "network", holdUntil: new Date("infinity") });
    expect(endless!.until).toEqual(INDEFINITE_UNTIL);
  });

  it("an older build's endpoint-group hold and an entry without an end are no breaker; the route state is read apart", () => {
    const rows = imported({
      ...empty,
      resourceHolds: {
        "dm-conversations": { until: at(MIN).toISOString(), step: 4, since: NOW.toISOString(), kind: "rate_limit_list" },
        "media-stats": { step: 1 },
        posts: "held",
        probe: { until: at(MIN).toISOString(), step: 2 },
        "route:state": { version: 1, routes: {} },
      },
    });
    expect(rows).toEqual([resourceBreakerRow("probe", at(MIN), { step: 2, since: NOW })]);
  });

  it("refuses a route state no build wrote, naming what it cannot read", () => {
    const entry = { holdUntil: null, ladderStep: 0, effectivePerMin: null, policyVersion: null, last429AttemptId: null, last429At: null, revision: 1 };
    for (const [routeState, diagnostic] of [
      [{ version: 2, routes: {} }, "route_state_version:2"],
      [{ routes: {} }, "route_state_version:undefined"],
      ["v1", "route_state_not_an_object"],
      [{ version: 1, routes: [] }, "route_state_routes"],
      [{ version: 1, routes: { polls: "held" } }, "route_state_entry:polls"],
      ...[
        { holdUntil: "soon" }, { effectivePerMin: 0 }, { effectivePerMin: -1 }, { ladderStep: -1 }, { revision: 1.5 }, { revision: 0 },
        { last429AttemptId: 0 }, { last429At: "then" }, { policyVersion: 3 },
      ].map((bad) => [{ version: 1, routes: { polls: { ...entry, ...bad } } }, "route_state_entry:polls"] as const),
    ] as const) {
      const read = () => holdRowsOfLegacyColumns(7, { ...empty, resourceHolds: { "route:state": routeState } });
      expect(read, diagnostic).toThrow(SyncLegacyHoldsUnreadableError);
      expect(read, diagnostic).toThrow(new RegExp(`page 7: .*\\(${diagnostic.replace(".", "\\.")}\\)`));
    }
    expect(holdRowsOfLegacyColumns(7, { ...empty, resourceHolds: { "route:state": null } })).toEqual([]);
  });
});

describe("the old columns have one reader and one writer", () => {
  const sources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return entry.name === "node_modules" || entry.name === "dist" ? [] : sources(path);
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });

  it("no source but the dual-write file names a hold column of the page row, or its route-state key", () => {
    const named = [...sources("apps/runtime/src"), ...sources("packages/db/src"), ...sources("packages/shared/src"), ...sources("packages/contracts/src")]
      .filter((path) => /\b(hold_kind|hold_until|hold_since|hold_detail|hold_step|resource_holds)\b|route:state/.test(readFileSync(path, "utf8")));
    // The drizzle mirror of the table keeps the columns it still has. (The
    // calibration report reads the hold set: tests/sync-route-holds.test.ts.)
    expect(named.sort()).toEqual(["packages/db/src/repositories/sync/holds-legacy.ts", "packages/db/src/schema.ts"]);
    // The page-wide 429 ladder step no build has stepped since a 429 holds its
    // route: the drizzle table no longer maps the column.
    expect(readFileSync("packages/db/src/schema.ts", "utf8")).not.toMatch(/smallint\("hold_step"\)/);
  });
});
