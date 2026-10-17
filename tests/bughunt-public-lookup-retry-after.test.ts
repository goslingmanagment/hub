import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

import { fanslyPublicWireSpec, readFanslyWireResponse, type FanslyWireOutcome } from "@agency_hub_core/fansly";

import {
  publicLookupIncidentSummary,
  publicLookupVerdict,
} from "../apps/runtime/src/sync/fansly/public-lookup.ts";

// Bug hunt 2026-10-09 (public-lookup, PL-3): the public reader keeps a failed
// answer's Retry-After unclamped (`parseRetryAfterInstant`). A delta-seconds
// value past JS Date's range turns into an Invalid Date; the stop write
// (`stopFanslyPublicLookup`, `${retryNotBefore}::timestamptz`) then sends pg's
// "0NaN-NaN-…" literal, Postgres refuses it, `#settle` throws, the attempt stays
// pending and every later pass settles the same journaled answer the same way.

const NOW = new Date("2026-10-09T13:08:01.823Z");
const ASKED = ["290458453288165376", "298616862499938304"];
const SPEC = fanslyPublicWireSpec("accounts.public_by_ids");

function response(status: number, body: string, headers: Record<string, string>): FanslyWireOutcome {
  return { kind: "response", status, headers, bodyText: body, bodyBytes: body.length, sendMark: "request_start" };
}

describe("bughunt PL-3: an absurd Retry-After on a failed public lookup", () => {
  it("becomes an Invalid Date that the stop's SQL parameter and the incident line cannot carry", () => {
    const outcome = response(429, "", { "retry-after": "1e20" });
    const read = outcome.kind === "response" ? readFanslyWireResponse(SPEC, { ids: ASKED }, outcome) : null;
    const verdict = publicLookupVerdict(outcome, read, ASKED, NOW);
    expect(verdict.kind).toBe("failure");
    if (verdict.kind !== "failure") return;
    expect(verdict.failure.reason).toBe("rate_limited");
    const retryNotBefore = verdict.failure.retryNotBefore;
    expect(retryNotBefore).not.toBeNull();
    expect(Number.isNaN(retryNotBefore!.getTime())).toBe(true);

    // What node-postgres sends for `${retryNotBefore}::timestamptz` (packages/db stopFanslyPublicLookup).
    const require = createRequire(import.meta.url);
    const pgUtils = require("pg/lib/utils") as { prepareValue(value: unknown): unknown };
    expect(pgUtils.prepareValue(retryNotBefore)).toBe("0NaN-NaN-NaNTNaN:NaN:NaN.NaN+NaN:NaN");

    // The incident line of the same stop throws too.
    expect(() => publicLookupIncidentSummary({ reason: "rate_limited", httpStatus: 429, firstBatch: false, retryNotBefore }))
      .toThrow(RangeError);
  });

  it("a merely large one is kept to the letter: a year-long wait no lever can shorten", () => {
    const outcome = response(429, "", { "retry-after": String(365 * 24 * 3600) });
    const read = outcome.kind === "response" ? readFanslyWireResponse(SPEC, { ids: ASKED }, outcome) : null;
    const verdict = publicLookupVerdict(outcome, read, ASKED, NOW);
    expect(verdict).toMatchObject({ kind: "failure", failure: { retryNotBefore: new Date("2027-10-09T13:08:01.823Z") } });
  });
});
