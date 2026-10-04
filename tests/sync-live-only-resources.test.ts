import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { NO_FANSLY_PAGE_HOLDS } from "@agency_hub_core/shared";

import { onOutcome, type OutcomeDecision, type PageErrorState } from "../apps/runtime/src/sync/engine/errors.ts";
import { requestJsonOf } from "../apps/runtime/src/sync/engine/commit.ts";
import {
  descriptionIdOfSubject,
  mediaDownloadHop,
  mediaDownloadOutcome,
  mediaDownloadSubject,
} from "../apps/runtime/src/sync/fansly/resources/media-download.ts";
import type { SyncWorkRow } from "@agency_hub_core/db";

import type { PlanContext } from "../apps/runtime/src/sync/engine/resource.ts";
import { parseRepairCursor } from "../apps/runtime/src/sync/fansly/resources/repair.ts";
import type { FanslyRoute } from "../apps/runtime/src/sync/fansly/routes.ts";
import { wsConnectModule, wsConnectOutcome, wsConnectPlan } from "../apps/runtime/src/sync/fansly/resources/ws-connect.ts";

// The live-only resources of step 3 (design S3-04), their pure halves: what
// `ws.connect` plans by the socket owner's state and what a handshake outcome
// does; what a CDN hop's final answer leaves for the describer; the repair's
// cursor; and the journal of the two routes that keep no request line (J7).

const NOW = new Date("2026-10-02T12:00:00.000Z");

const page: PageErrorState = {
  holds: NO_FANSLY_PAGE_HOLDS,
  networkFailureStreak: 2,
  resourceHolds: {},
  credentialsGeneration: "a".repeat(64),
};

function decide(
  errorClass: Parameters<typeof onOutcome>[0]["errorClass"],
  resource: string,
  httpStatus: number | null = null,
  route: FanslyRoute | null = null,
): OutcomeDecision {
  return onOutcome({
    errorClass,
    now: NOW,
    resource,
    subject: "",
    httpStatus,
    retryAfterMs: null,
    page,
    ...(route === null ? {} : { route: { route, entry: null, attemptId: 1, jitter: () => 0 } }),
    subjectState: { failureCount: 0, breakerUntil: null, blockedByVendorAt: null },
    subjectQueue: false,
    recentFailedSubjects: 5,
  });
}

describe("ws.connect", () => {
  it("asks for an Upgrade only when the owner holds the socket lock and has no socket", () => {
    expect(wsConnectPlan("owning", NOW)).toEqual({ kind: "request", request: { spec: "ws.upgrade", params: {} } });
    expect(wsConnectPlan("down", NOW)).toMatchObject({ kind: "request" });
    expect(wsConnectPlan("open", NOW)).toEqual({ kind: "done", reason: "socket_open" });
    expect(wsConnectPlan("connecting", NOW)).toEqual({ kind: "wait", reason: "dependency", until: new Date(NOW.getTime() + 5_000) });
    expect(wsConnectPlan("idle", NOW)).toMatchObject({ kind: "wait", reason: "dependency" });
    for (const state of ["blocked_generation", "stopped", null] as const) {
      expect(wsConnectPlan(state, NOW), String(state)).toEqual({ kind: "wait", reason: "dependency", until: new Date(NOW.getTime() + 60_000) });
    }
  });

  it("never asks for an Upgrade before the owner's reconnect ladder allows", () => {
    const later = new Date(NOW.getTime() + 7_000);
    for (const state of ["owning", "down"] as const) {
      expect(wsConnectPlan(state, NOW, later), state).toEqual({ kind: "wait", reason: "not_due", until: later });
      expect(wsConnectPlan(state, later, later), state).toMatchObject({ kind: "request" });
      expect(wsConnectPlan(state, NOW, new Date(NOW.getTime() - 1)), state).toMatchObject({ kind: "request" });
    }
    // Through the module, from the owner the plan context names.
    const ctx = { shadow: false, now: NOW, socket: { state: "down", connectNotBefore: later } } as unknown as PlanContext;
    return expect(wsConnectModule.plan({} as SyncWorkRow, ctx)).resolves.toEqual({ kind: "wait", reason: "not_due", until: later });
  });

  it("sends a failed handshake back to the socket's ladder: no streak, no breaker, no hold", () => {
    for (const errorClass of ["network", "subject_failure"] as const) {
      const base = decide(errorClass, "ws.connect", errorClass === "network" ? null : 400);
      const decided = wsConnectOutcome(base);
      expect(decided.work, errorClass).toEqual({ action: "close", closeReason: "failed_handshake" });
      expect(decided.networkFailureStreak, errorClass).toBeNull();
      expect(decided.subjectBreaker, errorClass).toBeNull();
      expect(decided.pageHold, errorClass).toEqual({ action: "keep" });
      expect(decided.resourceHold, errorClass).toEqual({ action: "keep" });
      expect(decided.alerts, errorClass).toEqual([]);
    }
    // The third network failure of a page would hold it: not for a handshake.
    expect(decide("network", "ws.connect").pageHold).toMatchObject({ action: "set", kind: "network" });
  });

  it("keeps the holds: 401/403 the page's auth, a 429 the Upgrade route's with its incident — never the ladder", () => {
    const auth = wsConnectOutcome(decide("auth", "ws.connect", 401));
    expect(auth.pageHold).toMatchObject({ action: "set", kind: "auth" });
    expect(auth.work).toMatchObject({ action: "reopen", waitingReason: "page_hold" });
    const limited = wsConnectOutcome(decide("rate_limit", "ws.connect", 429, "ws.upgrade"));
    expect(limited.pageHold).toEqual({ action: "keep" });
    expect(limited.routeHold).toMatchObject({ action: "set", route: "ws.upgrade" });
    expect(limited.alerts).toEqual([{ subKey: "route_limited", detail: "rate_limit", route: "ws.upgrade" }]);
    // Open, not closed `failed_handshake`: the route admission keeps it out until the route opens.
    expect(limited.work).toEqual({ action: "reopen", dueAt: null, waitingReason: null, waitingUntil: null });
    expect(wsConnectOutcome(decide("ok", "ws.connect", 101)).work).toEqual({ action: "apply" });
  });
});

describe("media-download.fetch", () => {
  it("names its subject by the describer's row", () => {
    expect(mediaDownloadSubject(42)).toBe("desc:42");
    expect(descriptionIdOfSubject("desc:42")).toBe(42);
    for (const subject of ["desc:", "desc:0", "desc:x", "media-1", ""]) expect(descriptionIdOfSubject(subject), subject).toBeNull();
    expect(mediaDownloadHop({ hop: 2 })).toBe(2);
    expect(mediaDownloadHop({})).toBe(0);
    expect(mediaDownloadHop({ hop: -1 })).toBe(0);
  });

  it("closes on the signed URL's 401/403 with the describer's failure, holding nothing", () => {
    const decided = mediaDownloadOutcome(decide("subject_terminal", "media-download.fetch", 403), {
      request: { spec: "cdn.media", params: { hop: 0 } },
      httpStatus: 403,
      outcome: "response",
    });
    expect(decided.work).toEqual({ action: "close", closeReason: "subject_terminal:403", result: { failure: "http_status", httpStatus: 403 } });
    expect(decided.pageHold).toEqual({ action: "keep" });
  });

  it("ends the download on a transport failure without feeding the page's network streak", () => {
    const step = { request: { spec: "cdn.media" as const, params: { hop: 1 } }, httpStatus: null };
    const timedOut = mediaDownloadOutcome(decide("network", "media-download.fetch"), { ...step, outcome: "timeout" });
    expect(timedOut.work).toEqual({ action: "close", closeReason: "download_failed", result: { failure: "timeout", httpStatus: null } });
    expect(timedOut.networkFailureStreak).toBeNull();
    expect(timedOut.pageHold).toEqual({ action: "keep" });
    expect(mediaDownloadOutcome(decide("network", "media-download.fetch"), { ...step, outcome: "transport_error" }).work)
      .toMatchObject({ result: { failure: "transport" } });
    // A 429 holds the CDN route (owner decision №22), never the page.
    const limited = mediaDownloadOutcome(decide("rate_limit", "media-download.fetch", 429, "cdn.media"), { ...step, httpStatus: 429, outcome: "response" });
    expect(limited.pageHold).toEqual({ action: "keep" });
    expect(limited.routeHold).toMatchObject({ action: "set", route: "cdn.media" });
  });
});

describe("the journal of the routes without a request line (J7)", () => {
  it("keeps a CDN hop's number and the digest of its path, never its URL", () => {
    const json = requestJsonOf({ spec: "cdn.media", params: { hop: 1 } }, { url: "https://cdn3.fansly.com/abc/file.jpg?ngsw-bypass=true&Signature=SECRET" });
    expect(json).toEqual({
      spec: "cdn.media",
      host: "cdn",
      params: { hop: 1 },
      hop: 1,
      pathSha256: createHash("sha256").update("/abc/file.jpg").digest("hex"),
    });
    expect(JSON.stringify(json)).not.toContain("SECRET");
    expect(JSON.stringify(json)).not.toContain("cdn3.fansly.com");
    expect(requestJsonOf({ spec: "ws.upgrade", params: {} })).toEqual({ spec: "ws.upgrade", host: "ws", params: {} });
    // The Upgrade carries the page's stored session: its digest is journaled.
    expect(requestJsonOf({ spec: "ws.upgrade", params: {} }, { url: "socket-owner:ws.upgrade", credentialsGeneration: "a".repeat(64) }))
      .toEqual({ spec: "ws.upgrade", host: "ws", params: {}, credentialsGeneration: "a".repeat(64) });
  });
});

describe("repair.ws-gap's cursor", () => {
  it("reads a pass under way and nothing else", () => {
    const pass = { since: "2026-10-02T11:00:00.000Z", targets: ["c1"], startedRevision: 3 };
    expect(parseRepairCursor({ phase: "list", pass, offset: 100, pageCount: 1, spawned: [{ resource: "dm-messages.head", subject: "g" }], waitStartedAt: null }))
      .toEqual({ phase: "list", pass, offset: 100, pageCount: 1, spawned: [{ resource: "dm-messages.head", subject: "g" }], waitStartedAt: null });
    expect(parseRepairCursor({})).toBeNull();
    expect(parseRepairCursor({ phase: "stamp", pass, offset: 0 })).toBeNull();
    expect(parseRepairCursor({ phase: "wait", pass: { ...pass, since: "never" }, offset: 0 })).toBeNull();
  });
});

describe("the works' secret parameters stay ciphertext (J7)", () => {
  const grep = (pattern: string): string[] => {
    try {
      const output = execFileSync("grep", ["-rlE", pattern, "--include=*.ts", "apps/runtime/src", "packages/db/src", "packages/fansly/src"], { encoding: "utf8" });
      return output.split("\n").filter((line) => line !== "").sort();
    } catch {
      return [];
    }
  };

  it("one function selects the column, and only the live page transport calls it", () => {
    expect(grep("select [^;]*secret_params")).toEqual(["packages/db/src/repositories/sync/work.ts"]);
    // The candidate exemption of an auth hold (S3-05) only asks whether a
    // work carries a secret; it never reads one.
    const selects = readFileSync("packages/db/src/repositories/sync/work.ts", "utf8").match(/select [^`]*?secret_params[^\n]*/g) ?? [];
    expect(selects.filter((line) => !line.includes("secret_params is not null")).map((line) => line.slice(0, 22))).toEqual([
      "select w.secret_params",
    ]);
    expect(selects).toHaveLength(2);
    expect(grep("readSyncWorkSecretParams\\(")).toEqual([
      "apps/runtime/src/sync/fansly/transport.ts",
      "packages/db/src/repositories/sync/work.ts",
    ]);
  });

  it("only the transport opens a secret; the box seals for the describer, a redirect's next hop and a candidate identity", () => {
    expect(grep("decryptSyncWorkSecret[<(]")).toEqual([
      "apps/runtime/src/sync/fansly/transport.ts",
      "apps/runtime/src/sync/requests/secret-params.ts",
    ]);
    expect(readFileSync("apps/runtime/src/sync/requests/secret-params.ts", "utf8").match(/decryptSyncWorkSecret[<(]/g)).toHaveLength(1);
    expect(grep("encryptSyncWorkSecret[<(]")).toEqual([
      "apps/runtime/src/services/ai-media-describe/engine-download.ts",
      "apps/runtime/src/services/sync-engine-account.ts",
      "apps/runtime/src/sync/requests/secret-params.ts",
    ]);
  });
});
