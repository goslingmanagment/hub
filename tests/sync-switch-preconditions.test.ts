import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { HistoryRequestDocument } from "../apps/runtime/src/sync/requests/history.ts";
import {
  depthOfLegacyHydration,
  historyKeyOfLegacyHydration,
  mirrorLegacyHydrationState,
  uuidV5,
} from "../apps/runtime/src/sync/requests/legacy-hydration.ts";
import { wholeSeconds } from "../apps/runtime/src/sync/switch/context.ts";
import { judgeBuildIdentity, shadowReportCheck } from "../apps/runtime/src/sync/switch/preconditions.ts";
import { engineOwnerStopped } from "../apps/runtime/src/sync/switch/rollback.ts";

// The step-3 switch's pure rules (design step 3 §3.5 items 7, 10, 13): the
// build identity both sides must share (G13), the shadow report's verdict
// for the page (A3), when an engine owner counts as stopped for a rollback
// (J4), the legacy hydration conversion's idempotency key and boundary (A4),
// and what a wrapper row reads as (S2 §7.5). The database half of the
// preconditions runs in tests/sync-switch.integration.test.ts.

const NOW = new Date("2026-10-02T12:00:00.000Z");

function report(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    generatedAt: NOW.toISOString(),
    pages: [{ page: "lilly-1", mode: "shadow" }, { page: "ari-1", mode: "shadow" }],
    window: { window: { start: "2026-10-02T10:00:00.000Z", end: "2026-10-02T11:00:00.000Z" } },
    verdict: { accepted: true },
    ...overrides,
  });
}

describe("the build identity (G13)", () => {
  it("passes only for a fresh sync heartbeat that runs exactly this CLI's build", () => {
    expect(judgeBuildIdentity({ imageTag: "abc123", ageMs: 5_000 }, "abc123")).toMatchObject({ ok: true });
    expect(judgeBuildIdentity({ imageTag: "abc123", ageMs: 5_000 }, "def456")).toMatchObject({
      ok: false, detail: "sync runs abc123, this CLI def456",
    });
  });

  it.each([
    [null, "abc123"],
    ["abc123", null],
    ["unknown", "unknown"],
    ["", "abc123"],
    [null, null],
  ])("refuses an unknown identity (sync %s, CLI %s)", (imageTag, own) => {
    expect(judgeBuildIdentity({ imageTag, ageMs: 1_000 }, own)).toMatchObject({ ok: false, detail: expect.stringContaining("build identity unknown") });
  });

  it("refuses without a heartbeat or with a stale one", () => {
    expect(judgeBuildIdentity(null, "abc123")).toMatchObject({ ok: false, detail: expect.stringContaining("no sync heartbeat") });
    expect(judgeBuildIdentity({ imageTag: "abc123", ageMs: 91_000 }, "abc123")).toMatchObject({ ok: false, detail: "the sync heartbeat is 91 s old" });
  });

  it("is what every image reports: the release's source revision, also in the dist-only overlay", () => {
    expect(readFileSync("Dockerfile", "utf8")).toContain("ENV GIT_SHA=${APP_SOURCE_REVISION}");
    expect(readFileSync("scripts/deploy-production.sh", "utf8")).toContain("ENV GIT_SHA=\\${APP_SOURCE_REVISION}");
    expect(readFileSync("apps/runtime/src/services/runtime-heartbeat.ts", "utf8")).toContain("process.env.IMAGE_TAG ?? process.env.GIT_SHA");
    expect(readFileSync("apps/runtime/src/sync/cli/switch.ts", "utf8")).toContain("buildSha: () => process.env.GIT_SHA ?? null");
  });
});

describe("the shadow report (A3: one report-wide verdict)", () => {
  it("passes an accepted report that lists the page in shadow and whose window ended within 24 h", () => {
    expect(shadowReportCheck(report(), "lilly-1", NOW)).toMatchObject({ ok: true });
  });

  it.each([
    ["no report", null, "no shadow report"],
    ["not JSON", "{", "not JSON"],
    ["not accepted", report({ verdict: { accepted: false } }), "not accepted"],
    ["page missing", report({ pages: [{ page: "ari-1", mode: "shadow" }] }), "does not list lilly-1"],
    ["page not shadow", report({ pages: [{ page: "lilly-1", mode: "off" }] }), "as off, not shadow"],
    ["no window", report({ window: null }), "has no window"],
    ["stale window", report({ window: { window: { start: "2026-09-30T10:00:00.000Z", end: "2026-09-30T11:00:00.000Z" } } }), "(> 24 h)"],
  ])("refuses %s", (_name, text, detail) => {
    expect(shadowReportCheck(text, "lilly-1", NOW)).toMatchObject({ ok: false, detail: expect.stringContaining(detail) });
  });
});

describe("a stopped engine owner (rollback step 2, J4)", () => {
  const owner = {
    generation: 4n, instance: null, host: "sync-a", pid: 1, pidStart: null, pidNs: null, bootId: null,
    acquiredAt: new Date("2026-10-02T11:00:00Z"), heartbeatAt: new Date("2026-10-02T11:59:50Z"),
    releasedAt: null, releaseGeneration: null, stopConfirmedAt: null, stopConfirmedBy: null,
  };

  it("is its own safe release, a stop confirmation after its acquisition, or no owner ever", () => {
    expect(engineOwnerStopped({ owner: { ...owner, generation: 0n } })).toBe(true);
    expect(engineOwnerStopped({ owner: { ...owner, releasedAt: NOW, releaseGeneration: 4n } })).toBe(true);
    expect(engineOwnerStopped({ owner: { ...owner, stopConfirmedAt: new Date("2026-10-02T11:30:00Z") } })).toBe(true);
  });

  it("is never assumed: a heartbeat gone quiet, a release of an older generation, an older confirmation", () => {
    expect(engineOwnerStopped({ owner })).toBe(false);
    expect(engineOwnerStopped({ owner: { ...owner, releasedAt: NOW, releaseGeneration: 3n } })).toBe(false);
    expect(engineOwnerStopped({ owner: { ...owner, stopConfirmedAt: new Date("2026-10-02T10:00:00Z") } })).toBe(false);
  });
});

describe("the legacy hydration conversion", () => {
  it("files every legacy ref under one fixed name-based uuid (v5)", () => {
    // RFC 4122 appendix vector: the DNS namespace and "www.example.com".
    expect(uuidV5("www.example.com", "6ba7b810-9dad-11d1-80b4-00c04fd430c8")).toBe("2ed6657d-e927-568b-95e1-2665a8aea6a2");
    const key = historyKeyOfLegacyHydration("8f3c0b4e-6a1d-4c2e-9b7a-0d5e3f1a2b4c");
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(historyKeyOfLegacyHydration("8f3c0b4e-6a1d-4c2e-9b7a-0d5e3f1a2b4c")).toBe(key);
    expect(historyKeyOfLegacyHydration("8f3c0b4e-6a1d-4c2e-9b7a-0d5e3f1a2b4d")).not.toBe(key);
  });

  it("keeps the legacy boundary: exactly one of the message ref and the instant (A4)", () => {
    expect(depthOfLegacyHydration({ targetBeforeAt: null, targetBeforeMessageRef: "123" }))
      .toEqual({ kind: "before_boundary", messageRef: "123" });
    const at = new Date("2026-09-01T00:00:00Z");
    expect(depthOfLegacyHydration({ targetBeforeAt: at, targetBeforeMessageRef: null })).toEqual({ kind: "before_boundary", at });
  });

  function documentWith(state: string, item: Record<string, unknown> | null): HistoryRequestDocument {
    return {
      request: { state } as HistoryRequestDocument["request"],
      items: item === null ? [] : [{ historyState: "partial", satisfiedBy: null, ...item } as HistoryRequestDocument["items"][number]],
      nextAfterOrdinal: null,
    };
  }

  it.each([
    ["queued", "open", { state: "queued" }, "dispatching", "none"],
    ["loading", "open", { state: "loading" }, "dispatching", "none"],
    ["read to an empty page", "done", { state: "ready", satisfiedBy: "empty_page", historyState: "complete" }, "completed", "none"],
    ["already satisfied on a complete chat", "done", { state: "ready", satisfiedBy: "already_satisfied", historyState: "complete" }, "completed", "none"],
    ["already satisfied above a boundary", "done", { state: "ready", satisfiedBy: "already_satisfied" }, "partially_completed", "none"],
    ["read to the boundary", "done", { state: "ready", satisfiedBy: "boundary" }, "partially_completed", "none"],
    ["refused", "done", { state: "refused" }, "failed", "vendor_unavailable"],
    ["blocked by the vendor", "open", { state: "blocked" }, "failed", "quarantined"],
    ["cancelled fan", "done", { state: "cancelled" }, "expired", "none"],
  ])("reads %s as the legacy state", (_name, requestState, item, state, lastError) => {
    expect(mirrorLegacyHydrationState(documentWith(requestState, item))).toEqual({ state, lastError });
  });

  it("reads a cancelled request as expired", () => {
    expect(mirrorLegacyHydrationState(documentWith("cancelled", { state: "queued" }))).toEqual({ state: "expired", lastError: "none" });
  });
});

describe("operator lines", () => {
  it("round a wait up to whole seconds", () => {
    expect(wholeSeconds(300_000)).toBe(300);
    expect(wholeSeconds(1)).toBe(1);
  });
});
