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
import { ROUTE_POLICY_HASH } from "../apps/runtime/src/sync/fansly/routes.ts";
import { SHADOW_FINGERPRINT_VERSION } from "../apps/runtime/src/sync/report/shadow-fingerprint.ts";
import { SHADOW_HARD_CHECKS, SHADOW_RED_LINES, SHADOW_VERDICT_CHECKS, type ShadowReportVerdict } from "../apps/runtime/src/sync/report/shadow-report.ts";
import { redLinesAuditEvent, SYNC_SWITCH_RED_LINES_AUDIT_EVENT } from "../apps/runtime/src/sync/switch/audit.ts";
import { judgeBuildIdentity, shadowReportCheck, type RedLinesAcceptance } from "../apps/runtime/src/sync/switch/preconditions.ts";
import { engineOwnerStopped } from "../apps/runtime/src/sync/switch/rollback.ts";

// The step-3 switch's pure rules (design step 3 §3.5 items 7, 10, 13): the
// build identity both sides must share (G13), the shadow report's verdict
// for the page (A3) of the build and route policy being switched to (step 3b
// ruling 12: its fingerprint; a verdict not accepted passes only on the
// owner's judgement of its red lines, never a hard check), when an engine
// owner counts as stopped for a rollback (J4), the legacy hydration
// conversion's idempotency key and boundary (A4), and what a wrapper row
// reads as (S2 §7.5). The database half of the preconditions runs in
// tests/sync-switch.integration.test.ts.

const NOW = new Date("2026-10-02T12:00:00.000Z");
const BUILD = "abc123";
/** What the switching build runs. */
const EXPECTED = { syncBuild: BUILD, policyHash: ROUTE_POLICY_HASH };

function fingerprint(overrides: Record<string, unknown> = {}) {
  return {
    version: SHADOW_FINGERPRINT_VERSION,
    build: { sync: BUILD, unproven: null, report: BUILD },
    policyHash: ROUTE_POLICY_HASH,
    registryHash: "f".repeat(64),
    setting: { effectiveMs: 2_500, windowMs: [2_500] },
    pages: [],
    ...overrides,
  };
}

function report(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    generatedAt: NOW.toISOString(),
    pages: [{ page: "lilly-1", mode: "shadow" }, { page: "ari-1", mode: "shadow" }],
    fingerprint: fingerprint(),
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

describe("the shadow report (A3: one report-wide verdict; step 3b ruling 12: its fingerprint)", () => {
  it("passes an accepted report of this build and route policy that lists the page in shadow and whose window ended within 24 h", () => {
    expect(shadowReportCheck(report(), "lilly-1", NOW, EXPECTED)).toEqual({
      check: {
        name: "shadow_report",
        ok: true,
        detail: `accepted; window ended 2026-10-02T11:00:00.000Z; build ${BUILD}, route policy ${ROUTE_POLICY_HASH.slice(0, 12)}, S 2500 ms in the window`,
      },
      redLines: null,
    });
  });

  it.each([
    ["no report", null, "no shadow report"],
    ["not JSON", "{", "not JSON"],
    ["not accepted", report({ verdict: { accepted: false } }), "not accepted"],
    ["page missing", report({ pages: [{ page: "ari-1", mode: "shadow" }] }), "does not list lilly-1"],
    ["page not shadow", report({ pages: [{ page: "lilly-1", mode: "off" }] }), "as off, not shadow"],
    ["no window", report({ window: null }), "has no window"],
    ["stale window", report({ window: { window: { start: "2026-09-30T10:00:00.000Z", end: "2026-09-30T11:00:00.000Z" } } }), "(> 24 h)"],
    // An accepted, fresh report of an older build: no fingerprint at all.
    ["a report without a fingerprint", report({ fingerprint: undefined }), "carries no fingerprint"],
    ["a fingerprint of another kind", report({ fingerprint: fingerprint({ version: 2 }) }), "carries no fingerprint"],
    ["a window no single build is proven for", report({ fingerprint: fingerprint({ build: { sync: null, unproven: "sync heartbeats of 2 builds (a, b)", report: BUILD } }) }),
      "proves no single sync build through its window (sync heartbeats of 2 builds (a, b))"],
    ["the hour of another build", report({ fingerprint: fingerprint({ build: { sync: "old999", unproven: null, report: "old999" } }) }),
      "the shadow window ran build old999, sync runs abc123"],
    ["the hour of another route policy", report({ fingerprint: fingerprint({ policyHash: "0".repeat(64) }) }),
      `ran route policy 000000000000, this build ${ROUTE_POLICY_HASH.slice(0, 12)}`],
  ])("refuses %s", (_name, text, detail) => {
    expect(shadowReportCheck(text, "lilly-1", NOW, EXPECTED)).toEqual({
      check: { name: "shadow_report", ok: false, detail: expect.stringContaining(detail) },
      redLines: null,
    });
  });

  it("refuses every report while the switching sync build is unknown", () => {
    expect(shadowReportCheck(report(), "lilly-1", NOW, { syncBuild: null, policyHash: ROUTE_POLICY_HASH }).check).toMatchObject({
      ok: false, detail: expect.stringContaining("sync runs an unknown build"),
    });
  });
});

describe("the owner's judgement of a report's red lines (step 3b ruling 12)", () => {
  /** A complete verdict: every check passes unless overridden. */
  function verdict(overrides: Partial<ShadowReportVerdict> = {}): ShadowReportVerdict {
    return {
      covered: true, a1: true, a2: true, a3: true, a4: true, budgets: true, walks: true, build: true, b5: true, b6: true, b7: true,
      accepted: false,
      ...overrides,
    };
  }
  /** The 03.10 13:28 report: four red lines, every hard check passed. */
  const RED = { a1: false, a2: false, a3: false, b6: false } as const;
  const REASON = "lilly-1 is live (A1 floor, A3, B6 its own); A2 post_replies: legacy reads the shared queue first";
  const accept = (checks: readonly string[], reason = REASON): RedLinesAcceptance => ({ checks, reason });
  const judge = (overrides: Partial<ShadowReportVerdict>, acceptance: RedLinesAcceptance | null) =>
    shadowReportCheck(report({ verdict: verdict(overrides) }), "lilly-1", NOW, EXPECTED, acceptance);

  it("splits the verdict: the hard checks are never the owner's, the frozen rules' red lines are", () => {
    // Every verdict check is one or the other (the record's type has every key).
    expect([...SHADOW_HARD_CHECKS, ...SHADOW_RED_LINES].sort()).toEqual(Object.keys(verdict()).filter((key) => key !== "accepted").sort());
    expect(SHADOW_HARD_CHECKS).toEqual(["covered", "a4", "budgets", "walks", "build"]);
    expect(SHADOW_RED_LINES).toEqual(["a1", "a2", "a3", "b5", "b6", "b7"]);
    expect(SHADOW_VERDICT_CHECKS).toMatchObject({ a4: "hard", b5: "red_line" });
  });

  it("without the owner's word, a report not accepted is refused, naming its failing checks and how the owner may accept them", () => {
    expect(judge(RED, null).check).toEqual({
      name: "shadow_report",
      ok: false,
      detail: "the shadow report's verdict is not accepted (a1 FAIL, a2 FAIL, a3 FAIL, b6 FAIL); the owner may accept its red lines with "
        + "evidence: --accept-red-lines a1,a2,a3,b6 --red-lines-reason \"<evidence>\" (step 3b ruling 12)",
    });
    // A failed hard check: no such offer.
    expect(judge({ ...RED, walks: false }, null).check.detail).toBe(
      "the shadow report's verdict is not accepted (walks FAIL, a1 FAIL, a2 FAIL, a3 FAIL, b6 FAIL)",
    );
  });

  it("passes a report whose every failing check is a red line the owner accepted, with every hard check passed", () => {
    const judged = judge(RED, accept(["a1", "a2", "a3", "b6"]));
    expect(judged.redLines).toEqual({
      checks: ["a1", "a2", "a3", "b6"],
      listedNotFailing: [],
      reason: REASON,
      window: { start: "2026-10-02T10:00:00.000Z", end: "2026-10-02T11:00:00.000Z" },
      generatedAt: NOW.toISOString(),
    });
    expect(judged.check).toEqual({
      name: "shadow_report",
      ok: true,
      detail: `not accepted; red lines a1, a2, a3, b6 accepted by the owner (step 3b ruling 12): "${REASON}"; `
        + "report window 2026-10-02T10:00:00.000Z … 2026-10-02T11:00:00.000Z; "
        + `window ended 2026-10-02T11:00:00.000Z; build ${BUILD}, route policy ${ROUTE_POLICY_HASH.slice(0, 12)}, S 2500 ms in the window`,
    });
    // A red line listed that this report does not fail is named, not audited as accepted.
    expect(judge({ a2: false }, accept(["a1", "a2"])).redLines).toMatchObject({ checks: ["a2"], listedNotFailing: ["a1"] });
    // A3 without a sampled frame is the verdict's own rule, no red line.
    expect(judge({ a2: false, a3: null }, accept(["a2"])).redLines).toMatchObject({ checks: ["a2"] });
  });

  it.each(SHADOW_HARD_CHECKS.map((key) => [key]))("refuses a failed hard check %s, whatever red lines the owner accepts", (key) => {
    const judged = judge({ ...RED, [key]: false }, accept(SHADOW_RED_LINES));
    expect(judged).toEqual({
      check: { name: "shadow_report", ok: false, detail: `the shadow report fails a hard check (${key} FAIL): never accepted, whatever the red lines` },
      redLines: null,
    });
    // Not judged is no pass either (part A did not run).
    expect(judge({ ...RED, [key]: null }, accept(SHADOW_RED_LINES)).check.detail).toContain(`(${key} not judged)`);
    // Nor can the owner list it.
    expect(judge({ ...RED, [key]: false }, accept([...SHADOW_RED_LINES, key])).check).toMatchObject({
      ok: false, detail: `${key}: a hard check of the shadow report, never accepted (red lines: a1, a2, a3, b5, b6, b7)`,
    });
  });

  it("refuses a failing red line the owner did not list", () => {
    expect(judge(RED, accept(["a1", "a3", "b6"])).check).toMatchObject({
      ok: false, detail: "the shadow report fails a2, which the owner did not accept (--accept-red-lines a1,a3,b6)",
    });
    expect(judge({ b5: false }, accept(["b6"])).redLines).toBeNull();
  });

  it.each([["an empty reason", ""], ["a blank reason", "  \n "]])("requires the owner's reason: refuses %s", (_name, reason) => {
    expect(judge(RED, accept(["a1", "a2", "a3", "b6"], reason))).toEqual({
      check: { name: "shadow_report", ok: false, detail: "accepting red lines needs the owner's reason (--red-lines-reason)" },
      redLines: null,
    });
    // On an accepted report too: the owner's word is checked before the report.
    expect(shadowReportCheck(report(), "lilly-1", NOW, EXPECTED, accept(["a1"], reason)).check.ok).toBe(false);
  });

  it("refuses an incomplete report (a part not run) and a name that is no check", () => {
    expect(judge({ b5: null, b6: null, b7: null, a1: false }, accept(SHADOW_RED_LINES)).check.detail).toBe(
      "the shadow report did not judge b5, b6, b7 (a part did not run): no red line of an incomplete report is accepted",
    );
    expect(judge(RED, accept(["a1", "a2", "a3", "b6", "toString"])).check.detail).toBe(
      "toString: no check of the shadow report (red lines: a1, a2, a3, b5, b6, b7)",
    );
    expect(judge({}, accept(["a1"])).check.detail).toBe("the shadow report's verdict is not accepted, yet it fails no check");
  });

  it("keeps every other check under the owner's word: the page in shadow, the window's age, the fingerprint", () => {
    const red = (overrides: Record<string, unknown>) => shadowReportCheck(
      report({ verdict: verdict(RED), ...overrides }), "lilly-1", NOW, EXPECTED, accept(["a1", "a2", "a3", "b6"]),
    );
    expect(red({ pages: [{ page: "lilly-1", mode: "live" }] }).check.detail).toBe("the shadow report lists lilly-1 as live, not shadow");
    expect(red({ pages: [{ page: "ari-1", mode: "shadow" }] }).check.detail).toBe("the shadow report does not list lilly-1");
    expect(red({ window: { window: { start: "2026-09-30T10:00:00.000Z", end: "2026-09-30T11:00:00.000Z" } } }).check.detail).toContain("(> 24 h)");
    expect(red({ fingerprint: fingerprint({ policyHash: "0".repeat(64) }) }).check).toMatchObject({ ok: false, detail: expect.stringContaining("ran route policy 000000000000") });
    expect(red({ fingerprint: fingerprint({ policyHash: "0".repeat(64) }) }).redLines).toBeNull();
  });

  it("an accepted report needs no red line: the owner's word changes nothing", () => {
    expect(shadowReportCheck(report(), "lilly-1", NOW, EXPECTED, accept(["a2"]))).toMatchObject({
      check: { ok: true, detail: expect.stringMatching(/^accepted \(no red line to accept\); window ended /) },
      redLines: null,
    });
  });

  it("is audited: the page, the report's window, the checks accepted, the reason and the actor", () => {
    const { redLines } = judge(RED, accept(["a1", "a2", "a3", "b6", "b7"]));
    expect(redLinesAuditEvent({ pageId: 7, page: "lilly-1", actor: "cli@mac pid 1", redLines: redLines! })).toEqual({
      platformAccountId: 7,
      source: "cli",
      eventType: SYNC_SWITCH_RED_LINES_AUDIT_EVENT,
      metadata: {
        pageId: 7,
        page: "lilly-1",
        actor: "cli@mac pid 1",
        checks: ["a1", "a2", "a3", "b6"],
        listedNotFailing: ["b7"],
        reason: REASON,
        reportWindow: { start: "2026-10-02T10:00:00.000Z", end: "2026-10-02T11:00:00.000Z" },
        reportGeneratedAt: NOW.toISOString(),
      },
    });
    expect(SYNC_SWITCH_RED_LINES_AUDIT_EVENT).toBe("admin.sync_switch_red_lines_accepted");
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
