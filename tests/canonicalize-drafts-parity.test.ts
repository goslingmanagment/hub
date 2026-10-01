// The canonicalization seam (Fansly Sync Engine design §3.11, S2-05).
//
// `runFamily` used to build its drafts inline. The pure half — shape gate →
// drafts → occurred_at clamp (+ the family's quarantine verdict) — is now
// `buildCanonicalDrafts`, which the engine's in-transaction helper calls too.
// These pins prove, for a fixture of EVERY family (OnlyFans included):
//   1. the driver appends exactly the drafts the seam builds, through the same
//      appender, checkpoint and stamp as before — on its own pool handle, one
//      statement after another, never inside a caller's transaction;
//   2. the one-call form the engine uses (gate inside) gives the same drafts
//      as the driver's two-step form (gate, context reads, drafts);
//   3. refusals, quarantines and the clamp keep their driver outcomes.
// The db is mocked: these assert what the driver WRITES and where, not SQL
// (the in-transaction twin runs against Postgres in
// canonicalize-in-transaction.integration.test.ts).

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  canonicalFamilyFixtures,
  FIXTURE_ACCEPTED_OF_POST_REFS,
  FIXTURE_FANSLY_OWN_REF,
  FIXTURE_FANSLY_PAGE_ID,
  FIXTURE_NOW,
  FIXTURE_ONLYFANS_PAGE_ID,
  type CanonicalFamilyFixture,
} from "./helpers/canonicalize-family-fixtures.ts";

const dbMocks = vi.hoisted(() => ({
  getCanonicalizeSweepCursor: vi.fn(),
  advanceCanonicalizeSweepCursor: vi.fn(),
  listPageNativeAccountRefs: vi.fn(),
  listHistoricalOfapiBindings: vi.fn(),
  listObservationsForReplay: vi.fn(),
  listDetachedPartitionsHoldingAccount: vi.fn(),
  listObservedPostRefsForCapture: vi.fn(),
  markObservationParsed: vi.fn(),
  recordObservationQuarantine: vi.fn(),
  appendDomainEvents: vi.fn(),
  appendMixedDomainEvents: vi.fn(),
  appendProjectionOnlyDomainEvents: vi.fn(),
  assertDomainEventTargetMonthsAttached: vi.fn(),
  loadDomainEventPartitionCoverage: vi.fn(),
  tryAcquireDmArchiveWriterFenceLock: vi.fn(),
  isDmArchiveScopeFenced: vi.fn(),
  DomainEventTargetMonthsUnattachedError: class extends Error {},
  // The read seam's value imports. Never reached: every fixture row carries
  // `payloadRef: null`, which the seam answers from the inline body.
  CapturePayloadCodecError: class extends Error {},
  canonicalizeCaptureJson: vi.fn(),
  capturePayloadRefFromColumns: vi.fn(),
  readEnvelopeCapturePayload: vi.fn(),
}));

vi.mock("@agency_hub_core/db", () => dbMocks);

const { runCanonicalization } = await import("../apps/runtime/src/services/canonicalize-driver.ts");
const { familyForObservation } = await import("../apps/runtime/src/services/canonicalize/index.ts");
const { buildCanonicalDrafts, clampDraftOccurredAt, gateCanonicalObservation } = await import(
  "../apps/runtime/src/services/canonicalize-drafts.ts"
);
const driverReexports = await import("../apps/runtime/src/services/canonicalize-driver.ts");

const nativeRefs = new Map<number, string | null>([
  [FIXTURE_FANSLY_PAGE_ID, FIXTURE_FANSLY_OWN_REF],
  [FIXTURE_ONLYFANS_PAGE_ID, null],
]);

function appStub() {
  const tx = { name: "driver-transaction" };
  const db = {
    name: "driver-pool",
    transaction: vi.fn(async (callback: (handle: unknown) => Promise<unknown>) => callback(tx)),
  };
  return { app: { db, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }, db, tx };
}

async function runDriver(fixture: CanonicalFamilyFixture) {
  const family = familyForObservation(fixture.observation)!;
  dbMocks.listObservationsForReplay
    .mockResolvedValueOnce([{ ...fixture.observation, parseVersion: 0, payloadRef: null }])
    .mockResolvedValue([]);
  const stub = appStub();
  const diagnostics: string[] = [];
  const result = await runCanonicalization(stub.app as never, {
    families: [family],
    now: FIXTURE_NOW,
    maxPagesPerFamily: 1,
    diagnostics: { record: (code) => void diagnostics.push(code) },
  });
  return { family, result, diagnostics, ...stub };
}

/** The drafts the seam builds in the engine's one-call form. */
function seamDrafts(fixture: CanonicalFamilyFixture) {
  const family = familyForObservation(fixture.observation)!;
  return buildCanonicalDrafts(family, fixture.observation, {
    nativeAccountRefByAccountId: nativeRefs,
    ...(family.replayContext === "accepted_posts"
      ? { acceptedPostRefs: new Set<string>(FIXTURE_ACCEPTED_OF_POST_REFS) }
      : {}),
    now: FIXTURE_NOW,
  });
}

function appenderOf(family: NonNullable<ReturnType<typeof familyForObservation>>) {
  return family.projectionOnly === true
    ? dbMocks.appendProjectionOnlyDomainEvents
    : family.mixed === true
    ? dbMocks.appendMixedDomainEvents
    : dbMocks.appendDomainEvents;
}

const appenders = () => [
  dbMocks.appendDomainEvents,
  dbMocks.appendMixedDomainEvents,
  dbMocks.appendProjectionOnlyDomainEvents,
];

beforeEach(() => {
  for (const mock of Object.values(dbMocks)) {
    if (typeof mock === "function" && "mockReset" in mock) {
      (mock as ReturnType<typeof vi.fn>).mockReset();
    }
  }
  dbMocks.listPageNativeAccountRefs.mockResolvedValue([
    { id: FIXTURE_FANSLY_PAGE_ID, platform: "fansly", nativeAccountRef: FIXTURE_FANSLY_OWN_REF, ofapiAccountId: null },
    { id: FIXTURE_ONLYFANS_PAGE_ID, platform: "onlyfans", nativeAccountRef: null, ofapiAccountId: "acct_test" },
  ]);
  dbMocks.listHistoricalOfapiBindings.mockResolvedValue([]);
  dbMocks.listDetachedPartitionsHoldingAccount.mockResolvedValue([]);
  dbMocks.listObservedPostRefsForCapture.mockResolvedValue([...FIXTURE_ACCEPTED_OF_POST_REFS]);
  for (const append of appenders()) {
    append.mockImplementation(async (_db: unknown, _account: number, events: readonly unknown[]) => ({
      appended: events.length, deduped: 0, highWater: events.length, events: [],
    }));
  }
});

describe("buildCanonicalDrafts — the shared pure seam", () => {
  const fixtures = canonicalFamilyFixtures();

  it("covers every registered family, OnlyFans included", async () => {
    const { CANONICALIZER_FAMILIES } = await import("../apps/runtime/src/services/canonicalize/index.ts");
    const covered = new Set(fixtures.map((fixture) => {
      const family = familyForObservation(fixture.observation)!;
      return `${family.source}:${family.lane}`;
    }));
    expect([...covered].sort()).toEqual(CANONICALIZER_FAMILIES.map((family) => `${family.source}:${family.lane}`).sort());
    for (const fixture of fixtures) {
      const outcome = seamDrafts(fixture);
      const expected = {
        drafts: ["accepted", true],
        empty: ["accepted", false],
        quarantined: ["accepted", false],
        rejected: ["rejected", false],
      }[fixture.expect];
      expect([outcome.kind, outcome.kind === "accepted" && outcome.drafts.length > 0], fixture.name).toEqual(expected);
    }
  });

  it("gives the engine's one-call form and the driver's gate-then-drafts form the same drafts", () => {
    for (const fixture of fixtures) {
      const family = familyForObservation(fixture.observation)!;
      const verdict = gateCanonicalObservation(family, fixture.observation);
      const context = {
        nativeAccountRefByAccountId: nativeRefs,
        ...(family.replayContext === "accepted_posts"
          ? { acceptedPostRefs: new Set<string>(FIXTURE_ACCEPTED_OF_POST_REFS) }
          : {}),
        now: FIXTURE_NOW,
      };
      const twoStep = verdict.accepted
        ? buildCanonicalDrafts(family, fixture.observation, context, verdict)
        : { kind: "rejected" as const, rejection: verdict.rejection };
      expect(seamDrafts(fixture), fixture.name).toEqual(twoStep);
    }
  });

  it("is the canonicalizer's own output, clamped — nothing added, nothing dropped", () => {
    for (const fixture of fixtures.filter((candidate) => candidate.expect === "drafts")) {
      const family = familyForObservation(fixture.observation)!;
      const raw = family.parse?.(fixture.observation).events ?? family.canonicalize(fixture.observation, {
        nativeAccountRefByAccountId: nativeRefs,
        acceptedPostRefs: new Set<string>(FIXTURE_ACCEPTED_OF_POST_REFS),
      });
      const outcome = seamDrafts(fixture);
      expect(outcome.kind === "accepted" ? outcome.drafts : null, fixture.name).toEqual(
        raw.map((draft) => clampDraftOccurredAt(draft, fixture.observation.receivedAt, FIXTURE_NOW)),
      );
    }
  });

  it("re-dates an out-of-window provider time to the receipt and keeps the raw value", () => {
    const clamp = fixtures.find((fixture) => fixture.name === "pull:sync clamp")!;
    const outcome = seamDrafts(clamp);
    expect(outcome.kind).toBe("accepted");
    const [draft] = outcome.kind === "accepted" ? outcome.drafts : [];
    expect(draft!.occurredAt).toEqual(clamp.observation.receivedAt);
    expect(draft!.data).toMatchObject({ occurredAtClamped: true, occurredAtRaw: "1970-01-01T00:00:01.000Z" });
  });

  it("keeps the clamp importable from the driver, where it used to live", () => {
    expect(driverReexports.clampDraftOccurredAt).toBe(clampDraftOccurredAt);
    expect(driverReexports.occurredAtClampMax(FIXTURE_NOW).toISOString()).toBe("2026-10-22T10:00:00.000Z");
  });
});

describe("the minutely driver on the seam — transactions unchanged", () => {
  const fixtures = canonicalFamilyFixtures();

  for (const fixture of fixtures.filter((candidate) => candidate.expect === "drafts")) {
    it(`${fixture.name}: appends exactly the seam's drafts on its own pool handle, then stamps`, async () => {
      const { family, result, db } = await runDriver(fixture);
      const outcome = seamDrafts(fixture);
      expect(outcome.kind).toBe("accepted");
      const drafts = outcome.kind === "accepted" ? outcome.drafts : [];
      const append = appenderOf(family);
      expect(append).toHaveBeenCalledTimes(1);
      for (const other of appenders().filter((candidate) => candidate !== append)) {
        expect(other).not.toHaveBeenCalled();
      }
      const call = append.mock.calls[0]!;
      // The driver's own pool handle: each append is its own transaction.
      expect(call[0]).toBe(db);
      expect(call[1]).toBe(fixture.observation.accountId);
      expect(call[2]).toEqual(drafts.map((draft) => ({ ...draft, observationId: fixture.observation.id })));
      if (family.projectionOnly === true || family.mixed === true) {
        expect(call[3]).toEqual({
          occurredAt: fixture.observation.receivedAt,
          observationId: fixture.observation.id,
          dedupKey: `${family.source}:v${family.version}:checkpoint:${fixture.observation.id}`,
        });
      }
      // The partition gate ran first, over exactly the appended times.
      expect(dbMocks.assertDomainEventTargetMonthsAttached).toHaveBeenCalledTimes(1);
      expect(dbMocks.assertDomainEventTargetMonthsAttached.mock.calls[0]![1])
        .toEqual(drafts.map((draft) => draft.occurredAt));
      expect(dbMocks.assertDomainEventTargetMonthsAttached.mock.invocationCallOrder[0]!)
        .toBeLessThan(append.mock.invocationCallOrder[0]!);
      // The stamp is a separate statement on the same pool handle, after the append.
      expect(dbMocks.markObservationParsed).toHaveBeenCalledTimes(1);
      expect(dbMocks.markObservationParsed.mock.calls[0]).toEqual([db, {
        observationId: fixture.observation.id,
        receivedAt: fixture.observation.receivedAt,
        parseVersion: family.version,
      }]);
      expect(append.mock.invocationCallOrder[0]!)
        .toBeLessThan(dbMocks.markObservationParsed.mock.invocationCallOrder[0]!);
      expect(db.transaction).not.toHaveBeenCalled();
      expect(result).toMatchObject({ scanned: 1, stamped: 1, appended: drafts.length, errored: 0 });
    });
  }

  it("leaves a shape-gate refusal unstamped and names its reason", async () => {
    const rejected = fixtures.find((fixture) => fixture.expect === "rejected")!;
    const { result, diagnostics, db } = await runDriver(rejected);
    for (const append of appenders()) expect(append).not.toHaveBeenCalled();
    expect(dbMocks.markObservationParsed).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
    expect(result).toMatchObject({ scanned: 1, stamped: 0, skippedUnparseable: 1 });
    expect(result.unparseableSamples).toEqual([{
      observationId: rejected.observation.id, family: "pull:sync", kind: "dm_messages", reasonCode: "messages_not_array",
    }]);
    expect(diagnostics).toEqual(["canonicalize_rejected:sync:messages_not_array"]);
  });

  it("records a terminal quarantine and its stamp in ONE driver transaction", async () => {
    const quarantined = fixtures.find((fixture) => fixture.expect === "quarantined")!;
    const { family, result, db, tx } = await runDriver(quarantined);
    for (const append of appenders()) expect(append).not.toHaveBeenCalled();
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(dbMocks.recordObservationQuarantine.mock.calls).toEqual([[tx, {
      observationId: quarantined.observation.id,
      parseVersion: family.version,
      source: "webhook",
      lane: "ofapi",
      kind: "messages.ppv.unlocked",
      reasonCode: "ppv_unlocked_no_chat_ref",
      receivedAt: quarantined.observation.receivedAt,
    }]]);
    expect(dbMocks.markObservationParsed.mock.calls).toEqual([[tx, {
      observationId: quarantined.observation.id,
      receivedAt: quarantined.observation.receivedAt,
      parseVersion: family.version,
    }]]);
    expect(result).toMatchObject({ stamped: 1, quarantined: 1 });
  });

  it("reads the OnlyFans acceptance boundary only for an accepted post page", async () => {
    const posts = fixtures.find((fixture) => fixture.name === "ofapi_capture:ofapi-posts")!;
    const { db } = await runDriver(posts);
    expect(dbMocks.listDetachedPartitionsHoldingAccount.mock.calls).toEqual([[db, FIXTURE_ONLYFANS_PAGE_ID]]);
    expect(dbMocks.listObservedPostRefsForCapture.mock.calls).toEqual([[db, FIXTURE_ONLYFANS_PAGE_ID, posts.observation.id]]);

    dbMocks.listDetachedPartitionsHoldingAccount.mockClear();
    dbMocks.listObservedPostRefsForCapture.mockClear();
    const refused = { ...posts, observation: { ...posts.observation, payload: { response: { status: 200, body: "{}", bodyEncoding: "utf8" } } } };
    const { result } = await runDriver(refused);
    expect(result).toMatchObject({ skippedUnparseable: 1, errored: 0 });
    expect(dbMocks.listDetachedPartitionsHoldingAccount).not.toHaveBeenCalled();
    expect(dbMocks.listObservedPostRefsForCapture).not.toHaveBeenCalled();
  });
});
