import { createHash } from "node:crypto";
import type * as Crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ReplayObservationRow } from "@agency_hub_core/db";
import type { CanonicalEventDraft } from "../apps/runtime/src/services/canonicalize/types.ts";

const dbMocks = vi.hoisted(() => ({
  listPageNativeAccountRefs: vi.fn(),
  listHistoricalOfapiBindings: vi.fn(),
  listObservationsForReplay: vi.fn(),
  markObservationParsed: vi.fn(),
  appendDomainEvents: vi.fn(),
  appendMixedDomainEvents: vi.fn(),
  appendProjectionOnlyDomainEvents: vi.fn(),
  assertDomainEventTargetMonthsAttached: vi.fn(),
  loadDomainEventPartitionCoverage: vi.fn(),
  DomainEventTargetMonthsUnattachedError: class extends Error {},
  // Inline fixtures pass through the real payload seam without catalog reads.
  CapturePayloadCodecError: class extends Error {},
  canonicalizeCaptureJson: vi.fn(),
  capturePayloadRefFromColumns: vi.fn(),
  readEnvelopeCapturePayload: vi.fn(),
}));

vi.mock("@agency_hub_core/db", () => dbMocks);
vi.mock("node:crypto", async importOriginal => {
  const actual = await importOriginal<typeof Crypto>();
  return { ...actual, createHash: vi.fn((...args: Parameters<typeof actual.createHash>) => {
    const hash = actual.createHash(...args);
    vi.spyOn(hash, "update");
    return hash;
  }) };
});

const { runCanonicalization } = await import("../apps/runtime/src/services/canonicalize-driver.ts");
const { familyForObservation } = await import("../apps/runtime/src/services/canonicalize/index.ts");
const {
  canonicalizeFanslyEarningsObservation,
  canParseFanslyEarningsObservation,
  diagnoseFanslyEarningsRejection,
} = await import("../apps/runtime/src/services/canonicalize/fansly-earnings.ts");

const NOW = new Date("2026-09-12T12:00:00Z");
const VALID_ROW = { correlationAccountId: "fan-a", totalGross: 1000, totalNet: 800, type: 1 };
// Count real aggregate fingerprints, excluding the driver's cursor-scope hash.
const hashCalls = () => vi.mocked(createHash).mock.results.filter(result => result.type === "return"
  && vi.mocked(result.value.update).mock.calls.some(([value]) => typeof value === "string"
    && value.startsWith('{"grossMills":'))).length;

function observation(payload: unknown, kind = "fan_earnings_stats"): ReplayObservationRow {
  return {
    id: 19, source: "pull", producer: "sync:fansly", platform: "fansly",
    accountId: 7, nativeAccountRef: "known-page", kind, payload,
    observedAt: NOW, receivedAt: NOW, parseVersion: 0, payloadRef: null,
  };
}

function appStub() {
  return {
    db: {},
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as never;
}

async function run(rows: ReplayObservationRow[], dryRun = false) {
  const family = familyForObservation(rows[0]!);
  expect(family).toMatchObject({ lane: "earnings", version: 7, projectionOnly: true });
  dbMocks.listObservationsForReplay.mockResolvedValueOnce(rows).mockResolvedValueOnce([]);
  const diagnostics: string[] = [];
  const result = await runCanonicalization(appStub(), {
    families: [family!], now: NOW, dryRun,
    // One pass isolates parse work from the separate capture/replay budget law.
    maxPagesPerFamily: 1,
    diagnostics: { record: code => diagnostics.push(code) },
  });
  // Do not carry unused mocked responses into a second run in the same test.
  dbMocks.listObservationsForReplay.mockReset();
  return { result, diagnostics };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.listObservationsForReplay.mockReset();
  dbMocks.listPageNativeAccountRefs.mockResolvedValue([
    { id: 7, platform: "fansly", nativeAccountRef: "known-page", ofapiAccountId: null },
  ]);
  dbMocks.listHistoricalOfapiBindings.mockResolvedValue([]);
  dbMocks.loadDomainEventPartitionCoverage.mockResolvedValue({});
  dbMocks.markObservationParsed.mockResolvedValue(undefined);
  dbMocks.appendProjectionOnlyDomainEvents.mockImplementation(
    async (_db: unknown, _accountId: number, events: CanonicalEventDraft[]) => ({
      appended: events.length, deduped: 0,
    }),
  );
});

describe("earnings sweep parses each observation once", () => {
  it.each([
    { kind: "fan_earnings_stats", payload: [VALID_ROW], drafts: 1 },
    { kind: "fan_earnings_monthly", payload: [
      { ...VALID_ROW, year: 2026, month: 8 },
      { ...VALID_ROW, type: 2, year: 2026, month: 8 },
      { ...VALID_ROW, year: 2026, month: 9 },
    ], drafts: 2 },
  ])("hashes each $kind aggregate once and keeps the standalone output", async ({ kind, payload, drafts }) => {
    const row = observation(payload, kind);
    const expected = canonicalizeFanslyEarningsObservation(row);
    vi.mocked(createHash).mockClear();

    const { result } = await run([row]);

    expect(hashCalls()).toBe(drafts);
    expect(result).toMatchObject({ scanned: 1, stamped: 1, appended: drafts, errored: 0 });
    expect(dbMocks.appendProjectionOnlyDomainEvents).toHaveBeenCalledWith(
      expect.anything(), 7,
      expected.map(event => ({ ...event, observationId: row.id })),
      { occurredAt: NOW, observationId: row.id, dedupKey: `pull:v7:checkpoint:${row.id}` },
    );
    expect(dbMocks.markObservationParsed).toHaveBeenCalledWith(expect.anything(), {
      observationId: row.id, receivedAt: NOW, parseVersion: 7,
    });
    expect(dbMocks.appendDomainEvents).not.toHaveBeenCalled();
    expect(dbMocks.appendMixedDomainEvents).not.toHaveBeenCalled();
  });

  it("validates malformed money once and preserves the fixed-code rejection", async () => {
    let amountReads = 0;
    const row = observation([{
      ...VALID_ROW,
      get totalGross() { amountReads++; return "invalid"; },
    }]);

    const { result, diagnostics } = await run([row]);

    expect(amountReads).toBe(1);
    expect(hashCalls()).toBe(0);
    expect(result).toMatchObject({
      scanned: 1, stamped: 0, appended: 0, skippedUnparseable: 1, errored: 0,
      unparseableSamples: [{
        observationId: row.id, family: "pull:earnings", kind: row.kind,
        reasonCode: "invalid_earnings_money",
      }],
    });
    expect(diagnostics).toEqual(["canonicalize_rejected:earnings:invalid_earnings_money"]);
    expect(dbMocks.markObservationParsed).not.toHaveBeenCalled();
  });

  it.each([
    { payload: {}, reason: "unsupported_earnings_shape" },
    { payload: [null], reason: "invalid_earnings_row" },
    { payload: [{ totalGross: 1, totalNet: 1 }], reason: "missing_earnings_fan" },
    { payload: [{ ...VALID_ROW, totalNet: null }], reason: "invalid_earnings_money" },
    { payload: [{ ...VALID_ROW, totalGross: 0.5 }], reason: "invalid_earnings_money" },
    { payload: [{ ...VALID_ROW, totalGross: Number.MAX_SAFE_INTEGER }, VALID_ROW], reason: "invalid_earnings_money" },
    { payload: [{ ...VALID_ROW, year: 2026, month: 13 }], kind: "fan_earnings_monthly", reason: "invalid_earnings_window" },
    // A sound fan cannot make the OTHER malformed fan's observation consumable.
    { payload: [VALID_ROW, { ...VALID_ROW, correlationAccountId: "fan-b", totalNet: "bad" }], reason: "invalid_earnings_money" },
    // Nor may the sound portion of one fan/window become a partial snapshot.
    { payload: [VALID_ROW, { ...VALID_ROW, totalNet: "bad" }], reason: "invalid_earnings_money" },
  ])("preserves whole-observation refusal: $reason ($payload)", async ({ payload, kind, reason }) => {
    const row = observation(payload, kind);
    expect(canParseFanslyEarningsObservation(row)).toBe(false);
    expect(diagnoseFanslyEarningsRejection(row)).toEqual({ code: reason });

    const { result } = await run([row]);

    expect(result).toMatchObject({ stamped: 0, appended: 0, skippedUnparseable: 1, errored: 0 });
    expect(result.unparseableSamples[0]?.reasonCode).toBe(reason);
    expect(dbMocks.appendProjectionOnlyDomainEvents).not.toHaveBeenCalled();
    expect(dbMocks.markObservationParsed).not.toHaveBeenCalled();
  });

  it.each([
    { payload: [], drafts: 0 },
    { payload: [{ ...VALID_ROW, totalGross: 0, totalNet: 0 }], drafts: 1 },
  ])("preserves valid empty/zero consumption ($drafts drafts)", async ({ payload, drafts }) => {
    const { result } = await run([observation(payload)]);
    expect(hashCalls()).toBe(drafts);
    expect(result).toMatchObject({ stamped: 1, appended: drafts, skippedUnparseable: 0 });
    if (drafts === 0) expect(dbMocks.appendProjectionOnlyDomainEvents).not.toHaveBeenCalled();
    else expect(dbMocks.appendProjectionOnlyDomainEvents.mock.calls[0]![2][0].data)
      .toMatchObject({ grossMills: 0, netMills: 0 });
  });

  it("keeps unmapped captures replayable and reparses after binding repair", async () => {
    const row = { ...observation([VALID_ROW]), accountId: null, nativeAccountRef: "unbound-page" };
    for (let index = 0; index < 2; index++) {
      expect((await run([row])).result).toMatchObject({ stamped: 0, appended: 0, skippedUnmapped: 1 });
    }
    expect(hashCalls()).toBe(2);
    expect(dbMocks.markObservationParsed).not.toHaveBeenCalled();
    dbMocks.listPageNativeAccountRefs.mockResolvedValue([
      { id: 7, platform: "fansly", nativeAccountRef: "unbound-page", ofapiAccountId: null },
    ]);

    expect((await run([row])).result).toMatchObject({ stamped: 1, appended: 1, skippedUnmapped: 0 });
    expect(hashCalls()).toBe(3);
  });

  it("does not append or stamp during dry-run", async () => {
    expect((await run([observation([VALID_ROW])], true)).result)
      .toMatchObject({ stamped: 0, appended: 1, errored: 0 });
    expect(hashCalls()).toBe(1);
    expect(dbMocks.appendProjectionOnlyDomainEvents).not.toHaveBeenCalled();
    expect(dbMocks.markObservationParsed).not.toHaveBeenCalled();
  });

  it("keeps refusal samples bounded while reporting every rejected observation", async () => {
    const rows = Array.from({ length: 25 }, (_, index) => ({ ...observation([null]), id: index + 1 }));
    const { result, diagnostics } = await run(rows);
    expect(result).toMatchObject({ scanned: 25, skippedUnparseable: 25, stamped: 0, errored: 0 });
    expect(result.unparseableSamples).toHaveLength(20);
    expect(diagnostics).toHaveLength(25);
    expect(dbMocks.markObservationParsed).not.toHaveBeenCalled();
  });
});
