import { describe, expect, it } from "vitest";

import { FanslyApiError } from "@agency_hub_core/fansly";

import { FanslyPurchaseHistoryContractError } from "../apps/runtime/src/services/sync/errors.ts";
import {
  assertFanslyPurchaseHistoryTargetKindsConsistent,
  classifyFanslyPurchaseHistoryCapture,
  classifyFanslyPurchaseHistoryCaptures,
  classifyFanslyPurchaseHistoryProbe,
  deriveFanslyPurchaseHistoryRejectionStreaks,
  extractFanslyPurchaseHistoryTargetsFromTransactions,
  fanslyPurchaseHistoryTargetRejection,
  parseFanslyPurchaseHistoryCursorState,
  rejectedFanslyPurchaseHistoryPayload,
} from "../apps/runtime/src/services/sync/fansly-purchase-history.ts";

describe("Fansly purchase-history transaction discovery", () => {
  it("maps current and legacy media transaction types to the correct target kind", () => {
    expect(extractFanslyPurchaseHistoryTargetsFromTransactions([
      { rawType: 2010, correlationId: "legacy-media" },
      { rawType: "2110", correlationId: "media" },
      { rawType: 2016, correlationId: "legacy-bundle" },
      { rawType: "2116", correlationId: "bundle" },
      { rawType: 15001, correlationId: "subscription-history" },
      { rawType: 2110, correlationId: null },
      { rawType: 2110, correlationId: "  " },
    ])).toEqual([
      { kind: "single", contentId: "legacy-media" },
      { kind: "single", contentId: "media" },
      { kind: "bundle", contentId: "legacy-bundle" },
      { kind: "bundle", contentId: "bundle" },
    ]);
  });

  it("deduplicates repeat sales of the same content without changing first-seen order", () => {
    expect(extractFanslyPurchaseHistoryTargetsFromTransactions([
      { rawType: 2110, correlationId: "media-2" },
      { rawType: 2110, correlationId: "media-1" },
      { rawType: 2110, correlationId: "media-2" },
      { rawType: 2016, correlationId: "bundle-1" },
      { rawType: 2116, correlationId: "bundle-1" },
    ])).toEqual([
      { kind: "single", contentId: "media-2" },
      { kind: "single", contentId: "media-1" },
      { kind: "bundle", contentId: "bundle-1" },
    ]);
  });

  it("fails closed when one content id appears in both media namespaces", () => {
    expect(() => extractFanslyPurchaseHistoryTargetsFromTransactions([
      { rawType: 2110, correlationId: "ambiguous-content" },
      { rawType: 2116, correlationId: "ambiguous-content" },
    ])).toThrow(expect.objectContaining({
      name: "FanslyPurchaseHistoryContractError",
      code: "purchase_history_target_kind_conflict",
    }));

    try {
      extractFanslyPurchaseHistoryTargetsFromTransactions([
        { rawType: 2110, correlationId: "ambiguous-content" },
        { rawType: 2116, correlationId: "ambiguous-content" },
      ]);
    } catch (error) {
      expect(error).toBeInstanceOf(FanslyPurchaseHistoryContractError);
    }
  });

  it("fails closed when conflicting kinds arrive across batches or sources", () => {
    expect(() => assertFanslyPurchaseHistoryTargetKindsConsistent(
      [{ kind: "bundle", contentId: "cross-batch-content" }],
      new Set(["single:cross-batch-content"]),
    )).toThrow(expect.objectContaining({
      name: "FanslyPurchaseHistoryContractError",
      code: "purchase_history_target_kind_conflict",
    }));

    expect(() => assertFanslyPurchaseHistoryTargetKindsConsistent(
      [{ kind: "bundle", contentId: "conflicting-captured-content" }],
      new Set([
        "single:conflicting-captured-content",
      ]),
    )).toThrow(expect.objectContaining({
      code: "purchase_history_target_kind_conflict",
    }));
  });
});

describe("Fansly purchase-history cursor v5", () => {
  const now = new Date("2026-08-23T00:00:00.000Z");

  it("migrates a valid v2 cursor without losing raw progress or pending targets", () => {
    expect(parseFanslyPurchaseHistoryCursorState({
      version: 2,
      rawPayloadCursorId: 987,
      pendingTargets: [{ kind: "bundle", contentId: "bundle-9" }],
    }, now)).toEqual({
      version: 5,
      transactionCursorId: 0,
      rawPayloadCursorId: 987,
      pendingTargets: [{ kind: "bundle", contentId: "bundle-9", before: null }],
      utcDay: "2026-08-23",
      callsToday: 0,
    });
  });

  it("round-trips a valid v3 cursor", () => {
    expect(parseFanslyPurchaseHistoryCursorState({
      version: 3,
      transactionCursorId: 456,
      rawPayloadCursorId: 987,
      pendingTargets: [{ kind: "single", contentId: "media-9" }],
    }, now)).toEqual({
      version: 5,
      transactionCursorId: 456,
      rawPayloadCursorId: 987,
      pendingTargets: [{ kind: "single", contentId: "media-9", before: null }],
      utcDay: "2026-08-23",
      callsToday: 0,
    });
  });

  it("round-trips a valid v4 per-target cursor", () => {
    expect(parseFanslyPurchaseHistoryCursorState({
      version: 4,
      transactionCursorId: 456,
      rawPayloadCursorId: 987,
      pendingTargets: [{ kind: "single", contentId: "media-9", before: "order-100" }],
    }, now)).toEqual({
      version: 5,
      transactionCursorId: 456,
      rawPayloadCursorId: 987,
      pendingTargets: [{ kind: "single", contentId: "media-9", before: "order-100" }],
      utcDay: "2026-08-23",
      callsToday: 0,
    });
  });

  it("keeps a retry mark on a pending target and nothing else from the storm", () => {
    const v5 = {
      version: 5,
      transactionCursorId: 1,
      rawPayloadCursorId: 2,
      pendingTargets: [
        { kind: "single", contentId: "media-9", before: null, retry: true },
        { kind: "single", contentId: "media-8", before: null, retry: "yes" },
        { kind: "bundle", contentId: "bundle-1", before: "order-3" },
      ],
      utcDay: "2026-08-23",
      callsToday: 4,
      // A cursor written by the first cut of Decision 358; the streak is
      // derived from captures now and the field is simply ignored.
      rejectionStreak: 2,
    };
    expect(parseFanslyPurchaseHistoryCursorState(v5, now)).toEqual({
      version: 5,
      transactionCursorId: 1,
      rawPayloadCursorId: 2,
      pendingTargets: [
        { kind: "single", contentId: "media-9", before: null, retry: true },
        { kind: "single", contentId: "media-8", before: null },
        { kind: "bundle", contentId: "bundle-1", before: "order-3" },
      ],
      utcDay: "2026-08-23",
      callsToday: 4,
    });
  });

  it.each([
    { version: 3, transactionCursorId: -1, rawPayloadCursorId: 1, pendingTargets: [] },
    { version: 3, rawPayloadCursorId: 1, pendingTargets: [] },
    { version: 3, transactionCursorId: 1, rawPayloadCursorId: -1, pendingTargets: [] },
    {
      version: 4,
      transactionCursorId: 1,
      rawPayloadCursorId: 1,
      pendingTargets: [{ kind: "single", contentId: "media", before: "" }],
    },
    {
      version: 4,
      transactionCursorId: 1,
      rawPayloadCursorId: 1,
      pendingTargets: [
        { kind: "single", contentId: "media", before: null },
        { kind: "single", contentId: "media", before: "order-1" },
      ],
    },
  ])("rejects an invalid cursor %#", (state) => {
    expect(parseFanslyPurchaseHistoryCursorState(state)).toBeNull();
  });
});

describe("Fansly purchase-history page classification", () => {
  const capture = (
    responsePayload: unknown,
    requestBefore: string | null = null,
  ) => classifyFanslyPurchaseHistoryCapture({
    id: 1,
    targetKey: "single:media-1",
    requestBefore,
    statusCode: null,
    responsePayload,
  });

  it("treats only an empty successful page as terminal", () => {
    expect(capture({ accountMediaOrderHistory: [] })).toMatchObject({
      outcome: "terminal_empty",
      terminal: true,
      blocked: false,
      orderRows: 0,
    });
    expect(capture({
      accountMediaOrderHistory: [{ orderId: "order-1" }],
    })).toMatchObject({
      outcome: "continuation",
      terminal: false,
      nextBefore: "order-1",
      orderRows: 1,
    });
  });

  it("continues a full page when its last row has an order cursor", () => {
    expect(capture({
      accountMediaOrderHistory: Array.from(
        { length: 100 },
        (_, index) => ({ orderId: `order-${index + 1}` }),
      ),
    })).toMatchObject({
      outcome: "continuation",
      nextBefore: "order-100",
      orderRows: 100,
      blocked: false,
    });
  });

  it("consumes a 422 as a target-local rejection and keeps every other 4xx a durable block", () => {
    const rejected = (statusCode: number) => classifyFanslyPurchaseHistoryCapture({
      id: 1,
      targetKey: "single:media-1",
      requestBefore: null,
      statusCode,
      responsePayload: { error: { status: statusCode, code: 99 } },
    });
    // Fansly's "I understood the request but cannot serve THIS media" —
    // production ari-1 2026-09-02: {"code":99,"details":"error getting account
    // media"} for a media the account no longer holds.
    expect(rejected(422)).toMatchObject({
      outcome: "terminal_rejected",
      terminal: true,
      blocked: false,
      validatedPage: true,
      orderRows: 0,
    });
    expect(rejected(404)).toMatchObject({ outcome: "terminal_missing", terminal: true });
    // The same code 99 under HTTP 400 is the parameter-drift shape: a fact
    // about the request contract, never about one target.
    expect(rejected(400)).toMatchObject({ outcome: "http_rejected", blocked: true });
    expect(rejected(409)).toMatchObject({ outcome: "http_rejected", blocked: true });
    expect(rejected(403)).toMatchObject({ outcome: "http_rejected", blocked: true });

    // A rejected target is a complete chain, exactly like a deleted one: it is
    // never asked for again unless the classifier is deliberately changed.
    const index = classifyFanslyPurchaseHistoryCaptures([{
      id: 7,
      targetKey: "single:media-1",
      requestBefore: null,
      statusCode: 422,
      responsePayload: { error: { status: 422, code: 99 } },
    }]);
    expect(index.validatedCompleteTargetKeys).toEqual(["single:media-1"]);
    expect(index.blocked).toEqual([]);
    expect(index.resumableTargets).toEqual([]);
    // ...but it was never SERVED, so it is no witness for the request contract;
    // a chain the provider actually answered is.
    expect(index.chains).toEqual([expect.objectContaining({
      status: "complete",
      served: false,
      lastServedCaptureId: null,
      rejectionsAtLastCursor: 1,
      lastCaptureId: 7,
      lastStatusCode: 422,
      lastRequestBefore: null,
    })]);
    const servedIndex = classifyFanslyPurchaseHistoryCaptures([{
      id: 8,
      targetKey: "single:media-2",
      requestBefore: null,
      statusCode: null,
      responsePayload: { accountMediaOrderHistory: [] },
    }]);
    expect(servedIndex.chains).toEqual([expect.objectContaining({
      status: "complete",
      served: true,
      lastServedCaptureId: 8,
      rejectionsAtLastCursor: 0,
      lastStatusCode: null,
    })]);
  });

  it("lets a later served answer supersede a rejection of the same question", () => {
    // A retried target (Decision 358) the repaired provider now serves: the
    // rejection and the rows are not a fork, the rows win.
    const index = classifyFanslyPurchaseHistoryCaptures([
      {
        id: 7,
        targetKey: "single:media-1",
        requestBefore: null,
        statusCode: 422,
        responsePayload: { error: { status: 422, code: 99 } },
      },
      {
        id: 9,
        targetKey: "single:media-1",
        requestBefore: null,
        statusCode: null,
        responsePayload: { accountMediaOrderHistory: [{ orderId: "order-1" }] },
      },
      {
        id: 10,
        targetKey: "single:media-1",
        requestBefore: "order-1",
        statusCode: null,
        responsePayload: { accountMediaOrderHistory: [] },
      },
    ]);
    expect(index.blocked).toEqual([]);
    expect(index.chains).toEqual([expect.objectContaining({
      status: "complete",
      served: true,
      orderRows: 1,
      rejectionsAtLastCursor: 0,
      lastCaptureId: 10,
      lastServedCaptureId: 10,
      lastStatusCode: null,
    })]);
  });

  it("derives each namespace's epoch from the captures: streak, proof attempt, storm record, owed retries", () => {
    const page = (
      id: number,
      targetKey: string,
      statusCode: number | null,
      requestBefore: string | null = null,
    ) => ({
      id,
      targetKey,
      requestBefore,
      statusCode,
      responsePayload: statusCode === null
        ? { accountMediaOrderHistory: [] }
        : { error: { status: statusCode, code: 99 } },
    });
    const probe = (id: number, targetKey: string, statusCode: number | null, malformed = false) =>
      classifyFanslyPurchaseHistoryProbe({
        id,
        targetKey,
        requestBefore: null,
        statusCode,
        responsePayload: statusCode === null
          ? (malformed ? { unexpected: [] } : { accountMediaOrderHistory: [] })
          : { error: {} },
      })!;
    const index = classifyFanslyPurchaseHistoryCaptures([
      page(1, "single:old-gone", 404),
      page(2, "single:served-1", null),
      page(3, "bundle:bundle-served", null),
      page(4, "single:a", 422),
      page(5, "bundle:bundle-gone", 404),
      page(6, "single:b", 422),
      page(7, "single:c", 422),
    ]);

    // No witness pages: three singles since served-1 (the old 404 sits behind
    // a served page and is history), one bundle since bundle-served.
    const bare = deriveFanslyPurchaseHistoryRejectionStreaks(index, []);
    expect(bare.single).toEqual({
      count: 3,
      statuses: [422],
      members: [
        { target: { kind: "single", contentId: "a" }, targetKey: "single:a", before: null, status: 422, lastCaptureId: 4 },
        { target: { kind: "single", contentId: "b" }, targetKey: "single:b", before: null, status: 422, lastCaptureId: 6 },
        { target: { kind: "single", contentId: "c" }, targetKey: "single:c", before: null, status: 422, lastCaptureId: 7 },
      ],
      probedWitnessKeys: [],
      votes: 0,
      votedWitnessKeys: [],
      stormVoted: false,
      stormDeclared: false,
      stormVerdictRunId: null,
      owedRetries: [],
    });
    expect(bare.bundle).toMatchObject({ count: 1, statuses: [404], votes: 0 });

    // A served witness after the streak closes the epoch durably.
    const proven = deriveFanslyPurchaseHistoryRejectionStreaks(index, [probe(8, "single:served-1", null)]);
    expect(proven.single).toMatchObject({ count: 0, members: [], probedWitnessKeys: [], votes: 0 });

    // A proof cut short resumes: the witness probed since the newest
    // rejection is remembered, a vote (same status) and a skip (other status)
    // are told apart, and a malformed "success" is a vote.
    const partial = deriveFanslyPurchaseHistoryRejectionStreaks(index, [
      probe(8, "single:w1", 422),
      probe(9, "single:w2", 404),
      probe(10, "single:w3", null, true),
    ]);
    expect(partial.single).toMatchObject({
      count: 3,
      probedWitnessKeys: ["single:w1", "single:w2", "single:w3"],
      votes: 2,
      votedWitnessKeys: ["single:w1", "single:w3"],
      stormVoted: true,
    });

    // The evidence target the owner's unblock bought, rejected: the proof
    // attempt restarts (nothing probed since it) but the storm record stays.
    const evidenceRejected = deriveFanslyPurchaseHistoryRejectionStreaks(
      classifyFanslyPurchaseHistoryCaptures([
        page(2, "single:served-1", null),
        page(4, "single:a", 422),
        page(6, "single:b", 422),
        page(7, "single:c", 422),
        page(11, "single:d", 422),
      ]),
      [probe(8, "single:w1", 422)],
    );
    expect(evidenceRejected.single).toMatchObject({
      count: 4,
      probedWitnessKeys: [],
      votes: 0,
      stormVoted: true,
      owedRetries: [],
    });

    // A served answer after a storm is a repair: the epoch's members still
    // rejected once at their cursor are owed a retry, at that cursor — and a
    // rejected continuation is a member too, retried where it was refused.
    const repaired = deriveFanslyPurchaseHistoryRejectionStreaks(
      classifyFanslyPurchaseHistoryCaptures([
        page(2, "single:served-1", null),
        page(3, "single:t", null),                     // page one served: rows → continuation
        page(4, "single:a", 422),
        page(6, "single:t", 422, "order-1"),           // the continuation refused
        page(7, "single:c", 422),
        page(12, "single:d", null),                    // the repair (evidence target served)
      ].map((capture) => capture.targetKey === "single:t" && capture.id === 3
        ? { ...capture, responsePayload: { accountMediaOrderHistory: [{ orderId: "order-1" }] } }
        : capture)),
      [probe(8, "single:w1", 422)],
    );
    expect(repaired.single).toMatchObject({
      count: 0,
      stormVoted: false,
      owedRetries: [
        { target: { kind: "single", contentId: "a" }, targetKey: "single:a", before: null },
        { target: { kind: "single", contentId: "t" }, targetKey: "single:t", before: "order-1" },
        { target: { kind: "single", contentId: "c" }, targetKey: "single:c", before: null },
      ],
    });

    // A retry served, or rejected a second time, is settled and owed nothing.
    const settled = deriveFanslyPurchaseHistoryRejectionStreaks(
      classifyFanslyPurchaseHistoryCaptures([
        page(2, "single:served-1", null),
        page(4, "single:a", 422),
        page(6, "single:b", 422),
        page(7, "single:c", 422),
        page(12, "single:d", null),
        page(13, "single:a", null),
        page(14, "single:b", 422),
      ]),
      [probe(8, "single:w1", 422)],
    );
    expect(settled.single).toMatchObject({
      count: 1,
      members: [expect.objectContaining({ targetKey: "single:b" })],
      owedRetries: [{ target: { kind: "single", contentId: "c" }, targetKey: "single:c", before: null }],
    });

    // A skipped witness (other status) alone is no storm, and no vote.
    const skippedOnly = deriveFanslyPurchaseHistoryRejectionStreaks(index, [probe(8, "single:w1", 404)]);
    expect(skippedOnly.single).toMatchObject({ votes: 0, stormVoted: false, probedWitnessKeys: ["single:w1"] });

    // The verdict is the lane's own record of a block. Voted but undeclared
    // is not declared; declared then rejected (the evidence target) is spent;
    // declared then served is closed.
    const voted = deriveFanslyPurchaseHistoryRejectionStreaks(index, [probe(8, "single:w1", 422)]);
    expect(voted.single).toMatchObject({ votes: 1, stormVoted: true, stormDeclared: false });
    const declared = deriveFanslyPurchaseHistoryRejectionStreaks(
      index,
      [probe(8, "single:w1", 422)],
      [{ id: 9, kind: "single", syncRunId: 77 }],
    );
    // The verdict names the run that declared it: that run's block record
    // (and no other) vouches for the storm.
    expect(declared.single).toMatchObject({ votes: 1, stormDeclared: true, stormVerdictRunId: 77 });
    expect(declared.bundle).toMatchObject({ stormDeclared: false, stormVerdictRunId: null });
    const spent = deriveFanslyPurchaseHistoryRejectionStreaks(
      classifyFanslyPurchaseHistoryCaptures([
        page(2, "single:served-1", null),
        page(4, "single:a", 422),
        page(6, "single:b", 422),
        page(7, "single:c", 422),
        page(11, "single:d", 422),
      ]),
      [probe(8, "single:w1", 422)],
      [{ id: 9, kind: "single", syncRunId: 77 }],
    );
    expect(spent.single).toMatchObject({
      count: 4,
      votes: 0,
      stormVoted: true,
      stormDeclared: false,
      stormVerdictRunId: null,
    });
  });

  it("reads a provider rejection into its durable payload, body verbatim", () => {
    const body = '{"success":false,"error":{"code":99,"details":"error getting account media"}}';
    const rejection = fanslyPurchaseHistoryTargetRejection(
      new FanslyApiError("Fansly request failed (422)", 422, 99, body),
    );
    expect(rejection).toEqual({ status: 422, code: 99, details: "error getting account media", body });
    expect(rejectedFanslyPurchaseHistoryPayload(rejection!)).toEqual({
      error: { status: 422, code: 99, details: "error getting account media", body },
    });
    // A body that is not the JSON envelope still travels verbatim; only the
    // parsed details are unknown.
    expect(fanslyPurchaseHistoryTargetRejection(
      new FanslyApiError("Fansly request failed (502)", 502, undefined, "<html>Bad Gateway</html>"),
    )).toEqual({ status: 502, code: null, details: null, body: "<html>Bad Gateway</html>" });
    expect(fanslyPurchaseHistoryTargetRejection(new FanslyApiError("media gone", 404)))
      .toEqual({ status: 404, code: null, details: null, body: null });
    // Not an HTTP answer at all: transport, proxy refusal, budget.
    expect(fanslyPurchaseHistoryTargetRejection(new FanslyApiError("no status"))).toBeNull();
    expect(fanslyPurchaseHistoryTargetRejection(new Error("socket hang up"))).toBeNull();
  });

  it("blocks non-empty pages with a missing or repeated cursor", () => {
    expect(capture({ accountMediaOrderHistory: [{ id: "order-1" }] })).toMatchObject({
      outcome: "cursor_missing",
      blocked: true,
    });
    expect(capture({
      accountMediaOrderHistory: [{ orderId: "order-1" }],
    }, "order-1")).toMatchObject({
      outcome: "cursor_repeated",
      blocked: true,
    });
  });

  it("reconstructs complete, resumable, and cyclic chains from raw pages", () => {
    const base = {
      targetKey: "single:media-1",
      statusCode: null,
    };
    const complete = classifyFanslyPurchaseHistoryCaptures([
      {
        ...base,
        id: 1,
        requestBefore: null,
        responsePayload: { accountMediaOrderHistory: [{ orderId: "order-1" }] },
      },
      {
        ...base,
        id: 2,
        requestBefore: "order-1",
        responsePayload: { accountMediaOrderHistory: [] },
      },
    ]);
    expect(complete.validatedCompleteTargetKeys).toEqual(["single:media-1"]);
    expect(complete.resumableTargets).toEqual([]);

    const resumable = classifyFanslyPurchaseHistoryCaptures([
      {
        ...base,
        id: 1,
        requestBefore: null,
        responsePayload: { accountMediaOrderHistory: [{ orderId: "order-1" }] },
      },
    ]);
    expect(resumable.resumableTargets).toEqual([{
      kind: "single",
      contentId: "media-1",
      before: "order-1",
    }]);

    const cyclic = classifyFanslyPurchaseHistoryCaptures([
      {
        ...base,
        id: 1,
        requestBefore: null,
        responsePayload: { accountMediaOrderHistory: [{ orderId: "order-1" }] },
      },
      {
        ...base,
        id: 2,
        requestBefore: "order-1",
        responsePayload: { accountMediaOrderHistory: [{ orderId: "order-2" }] },
      },
      {
        ...base,
        id: 3,
        requestBefore: "order-2",
        responsePayload: { accountMediaOrderHistory: [{ orderId: "order-1" }] },
      },
    ]);
    expect(cyclic.blocked[0]).toMatchObject({ outcome: "cursor_repeated" });
  });

  it("blocks forked capture history at the same request cursor", () => {
    const forked = classifyFanslyPurchaseHistoryCaptures([
      {
        id: 1,
        targetKey: "single:media-1",
        requestBefore: null,
        statusCode: null,
        responsePayload: { accountMediaOrderHistory: [{ orderId: "order-1" }] },
      },
      {
        id: 2,
        targetKey: "single:media-1",
        requestBefore: null,
        statusCode: null,
        responsePayload: { accountMediaOrderHistory: [{ orderId: "order-2" }] },
      },
    ]);

    expect(forked.validatedCompleteTargetKeys).toEqual([]);
    expect(forked.resumableTargets).toEqual([]);
    expect(forked.blocked).toHaveLength(1);
    expect(forked.blocked[0]).toMatchObject({
      requestBefore: null,
      outcome: "cursor_conflict",
      blocked: true,
    });
  });
});
