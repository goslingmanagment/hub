import { describe, expect, it } from "vitest";

import { ofapiProviderOperationReuseIssue } from "@agency_hub_core/db";

const ACCOUNT = "acct_01000000000000000000000000000000";

describe("provider operation reuse predicate shared by intake and dispatch (review #138 fix 4)", () => {
  const now = new Date("2026-09-07T12:00:00Z");
  const parent = { operation_id: "op", provider_key: "key", team_slug: "team", account_id: ACCOUNT, endpoint: "/e", body_hash: "h", first_attempt_at: new Date("2026-09-07T00:00:00Z") };
  const input = { teamSlug: "team", accountId: ACCOUNT, endpoint: "/e", bodyHash: "h", now };
  it("accepts an unchanged replay inside the window", () => {
    expect(ofapiProviderOperationReuseIssue(parent, input)).toBeNull();
  });
  it.each([
    ["parent_operation_missing", undefined, input],
    ["team_changed", parent, { ...input, teamSlug: "other" }],
    ["team_changed", parent, { ...input, teamSlug: null }],
    ["account_changed", parent, { ...input, accountId: "acct_other" }],
    ["endpoint_changed", parent, { ...input, endpoint: "/other" }],
    ["body_changed", parent, { ...input, bodyHash: "edited" }],
    ["window_expired", parent, { ...input, now: new Date("2026-09-08T00:00:00Z") }],
    ["window_expired", parent, { ...input, now: new Date("2026-09-06T23:59:59Z") }],
  ] as const)("refuses with %s", (issue, source, candidate) => {
    expect(ofapiProviderOperationReuseIssue(source, candidate)).toBe(issue);
  });
});
