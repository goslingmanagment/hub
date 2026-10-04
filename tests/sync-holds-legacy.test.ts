import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { legacyHoldColumnsOf, type SyncLegacyHoldColumns } from "@agency_hub_core/db";
import { INDEFINITE_UNTIL } from "@agency_hub_core/shared";

import { pageHoldRow, resourceBreakerRow, routeHoldRows } from "./helpers/sync-holds.ts";

// The old hold columns of the page row beside the hold set (step 4, S4-31):
// still written, no longer read. The image before this one compares them
// with what the rows make them when it acquires a page and lets the columns
// win, so every hold write rewrites them — this is what it writes, the pure
// half (tests/sync-hold-set.integration.test.ts runs it on a database). And
// the pins: nothing but that writer names them.

const NOW = new Date("2026-10-04T12:00:00.000Z");
const MIN = 60_000;
const at = (ms: number) => new Date(NOW.getTime() + ms);

const empty: SyncLegacyHoldColumns = { holdKind: null, holdUntil: null, holdSince: null, holdDetail: {}, resourceHolds: {} };
const refusal = { status: 401, credentialsGeneration: "gen-b", failedAttemptId: 7, failedAt: at(-MIN).toISOString() };
const backoff = { streak: 4, networkSince: at(-5 * MIN).toISOString() };

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

describe("the old columns have one writer and no reader", () => {
  const sources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return entry.name === "node_modules" || entry.name === "dist" ? [] : sources(path);
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
  const all = [...sources("apps/runtime/src"), ...sources("packages/db/src"), ...sources("packages/shared/src"), ...sources("packages/contracts/src")];

  it("no source but the mirror names a hold column of the page row, or its route-state key", () => {
    const named = all.filter((path) => /\b(hold_kind|hold_until|hold_since|hold_detail|resource_holds)\b|route:state/.test(readFileSync(path, "utf8")));
    // The drizzle mirror of the table keeps the columns it still has. (The
    // calibration report reads the hold set: tests/sync-route-holds.test.ts.)
    expect(named.sort()).toEqual(["packages/db/src/repositories/sync/holds-legacy.ts", "packages/db/src/schema.ts"]);
    // `hold_step` is gone (0241; tests/sync-engine-migrations.test.ts pins
    // that no source names it): the drizzle table does not map it.
    expect(readFileSync("packages/db/src/schema.ts", "utf8")).not.toMatch(/smallint\("hold_step"\)/);
  });

  it("the mirror writes them in one statement and selects none of them", () => {
    const mirror = readFileSync("packages/db/src/repositories/sync/holds-legacy.ts", "utf8");
    const code = mirror.split("\n").filter((line) => !/^\s*(\/\/|\/?\*)/.test(line)).join("\n");
    expect(code.match(/\b(select|insert into|update|delete from)\b/g)).toEqual(["update"]);
    expect(code).toMatch(/update sync_pages\s+set hold_kind = [^\n]+\n\s+hold_until = [^\n]+\n\s+hold_since = [^\n]+\n\s+hold_detail = [^\n]+\n\s+resource_holds = /);
    // What read them back is gone: the comparison, the import and its refusal.
    for (const path of all) {
      expect(readFileSync(path, "utf8"), path)
        .not.toMatch(/reconcileSyncHoldsWithLegacyColumns|holdRowsOfLegacyColumns|sameLegacyHoldColumns|SyncLegacyHoldsUnreadableError|holdsImported|sync_holds_imported/);
    }
  });
});
