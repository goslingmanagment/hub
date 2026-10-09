import { describe, expect, it } from "vitest";

import { fanslyPublicWireSpec, readFanslyWireResponse, type FanslyWireOutcome } from "@agency_hub_core/fansly";

import {
  publicLookupIncidentSummary,
  publicLookupVerdict,
} from "../apps/runtime/src/sync/fansly/public-lookup.ts";

// Arena "vanished chat" R5: what one outcome of the public reader means. The
// reader on a real database is tests/sync-public-lookup.integration.test.ts.

const NOW = new Date("2026-10-09T12:00:00.000Z");
const ASKED = ["290458453288165376", "955637964849827840"];
const SPEC = fanslyPublicWireSpec("accounts.public_by_ids");

function response(status: number, body: unknown, headers: Record<string, string> = {}): FanslyWireOutcome {
  const bodyText = typeof body === "string" ? body : JSON.stringify(body);
  return { kind: "response", status, headers, bodyText, bodyBytes: bodyText.length, sendMark: "request_start" };
}

function verdict(outcome: FanslyWireOutcome) {
  const read = outcome.kind === "response" ? readFanslyWireResponse(SPEC, { ids: ASKED }, outcome) : null;
  return publicLookupVerdict(outcome, read, ASKED, NOW);
}

describe("publicLookupVerdict", () => {
  it("an answer: the asked accounts it returned, each once; an empty one finds nobody", () => {
    expect(verdict(response(200, { success: true, response: [{ id: ASKED[0] }, { id: ASKED[0] }] })))
      .toEqual({ kind: "answer", foundIds: [ASKED[0]] });
    expect(verdict(response(200, { success: true, response: [] }))).toEqual({ kind: "answer", foundIds: [] });
  });

  it("nothing sent is no failure", () => {
    expect(verdict({ kind: "aborted_before_send", refusal: "lease_inactive" })).toEqual({ kind: "unsent" });
  });

  it("every other outcome stops the reader, by its class, with a Retry-After kept", () => {
    expect(verdict(response(429, "", { "retry-after": "120" }))).toEqual({
      kind: "failure",
      failure: { reason: "rate_limited", httpStatus: 429, detail: "HTTP 429", retryNotBefore: new Date("2026-10-09T12:02:00.000Z") },
    });
    expect(verdict(response(401, { success: false, error: { code: 401, details: "no" } })))
      .toMatchObject({ failure: { reason: "auth_refused", httpStatus: 401, detail: "HTTP 401: no" } });
    expect(verdict(response(403, ""))).toMatchObject({ failure: { reason: "auth_refused", httpStatus: 403 } });
    expect(verdict(response(503, "", { "retry-after": "60" })))
      .toMatchObject({ failure: { reason: "off_contract", httpStatus: 503, retryNotBefore: new Date("2026-10-09T12:01:00.000Z") } });
    expect(verdict(response(200, "<html/>"))).toMatchObject({ failure: { reason: "off_contract", httpStatus: 200 } });
    expect(verdict(response(200, { success: true, response: [{ name: "no id" }] })))
      .toMatchObject({ failure: { reason: "off_contract", detail: "[0].id: account row without a non-empty id" } });
    expect(verdict(response(200, { success: true, response: [{ id: "1" }] })))
      .toMatchObject({ failure: { reason: "off_contract", detail: "the answer names 1 account(s) that were not asked for" } });
    expect(verdict({ kind: "transport_error", sent: true, message: "socket hang up" }))
      .toMatchObject({ failure: { reason: "network", httpStatus: null, detail: "transport_error after the request was sent: socket hang up" } });
    expect(verdict({ kind: "timeout", sent: false, message: "budget" }))
      .toMatchObject({ failure: { reason: "network", detail: "timeout before the request was sent: budget" } });
  });
});

describe("the owner's incident line", () => {
  it("names the reason, the status, the first batch and the Retry-After within the incident's 240 characters", () => {
    const line = publicLookupIncidentSummary({
      reason: "rate_limited",
      httpStatus: 429,
      firstBatch: true,
      retryNotBefore: new Date("2026-10-09T12:02:00.000Z"),
    });
    expect(line).toBe("Public account reader stopped: rate_limited (HTTP 429) on its FIRST batch: decide before resuming; "
      + "Retry-After 2026-10-09T12:02:00.000Z. No fan changed. Resume: sync public-lookup resume.");
    expect(line.length).toBeLessThanOrEqual(240);
    expect(publicLookupIncidentSummary({ reason: "indeterminate", httpStatus: null, firstBatch: false, retryNotBefore: null }))
      .toBe("Public account reader stopped: indeterminate. No fan changed. Resume: sync public-lookup resume.");
  });
});
